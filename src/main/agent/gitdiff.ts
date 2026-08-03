import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, stat, unlink } from 'node:fs/promises'
import { relative } from 'node:path'
import type { HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk'
import { IPC, type DiffStats, type FileDiff } from '../../shared/types'
import { send } from '../../shared/sink'
import { parsePorcelainZ } from './porcelain.mts'
import { countLines, parseNumstat } from './numstat.mts'
import { diffRow, MAX_DIFF_BYTES } from '../../shared/diff.mts'
import { within } from './policy.mts'

const exec = promisify(execFile)

/**
 * The panel reads git, and only git.
 *
 * It used to be driven by an in-memory Map of before-contents captured by a
 * PreToolUse hook and keyed by a per-Session uuid. That map was wrong in three
 * directions at once: it was empty after a restart (so a dirty tree showed
 * nothing), it deliberately blacklisted everything already dirty at session
 * start (so the user's own work never appeared), and it compared its snapshot
 * against disk rather than HEAD (so a file stayed in the panel forever once
 * committed from anywhere but the panel's own button).
 *
 * `git status` answers all three, and it survives restarts because it lives in
 * .git. The snapshots are gone rather than kept as a fallback, because keeping
 * them would make Revert lie: a row rendered from HEAD but reverted to a
 * mid-session snapshot leaves a file that still differs from HEAD.
 */

async function git(root: string, args: string[]): Promise<string | null> {
  try {
    // Files can be large; the 1MB default truncates and throws.
    const { stdout } = await exec('git', ['-C', root, ...args], { maxBuffer: 64 * 1024 * 1024 })
    return stdout
  } catch {
    return null
  }
}

/**
 * Same call, but keeping git's own error text.
 *
 * `git()` above swallows failures because its callers genuinely don't care why
 * (no HEAD yet, not a repo, file absent). Anything the user *asked* for has to
 * report why it didn't happen instead — "commit failed" with no reason is the
 * worst possible outcome for the one operation here that writes history.
 */
async function gitTry(
  root: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string; error: string }> {
  try {
    const { stdout } = await exec('git', ['-C', root, ...args], { maxBuffer: 64 * 1024 * 1024 })
    return { ok: true, stdout, error: '' }
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message?: string }
    return {
      ok: false,
      stdout: e.stdout ?? '',
      // git puts the useful line on stderr; message is the bare exit code.
      error: (e.stderr || e.message || 'git failed').trim(),
    }
  }
}

interface GitStatus {
  root: string
  /** null on a detached HEAD — the UI falls back to the worktree's branch. */
  branch: string | null
  /** Absolute path -> two-character porcelain code. */
  dirty: Map<string, string>
}

/**
 * One live read of git's opinion. null when the cwd isn't a repo.
 *
 * Three separate calls rather than folding the first two into
 * `rev-parse --show-toplevel --abbrev-ref HEAD`: that form exits 128 on a repo
 * with no commits yet, and `git()` swallows non-zero, so a fresh repo would
 * lose its root as well as its branch. `branch --show-current` prints nothing
 * on a detached HEAD instead of failing.
 */
export async function readStatus(cwd: string): Promise<GitStatus | null> {
  const top = await git(cwd, ['rev-parse', '--show-toplevel'])
  const root = top?.trim()
  if (!root) return null

  const [head, status] = await Promise.all([
    git(root, ['branch', '--show-current']),
    git(root, ['status', '--porcelain', '-z', '--untracked-files=all']),
  ])

  return {
    root,
    branch: head?.trim() || null,
    dirty: status === null ? new Map() : parsePorcelainZ(status, root),
  }
}

/** Content at HEAD, or null when the file did not exist there (or there is no HEAD). */
async function contentAtHead(root: string, path: string): Promise<string | null> {
  return await git(root, ['show', `HEAD:${relative(root, path)}`])
}

/**
 * What to diff the working tree against: 'HEAD', or the empty tree.
 *
 * A repo with no commits has no HEAD, and `git diff HEAD` there is a hard
 * `fatal: ambiguous argument 'HEAD'` — so the badge would silently read 0 on
 * exactly the tree where everything is new.
 *
 * The empty tree is COMPUTED, not the famous 4b825dc6… literal: that hash is
 * SHA-1's, and a repo created with `--object-format=sha256` has a different one.
 * `/dev/null` rather than the documented `--stdin`, and this is not cosmetic —
 * promisify(execFile) never closes the child's stdin, so `--stdin` hangs forever
 * on a code path that runs after every agent tool call. If this ever has to run
 * on Windows the answer is `spawn` plus an explicit `stdin.end()`, NOT the
 * literal 4b825dc6… — that would silently give the wrong base on a SHA-256 repo,
 * which is the failure this function exists to avoid. (The build ships mac only.)
 */
