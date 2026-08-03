import { useEffect } from 'react'

/**
 * Hold ⌘ for a moment and every control with a shortcut says what it is.
 *
 * The app has ⌘1–⌘4, ⌘, and ⌘N, and the only place any of them appeared was in
 * a tooltip you had to already be hovering — which means you had to know a
 * shortcut existed before you could find out what it was. A hold is the standard
 * answer (macOS itself, Figma, Linear) and costs nothing when you are not doing
 * it.
 */
const HOLD_MS = 400

/**
 * Paints `data-keys` on `<body>` while ⌘ is held, and nothing else.
 *
 * IMPERATIVE, NEVER REACT STATE, and on `document.body` rather than `.app`. App
 * renders SessionRail, an unmemoised Conversation and an unmemoised Composer, so
 * a state flip here is two full-tree re-renders per hold — on a 400-turn
 * transcript, to fade in six 11px labels. That is the same argument ScrollDown
 * and Tooltip already make for owning their own listeners. `.app` is out because
 * React reconciles `data-panel` on that element and would fight for the node.
 *
 * A separate listener from App's ⌘-shortcut handler on purpose: that one
 * early-returns `if (!e.metaKey) return`, so it can never see the plain keydown
 * that has to CANCEL a reveal.
 */
export function useKeyPeek(): void {
  useEffect(() => {
    let timer: number | null = null

    const clear = (): void => {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      delete document.body.dataset.keys
    }

    /** Nothing armed and nothing shown — the state every keystroke of ordinary
     *  typing is in, and the one where there is provably nothing to cancel. */
    const idle = (): boolean => timer === null && document.body.dataset.keys === undefined

    const onDown = (e: KeyboardEvent): void => {
      // ANY other key cancels — including the second half of a chord, which is
      // what stops ⌘1 leaving the caps painted over the panel it just opened.
      //
      // The `idle` test in front of it is what keeps this listener free in the
      // common case: this fires for every character typed into the composer, and
      // without it each one paid for a `delete` on a live DOM node's dataset.
      if (e.key !== 'Meta') {
        if (!idle()) clear()
        return
      }
      // Already armed or already showing: macOS repeats a held modifier on some
      // keyboards, and re-arming would restart the timer forever.
      if (e.repeat || !idle()) return
      timer = window.setTimeout(() => {
        timer = null
        document.body.dataset.keys = ''
      }, HOLD_MS)
    }

    const onUp = (e: KeyboardEvent): void => {
      if (e.key === 'Meta') clear()
    }

    // LOAD-BEARING, not defensive. On ⌘Tab macOS swallows the Tab keydown, so
    // the cancel-on-other-key rule never fires, and the Meta keyup is delivered
    // to whatever app you switched to — leaving the caps painted over a
    // background window until you come back and press something. Same for ⌘Space
    // and for the native folder dialog ⌘N opens.
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    window.addEventListener('blur', clear)
    return () => {
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
      window.removeEventListener('blur', clear)
      clear()
    }
  }, [])
}
