import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Cog,
  Gauge,
  GitBranch,
  ListPlus,
  SendHorizontal,
  SendToBack,
  ShieldCheck,
  Sparkles,
  Square,
  X,
} from 'lucide-react'
import type {
  EffortLevel,
  ImageMediaType,
  ModelInfo,
  PermissionMode,
  SendBlock,
  SessionMeta,
  SlashCommandInfo,
} from '../../../shared/types'
import type { EditorView } from '@codemirror/view'
import { useStore } from '../store'
import { filterEntries, triggerAt } from '../derive.mts'
import Autocomplete, { type Suggestion } from './Autocomplete'
import MarkdownInput from './MarkdownInput'

/** Sentinel for "whatever the session is already running" when no alias matches. */
const CURRENT = '__current__'

/** Mirrors ImageMediaType; anything else is silently not attachable. */
const ACCEPTED: readonly ImageMediaType[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

/** null = leave the SDK's own default alone. 'max' is session-scoped.
 *  Values are the SDK's EffortLevel strings; only the labels are ours. */
export const EFFORTS: { value: EffortLevel | ''; label: string }[] = [
  { value: '', label: 'Auto' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
  { value: 'max', label: 'Max' },
]

/** Cap on suggestions rendered at once — a 4000-file repo must not build 4000 rows. */
const MAX_SUGGESTIONS = 50

/** Drop a trailing context-window suffix: 'claude-opus-5[1m]' -> 'claude-opus-5'.
 *  Exported so the empty chat state resolves a display name the same way the
 *  model picker below does. */
export const bareModel = (id: string | null | undefined): string =>
  (id ?? '').replace(/\[[^\]]*\]$/, '')

/**
 * A model row that names its version: `Default (recommended) · claude-opus-5`.
 *
 * `displayName` alone hides which model you are actually on — worst of all for
 * the 'default' row, whose whole content is the word "Default". `resolvedModel`
 * is the canonical wire id the alias expands to and already crosses the bridge,
 * so the version is free; the `[1m]` context suffix is dropped because it is a
 * window size, not a version.
 */
export const modelLabel = (m: ModelInfo): string => {
  const wire = bareModel(m.resolvedModel)
  return wire ? `${m.displayName} · ${wire}` : m.displayName
}

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
  const close = useStore((s) => s.close)
  const openPath = useStore((s) => s.openPath)
  // Only for the picker's pre-first-turn fallback: the session was created with
  // this model, but meta.model stays null until an assistant message reports one.
  const prefs = useStore((s) => s.prefs)
  /** Nothing said yet, so the session can still be recreated somewhere else. */
  const fresh = useStore((s) => (s.items[session.id]?.length ?? 0) === 0)
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [caret, setCaret] = useState(0)
  const [cursor, setCursor] = useState(0)
  const [commands, setCommands] = useState<SlashCommandInfo[]>([])
  const [files, setFiles] = useState<string[]>([])
  const box = useRef<EditorView | null>(null)

  const busy = session.status === 'running' || session.status === 'awaiting-approval'
  /** Nothing to send. Drives both the disabled state and its tooltip. */
  const empty = !text.trim() && attachments.length === 0

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

  /** Showing the predicted next prompt as an overlay on the empty input. */
  const ghost = !text && !busy && session.promptSuggestion

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
    // The editor syncs both from props; it just needs the focus back, since the
    // click that picked the suggestion took it.
    requestAnimationFrame(() => box.current?.focus())
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

  /**
   * Move this session into its own worktree.
   *
   * A session's cwd is decided by createSession and never changes, so "switch to
   * a worktree" is really close-and-reopen. Safe only while nothing has been
   * said yet, which is exactly when the toggle is offered.
   *
   * The branch name is derived rather than prompted: the rail's existing flow
   * asks for one, but a checkbox that opens a text field isn't a checkbox.
   * `startBranch` bails on empty and `branchSlug('')` would make a degenerate
   * ref, so this must never pass a blank.
   */
  const goWorktree = async (): Promise<void> => {
    if (!fresh || session.worktree) return
    // Not a worktree yet, so cwd is the project directory — the right base.
    const base = session.cwd
    const name = session.title?.trim() || `session-${Date.now().toString(36)}`
    await close(session.id)
    await openPath(base, name)
  }

  /** Accepting the predicted prompt has to move the caret too, or it lands at 0. */
  const acceptGhost = (): void => {
    const s = session.promptSuggestion ?? ''
    setText(s)
    setCaret(s.length)
    box.current?.focus()
  }

  return (
    <div className="composer">
      {attachments.length > 0 && (
        <div className="attachments">
          {attachments.map((a) => (
            <span key={a.id} className="chip">
              <img src={`data:${a.mediaType};base64,${a.data}`} alt="" />
              {a.name}
              <button
                data-tip={`Remove ${a.name}`}
                data-tip-start=""
                aria-label={`Remove ${a.name}`}
                onClick={() => setAttachments((list) => list.filter((x) => x.id !== a.id))}
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="composer-input">
        {/* Ghost text for the predicted next prompt. Only while the box is
            empty and idle — overlaying a suggestion on real typing is noise. */}
        {ghost && (
          <button
            className="ghost"
            data-tip="Predicted next prompt — Tab to use"
            data-tip-start=""
            onClick={acceptGhost}
          >
            {session.promptSuggestion}
          </button>
        )}
        {suggestions.length > 0 && (
          <Autocomplete items={suggestions} cursor={cursor} onPick={pick} />
        )}
        <MarkdownInput
          viewRef={box}
          value={text}
          caret={caret}
          // The ghost is an overlay on this same box, so leaving the
          // placeholder on paints the two strings on top of each other.
          placeholder={
            ghost ? '' : busy ? 'Queue a message…' : `Message the agent in ${session.title}…`
          }
          // One channel for both, because in CodeMirror a caret move and an edit
          // arrive as the same update — and `triggerAt` needs the pair in step.
          onChange={(next, pos) => {
            setText(next)
            setCaret(pos)
          }}
          onPaste={(e) => {
            const imgs = Array.from(e.clipboardData?.files ?? []).filter((f) =>
              ACCEPTED.includes(f.type as ImageMediaType),
            )
            if (!imgs.length) return
            e.preventDefault() // or the filename lands in the editor too
            addFiles(imgs)
          }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            if (!e.dataTransfer?.files.length) return
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
            if (e.key === 'Tab' && !text && session.promptSuggestion) {
              e.preventDefault()
              acceptGhost()
              return
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
        />
      </div>

      {/* Not just "three boxes are here": each chip carries the rolling AI
          progress summary the SDK emits on task_progress, so backgrounded work
          is watchable instead of opaque. The full summary is in the tooltip,
          since a chip only has room for one line of it. */}
      {session.backgroundTasks.length > 0 && (
        <div className="bg-tray">
          {session.backgroundTasks.map((t) => (
            <span
              key={t.taskId}
              className="chip bg-task"
              title={t.description}
              data-tip={
                [t.progress, t.lastTool && `last: ${t.lastTool}`].filter(Boolean).join('\n') ||
                'Running — no progress reported yet'
              }
              data-tip-start=""
            >
              <Cog size={12} className="bg-spin" />
              <span className="bg-desc">{t.description || t.taskType}</span>
              {t.progress && <span className="bg-progress">{t.progress}</span>}
              {t.tokens ? <span className="bg-tok">{Math.round(t.tokens / 1000)}k</span> : null}
              <button
                aria-label="Stop this background task"
                onClick={() => void window.foreman.stopTask(session.id, t.taskId)}
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="composer-row">
        {/* Each select gets a glyph, because three unlabelled dropdowns say
            nothing about what they control. A native <select> can't hold an
            icon, so the glyph is a sibling and the select is padded to clear
            it — see `.ctl` in theme.css. */}
        <label className="ctl" data-tip="Permission mode — how much the agent may do without asking">
          <ShieldCheck size={12} />
          <select
            className="select"
            aria-label="Permission mode"
            value={session.permissionMode}
            onChange={(e) =>
              void window.foreman.setPermissionMode(session.id, e.target.value as PermissionMode)
            }
          >
            {MODES.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </label>

        <label className="ctl" data-tip="Model">
          <Sparkles size={12} />
          <select
            className="select"
            aria-label="Model"
            // Aliases ('opus', '') don't equal the running wire id, so match on
            // resolvedModel. Before the first turn there is no wire id at all,
            // so fall back to the row for the user's configured default — which
            // is what this session was actually created with.
            value={
              (models.find((m) => m.resolvedModel === session.model) ??
                (session.model
                  ? models.find((m) => bareModel(m.resolvedModel) === bareModel(session.model))
                  : models.find((m) => m.id === (prefs.model || 'default'))))?.id ?? CURRENT
            }
            onChange={(e) => {
              if (e.target.value !== CURRENT)
                void window.foreman.setModel(session.id, e.target.value)
            }}
          >
            {!models.some(
              (m) => bareModel(m.resolvedModel) === bareModel(session.model),
            ) && <option value={CURRENT}>{session.model ?? 'Loading…'}</option>}
            {models.map((m) => (
              <option key={m.displayName} value={m.id}>
                {modelLabel(m)}
              </option>
            ))}
          </select>
        </label>

        <label className="ctl" data-tip="Reasoning effort — how long the model thinks before answering">
          <Gauge size={12} />
          <select
            className="select"
            aria-label="Reasoning effort"
            value={session.effort ?? ''}
            onChange={(e) => void window.foreman.setEffort(session.id, e.target.value || null)}
          >
            {EFFORTS.map((x) => (
              <option key={x.value} value={x.value}>
                {x.label}
              </option>
            ))}
          </select>
        </label>

        {/* A session's cwd is fixed when it's created, so this is only a live
            choice on an untouched tab — after that it's a read-only chip saying
            where you ended up. Ticking it recreates the session in a worktree,
            through the same openPath the rail's branch button already uses. */}
        {session.worktree ? (
          <span className="wt-chip" title={`Isolated in ${session.worktree.repoRoot}`}>
            <GitBranch size={12} />
            {session.worktree.branch}
          </span>
        ) : (
          <label
            className="wt-toggle"
            data-off={fresh ? undefined : ''}
            title={
              fresh
                ? 'Run this session in its own git worktree, on its own branch'
                : 'Only available before the first message — a session cannot change directory'
            }
          >
            <input
              type="checkbox"
              checked={false}
              disabled={!fresh}
              onChange={() => void goWorktree()}
            />
            worktree
          </label>
        )}

        <span className="spacer" />

        {/* Always on, including while busy: the per-turn "done · $0.0231" rows
            are gone from the transcript, so this is now the only place a running
            cost appears. Two decimals — cents are the unit anyone actually reads,
            and a sub-cent turn showing $0.00 is the accepted trade. */}
        <span className="cost">
          ${session.costUsd.toFixed(2)} · {session.inputTokens + session.outputTokens} tok
        </span>

        {/* Send stays available while running: the queue holds the message and
            the transcript shows it as cancellable until the agent picks it up. */}
        {busy && (
          <>
            {/* Moves in-flight Bash/subagent work to the background so the turn
                continues instead of blocking on a long command. */}
            <button
              className="btn"
              data-tip="Run in-flight work in the background, so the turn continues"
              data-tip-end=""
              aria-label="Run in-flight work in the background"
              onClick={() => void window.foreman.backgroundTasks(session.id)}
            >
              <SendToBack size={14} />
            </button>
            {/* A red square is the most universally-read control glyph there is,
                and it only exists while running, so its context is unambiguous. */}
            <button
              className="btn"
              data-variant="danger"
              data-tip="Stop the agent  Esc"
              data-tip-end=""
              aria-label="Stop the agent"
              onClick={() => void window.foreman.interrupt(session.id)}
            >
              <Square size={14} />
            </button>
          </>
        )}
        {/* Icon-only: this is the core loop, bound to ⏎ and pressed hundreds of
            times a session — the two glyphs read the state better than the two
            words did, and the word was pure chrome. */}
        <button
          className="btn"
          data-variant="primary"
          onClick={submit}
          disabled={empty}
          data-tip={
            empty
              ? 'Type a message first'
              : busy
                ? 'Queue this message — the agent picks it up when the turn ends  ⏎'
                : 'Send  ⏎'
          }
          data-tip-end=""
          aria-label={busy ? 'Queue this message' : 'Send'}
        >
          {busy ? <ListPlus size={14} /> : <SendHorizontal size={14} />}
        </button>
      </div>
    </div>
  )
}
