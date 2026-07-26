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

// ------------------------------------------------------------ context usage

export interface ContextCategory {
  name: string
  tokens: number
  isDeferred?: boolean
}

/**
 * Splits the SDK's category list into what is actually occupying the context
 * window versus what merely could.
 *
 * Two entries in that list are not usage, and both would fill the bar to 100%
 * if drawn:
 *  - a "Free space" filler that completes the list to maxTokens,
 *  - deferred tool groups, which are loadable on demand and are excluded from
 *    totalTokens (measured: the categories sum to 92,328 against a totalTokens
 *    of 23,894 — the difference is exactly the two deferred groups).
 *
 * The filler is found by an exact identity — it is by definition
 * `maxTokens - totalTokens` — rather than by name, which would break on
 * relabelling, or by "bigger than the total", which breaks the moment the window
 * is more than half full and free space becomes the smaller number.
 * At most one category is dropped, so a real one that happens to tie doesn't
 * silently vanish.
 */
export function contextBreakdown(
  categories: readonly ContextCategory[],
  totalTokens: number,
  maxTokens: number,
): { used: ContextCategory[]; deferred: ContextCategory[] } {
  const filler = maxTokens - totalTokens
  let droppedFiller = false
  const used: ContextCategory[] = []
  const deferred: ContextCategory[] = []

  for (const c of categories) {
    if (c.tokens <= 0) continue
    if (c.isDeferred) {
      deferred.push(c)
    } else if (!droppedFiller && filler > 0 && c.tokens === filler) {
      droppedFiller = true
    } else {
      used.push(c)
    }
  }
  return { used, deferred }
}

// -------------------------------------------------------------- elicitation

export interface ElicitField {
  name: string
  label: string
  type: 'string' | 'number' | 'boolean' | 'enum'
  required: boolean
  /** Populated for 'enum'. */
  options?: string[]
  description?: string
  default?: string | number | boolean
}

/**
 * Turns an MCP elicitation `requestedSchema` into flat form fields.
 *
 * Flat is not a simplification: the MCP spec restricts elicitation schemas to an
 * object of primitive properties (PrimitiveSchemaDefinition) precisely so that
 * any client can render them generically. Anything nested is out of spec, and is
 * dropped here rather than half-rendered.
 */
export function schemaFields(schema: Record<string, unknown> | undefined): ElicitField[] {
  const props = schema?.properties
  if (!props || typeof props !== 'object') return []
  const required = new Set(
    Array.isArray(schema?.required) ? (schema.required as unknown[]).filter((r) => typeof r === 'string') : [],
  )

  return Object.entries(props as Record<string, unknown>).flatMap(([name, raw]): ElicitField[] => {
    const def = raw as Record<string, unknown> | null
    if (!def || typeof def !== 'object') return []

    const enumValues = Array.isArray(def.enum)
      ? (def.enum as unknown[]).filter((v): v is string => typeof v === 'string')
      : null

    const declared = typeof def.type === 'string' ? def.type : ''
    // enum wins over the declared type: an enum is always a string in the spec,
    // but a dropdown is a strictly better control than a free-text box.
    const type: ElicitField['type'] = enumValues?.length
      ? 'enum'
      : declared === 'boolean'
        ? 'boolean'
        : declared === 'number' || declared === 'integer'
          ? 'number'
          : 'string'

    const dflt = def.default
    return [
      {
        name,
        label: typeof def.title === 'string' ? def.title : name,
        type,
        required: required.has(name),
        ...(type === 'enum' && enumValues ? { options: enumValues } : {}),
        ...(typeof def.description === 'string' ? { description: def.description } : {}),
        ...(typeof dflt === 'string' || typeof dflt === 'number' || typeof dflt === 'boolean'
          ? { default: dflt }
          : {}),
      },
    ]
  })
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
