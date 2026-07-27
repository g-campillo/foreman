import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  ClipboardList,
  GitBranch,
  HardHat,
  MessageCircleQuestion,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Undo2,
  X,
} from 'lucide-react'
import type { ChatItem, EffortLevel, SessionMeta } from '../../../shared/types'
import { useStore } from '../store'
import ToolCard from './ToolCard'
import ApprovalCard from './ApprovalCard'
import ElicitationCard from './ElicitationCard'
import QuestionCard from './QuestionCard'
import PlanCard from './PlanCard'
import ClaudeMark from './ClaudeMark'
import {
  answeredQuestions,
  askQuestions,
  fmt,
  hms,
  planProposal,
  planTitle,
  toolLabel,
  toolRender,
  transcriptRows,
  workingVerb,
} from '../derive.mts'
import Markdown from './Markdown'
import { EFFORTS, MODES, modelName } from './Composer'

/** How long each fun verb stays up. Slow enough to read, quick enough to notice. */
const VERB_MS = 2500

/** 1s, because the readout counts seconds. The verb rotates off this same clock
 *  rather than its own interval — one timer, and the rotation comes free. */
const TICK_MS = 1000

export default function Conversation({ sessionId }: { sessionId: string }): React.JSX.Element {
  const items = useStore((s) => s.items[sessionId] ?? EMPTY)
  const focusItemId = useStore((s) => s.focusItemId)
  const revealItem = useStore((s) => s.revealItem)
  // Select the raw array and narrow in a memo — filtering inside the selector
  // returns a fresh array on every snapshot read, which zustand reads as a
  // changed store and spins into an infinite render loop. `.find` is safe: it
  // returns an existing object, not a new one, so its identity is stable.
  const session = useStore((s) => s.sessions.find((x) => x.id === sessionId))
  const status = session?.status
  const branch = useStore((s) => s.branches[sessionId] ?? null)
  const allApprovals = useStore((s) => s.approvals)
  const approvals = useMemo(
    () => allApprovals.filter((a) => a.sessionId === sessionId),
    [allApprovals, sessionId],
  )
  const allElicitations = useStore((s) => s.elicitations)
  const elicitations = useMemo(
    () => allElicitations.filter((e) => e.sessionId === sessionId),
    [allElicitations, sessionId],
  )
  const rewindPreview = useStore((s) => s.rewindPreview)
  // Subagent output arrives flat with a parentId; the tree is assembled here so
  // main never has to maintain one. Items without a parent are the main thread.
  const byParent = useMemo(() => {
    const m = new Map<string, ChatItem[]>()
    for (const it of items) {
      const p = parentOf(it)
      if (!p) continue
      const kids = m.get(p)
      if (kids) kids.push(it)
      else m.set(p, [it])
    }
    return m
  }, [items])
  const roots = useMemo(() => items.filter((it) => !parentOf(it)), [items])
  // Drops the checklist events TodoStrip renders, and flags the assistant
  // message that opens a turn. No longer folds tool runs — see transcriptRows.
  const rows = useMemo(() => transcriptRows(roots), [roots])

  // cwd is the *worktree* path for worktree sessions — a userData directory with
  // a disambiguating suffix — so repoRoot is what you actually want to name.
  //
  // Naming only. Do NOT reuse `root` for the cwd passed down to ToolCard: a
  // worktree session's tool file_paths point INTO the worktree, so stripping
  // repoRoot would never match and every path would silently stay absolute.
  // That one is plain `session?.cwd`.
  const root = session?.worktree?.repoRoot ?? session?.cwd ?? ''
  const project = root.split('/').filter(Boolean).pop() ?? ''
  // Chips, not a ` · `-joined string. Joined, this rendered as
  // "foreman · icon-chrome-collapsible-panel · Ask" — a repo, a long branch slug
  // and a bare mode word with nothing saying which was which.
  const chips: { icon: React.ReactNode; text: string }[] = [
    // The live branch, refreshed with the diff panel. worktree.branch is the
    // fallback only: it's frozen at creation, so it lies after a checkout.
    { icon: <GitBranch size={11} />, text: branch ?? session?.worktree?.branch ?? '' },
    {
      icon: <Sparkles size={11} />,
      // null until the first turn lands. modelName reads the wire id directly,
      // so this no longer needs the model list to resolve a display name.
      text: modelName(session?.model),
    },
    {
      icon: <ShieldCheck size={11} />,
      text: MODES.find((m) => m.value === session?.permissionMode)?.label ?? '',
    },
  ].filter((c) => c.text)

  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)

  // Only autoscroll when the user is already at the bottom, so reading history
  // isn't yanked away mid-stream.
  useEffect(() => {
    const el = scroller.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [items, approvals, elicitations, rewindPreview])

  /**
   * Scroll to and flash the row the editor pointed at.
   *
   * The other half of the gutter click. One-shot: revealItem(null) immediately
   * after, so re-clicking the same stripe flashes again rather than doing
   * nothing because the state never changed.
   */
  useEffect(() => {
    if (!focusItemId) return
    const el = document.querySelector(`[data-item-id="${focusItemId}"]`)
    if (el) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' })
      el.setAttribute('data-flash', '')
      setTimeout(() => el.removeAttribute('data-flash'), 1200)
    }
    revealItem(null)
  }, [focusItemId, revealItem])

  return (
    <div
      className="convo"
      ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
      }}
    >
      {/* `.empty` is flex:1 and centred on both axes already; it beats
          `.convo > * { flex-shrink: 0 }` on source order at equal specificity,
          which is what lets it fill the scroller. The 'starting' guard covers
          resume: the session appears and select()s before hydrate()'s async
          transcript read prepends, so items is [] for at least one frame. */}
      {items.length === 0 && status !== 'starting' && (
        <div className="empty">
          <HardHat size={44} />
          <h2>{project || 'Foreman'}</h2>
          <div className="empty-chips">
            {chips.map((c) => (
              <span key={c.text} className="empty-chip">
                {c.icon}
                {c.text}
              </span>
            ))}
          </div>
        </div>
      )}
      {rows.map((r) => (
        /* data-item-id is what the editor's gutter jumps to. A wrapper rather
           than an attribute on Item, because Item returns a different root per
           kind and threading the id through six branches would be six chances
           to miss one. */
        <div key={r.item.id} data-item-id={r.item.id}>
          <Item
            item={r.item}
            sessionId={sessionId}
            cwd={session?.cwd ?? ''}
            byParent={byParent}
            leadsTurn={r.leadsTurn}
          />
        </div>
      ))}
      {approvals.map((a) => {
        // ExitPlanMode's approval prompt IS the plan approval, so it gets the
        // plan rendered rather than "Allow ExitPlanMode?" over raw JSON.
        const plan = planProposal(a.toolName, a.input)
        if (plan) return <PlanCard key={a.requestId} req={a} plan={plan} />
        // A malformed question set falls back to the plain allow/deny card
        // rather than rendering a card with nothing to click.
        const questions = askQuestions(a.toolName, a.input)
        return questions ? (
          <QuestionCard key={a.requestId} req={a} questions={questions} />
        ) : (
          <ApprovalCard key={a.requestId} req={a} />
        )
      })}
      {elicitations.map((e) => (
        <ElicitationCard key={e.requestId} req={e} />
      ))}
      {rewindPreview && <RewindCard />}
      {/* Without this there's dead air between sending and the first token. */}
      {status === 'running' && session && <Working session={session} />}
    </div>
  )
}

