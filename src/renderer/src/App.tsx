import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FolderTree, GitCompare, Gauge, PanelLeft, Plus, SlidersHorizontal, SquareTerminal, X } from 'lucide-react'
import { activeSession, DEFAULT_APPEARANCE, useStore } from './store'
import { baseName } from './derive.mts'
import SessionRail from './components/SessionRail'
import Conversation from './components/Conversation'
import Composer from './components/Composer'
import DiffPanel from './components/DiffPanel'
import TerminalModal from './components/TerminalModal'
import FileTree from './components/FileTree'
import FileModal from './components/FileModal'
import Settings from './components/Settings'
import TodoStrip from './components/TodoStrip'
import SessionMeter from './components/SessionMeter'
import SessionPanel from './components/SessionPanel'
import CommandPalette, { type PaletteActions } from './components/CommandPalette'
import Tooltip from './components/Tooltip'
import { hk } from './hotkey'
import { useKeyPeek } from './useKeyPeek'
import { usePresence } from './usePresence'

export type Panel = 'diff' | 'session' | 'files'

/** Order matters: this is the dock's tab order, left to right. */
const PANEL_LABEL: Record<Panel, string> = {
  diff: 'Changes',
  files: 'Files',
  session: 'Session',
}

/** Elements rather than components, because they are only ever rendered at one
 *  size in one place — see ICON below for why that size is fixed. */
const PANEL_ICON: Record<Panel, React.ReactNode> = {
  diff: <GitCompare size={14} />,
  files: <FolderTree size={14} />,
  session: <Gauge size={14} />,
}

/** ⌘1/⌘3/⌘4, declared panel-first because that is the direction the keycaps read
 *  it: the tab bar renders `⌘${PANEL_KEY[p]}` inside its own map rather than
 *  carrying a second hardcoded copy of the numbering.
 *
 *  ⌘2 is deliberately absent and handled beside ⌘, and ⌘0 instead: the terminal
 *  kept its key but stopped being a panel, so the numbering already learned is
 *  unchanged even though it is no longer one of the display:none siblings. */
const PANEL_KEY: Record<Panel, string> = {
  diff: '1',
  session: '3',
  files: '4',
}

/** The same table read the other way, for the keydown handler. `undefined` for
 *  every other key — that lookup IS the guard in onKey, and a record rather than
 *  a `'1' <= key <= '4'` range, which also admits junk. Derived rather than
 *  written out, so a cap and its shortcut cannot disagree. */
const PANEL_KEYS: Record<string, Panel | undefined> = Object.fromEntries(
  (Object.keys(PANEL_KEY) as Panel[]).map((p) => [PANEL_KEY[p], p]),
)

/** One size for every chrome glyph, so the toolbar stays optically even.
 *  strokeWidth is deliberately absent — theme.css sets it once for all SVG. */
const ICON = 14

/**
 * Live-drag limits, mirroring the clamp() on --rail-w / --side-w in theme.css.
 *
 * The CSS clamp is the one that survives a window resize; this one exists only
 * so the seam stays under the pointer rather than running past the limit and
 * opening a dead zone on the way back. `max` is a fraction of the window.
 */
const SEAMS = {
  rail: { min: 180, max: 0.3, prop: '--rail-w-user' },
  side: { min: 280, max: 0.44, prop: '--side-w-user' },
} as const

type Seam = keyof typeof SEAMS

