import { useEffect, useState } from 'react'
import {
  Check,
  ChevronLeft,
  ChevronRight,
  MessageCircleQuestion,
  SkipForward,
  X,
} from 'lucide-react'
import type { PermissionRequest } from '../../../shared/types'
import { ANSWER_PREFIX, askQuestions, type AskQuestion } from '../derive.mts'
import Markdown from './Markdown'

/**
 * The agent's AskUserQuestion tool, rendered as actual choices — one question at
 * a time, in a modal.
 *
 * Paged rather than stacked because a flat list gave no answer to "where does
 * this question end and the next begin", especially once options carry markdown
 * previews. One question on screen makes that unaskable, and the dots in the
 * footer carry the position and progress the list used to imply.
 *
 * A modal for the same reason as PlanCard, whose frame this reuses: closing it
 * must NOT answer. The request stays parked in main, the transcript keeps a bar
 * to reopen from, and because only `open` flips, a half-finished set of
 * selections survives a close/reopen.
 *
 * Answering goes back as a permission *denial* carrying the selection as its
 * message. That sounds wrong and is in fact the only channel available:
 * allowing the tool simply runs it, and it reports "The user did not answer the
 * questions", because the CLI collects answers from its own interactive UI —
 * which does not exist in an SDK host. The deny message becomes the tool_result
 * the model reads, so the selection lands where the answer belongs.
 */
export default function QuestionCard({
  req,
  questions,
}: {
  req: PermissionRequest
  questions: AskQuestion[]
}): React.JSX.Element {
  const [open, setOpen] = useState(true)
  const [at, setAt] = useState(0)
  const [picked, setPicked] = useState<Record<number, string[]>>({})

  const toggle = (qi: number, label: string, multi: boolean): void =>
    setPicked((p) => {
      const cur = p[qi] ?? []
      if (!multi) return { ...p, [qi]: cur[0] === label ? [] : [label] }
      return {
        ...p,
        [qi]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label],
      }
    })

  const answered = questions.filter((_, i) => (picked[i] ?? []).length > 0).length
  const submit = (): void => {
    const lines = questions.map(
      (q, i) => `${q.question} → ${(picked[i] ?? []).join(', ') || '(no answer)'}`,
    )
    void window.foreman.respondPermission(
      req.requestId,
      'deny',
      `${ANSWER_PREFIX}\n${lines.join('\n')}`,
    )
  }
  const skip = (): void => void window.foreman.respondPermission(req.requestId, 'deny')

  const q = questions[at]
  const last = at === questions.length - 1
  const back = (): void => setAt((i) => Math.max(0, i - 1))
  const next = (): void => setAt((i) => Math.min(questions.length - 1, i + 1))

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setOpen(false)
        return
      }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        if (answered > 0) submit()
        return
      }
      // A focused option owns its own Enter/Space — without this, a keyboard
      // user tabbing onto an option would both pick it and advance the page.
      if (
        (e.key === 'Enter' || e.key === ' ') &&
        e.target instanceof HTMLElement &&
        e.target.closest('.ask-opt') !== null
      )
        return

      if (e.key === 'ArrowLeft') {
        back()
        return
      }
      if (e.key === 'ArrowRight' || e.key === 'Enter') {
        if (!last) next()
        else if (answered > 0) submit()
        return
      }
      // 1–9 pick the nth option on this page. Number keys rather than
      // arrows-plus-Enter because they sidestep the focus-versus-global-handler
      // conflict entirely, and they are what the CLI does.
      const n = Number(e.key)
      if (Number.isInteger(n) && n >= 1 && n <= q.options.length) {
        e.preventDefault()
        toggle(at, q.options[n - 1].label, Boolean(q.multiSelect))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // `picked`, `at` and `q` are read by submit/toggle — omitting them would
    // ship a stale closure that submits an out-of-date selection.
  }, [open, at, answered, picked, questions, last, q])

  return (
    <>
      <div className="plan-bar">
        <span className="plan-tag">Question</span>
        <span className="plan-bar-title" title={questions[0].question}>
          {questions[0].header || questions[0].question}
        </span>
        <button className="btn" data-variant="primary" onClick={() => setOpen(true)}>
          <MessageCircleQuestion size={14} />
          {answered ? `Answer (${answered}/${questions.length})` : 'Answer'}
        </button>
      </div>

      {open && (
        <div className="plan-scrim" onMouseDown={() => setOpen(false)}>
          <div
            className="plan-modal ask-modal"
            role="dialog"
            aria-label={q.question}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <header className="plan-head">
              {q.header && <span className="ask-tag">{q.header}</span>}
              <h2 className="plan-title">{q.question}</h2>
              {q.multiSelect && <span className="ask-multi">choose any</span>}
              <button
                className="plan-close"
                data-tip="Close — the questions stay pending, reopen from the transcript"
                data-tip-end=""
                aria-label="Close questions"
                onClick={() => setOpen(false)}
              >
                <X size={14} />
              </button>
            </header>

            <div className="plan-body">
              <div className="ask-q">
                {q.options.map((o, oi) => {
                  const on = (picked[at] ?? []).includes(o.label)
                  return (
                    <button
                      key={o.label}
                      className="ask-opt"
                      data-on={on ? '' : undefined}
                      onClick={() => toggle(at, o.label, Boolean(q.multiSelect))}
                    >
                      <span className="ask-key">{oi + 1}</span>
                      <span className="ask-opt-label">{o.label}</span>
                      {o.description && <span className="ask-opt-desc">{o.description}</span>}
                      {/* Previews are requested as markdown, not HTML, so they
                          render through the existing renderer, not innerHTML. */}
                      {o.preview && (
                        <span className="ask-preview">
                          <Markdown text={`\`\`\`\n${o.preview}\n\`\`\``} />
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            </div>

            <footer className="plan-actions">
              {/* Sits where .plan-path does, so .plan-buttons stays right-aligned
                  and .plan-actions needs no change of its own. */}
              <div className="ask-dots">
                {questions.map((_, i) => (
                  <button
                    key={i}
                    className="ask-dot"
                    data-on={i === at ? '' : undefined}
                    data-answered={(picked[i] ?? []).length > 0 ? '' : undefined}
                    aria-current={i === at ? 'step' : undefined}
                    aria-label={`Question ${i + 1} of ${questions.length}${
                      (picked[i] ?? []).length ? ', answered' : ''
                    }`}
                    onClick={() => setAt(i)}
                  />
                ))}
                <span className="ask-count">
                  {at + 1}/{questions.length}
                </span>
              </div>

              <div className="plan-buttons">
                <button className="btn" onClick={skip}>
                  <SkipForward size={14} />
                  Skip
                </button>
                <button className="btn" disabled={at === 0} onClick={back}>
                  <ChevronLeft size={14} />
                  Back
                </button>
                {last ? (
                  <button
                    className="btn"
                    data-variant="primary"
                    disabled={answered === 0}
                    onClick={submit}
                  >
                    <Check size={14} />
                    {answered < questions.length
                      ? `Answer (${answered}/${questions.length})`
                      : 'Answer'}
                  </button>
                ) : (
                  <button className="btn" data-variant="primary" onClick={next}>
                    Next
                    <ChevronRight size={14} />
                  </button>
                )}
              </div>
            </footer>
          </div>
        </div>
      )}
    </>
  )
}

export { askQuestions }