const EMPTY: ChatItem[] = []

/**
 * Confirmation for a rewind, showing what the dry run says would actually
 * change. The preview costs nothing, so the card names real files instead of
 * asking the user to trust a verb.
 */
function RewindCard(): React.JSX.Element | null {
  const preview = useStore((s) => s.rewindPreview)
  const confirmRewind = useStore((s) => s.confirmRewind)
  const cancelRewind = useStore((s) => s.cancelRewind)
  if (!preview) return null

  const { result } = preview
  const files = result.filesChanged
  return (
    <div className="ask">
      <div className="ask-head">
        <span className="ask-tag">Rewind</span>
        <span>
          {result.canRewind
            ? files.length
              ? `Restore ${files.length} file${files.length === 1 ? '' : 's'} to this point?`
              : 'Nothing to restore — no file changes since this message.'
            : `Cannot rewind: ${result.error ?? 'no checkpoint for this message'}`}
        </span>
      </div>

      {result.canRewind && files.length > 0 && (
        <ul className="kv">
          {files.slice(0, 12).map((f) => (
            <li key={f} title={f}>
              <span className="kv-path">{f}</span>
            </li>
          ))}
          {files.length > 12 && (
            <li>
              <span>…and {files.length - 12} more</span>
            </li>
          )}
          <li>
            <span>Net change</span>
            <b>
              +{result.insertions}/−{result.deletions}
            </b>
          </li>
        </ul>
      )}

      <div className="ask-actions">
        <button className="btn" onClick={cancelRewind}>
          <X size={14} />
          Cancel
        </button>
        {result.canRewind && files.length > 0 && (
          <button className="btn" data-variant="danger" onClick={() => void confirmRewind()}>
            <Undo2 size={14} />
            Restore files
          </button>
        )}
      </div>
    </div>
  )
}

