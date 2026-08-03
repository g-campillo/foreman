import { useEffect, useState } from 'react'
import { Cog, Eye, Square, X } from 'lucide-react'
import type { BackgroundTask, SessionMeta } from '../../../shared/types'
import { fmt, hms } from '../derive.mts'
import { useStore } from '../store'

/** One second, the same cadence the transcript's status line ticks at. */
const TICK_MS = 1000

/**
 * How long a task has been running, paused time removed.
 *
 * `pausedMs` is subtracted rather than shown separately because the question the
 * clock answers is "how long has this been working", and a task parked behind an
 * approval was not working. Clamped at zero: `startedAt` can be a floor derived
 * from a ~30s-stale `duration_ms`, so the arithmetic can briefly go negative.
 *
 * CLAMPED TO `endedAt` at the other end. A finished task can sit in the tray for
 * a moment — its completion and the membership change are two streams with no
 * defined order — and a chip reading "completed" beside a clock still counting
 * up is a status line arguing with itself.
 */
const elapsedOf = (task: BackgroundTask, now: number): number =>
  Math.max(0, (task.endedAt ?? now) - task.startedAt - (task.pausedMs ?? 0))

/** What kind of work this is, in the words the SDK gave us for it. */
const kindOf = (task: BackgroundTask): string =>
  task.subagentType ?? task.workflowName ?? task.taskType

/**
 * Everything a chip can say about itself, as tooltip lines.
 *
 * COMPOSED FROM THINGS ALWAYS KNOWN, which is the whole fix. The old tip was
 * built from `summary` and `last_tool_name` alone — both of which arrive on
 * `task_progress`, i.e. up to 30 seconds after the task starts — so for the
 * first half-minute of every task the hover read "Running — no progress reported
 * yet", a dead-end string that made a live feature look broken. The kind, the
 * status, the clock and the token count are known from the start edge onwards,
 * so there is nothing left for that string to cover.
 */
