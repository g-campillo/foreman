import { memo } from 'react'
import type { DiffHunk } from '../../../shared/types'

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
}: {
  hunks: DiffHunk[]
  numbers?: boolean
  /** Clip past this many lines and say how many were hidden. */
  maxLines?: number
}): React.JSX.Element {
  const total = hunks.reduce((n, h) => n + h.lines.length, 0)
  let budget = maxLines ?? Infinity

  return (
    <div className="diff-body" data-bare={numbers ? undefined : ''}>
      {hunks.map((h, hi) => {
        if (budget <= 0) return null
        const lines = h.lines.slice(0, budget)
        budget -= lines.length
        return (
          <div key={hi}>
            {numbers && (
              <div className="diff-hunk-head">
                @@ −{h.oldStart} +{h.newStart} @@
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
                <span className="diff-text">{l.text || ' '}</span>
              </div>
            ))}
          </div>
        )
      })}
      {maxLines !== undefined && total > maxLines && (
        <div className="diff-more">+{total - maxLines} more</div>
      )}
    </div>
  )
}

export default memo(DiffLines)