/** Only some variants can be parented, so the union needs narrowing to read it. */
function parentOf(item: ChatItem): string | undefined {
  return 'parentId' in item ? item.parentId : undefined
}

/** null means the SDK's own default is in force — a level this session never
 *  chose. Omitted rather than rendered as "auto", which would assert one. */
const effortLabel = (e: EffortLevel | null): string | null =>
  e ? (EFFORTS.find((x) => x.value === e)?.label.toLowerCase() ?? e) : null

/**
 * The status line: a rotating verb, plus this turn's elapsed time, output tokens
 * and reasoning effort — the shape the CLI uses.
 *
 * Still its own component so the tick repaints one line rather than the whole
 * transcript. Re-rendering a child never re-renders its parent, so the interval
 * stays contained here even though it now runs 2.5x more often than the verb
 * rotation needed.
 */
function Working({ session }: { session: SessionMeta }): React.JSX.Element {
  const [now, setNow] = useState(() => Date.now())
  // Opt-out in Settings: the verbs are purely for fun, and the dots already say
  // everything functional. The stats are information rather than decoration, so
  // they are deliberately NOT gated by it — and the clock has to tick either way.
  const verbs = useStore((s) => s.prefs.workingVerbs)
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(id)
  }, [])

  // turnStartedAt comes from main rather than a mount timestamp because this
  // component is not remounted per session: Conversation is rendered unkeyed, so
  // a Working that survived a tab switch would still be timing the old turn.
  const elapsed = session.turnStartedAt === null ? 0 : Math.max(0, now - session.turnStartedAt)
  const stats = [
    hms(elapsed),
    session.turnTokens ? `↓ ${fmt(session.turnTokens)}` : null,
    effortLabel(session.effort),
  ].filter(Boolean)

  return (
    <div className="working">
      <span className="working-dots">
        <i />
        <i />
        <i />
      </span>
      {/* Rotation is derived from the clock instead of its own counter, so the
          cadence alternates 2s/3s rather than a flat 2.5s. Indistinguishable,
          and it buys one timer instead of two. */}
      {verbs ? workingVerb(session.id, Math.floor(elapsed / VERB_MS)) : 'Working'}
      <span className="spacer" />
      <span className="working-stats">{stats.join(' · ')}</span>
    </div>
  )
}

/**
 * A one-line record of something the user was asked.
 *
 * AskUserQuestion and ExitPlanMode are conversations, not mechanical steps, and
 * a tool card reading "AskUserQuestion" over raw JSON is the worst possible
 * rendering of the one call the user actually took part in. The live prompt is
 * a QuestionCard or PlanCard; this is what stays behind afterwards.
 *
 * Deliberately not hidden outright: the cards vanish once answered, so without
 * this a resumed conversation would show no trace of what was asked or chosen.
 */
function RecordRow({ item }: { item: Extract<ChatItem, { kind: 'tool' }> }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const plan = planProposal(item.name, item.input)
  const answers = plan ? null : answeredQuestions(item.input, item.result)

  // ExitPlanMode's tool_result only arrives when the plan was APPROVED — a
  // rejection comes back through the deny channel as an error. So the card's
  // own status is the approval state.
  const body = plan
    ? planTitle(plan.markdown)
    : (answers ?? [])
        .map((a) => (a.answer ? `${a.header} → ${a.answer}` : a.header))
        .join(' · ')

  return (
    <div className="record" data-error={item.status === 'error' ? '' : undefined}>
      <button
        className="record-head"
        onClick={() => setOpen((v) => !v)}
        disabled={!plan}
        data-static={plan ? undefined : ''}
      >
        {plan ? (
          <ClipboardList size={12} />
        ) : (
          <MessageCircleQuestion size={12} />
        )}
        <span className="record-tag">{toolLabel(item.name)}</span>
        <span className="record-body">{body}</span>
        {plan && (
          <span style={{ color: 'rgb(var(--text-faint))' }}>
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </span>
        )}
      </button>
      {/* The approved plan lives nowhere else once its modal closes. */}
      {open && plan && (
        <div className="tool-plan">
          <Markdown text={plan.markdown} />
        </div>
      )}
    </div>
  )
}

