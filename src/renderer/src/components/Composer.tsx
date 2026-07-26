import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  ImageMediaType,
  PermissionMode,
  SendBlock,
  SessionMeta,
  SlashCommandInfo,
} from '../../../shared/types'
import { useStore } from '../store'
import { filterEntries, triggerAt } from '../derive.mts'
import Autocomplete, { type Suggestion } from './Autocomplete'

/** Sentinel for "whatever the session is already running" when no alias matches. */
const CURRENT = '__current__'

/** Mirrors ImageMediaType; anything else is silently not attachable. */
const ACCEPTED: readonly ImageMediaType[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

/** Cap on suggestions rendered at once — a 4000-file repo must not build 4000 rows. */
const MAX_SUGGESTIONS = 50

/** Drop a trailing context-window suffix: 'claude-opus-5[1m]' -> 'claude-opus-5'. */
const bareModel = (id: string | null | undefined): string => (id ?? '').replace(/\[[^\]]*\]$/, '')

/** Exported so the command palette offers the same modes, spelled the same way. */
export const MODES: { value: PermissionMode; label: string }[] = [
  { value: 'default', label: 'Ask' },
  { value: 'acceptEdits', label: 'Accept edits' },
  { value: 'plan', label: 'Plan' },
  { value: 'bypassPermissions', label: 'Bypass' },
  { value: 'dontAsk', label: "Don't ask" },
]

/** Only the four types the API accepts get this far — see ACCEPTED below. */
interface Attachment {
  id: string
  mediaType: ImageMediaType
  /** base64, no data: prefix — that's what the wire format wants. */
  data: string
  name: string
}

