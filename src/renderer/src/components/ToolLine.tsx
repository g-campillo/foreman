import { Children, useMemo, useState } from 'react'
import { ChevronDown, FileCode2 } from 'lucide-react'
import type { ChatItem, DiffHunk } from '../../../shared/types'
import { toHunks } from '../../../shared/diff.mts'
import {
  ANSWER_PREFIX,
  askQuestions,
  planProposal,
  planTitle,
  relPath,
  toolVerb,
  focusTarget,
} from '../derive.mts'
import { hljsLang } from '../highlight.mts'
import { useStore } from '../store'
import Markdown from './Markdown'
import DiffLines from './DiffLines'

type Tool = Extract<ChatItem, { kind: 'tool' }>

/** Inline edit diffs are a glance, not a review — the diff panel is the review. */
const MAX_INLINE_DIFF_LINES = 12

/** Expanded is still a transcript, not the diff panel. One click, one ceiling. */
const MAX_EXPANDED_DIFF_LINES = 200

/**
 * One-line gist of a tool call. The card is only ever this one line.
 *
 * `cwd` shortens paths that live under it — see relPath. It defaults to empty
 * so the one caller that has no session in scope (ApprovalCard) keeps working
 * and keeps showing absolute paths, which is what it should show: that card is
 * the user authorising a write to disk, and abbreviating a path you are being
 * asked to trust is the wrong trade.
 */
export function summarise(name: string, input: unknown, cwd = ''): string {
  if (!input || typeof input !== 'object') return ''
  const i = input as Record<string, unknown>
  const str = (k: string): string | null => (typeof i[k] === 'string' ? (i[k] as string) : null)

  switch (name) {
    case 'Bash':
      return str('command') ?? ''
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
      return relPath(str('file_path') ?? '', cwd)
    case 'NotebookEdit':
      return relPath(str('notebook_path') ?? '', cwd)
    case 'Glob':
    case 'Grep':
      return str('pattern') ?? ''
    case 'WebFetch':
      return str('url') ?? ''
    case 'ExitPlanMode': {
      // The whole plan is in here; the default branch would put the first 120
      // characters of it, JSON-escaped, in a one-line gist.
      const plan = planProposal(name, input)
      return plan ? planTitle(plan.markdown) : ''
    }
    // The subagent tool reports as 'Agent' on the wire; 'Task' is kept because
    // that is what it is called everywhere else, including older transcripts.
    // Without this the default branch falls through to `prompt` and puts the
    // subagent's entire instructions in the card's one-line gist.
    case 'Agent':
    case 'Task': {
      const desc = str('description')
      const kind = str('subagent_type')
      return desc && kind ? `${kind}: ${desc}` : (desc ?? kind ?? '')
    }
    default: {
      // The question set is the whole input, so the generic fallback would put
      // raw JSON in the gist of the one card the user is being asked to read.
      const questions = askQuestions(name, input)
      if (questions) return questions.map((q) => q.header || q.question).join(' · ')

      // MCP tools land here. Named fields first, then any short string value —
      // this used to fall through to 120 characters of raw JSON, which is most
      // of what made a transcript of MCP calls unreadable.
      // The two path-shaped fields get shortened; query/pattern/name are not
      // paths and must be left exactly as the agent wrote them.
      const filePath = str('file_path') ?? str('path')
      if (filePath) return relPath(filePath, cwd)
      const named = str('query') ?? str('pattern') ?? str('name')
      if (named) return named
      for (const v of Object.values(i)) if (typeof v === 'string' && v.length <= 80) return v
      return ''
    }
  }
}

/**
 * The diff an edit tool is about to make, from its own input.
 *
 * Line numbers are deliberately absent downstream: old_string/new_string are
 * fragments of the file, not the file, so any number here would be invented.
 * Write has no before-text at all, so it reads as pure additions.
 */
function editHunks(name: string, input: unknown): DiffHunk[] | null {
  if (!input || typeof input !== 'object') return null
  const i = input as Record<string, unknown>
  const s = (k: string): string => (typeof i[k] === 'string' ? (i[k] as string) : '')
  const path = s('file_path') || s('notebook_path')

  if (name === 'Edit') return toHunks(s('old_string'), s('new_string'), path)
  if (name === 'Write') return toHunks('', s('content'), path)
  if (name === 'NotebookEdit') {
    // Same shape as Write: the input carries the new cell source and no previous
    // text, so it reads as pure additions. A delete carries no source at all —
    // showing nothing beats inventing a before-image to strike through.
    if (s('edit_mode') === 'delete') return null
    return toHunks('', s('new_source'), path)
  }
  if (name === 'MultiEdit') {
    const edits = Array.isArray(i.edits) ? (i.edits as Record<string, unknown>[]) : []
    return edits.flatMap((e) =>
      toHunks(String(e?.old_string ?? ''), String(e?.new_string ?? ''), path),
    )
  }
  return null
}

/* TOOL_ICON and toolIcon lived here — a per-tool lucide glyph, with the status
   carried as a colour on `.tool-head[data-status]` beside it.

   Both are gone with the card. Cursor's rows have no icon at all: the verb says
   what kind of work it was ("Searched files", "Ran", "Edited") far better than
   a 12px glyph did, and once thirty rows are plain text an icon column is the
   only thing left drawing a grid down the transcript. The status colour went
   the same way — see `data-failed` on the row for the one state still worth
   showing without a click. TOOL_VERB in derive.mts is the replacement. */

