import { Children, useState } from 'react'
import type { ChatItem } from '../../../shared/types'
import { ANSWER_PREFIX, askQuestions } from '../derive.mts'

type Tool = Extract<ChatItem, { kind: 'tool' }>

/** One-line gist of a tool call, so the card reads without expanding. */
export function summarise(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const i = input as Record<string, unknown>
  const str = (k: string): string | null => (typeof i[k] === 'string' ? (i[k] as string) : null)

  switch (name) {
    case 'Bash':
      return str('command') ?? ''
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
      return str('file_path') ?? ''
    case 'NotebookEdit':
      return str('notebook_path') ?? ''
    case 'Glob':
    case 'Grep':
      return str('pattern') ?? ''
    case 'WebFetch':
      return str('url') ?? ''
    // The subagent tool reports as 'Agent' on the wire; 'Task' is kept because
    // that is what it is called everywhere else, including older transcripts.
    // Without this the default branch falls through to `prompt` and puts the
    // subagent's entire instructions in the card's one-line gist.
    case 'Agent':
    case 'Task': {
      const desc = str('description')
      const kind = str('subagent_type')
      return desc && kind ? `${kind}: ${desc}` : (desc ?? kind ?? '')
    }
    default: {
      // The question set is the whole input, so the generic fallback would put
      // raw JSON in the gist of the one card the user is being asked to read.
      const questions = askQuestions(name, input)
      if (questions) return questions.map((q) => q.header || q.question).join(' · ')
      const first = str('file_path') ?? str('path') ?? str('query') ?? str('prompt')
      return first ?? JSON.stringify(i).slice(0, 120)
    }
  }
}

const ICON: Record<Tool['status'], string> = { pending: '○', done: '●', error: '✕' }

export default function ToolCard({
  item,
  children,
}: {
  item: Tool
  /** A subagent's nested transcript, when this card is a Task that spawned one. */
  children?: React.ReactNode
}): React.JSX.Element {
  // null means "not touched yet", which is what lets the default depend on
  // whether there's a subagent to watch while still honouring a click either way.
  const [open, setOpen] = useState<boolean | null>(null)
  const nested = Children.count(children) > 0
  const isOpen = open ?? nested
  const gist = summarise(item.name, item.input)
  // An answered question comes back flagged is_error, because the answer had to
  // travel as a permission deny — see ANSWER_PREFIX. It succeeded; don't paint
  // it as a failure. A skipped one has no answer text and stays an error.
  const status = item.status === 'error' && item.result?.startsWith(ANSWER_PREFIX)
    ? 'done'
    : item.status

  return (
    <div className="tool" data-nested={nested ? '' : undefined}>
      <button className="tool-head" onClick={() => setOpen(!isOpen)}>
        <span
          style={{
            color:
              status === 'error'
                ? 'rgb(var(--danger))'
                : status === 'done'
                  ? 'rgb(var(--ok))'
                  : 'rgb(var(--text-faint))',
          }}
        >
          {ICON[status]}
        </span>
        <span className="tool-name">{item.name}</span>
        {/* The rolling summary is the more useful line once there is one, and it
            replaces the gist rather than crowding it — the gist is the Task's
            static description, which the expanded input still shows. */}
        <span className="tool-arg">{item.progress || gist}</span>
        <span style={{ color: 'rgb(var(--text-faint))' }}>{isOpen ? '▾' : '▸'}</span>
      </button>

      {isOpen && (
        <>
          {nested && <div className="tool-nest">{children}</div>}
          <div className="tool-out">
            {JSON.stringify(item.input, null, 2)}
            {/* A subagent's tool_result is verbatim its last nested message, so
                printing it here too doubles the longest thing on screen — and
                the raw copy loses the markdown the nested one renders. */}
            {!nested && item.result ? `\n\n─────\n${item.result}` : ''}
          </div>
        </>
      )}
    </div>
  )
}
