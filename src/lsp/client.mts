import { spawn, type ChildProcess } from 'node:child_process'
import { encode, makeFrameReader, LSP_ERR } from '../shared/lspwire.mts'
import { toUri } from '../shared/languages.mts'
// Type-only, so nothing here runtime-imports a value out of a .ts file and this
// keeps loading under bare node for the check scripts.
import type { LspStatus } from '../shared/types'

/**
 * One language server, spoken to over stdio.
 *
 * The pending-map / call-correlation skeleton is HostClient's, because that
 * shape is already proven in this codebase. The framing is not — see lspwire.mts
 * for why makeLineReader cannot be reused.
 */

type Json = Record<string, unknown>

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  method: string
}

/** `$/progress`. The token is whatever we granted; the value is the LSP's own
 *  WorkDoneProgress union, narrowed to the fields anything here reads. */
interface ProgressParams {
  token?: unknown
  value?: { kind?: string; title?: string; message?: string; percentage?: number }
}

/**
 * How long a work token may go unmentioned before it is presumed abandoned.
 *
 * `busy` latches on `window/workDoneProgress/create`, before any `begin`, and
 * only an `end` frame clears it — so a server that opens a token for a job it
 * then abandons internally (or one we would normally cancel with
 * `window/workDoneProgress/cancel`, which we never send) would read as
 * "indexing" for the life of the process, with no crash to reset it.
 *
 * The ready-latch in `phaseOf` bounds the blast radius to servers that never
 * reached `ready` in the first place — which is exactly the case that matters,
 * since a server stuck warming is the one the user is waiting on.
 *
 * A minute is far longer than the gap any live job leaves between reports —
 * jdtls reports every few hundred milliseconds — and short enough that a wedged
 * row does not outlive the session.
 */
const TOKEN_STALE_MS = 60000

export interface ServerCaps {
  positionEncoding?: string
  hoverProvider?: unknown
  definitionProvider?: unknown
  declarationProvider?: unknown
  typeDefinitionProvider?: unknown
  implementationProvider?: unknown
  referencesProvider?: unknown
  documentSymbolProvider?: unknown
  workspaceSymbolProvider?: unknown
  renameProvider?: unknown
  codeActionProvider?: unknown
  callHierarchyProvider?: unknown
  diagnosticProvider?: unknown
  semanticTokensProvider?: { legend?: { tokenTypes?: string[] } }
  inlayHintProvider?: unknown
  [k: string]: unknown
}

/**
 * A server's own account of whether it can answer yet.
 *
 * Folded here rather than in the registry because the two mechanisms servers
 * use for this are both wire-level and both easy to get subtly wrong, and
 * neither is worth learning twice.
 */
export interface LspSignal {
  /** A work-done progress job the server opened is still open. */
  busy: boolean
  /** 0-100 when the server reports one; null when it only says "busy". */
  percent: number | null
  /** The server's own words for what it is doing. */
  detail: string | null
  /**
   * jdtls's `language/status`, the only signal any server here sends that
   * actually means "answers are trustworthy now".
   *
   * `silent` — this server does not speak language/status at all, which is
   *   every server except jdtls. It must NOT read as "not ready".
   * `warming` — it announced Starting/Started and has not said ServiceReady.
   * `ready` — ServiceReady arrived.
   * `failed` — it announced Error. No ServiceReady ever follows one, so
   *   anything that leaves this at `warming` pins the row on "indexing" for the
   *   rest of the session.
   */
  service: 'silent' | 'warming' | 'ready' | 'failed'
}

