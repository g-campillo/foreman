import { useCallback, useEffect, useState } from 'react'
import { Check, Palette, RefreshCw, TriangleAlert, X } from 'lucide-react'
import type { ServerReport } from '../../../shared/types'
import { activeSession, useStore } from '../store'

/**
 * Which languages this project actually gets intelligence for, and how to fix
 * the ones it doesn't.
 *
 * Syntax highlighting needs nothing — Monaco ships ~84 grammars. Everything
 * else (hover, go-to-definition, references, diagnostics) needs a real language
 * server, and whether one exists is a per-PROJECT question, not a per-machine
 * one: clangd can be installed and still useless without a compilation
 * database, and TypeScript resolves to the project's own compiler when it has
 * a newer one than ours.
 *
 * Recheck rather than restart. `resolveServer` runs fresh every time, so the
 * only thing standing between "just installed it" and "it works" is the
 * registry's cache of past failures — which exists so twenty tool calls don't
 * each re-run `which` for a missing binary. Clearing that is enough.
 */
/**
 * One language's row. Extracted only because the list is in two halves now — the
 * servers that could be doing something for this project, and the ones that were
 * never going to be. Rendering it twice from one component is what a disclosure
 * costs; two copies of this JSX would have been what it cost instead.
 */
function LspRow({
  r,
  copied,
  onCopy,
  onAsk,
}: {
  r: ServerReport
  copied: string | null
  onCopy: (cmd: string) => void
  onAsk: (r: ServerReport) => void
}): React.JSX.Element {
  return (
    <div className="lsp-row" data-state={r.state}>
      <span className="lsp-icon">
        {r.state === 'ready' ? (
          <Check size={12} />
        ) : r.state === 'unconfigured' ? (
          <TriangleAlert size={12} />
        ) : r.state === 'highlight-only' ? (
          <Palette size={12} />
        ) : (
          <X size={12} />
        )}
      </span>
      <div className="lsp-row-body">
        <div className="lsp-row-title">
          {r.label}
          <span className="lsp-ext">{r.extensions}</span>
        </div>
        <div className="lsp-detail">{r.detail}</div>
        {r.hint && <div className="lsp-detail lsp-hint">{r.hint}</div>}
        {r.state !== 'ready' && r.install && (
          <div className="lsp-cmd">
            <code>{r.install}</code>
            <button className="btn" onClick={() => onCopy(r.install!)}>
              {copied === r.install ? 'Copied' : 'Copy'}
            </button>
            {/* Composes a message; runs nothing. The agent already owns a
                terminal, and the install raises the same approval card any
                other command would — so this adds no privilege that was not
                already there. Auto-running `npx -y …` would. */}
            <button className="btn" onClick={() => onAsk(r)}>
              Ask the agent
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export default function LspServers(): React.JSX.Element {
  const session = useStore(activeSession)
  const send = useStore((s) => s.send)
  const [reports, setReports] = useState<ServerReport[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const cwd = session?.cwd

  const load = useCallback(async () => {
    if (!cwd) return
    setReports(await window.foreman.lspServers(cwd))
  }, [cwd])

  useEffect(() => {
    void load()
  }, [load])

  const recheck = async (): Promise<void> => {
    setBusy(true)
    // Clear the host's negative cache first, or a server installed a moment ago
    // stays "missing" until the session restarts.
    if (session) await window.foreman.lspRecheck(session.id)
    await load()
    setBusy(false)
  }

  const copy = (cmd: string): void => {
    void navigator.clipboard.writeText(cmd)
    setCopied(cmd)
    setTimeout(() => setCopied(null), 1400)
  }

  const askAgent = (r: ServerReport): void => {
    void send(
      `Install a ${r.label} language server for this project. Prefer the ` +
        `project's own environment over a global install. \`${r.install}\` is ` +
        `the usual way. When it is done, tell me the absolute path to the ` +
        `executable so I can point Foreman at it.`,
    )
  }

  if (!cwd) return <div className="lsp-empty">Open a project to see its language servers.</div>

  /* Split, not sorted. `highlight-only` languages have no server to install and
     nothing to fix — the row exists to answer "why is my .kt file not smart",
     which is worth saying once and not worth four rows of the list's height
     every time you come here for a real one. */
  const real = reports?.filter((r) => r.state !== 'highlight-only') ?? []
  const highlightOnly = reports?.filter((r) => r.state === 'highlight-only') ?? []

  return (
    <div className="lsp-list">
      <div className="lsp-head">
        <span>
          Syntax highlighting works for ~84 languages with no setup. These add hover,
          go-to-definition, references and diagnostics — for you and for the agent.
        </span>
        <button className="btn" disabled={busy} onClick={() => void recheck()}>
          <RefreshCw size={12} />
          {busy ? 'Checking…' : 'Recheck'}
        </button>
      </div>

      {real.map((r) => (
        <LspRow key={r.id} r={r} copied={copied} onCopy={copy} onAsk={askAgent} />
      ))}

      {/* The <details> element itself must NOT be `display: flex` — the UA rule
          that hides a closed disclosure's children only holds while it is a
          block box, and a flex one renders its contents open at all times. The
          column lives on .lsp-more-body inside it. */}
      {highlightOnly.length > 0 && (
        <details className="lsp-more">
          <summary>
            {highlightOnly.length} more with highlighting only, and no server to install
          </summary>
          <div className="lsp-more-body">
            {highlightOnly.map((r) => (
              <LspRow key={r.id} r={r} copied={copied} onCopy={copy} onAsk={askAgent} />
            ))}
          </div>
        </details>
      )}

      {!reports && <div className="lsp-empty">Checking…</div>}
    </div>
  )
}
