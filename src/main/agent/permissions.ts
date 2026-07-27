import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import { IPC, type PermissionMode, type PermissionRequest } from '../../shared/types'
import { send } from '../../shared/sink'
import { recomposeWrite, subsetMultiEdit } from '../../shared/diff.mts'

interface Waiter {
  resolve: (r: PermissionResult) => void
  sessionId: string
  /** The card's payload, kept so a renderer that lost its copy can be re-sent it. */
  req: PermissionRequest
  onPendingChange: (count: number) => void
  onModeChanged: (mode: PermissionMode) => void
}

const waiting = new Map<string, Waiter>()

/**
 * The single exit for a parked prompt: unpark it, answer the SDK, tell the
 * renderer, re-count.
 *
 * Every way out goes through here — answered, denied, interrupted, session
 * closed. Resolving without the re-count leaves the session pinned to
 * 'awaiting-approval' with its queue gate shut and a stale count in the
 * notification body, until some later stream event happens to unstick it.
 */
function settle(requestId: string, result: PermissionResult): boolean {
  const w = waiting.get(requestId)
  if (!w) return false
  waiting.delete(requestId)
  w.resolve(result)
  send(IPC.permResolved, { requestId, sessionId: w.sessionId })
  w.onPendingChange(countFor(w.sessionId))
  return true
}

/**
 * Bridges the SDK's canUseTool callback to the renderer: park the resolver,
 * push an approval card, resolve when the user clicks.
 *
 * Auto-approved tools never reach this callback — that is by design, and why
 * the diff panel reads git directly rather than hanging off it (see gitdiff.ts).
 */
export function makeCanUseTool(
  sessionId: string,
  onPendingChange: (count: number) => void,
  /** Mirror a mode carried out on a permission result back into session meta. */
  onModeChanged: (mode: PermissionMode) => void,
): CanUseTool {
  return async (toolName, input, options) => {
    const requestId = randomUUID()

    const req: PermissionRequest = {
      requestId,
      sessionId,
      toolName,
      input: input as Record<string, unknown>,
      hasSuggestions: Boolean(options.suggestions?.length),
    }
    send(IPC.permRequest, req)

    return new Promise<PermissionResult>((resolve) => {
      waiting.set(requestId, { resolve, sessionId, req, onPendingChange, onModeChanged })
      onPendingChange(countFor(sessionId))

      // If the turn is aborted (interrupt, session close) the callback would
      // otherwise dangle forever and wedge the CLI subprocess.
      options.signal.addEventListener(
        'abort',
        () => settle(requestId, { behavior: 'deny', message: 'Interrupted' }),
        { once: true },
      )
    })
  }
}

function countFor(sessionId: string): number {
  let n = 0
  for (const w of waiting.values()) if (w.sessionId === sessionId) n++
  return n
}

/**
 * Prompts still parked here, for a renderer that lost its copy.
 *
 * The resolver lives in this map while the card lives only in the renderer's
 * store, so a reload — or, before the close handler in main/index.ts, a ⌘W —
 * left the SDK promise parked forever with nothing on screen to answer it, and
 * the session pinned to 'awaiting-approval' behind a shut queue gate.
 */
export function pendingPermissions(sessionId?: string): PermissionRequest[] {
  return [...waiting.values()]
    .filter((w) => !sessionId || w.sessionId === sessionId)
    .map((w) => w.req)
}

/** Fail any outstanding prompts for a session so its subprocess can wind down. */
export function cancelPending(sessionId: string): void {
  for (const [id, w] of waiting) {
    if (w.sessionId !== sessionId) continue
    settle(id, { behavior: 'deny', message: 'Session closed' })
  }
}

/** Arguments of a permission answer, as they arrive from the renderer. */
export interface PermissionAnswer {
  requestId: string
  behavior: 'allow' | 'deny'
  /** Replaces the default deny text; see the AskUserQuestion note below. */
  message?: string
  /**
   * Permission mode to switch to as part of the same allow.
   *
   * This rides on the permission result rather than going out as a separate
   * setPermissionMode call because approving ExitPlanMode makes the CLI change
   * the mode too — two writers, and whichever landed second would win.
   * `updatedPermissions` is applied with the decision, so the user's pick can't
   * lose that race.
   */
  setMode?: PermissionMode
  alwaysAllow?: boolean
  /**
   * Indices of the edits/hunks the user actually accepted. Absent means all.
   *
   * INDICES, never content, and that is the whole safety argument. The host
   * subsets its OWN copy of the tool input, so the renderer cannot name bytes
   * that reach disk — a nasty new trust boundary collapses into a bounds check.
   * See subsetMultiEdit in shared/diff.mts for the property that buys.
   */
  keep?: number[]
  /**
   * Approving a plan AND handing the work to subagents.
   *
   * Rides the permission answer for the same reason `setMode` does, only more
   * so: it has to be known BEFORE the tool runs. The input queue is gated shut
   * for the whole turn, so a follow-up message would not reach the model until
   * after it had already implemented the plan alone. The directive itself
   * travels on a PostToolUse hook — see plan.ts — and this flag is only how the
   * click reaches it.
   */
  subagents?: boolean
}

