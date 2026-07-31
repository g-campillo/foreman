/**
 * Self-check for the renderer's pure derivations: `npm run check:derive`.
 *
 * Both of these chew on data the agent authored, so the failure modes are a
 * thrown exception inside a render (blank pane) or a silently empty strip —
 * neither of which announces itself.
 */
import { strict as assert } from 'node:assert'
import type { ChatItem, SessionMeta } from '../../shared/types'
import { activityOf, answeredQuestions, ANSWER_PREFIX, fmt, hms, latestTodos, score, filterEntries, schemaFields, contextBreakdown, triggerAt, askQuestions, projectKey, relPath, recentProjects, groupSessions, newestSession, aggregateUsage, planProposal, planTitle, toolLabel, toolVerb, toolRender, transcriptRows, groupTurns, workingVerb, WORKING_VERBS, buildTree, focusTarget, authorEdits, resolveAnchors } from './derive.mts'

let seq = 0
const tool = (name: string, input: unknown, result?: string): ChatItem => ({
  id: `i${++seq}`,
  kind: 'tool',
  name,
  input,
  status: 'done',
  result,
})
const todo = (content: string, status: string): unknown => ({ content, status })

// ------------------------------------------------------------------ activityOf

// Leading `;` is load-bearing, not a stray: the line above ends in `})`, and a
// bare block after it makes tsc read `({ content, status })` as an arrow's
// parameter list and demand a `=>` (TS1005). Node's type-stripping parses it
// fine, so `npm run check:derive` passes while `npm run typecheck` fails.
;{
  const bg = [{ taskId: '1', taskType: 'Bash', description: 'npm test' }]
  const s = (
    status: SessionMeta['status'],
    permissionMode: SessionMeta['permissionMode'] = 'default',
    backgroundTasks: SessionMeta['backgroundTasks'] = [],
  ): Pick<SessionMeta, 'status' | 'permissionMode' | 'backgroundTasks'> => ({
    status,
    permissionMode,
    backgroundTasks,
  })

  assert.equal(activityOf(s('idle')), 'idle')
  assert.equal(activityOf(s('starting')), 'starting')
  assert.equal(activityOf(s('running')), 'working')
  assert.equal(activityOf(s('awaiting-approval')), 'awaiting')
  assert.equal(activityOf(s('error')), 'error')

  // Plan mode splits `running` in two, and only while actually running.
  assert.equal(activityOf(s('running', 'plan')), 'planning')
  assert.equal(activityOf(s('idle', 'plan')), 'idle', 'plan mode alone is not planning')

  // THE BUG THIS EXISTS FOR: a finished turn with live background tasks read as
  // 'idle' in the rail while work was still going on.
  assert.equal(activityOf(s('idle', 'default', bg)), 'background')
  assert.equal(activityOf(s('starting', 'default', bg)), 'background')

  // ...but a foreground turn still wins. That is what the user is waiting on.
  assert.equal(activityOf(s('running', 'default', bg)), 'working')
  assert.equal(activityOf(s('awaiting-approval', 'default', bg)), 'awaiting')
  assert.equal(activityOf(s('error', 'default', bg)), 'error')
}

/** Mirrors the live tool: the id is assigned in the RESULT, not the input. */
const create = (n: number, subject: string, activeForm?: string): ChatItem =>
  tool('TaskCreate', { subject, activeForm }, `Task #${n} created successfully: ${subject}`)
const update = (n: number, status: string): ChatItem =>
  tool('TaskUpdate', { taskId: String(n), status }, `Updated task #${n} status`)

// ---------------------------------------------------------------- latestTodos

assert.equal(latestTodos([]), null, 'no items')
assert.equal(latestTodos([tool('Bash', { command: 'ls' })]), null, 'no plan tools')

// The installed SDK has no TodoWrite — the plan only exists as TaskCreate +
// TaskUpdate events, so the list has to be folded rather than read off one call.
{
  const got = latestTodos([
    create(1, 'Scope the export', 'Scoping the export'),
    create(2, 'Write the serializer'),
    tool('Bash', { command: 'ls' }),
    create(3, 'Wire the entry point'),
    update(1, 'completed'),
    update(2, 'in_progress'),
  ])
  assert.deepEqual(got?.map((t) => t.content), [
    'Scope the export',
    'Write the serializer',
    'Wire the entry point',
  ])
  assert.deepEqual(got?.map((t) => t.status), ['completed', 'in_progress', 'pending'])
  assert.equal(got?.[0].activeForm, 'Scoping the export', 'activeForm survives the fold')
}

// A task still streaming has no result yet, so no id — the creation counter has
// to stand in, or the row vanishes mid-turn.
{
  const pending: ChatItem = { id: 'p', kind: 'tool', name: 'TaskCreate', input: { subject: 'x' }, status: 'pending' }
  assert.deepEqual(latestTodos([pending])?.map((t) => t.content), ['x'])
}

// The SDK's own patches say 'running' where the tool says 'in_progress'.
assert.equal(latestTodos([create(1, 'a'), update(1, 'running')])?.[0].status, 'in_progress')

// An update for a task never created must not invent a blank row.
assert.equal(latestTodos([create(1, 'a'), update(9, 'completed')])?.length, 1)

// A finished plan is not worth pinning to a header.
assert.equal(
  latestTodos([create(1, 'a'), create(2, 'b'), update(1, 'completed'), update(2, 'completed')]),
  null,
  'all-completed plan is hidden',
)
// ...but one straggler keeps the whole list visible.
assert.equal(latestTodos([create(1, 'a'), create(2, 'b'), update(1, 'completed')])?.length, 2)

// TodoWrite is still honoured, and being a whole-list rewrite it RESETS the fold.
{
  const got = latestTodos([
    create(1, 'from tasks'),
    tool('TodoWrite', { todos: [todo('from todowrite', 'in_progress')] }),
  ])
  assert.deepEqual(got?.map((t) => t.content), ['from todowrite'], 'TodoWrite replaces the list')
}

