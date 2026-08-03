import { useCallback, useEffect, useState } from 'react'
import { GitBranch, RefreshCw, Trash2, TriangleAlert } from 'lucide-react'
import type { WorktreeReport } from '../../../shared/types'
import { activeSession, useStore } from '../store'
import { baseName, tildePath } from '../derive.mts'

/**
 * This project's worktrees: what git has registered, what is left over, and what
 * can safely go.
 *
 * IN SETTINGS, as the second category about the PROJECT rather than the app —
 * `lsp` above it is the first, and its self-fetching, propless shape is the one
 * this copies. Not SessionPanel: that panel's own docblock says it is
 * per-session and read-only, and this is neither.
 *
 * PRUNE IS NEVER AUTOMATIC, and that is the whole reason it is a button here
 * rather than a line in `createWorktree`. `git worktree prune` unregisters the
 * admin entries the CLI's own `--resume` fallback scans, so pruning under a live
 * worktree session is what turns its next message into a re-home. Recoverable —
 * see `rehome` — but not something to do to someone silently, which is why the
 * in-use rows are named before the button is pressed rather than after.
 */
export default function Worktrees(): React.JSX.Element {
  const session = useStore(activeSession)
  const setNotice = useStore((s) => s.setNotice)
  const [report, setReport] = useState<WorktreeReport | null>(null)
  const [busy, setBusy] = useState(false)
  // The PROJECT, not the checkout: from a worktree session `cwd` is one of the
  // rows this panel is listing, and every git call here belongs to the repo.
  const cwd = session?.worktree?.repoRoot ?? session?.cwd

  const load = useCallback(async () => {
    if (!cwd) return
    setReport(await window.foreman.listWorktrees(cwd))
  }, [cwd])

  useEffect(() => {
    void load()
  }, [load])

  const prune = async (): Promise<void> => {
    if (!cwd) return
    setBusy(true)
    const r = await window.foreman.pruneWorktrees(cwd)
    if (!r.ok && r.error) setNotice(r.error)
    await load()
    setBusy(false)
  }

  const remove = async (path: string): Promise<void> => {
    if (!cwd) return
    setBusy(true)
    const r = await window.foreman.removeOrphanWorktree(cwd, path)
    // The refusal IS the feature, exactly as it is for a branch checkout: git's
    // reasons ("2 uncommitted changes at …") are better than anything we could
    // write over them, and a removal that silently did nothing is worse.
    if (!r.removed && r.reason) setNotice(r.reason)
    await load()
    setBusy(false)
  }

  if (!cwd) return <div className="lsp-empty">Open a project to see its worktrees.</div>
  if (!report) return <div className="lsp-empty">Reading…</div>
  if (!report.root) return <div className="lsp-empty">This project is not a git repository.</div>

  const stale = report.rows.filter((r) => r.prunable)
  const inUse = report.rows.filter((r) => r.inUse && !r.main)

  return (
    <div className="lsp-list">
      <div className="lsp-head">
        <span>
          Each worktree is a separate checkout under <code>.worktrees/</code>, so parallel
          agents can edit the same files without colliding. Pruning drops git&apos;s record of
          checkouts whose directories are gone.
        </span>
        <button className="btn" disabled={busy || stale.length === 0} onClick={() => void prune()}>
          <RefreshCw size={12} />
          {busy ? 'Working…' : stale.length ? `Prune ${stale.length}` : 'Nothing to prune'}
        </button>
      </div>

      {/* BEFORE the button is pressed, not after. Pruning unregisters exactly
          what the CLI resolves `--resume` against, so a conversation standing in
          one of these directories comes back re-homed to the project root on its
          next message rather than where it was. */}
      {inUse.length > 0 && stale.length > 0 && (
        <div className="lsp-row" data-state="unconfigured">
          <span className="lsp-icon">
            <TriangleAlert size={12} />
          </span>
          <div className="lsp-row-body">
            <div className="lsp-detail">
              {inUse.length === 1 ? 'One conversation is' : `${inUse.length} conversations are`}{' '}
              working in these directories. Pruning moves{' '}
              {inUse.length === 1 ? 'it' : 'them'} to the project root on the next message —
              nothing is lost, but the agent stops being isolated.
            </div>
          </div>
        </div>
      )}

      {/* No `data-state` on a healthy row, deliberately: the states this
          stylesheet defines are green for "working" and amber for "needs you",
          and a green row per checkout would make an ordinary three-agent project
          read as an alert board. A worktree that is fine is furniture. */}
      {report.rows.map((r) => (
        <div
          key={r.path}
          className="lsp-row"
          data-state={r.orphan || r.prunable ? 'unconfigured' : undefined}
        >
          <span className="lsp-icon">
            <GitBranch size={12} />
          </span>
          <div className="lsp-row-body">
            {/* A missing branch means two different things and only one of them
                is "detached", which in git names a specific state — a checkout
                sitting on a commit rather than a ref. That is what a REGISTERED
                row with no branch is, and git said so. An orphan has no branch
                because git has no record of it at all, so its directory name is
                the only name it has. */}
            <div className="lsp-row-title">
              {r.branch ?? (r.orphan ? baseName(r.path) : 'detached')}
              {r.main && <span className="lsp-ext">the repository</span>}
              {r.inUse && <span className="lsp-ext">in use</span>}
            </div>
            <div className="lsp-detail">{tildePath(r.path, window.foreman.homeDir)}</div>
            {r.prunable && (
              <div className="lsp-detail lsp-hint">
                The directory is gone; git still has its entry. Prune clears it.
              </div>
            )}
            {r.orphan && (
              <div className="lsp-cmd">
                <span className="lsp-detail lsp-hint">
                  A leftover checkout git no longer knows about. Prune cannot collect it.
                </span>
                {/* Disabled rather than hidden, and refused again in main: an
                    agent is standing in this directory, and deleting it under
                    the process would produce exactly the failure this whole
                    batch exists to remove. */}
                <button
                  className="btn"
                  disabled={busy || r.inUse}
                  onClick={() => void remove(r.path)}
                >
                  <Trash2 size={12} />
                  {r.inUse ? 'In use' : 'Delete'}
                </button>
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}
