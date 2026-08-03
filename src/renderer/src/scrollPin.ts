/**
 * A one-shot "scroll to the bottom on the next frame that draws" latch.
 *
 * Sending while scrolled up into history did nothing: Conversation's autoscroll
 * only fires while `pinned` is true, and `pinned` is only ever written by a real
 * scroll event. So the message you just sent landed off screen.
 *
 * A MODULE-LEVEL LATCH, exactly like composerBox above it, and not a zustand
 * nonce. Bumping a counter in `submit()` re-runs the effect IMMEDIATELY and
 * scrolls to the OLD bottom — the user's own message has not arrived yet, it
 * comes back over `onItem` a round-trip later. By the time it does, the nonce has
 * not moved, `pinned` is still false, and nothing happens. Every fix for that
 * degenerates into this latch plus a store write and a transcript re-render per
 * send.
 *
 * Nor is it a write to `pinned.current` directly: ScrollDown declares in a
 * docblock that its scroll handler is that ref's ONLY writer, and the invariant
 * is load-bearing at mount — `pinned` starts true so a session with a long
 * history opens at the bottom, and a second writer would make that unreadable.
 *
 * Set it when the USER'S OWN WORDS enter the transcript, and only then. Not on
 * an approval or a plan approve: nothing of theirs is added there, and yanking
 * history away mid-stream is precisely what the `pinned` guard exists to prevent.
 */
export const scrollPin = { current: false }

export const pinToBottom = (): void => {
  scrollPin.current = true
}
