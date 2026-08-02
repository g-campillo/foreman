import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import type { ContextUsage, SessionMeta } from '../../../shared/types'
import { contextBreakdown, fmt, level, swatch, type ContextCategory } from '../derive.mts'

/** Ring geometry. 7px radius in an 18px box leaves room for a 2px stroke. */
const R = 7
const CIRC = 2 * Math.PI * R

export interface ContextView {
  tokens: number
  max: number
  pct: number
  /** Categories that actually occupy the window, filler and deferred removed. */
  used: ContextCategory[]
}

/**
 * This session's context pressure, polled.
 *
 * A hook rather than state inside the ring, because the ring and the card it
 * opens are siblings — the ring sits under the composer and the card floats
 * above it, so neither can own the fetch for the other.
 *
 * Same policy the session panel uses: context usage is only meaningful between
 * turns, and polling a running session just races the numbers. Unlike the panel
 * this is always mounted, so during a turn it keeps showing the PREVIOUS turn's
 * figure rather than blanking — stale by one turn is the honest reading, and a
 * gauge that emptied every time you pressed send would look like a bug.
 */
export function useContextUsage(session: SessionMeta): ContextView | null {
  const [ctx, setCtx] = useState<ContextUsage | null>(null)

  useEffect(() => {
    if (session.status !== 'idle') return
    let live = true
    void window.foreman
      .contextUsage(session.id)
      .then((u) => {
        // `live && u`: on a transient null (session tearing down, SDK hiccup)
        // keep the last good reading.
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
  const tokens = ctx?.totalTokens ?? 0
  const max = ctx?.maxTokens ?? 0

  // Nothing to draw. A ring against an unknown window would either sit empty and
  // assert "plenty left" or, drawn off Math.max(max, 1), sit full and assert the
  // opposite. `used` proves the breakdown parsed — the same guard the panel uses.
  if (max <= 0 || used.length === 0) return null
  return { tokens, max, pct: (tokens / max) * 100, used }
}

/**
 * Context pressure as a ring, and the button that opens its breakdown.
 *
 * Replaces ContextStrip, which spelled the same figures out as a labelled bar at
 * the foot of the rail. Cursor puts this next to the composer as a bare 20px
 * circle: a gauge you glance at, beside the thing consuming the window.
 */
export function ContextRing({
  usage,
  open,
  onToggle,
}: {
  usage: ContextView
  open: boolean
  onToggle: () => void
}): React.JSX.Element {
  const pct = usage.pct
  return (
    <button
      className="ctx-ring"
      data-level={level(pct)}
      data-open={open ? '' : undefined}
      aria-expanded={open}
      aria-label={`Context ${pct.toFixed(0)}% used`}
      /* Cursor's own wording and split: the percentage as a sentence on the
         first line, the raw fraction underneath. What was here before —
         "Context: 51k of 1M used · 5%" plus a session-cost line — said the same
         thing twice on one line and then added something the hover was not
         asked about. Cost is in the card. */
      data-tip={`${pct.toFixed(0)}% context used\n${fmt(usage.tokens)} / ${fmt(usage.max)} tokens`}
      onClick={onToggle}
    >
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
        <circle className="ctx-ring-track" cx="9" cy="9" r={R} />
        {/* Rotated so the arc starts at twelve o'clock rather than three. */}
        <circle
          className="ctx-ring-val"
          cx="9"
          cy="9"
          r={R}
          transform="rotate(-90 9 9)"
          strokeDasharray={`${(Math.min(pct, 100) / 100) * CIRC} ${CIRC}`}
        />
      </svg>
    </button>
  )
}

/**
 * The breakdown, as a card above the composer.
 *
 * Cursor opens this from the ring and floats it in the composer's tray slot at
 * the full width of the composer — not as an anchored menu. Same content the
 * session panel has always carried, at a size that does not need a panel: one
 * segmented bar, then a row per category.
 *
 * Colours come from `derive.mts`'s `swatch`, deliberately, so the two views can
 * never disagree about which band is which — it is the one place in the app with
 * a categorical palette rather than the single-hue chrome.
 */
export function ContextCard({
  usage,
  costUsd,
  onClose,
}: {
  usage: ContextView
  costUsd: number
  onClose: () => void
}): React.JSX.Element {
  return (
    <div className="ctx-card">
      <div className="ctx-card-head">
        <span>Context usage</span>
        <span className="spacer" />
        {/* The one figure Cursor has no equivalent for — they bill by request,
            Foreman by token. It rides here rather than in the ring's hover,
            which Cursor keeps to the two context lines. */}
        <span className="ctx-card-cost">${costUsd.toFixed(2)}</span>
        <button className="ctx-card-close" aria-label="Close" onClick={onClose}>
          <X size={12} />
        </button>
      </div>

      <div className="ctx-card-stats">
        <span>{usage.pct.toFixed(0)}% full</span>
        <span className="spacer" />
        <span className="ctx-card-tokens">
          ~{fmt(usage.tokens)} / {fmt(usage.max)} tokens
        </span>
      </div>

      {/* Segments sized against the WINDOW, not against each other, so the bar
          fills to the same fraction the ring shows. The remainder is the track
          showing through. */}
      <div className="ctx-card-bar" data-level={level(usage.pct)}>
        {usage.used.map((c, i) => (
          <span
            key={c.name}
            style={{ width: `${(c.tokens / usage.max) * 100}%`, background: swatch(i) }}
          />
        ))}
      </div>

      <ul className="ctx-card-list">
        {usage.used.map((c, i) => (
          <li key={c.name}>
            <i style={{ background: swatch(i) }} />
            <span className="ctx-card-name">{c.name}</span>
            <span className="ctx-card-n">{fmt(c.tokens)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