/**
 * What a started server's own reports add up to.
 *
 * Pure, and pinned by `npm run check:lspstatus`, because getting it backwards
 * produces exactly the thing this feature exists to prevent: a green light over
 * a server that answers every request with nothing.
 *
 * `busy` alone is enough for `indexing` — a server that opened a work token has
 * told us it is not finished — and `warming` covers jdtls, which does most of
 * its project build without any token at all. Silence means ready, because for
 * every server but jdtls silence is all there ever is.
 *
 * `failed` outranks everything: a server that said Error will never say
 * ServiceReady, and an indefinite "warming up" over a dead server is the same
 * lie as a green light over a warming one.
 *
 * `was` is the phase the fleet is already showing for this server, and it is
 * what makes the LATCH work: once a server has reached `ready`, routine
 * background work must not drag it back below `ready`. jdtls, tsgo and pyright
 * all open short work tokens for validate-on-save and publish-diagnostics, and
 * every flip between `ready` and `indexing` is a phase diff — flushed
 * immediately, past the host's throttle, and mounting or unmounting a strip
 * that resizes the session list under it. This feature is about INITIAL
 * readiness; the tooltip is where later work belongs. Omit `was` when there is
 * no prior phase to honour.
 */
export function phaseOf(sig: LspSignal, was?: LspStatus['phase']): LspStatus['phase'] {
  if (sig.service === 'failed') return 'failed'
  if (was === 'ready') return 'ready'
  return sig.busy || sig.service === 'warming' ? 'indexing' : 'ready'
}

export class LspClient {
  private child: ChildProcess | null = null
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private ready: Promise<ServerCaps> | null = null
  private disposed = false

  /**
   * Work tokens the server opened with window/workDoneProgress/create, each
   * stamped with when it was last heard from.
   *
   * Kept so `$/progress` can be believed. A report against a token we never
   * granted is one nothing will ever close, and honouring it would leave the
   * indicator stuck on "indexing" for the life of the session.
   *
   * The stamp is what bounds the opposite hole — a token the server opens and
   * then never ends. See TOKEN_STALE_MS and `sweepTokens`.
   */
  private readonly workTokens = new Map<string, number>()

  /** Armed only while tokens are open, so an idle client holds no timer. */
  private sweepTimer: ReturnType<typeof setTimeout> | null = null

  private readonly signal: LspSignal = {
    busy: false,
    percent: null,
    detail: null,
    service: 'silent',
  }

  caps: ServerCaps = {}
  /** Set when the process dies, so the registry can decide about restarting. */
  exited: { code: number | null; signal: string | null } | null = null

  readonly id: string
  private readonly cmd: string
  private readonly args: string[]
  private readonly root: string
  private readonly onDiagnostics: (uri: string, diags: unknown[]) => void
  private readonly onExit: (self: LspClient) => void
  private readonly onStatus: (signal: LspSignal) => void

  // Fields declared and assigned by hand rather than as constructor parameter
  // properties. Node's type stripping is STRIP-ONLY: a parameter property emits
  // an assignment, so it is not a type annotation it can erase, and the file
  // stops loading under bare node with ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX. That
  // is the whole reason this module is .mts, so the shorthand is not available
  // here. Same constraint applies to enums and namespaces.
  constructor(
    id: string,
    cmd: string,
    args: string[],
    root: string,
    onDiagnostics: (uri: string, diags: unknown[]) => void,
    onExit: (self: LspClient) => void,
    onStatus: (signal: LspSignal) => void,
  ) {
    this.id = id
    this.cmd = cmd
    this.args = args
    this.root = root
    this.onDiagnostics = onDiagnostics
    this.onExit = onExit
    this.onStatus = onStatus
  }

  /**
   * The server's own account of itself, folded from $/progress and
   * language/status.
   *
   * A getter as well as a callback because both mechanisms fire DURING the
   * handshake: by the time `start()` resolves, jdtls has already said what it is
   * doing, and a registry that only listened for later events would miss it.
   */
  get status(): LspSignal {
    return { ...this.signal }
  }