function Item({
  item,
  sessionId,
  cwd,
  byParent,
  leadsTurn,
}: {
  item: ChatItem
  sessionId: string
  /** Session working directory, for shortening tool file paths. See ToolCard. */
  cwd: string
  byParent: Map<string, ChatItem[]>
  /** First assistant block of a turn — the one that gets the avatar. */
  leadsTurn?: boolean
}): React.JSX.Element | null {
  switch (item.kind) {
    case 'user':
      return (
        <div className="msg-user" data-queued={item.queued ? '' : undefined}>
          {item.images?.map((src, i) => (
            <img key={i} className="msg-image" src={src} alt="attachment" />
          ))}
          {/* Rendered as markdown, matching the composer that now renders it live
              while you type. `thinking` and `error` stay literal. */}
          <Markdown text={item.text} />
          {/* Nothing between this and the actions below: .msg-actions is absolutely
              positioned precisely so the invisible hover buttons stop reserving a
              blank line at the bottom of every bubble. */}
          {item.queued ? (
            <button
              className="queued-cancel"
              data-tip="Cancel this queued message — it has not reached the agent yet"
              onClick={() => void window.foreman.cancelQueued(sessionId, item.id)}
            >
              <X size={12} />
              queued
            </button>
          ) : (
            item.uuid && (
              // Branches into a new session sliced at this message — the
              // edit-and-retry shape, without disturbing this conversation.
              <span className="msg-actions">
                <button
                  className="branch-btn"
                  data-tip="Branch a new conversation from this point"
                  onClick={() => void useStore.getState().fork(item.uuid)}
                >
                  <GitBranch size={12} />
                  branch
                </button>
                <button
                  className="branch-btn"
                  data-tip="Restore files to their state at this message"
                  onClick={() => void useStore.getState().rewind(item.uuid!)}
                >
                  <RotateCcw size={12} />
                  rewind
                </button>
              </span>
            )
          )}
        </div>
      )
    case 'assistant':
      // Thinking text stays literal on purpose: markdown headings inside the
      // small italic block fight its styling.
      //
      // The gutter is always present, even without the mark, so the text column
      // stays aligned down the turn. Streaming emits several assistant items per
      // turn, so only the first carries the avatar.
      return (
        <div className="msg-assistant">
          <span className="msg-avatar">{leadsTurn && <ClaudeMark size={14} />}</span>
          <div className="msg-body">
            <Markdown text={item.text} />
          </div>
        </div>
      )
    case 'thinking':
      return <div className="msg-thinking">{item.text}</div>
    case 'tool':
      // Tools the user participated in get a compact record row instead of a
      // card — see RecordRow. They never have a subagent transcript to nest.
      if (toolRender(item.name) === 'record') return <RecordRow item={item} />
      // A Task card owns its subagent's whole transcript, nested. Recursing on
      // Item means a subagent that spawns its own subagent nests again for free.
      return (
        <ToolCard item={item} cwd={cwd}>
          {byParent.get(item.id)?.map((child) => (
            <Item key={child.id} item={child} sessionId={sessionId} cwd={cwd} byParent={byParent} />
          ))}
        </ToolCard>
      )
    case 'error':
      return <div className="msg-error">{item.text}</div>
    case 'result':
      // Only failures get a row now. A "done · 12.4s · $0.0231" line after every
      // single turn is noise the composer's running cost already covers, but a
      // turn that *failed* has to say so somewhere.
      return item.isError ? (
        <div className="msg-result" data-error="">
          failed · {(item.durationMs / 1000).toFixed(1)}s
        </div>
      ) : null
    default:
      return null
  }
}
