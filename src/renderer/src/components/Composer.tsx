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
import ContextStrip from './ContextStrip'

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
 * The model a wire id names: `claude-opus-5[1m]` -> `Opus 5`,
 * `claude-haiku-4-5` -> `Haiku 4.5`, `claude-3-5-sonnet-20241022` -> `Sonnet 3.5`.
 *
 * Name and version, nothing else. The `[1m]` bracket is a window size rather
 * than a version, and how much window is left now has its own readout under the
 * composer — repeating it in every label was noise.
 *
 * Derived from the wire id rather than the SDK's `displayName` because the wire
 * id is what `SessionMeta.model` actually holds, so this answers "what am I
 * running" with no lookup into the model list.
 */
export const modelName = (id: string | null | undefined): string => {
  const parts = bareModel(id)
    .replace(/^claude-/, '')
    .split('-')
    .filter(Boolean)
  if (!parts.length) return ''
  // First non-numeric part is the name: dated ids put the version first
  // ('3-5-sonnet-…'), current ones put it last ('haiku-4-5').
  const name = parts.find((p) => !/^\d+$/.test(p)) ?? parts[0]
  // Five digits or more is a release datestamp, not a version component.
  const version = parts.filter((p) => /^\d{1,4}$/.test(p)).join('.')
  const cap = name[0].toUpperCase() + name.slice(1)
  return version ? `${cap} ${version}` : cap
}

/** The context-window bracket as a badge: `claude-opus-5[1m]` -> `1M`. */
const windowTag = (m: ModelInfo): string =>
  ((m.resolvedModel || m.id) ?? '').match(/\[([^\]]+)\]$/)?.[1].toUpperCase() ?? ''

/** A displayName without its parenthetical: `Opus 5 (1M context)` -> `Opus 5`. */
const plainName = (s: string): string => s.replace(/\s*\([^)]*\)\s*$/, '').trim()

/**
 * Labels for every picker row, computed over the whole list — because two
 * <option>s that render identically are indistinguishable, and uniqueness is not
 * a property any single row can see.
 *
 * The base label is `modelName(resolvedModel)`, so a row is spelled exactly the
 * way the context strip spells the running model. Two exceptions:
 *
 *  - When the SDK's own name says something the wire id cannot — the
 *    `Default (recommended)` row, whose alias resolves to some other model — it
 *    is kept as a prefix. Stripping it would leave Default rendering as a bare
 *    `Opus 5` that both collides with the real Opus row and loses the one word
 *    identifying it. The test is mechanical: if the SDK's name already names the
 *    model, it adds nothing.
 *  - When two rows still collapse — `Opus 5` and `Opus 5 (1M context)` both name
 *    Opus 5 — the colliding rows get the window tag back. Only the colliding
 *    ones: tagging unconditionally would re-add the suffix this exists to remove.
 */
export const modelLabels = (all: readonly ModelInfo[]): string[] => {
  const base = all.map((m) => {
    const name = modelName(m.resolvedModel)
    if (!name) return m.displayName || m.id
    const own = plainName(m.displayName)
    // Containment, not equality: the alias rows are named 'Opus'/'Haiku', which
    // an equality test treats as new information and renders 'Opus · Opus 5'.
    // Only a name the derived one does NOT already contain is worth keeping —
    // in practice that is the 'Default' row, whose whole identity is that word.
    return name.toLowerCase().includes(own.toLowerCase()) ? name : `${own} · ${name}`
  })
  const counts = new Map<string, number>()
  for (const b of base) counts.set(b, (counts.get(b) ?? 0) + 1)
  // Only the row that actually HAS a window gets tagged — the standard-window
  // twin stays bare, so a collision reads `Opus 5` / `Opus 5 · 1M` rather than
  // tagging both and inventing a distinction for the ordinary one.
  return base.map((b, i) =>
    (counts.get(b) ?? 0) > 1 && windowTag(all[i]) ? `${b} · ${windowTag(all[i])}` : b,
  )
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
  // Computed over the whole list rather than per row, because disambiguating a
  // collision means knowing what the other rows render as.
  const modelRows = useMemo(() => modelLabels(models), [models])
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
            {models.map((m, i) => (
              <option key={m.displayName} value={m.id}>
                {modelRows[i]}
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

        {/* The running cost used to sit here. It moved to ContextStrip below:
            it is a readout rather than a control, and this row had no width left
            for it. Two decimals there — cents are the unit anyone reads, and a
            sub-cent turn showing $0.00 is the accepted trade. */}

        {/* Send stays available while running: the queue holds the message and
            the transcript shows it as cancellable until the agent picks it up. */}
        {busy && (
          <>
            {/* Moves in-flight Bash/subagent work to the background so the turn
                continues instead of blocking on a long command. */}
            <button
              className="btn"
              data-tip="Run in-flight work in the background, so the turn continues"
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
        {/* data-tip rides on the wrapper, not the button: the button is disabled
            while `empty`, and a disabled control fires no pointer events, so the
            one tip that explains the disabled state would never appear. */}
        <span
          className="tw"
          data-tip={
            empty
              ? 'Type a message first'
              : busy
                ? 'Queue this message — the agent picks it up when the turn ends  ⏎'
                : 'Send  ⏎'
          }
        >
          <button
            className="btn"
            data-variant="primary"
            onClick={submit}
            disabled={empty}
            aria-label={busy ? 'Queue this message' : 'Send'}
          >
            {busy ? <ListPlus size={14} /> : <SendHorizontal size={14} />}
          </button>
        </span>
      </div>

      {/* Keyed: Composer is rendered unkeyed by App, so without this the strip's
          fetched context would survive a tab switch onto the wrong session. */}
      <ContextStrip key={session.id} session={session} />
    </div>
  )
}
