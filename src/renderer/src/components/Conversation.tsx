import { useContext, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  ClipboardList,
  GitBranch,
  MessageCircleQuestion,
  RotateCcw,
  Undo2,
  X,
} from 'lucide-react'
import type { ChatItem, SessionMeta } from '../../../shared/types'
import { useStore } from '../store'
import { scrollPin } from '../scrollPin'
import ToolLine from './ToolLine'
import ToolRun, { FoldedContext, RevealContext } from './ToolRun'
import ScrollDown from './ScrollDown'
import ApprovalCard from './ApprovalCard'
import ElicitationCard from './ElicitationCard'
import QuestionCard from './QuestionCard'
import PlanCard from './PlanCard'
import {
  answeredQuestions,
  armedApproval,
  askQuestions,
  groupRuns,
  groupTurns,
  hms,
  planProposal,
  planTitle,
  runSummary,
  toolLabel,
  toolRender,
  transcriptRows,
  workingVerb,
} from '../derive.mts'
import type { Row, Turn as TurnShape, WorkNode } from '../derive.mts'
import Markdown from './Markdown'

/** How long each fun verb stays up. A minute, because this is decoration next to
 *  a line that is already saying "alive": at a few seconds the words change
 *  faster than they can be read and the eye reads motion rather than a status. */
const VERB_MS = 60_000

