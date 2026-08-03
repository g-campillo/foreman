/**
 * Which commit a new worktree branch is cut from, and the ignore entry that
 * keeps the checkouts out of `git status`.
 *
 * Both are pure, and both take the world as a parameter — the ref probe here,
 * the current file contents in `withExclude` — for the reason `uniqueBranch` in
 * policy.mts does: `npm run check` can then drive the whole decision table under
 * bare node with no repository to set up. They live in a leaf `.mts` rather than
 * in worktrees.ts for a second reason as well: branches.ts already imports from
 * worktrees.ts, so a resolver worktrees.ts imported back would be a cycle.
 */

/** What `chooseBase` picked, and how to say it in a sentence. */
export interface WorktreeBase {
  /** Passed to `git worktree add … <ref>`, so it reaches argv verbatim. */
  ref: string
  /** For the notice: `Working in foreman/x, cut from ${label}.` */
  label: string
}

/** A ref name that is safe to hand to git as a positional argument.
 *
 * Refuses `..` (a range, and `git worktree add x a..b` is not what anyone meant),
 * a leading `-` (git reads it as an option), a trailing or doubled slash and
 * anything with whitespace or a control character. Deliberately NOT a general
 * check-ref-format implementation: this only has to be tight enough that a
 * hostile or corrupt `origin/HEAD` cannot become a flag. */
function safeRef(ref: string): boolean {
  if (!ref || ref.startsWith('-') || ref.startsWith('/') || ref.endsWith('/')) return false
  if (ref.includes('..') || ref.includes('//')) return false
  return !/[\s~^:?*[\\]|[\x00-\x1f\x7f]/.test(ref)
}

/**
 * The branch a worktree is cut from.
 *
 * `origin/HEAD` first, because that is the repository's own answer to "what is
 * the default branch" and it survives a rename of `master` to `main` or to
 * anything else. `symref` is whatever `git symbolic-ref --short --quiet
 * refs/remotes/origin/HEAD` printed — `origin/main`, or empty in a clone that
 * never fetched one and in a repo with no remote at all.
 *
 * NO FETCH, ever. This runs on the path that creates a session, and
 * branches.ts:46-57 already argues the case against a network call on a UI path;
 * this is the same argument with a worse failure mode, because a fetch that
 * hangs hangs the new conversation. It also gives parity with what a person
 * would do by hand, which is `git checkout main` against whatever they have.
 *
 * Falling back to HEAD rather than refusing: a repo with no `origin`, no `main`
 * and no `master` is an ordinary local repo, and cutting from wherever it is
 * standing is exactly what `git worktree add -b x <dir>` does by default.
 */
export async function chooseBase(
  symref: string,
  exists: (ref: string) => Promise<boolean>,
): Promise<WorktreeBase> {
  const remote = symref.trim()
  // The remote-tracking ref itself, which is a real committish — `origin/main`
  // resolves without a fetch because the clone already has it.
  if (remote && safeRef(remote) && (await exists(remote))) {
    return { ref: remote, label: remote }
  }
  // ...and the LOCAL branch of the same name when the remote-tracking ref is
  // gone but the name still tells us which branch is the default.
  const stripped = remote.startsWith('origin/') ? remote.slice('origin/'.length) : ''
  if (stripped && safeRef(stripped) && (await exists(`refs/heads/${stripped}`))) {
    return { ref: stripped, label: stripped }
  }
  for (const name of ['main', 'master']) {
    if (await exists(`refs/heads/${name}`)) return { ref: name, label: name }
  }
  return { ref: 'HEAD', label: 'the current HEAD' }
}

/**
 * `info/exclude` with our entry appended, or null when it is already there.
 *
 * Null rather than the unchanged text, so the caller writes only when there is
 * something to write — this runs on every worktree creation, and three creates
 * must not leave three copies of the same line.
 *
 * A LINE-EXACT MATCH, not a substring test. `.worktrees` inside a comment is not
 * an exclusion, and `/.worktrees/` is a different pattern from `.worktrees` (the
 * leading slash anchors it to the repository root, which is the one we want —
 * a bare `.worktrees` would also hide a directory of that name nested anywhere
 * in the tree). Matching loosely would silently skip the write and leave the
 * checkouts showing up as untracked in the user's own `git status`.
 */
export function withExclude(current: string, entry: string): string | null {
  const has = current
    .split('\n')
    .some((line) => line.replace(/\r$/, '').trim() === entry)
  if (has) return null
  // An empty file gets no leading blank line; one without a trailing newline
  // gets one, or the entry would be glued onto the last pattern and both would
  // stop matching.
  if (!current) return `${entry}\n`
  return current.endsWith('\n') ? `${current}${entry}\n` : `${current}\n${entry}\n`
}
