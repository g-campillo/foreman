/**
 * Self-check for the diff helpers: `npm run check:diff`.
 *
 * The line-number walk in toHunks is what revert writes against, and the two
 * subset functions decide what reaches disk from a partial approval. Both are
 * the kind of code that drifts silently — a wrong line number does not throw,
 * it just writes to the wrong place.
 */
import { strict as assert } from 'node:assert'
import { toHunks, diffRow, subsetMultiEdit, recomposeWrite } from './diff.mts'

// -------------------------------------------------------------------- toHunks

{
  const hunks = toHunks('a\nb\nc\n', 'a\nB\nc\n', 'x.ts')
  assert.equal(hunks.length, 1)
  const lines = hunks[0]!.lines
  // Numbers are 1-based and advance independently on each side.
  const del = lines.find((l) => l.type === 'del')!
  const add = lines.find((l) => l.type === 'add')!
  assert.equal(del.oldNo, 2)
  assert.equal(del.newNo, null, 'a deleted line has no new number')
  assert.equal(add.newNo, 2)
  assert.equal(add.oldNo, null)
}

// ------------------------------------------------------------------- diffRow

{
  const binary = diffRow('/a', 'a', 'x\0y', 'z')
  assert.equal(binary.note, 'binary')
  assert.deepEqual(binary.hunks, [])

  // A mode-only change is genuinely dirty with no content diff, and MUST still
  // produce a row — the badge counts dirty paths and the panel renders rows, so
  // dropping this makes the two disagree.
  const same = diffRow('/a', 'a', 'x\n', 'x\n')
  assert.equal(same.added, 0)
  assert.equal(same.removed, 0)
  assert.equal(same.note, undefined)

  const created = diffRow('/a', 'a', null, 'new\n')
  assert.equal(created.added, 1)
}

// ------------------------------------------------------------ subsetMultiEdit

{
  const input = {
    file_path: '/a/x.ts',
    edits: [
      { old_string: 'one', new_string: '1' },
      { old_string: 'two', new_string: '2' },
      { old_string: 'three', new_string: '3' },
    ],
  }

  const two = subsetMultiEdit(input, [0, 2]) as typeof input
  assert.deepEqual(two.edits, [input.edits[0], input.edits[2]])
  assert.equal(two.file_path, '/a/x.ts', 'every other field survives untouched')

  // Order is the tool's, not the user's click order: MultiEdit applies edits
  // sequentially, so a reordered array is a DIFFERENT edit.
  assert.deepEqual(
    (subsetMultiEdit(input, [2, 0]) as typeof input).edits,
    [input.edits[0], input.edits[2]],
    'indices are sorted back into the original order',
  )

  // Nothing dropped -> the original object, so a full approval is byte-identical
  // to not having gone through here at all.
  assert.equal(subsetMultiEdit(input, [0, 1, 2]), input)

  // Nothing kept -> null. An empty edits array is not a no-op, the tool ERRORS
  // on it, so the caller must deny outright.
  assert.equal(subsetMultiEdit(input, []), null)

  // THE SECURITY SURFACE. Indices are all the renderer can send, so these are
  // all it can get wrong.
  assert.equal(subsetMultiEdit(input, [9]), null, 'out of range is dropped')
  assert.equal(subsetMultiEdit(input, [-1]), null, 'negative is dropped')
  assert.equal(subsetMultiEdit(input, [1.5]), null, 'non-integer is dropped')
  assert.equal(subsetMultiEdit(input, [NaN]), null)
  assert.deepEqual(
    (subsetMultiEdit(input, [1, 1, 1]) as typeof input).edits,
    [input.edits[1]],
    'duplicates collapse rather than applying an edit twice',
  )
  assert.deepEqual(
    (subsetMultiEdit(input, [0, 99]) as typeof input).edits,
    [input.edits[0]],
    'a valid index survives an invalid neighbour',
  )

  // Malformed inputs must not throw — these come off the wire.
  for (const bad of [null, undefined, 42, 'str', {}, { edits: 'no' }, { edits: null }]) {
    assert.doesNotThrow(() => subsetMultiEdit(bad, [0]))
    assert.equal(subsetMultiEdit(bad, [0]), null)
  }
}

// ------------------------------------------------------------- recomposeWrite

{
  // The two changed lines have to be more than 2*context apart or jsdiff merges
  // them into one hunk — context is 3, so 6 lines of separation is not enough.
  const L = (n: number): string => Array.from({ length: n }, (_, i) => `line${i}`).join('\n')
  const before = `one\ntwo\n${L(20)}\nnine\nten\n`
  const after = `one\nTWO\n${L(20)}\nNINE\nten\n`
  const hunks = toHunks(before, after, 'x')
  assert.equal(hunks.length, 2, 'fixture must actually have two hunks')

  // Accept both -> the agent's version, exactly.
  assert.equal(recomposeWrite(before, after, [0, 1]), after)
  // Accept neither -> the original, exactly. Nothing lands.
  assert.equal(recomposeWrite(before, after, []), before)

  // Accept only the first: TWO lands, NINE does not.
  const first = recomposeWrite(before, after, [0])
  assert.ok(first.includes('TWO'))
  assert.ok(first.includes('nine'), 'the rejected hunk keeps its ORIGINAL line')
  assert.ok(!first.includes('NINE'))

  const second = recomposeWrite(before, after, [1])
  assert.ok(second.includes('two') && !second.includes('TWO'))
  assert.ok(second.includes('NINE'))

  // Rejecting a pure DELETION means keeping the deleted line — the case that is
  // easy to get backwards, because "reject" reads as "remove".
  const withDel = 'a\nb\nc\n'
  const withoutDel = 'a\nc\n'
  assert.equal(recomposeWrite(withDel, withoutDel, []), withDel, 'rejected deletion keeps the line')
  assert.equal(recomposeWrite(withDel, withoutDel, [0]), withoutDel, 'accepted deletion removes it')

  // Pure insertion, both ways.
  assert.equal(recomposeWrite('a\nc\n', 'a\nb\nc\n', [0]), 'a\nb\nc\n')
  assert.equal(recomposeWrite('a\nc\n', 'a\nb\nc\n', []), 'a\nc\n')

  // Creating a file from nothing.
  assert.equal(recomposeWrite('', 'hello\n', [0]), 'hello\n')
  assert.equal(recomposeWrite('', 'hello\n', []), '')

  // No change at all: no hunks, so the input passes through whatever is kept.
  assert.equal(recomposeWrite('same\n', 'same\n', []), 'same\n')
}

console.log('diff: ok')
