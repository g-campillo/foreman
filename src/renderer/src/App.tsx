import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FolderTree, GitCompare, Gauge, SlidersHorizontal, SquareTerminal, X } from 'lucide-react'
import { activeSession, DEFAULT_APPEARANCE, onHome, useStore } from './store'
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
import ProjectChooser from './components/ProjectChooser'
import Home from './components/Home'
import CommandPalette, { type PaletteActions } from './components/CommandPalette'
import Tooltip from './components/Tooltip'

export type Panel = 'diff' | 'session' | 'files'

const PANEL_LABEL: Record<Panel, string> = {
  diff: 'Diff',
  session: 'Session',
  files: 'Files',
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
  const branch = useStore((s) => (s.activeId ? (s.branches[s.activeId] ?? null) : null))
  const newSession = useStore((s) => s.newSession)
  const startDraft = useStore((s) => s.startDraft)
  // A conversation with no project yet. Takes over the pane, so the chooser is
  // the conversation until a directory is picked.
  const draft = useStore((s) => s.draft)
  // Derived, so "no session at all" counts as Home without anyone setting a flag.
  const home = useStore(onHome)
  const showHome = useStore((s) => s.showHome)
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
      } else if (e.key === 'n' || e.key === 'N') {
        // ⌘N reuses the current project — the common case, and it stays one
        // keystroke. ⇧⌘N is the "somewhere else" one and opens the chooser.
        // Matching on both cases because Shift changes `key` to 'N'.
        e.preventDefault()
        if (e.shiftKey) startDraft()
        else void newSession()
      } else if (e.key === '0') {
        // Not in PANEL_KEYS, which only claims 1/2/3. Electron's default menu
        // binds ⌘0 to resetZoom — harmless here since the app never zooms, and
        // preventDefault keeps it from firing.
        e.preventDefault()
        showHome()
      } else if (e.key === 'p' || e.key === 'k') {
        // ⌘K used to cycle sessions; the palette is that, done properly. Both
        // keys open it, since muscle memory splits between the two.
        e.preventDefault()
        setShowPalette((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [newSession, startDraft, toggle, showHome])

  return (
    <div className="app" data-panel={panel ?? undefined}>
      <SessionRail />

      <section className="pane pane-fill">
        <header className="pane-head drag">
          <span>
            {draft ? 'New conversation' : home ? 'Home' : session ? session.title : 'Foreman'}
          </span>
          {session && !draft && !home && (
            /* A worktree path is long and says nothing useful — it lives under
               userData with a disambiguating suffix. The branch is what the user
               thinks of this session as; the full path stays in the tooltip. */
            <span className="pane-path" title={session.cwd}>
              {session.worktree ? session.worktree.repoRoot : session.cwd}
              {/* The live branch, so a `git checkout` shows up and a plain
                  session gets one too. worktree.branch is only the fallback now:
                  it's frozen at creation and goes stale the moment you switch. */}
              {(branch ?? session.worktree?.branch) && ` · ${branch ?? session.worktree?.branch}`}
            </span>
          )}

          {/* The toolbar lives here, not in the side pane: that pane's header is
              gone whenever the panel is closed, which is the default. `no-drag`
              on the wrapper covers all four — -webkit-app-region inherits. */}
          <div className="tabs no-drag">
            <button
              className="tab"
              data-active={panel === 'diff'}
              aria-pressed={panel === 'diff'}
              aria-label="Diff"
              data-tip="Diff — files this agent has changed  ⌘1"
              disabled={!session}
              onClick={() => toggle('diff')}
            >
              <GitCompare size={ICON} />
              {diffCount > 0 && <span className="badge">{diffCount}</span>}
            </button>
            <button
              className="tab"
              data-active={panel === 'files'}
              aria-pressed={panel === 'files'}
              aria-label="Files"
              data-tip="Files — this project's tree  ⌘4"
              disabled={!session}
              onClick={() => toggle('files')}
            >
              <FolderTree size={ICON} />
            </button>
            {/* Still ⌘2, no longer a panel — it opens the window-level modal. */}
            <button
              className="tab"
              data-active={showTerminal}
              aria-pressed={showTerminal}
              aria-label="Terminal"
              data-tip="Terminal — a shell in this session's directory  ⌘2"
              disabled={!session}
              onClick={() => setShowTerminal((v) => !v)}
            >
              <SquareTerminal size={ICON} />
            </button>
            <button
              className="tab"
              data-active={panel === 'session'}
              aria-pressed={panel === 'session'}
              aria-label="Session info"
              data-tip="Session info — context window, cost, MCP servers, skills  ⌘3"
              disabled={!session}
              onClick={() => toggle('session')}
            >
              <Gauge size={ICON} />
            </button>
            {/* SlidersHorizontal, not lucide's `Settings` — that name collides
                with the component imported above. */}
            <button
              className="tab"
              data-active={showSettings}
              aria-pressed={showSettings}
              aria-label="Settings"
              data-tip="Settings  ⌘,"
              onClick={() => setShowSettings((v) => !v)}
            >
              <SlidersHorizontal size={ICON} />
            </button>
          </div>
        </header>

        {/* Three states, in priority order. The chooser IS the conversation
            until a project is picked, so a draft outranks Home; Home in turn
            covers both the explicit ⌘0 and the old bare "no active session". */}
        {draft ? (
          <ProjectChooser />
        ) : home ? (
          <Home />
        ) : (
          session && (
            <>
              <TodoStrip sessionId={session.id} />
              <Conversation sessionId={session.id} />
              <Composer session={session} />
            </>
          )
        )}
      </section>

      {/* `side` is the hook theme.css hides when no panel is open. The header
          stays even though the toolbar left: the window is frameless, and the
          .pane-head.drag strips are the ONLY drag region — drop it and the
          top-right of the window becomes undraggable while a panel is open. */}
      <section className="pane pane-fill side">
        <header className="pane-head drag">
          <span>{panel ? PANEL_LABEL[panel] : ''}</span>
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
