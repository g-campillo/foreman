/**
 * Self-check for the porcelain parser: `npm run check:porcelain`.
 *
 * Worth having because a mis-parse here doesn't just show the wrong file in the
 * diff panel — revert writes to disk against these paths.
 */
import { strict as assert } from 'node:assert'
import { parsePorcelainZ } from './porcelain.mts'
import { diffRow } from '../../shared/diff.mts'

const ROOT = '/repo'
const z = (...fields: string[]): string => fields.join('\0') + '\0'

// Plain modified / untracked / deleted entries.
{
  const got = parsePorcelainZ(z(' M src/a.ts', '?? new.txt', ' D gone.md'), ROOT)
  assert.deepEqual(
    [...got],
    [
      ['/repo/src/a.ts', ' M'],
      ['/repo/new.txt', '??'],
      ['/repo/gone.md', ' D'],
    ],
  )
}

// A rename yields BOTH ends, and the origin field must not be read as an entry.
{
  const got = parsePorcelainZ(z('R  new/name.ts', 'old/name.ts', ' M after.ts'), ROOT)
  assert.deepEqual(
    [...got],
    [
      ['/repo/old/name.ts', 'R '],
      ['/repo/new/name.ts', 'R '],
      ['/repo/after.ts', ' M'],
    ],
    'rename origin consumed as its own field, and the next entry still parses',
  )
}

// Copies behave like renames.
assert.equal(parsePorcelainZ(z('C  copy.ts', 'src.ts'), ROOT).size, 2)

// Paths with spaces and non-ASCII survive intact — the whole point of -z.
{
  const got = parsePorcelainZ(z(' M dir with spaces/café ☕.md'), ROOT)
  assert.deepEqual([...got.keys()], ['/repo/dir with spaces/café ☕.md'])
}

// Empty output, and the trailing empty field, produce nothing.
assert.equal(parsePorcelainZ('', ROOT).size, 0)
assert.equal(parsePorcelainZ('\0', ROOT).size, 0)

// ------------------------------------------------------------------- diffRow

// A new file is all adds; a deleted one is all dels.
{
  const created = diffRow('/repo/n.ts', 'n.ts', null, 'a\nb\n')
  assert.equal(created.added, 2)
  assert.equal(created.removed, 0)

  const deleted = diffRow('/repo/n.ts', 'n.ts', 'a\nb\n', null)
  assert.equal(deleted.added, 0)
  assert.equal(deleted.removed, 2)
}

// Identical content STILL yields a row, with no hunks. This is what keeps the
// badge (which counts dirty paths) equal to the panel — a chmod +x is dirty to
// git and has no content diff, and dropping it would desync the two.
{
  const same = diffRow('/repo/x.ts', 'x.ts', 'a\n', 'a\n')
  assert.equal(same.hunks.length, 0)
  assert.equal(same.added, 0)
  assert.equal(same.note, undefined, 'an unchanged text file is not annotated')
}

// A NUL byte on either side means binary: annotated, never line-diffed.
for (const [before, after] of [
  ['a\0b', 'c'],
  ['c', 'a\0b'],
]) {
  const row = diffRow('/repo/b.png', 'b.png', before, after)
  assert.equal(row.note, 'binary')
  assert.equal(row.hunks.length, 0)
}

// Oversize content is annotated rather than fed to an O(ND) diff.
{
  const row = diffRow('/repo/big.json', 'big.json', 'x'.repeat(1_000_001), 'y')
  assert.equal(row.note, 'too large to diff')
  assert.equal(row.hunks.length, 0)
}

// Line numbering stays correct across two separated hunks — the thing a
// hand-rolled marker walk gets wrong, and revert writes against these paths.
{
  const before = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n')
  const after = before.replace('l1', 'CHANGED').replace('l18', 'ALSO')
  const row = diffRow('/repo/m.ts', 'm.ts', before, after)
  assert.equal(row.hunks.length, 2, 'context:3 keeps distant edits in separate hunks')
  assert.equal(row.added, 2)
  assert.equal(row.removed, 2)
  const first = row.hunks[0].lines.find((l) => l.type === 'add')!
  assert.equal(first.text, 'CHANGED')
  assert.equal(first.newNo, 2, '1-based line number, not an index')
  assert.equal(first.oldNo, null, 'an added line has no old number')
}

console.log('porcelain: ok')
