import { readFile, stat } from 'node:fs/promises'
import { LspClient, phaseOf, type LspSignal } from './client.mts'
import { resolveServer, searchedFor, type Resolved } from './detect.mts'
import { languageOf, serverFor, toUri, sameUri, type ServerId } from '../shared/languages.mts'
import type { LspStatus } from '../shared/types'

/**
 * The fleet: which servers are running, and what each believes about the files.
 *
 * Lifecycle and document state live together because a path maps to exactly one
 * server, so "what does the fleet think this file says" is never a question that
 * spans two of them.
 *
 * Registry shape follows pty.ts deliberately: a Map keyed by id, idempotent
 * lazy start, errors swallowed and logged rather than thrown at callers, and a
 * disposeAll called from the owning process's shutdown.
 *
 * THIS RUNS IN THE HOST, not in main, and that is forced rather than chosen.
 * `createSdkMcpServer`'s tool handlers execute in whichever process called
 * `query()` — the host. A fleet in main would need reverse-RPC that hostwire
 * does not have, and would die at app quit while the agent kept running.
 * Keeping it here also means one document mirror shared by the agent and the
 * editor: two fleets would eventually disagree, and the moment the agent's "I
 * fixed it" contradicts the user's squiggles, the feature is worthless.
 */

interface Doc {
  uri: string
  languageId: string
  version: number
  text: string
  /** Refcount by purpose, so the editor closing a file cannot blind the
   *  diagnostics loop that also has it open, and vice versa. */
  owners: Set<'editor' | 'agent' | 'diag'>
  /** The editor has unsaved changes; disk is stale and must not overwrite. */
  dirty?: boolean
}

export interface Entry {
  client: LspClient
  resolved: Resolved
  startedAt: number
  restarts: number
  /** Absolute path -> mirror. */
  docs: Map<string, Doc>
  /** Latest push diagnostics, by uri. Servers that only support pull leave
   *  this empty and are read through textDocument/diagnostic instead. */
  pushed: Map<string, unknown[]>
  /** What the UI shows. Distinct from ServerReport.state, which only means "a
   *  binary was detected" and is computed in a different process entirely. */
  phase: LspStatus['phase']
  percent: number | null
  detail: string | null
}

const servers = new Map<ServerId, Entry>()
/**
 * Servers given up on, and why.
 *
 * `via` rides along because three of the four ways in here — a refused position
 * encoding, a failed handshake, a crash cap — happen AFTER a rung was resolved
 * and the command run, and the Entry holding it is deleted on the way. Without
 * this, the tooltip loses "jdtls" for exactly the failures where knowing which
 * binary died is the whole question.
 */
const failed = new Map<ServerId, { reason: string; via: string }>()
let root = ''

/**
 * Where fleet status goes, as a seam rather than an import.
 *
 * No .mts file here runtime-imports a value from a .ts one — the extension is
 * what lets these run under bare node for the check scripts — so this cannot
 * reach `send`/`IPC` itself. src/host/index.ts registers the listener, exactly
 * as tools.ts and diagnose.ts sidestep the same boundary.
 */
let statusListener: ((list: LspStatus[]) => void) | null = null

export function setStatusListener(fn: ((list: LspStatus[]) => void) | null): void {
  statusListener = fn
}

/** Every server the fleet has an opinion about: running, or given up on. */
export function lspStatuses(): LspStatus[] {
  const out: LspStatus[] = []
  for (const [id, e] of servers) {
    out.push({ id, via: e.resolved.via, phase: e.phase, percent: e.percent, detail: e.detail })
  }
  for (const [id, f] of failed) {
    // A server can be in both while a crashed one waits out its backoff; the
    // live entry is the truer of the two.
    if (servers.has(id)) continue
    // `via` is empty only for a detection failure, which never got as far as
    // resolving a rung; inventing one there would put a command in the tooltip
    // that was never run.
    out.push({ id, via: f.via, phase: 'failed', percent: null, detail: f.reason })
  }
  return out
}

