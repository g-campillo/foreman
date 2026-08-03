import { useMemo, useState } from 'react'
import { ChevronDown, FileCode2 } from 'lucide-react'
import type { ChatItem } from '../../../shared/types'
import type { RunSummary } from '../derive.mts'
import {
  editHunks,
  mcpName,
  planProposal,
  summarise,
  titleCase,
  toolFailed,
  toolVerb,
  focusTarget,
} from '../derive.mts'
import { hljsLang } from '../highlight.mts'
import { useStore } from '../store'
import Markdown from './Markdown'
import DiffLines from './DiffLines'
import McpMark from './McpMark'
import { RunChips } from './ToolRun'
import { useTailPin } from './ScrollDown'

type Tool = Extract<ChatItem, { kind: 'tool' }>

/** Inline edit diffs are a glance, not a review — the diff panel is the review. */
const MAX_INLINE_DIFF_LINES = 12

/** Expanded is still a transcript, not the diff panel. One click, one ceiling. */
const MAX_EXPANDED_DIFF_LINES = 200

/* `summarise` and `editHunks` were defined here. They moved to derive.mts when
   the folded run head started needing both — the head names the call in flight
   and sums the run's diff — and derive.mts cannot import a `.tsx` without
   breaking `npm run check:derive`, which runs under bare node. The move also
   made summarise checkable for the first time.

   Only summarise is re-exported, and only because ApprovalCard imports it from
   here; one import line is not worth touching a file for. editHunks has no
   caller outside this module, and a re-export nobody uses is just a second name
   for the same function. */
export { summarise }

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
  nest,
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
  /**
   * What the nested transcript adds up to, and whether there is one at all.
   *
   * Null is the ONLY test for "has a subagent". This used to be
   * `Children.count(children) > 0`, which is a trap rather than an equivalent:
   * React counts `false` as one child and `null`/`undefined` as none, so the
   * moment a caller guarded its children with `&&` instead of `?:` every tool
   * row in the transcript would claim a nest and grow a chevron over an empty
   * body. It was correct only by accident — `byParent.get(...)?.map()` happens
   * to yield `undefined` — and ToolItem now does guard with `&&`.
   */
  nest?: RunSummary | null
  /** A subagent's nested transcript, when this call is a Task that spawned one. */
  children?: React.ReactNode
}): React.JSX.Element {
  const nested = nest != null
  const gist = summarise(item.name, item.input, cwd)
  const plan = planProposal(item.name, item.input)
  const hunks = useMemo(() => editHunks(item.name, item.input), [item.name, item.input])
  const openFile = useStore((s) => s.openFile)
  // Same function the tree and the editor follow with, so a row that offers the
  // editor is exactly a call the agent could be followed into.
  const target = useMemo(() => focusTarget(item.name, item.input), [item.name, item.input])

  // Shared with the folded run head's `N failed` count, so the two can never
  // disagree about what failed — see toolFailed for the is_error subtlety.
  const failed = toolFailed(item)

  /** Now three things rather than two: a subagent transcript, an approved plan,
   *  or a diff. The diff used to render unconditionally under the card; behind
   *  the click it keeps the line a line, which is the whole point of this shape. */
  const expandable = nested || Boolean(plan) || Boolean(hunks?.length)
  const [open, setOpen] = useState(false)

  // One-way: once the ceiling is raised there is no "more" row left to click,
  // and a separate collapse control buys little at a 200-line cap.
  const [allLines, setAllLines] = useState(false)

  /* The nest is capped and therefore scrolls itself, so something has to follow
     its tail while the subagent streams — the transcript's autoscroll writes a
     different element and cannot. A callback ref because the node only exists
     while the row is open; see useTailPin, which is also where re-expanding gets
     its meaning as the way back to the bottom. */
  const nestRef = useTailPin<HTMLDivElement>()

  const added = hunks?.reduce((n, h) => n + h.lines.filter((l) => l.type === 'add').length, 0) ?? 0
  const removed = hunks?.reduce((n, h) => n + h.lines.filter((l) => l.type === 'del').length, 0) ?? 0

  /* A subagent gets Cursor's two-line form: what it was asked on the first line,
     what it is doing right now on the second — and a third while it is
     collapsed, summing the work behind the fold. Every other tool keeps one line
     and lets the rolling summary replace its argument, because for those the
     progress IS the argument — a Bash call reporting "installing packages" has
     nothing to say on a second line that the command did not already say. */
  const subagent = item.name === 'Agent' || item.name === 'Task'
  const status2 = subagent ? item.progress : null

  /* An MCP call leads with the official mark instead of the literal word `MCP`.
     `MCP brain Brain Get` spends a third of the row restating the protocol, and
     the protocol has a mark for exactly this. The server segment stays verbatim
     — it is a name from the user's config, not prose — so only the tool half is
     title-cased. The word is still ANNOUNCED, because a screen reader gets
     nothing at all from an aria-hidden glyph.

     RecordRow and ApprovalCard deliberately keep printing the word: both render
     the name as a `.record-tag` / `.approval-tag`, and a tag is a tag — a glyph
     inside a chip that already reads as a label is decoration. */
  const mcp = mcpName(item.name)

  const line = (
    <>
      <span className="tool-verb">
        {mcp ? (
          <>
            <McpMark size={12} className="tool-mark" />
            <span className="sr-only">MCP </span>
            {/* Same join as toolLabel, minus the prefix the mark replaced: a
                server with no tool segment must not trail a lone space. */}
            {[mcp.server, mcp.tool && titleCase(mcp.tool)].filter(Boolean).join(' ')}
          </>
        ) : (
          toolVerb(item.name, item.status === 'pending')
        )}
      </span>
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
          data-failed={failed ? '' : undefined}
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
          data-failed={failed ? '' : undefined}
          title="Open in the editor"
          onClick={() => openFile(target.path, target.line ?? undefined)}
        >
          {line}
        </button>
      ) : (
        <div
          className="tool-line"
          data-failed={failed ? '' : undefined}
          data-static=""
        >
          {line}
        </div>
      )}

      {/* Outside the click target, so hovering the live status does not light up
          the row as if it were expandable on its own. */}
      {status2 && <div className="tool-status">{status2}</div>}

      {/* What is behind the fold, while it is shut — the same readout a folded
          run wears, over the whole nest instead of over one run. A subagent is
          the largest thing a turn can collapse, and until now it collapsed to a
          single line that said only what it had been asked.

          Gated on steps, because a subagent that only reasoned and reported
          produces `steps: 0`, and `0 steps` under every prose-only delegation is
          furniture. Gated on `!open` because the rows themselves are the better
          answer once they are on screen. */}
      {!open && nest && nest.steps > 0 && (
        <div className="tool-sum" data-failed={nest.failed > 0 ? '' : undefined}>
          <RunChips sum={nest} />
        </div>
      )}

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
          {nested && (
            <div className="tool-nest" ref={nestRef}>
              {children}
            </div>
          )}
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
