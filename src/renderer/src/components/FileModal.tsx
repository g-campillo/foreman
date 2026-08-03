import { useCallback, useEffect, useRef, useState } from 'react'
import { TriangleAlert, X } from 'lucide-react'
import type { FileRead, SessionMeta } from '../../../shared/types'
import type { ServerReport } from '../../../shared/types'
import { authorEdits, relPath, resolveAnchors, tildePath } from '../derive.mts'
import { useStore } from '../store'
import { loadedMonaco } from '../editor/monaco'
import { startLsp } from '../editor/lsp'
import {
  attach,
  bufFor,
  detach,
  editorHasFocus,
  isDirty,
  loadBuffer,
  markSaved,
  onGutterClick,
  relayout,
  retheme,
  revealLine,
  setAuthored,
} from '../editor/models'
import { useAgentFocus } from '../useAgentFocus'
import { usePresence } from '../usePresence'
import { serverFor } from '../../../shared/languages.mts'

/** Languages the user has waved away this session. Module scope, so it survives
 *  the modal closing — otherwise every file reopens the same note. */
const dismissed = new Set<string>()

/**
 * A file, in the same modal frame as PlanCard and QuestionCard — wider, because
 * it is a file.
 *
 * MOUNTED AT .app LEVEL, and that is not a detail. PlanCard renders its scrim
 * inside .convo, which sits in a `section.pane.pane-fill`; that rule's
 * `contain: paint` makes the pane the containing block for its position:fixed
 * descendants, and the pane's own overflow:hidden then clips them. That
 * confinement is deliberate for a plan, and wrong for a file. Settings,
 * CommandPalette and Tooltip all mount at .app for exactly this reason, and
 * App.tsx says so. Move this into Conversation and it silently becomes a
 * chat-column-sized modal.
 *
 * Which file is open lives in the store rather than here, so a tree row, a diff
 * row, a tool card and the palette can all open one without a threaded callback.
 */

interface Props {
  session: SessionMeta
}

