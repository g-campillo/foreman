import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import type {
  McpSdkServerConfigWithInstance,
  SdkMcpToolDefinition,
} from '@anthropic-ai/claude-agent-sdk'
import * as reg from './registry.mts'
import { serverFor, toUri, type ServerId } from '../shared/languages.mts'
import {
  diagnostics as fmtDiagnostics,
  empty,
  hover as fmtHover,
  kindName,
  locations,
  outline,
  provenance,
  rel,
  toDisplay,
  toLsp,
  type Diag,
  type DocSym,
  type Loc,
} from './format.mts'

/**
 * The language servers, exposed to the agent as MCP tools.
 *
 * This is the point of the whole feature. An agent that greps for a symbol name
 * gets every string that happens to match; an agent that asks a compiler gets
 * the call sites. Measured on this repo: `references` on `makeDiffHook` returns
 * exactly one hit with no false positives, and `rename` returns three edits
 * across two files — declaration, import and call — rather than the declaration
 * alone.
 *
 * Registered by one field on the `query({options})` literal, which also means
 * the existing MCP panel lists it, `mcpStatus()` reports it, and the toggle and
 * permission-override controls work on it, for no new UI at all.
 *
 * Position convention is 1-BASED on both axes, matching what the harness's own
 * LSP tool documents and therefore what models expect. Every tool also accepts
 * `symbol` instead, because models are good at names and bad at columns — and
 * when they use it, the answer reports which position was actually used.
 */

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

const text = (s: string, isError = false): ToolResult => ({
  content: [{ type: 'text', text: s }],
  isError: isError || undefined,
})

const READ_ONLY = { readOnlyHint: true } as const

function lines(path: string): string[] | null {
  try {
    return readFileSync(path, 'utf8').split('\n')
  } catch {
    return null
  }
}

/** Absolute path from whatever the model passed. */
function abs(path: string): string {
  return path.startsWith('/') ? path : resolve(reg.currentRoot(), path)
}

interface Where {
  path: string
  line?: number
  character?: number
  symbol?: string
}

/**
 * Turn a model's idea of "where" into an LSP position.
 *
 * The `symbol` path is the one that earns its keep. A model that guesses a
 * column lands on the wrong token and gets a confidently wrong answer; a model
 * that names `makeDiffHook` cannot. When a line is given too, the search is
 * scoped to it; otherwise the first occurrence wins and the caller is told
 * which one that was.
 */
function locate(
  w: Where,
): { path: string; pos: { line: number; character: number }; note: string } | { error: string } {
  const path = abs(w.path)
  const src = lines(path)
  if (!src) return { error: `Cannot read ${rel(reg.currentRoot(), path)}.` }

  if (w.symbol) {
    const search = (i: number): number => src[i]?.indexOf(w.symbol!) ?? -1
    if (w.line !== undefined) {
      const i = w.line - 1
      const at = search(i)
      if (at === -1) {
        return { error: `"${w.symbol}" is not on line ${w.line} of ${rel(reg.currentRoot(), path)}.` }
      }
      return { path, pos: { line: i, character: at }, note: `at ${w.line}:${at + 1}` }
    }
    for (let i = 0; i < src.length; i++) {
      const at = search(i)
      if (at !== -1) return { path, pos: { line: i, character: at }, note: `at ${i + 1}:${at + 1}` }
    }
    return { error: `"${w.symbol}" does not appear in ${rel(reg.currentRoot(), path)}.` }
  }

  if (w.line === undefined) return { error: 'Pass either `symbol` or `line`.' }
  const pos = toLsp(w.line, w.character ?? 1)
  return { path, pos, note: `at ${w.line}:${w.character ?? 1}` }
}

/** Server state, for the never-return-a-bare-empty-list rule. */
function hint(id: ServerId): string {
  return `[${id}: ${reg.statusLine(id)}]`
}

async function ask<T>(
  path: string,
  method: string,
  params: Record<string, unknown>,
): Promise<{ result: T; ms: number; via: string; id: ServerId } | { error: string }> {
  const id = serverFor(path)
  if (!id) return { error: `No language server handles ${rel(reg.currentRoot(), path)}.` }
  const entry = await reg.ensure(id)
  if (!entry) {
    const why = reg.whyMissing(id)
    return {
      error: `No ${id} language server. Looked in:\n  ${(why?.tried ?? []).join('\n  ')}\nAsk the user to install one, or run the install yourself and tell them the path.`,
    }
  }
  await reg.openDoc(path, 'agent')
  const t0 = Date.now()
  try {
    const result = (await entry.client.request(method, {
      textDocument: { uri: toUri(path) },
      ...params,
    })) as T
    return { result, ms: Date.now() - t0, via: entry.resolved.via, id }
  } catch (err) {
    return { error: `${method} failed: ${String(err)}` }
  }
}

