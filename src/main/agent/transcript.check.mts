/**
 * Self-check for transcript replay: `npm run check:transcript`.
 *
 * This parses data the CLI wrote, possibly an older version of it, so the
 * failure modes are quiet: a resumed session that renders blank, tool cards
 * stuck spinning forever, or subagent chatter interleaved into the main thread.
 */
import { strict as assert } from 'node:assert'
import type { ChatItem } from '../../shared/types'
import { normaliseTranscript, searchTranscript, type StoredMessage } from './transcript.mts'

/** Narrowing helpers — ChatItem is a union, and only some arms carry text. */
const textOf = (i: ChatItem | undefined): string =>
  i && i.kind !== 'tool' ? i.text : ''
const statusOf = (i: ChatItem | undefined): string | undefined =>
  i && i.kind === 'tool' ? i.status : undefined
const resultOf = (i: ChatItem | undefined): string | undefined =>
  i && i.kind === 'tool' ? i.result : undefined
const uuidOf = (i: ChatItem | undefined): string | undefined =>
  i && (i.kind === 'user' || i.kind === 'assistant') ? i.uuid : undefined


const user = (uuid: string, content: unknown, parent?: string): StoredMessage => ({
  type: 'user',
  uuid,
  message: { role: 'user', content },
  parent_tool_use_id: parent ?? null,
})
const assistant = (uuid: string, content: unknown, parent?: string): StoredMessage => ({
  type: 'assistant',
  uuid,
  message: { role: 'assistant', content },
  parent_tool_use_id: parent ?? null,
})

// ------------------------------------------------------------ basic replay

assert.deepEqual(normaliseTranscript([]), [])

// A plain exchange. User content is a bare string in older transcripts.
{
  const items = normaliseTranscript([
    user('u1', 'hello there'),
    assistant('a1', [{ type: 'text', text: 'hi back' }]),
  ])
  assert.deepEqual(items.map((i) => [i.kind, textOf(i)]), [
    ['user', 'hello there'],
    ['assistant', 'hi back'],
  ])
  // The uuid has to survive: rewind and fork address messages by it.
  assert.equal(uuidOf(items[0]), 'u1')
  assert.equal(uuidOf(items[1]), 'a1')
}

// Block-form user content, which is what an attachment produces.
assert.equal(
  textOf(normaliseTranscript([user('u1', [{ type: 'text', text: 'block form' }])])[0]),
  'block form',
)

// Thinking blocks keep their own kind rather than merging into the reply.
assert.deepEqual(
  normaliseTranscript([
    assistant('a1', [
      { type: 'thinking', thinking: 'hmm' },
      { type: 'text', text: 'answer' },
    ]),
  ]).map((i) => i.kind),
  ['thinking', 'assistant'],
)

// ------------------------------------------------------- tools and results

// A tool_use followed by its tool_result must render as ONE completed card.
{
  const items = normaliseTranscript([
    assistant('a1', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }]),
    user('u2', [{ type: 'tool_result', tool_use_id: 't1', content: 'file.txt' }]),
  ])
  assert.equal(items.length, 1, 'the tool_result must not add a second item')
  assert.equal(items[0].kind, 'tool')
  assert.equal(statusOf(items[0]), 'done')
  assert.equal(resultOf(items[0]), 'file.txt')
}

// A stored transcript is finished: nothing may render as still-pending, or a
// tool that ran days ago spins forever.
assert.equal(
  statusOf(normaliseTranscript([assistant('a1', [{ type: 'tool_use', id: 't1', name: 'Read' }])])[0]),
  'done',
)

// Errors carry through.
{
  const items = normaliseTranscript([
    assistant('a1', [{ type: 'tool_use', id: 't1', name: 'Bash' }]),
    user('u2', [{ type: 'tool_result', tool_use_id: 't1', content: 'boom', is_error: true }]),
  ])
  assert.equal(statusOf(items[0]), 'error')
}

