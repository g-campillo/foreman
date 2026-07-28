/**
 * Syntax highlighting for the inline diffs on tool cards: `npm run check:highlight`.
 *
 * lowlight, not highlight.js directly, for one decisive reason: it returns a
 * hast TREE rather than an HTML string, so nothing here ever reaches
 * `dangerouslySetInnerHTML` with agent-authored file content. It is also already
 * in the bundle — `rehype-highlight`, which paints fenced code blocks in the
 * transcript, imports it — so promoting it to a direct dependency was a manifest
 * line and zero new bytes. Same grammars means the hand-mapped `.hljs-*` palette
 * in theme.css applies with no new tokens.
 *
 * `.mts` and free of React/DOM so the asserts can run under bare node.
 */
import { createLowlight, common } from 'lowlight'
import type { Root, RootContent } from 'hast'
import type { DiffLine } from '../../shared/types'
import { languageOf } from '../../shared/languages.mts'

/** One instance for the process. Registering 37 grammars is not free, and
 *  nothing here is stateful across calls. */
const lowlight = createLowlight(common)

/**
 * LSP languageId -> highlight.js grammar name, for the six that disagree.
 *
 * Deliberately here and NOT in shared/languages.mts: that file's header is
 * explicit that it is dependency-free, runs under bare node for check:lsp, and
 * holds LSP-spec ids. An hljs name is a renderer concern and would be a second
 * vocabulary in a file that exists to own exactly one.
 *
 * Six and no more: highlight.js auto-registers each grammar's aliases, which
 * already covers ts/tsx/js/jsx/html/sh/md/toml. These are the values languageOf
 * can return that no alias catches. `scala` and `groovy` are genuinely absent
 * from the common set and correctly fall through to null.
 */
const HLJS_BY_LSP: Record<string, string> = {
  typescriptreact: 'typescript',
  javascriptreact: 'javascript',
  shellscript: 'bash',
  'objective-c': 'objectivec',
  'objective-cpp': 'objectivec',
  jsonc: 'json',
}

/**
 * The grammar to highlight a path with, or null for "render it plain".
 *
 * Null for an unknown extension, a dotfile, AND a language lowlight has no
 * grammar for — the last check is what keeps callers from having to know that
 * `lowlight.highlight` THROWS on an unregistered name, which inside a render
 * would blank the whole transcript pane.
 */
export function hljsLang(path: string): string | null {
  const lsp = languageOf(path)
  if (!lsp) return null
  const name = HLJS_BY_LSP[lsp] ?? lsp
  return lowlight.registered(name) ? name : null
}

/** A run of text sharing one class chain. `cls` is '' for unhighlighted text. */
export interface Tok {
  text: string
  cls: string
}

function classOf(node: RootContent): string {
  if (node.type !== 'element') return ''
  const cn = node.properties?.className
  if (Array.isArray(cn)) return cn.filter((c) => typeof c === 'string').join(' ')
  return typeof cn === 'string' ? cn : ''
}

/**
 * Flatten a hast root into one Tok array per source line.
 *
 * The ancestor class chain is JOINED onto a single span rather than nested, so
 * one flat span carries `class="hljs-class hljs-title"`. Compound selectors
 * (`.hljs-title.function_`) keep working; the one descendant selector in the
 * palette (`.hljs-class .hljs-title`) does not, which is why theme.css lists the
 * compound form alongside it.
 *
 * Always returns at least one line, so an empty input is one empty line — which
 * is what `''.split('\n')` gives and what the caller's line-count check expects.
 */
export function toLines(root: Root): Tok[][] {
  const out: Tok[][] = [[]]

  const walk = (nodes: RootContent[], cls: string): void => {
    for (const node of nodes) {
      if (node.type === 'text') {
        const parts = node.value.split('\n')
        for (let i = 0; i < parts.length; i++) {
          if (i > 0) out.push([])
          if (parts[i]) out[out.length - 1]!.push({ text: parts[i]!, cls })
        }
      } else if (node.type === 'element') {
        const own = classOf(node)
        walk(node.children, own ? (cls ? `${cls} ${own}` : own) : cls)
      }
    }
  }

  walk(root.children, '')
  return out
}

/**
 * Tokens for each of `lines`, or null to render them plain.
 *
 * Highlights per SIDE, not per line, and that is the whole design. There is no
 * public continuation API — highlight.js's internal `_highlight` takes a 4th
 * `continuation` argument that neither `highlight()` nor lowlight exposes — so a
 * line highlighted alone is a line with no context. Concretely: this repo's own
 * diff.mts line 5 (`* Shared by main's git panel...`) is not a comment on its
 * own, and hljs sees the apostrophe in `main's`, opens a string that never
 * closes, and paints the rest of the line green.
 *
 * TWO passes rather than one over the interleaved body, because a `-` line and
 * its `+` replacement are ALTERNATIVE texts, not consecutive ones: an edit that
 * removes and re-adds a `/*` would open the comment twice in a single pass.
 *
 * Residual and irreducible: a hunk is a fragment, so its first lines still lack
 * whatever came above them in the file. That is the same truth DiffLines already
 * tells by rendering tool-card diffs with `numbers={false}`.
 *
 * Returns null on a throw AND on a line-count mismatch. The mismatch case
 * matters more than it looks: without it a grammar quirk would slide the zip by
 * one and paint one line's colours onto another, which reads as a real edit.
 */
export function tokenizeDiff(lines: readonly DiffLine[], lang: string): Tok[][] | null {
  if (lines.length === 0) return null

  const oldSrc = lines.filter((l) => l.type !== 'add')
  const newSrc = lines.filter((l) => l.type !== 'del')

  const side = (src: readonly DiffLine[]): Tok[][] =>
    src.length ? toLines(lowlight.highlight(lang, src.map((l) => l.text).join('\n'))) : []

  let oldToks: Tok[][]
  let newToks: Tok[][]
  try {
    oldToks = side(oldSrc)
    newToks = side(newSrc)
  } catch {
    // An unregistered grammar, or a grammar that threw on this input. Either way
    // plain text is the correct fallback and a thrown render is not.
    return null
  }

  if (oldToks.length !== oldSrc.length || newToks.length !== newSrc.length) return null

  const out: Tok[][] = []
  let oi = 0
  let ni = 0
  for (const line of lines) {
    // `ctx` consumes BOTH cursors — the line exists on each side — and renders
    // the new side, since that is the text the file will be left with.
    if (line.type === 'del') out.push(oldToks[oi++]!)
    else if (line.type === 'add') out.push(newToks[ni++]!)
    else {
      oi++
      out.push(newToks[ni++]!)
    }
  }
  return out
}
