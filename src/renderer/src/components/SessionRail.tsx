import { useEffect, useMemo, useState } from 'react'
import {
  Circle,
  Cog,
  Compass,
  FolderOpen,
  FolderPlus,
  GitBranch,
  GitBranchPlus,
  LoaderCircle,
  MessageCircleQuestion,
  Moon,
  Plus,
  Search,
  TriangleAlert,
  X,
} from 'lucide-react'
import type { PastSession, SessionMeta, TranscriptSearchHit } from '../../../shared/types'
import { useStore } from '../store'
import { activityOf, baseName, groupSessions, tildePath, type Activity } from '../derive.mts'
import { hk } from '../hotkey'
import LspStrip from './LspStrip'

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
const ACTIVITY_ICON: Record<Activity, typeof Circle | null> = {
  working: LoaderCircle,
  planning: Compass,
  background: Cog,
  awaiting: MessageCircleQuestion,
  starting: LoaderCircle,
  error: TriangleAlert,
  // The one glyph that marks an ABSENCE rather than an activity: no host, no
  // CLI, no MCP fleet, no language server. It is here because `idle` is not —
  // with both blank, an idle conversation holding ~2 GB and a sleeping one
  // holding nothing rendered identically, and the rail could not tell you which
  // row to close. A mark means free; a bare row means live.
  asleep: Moon,
  // Nothing at all. An idle session used to paint a hollow Circle, so a rail of
  // twelve finished conversations was a column of twelve identical dots saying
  // "not running" twelve times. Cursor leaves the slot empty and collapses it,
  // which is what makes the one agent that IS working findable at a glance.
  idle: null,
}

const ACTIVITY_TIP: Record<Activity, string> = {
  working: 'Working',
  planning: 'Planning',
  background: 'Background work still running',
  awaiting: 'Waiting for you',
  starting: 'Starting up',
  error: 'Last turn failed',
  asleep: 'Asleep — no agent running. Send a message to wake it',
  idle: 'Idle',
}

