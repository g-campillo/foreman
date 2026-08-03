/**
 * Self-check for the numstat parser: `npm run check:numstat`.
 *
 * Worth having because the badge is the only place in the app that reports a
 * number nobody can cross-check at a glance — a mis-parse reads as "the badge is
 * just wrong sometimes" rather than as a bug with a shape. The countLines cases
 * are checked against diffRow directly, because the badge and the Changes panel
 * agreeing on untracked files is the whole reason that function exists.
 */
import { strict as assert } from 'node:assert'
import { countLines, parseNumstat } from './numstat.mts'
import { diffRow } from '../../shared/diff.mts'

/** Records as git writes them: counts tab-joined, only the PATH NUL-terminated. */
const z = (...records: string[]): string => records.join('\0') + '\0'

// The ordinary case.
{
  const got = parseNumstat(z('12\t3\tsrc/a.ts', '0\t9\tgone.md'))
  assert.deepEqual(got, { files: 2, added: 12, removed: 12 })
}

// Paths with spaces and non-ASCII survive — the whole point of -z. A tab inside
// the path would break a naive tab-split, which is why only the first two are read.
{
  const got = parseNumstat(z('1\t1\tdir with spaces/café ☕.md', '2\t0\ta\tb.txt'))
  assert.deepEqual(got, { files: 2, added: 3, removed: 1 })
}

// Binary files are reported as `-\t-`: counted as a file, contributing no lines.
{
  const got = parseNumstat(z('-\t-\tbuild/icon.png', '4\t0\tsrc/a.ts'))
  assert.deepEqual(got, { files: 2, added: 4, removed: 0 })
}

// Empty output, and the trailing empty field, produce nothing.
assert.deepEqual(parseNumstat(''), { files: 0, added: 0, removed: 0 })
assert.deepEqual(parseNumstat('\0'), { files: 0, added: 0, removed: 0 })

// ----------------------------------------------------------------- countLines

// Every case, checked against diffRow's own count for a created file. These two
// disagreeing is exactly the badge-vs-panel drift this pairing exists to stop.
for (const [text, expected] of [
  ['', 0],
  ['a', 1],
  ['\n', 1],
  ['a\nb', 2],
  ['a\nb\n', 2],
  ['a\nb\n\n', 3],
] as const) {
  assert.equal(countLines(text), expected, `countLines(${JSON.stringify(text)})`)
  assert.equal(
    countLines(text),
    diffRow('/repo/n.ts', 'n.ts', null, text).added,
    `countLines disagrees with diffRow on ${JSON.stringify(text)}`,
  )
}

console.log('numstat: ok')
