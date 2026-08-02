import { app } from 'electron'
import { type ChildProcessByStdio, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Readable } from 'node:stream'
import { SENTINEL, mergePath, parseShellPath, pathId } from '../shared/shellpath.mts'

/**
 * Ask the user's login shell what PATH it would have set up, and adopt it.
 *
 * Launched from Finder or the Dock, macOS gives an app the bare launch PATH:
 * `/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin`. Nothing the user installed
 * for themselves is on it. `HostClient.start` spawns every agent host with
 * `{ ...process.env }`, so that stripped PATH is inherited by the host, by the
 * bundled `claude` CLI, and by every stdio MCP server the CLI spawns — which is
 * why four plugin servers sit permanently red in the MCP tab with
 * `Executable not found in $PATH: "npx"`.
 *
 * The terminal never had this problem because `pty.ts` spawns `$SHELL -l`. This
 * does the same thing once, at startup, for everything else.
 *
 * The pure half — the sentinel, the parser, the merge — is `shared/shellpath.mts`
 * so it can be self-checked under bare node. This half spawns, caches, and is
 * the only thing in the app that writes `process.env.PATH`.
 */

/**
 * How long we will wait for a shell to finish sourcing its rc files.
 *
 * Generous, because this is not on any path a user is watching: a warm launch
 * has already applied the cached answer and moved on, and only a cold first
 * launch actually blocks on it. But it must be bounded — an rc file that hangs
 * would otherwise mean no session can ever start.
 */
const RESOLVE_TIMEOUT_MS = 5000

interface CachedPath {
  path: string
  resolvedAt: number
}

function cacheFile(): string {
  return join(app.getPath('userData'), 'shell-path.json')
}

function readCache(): string | null {
  try {
    const { path } = JSON.parse(readFileSync(cacheFile(), 'utf8')) as CachedPath
    return path || null
  } catch {
    // Missing on first launch, and unreadable if a write was interrupted.
    // Either way there is nothing to apply and the refresh below will fix it.
    return null
  }
}

function writeCache(path: string): void {
  try {
    const file = cacheFile()
    mkdirSync(dirname(file), { recursive: true })
    // Written to a sibling and renamed: `rename` within a directory is atomic,
    // so a launch that dies mid-write leaves either the old file or the new one
    // and never a truncated one that `readCache` has to fail on.
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify({ path, resolvedAt: Date.now() } satisfies CachedPath))
    renameSync(tmp, file)
  } catch (err) {
    // A cache we cannot write costs a shell spawn per launch, nothing more.
    console.warn('[path] could not cache the shell PATH:', err)
  }
}

/** Merge into this process's PATH, which every host then inherits at spawn. */
function applyPath(resolved: string): void {
  const merged = mergePath(process.env.PATH ?? '', resolved)
  if (merged === process.env.PATH) return
  process.env.PATH = merged
  console.log(`[path] adopted the login shell's PATH (${merged.split(':').length} entries)`)
}

/**
 * What the user's shell says PATH should be, or null if we could not find out.
 *
 * Null on every failure — no shell, no sentinel, an empty value — because
 * the caller's response to null is "keep the PATH we already have", and that is
 * always safe. There is no failure here worth making louder than a log line:
 * the app worked before this function existed and will work after it fails.
 */