/**
 * How two snapshots differ — which is what decides whether one is worth an event.
 *
 * `phase` — something started, finished, or failed. That is the thing the user
 *   is waiting to see, so it goes out immediately.
 * `percent` — only the numbers moved. Worth at most one event a second.
 * `same` — nothing moved. The host's sink does a synchronous appendFileSync per
 *   event and replays every one of them to every future client, so an event
 *   that says nothing new is a real cost, not a rounding error.
 */
export function statusDiff(a: LspStatus[], b: LspStatus[]): 'same' | 'percent' | 'phase' {
  if (a.length !== b.length) return 'phase'
  let diff: 'same' | 'percent' = 'same'
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!
    const y = b[i]!
    if (x.id !== y.id || x.phase !== y.phase || x.via !== y.via) return 'phase'
    if (x.percent !== y.percent || x.detail !== y.detail) diff = 'percent'
  }
  return diff
}

/**
 * What the host's throttle should hold, and whether to send it now.
 *
 * Split out of src/host/index.ts so `check:lspstatus` can pin it — the host is
 * a .ts file that spawns a session on load, so nothing here can import it, and
 * this is the half that is easy to get wrong.
 *
 * The subtle case is `same`. Live state catching back up with what the renderer
 * already has must CLEAR whatever the timer is holding, not just skip the send:
 * a frame armed a moment earlier is now older than the truth, and letting the
 * timer deliver it would leave `sentStatus` describing a state that no longer
 * exists — with nothing to correct it, because the very next comparison is
 * against that stale record. On a server that then goes quiet, nothing ever does.
 */
export function throttleStatus(
  list: LspStatus[],
  sent: LspStatus[],
): { pending: LspStatus[] | null; now: boolean } {
  const diff = statusDiff(list, sent)
  if (diff === 'same') return { pending: null, now: false }
  return { pending: list, now: diff === 'phase' }
}

function publish(): void {
  statusListener?.(lspStatuses())
}

function setPhase(entry: Entry, phase: LspStatus['phase'], detail: string | null): void {
  entry.phase = phase
  // A percentage only ever describes work in flight; carrying one into any
  // other phase would leave a half-full bar under a finished or dead server.
  // The words go the same way at `ready`: a server with nothing outstanding has
  // nothing to describe, and relaying the chatter of one that has latched ready
  // would be an event a second for a row the strip does not even render.
  if (phase !== 'indexing') entry.percent = null
  entry.detail = phase === 'ready' ? null : detail
  publish()
}

/** A frame from a server's own reports. */
function onServerStatus(id: ServerId, entry: Entry, sig: LspSignal): void {
  // A late frame from a client that has already been replaced by a restart.
  if (servers.get(id) !== entry) return
  // `starting` outranks anything the server says about its work: until the
  // handshake resolves we do not know there is a usable server at all, and
  // `failed` is terminal for this entry. Between those, its own reports decide
  // — with the entry's current phase passed in, because that is what latches a
  // server which has already reached `ready` (see phaseOf).
  const phase =
    entry.phase === 'starting' || entry.phase === 'failed'
      ? entry.phase
      : phaseOf(sig, entry.phase)
  // Through setPhase rather than around it. Assigning percent unconditionally
  // is what broke the invariant setPhase documents: a progress token opened
  // during the handshake left a 40%-full bar under `data-phase="starting"`,
  // which LspStrip does not even pulse.
  entry.percent = sig.percent
  setPhase(entry, phase, sig.detail)
}

export function setRoot(cwd: string): void {
  root = cwd
}

export function currentRoot(): string {
  return root
}

/** Pids for the host to record, so a dead host's servers can still be reaped. */
export function serverPids(): number[] {
  return [...servers.values()].map((e) => e.client.pid).filter((p): p is number => p !== undefined)
}

/** Why a language has no server, for the "ask the agent" strip. */
export function whyMissing(id: ServerId): { reason: string; tried: string[] } | null {
  const f = failed.get(id)
  return f ? { reason: f.reason, tried: searchedFor(id, root) } : null
}