// Agent-authored JSON: malformed entries drop out instead of throwing in render.
{
  const got = latestTodos([
    tool('TodoWrite', {
      todos: [todo('keep', 'pending'), null, { status: 'pending' }, { content: 42 }],
    }),
  ])
  assert.deepEqual(got?.map((t) => t.content), ['keep'])
}
// An unknown status degrades to 'pending' rather than rendering an unstyled chip.
assert.equal(latestTodos([tool('TodoWrite', { todos: [todo('x', 'banana')] })])?.[0].status, 'pending')
assert.equal(latestTodos([create(1, 'a'), update(1, 'banana')])?.[0].status, 'pending')
// Shapes that aren't a list at all.
assert.equal(latestTodos([tool('TodoWrite', { todos: 'nope' })]), null)
assert.equal(latestTodos([tool('TodoWrite', null)]), null)
assert.equal(latestTodos([tool('TodoWrite', { todos: [] })]), null)
assert.equal(latestTodos([tool('TaskCreate', { description: 'no subject' })]), null)

// ---------------------------------------------------------- contextBreakdown

// Verbatim from a live session: the categories sum to 92,328 while totalTokens
// is 23,894, and the list ends with a 976k "Free space" filler.
{
  const cats = [
    { name: 'System prompt', tokens: 95 },
    { name: 'System tools', tokens: 13761 },
    { name: 'MCP tools (deferred)', tokens: 52166, isDeferred: true },
    { name: 'System tools (deferred)', tokens: 16268, isDeferred: true },
    { name: 'Custom agents', tokens: 71 },
    { name: 'Memory files', tokens: 1492 },
    { name: 'Skills', tokens: 2538 },
    { name: 'Messages', tokens: 5937 },
    { name: 'Free space', tokens: 976106 },
  ]
  const { used, deferred } = contextBreakdown(cats, 23894, 1_000_000)

  assert.equal(
    used.reduce((n, c) => n + c.tokens, 0),
    23894,
    'the used categories must sum to exactly totalTokens, or the bar lies',
  )
  assert.equal(used.some((c) => c.name === 'Free space'), false, 'filler is excluded')
  assert.deepEqual(deferred.map((c) => c.name), ['MCP tools (deferred)', 'System tools (deferred)'])
}

// Zero-token categories are dropped so they don't clutter the legend.
assert.deepEqual(contextBreakdown([{ name: 'x', tokens: 0 }], 100, 200).used, [])

// A NEARLY-FULL window is the case a "bigger than the total" rule gets wrong:
// free space is now the smallest entry, and keeping it would read as 100% used.
{
  const { used } = contextBreakdown(
    [
      { name: 'Messages', tokens: 990 },
      { name: 'Free space', tokens: 10 },
    ],
    990,
    1000,
  )
  assert.deepEqual(used.map((c) => c.name), ['Messages'])
  assert.equal(used.reduce((n, c) => n + c.tokens, 0), 990, 'bar still sums to the real total')
}

// A completely full window has no filler at all, so nothing may be dropped.
{
  const { used } = contextBreakdown([{ name: 'Messages', tokens: 1000 }], 1000, 1000)
  assert.deepEqual(used.map((c) => c.name), ['Messages'])
}

// Only ONE category is dropped, so a real one that happens to tie the filler
// size still renders.
{
  const { used } = contextBreakdown(
    [
      { name: 'Free space', tokens: 40 },
      { name: 'Messages', tokens: 40 },
      { name: 'Skills', tokens: 20 },
    ],
    60,
    100,
  )
  assert.deepEqual(used.map((c) => c.name), ['Messages', 'Skills'])
  assert.equal(used.reduce((n, c) => n + c.tokens, 0), 60)
}

// -------------------------------------------------------------- schemaFields

// Anything that isn't a property bag yields no form, so the card can fall back
// to a plain accept/decline rather than rendering an empty box.
assert.deepEqual(schemaFields(undefined), [])
assert.deepEqual(schemaFields({}), [])
assert.deepEqual(schemaFields({ properties: 'nope' }), [])
assert.deepEqual(schemaFields({ properties: { bad: null } }), [])

// The primitive types the MCP spec allows, plus `required` and titles.
{
  const fields = schemaFields({
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string', title: 'Your name', description: 'Full name' },
      age: { type: 'integer' },
      score: { type: 'number' },
      subscribe: { type: 'boolean', default: true },
      plan: { type: 'string', enum: ['free', 'pro'] },
    },
  })
  assert.deepEqual(
    fields.map((f) => [f.name, f.type, f.required]),
    [
      ['name', 'string', true],
      ['age', 'number', false],
      ['score', 'number', false],
      ['subscribe', 'boolean', false],
      ['plan', 'enum', false],
    ],
  )
  assert.equal(fields[0].label, 'Your name', 'title becomes the label')
  assert.equal(fields[0].description, 'Full name')
  assert.equal(fields[1].label, 'age', 'no title falls back to the property name')
  assert.equal(fields[3].default, true)
  assert.deepEqual(fields[4].options, ['free', 'pro'])
}

// An enum is declared `type: 'string'` in the spec — it must still render as a
// dropdown, not a free-text box.
assert.equal(schemaFields({ properties: { x: { type: 'string', enum: ['a'] } } })[0].type, 'enum')

// Field order follows the schema, which is the order the server intended.
assert.deepEqual(
  schemaFields({ properties: { z: { type: 'string' }, a: { type: 'string' } } }).map((f) => f.name),
  ['z', 'a'],
)

// Out-of-spec junk must not produce a half-rendered control.
{
  const f = schemaFields({
    required: 'not-an-array',
    properties: { nested: { type: 'object' }, weird: { type: 'array' } },
  })
  // Both degrade to text inputs rather than being dropped — the server still
  // wants a value, and a text box is the honest generic control.
  assert.deepEqual(f.map((x) => x.type), ['string', 'string'])
  assert.equal(f.every((x) => x.required === false), true, 'bad `required` is ignored, not thrown on')
}

// -------------------------------------------------------------- askQuestions

// Only that one tool, and only when there is something to pick — otherwise the
// caller must fall back to the plain allow/deny card.
assert.equal(askQuestions('Bash', { questions: [] }), null)
assert.equal(askQuestions('AskUserQuestion', null), null)
assert.equal(askQuestions('AskUserQuestion', { questions: 'nope' }), null)
assert.equal(askQuestions('AskUserQuestion', { questions: [] }), null)
assert.equal(
  askQuestions('AskUserQuestion', { questions: [{ question: 'q', options: [] }] }),
  null,
  'a question with no options is not answerable as a card',
)

