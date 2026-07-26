import { useEffect, useMemo, useRef } from 'react'
import type { ChatItem } from '../../../shared/types'
import { useStore } from '../store'
import ToolCard from './ToolCard'
import ApprovalCard from './ApprovalCard'
import ElicitationCard from './ElicitationCard'
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
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)

  // Only autoscroll when the user is already at the bottom, so reading history
  // isn't yanked away mid-stream.
  useEffect(() => {
    const el = scroller.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [items, approvals, elicitations])

  return (
    <div
      className="convo"
      ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
      }}
    >
      {items.map((item) => (
        <Item key={item.id} item={item} sessionId={sessionId} />
      ))}
      {approvals.map((a) => (
        <ApprovalCard key={a.requestId} req={a} />
      ))}
      {elicitations.map((e) => (
        <ElicitationCard key={e.requestId} req={e} />
      ))}
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

function Item({
  item,
  sessionId,
}: {
  item: ChatItem
  sessionId: string
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
              <button
                className="branch-btn"
                title="Branch a new session from this point"
                onClick={() => void useStore.getState().fork(item.uuid)}
              >
                ⑂ branch
              </button>
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
      return <ToolCard item={item} />
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
