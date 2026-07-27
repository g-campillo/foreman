import { ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
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
  type ElicitationAction,
  type ElicitationRequest,
  type PastSession,
  type PermissionRequest,
  type SendContent,
  type SessionMeta,
  type TranscriptSearchHit,
  type WorktreeInfo,
} from '../../shared/types'
import { createWorktree, removeWorktree } from './worktrees'
import {
  normaliseTranscript,
  searchTranscript,
  type StoredMessage,
} from './transcript.mts'
import { send } from '../bridge'
import type { SessionInit } from './session'
import { HostClient, policy, reapDeadHost, scanHosts } from './hostclient'
import {
  computeDiffs,
  revertFile,
  commitFiles,
} from './gitdiff'
import { listProjectFiles, FILE_LIMIT } from '../files'
import type { PermissionAnswer } from './permissions'

/**
 * Live agents, by session id.
 *
 * These are CLIENTS of detached host processes, not the sessions themselves —
 * the agent runs in its own process so it survives the app. Everything below
 * that used to be a method call is now a socket round-trip with the same name
 * and arguments, which is what kept the move mechanical.
 */
const sessions = new Map<string, HostClient>()

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
    cwd: canonical(s.cwd ?? dir),
    lastModified: s.lastModified,
    gitBranch: s.gitBranch,
  }
}

/**
 * Resolve symlinks so a past session's cwd compares equal to a live one's.
 *
 * `createSession` realpaths what it is given, but the SDK returns the path as
 * it was written — so without this the same project can appear twice in
 * recents, and Home's per-project spend can split across the two spellings.
 * Non-fatal: a deleted directory keeps whatever string it had.
 */
