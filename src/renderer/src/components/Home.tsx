import { useEffect, useMemo, useState } from 'react'
import {
  Clock,
  FolderGit2,
  FolderOpen,
  FolderPlus,
  GitBranch,
  GitCompare,
  HardHat,
  Plus,
  Search,
  X,
} from 'lucide-react'
import type { PastSession } from '../../../shared/types'
import { useStore } from '../store'
import {
  aggregateUsage,
  filterEntries,
  fmt,
  groupSessions,
  recentProjects,
  type UsageRow,
} from '../derive.mts'
import { modelName } from './Composer'
import { ActivityIcon } from './SessionRail'
import { swatch } from './SessionPanel'

/** Enough to be useful, few enough to scan. The filter box covers the rest. */
const MAX_RECENTS = 10

/** Beyond this the bars stop being comparable and start being a list. */
const MAX_PROJECT_BARS = 6

/**
 * The launch screen: every live session grouped by project, the projects worth
 * reopening, and what all of it has cost.
 *
 * Sits beside ProjectChooser rather than absorbing it. The chooser is a
 * modal-ish task — autofocused input, Enter commits, Escape backs out, one job.
 * This is a dashboard: nothing focused, many actions, scrollable. They share
 * data and CSS, not JSX, so the project rows look identical for free.
 */
