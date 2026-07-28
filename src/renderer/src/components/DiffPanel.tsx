import { useCallback, useEffect, useRef, useState } from 'react'
import { GitCommitHorizontal, Undo2 } from 'lucide-react'
import type { FileDiff, SessionMeta } from '../../../shared/types'
import { useStore } from '../store'
import DiffLines from './DiffLines'

/** How often to re-read git while the panel is on screen. */
const POLL_MS = 4000

export default function DiffPanel({
  session,
  visible,
}: {
  session: SessionMeta
  visible: boolean
}): React.JSX.Element {
  const [diffs, setDiffs] = useState<FileDiff[]>([])
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  // Paths explicitly UNticked. Tracking exclusions rather than inclusions means
  // a file the agent touches mid-review is included by default, which matches
  // what "commit these changes" means to someone looking at a finished list.
  const [excluded, setExcluded] = useState<Record<string, boolean>>({})
  const [message, setMessage] = useState('')
  const [committing, setCommitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const bump = useStore((s) => s.diffCounts[session.id] ?? 0)
  const status = session.status

  const refresh = useCallback(
    () => window.foreman.listDiffs(session.id, session.cwd).then(setDiffs),
    [session.id, session.cwd],
  )

  // Nothing here is deliberately NOT gated on `visible`: this component is
  // mounted for the life of a session, so these are also what keep the badge
  // honest before the panel is ever opened.

  // The agent's PostToolUse hook bumps the count; a settled turn is the other
  // moment the tree is most likely to have changed.
  useEffect(() => {
    void refresh()
  }, [refresh, bump, status])

  // Committed or edited from an external shell — no hook, no event, so the
  // return to the window is the signal.
  useEffect(() => {
    const onFocus = (): void => void refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  // The embedded terminal changes files without a focus event or a hook, so the
  // open panel polls. Self-chaining rather than setInterval, so a slow refresh
  // on a large working set can't stack requests on top of itself.
  // ponytail: 4s poll while open. Watch <root>/.git/index if it ever drags.
  const timer = useRef<number>(0)
  useEffect(() => {
    if (!visible) return
    let live = true
    const tick = (): void => {
      void refresh().finally(() => {
        if (live) timer.current = window.setTimeout(tick, POLL_MS)
      })
    }
    timer.current = window.setTimeout(tick, POLL_MS)
    return () => {
      live = false
      window.clearTimeout(timer.current)
    }
  }, [visible, refresh])

  const picked = diffs.filter((d) => !excluded[d.path])

  async function commit(): Promise<void> {
    setCommitting(true)
    setError(null)
    const res = await window.foreman.commitFiles(
      session.id,
      session.cwd,
      picked.map((d) => d.path),
      message,
    )
    setCommitting(false)
    if (!res.ok) {
      setError(res.error ?? 'Commit failed.')
      return
    }
    setMessage('')
    setExcluded({})
    void refresh()
  }

  if (diffs.length === 0) {
    return (
      <div className="empty">
        <h2>Nothing to commit</h2>
        <p>This panel mirrors `git status` — it&rsquo;s empty because your tree is clean.</p>
      </div>
    )
  }

  const totalAdd = diffs.reduce((n, d) => n + d.added, 0)
  const totalDel = diffs.reduce((n, d) => n + d.removed, 0)

  return (
    <>
      <div
        className="pane-head"
        style={{ borderBottom: '1px solid rgb(var(--border))', height: 34 }}
      >
        <span>
          {diffs.length} file{diffs.length === 1 ? '' : 's'}
        </span>
        <span className="diff-stat">
          <span className="a">+{totalAdd}</span> <span className="d">−{totalDel}</span>
        </span>
        <span className="spacer" />
        {/* "Mark reviewed" used to live here. It meant "forget these snapshots",
            which no longer exists as a concept — the next refresh reads git and
            brings everything straight back. Commit or revert are the real verbs. */}
      </div>

      <div className="commit-bar">
        <input
          className="commit-msg"
          placeholder={
            picked.length
              ? `Commit ${picked.length} file${picked.length === 1 ? '' : 's'}…`
              : 'Tick a file to commit'
          }
          value={message}
          disabled={picked.length === 0}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            // Enter commits; it's a single-line field, so there's nothing else
            // for the key to mean, and the button stays for discoverability.
            if (e.key === 'Enter' && !committing && message.trim() && picked.length) void commit()
          }}
        />
        <button
          className="btn"
          data-variant="accent"
          disabled={committing || !message.trim() || picked.length === 0}
          onClick={() => void commit()}
          data-tip={
            session.worktree
              ? `Commit the ticked files to ${session.worktree.branch}`
              : 'Commit the ticked files'
          }
        >
          <GitCommitHorizontal size={14} />
          {committing ? 'Committing…' : 'Commit'}
        </button>
      </div>
      {error && <div className="commit-error">{error}</div>}

      <div className="diff-scroll">
        {diffs.map((d) => (
          <div className="diff-file" key={d.path}>
            <div className="diff-file-head">
              <input
                type="checkbox"
                className="diff-pick"
                checked={!excluded[d.path]}
                data-tip="Include in the next commit"
                onChange={(e) =>
                  setExcluded((x) => ({ ...x, [d.path]: !e.target.checked }))
                }
              />
              <button
                className="diff-path"
                onClick={() => setCollapsed((c) => ({ ...c, [d.path]: !c[d.path] }))}
                title={d.path}
              >
                {/* RTL truncation keeps the filename visible on long paths */}
                {d.relPath}
              </button>
              <span className="diff-stat">
                <span className="a">+{d.added}</span> <span className="d">−{d.removed}</span>
              </span>
              <button
                className="btn"
                style={{ padding: '2px 7px', fontSize: 11 }}
                onClick={() => {
                  void window.foreman.revertFile(session.id, session.cwd, d.path).then(refresh)
                }}
                // This discards YOUR uncommitted work too, not just the agent's
                // — the panel mirrors git now. The diff above the button is the
                // confirmation; there is no second dialog.
                data-tip={
                  d.before === null
                    ? 'Delete this new file'
                    : 'Discard all uncommitted changes to this file — yours as well as the agent\'s'
                }
              >
                <Undo2 size={12} />
                Revert
              </button>
            </div>

            {!collapsed[d.path] &&
              (d.note ? (
                <div className="diff-note">{d.note}</div>
              ) : (
                /* No `lang` here, deliberately, and the tool cards do pass one.
                   This call is UNCAPPED — no maxLines — and refresh() rebuilds
                   brand-new FileDiff objects from IPC every POLL_MS, so a
                   useMemo keyed on d.hunks is busted four times a minute. That
                   would re-tokenize the entire working set forever, for a panel
                   whose job is reviewing what changed rather than reading code.
                   The ask was highlighting in the chat area; this is not it. */
                <DiffLines hunks={d.hunks} />
              ))}
          </div>
        ))}
      </div>
    </>
  )
}
