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

  if (!cwd) return <div className="lsp-empty">Open a project to see its language servers.</div>

  return (
    <div className="lsp-list">
      <div className="lsp-head">
        <span>
          Syntax highlighting works for ~84 languages with no setup. These add hover,
          go-to-definition, references and diagnostics — for you and for the agent.
        </span>
        <button className="btn" disabled={busy} onClick={() => void recheck()}>
          <RefreshCw size={13} />
          {busy ? 'Checking…' : 'Recheck'}
        </button>
      </div>

      {reports?.map((r) => (
        <div key={r.id} className="lsp-row" data-state={r.state}>
          <span className="lsp-icon">
            {r.state === 'ready' ? (
              <Check size={13} />
            ) : r.state === 'unconfigured' ? (
              <TriangleAlert size={13} />
            ) : r.state === 'highlight-only' ? (
              <Palette size={13} />
            ) : (
              <X size={13} />
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
                <button className="btn" onClick={() => copy(r.install!)}>
                  {copied === r.install ? 'Copied' : 'Copy'}
                </button>
                {/* Composes a message; runs nothing. The agent already owns a
                    terminal, and the install raises the same approval card any
                    other command would — so this adds no privilege that was not
                    already there. Auto-running `npx -y …` would. */}
                <button
                  className="btn"
                  onClick={() =>
                    void send(
                      `Install a ${r.label} language server for this project. Prefer the ` +
                        `project's own environment over a global install. \`${r.install}\` is ` +
                        `the usual way. When it is done, tell me the absolute path to the ` +
                        `executable so I can point Foreman at it.`,
                    )
                  }
                >
                  Ask the agent
                </button>
              </div>
            )}
          </div>
        </div>
      ))}

      {!reports && <div className="lsp-empty">Checking…</div>}
    </div>
  )
}
