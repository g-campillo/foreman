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

/** Past this, a line diff is both useless to read and slow to produce — structuredPatch is O(ND).
 *
 *  Exported because gitdiff's badge has to refuse exactly the same files this
 *  does: a second copy of the ceiling would drift, and the badge would then count
 *  lines in a file the panel renders as 'too large to diff'. */
export const MAX_DIFF_BYTES = 1_000_000

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

// ------------------------------------------------------------ partial approval

/**
 * Approving only part of what the agent proposed.
 *
 * `canUseTool` returns ONE result for ONE tool call, so "accept these two edits
 * and not that one" is not expressible as allow-or-deny and no amount of UI
 * changes that. What is expressible is `updatedInput` on the allow arm — the
 * permission result may rewrite the tool's input before it runs — and these two
 * functions build that rewrite.
 *
 * THE RENDERER SENDS INDICES, NEVER CONTENT. These take a `keep` array of
 * integers and subset the host's OWN copy of the input, so a compromised or
 * simply buggy renderer cannot name bytes that reach disk. That collapses what
 * would be a nasty new trust boundary into a bounds check, and it gives the
 * property this codebase already relies on elsewhere:
 *
 *   A subset is always a subset. The UI can only remove edits from what the
 *   agent proposed; it can never add or alter one. The worst case of a bug here
 *   is that LESS lands than was ticked. Nothing the user did not see can ever
 *   be written.
 *
 * That is the same argument `setMcpPermissionOverride` makes for being safe to
 * expose directly — tighten-only, never widen — and it is safe here for the
 * same structural reason.
 *
 * Note what is absent: there is no `subsetEdit`. An Edit is one old_string and
 * one new_string; it is a single atom with nothing to subset. The UI must not
 * imply otherwise, which is the same refusal DiffLines already makes by
 * rendering an Edit's preview with numbers={false}.
 */

/**
 * A MultiEdit's input with the unticked edits removed.
 *
 * Returns null when nothing survives. An empty `edits` array is NOT a harmless
 * no-op — the tool errors on it — so the caller has to deny outright instead,
 * which is also what the user meant by unticking everything.
 */
export function subsetMultiEdit(input: unknown, keep: readonly number[]): unknown | null {
  const i = input as Record<string, unknown> | null
  const edits = Array.isArray(i?.edits) ? (i.edits as unknown[]) : null
  if (!i || !edits) return null

  // Bounds-check and de-duplicate. This is the entire validation surface,
  // because indices are the entire attack surface.
  const wanted = [...new Set(keep)].filter((n) => Number.isInteger(n) && n >= 0 && n < edits.length)
  if (!wanted.length) return null
  // Original order, not click order: the tool applies edits sequentially and a
  // reordered MultiEdit is a different edit.
  wanted.sort((a, b) => a - b)
  if (wanted.length === edits.length) return input // nothing dropped, send it back untouched

  return { ...i, edits: wanted.map((n) => edits[n]) }
}

/**
 * A Write's `content` rebuilt from only the accepted hunks.
 *
 * `before` must be read at DECISION time, from disk, in the host — not carried
 * in the request payload. A prompt can sit parked for a long time, and
 * recomposing against a snapshot taken when it was raised would silently revert
 * whatever the user did in the meantime.
 */
export function recomposeWrite(before: string, after: string, keep: readonly number[]): string {
  const hunks = toHunks(before, after, 'write')
  const kept = new Set(keep)
  const out: string[] = []
  const beforeLines = before.split('\n')
  let cursor = 0 // 0-based index into beforeLines

  hunks.forEach((h, n) => {
    // Everything between the last hunk and this one is untouched context.
    const start = h.oldStart - 1
    while (cursor < start && cursor < beforeLines.length) out.push(beforeLines[cursor++]!)

    for (const line of h.lines) {
      if (line.type === 'ctx') {
        out.push(line.text)
        cursor++
      } else if (line.type === 'add') {
        // An added line only survives if its hunk was accepted.
        if (kept.has(n)) out.push(line.text)
      } else {
        // A deleted line survives only if its hunk was REJECTED — rejecting a
        // deletion means keeping what was there.
        if (!kept.has(n)) out.push(line.text)
        cursor++
      }
    }
  })

  while (cursor < beforeLines.length) out.push(beforeLines[cursor++]!)
  return out.join('\n')
}
