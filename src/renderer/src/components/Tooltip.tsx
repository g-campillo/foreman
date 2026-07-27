import { useEffect, useRef } from 'react'

/** Bubble-to-control gap, and the smallest bubble-to-window margin. */
const GAP = 7
const EDGE = 8

/**
 * The one tooltip. Every `data-tip` in the app is read by this single element.
 *
 * What this replaces was two pseudo-elements on the control itself, with no
 * component and no JS — cheaper, and the right shape right up until it met
 * `.pane { overflow: hidden }`. The rail is ~244px and a bubble is up to 240px,
 * so a footer button lost nearly half its tip, and the Session tab's ran off the
 * right of the chat pane. `position: fixed` cannot rescue a pseudo-element
 * either: .glass's backdrop-filter makes every pane the containing block for its
 * fixed descendants, so the pane's own overflow still clips them. Rendering at
 * .app level is the only escape, and it is the one Settings and the command
 * palette already take.
 *
 * Imperative rather than React state, for the same reason App.tsx gives about
 * the seam drag: pointerover fires at pointermove frequency, and a re-render per
 * hover would rebuild the conversation, the diff panel and the terminal for it.
 */
export default function Tooltip(): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const tip = ref.current
    if (!tip) return
    let cur: HTMLElement | null = null

    // Arrow consts declared after the null guard, not hoisted `function`
    // declarations: a hoisted body is visible before the guard runs, so TS drops
    // the narrowing and every `tip` inside becomes possibly-null. `show` refers
    // to `watch` below it, which is legal because it only runs from an event.
    const hide = (): void => {
      if (!cur) return
      cur = null
      watch.disconnect()
      delete tip.dataset.show
    }

    const place = (el: HTMLElement): void => {
      const text = el.dataset.tip
      if (!text) return hide()
      tip.textContent = text
      delete tip.dataset.below
      // Measure at natural width before positioning. One forced reflow per
      // hover-enter — not per frame, which is the whole reason none of this is
      // React state.
      tip.style.left = '0px'
      tip.style.top = '0px'
      tip.dataset.show = ''

      const box = el.getBoundingClientRect()
      const self = tip.getBoundingClientRect()
      const below = box.top - self.height - GAP < EDGE
      const cx = box.left + box.width / 2
      const x = Math.min(
        Math.max(cx - self.width / 2, EDGE),
        window.innerWidth - self.width - EDGE,
      )

      if (below) tip.dataset.below = ''
      tip.style.left = `${Math.round(x)}px`
      tip.style.top = `${Math.round(below ? box.bottom + GAP : box.top - self.height - GAP)}px`
      // Where the arrow goes once the bubble has been clamped against a window
      // edge. The pseudo-element version had no way to know, so a clamped bubble
      // pointed at nothing.
      tip.style.setProperty('--tip-ax', `${Math.round(cx - x)}px`)
    }

    const show = (el: HTMLElement): void => {
      if (el === cur) return
      cur = el
      watch.disconnect()
      watch.observe(el, { attributeFilter: ['data-tip'] })
      place(el)
    }

    // Some tips change while the pointer is still on them: Markdown's copy
    // button flips to "Copied" as its click feedback, and the composer's send
    // button flips to "Queue this message" on its own the moment a turn starts.
    // attr() re-read that for free; a singleton has to be told.
    const watch = new MutationObserver(() => {
      if (cur) place(cur)
    })

    const near = (t: EventTarget | null): HTMLElement | null => {
      const el = t instanceof Element ? t.closest('[data-tip]') : null
      return el instanceof HTMLElement ? el : null
    }

    const onOver = (e: PointerEvent): void => {
      const el = near(e.target)
      if (el) show(el)
      else hide()
    }
    // A null relatedTarget means the pointer left the window outright, and no
    // pointerover will follow to clear the bubble.
    const onOut = (e: PointerEvent): void => {
      if (!e.relatedTarget) hide()
    }
    // :focus-visible, matching what this replaces. A click already has the
    // pointer path, and a mouse-focused button should not sprout a bubble.
    const onFocus = (e: FocusEvent): void => {
      const el = near(e.target)
      if (el?.matches(':focus-visible')) show(el)
    }
    // Only clear a bubble that belongs to the element being blurred. A blanket
    // hide looks right and isn't: clicking any control blurs whatever had focus,
    // so hovering the copy button and clicking it would hide the bubble a
    // moment before it flips to "Copied", and the feedback would never be seen.
    const onBlur = (e: FocusEvent): void => {
      if (cur && cur === near(e.target)) hide()
    }
    // A trigger that unmounts under the pointer — archive a session, dismiss the
    // notice, cancel a queued message, close the panel — fires no pointerout, so
    // the bubble would hang over an element that no longer exists. Deliberately
    // NOT a blanket hide-on-click: that would kill the copy button's "Copied".
    const onDown = (): void => {
      requestAnimationFrame(() => {
        if (cur && !cur.isConnected) hide()
      })
    }

    // Capture, for scroll: the bubble is fixed and the trigger is not, so any
    // scroller in the tree moving out from under it has to drop the bubble.
    window.addEventListener('pointerover', onOver)
    window.addEventListener('pointerout', onOut)
    window.addEventListener('focusin', onFocus)
    window.addEventListener('focusout', onBlur)
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', hide)
    window.addEventListener('resize', hide)
    window.addEventListener('scroll', hide, true)
    return () => {
      watch.disconnect()
      window.removeEventListener('pointerover', onOver)
      window.removeEventListener('pointerout', onOut)
      window.removeEventListener('focusin', onFocus)
      window.removeEventListener('focusout', onBlur)
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', hide)
      window.removeEventListener('resize', hide)
      window.removeEventListener('scroll', hide, true)
    }
  }, [])

  return <div className="tip" ref={ref} aria-hidden="true" />
}
