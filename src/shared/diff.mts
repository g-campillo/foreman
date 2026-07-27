import { structuredPatch } from 'diff'
import type { DiffHunk, DiffLine, FileDiff } from './types'

/**
 * Shared by main's git panel and the renderer's inline tool-card diffs.
 *
 * Lives in shared/ rather than beside either caller because both genuinely need
 * it and a second copy of the marker walk below is exactly the kind of thing
 * that drifts silently — the line numbers it produces are what revert writes
 * against. `.mts` so the assert checks can load it under bare node.
 */

/** Past this, a line diff is both useless to read and slow to produce — structuredPatch is O(ND). */
const MAX_DIFF_BYTES = 1_000_000

/**
 * jsdiff's hunk lines carry their marker as the first character and no line
 * numbers, so this walks them to assign 1-based old/new numbers.
 */
export function toHunks(before: string, after: string, path: string): DiffHunk[] {
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

/**
 * Build one diff-panel row. Pure — no git, no fs — so every branch is checkable.
 *
 * Always returns a row, even when `before === after`. That is deliberate and
 * load-bearing: the badge counts what git calls dirty, and the panel renders
 * these, so a row per dirty path is what makes the two agree by construction.
 * A mode-only change (chmod +x) is exactly that case — genuinely dirty, no
 * content diff — and it should be visible and committable, not silently dropped.
 */
export function diffRow(
  path: string,
  relPath: string,
  before: string | null,
  after: string | null,
): FileDiff {
  const base = { path, relPath, before, after, added: 0, removed: 0, hunks: [] as DiffHunk[] }

  // A NUL byte means git would call this binary too; a line diff of it is noise.
  if (before?.includes('\0') || after?.includes('\0')) return { ...base, note: 'binary' }
  if ((before?.length ?? 0) > MAX_DIFF_BYTES || (after?.length ?? 0) > MAX_DIFF_BYTES)
    return { ...base, note: 'too large to diff' }

  const hunks = toHunks(before ?? '', after ?? '', path)
  let added = 0
  let removed = 0
  for (const h of hunks)
    for (const l of h.lines) {
      if (l.type === 'add') added++
      else if (l.type === 'del') removed++
    }
  return { ...base, added, removed, hunks }
}
