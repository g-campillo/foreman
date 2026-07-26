/**
 * Self-check for the renderer's pure derivations: `npm run check:derive`.
 *
 * Both of these chew on data the agent authored, so the failure modes are a
 * thrown exception inside a render (blank pane) or a silently empty strip —
 * neither of which announces itself.
 */
import { strict as assert } from 'node:assert'
import type { ChatItem } from '../../shared/types'
import { latestTodos, score, filterEntries, schemaFields, contextBreakdown } from './derive.mts'

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

console.log('derive: ok')
