import { useEffect, useState } from 'react'
import type { SessionMeta } from '../../../shared/types'
import { fmt, hms, meterElapsed, sessionTokens } from '../derive.mts'

/** 1s, because the readout counts seconds. Matches Conversation's own tick. */
const TICK_MS = 1000

/**
 * The clock and the token count, in the pane header.
 *
 * ITS OWN COMPONENT FOR THE INTERVAL, the same argument BackgroundTasks and
 * Conversation's `Working` already make: a 1s tick in App would rebuild the
 * rail, the transcript, the composer and every open panel once a second to move
 * two numbers. Re-rendering a child never re-renders its parent, so the cost
 * stays in here.
 *
 * NON-INTERACTIVE ON PURPOSE — text and a `data-tip`, never a button. `.pane-head`
 * is the only drag region on the chat side of a frameless window, and anything
 * clickable in it has to opt out of dragging with `no-drag`, which would carve a
 * hole in the middle of the strip you use to move the window.
 *
 * What it replaced: the same two figures at the foot of the transcript, inside
 * `Working`, where they existed only while a turn was running and scrolled away
 * with it. Here they are always on screen — and the tip carries the running cost,
 * which the app has never shown outside the context card.
 *
 * Renders NOTHING until the first message is sent, because until then there is
 * no duration to report — see meterElapsed and SessionMeta.firstMessageAt.
 */
export default function SessionMeter({ session }: { session: SessionMeta }): React.JSX.Element | null {
  const [now, setNow] = useState(() => Date.now())
  // Armed only once there is a clock to move, the same shape as Turn's guard in
  // Conversation.tsx. `now` is re-read here rather than left at its mount value:
  // this component is mounted for the whole life of the pane, so by the time the
  // first message lands the state seeded at mount can be minutes stale — and
  // the first tick is a second away, which is a second of a visibly wrong figure.
  const armed = session.firstMessageAt !== null
  useEffect(() => {
    if (!armed) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(id)
  }, [armed])

  const running = session.turnStartedAt !== null
  const out = sessionTokens(session)
  const ms = meterElapsed(session, now)
  if (ms === null) return null
  const elapsed = hms(ms)

  return (
    <span
      className="meter"
      /* Three lines, the shape ContextRing's tip established. The first says
         WHICH duration the visible clock is showing, because the same digits
         mean two different things either side of a turn boundary. Cost is last
         and is the reason the tip exists at all.

         Cache tokens are deliberately absent: `inputTokens` already folds cache
         reads and cache writes into it (see inputTokensOf in main), so there is
         no separate figure to report without a new field on the wire. Context %
         is absent for the same kind of reason — the window size only arrives
         from the contextUsage poll the ring under the composer already owns, and
         a second poller for one line of hover text would double a control call
         that is measured taking longer than its own interval. */
      data-tip={[
        `${running ? 'This turn' : 'Session'} · ${elapsed}`,
        `${fmt(session.inputTokens)} in · ${fmt(out)} out`,
        `$${session.costUsd.toFixed(2)} so far`,
      ].join('\n')}
    >
      {elapsed} · {fmt(out)}
    </span>
  )
}