async function diffBase(root: string): Promise<string> {
  const head = await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD'])
  if (head?.trim()) return 'HEAD'
  const empty = await git(root, ['hash-object', '-t', 'tree', '/dev/null'])
  // Falling back to HEAD is the safe failure: readStats treats a failed diff as
  // zero, which is what an unreadable repo should report anyway.
  return empty?.trim() || 'HEAD'
}

/**
 * Cap on the untracked files whose lines are counted.
 *
 * This runs on the agent's hot path — every Edit, Write and Bash — and a
 * `node_modules` that escaped .gitignore is thousands of reads. Past the cap the
 * badge undercounts, which is far better than a stalled turn.
 */
const MAX_UNTRACKED_SCAN = 400

/**
 * Line totals for a status already in hand.
 *
 * Two sources, because neither one can answer alone. `git diff --numstat` covers
 * everything git tracks, in one process and without reading a single file in
 * this one — but it cannot see untracked files, and `git add -N` to fold them in
 * is not available: it mutates the index, which would break commitFiles'
 * "exactly the files you ticked" contract. So new files are counted by reading
 * them, under the same ceilings the panel applies.
 *
 * `--no-renames` is load-bearing twice: it keeps a numstat record to three
 * fields, and it makes a rename count as a full delete plus a full add — which
 * is what parsePorcelainZ's two `R` entries and diffRow's two rows already
 * produce, so the badge and the panel agree about renames too.
 *
 * `files` is `st.dirty.size` rather than numstat's record count, because that is
 * what the panel renders one row per.
 */
async function readStats(st: GitStatus): Promise<DiffStats> {
  const base = await diffBase(st.root)
  const out = await git(st.root, ['diff', '--numstat', '--no-renames', '-z', base])
  const totals = out === null ? { added: 0, removed: 0 } : parseNumstat(out)

  let added = totals.added
  let scanned = 0
  for (const [path, code] of st.dirty) {
    if (!code.startsWith('??')) continue
    if (++scanned > MAX_UNTRACKED_SCAN) break
    // Same three refusals diffRow makes, so a file the panel declines to diff
    // cannot contribute lines the panel never shows: not a regular file, over
    // the ceiling, or binary by git's own NUL-byte heuristic.
    const info = await stat(path).catch(() => null)
    if (!info?.isFile() || info.size > MAX_DIFF_BYTES) continue
    const text = await readFile(path, 'utf8').catch(() => null)
    if (text === null || text.includes('\0')) continue
    added += countLines(text)
  }

  return { files: st.dirty.size, added, removed: totals.removed }
}

/**
 * The ONE emitter for evtDiffChanged, taking a status the caller already read.
 *
 * Single, so what the badge says and what the panel just received can never
 * disagree — computeDiffs routes both of its emits through here rather than
 * building the payload twice. `null` is "not a repository", which is a clean
 * badge and no branch.
 */
export async function sendStats(sessionId: string, st: GitStatus | null): Promise<void> {
  const stats = st ? await readStats(st) : { files: 0, added: 0, removed: 0 }
  send(IPC.evtDiffChanged, { sessionId, ...stats, branch: st?.branch ?? null })
}

/**
 * Every uncommitted change, straight from git.
 *
 * Emits the badge count as a side effect, so what the badge says and what the
 * panel just received can never disagree.
 *
 * ponytail: one `git show` per dirty file, sequential. Fine at tens of files;
 * batch through `git cat-file --batch` if a formatter-sized working set drags.
 */
export async function computeDiffs(sessionId: string, cwd: string): Promise<FileDiff[]> {
  const st = await readStatus(cwd)
  if (!st) {
    await sendStats(sessionId, null)
    return []
  }

  const out: FileDiff[] = []
  for (const [path, code] of st.dirty) {
    // Porcelain paths are root-resolved by construction, so this is belt and
    // braces — but it is the guard that keeps plan mode's writes to
    // ~/.claude/plans/*.md out of a panel that could never stage them.
    if (!within(st.root, path)) continue

    const before = code.startsWith('??') ? null : await contentAtHead(st.root, path)
    const after = await readFile(path, 'utf8').catch(() => null)
    out.push(diffRow(path, relative(cwd, path) || path, before, after))
  }

  out.sort((a, b) => a.relPath.localeCompare(b.relPath))
  // The status this already holds, rather than a second readStatus: the panel
  // and the badge are then reporting the same instant of the tree.
  await sendStats(sessionId, st)
  return out
}

