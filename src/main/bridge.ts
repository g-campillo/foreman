import { app, Notification, type BrowserWindow } from 'electron'
import { setSink, send } from '../shared/sink'

/**
 * Main's end of the event stream: everything the renderer receives goes through
 * here.
 *
 * The actual `send` now lives in `shared/sink`, because a detached agent host
 * runs the same Session code with a different destination (its event log and
 * socket) and cannot import Electron. This module is just the Electron
 * implementation of that sink, plus the two things only main can do —
 * notifications and opening a browser.
 */
let win: BrowserWindow | null = null

export function setMainWindow(w: BrowserWindow | null): void {
  win = w
  setSink(w ? (channel, payload) => forward(channel, payload) : null)
  // The badge means "something happened while you were away", so looking at the
  // window is what earns clearing it.
  w?.on('focus', () => app.dock?.setBadge(''))
}

function forward(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

/**
 * Ping the user about a session — but only when they aren't already watching it.
 * A notification for something visible on screen is just noise.
 *
 * Reached as an event now (IPC.evtNotify), so a host can raise one without
 * Electron. Sessions call `notify()` from shared/sink; this is where it lands.
 */
export function showNotification(title: string, body: string): void {
  if (!win || win.isDestroyed() || win.isFocused()) return
  app.dock?.setBadge('●')
  if (!Notification.isSupported()) return
  const n = new Notification({ title, body })
  n.on('click', () => {
    win?.show()
    win?.focus()
  })
  n.show()
}

export { send }
