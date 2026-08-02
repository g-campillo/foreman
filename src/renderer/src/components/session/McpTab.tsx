import { useEffect, useState } from 'react'
import { PlugZap, Power } from 'lucide-react'
import type { McpServerInfo } from '../../../../shared/types'
import Picker from '../Picker'
import Row, { Pill } from './Row'

/** The SDK's override values, paired with what a human calls them. */
const OVERRIDES: { value: string; label: string }[] = [
  { value: '', label: 'inherit' },
  { value: 'default', label: 'ask' },
  { value: 'auto', label: 'auto' },
]

/** Status word and tone. `connected` is the only one that carries a number. */
function statusPill(srv: McpServerInfo): React.JSX.Element {
  switch (srv.status) {
    case 'connected':
      return <Pill>{srv.toolCount} tools</Pill>
    case 'failed':
      return <Pill tone="danger">failed</Pill>
    case 'needs-auth':
      return <Pill tone="warn">sign in</Pill>
    case 'pending':
      return <Pill>connecting</Pill>
    default:
      return <Pill>disabled</Pill>
  }
}

/**
 * `plugin:context7:context7` → `context7`, `plugin`.
 *
 * Plugin servers arrive named `plugin:<plugin>:<server>`, and the raw triple is
 * both the longest and the least informative string in the tab: it truncates to
 * `plugin:desktop-commander:desktop-c…`, which loses the only segment anyone
 * reads. Almost always the two segments are the same word, so the plugin name
 * collapses into the origin and the row reads as `desktop-commander  plugin`.
 * When they differ — one plugin shipping several servers — the origin carries
 * the plugin so the row is still traceable to it.
 *
 * The scope word is dropped for plugin rows on purpose: it is always `dynamic`
 * there, and `plugin` already says more than that does.
 *
 * Split on the first colon after the prefix only, so a server whose own name
 * contains a colon survives intact.
 */
function label(srv: McpServerInfo): { name: string; origin?: string } {
  const rest = srv.name.startsWith('plugin:') ? srv.name.slice('plugin:'.length) : null
  if (rest === null) return { name: srv.name, origin: srv.scope }

  const at = rest.indexOf(':')
  if (at === -1) return { name: rest, origin: 'plugin' }
  const plugin = rest.slice(0, at)
  const server = rest.slice(at + 1)
  return { name: server, origin: plugin === server ? 'plugin' : `plugin · ${plugin}` }
}

/**
 * The failure line, and the reason this row is allowed to be two lines high.
 *
 * A server that is down is the one thing in this panel you cannot afford to
 * hover to discover, and `error` was previously reachable only through a native
 * `title`. So it is spent inline — but only when something is actually wrong,
 * which is at most a row or two.
 *
 * The fallbacks matter: `error` is optional on the wire, and a red row with no
 * explanation is worse than the old tooltip.
 */
function failureText(srv: McpServerInfo): string | undefined {
  if (srv.status !== 'failed' && srv.status !== 'needs-auth') return undefined
  if (srv.error) return srv.error
  return srv.status === 'failed'
    ? 'Failed to start, and reported no error.'
    : 'Authentication required — reconnect to sign in.'
}

/**
 * Which MCP servers are up, and the three things you can do about one.
 *
 * The controls are always visible here rather than revealed on hover. That is
 * the opposite of the usual list-row treatment, and deliberate: there are about
 * four servers, so there is no clutter to hide, and an inert-looking list was
 * the reason this section read as unfinished. `.srow-acts` sits them at
 * --text-faint and brings them to --text-dim on row hover, which buys the same
 * calm without the disappearing act.
 */