  start(): Promise<ServerCaps> {
    if (this.ready) return this.ready

    this.child = spawn(this.cmd, this.args, {
      cwd: this.root,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    })

    const read = makeFrameReader((msg) => this.receive(msg as Json))
    this.child.stdout?.on('data', read)
    // Servers log freely to stderr. Kept but not parsed — a crash loop is much
    // easier to diagnose with the server's own last words than without them.
    this.child.stderr?.on('data', (b: Buffer) => {
      const s = b.toString('utf8').trim()
      if (s) console.error(`[lsp:${this.id}] ${s.slice(0, 500)}`)
    })
    this.child.on('exit', (code, signal) => {
      this.exited = { code, signal }
      // Nothing left to sweep for, and a stray one would emit status for a dead
      // client while the registry is already showing its restart.
      this.stopSweep()
      // Reject everything in flight rather than leaving callers hanging on a
      // promise that can no longer settle. HostClient's close handler does the
      // same thing for the same reason.
      for (const [, p] of this.pending) p.reject(new Error(`[lsp:${this.id}] server exited`))
      this.pending.clear()
      this.onExit(this)
    })
    this.child.on('error', (err) => console.error(`[lsp:${this.id}] spawn failed:`, err))

    this.ready = this.initialize()
    return this.ready
  }

  private async initialize(): Promise<ServerCaps> {
    // Bounded, because an unbounded initialize is indistinguishable from a hung
    // tool call: the handler awaits forever, the agent's turn never completes,
    // and nothing anywhere says why. A server that has not answered in fifteen
    // seconds is not going to.
    const handshake = this.request('initialize', {
      // Well-behaved servers exit when this pid dies. That is one of the three
      // things keeping language servers from outliving the host that spawned
      // them; the others are the pid list in HostMeta and disposeAll on
      // shutdown. tsgo honours it.
      processId: process.pid,
      rootUri: toUri(this.root),
      workspaceFolders: [{ uri: toUri(this.root), name: this.root.split('/').pop() ?? 'root' }],
      clientInfo: { name: 'Foreman', version: '0.1.0' },
      capabilities: {
        // Advertised because Monaco is natively UTF-16, so no conversion is
        // needed for a server that agrees. The returned value is ASSERTED in
        // the registry: a server answering utf-8 and treated as utf-16 gives
        // hovers that are correct on ASCII and silently wrong the moment a line
        // contains an emoji, which is the worst way for this to fail.
        general: { positionEncodings: ['utf-16'] },
        workspace: {
          workspaceFolders: true,
          // Only claimed because `receive` really does answer both of these.
          // Advertising a capability we do not implement is what wedges a
          // server: it will wait forever for a reply that never comes.
          configuration: true,
          didChangeWatchedFiles: { dynamicRegistration: true },
          applyEdit: false,
        },
        textDocument: {
          synchronization: { didSave: true, dynamicRegistration: false },
          hover: { contentFormat: ['markdown', 'plaintext'] },
          definition: { linkSupport: true },
          typeDefinition: { linkSupport: true },
          implementation: { linkSupport: true },
          references: {},
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          rename: { prepareSupport: true },
          codeAction: {},
          callHierarchy: {},
          publishDiagnostics: { relatedInformation: true },
          diagnostic: { dynamicRegistration: false },
          completion: { completionItem: { snippetSupport: false } },
        },
      },
    })

    const result = (await Promise.race([
      handshake,
      new Promise((_r, reject) =>
        setTimeout(() => reject(new Error('initialize timed out after 15s')), 15000).unref?.(),
      ),
    ])) as { capabilities?: ServerCaps }

    this.caps = result?.capabilities ?? {}
    this.notify('initialized', {})
    return this.caps
  }

