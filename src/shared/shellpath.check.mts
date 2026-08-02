/**
 * Self-check for login-shell PATH recovery: `npm run check:shellpath`.
 *
 * This exists because of a bug whose symptom pointed at the wrong subsystem
 * entirely. Launched from the Dock, Foreman inherits macOS's bare launch PATH,
 * so every stdio MCP server the bundled CLI spawns fails with
 * `Executable not found in $PATH: "npx"` — and what the user sees is four red
 * rows in the MCP tab and a reconnect button that appears to do nothing.
 *
 * Three things are worth pinning. The parser, because it reads whatever a
 * stranger's `.zshrc` prints and must not be fooled by it; the merge, because
 * it mutates the PATH of the process that spawns every agent, so a bug there
 * breaks machines that were working fine; and the fingerprint, because it is
 * what decides whether a running session gets told to throw itself away.
 *
 * The last section spawns a real shell. That is the half most likely to be
 * wrong — `-ilc` vs `-lc` is the difference between finding nvm and not — and
 * no amount of string testing catches it.
 */
import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { SENTINEL, mergePath, parseShellPath, pathId } from './shellpath.mts'

/** What a well-behaved shell sends back, banners and all. */
const wrap = (body: string): string => `${SENTINEL}\n${body}\n${SENTINEL}\n`

const REAL = '/Users/u/.nvm/versions/node/v24.0.0/bin:/opt/homebrew/bin:/usr/bin:/bin'
const LAUNCHD = '/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin'

// ------------------------------------------------------------------ parsing

assert.equal(
  parseShellPath(wrap(`SHELL=/bin/zsh\nPATH=${REAL}\nTERM=xterm-256color`)),
  REAL,
  'the PATH line inside the sentinels is the answer',
)

// The whole reason for the sentinels: an interactive shell prints things. This
// is the case that made `-i` survivable at all.
assert.equal(
  parseShellPath(`Now using node v24.0.0\n${wrap(`PATH=${REAL}`)}(base) $ `),
  REAL,
  'banners before and after the payload must be ignored',
)

// An rc file that echoes something PATH-shaped OUTSIDE the sentinels is not the
// shell's PATH, and taking it would be worse than taking nothing.
assert.equal(
  parseShellPath(`PATH=/decoy\n${wrap(`PATH=${REAL}`)}`),
  REAL,
  'only what is between the sentinels counts',
)

// A value that merely CONTAINS "PATH=" is not a PATH line — `startsWith` is
// load-bearing, and a substring search here would return MANPATH's value.
assert.equal(
  parseShellPath(wrap(`MANPATH=/usr/share/man\nPATH=${REAL}`)),
  REAL,
  'MANPATH must not be mistaken for PATH',
)

// Some terminal setups echo CRLF; a trailing carriage return turns the last
// directory into one that exists nowhere, silently.
assert.equal(parseShellPath(wrap(`PATH=${REAL}\r`)), REAL, 'a trailing CR must be stripped')

// Every way this can fail has to come back null, because null means "keep the
// PATH we already have" and that is the only safe answer.
assert.equal(parseShellPath(''), null, 'empty output')
assert.equal(parseShellPath(`PATH=${REAL}`), null, 'no sentinels at all')
assert.equal(parseShellPath(`${SENTINEL}\nPATH=${REAL}`), null, 'an unterminated payload')
assert.equal(parseShellPath(wrap('TERM=xterm')), null, 'sentinels but no PATH')
assert.equal(parseShellPath(wrap('PATH=')), null, 'an empty PATH is not an answer')

// ------------------------------------------------------------------ merging

// The bug, end to end: the launch PATH plus a real one has to be able to find
// the tools the CLI shells out to.
{
  const merged = mergePath(LAUNCHD, REAL)
  assert.ok(merged.split(':').includes('/opt/homebrew/bin'), 'Homebrew must be reachable')
  assert.ok(
    merged.startsWith('/Users/u/.nvm/versions/node/v24.0.0/bin:'),
    'the version manager has to beat /usr/bin, or it manages nothing',
  )
}

// Additive, always. This runs at startup on machines where nothing was broken,
// so removing a directory is the one outcome that is not allowed.
{
  const custom = `${LAUNCHD}:/Users/u/private/bin`
  const merged = mergePath(custom, REAL).split(':')
  for (const dir of custom.split(':')) {
    assert.ok(merged.includes(dir), `merging must never drop ${dir}`)
  }
}

// De-duplication, and it keeps the FIRST occurrence — otherwise appending the
// current PATH would quietly undo the ordering above.
{
  const merged = mergePath('/usr/bin:/bin', '/opt/homebrew/bin:/usr/bin')
  assert.equal(merged, '/opt/homebrew/bin:/usr/bin:/bin')
}

// Empty segments mean "the current directory" to some tools, and never on purpose.
assert.equal(mergePath('/usr/bin::', ':/opt/homebrew/bin:'), '/opt/homebrew/bin:/usr/bin')

