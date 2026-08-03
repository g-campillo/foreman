import type { BranchInfo } from '../../shared/types'

/**
 * The branch list, parsed out of `git for-each-ref`.
 *
 * `for-each-ref` and NOT `git branch -a`, which is porcelain in the literal
 * sense: it decorates the current branch with a leading `* `, indents everything
 * else by two spaces, and renders `origin/HEAD` as the arrow line
 * `remotes/origin/HEAD -> origin/main`. Every one of those is a shape this would
 * have to un-parse, and none of them is promised to stay put.
 *
 * The fields are TAB-joined. A refname may not contain a control character, so a
 * tab is an unambiguous separator; a SPACE is not, and specifically `%(HEAD)`
 * emits a literal space for every ref that is not the current one — which is why
 * that field is tested for `'*'` rather than for emptiness.
 */
export const REF_FORMAT =
  '%(refname)%09%(HEAD)%09%(worktreepath)%09%(upstream:short)%09%(committerdate:unix)%09%(symref)'

const LOCAL = 'refs/heads/'
const REMOTE = 'refs/remotes/'

/**
 * Rows for the branch menu, newest first (git's `--sort=-committerdate` order is
 * preserved).
 *
 * `remotes` is the output of `git remote`, and it is required rather than
 * inferred: a remote-tracking ref is `refs/remotes/<remote>/<branch>`, and both
 * halves may contain slashes. Splitting on the first `/` mis-strips a remote
 * named `team/fork`, and splitting on the last one mangles every `feature/x`.
 * Matching the LONGEST configured remote is the only split that is right in both
 * directions.
 *
 * Three rows are dropped, each for its own reason:
 *
 *  - Anything with a non-empty `%(symref)`. That is `origin/HEAD`, and skipping
 *    it by WHAT IT IS rather than by its name means a clone whose default branch
 *    was renamed still works.
 *  - `refs/remotes/<remote>/HEAD` by name, for an older clone carrying a
 *    non-symbolic one.
 *  - A remote ref whose remote is not configured. There is nothing to
 *    `--track` there, so offering the row would only produce a failed checkout.
 *
 * Finally, a remote branch that also exists locally is dropped: picking it would
 * mean "create a local branch tracking this" for a local branch that already
 * exists. Locals are collected first so that pass can see all of them regardless
 * of date order.
 */
export function parseRefs(out: string, remotes: readonly string[]): BranchInfo[] {
  // Longest first, so `team/fork` wins over a `team` that also exists.
  const byLength = [...remotes].filter(Boolean).sort((a, b) => b.length - a.length)
  const rows: BranchInfo[] = []
  const localNames = new Set<string>()

  for (const line of out.split('\n')) {
    if (!line) continue
    const [ref, head, worktreePath, upstream, committed, symref] = line.split('\t')
    // Six fields or it is not our format at all — and the last is only empty,
    // never absent, because %(symref) always emits its (possibly empty) value.
    if (symref === undefined || symref !== '') continue

    let name: string
    let remote: string | null = null
    if (ref.startsWith(LOCAL)) {
      name = ref.slice(LOCAL.length)
      localNames.add(name)
    } else if (ref.startsWith(REMOTE)) {
      const rest = ref.slice(REMOTE.length)
      const found = byLength.find((r) => rest.startsWith(`${r}/`))
      if (!found) continue
      name = rest.slice(found.length + 1)
      if (!name || name === 'HEAD') continue
      remote = found
    } else {
      continue
    }

    rows.push({
      name,
      remote,
      ref,
      current: head === '*',
      // Raw here; listBranches clears it for our OWN worktree, which needs a
      // realpath comparison this file has no business doing.
      checkedOutAt: worktreePath || null,
      upstream: upstream || null,
      updatedAt: Number(committed) || 0,
    })
  }

  return rows.filter((b) => !b.remote || !localNames.has(b.name))
}
