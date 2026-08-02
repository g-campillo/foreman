/**
 * Pure derivations from store state, kept out of the components so they can be
 * checked under bare node — no React import here, and the ChatItem import is
 * type-only, so nothing needs resolving at runtime.
 */
import type { ChatItem, SessionMeta } from '../../shared/types'

// ---------------------------------------------------------------- activity

/**
 * What a session is actually doing, for the rail's icon.
 *
 * Richer than `SessionStatus` in exactly two places, both of which the raw
 * status gets wrong:
 *
 *  - **`background`.** A session whose turn has ended but which still has live
 *    background tasks reports `idle`. It is not idle — it is waiting on work
 *    the user cannot otherwise see. So a non-empty `backgroundTasks` outranks
 *    `idle` and `starting`.
 *  - **`planning`.** Free, because `permissionMode` is already on SessionMeta
 *    and is already patched when a plan is approved (the mode change rides out
 *    on the permission result). So this flips to `working` the moment the plan
 *    is accepted, with no extra plumbing.
 *
 * An in-flight turn still outranks background work: the foreground is what the
 * user is waiting on.
 */
export type Activity =
  | 'idle'
  | 'starting'
  | 'planning'
  | 'working'
  | 'background'
  | 'awaiting'
  | 'error'

export function activityOf(
  s: Pick<SessionMeta, 'status' | 'permissionMode' | 'backgroundTasks'>,
): Activity {
  if (s.status === 'error') return 'error'
  if (s.status === 'awaiting-approval') return 'awaiting'
  if (s.status === 'running') return s.permissionMode === 'plan' ? 'planning' : 'working'
  // Below here the turn is over, so background work is the most specific thing
  // left to say — including while the session is still starting up.
  if (s.backgroundTasks.length > 0) return 'background'
  if (s.status === 'starting') return 'starting'
  return 'idle'
}

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

/** Our own palette, because the SDK's `color` is a CLI theme key, not CSS.
 *  All theme tokens, so the breakdown flips with light/dark like everything else.
 *
 *  ORDER IS THE POINT. Categories are assigned by index, so neighbours in this
 *  list are neighbours in the legend and in the bar — and --warn next to
 *  --syn-num next to --syn-fn put three oranges in a row, which at a 9px swatch
 *  and a 4px bar segment is one colour. Interleaved so consecutive entries
 *  always jump hue, the way Cursor's grey/purple/green/amber/mauve/blue/salmon
 *  does. This is the only categorical palette in the app; everywhere else is one
 *  hue at varying alpha. */
const SWATCHES = [
  'rgb(var(--accent))',
  'rgb(var(--syn-key))',
  'rgb(var(--ok))',
  'rgb(var(--warn))',
  'rgb(var(--syn-str))',
  'rgb(var(--syn-type))',
  'rgb(var(--danger))',
]

/**
 * Colour for the i-th context category.
 *
 * Lives here rather than in either component because BOTH draw the same
 * breakdown — the ring's card under the composer and the session panel's
 * Overview tab. It used to be exported from SessionPanel and imported by
 * ContextRing, which made a leaf component depend on a panel shell for a colour
 * constant; splitting the panel into components/session/ would have made that
 * reach across a directory boundary too.
 */
export const swatch = (i: number): string => SWATCHES[i % SWATCHES.length]

/**
 * Pressure band for a 0-100 percentage, as a `data-level` value.
 *
 * `undefined` below 75 rather than a `'normal'` string, so the attribute is
 * absent entirely and the base CSS rule needs no `[data-level='normal']`
 * counterpart to beat.
 *
 * Shared by the context ring and the rate-limit meters so a gauge and a meter
 * can never disagree about what counts as nearly-full.
 */
export const level = (pct: number): string | undefined =>
  pct >= 90 ? 'danger' : pct >= 75 ? 'warn' : undefined

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

/**
 * What was asked and what was picked, read back off a settled tool card.
 *
 * The transcript no longer renders AskUserQuestion as a tool card — a card
 * saying "AskUserQuestion" over raw JSON is the least useful possible rendering
 * of the one call the user actually participated in. It becomes a one-line
 * record instead, and this is what fills it.
 *
 * Answers ride out on the deny channel as `${ANSWER_PREFIX}\n<q> → <a>` lines
 * (see QuestionCard.submit), in question order. Matching is positional rather
 * than by question text: a question containing ' → ' would otherwise split
 * wrong, and the two lists are generated from the same array.
 *
 * The full format is a strict superset of that, and this parser handles all of
 * it without a special case:
 *
 *     <question> → <pick>, <pick>, Other: <typed text> — note: <note>
 *
 * `Other: ` tags free text so the model can tell typed from picked, and the
 * note appends to the RIGHT of the arrow — which is why `lastIndexOf(' → ')`
 * still finds the right split and why everything after it is the answer.
 *
 * TWO INVARIANTS THE SENDER OWNS, because nothing here can recover from a
 * violation:
 *
 *  1. **One line per question.** Matching is by index, so a single newline
 *     inside an answer shifts every later question's answer by one. Senders
 *     collapse whitespace runs, newlines included, to a space.
 *  2. **No ' → ' to the right of the real one.** A user who types an arrow into
 *     a note would otherwise steal the split from the question. Senders rewrite
 *     ' → ' to ' -> ' in every user-authored fragment.
 *
 * Both are enforced by QuestionCard's `oneLine`/`sanitize`. Do NOT relax them by
 * making this parser cleverer: transcripts recorded by older builds are replayed
 * on resume and carry no version marker to branch on, so this parser has to keep
 * reading the old format and the new one identically. It does, because the new
 * one only ever adds text to the right of the arrow.
 *
 * Returns null when this isn't an answerable question set, so the caller falls
 * back to an ordinary tool card rather than rendering an empty row.
 */
