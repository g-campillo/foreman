import { ipcMain } from 'electron'
import { realpathSync } from 'node:fs'
import { listSessions } from '@anthropic-ai/claude-agent-sdk'
import { IPC, type PermissionMode, type PastSession, type SessionMeta } from '../../shared/types'
import { send } from '../bridge'
import { Session, type SessionInit } from './session'

const sessions = new Map<string, Session>()

function get(id: string): Session | undefined {
  return sessions.get(id)
}

export function createSession(init: SessionInit): SessionMeta {
  // Canonicalise once, here, so cwd / snapshot paths / pty all agree. Tools
  // report real paths, so an un-resolved symlink (e.g. macOS /tmp ->
  // /private/tmp) makes every diff path render as ../../private/tmp/...
  let cwd = init.cwd
  try {
    cwd = realpathSync(init.cwd)
  } catch {
    /* path may not exist yet; fall back to as-given */
  }
  const s = new Session({ ...init, cwd })
  sessions.set(s.meta.id, s)
  return s.meta
}

export function closeSession(id: string): void {
  const s = sessions.get(id)
  if (!s) return
  s.close()
  sessions.delete(id)
  send(IPC.evtRemoved, { sessionId: id })
}

export function disposeAllSessions(): void {
  for (const s of sessions.values()) s.close()
  sessions.clear()
}

export function registerSessionIpc(): void {
  ipcMain.handle(IPC.sessionCreate, (_e, init: SessionInit) => createSession(init))

  ipcMain.handle(IPC.sessionResume, (_e, init: SessionInit & { resume: string }) =>
    createSession(init),
  )

  ipcMain.handle(IPC.sessionClose, (_e, { sessionId }: { sessionId: string }) =>
    closeSession(sessionId),
  )

  ipcMain.handle(IPC.sessionList, () => [...sessions.values()].map((s) => s.meta))

  ipcMain.handle(
    IPC.sessionSend,
    (_e, { sessionId, text }: { sessionId: string; text: string }) => {
      get(sessionId)?.send(text)
    },
  )

  ipcMain.handle(IPC.sessionInterrupt, (_e, { sessionId }: { sessionId: string }) =>
    get(sessionId)?.interrupt(),
  )

  ipcMain.handle(
    IPC.sessionSetMode,
    (_e, { sessionId, mode }: { sessionId: string; mode: PermissionMode }) =>
      get(sessionId)?.setPermissionMode(mode),
  )

  ipcMain.handle(
    IPC.sessionSetModel,
    (_e, { sessionId, model }: { sessionId: string; model: string }) =>
      get(sessionId)?.setModel(model),
  )

  ipcMain.handle(IPC.sessionModels, (_e, { sessionId }: { sessionId: string }) =>
    get(sessionId)?.models() ?? [],
  )

  ipcMain.handle(IPC.sessionPastList, async (_e, { dir }: { dir?: string }): Promise<PastSession[]> => {
    try {
      const list = await listSessions({ dir, limit: 40 })
      return list.map((s: Record<string, unknown>) => ({
        sessionId: String(s.sessionId ?? ''),
        summary: String(s.summary ?? s.title ?? 'Untitled session'),
        cwd: typeof s.cwd === 'string' ? s.cwd : undefined,
        updatedAt: typeof s.updatedAt === 'string' ? s.updatedAt : undefined,
      }))
    } catch (err) {
      console.warn('[sessions] listSessions failed:', err)
      return []
    }
  })
}