export default function App(): React.JSX.Element {
  const session = useStore(activeSession)
  // Lines, not files: `Changes +14` used to be the dirty FILE count wearing a
  // plus sign, which reads as fourteen added lines and never was. Undefined
  // until the first evtDiffChanged lands, which is a clean row rather than +0.
  const diffStats = useStore((s) => (s.activeId ? s.diffCounts[s.activeId] : undefined))
  const newSession = useStore((s) => s.newSession)
  const setAppearance = useStore((s) => s.setAppearance)
  // Persisted rather than App-local like `panel`: where the user left the
  // furniture is Appearance's job, and a rail that reopened on every launch
  // would undo the one thing ⌘B is for.
  const railOpen = useStore((s) => s.appearance.railOpen)
  const [panel, setPanel] = useState<Panel | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [showPalette, setShowPalette] = useState(false)
  // App-local like Settings and the palette, NOT in the store like `editor`.
  // The file modal is in the store because a tree row, a diff row, a tool card
  // six levels down and the palette all open it; the terminal has exactly three
  // openers and all three are in this file or already take an actions object.
  const [showTerminal, setShowTerminal] = useState(false)

  // Each modal stays mounted for the length of its exit transition, which is the
  // only way a `{cond && <X/>}` overlay can animate out at all — see usePresence.
  // The flags above are still the truth; these only delay the unmount.
  const settingsAt = usePresence(showSettings)
  const paletteAt = usePresence(showPalette)
  const terminalAt = usePresence(showTerminal)

  // Hold ⌘ and every `data-key` in the window names its shortcut. Writes an
  // attribute on <body> and nothing else — see useKeyPeek for why it must not
  // be state.
  useKeyPeek()

  // Opening the initial project lives in the store's bootstrap(), not here: it
  // has to run after the session rehydration it would otherwise race.

  /**
   * Live pane resize.
   *
   * The width goes straight onto the root element as a custom property rather
   * than through React state: it is a value only CSS reads, and a re-render per
   * pointermove would rebuild the conversation, the diff panel and the terminal
   * for it. The store is written once, on pointerup — setAppearance hits
   * localStorage on every call.
   */
  const drag = useRef<{
    seam: Seam
    el: HTMLElement
    app: HTMLElement
    /** Pane width at grab time, and the pointer x it was grabbed at. */
    from: number
    x: number
    /** +1 where dragging right widens this pane, -1 where it narrows it. */
    dir: 1 | -1
    min: number
    max: number
    /** 0 until the first move: a click that never moved must not write. */
    w: number
  } | null>(null)

  const onSeamDown = useCallback((e: React.PointerEvent<HTMLDivElement>, seam: Seam): void => {
    if (e.button !== 0) return
    const el = e.currentTarget
    const app = el.parentElement
    if (!app) return
    const box = app.getBoundingClientRect()
    const cfg = SEAMS[seam]
    // Ask the grid what it actually used, rather than deriving it from the
    // handle's own box: that would silently depend on .rs's width matching the
    // -4px inset in its left/right calc(), two numbers nothing keeps in sync.
    // This also reads the CSS clamp()'s result, not the stored value.
    const cols = getComputedStyle(app).gridTemplateColumns.split(' ')
    drag.current = {
      seam,
      el,
      app,
      from: parseFloat(seam === 'rail' ? cols[0] : cols[cols.length - 1]),
      x: e.clientX,
      dir: seam === 'rail' ? 1 : -1,
      min: cfg.min,
      max: Math.max(cfg.min, box.width * cfg.max),
      w: 0,
    }
    el.setPointerCapture(e.pointerId)
    el.setAttribute('data-active', '')
    app.setAttribute('data-resizing', '')
  }, [])

  const onSeamMove = useCallback((e: React.PointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (!d) return
    const w = Math.min(Math.max(d.from + d.dir * (e.clientX - d.x), d.min), d.max)
    d.w = w
    document.documentElement.style.setProperty(SEAMS[d.seam].prop, `${w}px`)
  }, [])

  const onSeamUp = useCallback((): void => {
    const d = drag.current
    if (!d) return
    drag.current = null
    d.el.removeAttribute('data-active')
    d.app.removeAttribute('data-resizing')
    // Not just "did any move fire": a trackpad reports a pixel of jitter on an
    // ordinary click, and setAppearance writes localStorage and pushes to main
    // on every call. Commit only a real change.
    const w = Math.round(d.w)
    if (!d.w || w === Math.round(d.from)) return
    // Branching rather than a computed key: `{ [SEAMS[seam].key]: w }` widens to
    // `{ [x: string]: number }` when the key is a union, and fails to assign to
    // Partial<Appearance>.
    if (d.seam === 'rail') setAppearance({ railWidth: w })
    else setAppearance({ sideWidth: w })
  }, [setAppearance])

  // The same panel closes; a different one swaps. Only one is ever open — the
  // chat is the app, and the side pane is a reference you consult.
  const toggle = useCallback((p: Panel) => setPanel((cur) => (cur === p ? null : p)), [])

  // Identity-stable, or the palette's entry list rebuilds on every keystroke.
  // showPanel is setPanel, NOT toggle: "Show diff" from the palette must open
  // the panel, never close one that already is.
  const paletteActions = useMemo<PaletteActions>(
    () => ({
      showPanel: setPanel,
      showSettings: () => setShowSettings(true),
      showTerminal: () => setShowTerminal(true),
    }),
    [],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!e.metaKey) return
      const p = PANEL_KEYS[e.key]
      if (p) {
        e.preventDefault()
        toggle(p)
      } else if (e.key === '2') {
        // Kept its key, lost its panel. Out of PANEL_KEYS because it is no
        // longer one of the display:none siblings in .side — it is a modal now.
        e.preventDefault()
        setShowTerminal((v) => !v)
      } else if (e.key === ',') {
        // The standard macOS Preferences key. Free: the app installs no Menu,
        // and Electron's default template has no Preferences role.
        e.preventDefault()
        setShowSettings((v) => !v)
      } else if (e.key === 'n') {
        // ⌘N reuses the current project, and falls through to the directory
        // picker when there is none. ⇧⌘N used to open the project chooser; both
        // the key and the chooser are gone, so this no longer tests shiftKey —
        // which also means ⇧⌘N is free rather than silently doing ⌘N's job.
        if (e.shiftKey) return
        e.preventDefault()
        void newSession()
      } else if (e.key === 'p' || e.key === 'k') {
        // ⌘K used to cycle sessions; the palette is that, done properly. Both
        // keys open it, since muscle memory splits between the two.
        e.preventDefault()
        setShowPalette((v) => !v)
      } else if (e.key === 'b') {
        // Every editor's sidebar key, and free for the same reason ⌘, is: no
        // Menu of our own, and Electron's default template does not claim it.
        e.preventDefault()
        setAppearance({ railOpen: !railOpen })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [newSession, toggle, setAppearance, railOpen])

  return (
    <div className="app" data-panel={panel ?? undefined} data-rail={railOpen ? undefined : 'closed'}>
      <SessionRail />

      {/* `pane-chat` names the pane rather than describing it: it is the only
          .pane with nothing else to select it by, and collapsing the rail needs
          to reach exactly this one — for its divider and for the traffic lights
          it inherits. */}
      <section className="pane pane-chat pane-fill">
        {/* Deliberately empty on the left. The title and the cwd · branch line
            that used to sit here are gone: the rail already names the session,
            and the empty state carries branch and model as chips, so this strip
            was repeating both while costing a divider and a row of uppercase.

            It stays in the flow as a 44px strip rather than floating over the
            transcript, and that is load-bearing — this is the ONLY drag region
            on the chat side of a frameless window. Floating it top-right would
            leave the whole left half of the title bar undraggable. Transparent
            with nothing in it, it looks like the absence Cursor has, and still
            moves the window. */}
        {/* The five-icon toolbar that lived here is gone. Cursor names the agent
            on the left of this strip and keeps the panel's entry points as a
            labelled list at the top RIGHT of the content area — see .dock-entries
            below. Five unlabelled glyphs in a corner were the last piece of
            toolbar idiom left in the app.

            Settings keeps a button because it is the one thing here that belongs
            to the app rather than to the session. */}
        <header className="pane-head drag">
          {/* First child, and the SAME slot open or closed — a control that
              moves when you use it is a control you have to find again. When the
              rail is collapsed the traffic lights land in this strip beside it;
              see --traffic-w in theme.css. `no-drag`, because this strip is the
              drag region (above).

              One glyph, not a PanelLeft/PanelLeftClose swap: aria-pressed and
              the tip carry the state to everything that needs it, and a glyph
              that changes under the cursor is exactly the churn this app keeps
              removing. No data-active either — the rail is open by default, so
              the most permanent button in the window would be lit from launch,
              which says nothing.

              THE LABEL IS A NOUN, and the visible tip is the only thing that
              names an action. aria-pressed already asserts that whatever the
              label names is ON, so "Hide conversations" + pressed announces
              "hiding is active" — the exact opposite of the state it is in. A
              toggle carries its state in one place or the other, never both;
              Settings beside it is labelled the same way for the same reason. */}
          <button
            className="tab no-drag"
            aria-pressed={railOpen}
            aria-label="Conversations"
            {...hk(railOpen ? 'Hide conversations' : 'Show conversations', '⌘B')}
            onClick={() => setAppearance({ railOpen: !railOpen })}
          >
            <PanelLeft size={ICON} />
          </button>
          <span className="pane-title">{session?.title ?? ''}</span>
          <span className="spacer" />
          {/* Between the spacer and Settings, and no `no-drag`: it is text with a
              `data-tip` and nothing else, so it keeps dragging the window. The
              tick lives inside it — see SessionMeter. */}
          {session && <SessionMeter session={session} />}
          <button
            className="tab no-drag"
            data-active={showSettings}
            aria-pressed={showSettings}
            aria-label="Settings"
            {...hk('Settings', '⌘,')}
            onClick={() => setShowSettings((v) => !v)}
          >
            <SlidersHorizontal size={ICON} />
          </button>
        </header>

        {/* Cursor's `On <repo>` list: the dock's entries, shown only while the
            dock is closed, as labelled rows rather than icons. Absolutely
            positioned inside the pane — `.pane-fill`'s `contain: paint` makes it
            the containing block, which is exactly what is wanted here. */}
        {!panel && session && (
          <div className="dock-entries">
            <div className="dock-entries-head">
              On {baseName(session.worktree?.repoRoot ?? session.cwd)}
            </div>
            <button
              {...hk('Files this agent has changed', `⌘${PANEL_KEY.diff}`)}
              onClick={() => toggle('diff')}
            >
              <GitCompare size={ICON} />
              Changes
              {/* Each number only when it is non-zero — a lone `−0` beside a
                  real `+120` reads as a rounding error.

                  ...but a DIRTY TREE MUST NEVER RENDER AS CLEAN, which is what
                  gating on the totals alone would do. Three ordinary cases have
                  files but no lines: a binary file (numstat reports `-  -`), a
                  chmod +x (`0  0`), and a new empty file. The panel lists rows
                  and offers a commit for all three, so the row falls back to the
                  file count — which is exactly what this badge showed before it
                  learned to count lines. */}
              {diffStats && (diffStats.added > 0 || diffStats.removed > 0) ? (
                <>
                  {diffStats.added > 0 && <span className="dock-count">+{diffStats.added}</span>}
                  {diffStats.removed > 0 && (
                    <span className="dock-count" data-tone="del">
                      −{diffStats.removed}
                    </span>
                  )}
                </>
              ) : (
                !!diffStats?.files && <span className="dock-count">{diffStats.files}</span>
              )}
            </button>
            {/* ⌘2 is hardcoded because the terminal is not a Panel — it kept
                its key when it became a modal. */}
            <button
              {...hk("A shell in this session's directory", '⌘2')}
              onClick={() => setShowTerminal(true)}
            >
              <SquareTerminal size={ICON} />
              Terminal
            </button>
            <button
              {...hk("This project's tree", `⌘${PANEL_KEY.files}`)}
              onClick={() => toggle('files')}
            >
              <FolderTree size={ICON} />
              Files
            </button>
            <button
              {...hk('Context window, cost, MCP servers, skills', `⌘${PANEL_KEY.session}`)}
              onClick={() => toggle('session')}
            >
              <Gauge size={ICON} />
              Session
            </button>
          </div>
        )}

        {/* Two states now. The Home dashboard and the project chooser both went:
            Home listed what the rail already lists, and the chooser only existed
            to ask which project a new conversation belonged to, which
            newSession() answers by opening the directory picker.

            So "no session" is no longer a route to anywhere — it is the absence
            of a conversation, and it says so. */}
        {session ? (
          <>
            <TodoStrip sessionId={session.id} />
            <Conversation sessionId={session.id} />
            <Composer session={session} />
          </>
        ) : (
          <div className="pane-empty">
            <p>No conversation open.</p>
            <button
              className="btn"
              data-variant="primary"
              onClick={() => void newSession()}
            >
              <Plus size={14} />
              New conversation
            </button>
          </div>
        )}
      </section>

      {/* `side` is the hook theme.css hides when no panel is open. The header
          stays even though the toolbar left: the window is frameless, and the
          .pane-head.drag strips are the ONLY drag region — drop it and the
          top-right of the window becomes undraggable while a panel is open. */}
      <section className="pane pane-fill side">
        {/* A tab bar, not a label. Cursor's dock switches between Changes,
            Browser and a terminal from tabs in this strip — active is a filled
            rounded rect, inactive is plain text, and there are no borders
            anywhere. Terminal and the file view stay modals, so they are not
            tabs here; they open from the entry list instead. */}
        <header className="pane-head drag">
          <div className="dock-tabs no-drag">
            {(Object.keys(PANEL_LABEL) as Panel[]).map((p) => (
              <button
                key={p}
                data-active={panel === p}
                aria-pressed={panel === p}
                // No data-tip, deliberately (see the comment above): the tab is
                // already labelled, and a bubble repeating its own text is
                // noise. The cap is declared on its own so it can exist without
                // one — which is the whole reason data-key is not parsed out of
                // data-tip. Derived from PANEL_KEY rather than a second table.
                data-key={`⌘${PANEL_KEY[p]}`}
                onClick={() => setPanel(p)}
              >
                {PANEL_ICON[p]}
                {PANEL_LABEL[p]}
              </button>
            ))}
          </div>
          <span className="spacer" />
          <button
            className="plan-close no-drag"
            data-tip="Close panel"
            aria-label="Close panel"
            onClick={() => setPanel(null)}
          >
            <X size={ICON} />
          </button>
        </header>

        {/* All three stay mounted rather than swapping, because DiffPanel holds
            an unsent commit message plus per-file tick and collapse state, and a
            panel toggle silently discarding those is worse than three hidden
            subtrees. SessionPanel renders nothing until its first open.

            `data-active` rather than an inline `display`: theme.css stacks all
            three in one grid cell and crossfades them, and `display` is the one
            property that cannot be transitioned into. The attribute is the only
            thing the CSS needs — see .pane-body. */}
        <div className="pane pane-body" data-active={panel === 'diff' || undefined}>
          {session ? (
            <DiffPanel session={session} visible={panel === 'diff'} />
          ) : (
            <div className="empty">No session</div>
          )}
        </div>
        <div className="pane pane-body" data-active={panel === 'files' || undefined}>
          {session ? (
            <FileTree session={session} visible={panel === 'files'} />
          ) : (
            <div className="empty">No session</div>
          )}
        </div>
        <div className="pane pane-body" data-active={panel === 'session' || undefined}>
          {session ? (
            <SessionPanel session={session} visible={panel === 'session'} />
          ) : (
            <div className="empty">No session</div>
          )}
        </div>
      </section>

      {/* The two draggable seams. Absolutely positioned, so .app stays a
          three-column grid with three children as far as the template knows.
          role="separator" without tabIndex on purpose: a focusable separator
          needs aria-valuenow/min/max and inserts two tab stops mid-tree, for a
          feature nobody will keyboard-drive in a single-user desktop app. */}
      <div
        className="rs rs-rail"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize session rail"
        onPointerDown={(e) => onSeamDown(e, 'rail')}
        onPointerMove={onSeamMove}
        onPointerUp={onSeamUp}
        onPointerCancel={onSeamUp}
        onDoubleClick={() => setAppearance({ railWidth: DEFAULT_APPEARANCE.railWidth })}
      />
      <div
        className="rs rs-side"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panel"
        onPointerDown={(e) => onSeamDown(e, 'side')}
        onPointerMove={onSeamMove}
        onPointerUp={onSeamUp}
        onPointerCancel={onSeamUp}
        onDoubleClick={() => setAppearance({ sideWidth: DEFAULT_APPEARANCE.sideWidth })}
      />

      {/* All three are position:fixed, so they sit outside the panes — Settings
          in particular must not live in a section that can be display:none, and
          the tooltip is here for the stronger version of the same reason: a
          pane's `contain: paint` makes it the containing block for a fixed
          child, and the pane's overflow would then clip the bubble. Tooltip
          renders last so its z-index:70 and its DOM order agree about painting
          over both scrims. */}
      {settingsAt.mounted && (
        <Settings data-state={settingsAt.state} onClose={() => setShowSettings(false)} />
      )}
      {paletteAt.mounted && (
        <CommandPalette
          data-state={paletteAt.state}
          actions={paletteActions}
          onClose={() => setShowPalette(false)}
        />
      )}
      {/* Here for the strong version of the reason above, not the weak one:
          PlanCard's scrim renders inside .convo and is therefore confined to the
          chat pane. A file needs the whole window, so it mounts as a sibling of
          Settings. Before Tooltip, so a tip still paints over a suggest list. */}
      {session && <FileModal session={session} />}
      {/* Same reason as FileModal — a pane's `contain: paint` makes it the
          containing block and the pane's overflow would clip it. Unlike the
          others it sits BELOW the palette in z (see .term-scrim): ⌘K has to
          stay reachable over a terminal you left open. */}
      {session && terminalAt.mounted && (
        <TerminalModal
          data-state={terminalAt.state}
          session={session}
          onClose={() => setShowTerminal(false)}
        />
      )}
      <Tooltip />
    </div>
  )
}
