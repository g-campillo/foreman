/**
 * Self-check for session policy: `npm run check:policy`.
 *
 * Worth having because both rules fail *silently*. A broken resultText turns a
 * spend cap into a blank card that reads as a crash; a broken notifyBody either
 * spams the user on every session start or goes quiet exactly when the agent is
 * blocked waiting for them.
 */
import { strict as assert } from 'node:assert'
import {
  MAX_BUDGET_USD,
  MAX_TURNS,
  branchSlug,
  cap,
  resultText,
  notifyBody,
  normaliseSend,
  underWorktrees,
  uniqueBranch,
  within,
} from './policy.mts'

// --------------------------------------------------------------------- within

assert.equal(within('/repo', '/repo/src/a.ts'), true, 'a file in the tree')
assert.equal(within('/repo', '/repo'), true, 'the root itself')
assert.equal(within('/repo', '/repo/'), true, 'the root with a trailing slash')
assert.equal(within('/repo', '/repo/a/../b.ts'), true, 'normalised back inside')

// The prefix trap: a plain startsWith would call both of these true, and pull a
// sibling checkout's edits into this session's diff.
assert.equal(within('/repo', '/repo-other/x.ts'), false, 'sibling sharing a prefix')
assert.equal(within('/repo', '/repository/x.ts'), false, 'longer name sharing a prefix')

assert.equal(within('/repo', '/etc/passwd'), false, 'unrelated absolute path')
assert.equal(within('/repo/pkg', '/repo/other.ts'), false, 'above the given dir')
assert.equal(within('/repo', '/repo/../escape.ts'), false, 'traversal out of the tree')

// The case this was written for: plan mode writes every plan outside the
// project, so these must never reach the diff panel.
assert.equal(
  within('/Users/x/code/foreman', '/Users/x/.claude/plans/witty-tiger.md'),
  false,
  'a plan file is not part of the working tree',
)

// A directory named '..' at the end is a traversal; one merely starting with
// dots is an ordinary hidden file and stays in.
assert.equal(within('/repo', '/repo/..config/a'), true, 'a dotted name is not a traversal')

// -------------------------------------------------------------- underWorktrees

assert.equal(underWorktrees('/repo', '/repo/.worktrees/add-tests'), true, 'a linked checkout')
assert.equal(underWorktrees('/repo', '/repo/.worktrees/add-tests/src/a.ts'), true, 'a file inside one')
assert.equal(underWorktrees('/repo', '/repo/.worktrees'), true, 'the directory itself')

// THE PREFIX TRAP, one directory over from within()'s: a plain startsWith on
// `${root}/.worktrees` calls this true, and the session standing in it would
// then be invisible to sessionsUnder — so a checkout in the main tree would be
// allowed to run underneath a live agent.
assert.equal(underWorktrees('/repo', '/repo/.worktreesX/a'), false, 'a sibling sharing the prefix')
assert.equal(underWorktrees('/repo', '/repo/.worktreesX'), false, 'and the sibling itself')

assert.equal(underWorktrees('/repo', '/repo/src/a.ts'), false, 'an ordinary file in the tree')
assert.equal(underWorktrees('/repo', '/repo'), false, 'the root is not under its own worktree dir')
assert.equal(underWorktrees('/repo', '/other/.worktrees/x'), false, 'another repo entirely')
// Only at the ROOT. A directory of that name nested in the tree is the user's,
// and a session in it is an ordinary session in this project.
assert.equal(underWorktrees('/repo', '/repo/pkg/.worktrees/x'), false, 'nested, so not ours')
// The legacy location, still on disk for existing checkouts, is outside the
// repo entirely — so it fails the `within` half rather than this one.
assert.equal(
  underWorktrees('/repo', '/Users/x/Library/Application Support/foreman/worktrees/repo-x'),
  false,
  'the pre-move location is not under the repo at all',
)

// ------------------------------------------------------------------------ cap

// Unset keeps the default.
delete process.env.FM_TEST_CAP
assert.equal(cap('FM_TEST_CAP', 500), 500)

// An explicit value wins, including a float.
process.env.FM_TEST_CAP = '75'
assert.equal(cap('FM_TEST_CAP', 500), 75)
process.env.FM_TEST_CAP = '12.5'
assert.equal(cap('FM_TEST_CAP', 500), 12.5)

// 0 / off / OFF mean genuinely uncapped, so the option gets omitted entirely.
for (const off of ['0', 'off', 'OFF', ' off ']) {
  process.env.FM_TEST_CAP = off
  assert.equal(cap('FM_TEST_CAP', 500), undefined, `${off} should uncap`)
}

