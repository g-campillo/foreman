import { ipcMain } from 'electron'
import { IPC } from '../shared/types'
import { send } from './bridge'

// Typed loosely: @lydell/node-pty ships prebuilt binaries and is externalised
// from the bundle, so we only need the handful of members we actually touch.
interface IPty {
  onData(cb: (data: string) => void): void
  onExit(cb: (e: { exitCode: number }) => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
}

const ptys = new Map<string, IPty>()

function spawnPty(sessionId: string, cwd: string, cols: number, rows: number): void {
  if (ptys.has(sessionId)) return

  const pty = require('@lydell/node-pty') as {
    spawn(file: string, args: string[], opts: Record<string, unknown>): IPty
  }
  const shell = process.env.SHELL || '/bin/zsh'

  const p = pty.spawn(shell, ['-l'], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: { ...process.env, TERM: 'xterm-256color' },
  })

  p.onData((data) => send(IPC.evtPtyData, { sessionId, data }))
  p.onExit(({ exitCode }) => {
    ptys.delete(sessionId)
    send(IPC.evtPtyExit, { sessionId, exitCode })
  })

  ptys.set(sessionId, p)
}

export function killPty(sessionId: string): void {
  const p = ptys.get(sessionId)
  if (!p) return
  try {
    p.kill()
  } catch {
    /* already dead */
  }
  ptys.delete(sessionId)
}

export function disposeAllPtys(): void {
  for (const id of [...ptys.keys()]) killPty(id)
}

export function registerPtyIpc(): void {
  ipcMain.handle(
    IPC.ptyStart,
    (
      _e,
      {
        sessionId,
        cwd,
        cols,
        rows,
      }: { sessionId: string; cwd: string; cols: number; rows: number },
    ) => {
      try {
        spawnPty(sessionId, cwd, cols, rows)
        return true
      } catch (err) {
        console.error('[pty] spawn failed:', err)
        return false
      }
    },
  )

  ipcMain.handle(IPC.ptyWrite, (_e, { sessionId, data }: { sessionId: string; data: string }) => {
    ptys.get(sessionId)?.write(data)
  })

  ipcMain.handle(
    IPC.ptyResize,
    (_e, { sessionId, cols, rows }: { sessionId: string; cols: number; rows: number }) => {
      try {
        ptys.get(sessionId)?.resize(cols, rows)
      } catch {
        /* pty raced with exit */
      }
    },
  )

  ipcMain.handle(IPC.ptyKill, (_e, { sessionId }: { sessionId: string }) => killPty(sessionId))
}
