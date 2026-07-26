/**
 * Self-check for the porcelain parser: `npm run check:porcelain`.
 *
 * Worth having because a mis-parse here doesn't just show the wrong file in the
 * diff panel — revert writes to disk against these paths.
 */
import { strict as assert } from 'node:assert'
import { parsePorcelainZ } from './porcelain.mts'

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

console.log('porcelain: ok')
