import { ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
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
  type WorktreeReport,
  type WorktreeRow,
} from '../../shared/types'
import {
  createWorktree,
  listWorktrees,
  mainRoot,
  orphanedCheckouts,
  pruneWorktrees,
  removeOrphan,
  removeWorktree,
  repoRoot,
} from './worktrees'
import { checkoutBranch, listBranches } from './branches'
import { underWorktrees, within } from './policy.mts'
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
 * Every live session standing on a repository's MAIN working tree, for an
 * operation that rewrites the working directory under all of them at once.
 *
 * Containment, not equality: a session opened on `<repo>/src` is affected by a
 * checkout exactly as much as one opened on the root.
 *
 * ...and the `underWorktrees` half is what keeps that true now that worktrees
 * live INSIDE the repo. A linked checkout at `<repo>/.worktrees/x` passes
 * `within` — honestly, it is under the repo — but a checkout on the main tree
 * cannot touch it, because it is a separate working tree with its own HEAD. It
 * used to fall outside for free, by living under `userData`. Without the
 * exclusion, `gitCheckout` refuses to switch branch in the main tree whenever
 * ANY worktree agent is mid-turn, which is precisely the thing worktrees exist
 * to make safe.
 */
function sessionsUnder(root: string): HostClient[] {
  return [...sessions.values()].filter(
    (h) => within(root, h.meta.cwd) && !underWorktrees(root, h.meta.cwd),
  )
}

/**
 * The live session standing in exactly this directory, if there is one.
 *
 * ONE FUNCTION for the two places that ask, because they used to disagree and
 * the looser of the two was the one that DELETES: the panel's report compared
 * canonically while the removal handler compared raw strings, so a worktree
 * registered as `/tmp/x` and running as `/private/tmp/x` was shown as in use and
 * removed anyway. `meta.cwd` is realpath'd at create time and git prints the
 * path as it was registered, so the two spellings genuinely differ on macOS.
 */