export default function Home(): React.JSX.Element {
  const sessions = useStore((s) => s.sessions)
  const diffCounts = useStore((s) => s.diffCounts)
  const branches = useStore((s) => s.branches)
  const hiddenProjects = useStore((s) => s.hiddenProjects)
  const activeId = useStore((s) => s.activeId)
  const select = useStore((s) => s.select)
  const leaveHome = useStore((s) => s.leaveHome)
  const openPath = useStore((s) => s.openPath)
  const openProject = useStore((s) => s.openProject)
  const newSession = useStore((s) => s.newSession)
  const startDraft = useStore((s) => s.startDraft)
  const hideProject = useStore((s) => s.hideProject)
  const clearHiddenProjects = useStore((s) => s.clearHiddenProjects)

  const [past, setPast] = useState<PastSession[] | null>(null)
  const [usage, setUsage] = useState<UsageRow[] | null>(null)
  const [query, setQuery] = useState('')

  useEffect(() => {
    // Unscoped on purpose: Home is the cross-project view.
    void window.foreman.listPastSessions(undefined).then(setPast)
    void window.foreman.listUsage().then(setUsage)
  }, [])

  // Escape returns to the conversation, mirroring ProjectChooser's "back out,
  // but only when there is somewhere to back out to".
  useEffect(() => {
    if (!activeId) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') leaveHome()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeId, leaveHome])

  const groups = useMemo(() => groupSessions(sessions), [sessions])
  const recents = useMemo(
    () => recentProjects(sessions, past ?? [], hiddenProjects).slice(0, MAX_RECENTS),
    [sessions, past, hiddenProjects],
  )
  const shown = useMemo(() => filterEntries(recents, query), [recents, query])
  const totals = useMemo(() => aggregateUsage(usage ?? [], past ?? []), [usage, past])
  const topSpend = totals.byProject[0]?.costUsd ?? 0

  return (
    <div className="home">
      <header className="home-hero">
        <HardHat size={30} />
        <h1>Foreman</h1>
        <p>
          {sessions.length
            ? `${sessions.length} session${sessions.length === 1 ? '' : 's'} open`
            : 'Nothing running.'}
        </p>
        <div className="home-cta">
          <button className="btn" data-variant="primary" onClick={() => void newSession()}>
            <Plus size={14} />
            New conversation
          </button>
          <button className="btn" onClick={startDraft}>
            <FolderPlus size={14} />
            Another project…
          </button>
          <button className="btn" onClick={() => void openProject()}>
            <FolderOpen size={14} />
            Browse…
          </button>
        </div>
      </header>

      <section className="home-section">
        <h3 className="home-section-head">Running</h3>
        {groups.length === 0 && <p className="rail-note">No live sessions.</p>}
        {groups.map((g) => (
          <div key={g.root} className="home-group">
            <div className="home-group-head">
              <FolderGit2 size={12} />
              <span className="home-group-name">
                {g.root.split('/').filter(Boolean).pop() ?? g.root}
              </span>
              <span className="home-group-path" title={g.root}>
                {g.root}
              </span>
            </div>
            {g.sessions.map((s) => (
              <button
                key={s.id}
                className="home-card"
                data-active={s.id === activeId ? '' : undefined}
                onClick={() => select(s.id)}
                title={s.cwd}
              >
                <ActivityIcon session={s} />
                <span className="home-card-body">
                  <span className="home-card-title">{s.title}</span>
                  <span className="home-card-meta">
                    {s.model && <span>{modelName(s.model)}</span>}
                    {/* Live branch first — worktree.branch is frozen at creation,
                        so it lies after a checkout. Same precedence as the
                        pane header. */}
                    {(branches[s.id] ?? s.worktree?.branch) && (
                      <span>
                        <GitBranch size={10} />
                        {branches[s.id] ?? s.worktree?.branch}
                      </span>
                    )}
                    {(diffCounts[s.id] ?? 0) > 0 && (
                      <span>
                        <GitCompare size={10} />
                        {diffCounts[s.id]}
                      </span>
                    )}
                    {s.costUsd > 0 && <span>${s.costUsd.toFixed(2)}</span>}
                  </span>
                </span>
              </button>
            ))}
          </div>
        ))}
      </section>

      <section className="home-section">
        <h3 className="home-section-head">
          Projects
          <span className="spacer" />
          <span className="home-search">
            <Search size={12} />
            <input
              value={query}
              placeholder="Filter…"
              aria-label="Filter projects"
              onChange={(e) => setQuery(e.target.value)}
            />
          </span>
        </h3>
        {past === null && <p className="rail-note">Loading…</p>}
        {past !== null && shown.length === 0 && <p className="rail-note">Nothing to show.</p>}
        {shown.map((r) => (
          <div key={r.hint} className="home-recent">
            <button className="chooser-row" onClick={() => void openPath(r.hint)}>
              <Clock size={12} />
              <span className="chooser-name">{r.label}</span>
              <span className="chooser-path">{r.hint}</span>
            </button>
            {/* A sibling rather than a nested span[role=button]: the rail's
                pattern exists only because that row IS a <button>. Nothing nests
                here, so this can be a real focusable one.
                Absent while the project has a live session — see recentProjects. */}
            {!r.open && (
              <button
                className="home-remove"
                aria-label={`Remove ${r.label} from recents`}
                data-tip="Remove from this list — nothing on disk is touched"
                data-tip-end=""
                onClick={() => hideProject(r.hint)}
              >
                <X size={11} />
              </button>
            )}
          </div>
        ))}
        {/* Without this a mis-click is only undoable by editing localStorage. */}
        {hiddenProjects.length > 0 && (
          <p className="rail-note">
            {hiddenProjects.length} removed ·{' '}
            <button className="home-link" onClick={clearHiddenProjects}>
              Restore
            </button>
          </p>
        )}
      </section>

      <section className="home-section">
        <h3 className="home-section-head">Usage</h3>
        {usage === null ? (
          <p className="rail-note">Loading…</p>
        ) : totals.sessions === 0 ? (
          <p className="rail-note">No recorded turns yet.</p>
        ) : (
          <>
            <div className="home-stats">
              <div className="home-stat">
                <span className="home-stat-n">${totals.costUsd.toFixed(2)}</span>
                <span className="home-stat-k">Spent</span>
              </div>
              <div className="home-stat">
                <span className="home-stat-n">{fmt(totals.inputTokens)}</span>
                <span className="home-stat-k">Tokens in</span>
              </div>
              <div className="home-stat">
                <span className="home-stat-n">{fmt(totals.outputTokens)}</span>
                <span className="home-stat-k">Tokens out</span>
              </div>
              <div className="home-stat">
                <span className="home-stat-n">{totals.sessions}</span>
                <span className="home-stat-k">Conversations</span>
              </div>
            </div>

            {totals.byProject.slice(0, MAX_PROJECT_BARS).map((p, i) => (
              <div key={p.root} className="home-spend" title={p.root}>
                <span className="home-spend-name">
                  {p.root.split('/').filter(Boolean).pop() ?? p.root}
                </span>
                <span className="home-bar">
                  <i
                    style={{
                      width: `${topSpend > 0 ? (p.costUsd / topSpend) * 100 : 0}%`,
                      background: swatch(i),
                    }}
                  />
                </span>
                <span className="home-spend-n">${p.costUsd.toFixed(2)}</span>
              </div>
            ))}

            {/* Stated rather than folded in silently: these are turns Foreman
                recorded, so anything run from the Claude CLI is not counted. */}
            <p className="rail-note">
              Turns taken in Foreman only.
              {totals.unattributed.sessions > 0 &&
                ` ${totals.unattributed.sessions} without a project ($${totals.unattributed.costUsd.toFixed(2)}).`}
            </p>
          </>
        )}
      </section>
    </div>
  )
}