export default function McpTab({
  sessionId,
  servers,
  staleEnv,
  overrides,
  onOverride,
  onChanged,
}: {
  sessionId: string
  servers: McpServerInfo[]
  /** This session's host was spawned with a different PATH than the app now
   *  has, so nothing in this list can be reconnected from here. See McpStatus. */
  staleEnv: boolean
  /** Per-server permission override, keyed by server name. Owned by
   *  SessionPanel — see the note on `setOverride` there for why not here. */
  overrides: Record<string, string>
  onOverride: (server: string, value: string) => void
  /** Re-runs the panel's batched fetch after a toggle or a reconnect. */
  onChanged: () => void
}): React.JSX.Element {
  /* Why the reconnect button used to look inert: the reason it failed was
     `console.warn`-ed inside a detached host process, swallowed again by the
     manager's deliberate `callOr`, and the renderer just re-fetched and redrew
     the same red row. Keyed by server name and local to this tab, which is the
     right lifetime — an error from a previous visit is stale by definition. */
  const [reconnectErrors, setReconnectErrors] = useState<Record<string, string>>({})

  /* Drop an error the moment the server it belongs to comes up, so a successful
     reconnect (or one that happened elsewhere) doesn't leave a contradiction on
     screen: a green dot over "Reconnect failed". */
  useEffect(() => {
    setReconnectErrors((prev) => {
      const next = { ...prev }
      let changed = false
      for (const srv of servers) {
        if (srv.status === 'connected' && next[srv.name]) {
          delete next[srv.name]
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [servers])

  /* `.sect-empty` rather than a banner of its own: this is the same kind of
     muted, full-width sentence, and one more bespoke box in a panel this dense
     is worse than a reused one. Above the empty guard on purpose — a stale
     environment can leave the list empty, and that is the case that needs the
     explanation most. */
  const stale = staleEnv && (
    <p className="sect-empty">
      This session started before Foreman picked up your shell PATH. Start a new session to
      reconnect these servers.
    </p>
  )

  if (!servers.length)
    return (
      <>
        {stale}
        <p className="sect-empty">None configured.</p>
      </>
    )

  return (
    <div className="slist">
      {stale}
      {servers.map((srv) => {
        const cur = overrides[srv.name] ?? ''
        const { name, origin } = label(srv)
        return (
          <Row
            key={srv.name}
            dot={srv.status}
            name={name}
            note={origin}
            /* The raw identifier, which the name line no longer shows in full —
               this was the only Row in the app that never passed a tip, and it
               is the one whose name is most often truncated. */
            tip={srv.name}
            meta={statusPill(srv)}
            sub={reconnectErrors[srv.name] ?? failureText(srv)}
            actions={
              <>
                <button
                  className="code-btn"
                  data-tip={srv.status === 'disabled' ? 'Enable this server' : 'Disable this server'}
                  aria-label={
                    srv.status === 'disabled' ? 'Enable this server' : 'Disable this server'
                  }
                  onClick={() =>
                    void window.foreman
                      .toggleMcp(sessionId, srv.name, srv.status === 'disabled')
                      .then(onChanged)
                  }
                >
                  <Power size={12} />
                </button>
                <button
                  className="code-btn"
                  data-tip="Reconnect this server"
                  aria-label="Reconnect"
                  onClick={() =>
                    void window.foreman.reconnectMcp(sessionId, srv.name).then((res) => {
                      setReconnectErrors((m) => {
                        const next = { ...m }
                        if (res?.ok) delete next[srv.name]
                        else next[srv.name] = `Reconnect failed: ${res?.error ?? 'no reason given.'}`
                        return next
                      })
                      onChanged()
                    })
                  }
                >
                  <PlugZap size={12} />
                </button>
                {/* Tighten-only by construction — the SDK's override can restrict
                    a server's permission handling but never widen it. */}
                <Picker
                  ariaLabel={`Permission override for ${srv.name}`}
                  tip="Permission override — can restrict this server, never widen it"
                  align="right"
                  label={OVERRIDES.find((o) => o.value === cur)?.label ?? 'inherit'}
                  items={OVERRIDES.map((o) => ({
                    id: o.value || 'inherit',
                    label: o.label,
                    checked: o.value === cur,
                    onSelect: () => {
                      onOverride(srv.name, o.value)
                      void window.foreman.setMcpPermissionOverride(
                        sessionId,
                        srv.name,
                        o.value || null,
                      )
                    },
                  }))}
                />
              </>
            }
          />
        )
      })}
    </div>
  )
}
