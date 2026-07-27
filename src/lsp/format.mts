/**
 * Turning LSP responses into text a model reads well.
 *
 * Three rules, and the third is the one that matters most:
 *
 *  1. `path:line:col` relative to cwd, with one trimmed source line. Raw LSP
 *     JSON is enormous and mostly URIs.
 *
 *  2. Positions are 1-BASED on both axes, because that is what this harness's
 *     own built-in LSP tool documents ("1-based, as shown in editors") and what
 *     models are therefore trained on. LSP is 0-based; the conversion happens
 *     here and nowhere else.
 *
 *  3. NEVER return a bare empty list. An empty list is exactly what a *broken*
 *     tool returns, and a model cannot tell "no references exist" from "the
 *     indexer has not finished". That ambiguity is the direct cause of the
 *     failure mode where a reference search quietly reports zero on a language
 *     it cannot actually resolve, and the agent believes it. Every empty result
 *     carries the server, its state, and what to do about it.
 *
 * Pure — no Electron, no SDK, no fs — so it runs under bare node.
 */

export interface Pos {
  line: number
  character: number
}
export interface Rng {
  start: Pos
  end: Pos
}
export interface Loc {
  uri: string
  range: Rng
}

const MAX_RESULTS = 50
const MAX_LINE = 200

/** LSP 0-based -> human/model 1-based. */
export function toDisplay(p: Pos): { line: number; column: number } {
  return { line: p.line + 1, column: p.character + 1 }
}

/** Model/human 1-based -> LSP 0-based. Clamped, because a model may send 0. */
export function toLsp(line: number, character: number): Pos {
  return { line: Math.max(0, line - 1), character: Math.max(0, character - 1) }
}

export function rel(root: string, path: string): string {
  const base = root.replace(/\/+$/, '')
  return path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path
}

/** `[typescript · project tsgo · 8ms]` — verifiability is the whole point. */
export function provenance(server: string, via: string, ms: number): string {
  return `[${server} · ${via} · ${ms}ms]`
}

/**
 * The empty-result message. Deliberately not "".
 *
 * `hint` is what distinguishes "genuinely none" from "ask again in a second",
 * which is the single most valuable bit of information this module carries.
 */
export function empty(what: string, prov: string, hint?: string): string {
  return `No ${what} found. ${prov}${hint ? `\n${hint}` : ''}`
}

/**
 * Locations, grouped by file with counts, each with its source line.
 *
 * `read` is injected rather than imported so this module stays fs-free and
 * therefore trivially testable.
 */
export function locations(
  root: string,
  locs: Loc[],
  read: (path: string) => string[] | null,
  prov: string,
): string {
  const byFile = new Map<string, Rng[]>()
  for (const l of locs) {
    const path = l.uri.startsWith('file://') ? decodeURIComponent(l.uri.slice(7)) : l.uri
    const list = byFile.get(path) ?? []
    list.push(l.range)
    byFile.set(path, list)
  }

  const out: string[] = []
  let shown = 0
  let dropped = 0

  for (const [path, ranges] of byFile) {
    const lines = read(path)
    out.push(`${rel(root, path)}  (${ranges.length})`)
    for (const r of ranges) {
      if (shown >= MAX_RESULTS) {
        dropped += 1
        continue
      }
      const d = toDisplay(r.start)
      const src = lines?.[r.start.line]?.trim().slice(0, MAX_LINE) ?? ''
      out.push(`  ${d.line}:${d.column}  ${src}`)
      shown += 1
    }
  }

  // A silent cap reads as "that is all of them", which is a lie the model will
  // act on. Say what was dropped.
  if (dropped) out.push(`… and ${dropped} more (showing the first ${MAX_RESULTS})`)
  out.push(prov)
  return out.join('\n')
}

export interface Diag {
  range: Rng
  severity?: number
  code?: string | number
  message: string
  source?: string
}

const SEV = ['', 'error', 'warning', 'info', 'hint']

/** Diagnostics as `path:line:col  error TS2322: msg`. */
export function diagnostics(
  root: string,
  byPath: Array<{ path: string; diags: Diag[] }>,
  prov: string,
  max = 25,
): string {
  const rows: string[] = []
  let dropped = 0
  for (const { path, diags } of byPath) {
    for (const d of diags) {
      if (rows.length >= max) {
        dropped += 1
        continue
      }
      const p = toDisplay(d.range.start)
      const sev = SEV[d.severity ?? 1] ?? 'error'
      const code = d.code === undefined ? '' : ` ${d.code}`
      rows.push(`${rel(root, path)}:${p.line}:${p.column}  ${sev}${code}: ${d.message.split('\n')[0]}`)
    }
  }
  if (!rows.length) return ''
  if (dropped) rows.push(`… and ${dropped} more`)
  rows.push(prov)
  return rows.join('\n')
}

/** Hover markdown, unwrapped from LSP's three legal shapes and capped. */
export function hover(contents: unknown, maxLines = 40): string | null {
  const text =
    typeof contents === 'string'
      ? contents
      : Array.isArray(contents)
        ? contents.map((c) => (typeof c === 'string' ? c : ((c as { value?: string }).value ?? ''))).join('\n')
        : ((contents as { value?: string } | null)?.value ?? '')
  const trimmed = text.trim()
  if (!trimmed) return null
  const lines = trimmed.split('\n')
  return lines.length > maxLines ? `${lines.slice(0, maxLines).join('\n')}\n…` : trimmed
}

const SYMBOL_KIND = [
  '', 'file', 'module', 'namespace', 'package', 'class', 'method', 'property',
  'field', 'constructor', 'enum', 'interface', 'function', 'variable', 'constant',
  'string', 'number', 'boolean', 'array', 'object', 'key', 'null', 'enum-member',
  'struct', 'event', 'operator', 'type-parameter',
]

export function kindName(kind: number | undefined): string {
  return SYMBOL_KIND[kind ?? 0] ?? 'symbol'
}

export interface DocSym {
  name: string
  kind?: number
  range?: Rng
  selectionRange?: Rng
  location?: Loc
  children?: DocSym[]
}

/** A document outline, indented by nesting. */
export function outline(syms: DocSym[], depth = 0): string {
  const out: string[] = []
  for (const s of syms) {
    const r = s.selectionRange ?? s.range ?? s.location?.range
    const at = r ? `  ${toDisplay(r.start).line}` : ''
    out.push(`${'  '.repeat(depth)}${kindName(s.kind)} ${s.name}${at}`)
    if (s.children?.length) out.push(outline(s.children, depth + 1))
  }
  return out.join('\n')
}
