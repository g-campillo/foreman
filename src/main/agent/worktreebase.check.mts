/**
 * Self-check for the worktree base resolver: `npm run check:worktreebase`.
 *
 * Worth having for two reasons. `chooseBase` decides which commit a whole
 * session's work is cut from, and getting it wrong is silent — the agent starts
 * from a stale `master` nobody has touched in a year and its branch merges
 * badly, days later. And its answer reaches ARGV: `git worktree add -b <branch>
 * <dir> <ref>`, where a ref starting with `-` is an option and `a..b` is a
 * range.
 */
import { strict as assert } from 'node:assert'
import { chooseBase, withExclude } from './worktreebase.mts'

/** `exists` over a fixed set, recording what was asked. */
const probe = (
  refs: readonly string[],
): { exists: (ref: string) => Promise<boolean>; asked: string[] } => {
  const asked: string[] = []
  return {
    asked,
    exists: async (ref) => {
      asked.push(ref)
      return refs.includes(ref)
    },
  }
}

// ---- chooseBase: the decision table
{
  // origin/HEAD is the repository's own answer, and it wins.
  {
    const p = probe(['origin/main', 'refs/heads/main', 'refs/heads/master'])
    const got = await chooseBase('origin/main', p.exists)
    assert.deepEqual(got, { ref: 'origin/main', label: 'origin/main' }, 'origin/HEAD wins over local main')
  }
  // ...including in a clone whose default branch is named something else, which
  // is the whole reason this is not just `main`.
  {
    const p = probe(['origin/trunk'])
    const got = await chooseBase('origin/trunk', p.exists)
    assert.equal(got.ref, 'origin/trunk', 'a renamed default branch still resolves')
  }
  // The symref names a branch whose remote-tracking ref has been pruned: strip
  // `origin/` and take the local branch of that name.
  {
    const p = probe(['refs/heads/trunk'])
    const got = await chooseBase('origin/trunk', p.exists)
    assert.deepEqual(got, { ref: 'trunk', label: 'trunk' }, 'falls through to the local branch of the same name')
  }
  // No origin at all: `main`, then `master`.
  {
    const p = probe(['refs/heads/main', 'refs/heads/master'])
    assert.equal((await chooseBase('', p.exists)).ref, 'main', 'main before master')
  }
  {
    const p = probe(['refs/heads/master'])
    assert.equal((await chooseBase('', p.exists)).ref, 'master', 'an older repo still resolves')
  }
  // A local repo with neither. Cutting from HEAD is what plain `git worktree
  // add -b` does, so this is parity rather than a guess.
  {
    const p = probe([])
    const got = await chooseBase('', p.exists)
    assert.deepEqual(got, { ref: 'HEAD', label: 'the current HEAD' }, 'no default branch is not a failure')
  }
  // A stray newline off `symbolic-ref`'s stdout must not become part of the ref.
  {
    const p = probe(['origin/main'])
    assert.equal((await chooseBase('origin/main\n', p.exists)).ref, 'origin/main', 'stdout is trimmed')
  }
  // A symref that is not a remote-tracking name at all — `origin/` is not
  // assumed, and stripping it off something else must not invent a probe.
  {
    const p = probe(['refs/heads/main'])
    const got = await chooseBase('weird', p.exists)
    assert.equal(got.ref, 'main')
    assert.ok(!p.asked.includes('refs/heads/'), 'no empty ref is ever probed')
  }
}

// ---- chooseBase: nothing dangerous ever reaches argv
{
  // Every hostile symref lands on a safe answer, and — the stronger assertion —
  // no probe is ever made with a string git would read as an option or a range.
  const hostile = [
    '--upload-pack=touch /tmp/pwned',
    '-x',
    'origin/../../etc/passwd',
    'origin/..',
    'origin//main',
    'origin/main;rm -rf /',
    'origin/ma in',
    'origin/main\n--force',
    'origin/',
    '/absolute',
    'origin/main^{}',
    'origin/ma~1',
  ]
  for (const symref of hostile) {
    const p = probe(['origin/main', 'refs/heads/main'])
    const got = await chooseBase(symref, p.exists)
    for (const ref of p.asked) {
      assert.ok(!ref.includes('..'), `${symref}: probed ${ref}, which is a range`)
      assert.ok(!ref.startsWith('-'), `${symref}: probed ${ref}, which git reads as an option`)
      assert.ok(!/(^|[^:])\/\//.test(ref), `${symref}: probed ${ref}, which has a stray //`)
      assert.ok(!/\s/.test(ref), `${symref}: probed ${ref}, which carries whitespace`)
    }
    assert.ok(!got.ref.includes('..'), `${symref}: chose a range`)
    assert.ok(!got.ref.startsWith('-'), `${symref}: chose an option`)
    assert.ok(!/\s/.test(got.ref), `${symref}: chose a ref with whitespace in it`)
  }
}

// ---- withExclude
{
  const ENTRY = '/.worktrees/'
  assert.equal(withExclude('', ENTRY), '/.worktrees/\n', 'an empty file gets the entry alone')
  assert.equal(
    withExclude('*.log\n', ENTRY),
    '*.log\n/.worktrees/\n',
    'appended after an existing pattern',
  )
  assert.equal(
    withExclude('*.log', ENTRY),
    '*.log\n/.worktrees/\n',
    'a file with no trailing newline gets one, or the two patterns glue together and neither matches',
  )
  // IDEMPOTENCE, which is the whole reason this returns null: three worktree
  // creations must leave exactly one line.
  assert.equal(withExclude('/.worktrees/\n', ENTRY), null, 'already present')
  assert.equal(withExclude('*.log\n/.worktrees/\n*.tmp\n', ENTRY), null, 'present in the middle')
  assert.equal(withExclude('/.worktrees/', ENTRY), null, 'present with no trailing newline')
  assert.equal(withExclude('  /.worktrees/  \n', ENTRY), null, 'present with surrounding space')
  assert.equal(withExclude('/.worktrees/\r\n', ENTRY), null, 'present with a CRLF line ending')
  // ...and near-misses that are NOT the entry.
  assert.notEqual(withExclude('.worktrees/\n', ENTRY), null, 'unanchored .worktrees/ is a different pattern')
  assert.notEqual(withExclude('.worktrees\n', ENTRY), null, 'and so is the bare directory name')
  assert.notEqual(
    withExclude('# /.worktrees/ is added by Foreman\n', ENTRY),
    null,
    'a mention inside a comment excludes nothing',
  )
  assert.notEqual(
    withExclude('!/.worktrees/\n', ENTRY),
    null,
    'a negation is the opposite of the entry, not the entry',
  )
}

console.log('worktreebase: ok')
