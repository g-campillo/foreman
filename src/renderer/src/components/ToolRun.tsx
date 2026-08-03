import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import type { Row } from '../derive.mts'
import { runSummary, summarise, toolVerb } from '../derive.mts'
import { atBottom } from './ScrollDown'

/**
 * Whether the rows being rendered are inside a COLLAPSED run.
 *
 * A collapsed run does not drop its rows, it hides them — see ToolRun — and the
 * `hidden` attribute has to land on the `[data-item-id]` wrapper, which
 * Conversation's `RowItem` owns. A context rather than a prop because ToolRun is
 * handed those rows already rendered (again, see ToolRun), so it has nothing to
 * pass a prop to; and `false` is the right default for every row that is not in
 * a run at all — a turn's lead, its tail, an assistant sentence between calls.
 */
export const FoldedContext = createContext(false)

/**
 * The row the editor's gutter asked for, as the ids of the things that have to
 * be open for it to exist in the DOM.
 *
 * A context rather than a prop, because the row's own ancestors are `Rows` and
 * `Item`, neither of which has any business knowing about a reveal — threading
 * it through both would put a parameter on two components that never read it.
 * `Turn` and `ToolRun` each compare their own id and open themselves.
 *
 * Declared HERE and imported by Conversation rather than the other way round,
 * which would be the natural direction: Conversation already imports this
 * module, so declaring it there would make the pair a cycle for the sake of one
 * constant.
 */
export const RevealContext = createContext<{
  turnId: string
  /** null when the row is not inside a run — a turn's tail, say. */
  runId: string | null
} | null>(null)

/**
 * A run of consecutive tool calls, folded to one line.
 *
 * `12 steps · 5 reads, 4 commands, 3 brain calls  +40 −12  1 failed ⌄`, and
 * under it the call in flight. ALWAYS COLLAPSED, including while the turn is
 * still streaming, which is the point: a turn routinely emits twenty of these
 * rows between one sentence of commentary and the next, and the chat pane
 * becomes a log you scroll rather than a conversation you read.
 *
 * The two objections that got tool-run folding deleted the first time are
 * answered rather than waved away — see transcriptRows in derive.mts for both
 * halves. Two of the answers live here. `open` is one-way: once the user opens a
 * run by hand it stays open for the life of that node. And a COLLAPSED RUN HIDES
 * ITS ROWS RATHER THAN DROPPING THEM, which is what protects the state inside
 * them the one time the fold closes without being asked — see the Provider at
 * the bottom of the render.
 *
 * The rows come in as `children` rather than being mapped here. They are
 * rendered by Conversation's `Rows`, because each one needs `Item` — and `Item`
 * lives in Conversation, so mapping them here would make the two modules a
 * cycle. A Fragment, not a wrapper, for the same reason `Turn` uses one: the
 * `[data-item-id]` wrappers have to stay direct `.convo` children or the
 * `.convo > [data-item-id]` rules stop applying.
 */
