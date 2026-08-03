import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Circle, CircleCheck, CircleDot } from 'lucide-react'
import { useStore } from '../store'
import { latestTodos } from '../derive.mts'

const EMPTY: never[] = []

/** Components, not glyphs. The per-status colour still comes from the
 *  `.todos-list li[data-status]` rules — lucide strokes with currentColor. */
const MARK = {
  completed: CircleCheck,
  in_progress: CircleDot,
  pending: Circle,
} as const

/**
 * The agent's current plan, pinned above the transcript.
 *
 * No new plumbing on the renderer side: the plan is folded out of the TaskCreate
 * and TaskUpdate cards already in the store (see `latestTodos`), so this reads
 * it instead of leaving it buried in scrollback.
 *
 * What was missing was upstream. Nothing ever ASKED the agent for tasks, so
 * across every project directory on this machine TaskCreate fired 0 times in a
 * Foreman session — a finished feature with no input. `CHECKLIST` in
 * main/agent/plan.ts is what feeds it.
 */
export default function TodoStrip({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const items = useStore((s) => s.items[sessionId] ?? EMPTY)
  const running = useStore((s) => s.sessions.find((x) => x.id === sessionId)?.status === 'running')
  const [open, setOpen] = useState(false)
  /**
   * Set the first time the user touches the chevron. From then on the manual
   * state is authoritative — an auto-expand that fights a deliberate collapse is
   * a control that does not work.
   *
   * STATE, NOT A REF, and the difference is the whole control. Collapsing an
   * auto-expanded strip computes `setOpen(false)` over an `open` that is already
   * false — React's eager-state path sees no change and does not re-render, so a
   * ref flipped alongside it would take effect only when something else happened
   * to repaint. During a quiet stretch of a running turn nothing does, and the
   * chevron simply did nothing.
   */
  const [overridden, setOverridden] = useState(false)

  /* App renders ONE unkeyed <TodoStrip>, so without this a fold in session A
     would arrive as a fold in session B — and the auto-expand, which is the
     whole point of `overridden`, would be suppressed for a plan the user has
     never seen. Adjusted DURING RENDER rather than in an effect, which is
     React's own answer for state derived from a prop: an effect would paint one
     frame of the wrong fold first. */
  const [forSession, setForSession] = useState(sessionId)
  if (forSession !== sessionId) {
    setForSession(sessionId)
    setOverridden(false)
  }

  // Scans the transcript backwards, so memoise on the array identity rather than
  // re-deriving on every unrelated store change.
  const todos = useMemo(() => latestTodos(items), [items])

  const host = useRef<HTMLDivElement>(null)
  /* Cached rather than re-derived on cleanup: by the time this strip has no plan
     left to show it renders null, so `host.current` is already gone and there is
     nothing left to walk up from to clear the property. */
  const pane = useRef<HTMLElement | null>(null)
  /**
   * Publish this strip's height so `.dock-entries` can sit below it.
   *
   * That list is absolutely positioned against `.pane-fill` at a FIXED top of
   * one titlebar, so it was laid out as though this strip did not exist and the
   * `Changes` row landed on top of the band. CSS alone cannot fix it: an
   * absolutely positioned box has no way to ask how tall an earlier sibling is,
   * and a constant would be wrong in one state or the other — the strip is ~32px
   * collapsed and up to 30vh open. So measure, and let the dock offset itself.
   *
   * Keyed on presence, not on the fold: the observer already reports the open
   * and close, so re-running the effect for them would only rebuild it to learn
   * what it was about to report anyway.
   */
  const present = todos !== null
  useEffect(() => {
    const el = host.current
    if (!el) {
      pane.current?.style.removeProperty('--todos-h')
      return
    }
    pane.current = el.parentElement
    const ro = new ResizeObserver(([entry]) => {
      pane.current?.style.setProperty(
        '--todos-h',
        `${entry.target.getBoundingClientRect().height}px`,
      )
    })
    ro.observe(el)
    return () => {
      ro.disconnect()
      pane.current?.style.removeProperty('--todos-h')
    }
  }, [present])

  if (!todos) return null

  const done = todos.filter((t) => t.status === 'completed').length
  const current = todos.find((t) => t.status === 'in_progress')
  // DERIVED rather than an effect writing `open`, so there is one writer of this
  // fact: open while there is live work in the plan, collapsed once it is done.
  // The rows are what the strip is for, and a checklist you have to click to see
  // is a checklist nobody sees.
  const finished = done === todos.length
  const shown = overridden ? open : running && !finished

  return (
    <div
      className="todos"
      ref={host}
      data-open={shown ? '' : undefined}
      data-done={finished ? '' : undefined}
    >
      <button
        className="todos-head"
        onClick={() => {
          setOverridden(true)
          setOpen(!shown)
        }}
      >
        <span className="todos-count">
          {done}/{todos.length}
        </span>
        {/* The completion frame this strip never had — it used to disappear at
            exactly this moment, which reads as a bug rather than as done. */}
        <span className="todos-now">
          {current ? (current.activeForm ?? current.content) : finished ? 'Plan complete' : 'Plan'}
        </span>
        <span className="todos-chev">
          {shown ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
      </button>

      {shown && (
        <ol className="todos-list">
          {todos.map((t, i) => {
            const Mark = MARK[t.status]
            return (
              <li key={i} data-status={t.status}>
                <span className="todos-mark">
                  <Mark size={12} />
                </span>
                {t.content}
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}
