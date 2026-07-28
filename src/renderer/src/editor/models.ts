import type { FileRead } from '../../../shared/types'
import { applyTheme, editorOptions, loadMonaco, type Monaco } from './monaco'

/**
 * Editor state that must outlive React, following TerminalPane's `slots` map.
 *
 * Two things live here and they are keyed differently on purpose:
 *
 *   Buffers are keyed by ABSOLUTE PATH and are app-global. Monaco enforces URI
 *   uniqueness anyway, so there is no choice — but it is also correct. Worktree
 *   sessions have different absolute paths for the same relative file, so
 *   `Uri.file(abs)` is already worktree-correct; and two sessions on one cwd
 *   sharing a buffer is the same file on disk, so sharing keeps dirty state and
 *   save consistent instead of racing.
 *
 *   The editor VIEW is a singleton. The modal shows one file at a time, so a
 *   second IStandaloneCodeEditor would be pure waste; switching files is
 *   setModel() plus a saved view state, which is also what makes reopening land
 *   where you left off.
 *
 * The host div is created once and re-parented into whatever modal body is
 * currently mounted — the generalisation of TerminalPane's
 * `el.contains(slot.term.element)` guard. Without it every open would rebuild
 * the editor, which is visible.
 */

type Editor = import('monaco-editor').editor.IStandaloneCodeEditor
type Model = import('monaco-editor').editor.ITextModel
type ViewState = import('monaco-editor').editor.ICodeEditorViewState

interface Buf {
  model: Model
  /**
   * `getAlternativeVersionId()` at the last load or save.
   *
   * Alternative, not `getVersionId()`: the alternative id goes BACK when you
   * undo to a previously-saved state, so "type then undo" correctly reads as
   * clean again. getVersionId only ever increments, which leaves a tab dirty
   * forever and is the version of this everyone ships by accident.
   */
  savedVersionId: number
  /** Optimistic-concurrency token. Handed back on write; a mismatch is refused. */
  mtimeMs: number
  bom: boolean
  view: ViewState | null
}

const bufs = new Map<string, Buf>()

let editor: Editor | null = null
let host: HTMLDivElement | null = null
let currentPath: string | null = null

export function isDirty(path: string): boolean {
  const b = bufs.get(path)
  return b ? b.model.getAlternativeVersionId() !== b.savedVersionId : false
}

export function bufFor(path: string): Buf | undefined {
  return bufs.get(path)
}

/** Every open buffer, for the mtime sweep. */
export function openPaths(): string[] {
  return [...bufs.keys()]
}

/**
 * Create or update the buffer for a path from a successful read.
 *
 * Reuses an existing model rather than disposing and recreating it, so an
 * external-change reload keeps undo history, decorations and folds.
 */
export async function loadBuffer(path: string, read: Extract<FileRead, { ok: true }>): Promise<void> {
  const monaco = await loadMonaco()
  const uri = monaco.Uri.file(path)
  const existing = bufs.get(path)

  if (existing) {
    if (existing.model.getValue() !== read.text) existing.model.setValue(read.text)
    existing.savedVersionId = existing.model.getAlternativeVersionId()
    existing.mtimeMs = read.mtimeMs
    existing.bom = read.bom
    return
  }

  // Language comes from the URI's extension — Monaco owns that table, so there
  // is no extension->language map to write or keep up to date.
  const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(read.text, undefined, uri)
  // Set explicitly rather than trusting detection. getValue() then emits CRLF,
  // which keeps the write path dumb — miss this and saving one line of a CRLF
  // file rewrites every line, and the diff panel lights up for a one-word edit.
  model.setEOL(
    read.eol === 'crlf'
      ? monaco.editor.EndOfLineSequence.CRLF
      : monaco.editor.EndOfLineSequence.LF,
  )

  bufs.set(path, {
    model,
    savedVersionId: model.getAlternativeVersionId(),
    mtimeMs: read.mtimeMs,
    bom: read.bom,
    view: null,
  })
}

export function markSaved(path: string, mtimeMs: number): void {
  const b = bufs.get(path)
  if (!b) return
  b.savedVersionId = b.model.getAlternativeVersionId()
  b.mtimeMs = mtimeMs
}

/**
 * Attach the singleton editor to a mount point and show `path`.
 *
 * The zero-size guard is the same hazard TerminalPane documents: Monaco measures
 * its character cell by reading getBoundingClientRect() on a probe element, and
 * inside a zero-height box every metric it caches is poisoned. The modal is
 * conditionally rendered so this is rarer than it is for the panels, but the
 * frame on which it first mounts has not laid out yet.
 */
export async function attach(mount: HTMLElement, path: string, line: number | null): Promise<void> {
  const monaco = await loadMonaco()
  const buf = bufs.get(path)
  if (!buf) return

  if (!host) {
    host = document.createElement('div')
    host.className = 'file-host'
  }
  if (!mount.contains(host)) mount.appendChild(host)

  if (!editor) {
    editor = monaco.editor.create(host, {
      ...editorOptions(),
      model: buf.model,
      // Monaco's suggest/hover/find widgets are absolutely positioned inside the
      // editor, and .plan-modal sets overflow:hidden — so near the bottom edge
      // they would be clipped by the modal itself. Same escape hatch Tooltip
      // already takes for the same class of reason.
      overflowWidgetsDomNode: overflowHost(),
      fixedOverflowWidgets: true,
    } as never)
    currentPath = path
  } else if (currentPath !== path) {
    if (currentPath) {
      const prev = bufs.get(currentPath)
      if (prev) prev.view = editor.saveViewState()
    }
    editor.setModel(buf.model)
    currentPath = path
    if (buf.view && line === null) editor.restoreViewState(buf.view)
  }

  // One frame late, deliberately. On the render that reveals the modal, layout
  // for the freshly-mounted subtree has not settled when effects run, so
  // measuring now caches the wrong cell size.
  // Dev-only handle for driving the editor over CDP, mirroring the __store one
  // in main.tsx. Stripped from production builds — and worth having, because
  // Monaco's keybindings cannot be reached with synthetic DOM key events and
  // F12 collides with DevTools, so this is the only way to test an action.
  if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__editor = editor

  requestAnimationFrame(() => {
    if (!editor) return
    monaco.editor.remeasureFonts()
    editor.layout()
    if (line !== null) {
      editor.revealLineInCenter(line)
      editor.setPosition({ lineNumber: line, column: 1 })
    }
    editor.focus()
  })
}

