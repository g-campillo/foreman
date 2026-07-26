import type { BrowserWindow } from 'electron'

/**
 * The one place main pushes events at the renderer from. Lives in its own module
 * so agent/* and pty.ts don't have to import index.ts, which imports them back.
 */
let win: BrowserWindow | null = null

export function setMainWindow(w: BrowserWindow | null): void {
  win = w
}

export function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}
