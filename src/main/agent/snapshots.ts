import { ipcMain } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises'
import { dirname, relative, isAbsolute, resolve as resolvePath } from 'node:path'
import { structuredPatch } from 'diff'
import type { HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk'
import { IPC, type DiffHunk, type DiffLine, type FileDiff } from '../../shared/types'
import { send } from '../bridge'
import { parsePorcelainZ } from './porcelain.mts'

const exec = promisify(execFile)

/** sessionId -> absolute path -> content before the agent first touched it (null = did not exist). */
const store = new Map<string, Map<string, string | null>>()

const WRITE_TOOLS = 'Edit|Write|MultiEdit|NotebookEdit'

function bucket(sessionId: string): Map<string, string | null> {
  let m = store.get(sessionId)
  if (!m) store.set(sessionId, (m = new Map()))
  return m
}

function targetPath(toolInput: unknown, cwd: string): string | null {
  if (!toolInput || typeof toolInput !== 'object') return null
  const rec = toolInput as Record<string, unknown>
  const raw = rec.file_path ?? rec.notebook_path
  if (typeof raw !== 'string' || raw.length === 0) return null
  return isAbsolute(raw) ? raw : resolvePath(cwd, raw)
}

/**
 * Snapshot a file's contents before the agent's first write to it.
 *
 * This is a PreToolUse hook rather than part of canUseTool on purpose: hooks run
 * ahead of every other permission step, so diffs are still captured in
 * acceptEdits / bypassPermissions mode where canUseTool is never called.
 */
export function makeSnapshotHook(sessionId: string, cwd: string): HookCallbackMatcher[] {
  return [
    {
      matcher: WRITE_TOOLS,
      hooks: [
        async (input) => {
          if (input.hook_event_name !== 'PreToolUse') return { continue: true }
          const path = targetPath(input.tool_input, cwd)
          if (!path) return { continue: true }

          const snaps = bucket(sessionId)
          if (!snaps.has(path)) {
            const before = await readFile(path, 'utf8').catch(() => null)
            snaps.set(path, before)
            send(IPC.evtDiffChanged, { sessionId, count: snaps.size })
          }
          return { continue: true }
        },
      ],
    },
  ]
}

// ----------------------------------------------------------- bash-driven edits
//
// The hook above only fires for the edit tools, so a file changed by `sed`, `mv`
// or a codegen step produced no diff at all. Git supplies what the SDK can't: the
// content the file had before anything touched it.
//
// (The SDK does have a 'FileChanged' hook event, but reaching it means returning
// watchPaths from SessionStart and then watching the whole tree — which floods on
// any npm install. It is the upgrade path only if non-Bash writers ever matter.)

interface GitBaseline {
  /** Repo root, or null when the session cwd isn't in a git repo. */
  root: string | null
  /** Paths already dirty before the agent started — the user's own work. */
  dirty: Set<string>
}

const baselines = new Map<string, Promise<GitBaseline>>()

async function git(root: string, args: string[]): Promise<string | null> {
  try {
    // Files can be large; the 1MB default truncates and throws.
    const { stdout } = await exec('git', ['-C', root, ...args], { maxBuffer: 64 * 1024 * 1024 })
    return stdout
  } catch {
    return null
  }
}

/** Absolute path -> git status code, for everything dirty in the worktree. */
async function dirtyPaths(root: string): Promise<Map<string, string>> {
  const out = await git(root, ['status', '--porcelain', '-z', '--untracked-files=all'])
  return out === null ? new Map() : parsePorcelainZ(out, root)
}

async function readGitState(cwd: string): Promise<GitBaseline> {
  const top = await git(cwd, ['rev-parse', '--show-toplevel'])
  const root = top?.trim() || null
  if (!root) return { root: null, dirty: new Set() }
  return { root, dirty: new Set((await dirtyPaths(root)).keys()) }
}

/** Record what was already dirty, before the agent gets a chance to change it. */
export function beginSession(sessionId: string, cwd: string): void {
  baselines.set(sessionId, readGitState(cwd))
}

/** Content at HEAD, or null when the file did not exist there (or there is no HEAD). */
async function contentAtHead(root: string, path: string): Promise<string | null> {
  return await git(root, ['show', `HEAD:${relative(root, path)}`])
}

/**
 * Adopt anything Bash dirtied that isn't already tracked, using HEAD as the
 * before-content. Runs after every Bash call.
 */
async function adoptBashChanges(sessionId: string): Promise<void> {
  const base = await baselines.get(sessionId)
  if (!base?.root) return // not a git repo — no baseline to diff against

  const snaps = bucket(sessionId)
  const before = snaps.size

  for (const [path] of await dirtyPaths(base.root)) {
    if (snaps.has(path)) continue // already captured, by an edit tool or an earlier Bash
    if (base.dirty.has(path)) continue // the user's own uncommitted work, not the agent's
    const head = await contentAtHead(base.root, path)
    if (head?.includes('\0')) continue // binary: a line diff of it is pure noise
    snaps.set(path, head)
  }

  if (snaps.size !== before) send(IPC.evtDiffChanged, { sessionId, count: snaps.size })
}

export function makeBashDiffHook(sessionId: string): HookCallbackMatcher[] {
  return [
    {
      // Substring match, so this also covers BashOutput — a background shell can
      // change files too.
      matcher: 'Bash',
      hooks: [
        async (input) => {
          if (input.hook_event_name !== 'PostToolUse') return { continue: true }
          // ponytail: one `git status` per Bash call. Fine on normal repos; if a
          // monorepo makes it drag, cache on the tool's own mtime window.
          await adoptBashChanges(sessionId).catch(() => undefined)
          return { continue: true }
        },
      ],
    },
  ]
}

// -----------------------------------------------------------------------------

function toHunks(before: string, after: string, path: string): DiffHunk[] {
  const patch = structuredPatch(path, path, before, after, '', '', { context: 3 })
  return patch.hunks.map((h) => {
    let oldNo = h.oldStart
    let newNo = h.newStart
    const lines: DiffLine[] = []
    for (const raw of h.lines) {
      const marker = raw[0]
      const text = raw.slice(1)
      if (marker === '+') lines.push({ type: 'add', text, oldNo: null, newNo: newNo++ })
      else if (marker === '-') lines.push({ type: 'del', text, oldNo: oldNo++, newNo: null })
      else if (marker === '\\') continue // "\ No newline at end of file"
      else lines.push({ type: 'ctx', text, oldNo: oldNo++, newNo: newNo++ })
    }
    return { oldStart: h.oldStart, newStart: h.newStart, lines }
  })
}

export async function computeDiffs(sessionId: string, cwd: string): Promise<FileDiff[]> {
  const snaps = store.get(sessionId)
  if (!snaps) return []

  const out: FileDiff[] = []
  for (const [path, before] of snaps) {
    const after = await readFile(path, 'utf8').catch(() => null)
    if (before === after) continue // reverted by hand, or a no-op write

    const hunks = toHunks(before ?? '', after ?? '', path)
    let added = 0
    let removed = 0
    for (const h of hunks)
      for (const l of h.lines) {
        if (l.type === 'add') added++
        else if (l.type === 'del') removed++
      }

    out.push({ path, relPath: relative(cwd, path) || path, before, after, added, removed, hunks })
  }
  out.sort((a, b) => a.relPath.localeCompare(b.relPath))
  return out
}

export async function revertFile(sessionId: string, path: string): Promise<void> {
  const snaps = store.get(sessionId)
  if (!snaps || !snaps.has(path)) return
  const before = snaps.get(path)!

  if (before === null) await unlink(path).catch(() => {})
  else {
    await mkdir(dirname(path), { recursive: true }).catch(() => {})
    await writeFile(path, before, 'utf8')
  }
  snaps.delete(path)
  send(IPC.evtDiffChanged, { sessionId, count: snaps.size })
}

export function clearSnapshots(sessionId: string): void {
  store.delete(sessionId)
  baselines.delete(sessionId)
  send(IPC.evtDiffChanged, { sessionId, count: 0 })
}

export function registerDiffIpc(): void {
  ipcMain.handle(IPC.diffList, (_e, { sessionId, cwd }: { sessionId: string; cwd: string }) =>
    computeDiffs(sessionId, cwd),
  )
  ipcMain.handle(IPC.diffRevert, (_e, { sessionId, path }: { sessionId: string; path: string }) =>
    revertFile(sessionId, path),
  )
  ipcMain.handle(IPC.diffClear, (_e, { sessionId }: { sessionId: string }) =>
    clearSnapshots(sessionId),
  )
}

// ponytail: a file that was ALREADY dirty when the session started is never
// adopted, even if the agent then edits it — attributing the user's own
// uncommitted work to the agent, and offering to revert it, is the worse
// failure. Per-file content baselines would fix it if it ever matters.