export interface AnsweredQuestion {
  header: string
  question: string
  /** '' while the prompt is still open, or when it was skipped. */
  answer: string
}

export function answeredQuestions(
  input: unknown,
  result: string | undefined,
): AnsweredQuestion[] | null {
  const questions = askQuestions('AskUserQuestion', input)
  if (!questions) return null

  const answers = (result ?? '').startsWith(ANSWER_PREFIX)
    ? result!.slice(ANSWER_PREFIX.length).split('\n').filter((l) => l.trim())
    : []

  return questions.map((q, i) => {
    const line = answers[i] ?? ''
    const at = line.lastIndexOf(' → ')
    return {
      header: q.header || q.question,
      question: q.question,
      answer: at === -1 ? '' : line.slice(at + ' → '.length).trim(),
    }
  })
}

// ----------------------------------------------------------- ExitPlanMode

export interface PlanProposal {
  /** The plan itself, as markdown. */
  markdown: string
  /** Where the CLI saved it — under ~/.claude/plans, never in the project. */
  filePath?: string
}

/**
 * Pulls a finished plan out of an ExitPlanMode call.
 *
 * The input carries the whole plan as markdown (`plan`) plus the file the CLI
 * made the agent write it to first (`planFilePath`). Neither is in the SDK's
 * published `ExitPlanModeInput`, which declares one deprecated field and an
 * index signature — so both are read defensively and confirmed against live
 * transcripts rather than trusted from the type.
 *
 * Returning null is what keeps a malformed call on the generic approval card
 * instead of opening an empty plan modal over the conversation.
 */
export function planProposal(toolName: string, input: unknown): PlanProposal | null {
  if (toolName !== 'ExitPlanMode') return null
  const i = input as Record<string, unknown> | null
  const markdown = typeof i?.plan === 'string' ? i.plan.trim() : ''
  if (!markdown) return null
  return {
    markdown,
    ...(typeof i?.planFilePath === 'string' && i.planFilePath ? { filePath: i.planFilePath } : {}),
  }
}

/**
 * The plan's own first heading, for a one-line label.
 *
 * Plans reliably open with one, and it beats every generic alternative: the
 * file slug is a mangled fragment of the prompt that opened the session
 * ("use-your-brainstorming-superpower-witty-tiger"), and the raw input is tens
 * of kilobytes of JSON.
 */
export function planTitle(markdown: string): string {
  const m = /^\s{0,3}#{1,3}\s+(.+?)\s*#*\s*$/m.exec(markdown)
  return m ? m[1].trim() : 'Implementation plan'
}

/** Sent back on the deny channel when the user wants revisions, not a rewrite. */
export const PLAN_FEEDBACK_PREFIX =
  'The user did not approve this plan. Stay in plan mode and revise it based on this feedback:'

// ------------------------------------------------------- arming an approval

/**
 * The one approval, if any, whose Allow button may take focus so that ⏎
 * activates it natively.
 *
 * Focus rather than a global keydown listener, because a focused `<button>`
 * activates on ⏎ for free, gets a real focus ring, is announced by VoiceOver as
 * the default action, and stays Tab-reachable. A global handler would have to
 * re-derive all three of those AND answer "is the user typing right now" on
 * every keystroke instead of once.
 *
 * Three rules, and the middle one is the whole reason this is a function rather
 * than an index test:
 *
 *  1. Only the FIRST pending request arms. Anything else would put the default
 *     action on a card the user has not read.
 *  2. NOTHING arms while a plan or a question is pending — even one that is not
 *     first. PlanCard and QuestionCard come out of the same `approvals` array as
 *     these, and both mount window-level keydown listeners; QuestionCard's binds
 *     plain Enter. A focused button plus that listener means one ⏎ both answers
 *     the questions and approves an unrelated tool. Conversation cannot see
 *     whether those modals are open, so the conservative test is the presence of
 *     the request, reusing the very helpers that decide which card gets rendered.
 *  3. Otherwise, the first id.
 *
 * A MALFORMED question set does arm the request in front of it, and that is
 * correct rather than sloppy: askQuestions returning null is exactly the case
 * where Conversation falls back to a plain approval card with no listener of its
 * own, so there is nothing left to collide with.
 */
export function armedApproval(
  reqs: readonly { requestId: string; toolName: string; input: unknown }[],
): string | null {
  const first = reqs[0]
  if (!first) return null
  for (const r of reqs) {
    if (planProposal(r.toolName, r.input)) return null
    if (askQuestions(r.toolName, r.input)) return null
  }
  return first.requestId
}

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

