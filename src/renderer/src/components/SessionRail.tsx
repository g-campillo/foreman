import { useEffect, useMemo, useState } from 'react'
import {
  Circle,
  Cog,
  Compass,
  FolderPlus,
  GitBranch,
  GitBranchPlus,
  HardHat,
  History,
  LoaderCircle,
  MessageCircleQuestion,
  Plus,
  TriangleAlert,
  X,
} from 'lucide-react'
import type { PastSession, SessionMeta, TranscriptSearchHit } from '../../../shared/types'
import { onHome, useStore } from '../store'
import { activityOf, groupSessions, type Activity } from '../derive.mts'
import LspStrip from './LspStrip'
import ContextStrip from './ContextStrip'

/** Debounce on search: each keystroke otherwise re-reads up to 40 transcripts. */
const SEARCH_DELAY_MS = 250

/**
 * One glyph per activity, animated in CSS off the `data-activity` attribute.
 *
 * Replaces the single blinking dot, which said only "something or nothing" —
 * with three of these open at once you could not tell which agent was waiting
 * on you and which was grinding. Components, not elements: lucide strokes with
 * currentColor, so the wrapper owns the colour.
 */
const ACTIVITY_ICON: Record<Activity, typeof Circle> = {
  working: LoaderCircle,
  planning: Compass,
  background: Cog,
  awaiting: MessageCircleQuestion,
  starting: LoaderCircle,
  error: TriangleAlert,
  idle: Circle,
}

const ACTIVITY_TIP: Record<Activity, string> = {
  working: 'Working',
  planning: 'Planning',
  background: 'Background work still running',
  awaiting: 'Waiting for you',
  starting: 'Starting up',
  error: 'Last turn failed',
  idle: 'Idle',
}