export function statusLine(id: ServerId): string {
  const e = servers.get(id)
  if (!e) return failed.get(id)?.reason ?? 'not started'
  const secs = Math.round((Date.now() - e.startedAt) / 1000)
  return `${e.resolved.via}, up ${secs}s, ${e.docs.size} open`
}

/**
 * Start (or return) the server for an id.
 *
 * Idempotent, like spawnPty. A failure is remembered so the next twenty tool
 * calls do not each re-run `which` for a binary that is not installed.
 */
export async function ensure(id: ServerId): Promise<Entry | null> {
  const existing = servers.get(id)
  // Returned even while its initialize is still in flight — `servers.set` below
  // precedes the await — so a didChange arriving first finds the entry and no
  // doc, and editorChanged drops that edit. Self-heals on the next keystroke,
  // because sync is full-text. Pre-dates the proxy; not fixed here.
  if (existing && !existing.client.exited) return existing
  if (failed.has(id)) return null

  const resolved = resolveServer(id, root)
  console.error(`[lsp] ${id}: ${resolved ? resolved.via : 'no server found'}`)
  if (!resolved) {
    // The one failure with no rung to name: nothing was resolved, so nothing ran.
    failed.set(id, { reason: 'no server found', via: '' })
    publish()
    return null
  }

  const entry: Entry = {
    client: new LspClient(
      id,
      resolved.cmd,
      resolved.args,
      root,
      (uri, diags) => entry.pushed.set(uri, diags),
      (self) => onServerExit(id, self),
      (signal) => onServerStatus(id, entry, signal),
    ),
    resolved,
    startedAt: Date.now(),
    restarts: existing?.restarts ?? 0,
    docs: existing?.docs ?? new Map(),
    pushed: new Map(),
    phase: 'starting',
    percent: null,
    detail: null,
  }
  servers.set(id, entry)
  // BEFORE the await, deliberately: the gap documented above is the handshake
  // window — 3.7s for jdtls on a Maven project — and leaving it unannounced is
  // most of what makes a warming server look like a broken one.
  setPhase(entry, 'starting', null)

  try {
    const caps = await entry.client.start()
    // Assert rather than assume. A server answering utf-8 while we send utf-16
    // offsets produces hovers that are right on ASCII and wrong the moment a
    // line has an emoji — correct-looking output is the worst failure mode
    // available, so refuse instead.
    const enc = caps.positionEncoding ?? 'utf-16'
    if (enc !== 'utf-16') {
      failed.set(id, { reason: `unsupported positionEncoding "${enc}"`, via: resolved.via })
      void entry.client.dispose()
      servers.delete(id)
      publish()
      return null
    }
    // A restart has to re-open every document, or the server's view is empty
    // while ours says otherwise.
    for (const doc of entry.docs.values()) {
      entry.client.notify('textDocument/didOpen', {
        textDocument: { uri: doc.uri, languageId: doc.languageId, version: doc.version, text: doc.text },
      })
    }
    // The handshake is done. Whether ANSWERS are is a separate question, and
    // only the server's own reports settle it — read from the client rather
    // than waited for, since both arrive during the handshake.
    const sig = entry.client.status
    entry.percent = sig.percent
    setPhase(entry, phaseOf(sig, entry.phase), sig.detail)
    return entry
  } catch (err) {
    console.error(`[lsp:${id}] initialize failed:`, err)
    failed.set(id, { reason: `initialize failed: ${String(err)}`, via: resolved.via })
    // Including the timeout case, which is the whole reason this is here: a
    // server that has not answered `initialize` in fifteen seconds is still
    // RUNNING, and dropping the entry without this leaves it alive with nothing
    // referencing it and nothing left to kill it.
    void entry.client.dispose()
    servers.delete(id)
    publish()
    return null
  }
}

/**
 * Restart with backoff, giving up after five in five minutes.
 *
 * The cap matters: a server that crashes on this particular project would
 * otherwise respawn forever, and each attempt costs a process.
 */