// Degenerate inputs must not produce a PATH with a phantom entry in it.
assert.equal(mergePath('', REAL), REAL, 'no current PATH')
assert.equal(mergePath(REAL, ''), REAL, 'nothing resolved')
assert.equal(mergePath('', ''), '', 'neither')

// Idempotent: the background refresh applies a second time on every launch, and
// re-applying the same answer must not grow the PATH.
assert.equal(mergePath(mergePath(LAUNCHD, REAL), REAL), mergePath(LAUNCHD, REAL))

// -------------------------------------------------------------- the id

// The one that matters. A shell asked twice is not a fixed point: the probe
// inherits the PATH we already merged, so the same directories come back in a
// different arrangement from one launch to the next. If the id followed the
// order, the background refresh would mark every live, perfectly healthy
// session stale and tell the user to start a new one for no reason at all.
{
  const dirs = REAL.split(':')
  const rotated = [...dirs.slice(1), dirs[0]].join(':')
  const reversed = [...dirs].reverse().join(':')
  assert.equal(pathId(rotated), pathId(REAL), 'reordering must not change the id')
  assert.equal(pathId(reversed), pathId(REAL), 'and not for any ordering')
}

// It still has to be an answer about the directories: adding one — the case
// `staleEnv` exists to catch, a host spawned before nvm's bin was on PATH —
// must change it.
assert.notEqual(pathId(`${REAL}:/opt/extra/bin`), pathId(REAL), 'a new directory is a new id')
assert.notEqual(pathId(LAUNCHD), pathId(REAL), 'and a different PATH entirely, obviously')

// Empty segments are noise, not membership; `mergePath` drops them, so a PATH
// that has been through the merge must not read as different from one that has.
assert.equal(pathId(`:${REAL}:`), pathId(REAL), 'empty segments do not count')
assert.equal(pathId(''), pathId(':'), 'nor does a PATH made only of them')

assert.match(pathId(REAL), /^[0-9a-f]{12}$/, 'short, and comparable as a string')

// --------------------------------------------------------- the real thing

/**
 * The command `resolveShellPath` runs, spelled out here rather than imported:
 * `src/main/shellpath.ts` pulls in `electron`, which bare node cannot load. So
 * this duplicates one line in exchange for being runnable at all — and that one
 * line is where the interesting mistake lives.
 */
const SCRIPT = `echo ${SENTINEL}; /usr/bin/env; echo ${SENTINEL}`

/** Runs a script in the real `$SHELL` the way `resolveShellPath` does. */
const run = (script: string): Promise<{ out: string; code: number | null }> =>
  new Promise((resolve) => {
    // `-ilc`, not `-lc`. zsh sources `.zprofile` for a login shell but `.zshrc`
    // only for an interactive one, and nvm is loaded from `.zshrc` on a default
    // install — so a non-interactive shell reports a PATH with no node on it and
    // the whole exercise achieves nothing.
    const child = spawn(process.env.SHELL as string, ['-ilc', script], {
      // stdin ignored: an rc file that reads from it would hang us forever.
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let buf = ''
    child.stdout.on('data', (c: Buffer) => (buf += c.toString('utf8')))
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve({ out: '', code: null })
    }, 10_000)
    child.on('error', () => resolve({ out: '', code: null }))
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ out: buf, code })
    })
  })

if (process.platform !== 'win32' && process.env.SHELL) {
  const { out } = await run(SCRIPT)

  const path = parseShellPath(out)
  assert.ok(path, `a real ${process.env.SHELL} must answer with a PATH`)
  assert.ok(path.includes('/'), 'and it must look like a directory list')
  // The property the whole feature rests on: merging a real answer into the
  // bare launch PATH loses nothing from either side. Stated as set membership
  // rather than a length comparison, because a lived-in PATH usually has
  // duplicate entries in it and the merge is entitled to drop those.
  {
    const merged = mergePath(LAUNCHD, path).split(':')
    for (const dir of [...path.split(':'), ...LAUNCHD.split(':')]) {
      if (dir) assert.ok(merged.includes(dir), `merging a real PATH must keep ${dir}`)
    }
  }
  // The exit status is not a gate, and must not become one again. A shell whose
  // rc files end in a failing check — or one killed by an outside signal after
  // printing everything, which reports no code at all — has still told us the
  // truth, and the sentinel pair plus the `PATH=` anchor is the only test worth
  // applying. Gating on the code threw this away.
  {
    const { out: noisy, code } = await run(`${SCRIPT}; exit 3`)
    const failed = parseShellPath(noisy)
    assert.notEqual(code, 0, 'the shell really did fail')
    assert.ok(failed, 'and still answered with a PATH')
    // Compared as a set: two runs of a shell that prepends its own shims can
    // hand the same directories back in a different order, which is the whole
    // reason `pathId` sorts.
    assert.equal(pathId(failed), pathId(path), 'the same PATH, exit code notwithstanding')
  }

  console.log(`shellpath: ${process.env.SHELL} -> ${path.split(':').length} entries`)
} else {
  console.log('shellpath: no $SHELL to ask; skipped the live check')
}

console.log('shellpath: ok')