// Verbatim shape from a live AskUserQuestion call.
{
  const qs = askQuestions('AskUserQuestion', {
    questions: [
      {
        question: 'Tabs or spaces for indentation?',
        header: 'Indentation',
        multiSelect: false,
        options: [
          { label: 'Tabs', description: 'One tab per level.', preview: 'if (x) {\n\treturn 1\n}' },
          { label: 'Spaces', description: 'Fixed width.' },
        ],
      },
    ],
  })
  assert.equal(qs?.length, 1)
  assert.equal(qs?.[0].header, 'Indentation')
  assert.equal(qs?.[0].multiSelect, undefined, 'multiSelect false is omitted, not carried as false')
  assert.deepEqual(qs?.[0].options.map((o) => o.label), ['Tabs', 'Spaces'])
  assert.ok(qs?.[0].options[0].preview?.includes('\t'))
  assert.equal(qs?.[0].options[1].preview, undefined)
}

// multiSelect carries through when actually set.
assert.equal(
  askQuestions('AskUserQuestion', {
    questions: [{ question: 'q', multiSelect: true, options: [{ label: 'a' }] }],
  })?.[0].multiSelect,
  true,
)

// Malformed entries drop out instead of throwing inside a render.
{
  const qs = askQuestions('AskUserQuestion', {
    questions: [
      null,
      { header: 'no question text' },
      { question: 'good', options: [{ label: 'ok' }, null, { description: 'no label' }] },
    ],
  })
  assert.equal(qs?.length, 1)
  assert.deepEqual(qs?.[0].options.map((o) => o.label), ['ok'])
}

// ----------------------------------------------------------------- triggerAt

const at = (s: string) => triggerAt(s, s.length)

// Slash commands: only at the very start of the message.
assert.deepEqual(at('/rev'), { kind: 'command', query: 'rev', start: 0 })
assert.deepEqual(at('/'), { kind: 'command', query: '', start: 0 })
assert.equal(at('run /rev'), null, 'a slash mid-sentence is not a command')

// A bare path must not open the command menu — this is the common false positive.
assert.equal(at('src/foo.ts'), null)
assert.equal(at('look at src/'), null)

// @-mentions at a word boundary, including at the very start.
assert.deepEqual(at('@src'), { kind: 'file', query: 'src', start: 0 })
assert.deepEqual(at('read @src/app.ts'), { kind: 'file', query: 'src/app.ts', start: 5 })
assert.deepEqual(at('read @'), { kind: 'file', query: '', start: 5 })

// An email is the other common false positive.
assert.equal(at('mail me at bob@example.com'), null)

// Whitespace closes the trigger, so a finished mention stops completing.
assert.equal(at('@src/app.ts and then'), null)
assert.equal(at('@src '), null)
assert.equal(at('/rev '), null)

// A slash inside a mention must not steal the trigger from the @.
assert.deepEqual(at('@a/b/c'), { kind: 'file', query: 'a/b/c', start: 0 })

// The caret, not the end of the string, decides.
assert.deepEqual(triggerAt('@src and more', 4), { kind: 'file', query: 'src', start: 0 })
assert.equal(triggerAt('@src and more', 9), null, 'caret past the mention closes it')
assert.equal(triggerAt('', 0), null)
// A caret past the end is clamped rather than producing a wrong slice.
assert.deepEqual(triggerAt('@abc', 99), triggerAt('@abc', 4), 'caret is clamped to the text')
assert.deepEqual(triggerAt('@abc', -5), null, 'a negative caret yields nothing')

// --------------------------------------------------------------------- score

assert.equal(score('New session', ''), 0, 'empty query matches everything')
assert.equal(score('New session', 'zzz'), null)
assert.equal(score('New session', 'New'), 0, 'contiguous prefix is the tightest match')
assert.notEqual(score('New session', 'nse'), null, 'subsequence matches')
assert.ok(
  (score('New session', 'New') ?? 9e9) < (score('New session', 'nse') ?? 9e9),
  'contiguous beats scattered',
)
assert.equal(
  score('New Session', 'NeW sEsSiOn'),
  score('new session', 'new session'),
  'case-insensitive on both sides',
)
assert.equal(score('New session', 'n s'), score('New session', 'ns'), 'spaces are separators')

// ------------------------------------------------------------- filterEntries

const entries = [
  { label: 'Open project…', hint: '⌘O' },
  { label: 'New session', hint: '⌘N' },
  { label: 'foreman', hint: '/tmp/foreman-bed4' },
]

assert.equal(filterEntries(entries, '').length, 3, 'empty query keeps everything')
assert.equal(filterEntries(entries, '   ').length, 3, 'whitespace is an empty query')
assert.deepEqual(filterEntries(entries, 'new').map((e) => e.label), ['New session'])
assert.equal(filterEntries(entries, 'zzzz').length, 0)

// A label match must outrank a hint match, so typing a session name doesn't
// bury it under commands whose shortcut happens to contain the letters.
{
  const ranked = filterEntries(
    [
      { label: 'Toggle terminal', hint: 'bed4' },
      { label: 'bed4', hint: 'a session' },
    ],
    'bed4',
  )
  assert.equal(ranked[0].label, 'bed4', 'label match ranks above hint match')
  assert.equal(ranked.length, 2, 'the hint match still appears')
}

// The original array is never mutated — it comes straight from the store.
{
  const src = [...entries]
  filterEntries(src, 'e')
  assert.deepEqual(src, entries)
}

// ------------------------------------------------------------ planProposal

