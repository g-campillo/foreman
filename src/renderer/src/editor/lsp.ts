import { loadMonaco } from './monaco'
import { registerLocationProviders } from './locations'

/**
 * Wiring monaco 0.56's own LSP client to the host's server fleet.
 *
 * The alternative was ~600 lines of hand-rolled providers and conversions —
 * every 0-vs-1-based offset, the inverted MarkerSeverity table (LSP 1=error,
 * Monaco 8=error), the entirely different CompletionItemKind numbering. That
 * code fails silently when it is wrong: a hover lands on the neighbouring token
 * and looks like the server is confused. monaco-editor already ships all of it,
 * tested, registering 21 providers.
 *
 * It is not exported as a documented API — it lives under `esm/external/` and
 * its only public surface is the constructor — so this is deliberately the
 * thinnest possible attachment: one transport, no subclassing, nothing that
 * depends on its internals. If it is ever withdrawn, what is lost is this file.
 *
 * The host end (src/lsp/proxy.mts) is what makes it legal: the client does its
 * own `initialize` and its own document sync, and LSP is single-client, so the
 * proxy answers those itself and forwards the rest. See that file for why.
 */

type Message = unknown
type ConnectionState = { state: 'connecting' } | { state: 'open' } | { state: 'closed'; error: Error | undefined }
type Listener = (m: Message) => void

/**
 * IMessageTransport, implemented by hand.
 *
 * `BaseMessageTransport` would be the natural base class and is NOT exported —
 * only the interface is, and it is four members, so this is cheaper than
 * reaching into the package for it.
 */
class IpcTransport {
  private listener: Listener | undefined
  private readonly stateListeners = new Set<(s: ConnectionState) => void>()
  // Open from the start: the socket to the host already exists by the time a
  // session is on screen, so there is no connecting phase to model here.
  private current: ConnectionState = { state: 'open' }

  constructor(private readonly sessionId: string) {}

  get state(): { value: ConnectionState; onChange: (l: (s: ConnectionState) => void) => { dispose: () => void } } {
    return {
      value: this.current,
      onChange: (l) => {
        this.stateListeners.add(l)
        return { dispose: () => this.stateListeners.delete(l) }
      },
    }
  }

  async send(message: Message): Promise<void> {
    await window.foreman.lspSend(this.sessionId, message)
  }

  setListener(listener: Listener | undefined): void {
    this.listener = listener
  }

  /** Called from the IPC subscription with a frame the host sent back. */
  receive(message: Message): void {
    this.listener?.(message)
  }

  close(err?: Error): void {
    this.current = { state: 'closed', error: err }
    for (const l of this.stateListeners) l(this.current)
  }

  toString(): string {
    return `foreman-ipc(${this.sessionId})`
  }
}

interface Live {
  transport: IpcTransport
  off: () => void
}

/**
 * One client per session, kept outside React like the editor itself.
 *
 * Session-keyed rather than global because each session has its own host, its
 * own cwd — possibly a worktree — and therefore its own fleet.
 */
const clients = new Map<string, Live>()

/** Set once; go-to-definition needs somewhere to send you. */
let openerRegistered = false

/**
 * Teach Monaco how to open a different file.
 *
 * Without this, go-to-definition resolves correctly and then does nothing at
 * all when the target is in another file — the provider works, the navigation
 * silently no-ops, and it reads as "definitions are broken". Monaco's own
 * comment says as much: "If no handler is registered the default behavior is to
 * do nothing for models other than the currently attached one."
 *
 * Routed through the store, so a definition lands in the same modal by the same
 * path as a tree click or a diff row.
 */
function registerOpener(monaco: Awaited<ReturnType<typeof loadMonaco>>, open: OpenFile): void {
  if (openerRegistered) return
  openerRegistered = true
  monaco.editor.registerEditorOpener({
    openCodeEditor(_source, resource, selectionOrPosition) {
      if (resource.scheme !== 'file') return false
      const line =
        selectionOrPosition && 'startLineNumber' in selectionOrPosition
          ? selectionOrPosition.startLineNumber
          : ((selectionOrPosition as { lineNumber?: number } | undefined)?.lineNumber ?? undefined)
      open(resource.path, line)
      return true
    },
  })
}

type OpenFile = (path: string, line?: number) => void

export async function startLsp(sessionId: string, open: OpenFile): Promise<void> {
  const monaco = await loadMonaco()
  registerOpener(monaco, open)
  // Registered once, alongside the bundled client's own providers — see
  // locations.ts for why those five cannot be left to it.
  registerLocationProviders(monaco, (method, params) =>
    window.foreman.lspRequest(sessionId, method, params),
  )
  if (clients.has(sessionId)) return

  const transport = new IpcTransport(sessionId)
  // Registered BEFORE constructing the client: its constructor sends
  // `initialize` immediately, and a reply arriving before we are listening
  // would be dropped and the handshake would never complete.
  const off = window.foreman.onLspMessage(({ sessionId: sid, msg }: { sessionId: string; msg: unknown }) => {
    if (sid === sessionId) transport.receive(msg)
  })
  clients.set(sessionId, { transport, off })

  try {
    // `lsp` is a namespace on monaco-editor's main entry, from
    // esm/external/monaco-lsp-client. Constructing it registers every provider
    // and starts the handshake; there is nothing else to call.
    new (monaco as unknown as { lsp: { MonacoLspClient: new (t: unknown) => unknown } }).lsp.MonacoLspClient(
      transport,
    )
  } catch (err) {
    console.error('[lsp] client failed to start:', err)
    off()
    clients.delete(sessionId)
  }
}

export function stopLsp(sessionId: string): void {
  const live = clients.get(sessionId)
  if (!live) return
  // MonacoLspClient exposes no dispose(), so the transport is the only handle:
  // closing it stops frames in both directions and the providers it registered
  // fall back to returning nothing. Worth knowing before relying on teardown.
  live.transport.close()
  live.off()
  clients.delete(sessionId)
}