export async function resolveShellPath(): Promise<string | null> {
  // No login shell to ask on Windows, and without $SHELL there is nothing to
  // spawn — a bare `sh` would report a PATH nobody configured.
  if (process.platform === 'win32') return null
  const shell = process.env.SHELL
  if (!shell) return null

  return new Promise<string | null>((resolve) => {
    const env = { ...process.env }
    // Defensive: main does not set this, but it is inherited by everything an
    // agent runs and it turns any downstream Electron launch into a bare node
    // process. It must never be in the environment of a shell we spawn.
    delete env.ELECTRON_RUN_AS_NODE

    // `-ilc`, not `-lc`. zsh sources `.zprofile` for a login shell but `.zshrc`
    // only for an interactive one, and a default nvm install writes its loader
    // into `.zshrc` — so a non-interactive shell answers with a PATH that has
    // no node on it, which is the exact failure this function exists to fix.
    // The sentinels are what make an interactive shell's banner output
    // survivable; a full `env` dump rather than `echo $PATH` gives the parser an
    // anchor that an rc file cannot forge.
    //
    // `/usr/bin/env` by absolute path, not `command -p env`: `command -p` is a
    // POSIX special builtin that fish does not have, so under fish the whole
    // exercise would emit two sentinels with nothing between them and fish users
    // would silently keep the broken PATH. An absolute path to a real binary
    // works in every shell, and survives an rc file that wrecked PATH on the way
    // through.
    let child: ChildProcessByStdio<null, Readable, null>
    try {
      child = spawn(shell, ['-ilc', `echo ${SENTINEL}; /usr/bin/env; echo ${SENTINEL}`], {
        env,
        // stdin ignored on purpose: an rc file that reads from it — a prompt, a
        // `read -k` keybinding check — would otherwise hang us forever.
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    } catch (err) {
      // `spawn` throws synchronously when the fork itself fails — EAGAIN or
      // EMFILE under process pressure — rather than emitting `error`. Left to
      // propagate it would reject this promise, and through it `primeShellPath`,
      // so `markReady` would never run and every session start would await
      // forever. Null is the same "keep the PATH we have" as any other failure.
      console.warn(`[path] could not spawn ${shell}:`, err)
      resolve(null)
      return
    }

    let out = ''
    let settled = false
    const finish = (value: string | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // The child may still be sourcing something slow; nothing downstream
      // wants its output any more.
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
      resolve(value)
    }

    const timer = setTimeout(() => finish(null), RESOLVE_TIMEOUT_MS)
    timer.unref?.()

    child.stdout.on('data', (c: Buffer) => {
      out += c.toString('utf8')
    })
    child.on('error', () => finish(null))
    child.on('close', (code, signal) => {
      // The exit status is deliberately not a gate. The sentinel pair plus the
      // `PATH=` anchor IS the validity test, and with `-c` the status is just
      // the last command's — an rc file that ends in a failing check, or a shell
      // killed by an outside signal (`code === null`) after printing everything,
      // would otherwise throw away a payload that parsed perfectly well. Still
      // worth a line when it happens, so a hostile rc stays diagnosable — but
      // not when we are the ones who killed it, which is every timeout.
      if (code !== 0 && !settled) {
        console.warn(`[path] ${shell} exited with code=${code} signal=${signal}`)
      }
      finish(parseShellPath(out))
    })
  })
}

let markReady: () => void = () => undefined

/**
 * Resolves once this process's PATH is as good as it is going to get.
 *
 * `HostClient.start` awaits it, so the first session of a cold first launch
 * cannot race the resolution and spawn a host with the stripped PATH. On every
 * launch after that there is a cached answer, this is already resolved by the
 * time anything awaits it, and starting a session costs nothing.
 */
export const shellPathReady: Promise<void> = new Promise<void>((resolve) => {
  markReady = resolve
})

/**
 * Startup: apply what we knew, then go and find out what is true now.
 *
 * Deliberately not awaited by the caller. The cached value is applied
 * synchronously, before the first `await` below, so a warm launch has the right
 * PATH in place before a window is even created; the shell spawn then happens
 * behind everything else.
 *
 * The refresh runs on EVERY launch rather than on a cache expiry, because the
 * answer changes for ordinary reasons — switching node versions, installing
 * Homebrew, editing `.zshrc` — and a stale PATH here reads to the user as an
 * MCP server that will not connect. A refresh that lands after a host has
 * already been spawned cannot reach it, since its env was frozen at `spawn`;
 * that is what the `pathId` in `HostMeta` exists to surface.
 */
export async function primeShellPath(): Promise<void> {
  if (process.platform === 'win32' || !process.env.SHELL) return markReady()

  // `finally`, because `markReady` failing to run is the one outcome nobody
  // recovers from: `HostClient.start` awaits `shellPathReady`, so anything that
  // escapes this body on a cold launch with no cache hangs every session start
  // forever, with no error and no timeout. A PATH we could not improve is a
  // working app; a promise that never settles is not.
  try {
    const cached = readCache()
    if (cached) {
      applyPath(cached)
      // Good enough to spawn with. Sessions are unblocked now and the refresh
      // lands behind them rather than in front.
      markReady()
    }

    const fresh = await resolveShellPath()
    if (fresh) {
      applyPath(fresh)
      writeCache(fresh)
    } else if (!cached) {
      console.warn(`[path] could not read a PATH from ${process.env.SHELL}; using the launch PATH`)
    }
  } finally {
    markReady()
  }
}

/**
 * A short stable fingerprint of the PATH a host would be spawned with.
 *
 * Recorded in each host's `meta.json` at spawn time and compared against the
 * current one when the MCP tab asks for status. A host's environment is frozen
 * at `spawn`, so a host started before this process learned the real PATH can
 * never reconnect an MCP server no matter how many times the button is pressed
 * — and saying so is far better than another silent red row. An absent id means
 * a host started by a build older than this, which is the same stale case.
 *
 * Set-based, not order-based — see `pathId`, where the sort and the reason for
 * it live. The property being asked about is "can this host still find npx",
 * and a shell that hands the same directories back in a different order has not
 * invalidated anything.
 */
export function currentPathId(): string {
  return pathId(process.env.PATH ?? '')
}
