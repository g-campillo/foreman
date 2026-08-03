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
import { pinToBottom } from '../scrollPin'
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

/** One question's answer: what was picked, what was typed, and any note. */
interface Answer {
  picked: string[]
  /** Free text, kept even while `otherOn` is false so toggling twice is lossless. */
  other: string
  /**
   * Whether the Other row is on.
   *
   * Separate from `other !== ''` on purpose: derived from the text, clearing the
   * field would silently untoggle the row mid-keystroke.
   */
  otherOn: boolean
  /** Optional per-question note. Only offered where an option has a preview. */
  note: string
}

const EMPTY: Answer = { picked: [], other: '', otherOn: false, note: '' }

/** Long enough for a real instruction, short enough that one answer cannot bury
 *  the rest of the payload. */
const MAX_FREE_TEXT = 500

/** One line, always. THE payload invariant: derive.answeredQuestions splits the
 *  result on '\n' and matches positionally, so a newline anywhere in an answer
 *  shifts every later question's answer by one. */
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()

/**
 * User-typed text, made safe to put on the right of the ' → '.
 *
 * The arrow rewrite is what turns the parser's guarantee from probabilistic into
 * airtight: it reads the LAST ' → ' on the line, so a question containing one is
 * already fine, but an arrow typed into a note or an Other answer would land to
 * the right of the real one and steal the split.
 */
const sanitize = (s: string): string => oneLine(s).replace(/ → /g, ' -> ').slice(0, MAX_FREE_TEXT)

