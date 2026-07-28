import * as reg from './registry.mts'
import { fromUri, serverFor, toUri, type ServerId } from '../shared/languages.mts'

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
 *   initialize   — answered from a fixed capability set of our own, because what
 *                  the renderer talks to is the ROUTER, not any one server.
 *                  Crucially MonacoLspClient sends `rootUri: null`, which would
 *                  leave a server with no project at all; never forwarding it is
 *                  what keeps cross-file resolution working.
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
 * `completionItem/resolve` is the same shape of hazard and worse: the client
 * passes the item in and then reads detail, documentation and
 * additionalTextEdits straight off the reply, so the only safe empty is the
 * item it gave us, unresolved but intact.
 *
 * Unhandled languages are normal here — json, css, markdown and anything with
 * no installed server all take this path — so the empty has to be well-formed.
 */
function emptyFor(method: string, params?: unknown): unknown {
  if (method === 'textDocument/diagnostic') return { kind: 'full', items: [] }
  if (method === 'workspace/diagnostic') return { items: [] }
  if (method.startsWith('textDocument/semanticTokens')) return { data: [] }
  if (method === 'textDocument/completion') return { isIncomplete: false, items: [] }
  if (method === 'completionItem/resolve') return params ?? {}
  return null
}

/** The document a request is about, for the many methods that name one. */
function uriOf(params: unknown): string | null {
  return (params as { textDocument?: { uri?: string } } | undefined)?.textDocument?.uri ?? null
}

/** Where a request should go, from whatever carries a URI. */
function routeOf(params: unknown): ServerId | null {
  const uri = uriOf(params)
  return uri ? serverFor(fromUri(uri)) : null
}

/**
 * Where the last `textDocument/completion` went.
 *
 * `completionItem/resolve` carries a CompletionItem and nothing else — no URI —
 * so `routeOf` cannot answer for it, and skipping it is not an option: jdtls
 * fills in the detail, the docs, and the `additionalTextEdits` that ARE the
 * auto-import only on resolve. Answering it from `emptyFor` would silently drop
 * the import.
 *
 * Completion is strictly request-then-resolve on the document the user is
 * looking at, so "wherever the last completion went" is the right server. The
 * worst a race can do is resolve against the previously focused file's server,
 * which returns the same nothing the empty would.
 */
let lastCompletionRoute: ServerId | null = null

/**
 * What the proxy routes — advertised statically, because it is a ROUTER.
 *
 * Deriving this from one backend's capabilities is the bug that made the entire
 * editor go dead in any project without that backend: `ensure('ts')` returns
 * null in a Maven project, the caps collapse to `{}`, and MonacoLspClient —
 * which registers its 21 providers FROM these capabilities — registers none. No
 * completion, no hover, no diagnostics, for every language, while jdtls sat
 * running and idle. What we can answer is a property of the routing table, not
 * of which servers happen to have started, and `emptyFor` already returns a
 * well-formed empty for the languages nobody serves.
 *
 * Completion and hover follow from that alone. Diagnostics do not, and saying
 * so precisely matters: advertising `diagnosticProvider` only gets Monaco to
 * ASK, and asking is all Monaco can do — a pull provider is its only diagnostics
 * path here — while jdtls answers exclusively by pushing. The half that closes
 * that gap is in the request handler below, which serves this one method from
 * reg.diagnosticsFor instead of forwarding it.
 *
 * Three are deliberately absent, each for a measured reason:
 *
 *   semanticTokensProvider — tsgo advertises it, but its legend's tokenTypes is
 *     `[]` and `/full` answers `{data:[]}`. Monaco's Monarch grammars already
 *     colour the file; a provider gated on an empty legend only replaces
 *     working colours with none.
 *   inlayHintProvider — tsgo returns null.
 *   codeLensProvider — a lens that resolves wrongly rewrites the line above
 *     every symbol in the file. Not worth the risk for what it adds.
 */