// Array-form tool_result content is joined, not stringified as [object Object].
{
  const items = normaliseTranscript([
    assistant('a1', [{ type: 'tool_use', id: 't1', name: 'Read' }]),
    user('u2', [
      {
        type: 'tool_result',
        tool_use_id: 't1',
        content: [{ type: 'text', text: 'line1' }, { type: 'text', text: 'line2' }],
      },
    ]),
  ])
  assert.equal(resultOf(items[0]), 'line1line2')
}

// A tool-results-only user turn is plumbing, not something the user typed —
// rendering it would put an empty bubble after every single tool call.
assert.equal(
  normaliseTranscript([user('u1', [{ type: 'tool_result', tool_use_id: 'nope', content: 'x' }])])
    .length,
  0,
)

// A result for a tool we never saw must not throw.
assert.doesNotThrow(() =>
  normaliseTranscript([user('u1', [{ type: 'tool_result', tool_use_id: 'ghost', content: 'x' }])]),
)

// ------------------------------------------------------------- robustness

// Subagent messages carry parent_tool_use_id and must not interleave into the
// main transcript — the same hazard that holds forwardSubagentText back.
assert.deepEqual(
  normaliseTranscript([
    user('u1', 'main'),
    assistant('a1', [{ type: 'text', text: 'subagent chatter' }], 'tool-123'),
  ]).map((i) => textOf(i)),
  ['main'],
)

// System messages are skipped.
assert.deepEqual(
  normaliseTranscript([{ type: 'system', uuid: 's1', message: { content: 'compacted' } }]),
  [],
)

// Junk from an older CLI degrades to nothing rather than throwing mid-render.
for (const junk of [null, undefined, 'a string', 42, { content: null }, { content: 7 }]) {
  assert.doesNotThrow(
    () => normaliseTranscript([{ type: 'assistant', uuid: 'x', message: junk }]),
    `message: ${JSON.stringify(junk)}`,
  )
}
assert.deepEqual(normaliseTranscript([{ type: 'assistant', uuid: 'x', message: null }]), [])

// Ids must be unique or React collapses rows onto each other.
{
  const items = normaliseTranscript([
    assistant('a1', [
      { type: 'text', text: 'one' },
      { type: 'text', text: 'two' },
    ]),
  ])
  assert.equal(new Set(items.map((i) => i.id)).size, items.length, 'ids are unique')
}

// --------------------------------------------------------- searchTranscript

const convo = [
  user('u1', 'please refactor the parser'),
  assistant('a1', [{ type: 'text', text: 'I rewrote the parser to be iterative.' }]),
]

assert.equal(searchTranscript(convo, ''), null, 'empty query matches nothing')
assert.equal(searchTranscript(convo, 'kubernetes'), null)

{
  const hit = searchTranscript(convo, 'parser')
  assert.equal(hit?.matches, 2, 'counts every message that matches')
  assert.ok(hit?.snippet.includes('parser'))
}

// Case-insensitive, and tool names/output are searchable too.
assert.ok(searchTranscript(convo, 'PARSER'))
{
  const withTool = [
    assistant('a1', [{ type: 'tool_use', id: 't1', name: 'Grep' }]),
    user('u2', [{ type: 'tool_result', tool_use_id: 't1', content: 'needle found here' }]),
  ]
  assert.ok(searchTranscript(withTool, 'needle'), 'tool output is searchable')
  assert.ok(searchTranscript(withTool, 'Grep'), 'tool name is searchable')
}

// A long match is elided on both sides rather than dumping the whole message.
{
  const long = 'x'.repeat(400) + 'NEEDLE' + 'y'.repeat(400)
  const hit = searchTranscript([user('u1', long)], 'needle')
  assert.ok(hit!.snippet.startsWith('…') && hit!.snippet.endsWith('…'))
  assert.ok(hit!.snippet.length < 200, 'snippet stays short')
}

console.log('transcript: ok')
