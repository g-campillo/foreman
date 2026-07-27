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
  sessions: readonly Pick<SessionMeta, 'cwd' | 'worktree'>[],
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
  for (const s of sessions) push(s.worktree?.repoRoot ?? s.cwd, true)
  for (const p of past) if (p.cwd) push(p.cwd, false)
  return out
}

/** Live sessions grouped by the project they belong to, worktrees folded in. */
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
  return [...by.values()]
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
   * Sidecars found — conversations that have taken at least one turn *in
   * Foreman*. Sessions started from the Claude CLI never get one, so this is
   * not a machine-wide total and the UI must not claim it is.
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