export default function ToolRun({
  id,
  rows,
  cwd,
  children,
}: {
  /** The run's id, which is its first row's item id. Matches RevealContext. */
  id: string
  rows: readonly Row[]
  /** Session working directory, for shortening the live line's path. */
  cwd: string
  children: React.ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(false)

  const reveal = useContext(RevealContext)
  const forceOpen = reveal?.runId === id
  // Same shape as Turn's `latest` effect, and deliberately one-way: a reveal
  // opens a run, and nothing ever closes one.
  useEffect(() => {
    if (forceOpen) setOpen(true)
  }, [forceOpen])

  const sum = useMemo(() => runSummary(rows), [rows])

  // A lone call is its own summary. The node still EXISTS at n = 1 — see
  // groupRuns for why that is not an accident — it just wears no head, so the
  // row underneath renders exactly as it always did.
  const folds = rows.length >= 2

  // Remaining CALLS, not remaining kinds, so the arithmetic against `N steps`
  // adds up for whoever reads the line. runSummary has already capped and
  // ordered `groups`; the cut is its decision, not a rendering one, because
  // which five survive has to be checkable.
  const more = sum.steps - sum.groups.reduce((n, g) => n + g.n, 0)

  /* The head's second line. The verb carries the tense — Cursor ships no
     spinner on any of this — and the rolling progress replaces the argument
     when the tool has one, exactly as it does on the row itself. */
  const live = sum.live
  const liveItem = live?.item.kind === 'tool' ? live.item : null
  const liveText = liveItem
    ? [
        toolVerb(liveItem.name, true),
        liveItem.progress || summarise(liveItem.name, liveItem.input, cwd),
      ]
        .filter(Boolean)
        .join(' ')
    : ''

  /* Expanding twenty rows adds a few hundred pixels below the fold, so a
     transcript that was sitting at the bottom is suddenly no longer there —
     and nothing else will put it back, because the autoscroll effect watches
     `items` and no item changed. Only when the user was already following;
     scrolling someone who had deliberately scrolled back is the one thing
     autoscroll must never do. Measured from the DOM before the toggle, which is
     what `pinned` means anyway. */
  const toggle = (e: React.MouseEvent<HTMLButtonElement>): void => {
    const el = e.currentTarget.closest('.convo')
    const following = el instanceof HTMLElement && atBottom(el)
    setOpen((v) => !v)
    if (el instanceof HTMLElement && following)
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight
      })
  }

  return (
    <>
      {/* Head and live line share a wrapper, and the wrapper is skipped entirely
          when there is no head: `.tool-status` is designed as a child of the
          zero-gap `.tool` column, and as a bare `.convo` child it would inherit
          --convo-gap and float away from the line it belongs to. An empty one
          would collect that gap on both sides for nothing. */}
      {folds && (
        <div className="run">
          <button
            className="run-head"
            aria-expanded={open}
            data-failed={sum.failed > 0 ? '' : undefined}
            onClick={toggle}
          >
            {sum.steps} steps
            {sum.groups.length > 0 && (
              <span className="run-groups">
                · {sum.groups.map((g) => `${g.n} ${g.label}`).join(', ')}
                {more > 0 && ` +${more} more`}
              </span>
            )}
            {/* The only colour the transcript has, summed across the run rather
                than hidden with the rows that produced it. */}
            {(sum.added > 0 || sum.removed > 0) && (
              <span className="diff-stat">
                {sum.added > 0 && <span className="a">+{sum.added}</span>}
                {sum.removed > 0 && <span className="d">−{sum.removed}</span>}
              </span>
            )}
            {/* A failure is the one outcome that must survive the fold. */}
            {sum.failed > 0 && <span className="run-failed">{sum.failed} failed</span>}
            <ChevronDown size={12} className="run-chevron" />
          </button>
          {liveText && <div className="tool-status">{liveText}</div>}
        </div>
      )}

      {/* HIDDEN, NEVER DROPPED. `{open && children}` would unmount every row on
          collapse, and the collapse that matters is the one nobody asks for:
          a lone row has no head, so it renders open, and the moment a second
          call lands it acquires a head and folds. Unmounting there destroys
          ToolLine's `open`/`allLines` state — the diff the user opened 400ms
          ago vanishes while they are reading it, which is precisely the
          objection this whole feature had to answer.

          React preserves state across a `hidden` toggle because the element
          never leaves the tree, so this covers the 1→2 transition and every
          later fold alike. React state is the WHOLE of what it buys: a
          `display: none` element generates no principal box, which unsets
          `contain-intrinsic-size: auto`'s remembered size just as unmounting
          would, so unfolding still lays every row out from the guess in
          theme.css. The cost is bounded: a folded TURN never renders `Rows` at
          all, so hidden rows only ever exist inside a turn that is open. */}
      <FoldedContext.Provider value={folds && !open}>{children}</FoldedContext.Provider>
    </>
  )
}
