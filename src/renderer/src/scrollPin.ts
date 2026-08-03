/**
 * A one-shot "scroll to the bottom on the next frame that draws" latch.
 *
 * Sending while scrolled up into history did nothing: Conversation's autoscroll
 * only fires while `pinned` is true, and `pinned` is only ever written by a real
 * scroll event. So the message you just sent landed off screen.
 *
 * A MODULE-LEVEL LATCH, exactly like composerBox above it, and not a zustand
 * nonce. A counter bumped at the moment of sending re-runs the effect
 * IMMEDIATELY and scrolls to the OLD bottom — the user's own message has not
 * arrived yet, it comes back over `onItem` a round-trip later. By the time it
 * does, the nonce has not moved, `pinned` is still false, and nothing happens.
 * Every fix for that degenerates into this latch plus a store write and a
 * transcript re-render per send.
 *
 * Nor is it a write to `pinned.current` directly: ScrollDown declares in a
 * docblock that its scroll handler is that ref's ONLY writer, and the invariant
 * is load-bearing at mount — `pinned` starts true so a session with a long
 * history opens at the bottom, and a second writer would make that unreadable.
 *
 * SET IT WHEN THE USER'S OWN WORDS ENTER THE TRANSCRIPT OF THE SESSION ON
 * SCREEN, and only then. There is exactly one setter, and it is the store's
 * `onQueue` handler on the 'started' edge — the moment a message actually leaves
 * the input queue and lands in `items`.
 *
 * It used to be the composer's `submit()`, which was wrong in both directions
 * once queued messages stopped entering the transcript: on a busy session
 * nothing appeared at the bottom to scroll to, so the pin only stole the
 * reader's place in the running answer. Moving it to the event costs one thing —
 * `submit()` was inherently about the visible session and a global event handler
 * is not, so the setter has to check `activeId` itself, or a background agent
 * dequeuing its own message yanks the transcript you are reading.
 *
 * Not on an approval or a plan approve: nothing of the user's is added there,
 * and yanking history away mid-stream is precisely what the `pinned` guard
 * exists to prevent.
 */
export const scrollPin = { current: false }

export const pinToBottom = (): void => {
  scrollPin.current = true
}

/**
 * The same latch for SWITCHING conversations: which session still owes a scroll
 * to its newest message.
 *
 * A module latch for the reason above, and a second one rather than a second
 * setter of `scrollPin` because the two are spent on different conditions.
 * `scrollPin` is a single frame's worth of "you just sent something"; this one
 * is owed until a write actually moves the scroller, which can be several
 * frames — an asleep session's transcript arrives as `items: []` and is
 * replaced wholesale a round-trip later, and `content-visibility: auto` makes
 * `scrollHeight` an ESTIMATE on the switch frame, so the first write lands
 * short of the real bottom.
 *
 * A SESSION ID, not a boolean: Conversation is rendered unkeyed, so on the
 * switch frame its effect can still be running for the session being left. The
 * id makes the debt name its creditor.
 *
 * NOT ONE-SHOT for the same reason it is not a boolean — see Conversation's
 * settle loop, which is what clears it.
 */
export const switchPin = { current: null as string | null }

export const pinNewest = (sessionId: string | null): void => {
  switchPin.current = sessionId
}
