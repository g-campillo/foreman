import type { AccountInfo, ContextUsage, RateWindow, UsageInfo } from '../../../../shared/types'
import { contextBreakdown, fmt, level, swatch } from '../../derive.mts'

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
  context: ctx,
  account,
  usage,
}: {
  context: ContextUsage | null
  account: AccountInfo | null
  usage: UsageInfo | null
}): React.JSX.Element {
  const { used, deferred } = contextBreakdown(
    ctx?.categories ?? [],
    ctx?.totalTokens ?? 0,
    ctx?.maxTokens ?? 0,
  )
  const resets = usage ? resetLine(usage.windows) : null

  return (
    <>
      <div className="sect-head">
        <span>Context</span>
      </div>

      {!ctx ? (
        <p className="sect-empty">Unavailable — send a message first.</p>
      ) : (
        <>
          <div className="ctx-bar">
            {used.map((c, i) => (
              <span
                key={c.name}
                style={{
                  width: `${(c.tokens / Math.max(ctx.maxTokens, 1)) * 100}%`,
                  background: swatch(i),
                }}
                title={`${c.name}: ${fmt(c.tokens)}`}
              />
            ))}
          </div>
          {/* Percentage derived from the same tokens the bar is drawn from. The
              SDK's own `percentage` is rounded differently (it reported 2.0 for
              a 2.39% window) and a readout that disagrees with the bar beside it
              reads as a bug. */}
          <p className="sect-sub">
            {fmt(ctx.totalTokens)} / {fmt(ctx.maxTokens)} ·{' '}
            {((ctx.totalTokens / Math.max(ctx.maxTokens, 1)) * 100).toFixed(1)}% · {ctx.model}
          </p>
          <ul className="kv">
            {used.map((c, i) => (
              <li key={c.name}>
                <i className="ctx-dot" style={{ background: swatch(i) }} />
                <span>{c.name}</span>
                <b>{fmt(c.tokens)}</b>
              </li>
            ))}
            {/* Loadable on demand, and deliberately NOT in the bar: the SDK
                excludes these from totalTokens, so drawing them would overstate
                what the window is actually holding. */}
            {deferred.map((c) => (
              <li key={c.name} className="kv-muted">
                <i className="ctx-dot" style={{ background: 'rgb(var(--text-faint))' }} />
                <span>{c.name}</span>
                <b>{fmt(c.tokens)}</b>
              </li>
            ))}
          </ul>
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