export default function FileModal({ session }: Props): React.JSX.Element | null {
  const editorState = useStore((s) => s.editor)
  const closeFile = useStore((s) => s.closeFile)
  const openFile = useStore((s) => s.openFile)
  const resolvedTheme = useStore((s) => s.resolvedTheme)
  const revealItem = useStore((s) => s.revealItem)
  // Same signal the tree uses, so the two never disagree about where the agent is.
  const agent = useAgentFocus(session.id)
  // The agent's writes already push this; the gutter rides it rather than
  // polling. Read for its identity — see DiffPanel for what a fresh one means.
  const bump = useStore((s) => s.diffCounts[session.id])
  const [elsewhere, setElsewhere] = useState<string | null>(null)
  // Bumped once the editor is actually attached. The gutter effect needs a live
  // Monaco AND a model, and on the first open neither exists when effects first
  // run — the chunk is still loading. Without this the decorations are computed
  // against nothing and never recomputed, which looks exactly like a feature
  // that does not work. Same shape as the theme bug: `loadedMonaco()` returning
  // null is not a state React knows to re-run on.
  const [ready, setReady] = useState(0)
  const [noServer, setNoServer] = useState<ServerReport | null>(null)
  const send = useStore((st) => st.send)
  const body = useRef<HTMLDivElement | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)

  const path = editorState?.path ?? null
  const line = editorState?.line ?? null

  /* Presence lives INSIDE this component, unlike the other four modals: what
     opens it is `editor` in the store rather than a flag at the call site, and
     App renders `<FileModal>` unconditionally.

     `shown` is the path the frame keeps rendering while it animates out. `path`
     is already null by then, and every hook below still keys off `path` — so
     the reads, the buffer and the gutter all tear down on the real close,
     exactly as before, and only the frame outlives them by --dur-2. The one
     exception is the detach effect, which says why on itself. */
  const at = usePresence(!!path)
  const shown = useRef<string | null>(null)
  if (path) shown.current = path

  const save = useCallback(async () => {
    if (!path) return
    const buf = bufFor(path)
    if (!buf) return
    setSaving(true)
    const res = await window.foreman.writeFile(
      session.id,
      session.cwd,
      path,
      buf.model.getValue(),
      buf.bom,
      buf.mtimeMs,
    )
    setSaving(false)
    if (res.ok) {
      markSaved(path, res.mtimeMs)
      setDirty(false)
      setErr(null)
    } else {
      setErr(
        res.reason === 'stale'
          ? 'Changed on disk since you opened it. Reopen to see the new version.'
          : res.error,
      )
    }
  }, [path, session.id, session.cwd])

  // Load, then attach. Split because a failed read must never open an editor:
  // an empty buffer that looks like an empty file is one ⌘S from truncating it.
  useEffect(() => {
    if (!path) return
    let cancelled = false
    setErr(null)
    void (async () => {
      const res: FileRead = await window.foreman.readFile(session.cwd, path)
      if (cancelled) return
      if (!res.ok) {
        setErr(
          res.reason === 'binary'
            ? 'Binary file.'
            : res.reason === 'too-large'
              ? `Too large to edit (${res.error}).`
              : res.error,
        )
        return
      }
      await loadBuffer(path, res)
      if (cancelled || !body.current) return
      // Start the language client before attaching, so its onDidCreateModel
      // subscription is live when loadBuffer's model appears. Started lazily
      // here rather than at session create: no editor, no reason to spawn a
      // language server.
      await startLsp(session.id, openFile)
      await attach(body.current, path, line)
      setDirty(isDirty(path))
      setReady((n) => n + 1)
      // Subscribe after attach so the initial load does not read as an edit.
      const buf = bufFor(path)
      const sub = buf?.model.onDidChangeContent(() => setDirty(isDirty(path)))
      disposers.current.push(() => sub?.dispose())
    })()
    return () => {
      cancelled = true
    }
  }, [path, line, session.cwd, session.id, openFile])

  const disposers = useRef<(() => void)[]>([])
  useEffect(
    () => () => {
      disposers.current.forEach((d) => d())
      disposers.current = []
    },
    [path],
  )

  // Escape closes, copying PlanCard's listener verbatim. Monaco calls
  // stopPropagation() on keys it handles, so Escape dismissing its own find
  // widget never reaches this — which is the behaviour we want and the reason
  // this can stay a plain window listener.
  useEffect(() => {
    if (!path) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeFile()
      // Registered here as well as on the editor: focus is normally inside
      // Monaco, but not while the error state is showing.
      else if (e.key === 's' && e.metaKey) {
        e.preventDefault()
        void save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [path, closeFile, save])

  /* Keyed on `at.mounted` rather than on `path`, and that is about detach():
     it pulls Monaco's host straight out of the DOM, so running it the frame
     `path` clears would empty the editor before the modal had begun to fade —
     the code vanishing, then a blank frame sliding away. Held to the end of the
     exit and the file fades out with the modal that holds it.

     It also stops a file SWITCH detaching at all, which was already redundant:
     attach() saves the outgoing buffer's view state itself and re-appends the
     host only when the mount does not already contain it. */
  useEffect(() => {
    if (!at.mounted) return
    const onResize = (): void => relayout()
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      detach()
    }
  }, [at.mounted])

  /**
   * Follow the agent — but only ever within an editor that is already open.
   *
   * RULE 1, and it is the one that makes this a feature people leave on:
   * following NEVER opens the modal. When it is closed the agent's movement
   * lands in the ⌘4 tree instead, which pulses and auto-reveals and interrupts
   * nothing. An editor that appears because the agent read a file is the editor
   * becoming the app's spine, and the README's first line forbids that.
   *
   * RULE 3: never move the viewport while the caret is inside the editor. One
   * condition, one place. A suppressed move surfaces as a chip in the header
   * rather than being silently dropped.
   *
   * Rules 2 and 4 (follow when open; main thread of the active session only)
   * are structural — this effect only runs for the open file, and
   * useAgentFocus already excludes subagents.
   */
  useEffect(() => {
    const target = agent.current
    if (!path || !target) return
    if (target.path !== path) {
      // The agent moved to a different file. Offer it; do not take the user
      // there, and do not open anything.
      setElsewhere(relPath(target.path, session.cwd))
      return
    }
    setElsewhere(null)
    if (target.line === null || editorHasFocus()) return
    revealLine(target.line)
  }, [agent, path, session.cwd])

  // The agent-authored gutter. Recomputed when the agent edits (bump) or the
  // file changes, NOT on every keystroke — the decorations Monaco holds already
  // track your typing.
  useEffect(() => {
    const monaco = loadedMonaco()
    if (!path || !monaco) return
    let cancelled = false
    void (async () => {
      const buf = bufFor(path)
      if (!buf) return
      const items = useStore.getState().items[session.id] ?? []
      const ranges = resolveAnchors(buf.model.getValue(), authorEdits(items, path))
      // Git is the authority on WHICH lines changed; anchors only decide which
      // of them can link back to a message.
      const diffs = await window.foreman.listDiffs(session.id, session.cwd)
      if (cancelled) return
      const mine = diffs.find((d: { path: string }) => d.path === path)
      const changed = new Set<number>()
      for (const h of mine?.hunks ?? []) {
        for (const l of h.lines) if (l.type === 'add' && l.newNo) changed.add(l.newNo)
      }
      setAuthored(monaco, ranges, changed)
    })()
    return () => {
      cancelled = true
    }
  }, [path, bump, ready, session.id, session.cwd])

  // Gutter click -> the message that wrote the line.
  useEffect(() => {
    if (!path || !ready) return
    return onGutterClick((itemId) => {
      // Close on the way. The gesture is "show me the message that wrote this",
      // and the modal covers the conversation — scrolling a transcript the user
      // cannot see is the same as doing nothing. Reopening from the tree lands
      // back on this line, because the editor keeps view state per path.
      revealItem(itemId)
      closeFile()
    })
  }, [path, ready, revealItem, closeFile])

  // Only handles CHANGES. The first definition happens inside loadMonaco, which
  // has to run before any editor is created — this effect cannot, because on the
  // first open the chunk has not landed yet and loadedMonaco() is still null.
  useEffect(() => {
    const monaco = loadedMonaco()
    if (monaco) retheme(monaco)
  }, [resolvedTheme])

  /**
   * Does this file's language actually have a server?
   *
   * Asked per open, because the answer depends on the project — clangd is
   * installed on this machine but useless without a compilation database, and
   * that is a per-project fact, not a per-machine one.
   */
  useEffect(() => {
    if (!path) return
    let cancelled = false
    void window.foreman.lspServers(session.cwd).then((reports: ServerReport[]) => {
      if (cancelled) return
      const id = serverFor(path)
      const mine = id ? reports.find((r) => r.id === id) : null
      // Languages Monaco handles itself (json, css, html, markdown) have no
      // server by design and must not be reported as missing one.
      setNoServer(mine && mine.state !== 'ready' && !dismissed.has(mine.id) ? mine : null)
    })
    return () => {
      cancelled = true
    }
  }, [path, session.cwd])

  const dismiss = (id: string): void => {
    dismissed.add(id)
    setNoServer(null)
  }

  const askAgent = (r: ServerReport): void => {
    setNoServer(null)
    void send(
      `Install a ${r.label} language server for this project. Prefer the project's own ` +
        `environment over a global install. \`${r.install}\` is the usual way. When it is ` +
        `done, tell me the absolute path to the executable.`,
    )
  }

  if (!at.mounted || !shown.current) return null
  // (path, cwd) — that order, not the other one. relPath does prefix arithmetic
  // and returns its first argument unchanged when the second does not prefix it,
  // so swapping them fails silently by rendering the cwd as a filename.
  const rel = relPath(shown.current, session.cwd)

  return (
    <div className="plan-scrim" data-state={at.state} onMouseDown={closeFile}>
      <div
        className="plan-modal file-modal"
        role="dialog"
        aria-label={rel}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="plan-head file-head">
          <h2 className="plan-title file-title">
            {rel}
            {dirty && <span className="file-dirty" title="Unsaved changes" />}
          </h2>
          <span className="spacer" />
          {/* A move we deliberately did not make. Clicking it catches up — which
              is also the whole of the pinned-mode UI, for one component. */}
          {elsewhere && agent.current && (
            <button
              className="file-elsewhere"
              title="The agent is working in another file"
              onClick={() => openFile(agent.current!.path, agent.current!.line ?? undefined)}
            >
              {elsewhere} · agent is here
            </button>
          )}
          <button className="plan-close" aria-label="Close file" onClick={closeFile}>
            <X size={14} />
          </button>
        </header>

        {/* Why this file has no hover or go-to-definition, said at the moment
            you would otherwise wonder. Dismissible, and remembered per language
            for the session — a note you cannot silence is an ad. */}
        {noServer && (
          <div className="lsp-note">
            <TriangleAlert size={14} />
            <div className="lsp-note-body">
              <b>No {noServer.label} language server.</b> Syntax highlighting works; hover,
              go-to-definition and diagnostics need one.
              {noServer.install && (
                <div className="lsp-note-cmd">
                  <code>{noServer.install}</code>
                  <button
                    className="btn"
                    onClick={() => void navigator.clipboard.writeText(noServer.install!)}
                  >
                    Copy
                  </button>
                  {/* Composes a message rather than running anything. The agent
                      owns a terminal already, and the install raises the same
                      approval card any other command would — so this adds no
                      privilege that was not already there. */}
                  <button className="btn" onClick={() => askAgent(noServer)}>
                    Ask the agent
                  </button>
                </div>
              )}
              {noServer.hint && <div className="lsp-note-hint">{noServer.hint}</div>}
            </div>
            <button className="plan-close" aria-label="Dismiss" onClick={() => dismiss(noServer.id)}>
              <X size={14} />
            </button>
          </div>
        )}

        {err ? (
          <div className="plan-body file-body">
            <div className="empty">{err}</div>
          </div>
        ) : (
          <div className="plan-body file-body" ref={body} />
        )}

        <footer className="plan-actions">
          <span className="plan-path" title={session.cwd}>
            {tildePath(session.cwd, window.foreman.homeDir)}
          </span>
          <div className="plan-buttons">
            <button
              className="btn"
              data-variant="primary"
              disabled={!dirty || saving || !!err}
              onClick={() => void save()}
            >
              {saving ? 'Saving…' : 'Save  ⌘S'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  )
}