function tipFor(task: BackgroundTask, now: number): string {
  return [
    `${kindOf(task)} · ${task.status ?? 'running'}`,
    // Past tense once the clock has stopped, or the line contradicts the status
    // directly above it.
    `${task.endedAt ? 'Ran for' : 'Running'} ${hms(elapsedOf(task, now))}`,
    [
      task.tokens ? `${fmt(task.tokens)} tokens` : null,
      task.toolUses ? `${task.toolUses} tool ${task.toolUses === 1 ? 'use' : 'uses'}` : null,
      task.lastTool ? `last: ${task.lastTool}` : null,
    ]
      .filter(Boolean)
      .join(' · '),
    task.progress,
    'Click for details',
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * The tray of live background tasks, under the composer.
 *
 * THE TICKER LIVES HERE, in its own component, for the reason Conversation's
 * `Working` does: a 1s interval in Composer would repaint the whole composer
 * every second — MarkdownInput, the autocomplete popover and every open picker
 * menu with it — to move two clock readings. Re-rendering a child never
 * re-renders its parent, so the cost stays inside this subtree.
 */
export function BackgroundTaskTray({
  session,
  openTask,
  onOpen,
}: {
  session: SessionMeta
  /** The task whose card is open, so the chip can show itself as pressed. */
  openTask: string | null
  onOpen: (taskId: string | null) => void
}): React.JSX.Element {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(id)
  }, [])

  return (
    <div className="bg-tray">
      {session.backgroundTasks.map((t) => (
        /* A DIV, not a button. The body opens the card and the ✕ stops the task,
           and a button inside a button is not markup a browser will keep — it
           silently reparents, and the ✕ ends up outside the chip. So the chip is
           a plain box holding two buttons.

           The native `title` that used to sit here is gone: the app's own
           tooltip already reads `data-tip`, and the two raced — the OS one
           appearing a second later, on top, saying less. */
        <div key={t.taskId} className="chip bg-task" data-open={openTask === t.taskId ? '' : undefined}>
          <button
            className="bg-body"
            data-tip={tipFor(t, now)}
            aria-label={`Background task: ${t.description || kindOf(t)}`}
            aria-expanded={openTask === t.taskId}
            onClick={() => onOpen(openTask === t.taskId ? null : t.taskId)}
          >
            <Cog size={12} className="bg-spin" />
            <span className="bg-desc">{t.description || t.taskType}</span>
            {t.progress && <span className="bg-progress">{t.progress}</span>}
            {/* The clock, which the chip never had. It is the one figure that
                exists from the first second, and "is this thing stuck?" is the
                question the tray is actually asked. */}
            <span className="bg-elapsed">{hms(elapsedOf(t, now))}</span>
            {t.tokens ? <span className="bg-tok">{fmt(t.tokens)}</span> : null}
          </button>
          <button
            className="bg-stop"
            data-tip="Stop this background task"
            aria-label="Stop this background task"
            onClick={() => void window.foreman.stopTask(session.id, t.taskId)}
          >
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  )
}

/**
 * One task, opened from its chip.
 *
 * Reuses `.ctx-card` rather than growing a second floating panel: it occupies
 * the same slot above the composer, at the same width, and two cards that looked
 * different in the one place only one of them can be would read as two features.
 *
 * The two actions are the point of it. A backgrounded subagent's live output is
 * ALREADY nested under its Task card in the transcript — it has been the whole
 * time — and there was simply no way to get to it from the chip; "Show in
 * transcript" is that path, reusing the store's existing scroll/flash/unfold.
 */
export function BackgroundTaskCard({
  session,
  task,
  onClose,
}: {
  session: SessionMeta
  task: BackgroundTask
  onClose: () => void
}): React.JSX.Element {
  const revealItem = useStore((s) => s.revealItem)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(id)
  }, [])

  const stats: [string, string][] = [
    ['Kind', kindOf(task)],
    ['Status', task.status ?? 'running'],
    ['Elapsed', hms(elapsedOf(task, now))],
    ...(task.pausedMs ? ([['Paused', hms(task.pausedMs)]] as [string, string][]) : []),
    ...(task.tokens ? ([['Tokens', fmt(task.tokens)]] as [string, string][]) : []),
    ...(task.toolUses ? ([['Tool uses', String(task.toolUses)]] as [string, string][]) : []),
    ...(task.lastTool ? ([['Last tool', task.lastTool]] as [string, string][]) : []),
  ]

  return (
    <div className="ctx-card">
      <div className="ctx-card-head">
        <Cog size={12} className="bg-spin" />
        {/* Untruncated, unlike the chip's copy — the card exists because 45% of
            a chip is not enough room for a subagent's own description of what
            it was asked to do. */}
        <span className="bg-card-title">{task.description || kindOf(task)}</span>
        <span className="spacer" />
        <button className="ctx-card-close" aria-label="Close" onClick={onClose}>
          <X size={12} />
        </button>
      </div>

      {task.progress && <p className="bg-card-progress">{task.progress}</p>}
      {task.error && <p className="bg-card-error">{task.error}</p>}

      <ul className="ctx-card-list">
        {stats.map(([label, value]) => (
          <li key={label}>
            <span className="ctx-card-name">{label}</span>
            <span className="ctx-card-n">{value}</span>
          </li>
        ))}
      </ul>

      <div className="bg-card-actions">
        {/* data-tip on the wrapper, not the button: a disabled control fires no
            pointer events, and this tip exists precisely to explain the disabled
            state — an ambient (skip_transcript) task has no card to show, which
            is otherwise a button that looks broken. */}
        <span
          className="tw"
          data-tip={
            task.itemId
              ? 'Scroll to this task in the conversation'
              : 'This task has no transcript card — it runs outside the conversation'
          }
        >
          <button
            className="btn"
            disabled={!task.itemId}
            onClick={() => {
              if (task.itemId) revealItem(task.itemId)
              onClose()
            }}
          >
            <Eye size={14} />
            Show in transcript
          </button>
        </span>
        <span className="spacer" />
        <button
          className="btn"
          data-variant="danger"
          onClick={() => {
            void window.foreman.stopTask(session.id, task.taskId)
            onClose()
          }}
        >
          <Square size={14} />
          Stop
        </button>
      </div>
    </div>
  )
}
