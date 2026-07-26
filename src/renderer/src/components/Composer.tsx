import { useRef, useState } from 'react'
import type { PermissionMode, SessionMeta } from '../../../shared/types'
import { useStore } from '../store'

/** Sentinel for "whatever the session is already running" when no alias matches. */
const CURRENT = '__current__'

/** Drop a trailing context-window suffix: 'claude-opus-5[1m]' -> 'claude-opus-5'. */
const bareModel = (id: string | null | undefined): string => (id ?? '').replace(/\[[^\]]*\]$/, '')

const MODES: { value: PermissionMode; label: string }[] = [
  { value: 'default', label: 'Ask' },
  { value: 'acceptEdits', label: 'Accept edits' },
  { value: 'plan', label: 'Plan' },
  { value: 'bypassPermissions', label: 'Bypass' },
  { value: 'dontAsk', label: "Don't ask" },
]

export default function Composer({ session }: { session: SessionMeta }): React.JSX.Element {
  const send = useStore((s) => s.send)
  const models = useStore((s) => s.models)
  const [text, setText] = useState('')
  const box = useRef<HTMLTextAreaElement>(null)

  const busy = session.status === 'running' || session.status === 'awaiting-approval'
  // Two ways the picker used to fail to name what's running. Before the first
  // assistant message meta.model is null, because the system/init frame carries
  // no model — fall back to the 'default' row, which IS what the session runs
  // when nothing overrides it. After it, the wire id can drop the context suffix
  // the model list carries ('claude-opus-5' vs 'claude-opus-5[1m]'), so compare
  // without it rather than dumping the raw id in the dropdown.
  const matchedModel =
    models.find((m) => m.resolvedModel === session.model) ??
    (session.model
      ? models.find((m) => bareModel(m.resolvedModel) === bareModel(session.model))
      : models.find((m) => m.id === 'default'))

  const submit = (): void => {
    const t = text.trim()
    if (!t) return
    void send(t)
    setText('')
    if (box.current) box.current.style.height = 'auto'
  }

  return (
    <div className="composer">
      <textarea
        ref={box}
        value={text}
        placeholder={`Message the agent in ${session.title}…`}
        onChange={(e) => {
          setText(e.target.value)
          e.target.style.height = 'auto'
          e.target.style.height = `${Math.min(e.target.scrollHeight, 220)}px`
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            submit()
          }
        }}
      />

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
          value={matchedModel?.id ?? CURRENT}
          onChange={(e) => {
            if (e.target.value !== CURRENT) void window.foreman.setModel(session.id, e.target.value)
          }}
          title="Model"
        >
          {!matchedModel && (
            <option value={CURRENT}>{session.model ?? 'Loading…'}</option>
          )}
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

        {busy ? (
          <button
            className="btn"
            data-variant="danger"
            onClick={() => void window.foreman.interrupt(session.id)}
          >
            Stop
          </button>
        ) : (
          <button className="btn" data-variant="primary" onClick={submit} disabled={!text.trim()}>
            Send
          </button>
        )}
      </div>
    </div>
  )
}
