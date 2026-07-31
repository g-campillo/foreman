/**
 * Where a host's unix socket goes, and why it is not where you would expect.
 *
 * Its own module, and `.mts`, for one reason: the root package is
 * `"type": "commonjs"`, so a plain `.ts` cannot be loaded under bare node and
 * therefore cannot be self-checked. `hostwire.ts` is bundled-only for exactly
 * that reason, and this logic is the part that needs a test.
 */

/**
 * The hard limit on a unix socket path, from `sockaddr_un.sun_path`.
 *
 * 104 bytes on macOS, 108 on Linux, NUL included. This is a kernel ABI
 * constant, not a filesystem limit: `PATH_MAX` is 1024, and every other file a
 * host owns is free to sit at a long path.
 *
 * Node reports an overrun as a bare `EINVAL` from `listen()` that mentions
 * neither length nor limit, which reads like a bug in the caller. That is how
 * it presented: every host started, logged `up:`, then died on bind.
 */
export const SUN_PATH_MAX = process.platform === 'darwin' ? 104 : 108

/** Runtime sockets, directly under userData rather than per-host. */
export const HOST_SOCK_DIR = 'run'

/**
 * Deliberately NOT inside the host's own directory.
 *
 * The obvious layout, `<userData>/hosts/<sessionId>/sock`, spends 84 bytes
 * after `/Users/<name>`: 29 for `/Library/Application Support/`, 7 for the app
 * name, 7 for `/hosts/`, 36 for a full UUID and 5 for `/sock`. Against a
 * 104-byte cap that leaves **12 characters for a username**, so it works for
 * `gcampillo` (9) and fails for `gabriel.campillo` (16) — a bug that fires
 * based on nothing but the length of an account name, and takes the whole app
 * with it because no session can start at all.
 *
 * This layout spends 58, leaving 38 — or 34 on the dev build, whose userData is
 * `Foreman Dev` rather than `foreman`. That is the figure that matters, and
 * macOS caps account names at 31. The id is truncated to 12 hex digits: 48 bits
 * of collision space against at most a handful of concurrent hosts, in exchange
 * for 24 characters of headroom.
 */
export function sockPathFor(userData: string, sessionId: string): string {
  const short = sessionId.replace(/-/g, '').slice(0, 12) || 'default'
  // Joined by hand: a unix socket path is `/`-separated by definition, so there
  // is nothing platform-specific for `node:path` to decide.
  return `${userData.replace(/\/+$/, '')}/${HOST_SOCK_DIR}/${short}.sock`
}

/**
 * Why a socket path is unusable, or null if it is fine.
 *
 * Called by both sides before bind and connect, so an overrun names itself
 * instead of surfacing as `EINVAL` in a log nobody opens.
 */
export function sockPathProblem(path: string): string | null {
  const bytes = Buffer.byteLength(path, 'utf8')
  if (bytes >= SUN_PATH_MAX) {
    return `socket path is ${bytes} bytes, over the ${SUN_PATH_MAX}-byte sun_path limit on this platform: ${path}`
  }
  return null
}
