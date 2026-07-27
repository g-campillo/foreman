import * as reg from './registry.mts'
import { fromUri, serverFor, type ServerId } from '../shared/languages.mts'

/**
 * A virtual LSP server for the renderer, multiplexed onto the real fleet.
 *
 * monaco-editor 0.56 bundles a complete LSP client (MonacoLspClient), which
 * registers all 21 providers with the conversions already written — every
 * 0-vs-1-based offset, the inverted MarkerSeverity table, the CompletionItemKind
 * renumbering. Using it deletes ~600 lines of exactly the code that fails
 * silently when it is wrong.
 *
 * But it is a CLIENT, and LSP is single-client. It does its own `initialize`,
 * and it syncs Monaco's models itself. Pointing it at a server the host is
 * already driving would mean two initialize handshakes and two competing
 * document versions on one process. Hence this: the renderer talks to us, and
 * we are the only client the real servers ever see.
 *
 * Three interceptions, everything else is a pass-through:
 *
 *   initialize   — answered from the caps the host already negotiated. Crucially
 *                  MonacoLspClient sends `rootUri: null`, which would leave a
 *                  server with no project at all; never forwarding it is what
 *                  keeps cross-file resolution working.
 *   didOpen/     — folded into the host's document mirror, so exactly one
 *   didChange/     didOpen per URI reaches the server no matter how many
 *   didClose       owners it has.
 *   everything   — routed by the URI in the params, which is why one connection
 *   else           can front servers for several languages at once.
 */

type Json = Record<string, unknown>

/**
 * The empty answer for a method, when no server handles this language.
 *
 * `null` is right for most of LSP — "no hover here" is a legitimate reply — but
 * NOT for the pull-diagnostics request, whose result is a report object the
 * client immediately reads `.kind` off. Answering null there throws inside
 * Monaco's provider ("Cannot read properties of null") on every open of a file
 * in a language with no server, which is exactly the common case this feature
 * exists to explain rather than to break.
 *
 * Unhandled languages are normal here — json, css, markdown and anything with
 * no installed server all take this path — so the empty has to be well-formed.
 */
function emptyFor(method: string): unknown {
  if (method === 'textDocument/diagnostic') return { kind: 'full', items: [] }
  if (method === 'workspace/diagnostic') return { items: [] }
  if (method.startsWith('textDocument/semanticTokens')) return { data: [] }
  return null
}

/** Where a request should go, from whatever carries a URI. */
function routeOf(params: unknown): ServerId | null {
  const p = params as { textDocument?: { uri?: string } } | undefined
  const uri = p?.textDocument?.uri
  return uri ? serverFor(fromUri(uri)) : null
}

/** Merge what we know, so the client registers providers for real capabilities. */
async function initializeResult(): Promise<Json> {
  const entry = await reg.ensure('ts')
  const caps = entry?.client.caps ?? {}
  return {
    capabilities: {
      ...caps,
      // We own synchronisation; tell the client to send full text rather than
      // ranges, because the mirror we keep for the agent is full-text anyway
      // and reconciling two incremental streams is not worth the bytes saved.
      textDocumentSync: { openClose: true, change: 1 },
    },
    serverInfo: { name: 'foreman-lsp-proxy', version: '1' },
  }
}

/**
 * Handle one message from the renderer.
 *
 * Returns a reply to send back, or null for notifications and swallowed frames.
 */
export async function handleFromRenderer(msg: Json): Promise<Json | null> {
  const method = msg.method as string | undefined
  const id = msg.id

  // ---- requests ----------------------------------------------------------
  if (id !== undefined && method) {
    if (method === 'initialize') {
      return { jsonrpc: '2.0', id, result: await initializeResult() }
    }
    if (method === 'shutdown') return { jsonrpc: '2.0', id, result: null }

    const route = routeOf(msg.params)
    if (!route) return { jsonrpc: '2.0', id, result: emptyFor(method) }
    const entry = await reg.ensure(route)
    if (!entry) return { jsonrpc: '2.0', id, result: emptyFor(method) }
    try {
      const result = await entry.client.request(method, msg.params)
      return { jsonrpc: '2.0', id, result: result ?? null }
    } catch (err) {
      // Report as a result, not an error: a rejected provider request puts a
      // red banner in the editor for something as ordinary as a race with a
      // server restart.
      console.error(`[lsp-proxy] ${method} failed:`, err)
      return { jsonrpc: '2.0', id, result: emptyFor(method) }
    }
  }

  // ---- notifications -----------------------------------------------------
  if (!method) return null
  if (method === 'initialized' || method === 'exit') return null

  const params = msg.params as { textDocument?: { uri?: string; text?: string; version?: number }; contentChanges?: Array<{ text: string }> } | undefined
  const uri = params?.textDocument?.uri
  const path = uri ? fromUri(uri) : null

  if (method === 'textDocument/didOpen' && path) {
    // The registry decides whether the server has seen this URI already; a
    // second didOpen for one document is a protocol error on most servers.
    await reg.openDoc(path, 'editor', params?.textDocument?.text)
    return null
  }

  if (method === 'textDocument/didChange' && path) {
    const text = params?.contentChanges?.[0]?.text
    if (typeof text === 'string') await reg.editorChanged(path, text)
    return null
  }

  if (method === 'textDocument/didClose' && path) {
    reg.closeDoc(path, 'editor')
    return null
  }

  // Anything else a future client sends: route it if we can, drop it if not.
  const route = routeOf(msg.params)
  if (route) {
    const entry = await reg.ensure(route)
    entry?.client.notify(method, msg.params)
  }
  return null
}

/**
 * A request from the renderer that wants its answer back on the same call.
 *
 * The frame path above is fire-and-forget by design — a JSON-RPC reply is just
 * another frame — but the hand-rolled location providers in the renderer are
 * plain async functions and need a promise. Same routing, same server, one
 * fewer hop.
 */
export async function lspRequest(method: string, params: unknown): Promise<unknown> {
  const route = routeOf(params)
  if (!route) return null
  const entry = await reg.ensure(route)
  if (!entry) return null
  try {
    return (await entry.client.request(method, params)) ?? null
  } catch (err) {
    console.error(`[lsp-proxy] direct ${method} failed:`, err)
    return null
  }
}
