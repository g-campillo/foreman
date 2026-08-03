import { ipcMain } from 'electron'
import { readFile, writeFile, stat, realpath, readdir } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { dirname, basename, join, relative, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { IPC, type FileRead, type FileWrite, type FileList } from '../shared/types'
import { within } from './agent/policy.mts'
import { reportServers } from '../lsp/detect.mts'
import { emitStats, readStatus } from './agent/gitdiff'

const exec = promisify(execFile)

/**
 * Files for the editor, read and written with node:fs in main.
 *
 * Deliberately NOT `q.readFile` from the SDK, even though it exists and is
 * permission-aware. Its own declaration says it is "for the remote sidebar
 * viewer" and that it "returns null on permission denial, missing file, or
 * transport error" — three outcomes, one value. An editor that cannot tell
 * denied from missing shows an empty buffer for a file it was not allowed to
 * read, and then ⌘S truncates it. That single failure mode disqualifies it.
 * It also has no write counterpart, caps at 1MB, and needs a live host — so a
 * session whose host has idled out would lose its editor.
 *
 * The asymmetry is the point, and it is not a shortcut: agent reads are policed
 * because the agent is autonomous; human reads are policed by the OS, because
 * the human already has a Finder. `computeDiffs` reads with node:fs for the
 * same reason, and gitdiff.ts's own comment makes the argument.
 *
 * Session-free, taking cwd from the renderer — the posture diffList, diffRevert
 * and ptyStart already have. `diffRevert` accepts a renderer-supplied cwd and
 * *deletes files*, so tightening only this module would be inconsistent without
 * being meaningfully safer.
 */

/** Refuse to open anything bigger. Monaco degrades badly past ~10MB anyway. */
const MAX_EDIT_BYTES = 4 * 1024 * 1024

/** Cap on files offered to @-mention autocomplete. The popover is a shortlist. */
export const FILE_LIMIT = 4000

/** Cap on files offered to the tree. Higher, because a tree implies completeness. */
export const TREE_LIMIT = 20000

/**
 * Directories the non-git walk never descends into.
 *
 * NOT a .gitignore reimplementation — that is exactly what `listProjectFiles`
 * exists to avoid. This is a fixed deny-list standing in for the one thing
 * `--exclude-standard` was buying us, and it only has to cover the directories
 * whose sheer size would make an unfiltered walk useless: build output and
 * vendored dependencies. Anything else showing up in a non-git project is a
 * file the user actually has.
 */
const SKIP_DIRS = new Set([
  '.git',
  // Foreman's own worktree checkouts, each a full copy of this repository — so
  // an unfiltered walk would list every file in the project once per live agent.
  // NOT redundant with the `info/exclude` entry ensureExcluded writes: that one
  // covers the `git ls-files --exclude-standard` path, and this walk is the
  // fallback for a directory git knows nothing about. Neither covers the other.
  '.worktrees',
  'node_modules',
  'target', // maven, cargo
  'build', // gradle, cmake
  'dist',
  'out',
  '.gradle',
  '.idea',
  '.venv',
  'venv',
  '__pycache__',
  'vendor',
  '.next',
  '.cache',
  'Pods',
])

/**
 * Every file under `root`, root-relative, pruned and capped.
 *
 * Iterative rather than recursive so the cap stops the whole walk instead of
 * just the current branch — on a directory that is not a project at all (a home
 * folder picked by mistake) that is the difference between a pause and a hang.
 *
 * Symlinks are skipped outright, and for once the default does the right thing:
 * `Dirent` reports a symlink as neither `isFile()` nor `isDirectory()`, so
 * following them would have to be opt-in. Not following them means no cycle
 * detection, which is worth more than the rare symlinked source dir.
 */
async function walkFiles(root: string, limit: number): Promise<FileList> {
  const paths: string[] = []
  const stack = ['']

  while (stack.length) {
    const rel = stack.pop()!
    let entries: Dirent[]
    try {
      entries = await readdir(join(root, rel), { withFileTypes: true })
    } catch {
      // One unreadable directory must not cost us the rest of the tree.
      continue
    }
    for (const e of entries) {
      // POSIX separators, because buildTree splits on '/' and this runs on mac.
      const path = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(path)
      } else if (e.isFile()) {
        paths.push(path)
        // Stop one PAST the cap, so `truncated` can tell "landed exactly on the
        // limit" from "there was more" without a second count.
        if (paths.length > limit) return { paths: paths.slice(0, limit), truncated: true }
      }
    }
  }
  return { paths, truncated: false }
}

