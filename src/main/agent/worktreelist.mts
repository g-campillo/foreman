/**
 * `git worktree list --porcelain`, parsed.
 *
 * Same posture as porcelain.mts, numstat.mts and refs.mts: the parse is pure and
 * lives in its own `.mts` leaf so `npm run check` can drive it under bare node,
 * with no repository to set up. `--porcelain` and not the human format, which
 * pads the path with spaces to a column width and abbreviates the branch — both
 * of which are display decisions git is free to change.
 *
 * RECORDS ARE SEPARATED BY A BLANK LINE, and that is the only structure this
 * relies on. Parsing by line index would break on the very next attribute git
 * adds: `locked` and `prunable` are optional, either may carry a reason, and a
 * detached worktree has no `branch` line at all.
 *
 * A VALUE IS EVERYTHING AFTER THE FIRST SPACE, never a `split(' ')[1]`. A
 * worktree path may contain spaces — `~/My Projects/thing` is an ordinary macOS
 * path — and so may a lock reason, which is free text the user typed.
 */
export interface WorktreeEntry {
  path: string
  /** Short branch name, or null when the checkout is detached or bare. */
  branch: string | null
  head: string | null
  detached: boolean
  bare: boolean
  /** git says this entry's directory is gone; `worktree prune` would drop it. */
  prunable: boolean
  /** Reason git gave for `locked`/`prunable`, or null. Empty when the flag has
   *  no reason after it — the flag itself is on the boolean beside this. */
  reason: string | null
  locked: boolean
}

const BRANCH = 'refs/heads/'

/** The key and its value, or null for a bare flag. */
function split(line: string): [key: string, value: string | null] {
  const at = line.indexOf(' ')
  return at === -1 ? [line, null] : [line.slice(0, at), line.slice(at + 1)]
}

export function parseWorktreeList(stdout: string): WorktreeEntry[] {
  const out: WorktreeEntry[] = []
  let cur: WorktreeEntry | null = null

  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (!line) {
      // A blank line ends the record. Trailing blanks and a blank-only stdout
      // therefore cost nothing, which is what makes `''` parse to `[]`.
      if (cur) out.push(cur)
      cur = null
      continue
    }
    const [key, value] = split(line)
    if (key === 'worktree') {
      // A second `worktree` line with no blank between records would otherwise
      // silently overwrite the first — flush rather than trust the separator.
      if (cur) out.push(cur)
      cur = {
        path: value ?? '',
        branch: null,
        head: null,
        detached: false,
        bare: false,
        prunable: false,
        reason: null,
        locked: false,
      }
      continue
    }
    // An attribute before any `worktree` line is not something git emits, and
    // inventing an entry for it would put a pathless row in front of the user.
    if (!cur) continue
    if (key === 'HEAD') cur.head = value
    else if (key === 'branch') cur.branch = value?.startsWith(BRANCH) ? value.slice(BRANCH.length) : value
    else if (key === 'detached') cur.detached = true
    else if (key === 'bare') cur.bare = true
    else if (key === 'locked') {
      cur.locked = true
      if (value) cur.reason = value
    } else if (key === 'prunable') {
      cur.prunable = true
      if (value) cur.reason = value
    }
  }
  if (cur) out.push(cur)
  return out
}
