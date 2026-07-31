import { useCallback, useEffect, useState } from 'react'
import { PlugZap, Power, RefreshCw, RotateCcw } from 'lucide-react'
import type {
  AccountInfo,
  AgentInfo,
  ContextUsage,
  McpServerInfo,
  SessionMeta,
  SkillInfo,
  UsageInfo,
} from '../../../shared/types'
import { contextBreakdown, fmt } from '../derive.mts'

/** Our own palette, because the SDK's `color` is a CLI theme key, not CSS.
 *  All theme tokens, so the breakdown flips with light/dark like everything else.
 *
 *  ORDER IS THE POINT. Categories are assigned by index, so neighbours in this
 *  list are neighbours in the legend and in the bar — and --warn next to
 *  --syn-num next to --syn-fn put three oranges in a row, which at a 9px swatch
 *  and a 4px bar segment is one colour. Interleaved so consecutive entries
 *  always jump hue, the way Cursor's grey/purple/green/amber/mauve/blue/salmon
 *  does. This is the only categorical palette in the app; everywhere else is one
 *  hue at varying alpha. */
const SWATCHES = [
  'rgb(var(--accent))',
  'rgb(var(--syn-key))',
  'rgb(var(--ok))',
  'rgb(var(--warn))',
  'rgb(var(--syn-str))',
  'rgb(var(--syn-type))',
  'rgb(var(--danger))',
]
export const swatch = (i: number): string => SWATCHES[i % SWATCHES.length]

interface Data {
  context: ContextUsage | null
  account: AccountInfo | null
  usage: UsageInfo | null
  mcp: McpServerInfo[]
  agents: AgentInfo[]
}

/**
 * The read-only side of the session: what's in the context window, what the
 * account is spending, which MCP servers are up, and which agents exist.
 *
 * One panel rather than four, because every one of these is a handful of rows
 * that nobody wants a separate tab for.
 */