/**
 * Resolve a renderer-supplied path and prove it is inside the project.
 *
 * realpath FIRST, then `within` — the order is the whole guard. A symlink at
 * `<repo>/link` pointing at /etc/passwd is inside the repo by string comparison
 * and outside it in every sense that matters. gitdiff has the same latent gap
 * but its paths come from git porcelain, so it is not reachable there; here the
 * path comes from the renderer.
 *
 * A missing leaf is not a failure: saving may create the file. Resolve the
 * parent instead, which has to exist for the write to succeed anyway.
 */
async function resolveWithin(cwd: string, path: string): Promise<string | null> {
  let real: string
  try {
    real = await realpath(path)
  } catch {
    try {
      real = join(await realpath(dirname(path)), basename(path))
    } catch {
      return null
    }
  }
  const root = await realpath(cwd).catch(() => cwd)
  return within(root, real) ? real : null
}

const OUTSIDE = { ok: false, reason: 'outside', error: 'Outside the project.' } as const

export async function readFileFor(cwd: string, path: string): Promise<FileRead> {
  const real = await resolveWithin(cwd, path)
  if (!real) return OUTSIDE

  let buf: Buffer
  let mtimeMs: number
  try {
    const st = await stat(real)
    if (!st.isFile()) return { ok: false, reason: 'missing', error: 'Not a file.' }
    if (st.size > MAX_EDIT_BYTES) {
      return { ok: false, reason: 'too-large', error: `${(st.size / 1048576).toFixed(1)}MB` }
    }
    mtimeMs = st.mtimeMs
    buf = await readFile(real)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return code === 'ENOENT'
      ? { ok: false, reason: 'missing', error: 'No such file.' }
      : { ok: false, reason: 'io', error: String(err) }
  }

  // A NUL byte in the first 8KB. git's own heuristic, and shared/diff.mts uses
  // exactly it — so "binary" means the same thing in the editor and the diff.
  if (buf.subarray(0, 8192).includes(0)) {
    return { ok: false, reason: 'binary', error: 'Binary file.' }
  }

  const raw = buf.toString('utf8')
  // toString('utf8') never fails: it substitutes U+FFFD and moves on. Saving
  // that back writes the replacement characters over the user's bytes, so the
  // round-trip is the only way to find out before we have destroyed anything.
  if (!Buffer.from(raw, 'utf8').equals(buf)) {
    return { ok: false, reason: 'binary', error: 'Not valid UTF-8.' }
  }

  const bom = raw.charCodeAt(0) === 0xfeff
  const text = bom ? raw.slice(1) : raw
  // Reported rather than normalised. The renderer sets the model's EOL from it,
  // so getValue() gives CRLF back and the write path stays dumb. Skip this and
  // saving one line of a CRLF file rewrites every line, and the diff panel
  // lights up entirely for a one-word change.
  const eol = text.includes('\r\n') ? 'crlf' : 'lf'

  return { ok: true, text, mtimeMs, size: buf.length, bom, eol }
}

