import { ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import { IPC } from '../../shared/types'
import { send } from '../bridge'

interface Waiter {
  resolve: (r: PermissionResult) => void
  sessionId: string
  onPendingChange: (count: number) => void
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
 * diff capture hangs off a PreToolUse hook instead (see snapshots.ts).
 */
export function makeCanUseTool(
  sessionId: string,
  onPendingChange: (count: number) => void,
): CanUseTool {
  return async (toolName, input, options) => {
    const requestId = randomUUID()

    send(IPC.permRequest, {
      requestId,
      sessionId,
      toolName,
      input,
      hasSuggestions: Boolean(options.suggestions?.length),
    })

    return new Promise<PermissionResult>((resolve) => {
      waiting.set(requestId, { resolve, sessionId, onPendingChange })
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

/** Fail any outstanding prompts for a session so its subprocess can wind down. */
export function cancelPending(sessionId: string): void {
  for (const [id, w] of waiting) {
    if (w.sessionId !== sessionId) continue
    settle(id, { behavior: 'deny', message: 'Session closed' })
  }
}

export function registerPermissionIpc(): void {
  ipcMain.handle(
    IPC.permRespond,
    (
      _e,
      {
        requestId,
        behavior,
        message,
        alwaysAllow,
      }: {
        requestId: string
        behavior: 'allow' | 'deny'
        /** Replaces the default deny text; see the AskUserQuestion note below. */
        message?: string
        alwaysAllow?: boolean
      },
    ) => {
      void alwaysAllow // ponytail: rule persistence needs updatedPermissions + the SDK's
      // suggestions passed back through; add when the always-allow button ships.

      // A deny message becomes the tool_result the model reads, which is the
      // only channel an SDK host has for answering AskUserQuestion: allowing the
      // tool just runs it, and it reports "The user did not answer the
      // questions" because the CLI collects answers from its own interactive UI,
      // which does not exist here. Verified against the live CLI.
      return settle(
        requestId,
        behavior === 'allow'
          ? { behavior: 'allow', updatedInput: undefined }
          : { behavior: 'deny', message: message || 'Denied by user' },
      )
    },
  )
}
