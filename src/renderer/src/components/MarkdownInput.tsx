import { useEffect, useRef } from 'react'
import { Compartment, EditorState, Prec, RangeSet, type Extension } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  keymap,
  placeholder as cmPlaceholder,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'
import { history, historyKeymap, defaultKeymap, insertNewlineAndIndent } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { syntaxTree } from '@codemirror/language'

/**
 * The composer, as a live-rendering markdown editor.
 *
 * CodeMirror rather than a hand-rolled contenteditable because **markdown stays
 * the document**: `state.doc.toString()` is the exact string we send, and
 * `selection.main.head` is a plain character offset — so the existing
 * `triggerAt()` autocomplete works unchanged, and there is no DOM-to-markdown
 * serializer that could quietly rewrite what the user typed. ProseMirror-family
 * editors model a typed node tree instead, and their markdown export normalizes.
 *
 * It also brings undo, IME/composition and rich-paste correctness, which are the
 * three things a from-scratch version gets wrong for months.
 */

/** Inline nodes whose delimiters hide when the caret is elsewhere. */
const STYLED: Record<string, string> = {
  StrongEmphasis: 'cm-md-strong',
  Emphasis: 'cm-md-em',
  InlineCode: 'cm-md-code',
  Strikethrough: 'cm-md-strike',
}

/** Delimiter node names, hidden with their parent. */
const MARKS = new Set(['EmphasisMark', 'CodeMark', 'HeaderMark', 'StrikethroughMark'])

const HIDE = Decoration.replace({})

/**
 * The live-preview decorations.
 *
 * Markers are hidden only while the selection is outside the construct that owns
 * them — that is what makes the text still editable: put the caret back in and
 * the `**` reappear, so there is never an invisible character to backspace over
 * blindly. This is the Obsidian live-preview rule, and CodeMirror's
 * atomic-range handling is what makes arrowing past a hidden run behave.
 */
function decorate(view: EditorView): DecorationSet {
  const ranges: { from: number; to: number; value: Decoration }[] = []
  const sel = view.state.selection.main
  const doc = view.state.doc

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        const heading = /^ATXHeading(\d)$/.exec(node.name)
        const cls = heading ? `cm-md-h${heading[1]}` : STYLED[node.name]
        if (!cls) return

        if (node.to > node.from) {
          ranges.push({ from: node.from, to: node.to, value: Decoration.mark({ class: cls }) })
        }

        // Touching counts as inside: with the caret at the very end of `**bold`,
        // hiding the delimiter you are about to close reads as the editor
        // fighting you.
        const inside = sel.from <= node.to && sel.to >= node.from
        if (inside) return

        for (let c = node.node.firstChild; c; c = c.nextSibling) {
          if (!MARKS.has(c.name)) continue
          // A heading's '#' owns the space after it too, or hiding the hash
          // leaves the line indented by one.
          const pad =
            c.name === 'HeaderMark' && doc.sliceString(c.to, c.to + 1) === ' ' ? 1 : 0
          if (c.to + pad > c.from) ranges.push({ from: c.from, to: c.to + pad, value: HIDE })
        }
      },
    })
  }
  return ranges.length ? Decoration.set(ranges, true) : RangeSet.empty
}

const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = decorate(view)
    }
    update(u: ViewUpdate): void {
      // selectionSet matters as much as docChanged here: moving the caret out of
      // a span is what hides its markers.
      if (u.docChanged || u.selectionSet || u.viewportChanged) this.decorations = decorate(u.view)
    }
  },
  { decorations: (v) => v.decorations },
)

export default function MarkdownInput({
  value,
  caret,
  onChange,
  onKeyDown,
  placeholder,
  onPaste,
  onDrop,
  onDragOver,
  viewRef,
}: {
  value: string
  /** Character offset. -1 means "leave the selection alone" (Escape's sentinel). */
  caret: number
  onChange: (text: string, caret: number) => void
  /** Runs before CodeMirror's own bindings; preventDefault to consume the key. */
  onKeyDown?: (e: KeyboardEvent) => void
  placeholder: string
  onPaste?: (e: ClipboardEvent) => void
  onDrop?: (e: DragEvent) => void
  onDragOver?: (e: DragEvent) => void
  /** Lets the parent focus the editor after replacing the text. */
  viewRef?: React.RefObject<EditorView | null>
}): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const ph = useRef(new Compartment())

  // Props change every keystroke, but the editor is built once — so the handlers
  // are read through a ref rather than baked into the extensions.
  const cb = useRef({ onChange, onKeyDown, onPaste, onDrop, onDragOver })
  cb.current = { onChange, onKeyDown, onPaste, onDrop, onDragOver }

  useEffect(() => {
    if (!host.current) return

    const extensions: Extension[] = [
      history(),
      markdown(),
      livePreview,
      EditorView.lineWrapping,
      ph.current.of(cmPlaceholder(placeholder)),
      // Highest, so the parent's popover/submit handling beats every built-in
      // binding — the autocomplete's Enter must not insert a newline first.
      Prec.highest(
        EditorView.domEventHandlers({
          keydown: (e) => {
            cb.current.onKeyDown?.(e)
            return e.defaultPrevented
          },
          paste: (e) => {
            cb.current.onPaste?.(e)
            return e.defaultPrevented
          },
          drop: (e) => {
            cb.current.onDrop?.(e)
            return e.defaultPrevented
          },
          dragover: (e) => {
            cb.current.onDragOver?.(e)
            return e.defaultPrevented
          },
        }),
      ),
      // Bound explicitly: plain Enter is consumed by the parent (it sends), so
      // without this the newline case would fall through to nothing.
      keymap.of([{ key: 'Shift-Enter', run: insertNewlineAndIndent }]),
      keymap.of([...historyKeymap, ...defaultKeymap]),
      EditorView.updateListener.of((u) => {
        if (!u.docChanged && !u.selectionSet) return
        cb.current.onChange(u.state.doc.toString(), u.state.selection.main.head)
      }),
    ]

    const v = new EditorView({
      state: EditorState.create({ doc: value, extensions }),
      parent: host.current,
    })
    view.current = v
    if (viewRef) viewRef.current = v

    return () => {
      v.destroy()
      view.current = null
      if (viewRef) viewRef.current = null
    }
    // Built once. `value`/`placeholder` are seeded here and synced by the effects
    // below; rebuilding on either would drop the undo history and the caret.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Pull in changes the parent made (submit clearing the box, an autocomplete
  // splice). Compared first, so our own updateListener echo is a no-op rather
  // than a dispatch loop.
  useEffect(() => {
    const v = view.current
    if (!v) return
    const current = v.state.doc.toString()
    if (current === value) return
    v.dispatch({
      changes: { from: 0, to: current.length, insert: value },
      selection: { anchor: Math.min(Math.max(caret, 0), value.length) },
    })
  }, [value, caret])

  useEffect(() => {
    const v = view.current
    if (!v || caret < 0) return
    const pos = Math.min(caret, v.state.doc.length)
    if (v.state.selection.main.head === pos) return
    v.dispatch({ selection: { anchor: pos } })
  }, [caret])

  useEffect(() => {
    view.current?.dispatch({
      effects: ph.current.reconfigure(cmPlaceholder(placeholder)),
    })
  }, [placeholder])

  return <div className="composer-editor" ref={host} />
}
