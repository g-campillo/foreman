/**
 * The wire between Electron and a detached agent host.
 *
 * Shared by both sides so the framing can never drift. Deliberately Electron-
 * free: the host runs under bare Node.
 *
 * Newline-delimited JSON over a unix domain socket. Not a real RPC library,
 * because the whole protocol is "call a method on the Session, get its return
 * value" plus a one-way event stream — and a dependency for that would be
 * larger than the protocol.
 */
import type { SessionMeta } from './types'

/** Everything one host owns, under `userData/hosts/<sessionId>/`. */
export const HOST_FILES = {
  meta: 'meta.json',
  events: 'events.ndjson',
  sock: 'sock',
} as const

/**
 * Written by the host at startup, read by the app at launch to find it again.
 *
 * `pid` is the host's own. `agentPid` is the `claude` child it spawned, and it
 * is the reason this file records two: if the host itself dies uncleanly the
 * agent is orphaned with no parent to reap it, and only a recorded pid makes
 * that killable on the next launch.
 */
export interface HostMeta {
  sessionId: string
  pid: number
  agentPid?: number
  cwd: string
  title: string
  sdkSessionId: string | null
  startedAt: number
}

/** App → host. `id` correlates the reply; absent means fire-and-forget. */
export interface HostCall {
  id: number
  method: string
  args: unknown[]
}

/** Host → app. Exactly one of these shapes per line. */
export type HostFrame =
  | { t: 'reply'; id: number; ok: true; value: unknown }
  | { t: 'reply'; id: number; ok: false; error: string }
  /** A session event — the same (channel, payload) pairs the renderer expects. */
  | { t: 'event'; channel: string; payload: unknown }
  /** Sent on connect, before any replay, so the client can seed its rail row. */
  | { t: 'hello'; meta: SessionMeta }
  /** Marks the end of the replayed backlog; live events follow. */
  | { t: 'replayed' }

/** Split a socket's byte stream into whole JSON lines. */
export function makeLineReader(onLine: (line: string) => void): (chunk: Buffer) => void {
  let buf = ''
  return (chunk: Buffer): void => {
    buf += chunk.toString('utf8')
    let at: number
    while ((at = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, at)
      buf = buf.slice(at + 1)
      if (line.trim()) onLine(line)
    }
  }
}
