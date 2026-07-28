import { useEffect, useMemo } from 'react'
import { Bell, Gauge, Server, ShieldCheck, Sparkles, Sparkle, Wallet, X } from 'lucide-react'
import type {
  AgentLifetime,
  Appearance as AppearanceSettings,
  EffortLevel,
  PermissionMode,
} from '../../../shared/types'
import { useStore } from '../store'
import LspServers from './LspServers'
import { EFFORTS, MODES, modelLabels } from './Composer'

const THEMES: { label: string; value: AppearanceSettings['theme'] }[] = [
  { label: 'Auto', value: 'auto' },
  { label: 'Dark', value: 'dark' },
  { label: 'Light', value: 'light' },
]

/** 0 is "never" — the host spells that as a huge timeout rather than a special case. */
const IDLE_CHOICES = [15, 30, 60, 120, 480, 0]
const BUDGET_CHOICES = [0, 5, 10, 25, 50, 100]
const TURN_CHOICES = [0, 50, 100, 250, 500]

/**
 * ⌘, — everything the app persists: appearance, plus what a new session starts
 * with.
 *
 * The three defaults are deliberately one-way. Changing mode/model/effort in the
 * composer steers *this* conversation and never writes back here, so a session
 * you flipped to Bypass doesn't quietly make Bypass your default.
 *
 * A centred modal reusing PlanCard's scrim and frame, rather than the old `.pop`
 * popover: that was anchored to the side pane, which no longer reliably exists.
 */
