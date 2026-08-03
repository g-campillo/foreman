import { useEffect, useRef, useState } from 'react'

/**
 * How long a closing modal stays mounted. Must be >= the longest exit
 * transition built on --dur-2 in theme.css, and it is deliberately a NUMBER here
 * rather than read back out of the computed style: parsing a custom property to
 * decide when to unmount would make the unmount depend on the stylesheet having
 * loaded, and the failure mode is a modal that never leaves the DOM.
 *
 * Reduce Motion collapses --dur-2 to 1ms, so the transition is over long before
 * this fires — the extra frames are invisible, not wrong.
 */
const EXIT_MS = 180

/** What lands on the scrim as `data-state`. Exported because every modal that
 *  takes one has to name the type of the prop it forwards. */
export type PresenceState = 'open' | 'closed'

/**
 * Keeps open-gated content mounted for the length of its exit transition.
 *
 * Every modal in the app is `{cond && <X/>}`, which is why none of them have
 * ever animated out: the element is gone on the frame the flag flips, and there
 * is nothing left to transition. `@starting-style` solves entry with no JS at
 * all and does nothing for exit, because exit needs the element to still exist.
 *
 * `state` is what the CSS keys off — the caller spreads it onto its scrim as
 * `data-state`, and theme.css styles `[data-state='closed']` as the end pose.
 * The open state is written one frame LATE on purpose: a mount already carrying
 * `data-state='open'` has nothing to transition from, so the enter would pop.
 *
 * A timer rather than `transitionend`: the scrim and the modal transition
 * different properties over the same window, `transitionend` fires once per
 * property, and a transition that never starts (a display:none ancestor, a
 * cancelled interruption) never fires it at all — which would strand the modal
 * mounted forever. The timer cannot fail that way.
 */
export function usePresence(open: boolean): { mounted: boolean; state: PresenceState } {
  const [mounted, setMounted] = useState(open)
  /* 'closed' even when `open` is already true on the first render, so a modal
     that mounts open still animates IN — PlanCard and QuestionCard both do
     exactly that, appearing the moment their request arrives. The effect below
     flips it two frames later, which is the same path a later open takes. */
  const [state, setState] = useState<PresenceState>('closed')
  const timer = useRef<number | null>(null)

  useEffect(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
    }
    if (open) {
      setMounted(true)
      // Two frames, not one. A single rAF still lands in the same frame the
      // element is first painted in on some Chromium paths, and the browser
      // then has no earlier value to interpolate from.
      let live = true
      requestAnimationFrame(() => {
        if (live) requestAnimationFrame(() => live && setState('open'))
      })
      return () => {
        live = false
      }
    }
    setState('closed')
    timer.current = window.setTimeout(() => {
      timer.current = null
      setMounted(false)
    }, EXIT_MS)
    return
  }, [open])

  // Unmounting mid-exit must not leave a timer holding a setState on a dead
  // component. Separate from the effect above so it runs only on teardown.
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current)
    },
    [],
  )

  return { mounted, state }
}
