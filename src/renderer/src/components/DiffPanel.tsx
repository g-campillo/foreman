import { useCallback, useEffect, useState } from 'react'
import { ClipboardCheck, GitCommitHorizontal, Undo2 } from 'lucide-react'
import type { FileDiff, SessionMeta } from '../../../shared/types'
import { useStore } from '../store'

export default function DiffPanel({ session }: { session: SessionMeta }): React.JSX.Element {
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

  const refresh = useCallback(() => {
    void window.foreman.listDiffs(session.id, session.cwd).then(setDiffs)
  }, [session.id, session.cwd])

  // Re-read on new snapshots and whenever a turn settles — the agent may have
  // written several times to a file we already had a baseline for.
  useEffect(refresh, [refresh, bump, status])

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
    refresh()
  }

  if (diffs.length === 0) {
    return (
      <div className="empty">
        <h2>No changes yet</h2>
        <p>Edits the agent makes will show up here.</p>
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
        <button
          className="btn"
          style={{ padding: '3px 8px' }}
          onClick={() => {
            void window.foreman.clearDiffs(session.id).then(refresh)
          }}
          title="Forget these changes without touching the files"
        >
          <ClipboardCheck size={14} />
          Mark reviewed
        </button>
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
          title={
            session.worktree
              ? `Commit to ${session.worktree.branch}`
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
                title="Include in the next commit"
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
                  void window.foreman.revertFile(session.id, d.path).then(refresh)
                }}
                title={d.before === null ? 'Delete this new file' : 'Restore original contents'}
              >
                <Undo2 size={12} />
                Revert
              </button>
            </div>

            {!collapsed[d.path] && (
              <div className="diff-body">
                {d.hunks.map((h, hi) => (
                  <div key={hi}>
                    <div className="diff-hunk-head">
                      @@ −{h.oldStart} +{h.newStart} @@
                    </div>
                    {h.lines.map((l, li) => (
                      <div className="diff-line" data-t={l.type} key={li}>
                        <span className="diff-no">{l.oldNo ?? ''}</span>
                        <span className="diff-no">{l.newNo ?? ''}</span>
                        <span className="diff-sign">
                          {l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' '}
                        </span>
                        <span className="diff-text">{l.text || ' '}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  )
}
