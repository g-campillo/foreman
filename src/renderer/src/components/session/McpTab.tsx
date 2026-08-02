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
  overrides,
  onOverride,
  onChanged,
}: {
  sessionId: string
  servers: McpServerInfo[]
  /** Per-server permission override, keyed by server name. Owned by
   *  SessionPanel — see the note on `setOverride` there for why not here. */
  overrides: Record<string, string>
  onOverride: (server: string, value: string) => void
  /** Re-runs the panel's batched fetch after a toggle or a reconnect. */
  onChanged: () => void
}): React.JSX.Element {
  if (!servers.length) return <p className="sect-empty">None configured.</p>

  return (
    <div className="slist">
      {servers.map((srv) => {
        const cur = overrides[srv.name] ?? ''
        return (
          <Row
            key={srv.name}
            dot={srv.status}
            name={srv.name}
            note={srv.scope}
            meta={statusPill(srv)}
            sub={failureText(srv)}
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
                  onClick={() => void window.foreman.reconnectMcp(sessionId, srv.name).then(onChanged)}
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
