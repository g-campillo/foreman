import { useState } from 'react'
import type { ChatItem } from '../../../shared/types'

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
    case 'Task':
      return str('description') ?? ''
    default: {
      const first = str('file_path') ?? str('path') ?? str('query') ?? str('prompt')
      return first ?? JSON.stringify(i).slice(0, 120)
    }
  }
}

const ICON: Record<Tool['status'], string> = { pending: '○', done: '●', error: '✕' }

export default function ToolCard({ item }: { item: Tool }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const gist = summarise(item.name, item.input)

  return (
    <div className="tool">
      <button className="tool-head" onClick={() => setOpen((v) => !v)}>
        <span
          style={{
            color:
              item.status === 'error'
                ? 'rgb(var(--danger))'
                : item.status === 'done'
                  ? 'rgb(var(--ok))'
                  : 'rgb(var(--text-faint))',
          }}
        >
          {ICON[item.status]}
        </span>
        <span className="tool-name">{item.name}</span>
        <span className="tool-arg">{gist}</span>
        <span style={{ color: 'rgb(var(--text-faint))' }}>{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div className="tool-out">
          {JSON.stringify(item.input, null, 2)}
          {item.result ? `\n\n─────\n${item.result}` : ''}
        </div>
      )}
    </div>
  )
}
