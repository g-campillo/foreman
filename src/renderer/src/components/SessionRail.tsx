import { useEffect, useState } from 'react'
import type { PastSession, TranscriptSearchHit } from '../../../shared/types'
import { useStore } from '../store'

/** Debounce on search: each keystroke otherwise re-reads up to 40 transcripts. */
const SEARCH_DELAY_MS = 250

const when = (ms?: number): string => {
  if (!ms) return ''
  const days = Math.floor((Date.now() - ms) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days}d ago`
  return new Date(ms).toLocaleDateString()
}

export default function SessionRail(): React.JSX.Element {
  const sessions = useStore((s) => s.sessions)
  const activeId = useStore((s) => s.activeId)
  const select = useStore((s) => s.select)
  const close = useStore((s) => s.close)
  const newSession = useStore((s) => s.newSession)
  const resume = useStore((s) => s.resume)

  const [past, setPast] = useState<PastSession[]>([])
  const [showPast, setShowPast] = useState(false)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<TranscriptSearchHit[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)

  useEffect(() => {
    if (!showPast) return
    void window.foreman.listPastSessions().then(setPast)
  }, [showPast])

  useEffect(() => {
    const q = query.trim()
    if (!q) {
      setHits(null)
      setSearching(false)
      return
    }
    setSearching(true)
    const t = setTimeout(() => {
      void window.foreman.searchTranscripts(q).then((r: TranscriptSearchHit[]) => {
        setHits(r)
        setSearching(false)
      })
    }, SEARCH_DELAY_MS)
    return () => clearTimeout(t)
  }, [query])

  const commitRename = (sdkSessionId: string | null, title: string): void => {
    setRenaming(null)
    const t = title.trim()
    if (t && sdkSessionId) void window.foreman.renameSession(sdkSessionId, t)
  }

  return (
    <aside className="pane rail glass">
      <header className="pane-head rail-head drag">Sessions</header>

      <div className="rail-list">
        {sessions.map((s) =>
          renaming === s.id ? (
            <input
              key={s.id}
              className="rename-input"
              defaultValue={s.title}
              autoFocus
              onBlur={(e) => commitRename(s.sdkSessionId, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename(s.sdkSessionId, e.currentTarget.value)
                if (e.key === 'Escape') setRenaming(null)
              }}
            />
          ) : (
            <button
              key={s.id}
              className="session"
              data-active={s.id === activeId}
              onClick={() => select(s.id)}
              onDoubleClick={() => setRenaming(s.id)}
              onAuxClick={(e) => {
                if (e.button === 1) void close(s.id)
              }}
              title={`${s.cwd}\nDouble-click to rename`}
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
          ),
        )}

        {sessions.length === 0 && <p className="rail-note">No sessions yet.</p>}

        {showPast && (
          <>
            <input
              className="rail-search"
              value={query}
              placeholder="Search transcripts…"
              onChange={(e) => setQuery(e.target.value)}
            />

            <div className="rail-section">
              {hits ? `Matches${searching ? '…' : ` (${hits.length})`}` : 'Recent'}
            </div>

            {/* Search results replace the recent list rather than sitting beside
                it — both answer the same question, "which session was that". */}
            {hits
              ? hits.map((h) => (
                  <button
                    key={h.sessionId}
                    className="session"
                    title={h.cwd}
                    // Without a cwd the CLI searches the wrong project directory
                    // and reports "No conversation found", so don't offer it.
                    disabled={!h.cwd}
                    onClick={() => void resume(h.sessionId, h.cwd ?? '', h.summary.slice(0, 40))}
                  >
                    <span className="dot" />
                    <span className="session-body">
                      <span className="session-title">{h.summary}</span>
                      <span className="session-snippet">{h.snippet}</span>
                      <span className="session-sub">
                        {h.matches} match{h.matches === 1 ? '' : 'es'} · {when(h.lastModified)}
                      </span>
                    </span>
                  </button>
                ))
              : past.map((p) => (
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
                      <span className="session-sub">
                        {when(p.lastModified)}
                        {p.gitBranch && ` · ${p.gitBranch}`}
                      </span>
                    </span>
                  </button>
                ))}

            {hits && hits.length === 0 && !searching && <p className="rail-note">No matches.</p>}
            {!hits && past.length === 0 && <p className="rail-note">Nothing found.</p>}
          </>
        )}
      </div>

      <footer className="rail-foot">
        <button className="btn grow" data-variant="primary" onClick={() => void newSession()}>
          New
        </button>
        <button
          className="btn"
          onClick={() => setShowPast((v) => !v)}
          title="Resume or search past sessions"
        >
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