export async function writeFileFor(
  sessionId: string,
  cwd: string,
  path: string,
  text: string,
  bom: boolean,
  expectMtimeMs?: number,
): Promise<FileWrite> {
  const real = await resolveWithin(cwd, path)
  if (!real) return OUTSIDE

  // The backstop that makes correctness independent of every change-detection
  // trigger firing. Even if the focus sweep, the diff-hook bump and the reveal
  // sweep all miss, a write onto bytes we have not seen is refused rather than
  // silently clobbering the agent's work.
  //
  // A missing file is NOT stale — recreating something the agent deleted is a
  // legitimate save. Only a moved mtime is a conflict.
  if (expectMtimeMs !== undefined) {
    const st = await stat(real).catch(() => null)
    if (st && st.mtimeMs !== expectMtimeMs) {
      return { ok: false, reason: 'stale', error: 'Changed on disk.', mtimeMs: st.mtimeMs }
    }
  }

  try {
    // Not atomic, and deliberately so: temp-file-and-rename loses xattrs, breaks
    // hard links and fires watchers twice, and the file is in git — which is the
    // actual safety net. The SDK's own Write tool is not atomic either.
    await writeFile(real, bom ? `﻿${text}` : text, 'utf8')
    const st = await stat(real)
    // Human edits move the ⌘1 badge exactly as agent edits do. Without this the
    // badge silently disagrees with the tree until the next agent turn.
    void emitStats(sessionId, cwd)
    return { ok: true, mtimeMs: st.mtimeMs }
  } catch (err) {
    return { ok: false, reason: 'io', error: String(err) }
  }
}

/**
 * mtimes for the open set, in one call and with no content transfer.
 *
 * null means gone. With ten-odd open files this is free, which is what lets
 * reconciliation be a sweep on focus rather than a filesystem watcher — and
 * this repo already learned what watching a tree does during `npm install`.
 */
export async function statFiles(
  cwd: string,
  paths: string[],
): Promise<Record<string, number | null>> {
  const out: Record<string, number | null> = {}
  await Promise.all(
    paths.map(async (p) => {
      const real = await resolveWithin(cwd, p)
      out[p] = real ? await stat(real).then((s) => s.mtimeMs).catch(() => null) : null
    }),
  )
  return out
}

/**
 * Repo-relative paths, for @-mention autocomplete and for the tree.
 *
 * Moved here from manager.ts and given a cap, because the two callers want
 * different ones: a truncated popover is invisible and fine, a truncated tree
 * looks like the repo is missing files and must say so.
 *
 * `git ls-files` because it gets .gitignore filtering for free — walking the
 * tree by hand means reimplementing ignore rules, and the first thing an
 * unfiltered walk finds is node_modules. `--others --exclude-standard` adds
 * untracked-but-not-ignored files, so something the agent just created shows up
 * without a commit.
 */
