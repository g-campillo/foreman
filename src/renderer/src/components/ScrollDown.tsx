import { useEffect, useState } from 'react'
import { ArrowDown } from 'lucide-react'

/**
 * How far off the bottom still counts as "following the agent".
 *
 * One number, exported through atBottom, because three things now read it: the
 * autoscroll that only fires while pinned, this button's visibility, and a run
 * expanding under a pinned transcript (see ToolRun). Two thresholds would give
 * a run that scrolls to the bottom while the arrow says you are not there.
 */
const PIN_SLACK = 60

/** Whether a scroller is close enough to its end to be following it. */
export function atBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < PIN_SLACK
}

/**
 * The jump-to-newest arrow, floating over the bottom of the transcript.
 *
 * A LEAF THAT OWNS BOTH THE LISTENER AND THE STATE, which is the whole reason
 * it is a component rather than four lines in Conversation. `pinned` is a ref
 * precisely so scrolling causes no re-render; a `useState` in Conversation would
 * walk every Turn → Rows → Item → ToolLine — none of which are memoised — at the
 * exact moment the user's finger is on the trackpad. Down here a flip repaints
 * one 28px button.
 *
 * It writes both: the shared ref Conversation's autoscroll reads, and its own
 * visibility. One measurement, so the arrow and the autoscroll can never
 * disagree about whether the user is following along.
 *
 * Always mounted, opacity-toggled. Mounting it conditionally would change
 * `scrollHeight` right at the threshold, so dismissing the arrow would need
 * ~47px more scroll than summoning it did — see theme.css for the two other
 * traps in that rule.
 */
export default function ScrollDown({
  scroller,
  pinned,
}: {
  scroller: React.RefObject<HTMLDivElement | null>
  /** Shared with Conversation's autoscroll effect. Written here, read there. */
  pinned: React.RefObject<boolean>
}): React.JSX.Element {
  const [show, setShow] = useState(false)

  useEffect(() => {
    const el = scroller.current
    if (!el) return
    /* The SCROLL HANDLER IS THE ONLY WRITER of `pinned`, exactly as the inline
       one it replaced was. That matters at mount: `pinned` starts true so a
       session opened with a long history lands at the bottom, and a measurement
       taken before that first autoscroll would say "not following" and cancel
       it. */
    const onScroll = (): void => {
      const at = atBottom(el)
      pinned.current = at
      setShow(!at)
    }
    // Passive: this never calls preventDefault, and saying so keeps the handler
    // off the compositor's critical path during a flick.
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refs, stable for life
  }, [])

  /* Recomputed after every render, which is what covers the things that move
     the bottom without a scroll event: content growing, and the pane being
     resized. No dependency array on purpose — Conversation re-renders on every
     streaming delta, so this runs exactly when it needs to, and a setState to
     the value it already holds bails out rather than looping.

     THE FRESH MEASUREMENT DECIDES, alone. This used to also require
     `!pinned.current`, to spare one frame of arrow at mount before the first
     autoscroll runs — but `pinned` only changes on a scroll event, so a stale
     `true` (drag the pane wider, the column reflows taller, nothing scrolls)
     suppressed the arrow at the exact moment it was the only way back. A frame
     of a 0.12s fade is ~13% opacity; being unable to return to the newest output
     is not a trade. */
  useEffect(() => {
    const el = scroller.current
    if (el) setShow(!atBottom(el))
  })

  return (
    <button
      className="btn scroll-down"
      data-show={show ? '' : undefined}
      // Out of every cursor while invisible, not just the mouse's:
      // `pointer-events: none` stops the pointer, `tabIndex` the keyboard, and
      // `aria-hidden` a screen reader's virtual cursor, which would otherwise
      // find "Jump to the newest output" sitting at opacity 0.
      tabIndex={show ? undefined : -1}
      aria-hidden={show ? undefined : true}
      aria-label="Jump to the newest output"
      onClick={() => {
        const el = scroller.current
        if (el) el.scrollTop = el.scrollHeight
      }}
    >
      <ArrowDown size={14} />
    </button>
  )
}
