/**
 * Listing branches, and moving between them.
 *
 * The composer's branch control used to render one inert row — the name
 * `readStatus` happened to read as a side effect of the diff status. Nothing in
 * the app enumerated branches at all, so "the dropdown only shows main" was the
 * feature working exactly as built.
 *
 * In main rather than the host, for the reason the diff handlers already give:
 * this reads git against a cwd and holds no session state, so it costs no
 * round-trip and it still works for a session whose host has idled out.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { realpathSync } from 'node:fs'
import type { BranchList, CheckoutResult } from '../../shared/types'
import { parseRefs, REF_FORMAT } from './refs.mts'
import { repoRoot } from './worktrees'

const exec = promisify(execFile)

/**
 * One git call, keeping stderr.
 *
 * gitdiff.ts has two helpers for this — one that swallows and one that keeps the
 * message — and both are private to it. This one always keeps it, because the
 * whole design of `checkoutBranch` is that git's own refusal reaches the rail
 * verbatim: nothing we could write is better than "Your local changes to the
 * following files would be overwritten by checkout".
 */
async function git(
  cwd: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string; error: string }> {
  try {
    const { stdout } = await exec('git', ['-C', cwd, ...args], { maxBuffer: 16 * 1024 * 1024 })
    return { ok: true, stdout, error: '' }
  } catch (err) {
    const e = err as { stderr?: string; message?: string }
    return { ok: false, stdout: '', error: (e.stderr || e.message || 'git failed').trim() }
  }
}

const EMPTY: BranchList = { current: null, detachedAt: null, branches: [] }

/**
 * In-flight reads, keyed by repo root.
 *
 * Deliberately NOT a cache with a TTL. The menu is opened precisely when
 * something may have changed — you fetch in the ⌘2 terminal, then open the menu
 * to pick what you fetched — so any stale window is stale at the one moment it
 * matters. What IS worth collapsing is a double-open: this drops the second
 * click's four processes, and the entry is removed as soon as the read settles.
 *
 * There is also no `git fetch` here. That would be network-bound and would
 * mutate refs, on a menu-open path.
 */
const inflight = new Map<string, Promise<BranchList>>()

export async function listBranches(cwd: string): Promise<BranchList> {
  const root = await repoRoot(cwd)
  if (!root) return EMPTY
  const running = inflight.get(root)
  if (running) return running
  const p = readBranches(root).finally(() => inflight.delete(root))
  inflight.set(root, p)
  return p
}

/** Best-effort canonical path. macOS reports /tmp and /private/tmp for the same
 *  directory, and git prints one while `--show-toplevel` prints the other. */
function real(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

async function readBranches(root: string): Promise<BranchList> {
  const [head, sha, remotes, refs] = await Promise.all([
    // `symbolic-ref` rather than `branch --show-current`, which prints nothing
    // for BOTH a detached HEAD and an unborn one. This fails on a detachment and
    // succeeds on an unborn branch, which is exactly the distinction needed
    // below: one has a sha worth naming, the other has a branch worth listing.
    git(root, ['symbolic-ref', '--short', '--quiet', 'HEAD']),
    git(root, ['rev-parse', '--short', 'HEAD']),
    git(root, ['remote']),
    git(root, [
      'for-each-ref',
      `--format=${REF_FORMAT}`,
      '--sort=-committerdate',
      'refs/heads',
      'refs/remotes',
    ]),
  ])

  const current = (head.ok && head.stdout.trim()) || null
  const branches = parseRefs(
    refs.ok ? refs.stdout : '',
    remotes.ok ? remotes.stdout.split('\n').map((r) => r.trim()).filter(Boolean) : [],
  )

  // `%(worktreepath)` is set for OUR OWN branch too, so without this the branch
  // you are standing on renders greyed out with its own path as the reason.
  const here = real(root)
  for (const b of branches) {
    if (b.checkedOutAt && real(b.checkedOutAt) === here) b.checkedOutAt = null
  }

  // A repo with no commits has no refs/heads at all, but symbolic-ref still
  // names the unborn branch — so without this the menu is empty on a perfectly
  // ordinary fresh `git init`.
  if (current && !branches.some((b) => !b.remote && b.name === current)) {
    branches.unshift({
      name: current,
      remote: null,
      ref: `refs/heads/${current}`,
      current: true,
      checkedOutAt: null,
      upstream: null,
      updatedAt: 0,
    })
  }

  return {
    current,
    detachedAt: current ? null : (sha.ok && sha.stdout.trim()) || null,
    branches,
  }
}

/**
 * Check a branch out.
 *
 * The list is RE-READ and the request matched against it before anything reaches
 * argv, and that is a trust boundary rather than tidiness: `name` arrives over
 * IPC, and `git switch` has `--force`, `--discard-changes` and `--orphan` in its
 * flag set. Matching against git's own output means every value on the command
 * line came out of git's mouth — and it proves the ref still exists, so a menu
 * left open across a `git branch -d` in the terminal fails cleanly. Same posture
 * `revertFile` takes with its `within()` check.
 *
 * `git switch`, not `git checkout`: checkout's second meaning ("restore these
 * paths") makes a branch name that collides with a path ambiguous. `--no-guess`
 * on the local arm, so a stale menu fails loudly instead of quietly creating a
 * branch off some remote nobody picked.
 *
 * NO DIRTY-TREE PRE-CHECK, on purpose. `git switch` succeeds on a dirty tree
 * whenever the changes carry over cleanly, which is the common case; refusing
 * first would block the thing people actually do. When git does refuse, its
 * stderr is the message.
 */
export async function checkoutBranch(
  cwd: string,
  name: string,
  remote: string | null,
): Promise<CheckoutResult> {
  const root = await repoRoot(cwd)
  if (!root) return { ok: false, error: 'Not a git repository.' }

  const { branches } = await readBranches(root)
  const target = branches.find((b) => b.name === name && b.remote === remote)
  if (!target) return { ok: false, error: `No branch named ${name} any more.` }
  if (target.current) return { ok: true, branch: name }
  if (target.checkedOutAt) {
    return { ok: false, error: `${name} is already checked out at ${target.checkedOutAt}.` }
  }

  // READ BEFORE MOVING. Switching away from a detached HEAD that has commits on
  // it SUCCEEDS, warns on stderr and exits 0 — so the warning is discarded with
  // every other success, and the commits become unreachable with nothing on
  // screen to say so. This is the only chance to see the sha.
  const attached = await git(root, ['symbolic-ref', '--quiet', 'HEAD'])
  const leaving = attached.ok ? null : (await git(root, ['rev-parse', '--short', 'HEAD'])).stdout.trim() || null

  const done = await git(
    root,
    // Pinning the local name rather than letting `--track` derive it: that is
    // what makes `origin/feature/x` land on `feature/x`, and what disambiguates
    // the same branch name on two remotes. Never --force, never a stash.
    //
    // `--` before the last positional is residual belt-and-braces on top of the
    // match above — every value here already came out of git's own output. It
    // costs nothing and it closes the one theoretical gap left: `git branch --
    // -x` is refused by check-ref-format today, but a ref that ever did start
    // with a dash would otherwise land in argv as a flag.
    target.remote
      ? ['switch', '--create', name, '--track', '--', `${target.remote}/${name}`]
      : ['switch', '--no-guess', '--', name],
  )
  if (!done.ok) return { ok: false, error: done.error }

  return {
    ok: true,
    branch: name,
    notice: leaving ? `Left ${leaving} behind — recover it with git checkout ${leaving}.` : undefined,
  }
}