function onServerExit(id: ServerId, self: LspClient): void {
  const entry = servers.get(id)
  if (!entry || entry.client !== self) return
  if (entry.restarts >= 5) {
    const reason = `crashed ${entry.restarts} times; giving up`
    failed.set(id, { reason, via: entry.resolved.via })
    servers.delete(id)
    publish()
    return
  }
  const delay = Math.min(16000, 1000 * 2 ** entry.restarts)
  entry.restarts += 1
  // Back to `starting` for the backoff: the entry stays in the map so an open
  // document still finds it, but nothing it is asked right now gets answered,
  // and leaving it reading `ready` would be a plain lie.
  setPhase(entry, 'starting', `restarting after crash ${entry.restarts}`)
  setTimeout(() => {
    if (servers.get(id) === entry) {
      servers.delete(id)
      void ensure(id)
    }
  }, delay).unref?.()
}

/** The server that should answer for a path, started if needed. */
export async function forPath(path: string): Promise<Entry | null> {
  const id = serverFor(path)
  return id ? ensure(id) : null
}

// ------------------------------------------------------------------ documents

export async function openDoc(
  path: string,
  owner: 'editor' | 'agent' | 'diag',
  text?: string,
): Promise<Entry | null> {
  const entry = await forPath(path)
  if (!entry) return null

  const existing = entry.docs.get(path)
  if (existing) {
    existing.owners.add(owner)
    return entry
  }

  const body = text ?? (await readFile(path, 'utf8').catch(() => null))
  if (body === null) return null

  const doc: Doc = {
    uri: toUri(path),
    languageId: languageOf(path) ?? 'plaintext',
    version: 1,
    text: body,
    owners: new Set([owner]),
  }
  entry.docs.set(path, doc)
  entry.client.notify('textDocument/didOpen', {
    textDocument: { uri: doc.uri, languageId: doc.languageId, version: doc.version, text: doc.text },
  })
  return entry
}

/**
 * The editor changed a document. Its buffer is authoritative until it saves.
 *
 * `dirty` is what stops `filesChanged` from overwriting an unsaved buffer with
 * whatever is still on disk — without it, an agent edit to any file would drag
 * every open editor document back to its saved contents inside the server.
 */
export async function editorChanged(path: string, text: string): Promise<void> {
  const entry = await forPath(path)
  const doc = entry?.docs.get(path)
  if (!entry || !doc || doc.text === text) return
  doc.text = text
  doc.version += 1
  doc.dirty = true
  entry.client.notify('textDocument/didChange', {
    textDocument: { uri: doc.uri, version: doc.version },
    contentChanges: [{ text }],
  })
}

export function closeDoc(path: string, owner: 'editor' | 'agent' | 'diag'): void {
  const id = serverFor(path)
  const entry = id ? servers.get(id) : undefined
  const doc = entry?.docs.get(path)
  if (!entry || !doc) return
  doc.owners.delete(owner)
  if (doc.owners.size > 0) return
  entry.docs.delete(path)
  entry.client.notify('textDocument/didClose', { textDocument: { uri: doc.uri } })
}

/**
 * Tell the fleet that files changed on disk.
 *
 * Full-text didChange for anything open — we do not know the diff, and a full
 * replace is always correct. For anything NOT open, a synthesised
 * didChangeWatchedFiles, because tsgo does not watch the filesystem: it asks
 * the client to watch and report. A file the agent wrote that nobody opened is
 * otherwise invisible to it.
 *
 * Synthesising from the agent's own tool calls beats a watcher on every axis.
 * It is exact — the agent names the path — it costs nothing when idle, and an
 * `npm install` is one Bash tool call rather than forty thousand filesystem
 * events. This repo already rejected a tree watcher once for that last reason.
 */
