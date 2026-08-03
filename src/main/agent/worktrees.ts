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
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { branchSlug, uniqueBranch, within, WORKTREE_DIR } from './policy.mts'
import { chooseBase, withExclude, type WorktreeBase } from './worktreebase.mts'
import { parseWorktreeList, type WorktreeEntry } from './worktreelist.mts'
import type { WorktreeInfo } from '../../shared/types'

const exec = promisify(execFile)

/** What goes in `info/exclude`. Anchored with a leading `/` so it names the
 *  directory at the repo root and nothing else — see withExclude. */
const EXCLUDE_ENTRY = `/${WORKTREE_DIR}/`

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

/**
 * Where worktrees live: `<repo>/.worktrees/`, IN the project.
 *
 * They used to live under `userData`, which kept `git status` clean for free but
 * put a session's actual working tree somewhere no one would ever look — outside
 * every editor window, every `find`, every backup of the project. In the repo
 * they are where you would expect a checkout of the repo to be, and `git status`
 * stays clean through `info/exclude` instead (see ensureExcluded).
 */
export function worktreeRoot(root: string): string {
  return join(root, WORKTREE_DIR)
}

/** The pre-move location, still on disk for every worktree created before the
 *  move. Kept because existing checkouts are NOT relocated — moving a registered
 *  worktree means rewriting git's admin files under it — so the orphan scanner
 *  has to keep looking here. */
export function legacyWorktreeRoot(): string {
  return join(app.getPath('userData'), 'worktrees')
}

export async function repoRoot(cwd: string): Promise<string | null> {
  const r = await git(cwd, ['rev-parse', '--show-toplevel'])
  return r.ok ? r.stdout.trim() || null : null
}

/**
 * The repository's shared git directory: `<repo>/.git` for an ordinary clone,
 * and somewhere else entirely for a `--separate-git-dir` clone or a submodule.
 *
 * Every linked worktree of a repository shares it, which is what makes it the
 * right place to write an exclude that has to hold for all of them.
 */
async function gitCommonDir(cwd: string): Promise<string | null> {
  const r = await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  const dir = r.ok ? r.stdout.trim() : ''
  return dir || null
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
 *
 * EXPORTED, and `repoRoot` is the wrong function for anything that reasons
 * about the SET of worktrees. From inside a linked checkout `--show-toplevel`
 * returns that checkout, so `worktreeRoot(repoRoot(cwd))` names a
 * `<worktree>/.worktrees` that does not exist — the orphan scan then finds
 * nothing and reports a clean repository, and `removeOrphan`'s containment
 * check is computed against the same wrong root.
 */
export async function mainRoot(cwd: string): Promise<string | null> {
  const dir = await gitCommonDir(cwd)
  return dir ? dirname(dir) : await repoRoot(cwd)
}

/**
 * Keep `.worktrees/` out of `git status`, idempotently.
 *
 * THE COMMON DIR'S `info/exclude`, never the tracked `.gitignore`. Two reasons,
 * and both are hard: `.gitignore` is the user's file and is committed, so
 * writing to it puts a line in their next commit that they did not add; and a
 * `--separate-git-dir` clone or a submodule keeps its git directory outside the
 * working tree entirely, so `join(root, '.git', …)` writes into a plain file or
 * into nothing. One write here covers every linked worktree of the repository.
 *
 * BEST EFFORT. A read-only `info/exclude` is unusual but not broken — the only
 * consequence is that the checkouts show up as untracked — and failing the
 * session creation over it would be wildly out of proportion.
 */
function ensureExcluded(commonDir: string): void {
  try {
    const dir = join(commonDir, 'info')
    const file = join(dir, 'exclude')
    const current = existsSync(file) ? readFileSync(file, 'utf8') : ''
    const next = withExclude(current, EXCLUDE_ENTRY)
    if (next === null) return
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, next, 'utf8')
  } catch (err) {
    console.warn('[worktrees] could not update info/exclude:', (err as Error).message)
  }
}