export default function SessionPanel({
  session,
  visible,
}: {
  session: SessionMeta
  visible: boolean
}): React.JSX.Element {
  const [data, setData] = useState<Data | null>(null)
  const [skills, setSkills] = useState<SkillInfo[] | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    setBusy(true)
    const f = window.foreman
    // One round of calls, in parallel — a slow MCP status shouldn't hold up the
    // context meter, which is the reason most people open this panel.
    const [context, account, usage, mcp, agents] = await Promise.all([
      f.contextUsage(session.id).catch(() => null),
      f.accountInfo(session.id).catch(() => null),
      f.usageInfo(session.id).catch(() => null),
      f.mcpStatus(session.id).catch(() => []),
      f.supportedAgents(session.id).catch(() => []),
    ])
    setData({ context, account, usage, mcp, agents })
    setBusy(false)
  }, [session.id])

  // Refresh when the panel is actually on screen and the agent isn't mid-turn —
  // context usage is only meaningful between turns, and polling a running
  // session just races the numbers.
  useEffect(() => {
    if (visible && session.status === 'idle') void refresh()
  }, [visible, session.status, refresh])

  if (!visible) return <></>

  const ctx = data?.context
  const { used, deferred } = contextBreakdown(
    ctx?.categories ?? [],
    ctx?.totalTokens ?? 0,
    ctx?.maxTokens ?? 0,
  )
  return (
    <div className="panel-scroll">
      <div className="sect-head">
        <span>Context</span>
        {/* The busy state is `:disabled` (opacity .4) rather than a "Refreshing…"
            word — there's no room for one beside a 12px glyph. */}
        {/* data-tip on the wrapper: a disabled control fires no pointer events,
            and this tip exists precisely to explain the disabled state. */}
        <span className="tw" data-tip="Refresh — context usage is only meaningful between turns">
          <button
            className="code-btn"
            onClick={() => void refresh()}
            disabled={busy}
            aria-label="Refresh"
          >
            <RefreshCw size={12} />
          </button>
        </span>
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
      {!data?.account && !data?.usage ? (
        <p className="sect-empty">Unavailable.</p>
      ) : (
        <ul className="kv">
          {data.account?.email && (
            <li>
              <span>Account</span>
              <b>{data.account.email}</b>
            </li>
          )}
          {data.account?.organization && (
            <li>
              <span>Org</span>
              <b>{data.account.organization}</b>
            </li>
          )}
          {(data.usage?.subscriptionType ?? data.account?.subscriptionType) && (
            <li>
              <span>Plan</span>
              <b>{data.usage?.subscriptionType ?? data.account?.subscriptionType}</b>
            </li>
          )}
          {data.usage && (
            <li>
              <span>Session</span>
              <b>
                ${data.usage.costUsd.toFixed(2)} · +{data.usage.linesAdded}/−
                {data.usage.linesRemoved}
              </b>
            </li>
          )}
          {data.usage && !data.usage.rateLimitsAvailable && (
            <li>
              <span>Limits</span>
              <b>n/a for this auth</b>
            </li>
          )}
        </ul>
      )}

      {data?.usage?.windows.map((w) => (
        <div key={w.label} className="meter">
          <span className="meter-label">{w.label}</span>
          <span className="meter-track">
            <i style={{ width: `${Math.min(w.utilization ?? 0, 100)}%` }} />
          </span>
          <span className="meter-val">
            {w.utilization === null ? '—' : `${Math.round(w.utilization)}%`}
          </span>
        </div>
      ))}

      <div className="sect-head">
        <span>MCP servers</span>
      </div>
      {!data?.mcp.length ? (
        <p className="sect-empty">None configured.</p>
      ) : (
        <ul className="kv">
          {data.mcp.map((srv) => (
            <li key={srv.name} title={srv.error}>
              <i className="mcp-dot" data-status={srv.status} />
              <span>{srv.name}</span>
              <b>{srv.status === 'connected' ? `${srv.toolCount} tools` : srv.status}</b>
              <span className="mcp-acts">
                <button
                  className="code-btn"
                  data-tip={srv.status === 'disabled' ? 'Enable this server' : 'Disable this server'}
                  aria-label={
                    srv.status === 'disabled' ? 'Enable this server' : 'Disable this server'
                  }
                  onClick={() =>
                    void window.foreman
                      .toggleMcp(session.id, srv.name, srv.status === 'disabled')
                      .then(refresh)
                  }
                >
                  <Power size={12} />
                </button>
                <button
                  className="code-btn"
                  data-tip="Reconnect this server"
                  aria-label="Reconnect"
                  onClick={() => void window.foreman.reconnectMcp(session.id, srv.name).then(refresh)}
                >
                  <PlugZap size={12} />
                </button>
                {/* Tighten-only by construction — the SDK's override can restrict
                    a server's permission handling but never widen it. */}
                <select
                  className="code-btn"
                  defaultValue=""
                  data-tip="Permission override — can restrict this server, never widen it"
                  onChange={(e) =>
                    void window.foreman.setMcpPermissionOverride(
                      session.id,
                      srv.name,
                      e.target.value || null,
                    )
                  }
                >
                  <option value="">inherit</option>
                  <option value="default">ask</option>
                  <option value="auto">auto</option>
                </select>
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="sect-head">
        <span>Agents &amp; skills</span>
        <button
          className="code-btn"
          data-tip="Reload skills — the SDK has no read-only listing, so this is how you see them"
          aria-label="Reload skills"
          onClick={() => void window.foreman.reloadSkills(session.id).then(setSkills)}
        >
          <RotateCcw size={12} />
        </button>
      </div>
      {!data?.agents.length ? (
        <p className="sect-empty">None available.</p>
      ) : (
        <ul className="kv">
          {data.agents.map((a) => (
            <li key={a.name} title={a.description}>
              <span>{a.name}</span>
              <b>{a.model ?? 'inherits'}</b>
            </li>
          ))}
        </ul>
      )}
      {skills && (
        <ul className="kv">
          {skills.length === 0 && <li><span>No skills found</span></li>}
          {skills.map((s) => (
            <li key={s.name} title={s.description}>
              <span className="kv-path">{s.name}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
