import { useMemo, useState } from 'react'
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
 * No new plumbing: TodoWrite calls already flow through as tool items, so this
 * reads the newest one straight out of the store instead of being buried in
 * scrollback.
 */
export default function TodoStrip({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const items = useStore((s) => s.items[sessionId] ?? EMPTY)
  const [open, setOpen] = useState(false)

  // Scans the transcript backwards, so memoise on the array identity rather than
  // re-deriving on every unrelated store change.
  const todos = useMemo(() => latestTodos(items), [items])
  if (!todos) return null

  const done = todos.filter((t) => t.status === 'completed').length
  const current = todos.find((t) => t.status === 'in_progress')

  return (
    <div className="todos" data-open={open ? '' : undefined}>
      <button className="todos-head" onClick={() => setOpen((v) => !v)}>
        <span className="todos-count">
          {done}/{todos.length}
        </span>
        <span className="todos-now">
          {current ? (current.activeForm ?? current.content) : 'Plan'}
        </span>
        <span className="todos-chev">
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
      </button>

      {open && (
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
