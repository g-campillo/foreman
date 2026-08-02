import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { CanUseTool, PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk'
import {
  IPC,
  type PermissionAnswer,
  type PermissionMode,
  type PermissionRequest,
  type SuggestedUpdate,
} from '../../shared/types'
import { send } from '../../shared/sink'
import { recomposeWrite, subsetMultiEdit } from '../../shared/diff.mts'

/**
 * Compile-time only: the renderer's mirror of PermissionUpdate must keep
 * covering the SDK's union.
 *
 * `describeGrant` in shared/rules.mts is what tells the user what an "always
 * allow" click grants, and the click sends the SDK's suggestions back verbatim —
 * so an update type the SDK adds and the mirror lacks would be granted with
 * nothing on screen about it. This alias is the tripwire: it stops compiling the
 * day that happens. Zero runtime cost; it emits nothing at all.
 */
type Covers<Ours, Theirs extends Ours> = Theirs
type _RuleTypesMirrored = Covers<SuggestedUpdate['type'], PermissionUpdate['type']>

interface Waiter {
  resolve: (r: PermissionResult) => void
  sessionId: string
  /** The card's payload, kept so a renderer that lost its copy can be re-sent it. */
  req: PermissionRequest
  /**
   * The SDK's own "always allow" suggestions for THIS call — the thing actually
   * granted, as opposed to `req.rules`, which is only what the card SAYS would
   * be granted.
   *
   * BE PRECISE ABOUT WHERE THE ISOLATION COMES FROM, because it is not object
   * identity: `makeCanUseTool` casts one array and stores it in both places, so
   * this and `req.rules` are the same object in this process. What makes the
   * split safe is that the renderer's copy is a STRUCTURED CLONE made by IPC on
   * the way out, and that nothing here ever reads `req.rules` back — the grant
   * below replays THIS field. So the renderer answers `alwaysAllow: true` and
   * can never name a rule, a tool or a destination, whatever it does to the copy
   * it was given.
   *
   * Same trust boundary `keep` draws with indices instead of content, one step
   * further: not even indices.
   *
   * The corollary, for whoever changes this next: `req.rules` may be reshaped or
   * redacted freely, and the grant is unaffected. Reading it back here to decide
   * anything is what would break the property.
   */
  suggestions?: PermissionUpdate[]
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
      // Verbatim, not a boolean. The card has to name the exact rule and the
      // exact settings file BEFORE the click, because these differ enormously in
      // reach — `Read` is every file on the machine, `Bash(npm run build:*)` is
      // one command — and a permission you cannot read is not consent. The
      // structural mirror is checked above; the shapes are identical.
      ...(options.suggestions?.length
        ? { rules: options.suggestions as SuggestedUpdate[] }
        : {}),
    }
    send(IPC.permRequest, req)

    return new Promise<PermissionResult>((resolve) => {
      waiting.set(requestId, {
        resolve,
        sessionId,
        req,
        suggestions: options.suggestions,
        onPendingChange,
        onModeChanged,
      })
      onPendingChange(countFor(sessionId))

      // If the turn is aborted (interrupt, session close) the callback would
      // otherwise dangle forever and wedge the CLI subprocess.
      //
      // No `decisionClassification` here, deliberately: the user never saw this
      // prompt, so calling it a rejection poisons exactly the telemetry the
      // field exists for. Same at 'Session closed' below. Do not "fix" either.
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
    // Unclassified on purpose — see the abort listener in makeCanUseTool. The
    // user never answered this; nobody rejected anything.
    settle(id, { behavior: 'deny', message: 'Session closed' })
  }
}

/* PermissionAnswer used to be declared here. It moved to shared/types.ts, where
   the preload bridge can take it as an options object — the six positionals it
   had grown were already one too many. Same fields, same docblocks. */

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

  /**
   * "Stop asking me about this" — the SDK's own suggestions, replayed verbatim.
   *
   * Verbatim is the point: the renderer sent one boolean, so what is granted is
   * exactly what the CLI proposed for exactly this call, and nothing the
   * renderer could have widened it to. Three guards, each refusing an incoherent
   * combination rather than a dangerous one:
   *
   *  - `!denyInstead` — unticking every hunk IS a rejection, and a rejection
   *    that writes a permanent allow rule is a contradiction.
   *  - `!updatedInput` — "allow every future Write to this path, but trim THIS
   *    one" cannot be honoured: the rule would have no idea it was meant to be
   *    partial. So a partial approval stays a one-off.
   *  - non-empty — the CLI offers no suggestions for some calls at all, and an
   *    empty updatedPermissions array is a change that changes nothing.
   */
  const grantRules =
    behavior === 'allow' &&
    alwaysAllow &&
    !denyInstead &&
    !updatedInput &&
    Boolean(waiter?.suggestions?.length)

  // ONE array, so a plan approval carrying a mode still works alongside a grant.
  // Two separate updatedPermissions would mean whichever was spread second won.
  const updatedPermissions: PermissionUpdate[] = [
    ...(grantRules ? (waiter?.suggestions ?? []) : []),
    ...(setMode ? [{ type: 'setMode' as const, mode: setMode, destination: 'session' as const }] : []),
  ]

  const settled = settle(
    requestId,
    behavior === 'allow' && !denyInstead
      ? {
          behavior: 'allow',
          updatedInput,
          ...(updatedPermissions.length ? { updatedPermissions } : {}),
          // `user_permanent` only when rules were ACTUALLY granted, not merely
          // asked for: one refused by the `updatedInput` guard above is honestly
          // temporary, and saying otherwise would misreport the one decision
          // this field exists to distinguish. A plan approval carrying a setMode
          // is temporary too — switching mode is not a rule grant.
          decisionClassification: grantRules ? 'user_permanent' : 'user_temporary',
        }
      : {
          // Noticed and accepted: this also labels AskUserQuestion ANSWERS as
          // rejections, because an answer rides the deny channel (see
          // QuestionCard.submit and the ANSWER_PREFIX machinery that exists to
          // stop the rest of the app reading one as a failure). There is no
          // "answered" value in the vocabulary to say anything truer with, and
          // it is not a regression either way — sdk.d.ts:2072 says the CLI
          // already infers `reject` for a deny with this unset.
          behavior: 'deny',
          message: denyInstead ?? message ?? 'Denied by user',
          decisionClassification: 'user_reject',
        },
  )

  // The CLI now has the new mode, but nothing told our own meta — and the
  // composer's mode selector reads that. Without this it still says "Plan"
  // after the user approved a plan, and their next send re-asserts it.
  if (settled && setMode) waiter?.onModeChanged(setMode)
  return settled
}
