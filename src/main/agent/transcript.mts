/**
 * Turns stored session messages back into ChatItems.
 *
 * `SessionMessage.message` is typed `unknown` by the SDK because it is the raw
 * persisted API message, so everything here is defensive by necessity — this
 * parses data written by an older CLI as readily as today's.
 *
 * Kept SDK- and Electron-free so `npm run check:transcript` can load it under
 * bare node, same arrangement as porcelain.mts and policy.mts.
 */
import type { ChatItem } from '../../shared/types'

/** The subset of SessionMessage this needs; avoids importing the SDK type. */
export interface StoredMessage {
  type: 'user' | 'assistant' | 'system'
  uuid: string
  message: unknown
  parent_tool_use_id?: string | null
}

interface Block {
  type?: string
  text?: string
  thinking?: string
  name?: string
  input?: unknown
  id?: string
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
}

function blocksOf(message: unknown): Block[] {
  const content = (message as { content?: unknown } | null)?.content
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return Array.isArray(content) ? (content as Block[]) : []
}

/** tool_result content is either a string or an array of text blocks. */
function resultText(raw: unknown): string {
  if (typeof raw === 'string') return raw
  if (!Array.isArray(raw)) return ''
  return raw
    .map((c) => (c && typeof (c as Block).text === 'string' ? (c as Block).text : ''))
    .join('')
}

/**
 * Replays stored messages into the same ChatItem shapes a live session emits,
 * so a resumed conversation renders identically to one you watched happen.
 *
 * Subagent messages are nested rather than interleaved: they carry a
 * parent_tool_use_id, and the stored tool card's id IS its tool_use id, so that
 * field is already the `parentId` the renderer groups on.
 *
 * **Measured, so nobody re-derives it:** today's CLI does not persist subagent
 * messages in the parent session's file at all — a resumed run of a session that
 * spawned one comes back with the Agent tool_use, its tool_result, and nothing
 * in between (the subagent's own conversation goes to the separate `output_file`
 * named on `task_notification`). So this branch is currently unreachable in
 * practice, and a resumed Agent card falls back to rendering its report as the
 * tool_result. It is kept because the live path nests, `parent_tool_use_id` is
 * part of the stored shape, and dropping-or-nesting is strictly safer than the
 * alternative of letting an unrecognised parent land in the main thread.
 */
export function normaliseTranscript(messages: readonly StoredMessage[]): ChatItem[] {
  const items: ChatItem[] = []
  /** tool_use id -> index in `items`, so a later tool_result completes its card. */
  const toolIndex = new Map<string, number>()

  for (const m of messages) {
    if (m.type === 'system') continue

    const parentId = m.parent_tool_use_id ?? undefined
    // An orphan — parent Task outside this slice, or a tool_use block that had
    // no usable id — is dropped rather than promoted, since rendering it at top
    // level is exactly the interleaving this field exists to prevent.
    if (parentId && !toolIndex.has(parentId)) continue
    const under = parentId ? { parentId } : {}

    if (m.type === 'user') {
      const blocks = blocksOf(m.message)
      const text = blocks
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n')

      for (const b of blocks) {
        if (b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue
        const at = toolIndex.get(b.tool_use_id)
        if (at === undefined) continue
        const card = items[at]
        if (card.kind !== 'tool') continue
        items[at] = {
          ...card,
          status: b.is_error ? 'error' : 'done',
          result: resultText(b.content).slice(0, 4000),
        }
      }

      // A user turn that is nothing but tool results is plumbing, not something
      // the user said — rendering it would put an empty bubble after every tool.
      // A subagent's user turn is its prompt echo, which the Task card's own
      // input already shows, so it is dropped too — matching the live path.
      if (!parentId && text.trim()) items.push({ id: m.uuid, kind: 'user', text, uuid: m.uuid })
      continue
    }

    for (const b of blocksOf(m.message)) {
      if (b.type === 'text' && typeof b.text === 'string' && b.text) {
        items.push({
          id: `${m.uuid}:${items.length}`,
          kind: 'assistant',
          text: b.text,
          uuid: m.uuid,
          ...under,
        })
      } else if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking) {
        items.push({ id: `${m.uuid}:${items.length}`, kind: 'thinking', text: b.thinking, ...under })
      } else if (b.type === 'tool_use' && typeof b.name === 'string') {
        if (typeof b.id === 'string') toolIndex.set(b.id, items.length)
        items.push({
          id: typeof b.id === 'string' ? b.id : `${m.uuid}:${items.length}`,
          kind: 'tool',
          name: b.name,
          input: b.input,
          // Stored transcripts are finished. Anything still 'pending' here would
          // render a permanent spinner for a tool that ran days ago.
          status: 'done',
          ...under,
        })
      }
    }
  }

  return items
}

/**
 * First match of `query` in a transcript, with surrounding context.
 * Returns null when nothing matches, so callers can drop the session entirely.
 */
export function searchTranscript(
  messages: readonly StoredMessage[],
  query: string,
  context = 60,
): { snippet: string; matches: number } | null {
  const q = query.trim().toLowerCase()
  if (!q) return null

  let matches = 0
  let snippet = ''

  for (const item of normaliseTranscript(messages)) {
    const text = item.kind === 'tool' ? `${item.name} ${item.result ?? ''}` : item.text
    if (!text) continue
    const at = text.toLowerCase().indexOf(q)
    if (at === -1) continue
    matches += 1
    if (!snippet) {
      const from = Math.max(0, at - context)
      const to = Math.min(text.length, at + q.length + context)
      snippet = `${from > 0 ? '…' : ''}${text.slice(from, to).replace(/\s+/g, ' ')}${to < text.length ? '…' : ''}`
    }
  }

  return matches ? { snippet, matches } : null
}
