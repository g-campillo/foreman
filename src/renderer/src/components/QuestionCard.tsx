import { useState } from 'react'
import { Check, SkipForward } from 'lucide-react'
import type { PermissionRequest } from '../../../shared/types'
import { ANSWER_PREFIX, askQuestions, type AskQuestion } from '../derive.mts'
import Markdown from './Markdown'

/**
 * The agent's AskUserQuestion tool, rendered as actual choices.
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

  return (
    <div className="ask">
      {questions.map((q, qi) => (
        <div key={qi} className="ask-q">
          <div className="ask-head">
            {q.header && <span className="ask-tag">{q.header}</span>}
            <span>{q.question}</span>
            {q.multiSelect && <span className="ask-multi">choose any</span>}
          </div>

          {q.options.map((o) => {
            const on = (picked[qi] ?? []).includes(o.label)
            return (
              <button
                key={o.label}
                className="ask-opt"
                data-on={on ? '' : undefined}
                onClick={() => toggle(qi, o.label, Boolean(q.multiSelect))}
              >
                <span className="ask-opt-label">{o.label}</span>
                {o.description && <span className="ask-opt-desc">{o.description}</span>}
                {/* Previews are requested as markdown, not HTML, so they render
                    through the existing renderer instead of raw innerHTML. */}
                {o.preview && (
                  <span className="ask-preview">
                    <Markdown text={`\`\`\`\n${o.preview}\n\`\`\``} />
                  </span>
                )}
              </button>
            )
          })}
        </div>
      ))}

      <div className="ask-actions">
        <button
          className="btn"
          onClick={() => void window.foreman.respondPermission(req.requestId, 'deny')}
        >
          <SkipForward size={14} />
          Skip
        </button>
        <button
          className="btn"
          data-variant="primary"
          disabled={answered === 0}
          onClick={submit}
        >
          <Check size={14} />
          {answered < questions.length ? `Answer (${answered}/${questions.length})` : 'Answer'}
        </button>
      </div>
    </div>
  )
}

export { askQuestions }
