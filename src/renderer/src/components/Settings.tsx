import { useEffect, useMemo, useState } from 'react'
import {
  Bell,
  Bot,
  Columns3,
  Gauge,
  MessageSquarePlus,
  Monitor,
  Palette,
  Server,
  ShieldCheck,
  Sparkle,
  Sparkles,
  Timer,
  Wallet,
  X,
} from 'lucide-react'
import type {
  AgentLifetime,
  Appearance as AppearanceSettings,
  EffortLevel,
  PermissionMode,
} from '../../../shared/types'
import { useStore } from '../store'
import type { PresenceState } from '../usePresence'
import LspServers from './LspServers'
import type { MenuItem } from './Menu'
import Picker from './Picker'
import { SettingRow, SettingToggle } from './SettingRow'
import { EFFORTS, MODE_HINT, MODE_ICON, MODES, modelLabels } from './Composer'

/** One row of a Picker, before it knows which of its siblings is current. */
interface Choice<T extends string | number> {
  value: T
  label: string
  hint?: string
  icon?: React.ReactNode
}

const THEMES: Choice<AppearanceSettings['theme']>[] = [
  { value: 'auto', label: 'Auto', hint: 'follows macOS' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
]

/** The three stops on Appearance → Transcript width. Named rather than a pixel
 *  slider because there is no seam to drag: --convo-max-w is the only thing that
 *  moves, and the real question is which display you are on. */
const WIDTHS: Choice<AppearanceSettings['transcriptWidth']>[] = [
  { value: 'comfortable', label: 'Comfortable', hint: '840px' },
  { value: 'wide', label: 'Wide', hint: '1100px' },
  { value: 'full', label: 'Full', hint: 'the whole pane' },
]

/** `1 hours` was the bug this spells its way out of. Minutes below an hour stay
 *  minutes; 0 is "never", which the host spells as a huge timeout rather than as
 *  a special case. */
const idleLabel = (m: number): string => {
  if (m === 0) return 'Never'
  if (m < 60) return `${m} minutes`
  const h = m / 60
  return `${h} ${h === 1 ? 'hour' : 'hours'}`
}

const IDLE: Choice<number>[] = [15, 30, 60, 120, 480, 0].map((m) => ({
  value: m,
  label: idleLabel(m),
}))
const BUDGETS: Choice<number>[] = [0, 5, 10, 25, 50, 100].map((v) => ({
  value: v,
  label: v === 0 ? 'No cap' : `$${v}`,
}))
const TURNS: Choice<number>[] = [0, 50, 100, 250, 500].map((v) => ({
  value: v,
  label: v === 0 ? 'No cap' : `${v} turns`,
}))
const LIFETIMES: Choice<AgentLifetime>[] = [
  { value: 'persist', label: 'Keep agents running' },
  { value: 'stop', label: 'Stop agents' },
]

type Category = 'new' | 'agents' | 'limits' | 'appearance' | 'lsp'

/** Order is the nav's order. Language servers is last because it is the only
 *  category about the PROJECT rather than the app — and, until it got a category
 *  of its own, it was over half the scroll height of this whole modal. */
const CATEGORIES: { id: Category; label: string; icon: React.ReactNode }[] = [
  { id: 'new', label: 'New conversations', icon: <MessageSquarePlus size={14} /> },
  { id: 'agents', label: 'Agents', icon: <Bot size={14} /> },
  { id: 'limits', label: 'Limits & alerts', icon: <Wallet size={14} /> },
  { id: 'appearance', label: 'Appearance', icon: <Palette size={14} /> },
  { id: 'lsp', label: 'Language servers', icon: <Server size={14} /> },
]

/**
 * A settings row whose control is a Picker over a fixed list.
 *
 * Twelve rows were twelve hand-rolled `<label>` + `<select>` blocks; this is the
 * one that replaced them. The Picker is the app's own popover — the same
 * primitive the composer uses — rather than a native `<select>`, which cannot
 * hold an icon, cannot draw its own chevron, and opens OS chrome no stylesheet
 * reaches. It is also what makes the row one line: a `width: 100%` select could
 * not sit beside its own label, and a picker sized to its text can.
 *
 * THIS IS THE FIRST `.plan-scrim` MODAL TO CONTAIN A PICKER, despite the note at
 * `.menu` in theme.css having claimed otherwise for a while. Three things were
 * traced through the code and all three hold; none of them has been watched
 * happen:
 *
 *  - paint order: `.menu` is z-index 65 over `.plan-scrim`'s 60, both fixed, and
 *    `.app` — where Menu portals to — is `position: relative` with `z-index:
 *    auto`, so it is not a stacking context and the two compare directly.
 *  - the scrim's dismiss-on-mousedown: React events follow the REACT tree, not
 *    the DOM, so a click on a portalled menu row bubbles back through this
 *    component into `.plan-modal`'s `stopPropagation` and never reaches the
 *    scrim's onClose.
 *  - Escape: Menu listens in the capture phase and stops propagation; the
 *    Settings handler is on the bubble phase. First press closes the menu,
 *    second closes Settings.
 *
 * If it turns out not to paint, the fallback is one line: swap `<Picker>` for a
 * native `<select className="select" style={{ width: 'auto' }}>` over the same
 * `choices`, which keeps the whole height win and loses only the glyphs.
 *
 * `align="right"` because these sit at the right edge of a ~560px pane: a
 * left-aligned menu would grow further right and clamp against the window.
 */
function ChoiceRow<T extends string | number>({
  icon,
  label,
  hint,
  value,
  choices,
  onPick,
}: {
  icon?: React.ReactNode
  label: string
  hint?: React.ReactNode
  value: T
  choices: readonly Choice<T>[]
  onPick: (v: T) => void
}): React.JSX.Element {
  const items: MenuItem[] = choices.map((c) => ({
    // `String(c.value) || 'sdk-default'`, because two of these lists use '' as
    // their "leave it to the SDK" sentinel and Menu uses `id` as both the React
    // key and its roving-focus identity. The empty string is closed over in
    // onSelect below, so the sentinel still reaches the store intact.
    id: String(c.value) || 'sdk-default',
    label: c.label,
    hint: c.hint,
    icon: c.icon,
    checked: c.value === value,
    onSelect: () => onPick(c.value),
  }))
  const current = choices.find((c) => c.value === value)
  return (
    <SettingRow icon={icon} label={label} hint={hint}>
      {/* Menu turns its own search row on past eight rows, which is exactly the
          model list and nothing else — so no caller has to say so. */}
      <Picker
        align="right"
        ariaLabel={label}
        label={current?.label ?? String(value)}
        items={items}
      />
    </SettingRow>
  )
}

/**
 * ⌘, — everything the app persists: appearance, plus what a new session starts
 * with.
 *
 * The three defaults are deliberately one-way. Changing mode/model/effort in the
 * composer steers *this* conversation and never writes back here, so a session
 * you flipped to Bypass doesn't quietly make Bypass your default.
 *
 * SIDEBAR AND A DETAIL PANE, not one 2270px scroll. Everything except the
 * language-server list now fits a screen at a time, and the list keeps its own
 * scroll region — which is fine, because it is no longer sitting in front of
 * every other setting on the way past.
 *
 * It keeps `.plan-scrim`, `.plan-modal`, `.plan-head` and `.plan-close` — the
 * chrome — and owns only its layout below that. `.plan-scrim` in particular is
 * NOT optional: ApprovalCard queries for it to suppress its own auto-focus while
 * a modal is up, so dropping the class would silently re-arm approval
 * auto-focus behind this window.
 *
 * `.plan-body` is the one it deliberately stopped sharing. That class and
 * `.settings-body` were the same specificity with `.plan-body` defined later, so
 * the padding here never applied at all — the bug the comment above
 * `.plan-modal.settings` warns about, landed.
 */
export default function Settings({
  onClose,
  'data-state': state,
}: {
  onClose: () => void
  /** From usePresence in App — see `.plan-scrim[data-state='closed']`. */
  'data-state': PresenceState
}): React.JSX.Element {
  const a = useStore((s) => s.appearance)
  const set = useStore((s) => s.setAppearance)
  const prefs = useStore((s) => s.prefs)
  const setPrefs = useStore((s) => s.setPrefs)
  // Cached from the last live session, so this has options on a cold start.
  const models = useStore((s) => s.models)
  const modelRows = useMemo(() => modelLabels(models), [models])
  /* Local, and not in the persisted store: a category is where you are, not a
     preference, and re-opening on the first one is the right default. */
  const [cat, setCat] = useState<Category>('new')

  const modes: Choice<PermissionMode>[] = MODES.map((m) => ({
    value: m.value,
    label: m.label,
    hint: MODE_HINT[m.value],
    icon: MODE_ICON[m.value],
  }))
  /* '' is not one of the SDK's aliases — it means "don't pass a model at all",
     which is not the same as the 'default' row the SDK itself offers. */
  const modelChoices: Choice<string>[] = [
    { value: '', label: 'Leave to the SDK' },
    ...models.map((m, i) => ({ value: m.id, label: modelRows[i] })),
  ]

  useEffect(() => {
    // Bare Escape, matching PlanCard's. If a plan modal is up it renders above
    // this one (same z-index, later in the tree) and both would close together —
    // acceptable, since ⌘, while reviewing a plan is not a real workflow.
    //
    // A Picker open inside this modal swallows its own Escape first: Menu
    // listens in the CAPTURE phase and calls stopPropagation, and this listener
    // is on the bubble phase, so the first press closes the menu and the second
    // closes Settings.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="plan-scrim" data-state={state} onMouseDown={onClose}>
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

        <div className="settings-main">
          <nav className="settings-nav" aria-label="Settings sections">
            {CATEGORIES.map((c) => (
              <button
                key={c.id}
                data-active={cat === c.id || undefined}
                aria-current={cat === c.id ? 'true' : undefined}
                onClick={() => setCat(c.id)}
              >
                {c.icon}
                {c.label}
              </button>
            ))}
          </nav>

          {/* Keyed by category so the pane is a NEW element on every switch,
              which is what replays its arrival animation — a crossfade would
              need both panes mounted at once, and only one is. */}
          <div className="settings-pane" key={cat}>
            {cat === 'new' && (
              <>
                <ChoiceRow
                  icon={<ShieldCheck size={14} />}
                  label="Permission mode"
                  value={prefs.permissionMode}
                  choices={modes}
                  onPick={(permissionMode) => setPrefs({ permissionMode })}
                />
                <ChoiceRow
                  icon={<Sparkles size={14} />}
                  label="Model"
                  value={prefs.model}
                  choices={modelChoices}
                  onPick={(model) => setPrefs({ model })}
                />
                <ChoiceRow
                  icon={<Gauge size={14} />}
                  label="Reasoning effort"
                  value={prefs.effort ?? ''}
                  choices={EFFORTS.map((x) => ({ value: x.value, label: x.label }))}
                  onPick={(v) => setPrefs({ effort: (v || null) as EffortLevel | null })}
                />
                <SettingToggle
                  icon={<Sparkle size={14} />}
                  label="Name conversations automatically"
                  hint="A one-shot Haiku call on the first message, about $0.004 each. Off keeps the project directory name."
                  value={prefs.autoTitle}
                  onChange={(autoTitle) => setPrefs({ autoTitle })}
                />
              </>
            )}

            {cat === 'agents' && (
              <>
                <ChoiceRow
                  icon={<Server size={14} />}
                  label="When Foreman quits"
                  hint={
                    prefs.agentLifetime === 'persist'
                      ? 'Agents keep working in their own processes and are picked back up next launch — including after a crash.'
                      : 'Agents are stopped on quit. A crash still leaves them running, and they are picked back up next launch.'
                  }
                  value={prefs.agentLifetime}
                  choices={LIFETIMES}
                  onPick={(agentLifetime) => setPrefs({ agentLifetime })}
                />
                {/* No longer gated on `agentLifetime`. It used to be, because
                    this only ever applied to an agent left running after a quit
                    — and the control greying out is how a knob that now runs
                    while the app is open would have become unreachable for
                    anyone who chose "Stop agents".

                    The old hint read "Only counts while nothing is attached",
                    which was the bug in one sentence: Foreman holds a socket to
                    every agent for as long as it is open, so the timer never
                    started and a live agent — around 2 GB of CLI, MCP servers
                    and language server — was never reclaimed. */}
                <ChoiceRow
                  icon={<Timer size={14} />}
                  label="Put an idle agent to sleep after"
                  hint="A sleeping agent gives its processes back; the conversation stays in the list and reads exactly as it did. Sending a message starts it again. Never counts a running turn, a waiting approval, or the conversation on screen."
                  value={prefs.agentIdleMinutes}
                  choices={IDLE}
                  onPick={(agentIdleMinutes) => setPrefs({ agentIdleMinutes })}
                />
              </>
            )}

            {cat === 'limits' && (
              <>
                <ChoiceRow
                  icon={<Wallet size={14} />}
                  label="Cost cap per conversation"
                  value={prefs.maxBudgetUsd}
                  choices={BUDGETS}
                  onPick={(maxBudgetUsd) => setPrefs({ maxBudgetUsd })}
                />
                <ChoiceRow
                  icon={<Gauge size={14} />}
                  label="Turn cap per conversation"
                  hint="Hitting either cap ends the turn with a message rather than an error."
                  value={prefs.maxTurns}
                  choices={TURNS}
                  onPick={(maxTurns) => setPrefs({ maxTurns })}
                />
                <SettingToggle
                  icon={<Bell size={14} />}
                  label="Desktop notifications"
                  hint="Turn complete and approval needed, only while the window isn't focused."
                  value={prefs.notifications}
                  onChange={(notifications) => setPrefs({ notifications })}
                />
                <SettingToggle
                  icon={<Sparkles size={14} />}
                  label="Playful status verbs"
                  value={prefs.workingVerbs}
                  onChange={(workingVerbs) => setPrefs({ workingVerbs })}
                />
              </>
            )}

            {cat === 'appearance' && (
              <>
                <ChoiceRow
                  icon={<Palette size={14} />}
                  label="Theme"
                  value={a.theme}
                  choices={THEMES}
                  onPick={(theme) => set({ theme })}
                />
                {/* The composer is deliberately not in the deal — it stays at
                    840px in all three, which is what the hint says out loud so
                    nobody expects the prompt box to grow with the transcript. */}
                <ChoiceRow
                  icon={<Columns3 size={14} />}
                  label="Transcript width"
                  hint="How much of the chat pane a conversation uses. The composer stays where it is."
                  value={a.transcriptWidth}
                  choices={WIDTHS}
                  onPick={(transcriptWidth) => set({ transcriptWidth })}
                />
                {/* Theme and width are the whole section. Surface opacity,
                    Terminal opacity and Blur went with the transparent window —
                    see theme.css's header for why those three were paying a
                    per-frame cost to render nothing. Window buttons stays: it is
                    chrome, not glass. */}
                <SettingToggle
                  icon={<Monitor size={14} />}
                  label="Window buttons"
                  hint={
                    a.trafficLights
                      ? 'Shown. The window has no title bar, so these are its only close and zoom controls.'
                      : 'Hidden. ⌘W closes and ⌘Q quits.'
                  }
                  value={a.trafficLights}
                  onChange={(trafficLights) => set({ trafficLights })}
                />
              </>
            )}

            {cat === 'lsp' && <LspServers />}
          </div>
        </div>
      </div>
    </div>
  )
}
