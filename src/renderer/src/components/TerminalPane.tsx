import { useEffect, useRef } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { SessionMeta } from '../../../shared/types'
import { useStore } from '../store'
import { raw, token, vars } from '../tokens'

function termTheme(): ITheme {
  const css = vars()
  return {
    // Fully transparent, so .term-host's own translucent fill is what you see
    // and the terminal sits on the same glass as everything else. The window is
    // transparent again — this is the condition that justified transparency
    // here in the first place, and painting an opaque --bg over a translucent
    // host would put a solid black rectangle in the middle of the app.
    //
    // Note these are legacy comma-form rgb() strings, not CSS Color 4. That is
    // `token()`'s doing and it is load-bearing: xterm parses colours itself and
    // does not understand the space-separated `rgb(240 240 240 / .35)` syntax
    // the rest of this codebase stores tokens in.
    background: 'rgba(0,0,0,0)',
    foreground: token(css, '--text'),
    cursor: token(css, '--accent'),
    // Neutral, not accent. --accent is near-white now, so an accent selection
    // at 35% washed the selected text out instead of marking it.
    selectionBackground: token(css, '--text', 0.22),
  }
}

interface Slot {
  term: Terminal
  fit: FitAddon
  started: boolean
}

/**
 * Terminals live outside React, keyed by session, so switching sessions or tabs
 * re-attaches the same instance instead of dropping its scrollback.
 */
const slots = new Map<string, Slot>()

/** How fast the second Escape has to land to close the modal. Long enough to be
 *  reachable, short enough that Esc-to-normal-mode then Esc a second later — two
 *  separate intentions — is not read as one gesture. */
const ESC_DOUBLE_MS = 500

function slotFor(session: SessionMeta): Slot {
  const existing = slots.get(session.id)
  if (existing) return existing

  const term = new Terminal({
    // Back on, with eyes open. It genuinely costs something — xterm composites
    // every cell against what is behind it instead of blitting an opaque
    // background — but it is the only way the glass reaches the terminal, and
    // the glass is the point now.
    allowTransparency: true,
    // Read from the token rather than repeated as a literal. The duplicate that
    // used to live here was a second copy of --mono with no link to the first,
    // so changing the token silently left the terminal on the old stack.
    fontFamily: raw(vars(), '--mono'),
    fontSize: 12,
    lineHeight: 1.25,
    cursorBlink: true,
    scrollback: 10000,
    theme: termTheme(),
  })
  const fit = new FitAddon()
  term.loadAddon(fit)

  // Registered once per terminal, not once per mount, or keystrokes double up.
  term.onData((data) => void window.foreman.writePty(session.id, data))
  term.onResize(({ cols, rows }) => void window.foreman.resizePty(session.id, cols, rows))

  // Escape belongs to the shell, not to the modal above it — until you press it
  // twice.
  //
  // TerminalModal registers the same bare-window Escape listener FileModal does,
  // and that is only safe THERE because Monaco calls stopPropagation() on keys
  // it handles. xterm does not — so without this, Escape inside vim, less, htop
  // or a readline vi-mode prompt would tear down the terminal instead of
  // reaching the program.
  //
  // So the FIRST Escape behaves exactly as it always has: stopPropagation(),
  // return true, and the ESC goes down the pty unchanged while the bubble to
  // window is cut. xterm's own typings name this as the intended use —
  // "allowing consumers to stop propagation ... returns whether the event should
  // be processed by xterm.js".
  //
  // A SECOND Escape within ESC_DOUBLE_MS returns **false**, and false rather
  // than true is the deliberate half. xterm bails on a false handler before any
  // pty write and without calling preventDefault/stopPropagation, so the event
  // bubbles to window, TerminalModal closes — and the shell never sees the
  // stray ESC. With `true` the shell would get it, and oh-my-zsh's `sudo` plugin
  // (bound to `\e\e`) would silently rewrite a half-typed line to `sudo <line>`
  // on the way out.
  //
  // Deliberately NOT a `buffer.active.type === 'alternate'` test. That detects
  // full-screen TUIs and misses exactly the two cases that bite: `fzf --height`
  // and shell vi-mode both read Escape in the NORMAL buffer, so it would fail in
  // the direction that destroys work. Nothing is lost to a stray double-tap
  // either: the pty is never killed from the renderer and the scrollback lives
  // in `slots`, so ⌘2 brings the same shell — and the same vim — straight back.
  let lastEsc = 0
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== 'keydown') return true
    if (ev.key !== 'Escape') {
      lastEsc = 0 // only a *consecutive* pair closes; typing in between resets
      return true
    }
    const now = Date.now()
    if (now - lastEsc < ESC_DOUBLE_MS) {
      lastEsc = 0
      return false
    }
    lastEsc = now
    ev.stopPropagation()
    return true
  })

  const slot: Slot = { term, fit, started: false }
  slots.set(session.id, slot)
  return slot
}

/**
 * Give a session's terminal back.
 *
 * `slots` had no `delete` anywhere, and that is a leak with real weight: a 10 000
 * line scrollback, its Terminal instance, its renderer and a detached DOM tree,
 * retained for every session that ever opened a terminal, until the app quit.
 *
 * TerminalModal's own note — that unmounting the modal must NOT dispose, because
 * the pty outlives it and remounting re-parents the same terminal — stays exactly
 * true. This is session teardown, which is a different event: the conversation
 * itself is going away or giving its processes back, and there is nothing left
 * for the scrollback to belong to.
 */
export function disposeSlot(sessionId: string): void {
  const slot = slots.get(sessionId)
  if (!slot) return
  // Deleted first: dispose() tears down xterm's DOM and listeners, and a
  // late onPtyData frame finding a disposed terminal in the map would throw.
  slots.delete(sessionId)
  try {
    slot.term.dispose()
  } catch {
    /* already torn down */
  }
}

