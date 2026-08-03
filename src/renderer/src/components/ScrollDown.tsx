import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowDown } from 'lucide-react'

/**
 * How far off the bottom still counts as "following the agent".
 *
 * One number, exported through atBottom, because four things now read it: the
 * autoscroll that only fires while pinned, this button's visibility, a run
 * expanding under a pinned transcript (see ToolRun), and a capped subagent nest
 * following its own tail (see useTailPin). Two thresholds would give a run that
 * scrolls to the bottom while the arrow says you are not there.
 *
 * THIS MODULE IS THE PIN MODULE, which is why the second scrollport's hook lives
 * here rather than in a file of its own: a second file is a second threshold
 * within a week.
 */
const PIN_SLACK = 60

/** Whether a scroller is close enough to its end to be following it. */
export function atBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < PIN_SLACK
}

/**
 * Keep a scrollport stuck to its tail while it streams — `.convo`'s contract,
 * for the one other scrollport in the app.
 *
 * A capped subagent nest (see `.tool-nest`) scrolls itself. It has to: the
 * transcript's autoscroll writes `.convo.scrollTop`, and a nest with its own
 * overflow does not move when its parent does. That is exactly why the cap was
 * removed once before — the nest became a second scrollport that NOTHING EVER
 * SCROLLED, and a streaming subagent sat frozen on its opening lines. What was
 * missing was never the cap; it was this.
 *
 * A CALLBACK REF, not a ref plus a `[]` effect. The node mounts long after the
 * component that owns it — it exists only while the row is expanded — so a
 * mount-keyed effect would attach its listener to null and never try again.
 * Detach is the other half of the deal: re-expanding a row re-arms the pin, and
 * in a scrollport with no jump-to-newest arrow that is the only way back to the
 * tail once you have scrolled off it.
 *
 * PIN SEMANTICS ARE `.convo`'S, EXACTLY: the scroll handler is the only writer,
 * and it writes on every event, so scrolling back down re-pins rather than
 * releasing for good. Anything looser would strand a nest the user scrolled up
 * in, given there is no arrow down here to un-strand it with.
 */
export function useTailPin<T extends HTMLElement>(): (node: T | null) => (() => void) | void {
  const el = useRef<T | null>(null)
  const pinned = useRef(true)

  const ref = useCallback((node: T | null) => {
    el.current = node
    // React 19 takes the cleanup below instead of calling back with null, so
    // this branch is the older contract, kept because it costs one line and the
    // handler leaking would be silent.
    if (!node) return
    // Freshly mounted is freshly following, whatever the last incarnation of
    // this node was doing when it went away. See above: this is the escape
    // hatch, not an initialisation detail.
    pinned.current = true
    const onScroll = (): void => {
      pinned.current = atBottom(node)
    }
    // Passive, for the same reason the transcript's is: nothing here calls
    // preventDefault, and saying so keeps the handler off the compositor's
    // critical path during a flick.
    node.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      el.current = null
      node.removeEventListener('scroll', onScroll)
    }
  }, [])

  /* After every render of the owner, which is what catches content growing —
     the case there is no scroll event for. No dependency array on purpose: the
     owner re-renders on every streaming delta, so this runs precisely when the
     nest got taller.

     THE ZERO GUARD IS NOT OPTIONAL. An element inside a `content-visibility:
     auto` ancestor that is scrolled out of view generates no boxes at all, so it
     reports `scrollHeight: 0` — and the Task's own [data-item-id] wrapper is
     exactly such an ancestor. Writing that would silently rewind the nest to its
     first line while nobody was looking at it, and the user would find it there
     on the way back. */
  useEffect(() => {
    const node = el.current
    if (!node || !pinned.current) return
    if (node.scrollHeight === 0) return
    node.scrollTop = node.scrollHeight
  })

  return ref
}

/**
 * The scroll container a row lives in: the transcript, or the OUTERMOST subagent
 * nest above it.
 *
 * `closest('.convo')` is what this replaced, and it was right until a nest could
 * scroll — a run expanding inside an open subagent has to measure and move the
 * nest, not the transcript behind it. But `closest('.tool-nest, .convo')` would
 * be worse than either, because a nest inside a nest is NOT a scrollport: only
 * the outermost one is capped (see `.tool-nest .tool-nest`), so the nearest
 * match can be an element with nothing to scroll, and the caller would silently
 * do nothing. Hence the full climb, keeping the last nest it passed.
 */
export function scrollportOf(el: Element): HTMLElement | null {
  let nest: HTMLElement | null = null
  for (let node = el.parentElement; node; node = node.parentElement) {
    if (node.classList.contains('tool-nest')) nest = node
    else if (node.classList.contains('convo')) return nest ?? node
  }
  return nest
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
    /* THE SCROLLPORT ITSELF CAN CHANGE SIZE WITH NO SCROLL EVENT AND NO RENDER
       OF CONVERSATION, and that is not hypothetical: opening the checklist
       takes ~120px out of `.convo`'s flex height, and the fold lives in
       `todoFold`, which only TodoStrip subscribes to. So the effect below never
       runs, `pinned` stays a stale true, the reader is left 120px off the
       bottom and the arrow that would take them back does not appear. On a
       running session the next delta heals it; ON AN IDLE ONE IT NEVER DOES.

       Reads the pin rather than re-measuring it: a shorter viewport moves the
       bottom, it does not mean the user scrolled. Net observer count across the
       app is unchanged — TodoStrip's `--todos-h` one went away with the move. */
    const ro = new ResizeObserver(() => {
      if (pinned.current) el.scrollTop = el.scrollHeight
      else setShow(!atBottom(el))
    })
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', onScroll)
      ro.disconnect()
    }
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
