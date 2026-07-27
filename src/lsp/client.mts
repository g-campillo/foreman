import { spawn, type ChildProcess } from 'node:child_process'
import { encode, makeFrameReader, LSP_ERR } from '../shared/lspwire.mts'
import { toUri } from './languages.mts'

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

export class LspClient {
  private child: ChildProcess | null = null
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private ready: Promise<ServerCaps> | null = null
  private disposed = false

  caps: ServerCaps = {}
  /** Set when the process dies, so the registry can decide about restarting. */
  exited: { code: number | null; signal: string | null } | null = null

  readonly id: string
  private readonly cmd: string
  private readonly args: string[]
  private readonly root: string
  private readonly onDiagnostics: (uri: string, diags: unknown[]) => void
  private readonly onExit: (self: LspClient) => void

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
  ) {
    this.id = id
    this.cmd = cmd
    this.args = args
    this.root = root
    this.onDiagnostics = onDiagnostics
    this.onExit = onExit
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
      }
      // window/logMessage, $/progress and friends are dropped on purpose.
    }
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