/** 1s, because the turn header's readout counts seconds — `Turn` is the only
 *  caller now. The verb used to rotate off this same clock, but a minute apart
 *  that would be fifty-nine renders that change nothing, so `Working` arms its
 *  own timer against the boundary it actually cares about. */
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
  /** Transcript still on its way in — see the `.empty` node below. */
  const hydrating = useStore((s) => s.hydrating[sessionId] === true)
  const allApprovals = useStore((s) => s.approvals)
  const approvals = useMemo(
    () => allApprovals.filter((a) => a.sessionId === sessionId),
    [allApprovals, sessionId],
  )
  /* Which Allow button may take focus, so ⏎ answers it natively. Conversation
     renders only the ACTIVE session, so an approval raised by a background
     agent can never arm — and armedApproval refuses to arm anything at all
     while a plan or a question is pending, because those two cards bind their
     own window-level Enter. */
  const armId = useMemo(() => armedApproval(approvals), [approvals])
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
  // message that opens a turn.
  const rows = useMemo(() => transcriptRows(roots), [roots])
  /* Grouped into turns, so each one can head itself with `Worked for Ns ⌄` and
     fold everything between the question and the answer behind it. */
  const turns = useMemo(() => groupTurns(rows), [rows])
  /* ...and each turn's work grouped again, into runs of consecutive tool calls.
     Here rather than inside `Rows`, for two reasons: `Rows` is a .tsx, so the
     grouping would stop being checkable; and `Rows` also renders `turn.tail`,
     which groupTurns guarantees holds only assistant/result/error rows — a
     guaranteed-empty grouping pass on every streaming delta.

     `Turn.work` stays a Row[]. Changing its element type would break the
     groupTurns checks, which all read `t.work.map(r => r.item.id)`. */
  const grouped = useMemo(
    () => turns.map((turn) => ({ turn, nodes: groupRuns(turn.work) })),
    [turns],
  )

  /* `root`, `project` and the `chips` array lived here — the repo name and the
     branch · model · mode chips the empty state used to render above the
     composer. All three are live controls in the composer now (a project picker,
     a branch picker, the model picker and the `+` menu), so the labels were
     restating what sits four pixels below them. See the empty state below. */

  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)

  // Only autoscroll when the user is already at the bottom, so reading history
  // isn't yanked away mid-stream — or when the user's own message has just
  // entered this transcript, which is what `scrollPin` carries over from the
  // store's queue handler.
  //
  // Next frame, not in the effect body: reading scrollHeight and writing
  // scrollTop forces a synchronous layout, and doing that inside React's commit
  // makes every streaming update lay the whole transcript out twice. The rAF
  // runs after the browser has laid out the new content anyway, so scrollHeight
  // is the same number for free. Cancelled on re-run so a burst of updates
  // scrolls once.
  //
  // The latch is SPENT INSIDE THE rAF, not in the effect body, so it is spent on
  // the frame that actually scrolls: a cancelled callback never spends it, which
  // is what makes a burst of deltas arriving alongside the sent message collapse
  // to one scroll rather than swallowing the pin on a frame that never ran.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const el = scroller.current
      if (!el) return
      if (scrollPin.current) scrollPin.current = false
      else if (!pinned.current) return
      el.scrollTop = el.scrollHeight
    })
    return () => cancelAnimationFrame(frame)
  }, [items, approvals, elicitations, rewindPreview])

  /* Which turn and which run a given item lives in.

     The gutter jump used to querySelector for the row and silently give up when
     it missed — which it already did for anything inside a folded turn, i.e.
     every turn but the newest. Folded runs would have added a second way to
     miss, so both are fixed with one mechanism: the ids go down as context and
     the two folds open themselves. */
  const revealOf = useMemo(() => {
    const m = new Map<string, { turnId: string; runId: string | null }>()
    for (const { turn, nodes } of grouped) {
      const put = (itemId: string, runId: string | null): void => {
        m.set(itemId, { turnId: turn.id, runId })
      }
      if (turn.lead) put(turn.lead.item.id, null)
      for (const n of nodes) {
        if (n.kind === 'row') put(n.row.item.id, null)
        else for (const r of n.rows) put(r.item.id, n.id)
      }
      for (const r of turn.tail) put(r.item.id, null)
    }
    return m
  }, [grouped])
  const reveal = focusItemId ? (revealOf.get(focusItemId) ?? null) : null

  /**
   * Scroll to and flash the row the editor pointed at.
   *
   * The other half of the gutter click. One-shot: revealItem(null) once it has
   * landed, so re-clicking the same stripe flashes again rather than doing
   * nothing because the state never changed.
   */
  useEffect(() => {
    if (!focusItemId) return
    let frame = 0

    const land = (tries: number): void => {
      const el = document.querySelector(`[data-item-id="${focusItemId}"]`)
      // Not there YET is the common case, not a miss: the reveal context and
      // this effect commit in the same pass, so the turn and run it just told
      // to open are a frame away from mounting their rows. Clearing here would
      // close them again before the row existed. Three frames rather than one
      // because a turn and a run can have to open in sequence, and a frame is
      // cheap next to a gutter click that silently does nothing.
      if (!el && tries > 0) {
        frame = requestAnimationFrame(() => land(tries - 1))
        return
      }
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' })
        el.setAttribute('data-flash', '')
        setTimeout(() => el.removeAttribute('data-flash'), 1200)
      }
      // Cleared even on a genuine miss — an item that is not in this transcript
      // at all — or the id would stick and re-clicking the same stripe would do
      // nothing. Nothing re-folds when it clears: both folds are one-way.
      revealItem(null)
    }

    land(3)
    return () => cancelAnimationFrame(frame)
  }, [focusItemId, revealItem])

  return (
    <div className="convo" ref={scroller}>
      {/* `.empty` is flex:1 and centred on both axes already; it beats
          `.convo > * { flex-shrink: 0 }` on source order at equal specificity,
          which is what lets it fill the scroller.

          The guard is `hydrating`, not `status !== 'starting'`. It was written
          for resume — a resumed session is selected and painted before its
          transcript replays, so `items` is [] for a frame or two and the centred
          layout would flash over it. But a FRESH session is created with
          `status: 'starting'` too, so that test also suppressed `.empty` on the
          first paint of every new conversation: the composer rendered pinned to
          the bottom and then SNAPPED to the middle milliseconds later when the
          status flipped to idle. The store's `hydrating` says the thing that was
          actually meant, and only for the case it was meant for. */}
      {/* Deliberately empty. The hard-hat mark, the project name and the three
          read-only chips (branch · model · mode) all lived here; Cursor's
          new-agent screen has no hero at all, just the pickers, the composer and
          the starter chips, centred. Every one of those chips is now a live
          control in the composer instead of a label above it — the branch and
          project are pickers, the model is the model picker, and the mode is in
          the `+` menu — so the hero was restating the composer.

          The element itself stays: `.pane-fill:has(> .convo > .empty)` is what
          pulls the composer up to the middle of the pane, and it is the presence
          of this node, not its contents, that triggers it. */}
      {items.length === 0 && !hydrating && <div className="empty" />}
      {/* The Provider paints nothing, so every wrapper below it is still a
          direct `.convo` child — which is what the content-visibility and
          flex rules key off. */}
      <RevealContext.Provider value={reveal}>
        {grouped.map(({ turn, nodes }, i) => (
          <Turn
            key={turn.id}
            turn={turn}
            nodes={nodes}
            sessionId={sessionId}
            cwd={session?.cwd ?? ''}
            byParent={byParent}
            // Only the newest turn stays open. Everything before it folds to its
            // header plus what the agent finally said, which is what makes a long
            // session readable when you scroll back through it.
            latest={i === grouped.length - 1}
            // Live counter for the turn in flight. turnStartedAt comes from main,
            // not a mount timestamp — see Working for why that distinction matters.
            startedAt={i === grouped.length - 1 && status === 'running' ? session?.turnStartedAt ?? null : null}
          />
        ))}
      </RevealContext.Provider>
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
          <ApprovalCard key={a.requestId} req={a} arm={a.requestId === armId} />
        )
      })}
      {elicitations.map((e) => (
        <ElicitationCard key={e.requestId} req={e} />
      ))}
      {rewindPreview && <RewindCard />}
      {/* Without this there's dead air between sending and the first token. */}
      {status === 'running' && session && <Working session={session} />}
      {/* Last child, and always mounted: it floats over the bottom of the
          transcript on a negative margin, so it must sit after everything it
          floats over and must never change `scrollHeight` by appearing. */}
      <ScrollDown scroller={scroller} pinned={pinned} />
    </div>
  )
}

