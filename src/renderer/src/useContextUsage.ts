import { useCallback, useEffect, useRef, useState } from 'react'
import type { ContextUsage, SessionMeta } from '../../shared/types'
import { contextView, type ContextView } from './derive.mts'

/** How often to re-poll the breakdown while a turn is in flight. */
const POLL_MS = 10_000

/**
 * One applied poll, with the two facts that decide whether it may be applied at
 * all and whether it may be believed yet.
 */
interface Reading {
  usage: ContextUsage
  /** Request number that produced it. Monotonic — see the recency guard. */
  seq: number
  /** Value of the turn counter when the request was ISSUED, not when it landed. */
  turn: number
}

/**
 * This session's context pressure: the polled breakdown, plus the live level
 * main pushes on every request.
 *
 * A hook rather than state inside the ring, because the ring and the card it
 * opens are siblings — the ring sits under the composer and the card floats
 * above it, so neither can own the fetch for the other. The session panel uses
 * the same one, so the two views of one window agree by construction rather
 * than by two poll timers happening to line up.
 *
 * WHAT CHANGED, and why: this used to fire exactly one IPC call, gated on
 * `status === 'idle'`. So the ring only ever moved at turn boundaries — the one
 * moment nobody is watching it — and read as frozen for the whole of every turn,
 * which is the entire duration anyone cares how full the window is. It now
 * fetches on both edges and keeps polling while the turn runs, and `contextView`
 * shows `meta.contextTokens` in the meantime, which needs no call at all.
 */
export function useContextUsage(
  session: SessionMeta,
  enabled = true,
): { view: ContextView | null; ctx: ContextUsage | null; refresh: () => Promise<void> } {
  const [reading, setReading] = useState<Reading | null>(null)
  const timer = useRef<number>(0)
  /** Issued requests, ever. The recency guard's clock. */
  const seq = useRef(0)

  /* CLEARED DURING RENDER, not in an effect. <Composer> and <SessionPanel> are
     both rendered UNKEYED — App.tsx mounts one of each for whichever session is
     selected — so without this an idle session A's breakdown stays on screen
     underneath a running session B, and the ring reports the wrong window with
     no indication anything is stale.

     Keying the components by session.id would fix it too, and would throw away
     the composer's draft text, its attachments and the caret on every tab
     switch. A render-phase reset is React's own documented answer to exactly
     this, and it costs one extra render on switch rather than a remount. */
  const shown = useRef(session.id)
  if (shown.current !== session.id) {
    shown.current = session.id
    if (reading !== null) setReading(null)
  }

  const idle = session.status === 'idle'

  /* The turn counter, bumped on every transition INTO idle.

     DURING RENDER, deliberately, like the reset above. The render that first
     sees `idle` is the render that would otherwise draw the pre-turn total, so
     a counter bumped one effect later is exactly one frame too late — and one
     frame is all the dip below needs to be visible. */
  const wasIdle = useRef(idle)
  const turn = useRef(0)
  if (idle !== wasIdle.current) {
    wasIdle.current = idle
    if (idle) turn.current += 1
  }

  const refresh = useCallback((): Promise<void> => {
    const id = session.id
    const n = ++seq.current
    const at = turn.current
    return window.foreman
      .contextUsage(id)
      .then((u) => {
        setReading((prev) => {
          // Three guards, and they answer three different questions.
          //
          // `u` falsy is a transient null — the session tearing down, an SDK
          // hiccup — and the last good reading beats blanking the gauge.
          //
          // The id test drops a reply for a session we have since left, which
          // the render-phase reset above has already cleared.
          //
          // THE SEQ TEST IS RECENCY, which neither of the others is. Replies can
          // land out of order: getContextUsage is a control call against a busy
          // CLI and has been measured taking longer than the poll interval, so
          // poll n can settle after poll n+1 and overwrite a newer breakdown
          // with an older one — the ring visibly stepping backwards.
          if (!u || shown.current !== id) return prev
          if (prev && prev.seq > n) return prev
          return { usage: u, seq: n, turn: at }
        })
      })
      .catch(() => {})
  }, [session.id])

  const status = session.status
  const busy = status === 'running' || status === 'awaiting-approval'

  useEffect(() => {
    if (!enabled) return
    // BOTH edges of a turn, where this used to fire on the trailing one only.
    // The leading edge is what puts a breakdown behind the estimate before the
    // first assistant message lands.
    void refresh()
    // Only an in-flight turn needs a clock. A settled session — idle, starting,
    // or errored — cannot change its own occupancy, and polling an errored one
    // forever would be a control call every ten seconds against a session that
    // will never answer differently.
    if (!busy) return
    let live = true
    // CHAINED OFF THE REQUEST, not off a fixed interval — the DiffPanel shape.
    // Scheduling the next tick before the current one settles is a setInterval
    // wearing a setTimeout's clothes: on a CLI where this call takes longer than
    // POLL_MS the requests pile up one per interval forever.
    const tick = (): void => {
      void refresh().finally(() => {
        if (live) timer.current = window.setTimeout(tick, POLL_MS)
      })
    }
    timer.current = window.setTimeout(tick, POLL_MS)
    return () => {
      live = false
      window.clearTimeout(timer.current)
    }
  }, [enabled, status, busy, refresh])

  /* THE TURN-END DIP, and the whole reason `turn` exists.

     `status` flips to idle the instant the result lands, but the poll that
     reflects the turn has not been issued yet, let alone answered. Handing raw
     `idle` to contextView would therefore swap the estimate — which is correct
     and current — for a breakdown fetched BEFORE the turn ran, so the ring steps
     down to the pre-turn total for one round trip and then jumps back up. A
     visible regression in exactly the feel this change exists to produce.

     So the poll is only believed once one issued AFTER the turn ended has
     landed. A poll that fails or returns null leaves this false and the estimate
     on screen, which is the honest fallback: it is the freshest figure we have. */
  const settled = idle && reading !== null && reading.turn === turn.current

  return {
    view: contextView(reading?.usage ?? null, session.contextTokens, settled),
    ctx: reading?.usage ?? null,
    refresh,
  }
}