/** LSP returns Location | Location[] | LocationLink[]. Flatten all three. */
function asLocations(v: unknown): Loc[] {
  if (!v) return []
  const arr = Array.isArray(v) ? v : [v]
  return arr.flatMap((x) => {
    const o = x as Record<string, unknown>
    if (o.targetUri) return [{ uri: o.targetUri as string, range: (o.targetSelectionRange ?? o.targetRange) as Loc['range'] }]
    if (o.uri) return [o as unknown as Loc]
    return []
  })
}

const WHERE = {
  path: z.string().describe('File path, absolute or relative to the project root.'),
  line: z.number().optional().describe('1-based line number, as shown in an editor.'),
  character: z.number().optional().describe('1-based column. Ignored when `symbol` is given.'),
  symbol: z
    .string()
    .optional()
    .describe('Identifier to locate instead of a column. Prefer this over guessing a column.'),
}

function positional(
  name: string,
  description: string,
  method: string,
  label: string,
  extra: Record<string, unknown> = {},
) {
  return tool(
    name,
    description,
    WHERE,
    async (args): Promise<ToolResult> => {
      const where = locate(args as Where)
      if ('error' in where) return text(where.error, true)
      const res = await ask<unknown>(where.path, method, { position: where.pos, ...extra })
      if ('error' in res) return text(res.error, true)
      const locs = asLocations(res.result)
      const prov = provenance(res.id, res.via, res.ms)
      if (!locs.length) return text(empty(label, prov, hint(res.id)))
      return text(`${where.note}\n${locations(reg.currentRoot(), locs, lines, prov)}`)
    },
    { annotations: READ_ONLY },
  )
}

/**
 * `SdkMcpToolDefinition<any>` — the SDK's own type for this field, and the only
 * one that works. `SdkMcpToolDefinition<Schema>` is invariant in Schema because
 * the handler consumes args of that exact shape, so a heterogeneous array of
 * differently-shaped tools has no common instantiation other than `any`.
 */