// A typo must NOT silently remove the guard — that's the trap in `Number(x) || d`.
for (const junk of ['abc', '-5', 'NaN', '']) {
  process.env.FM_TEST_CAP = junk
  assert.equal(cap('FM_TEST_CAP', 500), 500, `${JSON.stringify(junk)} should keep the default`)
}
delete process.env.FM_TEST_CAP

// ------------------------------------------------------------------ resultText

// A user Stop beats everything else, including an error subtype.
assert.equal(
  resultText({ interrupted: true, subtype: 'error_during_execution', result: 'ignored' }),
  'stopped',
)

// The normal path: the SDK's own summary text passes through untouched.
assert.equal(resultText({ interrupted: false, subtype: 'success', result: 'all done' }), 'all done')

// Caps carry no `result` field. These must not render blank.
{
  const budget = resultText({ interrupted: false, subtype: 'error_max_budget_usd' })
  assert.notEqual(budget, '', 'budget cap must say something')
  assert.ok(budget.includes(String(MAX_BUDGET_USD)), 'and must name the cap it hit')

  const turns = resultText({ interrupted: false, subtype: 'error_max_turns' })
  assert.ok(turns.includes(String(MAX_TURNS)), 'turn cap must name its limit')
}

// A success with no text, and an unmapped subtype, both stay empty rather than
// leaking a raw subtype into the transcript.
assert.equal(resultText({ interrupted: false, subtype: 'success' }), '')
assert.equal(resultText({ interrupted: false, subtype: 'error_during_execution' }), '')

// -------------------------------------------------------------- normaliseSend

// A plain typed message stays a plain string — no block wrapping unless needed.
assert.equal(normaliseSend('hello'), 'hello')
assert.equal(normaliseSend('   '), null, 'whitespace-only is not a message')
assert.equal(normaliseSend(''), null)
assert.equal(normaliseSend(undefined), null)
assert.equal(normaliseSend({ nope: 1 }), null)
assert.equal(normaliseSend([]), null, 'an empty block list is not a message')

const img = (mediaType: string): unknown => ({
  type: 'image',
  source: { type: 'base64', media_type: mediaType, data: 'AAAA' },
})

// The four media types the API accepts survive; everything else is dropped
// here rather than failing upstream with an error pointing nowhere near the paste.
for (const ok of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
  assert.equal((normaliseSend([img(ok)]) as unknown[]).length, 1, `${ok} accepted`)
}
for (const bad of ['image/heic', 'image/svg+xml', 'image/bmp', 'text/plain', '']) {
  assert.equal(normaliseSend([img(bad)]), null, `${bad} rejected`)
}

// A mixed message keeps order, and drops only the offending block.
{
  const out = normaliseSend([img('image/png'), img('image/heic'), { type: 'text', text: 'look' }])
  assert.deepEqual(
    (out as { type: string }[]).map((b) => b.type),
    ['image', 'text'],
  )
}

