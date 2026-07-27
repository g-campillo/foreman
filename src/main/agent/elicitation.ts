import { randomUUID } from 'node:crypto'
import type { ElicitationResult, OnElicitation } from '@anthropic-ai/claude-agent-sdk'
import { IPC, type ElicitationAction, type ElicitationRequest } from '../../shared/types'
import { send } from '../../shared/sink'

interface Waiter {
  resolve: (r: ElicitationResult) => void
  sessionId: string
  /** The card's payload, kept so a renderer that lost its copy can be re-sent it. */
  req: ElicitationRequest
}

const waiting = new Map<string, Waiter>()

type ElicitContent = Record<string, string | number | boolean | string[]>

/**
 * The MCP protocol restricts an elicitation answer to primitives, so this drops
 * anything else rather than casting the renderer's payload through. Also drops
 * `undefined`, which is what a cleared optional field arrives as — an absent
 * field must be absent, not present-and-undefined.
 */
function sanitiseContent(raw: unknown): ElicitContent | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const out: ElicitContent = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v
    else if (Array.isArray(v) && v.every((x) => typeof x === 'string')) out[k] = v as string[]
  }
  return out
}

/**
 * Handles `elicitation/create` from MCP servers.
 *
 * Without this callback the SDK auto-declines every elicitation, which silently
 * breaks any MCP server that needs OAuth — the auth prompt is answered "no"
 * before the user ever sees it, and the server just reports as failed.
 *
 * Measured, with a probe MCP server: without this callback a form elicitation
 * comes back to the server as `{"action":"decline"}` and no prompt is ever
 * shown; with it, the typed values arrive intact.
 *
 * Two modes, and they want different treatment:
 *  - 'form' is structured input against a JSON Schema, which the renderer draws
 *           as a card. The schema crosses as plain JSON, so nothing on the other
 *           side has to know about the SDK.
 *  - 'url'  is browser-based auth. Currently UNREACHABLE, and not for a reason
 *           we control: the CLI advertises `elicitation: {}` to MCP servers, so
 *           a server calling elicitInput({mode:'url'}) fails its own capability
 *           check — `if (!clientCapabilities?.elicitation?.url) throw` — before
 *           any host callback runs. Handled anyway because the SDK's own
 *           ElicitationRequest declares the mode; if the CLI starts advertising
 *           it, this is already correct rather than silently answering a URL
 *           request with a form response.
 */
export function makeOnElicitation(sessionId: string): OnElicitation {
  return async (request, options) => {
    if (request.mode === 'url' && request.url) {
      // Fire-and-forget: a browser that refuses to open shouldn't wedge the
      // turn. An event rather than shell.openExternal, because a detached host
      // has no Electron — and because a URL raised while the app is closed then
      // lands in the event log and opens when it reconnects, instead of being
      // silently lost.
      send(IPC.evtOpenUrl, { url: request.url })
      // The user completes auth out of band; the server correlates via
      // elicitationId and notifies separately.
      send(IPC.elicitRequest, {
        requestId: randomUUID(),
        sessionId,
        serverName: request.serverName,
        message: request.message,
        title: request.title,
        description: request.description,
        mode: 'url',
        url: request.url,
      })
      return { action: 'accept' }
    }

    const requestId = randomUUID()
    const req: ElicitationRequest = {
      requestId,
      sessionId,
      serverName: request.serverName,
      message: request.message,
      title: request.title,
      description: request.description,
      mode: 'form',
      schema: request.requestedSchema as Record<string, unknown>,
    }
    send(IPC.elicitRequest, req)

    return new Promise<ElicitationResult>((resolve) => {
      waiting.set(requestId, { resolve, sessionId, req })

      // Same hazard as canUseTool: an aborted turn would leave this dangling
      // and wedge the CLI subprocess waiting on an answer that never comes.
      options.signal.addEventListener(
        'abort',
        () => {
          if (!waiting.has(requestId)) return
          waiting.delete(requestId)
          send(IPC.elicitResolved, { requestId, sessionId })
          resolve({ action: 'cancel' })
        },
        { once: true },
      )
    })
  }
}

/**
 * Prompts still parked here, for a renderer that lost its copy. The 'url' mode
 * above never parks a waiter — it already returned `accept` and the user
 * completes auth out of band — so it correctly never replays.
 */
export function pendingElicitations(sessionId?: string): ElicitationRequest[] {
  return [...waiting.values()]
    .filter((w) => !sessionId || w.sessionId === sessionId)
    .map((w) => w.req)
}

/** Settle any outstanding prompts for a session so its subprocess can wind down. */
export function cancelPendingElicitations(sessionId: string): void {
  for (const [id, w] of waiting) {
    if (w.sessionId !== sessionId) continue
    waiting.delete(id)
    send(IPC.elicitResolved, { requestId: id, sessionId })
    w.resolve({ action: 'cancel' })
  }
}

/** Answer a parked elicitation. Runs where the waiter lives — the host. */
export function respondElicitation({
  requestId,
  action,
  content,
}: {
  requestId: string
  action: ElicitationAction
  content?: Record<string, unknown>
}): boolean {
  const waiter = waiting.get(requestId)
  if (!waiter) return false
  waiting.delete(requestId)
  // `content` only belongs on an accept; sending it otherwise is a protocol error.
  waiter.resolve(action === 'accept' ? { action, content: sanitiseContent(content) } : { action })
  send(IPC.elicitResolved, { requestId, sessionId: waiter.sessionId })
  return true
}
