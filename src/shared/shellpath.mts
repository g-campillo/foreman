/**
 * The PATH a login shell would have given us, and how to read it back.
 *
 * Launched from Finder or the Dock, macOS hands an app the bare `launchd` PATH
 * — `/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin`. None of nvm, Homebrew or
 * pyenv is on it. That is invisible until something the app spawns needs a tool
 * the user installed themselves, and then it is very visible indeed: every
 * stdio MCP server the bundled `claude` CLI starts dies with
 * `Connection failed (ENOENT): Executable not found in $PATH: "npx"`, and the
 * MCP tab shows four permanently-red rows for a problem that has nothing to do
 * with MCP.
 *
 * The fix is to ask the user's own shell what PATH it would have set up, and to
 * do that before any agent host is spawned. This module is the pure half of it:
 * the marker we wrap the answer in, the parser, the merge, and the fingerprint.
 * The spawning, caching and `process.env` mutation live in
 * `src/main/shellpath.ts`.
 *
 * Its own module, and `.mts`, for the same reason as `sockpath.mts`: the root
 * package is `"type": "commonjs"`, so a plain `.ts` cannot be loaded under bare
 * node and therefore cannot be self-checked. The parsing is exactly the part
 * that needs a test, because it runs against whatever a stranger's `.zshrc`
 * decides to print.
 */

import { createHash } from 'node:crypto'

/**
 * Wrapped around the payload so a chatty rc file cannot be mistaken for it.
 *
 * We have to run the shell INTERACTIVE (see `resolveShellPath`), and an
 * interactive shell is exactly the one that prints things: fortune cookies,
 * `nvm` version notices, oh-my-zsh update prompts, a `pyenv` deprecation
 * warning. Some of that lands on stdout. Anchoring on a string that only we
 * emit is what makes the payload findable in the middle of it.
 *
 * Deliberately ugly and deliberately unique — it must not collide with anything
 * a real rc file would print, and it must survive being read by a human staring
 * at a broken shell.
 */
export const SENTINEL = '__foreman_shell_path__'

/**
 * The PATH out of a sentinel-wrapped `env` dump, or null if it isn't there.
 *
 * The payload is a full `KEY=value` dump rather than a bare `echo $PATH`
 * precisely so this has an unambiguous anchor: a line that STARTS with `PATH=`
 * inside the sentinels is the shell's PATH and nothing else can be. A bare echo
 * would be indistinguishable from an rc file echoing a path of its own.
 *
 * Everything before the first sentinel and after the second is thrown away, so
 * banners on either side cost nothing. Null on any doubt at all — the caller
 * treats null as "keep the PATH we already have", which is always safe.
 */
export function parseShellPath(stdout: string): string | null {
  const start = stdout.indexOf(SENTINEL)
  if (start === -1) return null
  const end = stdout.indexOf(SENTINEL, start + SENTINEL.length)
  if (end === -1) return null

  const body = stdout.slice(start + SENTINEL.length, end)
  for (const line of body.split('\n')) {
    if (!line.startsWith('PATH=')) continue
    // `\r` because a shell run under some terminal emulations echoes CRLF, and
    // a directory list with a stray carriage return at the end is a directory
    // list that silently never matches anything.
    const value = line.slice('PATH='.length).replace(/\r$/, '').trim()
    return value || null
  }
  return null
}

/**
 * The resolved PATH in front of the one we already have, without losing any.
 *
 * Additive by construction, and that is the safety property that matters: this
 * runs at startup on every machine, including the ones where nothing was ever
 * broken, so it must not be able to REMOVE a directory. The worst case is a
 * PATH that is longer than it needs to be.
 *
 * Resolved first because that is the ordering the user's shell chose — nvm's
 * shim directory has to beat `/usr/bin/node` or the version manager does
 * nothing. Duplicates are dropped keeping the first occurrence, so appending
 * the current PATH cannot undo that; empty segments go too, since a stray `::`
 * means "the current directory" to some tools and is never intended.
 */
export function mergePath(current: string, resolved: string): string {
  const out: string[] = []
  const seen = new Set<string>()
  for (const dir of `${resolved}:${current}`.split(':')) {
    if (!dir || seen.has(dir)) continue
    seen.add(dir)
    out.push(dir)
  }
  return out.join(':')
}

/**
 * A short stable fingerprint of a PATH: same directories, same id.
 *
 * The sort is load-bearing, and a "simplify" that drops it reintroduces a real
 * bug. This id is compared between a host's spawn-time environment and the
 * app's current one to decide whether that host can still find `npx` — which is
 * a property of the SET of directories, not of their order. And the order is
 * not stable: the shell we probe inherits the PATH we already merged, so rc
 * files that prepend their own shims hand back the same directories in a
 * different arrangement from one launch to the next. Hashing the string would
 * mean a background refresh that changed nothing marks every live, healthy
 * session as stale and tells the user to throw it away.
 *
 * 12 hex digits: this is an equality check between two runs of the same
 * machine, not a security boundary.
 */
export function pathId(path: string): string {
  const dirs = path.split(':').filter(Boolean).sort().join(':')
  return createHash('sha256').update(dirs).digest('hex').slice(0, 12)
}