// --------------------------------------------------------------- tool names

/** `get_file_content` / `query-docs` -> `Get File Content` / `Query Docs`. */
function titleCase(segment: string): string {
  return segment
    .split(/[_-]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ')
}

/**
 * How a tool call should appear in the transcript.
 *
 * Only tools whose default rendering is actively wrong are listed. Built-ins
 * that already read correctly — `Read`, `Bash`, `Edit`, `Write`, `Grep` — are
 * deliberately absent: inventing a transform for those would only find new ways
 * to be wrong.
 *
 *  - `'hidden'` — the call produces no transcript row, because something else
 *    already renders its content. TaskCreate/TaskUpdate are the whole of this:
 *    they are checklist *events*, and TodoStrip folds them into the live
 *    checklist. A row per event says nothing the strip doesn't say better.
 *  - `'record'` — the call is a conversation with the user, not a mechanical
 *    step. The live prompt is a QuestionCard or PlanCard; what stays in the
 *    transcript is a one-line record of what was asked and what was chosen.
 */
export type ToolRender = 'hidden' | 'record'

interface ToolDisplay {
  label?: string
  render?: ToolRender
}

const TOOL_DISPLAY: Record<string, ToolDisplay> = {
  // Checklist events — TodoStrip renders the fold of these.
  TaskCreate: { render: 'hidden' },
  TaskUpdate: { render: 'hidden' },
  // Asked the user something. QuestionCard/PlanCard own the live prompt.
  AskUserQuestion: { label: 'Asked', render: 'record' },
  ExitPlanMode: { label: 'Plan', render: 'record' },
  // Read correctly enough as verbs, badly as bare CamelCase nouns.
  EnterPlanMode: { label: 'Entered plan mode' },
  ToolSearch: { label: 'Loaded tools' },
  TaskGet: { label: 'Checked task' },
  TaskList: { label: 'Listed tasks' },
  TaskOutput: { label: 'Read task output' },
  TaskStop: { label: 'Stopped task' },
  // WebFetch/WebSearch/Read/Bash are deliberately absent — they already read
  // correctly, and relabelling them is the invented transform this file warns
  // against. The existing toolLabel checks pin that.
}

/** How this tool should render, or undefined for an ordinary tool card. */
export function toolRender(name: string): ToolRender | undefined {
  return TOOL_DISPLAY[name]?.render
}

/**
 * A tool name fit to read.
 *
 * Three cases, in order: a registry entry wins; then MCP wire names, where
 * `mcp__jcodemunch__get_file_content` becomes `MCP jcodemunch Get File Content`;
 * then everything else verbatim.
 *
 * MCP wire names encode server and tool with a double underscore between them,
 * while the tool's own words are separated by single underscores (or hyphens) —
 * so splitting on `__` first is what keeps `query-docs` from being mistaken for
 * a server boundary. The server segment is left verbatim: it's a name the user
 * chose in their MCP config, and title-casing it would misrepresent it.
 */
export function toolLabel(name: string): string {
  const known = TOOL_DISPLAY[name]?.label
  if (known) return known
  if (!name.startsWith('mcp__')) return name
  const [, server, ...rest] = name.split('__')
  if (!server) return name
  const tool = rest.join('__')
  return ['MCP', server, tool && titleCase(tool)].filter(Boolean).join(' ')
}

/**
 * Verbs, past and present.
 *
 * Cursor writes a tool call as a sentence — `Read README.md L1-50`, `Ran ls -la`,
 * `Searched files README* in etk-cli` — with the verb in secondary text and the
 * argument in quaternary. There is no icon, no card and no status colour, so the
 * verb is doing all the work the chrome used to do, and a bare CamelCase tool
 * name cannot do it: "Glob src/**" is not a sentence.
 *
 * The tense is the running indicator. Cursor ships no spinner on these rows at
 * all — a call in flight reads `Exploring 8 files`, and the same row becomes
 * `Explored 30 files` when it lands. That is the entire animation.
 *
 * Names absent from this map fall through to toolLabel, which is what MCP tools
 * and anything unrecognised want: an invented verb for a tool we know nothing
 * about would misdescribe it, and the existing label is at least honest.
 */
const TOOL_VERB: Record<string, readonly [past: string, present: string]> = {
  Read: ['Read', 'Reading'],
  Glob: ['Searched files', 'Searching files'],
  Grep: ['Searched files', 'Searching files'],
  Bash: ['Ran', 'Running'],
  BashOutput: ['Read output', 'Reading output'],
  KillShell: ['Stopped shell', 'Stopping shell'],
  Edit: ['Edited', 'Editing'],
  MultiEdit: ['Edited', 'Editing'],
  Write: ['Wrote', 'Writing'],
  NotebookEdit: ['Edited', 'Editing'],
  WebFetch: ['Fetched', 'Fetching'],
  WebSearch: ['Searched the web', 'Searching the web'],
  // The subagent tool. 'Agent' is the wire name, 'Task' is what older
  // transcripts carry — see summarise() for the same pairing.
  Agent: ['Delegated', 'Delegating'],
  Task: ['Delegated', 'Delegating'],
  TodoWrite: ['Updated the plan', 'Updating the plan'],
  SlashCommand: ['Ran', 'Running'],
  Skill: ['Used', 'Using'],
  ToolSearch: ['Loaded tools', 'Loading tools'],
}

/** The verb for a tool call, in the tense its status calls for. */
export function toolVerb(name: string, pending = false): string {
  const pair = TOOL_VERB[name]
  return pair ? pair[pending ? 1 : 0] : toolLabel(name)
}

// ------------------------------------------------------------ transcript shape

export interface Row {
  item: ChatItem
  /** First assistant block of a turn — the one that gets the avatar. */
  leadsTurn: boolean
}

/**
 * The transcript, one row per item, with the assistant message that opens a
 * turn flagged.
 *
 * This used to also fold consecutive tool calls into a collapsible "N steps"
 * run. That is gone on purpose: the agent moves fast enough that a run is
 * usually still open and re-folding under you, and a folded run hides exactly
 * the thing you are watching for. Individual cards are already one line each.
 *
 * `leadsTurn` stays, and is unrelated: streaming emits several assistant items
 * per turn, so putting an avatar on each one stutters down the page instead of
 * marking who is speaking.
 *
 * Hidden tools (TodoStrip's checklist events) are dropped here rather than
 * upstream, because `latestTodos` folds the very same items out of the store to
 * build that strip — filtering them earlier would empty it.
 */
export function transcriptRows(roots: readonly ChatItem[]): Row[] {
  const out: Row[] = []
  let prevKind: string | null = null

  for (const item of roots) {
    if (item.kind === 'tool' && toolRender(item.name) === 'hidden') continue
    out.push({
      item,
      leadsTurn: item.kind === 'assistant' && prevKind !== 'assistant',
    })
    prevKind = item.kind
  }
  return out
}

export interface Turn {
  /** Stable React key: the id of the first item in the turn. */
  id: string
  /** The user message that opened it. Null for a turn resumed mid-transcript. */
  lead: Row | null
  /** Thinking, tool calls and mid-turn commentary — what the header folds away. */
  work: Row[]
  /** The trailing run of assistant blocks: the answer. Never folded. */
  tail: Row[]
  /** Wall time from the turn's result item; null while it is still running. */
  durationMs: number | null
}

/**
 * The transcript as turns.
 *
 * Cursor heads each turn with `Worked for 13s ⌄` and folds everything between
 * the question and the answer behind it, leaving the previous turn as its
 * summary line plus what the agent finally said. Only the newest turn stays
 * open. Scrolled back through a long session that is the difference between
 * reading a conversation and reading a log.
 *
 * A turn is bounded by user messages rather than by result items, because a
 * transcript resumed from disk can begin mid-turn with no result to anchor on,
 * and because queued messages produce two user items before either turn ends.
 *
 * The split between `work` and `tail` is the trailing run of assistant blocks —
 * streaming emits several per turn, and all of them belong to the answer. Result
 * and error items ride along in `tail` so a failed turn still says so when the
 * turn is folded; that is the one thing you must not be able to hide.
 */
export function groupTurns(rows: readonly Row[]): Turn[] {
  const turns: Turn[] = []
  let body: Row[] = []

  /** Trailing assistant/result/error rows are the answer; the rest is work. */
  const close = (): void => {
    const turn = turns[turns.length - 1]
    if (!turn) return
    let i = body.length
    while (i > 0) {
      const kind = body[i - 1].item.kind
      if (kind !== 'assistant' && kind !== 'result' && kind !== 'error') break
      i -= 1
    }
    turn.work = body.slice(0, i)
    turn.tail = body.slice(i)
    body = []
  }

  for (const row of rows) {
    if (row.item.kind === 'user') {
      close()
      turns.push({ id: row.item.id, lead: row, work: [], tail: [], durationMs: null })
      continue
    }
    // A transcript that begins mid-turn — resumed from disk, or forked at an
    // assistant message — has work before any user message to hang it on.
    if (!turns.length) turns.push({ id: row.item.id, lead: null, work: [], tail: [], durationMs: null })
    // Read off the item rather than timing the render: this is the SDK's own
    // measure of the turn, and it survives a reload where a mount timestamp
    // would restart every turn at zero.
    if (row.item.kind === 'result') turns[turns.length - 1].durationMs = row.item.durationMs
    body.push(row)
  }
  close()
  return turns
}

// ------------------------------------------------------------ working verbs

/**
 * Rotating status verbs. Purely for fun — the spinner already says everything
 * functional. Kept here rather than in the component so the list is data, and
 * so the picker can be checked.
 */
export const WORKING_VERBS: readonly string[] = [
  // genz
  'Looksmaxing',
  'Mogging',
  'Locking in',
  'Aura farming',
  'Cooking',
  'Manifesting',
  'Rizzing up the compiler',
  'Touching grass',
  'Delulu-ing',
  'Glazing',
  'Ratioing',
  'Yeeting',
  'Sigma grinding',
  'Understanding the assignment',
  // dev
  'Yak shaving',
  'Bikeshedding',
  'Rubber ducking',
  'Bisecting',
  'Force pushing',
  'Cache invalidating',
  'Off-by-one-ing',
  'Monkey patching',
  'Tree shaking',
  'Vendoring',
  'Stashing',
  'Naming things',
  'Reticulating splines',
  // corporate
  'Circling back',
  'Putting a pin in it',
  'Boiling the ocean',
  'Moving the needle',
  'Double-clicking on it',
  'Taking it offline',
  'Peeling the onion',
  'Eating the frog',
  'Running it up the flagpole',
  'Herding cats',
  'Socializing the deck',
  'Drinking from the firehose',
  'Parking-lotting it',
  'Leveraging synergies',
]

/**
 * Verb for a given session and tick. Offset by the session id so two sessions
 * running at once don't chant in unison, which looks like a rendering bug.
 */
export function workingVerb(sessionId: string, tick: number): string {
  let seed = 0
  for (const ch of sessionId) seed = (seed + ch.charCodeAt(0)) % WORKING_VERBS.length
  return WORKING_VERBS[(seed + tick) % WORKING_VERBS.length]
}

/**
 * Elapsed time, the way the CLI spells it: `19s`, `5m 1s`, `1h 2m`.
 *
 * Seconds are dropped past an hour, where they have stopped being information
 * and only make the line twitch.
 */
export function hms(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/**
 * Compact token counts: `842`, `4.2k`, `42k`, `1M`.
 *
 * One decimal below 10k and none above, because at five significant digits the
 * decimal is noise. Shared by the session panel and the context strip so the
 * same number never renders two ways in one window.
 */
export function fmt(n: number): string {
  if (n >= 1e6) return `${+(n / 1e6).toFixed(1)}M`
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n)
}

// -------------------------------------------------------------------- projects

/**
 * Comparison key for a project directory.
 *
 * Deliberately NOT a realpath: the renderer has no fs. Main canonicalises with
 * realpathSync when it creates a session, but `PastSession.cwd` comes straight
 * from the SDK and is left as written — so this normalises only what a string
 * can, the trailing slash and the case (APFS is case-insensitive by default).
 * Two paths that differ through a symlink still read as two projects.
 *
 * The case-lowering is wrong on a case-sensitive volume, where it would merge
 * two genuinely distinct directories. Rare enough to accept knowingly.
 */
export function projectKey(path: string): string {
  return path.replace(/\/+$/, '').toLowerCase()
}

/**
 * A file path shown against the session's working directory.
 *
 * Inside the cwd the prefix goes; anything else stays absolute, because a
 * `../../../` chain is less legible than the absolute path it replaced. There
 * is no `~` case: the renderer has no `os.homedir()` — the preload surface is
 * IPC only — and reaching for one would be a new IPC call for an avatar-sized
 * gain.
 *
 * This is also what puts filenames back on screen. `.tool-arg` ellipsises the
 * TAIL, so a long absolute path rendered as `/Users/me/code/foreman/src/rend…`
 * — hiding the one part anyone reads.
 *
 * Prefix arithmetic rather than a `path.relative`, for the reason projectKey
 * gives above: the renderer has no fs, so there is nothing to canonicalise
 * against and a symlinked path stays absolute.
 */
export function relPath(path: string, cwd: string): string {
  if (!path || !cwd || !path.startsWith('/')) return path
  // Both sides lose their trailing slash. On `path` that matters as much as on
  // `cwd`: '/a/b/' against a cwd of '/a/b' would otherwise slice to the empty
  // string and the card would render a blank where a name belongs.
  const base = cwd.replace(/\/+$/, '')
  const p = path.replace(/\/+$/, '')
  if (!base || !p) return path
  // The cwd itself, which an MCP tool taking a `path` (index_folder,
  // resolve_repo) routinely passes. Its basename, not '.', which reads as a
  // rendering bug rather than as the project root.
  if (p === base) return base.split('/').pop() ?? path
  // The trailing slash is load-bearing: without it a cwd of /a/foo would
  // swallow the sibling directory /a/foobar.
  const prefix = base + '/'
  // Folded compare, then slice by length — so the case-insensitivity matches
  // projectKey's (APFS default) while the returned string keeps its own casing.
  if (p.toLowerCase().startsWith(prefix.toLowerCase())) return p.slice(prefix.length)
  return path
}

/** A project row on Home or in the chooser. */
export interface RecentProject extends Matchable {
  /** Full path. `label` is the basename. */
  hint: string
  /** Has a live session. Never hidden, and never removable — see below. */
  open: boolean
}

/**
 * The recents list, shared by Home and ProjectChooser so the two cannot
 * disagree about what the user removed.
 *
 * `hidden` is a display filter and nothing else — `~/.claude/projects` belongs
 * to the Claude CLI as much as to us, so a removed project must still be
 * resumable from the CLI, from the rail's history browser, and from search.
 *
 * A project with a live session is pushed first and can never be filtered out:
 * hiding the directory you are currently working in would produce a row you can
 * neither explain nor get rid of. The guard lives here rather than in the UI so
 * it cannot be bypassed by a caller that forgets it.
 */
export function recentProjects(
  sessions: readonly Pick<SessionMeta, 'cwd' | 'worktree' | 'createdAt'>[],
  past: readonly { cwd?: string }[],
  hidden: readonly string[],
): RecentProject[] {
  const hide = new Set(hidden.map(projectKey))
  const seen = new Set<string>()
  const out: RecentProject[] = []

  const push = (path: string, open: boolean): void => {
    if (!path) return
    const key = projectKey(path)
    if (seen.has(key)) return
    if (!open && hide.has(key)) return
    seen.add(key)
    out.push({ label: path.split('/').filter(Boolean).pop() ?? path, hint: path, open })
  }

  // The worktree path is a scratch checkout; repoRoot is the project the user
  // thinks in — and opening the scratch dir would start an agent inside it.
  //
  // Newest first, to agree with groupSessions. Home renders that one directly
  // above this one, so leaving this in store insertion order would put two
  // orderings of the same projects on screen at once, pointing opposite ways.
  for (const s of [...sessions].sort(byNewest)) push(s.worktree?.repoRoot ?? s.cwd, true)
  for (const p of past) if (p.cwd) push(p.cwd, false)
  return out
}

/**
 * Live sessions grouped by the project they belong to, worktrees folded in,
 * newest first at both levels.
 *
 * Ordering is `createdAt` descending, and a group ranks by its OWN newest
 * session — which is what preserves "the first row is the newest session" once
 * the rail draws headers between groups. Ordering groups alphabetically would
 * break it: the newest session could land three headers down.
 *
 * `createdAt` and not last-activity, deliberately. It is stamped once in the
 * Session constructor (including on resume, so a conversation pulled out of
 * History correctly comes back at the top) and no `onMeta` patch touches it
 * afterwards. So the rail reorders only on create/resume/close — all things
 * the user just did. Ordering by activity would yank a row to the top whenever
 * a background agent emitted, shifting the row you were about to click.
 */
export function groupSessions(
  sessions: readonly SessionMeta[],
): { root: string; sessions: SessionMeta[] }[] {
  const by = new Map<string, { root: string; sessions: SessionMeta[] }>()
  for (const s of sessions) {
    const root = s.worktree?.repoRoot ?? s.cwd
    const key = projectKey(root)
    const g = by.get(key) ?? { root, sessions: [] }
    g.sessions.push(s)
    by.set(key, g)
  }
  for (const g of by.values()) g.sessions.sort(byNewest)
  // `sessions[0]` is the group's newest, having just been sorted. Optional-
  // chained for noUncheckedIndexedAccess; a group only exists because something
  // was pushed into it, so the fallback is unreachable.
  return [...by.values()].sort(
    (a, b) => (b.sessions[0]?.createdAt ?? 0) - (a.sessions[0]?.createdAt ?? 0),
  )
}

/** Newest first. Shared so the rail, Home and the chooser cannot disagree. */
const byNewest = (a: Pick<SessionMeta, 'createdAt'>, b: Pick<SessionMeta, 'createdAt'>): number =>
  b.createdAt - a.createdAt

/**
 * The session a rail drawn newest-first shows at the top.
 *
 * The store array stays in insertion order, so its own `[0]` is the OLDEST —
 * which after grouping is the BOTTOM row. Anything picking a "next" session to
 * select after a close, or a first session to select on boot, wants this.
 */
export function newestSession(sessions: readonly SessionMeta[]): SessionMeta | undefined {
  // Seedless reduce throws on an empty array and TypeScript will not catch it.
  return sessions.length ? sessions.reduce((a, b) => (b.createdAt > a.createdAt ? b : a)) : undefined
}

/** One session's persisted spend, as `listUsage` returns it. */
export interface UsageRow {
  sdkSessionId: string
  costUsd: number
  inputTokens: number
  outputTokens: number
  /** Absent on sidecars an older build wrote; those fall back to the id join. */
  cwd?: string
}

export interface UsageTotals {
  costUsd: number
  inputTokens: number
  outputTokens: number
  /**
   * Sidecars found — very nearly "conversations that have taken at least one
   * turn *in Foreman*". Sessions started from the Claude CLI never get one, so
   * this is not a machine-wide total and the UI must not claim it is.
   *
   * "Very nearly", because the sidecar also carries the permission mode now, and
   * changing that before the first turn writes the file — so a conversation you
   * put in Plan mode and then abandoned counts here at $0.
   */
  sessions: number
  byProject: { root: string; costUsd: number; sessions: number }[]
  /** Spend with no project attached. Counted in the totals, not in byProject. */
  unattributed: { costUsd: number; sessions: number }
}

/**
 * Roll the per-session sidecars up into headline figures and a per-project split.
 *
 * Safe to sum: a resume writes back to the SAME sdkSessionId, and `restoredCost`
 * seeds the running total, so each file already holds that conversation's
 * lifetime cost exactly once. A fork mints a new id and accrues independently.
 */
export function aggregateUsage(
  rows: readonly UsageRow[],
  past: readonly { sessionId: string; cwd?: string }[],
): UsageTotals {
  // Fallback only, for rows written before `cwd` moved into the sidecar. Bounded
  // by whatever listPastSessions returned, which is why cwd is written at the
  // source rather than resolved here.
  const cwdOf = new Map<string, string>()
  for (const p of past) if (p.cwd) cwdOf.set(p.sessionId, p.cwd)

  const byRoot = new Map<string, { root: string; costUsd: number; sessions: number }>()
  const out: UsageTotals = {
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    sessions: 0,
    byProject: [],
    unattributed: { costUsd: 0, sessions: 0 },
  }

  for (const r of rows) {
    out.costUsd += r.costUsd
    out.inputTokens += r.inputTokens
    out.outputTokens += r.outputTokens
    out.sessions += 1

    const cwd = r.cwd ?? cwdOf.get(r.sdkSessionId)
    if (!cwd) {
      out.unattributed.costUsd += r.costUsd
      out.unattributed.sessions += 1
      continue
    }
    const key = projectKey(cwd)
    const g = byRoot.get(key) ?? { root: cwd, costUsd: 0, sessions: 0 }
    g.costUsd += r.costUsd
    g.sessions += 1
    byRoot.set(key, g)
  }

  out.byProject = [...byRoot.values()].sort((a, b) => b.costUsd - a.costUsd)
  return out
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

// -------------------------------------------------------- following the agent

/** Where a tool call is about to work. */
export interface FocusTarget {
  /** Absolute path, as the agent gave it. */
  path: string
  /** 1-based line to reveal, or null for "open it, don't move the view". */
  line: number | null
  /**
   * Text to locate when the input carries no line number — the first non-empty
   * line of `old_string`. Empty when there is nothing to match on.
   */
  anchor: string
  /** How hard this argues for moving the viewport. */
  weight: 'read' | 'write'
}

/**
 * What file a tool call is about to touch, from the call alone.
 *
 * The signal is already on the wire: session.ts emits a `tool` ChatItem the
 * instant a tool_use block lands — BEFORE the tool runs — so for a Read the
 * editor can arrive ahead of the agent. No new hook, no new IPC channel, no new
 * ChatItem arm; this function is the whole data half of follow-the-agent.
 *
 * Lives here with askQuestions and planProposal because it is the same job:
 * chew `unknown` the agent authored and return null rather than throw inside a
 * render.
 *
 * The honesty is in the nulls.
 */
export function focusTarget(name: string, input: unknown): FocusTarget | null {
  const i = input as Record<string, unknown> | null
  const s = (k: string): string => (typeof i?.[k] === 'string' ? (i[k] as string) : '')
  const path = s('file_path') || s('notebook_path') || s('path')
  if (!path) return null

  // First non-empty line of a fragment, which is all an Edit gives us.
  const anchorOf = (text: string): string =>
    text.split('\n').find((l) => l.trim().length > 0)?.trim() ?? ''

  switch (name) {
    case 'Read': {
      // `offset` is 1-based in the tool's own contract. Null when the agent
      // read the whole file — there is no line to reveal, only a file to show.
      const offset = typeof i?.offset === 'number' ? i.offset : null
      return { path, line: offset, anchor: '', weight: 'read' }
    }
    case 'Edit':
      // No line number, and there never will be one: old_string is a fragment.
      // DiffLines already encodes this truth with numbers={false} for the tool
      // card. Reuse the reasoning rather than inventing a number.
      return { path, line: null, anchor: anchorOf(s('old_string')), weight: 'write' }
    case 'MultiEdit': {
      const edits = Array.isArray(i?.edits) ? (i.edits as Record<string, unknown>[]) : []
      const first = edits.find((e) => typeof e?.old_string === 'string')
      return {
        path,
        line: null,
        anchor: anchorOf(typeof first?.old_string === 'string' ? first.old_string : ''),
        weight: 'write',
      }
    }
    case 'Write':
      // After a Write the whole file is the agent's, so the top is as good a
      // place as any and better than guessing.
      return { path, line: 1, anchor: '', weight: 'write' }
    case 'NotebookEdit':
      // A .ipynb is JSON; there is no line mapping and pretending to one is
      // worse than opening the file. Same call ToolCard.editHunks already makes.
      return { path, line: null, anchor: '', weight: 'write' }
    default:
      // An MCP tool that names a file still tells us something useful.
      // Grep and Bash are NOT here, deliberately — see the check file.
      return name.startsWith('mcp__') ? { path, line: null, anchor: '', weight: 'read' } : null
  }
}

/** One edit the agent made to a file, with the text it replaced. */
export interface AuthorEdit {
  /** ChatItem id of the tool call, for the jump back to the conversation. */
  itemId: string
  anchor: string
}

/**
 * Every edit this session made to a path, oldest first.
 *
 * The transcript IS the ledger, and it is already durable: a live session
 * replays its host event log, and a resumed one comes back through
 * normaliseTranscript, which preserves `input` on tool cards.
 *
 * Known gap, and it is known rather than broken: a resumed session shows no
 * SUBAGENT edits, because the CLI does not persist subagent messages in the
 * parent's transcript.
 */
export function authorEdits(items: readonly ChatItem[], path: string): AuthorEdit[] {
  const out: AuthorEdit[] = []
  for (const item of items) {
    if (item.kind !== 'tool') continue
    const i = item.input as Record<string, unknown> | null
    const s = (k: string): string => (typeof i?.[k] === 'string' ? (i[k] as string) : '')
    if ((s('file_path') || s('notebook_path')) !== path) continue

    // NEW_STRING, not old_string, and the difference is the whole feature.
    //
    // focusTarget anchors on old_string because it runs BEFORE the tool does,
    // when that text is still what the document says. This runs after, when the
    // agent has replaced it — so anchoring on old_string would match nothing,
    // essentially always, and the gutter would silently never link to anything.
    // A bug that looks exactly like "the feature does not work".
    const anchorOf = (text: string): string =>
      text.split('\n').find((l) => l.trim().length > 0)?.trim() ?? ''

    if (item.name === 'Edit') {
      const a = anchorOf(s('new_string'))
      if (a) out.push({ itemId: item.id, anchor: a })
    } else if (item.name === 'MultiEdit') {
      const edits = Array.isArray(i?.edits) ? (i.edits as Record<string, unknown>[]) : []
      for (const e of edits) {
        const a = anchorOf(typeof e?.new_string === 'string' ? e.new_string : '')
        // Each edit in a MultiEdit gets its own stripe: they are separate
        // changes that happen to have been sent together.
        if (a) out.push({ itemId: item.id, anchor: a })
      }
    }
    // Write has no anchor to offer — the whole file is the change, and git's
    // hunks already say which lines that means.
  }
  return out
}

/** An agent-authored span in the live document. */
export interface AuthoredRange {
  /** 1-based line. */
  line: number
  itemId: string
}

/**
 * Resolve anchors against the document as it is NOW.
 *
 * This is the load-bearing refusal of the whole feature. There is no durable
 * line-to-message map and building one is the mistake: a line number recorded
 * at edit time is wrong the moment anything above it changes, and a stripe on
 * the wrong line is a lie about who wrote your code.
 *
 * So: a line gets a STRIPE because git says it changed — that survives
 * everything. It gets a LINK because an anchor still matches — that survives
 * exactly as long as the text does. A miss is DROPPED, never guessed at, and
 * never falls back to a remembered position.
 */
export function resolveAnchors(doc: string, edits: readonly AuthorEdit[]): AuthoredRange[] {
  const lines = doc.split('\n')
  const out: AuthoredRange[] = []
  const taken = new Set<number>()
  for (const e of edits) {
    if (!e.anchor) continue
    // Later edits win a contested line: the transcript is oldest-first, so the
    // last writer is the one you want to be sent to.
    const at = lines.findIndex((l, n) => !taken.has(n) && l.trim() === e.anchor)
    if (at === -1) continue
    taken.add(at)
    out.push({ line: at + 1, itemId: e.itemId })
  }
  return out
}

// --------------------------------------------------------------------- files

/** A node in the file tree. Directories have `children`; files never do. */
export interface TreeNode {
  name: string
  /** Repo-relative, POSIX separators — the spelling `git ls-files` gave us. */
  path: string
  children?: TreeNode[]
}

/** Directories first, then case-insensitive by name. */
function cmpNodes(a: TreeNode, b: TreeNode): number {
  return (a.children ? 0 : 1) - (b.children ? 0 : 1) || a.name.localeCompare(b.name)
}

/**
 * Nest a flat path list into a tree.
 *
 * Flat, not lazy-per-directory, and that is a decision rather than a shortcut.
 * Loading a directory at a time means either reimplementing .gitignore — the
 * exact thing `listProjectFiles` exists to avoid — or one `git ls-files` per
 * expansion. 4000 paths is ~160KB across the bridge, which is nothing, and the
 * tree renders collapsed so only the root's children are ever in the DOM.
 */
export function buildTree(paths: readonly string[]): TreeNode[] {
  interface Dir {
    dirs: Map<string, Dir>
    files: Set<string>
  }
  const root: Dir = { dirs: new Map(), files: new Set() }

  for (const raw of paths) {
    // Normalise rather than reject. A './' prefix, a doubled slash or a trailing
    // one are all things a caller can plausibly hand us, and a path silently
    // dropped from a tree reads as "the repo is missing a file" — which is the
    // failure that looks like a bug in someone else's code.
    const parts = raw.split('/').filter((p) => p !== '' && p !== '.')
    if (!parts.length) continue

    let dir = root
    for (const part of parts.slice(0, -1)) {
      let next = dir.dirs.get(part)
      if (!next) {
        next = { dirs: new Map(), files: new Set() }
        dir.dirs.set(part, next)
      }
      dir = next
    }
    dir.files.add(parts[parts.length - 1]!)
  }

  const walk = (dir: Dir, prefix: string): TreeNode[] => {
    const out: TreeNode[] = []
    for (const [name, sub] of dir.dirs) {
      out.push({ name, path: prefix + name, children: walk(sub, `${prefix}${name}/`) })
    }
    for (const name of dir.files) {
      // A name can arrive as both a file and a directory — `foo` alongside
      // `foo/bar`. Keep the directory: a directory node can carry children and
      // a file node cannot, so dropping the directory loses every path under it
      // while dropping the file loses one.
      if (!dir.dirs.has(name)) out.push({ name, path: prefix + name })
    }
    return out.sort(cmpNodes)
  }

  return walk(root, '')
}
