import { useEffect, useState } from 'react'
import type { ContextUsage, SessionMeta } from '../../../shared/types'
import { contextBreakdown, fmt } from '../derive.mts'
import { modelName } from './Composer'

/**
 * The line under the composer: which model, how much of its window is gone, and
 * what the session has cost so far.
 *
 * Lives here rather than in `.composer-row` because none of it is a control —
 * and that row had run out of width, which is why its own CSS marks the cost
 * readout as the first thing to drop on overflow.
 *
 * Mount it with `key={session.id}`. Conversation and Composer are rendered
 * unkeyed, so without a key this component's state would survive a tab switch
 * and paint one session's numbers under another's model name.
 */
export default function ContextStrip({ session }: { session: SessionMeta }): React.JSX.Element {
  const [ctx, setCtx] = useState<ContextUsage | null>(null)

  // Same policy as the session panel: context usage is only meaningful between
  // turns, and polling a running session just races the numbers.
  //
  // Unlike the panel, this strip is always on screen — so during a turn it keeps
  // showing the PREVIOUS turn's figures rather than blanking. Stale by one turn
  // is the honest reading; a bar that emptied every time you pressed send would
  // look like a bug, and the number that would replace it does not exist yet.
  useEffect(() => {
    if (session.status !== 'idle') return
    let live = true
    void window.foreman
      .contextUsage(session.id)
      .then((u) => {
        // `live && u`: on a transient null (session tearing down, SDK hiccup)
        // keep the last good reading. The panel can afford to blank because you
        // opened it deliberately; a permanent strip cannot.
        if (live && u) setCtx(u)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [session.id, session.status])

  const { used } = contextBreakdown(
    ctx?.categories ?? [],
    ctx?.totalTokens ?? 0,
    ctx?.maxTokens ?? 0,
  )
  // Drawn from the same figure the panel prints, so the two never disagree.
  // `used` exists only to prove the breakdown parsed; the SDK's own `percentage`
  // is rounded differently and would fight the bar beside it.
  const tokens = ctx?.totalTokens ?? 0
  const max = ctx?.maxTokens ?? 0
  const pct = max > 0 ? (tokens / max) * 100 : 0

  return (
    <div className="ctx-strip">
      {/* session.model is null until the first assistant message lands, but the
          context report names the model too — so the strip is labelled from the
          moment it has any numbers to show, rather than sitting blank. */}
      <span className="ctx-strip-model">{modelName(session.model ?? ctx?.model)}</span>
      {/* Guarded rather than clamped: with no known window, a bar drawn off
          Math.max(max, 1) would sit at 100% and assert something false. */}
      {max > 0 && used.length > 0 && (
        <>
          <span className="ctx-bar" title={`${fmt(tokens)} of ${fmt(max)} used`}>
            <span style={{ width: `${Math.min(pct, 100)}%`, background: barColour(pct) }} />
          </span>
          <span className="cost">
            {fmt(tokens)}/{fmt(max)} · {pct.toFixed(0)}%
          </span>
        </>
      )}
      <span className="spacer" />
      {/* Moved down out of .composer-row, but the reason it exists is unchanged:
          the per-turn "done · $0.0231" rows are gone from the transcript, so this
          is still the only place a running session cost appears. It is just no
          longer competing for width with three selects and three buttons. */}
      <span className="cost">
        ${session.costUsd.toFixed(2)} · {fmt(session.inputTokens + session.outputTokens)} tok
      </span>
    </div>
  )
}

/** Colour by pressure — past ~90% of the window the number stops being trivia. */
function barColour(pct: number): string {
  return `rgb(var(--${pct >= 90 ? 'danger' : pct >= 75 ? 'warn' : 'accent'}))`
}
