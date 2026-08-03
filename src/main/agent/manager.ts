import { ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
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
  type McpActionResult,
  type McpServerInfo,
  type McpStatus,
  type PastSession,
  type PermissionAnswer,
  type PermissionRequest,
  type SendContent,
  type SessionMeta,
  type TranscriptSearchHit,
  type WorktreeInfo,
} from '../../shared/types'
import { createWorktree, removeWorktree, repoRoot } from './worktrees'
import { checkoutBranch, listBranches } from './branches'
import { within } from './policy.mts'
import {
  normaliseTranscript,
  searchTranscript,
  type StoredMessage,
} from './transcript.mts'
import { send } from '../bridge'
import type { SessionInit } from './session'
import { HostClient, policy, reapDeadHost, scanHosts } from './hostclient'
import { currentPathId } from '../shellpath'
import {
  computeDiffs,
  emitStats,
  revertFile,
  commitFiles,
} from './gitdiff'
import { listProjectFiles, FILE_LIMIT } from '../files'
import { killPty } from '../pty'

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

/**
 * The session the user is looking at, from the renderer.
 *
 * MAIN HOLDS THIS rather than asking the renderer to veto each hibernation, and
 * the difference matters: a veto is a round trip that can be missed, after which
 * main believes it reclaimed a session it did not. Null, or an id main has no
 * host for, both mean the same true thing — nothing live is on screen, which is
 * exactly the case when an asleep row is selected.
 */
let onScreenSessionId: string | null = null

/** How often the idle sweep looks. Far finer than the timeout it enforces, so
 *  the granularity of "30 minutes" is a minute rather than thirty. */
const IDLE_SWEEP_MS = 60_000

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
 * Every live session standing on a repository, for an operation that rewrites
 * the working directory under all of them at once.
 *
 * Containment, not equality: a session opened on `<repo>/src` is affected by a
 * checkout exactly as much as one opened on the root. Worktree sessions live
 * under `userData`, so they correctly fall OUTSIDE their own repo root and are
 * neither blocked by nor refreshed for a checkout on the main tree — which is
 * the whole point of a worktree.
 */
