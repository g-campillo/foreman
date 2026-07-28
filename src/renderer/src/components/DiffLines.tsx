import { memo, useMemo } from 'react'
import type { DiffHunk, DiffLine } from '../../../shared/types'
import { tokenizeDiff, type Tok } from '../highlight.mts'

/**
 * The +/− line renderer, shared by the diff panel and the inline diff on an
 * Edit/Write tool card.
 *
 * `numbers` is off for the tool-card case: an Edit's old_string/new_string are
 * fragments, not the file, so any line number shown beside them would be made
 * up. Hunk headers are suppressed with them, for the same reason.
 */
function DiffLines({
  hunks,
  numbers = true,
  maxLines,
  lang,
  onMore,
}: {
  hunks: DiffHunk[]
  numbers?: boolean
  /** Clip past this many lines and say how many were hidden. */
  maxLines?: number
  /**
   * highlight.js grammar for the file, from `hljsLang(path)`. Omit — or pass
   * null — to render plain text, which is what the diff panel does.
   *
   * A prop and not a field on DiffHunk on purpose: DiffHunk crosses IPC inside
   * FileDiff, and the language is a rendering choice this side makes, not
   * something main should be shipping.
   */
  lang?: string | null
  /**
   * Makes the clipped-line row a button. Omit for a static count — the diff
   * panel passes no `maxLines` at all, so it never reaches either form.
   */
  onMore?: () => void
}): React.JSX.Element {
  const total = hunks.reduce((n, h) => n + h.lines.length, 0)

  /**
   * The budget walk and the tokenizer, together, because the second depends on
   * the first. `budget` used to be mutated by the render map itself, which is
   * why no hook fit here before.
   *
   * Tokenizing exactly the SLICED lines is not an approximation: the slice is
   * always a prefix, and a prefix's tokenizer state is identical whether or not
   * the rest is tokenized. So the existing render caps (≤12 inline, ≤200
   * expanded, ≤14 in ApprovalCard) are the tokenizer's bound too, and no new
   * constant is needed.
   */
  const shown = useMemo(() => {
    let budget = maxLines ?? Infinity
    return hunks.map((h): { lines: DiffLine[]; toks: Tok[][] | null } | null => {
      if (budget <= 0) return null
      const lines = h.lines.slice(0, budget)
      budget -= lines.length
      return { lines, toks: lang && lines.length ? tokenizeDiff(lines, lang) : null }
    })
  }, [hunks, maxLines, lang])

  return (
    <div className="diff-body" data-bare={numbers ? undefined : ''}>
      {shown.map((h, hi) => {
        if (!h) return null
        const { lines, toks } = h
        return (
          <div key={hi}>
            {numbers && (
              <div className="diff-hunk-head">
                @@ −{hunks[hi]!.oldStart} +{hunks[hi]!.newStart} @@
              </div>
            )}
            {lines.map((l, li) => (
              <div className="diff-line" data-t={l.type} key={li}>
                {numbers && (
                  <>
                    <span className="diff-no">{l.oldNo ?? ''}</span>
                    <span className="diff-no">{l.newNo ?? ''}</span>
                  </>
                )}
                <span className="diff-sign">
                  {l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' '}
                </span>
                {/* data-hl is what makes the add/del foreground colours stand
                    down — see theme.css. It is set only when there are tokens to
                    show, so an untokenized line keeps the flat green/red it has
                    always had. */}
                <span className="diff-text" data-hl={toks?.[li]?.length ? '' : undefined}>
                  {toks?.[li]?.length ? <Spans toks={toks[li]!} /> : l.text || ' '}
                </span>
              </div>
            ))}
          </div>
        )
      })}
      {maxLines !== undefined &&
        total > maxLines &&
        (onMore ? (
          <button className="diff-more" onClick={onMore}>
            Show all {total} lines
          </button>
        ) : (
          <div className="diff-more">+{total - maxLines} more</div>
        ))}
    </div>
  )
}

/** One span per token run. `cls` is the joined ancestor chain, so a compound
 *  selector like `.hljs-title.function_` still matches. */
function Spans({ toks }: { toks: Tok[] }): React.JSX.Element {
  return (
    <>
      {toks.map((t, i) =>
        t.cls ? (
          <span key={i} className={t.cls}>
            {t.text}
          </span>
        ) : (
          t.text
        ),
      )}
    </>
  )
}

export default memo(DiffLines)
