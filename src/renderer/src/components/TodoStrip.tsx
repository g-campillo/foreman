import { useMemo } from 'react'
import { ChevronDown, ChevronRight, Square, SquareCheck, SquareDot } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useStore } from '../store'
import { latestTodos, todoWindow, type TodoStatus } from '../derive.mts'

const EMPTY: never[] = []

/** Components, not glyphs. The per-status colour still comes from the
 *  `.todos-list li[data-status]` rules — lucide strokes with currentColor.
 *
 *  SQUARES, as the CLI draws them: a checklist is a set of boxes you tick, and
 *  the circles this used to draw read as radio buttons, i.e. as a choice of one.
 *  `SquareCheck` rather than `SquareCheckBig` — the "Big" tick overshoots the
 *  square's top-right corner, so a completed row would sit visually higher than
 *  the pending ones beside it in a `width: 1em` column. */
const MARK: Record<TodoStatus, LucideIcon> = {
  completed: SquareCheck,
  in_progress: SquareDot,
  pending: Square,
}

/**
 * The agent's current plan, between the transcript and the composer.
 *
 * No new plumbing on the renderer side: the plan is folded out of the TaskCreate
 * and TaskUpdate cards already in the store (see `latestTodos`), so this reads
 * it instead of leaving it buried in scrollback.
 *
 * What was missing was upstream. Nothing ever ASKED the agent for tasks, so
 * across every project directory on this machine TaskCreate fired 0 times in a
 * Foreman session — a finished feature with no input. `CHECKLIST` in
 * main/agent/plan.ts is what feeds it.
 *
 * COLLAPSED BY DEFAULT, AND THE FOLD IS IN THE STORE. This used to auto-expand
 * while a turn ran, with a local `overridden` flag to stop that fighting a
 * deliberate collapse, and a local `forSession` to reset the flag when the one
 * unkeyed instance of this component changed session. All three are gone: a
 * strip that opens itself is a strip that moves the composer under the user's
 * cursor mid-sentence, and a per-session fold in the store IS the reset. See
 * `todoFold`.
 *
 * The `--todos-h` ResizeObserver is gone with the position: the strip is a flex
 * sibling below `.convo` now, so it takes its height from the transcript rather
 * than pushing the whole pane down, and `.dock-entries` no longer has to offset
 * itself around it.
 */
export default function TodoStrip({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const items = useStore((s) => s.items[sessionId] ?? EMPTY)
  const fold = useStore((s) => s.todoFold[sessionId])
  const setTodoFold = useStore((s) => s.setTodoFold)

  // Scans the transcript backwards, so memoise on the array identity rather than
  // re-deriving on every unrelated store change.
  const todos = useMemo(() => latestTodos(items), [items])
  // Always the WINDOWED view, whatever the fold, and before the early return
  // because hooks may not be conditional. `full` renders every row instead of
  // this one's slice — but it still needs `win.summary` to decide whether the
  // collapse control exists at all, and asking todoWindow for an unbounded
  // window would answer "nothing is hidden", which is true and useless.
  const win = useMemo(() => todoWindow(todos ?? EMPTY), [todos])

  if (!todos) return null

  const done = todos.filter((t) => t.status === 'completed').length
  const current = todos.find((t) => t.status === 'in_progress')
  const finished = done === todos.length
  const open = fold !== undefined
  const full = fold === 'full'
  const rows = full ? todos : win.visible

  return (
    <div className="todos" data-done={finished ? '' : undefined}>
      {/* ABOUT THE WHOLE PLAN, always, and deliberately not about the window:
          `3/8` and the live step mean the same thing open or closed, so the head
          does not change its subject when the body appears under it. */}
      <button className="todos-head" onClick={() => setTodoFold(sessionId, open ? null : 'window')}>
        <span className="todos-count">
          {done}/{todos.length}
        </span>
        {/* The completion frame this strip never had — it used to disappear at
            exactly this moment, which reads as a bug rather than as done. */}
        <span className="todos-now">
          {current ? (current.activeForm ?? current.content) : finished ? 'Plan complete' : 'Plan'}
        </span>
        <span className="todos-chev">
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
      </button>

      {open && (
        <>
          {/* `start` is SEMANTIC ONLY — `.todos-list` is `list-style: none`, so
              no marker is painted and nothing on screen is numbered at all. It
              is there for the accessibility tree: this is a slice of a longer
              list, and a screen reader announcing "item 1 of 5" over step 4 of a
              twelve-step plan is a worse lie than saying nothing, because it
              sounds like a fact. Keyed by `t.id` for the visible half of the
              same problem — see Todo.id. */}
          <ol className="todos-list" data-full={full ? '' : undefined} start={full ? 1 : win.start + 1}>
            {rows.map((t) => {
              const Mark = MARK[t.status]
              return (
                <li key={t.id} data-status={t.status}>
                  <span className="todos-mark">
                    <Mark size={12} />
                  </span>
                  {t.content}
                </li>
              )
            })}
          </ol>
          {/* OUTSIDE the <ol>, which is load-bearing rather than tidy: the full
              list scrolls at 30vh, and inside it "Collapse" would be reachable
              only by scrolling to the bottom of the thing it collapses. Same
              "Show all / Collapse" shape as a long code block — see Markdown. */}
          {win.summary !== null && (
            <button
              className="todos-more"
              onClick={() => setTodoFold(sessionId, full ? 'window' : 'full')}
            >
              {full ? 'Collapse' : win.summary}
            </button>
          )}
        </>
      )}
    </div>
  )
}
