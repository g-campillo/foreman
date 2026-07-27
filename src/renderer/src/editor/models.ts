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
 */
let overflow: HTMLDivElement | null = null
function overflowHost(): HTMLElement {
  if (!overflow) {
    overflow = document.createElement('div')
    overflow.className = 'monaco-overflow'
    document.body.appendChild(overflow)
  }
  return overflow
}
