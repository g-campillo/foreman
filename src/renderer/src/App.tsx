import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FolderTree, GitCompare, Gauge, Plus, SlidersHorizontal, SquareTerminal, X } from 'lucide-react'
import { activeSession, DEFAULT_APPEARANCE, useStore } from './store'
import SessionRail from './components/SessionRail'
import Conversation from './components/Conversation'
import Composer from './components/Composer'
import DiffPanel from './components/DiffPanel'
import TerminalModal from './components/TerminalModal'
import FileTree from './components/FileTree'
import FileModal from './components/FileModal'
import Settings from './components/Settings'
import TodoStrip from './components/TodoStrip'
import SessionPanel from './components/SessionPanel'
import CommandPalette, { type PaletteActions } from './components/CommandPalette'
import Tooltip from './components/Tooltip'

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

/** ⌘1/⌘3/⌘4. `undefined` for every other key — that lookup IS the guard in onKey.
 *  A record rather than a `'1' <= key <= '4'` range, which also admits junk.
 *
 *  ⌘2 is deliberately absent and handled beside ⌘, and ⌘0 instead: the terminal
 *  kept its key but stopped being a panel, so the numbering already learned is
 *  unchanged even though it is no longer one of the display:none siblings. */
const PANEL_KEYS: Record<string, Panel | undefined> = {
  '1': 'diff',
  '3': 'session',
  '4': 'files',
}

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
  const diffCount = useStore((s) => (s.activeId ? (s.diffCounts[s.activeId] ?? 0) : 0))
  const newSession = useStore((s) => s.newSession)
  const setAppearance = useStore((s) => s.setAppearance)
  const [panel, setPanel] = useState<Panel | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [showPalette, setShowPalette] = useState(false)
  // App-local like Settings and the palette, NOT in the store like `editor`.
  // The file modal is in the store because a tree row, a diff row, a tool card
  // six levels down and the palette all open it; the terminal has exactly three
  // openers and all three are in this file or already take an actions object.
  const [showTerminal, setShowTerminal] = useState(false)

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
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [newSession, toggle])

  return (
    <div className="app" data-panel={panel ?? undefined}>
      <SessionRail />

      <section className="pane pane-fill">
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
          <span className="pane-title">{session?.title ?? ''}</span>
          <span className="spacer" />
          <button
            className="tab no-drag"
            data-active={showSettings}
            aria-pressed={showSettings}
            aria-label="Settings"
            data-tip="Settings  ⌘,"
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
              On {(session.worktree?.repoRoot ?? session.cwd).split('/').filter(Boolean).pop()}
            </div>
            <button data-tip="Files this agent has changed  ⌘1" onClick={() => toggle('diff')}>
              <GitCompare size={ICON} />
              Changes
              {diffCount > 0 && <span className="dock-count">+{diffCount}</span>}
            </button>
            <button
              data-tip="A shell in this session's directory  ⌘2"
              onClick={() => setShowTerminal(true)}
            >
              <SquareTerminal size={ICON} />
              Terminal
            </button>
            <button data-tip="This project's tree  ⌘4" onClick={() => toggle('files')}>
              <FolderTree size={ICON} />
              Files
            </button>
            <button
              data-tip="Context window, cost, MCP servers, skills  ⌘3"
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
            subtrees. SessionPanel already no-ops while `visible` is false. */}
        <div className="pane pane-body" style={{ display: panel === 'diff' ? 'flex' : 'none' }}>
          {session ? (
            <DiffPanel session={session} visible={panel === 'diff'} />
          ) : (
            <div className="empty">No session</div>
          )}
        </div>
        <div className="pane pane-body" style={{ display: panel === 'files' ? 'flex' : 'none' }}>
          {session ? (
            <FileTree session={session} visible={panel === 'files'} />
          ) : (
            <div className="empty">No session</div>
          )}
        </div>
        <div className="pane pane-body" style={{ display: panel === 'session' ? 'flex' : 'none' }}>
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
      {showSettings && <Settings onClose={() => setShowSettings(false)} />}
      {showPalette && (
        <CommandPalette actions={paletteActions} onClose={() => setShowPalette(false)} />
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
      {session && showTerminal && (
        <TerminalModal session={session} onClose={() => setShowTerminal(false)} />
      )}
      <Tooltip />
    </div>
  )
}