/** Called when the modal closes. Keeps the editor and every model alive. */
export function detach(): void {
  if (editor && currentPath) {
    const buf = bufs.get(currentPath)
    if (buf) buf.view = editor.saveViewState()
  }
  host?.remove()
}

export function relayout(): void {
  editor?.layout()
}

/**
 * True while the caret is inside the editor.
 *
 * The whole of the don't-fight-me rule is this one condition, checked in one
 * place. No debounce, no is-the-user-typing heuristic, no timer — the DOM
 * already knows, the same way TerminalPane's `visible && clientHeight` guard
 * already knows whether it can measure.
 */
export function editorHasFocus(): boolean {
  return editor?.hasTextFocus() ?? false
}

/** Reveal a line without disturbing the model or the undo stack. */
export function revealLine(line: number): void {
  editor?.revealLineInCenterIfOutsideViewport(line)
}

let decorations: string[] = []

/**
 * Stripe the lines the agent wrote, and make them clickable.
 *
 * Handed to Monaco as DECORATIONS rather than kept as line numbers, and that is
 * the point: from here on Monaco position-maps them through every subsequent
 * edit, yours and the agent's. Drift within a session is its problem. Ours is
 * only the re-anchor on reopen, and resolveAnchors fails closed.
 */
export function setAuthored(
  monaco: Monaco,
  ranges: { line: number; itemId: string }[],
  changed: Set<number>,
): void {
  if (!editor) return
  const model = editor.getModel()
  if (!model) return

  const byLine = new Map(ranges.map((r) => [r.line, r.itemId]))
  // Git decides what is striped; anchors only decide what is LINKABLE. A line
  // the agent changed but whose text has since moved on still shows, it just
  // stops offering to jump.
  const lines = new Set<number>([...changed, ...byLine.keys()])

  decorations = model.deltaDecorations(
    decorations,
    [...lines]
      .filter((n) => n >= 1 && n <= model.getLineCount())
      .map((n) => ({
        range: new monaco.Range(n, 1, n, 1),
        options: {
          isWholeLine: true,
          linesDecorationsClassName: byLine.has(n) ? 'agent-gutter agent-linked' : 'agent-gutter',
          className: 'agent-line',
          ...(byLine.has(n) ? { glyphMarginHoverMessage: { value: 'Written by the agent — click to jump' } } : {}),
        },
      })),
  )
  linkedLines = byLine
}

let linkedLines = new Map<number, string>()

/** The transcript item that wrote a line, if the anchor still matches. */
export function itemForLine(line: number): string | undefined {
  return linkedLines.get(line)
}

/** Fires when a gutter stripe is clicked. Registered once, from FileModal. */
export function onGutterClick(cb: (itemId: string) => void): () => void {
  const ed = editor
  if (!ed) return () => undefined
  const sub = ed.onMouseDown((e) => {
    const line = e.target.position?.lineNumber
    if (line === undefined) return
    const id = linkedLines.get(line)
    if (id) cb(id)
  })
  return () => sub.dispose()
}

export function getEditor(): Editor | null {
  return editor
}

/** Re-theme in place. Monaco's theme is global, so this is one call — unlike
 *  TerminalPane, which has to loop every slot. */
export function retheme(monaco: Monaco): void {
  applyTheme(monaco)
}

/**
 * A body-level container for Monaco's overflowing widgets.
 *
 * Below the tooltip's z-index 70 so a tip still paints over a suggest list, and
 * above the scrims' 50/60 so the list is not painted over by its own modal.
 *
 * `monaco-editor` in the class list is not a mistake and is not decoration —
 * without it the widgets render as unstyled transparent DOM. Every rule in
 * Monaco's suggest.css, hover.css and parameterHints.css is scoped under
 * `.monaco-editor`, and standaloneThemeService declares the whole `--vscode-*`
 * variable block on `.monaco-editor, .monaco-diff-editor, .monaco-component`
 * only. Monaco does exactly this to its own overflow container
 * (multiDiffEditorWidgetImpl builds `h('div.monaco-editor@overflowWidgetsDomNode')`).
 *
 * Do NOT also add a theme class (`vs-dark` / `foreman`): Monaco applies that
 * only to an editor's own root, so a hand-added one goes stale on every theme
 * flip. The variable block above is theme-independent and retheme() rewrites it
 * globally, so `monaco-editor` alone is both sufficient and correct.
 */
let overflow: HTMLDivElement | null = null
function overflowHost(): HTMLElement {
  if (!overflow) {
    overflow = document.createElement('div')
    overflow.className = 'monaco-overflow monaco-editor'
    document.body.appendChild(overflow)
  }
  return overflow
}