export async function listProjectFiles(cwd: string, limit: number): Promise<FileList> {
  try {
    const { stdout } = await exec(
      'git',
      ['-C', cwd, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { maxBuffer: 32 * 1024 * 1024 },
    )
    const files = stdout.split('\0').filter(Boolean)
    return { paths: files.slice(0, limit), truncated: files.length > limit }
  } catch (err) {
    // Not a git repo, git missing from PATH, or a `safe.directory` refusal —
    // all three land here, and the failure used to be both silent and severe.
    //
    // This once fell back to a single-level readdir filtered by `isFile()`,
    // which discarded every directory. buildTree derives folders by splitting
    // paths on '/', so bare filenames produce NO folders at all: a Maven
    // project rendered as `pom.xml`, `README.md`, `HELP.md`, `mvnw`,
    // `mvnw.cmd` and nothing else, which reads as a broken language filter
    // rather than as git having failed.
    //
    // Walking is fine here; what the old comment was really rejecting was an
    // *un-ignored* walk. SKIP_DIRS plus the caller's cap covers that.
    console.warn('[files] git ls-files failed for', cwd, '- walking instead:', err)
    return walkFiles(cwd, limit)
  }
}

/** Entries offered for one directory. The popover shows ~50; this is headroom. */
const BROWSE_LIMIT = 300

/**
 * Complete an absolute or `~`-rooted path, one directory at a time.
 *
 * A second source alongside `listProjectFiles` rather than a loosening of it,
 * because the two are genuinely different shapes. Inside a project you want
 * every path at once and a fuzzy match over the lot — `git ls-files` gives you
 * that for the price of one call. Outside one there is no project to enumerate
 * and no ignore file to respect, so this completes a segment at a time against a
 * real directory, the way a shell does.
 *
 * `~` is expanded HERE because the renderer cannot: its preload surface is IPC
 * only, so it has no `os.homedir()`. derive.mts's `relPath` says the same thing
 * from the other side, and this is the IPC call it declined to add for display
 * purposes — worth it now that completion needs it.
 *
 * No `within` guard, and that is deliberate rather than overlooked. This lists
 * directories for a human who already has a Finder, which is the argument this
 * file's own header makes about editor reads. It grants the AGENT nothing: the
 * result is text in a prompt, and the agent's own Read still goes through
 * canUseTool. `resolveWithin` still guards every actual file I/O below.
 */
export async function browsePath(query: string): Promise<string[]> {
  const abs = query.startsWith('~') ? join(homedir(), query.slice(1)) : query
  if (!isAbsolute(abs)) return []

  // A trailing slash means "list this directory"; anything else means "complete
  // this last segment" — which is what the caret sitting after it implies, and
  // what every shell does.
  const listing = abs.endsWith('/')
  const dir = listing ? abs : dirname(abs)
  const prefix = listing ? '' : basename(abs).toLowerCase()

  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    // Half-typed directory names are the normal case here, not an error.
    return []
  }

  const out: string[] = []
  for (const e of entries) {
    if (!e.name.toLowerCase().startsWith(prefix)) continue
    // Hide dotfiles until they are actually being asked for, as a shell does.
    if (!prefix.startsWith('.') && e.name.startsWith('.')) continue
    const full = join(dir, e.name)
    // The trailing slash is the drill-down affordance: Composer keeps the
    // mention open when a value ends in one, so the next segment can be typed.
    if (e.isDirectory()) out.push(`${full}/`)
    else if (e.isFile()) out.push(full)
  }
  // Sort before the cap, or the cap would hand back an arbitrary subset in
  // readdir's filesystem order.
  return out.sort().slice(0, BROWSE_LIMIT)
}

export function registerFileIpc(): void {
  // Language-server availability. In main rather than the host because it is
  // pure detection against a directory — no session state — so Settings can
  // answer it before any agent exists and for a session whose host has idled
  // out. Asks the same resolveServer the runtime uses, so the list can never
  // claim a server is ready that then fails to start.
  ipcMain.handle(IPC.lspServers, (_e, { cwd }: { cwd: string }) => reportServers(cwd))

  ipcMain.handle(IPC.fileRead, (_e, { cwd, path }: { cwd: string; path: string }) =>
    readFileFor(cwd, path),
  )

  ipcMain.handle(
    IPC.fileWrite,
    (
      _e,
      {
        sessionId,
        cwd,
        path,
        text,
        bom,
        expectMtimeMs,
      }: {
        sessionId: string
        cwd: string
        path: string
        text: string
        bom: boolean
        expectMtimeMs?: number
      },
    ) => writeFileFor(sessionId, cwd, path, text, bom, expectMtimeMs),
  )

  ipcMain.handle(IPC.fileStat, (_e, { cwd, paths }: { cwd: string; paths: string[] }) =>
    statFiles(cwd, paths),
  )

  ipcMain.handle(IPC.fileBrowse, (_e, { query }: { query: string }) => browsePath(query))

  // One round-trip for both halves. `git status` next to the `git ls-files` we
  // are already making is close to free, and it is what lets the tree show what
  // changed rather than just what exists.
  ipcMain.handle(IPC.fileTree, async (_e, { cwd }: { cwd: string }) => {
    const [list, st] = await Promise.all([listProjectFiles(cwd, TREE_LIMIT), readStatus(cwd)])
    if (!st) return list
    const dirty: Record<string, string> = {}
    // Keyed repo-relative to match `git ls-files` output, which is what the tree
    // is built from — an absolute key would simply never match a node.
    for (const [abs, code] of st.dirty) dirty[relative(st.root, abs)] = code
    return { ...list, dirty }
  })
}