// Shape confirmed against live transcripts: the SDK's published
// ExitPlanModeInput declares neither key, so nothing but this pins them down.
{
  const got = planProposal('ExitPlanMode', {
    plan: '# Ship the thing\n\n## Context\n\nWhy.',
    planFilePath: '/Users/x/.claude/plans/ship-the-thing-witty-tiger.md',
  })
  assert.ok(got, 'a real ExitPlanMode input yields a proposal')
  assert.equal(got.filePath, '/Users/x/.claude/plans/ship-the-thing-witty-tiger.md')
  assert.match(got.markdown, /^# Ship the thing/)
}

assert.equal(planProposal('Bash', { command: 'ls' }), null, 'other tools are not plans')
assert.equal(planProposal('ExitPlanMode', null), null, 'null input')
assert.equal(planProposal('ExitPlanMode', {}), null, 'no plan key')
assert.equal(planProposal('ExitPlanMode', { plan: '   ' }), null, 'a blank plan is not a plan')
assert.equal(planProposal('ExitPlanMode', { plan: 42 }), null, 'non-string plan')

// A missing path must be absent, not present-and-undefined: the modal keys its
// footer row off `filePath &&`, and renders an empty line for a bad value.
assert.equal(
  'filePath' in planProposal('ExitPlanMode', { plan: '# x' })!,
  false,
  'no planFilePath key when the CLI sent none',
)
assert.equal(
  'filePath' in planProposal('ExitPlanMode', { plan: '# x', planFilePath: '' })!,
  false,
  'an empty planFilePath is dropped, not shown as a blank path',
)

// ---------------------------------------------------------------- planTitle

assert.equal(planTitle('# Ship the thing\n\nbody'), 'Ship the thing')
assert.equal(planTitle('## Nested heading\n'), 'Nested heading', 'h2 counts')
assert.equal(planTitle('Intro line\n\n### Later\n'), 'Later', 'first heading anywhere')
assert.equal(planTitle('## Closed ##'), 'Closed', 'closed ATX heading')
assert.equal(planTitle('  # Indented'), 'Indented', 'up to 3 spaces is still a heading')
// Never empty: it labels the modal, the tab-stop title and the transcript bar.
assert.equal(planTitle('just prose'), 'Implementation plan', 'fallback when unheaded')
assert.equal(planTitle(''), 'Implementation plan', 'fallback when empty')
assert.equal(planTitle('#hashtag not a heading'), 'Implementation plan', 'needs the space')

// ------------------------------------------------------------------ toolLabel

assert.equal(toolLabel('mcp__jcodemunch__get_file_content'), 'MCP jcodemunch Get File Content')
// Hyphens are word separators too, and the server segment keeps its own casing
// and underscores — it's a name from the user's MCP config, not prose.
assert.equal(
  toolLabel('mcp__plugin_context7_context7__query-docs'),
  'MCP plugin_context7_context7 Query Docs',
)
// Built-ins that already read correctly are NOT in the registry, and must keep
// passing through — relabelling those could only break them.
for (const name of ['Read', 'Bash', 'Edit', 'Write', 'Grep', 'WebFetch', 'WebSearch', ''])
  assert.equal(toolLabel(name), name, `passthrough: ${name || '(empty)'}`)
// The registry wins over passthrough, and over the mcp__ transform.
assert.equal(toolLabel('ExitPlanMode'), 'Plan')
assert.equal(toolLabel('AskUserQuestion'), 'Asked')
assert.equal(toolLabel('ToolSearch'), 'Loaded tools')
// Degenerate shapes must not throw — these come off the wire.
assert.equal(toolLabel('mcp__server'), 'MCP server', 'no tool segment')
assert.equal(toolLabel('mcp__'), 'mcp__', 'no server segment either')
assert.equal(toolLabel('mcp__s__a__b'), 'MCP s A B', 'extra __ belongs to the tool')

// ------------------------------------------------------------------- toolVerb

// The transcript renders a call as a sentence, and the tense IS the running
// indicator — Cursor ships no spinner on these rows, so a verb stuck in the
// past tense is a call that looks finished while it is still going.
assert.equal(toolVerb('Bash'), 'Ran')
assert.equal(toolVerb('Bash', true), 'Running')
assert.equal(toolVerb('Grep'), 'Searched files')
assert.equal(toolVerb('Grep', true), 'Searching files')
// Glob and Grep are one verb on purpose: "searched files" is what both did, and
// the argument already says whether it was a pattern or a path.
assert.equal(toolVerb('Glob'), toolVerb('Grep'))
// Both names for the subagent tool have to land on the same verb, for the same
// reason summarise() pairs them — older transcripts carry 'Task'.
assert.equal(toolVerb('Agent'), toolVerb('Task'))
assert.equal(toolVerb('Task'), 'Delegated')
// Every edit tool reads as one verb; the argument carries which file.
for (const name of ['Edit', 'MultiEdit', 'NotebookEdit'])
  assert.equal(toolVerb(name), 'Edited', `edit verb: ${name}`)
// Anything unmapped falls back to toolLabel rather than inventing a verb for a
// tool we know nothing about — MCP especially, where the name is user config.
assert.equal(toolVerb('mcp__jcodemunch__get_file_content'), 'MCP jcodemunch Get File Content')
assert.equal(toolVerb('SomeFutureTool'), 'SomeFutureTool')
assert.equal(toolVerb('SomeFutureTool', true), 'SomeFutureTool', 'no tense to offer')
// The registry label still wins for record-rendered tools, which never reach a
// tool row anyway — but must not start returning undefined if they ever do.
assert.equal(toolVerb('ExitPlanMode'), 'Plan')
assert.equal(toolVerb(''), '', 'degenerate name must not throw')

// -------------------------------------------------------------- groupTranscript

{
  const say = (id: string): ChatItem => ({ id, kind: 'assistant', text: 'x' })
  const rows = transcriptRows([
    say('a1'),
    say('a2'), // streaming emits several per turn — only the first leads
    tool('Read', {}),
    tool('Edit', {}),
    say('a3'),
    tool('Bash', {}),
  ])

  assert.deepEqual(
    rows.map((r) => `${r.item.kind}:${r.leadsTurn}`),
    ['assistant:true', 'assistant:false', 'tool:false', 'tool:false', 'assistant:true', 'tool:false'],
    'one row per item, and only the turn-opening assistant is flagged',
  )
}

// An empty transcript and an all-tools one are the boundary cases.
assert.deepEqual(transcriptRows([]), [])
assert.equal(transcriptRows([tool('Read', {}), tool('Read', {})]).length, 2, 'tools no longer fold')

// Checklist events produce no row — TodoStrip renders the fold of them, and a
// row per event would say nothing the strip doesn't say better. Critically,
// latestTodos still sees them, because this filters at render, not in the store.
{
  const plan = [create(1, 'Ship it'), update(1, 'in_progress'), tool('Bash', {})]
  assert.deepEqual(
    transcriptRows(plan).map((r) => (r.item.kind === 'tool' ? r.item.name : r.item.kind)),
    ['Bash'],
    'TaskCreate/TaskUpdate are hidden from the transcript',
  )
  assert.equal(latestTodos(plan)?.length, 1, '...but the checklist still folds them')
}

// -------------------------------------------------------------- groupTurns

{
  const ask = (id: string, text = 'q'): ChatItem => ({ id, kind: 'user', text })
  const say = (id: string): ChatItem => ({ id, kind: 'assistant', text: 'x' })
  const done = (id: string, durationMs: number): ChatItem => ({
    id,
    kind: 'result',
    text: '',
    costUsd: 0,
    durationMs,
    isError: false,
  })

  // The tool() helper's ids come off a file-global counter, so they are captured
  // rather than written out — hardcoding 'i1' here couples this block to how
  // many tools every block above it happened to build.
  const read = tool('Read', {})
  const bash = tool('Bash', {})
  const turns = groupTurns(
    transcriptRows([
      ask('u1'),
      say('a1'), // mid-turn commentary — work, not answer
      read,
      say('a2'), // trailing run...
      say('a3'), // ...both belong to the answer
      done('r1', 7000),
      ask('u2'),
      bash,
    ]),
  )

  assert.equal(turns.length, 2, 'a user message opens a turn')
  assert.deepEqual(turns.map((t) => t.lead?.item.id), ['u1', 'u2'])
  // The split is the TRAILING run of assistant blocks. An assistant block with
  // tool calls after it is commentary and folds away with them; streaming emits
  // several blocks for one answer and all of them have to stay visible.
  assert.deepEqual(turns[0].work.map((r) => r.item.id), ['a1', read.id])
  assert.deepEqual(turns[0].tail.map((r) => r.item.id), ['a2', 'a3', 'r1'])
  assert.equal(turns[0].durationMs, 7000, 'read off the result, not timed')
  // Still running: no result yet, so no duration and nothing in the answer.
  assert.equal(turns[1].durationMs, null)
  assert.deepEqual(turns[1].work.map((r) => r.item.id), [bash.id])
  assert.deepEqual(turns[1].tail, [])
}

// A transcript resumed from disk can begin mid-turn, with work and no user
// message to hang it on. That must still produce a turn rather than dropping
// every row before the first question.
{
  const turns = groupTurns(transcriptRows([tool('Read', {}), { id: 'a', kind: 'assistant', text: 'x' }]))
  assert.equal(turns.length, 1)
  assert.equal(turns[0].lead, null)
  assert.equal(turns[0].work.length, 1)
  assert.equal(turns[0].tail.length, 1)
}

// Two questions in a row — a queued message lands as a second user item before
// the first turn has produced anything.
{
  const turns = groupTurns(transcriptRows([
    { id: 'u1', kind: 'user', text: 'a' },
    { id: 'u2', kind: 'user', text: 'b' },
  ]))
  assert.equal(turns.length, 2, 'each question opens its own turn')
  assert.deepEqual(turns.map((t) => t.work.length), [0, 0])
}

// A failed turn keeps its result in the tail, so folding the turn can never
// hide that it failed.
{
  const turns = groupTurns(transcriptRows([
    { id: 'u1', kind: 'user', text: 'a' },
    tool('Bash', {}),
    { id: 'r1', kind: 'result', text: '', costUsd: 0, durationMs: 400, isError: true },
  ]))
  assert.deepEqual(turns[0].tail.map((r) => r.item.id), ['r1'])
  assert.deepEqual(turns[0].work.map((r) => r.item.kind), ['tool'])
}

assert.deepEqual(groupTurns([]), [], 'empty transcript')

// -------------------------------------------------------------- toolRender

assert.equal(toolRender('TaskCreate'), 'hidden')
assert.equal(toolRender('AskUserQuestion'), 'record')
assert.equal(toolRender('ExitPlanMode'), 'record')
assert.equal(toolRender('Read'), undefined, 'ordinary tools keep their card')
assert.equal(toolRender('mcp__x__y'), undefined)

// --------------------------------------------------------- answeredQuestions

assert.equal(answeredQuestions({}, undefined), null, 'not a question set')

{
  const input = {
    questions: [
      { question: 'Which titler?', header: 'Titling', options: [{ label: 'Haiku' }] },
      { question: 'Tooltips?', header: 'Tooltips', options: [{ label: 'CSS' }] },
    ],
  }

  // Still open: the prompt is up and nothing has come back yet.
  assert.deepEqual(
    answeredQuestions(input, undefined)?.map((a) => [a.header, a.answer]),
    [['Titling', ''], ['Tooltips', '']],
    'pending questions report their headers with no answer',
  )

  // Answered. The wire format is QuestionCard's: prefix line, then `q → a`.
  const result = `${ANSWER_PREFIX}\nWhich titler? → Haiku\nTooltips? → CSS`
  assert.deepEqual(
    answeredQuestions(input, result)?.map((a) => [a.header, a.answer]),
    [['Titling', 'Haiku'], ['Tooltips', 'CSS']],
  )

  // Skipped: denied with no answer payload, so there is nothing to show.
  assert.deepEqual(
    answeredQuestions(input, 'The user doesn\'t want to proceed')?.map((a) => a.answer),
    ['', ''],
    'a skip is not mistaken for an answer',
  )

  // A question containing the separator must not split on its own arrow —
  // which is why matching is positional and takes the LAST ' → '.
  const tricky = { questions: [{ question: 'a → b?', options: [{ label: 'x' }] }] }
  assert.equal(
    answeredQuestions(tricky, `${ANSWER_PREFIX}\na → b? → x`)?.[0].answer,
    'x',
  )

  // --- the richer wire format: Other, notes, and both at once ---
  //
  // EVERY ASSERT ABOVE IS THE BACKWARD-COMPATIBILITY PROOF and must stay
  // untouched: the format below is a strict superset, so a transcript recorded
  // by an older build still parses through the same code path. These add the
  // new shapes.

  /** A two-question payload whose second answer is always plain 'CSS'. */
  const wire = (first: string): string => `${ANSWER_PREFIX}\nWhich titler? → ${first}\nTooltips? → CSS`

  // Free text rides as a comma-joined item tagged `Other: `, so it lands inside
  // the answer rather than needing a field of its own.
  assert.equal(
    answeredQuestions(input, wire('Other: something else'))?.[0].answer,
    'Other: something else',
  )

  // A note appends to the RIGHT of the arrow, so the split is unaffected and the
  // note simply reads as part of the answer.
  assert.equal(
    answeredQuestions(input, wire('Haiku — note: cheapest'))?.[0].answer,
    'Haiku — note: cheapest',
  )

  // Picks, Other and a note together, multi-select.
  const rich = 'Haiku, Sonnet, Other: whatever is cheapest — note: cost matters'
  assert.equal(answeredQuestions(input, wire(rich))?.[0].answer, rich)

  // A question that itself contains ' → ' AND carries a note. lastIndexOf finds
  // the question's arrow, not the answer's, unless the note keeps its distance —
  // which it does, being to the right of it.
  assert.equal(
    answeredQuestions(tricky, `${ANSWER_PREFIX}\na → b? → x — note: because`)?.[0].answer,
    'x — note: because',
  )

  // A user who TYPES an arrow into a note. This is the case the sender's
  // sanitize() exists for: it rewrites ' → ' to ' -> ' before it ever reaches
  // the wire, so the last ' → ' on the line is still the real separator.
  assert.equal(
    answeredQuestions(tricky, `${ANSWER_PREFIX}\na → b? → x — note: a -> b is fine`)?.[0].answer,
    'x — note: a -> b is fine',
    'a sanitized arrow inside a note cannot steal the split',
  )

  // THE REGRESSION THAT MATTERS: matching is positional, so anything that could
  // add a line — a note, a long Other — would shift every later answer by one.
  // Q1 carries both here; Q2's answer must still be at index 1.
  const both = 'Other: my own model — note: two lines worth of thought, collapsed to one'
  assert.deepEqual(
    answeredQuestions(input, wire(both))?.map((a) => a.answer),
    [both, 'CSS'],
    'a note on Q1 does not shift Q2',
  )
}

// ----------------------------------------------------------------- workingVerb

// Must stay in range for any id, and advance with the tick.
assert.ok(WORKING_VERBS.includes(workingVerb('', 0)), 'empty session id is still in range')
assert.ok(WORKING_VERBS.includes(workingVerb('abc', 99999)), 'tick wraps rather than overflowing')
assert.notEqual(workingVerb('abc', 0), workingVerb('abc', 1), 'the verb actually rotates')

// ----------------------------------------------------------------- hms / fmt

// These reprint every second under a running turn, so a wrong branch is a
// visible twitch rather than a silent bug — but the boundaries are still easy
// to get wrong by one.
assert.equal(hms(0), '0s')
assert.equal(hms(19_000), '19s')
assert.equal(hms(59_999), '59s', 'rounds down, so it never prints 60s')
assert.equal(hms(60_000), '1m 0s')
assert.equal(hms(301_000), '5m 1s')
assert.equal(hms(3_599_000), '59m 59s')
assert.equal(hms(3_600_000), '1h 0m')
assert.equal(hms(3_720_000), '1h 2m')
assert.equal(hms(-5), '0s', 'clock skew must not print a negative')

assert.equal(fmt(0), '0')
assert.equal(fmt(842), '842')
assert.equal(fmt(1000), '1.0k')
assert.equal(fmt(4210), '4.2k')
assert.equal(fmt(42_100), '42k', 'no decimal past 10k — it is noise at 5 digits')
assert.equal(fmt(1_000_000), '1M', 'not 1000k, and not 1.0M')
assert.equal(fmt(1_500_000), '1.5M')

// ------------------------------------------------------- projects and usage

{
  assert.equal(projectKey('/a/b/'), '/a/b', 'trailing slash normalised')
  assert.equal(projectKey('/A/B'), '/a/b', 'case normalised — APFS is insensitive')

  const live = [{ cwd: '/repo/one', worktree: undefined, createdAt: 1 }] as Parameters<
    typeof recentProjects
  >[0]
  const past = [{ cwd: '/repo/one' }, { cwd: '/repo/two' }, { cwd: '/repo/three' }]

  const all = recentProjects(live, past, [])
  assert.deepEqual(
    all.map((r) => r.hint),
    ['/repo/one', '/repo/two', '/repo/three'],
    'live project first, then past, deduped',
  )
  assert.equal(all[0].open, true, 'the live one is flagged open')
  assert.equal(all[0].label, 'one', 'label is the basename')

  const hidden = recentProjects(live, past, ['/repo/two'])
  assert.deepEqual(
    hidden.map((r) => r.hint),
    ['/repo/one', '/repo/three'],
    'a hidden project drops out',
  )

  // The invariant the UI depends on: you cannot hide the directory you are
  // working in, or you get a row you can neither explain nor remove.
  const cannotHide = recentProjects(live, past, ['/repo/one'])
  assert.equal(cannotHide[0].hint, '/repo/one', 'an OPEN project is never hidden')

  // Hiding is key-based, so case and trailing slash still match.
  assert.equal(
    recentProjects([], past, ['/REPO/TWO/']).some((r) => r.hint === '/repo/two'),
    false,
    'hide-list matches on the normalised key',
  )

  // A worktree session contributes its repoRoot, not its scratch checkout —
  // opening the scratch dir would start an agent inside it.
  const wt = recentProjects(
    [
      {
        cwd: '/tmp/wt-x',
        worktree: { path: '/tmp/wt-x', branch: 'b', repoRoot: '/repo/four' },
        createdAt: 1,
      },
    ],
    [],
    [],
  )
  assert.equal(wt[0].hint, '/repo/four', 'worktree resolves to repoRoot')

  // Live projects come back newest first, the same order groupSessions uses.
  // Home renders the two lists one above the other, so a disagreement here puts
  // two orderings of the same projects on one screen pointing opposite ways.
  const ordered = recentProjects(
    [
      { cwd: '/repo/old', worktree: undefined, createdAt: 10 },
      { cwd: '/repo/new', worktree: undefined, createdAt: 30 },
      { cwd: '/repo/mid', worktree: undefined, createdAt: 20 },
    ],
    [],
    [],
  )
  assert.deepEqual(
    ordered.map((r) => r.hint),
    ['/repo/new', '/repo/mid', '/repo/old'],
    'live projects are newest first, matching groupSessions',
  )
}

// -------------------------------------------------------------------- relPath

assert.equal(relPath('/a/b/c.ts', '/a/b'), 'c.ts')
assert.equal(relPath('/a/b/d/e.ts', '/a/b'), 'd/e.ts', 'nested stays nested')
assert.equal(relPath('/a/b/c.ts', '/a/b/'), 'c.ts', 'trailing slash on cwd')
// The basename, not '.', which reads as a rendering bug. Reachable via any MCP
// tool handed the project root as its `path`.
assert.equal(relPath('/a/b', '/a/b'), 'b', 'the cwd itself renders as its name')
assert.equal(relPath('/a/b/', '/a/b'), 'b', 'trailing slash on the path too')

// The one that bites: without the trailing slash on the prefix, a cwd of
// /a/foo would swallow its sibling /a/foobar and render it as `bar/x`.
assert.equal(relPath('/a/foobar/x', '/a/foo'), '/a/foobar/x', 'sibling is not a child')

// Case-folded like projectKey, but the ORIGINAL casing is what comes back.
assert.equal(relPath('/A/B/c.ts', '/a/b'), 'c.ts', 'APFS is case-insensitive')
assert.equal(relPath('/a/b/C.ts', '/a/b'), 'C.ts', 'casing preserved in the result')

// Outside the cwd stays absolute — a ../../../ chain reads worse than the
// path it replaced.
assert.equal(relPath('/etc/hosts', '/a/b'), '/etc/hosts')

for (const [p, cwd] of [
  ['', '/a'],
  ['/a/b', ''],
  ['relative.ts', '/a'],
  ['/a/b', '/'],
] as const) {
  assert.equal(relPath(p, cwd), p, `passthrough: ${p || '(empty)'} against ${cwd || '(empty)'}`)
}

{
  const s = (
    id: string,
    cwd: string,
    createdAt: number,
    worktree?: SessionMeta['worktree'],
  ): SessionMeta => ({ id, cwd, createdAt, worktree }) as SessionMeta

  const groups = groupSessions([
    s('a', '/repo/one', 10),
    s('b', '/repo/two', 30),
    s('c', '/tmp/wt', 20, { path: '/tmp/wt', branch: 'x', repoRoot: '/repo/one' }),
  ])
  assert.equal(groups.length, 2, 'a worktree groups under its repo, not on its own')
  assert.deepEqual(
    groups.find((g) => g.root === '/repo/one')?.sessions.map((x) => x.id),
    ['c', 'a'],
    'newest first within a group',
  )

  // A group ranks by its own newest member, so the very first row of the rail
  // is the newest session overall. /repo/two's only session (30) beats
  // /repo/one's newest (20) even though /repo/one holds more sessions and was
  // seen first.
  assert.deepEqual(groups.map((g) => g.root), ['/repo/two', '/repo/one'], 'newest group first')
  assert.equal(groups[0].sessions[0].id, 'b', 'the top row is the newest session, full stop')

  // Insertion order must not leak through when the times tie.
  const tied = groupSessions([s('x', '/r', 5), s('y', '/r', 5)])
  assert.deepEqual(tied[0].sessions.map((n) => n.id), ['x', 'y'], 'stable on equal createdAt')

  assert.deepEqual(groupSessions([]), [], 'empty in, empty out')
}

// ------------------------------------------------------------- newestSession

{
  const s = (id: string, createdAt: number): SessionMeta => ({ id, createdAt }) as SessionMeta
  assert.equal(newestSession([s('a', 10), s('c', 30), s('b', 20)])?.id, 'c')
  assert.equal(newestSession([s('only', 1)])?.id, 'only')
  // Seedless reduce would throw here — the length guard is the whole point.
  assert.equal(newestSession([]), undefined, 'empty is undefined, not a throw')
}

{
  const rows = [
    { sdkSessionId: 's1', costUsd: 1, inputTokens: 10, outputTokens: 5, cwd: '/repo/one' },
    { sdkSessionId: 's2', costUsd: 2, inputTokens: 20, outputTokens: 6, cwd: '/repo/one' },
    { sdkSessionId: 's3', costUsd: 4, inputTokens: 30, outputTokens: 7 },
  ]
  // s3 has no cwd of its own, so it falls back to the id join against `past`.
  const t = aggregateUsage(rows, [{ sessionId: 's3', cwd: '/repo/two' }])
  assert.equal(t.costUsd, 7, 'totals sum every row')
  assert.equal(t.inputTokens, 60)
  assert.equal(t.sessions, 3)
  assert.deepEqual(
    t.byProject.map((p) => [p.root, p.costUsd]),
    [
      ['/repo/two', 4],
      ['/repo/one', 3],
    ],
    'sorted by spend, and the legacy row is attributed via the id join',
  )
  assert.equal(t.unattributed.sessions, 0)

  // With no join available that row must land in unattributed, not vanish —
  // the headline total has to keep adding up.
  const orphan = aggregateUsage(rows, [])
  assert.equal(orphan.costUsd, 7, 'unattributable spend still counts toward the total')
  assert.equal(orphan.unattributed.sessions, 1)
  assert.equal(orphan.unattributed.costUsd, 4)
}

// --------------------------------------------------------------- focusTarget

{
  assert.deepEqual(focusTarget('Read', { file_path: '/a/x.ts', offset: 40 }), {
    path: '/a/x.ts',
    line: 40,
    anchor: '',
    weight: 'read',
  })
  assert.equal(
    focusTarget('Read', { file_path: '/a/x.ts' })!.line,
    null,
    'no offset means the whole file was read — there is no line to reveal',
  )

  const edit = focusTarget('Edit', {
    file_path: '/a/x.ts',
    old_string: '\n\n  const value = 1\n  more()',
    new_string: 'x',
  })!
  assert.equal(edit.line, null, 'an Edit carries NO line number and never will')
  assert.equal(edit.anchor, 'const value = 1', 'first non-empty line, trimmed')
  assert.equal(edit.weight, 'write')

  assert.equal(
    focusTarget('MultiEdit', {
      file_path: '/a/x.ts',
      edits: [{ old_string: '  first()\nsecond()' }, { old_string: 'later()' }],
    })!.anchor,
    'first()',
    'MultiEdit anchors on its first edit',
  )
  assert.equal(focusTarget('Write', { file_path: '/a/x.ts', content: 'z' })!.line, 1)
  assert.equal(
    focusTarget('NotebookEdit', { notebook_path: '/a/n.ipynb' })!.line,
    null,
    'a notebook is JSON; there is no line mapping to pretend to',
  )

  // THE RULE. Asserted so nobody helpfully adds it later: a Grep's hits live in
  // its RESULT, not its input, and a search is the agent thinking rather than
  // working — following one flips the editor to a file it looks at for 200ms.
  assert.equal(focusTarget('Grep', { pattern: 'x', path: '/a' }), null, 'Grep never moves the viewport')
  assert.equal(focusTarget('Bash', { command: 'ls' }), null)
  assert.equal(focusTarget('Glob', { pattern: '**/*.ts' }), null)
  assert.equal(focusTarget('WebFetch', { url: 'http://x' }), null)

  // An MCP tool that names a file is still worth following.
  assert.equal(focusTarget('mcp__lsp__lsp_hover', { path: '/a/x.ts' })!.path, '/a/x.ts')

  // Malformed input must return null, not throw inside a render.
  for (const bad of [null, undefined, 42, 'str', {}, { file_path: 7 }, { edits: 'no' }]) {
    for (const name of ['Read', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit']) {
      assert.doesNotThrow(() => focusTarget(name, bad), `${name} on ${JSON.stringify(bad)}`)
    }
  }
  assert.equal(focusTarget('Edit', {}), null, 'no path, no target')
}

// ------------------------------------------------- authorEdits / resolveAnchors

{
  const items: ChatItem[] = [
    tool('Read', { file_path: '/a/x.ts' }),
    tool('Edit', { file_path: '/a/x.ts', old_string: 'const a = 1', new_string: 'const a = 2' }),
    tool('Edit', { file_path: '/a/other.ts', old_string: 'zzz', new_string: 'y' }),
    tool('Write', { file_path: '/a/x.ts', content: 'whole' }),
    tool('Edit', { file_path: '/a/x.ts', old_string: 'const b = 3', new_string: 'const b = 4' }),
  ]
  const edits = authorEdits(items, '/a/x.ts')
  // NEW_STRING, because this runs AFTER the edit landed. Anchoring on
  // old_string here would match nothing in the post-edit document, essentially
  // always — a gutter that silently never links, which reads as a dead feature.
  assert.deepEqual(
    edits.map((e) => e.anchor),
    ['const a = 2', 'const b = 4'],
    'writes to this path only; a Read contributes nothing and a Write has no anchor',
  )

  // The document as it is NOW, i.e. after those edits.
  const doc = 'header\nconst a = 2\nmiddle\nconst b = 4\ntail'
  assert.deepEqual(
    resolveAnchors(doc, edits),
    [
      { line: 2, itemId: edits[0]!.itemId },
      { line: 4, itemId: edits[1]!.itemId },
    ],
    'both land, because both anchors are the text that is actually there',
  )

  // And the fail-closed case: text the user has since changed by hand.
  assert.deepEqual(
    resolveAnchors('header\nconst a = 999\nmiddle\nconst b = 4\ntail', edits),
    [{ line: 4, itemId: edits[1]!.itemId }],
    'a moved-on line drops its link rather than guessing at a position',
  )

  // A MultiEdit contributes one anchor PER edit, all pointing at the same card.
  const multi = authorEdits(
    [
      tool('MultiEdit', {
        file_path: '/a/x.ts',
        edits: [
          { old_string: 'p', new_string: 'alpha()' },
          { old_string: 'q', new_string: 'beta()' },
        ],
      }),
    ],
    '/a/x.ts',
  )
  assert.deepEqual(multi.map((e) => e.anchor), ['alpha()', 'beta()'])
  assert.equal(multi[0]!.itemId, multi[1]!.itemId, 'both jump to the one card that made them')

  // Two edits with the same anchor take different lines rather than stacking.
  const dupes = [
    { itemId: 'i1', anchor: 'same' },
    { itemId: 'i2', anchor: 'same' },
  ]
  assert.deepEqual(
    resolveAnchors('same\nsame\n', dupes).map((r) => r.line),
    [1, 2],
    'a contested anchor does not put two links on one line',
  )
  assert.deepEqual(resolveAnchors('nothing here', dupes), [], 'no match, no range')
  assert.deepEqual(resolveAnchors('', [{ itemId: 'i', anchor: '' }]), [], 'an empty anchor never matches')
}

// ------------------------------------------------------------------ buildTree

{
  assert.deepEqual(buildTree([]), [], 'empty in, empty out')

  // One deep path has to materialise every intermediate directory, none of which
  // appear in the input.
  const deep = buildTree(['a/b/c/d.ts'])
  assert.equal(deep.length, 1)
  assert.equal(deep[0]!.name, 'a')
  assert.equal(deep[0]!.children![0]!.children![0]!.children![0]!.path, 'a/b/c/d.ts')
  assert.equal(
    deep[0]!.children![0]!.children![0]!.children![0]!.children,
    undefined,
    'a file has no children key at all — that is how the UI tells them apart',
  )

  // Siblings share the parent rather than each growing their own.
  const sib = buildTree(['src/a.ts', 'src/b.ts', 'src/deep/c.ts'])
  assert.equal(sib.length, 1, 'one root directory')
  assert.deepEqual(
    sib[0]!.children!.map((n) => n.name),
    ['deep', 'a.ts', 'b.ts'],
    'directories first, then files, each alphabetical',
  )

  // Sort order is by name within each group, NOT by input order.
  assert.deepEqual(
    buildTree(['z.ts', 'a.ts', 'M.ts']).map((n) => n.name),
    ['a.ts', 'M.ts', 'z.ts'],
    'localeCompare, so case does not split the alphabet',
  )

  // The collision case: `foo` is both a file and a directory. Keeping the
  // directory loses one path; keeping the file would lose every path under it.
  const clash = buildTree(['foo', 'foo/bar.ts'])
  assert.equal(clash.length, 1)
  assert.ok(clash[0]!.children, 'the directory wins')
  assert.deepEqual(clash[0]!.children!.map((n) => n.path), ['foo/bar.ts'])

  // Normalisation: none of these may drop a path or invent an empty node.
  assert.deepEqual(buildTree(['./a.ts']).map((n) => n.path), ['a.ts'], 'leading ./ stripped')
  assert.deepEqual(buildTree(['a//b.ts']).map((n) => n.name), ['a'], 'doubled slash collapsed')
  assert.deepEqual(buildTree(['']), [], 'an empty path yields no node')
  assert.deepEqual(buildTree(['/']), [], 'a bare separator yields no node')

  // Paths git actually emits: spaces and non-ASCII must survive intact.
  assert.deepEqual(
    buildTree(['my dir/café 🎉.ts']).map((n) => n.children![0]!.path),
    ['my dir/café 🎉.ts'],
  )
}

console.log('derive: ok')
