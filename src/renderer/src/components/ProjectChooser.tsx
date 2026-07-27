import { useEffect, useMemo, useState } from 'react'
import { Clock, FolderOpen, HardHat, Search } from 'lucide-react'
import type { PastSession } from '../../../shared/types'
import { useStore } from '../store'
import { filterEntries } from '../derive.mts'

/** Enough to cover what anyone actually switches between. */
const MAX_RECENTS = 10

/**
 * Where a new conversation should run.
 *
 * The Claude-app shape: open a conversation first, choose the project second.
 * Before this, the only way into a *different* project was a native folder
 * dialog, which is a poor answer to "the repo I was in twenty minutes ago".
 *
 * ⌘N deliberately does NOT come here — it reuses the current project, which is
 * the common case and should stay one keystroke. This is for the other one.
 *
 * Recents need no new storage: every past session already carries its cwd, so
 * the list is `listPastSessions()` deduped by directory, newest first.
 */
export default function ProjectChooser(): React.JSX.Element {
  const openPath = useStore((s) => s.openPath)
  const openProject = useStore((s) => s.openProject)
  const current = useStore((s) => s.sessions.find((x) => x.id === s.activeId)?.cwd)
  const cancelDraft = useStore((s) => s.cancelDraft)
  const hasSession = useStore((s) => s.sessions.length > 0)
  const [past, setPast] = useState<PastSession[] | null>(null)
  const [query, setQuery] = useState('')

  useEffect(() => {
    // Unscoped on purpose — the whole point is to reach a project you do not
    // currently have open.
    void window.foreman.listPastSessions(undefined).then(setPast)
  }, [])

  // Escape backs out — but only when there is a session to back out TO.
  // Otherwise this is the app's only screen and dismissing it strands the user.
  useEffect(() => {
    if (!hasSession) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') cancelDraft()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [hasSession, cancelDraft])

  const recents = useMemo(() => {
    const seen = new Set<string>()
    const out: { label: string; hint: string }[] = []
    // The project you are already in first, so it is one click even when it has
    // no history yet.
    if (current) {
      seen.add(current)
      out.push({ label: current.split('/').filter(Boolean).pop() ?? current, hint: current })
    }
    for (const p of past ?? []) {
      if (!p.cwd || seen.has(p.cwd)) continue
      seen.add(p.cwd)
      out.push({ label: p.cwd.split('/').filter(Boolean).pop() ?? p.cwd, hint: p.cwd })
    }
    return out.slice(0, MAX_RECENTS)
  }, [past, current])

  // Matches the name or the path — `filterEntries` already ranks hint matches
  // below label matches, which is what makes typing a repo name work.
  const shown = useMemo(() => filterEntries(recents, query), [recents, query])

  return (
    <div className="empty chooser">
      <HardHat size={40} />
      <h2>New conversation</h2>
      <p>{hasSession ? 'Which project should this agent work in?  Esc to cancel'
                    : 'Which project should this agent work in?'}</p>

      <div className="chooser-search">
        <Search size={13} />
        <input
          autoFocus
          value={query}
          placeholder="Filter projects…"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && shown[0]) void openPath(shown[0].hint)
          }}
        />
      </div>

      <div className="chooser-list">
        {past === null && <p className="rail-note">Loading…</p>}
        {past !== null && shown.length === 0 && <p className="rail-note">No matching projects.</p>}
        {shown.map((r) => (
          <button key={r.hint} className="chooser-row" onClick={() => void openPath(r.hint)}>
            <Clock size={12} />
            <span className="chooser-name">{r.label}</span>
            {/* RTL so a long path keeps its tail — the part that disambiguates. */}
            <span className="chooser-path">{r.hint}</span>
          </button>
        ))}
      </div>

      <button className="btn" data-variant="primary" onClick={() => void openProject()}>
        <FolderOpen size={14} />
        Browse…
      </button>
    </div>
  )
}