/**
 * Badge-only refresh: four git calls plus the untracked walk, no diffing.
 *
 * The four are readStatus's `rev-parse --show-toplevel` and `status`, then
 * diffBase's `rev-parse --verify HEAD` and the `diff --numstat` itself. Still
 * cheap enough for the PostToolUse hook, because none of them reads a tracked
 * file — which is the cost `computeDiffs` pays and this deliberately does not.
 *
 * `files` is equal to `computeDiffs().length` by construction, because diffRow
 * emits a row per dirty path unconditionally.
 */
export async function emitStats(sessionId: string, cwd: string): Promise<void> {
  await sendStats(sessionId, await readStatus(cwd))
}

/**
 * Nudge the badge after anything that could have touched the tree.
 *
 * PostToolUse rather than PreToolUse: we want the state *after* the write, and
 * there is nothing to capture beforehand any more. Bash is in the matcher (by
 * substring, so BashOutput counts too) because that is what makes an agent-run
 * `git commit` clear the badge mid-turn.
 */
export function makeDiffHook(sessionId: string, cwd: string): HookCallbackMatcher[] {
  return [
    {
      matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash',
      hooks: [
        async (input) => {
          if (input.hook_event_name !== 'PostToolUse') return { continue: true }
          await emitStats(sessionId, cwd).catch(() => undefined)
          return { continue: true }
        },
      ],
    },
  ]
}

/**
 * Discard a file's uncommitted changes.
 *
 * This is a trust boundary in a way the old version wasn't: `path` arrives over
 * IPC and this function deletes files, where before it could only touch keys it
 * had captured itself. Hence the containment check against the repo root.
 *
 * `git checkout` rather than writing bytes by hand — it covers modified, staged
 * and deleted in one branch, and it can't corrupt a binary the way the old utf8
 * round-trip could.
 */
export async function revertFile(
  sessionId: string,
  cwd: string,
  path: string,
): Promise<{ ok: boolean; error?: string }> {
  const st = await readStatus(cwd)
  if (!st) return { ok: false, error: 'Not a git repository.' }
  if (!within(st.root, path)) return { ok: false, error: 'Outside the repository.' }

  if ((await contentAtHead(st.root, path)) === null) {
    // Absent at HEAD: new, untracked, or there is no HEAD at all. The `git rm`
    // is what stops a `git add`-ed new file coming straight back as ' D';
    // --ignore-unmatch makes it a no-op for a plain untracked file.
    await unlink(path).catch(() => undefined)
    await git(st.root, ['rm', '-f', '--cached', '--ignore-unmatch', '--', path])
  } else {
    const done = await gitTry(st.root, ['checkout', 'HEAD', '--', path])
    if (!done.ok) return { ok: false, error: done.error }
  }

  await emitStats(sessionId, cwd)
  return { ok: true }
}

/**
 * Commit exactly the selected files.
 *
 * `add` then `commit -- <paths>` rather than `commit -a`: the pathspec keeps the
 * commit to what the user ticked, so anything else they had staged by hand — or
 * that another session in this same worktree is mid-edit on — is left alone. The
 * `add` is required because a file the agent created is untracked, and `commit`
 * refuses a pathspec that matches nothing in the index.
 */
export async function commitFiles(
  sessionId: string,
  cwd: string,
  paths: string[],
  message: string,
): Promise<{ ok: boolean; error?: string; sha?: string; committed: number }> {
  if (paths.length === 0) return { ok: false, error: 'Nothing selected.', committed: 0 }
  if (!message.trim()) return { ok: false, error: 'A commit message is required.', committed: 0 }

  const top = await git(cwd, ['rev-parse', '--show-toplevel'])
  const root = top?.trim()
  if (!root) return { ok: false, error: 'Not a git repository.', committed: 0 }

  const staged = await gitTry(root, ['add', '--', ...paths])
  if (!staged.ok) return { ok: false, error: staged.error, committed: 0 }

  // `--` before the paths, and `-m` taking the message as its own argv entry, so
  // a message starting with a dash or a path containing one is never read as a flag.
  const done = await gitTry(root, ['commit', '-m', message, '--', ...paths])
  if (!done.ok) return { ok: false, error: done.error, committed: 0 }

  // Nothing to forget — the committed files simply stop being dirty.
  await emitStats(sessionId, cwd)

  const sha = (await git(root, ['rev-parse', '--short', 'HEAD']))?.trim()
  return { ok: true, sha, committed: paths.length }
}
