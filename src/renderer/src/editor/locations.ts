import type { Monaco } from './monaco'

/**
 * The five location-returning providers, hand-rolled — and only these five.
 *
 * monaco-editor's bundled LSP client handles the other sixteen well, but its
 * `toMonacoLocation` resolves a result through `bridge.translateBackRange`,
 * which looks up an EXISTING Monaco model for the target URI and returns
 * `textModel.uri`. That is fine in VS Code, where a model service can
 * materialise any file on demand. Here models are created one at a time as
 * files are opened, so a definition in a file you have not opened yet resolves
 * against nothing and the jump silently does not happen.
 *
 * Measured, because it is not obvious: open the target file first and
 * go-to-definition works perfectly; leave it unopened and the same click does
 * nothing at all. Same request, same server response.
 *
 * These five need no model. They return `{uri, range}` built straight from the
 * LSP reply, and Monaco's editor opener — registered in lsp.ts — is what loads
 * the file. The conversion is the trivial half of the table: LSP is 0-based,
 * Monaco is 1-based, everything else passes through.
 *
 * Registered ALONGSIDE the bundled client's providers rather than instead of
 * them; Monaco merges results from all registered providers and dedupes by
 * position, so the duplicate is harmless and this file stays additive.
 */

interface LspPos {
  line: number
  character: number
}
interface LspRange {
  start: LspPos
  end: LspPos
}
type LspLoc =
  | { uri: string; range: LspRange }
  | { targetUri: string; targetRange: LspRange; targetSelectionRange?: LspRange }

/** LSP 0-based -> Monaco 1-based. The one conversion this file needs. */
function toRange(r: LspRange): {
  startLineNumber: number
  startColumn: number
  endLineNumber: number
  endColumn: number
} {
  return {
    startLineNumber: r.start.line + 1,
    startColumn: r.start.character + 1,
    endLineNumber: r.end.line + 1,
    endColumn: r.end.character + 1,
  }
}

/** LSP returns Location | Location[] | LocationLink[]. Flatten all three. */
function flatten(monaco: Monaco, result: unknown): { uri: unknown; range: unknown }[] {
  if (!result) return []
  const arr = (Array.isArray(result) ? result : [result]) as LspLoc[]
  return arr.flatMap((loc) => {
    if ('targetUri' in loc) {
      const range = loc.targetSelectionRange ?? loc.targetRange
      return [{ uri: monaco.Uri.parse(loc.targetUri), range: toRange(range) }]
    }
    if ('uri' in loc && loc.range) return [{ uri: monaco.Uri.parse(loc.uri), range: toRange(loc.range) }]
    return []
  })
}

type Send = (method: string, params: unknown) => Promise<unknown>

let registered = false

export function registerLocationProviders(monaco: Monaco, send: Send): void {
  if (registered) return
  registered = true

  const ALL = { language: '*' } as const

  const ask = async (
    method: string,
    model: { uri: { toString(): string } },
    position: { lineNumber: number; column: number },
    extra: Record<string, unknown> = {},
  ): Promise<{ uri: unknown; range: unknown }[]> => {
    const result = await send(method, {
      textDocument: { uri: model.uri.toString() },
      // Monaco 1-based -> LSP 0-based, the other direction.
      position: { line: position.lineNumber - 1, character: position.column - 1 },
      ...extra,
    })
    return flatten(monaco, result)
  }

  monaco.languages.registerDefinitionProvider(ALL, {
    provideDefinition: (model, position) =>
      ask('textDocument/definition', model, position) as never,
  })
  monaco.languages.registerDeclarationProvider(ALL, {
    provideDeclaration: (model, position) =>
      // tsgo advertises no declarationProvider, so this falls back to
      // definition rather than returning nothing — go-to-declaration on
      // TypeScript would otherwise be a menu item that never does anything.
      ask('textDocument/definition', model, position) as never,
  })
  monaco.languages.registerTypeDefinitionProvider(ALL, {
    provideTypeDefinition: (model, position) =>
      ask('textDocument/typeDefinition', model, position) as never,
  })
  monaco.languages.registerImplementationProvider(ALL, {
    provideImplementation: (model, position) =>
      ask('textDocument/implementation', model, position) as never,
  })
  monaco.languages.registerReferenceProvider(ALL, {
    provideReferences: (model, position, context) =>
      ask('textDocument/references', model, position, {
        context: { includeDeclaration: context.includeDeclaration },
      }) as never,
  })
}