export function ActivityIcon({ session }: { session: SessionMeta }): React.JSX.Element {
  const activity = activityOf(session)
  const Glyph = ACTIVITY_ICON[activity]
  return (
    <span className="activity" data-activity={activity} title={ACTIVITY_TIP[activity]}>
      <Glyph size={12} />
    </span>
  )
}

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
  const home = useStore(onHome)
  const showHome = useStore((s) => s.showHome)
  const select = useStore((s) => s.select)
  const close = useStore((s) => s.close)
  const newSession = useStore((s) => s.newSession)
  const resume = useStore((s) => s.resume)
  const draft = useStore((s) => s.draft)
  const startDraft = useStore((s) => s.startDraft)

  // In a memo, never in the selector: groupSessions allocates fresh objects and
  // arrays on every call, and zustand reads a new identity as a changed store —
  // the same infinite render loop the `approvals` memo in Conversation warns
  // about. `[sessions]` is sufficient as well as correct: onMeta replaces the
  // array via .map, so a title or status patch produces a new identity and
  // regroups, which is needed anyway since the rows render titles.
  const groups = useMemo(() => groupSessions(sessions), [sessions])

  const [past, setPast] = useState<PastSession[]>([])
  const [showPast, setShowPast] = useState(false)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<TranscriptSearchHit[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [branching, setBranching] = useState(false)
  const notice = useStore((s) => s.notice)
  const setNotice = useStore((s) => s.setNotice)
  const openPath = useStore((s) => s.openPath)

  /**
   * Both browsing and search are scoped to the open project by default.
   *
   * Unscoped they list every session on the machine — 336 transcripts across 67
   * projects here — which buries the ones you want. With no session open there
   * is no project to scope to, and an empty list would leave no way back in, so
   * that case is global regardless.
   *
   * Widening is safe, which is why the toggle exists: each row carries its OWN
   * cwd and that is what `resume()` is handed, so a global list still starts
   * every agent in its own directory. Rows without a cwd are already disabled.
   */
  const [allProjects, setAllProjects] = useState(false)
  /* `find`, not `filter` — it hands back a reference that already lives in the
     array, so the snapshot is stable across reads. A filtering selector mints a
     fresh array every time and zustand loops forever on it, blanking the app.
     `?? null` keeps the miss case a stable primitive rather than undefined. */
  const active = useStore((s) => s.sessions.find((x) => x.id === s.activeId) ?? null)
  const cwd = active?.cwd
  const scope = allProjects ? undefined : cwd

  useEffect(() => {
    if (!showPast) return
    void window.foreman.listPastSessions(scope).then(setPast)
  }, [showPast, scope])

  useEffect(() => {
    const q = query.trim()
    if (!q) {
      setHits(null)
      setSearching(false)
      return
    }
    setSearching(true)
    const t = setTimeout(() => {
      void window.foreman.searchTranscripts(q, scope).then((r: TranscriptSearchHit[]) => {
        setHits(r)
        setSearching(false)
      })
    }, SEARCH_DELAY_MS)
    return () => clearTimeout(t)
  }, [query, scope])

  const commitRename = (sdkSessionId: string | null, title: string): void => {
    setRenaming(null)
    const t = title.trim()
    if (t && sdkSessionId) void window.foreman.renameSession(sdkSessionId, t)
  }

  /**
   * Open a session in its own worktree. Scoped to the open project when there is
   * one, so "three agents on this repo" is two clicks rather than re-picking the
   * same directory each time; falls back to the picker when nothing is open.
   */
  const startBranch = (name: string): void => {
    setBranching(false)
    const n = name.trim()
    if (!n) return
    void (scope ? openPath(scope, n) : newSession(n))
  }

  return (
    <aside className="pane rail pane-fill">
      <header className="pane-head rail-head drag">Sessions</header>

      {notice && (
        <button
          className="rail-notice"
          onClick={() => setNotice(null)}
          data-tip="Dismiss this notice"
        >
          {notice}
        </button>
      )}

      <div className="rail-list">
        {/* Reuses `.session` so it matches the rows below with no new CSS. */}
        <button
          className="session"
          data-active={home}
          onClick={showHome}
          data-tip="Home — sessions, projects, usage  ⌘0"
        >
          <span className="activity" data-activity="idle">
            <HardHat size={12} />
          </span>
          <span className="session-body">
            <span className="session-title">Home</span>
          </span>
        </button>

        {/* A conversation that exists but has no project yet. Rendered as a row
            so the rail matches what the pane is showing — the chooser.

            Above the groups, not below: it has no project, so it cannot sit
            under any project header — and it is the newest thing in the rail
            by definition. */}
        {draft && (
          <div className="session" data-active>
            <span className="activity" data-activity="idle">
              <Plus size={12} />
            </span>
            <span className="session-body">
              <span className="session-title">New conversation</span>
              <span className="session-sub">pick a project</span>
            </span>
          </div>
        )}

        {groups.map((g) => (
          /* Boxes one project's header with its rows, and deliberately has no
             CSS rule. It used to be load-bearing — a sticky header releases when
             its own PARENT scrolls past, so flat in .rail-list the last header
             would have stayed pinned over the history list below — but
             .rail-group-head is static now, so this is plain grouping. */
          <div key={g.root}>
            <div className="rail-group-head" title={g.root}>
              {g.root.split('/').filter(Boolean).pop() ?? g.root}
              {/* Only when the group has depth. Next to a single row it restates
                  what you can already see. */}
              {g.sessions.length > 1 && (
                <span className="rail-group-n">{g.sessions.length}</span>
              )}
            </div>
            {g.sessions.map((s) =>
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
                <div key={s.id} className="rail-row">
                  <button
                    className="session"
                    // `&& !home` or two rows look selected at once.
                    data-active={s.id === activeId && !home}
                    onClick={() => select(s.id)}
                    onDoubleClick={() => setRenaming(s.id)}
                    onAuxClick={(e) => {
                      if (e.button === 1) void close(s.id)
                    }}
                    title={`${s.cwd}\nDouble-click to rename`}
                  >
                    <ActivityIcon session={s} />
                    <span className="session-body">
                      <span className="session-title">{s.title}</span>
                      {/* No sub-line at all. The icon carries state, the group
                          header carries the project, and position carries
                          recency — so every row is one line and the list reads
                          as a list. Cost used to live here; it is in
                          ContextStrip, SessionPanel and Home, all of which have
                          room for the token count beside it. */}
                      {/* Which checkout this agent is editing. Without it, three
                          sessions on one repo are indistinguishable in the rail. */}
                      {s.worktree && (
                        <span className="session-branch">
                          <GitBranch size={11} />
                          {s.worktree.branch}
                        </span>
                      )}
                    </span>
                  </button>
                  {/* Archive, not delete. close() drops the session from the
                      rail and stops the agent, but the transcript stays in
                      ~/.claude/projects and comes back from the history search
                      below — so this is reversible, and the tip says so rather
                      than making the user find out. Middle-click on the row
                      still does the same thing for anyone who knew about it. */}
                  <button
                    className="session-x"
                    data-tip="Archive — the transcript is kept, and resumes from past sessions"
                    aria-label={`Archive ${s.title}`}
                    onClick={() => void close(s.id)}
                  >
                    <X size={12} />
                  </button>
                </div>
              ),
            )}
          </div>
        ))}

        {sessions.length === 0 && !draft && <p className="rail-note">No sessions yet.</p>}

        {showPast && (
          <>
            <input
              className="rail-search"
              value={query}
              placeholder="Search transcripts…"
              onChange={(e) => setQuery(e.target.value)}
            />

            <div className="rail-section" title={scope ?? 'all projects'}>
              {hits ? `Matches${searching ? '…' : ` (${hits.length})`}` : 'Recent'}
              {/* Both the CLI and the SDK write to ~/.claude/projects, so this
                  list already covers conversations started from either — the
                  toggle is the only thing that was missing to reach them. */}
              <button
                className="rail-scope"
                onClick={() => setAllProjects((v) => !v)}
                disabled={!cwd}
                data-tip={
                  scope ? 'Showing this project — click for all projects' : 'Showing all projects'
                }
              >
                {scope ? scope.split('/').pop() : 'all projects'}
              </button>
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
                        {!scope && h.cwd && `${h.cwd.split('/').filter(Boolean).pop()} · `}
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
                        {/* Unscoped, the project is the thing that tells two
                            identically-named sessions apart — and scoped it is
                            redundant with the header. */}
                        {!scope && p.cwd && `${p.cwd.split('/').filter(Boolean).pop()} · `}
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

      {branching && (
        <input
          className="rename-input"
          autoFocus
          placeholder="Branch name…"
          onBlur={(e) => startBranch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') startBranch(e.currentTarget.value)
            if (e.key === 'Escape') setBranching(false)
          }}
        />
      )}

      {/* Bottom of the rail, above the buttons: the conventional place for
          status, and the one spot where a server waking up cannot REORDER the
          session list. It does still change its height — `.lsp-strip` is
          `flex: 0 0 auto` in this flex column, so mounting it shortens the
          scrollable `.rail-list` above. That is why phaseOf latches `ready`:
          without it, the short work tokens jdtls opens on every save would
          mount and unmount this strip under the user's cursor. Scoped to the
          active session because the fleet is per-host, and a host serves one
          session. */}
      {activeId && <LspStrip sessionId={activeId} />}

      {/* Model, context pressure and running cost. This lived under the composer
          until the chat pane lost its status bar — Cursor keeps the equivalent
          readout at the foot of the SIDEBAR, above the account row, and it
          belongs there for a reason that outlives the restyle: none of it is
          about the message you are typing, and down here it stops competing for
          width with the composer's controls.

          Keyed by session id for the same reason it always was: Conversation and
          Composer render unkeyed, so without it this component's polled state
          would survive a tab switch and print one session's numbers under
          another's model name. */}
      {active && <ContextStrip key={active.id} session={active} />}

      <footer className="rail-foot">
        <button
          className="btn grow"
          data-variant="primary"
          data-tip="New conversation in this project  ⌘N"
          onClick={() => void newSession()}
        >
          <Plus size={14} />
          New
        </button>
        <button
          className="btn"
          data-active={draft}
          onClick={startDraft}
          data-tip="New conversation in another project  ⇧⌘N"
          aria-label="New conversation in another project"
        >
          <FolderPlus size={14} />
        </button>
        <button
          className="btn"
          onClick={() => setBranching(true)}
          data-tip="New agent in its own git worktree, on its own branch"
          aria-label="New worktree session"
        >
          <GitBranchPlus size={14} />
        </button>
        <button
          className="btn"
          data-active={showPast}
          onClick={() => setShowPast((v) => !v)}
          data-tip={showPast ? 'Hide past sessions' : 'Resume or search past sessions'}
          aria-label={showPast ? 'Hide past sessions' : 'Past sessions'}
        >
          <History size={14} />
        </button>
        {activeId && (
          <button
            className="btn"
            data-variant="danger"
            data-tip="Close this session"
            aria-label="Close this session"
            onClick={() => void close(activeId)}
          >
            <X size={14} />
          </button>
        )}
      </footer>
    </aside>
  )
}
