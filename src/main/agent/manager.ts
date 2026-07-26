import { ipcMain } from 'electron'
import { realpathSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  forkSession,
  getSessionMessages,
  listSessions,
  renameSession,
  type SDKSessionInfo,
} from '@anthropic-ai/claude-agent-sdk'
import {
  IPC,
  type ChatItem,
  type EffortLevel,
  type PermissionMode,
  type PastSession,
  type SendContent,
  type SessionMeta,
  type TranscriptSearchHit,
} from '../../shared/types'
import {
  normaliseTranscript,
  searchTranscript,
  type StoredMessage,
} from './transcript.mts'
import { send } from '../bridge'
import { Session, type SessionInit } from './session'

const sessions = new Map<string, Session>()

const exec = promisify(execFile)

/** Cap on files offered to @-mention autocomplete. */
const FILE_LIMIT = 4000

/** Messages read back from a stored session. Long enough for any real session. */
const TRANSCRIPT_LIMIT = 5000

/** ponytail: search reads this many recent sessions per query, newest first.
 *  Fine for a local JSONL scan; add an index only if it starts dragging. */
const SEARCH_SESSION_LIMIT = 40

/**
 * The SDK's field is `lastModified` (epoch ms) — there is no `updatedAt`, which
 * is why the rail never showed a date.
 *
 * `cwd` falls back to the queried directory: when listSessions is called WITH a
 * dir the results omit cwd, since it is implied. Without this fallback every
 * scoped row arrives cwd-less and the rail disables it as unresumable.
 */
function toPastSession(s: SDKSessionInfo, dir?: string): PastSession {
  return {
    sessionId: s.sessionId,
    summary: s.customTitle ?? s.summary ?? 'Untitled session',
    cwd: s.cwd ?? dir,
    lastModified: s.lastModified,
    gitBranch: s.gitBranch,
  }
}

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
  // An empty cwd would resolve to the process's own directory, which silently
  // starts the session in the wrong project — and on resume the CLI then reports
  // "No conversation found" for a session that exists perfectly well elsewhere.
  if (!init.cwd) throw new Error('createSession: cwd is required')
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

  ipcMain.handle(
    IPC.sessionRewind,
    (_e, { sessionId, messageId, dryRun }: { sessionId: string; messageId: string; dryRun: boolean }) =>
      get(sessionId)?.rewind(messageId, dryRun) ??
      { canRewind: false, error: 'No session', filesChanged: [], insertions: 0, deletions: 0 },
  )

  ipcMain.handle(
    IPC.sessionSetEffort,
    (_e, { sessionId, effort }: { sessionId: string; effort: EffortLevel | null }) =>
      get(sessionId)?.setEffort(effort),
  )

  ipcMain.handle(
    IPC.sessionBackground,
    (_e, { sessionId, toolUseId }: { sessionId: string; toolUseId?: string }) =>
      get(sessionId)?.background(toolUseId) ?? false,
  )

  ipcMain.handle(
    IPC.sessionStopTask,
    (_e, { sessionId, taskId }: { sessionId: string; taskId: string }) =>
      get(sessionId)?.stopTask(taskId),
  )

  ipcMain.handle(
    IPC.mcpToggle,
    (_e, { sessionId, name, enabled }: { sessionId: string; name: string; enabled: boolean }) =>
      get(sessionId)?.toggleMcp(name, enabled),
  )

  ipcMain.handle(IPC.mcpReconnect, (_e, { sessionId, name }: { sessionId: string; name: string }) =>
    get(sessionId)?.reconnectMcp(name),
  )

  ipcMain.handle(
    IPC.mcpPermissionOverride,
    (
      _e,
      { sessionId, name, mode }: { sessionId: string; name: string; mode: 'default' | 'auto' | null },
    ) => get(sessionId)?.setMcpPermissionOverride(name, mode),
  )

  ipcMain.handle(IPC.sessionPastList, async (_e, { dir }: { dir?: string }): Promise<PastSession[]> => {
    try {
      return (await listSessions({ dir, limit: 40 })).map((x) => toPastSession(x, dir))
    } catch (err) {
      console.warn('[sessions] listSessions failed:', err)
      return []
    }
  })

  // Transcript of a stored session. `sessionId` here is the SDK's id, which is
  // NOT our meta.id on a resumed session — see SessionMeta.sdkSessionId.
  ipcMain.handle(
    IPC.sessionTranscript,
    async (_e, { sessionId, dir }: { sessionId: string; dir?: string }): Promise<ChatItem[]> => {
      try {
        const msgs = await getSessionMessages(sessionId, { dir, limit: TRANSCRIPT_LIMIT })
        return normaliseTranscript(msgs as unknown as StoredMessage[])
      } catch (err) {
        console.warn('[sessions] getSessionMessages failed:', err)
        return []
      }
    },
  )

  ipcMain.handle(
    IPC.sessionSearch,
    async (
      _e,
      { query, dir }: { query: string; dir?: string },
    ): Promise<TranscriptSearchHit[]> => {
      if (!query.trim()) return []
      let sessions: Awaited<ReturnType<typeof listSessions>> = []
      try {
        sessions = await listSessions({ dir, limit: SEARCH_SESSION_LIMIT })
      } catch (err) {
        console.warn('[search] listSessions failed:', err)
        return []
      }

      // Read transcripts concurrently — these are local JSONL files, so the cost
      // is IO the event loop can overlap, not CPU.
      const hits = await Promise.all(
        sessions.map(async (s): Promise<TranscriptSearchHit | null> => {
          try {
            const msgs = await getSessionMessages(s.sessionId, { dir, limit: TRANSCRIPT_LIMIT })
            const hit = searchTranscript(msgs as unknown as StoredMessage[], query)
            if (!hit) return null
            return {
              sessionId: s.sessionId,
              summary: s.customTitle ?? s.summary ?? 'Untitled session',
              // Same fallback as toPastSession: a scoped query omits cwd.
              cwd: s.cwd ?? dir,
              lastModified: s.lastModified,
              snippet: hit.snippet,
              matches: hit.matches,
            }
          } catch {
            // One unreadable session must not sink the whole search.
            return null
          }
        }),
      )
      return hits.filter((h): h is TranscriptSearchHit => h !== null)
    },
  )

  ipcMain.handle(
    IPC.sessionFork,
    async (
      _e,
      { sessionId, upToMessageId, title }: { sessionId: string; upToMessageId?: string; title?: string },
    ): Promise<string | null> => {
      try {
        const { sessionId: forked } = await forkSession(sessionId, { upToMessageId, title })
        return forked
      } catch (err) {
        console.warn('[sessions] forkSession failed:', err)
        return null
      }
    },
  )

  ipcMain.handle(
    IPC.sessionRename,
    async (_e, { sessionId, title }: { sessionId: string; title: string }): Promise<boolean> => {
      try {
        await renameSession(sessionId, title)
        // Keep a live session's rail entry in step with the stored title.
        for (const s of sessions.values()) {
          if (s.meta.sdkSessionId === sessionId) s.setTitle(title)
        }
        return true
      } catch (err) {
        console.warn('[sessions] renameSession failed:', err)
        return false
      }
    },
  )
}