/**
 * One tool call, as a line of prose.
 *
 * This was a bordered card with an icon, a name, a status colour and a chevron.
 * Cursor renders the same information as `Ran ls -la /Users/…` — verb in
 * secondary text, argument in quaternary, nothing else. Thirty of those read as
 * a paragraph of what the agent did; thirty cards read as a wall.
 *
 * What did NOT go away is the depth. Cursor's rows are inert, but Foreman's
 * carry things Cursor has nowhere to put: an edit's diff, a subagent's whole
 * transcript, an approved plan. So the row stays clickable and expands in place.
 * At rest it is Cursor's line; one click and it is what the card used to be.
 *
 * The old `data-status` colour is gone with the card. Failure is the one state
 * that still needs to be visible without a click, and it says so in words —
 * `data-failed` puts the argument in the danger hue rather than tinting a whole
 * surface.
 */
export default function ToolLine({
  item,
  cwd,
  children,
}: {
  item: Tool
  /**
   * The session's working directory, for shortening file paths.
   *
   * A prop rather than a useStore call: a long transcript renders hundreds of
   * these, and a selector in each would mean hundreds of store subscriptions
   * re-running `.find` over `sessions` on every streaming delta.
   */
  cwd?: string
  /** A subagent's nested transcript, when this call is a Task that spawned one. */
  children?: React.ReactNode
}): React.JSX.Element {
  const nested = Children.count(children) > 0
  const gist = summarise(item.name, item.input, cwd)
  const plan = planProposal(item.name, item.input)
  const hunks = useMemo(() => editHunks(item.name, item.input), [item.name, item.input])
  const openFile = useStore((s) => s.openFile)
  // Same function the tree and the editor follow with, so a row that offers the
  // editor is exactly a call the agent could be followed into.
  const target = useMemo(() => focusTarget(item.name, item.input), [item.name, item.input])

  // An answered question comes back flagged is_error, because the answer had to
  // travel as a permission deny — see ANSWER_PREFIX. It succeeded; don't paint
  // it as a failure. A skipped one has no answer text and stays an error.
  const status =
    item.status === 'error' && item.result?.startsWith(ANSWER_PREFIX) ? 'done' : item.status

  /** Now three things rather than two: a subagent transcript, an approved plan,
   *  or a diff. The diff used to render unconditionally under the card; behind
   *  the click it keeps the line a line, which is the whole point of this shape. */
  const expandable = nested || Boolean(plan) || Boolean(hunks?.length)
  const [open, setOpen] = useState(false)

  // One-way: once the ceiling is raised there is no "more" row left to click,
  // and a separate collapse control buys little at a 200-line cap.
  const [allLines, setAllLines] = useState(false)

  const added = hunks?.reduce((n, h) => n + h.lines.filter((l) => l.type === 'add').length, 0) ?? 0
  const removed = hunks?.reduce((n, h) => n + h.lines.filter((l) => l.type === 'del').length, 0) ?? 0

  /* A subagent gets Cursor's two-line form: what it was asked on the first line,
     what it is doing right now on the second. Every other tool keeps one line
     and lets the rolling summary replace its argument, because for those the
     progress IS the argument — a Bash call reporting "installing packages" has
     nothing to say on a second line that the command did not already say. */
  const subagent = item.name === 'Agent' || item.name === 'Task'
  const status2 = subagent ? item.progress : null

  const line = (
    <>
      <span className="tool-verb">{toolVerb(item.name, status === 'pending')}</span>
      {/* The rolling summary is the more useful argument once there is one, and
          it replaces the gist rather than crowding it. */}
      <span className="tool-arg">{subagent ? gist : item.progress || gist}</span>
      {/* The only colour on the row, and the only one Cursor uses too. */}
      {(added > 0 || removed > 0) && (
        <span className="diff-stat">
          {added > 0 && <span className="a">+{added}</span>}
          {removed > 0 && <span className="d">−{removed}</span>}
        </span>
      )}
      {expandable && <ChevronDown size={12} className="tool-chevron" />}
    </>
  )

  return (
    <div className="tool" data-nested={nested ? '' : undefined} data-open={open ? '' : undefined}>
      {expandable ? (
        <button
          className="tool-line"
          data-failed={status === 'error' ? '' : undefined}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {line}
          {/* Only offered when focusTarget resolves AND the row already owns its
              click — otherwise the whole row opens the editor and this would be
              a second control competing for the same gesture. */}
          {target && (
            <span
              className="tool-open"
              role="button"
              tabIndex={-1}
              title="Open in the editor"
              onClick={(e) => {
                e.stopPropagation()
                openFile(target.path, target.line ?? undefined)
              }}
            >
              <FileCode2 size={12} />
            </span>
          )}
        </button>
      ) : target ? (
        <button
          className="tool-line"
          data-failed={status === 'error' ? '' : undefined}
          title="Open in the editor"
          onClick={() => openFile(target.path, target.line ?? undefined)}
        >
          {line}
        </button>
      ) : (
        <div
          className="tool-line"
          data-failed={status === 'error' ? '' : undefined}
          data-static=""
        >
          {line}
        </div>
      )}

      {/* Outside the click target, so hovering the live status does not light up
          the row as if it were expandable on its own. */}
      {status2 && <div className="tool-status">{status2}</div>}

      {open && (
        <div className="tool-body">
          {hunks && hunks.length > 0 && (
            <DiffLines
              hunks={hunks}
              numbers={false}
              // The edited file's grammar, so the diff reads as code rather than
              // as a wall of green. Null for a language hljs has no grammar for.
              lang={hljsLang(target?.path ?? '')}
              maxLines={allLines ? MAX_EXPANDED_DIFF_LINES : MAX_INLINE_DIFF_LINES}
              // Dropped once expanded, so past the second ceiling the row
              // degrades to a static count rather than offering a dead click.
              onMore={allLines ? undefined : () => setAllLines(true)}
            />
          )}
          {nested && <div className="tool-nest">{children}</div>}
          {plan && (
            <div className="tool-plan">
              <Markdown text={plan.markdown} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
