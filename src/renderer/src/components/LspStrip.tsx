import { useMemo } from 'react'
import type { LspStatus, ServerId } from '../../../shared/types'
import { useStore } from '../store'

/** Module-level, so the `?? ` fallback is one identity forever. A fresh `[]` in
 *  a selector mints a new one per snapshot and loops the renderer — the trap
 *  documented on the `groups` memo in SessionRail. */
const EMPTY: LspStatus[] = []

/** Short enough for `.meter-label`'s 92px; the tooltip carries the rung. */
const LABEL: Record<ServerId, string> = {
  ts: 'typescript',
  swift: 'swift',
  java: 'java',
  python: 'python',
  rust: 'rust',
  go: 'go',
  clangd: 'c / c++',
}

const PHASE_WORD: Record<LspStatus['phase'], string> = {
  starting: 'starting up',
  indexing: 'indexing the project',
  ready: 'ready',
  failed: 'unavailable',
}

/**
 * Which language servers are awake, and whether they can answer yet.
 *
 * The gap this closes: jdtls returns from `initialize` in under four seconds on
 * a Maven project and then spends far longer building the project model, during
 * which completions come back empty. Without this, "still warming up" and
 * "broken" look identical — and a green light on the handshake alone would be
 * worse than nothing, so `ready` waits for the server's own reports (see
 * phaseOf in lsp/client.mts).
 *
 * A row appears when you open a file of that language, not at session start.
 * Servers start LAZILY — forPath → ensure, on the first document opened — and
 * that is deliberate: eagerly spawning jdtls for a project you never open Java
 * in would cost a JVM for nothing.
 *
 * It goes away when that server reaches `ready` and does NOT come back for the
 * short work tokens it opens afterwards, because phaseOf latches `ready`. This
 * is an INITIAL-readiness indicator: one that blinked on every save would get
 * tuned out, and each blink resizes the session list above it.
 *
 * Rows are plain `.meter`s, the same ones the rate-limit windows use, including
 * its indeterminate case: a bar at zero and a dash when the server says it is
 * busy without saying how busy.
 */
export default function LspStrip({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  // Scalar-safe: `.find` returns the stored session and `.lspStatus` the stored
  // array, so this selector allocates nothing and its identity only changes when
  // the host actually sends a new list.
  const statuses = useStore(
    (s) => s.sessions.find((x) => x.id === sessionId)?.lspStatus ?? EMPTY,
  )

  // Nothing to say once everything is warm, so the strip is not there at all —
  // a permanent row of full bars is noise, and hiding it in CSS would still
  // leave the border and padding behind.
  const shown = useMemo(() => statuses.filter((s) => s.phase !== 'ready'), [statuses])
  if (!shown.length) return null

  return (
    <div className="lsp-strip">
      <div className="rail-section">Language servers</div>
      {shown.map((s) => {
        const busy = s.phase !== 'failed' && s.percent === null
        return (
          <div
            key={s.id}
            className="meter"
            data-phase={s.phase}
            data-busy={busy ? '' : undefined}
            // The phase word is unconditional, not a fallback for a missing
            // detail: jdtls sends `language/status Starting "…"` during the
            // handshake and keeps that same message through indexing, so a
            // tooltip of detail-or-phase renders the two states identically and
            // the transition this strip exists to show produces no visible
            // change at all. A title has no width to run out of.
            title={[LABEL[s.id], s.via, PHASE_WORD[s.phase], s.detail]
              .filter(Boolean)
              .join(' · ')}
          >
            <span className="meter-label">{LABEL[s.id]}</span>
            <span className="meter-track">
              <i style={{ width: `${s.percent ?? 0}%` }} />
            </span>
            {/* 34px of room, so the phase lives in the tooltip and this stays a
                number wherever the server gives one. The em dash is the sibling
                `.meter`'s own indeterminate rendering (SessionPanel's rate-limit
                windows); the pulse on `.meter-val` is what says "still going". */}
            <span className="meter-val">
              {s.phase === 'failed' ? 'fail' : s.percent === null ? '—' : `${s.percent}%`}
            </span>
          </div>
        )
      })}
    </div>
  )
}