/**
 * Sessions whose next ExitPlanMode result should carry the orchestration
 * directive. Written here, read exactly once by the PostToolUse hook in plan.ts.
 *
 * A module-level set rather than a field on the PermissionResult because the SDK
 * gives a permission answer nowhere to put extra context — `updatedInput` and
 * `updatedPermissions` are the whole surface, and the live probe showed
 * ExitPlanMode's hook payload carries an EMPTY tool_input anyway. Safe as module
 * state because this file and the hook run in the SAME process: host/index.ts
 * owns both the waiters and the Session.
 */
const orchestrate = new Set<string>()

/**
 * Read-and-clear. One approval, one directive — a later plain approval in the
 * same session must not inherit this one's choice.
 */
export function takeOrchestration(sessionId: string): boolean {
  return orchestrate.delete(sessionId)
}

/**
 * Answer a parked prompt. Runs wherever the waiter lives — which is the host
 * process, since that is where canUseTool was called.
 */
export async function respondPermission({
  requestId,
  behavior,
  message,
  setMode,
  alwaysAllow,
  keep,
  subagents,
}: PermissionAnswer): Promise<boolean> {
  void alwaysAllow // ponytail: rule persistence needs updatedPermissions + the SDK's
  // suggestions passed back through; add when the always-allow button ships.

  // A deny message becomes the tool_result the model reads, which is the
  // only channel an SDK host has for answering AskUserQuestion: allowing the
  // tool just runs it, and it reports "The user did not answer the
  // questions" because the CLI collects answers from its own interactive UI,
  // which does not exist here. Verified against the live CLI.
  //
  // It is also how plan feedback travels: denying ExitPlanMode with the
  // user's notes leaves the session in plan mode with the revisions sitting
  // in the tool_result, which is exactly "no, keep planning, and here's why".
  // Read before settling — settle() unparks the waiter and drops it.
  const waiter = waiting.get(requestId)

  // Partial approval. `updatedInput` was passed as undefined here from the
  // start; this is the field finally being used for the thing it exists for.
  //
  // Only ever a SUBSET of what the agent proposed, built from the host's own
  // copy of the input — so the worst case of a bug is that less lands than the
  // user ticked, never something they did not see. Tighten-only, never widen,
  // the same property setMcpPermissionOverride is safe for.
  let updatedInput: Record<string, unknown> | undefined
  let denyInstead: string | null = null

  if (behavior === 'allow' && keep && waiter) {
    const { toolName, input } = waiter.req
    if (toolName === 'MultiEdit') {
      const subset = subsetMultiEdit(input, keep)
      // Nothing kept. An empty edits array is not a no-op — the tool errors on
      // it — so unticking everything has to become a deny, which is what the
      // user meant anyway.
      if (!subset) denyInstead = 'The user rejected all of the proposed edits.'
      else if (subset !== input) updatedInput = subset as Record<string, unknown>
    } else if (toolName === 'Write') {
      // `before` is read HERE, at decision time, from disk — never carried in
      // the request. A prompt can sit parked for a long time, and recomposing
      // against a snapshot from when it was raised would silently revert
      // whatever the user did in the meantime.
      const path = typeof input.file_path === 'string' ? input.file_path : ''
      const proposed = typeof input.content === 'string' ? input.content : ''
      const current = path ? await readFile(path, 'utf8').catch(() => '') : ''
      const content = recomposeWrite(current, proposed, keep)
      if (content === current) denyInstead = 'The user rejected all of the proposed changes.'
      else if (content !== proposed) updatedInput = { ...input, content }
    }
    // No `Edit` branch, deliberately: an Edit is one old_string and one
    // new_string, a single atom with nothing to subset. Allow or deny.
  }

  // Armed BEFORE settle(), not after. settle() resolves the SDK's promise, the
  // tool runs, and the PostToolUse hook in plan.ts can fire before any statement
  // below this line executes.
  if (behavior === 'allow' && subagents && !denyInstead && waiter?.req.toolName === 'ExitPlanMode') {
    orchestrate.add(waiter.sessionId)
  }

  const settled = settle(
    requestId,
    behavior === 'allow' && !denyInstead
      ? {
          behavior: 'allow',
          updatedInput,
          ...(setMode
            ? { updatedPermissions: [{ type: 'setMode', mode: setMode, destination: 'session' }] }
            : {}),
        }
      : { behavior: 'deny', message: denyInstead ?? message ?? 'Denied by user' },
  )

  // The CLI now has the new mode, but nothing told our own meta — and the
  // composer's mode selector reads that. Without this it still says "Plan"
  // after the user approved a plan, and their next send re-asserts it.
  if (settled && setMode) waiter?.onModeChanged(setMode)
  return settled
}