function sessionsUnder(root: string): HostClient[] {
  return [...sessions.values()].filter((h) => within(root, h.meta.cwd))
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
  host.onLost = hostLost
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
      const host = await HostClient.adopt(f)
      host.onLost = hostLost
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
export async function closeSession(
  id: string,
  fromRenderer?: WorktreeInfo,
): Promise<{ notice?: string }> {
  const s = sessions.get(id)
  // ONLY the host half is conditional. This used to return early when the map
  // had no entry, which after hibernation is EVERY sleeping session — so
  // archiving one skipped the single removeWorktree call site in the app. The
  // damage compounds: `git worktree remove` never runs, so the repo's
  // `.git/worktrees/<name>` admin entry survives; the directory still exists, so
  // `git worktree prune` will not collect it; and that entry keeps the branch
  // registered as checked out, so `git checkout` of it in the main tree fails
  // with "already checked out at …" permanently. `git branch -d` never runs
  // either, so refs pile up — the exact pile-up uniqueBranch exists to walk past.
  if (s) {
    // shutdown, not detach: closing a session is the one case where the user
    // really does mean "stop the agent", and it reaps the host's directory too.
    await s.shutdown()
    sessions.delete(id)
  }
  // node-pty lives in MAIN, not in the host — so nothing in the host's teardown
  // collects it, and a login shell survived per closed session until app quit.
  // Unconditional, because an asleep session can have opened a terminal too.
  killPty(id)
  // Emitted even for a session main was no longer holding: it is what tells the
  // renderer's own listeners (the terminal's slot registry) that this id is
  // finished. onRemoved ignores a row it has already dropped.
  send(IPC.evtRemoved, { sessionId: id })

  // Main's own copy wins where it has one; the renderer's row is the fallback
  // for a session main no longer holds, which is the only way a hibernated
  // worktree can be named at all. Everything downstream is still git's to
  // refuse: removeWorktree checks for uncommitted work, `worktree remove`
  // rejects a path this repository never registered, and `branch -d` rejects a
  // branch carrying commits.
  const worktree = s?.meta.worktree ?? fromRenderer
  if (!worktree) return {}
  const { removed, reason } = await removeWorktree(worktree)
  return removed ? {} : { notice: reason }
}

/**
 * Give a session's processes back without ending the conversation.
 *
 * ONE LINE SEPARATES THIS FROM closeSession, and it is the line that is not
 * here: **removeWorktree is never called**. A session that merely went idle must
 * keep its checkout — deleting a user's working tree because they stopped typing
 * for half an hour is unrecoverable. The other difference is the event:
 * `evtHibernated`, so the renderer turns the row asleep instead of dropping it.
 *
 * `shutdown()` is reused exactly as it is. It kills the host, and with it the
 * `claude` CLI, its MCP fleet and its language servers — measured at about 2 GB
 * for one live session — and removes the host's directory. That last part is
 * correct rather than a cost: waking re-hydrates from the CLI's own transcript
 * through hydrateInto, which is what `resume` has always done.
 */
export async function hibernateSession(id: string): Promise<void> {
  const s = sessions.get(id)
  if (!s) return
  await s.shutdown()
  sessions.delete(id)
  killPty(id)
  send(IPC.evtHibernated, { sessionId: id })
}

/**
 * A host that went away without being asked to — a crash, or its own idle exit.
 *
 * This is what `hostclient.ts` used to only claim happened. The row degrades to
 * asleep, which is honest and recoverable: the conversation is still on disk and
 * sending wakes it. Synchronous and idempotent, because it runs from a socket
 * event and a `close` can fire more than once.
 */
function hostLost(id: string): void {
  if (!sessions.delete(id)) return
  killPty(id)
  console.warn(`[hosts] lost contact with ${id}; the conversation is now asleep`)
  send(IPC.evtHibernated, { sessionId: id })
}

/**
 * Hibernate every live session that nobody is using.
 *
 * MAIN DRIVES THIS, not the host, and that is not where it started. `armIdleExit`
 * in the host begins `if (clients.size > 0) return`, and main holds a socket to
 * every host for the app's whole life — so the host's own idle timer is
 * permanently disarmed while Foreman is open. It is a crash backstop, not a
 * policy. Main is also the only side that can answer the two questions that
 * matter: which session is on screen, and how long each one has been quiet.
 *
 * Four conditions, all required:
 *  - not the session being read. Reclaiming what the user is looking at would
 *    make the app feel broken however cheap the wake is.
 *  - not busy. A turn in flight, or a prompt waiting on an answer, is work that
 *    must not be thrown away.
 *  - no live background tasks. This is NOT covered by the status test and that
 *    is the whole reason `activityOf` has a `background` activity outranking
 *    idle: a session whose turn has ended while a build or a dev server keeps
 *    running reports `idle`, and emits no event frames while it does — so
 *    `lastActivity` goes stale and the sweep would shut down exactly the work
 *    the user cannot see. The host's own test omits this too, which was
 *    harmless only because that test was unreachable while the app was open.
 *  - quiet for longer than the configured timeout. 0 still means never — see
 *    the mapping in hostclient's spawn env, which this deliberately mirrors.
 */
async function sweepIdleSessions(): Promise<void> {
  if (policy.idleMinutes <= 0) return
  const limit = policy.idleMinutes * 60_000
  const now = Date.now()
  // A copy: hibernateSession deletes from the map this is walking.
  for (const [id, h] of [...sessions]) {
    if (id === onScreenSessionId) continue
    if (h.meta.status === 'running' || h.meta.status === 'awaiting-approval') continue
    if (h.meta.backgroundTasks.length > 0) continue
    if (now - h.lastActivity < limit) continue
    console.log(`[hosts] hibernating ${id} after ${policy.idleMinutes}m idle`)
    await hibernateSession(id).catch((err) => console.warn('[hosts] hibernate failed:', err))
  }
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

/**
 * The CLI's 15-minute "don't bother retrying" cache, and why we reach into it.
 *
 * When a stdio MCP server fails to connect, the bundled `claude` binary records
 * it in `~/.claude/mcp-needs-auth-cache.json` and skips that server for the next
 * fifteen minutes — that is where the *"Skipping connection (recent failure
 * cached; retries automatically in 15 min…)"* text comes from. The string lives
 * in the binary, not in Foreman, and there is no flag to clear it.
 *
 * The explicit reconnect below bypasses the cache, so this is not about making
 * the button work. It is about the NEXT session: a failed reconnect rewrites the
 * entry with a fresh timestamp, so leaving it in place means a session started
 * two minutes later doesn't even attempt the server and reports a cached failure
 * instead of a real one. On success the CLI removes the entry itself and this is
 * a no-op.
 *
 * User-global, not session-scoped, which is why it happens in main rather than
 * inside a host. Best-effort throughout: a missing or unreadable file means
 * there is nothing cached to clear.
 */
function clearMcpFailureCache(name: string): void {
  const file = join(homedir(), '.claude', 'mcp-needs-auth-cache.json')
  try {
    const cache = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    if (!(name in cache)) return
    delete cache[name]
    writeFileSync(file, JSON.stringify(cache))
  } catch {
    /* no file, or not ours to parse — either way there is nothing to clear */
  }
}

export function registerSessionIpc(): void {
  // Registered once at startup, and deliberately never cleared: it outlives
  // every session, and unref'ing it would let a sweep be skipped whenever the
  // event loop happened to be otherwise empty.
  setInterval(() => void sweepIdleSessions(), IDLE_SWEEP_MS)

  ipcMain.handle(IPC.sessionCreate, (_e, init: SessionInit & { worktreeBranch?: string }) =>
    createSession(init),
  )

  ipcMain.handle(IPC.sessionActive, (_e, { sessionId }: { sessionId: string | null }) => {
    onScreenSessionId = sessionId
    return true
  })

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

  // --- branches -----------------------------------------------------------

  ipcMain.handle(IPC.gitBranches, (_e, { cwd }: { cwd: string }) => listBranches(cwd))

  /**
   * Check a branch out, on behalf of every session standing on that tree.
   *
   * A checkout rewrites the working directory under whoever is in it, so it is
   * refused while any session on this tree is mid-turn — an agent reading a file
   * that changes under it produces failures with no visible cause. The refusal
   * NAMES the session, because with three tabs open "something is busy" is not
   * an actionable sentence.
   *
   * On success, one emitStats per affected session. That single event carries
   * both the new branch and the new line totals, which is every downstream
   * refresh in one hop: the badge, the composer's branch label, the file tree,
   * the diff panel and the editor's gutter decorations.
   *
   * Left deliberately stale: an already-open FileModal buffer (which fails safely
   * on save via expectMtimeMs), SessionMeta.worktree.branch (cosmetic — Composer
   * prefers the live value), and the LSP servers (IPC.lspRecheck exists; out of
   * scope here).
   */
  ipcMain.handle(
    IPC.gitCheckout,
    async (
      _e,
      {
        sessionId,
        cwd,
        name,
        remote,
      }: { sessionId: string; cwd: string; name: string; remote: string | null },
    ) => {
      const root = await repoRoot(cwd)
      if (!root) return { ok: false, error: 'Not a git repository.' }

      const busy = sessionsUnder(root).find(
        (h) => h.meta.status === 'running' || h.meta.status === 'awaiting-approval',
      )
      if (busy) {
        return {
          ok: false,
          error: `${busy.meta.title} is mid-turn on this tree — interrupt it first.`,
        }
      }

      const result = await checkoutBranch(cwd, name, remote)
      if (!result.ok) return result

      // The asker is included by id even if its host has gone away, so the
      // window it is looking at still updates. A Map, because it is usually one
      // of the same sessions and a double emit would be a wasted git read.
      const targets = new Map(sessionsUnder(root).map((h) => [h.meta.id, h.meta.cwd]))
      targets.set(sessionId, cwd)
      await Promise.all([...targets].map(([id, dir]) => emitStats(id, dir).catch(() => undefined)))
      return result
    },
  )

  ipcMain.handle(IPC.sessionResume, (_e, init: SessionInit & { resume: string }) =>
    createSession(init),
  )

  // `worktree` rides along from the renderer's row, because a hibernated
  // session's checkout is otherwise unnameable — main dropped its meta when the
  // host went away. See closeSession.
  ipcMain.handle(
    IPC.sessionClose,
    (_e, { sessionId, worktree }: { sessionId: string; worktree?: WorktreeInfo }) =>
      closeSession(sessionId, worktree),
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
    // `h.replay()`, not `h.call('replay')`: the call resolves as soon as the
    // host has opened its log, while the frames are still on the way. The
    // renderer awaits this to know when a resumed transcript has landed — see
    // HostClient.replay and the store's `hydrating`.
    await Promise.all([...sessions.values()].map((h) => h.replay().catch(() => undefined)))
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

  // `false` as the fallback, like cancelQueued: a session that has gone away
  // cannot be holding the message, and the tray reads the answer to decide
  // whether to close its editor.
  ipcMain.handle(
    IPC.sessionEditQueued,
    (
      _e,
      { sessionId, itemId, content }: { sessionId: string; itemId: string; content: SendContent },
    ) => callOr(sessionId, false, 'editQueued', itemId, content),
  )

  ipcMain.handle(IPC.sessionCommands, (_e, { sessionId }: { sessionId: string }) =>
    callOr(sessionId, [], 'commands'),
  )

  // The popover wants a bare list and a short one; the tree wants the cap and a
  // `truncated` flag. Same git call, two callers, one implementation in files.ts.
  //
  // The renderer's cwd is the fallback, the same posture the diff handlers take:
  // this is a git read against a directory and holds no session state, so
  // answering only for a session with a live host made `@`-file completion come
  // back empty on every ASLEEP conversation. Main's own copy still wins.
  ipcMain.handle(
    IPC.sessionFiles,
    async (_e, { sessionId, cwd }: { sessionId: string; cwd?: string }) => {
      const dir = get(sessionId)?.meta.cwd ?? cwd
      return dir ? (await listProjectFiles(dir, FILE_LIMIT)).paths : []
    },
  )

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

  ipcMain.handle(IPC.lspRecheck, (_e, { sessionId }: { sessionId: string }) =>
    callOr(sessionId, false, 'lspRecheck'),
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
  /**
   * The server list, plus whether reconnecting anything in it can even work.
   *
   * `staleEnv` is decided here rather than in the host because the host is the
   * one process that cannot see it: its environment is whatever it was spawned
   * with, so comparing that against what main has NOW is only possible on this
   * side. A host adopted from a previous run carries its id in `meta.json`; one
   * started by a build older than the PATH fix has none, which is the same case.
   */
  ipcMain.handle(
    IPC.sessionMcpStatus,
    async (_e, { sessionId }: { sessionId: string }): Promise<McpStatus> => {
      const servers = await callOr<McpServerInfo[]>(sessionId, [], 'mcpStatus')
      const host = get(sessionId)
      return { servers, staleEnv: !!host && host.pathId !== currentPathId() }
    },
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

  ipcMain.handle(
    IPC.mcpReconnect,
    async (_e, { sessionId, name }: { sessionId: string; name: string }): Promise<McpActionResult> => {
      const result = await callOr<McpActionResult>(
        sessionId,
        { ok: false, error: 'This session is no longer running.' },
        'reconnectMcp',
        name,
      )
      // Success or failure — see clearMcpFailureCache. A failed attempt has just
      // re-stamped the entry, and that stale stamp is what makes the next
      // session skip the server outright.
      clearMcpFailureCache(name)
      return result
    },
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
