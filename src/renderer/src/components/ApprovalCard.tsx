import { useEffect, useMemo, useState } from 'react'
import { Ban, Check, FileCode2 } from 'lucide-react'
import type { DiffHunk, PermissionRequest } from '../../../shared/types'
import { toHunks } from '../../../shared/diff.mts'
import { focusTarget, relPath } from '../derive.mts'
import { useStore } from '../store'
import { summarise } from './ToolCard'
import DiffLines from './DiffLines'

/**
 * The approval prompt — now showing what it is asking you to approve.
 *
 * It used to render `summarise()` alone: "Allow Write? src/config.ts". You were
 * approving a file write sight unseen. It now renders the actual diff, and for
 * a Write it lets you accept only part of it.
 *
 * THIS CARD IS NEVER REPLACED BY ANYTHING. The editor is an additional surface,
 * never a substitute — a prompt answerable only somewhere the user might not
 * have open is a prompt that can be lost. main/index.ts hides the window rather
 * than destroying it on ⌘W for exactly this reason, and `pendingRequests()`
 * re-seeds these after a reload. Everything the editor can do, this can do.
 *
 * Per-hunk is offered only where it is EXPRESSIBLE, which is narrower than the
 * plan assumed:
 *
 *   Write — yes. The input is the whole file, so accepted hunks recompose into
 *           a new `content`. Verified end to end: two proposed changes,
 *           approving one, and the rejected line stayed at its original value.
 *   Edit  — no. One old_string and one new_string is a single atom with nothing
 *           to subset, so no ticks are drawn and the UI does not pretend. Same
 *           refusal DiffLines already makes by rendering an Edit preview with
 *           numbers={false}, since those strings are fragments.
 *   MultiEdit — the plan expected this to be the main case. It DOES NOT EXIST
 *           in @anthropic-ai/claude-agent-sdk@0.3.220: zero occurrences in
 *           sdk.d.ts, and a live agent reports it is not among its tools. The
 *           subsetting code is kept because it is tested and costs nothing, and
 *           this codebase already carries MultiEdit branches elsewhere for the
 *           same reason — but nothing reaches it today.
 */
export default function ApprovalCard({ req }: { req: PermissionRequest }): React.JSX.Element {
  const gist = summarise(req.toolName, req.input)
  const openFile = useStore((s) => s.openFile)
  const cwd = useStore((s) => s.sessions.find((x) => x.id === req.sessionId)?.cwd ?? '')
  const [before, setBefore] = useState<string | null>(null)
  /** Hunks the user has UNticked. Tracks rejections rather than acceptances, so
   *  everything is accepted by default and nothing is silently off. */
  const [rejected, setRejected] = useState<Set<number>>(new Set())

  const target = useMemo(() => focusTarget(req.toolName, req.input), [req.toolName, req.input])
  const path = target?.path ?? ''
  const proposed = typeof req.input.content === 'string' ? req.input.content : null
  const partial = req.toolName === 'Write' && proposed !== null

  // Read what is on disk, so the diff is against reality rather than a guess.
  useEffect(() => {
    if (!partial || !path || !cwd) return
    let cancelled = false
    void window.foreman.readFile(cwd, path).then((res) => {
      if (!cancelled) setBefore(res.ok ? res.text : '')
    })
    return () => {
      cancelled = true
    }
  }, [partial, path, cwd])

  const hunks: DiffHunk[] | null = useMemo(() => {
    if (partial && before !== null && proposed !== null) return toHunks(before, proposed, path)
    if (req.toolName === 'Edit') {
      const i = req.input as Record<string, unknown>
      const o = typeof i.old_string === 'string' ? i.old_string : ''
      const n = typeof i.new_string === 'string' ? i.new_string : ''
      return o || n ? toHunks(o, n, path) : null
    }
    return null
  }, [partial, before, proposed, path, req.toolName, req.input])

  const tickable = partial && hunks !== null && hunks.length > 1

  const respond = (behavior: 'allow' | 'deny'): void => {
    // Indices, never content. The host subsets its OWN copy of the input, so
    // this can only ever remove something the agent proposed — never add or
    // alter one. Tighten-only, never widen.
    const keep = tickable
      ? hunks.map((_, n) => n).filter((n) => !rejected.has(n))
      : undefined
    void window.foreman.respondPermission(req.requestId, behavior, undefined, undefined, keep)
  }

  const kept = hunks ? hunks.length - rejected.size : 0

  return (
    <div className="approval">
      <div className="approval-title">
        Allow <code>{req.toolName}</code>?
      </div>
      {gist && <div className="approval-input">{gist}</div>}

      {hunks?.map((h, n) => (
        <div key={n} className="approval-hunk" data-off={tickable && rejected.has(n) ? '' : undefined}>
          {tickable && (
            <label className="approval-tick">
              <input
                type="checkbox"
                checked={!rejected.has(n)}
                onChange={() =>
                  setRejected((r) => {
                    const next = new Set(r)
                    if (next.has(n)) next.delete(n)
                    else next.add(n)
                    return next
                  })
                }
              />
              <span>Hunk {n + 1}</span>
            </label>
          )}
          <DiffLines hunks={[h]} numbers={partial} maxLines={14} />
        </div>
      ))}

      <div className="approval-actions">
        {/* Both keep their words: these grant or refuse a real permission, and
            an icon-only Allow beside an icon+text Deny reads as a bug. */}
        <button className="btn" data-variant="primary" onClick={() => respond('allow')}>
          <Check size={14} />
          {tickable && rejected.size ? `Allow ${kept} of ${hunks.length}` : 'Allow'}
        </button>
        <button className="btn" data-variant="danger" onClick={() => respond('deny')}>
          <Ban size={14} />
          Deny
        </button>
        {/* Opens the file so the change can be read in context. Deliberately
            does NOT answer the prompt: reading before deciding must not mean
            deciding, which is the rule PlanCard's modal already follows. */}
        {target && (
          <button
            className="btn approval-open"
            title="Open the file. This does not answer the prompt."
            onClick={() => openFile(target.path, target.line ?? undefined)}
          >
            <FileCode2 size={14} />
            {relPath(target.path, cwd)}
          </button>
        )}
      </div>
    </div>
  )
}
