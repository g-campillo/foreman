/**
 * Self-check for the ref parser: `npm run check:refs`.
 *
 * Worth having because every value this produces is later handed to `git switch`
 * as argv — checkoutBranch matches the renderer's request against this list
 * precisely so that nothing but git's own output reaches a command line. A
 * mis-stripped remote name is therefore a wrong branch checked out, not a
 * cosmetic bug in a menu.
 */
import { strict as assert } from 'node:assert'
import { parseRefs, REF_FORMAT } from './refs.mts'

/** Fields in the same order REF_FORMAT declares them. */
const row = (
  ref: string,
  opts: {
    head?: boolean
    worktree?: string
    upstream?: string
    committed?: number
    symref?: string
  } = {},
): string =>
  [
    ref,
    opts.head ? '*' : ' ',
    opts.worktree ?? '',
    opts.upstream ?? '',
    String(opts.committed ?? 0),
    opts.symref ?? '',
  ].join('\t')

const out = (...rows: string[]): string => rows.join('\n') + '\n'

// The format string and this file's `row` must agree about field order.
assert.equal(REF_FORMAT.split('%09').length, 6, 'REF_FORMAT has six fields')

// The ordinary case: local and remote, current marked, order preserved.
{
  const got = parseRefs(
    out(
      row('refs/heads/main', { head: true, upstream: 'origin/main', committed: 1700000000 }),
      row('refs/remotes/origin/spike', { committed: 1600000000 }),
    ),
    ['origin'],
  )
  assert.deepEqual(
    got.map((b) => [b.name, b.remote, b.current]),
    [
      ['main', null, true],
      ['spike', 'origin', false],
    ],
  )
  assert.equal(got[0].upstream, 'origin/main')
  assert.equal(got[0].updatedAt, 1700000000)
}

// `%(HEAD)` is a literal SPACE for a non-current ref, never empty — so the test
// has to be `=== '*'`. A truthiness test would mark every branch current.
{
  const got = parseRefs(out(row('refs/heads/other')), [])
  assert.equal(got[0].current, false)
}

// origin/HEAD is skipped by its SYMREF, not by its name — so a clone whose
// default branch was renamed is still skipped...
{
  const got = parseRefs(
    out(
      row('refs/remotes/origin/HEAD', { symref: 'refs/remotes/origin/trunk' }),
      row('refs/remotes/origin/trunk', { committed: 5 }),
    ),
    ['origin'],
  )
  assert.deepEqual(
    got.map((b) => b.name),
    ['trunk'],
  )
}
// ...and an old clone's non-symbolic one is caught by name as well.
assert.deepEqual(parseRefs(out(row('refs/remotes/origin/HEAD')), ['origin']), [])

// A remote whose NAME contains a slash. `rest.split('/')[0]` would call this
// branch `fork/feature/x` on a remote called `team`; longest-match gets it right.
{
  const got = parseRefs(out(row('refs/remotes/team/fork/feature/x')), ['team', 'team/fork'])
  assert.deepEqual(
    got.map((b) => [b.name, b.remote]),
    [['feature/x', 'team/fork']],
  )
}

// A branch that exists both locally and on a remote appears ONCE, as the local.
// Order-independent: the remote row is listed first here on purpose.
{
  const got = parseRefs(
    out(
      row('refs/remotes/origin/fix/host-socket-path-length', { committed: 9 }),
      row('refs/heads/fix/host-socket-path-length', { committed: 8 }),
    ),
    ['origin'],
  )
  assert.deepEqual(
    got.map((b) => [b.name, b.remote]),
    [['fix/host-socket-path-length', null]],
  )
}

// A remote ref whose remote is not configured has nothing to --track.
assert.deepEqual(parseRefs(out(row('refs/remotes/gone/x')), ['origin']), [])

// Tags and anything else outside refs/heads and refs/remotes are not branches.
assert.deepEqual(parseRefs(out(row('refs/tags/v1.0')), ['origin']), [])

// A worktree path rides through raw; listBranches is what clears our own.
{
  const got = parseRefs(out(row('refs/heads/parked', { worktree: '/tmp/wt' })), [])
  assert.equal(got[0].checkedOutAt, '/tmp/wt')
}

// Empty output, and the trailing newline, produce nothing.
assert.deepEqual(parseRefs('', []), [])
assert.deepEqual(parseRefs('\n', []), [])

console.log('refs: ok')
