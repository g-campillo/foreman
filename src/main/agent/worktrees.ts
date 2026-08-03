/**
 * Git worktree isolation: one agent per branch, on its own copy of the tree.
 *
 * Sessions normally share the project's real cwd, which is fine for one agent
 * and a collision machine for three. A worktree gives each session its own
 * checkout and its own branch off the same repository, so parallel agents can
 * edit the same files without fighting.
 *
 * Everything here shells out to git rather than modelling worktree state — git
 * already tracks it in `.git/worktrees`, and a second source of truth would just
 * drift from it whenever the user runs `git worktree` themselves.
 */
import { app } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { basename, dirname, join } from 'node:path'
import { branchSlug, uniqueBranch } from './policy.mts'
import type { WorktreeInfo } from '../../shared/types'

const exec = promisify(execFile)

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

/** Where worktrees live: outside the repo, so the user's tree stays clean. */
function worktreeRoot(): string {
  return join(app.getPath('userData'), 'worktrees')
}

export async function repoRoot(cwd: string): Promise<string | null> {
  const r = await git(cwd, ['rev-parse', '--show-toplevel'])
  return r.ok ? r.stdout.trim() || null : null
}

/**
 * The *main* worktree's root, not whichever one `cwd` sits in.
 *
 * Matters because branching from an already-branched session is a normal thing
 * to do: `--show-toplevel` would then return that session's worktree, and we'd
 * record it as the new worktree's owner. Closing the parent first would leave
 * `repoRoot` pointing at a deleted directory, and the child could never be
 * cleaned up. `--git-common-dir` is shared by every worktree of a repository,
 * so its parent is stable no matter where this is called from.
 */
async function mainRoot(cwd: string): Promise<string | null> {
  const r = await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  const dir = r.ok ? r.stdout.trim() : ''
  return dir ? dirname(dir) : await repoRoot(cwd)
}

/**
 * Create a worktree on a new branch cut from the current HEAD.
 *
 * The directory name carries a disambiguating suffix because two projects can
 * share a basename and two sessions can ask for the same branch name; `git
 * worktree add` fails on a non-empty target, so a collision would surface as a
 * confusing error rather than silently sharing a checkout.
 *
 * The BRANCH gets the same treatment via uniqueBranch, and used to get none at
 * all: an existing ref was a refusal, and since removeWorktree leaves refs
 * behind on purpose, the second worktree session in a project failed forever.
 */
export async function createWorktree(
  cwd: string,
  branchName: string,
): Promise<{ ok: boolean; error?: string; worktree?: WorktreeInfo }> {
  const root = await mainRoot(cwd)
  if (!root) return { ok: false, error: 'Not a git repository.' }

  // A repo with no commits has nothing to branch from, and git's own message
  // for it ("invalid reference: HEAD") does not explain what to do.
  const head = await git(root, ['rev-parse', '--verify', 'HEAD'])
  if (!head.ok) {
    return { ok: false, error: 'This repository has no commits yet — make one first.' }
  }

  const slug = branchSlug(branchName)
  // `--quiet` so a missing ref is an exit code rather than a line on stderr:
  // this asks the question dozens of times in the pathological case, and every
  // miss is the ANSWER rather than a problem.
  const branch = await uniqueBranch(
    slug,
    async (ref) => (await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${ref}`])).ok,
  )

  const dir = join(worktreeRoot(), `${basename(root)}-${slug}-${Date.now().toString(36)}`)
  const made = await git(root, ['worktree', 'add', '-b', branch, dir, 'HEAD'])
  if (!made.ok) return { ok: false, error: made.error }

  return { ok: true, worktree: { path: dir, branch, repoRoot: root } }
}

/** Uncommitted changes in a worktree. 0 means removing it destroys nothing. */
export async function uncommittedCount(path: string): Promise<number> {
  const r = await git(path, ['status', '--porcelain', '--untracked-files=all'])
  if (!r.ok) return 0
  return r.stdout.split('\n').filter((l) => l.trim()).length
}

/**
 * Remove a worktree, but never one holding work that exists nowhere else.
 *
 * Committed work is safe either way — the branch ref outlives the checkout, so
 * removing a clean worktree loses nothing and the branch is still there to merge.
 * Uncommitted changes are the opposite: `git worktree remove` deletes the
 * directory, so this refuses and reports the path instead. Committing from the
 * diff panel first is the way through.
 *
 * The branch ref goes too when git agrees it carries nothing — see the `-d`
 * below. Without that, every worktree session a project ever had left a ref
 * behind, and those refs are what the uniquifier then has to walk past.
 */
export async function removeWorktree(
  info: WorktreeInfo,
): Promise<{ removed: boolean; reason?: string }> {
  const dirty = await uncommittedCount(info.path)
  if (dirty > 0) {
    return {
      removed: false,
      reason: `${info.branch} kept: ${dirty} uncommitted change${dirty === 1 ? '' : 's'} at ${info.path}`,
    }
  }

  const r = await git(info.repoRoot, ['worktree', 'remove', info.path])
  if (!r.ok) return { removed: false, reason: `${info.branch} kept: ${r.error}` }

  // -d, NEVER -D: git refuses a branch with unmerged commits, so this cannot
  // lose work — which is what lets it run unconditionally. An empty branch (the
  // common case, and the one that used to accumulate) is an ancestor of HEAD and
  // goes. Failure is the expected outcome for a branch carrying real commits, and
  // is deliberately silent: the ROADMAP's rule is that the ref outlives the
  // checkout, and git refusing here is that rule enforcing itself.
  await git(info.repoRoot, ['branch', '-d', info.branch])
  return { removed: true }
}
