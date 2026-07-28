import { Children, useMemo, useState } from 'react'
import {
  Bot,
  ChevronDown,
  ChevronRight,
  Circle,
  FilePen,
  FilePenLine,
  FilePlus,
  FileSearch,
  FileText,
  Globe,
  Link,
  ListTodo,
  NotebookPen,
  Plug,
  Search,
  Sparkles,
  Square,
  SquareSlash,
  SquareTerminal,
  Terminal,
  Wrench,
  FileCode2,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { ChatItem, DiffHunk } from '../../../shared/types'
import { toHunks } from '../../../shared/diff.mts'
import {
  ANSWER_PREFIX,
  askQuestions,
  planProposal,
  planTitle,
  relPath,
  toolLabel,
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

/**
 * The icon says what kind of work this is; the colour says how it went.
 *
 * Those used to be the same channel — one checkmark that was grey, then green
 * or red — so a transcript of thirty calls looked identical whether it had been
 * reading files or shelling out. Status moved to `.tool-head[data-status]` in
 * theme.css, which frees the glyph to carry the tool's identity instead.
 *
 * Components, not elements: lucide strokes with currentColor, so `.tool-icon`
 * owns the colour. Same arrangement as ACTIVITY_ICON in SessionRail.
 */
const TOOL_ICON: Record<string, LucideIcon> = {
  // files
  Read: FileText,
  Write: FilePlus,
  Edit: FilePen,
  MultiEdit: FilePenLine,
  NotebookEdit: NotebookPen,
  // shell
  Bash: Terminal,
  BashOutput: SquareTerminal,
  KillShell: Square,
  // search
  Glob: FileSearch,
  Grep: Search,
  ToolSearch: Wrench,
  // web
  WebFetch: Link,
  WebSearch: Globe,
  // orchestration. 'Agent' is the wire name; 'Task' is what older transcripts
  // carry, and both have to land on the same glyph — see summarise().
  Agent: Bot,
  Task: Bot,
  TodoWrite: ListTodo,
  // user-facing
  SlashCommand: SquareSlash,
  Skill: Sparkles,
  // Deliberately absent: TaskCreate/TaskUpdate (render 'hidden' — TodoStrip
  // folds them) and ExitPlanMode/AskUserQuestion (render 'record' — RecordRow
  // returns before a ToolCard is built, and carries its own glyph). None of
  // them can reach this map; see TOOL_DISPLAY in derive.mts.
}

/**
 * The glyph for a tool call.
 *
 * Exact name first, then the `mcp__<server>__<tool>` prefix — see toolLabel for
 * the wire format. That order is what lets a specific MCP tool be given its own
 * glyph later without special-casing the prefix check.
 */
export function toolIcon(name: string): LucideIcon {
  return TOOL_ICON[name] ?? (name.startsWith('mcp__') ? Plug : Circle)
}

export default function ToolCard({
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
  /** A subagent's nested transcript, when this card is a Task that spawned one. */
  children?: React.ReactNode
}): React.JSX.Element {
  const nested = Children.count(children) > 0
  const gist = summarise(item.name, item.input, cwd)
  const plan = planProposal(item.name, item.input)
  const hunks = useMemo(() => editHunks(item.name, item.input), [item.name, item.input])
  const openFile = useStore((s) => s.openFile)
  // Same function the tree and the editor follow with, so a card that is
  // clickable is exactly a call the agent could be followed into.
  const target = useMemo(() => focusTarget(item.name, item.input), [item.name, item.input])

  // Only a card carrying a whole document expands: a subagent's transcript, or
  // an approved plan whose modal is gone and which lives nowhere else. Ordinary
  // calls are one line and nothing more — the raw input used to be dumped here
  // as JSON, and a Task card auto-expanded purely because it had children.
  const expandable = nested || Boolean(plan)
  const [open, setOpen] = useState(false)

  // One-way: once the ceiling is raised there is no "more" row left to click,
  // and a separate collapse control buys little at a 200-line cap.
  const [allLines, setAllLines] = useState(false)

  // An answered question comes back flagged is_error, because the answer had to
  // travel as a permission deny — see ANSWER_PREFIX. It succeeded; don't paint
  // it as a failure. A skipped one has no answer text and stays an error.
  const status = item.status === 'error' && item.result?.startsWith(ANSWER_PREFIX)
    ? 'done'
    : item.status
  const Glyph = toolIcon(item.name)

  const head = (
    <>
      <span className="tool-icon">
        <Glyph size={12} />
      </span>
      <span className="tool-name">{toolLabel(item.name)}</span>
      {/* The rolling summary is the more useful line once there is one, and it
          replaces the gist rather than crowding it. */}
      <span className="tool-arg">{item.progress || gist}</span>
      {hunks && hunks.length > 0 && (
        <span className="diff-stat">
          <span className="a">+{hunks.reduce((n, h) => n + h.lines.filter((l) => l.type === 'add').length, 0)}</span>{' '}
          <span className="d">−{hunks.reduce((n, h) => n + h.lines.filter((l) => l.type === 'del').length, 0)}</span>
        </span>
      )}
      {expandable && (
        <span style={{ color: 'rgb(var(--text-faint))' }}>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
      )}
    </>
  )

  return (
    <div className="tool" data-nested={nested ? '' : undefined}>
      {/* data-status sits on the HEAD, never on .tool: a Task card nests whole
          .tool elements inside itself, so `.tool[data-status] .tool-icon` would
          repaint every child's icon with the parent's status. A .tool-head is
          never inside another .tool-head. */}
      {expandable ? (
        <button className="tool-head" data-status={status} onClick={() => setOpen(!open)}>
          {head}
          {/* A third arm on a switch that already existed, rather than a new
              interaction model. Only shown when focusTarget resolves AND the
              card is expandable — an expandable head's click is already taken. */}
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
          className="tool-head"
          data-status={status}
          title="Open in the editor"
          onClick={() => openFile(target.path, target.line ?? undefined)}
        >
          {head}
        </button>
      ) : (
        <div className="tool-head" data-status={status} data-static="">
          {head}
        </div>
      )}

      {/* Not behind the chevron: an edit's diff IS its summary, the way Claude
          Code shows it, and hiding it behind a click defeats the point. */}
      {hunks && hunks.length > 0 && (
        <DiffLines
          hunks={hunks}
          numbers={false}
          // The edited file's grammar, so the diff reads as code rather than as
          // a wall of green. Null for a language hljs has no grammar for, which
          // degrades to exactly what this rendered before.
          lang={hljsLang(target?.path ?? '')}
          maxLines={allLines ? MAX_EXPANDED_DIFF_LINES : MAX_INLINE_DIFF_LINES}
          // Dropped once expanded, so past the second ceiling the row degrades
          // to a static count rather than offering a click that does nothing.
          onMore={allLines ? undefined : () => setAllLines(true)}
        />
      )}

      {open && (
        <>
          {nested && <div className="tool-nest">{children}</div>}
          {plan && (
            <div className="tool-plan">
              <Markdown text={plan.markdown} />
            </div>
          )}
        </>
      )}
    </div>
  )
}
