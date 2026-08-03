import { X } from 'lucide-react'
import { fmt, level, swatch, type ContextView } from '../derive.mts'

/** Ring geometry. 7px radius in an 18px box leaves room for a 2px stroke. */
const R = 7
const CIRC = 2 * Math.PI * R

/* The `useContextUsage` hook lived here, and the `ContextView` type with it.
   Both moved out: the hook to ../useContextUsage.ts, because the session panel
   needs the same reading and a panel importing a hook out of a composer leaf is
   backwards; the type to derive.mts, because reconciling the poll with the live
   estimate is a pure derivation with a rule in it worth checking, and this file
   is a `.tsx` that `npm run check:derive` cannot load. */

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
      /* Dims the arc while the figure behind it is the per-request estimate
         rather than a measured breakdown. The ring MOVES mid-turn now, which is
         the whole point of the change — so it has to be able to say which of its
         two sources it is drawing, or a number that walks while you watch reads
         as a number nobody stands behind. */
      data-estimated={usage.estimated ? '' : undefined}
      aria-expanded={open}
      aria-label={`Context ${pct.toFixed(0)}% used`}
      /* Cursor's own wording and split: the percentage as a sentence on the
         first line, the raw fraction underneath. What was here before —
         "Context: 51k of 1M used · 5%" plus a session-cost line — said the same
         thing twice on one line and then added something the hover was not
         asked about. Cost is in the card. The third line only appears when
         there is something to disclose. */
      data-tip={[
        `${pct.toFixed(0)}% context used`,
        `${usage.estimated ? '~' : ''}${fmt(usage.tokens)} / ${fmt(usage.max)} tokens`,
        usage.estimated ? 'Estimated from the last request' : null,
      ]
        .filter(Boolean)
        .join('\n')}
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
        {/* The tilde is GATED, like the ring's and the panel's. It used to be
            hardcoded, from when this figure was always a poll away from current;
            now that a settled reading really is measured, an unconditional `~`
            says "approximately" about an exact number, and says nothing at all
            in the one case it is meant for. */}
        <span className="ctx-card-tokens">
          {usage.estimated ? '~' : ''}
          {fmt(usage.tokens)} / {fmt(usage.max)} tokens
        </span>
      </div>

      {/* Segments sized against the WINDOW, not against each other, so the bar
          fills to the same fraction the ring shows. The remainder is the track
          showing through.

          The hatched tail is what keeps that promise while a turn is running.
          The categories come from the last poll and the total comes from the
          live estimate, so without it the bar would stop short of where the arc
          ends — two views of one number, visibly disagreeing. It is hatched
          rather than coloured because nothing has measured what is in it. */}
      <div className="ctx-card-bar" data-level={level(usage.pct)}>
        {usage.used.map((c, i) => (
          <span
            key={c.name}
            style={{ width: `${(c.tokens / usage.max) * 100}%`, background: swatch(i) }}
          />
        ))}
        {usage.unattributed > 0 && (
          <span
            className="ctx-card-est"
            style={{ width: `${(usage.unattributed / usage.max) * 100}%` }}
          />
        )}
      </div>

      <ul className="ctx-card-list">
        {usage.used.map((c, i) => (
          <li key={c.name}>
            <i style={{ background: swatch(i) }} />
            <span className="ctx-card-name">{c.name}</span>
            <span className="ctx-card-n">{fmt(c.tokens)}</span>
          </li>
        ))}
        {/* Named rather than left as an unexplained band in the bar. It is one
            row and it is always the last one, because it is by construction
            whatever the breakdown could not account for. */}
        {usage.unattributed > 0 && (
          <li className="ctx-card-muted">
            <i className="ctx-card-est" />
            <span className="ctx-card-name">Since last refresh</span>
            <span className="ctx-card-n">~{fmt(usage.unattributed)}</span>
          </li>
        )}
      </ul>
    </div>
  )
}
