/**
 * Parse `git diff --numstat --no-renames -z <base>` into line totals.
 *
 * `-z` for the same reason parsePorcelainZ takes it: without it git quotes and
 * backslash-escapes any path with a space or a non-ASCII byte, and that escaping
 * is not reliably reversible by hand.
 *
 * The `-z` layout is NOT "every field NUL-terminated". numstat emits
 * `added \t removed \t path \0` — only the PATH is NUL-terminated, the two counts
 * stay tab-joined in front of it. So this splits on NUL to get records, then
 * takes the first two tab-separated fields of each. Splitting the whole output on
 * tabs instead would work right up until a path contained one.
 *
 * `--no-renames` is what keeps a record to three fields; with renames on, a
 * rename emits its two paths as extra NUL fields and the walk below would read
 * the origin path as its own record.
 */
export interface NumstatTotals {
  /** Records seen. Not the badge's file count — see readStats. */
  files: number
  added: number
  removed: number
}

export function parseNumstat(out: string): NumstatTotals {
  let files = 0
  let added = 0
  let removed = 0

  for (const record of out.split('\0')) {
    // Shortest real record is 'a\tr\tp' — anything less is the trailing empty
    // field, or output from a git that printed nothing at all.
    if (record.length < 5) continue
    const a = record.indexOf('\t')
    if (a === -1) continue
    const b = record.indexOf('\t', a + 1)
    if (b === -1) continue
    files++
    // A binary file is reported as `-\t-`. Number('-') is NaN, so both arms need
    // the guard — and a binary file genuinely contributes no lines, which is
    // also what diffRow's 'binary' note produces.
    const plus = Number(record.slice(0, a))
    const minus = Number(record.slice(a + 1, b))
    if (Number.isFinite(plus)) added += plus
    if (Number.isFinite(minus)) removed += minus
  }

  return { files, added, removed }
}

/**
 * Lines a brand-new file contributes to the badge.
 *
 * numstat cannot see untracked files — they are not in the index and `git add -N`
 * is not an option, because mutating the index would break commitFiles' "exactly
 * the files you ticked" contract. So they are counted here instead, and this has
 * to agree with what `diffRow(path, rel, null, text)` reports or the badge and the
 * panel disagree on every new file.
 *
 * Verified against diffRow: '' -> 0, 'a' -> 1, '\n' -> 1, 'a\nb' -> 2,
 * 'a\nb\n' -> 2. A trailing newline terminates the last line rather than
 * starting a new one.
 */
export function countLines(text: string): number {
  if (text === '') return 0
  const n = text.split('\n').length
  return text.endsWith('\n') ? n - 1 : n
}