function canonical(path: string | undefined): string | undefined {
  if (!path) return path
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

function get(id: string): HostClient | undefined {
  return sessions.get(id)
}

/**
 * Call a method on a session's host, or return a neutral value if it is gone.
 *
 * Every read-only panel handler used `?? null` / `?? []` for exactly this, and
 * a disconnected host is one more way to be gone — a panel opened mid-teardown
 * must render "unavailable", not reject the renderer's invoke.
 */
async function callOr<T>(id: string, fallback: T, method: string, ...args: unknown[]): Promise<T> {
  const h = get(id)
  if (!h) return fallback
  try {
    return (await h.call<T>(method, ...args)) ?? fallback
  } catch {
    return fallback
  }
}

/**
 * `worktreeBranch` opts the session into its own isolated checkout instead of
 * the project's real cwd — the one-agent-per-repo assumption this function used
 * to hardcode. Everything downstream (snapshots, pty, @-mentions) keys off the
 * resolved cwd, so isolation costs nothing beyond swapping it here.
 */
export async function createSession(
  init: SessionInit & { worktreeBranch?: string },
): Promise<SessionMeta> {
  // Canonicalise once, here, so cwd / snapshot paths / pty all agree. Tools
  // report real paths, so an un-resolved symlink (e.g. macOS /tmp ->
  // /private/tmp) makes every diff path render as ../../private/tmp/...
  // An empty cwd would resolve to the process's own directory, which silently
  // starts the session in the wrong project — and on resume the CLI then reports
  // "No conversation found" for a session that exists perfectly well elsewhere.
  if (!init.cwd) throw new Error('createSession: cwd is required')

  const { worktreeBranch, ...rest } = init
  let base = init.cwd
  let worktree: WorktreeInfo | undefined
  let title = init.title

  if (worktreeBranch) {
    const made = await createWorktree(init.cwd, worktreeBranch)
    // Throwing rejects the renderer's invoke with this message, which is the
    // only channel that reaches the user before a session exists to show it in.
    if (!made.ok || !made.worktree) throw new Error(made.error ?? 'Could not create worktree')
    worktree = made.worktree
    base = made.worktree.path
    // Otherwise the title falls back to basename(cwd), which for a worktree is
    // the disambiguated directory name — "foreman-bed8-add-tests-ms25p582".
    // What the user typed is the useful label; the rail shows the full ref.
    title ??= worktreeBranch.trim()
  }

  let cwd = base
  try {
    cwd = realpathSync(base)
  } catch {
    /* path may not exist yet; fall back to as-given */
  }
  // The worktree's own path must be canonical too, or `git worktree remove`
  // is handed a path git doesn't recognise as the one it registered.
  if (worktree) worktree = { ...worktree, path: cwd }

  // The session id is minted HERE rather than inside Session, because it names
  // the host's directory and the client has to know it before the host exists.
  const sessionId = randomUUID()
  const host = await HostClient.start(
    { ...rest, cwd, ...(title ? { title } : {}), ...(worktree ? { worktree } : {}) },
    sessionId,
  )
  sessions.set(host.meta.id, host)
  return host.meta
}

/**
 * Re-attach to agents that were left running — the whole point of hosts.
 *
 * Three cases, and the third only exists because of crashes:
 *  - host alive        -> adopt it; its event log replays the transcript.
 *  - host dead         -> its `claude` child is orphaned with nothing to reap
 *                         it, and the recorded agentPid is the only handle on
 *                         it. Kill it and delete the directory.
 *  - unreadable meta   -> a half-written startup; scanHosts already removed it.
 *
 * Runs once at launch, before the renderer asks for its session list.
 */
export async function adoptHosts(): Promise<SessionMeta[]> {
  const found = scanHosts()
  const adopted: SessionMeta[] = []

  for (const f of found) {
    if (!f.live) {
      reapDeadHost(f)
      continue
    }
    try {
      const host = await HostClient.adopt(f.dir)
      sessions.set(host.meta.id, host)
      adopted.push(host.meta)
    } catch (err) {
      console.warn('[hosts] adopt failed, reaping:', f.dir, err)
      reapDeadHost(f)
    }
  }
  if (adopted.length) console.log(`[hosts] adopted ${adopted.length} running agent(s)`)
  return adopted
}

/**
 * Returns a note when a worktree was deliberately left behind, so the renderer
 * can say where the work went. Silent otherwise.
 */
export async function closeSession(id: string): Promise<{ notice?: string }> {
  const s = sessions.get(id)
  if (!s) return {}
  const { worktree } = s.meta
  // shutdown, not detach: closing a session is the one case where the user
  // really does mean "stop the agent", and it reaps the host's directory too.
  await s.shutdown()
  sessions.delete(id)
  send(IPC.evtRemoved, { sessionId: id })

  if (!worktree) return {}
  const { removed, reason } = await removeWorktree(worktree)
  return removed ? {} : { notice: reason }
}

/**
 * Quit path: detach from every host and leave the agents running.
 *
 * This is the inversion the whole batch exists for. It used to kill them, so
 * quitting mid-turn threw the turn away — and a crash was worse, because
 * `before-quit` never fires and the agent was orphaned with dead stdio.
 * Now quitting is just a disconnect; the hosts keep working, keep logging, and
 * are adopted by `adoptHosts()` next launch. They stop themselves after
 * FOREMAN_HOST_IDLE_MS with no client and no work, so this cannot leak forever.
 *
 * Worktrees are still deliberately NOT removed: quit has no time to check each
 * one for uncommitted work, and deleting a checkout during shutdown is
 * unrecoverable if that check is wrong.
 */
export function disposeAllSessions(): void {
  for (const s of sessions.values()) {
    // The user's choice, from Settings. 'stop' is best-effort by nature: quit
    // does not wait, and a crash cannot be intercepted either way — which is
    // why a crash-survivor is still adopted next launch rather than orphaned.
    if (policy.lifetime === 'stop') void s.shutdown()
    else s.detach()
  }
  sessions.clear()
}

/**
 * Answer a prompt without knowing which host parked it.
 *
 * The waiters live in the host processes now, and the renderer only sends a
 * requestId. Rather than mirroring a requestId -> sessionId map in main — more
 * state, and one more thing that can go stale after a crash — this asks every
 * host and lets the one that owns it say yes. `respondPermission` already
 * returns false for an id it doesn't have, so this is exactly its contract.
 *
 * O(sessions) per click, on a handful of sessions.
 */
async function broadcastRespond(method: string, answer: unknown): Promise<boolean> {
  const results = await Promise.all(
    [...sessions.values()].map((h) => h.call<boolean>(method, answer).catch(() => false)),
  )
  return results.some(Boolean)
}

export function registerSessionIpc(): void {
  ipcMain.handle(IPC.sessionCreate, (_e, init: SessionInit & { worktreeBranch?: string }) =>
    createSession(init),
  )

  ipcMain.handle(
    IPC.agentPolicy,
    (_e, next: { lifetime: 'persist' | 'stop'; idleMinutes: number; notifications: boolean }) => {
      Object.assign(policy, next)
      return true
    },
  )

  // --- prompts ------------------------------------------------------------
  // These used to be registerPermissionIpc/registerElicitationIpc in their own
  // modules; they moved here because answering now means reaching a host, and
  // the host map lives in this file.

  ipcMain.handle(IPC.permRespond, (_e, answer: PermissionAnswer) =>
    broadcastRespond('respondPermission', answer),
  )

  ipcMain.handle(
    IPC.elicitRespond,
    (
      _e,
      answer: { requestId: string; action: ElicitationAction; content?: Record<string, unknown> },
    ) => broadcastRespond('respondElicitation', answer),
  )

  /**
   * Prompts still parked, for a renderer that lost its cards.
   *
   * Now doubly necessary: it covers a renderer reload as before, and also an
   * app *restart* — a prompt raised while the app was closed is sitting in its
   * host waiting for an answer, and this is how it gets back on screen.
   */
  ipcMain.handle(IPC.pendingList, async () => {
    const all = await Promise.all(
      [...sessions.values()].map((h) =>
        h
          .call<{ approvals: PermissionRequest[]; elicitations: ElicitationRequest[] }>('pending')
          .catch(() => ({ approvals: [], elicitations: [] })),
      ),
    )
    return {
      approvals: all.flatMap((x) => x.approvals),
      elicitations: all.flatMap((x) => x.elicitations),
    }
  })

  // --- diffs --------------------------------------------------------------
  // Deliberately NOT a host call: these read git against a cwd and hold no
  // session state, so running them in main saves a round-trip and keeps them
  // working for a session whose host has gone away.

  ipcMain.handle(IPC.diffList, (_e, { sessionId, cwd }: { sessionId: string; cwd: string }) =>
    computeDiffs(sessionId, cwd),
  )
  ipcMain.handle(
    IPC.diffRevert,
    (_e, { sessionId, cwd, path }: { sessionId: string; cwd: string; path: string }) =>
      revertFile(sessionId, cwd, path),
  )
  ipcMain.handle(
    IPC.diffCommit,
    (
      _e,
      {
        sessionId,
        cwd,
        paths,
        message,
      }: { sessionId: string; cwd: string; paths: string[]; message: string },
    ) => commitFiles(sessionId, cwd, paths, message),
  )

  ipcMain.handle(IPC.sessionResume, (_e, init: SessionInit & { resume: string }) =>
    createSession(init),
  )

  ipcMain.handle(IPC.sessionClose, (_e, { sessionId }: { sessionId: string }) =>
    closeSession(sessionId),
  )

  ipcMain.handle(IPC.sessionList, () => [...sessions.values()].map((s) => s.meta))

  /**
   * Stream every adopted host's event log to the renderer.
   *
   * Deliberately renderer-triggered rather than automatic on connect: hosts are
   * adopted during `whenReady`, before a window exists, so an automatic replay
   * would go to a null sink. The renderer calls this once its onItem listener
   * is registered, which is the only moment it can safely receive a backlog.
   */
  ipcMain.handle(IPC.sessionReplay, async () => {
    await Promise.all(
      [...sessions.values()].map((h) => h.call('replay').catch(() => undefined)),
    )
    return true
  })

  ipcMain.handle(
    IPC.sessionSend,
    (_e, { sessionId, content }: { sessionId: string; content: SendContent }) => {
      void callOr(sessionId, undefined, 'send', content)
    },
  )

  ipcMain.handle(
    IPC.sessionCancelQueued,
    (_e, { sessionId, itemId }: { sessionId: string; itemId: string }) =>
      callOr(sessionId, false, 'cancelQueued', itemId),
  )

  ipcMain.handle(IPC.sessionCommands, (_e, { sessionId }: { sessionId: string }) =>
    callOr(sessionId, [], 'commands'),
  )

  // The popover wants a bare list and a short one; the tree wants the cap and a
  // `truncated` flag. Same git call, two callers, one implementation in files.ts.
  ipcMain.handle(IPC.sessionFiles, async (_e, { sessionId }: { sessionId: string }) => {
    const s = get(sessionId)
    return s ? (await listProjectFiles(s.meta.cwd, FILE_LIMIT)).paths : []
  })

  // Fire-and-forget from the renderer's point of view: replies come back as
  // evtLspMessage pushes, because a JSON-RPC reply is just another frame.
  ipcMain.handle(IPC.lspSend, (_e, { sessionId, msg }: { sessionId: string; msg: unknown }) =>
    callOr(sessionId, null, 'lspSend', msg),
  )

  ipcMain.handle(
    IPC.lspRequest,
    (_e, { sessionId, method, params }: { sessionId: string; method: string; params: unknown }) =>
      callOr(sessionId, null, 'lspRequest', method, params),
  )

  ipcMain.handle(IPC.sessionInterrupt, (_e, { sessionId }: { sessionId: string }) =>
    callOr(sessionId, undefined, 'interrupt'),
  )

  ipcMain.handle(
    IPC.sessionSetMode,
    (_e, { sessionId, mode }: { sessionId: string; mode: PermissionMode }) =>
      callOr(sessionId, undefined, 'setPermissionMode', mode),
  )

  ipcMain.handle(
    IPC.sessionSetModel,
    (_e, { sessionId, model }: { sessionId: string; model: string }) =>
      callOr(sessionId, undefined, 'setModel', model),
  )

  ipcMain.handle(IPC.sessionModels, (_e, { sessionId }: { sessionId: string }) =>
    callOr(sessionId, [], 'models'),
  )

  // Read-only panels. Each returns a neutral empty value when the session is
  // gone, so a panel opened mid-teardown renders "unavailable" rather than throwing.
  ipcMain.handle(IPC.sessionContextUsage, (_e, { sessionId }: { sessionId: string }) =>
    callOr(sessionId, null, 'contextUsage'),
  )
  ipcMain.handle(IPC.sessionAccount, (_e, { sessionId }: { sessionId: string }) =>
    callOr(sessionId, null, 'account'),
  )
  ipcMain.handle(IPC.sessionUsage, (_e, { sessionId }: { sessionId: string }) =>
    callOr(sessionId, null, 'usage'),
  )
  ipcMain.handle(IPC.sessionAgents, (_e, { sessionId }: { sessionId: string }) =>
    callOr(sessionId, [], 'agents'),
  )
  ipcMain.handle(IPC.sessionMcpStatus, (_e, { sessionId }: { sessionId: string }) =>
    callOr(sessionId, [], 'mcpStatus'),
  )
  ipcMain.handle(IPC.sessionReloadSkills, (_e, { sessionId }: { sessionId: string }) =>
    callOr(sessionId, [], 'reloadSkills'),
  )

  ipcMain.handle(
    IPC.sessionRewind,
    (_e, { sessionId, messageId, dryRun }: { sessionId: string; messageId: string; dryRun: boolean }) =>
      callOr(sessionId, { canRewind: false, error: 'No session', filesChanged: [], insertions: 0, deletions: 0 }, 'rewind', messageId, dryRun),
  )

  ipcMain.handle(
    IPC.sessionSetEffort,
    (_e, { sessionId, effort }: { sessionId: string; effort: EffortLevel | null }) =>
      callOr(sessionId, undefined, 'setEffort', effort),
  )

  ipcMain.handle(
    IPC.sessionBackground,
    (_e, { sessionId, toolUseId }: { sessionId: string; toolUseId?: string }) =>
      callOr(sessionId, false, 'background', toolUseId),
  )

  ipcMain.handle(
    IPC.sessionStopTask,
    (_e, { sessionId, taskId }: { sessionId: string; taskId: string }) =>
      callOr(sessionId, undefined, 'stopTask', taskId),
  )

  ipcMain.handle(
    IPC.mcpToggle,
    (_e, { sessionId, name, enabled }: { sessionId: string; name: string; enabled: boolean }) =>
      callOr(sessionId, undefined, 'toggleMcp', name, enabled),
  )

  ipcMain.handle(IPC.mcpReconnect, (_e, { sessionId, name }: { sessionId: string; name: string }) =>
    callOr(sessionId, undefined, 'reconnectMcp', name),
  )

  ipcMain.handle(
    IPC.mcpPermissionOverride,
    (
      _e,
      { sessionId, name, mode }: { sessionId: string; name: string; mode: 'default' | 'auto' | null },
    ) => callOr(sessionId, undefined, 'setMcpPermissionOverride', name, mode),
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
          if (s.meta.sdkSessionId === sessionId) void s.call('setTitle', title).catch(() => undefined)
        }
        return true
      } catch (err) {
        console.warn('[sessions] renameSession failed:', err)
        return false
      }
    },
  )
}
