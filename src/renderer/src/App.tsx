import { useEffect, useMemo, useState } from 'react'
import { activeSession, useStore } from './store'
import SessionRail from './components/SessionRail'
import Conversation from './components/Conversation'
import Composer from './components/Composer'
import DiffPanel from './components/DiffPanel'
import TerminalPane from './components/TerminalPane'
import Appearance from './components/Appearance'
import TodoStrip from './components/TodoStrip'
import CommandPalette, { type PaletteActions } from './components/CommandPalette'

type Tab = 'diff' | 'terminal'

export default function App(): React.JSX.Element {
  const session = useStore(activeSession)
  const diffCount = useStore((s) => (s.activeId ? (s.diffCounts[s.activeId] ?? 0) : 0))
  const newSession = useStore((s) => s.newSession)
  const [tab, setTab] = useState<Tab>('diff')
  const [showAppearance, setShowAppearance] = useState(false)
  const [showPalette, setShowPalette] = useState(false)

  // Opening the initial project lives in the store's bootstrap(), not here: it
  // has to run after the session rehydration it would otherwise race.

  // Identity-stable, or the palette's entry list rebuilds on every keystroke.
  const paletteActions = useMemo<PaletteActions>(
    () => ({ showTab: setTab, showAppearance: () => setShowAppearance(true) }),
    [],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!e.metaKey) return
      if (e.key === 'n') {
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
  }, [newSession])

  return (
    <div className="app">
      <SessionRail />

      <section className="pane glass">
        <header className="pane-head drag">
          <span>{session ? session.title : 'Foreman'}</span>
          {session && (
            <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}>
              {session.cwd}
            </span>
          )}
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
              Open project…
            </button>
          </div>
        )}
      </section>

      <section className="pane glass" style={{ position: 'relative' }}>
        <header className="pane-head drag">
          <button className="btn no-drag" onClick={() => setShowAppearance((v) => !v)}>
            Appearance
          </button>
          <div className="tabs no-drag">
            <button className="tab" data-active={tab === 'diff'} onClick={() => setTab('diff')}>
              Diff{diffCount > 0 && <> &nbsp;<span className="badge">{diffCount}</span></>}
            </button>
            <button
              className="tab"
              data-active={tab === 'terminal'}
              onClick={() => setTab('terminal')}
            >
              Terminal
            </button>
          </div>
        </header>

        {showAppearance && <Appearance onClose={() => setShowAppearance(false)} />}

        {/* Both stay mounted: unmounting the terminal would drop its scrollback. */}
        <div className="pane pane-body" style={{ display: tab === 'diff' ? 'flex' : 'none' }}>
          {session ? <DiffPanel session={session} /> : <div className="empty">No session</div>}
        </div>
        <div className="pane pane-body" style={{ display: tab === 'terminal' ? 'flex' : 'none' }}>
          {session ? (
            <TerminalPane session={session} visible={tab === 'terminal'} />
          ) : (
            <div className="empty">No session</div>
          )}
        </div>
      </section>

      {showPalette && (
        <CommandPalette actions={paletteActions} onClose={() => setShowPalette(false)} />
      )}
    </div>
  )
}
