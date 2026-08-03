import type { AccountInfo, ContextUsage, RateWindow, UsageInfo } from '../../../../shared/types'
import { fmt, level, swatch, type ContextView } from '../../derive.mts'

/**
 * When a rate-limit window comes back around.
 *
 * Weekday and local time, nothing else. `resetsAt` is an ISO instant, but what
 * it answers is "how long am I throttled for" — a horizon, not a timestamp — and
 * seconds, the date and the year are all noise against that question. Anything
 * further out than six days would be ambiguous, but these windows are five-hour
 * and weekly, so it cannot happen.
 *
 * Returns null rather than throwing on a malformed instant: the panel would
 * rather drop one dim line than blank the tab.
 */
function resetLine(windows: readonly RateWindow[]): string | null {
  const parts: string[] = []
  for (const w of windows) {
    if (!w.resetsAt) continue
    const d = new Date(w.resetsAt)
    if (Number.isNaN(d.getTime())) continue
    const day = d.toLocaleDateString(undefined, { weekday: 'short' })
    const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    parts.push(`${w.label} resets ${day} ${time}`)
  }
  return parts.length ? parts.join(' · ') : null
}

/**
 * What this session is holding and what it is costing.
 *
 * These two were separate sections in the flat panel and are one tab now,
 * because they answer the same question at two scales — how much room is left,
 * and how much of the account's allowance is left. Neither is a list, so
 * neither needed a tab of its own.
 */
export default function OverviewTab({
  view,
  context: ctx,
  account,
  usage,
}: {
  /**
   * The reconciled reading — the same one the composer's ring draws, so the two
   * cannot disagree about how full the window is.
   */
  view: ContextView | null
  /**
   * The raw poll, alongside it. This tab is the only view that shows the model
   * name, the memory files and the deferred groups' own figures, none of which
   * survive the reduction to a ContextView.
   */
  context: ContextUsage | null
  account: AccountInfo | null
  usage: UsageInfo | null
}): React.JSX.Element {
  const resets = usage ? resetLine(usage.windows) : null

  return (
    <>
      <div className="sect-head">
        <span>Context</span>
      </div>

      {/* TWO GATES, not one, and the split is by what each thing actually
          needs. The bar and the figures need `view`, which is null when nothing
          in the breakdown occupies the window — all deferred, all filler. The
          model name and the memory files need only the raw poll, and hiding
          them behind "not measured" because the BAR had nothing to draw would
          be the tab claiming ignorance of something it was just told.

          "Send a message first" was wrong about the reason and therefore about
          the remedy: the window is not sized until the first REQUEST, so a
          resumed session with a full transcript reads the same way until it
          takes a turn. Say what is missing instead of naming an action. */}
      {!ctx ? (
        <p className="sect-empty">Not measured yet — the window is sized on the first request.</p>
      ) : (
        <>
          {view ? (
            <>
              <div className="ctx-bar">
                {view.used.map((c, i) => (
                  <span
                    key={c.name}
                    style={{
                      width: `${(c.tokens / view.max) * 100}%`,
                      background: swatch(i),
                    }}
                    title={`${c.name}: ${fmt(c.tokens)}`}
                  />
                ))}
                {/* Growth since the last poll — see ContextCard for why this is
                    hatched rather than coloured, and why the bar would otherwise
                    stop short of where the ring's arc ends. */}
                {view.unattributed > 0 && (
                  <span
                    className="ctx-card-est"
                    style={{ width: `${(view.unattributed / view.max) * 100}%` }}
                  />
                )}
              </div>
              {/* Percentage derived from the same tokens the bar is drawn from.
                  The SDK's own `percentage` is rounded differently (it reported
                  2.0 for a 2.39% window) and a readout that disagrees with the
                  bar beside it reads as a bug. `~` while the figure is the live
                  estimate. */}
              <p className="sect-sub">
                {view.estimated ? '~' : ''}
                {fmt(view.tokens)} / {fmt(view.max)} · {view.pct.toFixed(1)}% · {ctx.model}
              </p>
              <ul className="kv">
                {view.used.map((c, i) => (
                  <li key={c.name}>
                    <i className="ctx-dot" style={{ background: swatch(i) }} />
                    <span>{c.name}</span>
                    <b>{fmt(c.tokens)}</b>
                  </li>
                ))}
                {view.unattributed > 0 && (
                  <li className="kv-muted">
                    <i className="ctx-dot ctx-card-est" />
                    <span>Since last refresh</span>
                    <b>~{fmt(view.unattributed)}</b>
                  </li>
                )}
                {/* Loadable on demand, and deliberately NOT in the bar: the SDK
                    excludes these from totalTokens, so drawing them would
                    overstate what the window is actually holding. */}
                {view.deferred.map((c) => (
                  <li key={c.name} className="kv-muted">
                    <i className="ctx-dot" style={{ background: 'rgb(var(--text-faint))' }} />
                    <span>{c.name}</span>
                    <b>{fmt(c.tokens)}</b>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            /* Polled, parsed, and nothing in it occupies the window — the guard
               in contextView. There is no bar to draw and no honest percentage
               to print, but the model is still worth saying. */
            <p className="sect-sub">{ctx.model} · nothing in the window yet</p>
          )}
          {ctx.memoryFiles.length > 0 && (
            <ul className="kv">
              {ctx.memoryFiles.map((f) => (
                <li key={f.path} title={f.path}>
                  <span className="kv-path">{f.path}</span>
                  <b>{fmt(f.tokens)}</b>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <div className="sect-head">
        <span>Account &amp; usage</span>
      </div>
      {!account && !usage ? (
        <p className="sect-empty">Unavailable.</p>
      ) : (
        <ul className="kv">
          {account?.email && (
            <li>
              <span>Account</span>
              <b>{account.email}</b>
            </li>
          )}
          {account?.organization && (
            <li>
              <span>Org</span>
              <b>{account.organization}</b>
            </li>
          )}
          {(usage?.subscriptionType ?? account?.subscriptionType) && (
            <li>
              <span>Plan</span>
              <b>{usage?.subscriptionType ?? account?.subscriptionType}</b>
            </li>
          )}
          {usage && (
            <li>
              <span>Session</span>
              <b>
                ${usage.costUsd.toFixed(2)} · +{usage.linesAdded}/−{usage.linesRemoved}
              </b>
            </li>
          )}
          {usage && !usage.rateLimitsAvailable && (
            <li>
              <span>Limits</span>
              <b>n/a for this auth</b>
            </li>
          )}
        </ul>
      )}

      {usage?.windows.map((w) => (
        <div key={w.label} className="meter">
          <span className="meter-label">{w.label}</span>
          <span className="meter-track">
            {/* Same `level` the context ring uses, so a near-full meter and a
                near-full ring can never disagree about what counts as nearly
                full. A meter that stayed accent-white at 99% was the whole
                reason this is here. */}
            <i
              data-level={level(w.utilization ?? 0)}
              style={{ width: `${Math.min(w.utilization ?? 0, 100)}%` }}
            />
          </span>
          <span className="meter-val">
            {w.utilization === null ? '—' : `${Math.round(w.utilization)}%`}
          </span>
        </div>
      ))}
      {resets && <p className="sect-sub">{resets}</p>}
    </>
  )
}
