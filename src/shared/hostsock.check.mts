/**
 * Self-check for host socket paths: `npm run check:hostsock`.
 *
 * This exists because of a bug that made the app unusable for one developer and
 * invisible to another: every agent host died on bind with `listen EINVAL`, and
 * the only difference between the two machines was the length of the account
 * name. `sockaddr_un.sun_path` is 104 bytes on macOS, and the old layout —
 * `<userData>/hosts/<36-char-uuid>/sock` — left only 13 of them for a username.
 *
 * The failure mode is what makes it worth a check: EINVAL names neither length
 * nor path, the host writes it to a log file inside a directory most people
 * never open, and the app reports only "host did not come up".
 */
import { strict as assert } from 'node:assert'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
// `sockpath.mts`, not `hostwire.ts`: the latter is a plain `.ts` in a
// "type": "commonjs" package, so bare node refuses it outright. That is the
// whole reason this logic lives in its own module.
import { sockPathFor, sockPathProblem, SUN_PATH_MAX } from './sockpath.mts'

const userData = (user: string): string =>
  `/Users/${user}/Library/Application Support/foreman`

/**
 * The layout that shipped the bug, spelled out literally rather than built from
 * the constants — it describes history, so it must not drift when they change.
 */
const oldLayout = (user: string, sessionId: string): string =>
  join(userData(user), 'hosts', sessionId, 'sock')

const UUID = '23d8ad59-cf3d-4d76-ab85-fe3ca0884c0f'

// ------------------------------------------------- the limit is what we claim

assert.equal(SUN_PATH_MAX, process.platform === 'darwin' ? 104 : 108)

// Empirical, because the whole bug was a wrong assumption about this number.
// Binding is the only thing that actually settles it.
{
  const root = fs.mkdtempSync(join(os.tmpdir(), 'foreman-sock-'))
  const bind = (path: string): Promise<string | null> =>
    new Promise((res) => {
      const s = net.createServer()
      s.once('error', (e: NodeJS.ErrnoException) => res(e.code ?? 'ERR'))
      s.listen(path, () => s.close(() => res(null)))
    })

  /** A path of exactly `n` bytes inside `root`. */
  const atLength = (n: number): string => {
    const pad = n - root.length - '/x/s'.length + 1
    const dir = join(root, 'x'.repeat(pad))
    fs.mkdirSync(dir, { recursive: true })
    return join(dir, 's')
  }

  assert.equal(await bind(atLength(SUN_PATH_MAX - 1)), null, 'one under the limit must bind')
  assert.equal(
    await bind(atLength(SUN_PATH_MAX + 1)),
    'EINVAL',
    'one over the limit must fail, and fail as EINVAL',
  )
  fs.rmSync(root, { recursive: true, force: true })
}

// ------------------------------------------------------------- the regression

// The exact pair of machines. Both must behave as recorded or this check is
// asserting something other than the bug it was written for.
assert.ok(
  sockPathProblem(oldLayout('gcampillo', UUID)) === null,
  'the old layout DID work for a 9-character username — which is why it shipped',
)
assert.ok(
  sockPathProblem(oldLayout('gabriel.campillo', UUID)) !== null,
  'the old layout MUST be over the limit for a 16-character username',
)

// ---------------------------------------------------------------- the new one

for (const user of ['gcampillo', 'gabriel.campillo']) {
  assert.equal(
    sockPathProblem(sockPathFor(userData(user), UUID)),
    null,
    `new layout must fit for ${user}`,
  )
}

// Headroom, stated as a number so shortening it is a deliberate act rather
// than an accident. macOS caps account names at 31 characters, so 34 clears
// anything a user can actually have. The old layout allowed 12.
{
  const user = 'u'.repeat(34)
  assert.equal(
    sockPathProblem(sockPathFor(userData(user), UUID)),
    null,
    'new layout must survive a 34-character username',
  )
}

// The dev build's userData is "Foreman Dev", four bytes longer than "foreman",
// so it is the tighter of the two and the one worth sizing against.
{
  const dev = `/Users/${'u'.repeat(34)}/Library/Application Support/Foreman Dev`
  assert.equal(sockPathProblem(sockPathFor(dev, UUID)), null, 'dev userData must fit too')
}

// And the boundary is where the arithmetic says: one more byte must not fit.
{
  const dev = `/Users/${'u'.repeat(35)}/Library/Application Support/Foreman Dev`
  assert.ok(sockPathProblem(sockPathFor(dev, UUID)) !== null, '35 must be over the line')
}

// --------------------------------------------------------------- the function

// Distinct sessions must not collide onto one socket; a shared path would mean
// two hosts fighting over one bind.
{
  const a = sockPathFor(userData('u'), '11111111-aaaa-4444-8888-000000000000')
  const b = sockPathFor(userData('u'), '22222222-aaaa-4444-8888-000000000000')
  assert.notEqual(a, b, 'different sessions get different sockets')
  assert.ok(a.endsWith('.sock'), 'named as a socket')
}

// Same session, same socket — adoption after a restart depends on it.
assert.equal(sockPathFor(userData('u'), UUID), sockPathFor(userData('u'), UUID))

// A degenerate id must not produce a bare directory path.
assert.ok(sockPathFor(userData('u'), '').endsWith('default.sock'))

console.log('hostsock: ok')
