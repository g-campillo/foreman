import { resolve as resolvePath } from 'node:path'

/**
 * Parse `git status --porcelain -z --untracked-files=all` into
 * absolute path -> two-character status code.
 *
 * `-z` matters: without it git quotes and backslash-escapes any path containing
 * a space or a non-ASCII byte, and that escaping is not reliably reversible by
 * hand. With it, every field is raw and NUL-terminated.
 *
 * The one shape that isn't just "code, space, path": a rename or copy entry
 * carries its ORIGIN path as the *next* NUL field rather than inline. Miss that
 * and the origin parses as a garbage entry whose status code is really the first
 * two characters of a filename.
 */
export function parsePorcelainZ(out: string, root: string): Map<string, string> {
  const fields = out.split('\0')
  const found = new Map<string, string>()

  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i]
    // Shortest real entry is 'XY p' — anything less is the trailing empty field.
    if (entry.length < 4) continue

    const xy = entry.slice(0, 2)
    if (xy[0] === 'R' || xy[0] === 'C') {
      const from = fields[++i]
      // Both ends of a rename changed: the origin vanished, the target appeared.
      if (from) found.set(resolvePath(root, from), xy)
    }
    found.set(resolvePath(root, entry.slice(3)), xy)
  }
  return found
}