export function ActivityIcon({ session }: { session: SessionMeta }): React.JSX.Element | null {
  const activity = activityOf(session)
  const Glyph = ACTIVITY_ICON[activity]
  // The slot collapses rather than rendering empty: a reserved 12px gutter on
  // every idle row would indent the titles for a glyph that is never coming.
  if (!Glyph) return null
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
  const select = useStore((s) => s.select)
  const close = useStore((s) => s.close)
  const newSession = useStore((s) => s.newSession)
  /* NOT `resume`. Clicking a row here used to start a host, a `claude` CLI, its
     whole MCP fleet and a language server — about 2 GB — to READ a conversation
     that is already on disk. `preview` opens the same transcript with none of
     it, and the first message sent wakes the agent. */
  const preview = useStore((s) => s.preview)
  const rename = useStore((s) => s.rename)

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
  const openProject = useStore((s) => s.openProject)

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
  /* THE PROJECT, not the checkout — the same expression Composer and App's dock
     heading use. From a worktree session this used to be the worktree path, and
     it scopes four things at once: History (which looked empty, because the
     stored conversations are filed under the project), transcript search (same),
     the scope chip's own label (it read the checkout's directory name), and the
     base directory `startBranch` cuts a new worktree from. */
  const cwd = active?.worktree?.repoRoot ?? active?.cwd
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

  /* Through the store rather than straight at the bridge: main pushes the new
     title to the session's HOST, and an asleep conversation has none — so the
     row kept its old title until it was re-read from disk. See store.rename. */
  const commitRename = (id: string, title: string): void => {
    setRenaming(null)
    rename(id, title)
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
      {/* No title. Cursor's sidebar strip holds the traffic lights and nothing
          else, and "Sessions" was labelling a list that is self-evidently one.
          It stays in the flow as an empty strip because this and the chat pane's
          header are the ONLY window drag regions — see App.tsx. */}
      <header className="pane-head rail-head drag" />

      {notice && (
        <button
          className="rail-notice"
          onClick={() => setNotice(null)}
          data-tip="Dismiss this notice"
        >
          {notice}
        </button>
      )}

      {/* Cursor's nav block: the standing actions, above everything the list
          holds. Each row reveals its keybinding on hover — or on a ⌘ hold, which
          is now the app-wide way to see every shortcut at once — rather than
          carrying a permanent shortcut column, which is what keeps three rows of
          chrome from reading as a toolbar. */}
      <nav className="rail-nav">
        <button
          className="rail-nav-row"
          data-active={showPast || undefined}
          onClick={() => setShowPast((v) => !v)}
          data-tip={showPast ? 'Hide past sessions' : 'Resume or search past sessions'}
        >
          <Search size={14} />
          <span className="rail-nav-label">Search</span>
        </button>
        {/* `data-key` rather than the `.rail-key` span this used to render: one
            way to declare a shortcut, so ⌘ reveals this one alongside the dock's
            without a second mechanism to keep in step. */}
        <button
          className="rail-nav-row"
          onClick={() => void newSession()}
          {...hk('New conversation in this project', '⌘N')}
        >
          <Plus size={14} />
          <span className="rail-nav-label">New conversation</span>
        </button>
        {/* A Home row lived here, third. The dashboard it opened listed live
            sessions, recent projects and spend — all of which the rail itself
            already shows, or the session panel does. */}
      </nav>

      <div className="rail-list">
        {/* One section title over all the projects, the way Cursor heads its
            repository list — the per-project name is a row inside it, not a
            heading of its own. */}
        {groups.length > 0 && (
          <div className="rail-section-title">
            Projects
            <button
              className="rail-section-act"
              onClick={() => void openProject()}
              data-tip="Open another project"
              aria-label="Open another project"
            >
              <FolderPlus size={14} />
            </button>
            <button
              className="rail-section-act"
              onClick={() => setBranching(true)}
              data-tip="New agent in its own git worktree, on its own branch"
              aria-label="New worktree session"
            >
              <GitBranchPlus size={14} />
            </button>
          </div>
        )}

        {groups.map((g) => (
          /* Boxes one project's header with its rows, and deliberately has no
             CSS rule. It used to be load-bearing — a sticky header releases when
             its own PARENT scrolls past, so flat in .rail-list the last header
             would have stayed pinned over the history list below — but
             .rail-group-head is static now, so this is plain grouping. */
          <div className="rail-group" key={g.root}>
            {/* A row with a folder glyph, not a heading. Cursor lists each repo
                this way and nests its agents underneath — the count went with
                the heading, because the nested rows are right there to count. */}
            <div className="rail-group-head" title={g.root}>
              <FolderOpen size={14} />
              <span className="rail-group-name">
                {baseName(g.root) || g.root}
              </span>
              <button
                className="rail-section-act"
                onClick={() => void openPath(g.root)}
                data-tip="New conversation in this project"
                aria-label={`New conversation in ${g.root}`}
              >
                <Plus size={14} />
              </button>
            </div>
            {g.sessions.map((s) =>
              renaming === s.id ? (
                <input
                  key={s.id}
                  className="rename-input"
                  defaultValue={s.title}
                  autoFocus
                  onBlur={(e) => commitRename(s.id, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename(s.id, e.currentTarget.value)
                    if (e.key === 'Escape') setRenaming(null)
                  }}
                />
              ) : (
                <div key={s.id} className="rail-row">
                  <button
                    className="session"
                    // The `&& !home` guard is gone with the Home row: there is
                    // no longer a second thing that can be selected.
                    data-active={s.id === activeId}
                    onClick={() => select(s.id)}
                    onDoubleClick={() => setRenaming(s.id)}
                    onAuxClick={(e) => {
                      if (e.button === 1) void close(s.id)
                    }}
                    /* The base line only for a worktree row, and only when we
                       know it — see WorktreeInfo.base. It is the one fact about
                       a worktree session that has nowhere else to live once the
                       notice has been dismissed. */
                    title={[
                      tildePath(s.cwd, window.foreman.homeDir),
                      ...(s.worktree?.base ? [`Cut from ${s.worktree.base}`] : []),
                      'Double-click to rename',
                    ].join('\n')}
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
                          <GitBranch size={12} />
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

        {sessions.length === 0 && <p className="rail-note">No sessions yet.</p>}

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
                    title={tildePath(h.cwd ?? '', window.foreman.homeDir)}
                    // Without a cwd the transcript is read from the wrong
                    // project directory and comes back empty — the same reason
                    // this was disabled when the click meant resume.
                    disabled={!h.cwd}
                    onClick={() => preview(h.sessionId, h.cwd ?? '', h.summary.slice(0, 40))}
                  >
                    <span className="dot" />
                    <span className="session-body">
                      <span className="session-title">{h.summary}</span>
                      <span className="session-snippet">{h.snippet}</span>
                      <span className="session-sub">
                        {!scope && h.cwd && `${baseName(h.cwd)} · `}
                        {h.matches} match{h.matches === 1 ? '' : 'es'} · {when(h.lastModified)}
                      </span>
                    </span>
                  </button>
                ))
              : past.map((p) => (
                  <button
                    key={p.sessionId}
                    className="session"
                    title={tildePath(p.cwd ?? '', window.foreman.homeDir)}
                    onClick={() => preview(p.sessionId, p.cwd ?? '', p.summary.slice(0, 40))}
                    disabled={!p.cwd}
                  >
                    <span className="dot" />
                    <span className="session-body">
                      <span className="session-title">{p.summary}</span>
                      <span className="session-sub">
                        {/* Unscoped, the project is the thing that tells two
                            identically-named sessions apart — and scoped it is
                            redundant with the header. */}
                        {!scope && p.cwd && `${baseName(p.cwd)} · `}
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

      {/* ContextStrip and the rail footer lived here — model · context bar ·
          cost, and a lone Archive button.

          The context readout moved under the composer as a ring (see
          ContextRing), which is where Cursor keeps it and where it is next to
          the thing consuming the window. Archive went with it: it is a
          per-session action, and the session row's own hover × already does it
          without a second control at the other end of the rail. */}
    </aside>
  )
}
