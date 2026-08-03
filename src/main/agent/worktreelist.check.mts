/**
 * Self-check for the worktree list parser: `npm run check:worktreelist`.
 *
 * Worth having because the paths this produces are what the Worktrees panel
 * offers to DELETE. A record boundary read wrong merges two entries and puts one
 * worktree's path under another's branch name, which is a removal of the wrong
 * tree — and the panel's own membership check is derived from this same list, so
 * it would agree with the mistake.
 */
import { strict as assert } from 'node:assert'
import { parseWorktreeList } from './worktreelist.mts'

// ---- the ordinary case
{
  const got = parseWorktreeList(
    [
      'worktree /repo',
      'HEAD e2298a54acd5ffa129e9ee7a66f184ad7444844a',
      'branch refs/heads/main',
      '',
      'worktree /repo/.worktrees/add-tests',
      'HEAD 1111111111111111111111111111111111111111',
      'branch refs/heads/foreman/add-tests',
      '',
    ].join('\n'),
  )
  assert.equal(got.length, 2, 'two records, separated by the blank line')
  assert.equal(got[0].path, '/repo')
  assert.equal(got[0].branch, 'main', 'refs/heads/ is stripped — the panel shows a branch name')
  assert.equal(got[1].path, '/repo/.worktrees/add-tests')
  assert.equal(got[1].branch, 'foreman/add-tests', 'a branch name may itself contain a slash')
  assert.equal(got[1].detached, false)
  assert.equal(got[1].prunable, false)
}

// ---- a path containing spaces
{
  const got = parseWorktreeList('worktree /Users/me/My Projects/thing\nHEAD abc\n')
  assert.equal(
    got[0].path,
    '/Users/me/My Projects/thing',
    'the value is everything after the FIRST space — a split(" ")[1] loses the rest of the path',
  )
}

// ---- detached, and bare
{
  const got = parseWorktreeList(
    ['worktree /repo', 'bare', '', 'worktree /repo/wt', 'HEAD abc', 'detached', ''].join('\n'),
  )
  assert.equal(got[0].bare, true)
  assert.equal(got[0].branch, null, 'a bare repo has no branch line at all')
  assert.equal(got[1].detached, true)
  assert.equal(got[1].branch, null, 'nor has a detached checkout — and index-based parsing invents one')
}

// ---- locked and prunable, with and without a reason
{
  const got = parseWorktreeList(
    [
      'worktree /repo/a',
      'HEAD abc',
      'branch refs/heads/a',
      'locked',
      '',
      'worktree /repo/b',
      'HEAD def',
      'branch refs/heads/b',
      'locked on a removable device',
      '',
      'worktree /repo/c',
      'HEAD ghi',
      'prunable gitdir file points to non-existent location',
      '',
    ].join('\n'),
  )
  assert.equal(got[0].locked, true)
  assert.equal(got[0].reason, null, 'a bare flag leaves the reason null rather than an empty string')
  assert.equal(got[1].locked, true)
  assert.equal(got[1].reason, 'on a removable device', 'a lock reason is free text and may contain spaces')
  assert.equal(got[2].prunable, true)
  assert.equal(got[2].reason, 'gitdir file points to non-existent location')
}

// ---- shapes that are not a list
{
  assert.deepEqual(parseWorktreeList(''), [], 'empty stdout is no worktrees, not a throw')
  assert.deepEqual(parseWorktreeList('\n\n'), [], 'blank lines alone open no record')
  assert.deepEqual(
    parseWorktreeList('HEAD abc\nbranch refs/heads/main\n'),
    [],
    'attributes before any worktree line would be a pathless row in a delete list',
  )
}

// ---- no trailing blank line, and CRLF
{
  const got = parseWorktreeList('worktree /repo\nHEAD abc\nbranch refs/heads/main')
  assert.equal(got.length, 1, 'the last record is flushed even with no trailing blank line')
  assert.equal(got[0].branch, 'main')
}
{
  const got = parseWorktreeList('worktree /repo\r\nbranch refs/heads/main\r\n\r\n')
  assert.equal(got.length, 1)
  assert.equal(got[0].branch, 'main', 'a CR left on the end would make this "main\\r" and match nothing')
}

// ---- two records with no blank line between them
{
  const got = parseWorktreeList('worktree /a\nbranch refs/heads/a\nworktree /b\nbranch refs/heads/b\n')
  assert.deepEqual(
    got.map((w) => [w.path, w.branch]),
    [
      ['/a', 'a'],
      ['/b', 'b'],
    ],
    'a worktree line always starts a record, so a missing separator cannot merge two trees',
  )
}

console.log('worktreelist: ok')