// Malformed blocks never reach the SDK.
assert.equal(normaliseSend([null, { type: 'image' }, { type: 'image', source: {} }]), null)
assert.equal(normaliseSend([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' } }]), null,
  'an empty payload is not an image')
assert.equal(normaliseSend([{ type: 'text', text: '  ' }]), null, 'blank text block is dropped')

// An image with no caption is still a message worth sending.
assert.equal((normaliseSend([img('image/png')]) as unknown[]).length, 1)

// ----------------------------------------------------------------- notifyBody

// Start-up settles 'starting' -> 'idle'. Notifying there fires on every new
// session, before the agent has done anything at all.
assert.equal(notifyBody('starting', 'idle', 0), null)

// Finishing a real turn, and failing one, are both worth surfacing.
assert.equal(notifyBody('running', 'idle', 0), 'Turn complete')
assert.equal(notifyBody('running', 'error', 0), 'Turn failed')

// Blocked on the user is the highest-value case, and reports the count.
assert.ok(notifyBody('running', 'awaiting-approval', 2)?.includes('2'))

// Resuming after an approval is not a new turn, and a no-op patch is not a
// transition — neither may fire.
assert.equal(notifyBody('awaiting-approval', 'running', 0), null)
assert.equal(notifyBody('idle', 'idle', 0), null)
assert.equal(notifyBody('running', 'running', 0), null)

// ---------------------------------------------------------------- branchSlug
//
// This string becomes BOTH a git ref and a directory under userData, so a hole
// here is either a confusing `git worktree add` failure or a path escape.

// The ordinary case survives intact, including the characters git does allow.
assert.equal(branchSlug('Fix the parser'), 'fix-the-parser')
assert.equal(branchSlug('feat_v2.1-x'), 'feat_v2.1-x')

// Path separators and traversal must not survive in something used as a dirname.
assert.equal(branchSlug('../../etc/passwd'), 'etc-passwd')
assert.equal(branchSlug('a/b/c'), 'a-b-c')
for (const evil of ['../..', '..', '.', './/.', '/'])
  assert.ok(
    !branchSlug(evil).includes('/') && !branchSlug(evil).includes('..'),
    `escapes: ${evil}`,
  )

// git check-ref-format: no leading/trailing dot or dash, no '..' anywhere.
for (const raw of ['.hidden', 'trailing.', '-flag', 'a..b', 'a...b', '..x..', 'x.', '-']) {
  const s = branchSlug(raw)
  assert.ok(!s.startsWith('.') && !s.startsWith('-'), `leads badly: ${raw} -> ${s}`)
  assert.ok(!s.endsWith('.') && !s.endsWith('-'), `trails badly: ${raw} -> ${s}`)
  assert.ok(!s.includes('..'), `has '..': ${raw} -> ${s}`)
}

// Ref-breaking metacharacters are replaced, never dropped silently into the ref.
for (const raw of ['a~b', 'a^b', 'a:b', 'a?b', 'a*b', 'a[b', 'a\\b', 'a b', 'a\tb'])
  assert.ok(/^[a-z0-9._-]+$/.test(branchSlug(raw)), `not ref-safe: ${raw}`)

// Never empty: 'foreman/' is not a valid ref, and the resulting git error would
// point nowhere near the empty input that caused it.
for (const raw of ['', '   ', '!!!', '///', '...', '---'])
  assert.equal(branchSlug(raw), 'agent', `empty case: ${JSON.stringify(raw)}`)

// Bounded, and still well-formed after truncation — slicing mid-name must not
// leave a trailing dot or dash that then fails check-ref-format.
{
  const long = branchSlug('x'.repeat(200))
  assert.equal(long.length, 60)
  const cut = branchSlug(`${'y'.repeat(59)}.tail`)
  assert.ok(cut.length <= 60 && !cut.endsWith('.') && !cut.endsWith('-'), `bad cut: ${cut}`)
}

// Idempotent: re-slugging an already-slugged name is a no-op, so a round trip
// through the UI can't drift the branch away from the directory.
for (const raw of ['Fix the parser', '../etc', 'a..b', 'x'.repeat(200), ''])
  assert.equal(branchSlug(branchSlug(raw)), branchSlug(raw), `not idempotent: ${raw}`)

// --------------------------------------------------------------- uniqueBranch
//
// The bug this exists for: `foreman/<slug>` used to be a hard failure when the
// ref was taken, and removeWorktree deliberately never deleted refs — so the
// SECOND worktree session in any project failed forever.

{
  /** A fake ref store, so the suffix walk is checked without a repository. */
  const taken = (...refs: string[]) => {
    const set = new Set(refs)
    const seen: string[] = []
    return {
      seen,
      exists: async (ref: string): Promise<boolean> => {
        seen.push(ref)
        return set.has(ref)
      },
    }
  }

  // Nothing taken: the plain name, with no suffix to explain.
  {
    const t = taken()
    assert.equal(await uniqueBranch('fix-parser', t.exists), 'foreman/fix-parser')
    assert.deepEqual(t.seen, ['foreman/fix-parser'], 'one probe when the name is free')
  }

  // The suffix sequence starts at 2 — `-1` would imply a `-0` somewhere — and
  // walks upward one at a time, taking the first gap rather than the end.
  {
    const t = taken('foreman/fix-parser')
    assert.equal(await uniqueBranch('fix-parser', t.exists), 'foreman/fix-parser-2')
  }
  {
    const t = taken('foreman/fix-parser', 'foreman/fix-parser-2', 'foreman/fix-parser-3')
    assert.equal(await uniqueBranch('fix-parser', t.exists), 'foreman/fix-parser-4')
    assert.deepEqual(t.seen, [
      'foreman/fix-parser',
      'foreman/fix-parser-2',
      'foreman/fix-parser-3',
      'foreman/fix-parser-4',
    ])
  }
  {
    const t = taken('foreman/x', 'foreman/x-3')
    assert.equal(await uniqueBranch('x', t.exists), 'foreman/x-2', 'takes the first gap')
  }

  // Bounded. A predicate that always says yes must terminate with something
  // usable rather than spinning — and what it returns is still a valid ref.
  {
    const spun = await uniqueBranch('busy', async () => true)
    assert.ok(spun.startsWith('foreman/busy-'), `bounded fallback: ${spun}`)
    assert.equal(branchSlug(spun.slice('foreman/'.length)), spun.slice('foreman/'.length))
  }

  // The slug is passed through verbatim: branchSlug has already run on it, and
  // re-slugging here would be a second writer of the same rule.
  assert.equal(await uniqueBranch('agent', async () => false), 'foreman/agent')
}

console.log('policy: ok')
