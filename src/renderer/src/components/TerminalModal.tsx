import { useEffect } from 'react'
import { X } from 'lucide-react'
import type { SessionMeta } from '../../../shared/types'
import { tildePath } from '../derive.mts'
import TerminalPane from './TerminalPane'

/**
 * The shell, as a window-level card rather than a column in the side pane.
 *
 * Mounted at `.app` level, and that is mandatory rather than stylistic:
 * `.pane-fill`'s `contain: paint` makes a pane the containing block for
 * `position: fixed` descendants and its `overflow: hidden` then clips them —
 * which is exactly why PlanCard's scrim is chat-column-sized. Same reason
 * FileModal lives up there.
 *
 * Unmounting on close loses NOTHING. The pty lives in main/pty.ts and is only
 * ever reaped at quit; the xterm instance, its scrollback and its shell state
 * live in TerminalPane's module-level `slots` map. Remounting re-parents the
 * same terminal, and the `!slot.started` guard stops a second shell spawning.
 *
 * Two deliberate departures from the other modals, both because this is a place
 * you work rather than something you consult:
 *
 *  - **The scrim does not close it.** The card is near-fullscreen, so the scrim
 *    is a thin margin, and a thin margin that tears down your workspace and
 *    drops your focus on a stray click is a trap. ESC and ⌘2 are the ways out.
 *  - **z-index 45, below the palette's 50** (see `.term-scrim`). This is the
 *    least modal of the modals: ⌘K has to paint over it, and so does a plan or
 *    a question the agent is waiting on. A workspace you opened yourself does
 *    not outrank a decision someone is blocked on.
 */
export default function TerminalModal({
  session,
  onClose,
}: {
  session: SessionMeta
  onClose: () => void
}): React.JSX.Element {
  // Bare window listener, copying FileModal's — and safe here for the same
  // reason, which TerminalPane had to be taught: its attachCustomKeyEventHandler
  // calls stopPropagation() on the FIRST Escape, so while focus is inside xterm
  // a single press reaches the shell and never gets here. A second press within
  // 500ms is let through untouched — and not sent to the pty — which is the only
  // way this fires from inside the terminal. It also fires as normal when focus
  // is on the header, the close button, or the scrim.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="plan-scrim term-scrim">
      <div className="plan-modal term-modal" role="dialog" aria-label="Terminal">
        <header className="plan-head term-head">
          {/* `~/code/foreman`, not `/Users/…/code/foreman`. `.term-title`
              ellipsises the TAIL, so the full path spent its width on the one
              part that is identical for every project and then cut off the
              project name — the only part worth reading. `title` keeps the
              absolute path for anyone who wants it. */}
          <h2 className="plan-title term-title" title={session.cwd}>
            {tildePath(session.cwd, window.foreman.homeDir)}
          </h2>
          <span className="spacer" />
          {/* The honest answer to "why didn't Escape close this", said before
              you have to wonder — and now also the way out. */}
          <span className="term-hint">esc esc to close</span>
          <button
            className="plan-close"
            data-tip="Close terminal  ⌘2"
            aria-label="Close terminal"
            onClick={onClose}
          >
            <X size={14} />
          </button>
        </header>

        {/* No .plan-body wrapper: .term-host is already `flex:1; min-height:0`
            and .plan-modal is already a flex column, so the host IS the body —
            and .plan-body's reading-width padding and overflow-y:auto are both
            wrong for a terminal.

            key={session.id} gives each session its own host div. Without it,
            switching sessions re-runs TerminalPane's effect against a NEW slot
            while the previous session's .xterm is still a child of the same
            host, and the `!el.contains(...)` guard then appends a second one —
            two terminals stacked at height:100% in one box. */}
        <TerminalPane key={session.id} session={session} visible />
      </div>
    </div>
  )
}
