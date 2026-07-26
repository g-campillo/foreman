import { useEffect, useMemo, useRef } from 'react'
import type { ChatItem } from '../../../shared/types'
import { useStore } from '../store'
import ToolCard from './ToolCard'
import ApprovalCard from './ApprovalCard'
import ElicitationCard from './ElicitationCard'
import QuestionCard from './QuestionCard'
import PlanCard from './PlanCard'
import { askQuestions, planProposal } from '../derive.mts'
import Markdown from './Markdown'

export default function Conversation({ sessionId }: { sessionId: string }): React.JSX.Element {
  const items = useStore((s) => s.items[sessionId] ?? EMPTY)
  // Select the raw array and narrow in a memo — filtering inside the selector
  // returns a fresh array on every snapshot read, which zustand reads as a
  // changed store and spins into an infinite render loop.
  const status = useStore((s) => s.sessions.find((x) => x.id === sessionId)?.status)
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

  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)

  // Only autoscroll when the user is already at the bottom, so reading history
  // isn't yanked away mid-stream.
  useEffect(() => {
    const el = scroller.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [items, approvals, elicitations, rewindPreview])

  return (
    <div
      className="convo"
      ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
      }}
    >
      {roots.map((item) => (
        <Item key={item.id} item={item} sessionId={sessionId} byParent={byParent} />
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
      {status === 'running' && (
        <div className="working">
          <span className="working-dots">
            <i />
            <i />
            <i />
          </span>
          Working
        </div>
      )}
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
          Cancel
        </button>
        {result.canRewind && files.length > 0 && (
          <button className="btn" data-variant="danger" onClick={() => void confirmRewind()}>
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

function Item({
  item,
  sessionId,
  byParent,
}: {
  item: ChatItem
  sessionId: string
  byParent: Map<string, ChatItem[]>
}): React.JSX.Element | null {
  switch (item.kind) {
    case 'user':
      return (
        <div className="msg-user" data-queued={item.queued ? '' : undefined}>
          {item.images?.map((src, i) => (
            <img key={i} className="msg-image" src={src} alt="attachment" />
          ))}
          {item.text}
          {item.queued ? (
            <button
              className="queued-cancel"
              title="Cancel this queued message"
              onClick={() => void window.foreman.cancelQueued(sessionId, item.id)}
            >
              queued ✕
            </button>
          ) : (
            item.uuid && (
              // Branches into a new session sliced at this message — the
              // edit-and-retry shape, without disturbing this conversation.
              <span className="msg-actions">
                <button
                  className="branch-btn"
                  title="Branch a new session from this point"
                  onClick={() => void useStore.getState().fork(item.uuid)}
                >
                  ⑂ branch
                </button>
                <button
                  className="branch-btn"
                  title="Restore files to their state at this message"
                  onClick={() => void useStore.getState().rewind(item.uuid!)}
                >
                  ↺ rewind
                </button>
              </span>
            )
          )}
        </div>
      )
    case 'assistant':
      // User and thinking text stay literal on purpose: a prompt should read back
      // exactly as typed, and markdown headings inside the small italic thinking
      // block fight its styling.
      return (
        <div className="msg-assistant">
          <Markdown text={item.text} />
        </div>
      )
    case 'thinking':
      return <div className="msg-thinking">{item.text}</div>
    case 'tool':
      // A Task card owns its subagent's whole transcript, nested. Recursing on
      // Item means a subagent that spawns its own subagent nests again for free.
      return (
        <ToolCard item={item}>
          {byParent.get(item.id)?.map((child) => (
            <Item key={child.id} item={child} sessionId={sessionId} byParent={byParent} />
          ))}
        </ToolCard>
      )
    case 'error':
      return <div className="msg-error">{item.text}</div>
    case 'result':
      return (
        <div className="msg-result">
          {item.isError ? 'failed' : 'done'} · {(item.durationMs / 1000).toFixed(1)}s ·{' '}
          ${item.costUsd.toFixed(4)}
        </div>
      )
    default:
      return null
  }
}
