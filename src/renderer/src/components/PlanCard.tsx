import { useEffect, useState } from 'react'
import { Check, ChevronLeft, FileText, Pencil, SendHorizontal, Users, X, Zap } from 'lucide-react'
import type { PermissionMode, PermissionRequest } from '../../../shared/types'
import { PLAN_FEEDBACK_PREFIX, planTitle, tildePath, type PlanProposal } from '../derive.mts'
import { pinToBottom } from '../scrollPin'
import Markdown from './Markdown'

/**
 * The agent's finished plan, rendered as the thing it is.
 *
 * ExitPlanMode *is* the approval prompt — the CLI has no separate one — so this
 * replaces the "Allow ExitPlanMode?" card, which showed a 20KB plan as escaped
 * JSON and offered Allow/Deny with no hint that Deny meant "keep planning".
 *
 * Four exits, matching the CLI's own:
 *  - approve, and auto-accept the edits that follow
 *  - approve, and keep approving each edit by hand
 *  - approve, and hand the work to subagents (implement / review / test)
 *  - send feedback, which leaves the session in plan mode for a revision
 *
 * A modal rather than an inline card because plans run to tens of kilobytes;
 * closing it leaves the request pending and the transcript keeps a bar to
 * reopen from, so reading the code before deciding doesn't mean answering first.
 */
export default function PlanCard({
  req,
  plan,
}: {
  req: PermissionRequest
  plan: PlanProposal
}): React.JSX.Element {
  const [open, setOpen] = useState(true)
  const [feedback, setFeedback] = useState('')
  const [writing, setWriting] = useState(false)
  const title = planTitle(plan.markdown)

  // The two positionals plus an options bag — respondPermission grew its seventh
  // argument (`alwaysAllow`), which is exactly what the note that used to sit
  // here said would be the moment to collapse them.
  const approve = (mode: PermissionMode, subagents?: boolean): void => {
    void window.foreman.respondPermission(req.requestId, 'allow', { setMode: mode, subagents })
  }
  const revise = (): void => {
    if (!feedback.trim()) return
    // Feedback is the user's own words entering the transcript — unlike
    // `approve` above, which adds nothing of theirs and so must not move the
    // view out from under someone reading the plan they just approved.
    pinToBottom()
    void window.foreman.respondPermission(req.requestId, 'deny', {
      message: `${PLAN_FEEDBACK_PREFIX}\n\n${feedback.trim()}`,
    })
  }

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      // Only when the feedback box doesn't want it: Escape there should close
      // the box, and ⌘↵ there should send rather than fight the global handler.
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  return (
    <>
      <div className="plan-bar">
        <span className="plan-tag">Plan</span>
        <span className="plan-bar-title" title={title}>
          {title}
        </span>
        <button className="btn" data-variant="primary" onClick={() => setOpen(true)}>
          <FileText size={14} />
          Review plan
        </button>
      </div>

      {open && (
        <div className="plan-scrim" onMouseDown={() => setOpen(false)}>
          <div
            className="plan-modal"
            role="dialog"
            aria-label={title}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <header className="plan-head">
              <span className="plan-tag">Plan</span>
              <h2 className="plan-title">{title}</h2>
              <button
                className="plan-close"
                data-tip="Close — the plan stays pending, reopen from the transcript"
                aria-label="Close plan"
                onClick={() => setOpen(false)}
              >
                <X size={14} />
              </button>
            </header>

            <div className="plan-body">
              <Markdown text={plan.markdown} />
            </div>

            <footer className="plan-actions" data-writing={writing ? '' : undefined}>
              {writing ? (
                <>
                  <textarea
                    className="plan-feedback"
                    autoFocus
                    rows={3}
                    placeholder="What should change? The agent stays in plan mode and revises."
                    value={feedback}
                    onChange={(e) => setFeedback(e.target.value)}
                    onKeyDown={(e) => {
                      e.stopPropagation()
                      if (e.key === 'Escape') setWriting(false)
                      else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) revise()
                    }}
                  />
                  <div className="plan-buttons">
                    {/* Back keeps its word for row balance — a lone ‹ beside
                        "Send feedback" reads as a broken glyph. */}
                    <button className="btn" onClick={() => setWriting(false)}>
                      <ChevronLeft size={14} />
                      Back
                    </button>
                    <button
                      className="btn"
                      data-variant="primary"
                      disabled={!feedback.trim()}
                      onClick={revise}
                    >
                      <SendHorizontal size={14} />
                      Send feedback
                    </button>
                  </div>
                </>
              ) : (
                <>
                  {/* The path was a one-off `^.*\/\.claude\/` rewrite, which
                      only ever worked for a plan written under ~/.claude and
                      silently did nothing for one written anywhere else.
                      tildePath subsumes it and is right for both. */}
                  {plan.filePath && (
                    <span className="plan-path" title={plan.filePath}>
                      {tildePath(plan.filePath, window.foreman.homeDir)}
                    </span>
                  )}
                  <div className="plan-buttons">
                    {/* All four keep their words. THREE of them are Approve —
                        telling those apart by glyph alone is a coin flip on an
                        irreversible choice. */}
                    <button className="btn" onClick={() => setWriting(true)}>
                      <Pencil size={14} />
                      Request changes
                    </button>
                    <button className="btn" onClick={() => approve('default')}>
                      <Check size={14} />
                      Approve · ask per edit
                    </button>
                    <button
                      className="btn"
                      onClick={() => approve('acceptEdits')}
                      data-tip="Approve, and stop asking about each edit"
                    >
                      <Zap size={14} />
                      Approve · auto-accept
                    </button>
                    {/* Same acceptEdits as the button beside it, plus a directive
                        that reaches the model through a PostToolUse hook. Not a
                        checkbox crossed with the other two: a delegated run that
                        stopped on every implementer edit would defeat the point
                        of delegating it, so this is genuinely a third approve. */}
                    <button
                      className="btn"
                      data-variant="primary"
                      onClick={() => approve('acceptEdits', true)}
                      data-tip="Approve, and have subagents implement it, review it against the plan, and run the tests"
                    >
                      <Users size={14} />
                      Approve · subagents
                    </button>
                  </div>
                </>
              )}
            </footer>
          </div>
        </div>
      )}
    </>
  )
}
