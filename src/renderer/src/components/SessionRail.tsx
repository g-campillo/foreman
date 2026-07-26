import { useEffect, useState } from 'react'
import type { PastSession } from '../../../shared/types'
import { useStore } from '../store'

export default function SessionRail(): React.JSX.Element {
  const sessions = useStore((s) => s.sessions)
  const activeId = useStore((s) => s.activeId)
  const select = useStore((s) => s.select)
  const close = useStore((s) => s.close)
  const newSession = useStore((s) => s.newSession)
  const resume = useStore((s) => s.resume)

  const [past, setPast] = useState<PastSession[]>([])
  const [showPast, setShowPast] = useState(false)

  useEffect(() => {
    if (!showPast) return
    void window.foreman.listPastSessions().then(setPast)
  }, [showPast])

  return (
    <aside className="pane rail glass">
      <header className="pane-head rail-head drag">Sessions</header>

      <div className="rail-list">
        {sessions.map((s) => (
          <button
            key={s.id}
            className="session"
            data-active={s.id === activeId}
            onClick={() => select(s.id)}
            onAuxClick={(e) => {
              if (e.button === 1) void close(s.id)
            }}
            title={s.cwd}
          >
            <span className="dot" data-status={s.status} />
            <span className="session-body">
              <span className="session-title">{s.title}</span>
              <span className="session-sub">
                {s.status === 'awaiting-approval' ? 'needs approval' : s.status}
                {s.costUsd > 0 && ` · $${s.costUsd.toFixed(3)}`}
              </span>
            </span>
          </button>
        ))}

        {sessions.length === 0 && (
          <p style={{ padding: '10px 9px', color: 'rgb(var(--text-faint))', fontSize: 12 }}>
            No sessions yet.
          </p>
        )}

        {showPast && (
          <>
            <div
              style={{
                padding: '12px 9px 5px',
                fontSize: 10,
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
                color: 'rgb(var(--text-faint))',
              }}
            >
              Recent
            </div>
            {past.length === 0 && (
              <p style={{ padding: '4px 9px', color: 'rgb(var(--text-faint))', fontSize: 12 }}>
                Nothing found.
              </p>
            )}
            {past.map((p) => (
              <button
                key={p.sessionId}
                className="session"
                title={p.cwd}
                onClick={() => void resume(p.sessionId, p.cwd ?? '', p.summary.slice(0, 40))}
                disabled={!p.cwd}
              >
                <span className="dot" />
                <span className="session-body">
                  <span className="session-title">{p.summary}</span>
                  <span className="session-sub">{p.cwd ?? 'unknown directory'}</span>
                </span>
              </button>
            ))}
          </>
        )}
      </div>

      <footer className="rail-foot">
        <button className="btn grow" data-variant="primary" onClick={() => void newSession()}>
          New
        </button>
        <button className="btn" onClick={() => setShowPast((v) => !v)} title="Resume a past session">
          {showPast ? 'Hide' : 'Past'}
        </button>
        {activeId && (
          <button className="btn" data-variant="danger" onClick={() => void close(activeId)}>
            ✕
          </button>
        )}
      </footer>
    </aside>
  )
}