/**
 * Which branch a new worktree is cut from.
 *
 * A DEDICATED `symbolic-ref` CALL rather than reading it out of the branch list:
 * `parseRefs` deliberately DROPS the `origin/HEAD` row (see the docblock at
 * refs.mts:34-38), and reopening that contract to get one string back would put
 * a row in the branch menu that is not a branch.
 */
async function defaultBase(root: string): Promise<WorktreeBase> {
  const sym = await git(root, ['symbolic-ref', '--short', '--quiet', 'refs/remotes/origin/HEAD'])
  return chooseBase(sym.ok ? sym.stdout : '', async (ref) => verify(root, ref))
}

/** `--quiet` so a missing ref is an exit code rather than a line on stderr: this
 *  asks the question dozens of times in the pathological case, and every miss is
 *  the ANSWER rather than a problem. */
async function verify(root: string, ref: string): Promise<boolean> {
  return (await git(root, ['rev-parse', '--verify', '--quiet', ref])).ok
}

/**
 * `foreman/add-tests` → `add-tests`, and `foreman/fix/thing` → `fix-thing`.
 *
 * The directory used to be `foreman-<repo>-<slug>-<base36>`, which was fine when
 * it lived in a flat pile under userData and reads as line noise inside the
 * project. `.worktrees/` already scopes the name, and the branch is unique
 * within the repo, so the branch's own tail is enough.
 */
function dirNameFor(branch: string): string {
  return branch.replace(/^foreman\//, '').replace(/\//g, '-')
}

/**
 * Create a worktree on a new branch cut from the repository's default branch.
 *
 * NOT FROM `HEAD` ANY MORE. Cutting from whatever the main checkout happened to
 * be sitting on meant an agent could start on a half-finished branch of yours,
 * or on a detached HEAD, with nothing on screen to say so — see chooseBase for
 * why the answer is `origin/HEAD` and why there is no fetch. The chosen base is
 * returned so the renderer can name it.
 *
 * The BRANCH is uniquified via uniqueBranch, and used to get no treatment at
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

  // BEFORE the add, and this is the one call that clears the wreckage of a
  // worktree whose directory was deleted from underneath git: the admin entry in
  // `.git/worktrees/<name>` survives, and it keeps that branch registered as
  // checked out, so checking it out in the main tree fails with "already checked
  // out at …" permanently. See closeSession's own note on how that pile-up
  // starts.
  await git(root, ['worktree', 'prune'])

  // ALSO before the add. Written after, the new directory exists for a moment as
  // an untracked path — long enough for a concurrent `git status` (the diff
  // panel's, the composer's branch read, the user's own terminal) to report the
  // project as dirty and to offer the checkout's files for commit.
  const commonDir = await gitCommonDir(root)
  if (commonDir) ensureExcluded(commonDir)

  const slug = branchSlug(branchName)
  const branch = await uniqueBranch(slug, (ref) => verify(root, `refs/heads/${ref}`))
  const base = await defaultBase(root)

  // uniqueBranch guarantees the REF is free, not the DIRECTORY — a worktree
  // removed with `rm -rf` leaves its directory behind while its branch is gone,
  // and `git worktree add` fails on a non-empty target. So the old disambiguator
  // stays, as a fallback rather than as the name.
  let dir = join(worktreeRoot(root), dirNameFor(branch))
  if (existsSync(dir)) dir = `${dir}-${Date.now().toString(36)}`

  const made = await git(root, ['worktree', 'add', '-b', branch, dir, base.ref])
  if (!made.ok) return { ok: false, error: made.error }

  return { ok: true, worktree: { path: dir, branch, repoRoot: root, base: base.label } }
}

/** Best-effort canonical path — the same helper branches.ts keeps, for the same
 *  reason: macOS reports /tmp and /private/tmp for one directory, and git prints
 *  whichever spelling it was handed. */
function real(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** Every worktree git has registered for this repository, main tree included. */
export async function listWorktrees(root: string): Promise<WorktreeEntry[]> {
  const r = await git(root, ['worktree', 'list', '--porcelain'])
  return r.ok ? parseWorktreeList(r.stdout) : []
}

/** Drop admin entries whose directories are gone. What makes a branch checkable
 *  out again in the main tree — see createWorktree. */
export async function pruneWorktrees(root: string): Promise<{ ok: boolean; error?: string }> {
  const r = await git(root, ['worktree', 'prune'])
  return r.ok ? { ok: true } : { ok: false, error: r.error }
}

/** Subdirectory names, or none. A directory that does not exist is the ordinary
 *  case for a project that has never used a worktree, not a failure. */
function dirsIn(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return []
  }
}

/**
 * Which repository a linked checkout belongs to: the path out of its `.git`
 * file, which reads `gitdir: <commonDir>/worktrees/<name>`.
 *
 * Still there for an ORPHAN — the admin directory it names has gone, but the
 * string has not — which is exactly why this is usable as proof of ownership.
 * Null when the file is missing or unreadable, which is "cannot attribute".
 */
function linkedGitDir(checkout: string): string | null {
  try {
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(join(checkout, '.git'), 'utf8'))
    return m ? m[1]!.trim() : null
  } catch {
    return null
  }
}