window.foreman.onPtyData(({ sessionId, data }: { sessionId: string; data: string }) => {
  slots.get(sessionId)?.term.write(data)
})
window.foreman.onPtyExit(({ sessionId }: { sessionId: string }) => {
  const slot = slots.get(sessionId)
  if (!slot) return
  slot.started = false
  slot.term.writeln('\r\n\x1b[2m[process exited]\x1b[0m')
})
/**
 * ONE RULE: a slot exists only for a row that is live in the rail.
 *
 * Watched here rather than driven from the store, because the store must not
 * import a component it is itself imported by — see the note on `Attachment` in
 * shared/types.ts. But it is a subscription rather than a pair of IPC listeners
 * for a stronger reason: an event per teardown was NOT complete. `close()` of an
 * asleep session reached main with no host to remove, `wake()` rekeys a row from
 * the stub id to the host's without any event at all, and either one left a
 * 10 000-line scrollback with nothing that could ever name it again. Membership
 * of `sessions` is the fact this actually depends on, so it is the fact to read.
 *
 * `asleep` counts as gone: the conversation has given its processes back, and
 * its shell went with them.
 *
 * The `slots.size` bail matters — this runs on every meta patch, which during a
 * turn is several a second, and the map is empty for anyone who never opens a
 * terminal.
 */
useStore.subscribe((s, prev) => {
  if (!slots.size || s.sessions === prev.sessions) return
  for (const id of [...slots.keys()]) {
    const row = s.sessions.find((x) => x.id === id)
    if (!row || row.asleep) disposeSlot(id)
  }
})

export default function TerminalPane({
  session,
  visible,
}: {
  session: SessionMeta
  visible: boolean
}): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const resolvedTheme = useStore((s) => s.resolvedTheme)

  // Every slot, not just this session's — the others are still mounted offscreen
  // and would otherwise keep the old palette until they were next recreated.
  useEffect(() => {
    for (const slot of slots.values()) slot.term.options.theme = termTheme()
  }, [resolvedTheme])

  useEffect(() => {
    const el = host.current
    if (!el) return
    const slot = slotFor(session)

    // Only open into a laid-out container. All three side panels stay mounted
    // with display:none, so on first mount this host is 0x0 — and xterm measures
    // its character cell at open() time. Measuring in a zero-size element caches
    // a bogus cell height, and FitAddon then divides the real height by it, so
    // the viewport ends up a fraction of the pane. That is the half-height
    // scrollbar: the track is honest, the terminal inside it was just short.
    //
    // Side effect of bailing here: the shell below is now started the first time
    // you open the panel rather than when the session is created. That is the
    // better default anyway — no orphan shell per session you never open a
    // terminal for — and the effect re-runs on `visible`, so it starts on time.
    if (!visible || el.clientHeight === 0) return

    // Two states, not one, and `el.contains(...)` could not tell them apart — it
    // is false both for "never opened" and for "opened into a host that has
    // since been unmounted", and only the first wants open(). xterm's open()
    // early-returns once `element` exists and does NOT re-parent, so on the
    // second path it appended nothing and the reopened terminal stayed grey
    // forever. `slot.term.element` being null is the honest test.
    //
    // Moving the element by hand is safe: open() uses its parent for exactly
    // appendChild and ownerDocument.defaultView, and keeps no reference to it.
    // appendChild IS the move, so no remove() first. The CSS follows for free —
    // theme.css's rules are descendant selectors on `.xterm`, which the moved
    // element carries.
    let reparented = false
    if (!slot.term.element) {
      slot.term.open(el)
    } else if (slot.term.element.parentElement !== el) {
      el.appendChild(slot.term.element)
      reparented = true
    }

    const resize = (): void => {
      if (el.clientHeight === 0) return
      try {
        slot.fit.fit()
      } catch {
        /* transiently zero-size */
      }
    }

    const ro = new ResizeObserver(resize)
    ro.observe(el)
    // Next frame, not now: on the render that reveals the panel, layout for the
    // freshly un-hidden subtree hasn't settled when effects run.
    //
    // Focus rides along for exactly the same reason, and must not move back into
    // the effect body. open() above re-parents xterm's helper textarea, and
    // focusing it in the same tick — while the subtree it lives in has only just
    // stopped being display:none — silently does nothing. That was the "open the
    // terminal, then still have to click it before typing" bug: the focus call
    // was always here, just one frame too early.
    const frame = requestAnimationFrame(() => {
      resize()
      // A re-parented terminal usually reopens at the same size, and fit()
      // no-ops when cols/rows are unchanged — so without this nothing would ask
      // for a repaint and the new host would show the frame from before it was
      // detached.
      if (reparented) slot.term.refresh(0, slot.term.rows - 1)
      slot.term.focus()
    })

    // Synchronous on purpose: React 19's StrictMode double-invokes effects, and
    // a latch set inside the promise would let the second invocation spawn a
    // second shell. Released again only on failure — main's startPty is
    // idempotent, and otherwise a spawn that failed once could never be retried
    // for the life of the app, since only onPtyExit clears this and a shell that
    // never started never exits.
    if (!slot.started) {
      slot.started = true
      void window.foreman
        .startPty(session.id, session.cwd, slot.term.cols || 80, slot.term.rows || 24)
        .then((ok: boolean) => {
          if (!ok) {
            slot.started = false
            slot.term.writeln('\x1b[31m[failed to start shell]\x1b[0m')
          }
        })
    }

    return () => {
      cancelAnimationFrame(frame)
      ro.disconnect()
    }
  }, [session.id, session.cwd, visible])

  return <div className="term-host" ref={host} />
}