  private receive(msg: Json): void {
    // A response to something we sent.
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id as number)
      if (!p) return
      this.pending.delete(msg.id as number)
      const err = msg.error as { code?: number; message?: string } | undefined
      if (err) {
        // Cancellation is a normal outcome, not a failure. Rejecting here logs
        // an error every time someone types fast enough to outrun completion.
        if (err.code === LSP_ERR.RequestCancelled || err.code === LSP_ERR.ContentModified) {
          p.resolve(null)
        } else {
          p.reject(new Error(`${p.method}: ${err.message ?? 'lsp error'}`))
        }
      } else {
        p.resolve(msg.result)
      }
      return
    }

    // A request FROM the server. Every one must be answered.
    //
    // This is the rule that is expensive to learn: a client that advertises
    // `workspace.configuration` and never answers `workspace/configuration`
    // does not get a warning — the server never completes `initialize` at all,
    // and the whole connection hangs with nothing in any log.
    if (msg.id !== undefined && typeof msg.method === 'string') {
      const method = msg.method
      let result: unknown = null
      if (method === 'workspace/configuration') {
        // One null per requested section. A bare null is not the same shape and
        // some servers reject it.
        const items = (msg.params as { items?: unknown[] } | undefined)?.items ?? []
        result = items.map(() => null)
      } else if (method === 'workspace/workspaceFolders') {
        result = [{ uri: toUri(this.root), name: this.root.split('/').pop() ?? 'root' }]
      } else if (method === 'window/workDoneProgress/create') {
        // The token is the point. Answering null and discarding it is what made
        // "still building the project model" indistinguishable from "broken":
        // every subsequent $/progress names this token, and without it there is
        // nothing to match them against.
        const token = (msg.params as { token?: unknown } | undefined)?.token
        if (typeof token === 'string' || typeof token === 'number') {
          this.workTokens.set(String(token), Date.now())
          this.signal.busy = true
          this.armSweep()
          this.emitStatus()
        }
        result = null
      }
      // Everything else — client/registerCapability, client/unregisterCapability,
      // anything a future server invents — gets a null result rather than being
      // ignored. Answering wrongly is recoverable; not answering is not.
      this.send({ jsonrpc: '2.0', id: msg.id, result })
      return
    }

    // A notification from the server.
    if (typeof msg.method === 'string') {
      if (msg.method === 'textDocument/publishDiagnostics') {
        const p = msg.params as { uri?: string; diagnostics?: unknown[] } | undefined
        if (p?.uri) this.onDiagnostics(p.uri, p.diagnostics ?? [])
      } else if (msg.method === '$/progress') {
        this.progress(msg.params as ProgressParams | undefined)
      } else if (msg.method === 'language/status') {
        this.serviceStatus(msg.params as { type?: unknown; message?: unknown } | undefined)
      }
      // window/logMessage and friends are still dropped on purpose. Progress is
      // NOT: it and language/status are the only things a server sends that
      // distinguish "still building the project model" from "broken".
    }
  }

  /**
   * A work-done progress frame: begin, then any number of reports, then end.
   *
   * `detail` is sticky across reports because `title` is only legal on `begin` —
   * a report carrying no message of its own is still part of the job the begin
   * named, and blanking it there would make the line flicker.
   */
  private progress(params: ProgressParams | undefined): void {
    const token = params?.token
    const key = typeof token === 'string' || typeof token === 'number' ? String(token) : null
    if (key === null || !this.workTokens.has(key)) return

    const value = params?.value ?? {}
    const words =
      (typeof value.message === 'string' && value.message.trim()) ||
      (typeof value.title === 'string' && value.title.trim()) ||
      null

    if (value.kind === 'end') {
      this.workTokens.delete(key)
    } else {
      // Re-stamped on every frame, so only a token nothing has named for a
      // minute is swept — a long job that keeps reporting never is.
      this.workTokens.set(key, Date.now())
      if (typeof value.percentage === 'number' && Number.isFinite(value.percentage)) {
        this.signal.percent = Math.max(0, Math.min(100, Math.round(value.percentage)))
      }
    }

    this.settleWork(words)
    this.armSweep()
  }

  /** What the open-token set now means, after something added to or left it. */
  private settleWork(words: string | null): void {
    this.signal.busy = this.workTokens.size > 0
    if (this.signal.busy) {
      if (words) this.signal.detail = words
    } else {
      // Nothing in flight, so there is nothing to describe. Keeping the last
      // job's title would leave the strip reading "Building…" forever.
      this.signal.detail = null
      this.signal.percent = null
    }
    this.emitStatus()
  }

  /**
   * Forget tokens nothing has mentioned in TOKEN_STALE_MS.
   *
   * The one case `end` frames do not cover: a live server that opens a job and
   * abandons it. Without this there is no crash, no timeout and no sweep to
   * reset `busy`, so the row reads "indexing" until the process dies.
   */
  private sweepTokens(): void {
    const cutoff = Date.now() - TOKEN_STALE_MS
    let dropped = false
    for (const [key, seen] of this.workTokens) {
      if (seen > cutoff) continue
      console.error(`[lsp:${this.id}] work token ${key} went quiet; presuming it ended`)
      this.workTokens.delete(key)
      dropped = true
    }
    if (dropped) this.settleWork(null)
    this.armSweep()
  }

  /** Next sweep, timed off the oldest token so nothing waits two full periods. */
  private armSweep(): void {
    if (this.sweepTimer || this.disposed) return
    let oldest = Infinity
    for (const seen of this.workTokens.values()) if (seen < oldest) oldest = seen
    if (oldest === Infinity) return
    this.sweepTimer = setTimeout(() => {
      this.sweepTimer = null
      this.sweepTokens()
    }, Math.max(1000, oldest + TOKEN_STALE_MS - Date.now()))
    this.sweepTimer.unref?.()
  }

  private stopSweep(): void {
    if (this.sweepTimer) clearTimeout(this.sweepTimer)
    this.sweepTimer = null
  }

  /**
   * jdtls's `language/status`. Nothing else sends it.
   *
   * `ServiceReady` is the one that matters: it is the only frame any server here
   * emits that means the project model is built and answers are worth having.
   * `Error` is the other end of the same signal. The rest — Starting, Started,
   * ProjectStatus, Message — are progress notes, and only Starting/Started imply
   * work still to come.
   */
  private serviceStatus(params: { type?: unknown; message?: unknown } | undefined): void {
    const type = typeof params?.type === 'string' ? params.type : ''
    const message = typeof params?.message === 'string' ? params.message.trim() : ''

    if (type === 'ServiceReady') {
      this.signal.service = 'ready'
      this.signal.detail = null
    } else if (type === 'Error') {
      // The one frame in which a live server says it broke — a missing JDK, an
      // unreadable workspace, an import that blew up. No ServiceReady ever
      // follows it, so reading it as another warming note leaves the row pulsing
      // under "indexing the project" for the rest of the session: exactly as
      // false as a green light over a server that answers nothing.
      this.signal.service = 'failed'
      this.signal.detail = message || 'the server reported an error'
    } else if (type === 'Starting' || type === 'Started') {
      // Never a downgrade: jdtls sends Started BEFORE ServiceReady, but a
      // late-arriving one after it must not put the fleet back into indexing,
      // and one after an Error must not paper over it. Only ServiceReady clears
      // either.
      if (this.signal.service !== 'silent' && this.signal.service !== 'warming') return
      this.signal.service = 'warming'
      if (message) this.signal.detail = message
    } else if (message && this.signal.service === 'warming') {
      // A note from a server still warming up is worth showing; one from a
      // server that is already ready is just chatter.
      this.signal.detail = message
    } else {
      return
    }
    this.emitStatus()
  }

  /** A copy, not the live object: callers keep these and compare them. */
  private emitStatus(): void {
    this.onStatus({ ...this.signal })
  }

  private send(msg: Json): void {
    if (!this.child?.stdin?.writable) return
    this.child.stdin.write(encode(msg))
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.disposed || this.exited) {
      return Promise.reject(new Error(`[lsp:${this.id}] not running`))
    }
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, method })
      this.send({ jsonrpc: '2.0', id, method, params: params ?? {} })
    })
  }

  notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: '2.0', method, params: params ?? {} })
  }

  /** Fire-and-forget cancel. The reply arrives as -32800 and resolves to null. */
  cancel(id: number): void {
    this.notify('$/cancelRequest', { id })
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.stopSweep()
    try {
      // Politely, then not. A server that ignores `shutdown` still has to go.
      await Promise.race([
        this.request('shutdown'),
        new Promise((r) => setTimeout(r, 2000)),
      ]).catch(() => undefined)
      this.notify('exit')
    } catch {
      /* already gone */
    }
    const child = this.child
    if (!child || child.exitCode !== null) return
    setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGTERM')
      setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL')
      }, 3000).unref?.()
    }, 500).unref?.()
  }

  get pid(): number | undefined {
    return this.child?.pid
  }
}