export default function QuestionCard({
  req,
  questions,
}: {
  req: PermissionRequest
  questions: AskQuestion[]
}): React.JSX.Element {
  const [open, setOpen] = useState(true)
  const [at, setAt] = useState(0)
  const [answers, setAnswers] = useState<Record<number, Answer>>({})

  const ans = (qi: number): Answer => answers[qi] ?? EMPTY
  const patch = (qi: number, p: Partial<Answer>): void =>
    setAnswers((a) => ({ ...a, [qi]: { ...(a[qi] ?? EMPTY), ...p } }))

  const toggle = (qi: number, label: string, multi: boolean): void =>
    setAnswers((a) => {
      const cur = a[qi] ?? EMPTY
      // Single-select: a real option and Other are alternatives, so picking one
      // turns the other off. Multi-select: they coexist, which is the whole
      // point of "any of these, plus this thing I typed".
      if (!multi)
        return {
          ...a,
          [qi]: { ...cur, picked: cur.picked[0] === label ? [] : [label], otherOn: false },
        }
      return {
        ...a,
        [qi]: {
          ...cur,
          picked: cur.picked.includes(label)
            ? cur.picked.filter((l) => l !== label)
            : [...cur.picked, label],
        },
      }
    })

  const toggleOther = (qi: number, multi: boolean): void =>
    setAnswers((a) => {
      const cur = a[qi] ?? EMPTY
      const otherOn = !cur.otherOn
      return { ...a, [qi]: { ...cur, otherOn, picked: !multi && otherOn ? [] : cur.picked } }
    })

  /** A question counts as answered by a pick OR by non-empty free text. Used at
   *  every site that asks — the dots, the aria-label, the count and the button —
   *  or a free-text-only answer reads as unanswered and cannot be submitted. */
  const isAnswered = (qi: number): boolean => {
    const a = ans(qi)
    return a.picked.length > 0 || (a.otherOn && a.other.trim() !== '')
  }

  const answered = questions.filter((_, i) => isAnswered(i)).length
  /**
   * Human-readable prose, one line per question — deliberately not JSON.
   *
   * This string IS the tool_result the model reads, and it is a strict SUPERSET
   * of the format this card has always sent:
   *
   *     <question> → <a>, <b>, Other: <typed> — note: <note>
   *
   * Free text rides as a comma-joined item tagged `Other: ` so the model knows
   * it was typed rather than picked; the note appends to the RIGHT of the arrow,
   * where answeredQuestions' lastIndexOf(' → ') cannot see it. So the parser
   * needs no change and every transcript already recorded keeps parsing — which
   * matters because those get replayed on resume with no version marker to
   * branch on.
   */
  const submit = (): void => {
    // The answers land in the transcript as a user message, so this is the
    // user's own words arriving — the one case autoscroll follows unasked.
    pinToBottom()
    const lines = questions.map((q, i) => {
      const a = ans(i)
      const parts = a.picked.map(sanitize)
      if (a.otherOn && a.other.trim()) parts.push(`Other: ${sanitize(a.other)}`)
      const note = a.note.trim() ? ` — note: ${sanitize(a.note)}` : ''
      return `${oneLine(q.question)} → ${parts.join(', ') || '(no answer)'}${note}`
    })
    void window.foreman.respondPermission(req.requestId, 'deny', {
      message: `${ANSWER_PREFIX}\n${lines.join('\n')}`,
    })
  }
  const skip = (): void => void window.foreman.respondPermission(req.requestId, 'deny')

  const q = questions[at]
  const last = at === questions.length - 1
  const back = (): void => setAt((i) => Math.max(0, i - 1))
  const next = (): void => setAt((i) => Math.min(questions.length - 1, i + 1))

  /**
   * Keys inside a text field, for both textareas.
   *
   * stopPropagation is PlanCard's pattern verbatim and is non-negotiable: the
   * handler below is window-level, so without it a focused field would lose
   * every digit to the 1–9 shortcuts and every Enter to the pager.
   *
   * Escape blurs rather than closing, which is what makes Esc-Esc work: the
   * first press hands focus back, the second reaches the window handler and
   * closes the modal. Plain Enter inserts a newline — sanitize() collapses it to
   * a space on submit, so a multi-line answer is safe to type.
   */
  const fieldKeys = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    e.stopPropagation()
    if (e.key === 'Escape') e.currentTarget.blur()
    else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && answered > 0) submit()
  }

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      // Every key inside a text field belongs to the field. Both textareas call
      // stopPropagation() so this never fires for them; it is the safety net for
      // any field added later, and the failure it prevents is silent — typing
      // "3 things" into a note would pick option 3.
      //
      // The contentEditable arm is not hypothetical: the composer is CodeMirror,
      // which is neither a textarea nor an input, so with a question modal up and
      // focus left in the composer, typing a digit toggled an option.
      if (
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLInputElement ||
        (e.target instanceof HTMLElement && e.target.isContentEditable)
      )
        return

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
      // A letter for Other, not a number. 1–9 stay bound to real options — the
      // numbering beside each one and the bound below are unchanged — so no
      // muscle memory breaks and Other never renumbers the list.
      if ((e.key === 'o' || e.key === 'O') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        toggleOther(at, Boolean(q.multiSelect))
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
    // `answers`, `at` and `q` are read by submit/toggle — omitting them would
    // ship a stale closure that submits an out-of-date selection.
  }, [open, at, answered, answers, questions, last, q])

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
                aria-label="Close questions"
                onClick={() => setOpen(false)}
              >
                <X size={14} />
              </button>
            </header>

            <div className="plan-body">
              <div className="ask-q">
                {q.options.map((o, oi) => {
                  const on = ans(at).picked.includes(o.label)
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

                {/* A sibling pair, not a nested field: .ask-opt is a <button>
                    and a <button> cannot contain an <input>. Structurally the
                    same shape as PlanCard's `writing` gate. */}
                <div className="ask-other">
                  <button
                    className="ask-opt"
                    data-on={ans(at).otherOn ? '' : undefined}
                    onClick={() => toggleOther(at, Boolean(q.multiSelect))}
                  >
                    <span className="ask-key">O</span>
                    <span className="ask-opt-label">Other</span>
                    <span className="ask-opt-desc">
                      {q.multiSelect
                        ? 'Type your own, alongside anything picked above.'
                        : 'Type your own answer instead.'}
                    </span>
                  </button>
                  {ans(at).otherOn && (
                    <textarea
                      className="ask-other-input"
                      autoFocus
                      rows={2}
                      placeholder="Your answer, in your own words."
                      value={ans(at).other}
                      onChange={(e) => patch(at, { other: e.target.value })}
                      onKeyDown={fieldKeys}
                    />
                  )}
                </div>

                {/* Only where an option renders a preview. That is not a guess
                    about when a note is useful: the real AskUserQuestion schema
                    carries `annotations` keyed by question text with
                    {notes, preview}, so notes are a per-question companion to
                    exactly these. */}
                {q.options.some((o) => o.preview) && (
                  <label className="ask-note">
                    Note (optional)
                    <textarea
                      className="ask-other-input"
                      rows={2}
                      placeholder="Anything the agent should know about this choice."
                      value={ans(at).note}
                      onChange={(e) => patch(at, { note: e.target.value })}
                      onKeyDown={fieldKeys}
                    />
                  </label>
                )}
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
                    data-answered={isAnswered(i) ? '' : undefined}
                    aria-current={i === at ? 'step' : undefined}
                    aria-label={`Question ${i + 1} of ${questions.length}${
                      isAnswered(i) ? ', answered' : ''
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
