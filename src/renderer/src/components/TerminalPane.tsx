import { useEffect, useRef } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { SessionMeta } from '../../../shared/types'
import { useStore } from '../store'
import { token, vars } from '../tokens'

function termTheme(): ITheme {
  const css = vars()
  return {
    // Stays transparent in both themes: .term-host paints the themed fill
    // underneath, and the glass has to read through it.
    background: 'rgba(0,0,0,0)',
    foreground: token(css, '--text'),
    cursor: token(css, '--accent'),
    selectionBackground: token(css, '--accent', 0.35),
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

function slotFor(session: SessionMeta): Slot {
  const existing = slots.get(session.id)
  if (existing) return existing

  const term = new Terminal({
    allowTransparency: true, // required to see the glass through the terminal
    fontFamily: "'SF Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
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

  const slot: Slot = { term, fit, started: false }
  slots.set(session.id, slot)
  return slot
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
    if (!el.contains(slot.term.element ?? null)) slot.term.open(el)

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
      slot.term.focus()
    })

    if (!slot.started) {
      slot.started = true
      void window.foreman
        .startPty(session.id, session.cwd, slot.term.cols || 80, slot.term.rows || 24)
        .then((ok: boolean) => {
          if (!ok) slot.term.writeln('\x1b[31m[failed to start shell]\x1b[0m')
        })
    }

    return () => {
      cancelAnimationFrame(frame)
      ro.disconnect()
    }
  }, [session.id, session.cwd, visible])

  return <div className="term-host" ref={host} />
}