/**
 * Directories in either worktree root that git no longer knows about.
 *
 * The other half of prune: `git worktree prune` collects the admin ENTRY whose
 * directory is gone, and leaves a directory whose entry is gone entirely alone —
 * so an interrupted create, or a `git worktree remove` that failed halfway,
 * leaves a checkout sitting in the project with nothing that will ever collect
 * it. BOTH roots are scanned, because the pre-move ones are still on disk.
 *
 * THE TWO ROOTS PROVE OWNERSHIP DIFFERENTLY, and that asymmetry is the whole
 * reason this is not one loop. `<repo>/.worktrees/` belongs to this repository
 * by containment. `legacyWorktreeRoot()` is ONE FLAT DIRECTORY SHARED BY EVERY
 * PROJECT — so an unregistered directory in it is, far more often than not,
 * another project's perfectly live worktree, and listing it here hands the panel
 * a Delete button pointed at someone else's work.
 *
 * Attribution is by the `.git` file rather than by the old
 * `<basename>-<slug>-<base36>` naming, because the name is not evidence: two
 * checkouts of `~/work/foreman` and `~/oss/foreman` produce the same prefix, and
 * a repository that has since been renamed inverts the test in both directions
 * at once. Anything that cannot be attributed is left alone — a missed orphan
 * costs a stale directory, and the other error deletes a working tree.
 */
export async function orphanedCheckouts(root: string): Promise<string[]> {
  // CANONICAL ON BOTH SIDES. git prints the path as it was registered and we
  // build ours by joining, and on macOS those differ through /tmp — a live
  // worktree would then fail the membership test and be offered for DELETION as
  // an orphan. `real` is best effort, so a path that has gone away compares as
  // itself, which is exactly what an orphan is.
  const registered = new Set((await listWorktrees(root)).map((w) => real(w.path)))
  const out: string[] = []

  const here = worktreeRoot(root)
  for (const name of dirsIn(here)) {
    const path = join(here, name)
    if (!registered.has(real(path))) out.push(path)
  }

  const commonDir = await gitCommonDir(root)
  if (!commonDir) return out
  // Both spellings of the common dir, because the `gitdir:` line was written at
  // `worktree add` time with whatever spelling the root had then, and this one
  // comes from `--path-format=absolute` now. A mismatch here only ever hides an
  // orphan, which is the safe direction.
  const owned = (gitdir: string): boolean =>
    within(commonDir, gitdir) || within(real(commonDir), gitdir)

  const legacy = legacyWorktreeRoot()
  for (const name of dirsIn(legacy)) {
    const path = join(legacy, name)
    if (registered.has(real(path))) continue
    const gitdir = linkedGitDir(path)
    if (gitdir && owned(gitdir)) out.push(path)
  }
  return out
}

