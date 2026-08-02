import { useCallback, useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import type {
  AccountInfo,
  AgentInfo,
  ContextUsage,
  McpStatus,
  SessionMeta,
  UsageInfo,
} from '../../../shared/types'
import AgentsTab from './session/AgentsTab'
import McpTab from './session/McpTab'
import OverviewTab from './session/OverviewTab'

type SubTab = 'overview' | 'mcp' | 'agents'

/** Key order is the tab order, the same contract App.tsx's PANEL_LABEL has. */
const LABEL: Record<SubTab, string> = {
  overview: 'Overview',
  mcp: 'MCP',
  agents: 'Agents',
}

interface Data {
  context: ContextUsage | null
  account: AccountInfo | null
  usage: UsageInfo | null
  mcp: McpStatus
  agents: AgentInfo[]
}

/**
 * The read-only side of the session: what's in the context window, what the
 * account is spending, which MCP servers are up, and what the agent can call.
 *
 * Three tabs rather than one scroll. The flat version worked while every
 * section was a handful of rows, and stopped the moment plugins arrived — ~47
 * agents and ~62 skills under a heading two screens down is not a section, it
 * is a landfill. Overview keeps context and account together because they are
 * both meters about this session; the two lists that grow without bound get
 * their own space.
 *
 * This file is the shell only: the fetch, the tab state, and the strip. Each
 * tab's contents live in ./session/.
 */
export default function SessionPanel({
  session,
  visible,
}: {
  session: SessionMeta
  visible: boolean
}): React.JSX.Element {
  const [data, setData] = useState<Data | null>(null)
  const [busy, setBusy] = useState(false)
  /* Local, not persisted. The Appearance whitelist in store.ts is deliberately
     narrow and a sub-tab does not earn a slot in it; the panel stays mounted for
     the app's lifetime anyway, so the choice already survives every dock switch
     that isn't a restart. */
  const [tab, setTab] = useState<SubTab>('overview')
  /* Per-server permission override, keyed by server name.

     It lives up here rather than in McpTab for two reasons, both of which are
     the ORIGINAL bug wearing a different hat. The SDK gives us no way to read an
     override back, so whoever holds it is the only record of it — and McpTab is
     mounted only while its tab is selected, so holding it there means one click
     on Overview resets every picker to "inherit" while the override it set is
     still in force. That is exactly what the old uncontrolled <select> did.

     Cleared on session change because SessionPanel is NOT keyed by session in
     App.tsx: without this, session A's override label shows against session B's
     identically-named server, and these names come from shared project config,
     so a collision is the normal case rather than a corner one. */
  const [overrides, setOverrides] = useState<Record<string, string>>({})
  useEffect(() => setOverrides({}), [session.id])

  const refresh = useCallback(async (): Promise<void> => {
    setBusy(true)
    const f = window.foreman
    // One round of calls, in parallel — a slow MCP status shouldn't hold up the
    // context meter, which is the reason most people open this panel. Still one
    // batch rather than one per tab: fetching per-tab would leave the Overview
    // numbers stale for exactly as long as you'd been reading another tab.
    const [context, account, usage, mcp, agents] = await Promise.all([
      f.contextUsage(session.id).catch(() => null),
      f.accountInfo(session.id).catch(() => null),
      f.usageInfo(session.id).catch(() => null),
      f.mcpStatus(session.id).catch(() => ({ servers: [], staleEnv: false })),
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

  /* `null` until the fetch lands, not 0. A tab reading "MCP 0" for the second
     it takes to answer is a claim that there are none, and it is wrong far more
     often than it is right. */
  const counts: Record<SubTab, number | null> = {
    overview: null,
    mcp: data ? data.mcp.servers.length : null,
    agents: data ? data.agents.length : null,
  }
  return (
    <div className="session-panel">
      <div className="stabs">
        <div className="stabs-seg">
          {(Object.keys(LABEL) as SubTab[]).map((t) => (
            <button
              key={t}
              className="stab"
              data-active={tab === t}
              aria-pressed={tab === t}
              onClick={() => setTab(t)}
            >
              {LABEL[t]}
              {counts[t] !== null && <span className="stab-n">{counts[t]}</span>}
            </button>
          ))}
        </div>
        {/* Panel-level now rather than living in the Context heading: with tabs,
            a refresh that reloads one section is a refresh you cannot reach from
            the other two — and MCP, the tab most likely to need one, never had
            it at all.

            The busy state is `:disabled` (opacity .4) rather than a "Refreshing…"
            word — there's no room for one beside a 12px glyph. data-tip sits on
            the wrapper because a disabled control fires no pointer events, and
            this tip exists precisely to explain the disabled state. */}
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

      <div className="panel-scroll">
        {tab === 'overview' && (
          <OverviewTab
            context={data?.context ?? null}
            account={data?.account ?? null}
            usage={data?.usage ?? null}
          />
        )}
        {tab === 'mcp' && (
          <McpTab
            sessionId={session.id}
            servers={data?.mcp.servers ?? []}
            staleEnv={data?.mcp.staleEnv ?? false}
            overrides={overrides}
            onOverride={(server, value) => setOverrides((m) => ({ ...m, [server]: value }))}
            onChanged={() => void refresh()}
          />
        )}
        {/* Mounted only while selected, which is what makes the skills reload
            happen per visit — for this tab, mounting IS activation. The other
            two are cheap to re-render and hold nothing worth preserving, so
            none of the three needs the always-mounted treatment App.tsx gives
            the dock panels themselves. */}
        {tab === 'agents' && <AgentsTab sessionId={session.id} agents={data?.agents ?? null} />}
      </div>
    </div>
  )
}
