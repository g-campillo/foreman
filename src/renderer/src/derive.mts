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

// ------------------------------------------------------- AskUserQuestion

export interface AskOption {
  label: string
  description?: string
  /** Markdown, because the session requests previewFormat: 'markdown'. */
  preview?: string
}

export interface AskQuestion {
  question: string
  header?: string
  multiSelect?: boolean
  options: AskOption[]
}

/**
 * Pulls the question set out of an AskUserQuestion tool input, or null when it
 * isn't one / isn't usable.
 *
 * Returning null is what makes the caller fall back to the generic approval
 * card: a malformed question set should still be answerable as a plain
 * allow/deny rather than rendering a card with no buttons.
 */
export function askQuestions(toolName: string, input: unknown): AskQuestion[] | null {
  if (toolName !== 'AskUserQuestion') return null
  const raw = (input as { questions?: unknown } | null)?.questions
  if (!Array.isArray(raw)) return null

  const questions = raw.flatMap((entry): AskQuestion[] => {
    const q = entry as Record<string, unknown> | null
    if (!q || typeof q.question !== 'string') return []
    const opts = Array.isArray(q.options) ? q.options : []
    const options = opts.flatMap((o): AskOption[] => {
      const oo = o as Record<string, unknown> | null
      if (!oo || typeof oo.label !== 'string') return []
      return [
        {
          label: oo.label,
          ...(typeof oo.description === 'string' ? { description: oo.description } : {}),
          ...(typeof oo.preview === 'string' ? { preview: oo.preview } : {}),
        },
      ]
    })
    // A question with nothing to pick is not answerable as a card.
    if (!options.length) return []
    return [
      {
        question: q.question,
        ...(typeof q.header === 'string' ? { header: q.header } : {}),
        ...(q.multiSelect === true ? { multiSelect: true } : {}),
        options,
      },
    ]
  })

  return questions.length ? questions : null
}

/**
 * Marks a permission deny as an AskUserQuestion *answer* rather than a refusal.
 *
 * Answers ride out on the deny channel (see QuestionCard), so the CLI flags the
 * resulting tool_result `is_error` and the card would otherwise turn red — which
 * reads as "your answer failed" at the exact moment it succeeded.
 */
export const ANSWER_PREFIX = 'The user answered:'

// -------------------------------------------------------- composer triggers

export interface Trigger {
  kind: 'command' | 'file'
  /** Text between the trigger character and the caret. */
  query: string
  /** Index of the trigger character, for splicing the completion back in. */
  start: number
}

const SPACE = new Set([' ', '\t', '\n'])

/**
 * Finds an open completion trigger at the caret, or null.
 *
 * Two rules, both chosen to avoid firing on ordinary prose:
 *  - `/` completes a slash command only at position 0. Anywhere else it is far
 *    more likely to be a path (`src/foo`), so scanning continues past it — which
 *    is also what lets `@src/foo` keep completing as a file.
 *  - `@` completes a file only at a word boundary, so `email@example.com` is
 *    left alone.
 * Whitespace closes any trigger, since neither commands nor paths span it.
 */
export function triggerAt(text: string, caret: number): Trigger | null {
  const before = text.slice(0, Math.max(0, Math.min(caret, text.length)))

  for (let i = before.length - 1; i >= 0; i--) {
    const ch = before[i]
    if (SPACE.has(ch)) return null
    if (ch === '@') {
      const prev = i === 0 ? ' ' : before[i - 1]
      return SPACE.has(prev) ? { kind: 'file', query: before.slice(i + 1), start: i } : null
    }
    if (ch === '/' && i === 0) return { kind: 'command', query: before.slice(1), start: 0 }
  }
  return null
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
