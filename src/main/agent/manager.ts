import { ipcMain } from 'electron'
import { realpathSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { listSessions } from '@anthropic-ai/claude-agent-sdk'
import {
  IPC,
  type PermissionMode,
  type PastSession,
  type SendContent,
  type SessionMeta,
} from '../../shared/types'
import { send } from '../bridge'
import { Session, type SessionInit } from './session'

const sessions = new Map<string, Session>()

const exec = promisify(execFile)

/** Cap on files offered to @-mention autocomplete. */
const FILE_LIMIT = 4000

/**
 * Repo-relative paths for @-mention autocomplete.
 *
 * `git ls-files` because it gets .gitignore filtering for free — walking the
 * tree by hand means reimplementing ignore rules, and the first thing an
 * unfiltered walk finds is node_modules. `--others --exclude-standard` adds
 * untracked-but-not-ignored files, so something the agent just created is
 * mentionable without a commit.
 *
 * ponytail: read fresh on each open, no cache. It's one git call against a
 * warm index; add a watcher only if a huge repo makes the popover lag.
 */
async function listProjectFiles(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await exec(
      'git',
      ['-C', cwd, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { maxBuffer: 32 * 1024 * 1024 },
    )
    const files = stdout.split('\0').filter(Boolean)
    return files.slice(0, FILE_LIMIT)
  } catch {
    // Not a git repo, or git is missing. A shallow readdir beats nothing, and
    // deliberately does not recurse — an un-ignored deep walk is the slow,
    // node_modules-filled case this whole function exists to avoid.
    try {
      const entries = await readdir(cwd, { withFileTypes: true })
      return entries
        .filter((e) => e.isFile() && !e.name.startsWith('.'))
        .map((e) => e.name)
        .slice(0, FILE_LIMIT)
    } catch {
      return []
    }
  }
}

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
    (_e, { sessionId, content }: { sessionId: string; content: SendContent }) => {
      get(sessionId)?.send(content)
    },
  )

  ipcMain.handle(
    IPC.sessionCancelQueued,
    (_e, { sessionId, itemId }: { sessionId: string; itemId: string }) =>
      get(sessionId)?.cancelQueued(itemId) ?? false,
  )

  ipcMain.handle(IPC.sessionCommands, (_e, { sessionId }: { sessionId: string }) =>
    get(sessionId)?.commands() ?? [],
  )

  ipcMain.handle(IPC.sessionFiles, async (_e, { sessionId }: { sessionId: string }) => {
    const s = get(sessionId)
    return s ? listProjectFiles(s.meta.cwd) : []
  })

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

  // Read-only panels. Each returns a neutral empty value when the session is
  // gone, so a panel opened mid-teardown renders "unavailable" rather than throwing.
  ipcMain.handle(IPC.sessionContextUsage, (_e, { sessionId }: { sessionId: string }) =>
    get(sessionId)?.contextUsage() ?? null,
  )
  ipcMain.handle(IPC.sessionAccount, (_e, { sessionId }: { sessionId: string }) =>
    get(sessionId)?.account() ?? null,
  )
  ipcMain.handle(IPC.sessionUsage, (_e, { sessionId }: { sessionId: string }) =>
    get(sessionId)?.usage() ?? null,
  )
  ipcMain.handle(IPC.sessionAgents, (_e, { sessionId }: { sessionId: string }) =>
    get(sessionId)?.agents() ?? [],
  )
  ipcMain.handle(IPC.sessionMcpStatus, (_e, { sessionId }: { sessionId: string }) =>
    get(sessionId)?.mcpStatus() ?? [],
  )
  ipcMain.handle(IPC.sessionReloadSkills, (_e, { sessionId }: { sessionId: string }) =>
    get(sessionId)?.reloadSkills() ?? [],
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