const ROUTER_CAPABILITIES: Json = {
  completionProvider: {
    resolveProvider: true,
    // A union across the fleet's languages: `.` for members everywhere, `:` and
    // `>` for C++ and Rust paths, `<` for generics, the quotes and `/` for
    // import and include paths, `@` for Java annotations and JSDoc, `#` for
    // Python and preprocessor, `*` for JSDoc, `$` for shell. Space is
    // deliberately NOT here even though some servers ask for it: it would fire a
    // request on every space the user types.
    triggerCharacters: ['.', ':', '>', '<', '"', "'", '/', '@', '#', '*', '$'],
  },
  hoverProvider: true,
  signatureHelpProvider: { triggerCharacters: ['(', ','], retriggerCharacters: [')'] },
  // These five are ALSO hand-registered, on every language, in the renderer's
  // editor/locations.ts — read its header for why those cannot be left to the
  // bundled client. Monaco merges providers and dedupes by position, so each
  // request goes out twice and the result is the same. Known, pre-existing (it
  // already happened whenever tsgo was found), and left alone deliberately: the
  // fix is to delete one side, and doing that here would change two things at
  // once. Do not "fix" it by dropping these — that is what broke Java.
  definitionProvider: true,
  declarationProvider: true,
  typeDefinitionProvider: true,
  implementationProvider: true,
  referencesProvider: true,

  documentSymbolProvider: true,
  workspaceSymbolProvider: true,
  documentHighlightProvider: true,
  // Deliberately WITHOUT resolveProvider, and deliberately still here. The
  // bundled client only assigns its `resolveCodeAction` when that capability is
  // truthy, and then reads `.edit` straight off the raw reply — so a server
  // answering null to a resolve throws out of the lightbulb, uncaught, the way
  // completionItem/resolve would without `emptyFor`'s shaped empty.
  //
  // It has a cost, and it is the only omission in this block that the user can
  // see: an action carrying neither `edit` nor `command` still renders as a
  // lightbulb entry, and clicking it does nothing. jdtls returns exactly those
  // — `data`-carrying actions it fills in on resolve — so Java quick-fixes are
  // offered and silently no-op. Actions that arrive complete, with their edit
  // already in them, work today, which is why deleting the capability is worse
  // than keeping it.
  //
  // The fix is a `lastCodeActionRoute` mirroring lastCompletionRoute above,
  // routing the URI-less resolve and answering its null with the action we were
  // handed. Deferred on purpose, not overlooked: do not set resolveProvider
  // without it.
  codeActionProvider: true,
  renameProvider: { prepareProvider: true },
  documentFormattingProvider: true,
  documentRangeFormattingProvider: true,
  foldingRangeProvider: true,
  selectionRangeProvider: true,
  diagnosticProvider: { interFileDependencies: true, workspaceDiagnostics: false },
}

/** Answer the client's handshake with the router's own capabilities. */
function initializeResult(): Json {
  console.error('[lsp] proxy: advertising router capabilities')
  return {
    capabilities: {
      ...ROUTER_CAPABILITIES,
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
      return { jsonrpc: '2.0', id, result: initializeResult() }
    }
    if (method === 'shutdown') return { jsonrpc: '2.0', id, result: null }

    // The URI is the route for everything except the resolve, which has none.
    const route =
      routeOf(msg.params) ?? (method === 'completionItem/resolve' ? lastCompletionRoute : null)
    if (method === 'textDocument/completion') lastCompletionRoute = route
    if (!route) return { jsonrpc: '2.0', id, result: emptyFor(method, msg.params) }
    const entry = await reg.ensure(route)
    if (!entry) return { jsonrpc: '2.0', id, result: emptyFor(method, msg.params) }
    try {
      // Pull diagnostics are not forwarded. Monaco's ONLY diagnostics path is
      // this pull provider, and jdtls is push-only: forwarding it means one
      // rejection per model per edit, an empty report back, and a Java file
      // that never gets a squiggle however broken it is. reg.diagnosticsFor is
      // the same pull-then-push read the agent's tools use — see it for why an
      // empty pull is NOT the same answer as a refused one. Answering here also
      // keeps that entirely expected rejection out of the log below, which is
      // the log this bug had to be diagnosed from.
      if (method === 'textDocument/diagnostic') {
        // Re-spelled through the host's own encoding rather than passed on as
        // Monaco spelled it: this URI is matched against the didOpen we sent
        // and against the keys in `pushed`, and monaco.Uri.file does not encode
        // character-for-character the way toUri does.
        const uri = uriOf(msg.params)
        const items = uri ? await reg.diagnosticsFor(entry, toUri(fromUri(uri))) : []
        return { jsonrpc: '2.0', id, result: { kind: 'full', items } }
      }
      const result = await entry.client.request(method, msg.params)
      // A server answering null is the same hazard as no server at all for the
      // shaped methods, so it takes the same well-formed empty.
      return { jsonrpc: '2.0', id, result: result ?? emptyFor(method, msg.params) }
    } catch (err) {
      // Report as a result, not an error: a rejected provider request puts a
      // red banner in the editor for something as ordinary as a race with a
      // server restart.
      console.error(`[lsp-proxy] ${method} failed:`, err)
      return { jsonrpc: '2.0', id, result: emptyFor(method, msg.params) }
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