export async function filesChanged(paths: string[]): Promise<void> {
  const byServer = new Map<ServerId, { changed: string[]; open: string[] }>()
  for (const p of paths) {
    const id = serverFor(p)
    if (!id) continue
    const bucket = byServer.get(id) ?? { changed: [], open: [] }
    const entry = servers.get(id)
    if (entry?.docs.has(p)) bucket.open.push(p)
    else bucket.changed.push(p)
    byServer.set(id, bucket)
  }

  for (const [id, bucket] of byServer) {
    const entry = servers.get(id)
    if (!entry) continue

    for (const p of bucket.open) {
      const doc = entry.docs.get(p)!
      // An unsaved editor buffer outranks the file on disk. Reloading here
      // would tell the server the user's in-progress edit never happened.
      if (doc.dirty) continue
      const text = await readFile(p, 'utf8').catch(() => null)
      if (text === null) {
        // Deleted. didClose, then report it as a watched-file delete so the
        // server drops it from the project too.
        entry.docs.delete(p)
        entry.client.notify('textDocument/didClose', { textDocument: { uri: doc.uri } })
        entry.client.notify('workspace/didChangeWatchedFiles', {
          changes: [{ uri: doc.uri, type: 3 }],
        })
        continue
      }
      if (text === doc.text) continue
      doc.text = text
      doc.version += 1
      entry.client.notify('textDocument/didChange', {
        textDocument: { uri: doc.uri, version: doc.version },
        contentChanges: [{ text }],
      })
    }

    if (bucket.changed.length) {
      const changes = await Promise.all(
        bucket.changed.map(async (p) => ({
          uri: toUri(p),
          type: (await stat(p).then(() => 2).catch(() => 3)) as 1 | 2 | 3,
        })),
      )
      entry.client.notify('workspace/didChangeWatchedFiles', { changes })
    }
  }
}

/**
 * Diagnostics for one document a server already has open.
 *
 * Pull first, because tsgo does NOT push publishDiagnostics for open documents
 * — measured: after an incremental edit that introduced two errors, zero push
 * frames arrived and only the pull returned them. Push is still handled, since
 * plenty of other servers use it and some use both: jdtls is push-ONLY and
 * rejects `textDocument/diagnostic` outright.
 *
 * Which is why "rejected the pull" and "answered the pull with nothing" have to
 * stay distinct, and the truthiness of `res.items` is doing that on purpose: an
 * empty items array is a server saying "no problems in this file", and it must
 * WIN over `pushed`, which still holds whatever it published before the edit
 * that fixed them. Only a rejection — or a server that never advertised
 * diagnosticProvider at all — falls through. Getting that backwards leaves
 * corrected errors underlined until the file is closed.
 *
 * Shared with the editor: the proxy answers the renderer's pull with this
 * rather than forwarding it, so a push-only server's diagnostics reach Monaco,
 * whose only diagnostics path is a pull provider.
 */
export async function diagnosticsFor(entry: Entry, uri: string): Promise<unknown[]> {
  if (entry.client.caps.diagnosticProvider) {
    try {
      const res = (await entry.client.request('textDocument/diagnostic', {
        textDocument: { uri },
      })) as { items?: unknown[]; kind?: string } | null
      if (res?.items) return res.items
    } catch {
      /* fall through to whatever was pushed */
    }
  }
  for (const [pushedUri, diags] of entry.pushed) {
    if (sameUri(pushedUri, uri)) return diags
  }
  return []
}

/** Diagnostics for a path, opening it for the diagnostics loop if need be. */
export async function diagnose(path: string): Promise<unknown[]> {
  const entry = await openDoc(path, 'diag')
  if (!entry) return []
  return diagnosticsFor(entry, toUri(path))
}

/**
 * Forget every cached failure, so the next request re-runs detection.
 *
 * `failed` exists so twenty tool calls do not each re-run `which` for a binary
 * that is not installed — but that also means installing one mid-session has no
 * effect until something clears it. This is what makes "install it, then click
 * Recheck" work without restarting the app.
 */
export function recheck(): void {
  failed.clear()
  // The strip shows failures too, so clearing them here without saying so would
  // leave a red row for a server that is no longer considered broken.
  publish()
}

/** Every path any server currently has open — the default set to diagnose. */
export function openDocPaths(): string[] {
  const all = new Set<string>()
  for (const e of servers.values()) for (const p of e.docs.keys()) all.add(p)
  return [...all]
}

export async function disposeAll(): Promise<void> {
  const all = [...servers.values()]
  servers.clear()
  await Promise.all(all.map((e) => e.client.dispose()))
}