export default function Composer({ session }: { session: SessionMeta }): React.JSX.Element {
  const send = useStore((s) => s.send)
  const models = useStore((s) => s.models)
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [caret, setCaret] = useState(0)
  const [cursor, setCursor] = useState(0)
  const [commands, setCommands] = useState<SlashCommandInfo[]>([])
  const [files, setFiles] = useState<string[]>([])
  const box = useRef<HTMLTextAreaElement>(null)

  const busy = session.status === 'running' || session.status === 'awaiting-approval'

  // Commands are fixed for the session's lifetime, so once is enough.
  useEffect(() => {
    setCommands([])
    setFiles([])
    void window.foreman.supportedCommands(session.id).then(setCommands)
  }, [session.id])

  const trigger = triggerAt(text, caret)
  const mentioning = trigger?.kind === 'file'

  // Files are NOT fixed — the agent creates them mid-session, and those are
  // exactly the ones you want to mention. Refetched when a mention opens rather
  // than once per session, which is one git call per `@` typed, not per keystroke.
  useEffect(() => {
    if (mentioning) void window.foreman.projectFiles(session.id).then(setFiles)
  }, [mentioning, session.id])

  const suggestions = useMemo<Suggestion[]>(() => {
    if (!trigger) return []
    const pool: Suggestion[] =
      trigger.kind === 'command'
        ? commands.map((c) => ({
            value: `/${c.name}`,
            label: `/${c.name}`,
            hint: c.argumentHint || c.description,
          }))
        : files.map((f) => ({ value: `@${f}`, label: f }))
    return filterEntries(pool, trigger.query).slice(0, MAX_SUGGESTIONS)
  }, [trigger?.kind, trigger?.query, commands, files])

  // A stale cursor would insert the wrong completion once the list shrinks.
  useEffect(() => setCursor(0), [trigger?.query, trigger?.kind])

  const pick = (s: Suggestion): void => {
    if (!trigger) return
    // Replace from the trigger character to the caret, keeping whatever the
    // user had already typed after it.
    const next = `${text.slice(0, trigger.start)}${s.value} ${text.slice(caret)}`
    const pos = trigger.start + s.value.length + 1
    setText(next)
    setCaret(pos)
    requestAnimationFrame(() => {
      box.current?.focus()
      box.current?.setSelectionRange(pos, pos)
    })
  }

  const submit = (): void => {
    const t = text.trim()
    if (!t && attachments.length === 0) return

    // Stay a plain string unless there's actually something attached — the
    // block form is only needed for images.
    const content = attachments.length
      ? ([
          ...attachments.map(
            (a): SendBlock => ({
              type: 'image',
              source: { type: 'base64', media_type: a.mediaType, data: a.data },
            }),
          ),
          ...(t ? [{ type: 'text', text: t } as SendBlock] : []),
        ] as SendBlock[])
      : t

    void send(content)
    setText('')
    setAttachments([])
    setCaret(0)
    if (box.current) box.current.style.height = 'auto'
  }

  const addFiles = (list: FileList | File[]): void => {
    for (const file of Array.from(list)) {
      // Rejected here rather than at send time, so an unsupported paste says so
      // immediately instead of failing a turn later.
      if (!ACCEPTED.includes(file.type as ImageMediaType)) continue
      const reader = new FileReader()
      reader.onload = () => {
        // readAsDataURL gives "data:<mime>;base64,<data>"; the wire wants the
        // media type and the payload separately.
        const [, data] = String(reader.result).split(',')
        if (!data) return
        setAttachments((a) => [
          ...a,
          {
            id: crypto.randomUUID(),
            mediaType: file.type as ImageMediaType,
            data,
            name: file.name || 'pasted image',
          },
        ])
      }
      reader.readAsDataURL(file)
    }
  }

  const syncCaret = (e: { currentTarget: HTMLTextAreaElement }): void =>
    setCaret(e.currentTarget.selectionStart)

  return (
    <div className="composer">
      {attachments.length > 0 && (
        <div className="attachments">
          {attachments.map((a) => (
            <span key={a.id} className="chip">
              <img src={`data:${a.mediaType};base64,${a.data}`} alt="" />
              {a.name}
              <button onClick={() => setAttachments((list) => list.filter((x) => x.id !== a.id))}>
                ✕
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="composer-input">
        {suggestions.length > 0 && (
          <Autocomplete items={suggestions} cursor={cursor} onPick={pick} />
        )}
        <textarea
          ref={box}
          value={text}
          placeholder={
            busy ? 'Queue a message…' : `Message the agent in ${session.title}…`
          }
          onChange={(e) => {
            setText(e.target.value)
            setCaret(e.target.selectionStart)
            e.target.style.height = 'auto'
            e.target.style.height = `${Math.min(e.target.scrollHeight, 220)}px`
          }}
          onClick={syncCaret}
          onSelect={syncCaret}
          onPaste={(e) => {
            const imgs = Array.from(e.clipboardData.files).filter((f) =>
              ACCEPTED.includes(f.type as ImageMediaType),
            )
            if (!imgs.length) return
            e.preventDefault() // or the filename lands in the textarea too
            addFiles(imgs)
          }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            if (!e.dataTransfer.files.length) return
            e.preventDefault()
            addFiles(e.dataTransfer.files)
          }}
          onKeyDown={(e) => {
            if (suggestions.length) {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setCursor((c) => Math.min(c + 1, suggestions.length - 1))
                return
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault()
                setCursor((c) => Math.max(c - 1, 0))
                return
              }
              // Enter completes rather than sends while the popover is open —
              // otherwise picking a file would fire off a half-typed message.
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault()
                pick(suggestions[cursor])
                return
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                setCaret(-1) // closes the popover without touching the text
                return
              }
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
        />
      </div>

      <div className="composer-row">
        <select
          className="select"
          value={session.permissionMode}
          onChange={(e) =>
            void window.foreman.setPermissionMode(session.id, e.target.value as PermissionMode)
          }
          title="Permission mode"
        >
          {MODES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>

        <select
          className="select"
          // Aliases ('opus', '') don't equal the running wire id, so match on
          // resolvedModel and fall back to showing the raw id.
          value={
            (models.find((m) => m.resolvedModel === session.model) ??
              (session.model
                ? models.find((m) => bareModel(m.resolvedModel) === bareModel(session.model))
                : models.find((m) => m.id === 'default')))?.id ?? CURRENT
          }
          onChange={(e) => {
            if (e.target.value !== CURRENT) void window.foreman.setModel(session.id, e.target.value)
          }}
          title="Model"
        >
          {!models.some(
            (m) => bareModel(m.resolvedModel) === bareModel(session.model),
          ) && <option value={CURRENT}>{session.model ?? 'Loading…'}</option>}
          {models.map((m) => (
            <option key={m.displayName} value={m.id}>
              {m.displayName}
            </option>
          ))}
        </select>

        <span className="spacer" />

        <span className="cost">
          ${session.costUsd.toFixed(4)} · {session.inputTokens + session.outputTokens} tok
        </span>

        {/* Send stays available while running: the queue holds the message and
            the transcript shows it as cancellable until the agent picks it up. */}
        {busy && (
          <button
            className="btn"
            data-variant="danger"
            onClick={() => void window.foreman.interrupt(session.id)}
          >
            Stop
          </button>
        )}
        <button
          className="btn"
          data-variant="primary"
          onClick={submit}
          disabled={!text.trim() && attachments.length === 0}
        >
          {busy ? 'Queue' : 'Send'}
        </button>
      </div>
    </div>
  )
}