function sessionIn(path: string): HostClient | undefined {
  const real = canonical(path) ?? path
  return [...sessions.values()].find((h) => h.meta.cwd === path || h.meta.cwd === real)
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
  if (worktreeBranch) {
    // git just reported creating this directory, so a miss here is a half-failed
    // create rather than "the path may not exist yet" — and swallowing it starts
    // the agent in an un-canonicalised path whose every diff renders as
    // `../../private/...`, or in a directory that is not there at all.
    if (!existsSync(base)) throw new Error(`Worktree was not created at ${base}`)
    cwd = realpathSync(base)
  } else {
    try {
      cwd = realpathSync(base)
    } catch {
      /* path may not exist yet; fall back to as-given */
    }
  }
  // The worktree's own path must be canonical too, or `git worktree remove`
  // is handed a path git doesn't recognise as the one it registered. So must
  // `repoRoot`: projectKey in the renderer deliberately does NOT realpath (it
  // has no fs), so `/tmp/repo` and `/private/tmp/repo` split one project into
  // two groups in the rail.
  if (worktree) worktree = { ...worktree, path: cwd, repoRoot: canonical(worktree.repoRoot) ?? worktree.repoRoot }

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
 * The transcript file for an SDK session id, wherever it was written.
 *
 * `~/.claude/projects/<mangled-cwd>/<uuid>.jsonl` — the same shape the SDK's own
 * dir-less locator scans, and the scan is why this exists: the mangling is of
 * the ORIGINAL cwd, which for a stranded session is a worktree that no longer
 * exists, so it cannot be reconstructed from anything we still hold.
 *
 * Returns null rather than throwing on a missing `~/.claude/projects`, which is
 * an ordinary state for a machine that has never run the CLI outside Foreman.
 */
function transcriptFileFor(sdkSessionId: string): string | null {
  const root = join(homedir(), '.claude', 'projects')
  let dirs: string[]
  try {
    dirs = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return null
  }
  for (const d of dirs) {
    const file = join(root, d, `${sdkSessionId}.jsonl`)
    if (existsSync(file)) return file
  }
  return null
}

/**
 * The nearest ancestor of `path` that still exists, preferring a repository.
 *
 * Two passes rather than one, because "the nearest directory that is there" and
 * "the project this conversation was about" are different answers and the second
 * is the one worth having: a worktree at `<repo>/.worktrees/x` that was removed
 * leaves `<repo>/.worktrees` behind quite often, and landing the session there
 * would give it a cwd with no git, no files and no meaning.
 */
function nearestLiveDir(path: string): string | null {
  const climb = (test: (dir: string) => boolean): string | null => {
    let dir = path
    for (;;) {
      if (existsSync(dir) && test(dir)) return dir
      const up = dirname(dir)
      if (up === dir) return null
      dir = up
    }
  }
  return climb((d) => existsSync(join(d, '.git'))) ?? climb(() => true)
}

/**
 * Restart a session whose working directory has gone away, somewhere that has
 * not.
 *
 * THE REPORTED FAILURE: an agent working in its own worktree merged its branch
 * and removed the checkout it was standing in — so the next message came back as
 * `Path "…/worktrees/foreman-…-msdce2wf" does not exist`. Prune does the same
 * thing deliberately.
 *
 * `SessionMeta.cwd` IS IMMUTABLE, which is what makes this a restart rather than
 * a patch: the `claude` subprocess's cwd is fixed at spawn, and makeDiffHook and
 * makeDiagnosticsHook capture theirs in closures — so a session that merely
 * rewrote the field would keep running in the deleted directory and reporting
 * diffs against it. The host goes and a new one starts UNDER THE SAME SESSION
 * ID, so unlike `wake` (which has to rekey eight renderer slices) nothing keyed
 * by the id moves at all.
 *
 * Resumed by FILE, not by uuid — see SessionInit.resumeFile. `--resume <uuid>`
 * resolves against the cwd's project directory and then against `git worktree
 * list`, and once the worktree is unregistered both miss: re-homing by uuid
 * would trade `Path … does not exist` for `No conversation found with session
 * ID`. The `worktree` field goes with the checkout, because there is no longer
 * one to point the branch badge or the diff panel at.
 *
 * Returns the note to show, or null when nothing needed doing — which is the
 * overwhelmingly common case, and costs one `existsSync` per send.
 */
export async function rehome(id: string): Promise<string | null> {
  // A restart takes about a second, and during it this session has NO entry in
  // the map — so a second message arriving in that window would find no host and
  // be dropped without a word. Joining the in-flight restart is the whole fix:
  // by the time it resolves, the new host is registered. Same shape as the
  // in-flight map in branches.ts, and deliberately not a cache: the entry is
  // removed the moment the restart settles.
  const running = rehoming.get(id)
  if (running) return running

  const h = sessions.get(id)
  if (!h) return null
  const old = h.meta
  if (existsSync(old.cwd)) return null

  const p = restartElsewhere(id, old).finally(() => rehoming.delete(id))
  rehoming.set(id, p)
  return p
}

/** Restarts in flight, by session id — see rehome. */
const rehoming = new Map<string, Promise<string | null>>()

/** rehome's body, split out only so the in-flight entry above can be registered
 *  before the first `await` rather than after it. */
async function restartElsewhere(id: string, old: SessionMeta): Promise<string | null> {
  // The repo the worktree belonged to is the honest destination and the one the
  // user thinks in. The climb is for a session with no worktree at all — a
  // project directory that was moved or deleted out from under it.
  const home =
    (old.worktree?.repoRoot && existsSync(old.worktree.repoRoot) ? old.worktree.repoRoot : null) ??
    nearestLiveDir(old.cwd) ??
    homedir()

  const resume = old.sdkSessionId ?? undefined
  const resumeFile = resume ? (transcriptFileFor(resume) ?? undefined) : undefined

  await sessions.get(id)?.shutdown().catch(() => undefined)
  sessions.delete(id)
  killPty(id)

  let restarted: HostClient
  try {
    restarted = await HostClient.start(
      {
        cwd: home,
        title: old.title,
        ...(resume ? { resume } : {}),
        ...(resumeFile ? { resumeFile } : {}),
        permissionMode: old.permissionMode,
        ...(old.model ? { model: old.model } : {}),
        ...(old.effort ? { effort: old.effort } : {}),
        // From main's own copy of the policy, because there is no renderer call
        // behind this one to carry them — see hostclient's `policy`.
        ...(policy.maxBudgetUsd > 0 ? { maxBudgetUsd: policy.maxBudgetUsd } : {}),
        ...(policy.maxTurns > 0 ? { maxTurns: policy.maxTurns } : {}),
      },
      id,
    )
    restarted.onLost = hostLost
    sessions.set(id, restarted)
  } catch (err) {
    // THE SESSION IS ALREADY OUT OF THE MAP AND ITS HOST DIRECTORY IS ALREADY
    // REAPED by the shutdown above, so a rejection here leaves a rail row with
    // nothing behind it and nothing that will ever say so: `adoptHosts` cannot
    // find it at next launch either, because the directory is gone. Both of
    // HostClient.start's failure modes are real — sockPathProblem, and attach's
    // 5s connect timeout.
    //
    // So say exactly what hostLost says, and for the same reason: a conversation
    // whose host went away is ASLEEP, which is honest and recoverable — the
    // transcript is on disk and sending wakes it. Rethrown so the send path has
    // something to report rather than dropping the message into the `callOr`
    // fallback in silence.
    console.warn(`[hosts] could not restart ${id} in ${home}:`, err)
    send(IPC.evtHibernated, { sessionId: id })
    throw err
  }

  const note = old.worktree
    ? `The worktree for ${old.worktree.branch} is gone. This conversation is now running in ${home}.`
    : `${old.cwd} is gone. This conversation is now running in ${home}.`
  send(IPC.evtRehomed, { sessionId: id, meta: restarted.meta, note })
  // Or the branch label and the diff badge go on reporting the worktree that no
  // longer exists, which is the same lie in a smaller place.
  void emitStats(id, home).catch(() => undefined)
  return note
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
    (
      _e,
      next: {
        lifetime: 'persist' | 'stop'
        idleMinutes: number
        notifications: boolean
        maxBudgetUsd: number
        maxTurns: number
      },
    ) => {
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

  /**
   * Everything the Worktrees panel shows, in one call.
   *
   * `inUse` is the reason it is one call rather than three: the panel has to be
   * able to refuse a removal under a live agent, AND to say — before Prune runs
   * — what pruning will do to the conversations standing in these directories.
   * Prune is what unregisters the entries the CLI's own `--resume` fallback
   * scans, so a session pruned out from under gets re-homed on its next message
   * rather than resuming where it was. That is recoverable, and it is still not
   * something to do to someone without telling them.
   *
   * `mainRoot`, NEVER `repoRoot`, in all three of these handlers: the panel is
   * handed the active session's own directory, and the ⌘N-from-a-worktree
   * session that E1 exists to fix has no `worktree` field to resolve past — so
   * `cwd` is routinely a linked checkout, whose `--show-toplevel` is itself.
   */
  ipcMain.handle(IPC.worktreeList, async (_e, { cwd }: { cwd: string }): Promise<WorktreeReport> => {
    const root = await mainRoot(cwd)
    if (!root) return { root: null, rows: [] }
    const [entries, orphans] = await Promise.all([listWorktrees(root), orphanedCheckouts(root)])
    const inUse = (path: string): boolean => sessionIn(path) !== undefined

    const rows: WorktreeRow[] = entries.map((w, i) => ({
      path: w.path,
      branch: w.branch,
      // git lists the MAIN worktree first, always — it is the repository, and
      // there is no flag on the record that says so.
      main: i === 0,
      prunable: w.prunable,
      orphan: false,
      inUse: inUse(w.path),
    }))
    for (const path of orphans) {
      rows.push({ path, branch: null, main: false, prunable: false, orphan: true, inUse: inUse(path) })
    }
    return { root, rows }
  })

  ipcMain.handle(IPC.worktreePrune, async (_e, { cwd }: { cwd: string }) => {
    const root = await mainRoot(cwd)
    if (!root) return { ok: false, error: 'Not a git repository.' }
    return pruneWorktrees(root)
  })

  /**
   * Delete a leftover checkout.
   *
   * Refused under a live agent HERE as well as in the panel: the panel's copy is
   * the explanation, this one is the rule — through the SAME `sessionIn`, so the
   * rule cannot end up looser than the explanation. Everything else this can
   * refuse — membership of the orphan list, containment, uncommitted work — is
   * `removeOrphan`'s, which re-derives all of it rather than trusting the path
   * that came over the wire.
   */
  ipcMain.handle(IPC.worktreeRemove, async (_e, { cwd, path }: { cwd: string; path: string }) => {
    const root = await mainRoot(cwd)
    if (!root) return { removed: false, reason: 'Not a git repository.' }
    const busy = sessionIn(path)
    if (busy) return { removed: false, reason: `${busy.meta.title} is running in that directory.` }
    return removeOrphan(root, path)
  })

  /**
   * The DEAD-HOST half of re-homing. `rehome` restarts a host it can still see;
   * a hibernated worktree session has none, and the row's `cwd` is a directory
   * that may have gone away while the app was closed.
   *
   * Resolved BEFORE createSession rather than after, because createSession
   * spawns into that cwd — there is nothing to repair afterwards. `worktree` is
   * dropped with the checkout for the reason `rehome` gives, and `resumeFile`
   * takes over from the uuid because the CLI's own lookup scans a project
   * directory named after a cwd that no longer exists.
   */
  ipcMain.handle(IPC.sessionResume, (_e, init: SessionInit & { resume: string }) => {
    if (existsSync(init.cwd)) return createSession(init)
    const { worktree, ...rest } = init
    const cwd =
      (worktree?.repoRoot && existsSync(worktree.repoRoot) ? worktree.repoRoot : null) ??
      nearestLiveDir(init.cwd) ??
      homedir()
    const resumeFile = transcriptFileFor(init.resume)
    console.warn(`[hosts] ${init.cwd} is gone; resuming ${init.resume} in ${cwd}`)
    return createSession({ ...rest, cwd, ...(resumeFile ? { resumeFile } : {}) })
  })

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
    async (_e, { sessionId, content }: { sessionId: string; content: SendContent }) => {
      // ON THE SEND PATH, because that is where the failure was observed and the
      // only place it matters: a cwd that has gone away is harmless right up
      // until something has to run in it. One existsSync per message, and
      // `rehome` returns immediately when the directory is there.
      //
      // AWAITED, AND ITS REJECTION IS NOT SWALLOWED. A failed restart leaves no
      // host, so `callOr` would fall straight through to its `undefined`
      // fallback and the user's message would vanish with nothing on screen —
      // and every send after it would do the same. Rejecting the invoke is what
      // puts it in front of them; see store.send.
      await rehome(sessionId)
      await callOr(sessionId, undefined, 'send', content)
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

  /**
   * History, scoped to a project.
   *
   * THE SCOPE IS NOW THE REPO ROOT, not the session's cwd — see SessionRail —
   * and a conversation held in a worktree is filed under the WORKTREE's path,
   * because that is the cwd the CLI recorded it against. So a single scoped
   * `listSessions` misses every worktree conversation the project ever had.
   * Each registered checkout is queried too and the results deduped by
   * sessionId, which is what puts them back in scoped History.
   *
   * Only the REGISTERED ones: an unregistered checkout is one whose conversation
   * has already been re-homed, or one git never knew about. The global list (no
   * `dir`) is one toggle away and still finds those.
   */
  ipcMain.handle(IPC.sessionPastList, async (_e, { dir }: { dir?: string }): Promise<PastSession[]> => {
    const read = async (d?: string): Promise<PastSession[]> => {
      try {
        return (await listSessions({ dir: d, limit: 40 })).map((x) => toPastSession(x, d))
      } catch (err) {
        console.warn('[sessions] listSessions failed:', err)
        return []
      }
    }
    if (!dir) return read(undefined)

    const trees = await listWorktrees(dir).catch(() => [])
    const dirs = [dir, ...trees.map((w) => w.path).filter((p) => p && p !== dir)]
    const lists = await Promise.all(dirs.map(read))
    const seen = new Set<string>()
    const out: PastSession[] = []
    for (const row of lists.flat()) {
      if (seen.has(row.sessionId)) continue
      seen.add(row.sessionId)
      out.push(row)
    }
    // Newest first across the union — each list is sorted on its own, and
    // concatenating them would interleave two orderings. `?? 0` because the SDK
    // leaves lastModified off a row it could not stat; those sort to the end
    // rather than throwing the comparator.
    out.sort((a, b) => (b.lastModified ?? 0) - (a.lastModified ?? 0))
    return out.slice(0, 40)
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