/**
 * Delete an orphaned checkout.
 *
 * A TRUST BOUNDARY: the path arrives over IPC and this removes a directory tree.
 * Same posture `checkoutBranch` takes with a branch name (branches.ts:133-153) —
 * the list is RE-DERIVED here and the request matched against it, so the only
 * paths that can reach `rmSync` are ones this process just found itself. The
 * `within` check on top of that is belt and braces: it makes the containment
 * explicit rather than implied by how `orphanedCheckouts` builds its strings.
 *
 * A dirty orphan is REFUSED, for the reason removeWorktree refuses one: those
 * changes exist nowhere else, and there is no branch ref to recover them from.
 *
 * ...AND SO IS ONE GIT CANNOT BE ASKED ABOUT, which is not the same refusal and
 * is the one that matters here. Membership and `within` establish WHICH
 * directory this is, never whether it holds work. An orphan's `.git` file points
 * at an admin entry that has gone, so `git status` inside it fails — and the
 * whole reason this function exists is to handle directories in that state.
 * Rename or move the repository and EVERY checkout under `<repo>/.worktrees/`
 * lands here at once, each with a `gitdir` pointing at the old path, each
 * possibly holding hours of an agent's uncommitted work.
 *
 * So the rule is: delete a populated tree only on git's word that it is clean,
 * and delete a husk (see isHusk) without asking, because there is nothing in it
 * to lose. There is deliberately no third case.
 */
export async function removeOrphan(
  root: string,
  path: string,
): Promise<{ removed: boolean; reason?: string }> {
  const orphans = await orphanedCheckouts(root)
  if (!orphans.includes(path)) {
    return { removed: false, reason: 'That directory is not an orphaned worktree any more.' }
  }
  if (!within(worktreeRoot(root), path) && !within(legacyWorktreeRoot(), path)) {
    return { removed: false, reason: 'Refusing to remove a path outside the worktree directories.' }
  }
  const dirty = await statusCount(path)
  if (dirty.ok && dirty.count > 0) {
    return {
      removed: false,
      reason: `Kept: ${dirty.count} uncommitted change${dirty.count === 1 ? '' : 's'} at ${path}`,
    }
  }
  if (!dirty.ok && !isHusk(path)) {
    return {
      removed: false,
      reason:
        `Kept: git cannot read ${path}, so there is no way to tell whether it holds ` +
        `uncommitted work. Re-register it with \`git worktree add\` and commit, or ` +
        `remove it yourself.`,
    }
  }
  try {
    rmSync(path, { recursive: true, force: true })
  } catch (err) {
    return { removed: false, reason: (err as Error).message }
  }
  // The directory going away can turn a registered entry into a prunable one —
  // an orphan by our definition is unregistered, but git's own view of a
  // half-removed worktree is not always the same one.
  await git(root, ['worktree', 'prune'])
  return { removed: true }
}

/**
 * Uncommitted changes in a worktree, AND whether git could answer at all.
 *
 * THE TWO ARE DIFFERENT FACTS and collapsing them is a data-loss bug. A count of
 * 0 from a failed `git status` reads as "clean, safe to delete" — and status
 * fails for exactly the directories that most need the question asked: an
 * unregistered checkout's `.git` file points at an admin entry that no longer
 * exists, so `git -C <path> status` exits non-zero every single time.
 */
async function statusCount(path: string): Promise<{ ok: boolean; count: number }> {
  const r = await git(path, ['status', '--porcelain', '--untracked-files=all'])
  if (!r.ok) return { ok: false, count: 0 }
  return { ok: true, count: r.stdout.split('\n').filter((l) => l.trim()).length }
}

/**
 * Nothing in this directory but its `.git` link — a `worktree add` that got as
 * far as writing the link and no further.
 *
 * The one shape that can be deleted without git's word on it, because there are
 * no files in it to lose. Anything else is a populated tree, and a populated
 * tree we cannot ask about is indistinguishable from hours of uncommitted work.
 */
function isHusk(path: string): boolean {
  try {
    return readdirSync(path).every((name) => name === '.git')
  } catch {
    // Unreadable is not empty. Refusing here costs a stale directory; the other
    // answer removes a tree we could not even list.
    return false
  }
}

/** Uncommitted changes in a REGISTERED worktree, where `git status` answering is
 *  a given. `removeWorktree` is the only caller — see statusCount for why an
 *  unregistered one must not use this. */
export async function uncommittedCount(path: string): Promise<number> {
  return (await statusCount(path)).count
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
