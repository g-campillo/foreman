import { ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import { IPC } from '../../shared/types'
import { send } from '../bridge'

interface Waiter {
  resolve: (r: PermissionResult) => void
  sessionId: string
}

const waiting = new Map<string, Waiter>()

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
      waiting.set(requestId, { resolve, sessionId })
      onPendingChange(countFor(sessionId))

      // If the turn is aborted (interrupt, session close) the callback would
      // otherwise dangle forever and wedge the CLI subprocess.
      options.signal.addEventListener(
        'abort',
        () => {
          if (!waiting.has(requestId)) return
          waiting.delete(requestId)
          send(IPC.permResolved, { requestId, sessionId })
          onPendingChange(countFor(sessionId))
          resolve({ behavior: 'deny', message: 'Interrupted' })
        },
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
    waiting.delete(id)
    send(IPC.permResolved, { requestId: id, sessionId })
    w.resolve({ behavior: 'deny', message: 'Session closed' })
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
        alwaysAllow,
      }: { requestId: string; behavior: 'allow' | 'deny'; alwaysAllow?: boolean },
    ) => {
      const waiter = waiting.get(requestId)
      if (!waiter) return false
      waiting.delete(requestId)

      waiter.resolve(
        behavior === 'allow'
          ? { behavior: 'allow', updatedInput: undefined }
          : { behavior: 'deny', message: 'Denied by user' },
      )
      send(IPC.permResolved, { requestId, sessionId: waiter.sessionId })
      void alwaysAllow // ponytail: rule persistence needs updatedPermissions + the SDK's
      // suggestions passed back through; add when the always-allow button ships.
      return true
    },
  )
}