export default function Settings({ onClose }: { onClose: () => void }): React.JSX.Element {
  const a = useStore((s) => s.appearance)
  const set = useStore((s) => s.setAppearance)
  const prefs = useStore((s) => s.prefs)
  const setPrefs = useStore((s) => s.setPrefs)
  // Cached from the last live session, so this has options on a cold start.
  const models = useStore((s) => s.models)
  const modelRows = useMemo(() => modelLabels(models), [models])
  useEffect(() => {
    // Bare Escape, matching PlanCard's. If a plan modal is up it renders above
    // this one (same z-index, later in the tree) and both would close together —
    // acceptable, since ⌘, while reviewing a plan is not a real workflow.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="plan-scrim" onMouseDown={onClose}>
      <div
        className="plan-modal settings"
        role="dialog"
        aria-label="Settings"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="plan-head">
          <h2 className="plan-title">Settings</h2>
          <button className="plan-close" data-tip="Close  ⌘," aria-label="Close" onClick={onClose}>
            <X size={14} />
          </button>
        </header>

        <div className="plan-body settings-body">
          <div className="settings-sect">New conversations</div>

          <label>
            <span className="settings-lbl">
              <ShieldCheck size={12} /> Permission mode
            </span>
            <select
              className="select"
              value={prefs.permissionMode}
              onChange={(e) => setPrefs({ permissionMode: e.target.value as PermissionMode })}
            >
              {MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span className="settings-lbl">
              <Sparkles size={12} /> Model
            </span>
            <select
              className="select"
              value={prefs.model}
              onChange={(e) => setPrefs({ model: e.target.value })}
            >
              {/* '' is not one of the SDK's aliases — it means "don't pass a
                  model at all", which is not the same as the 'default' row. */}
              <option value="">Leave to the SDK</option>
              {models.map((m, i) => (
                <option key={m.displayName} value={m.id}>
                  {modelRows[i]}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span className="settings-lbl">
              <Gauge size={12} /> Reasoning effort
            </span>
            <select
              className="select"
              value={prefs.effort ?? ''}
              onChange={(e) =>
                setPrefs({ effort: (e.target.value || null) as EffortLevel | null })
              }
            >
              {EFFORTS.map((x) => (
                <option key={x.value} value={x.value}>
                  {x.label}
                </option>
              ))}
            </select>
          </label>

          {/* The switch is written last in every .settings-toggle so tab order
              follows reading order; the grid puts it in column 2 either way. */}
          <label className="settings-toggle">
            <span className="settings-lbl">
              <Sparkle size={12} /> Name conversations automatically
            </span>
            <span className="settings-hint">
              A one-shot Haiku call on the first message, about $0.004 each. Off keeps the
              project directory name.
            </span>
            <input
              className="switch"
              type="checkbox"
              checked={prefs.autoTitle}
              onChange={(e) => setPrefs({ autoTitle: e.target.checked })}
            />
          </label>

          <div className="settings-sect">Agents</div>

          <label>
            <span className="settings-lbl">
              <Server size={12} /> When Foreman quits
            </span>
            <select
              className="select"
              value={prefs.agentLifetime}
              onChange={(e) => setPrefs({ agentLifetime: e.target.value as AgentLifetime })}
            >
              <option value="persist">Keep agents running</option>
              <option value="stop">Stop agents</option>
            </select>
            <span className="settings-hint">
              {prefs.agentLifetime === 'persist'
                ? 'Agents keep working in their own processes and are picked back up next launch — including after a crash.'
                : 'Agents are stopped on quit. A crash still leaves them running, and they are picked back up next launch.'}
            </span>
          </label>

          <label>
            <span className="settings-lbl">
              <Gauge size={12} /> Stop an unattended agent after
            </span>
            <select
              className="select"
              value={prefs.agentIdleMinutes}
              disabled={prefs.agentLifetime !== 'persist'}
              onChange={(e) => setPrefs({ agentIdleMinutes: Number(e.target.value) })}
            >
              {IDLE_CHOICES.map((m) => (
                <option key={m} value={m}>
                  {m === 0 ? 'Never' : m < 60 ? `${m} minutes` : `${m / 60} hours`}
                </option>
              ))}
            </select>
            <span className="settings-hint">
              Only counts while nothing is attached and no turn is running. Applies to agents
              started from now on.
            </span>
          </label>

          <div className="settings-sect">Limits &amp; alerts</div>

          <label>
            <span className="settings-lbl">
              <Wallet size={12} /> Cost cap per conversation
            </span>
            <select
              className="select"
              value={prefs.maxBudgetUsd}
              onChange={(e) => setPrefs({ maxBudgetUsd: Number(e.target.value) })}
            >
              {BUDGET_CHOICES.map((v) => (
                <option key={v} value={v}>
                  {v === 0 ? 'No cap' : `$${v}`}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span className="settings-lbl">
              <Gauge size={12} /> Turn cap per conversation
            </span>
            <select
              className="select"
              value={prefs.maxTurns}
              onChange={(e) => setPrefs({ maxTurns: Number(e.target.value) })}
            >
              {TURN_CHOICES.map((v) => (
                <option key={v} value={v}>
                  {v === 0 ? 'No cap' : `${v} turns`}
                </option>
              ))}
            </select>
            <span className="settings-hint">
              Hitting either cap ends the turn with a message rather than an error.
            </span>
          </label>

          <label className="settings-toggle">
            <span className="settings-lbl">
              <Bell size={12} /> Desktop notifications
            </span>
            <span className="settings-hint">
              Turn complete and approval needed, only while the window isn&apos;t focused.
            </span>
            <input
              className="switch"
              type="checkbox"
              checked={prefs.notifications}
              onChange={(e) => setPrefs({ notifications: e.target.checked })}
            />
          </label>

          <label className="settings-toggle">
            <span className="settings-lbl">
              <Sparkles size={12} /> Playful status verbs
            </span>
            <input
              className="switch"
              type="checkbox"
              checked={prefs.workingVerbs}
              onChange={(e) => setPrefs({ workingVerbs: e.target.checked })}
            />
          </label>

          <div className="settings-sect">Appearance</div>

          <label>
            Theme
            <select
              className="select"
              value={a.theme}
              onChange={(e) => set({ theme: e.target.value as AppearanceSettings['theme'] })}
            >
              {THEMES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>

          {/* Theme is the whole section now. Surface opacity, Terminal opacity
              and Blur went with the transparent window — see theme.css's header
              for why those three were paying a per-frame cost to render nothing.
              Window buttons stays: it is chrome, not glass. */}

          <label className="settings-toggle">
            <span className="settings-lbl">Window buttons</span>
            <span className="settings-hint">
              {a.trafficLights
                ? 'Shown. The window has no title bar, so these are its only close and zoom controls.'
                : 'Hidden. ⌘W closes and ⌘Q quits.'}
            </span>
            <input
              className="switch"
              type="checkbox"
              checked={a.trafficLights}
              onChange={(e) => set({ trafficLights: e.target.checked })}
            />
          </label>

          {/* Last, because it is the only section about the PROJECT rather than
              the app, and it is read far less often than it is scrolled past. */}
          <div className="settings-sect">Language servers</div>
          <LspServers />
        </div>
      </div>
    </div>
  )
}
