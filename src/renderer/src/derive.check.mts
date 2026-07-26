/**
 * Self-check for the renderer's pure derivations: `npm run check:derive`.
 *
 * Both of these chew on data the agent authored, so the failure modes are a
 * thrown exception inside a render (blank pane) or a silently empty strip —
 * neither of which announces itself.
 */
import { strict as assert } from 'node:assert'
import type { ChatItem } from '../../shared/types'
import { latestTodos, score, filterEntries } from './derive.mts'

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
