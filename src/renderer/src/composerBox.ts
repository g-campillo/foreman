import type { EditorView } from '@codemirror/view'

/**
 * The composer's live CodeMirror view, as a module-level ref.
 *
 * This was a `useRef` inside Composer. It is hoisted because the approval card
 * now hands focus BACK here — a printable key typed at a focused Allow button
 * belongs in the message you were writing, not in the button.
 *
 * A MODULE REF AND NOT A STORE NONCE, and the reason is the one character that
 * would otherwise be lost: `focus()` has to happen SYNCHRONOUSLY, during the
 * same keydown, or the browser delivers the keypress to the button and the
 * letter never reaches the editor. A store write is a render away, which is one
 * frame too late.
 *
 * Shaped as `{ current: EditorView | null }` rather than typed as React's
 * RefObject so this file imports nothing from React — it is structurally
 * identical, so it drops straight into MarkdownInput's `viewRef` prop, which
 * already assigns it on mount and nulls it on unmount.
 *
 * Single-instance by construction: App renders exactly one `<Composer>`, and
 * unkeyed, so its text survives a session switch. A per-session map would be a
 * fiction about state that does not exist.
 */
export const composerBox: { current: EditorView | null } = { current: null }