export function lspTools(): SdkMcpToolDefinition<any>[] {
  return [
    positional(
      'lsp_definition',
      'Where a symbol is defined, from the language server. Compiler-accurate, unlike a text search.',
      'textDocument/definition',
      'definition',
    ),
    positional(
      'lsp_type_definition',
      'Where the TYPE of a symbol is defined.',
      'textDocument/typeDefinition',
      'type definition',
    ),
    positional(
      'lsp_implementations',
      'Implementations of an interface or abstract member.',
      'textDocument/implementation',
      'implementation',
    ),
    positional(
      'lsp_references',
      'Every reference to a symbol, from the language server. Use this instead of grep before any refactor: a text search matches unrelated identifiers with the same name, this does not.',
      'textDocument/references',
      'reference',
      { context: { includeDeclaration: false } },
    ),

    tool(
      'lsp_hover',
      'Type signature and documentation for a symbol.',
      WHERE,
      async (args): Promise<ToolResult> => {
        const where = locate(args as Where)
        if ('error' in where) return text(where.error, true)
        const res = await ask<unknown>(where.path, 'textDocument/hover', { position: where.pos })
        if ('error' in res) return text(res.error, true)
        const body = fmtHover((res.result as { contents?: unknown } | null)?.contents)
        const prov = provenance(res.id, res.via, res.ms)
        return text(body ? `${where.note}\n${body}\n${prov}` : empty('hover info', prov, hint(res.id)))
      },
      { annotations: READ_ONLY },
    ),

    tool(
      'lsp_document_symbols',
      'The outline of one file: its classes, functions and members, with line numbers.',
      { path: z.string().describe('File path, absolute or relative to the project root.') },
      async ({ path }): Promise<ToolResult> => {
        const p = abs(path)
        const res = await ask<DocSym[]>(p, 'textDocument/documentSymbol', {})
        if ('error' in res) return text(res.error, true)
        const prov = provenance(res.id, res.via, res.ms)
        const body = outline(res.result ?? [])
        return text(body ? `${rel(reg.currentRoot(), p)}\n${body}\n${prov}` : empty('symbols', prov, hint(res.id)))
      },
      { annotations: READ_ONLY },
    ),

    tool(
      'lsp_workspace_symbols',
      'Find a symbol by name anywhere in the project, without knowing its file.',
      {
        query: z.string().describe('Symbol name or prefix.'),
        maxResults: z.number().optional().describe('Default 50.'),
      },
      async ({ query, maxResults }): Promise<ToolResult> => {
        // Workspace symbols are not tied to a file, so pick the server that is
        // already up rather than guessing from an extension.
        const id: ServerId = 'ts'
        const entry = await reg.ensure(id)
        if (!entry) return text(`No ${id} language server running.`, true)
        const t0 = Date.now()
        const syms = ((await entry.client.request('workspace/symbol', { query })) ?? []) as Array<{
          name: string
          kind?: number
          location: Loc
        }>
        const prov = provenance(id, entry.resolved.via, Date.now() - t0)
        if (!syms.length) return text(empty(`symbol matching "${query}"`, prov, hint(id)))
        const rows = syms.slice(0, maxResults ?? 50).map((s) => {
          const path = decodeURIComponent(s.location.uri.replace('file://', ''))
          const d = toDisplay(s.location.range.start)
          return `${kindName(s.kind)} ${s.name}  ${rel(reg.currentRoot(), path)}:${d.line}`
        })
        if (syms.length > rows.length) rows.push(`… and ${syms.length - rows.length} more`)
        return text(`${rows.join('\n')}\n${prov}`)
      },
      { annotations: READ_ONLY },
    ),

    tool(
      'lsp_diagnostics',
      'Type errors and warnings, from the compiler rather than from inspection. Use before claiming an edit is correct.',
      {
        paths: z
          .array(z.string())
          .optional()
          .describe('Files to check. Defaults to everything currently open.'),
        errorsOnly: z.boolean().optional().describe('Default true. Warnings are usually noise.'),
      },
      async ({ paths, errorsOnly }): Promise<ToolResult> => {
        const targets = (paths ?? reg.openDocPaths()).map(abs)
        if (!targets.length) return text('No files to check. Pass `paths`.')
        const t0 = Date.now()
        const rows: Array<{ path: string; diags: Diag[] }> = []
        for (const p of targets) {
          const diags = (await reg.diagnose(p)) as Diag[]
          const kept = errorsOnly === false ? diags : diags.filter((d) => (d.severity ?? 1) === 1)
          if (kept.length) rows.push({ path: p, diags: kept })
        }
        const id = serverFor(targets[0]!) ?? 'ts'
        const prov = provenance(id, reg.statusLine(id), Date.now() - t0)
        const body = fmtDiagnostics(reg.currentRoot(), rows, prov)
        return text(
          body ||
            `Clean — no ${errorsOnly === false ? 'diagnostics' : 'errors'} in ${targets.length} file(s). ${prov}`,
        )
      },
      { annotations: READ_ONLY },
    ),
  ]
}

/**
 * The read-only tools, for `allowedTools`.
 *
 * Measured, not assumed: an MCP tool call DOES reach `canUseTool` — the card
 * reads "Allow mcp__lsp__lsp_document_symbols?" — so without this every
 * reference lookup raises an approval prompt, and a tool that interrupts you to
 * ask permission to read a symbol table is a tool nobody keeps using.
 *
 * Auto-allowing these widens nothing, which is the only reason it is acceptable
 * here. The agent can already call `Read` on any file in the project; asking a
 * compiler where a symbol is defined reveals strictly LESS than reading the file
 * would. Same structural argument the codebase already makes for
 * setMcpPermissionOverride: safe to expose directly because it cannot grant
 * anything that was not already granted.
 *
 * Deliberately a list rather than a wildcard. `mcp__lsp__*` would sweep in
 * whatever gets added later — and rename and code-action-apply WRITE. Those
 * must keep prompting, so they must never be able to join this list by accident.
 */
export const READ_ONLY_TOOLS = [
  'mcp__lsp__lsp_definition',
  'mcp__lsp__lsp_type_definition',
  'mcp__lsp__lsp_implementations',
  'mcp__lsp__lsp_references',
  'mcp__lsp__lsp_hover',
  'mcp__lsp__lsp_document_symbols',
  'mcp__lsp__lsp_workspace_symbols',
  'mcp__lsp__lsp_diagnostics',
]

export function lspMcpServer(): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: 'lsp',
    version: '1',
    instructions:
      'Language-server tools for this project. Prefer these over grep for anything about symbols: ' +
      'lsp_references finds real call sites where a text search finds coincidental name matches, ' +
      'and lsp_diagnostics reports what the compiler thinks rather than what the code looks like. ' +
      'Positions are 1-based; pass `symbol` rather than guessing a column.',
    tools: lspTools(),
  })
}