const EMPTY: ChatItem[] = []

/** What every row needs, and what nothing between Conversation and a row cares
 *  about — so it travels as one object rather than as three repeated props. */
interface RowCtx {
  sessionId: string
  cwd: string
  byParent: Map<string, ChatItem[]>
}

/** Each row keeps its own `data-item-id` wrapper: that is what the editor's
 *  gutter jumps to and flashes, and what `content-visibility` is applied to. A
 *  wrapper rather than an attribute on Item, because Item returns a different
 *  root per kind and threading the id through six branches would be six chances
 *  to miss one.
 *
 *  A subagent's rows are wrapped by the same component now (see ToolItem), and
 *  only some of that follows them down. `content-visibility` does not — those
 *  rules are `.convo >`-scoped on purpose. The gutter half only half does: the
 *  reveal map below is built from main-thread rows, so a nested target opens
 *  nothing to reach itself, but the flash rule is unscoped and lands if the Task
 *  is already open. What the wrapper is unconditionally there for down there is
 *  `hidden` — a run folds inside a nest exactly as it does out here, and this is
 *  the element the attribute has to land on. */
function RowItem({ row, ctx }: { row: Row; ctx: RowCtx }): React.JSX.Element {
  // Inside a collapsed run this row is HIDDEN, not unmounted — that is what
  // keeps an open diff open when a run folds under the user. The attribute has
  // to be here, on the wrapper, because that is the element the CSS knows about;
  // see `.convo > [data-item-id][hidden]` and its twin under `.tool-nest >`,
  // both of which exist to beat the UA rule's specificity.
  const folded = useContext(FoldedContext)
  return (
    <div data-item-id={row.item.id} hidden={folded || undefined}>
      <Item
        item={row.item}
        sessionId={ctx.sessionId}
        cwd={ctx.cwd}
        byParent={ctx.byParent}
        leadsTurn={row.leadsTurn}
      />
    </div>
  )
}

/** Loose rows, and runs of tool calls folded behind one line.
 *
 *  Two callers, one shape: a turn's work in the transcript, and a subagent's
 *  entire nested transcript under a Task row. It reads nothing about either —
 *  no `.convo`, no turn, no item ids — which is the whole reason ToolItem could
 *  reuse it rather than growing a second renderer that folds differently.
 *
 *  A pure mapper — the grouping is groupRuns, in derive.mts, where it is
 *  checkable, and both callers memoise it. ToolRun is handed its rows already
 *  rendered because `Item` lives in this module; see the comment on ToolRun for
 *  why that direction. */
