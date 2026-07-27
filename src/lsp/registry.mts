import { readFile, stat } from 'node:fs/promises'
import { LspClient } from './client.mts'
import { resolveServer, searchedFor, type Resolved } from './detect.mts'
import { languageOf, serverFor, toUri, sameUri, type ServerId } from './languages.mts'

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
}

interface Entry {
  client: LspClient
  resolved: Resolved
  startedAt: number
  restarts: number
  /** Absolute path -> mirror. */
  docs: Map<string, Doc>
  /** Latest push diagnostics, by uri. Servers that only support pull leave
   *  this empty and are read through textDocument/diagnostic instead. */
  pushed: Map<string, unknown[]>
}

const servers = new Map<ServerId, Entry>()
const failed = new Map<ServerId, string>()
let root = ''

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
  const r = failed.get(id)
  return r ? { reason: r, tried: searchedFor(id, root) } : null
}

export function statusLine(id: ServerId): string {
  const e = servers.get(id)
  if (!e) return failed.get(id) ?? 'not started'
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
  if (existing && !existing.client.exited) return existing
  if (failed.has(id)) return null

  const resolved = resolveServer(id, root)
  console.error(`[lsp] ensure(${id}) root=${root} -> ${resolved ? `${resolved.cmd} ${resolved.args.join(' ')} (${resolved.via})` : 'NOT FOUND'}`)
  if (!resolved) {
    failed.set(id, 'no server found')
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
    ),
    resolved,
    startedAt: Date.now(),
    restarts: existing?.restarts ?? 0,
    docs: existing?.docs ?? new Map(),
    pushed: new Map(),
  }
  servers.set(id, entry)

  try {
    const caps = await entry.client.start()
    // Assert rather than assume. A server answering utf-8 while we send utf-16
    // offsets produces hovers that are right on ASCII and wrong the moment a
    // line has an emoji — correct-looking output is the worst failure mode
    // available, so refuse instead.
    const enc = caps.positionEncoding ?? 'utf-16'
    if (enc !== 'utf-16') {
      failed.set(id, `unsupported positionEncoding "${enc}"`)
      void entry.client.dispose()
      servers.delete(id)
      return null
    }
    // A restart has to re-open every document, or the server's view is empty
    // while ours says otherwise.
    for (const doc of entry.docs.values()) {
      entry.client.notify('textDocument/didOpen', {
        textDocument: { uri: doc.uri, languageId: doc.languageId, version: doc.version, text: doc.text },
      })
    }
    return entry
  } catch (err) {
    console.error(`[lsp:${id}] initialize failed:`, err)
    failed.set(id, `initialize failed: ${String(err)}`)
    servers.delete(id)
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
    failed.set(id, `crashed ${entry.restarts} times; giving up`)
    servers.delete(id)
    return
  }
  const delay = Math.min(16000, 1000 * 2 ** entry.restarts)
  entry.restarts += 1
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
 * Diagnostics for a file.
 *
 * Pull first, because tsgo does NOT push publishDiagnostics for open documents
 * — measured: after an incremental edit that introduced two errors, zero push
 * frames arrived and only the pull returned them. Push is still handled, since
 * plenty of other servers use it and some use both.
 */
export async function diagnose(path: string): Promise<unknown[]> {
  const entry = await openDoc(path, 'diag')
  if (!entry) return []
  const uri = toUri(path)

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
