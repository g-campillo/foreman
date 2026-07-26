import { app, Notification, type BrowserWindow } from 'electron'

/**
 * The one place main pushes events at the renderer from. Lives in its own module
 * so agent/* and pty.ts don't have to import index.ts, which imports them back.
 */
let win: BrowserWindow | null = null

export function setMainWindow(w: BrowserWindow | null): void {
  win = w
  // The badge means "something happened while you were away", so looking at the
  // window is what earns clearing it.
  w?.on('focus', () => app.dock?.setBadge(''))
}

export function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

/**
 * Ping the user about a session — but only when they aren't already watching it.
 * A notification for something visible on screen is just noise.
 */
export function notify(title: string, body: string): void {
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
