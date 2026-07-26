/**
 * Pure derivations from store state, kept out of the components so they can be
 * checked under bare node — no React import here, and the ChatItem import is
 * type-only, so nothing needs resolving at runtime.
 */
import type { ChatItem } from '../../shared/types'

// ------------------------------------------------------------------- todos

export type TodoStatus = 'pending' | 'in_progress' | 'completed'
export interface Todo {
  content: string
  status: TodoStatus
  /** Present-tense form the agent writes for the in-flight item. */
  activeForm?: string
}

const DONE_WORDS: readonly string[] = ['completed', 'done']
const ACTIVE_WORDS: readonly string[] = ['in_progress', 'running', 'active']

/** Tolerates both vocabularies: the TaskUpdate tool says `in_progress`, while
 *  the SDK's own task patches say `running`. */
function normaliseStatus(raw: unknown): TodoStatus {
  const v = typeof raw === 'string' ? raw.toLowerCase() : ''
  if (DONE_WORDS.includes(v)) return 'completed'
  if (ACTIVE_WORDS.includes(v)) return 'in_progress'
  return 'pending'
}

/**
 * "Task #3 created successfully: …" → "3".
 *
 * TaskCreate assigns the id in its *result*, not its input, so this string is
 * the only place the id↔task mapping exists on the renderer side.
 */
function createdId(result: string | undefined): string | null {
  const m = /task\s*#(\d+)/i.exec(result ?? '')
  return m ? m[1] : null
}

/** A TodoWrite call carries the whole list and replaces whatever came before. */
function parseTodoWrite(input: Record<string, unknown> | null): Todo[] | null {
  const raw = input?.todos
  if (!Array.isArray(raw)) return null
  const todos = raw.flatMap((entry): Todo[] => {
    const o = entry as Record<string, unknown> | null
    if (!o || typeof o.content !== 'string') return []
    return [
      {
        content: o.content,
        status: normaliseStatus(o.status),
        activeForm: typeof o.activeForm === 'string' ? o.activeForm : undefined,
      },
    ]
  })
  return todos.length ? todos : null
}

/**
 * The agent's current plan, or null when there's nothing worth pinning.
 *
 * Folds the transcript rather than reading one call, because the installed SDK
 * has no TodoWrite: it exposes TaskCreate (one call per task) plus TaskUpdate
 * (one call per status change), so the list only exists as the sum of events.
 * TodoWrite is still handled — it's a whole-list rewrite, so it resets the fold —
 * since other model or tool configurations may still emit it.
 *
 * Tolerant by necessity: every field here is agent-authored JSON that reaches
 * the renderer as `unknown`, so malformed entries drop out rather than throwing
 * inside a render.
 *
 * Returns null once every task is completed — a finished plan is noise in a
 * header strip, and the transcript still has it.
 */
export function latestTodos(items: readonly ChatItem[]): Todo[] | null {
  const byId = new Map<string, Todo>()
  let created = 0

  for (const item of items) {
    if (item.kind !== 'tool') continue
    const input = (item.input ?? null) as Record<string, unknown> | null

    if (item.name === 'TodoWrite') {
      const list = parseTodoWrite(input)
      if (!list) continue
      byId.clear()
      created = 0
      list.forEach((t, i) => byId.set(`w${i}`, t))
    } else if (item.name === 'TaskCreate') {
      if (typeof input?.subject !== 'string') continue
      created += 1
      // The result hasn't arrived yet while the call is still pending; the ids
      // observed are 1-based in creation order, so the counter matches.
      byId.set(createdId(item.result) ?? String(created), {
        content: input.subject,
        status: 'pending',
        activeForm: typeof input.activeForm === 'string' ? input.activeForm : undefined,
      })
    } else if (item.name === 'TaskUpdate') {
      const raw = input?.taskId
      const key = typeof raw === 'string' || typeof raw === 'number' ? String(raw) : null
      const prev = key === null ? undefined : byId.get(key)
      // An update for a task we never saw created is dropped: inventing a row
      // for it would show a plan entry with no text.
      if (prev && key !== null && input && 'status' in input) {
        byId.set(key, { ...prev, status: normaliseStatus(input.status) })
      }
    }
  }

  const todos = [...byId.values()]
  if (!todos.length) return null
  return todos.every((t) => t.status === 'completed') ? null : todos
}

// ----------------------------------------------------------------- palette

export interface Matchable {
  label: string
  /** Secondary text — a cwd, a shortcut. Matched, but ranked below the label. */
  hint?: string
}

/**
 * Subsequence match, so 'nse' finds 'New session'. Returns the total gap between
 * matched characters (lower is a tighter match), or null for no match.
 */
export function score(text: string, query: string): number | null {
  if (!query) return 0
  const t = text.toLowerCase()
  let from = 0
  let gaps = 0
  let last = -1

  for (const ch of query.toLowerCase()) {
    if (ch === ' ') continue // spaces are how people separate words, not a literal
    const at = t.indexOf(ch, from)
    if (at === -1) return null
    if (last >= 0) gaps += at - last - 1
    last = at
    from = at + 1
  }
  return gaps
}

/** Hint matches are real but always rank below any label match. */
const HINT_PENALTY = 1000

/** Entries that match, best first. An empty query keeps the given order. */
export function filterEntries<T extends Matchable>(entries: readonly T[], query: string): T[] {
  const q = query.trim()
  if (!q) return [...entries]

  return entries
    .flatMap((entry) => {
      const onLabel = score(entry.label, q)
      const onHint = onLabel === null && entry.hint ? score(entry.hint, q) : null
      const rank = onLabel ?? (onHint === null ? null : onHint + HINT_PENALTY)
      return rank === null ? [] : [{ entry, rank }]
    })
    .sort((a, b) => a.rank - b.rank)
    .map((x) => x.entry)
}