function Rows({ nodes, ctx }: { nodes: readonly WorkNode[]; ctx: RowCtx }): React.JSX.Element {
  return (
    <>
      {nodes.map((n) =>
        n.kind === 'row' ? (
          <RowItem key={n.row.item.id} row={n.row} ctx={ctx} />
        ) : (
          <ToolRun key={n.id} id={n.id} rows={n.rows} cwd={ctx.cwd}>
            {n.rows.map((r) => (
              <RowItem key={r.item.id} row={r} ctx={ctx} />
            ))}
          </ToolRun>
        ),
      )}
    </>
  )
}

/** The answer, and the turn's opening question. Never folded and never grouped —
 *  groupTurns guarantees a tail holds only assistant/result/error rows. */
function TailRows({ rows, ctx }: { rows: readonly Row[]; ctx: RowCtx }): React.JSX.Element {
  return (
    <>
      {rows.map((r) => (
        <RowItem key={r.item.id} row={r} ctx={ctx} />
      ))}
    </>
  )
}

/**
 * One turn: the question, a `Worked for 13s ⌄` header, and the answer.
 *
 * The header is the fold. Cursor puts everything between the question and the
 * answer behind it and leaves only the newest turn open, so scrolling back
 * through a session shows what was asked and what came back rather than every
 * file the agent read on the way. Clicking it opens that turn again.
 *
 * The counter is live while the turn is running and frozen at the SDK's own
 * `durationMs` afterwards — the header a finished turn keeps is the same element
 * that was ticking a moment earlier, which is why it is one component and not a
 * status line that gets replaced by a summary.
 */
function Turn({
  turn,
  nodes,
  sessionId,
  cwd,
  byParent,
  latest,
  startedAt,
}: {
  turn: TurnShape
  /** `turn.work` grouped into runs. Computed in Conversation, where it is
   *  checkable — see the `grouped` memo. */
  nodes: WorkNode[]
  sessionId: string
  cwd: string
  byParent: Map<string, ChatItem[]>
  latest: boolean
  /** Epoch ms the running turn began, or null when it is not running. */
  startedAt: number | null
}): React.JSX.Element {
  // Keyed off `latest` rather than set once: the newest turn is open, and it
  // stops being the newest the moment the next question is sent, at which point
  // it should fold on its own without the user being asked.
  const [open, setOpen] = useState(latest)
  useEffect(() => setOpen(latest), [latest])

  // The editor's gutter pointed at a row inside this turn, so it has to be
  // open for that row to exist at all. One-way, and it deliberately does not
  // fold again when the reveal clears.
  const reveal = useContext(RevealContext)
  const forceOpen = reveal?.turnId === turn.id
  useEffect(() => {
    if (forceOpen) setOpen(true)
  }, [forceOpen])

  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (startedAt === null) return
    const id = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(id)
  }, [startedAt])

  const elapsed = startedAt !== null ? Math.max(0, now - startedAt) : turn.durationMs
  // Nothing to fold means no header. A turn where the agent answered outright is
  // a question and an answer, and a "Worked for 0s" line above it is furniture.
  const header = turn.work.length > 0 && elapsed !== null

  const ctx: RowCtx = { sessionId, cwd, byParent }

  return (
    <>
      {turn.lead && <RowItem row={turn.lead} ctx={ctx} />}

      {header && (
        <button className="turn-head" aria-expanded={open} onClick={() => setOpen(!open)}>
          {/* Present tense while it runs, past once it lands — the same tense
              switch the tool rows use, and for the same reason: Cursor ships no
              spinner on any of this. */}
          {startedAt !== null ? 'Working for' : 'Worked for'} {hms(elapsed)}
          <ChevronDown size={12} className="turn-chevron" />
        </button>
      )}

      {(open || !header) && <Rows nodes={nodes} ctx={ctx} />}
      <TailRows rows={turn.tail} ctx={ctx} />
    </>
  )
}

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

