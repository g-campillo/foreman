import { useEffect, useRef, useState } from 'react'
import { CornerDownRight, Image as ImageIcon, Pencil, X } from 'lucide-react'
import type { ChatItem } from '../../../shared/types'
import { useStore } from '../store'

const EMPTY: ChatItem[] = []

/**
 * The messages waiting behind the running turn.
 *
 * They used to render as dimmed rows in the transcript, which is what made a
 * queued message close the running turn and fold it — see the `queued` slice in
 * the store. Here they are what they actually are: a short list of things that
 * have NOT been said yet, sitting between the composer and the conversation.
 *
 * Same slot as the background-task tray, above `.composer-card`, because it is
 * the same shape of thing: status about the composer rather than part of the
 * field. The dashed border is the app's existing "not sent yet" signal, carried
 * over from `.msg-user[data-queued]`, which this replaces.
 */
export default function QueueTray({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const queued = useStore((s) => s.queued[sessionId] ?? EMPTY)
  const setNotice = useStore((s) => s.setNotice)
  /** The row being edited, or null. One at a time — the tray is a list of two or
   *  three items, not an editor. */
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  // A row can leave the queue while its editor is open: the turn ends and main
  // hands the message to the SDK. Closing here rather than only on save keeps
  // the tray from holding a textarea over a message that is already running.
  useEffect(() => {
    if (editing && !queued.some((x) => x.id === editing)) setEditing(null)
  }, [queued, editing])

  if (queued.length === 0) return null

  const save = (itemId: string): void => {
    const text = draft.trim()
    setEditing(null)
    if (!text) return
    // Text and only text. Any images the message carries stay in main's queue
    // and are re-attached to the rewritten content there — see
    // Session.queuedImages — rather than making a megabyte of base64 cross the
    // bridge twice to change a sentence.
    void window.foreman.editQueued(sessionId, itemId, text).then((ok) => {
      // The race the round trip exists to lose safely: the message left the
      // queue between the pencil and the save, so the edit cannot land and
      // saying nothing would look like it had.
      if (!ok) setNotice('That message had already been sent — the edit was not applied.')
    })
  }

  return (
    <div className="q-tray">
      <div className="q-head">
        <CornerDownRight size={12} />
        {queued.length} queued
      </div>
      {queued.map((item) =>
        editing === item.id ? (
          <QueueEditor
            key={item.id}
            value={draft}
            onChange={setDraft}
            onSave={() => save(item.id)}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <div key={item.id} className="q-row">
            <span className="q-text">{item.kind === 'user' ? item.text : ''}</span>
            {/* A count, not thumbnails — the row is one line high. It is here so
                an attachment is visibly still attached after an edit, which is
                the one thing a text-only editor cannot show you. */}
            {item.kind === 'user' && item.images?.length ? (
              <span className="q-img">
                <ImageIcon size={11} />
                {item.images.length}
              </span>
            ) : null}
            <button
              className="q-act"
              data-tip="Edit this message before it is sent"
              aria-label="Edit this queued message"
              onClick={() => {
                setDraft(item.kind === 'user' ? item.text : '')
                setEditing(item.id)
              }}
            >
              <Pencil size={12} />
            </button>
            <button
              className="q-act"
              data-tip="Cancel this queued message — it has not reached the agent yet"
              aria-label="Cancel this queued message"
              onClick={() => void window.foreman.cancelQueued(sessionId, item.id)}
            >
              <X size={12} />
            </button>
          </div>
        ),
      )}
    </div>
  )
}

/**
 * A plain `<textarea>`, deliberately — not the MarkdownInput the composer uses.
 *
 * The tray is a holding pen for one or two lines, and a second CodeMirror
 * instance per queued row would bring its own keymaps, its own autocomplete and
 * its own focus rules to a box you are in for four seconds.
 */
function QueueEditor({
  value,
  onChange,
  onSave,
  onCancel,
}: {
  value: string
  onChange: (v: string) => void
  onSave: () => void
  onCancel: () => void
}): React.JSX.Element {
  const box = useRef<HTMLTextAreaElement>(null)
  // The pencil is a click, so nothing has focus afterwards; without this the
  // editor opens and the keys go nowhere.
  useEffect(() => {
    box.current?.focus()
    box.current?.select()
  }, [])

  return (
    <div className="q-row" data-editing="">
      <textarea
        ref={box}
        className="q-edit"
        value={value}
        rows={1}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          // ⏎ saves and ⇧⏎ is a newline, matching the composer. ⌘⏎ saves too,
          // because that is what the muscle memory of every other box here does.
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            onSave()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            // Stopped here, and it is not defensive. Messages queue while the
            // session is 'awaiting-approval' too, so a PlanCard can be open
            // above this — and PlanCard binds a BARE window-level Escape.
            // Without this, abandoning an edit would dismiss the plan modal.
            e.stopPropagation()
            onCancel()
          }
        }}
      />
    </div>
  )
}
