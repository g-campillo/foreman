import { useCallback, useEffect, useMemo, useState } from 'react'
import { FolderOpen, GitCompare, Gauge, SlidersHorizontal, SquareTerminal, X } from 'lucide-react'
import { activeSession, useStore } from './store'
import SessionRail from './components/SessionRail'
import Conversation from './components/Conversation'
import Composer from './components/Composer'
import DiffPanel from './components/DiffPanel'
import TerminalPane from './components/TerminalPane'
import Settings from './components/Settings'
import TodoStrip from './components/TodoStrip'
import SessionPanel from './components/SessionPanel'
import CommandPalette, { type PaletteActions } from './components/CommandPalette'

export type Panel = 'diff' | 'terminal' | 'session'

const PANEL_LABEL: Record<Panel, string> = {
  diff: 'Diff',
  terminal: 'Terminal',
  session: 'Session',
}

/** ⌘1/⌘2/⌘3. `undefined` for every other key — that lookup IS the guard in onKey.
 *  A record rather than a `'1' <= key <= '3'` range, which also admits junk. */
const PANEL_KEYS: Record<string, Panel | undefined> = {
  '1': 'diff',
  '2': 'terminal',
  '3': 'session',
}

/** One size for every chrome glyph, so the toolbar stays optically even.
 *  strokeWidth is deliberately absent — theme.css sets it once for all SVG. */
const ICON = 14

export default function App(): React.JSX.Element {
  const session = useStore(activeSession)
  const diffCount = useStore((s) => (s.activeId ? (s.diffCounts[s.activeId] ?? 0) : 0))
  const newSession = useStore((s) => s.newSession)
  const [panel, setPanel] = useState<Panel | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [showPalette, setShowPalette] = useState(false)

  // Opening the initial project lives in the store's bootstrap(), not here: it
  // has to run after the session rehydration it would otherwise race.

  // The same panel closes; a different one swaps. Only one is ever open — the
  // chat is the app, and the side pane is a reference you consult.
  const toggle = useCallback((p: Panel) => setPanel((cur) => (cur === p ? null : p)), [])

  // Identity-stable, or the palette's entry list rebuilds on every keystroke.
  // showPanel is setPanel, NOT toggle: "Show diff" from the palette must open
  // the panel, never close one that already is.
  const paletteActions = useMemo<PaletteActions>(
    () => ({ showPanel: setPanel, showSettings: () => setShowSettings(true) }),
    [],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!e.metaKey) return
      const p = PANEL_KEYS[e.key]
      if (p) {
        e.preventDefault()
        toggle(p)
      } else if (e.key === ',') {
        // The standard macOS Preferences key. Free: the app installs no Menu,
        // and Electron's default template has no Preferences role.
        e.preventDefault()
        setShowSettings((v) => !v)
      } else if (e.key === 'n') {
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

      <section className="pane glass">
        <header className="pane-head drag">
          <span>{session ? session.title : 'Foreman'}</span>
          {session && (
            /* A worktree path is long and says nothing useful — it lives under
               userData with a disambiguating suffix. The branch is what the user
               thinks of this session as; the full path stays in the tooltip. */
            <span className="pane-path" title={session.cwd}>
              {session.worktree ? `${session.worktree.repoRoot} · ${session.worktree.branch}` : session.cwd}
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
              title="Diff  ⌘1"
              disabled={!session}
              onClick={() => toggle('diff')}
            >
              <GitCompare size={ICON} />
              {diffCount > 0 && <span className="badge">{diffCount}</span>}
            </button>
            <button
              className="tab"
              data-active={panel === 'terminal'}
              aria-pressed={panel === 'terminal'}
              aria-label="Terminal"
              title="Terminal  ⌘2"
              disabled={!session}
              onClick={() => toggle('terminal')}
            >
              <SquareTerminal size={ICON} />
            </button>
            <button
              className="tab"
              data-active={panel === 'session'}
              aria-pressed={panel === 'session'}
              aria-label="Session info"
              title="Session info  ⌘3"
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
              title="Settings  ⌘,"
              onClick={() => setShowSettings((v) => !v)}
            >
              <SlidersHorizontal size={ICON} />
            </button>
          </div>
        </header>

        {session ? (
          <>
            <TodoStrip sessionId={session.id} />
            <Conversation sessionId={session.id} />
            <Composer session={session} />
          </>
        ) : (
          <div className="empty">
            <h2>No active session</h2>
            <p>Open a project directory to start an agent.</p>
            <button className="btn" data-variant="primary" onClick={() => void newSession()}>
              <FolderOpen size={ICON} />
              Open project…
            </button>
          </div>
        )}
      </section>

      {/* `side` is the hook theme.css hides when no panel is open. The header
          stays even though the toolbar left: the window is frameless, and the
          .pane-head.drag strips are the ONLY drag region — drop it and the
          top-right of the window becomes undraggable while a panel is open. */}
      <section className="pane glass side">
        <header className="pane-head drag">
          <span>{panel ? PANEL_LABEL[panel] : ''}</span>
          <span className="spacer" />
          <button
            className="plan-close no-drag"
            title="Close panel"
            aria-label="Close panel"
            onClick={() => setPanel(null)}
          >
            <X size={ICON} />
          </button>
        </header>

        {/* All three stay mounted. NOT for the terminal's sake — its xterm lives
            in a module-level map inside TerminalPane and survives unmounting —
            but because DiffPanel holds an unsent commit message plus per-file
            tick and collapse state, and a panel toggle silently discarding those
            is worse than three hidden subtrees. SessionPanel already no-ops
            while `visible` is false. */}
        <div className="pane pane-body" style={{ display: panel === 'diff' ? 'flex' : 'none' }}>
          {session ? <DiffPanel session={session} /> : <div className="empty">No session</div>}
        </div>
        <div className="pane pane-body" style={{ display: panel === 'terminal' ? 'flex' : 'none' }}>
          {session ? (
            <TerminalPane session={session} visible={panel === 'terminal'} />
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

      {/* Both are position:fixed, so they sit outside the panes — Settings in
          particular must not live in a section that can be display:none. */}
      {showSettings && <Settings onClose={() => setShowSettings(false)} />}
      {showPalette && (
        <CommandPalette actions={paletteActions} onClose={() => setShowPalette(false)} />
      )}
    </div>
  )
}