/** Which verb is up: how many whole VERB_MS the turn has been running for.
 *
 *  Derived from the turn's start rather than counted from a mount, because
 *  `Working` is not remounted per session — a component that survived a tab
 *  switch, or that appeared halfway through a turn, still lands on the verb the
 *  turn is actually up to. A turn whose start has not arrived yet reads as tick
 *  0, which is reachable: main can flip the status one event before it sends the
 *  timestamp. */
function verbTick(startedAt: number | null): number {
  if (startedAt === null) return 0
  return Math.floor(Math.max(0, Date.now() - startedAt) / VERB_MS)
}

/**
 * "The agent is alive": bouncing dots and a rotating verb, and nothing else.
 *
 * The elapsed time, the token count and the effort label used to ride on the
 * right of this line. All three moved: the clock and the tokens to SessionMeter
 * in the pane header, where they are on screen whether or not the transcript is
 * scrolled to the bottom, and the effort nowhere — the composer's model picker
 * already renders it as a suffix on the model name, four pixels away.
 *
 * Still its own component so a verb change repaints one line rather than the
 * whole transcript. Nothing else on this line moves any more, so that is now one
 * render per minute rather than one per second.
 */
function Working({ session }: { session: SessionMeta }): React.JSX.Element {
  // turnStartedAt comes from main rather than a mount timestamp — see verbTick.
  const startedAt = session.turnStartedAt
  // Opt-out in Settings: the verbs are purely for fun, and the dots already say
  // everything functional. Nothing else on this line is timed, so switching them
  // off leaves no timer armed at all.
  const verbs = useStore((s) => s.prefs.workingVerbs)
  const [tick, setTick] = useState(() => verbTick(startedAt))

  useEffect(() => {
    // A new turn (or the missing timestamp finally landing) re-phases the
    // rotation, rather than carrying the previous turn's tick into this one.
    setTick(verbTick(startedAt))
    if (!verbs || startedAt === null) return
    // Re-armed against the wall clock on every fire instead of a flat interval:
    // a timer that ran late — a busy main thread, a throttled background window
    // — resyncs to the next boundary rather than carrying the lag for the rest
    // of the turn.
    let id: ReturnType<typeof setTimeout>
    const arm = (): void => {
      const elapsed = Math.max(0, Date.now() - startedAt)
      id = setTimeout(() => {
        setTick(verbTick(startedAt))
        arm()
      }, VERB_MS - (elapsed % VERB_MS))
    }
    arm()
    return () => clearTimeout(id)
  }, [verbs, startedAt])

  return (
    <div className="working">
      <span className="working-dots">
        <i />
        <i />
        <i />
      </span>
      {verbs ? workingVerb(session.id, tick) : 'Working'}
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

/**
 * One tool call, with a subagent's transcript folded under it when it has one.
 *
 * ITS OWN COMPONENT BECAUSE OF HOOKS. `Item` is a switch, and a useMemo in one
 * arm is a hook that does not run in the others — so the grouping either lives
 * here or is not memoised at all, and `byParent` is rebuilt on every streaming
 * delta.
 *
 * The nest gets THE SAME SHAPE AS THE TRANSCRIPT, through the same two
 * functions: transcriptRows drops the checklist events, groupRuns folds
 * consecutive calls behind one head. It used to get neither, so a subagent that
 * made forty-seven calls rendered forty-seven rows — the log-you-scroll that the
 * main transcript stopped being two folds ago.
 *
 * groupTurns is deliberately NOT applied, and that is verified rather than
 * assumed: only assistant, thinking and tool items carry a parentId (see
 * shared/types.ts), so a nest can hold no user message and no result. Every nest
 * is therefore exactly one lead-less, duration-less turn, and `Turn`'s header
 * gate can never fire on it — a useState, an effect and a RevealContext read
 * bought for a header that cannot render.
 *
 * `nest` is the summary of the WHOLE nest rather than of any one run inside it:
 * it is what the row says about the work while it is collapsed, so it counts a
 * sub-delegation as a step where a run head would refuse to. Null when there is
 * nothing to show at all, which is what keeps a Task whose only children were
 * checklist events from offering an empty body — see ToolLine's `nested`.
 */
function ToolItem({
  item,
  sessionId,
  cwd,
  byParent,
}: {
  item: Extract<ChatItem, { kind: 'tool' }>
  sessionId: string
  cwd: string
  byParent: Map<string, ChatItem[]>
}): React.JSX.Element {
  const kids = byParent.get(item.id)
  const rows = useMemo(() => transcriptRows(kids ?? EMPTY), [kids])
  const nodes = useMemo(() => groupRuns(rows), [rows])
  const nest = useMemo(() => (rows.length > 0 ? runSummary(rows) : null), [rows])
  const ctx: RowCtx = { sessionId, cwd, byParent }
  return (
    <ToolLine item={item} cwd={cwd} nest={nest}>
      {nest && <Rows nodes={nodes} ctx={ctx} />}
    </ToolLine>
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
  /** Session working directory, for shortening tool file paths. See ToolLine. */
  cwd: string
  byParent: Map<string, ChatItem[]>
  /** First assistant block of a turn — the one that gets the avatar. */
  leadsTurn?: boolean
}): React.JSX.Element | null {
  switch (item.kind) {
    case 'user':
      return (
        // Full column width now, not a right-aligned bubble. Cursor's user
        // message is a hairline card that spans the conversation column with its
        // controls tucked inside the right edge — the asymmetry that used to
        // come from `align-self: flex-end` comes from the card itself instead.
        /* The `data-queued` variant and its cancel button lived here. A queued
           message never reaches this component now — it is held in the store's
           `queued` slice and rendered by QueueTray above the composer, which is
           what stops it closing the running turn. So everything below is a
           message that has genuinely been sent. */
        <div className="msg-user">
          <div className="msg-user-body">
            {item.images?.map((src, i) => (
              <img key={i} className="msg-image" src={src} alt="attachment" />
            ))}
            {/* Rendered as markdown, matching the composer that now renders it
                live while you type. `thinking` and `error` stay literal. */}
            <Markdown text={item.text} />
          </div>
          {item.uuid && (
            // Inside the card, icon-only, and no longer absolutely positioned:
            // they used to hang below it at opacity 0 so they would not reserve
            // a blank line. In the right edge they cost nothing to leave
            // visible, which is what Cursor does with its restore glyph.
            <span className="msg-actions">
              <button
                className="msg-action"
                aria-label="Branch a new conversation from this point"
                data-tip="Branch a new conversation from this point"
                onClick={() => void useStore.getState().fork(item.uuid)}
              >
                <GitBranch size={12} />
              </button>
              <button
                className="msg-action"
                aria-label="Restore files to their state at this message"
                data-tip="Restore files to their state at this message"
                onClick={() => void useStore.getState().rewind(item.uuid!)}
              >
                <RotateCcw size={12} />
              </button>
            </span>
          )}
        </div>
      )
    case 'assistant':
      // Bare prose. The 16px avatar gutter and the ClaudeMark that opened each
      // turn are both gone: Cursor's assistant replies have no avatar, no bubble
      // and no gutter at all, so the reply starts at the same left edge as the
      // tool rows under it and the whole turn reads as one column of text.
      //
      // `leadsTurn` is still computed — the turn header uses it — it just no
      // longer decides whether to paint a mark.
      return (
        <div className="msg-assistant">
          <Markdown text={item.text} />
        </div>
      )
    case 'thinking':
      return <div className="msg-thinking">{item.text}</div>
    case 'tool':
      // Tools the user participated in get a compact record row instead of a
      // card — see RecordRow. They never have a subagent transcript to nest.
      if (toolRender(item.name) === 'record') return <RecordRow item={item} />
      // A Task card owns its subagent's whole transcript, nested — and ToolItem
      // shapes it the way the transcript shapes itself rather than mapping the
      // children straight through. The recursion survives the detour, because
      // ToolItem renders `Rows` and `Rows` render `Item`: a subagent that spawns
      // its own subagent still nests again for free.
      return <ToolItem item={item} sessionId={sessionId} cwd={cwd} byParent={byParent} />
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
