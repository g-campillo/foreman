/**
 * Where a session's outbound events go.
 *
 * This exists so `Session` and everything it drives can run in *either* process
 * without knowing which. In Electron's main process the sink is
 * `webContents.send`, straight to the renderer. In a detached agent host it is
 * "append to the event log, then push to whatever client is attached" — which
 * is what lets the agent keep working while no app is running at all.
 *
 * A module-level singleton is safe precisely because those are separate
 * processes, so there is never more than one sink per module instance.
 *
 * Deliberately no Electron import: this file is loaded by the host, which runs
 * under bare Node.
 */
import { IPC } from './types'

export type Sink = (channel: string, payload: unknown) => void

let sink: Sink | null = null

export function setSink(next: Sink | null): void {
  sink = next
}

/** Drops the event when nothing is attached. In a host that never happens —
 *  the log is always attached — and in main it means the window is gone. */
export function send(channel: string, payload: unknown): void {
  sink?.(channel, payload)
}

/**
 * Ask the app to tell the user about something.
 *
 * An event rather than a direct `new Notification()`, because a host has no
 * Electron to build one with. Main decides whether to actually show it — it is
 * the only side that knows whether the window is focused.
 *
 * This is strictly better than the old direct call: a notification raised while
 * no app is attached is now recorded in the event log and delivered when one
 * reconnects, instead of vanishing.
 */
export function notify(title: string, body: string): void {
  send(IPC.evtNotify, { title, body })
}
