import { useCallback, useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { FileRead, SessionMeta } from '../../../shared/types'
import { relPath } from '../derive.mts'
import { useStore } from '../store'
import { loadedMonaco } from '../editor/monaco'
import { attach, bufFor, detach, isDirty, loadBuffer, markSaved, relayout, retheme } from '../editor/models'

/**
 * A file, in the same modal frame as PlanCard and QuestionCard — wider, because
 * it is a file.
 *
 * MOUNTED AT .app LEVEL, and that is not a detail. PlanCard renders its scrim
 * inside .convo, which sits in a `section.pane.glass`; a backdrop-filter makes
 * that pane the containing block for its position:fixed descendants, and the
 * pane's own overflow:hidden then clips them. Settings, CommandPalette and
 * Tooltip all mount at .app for exactly this reason, and App.tsx says so. Move
 * this into Conversation and it silently becomes a chat-column-sized modal.
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
  const resolvedTheme = useStore((s) => s.resolvedTheme)
  const body = useRef<HTMLDivElement | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)

  const path = editorState?.path ?? null
  const line = editorState?.line ?? null

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
      await attach(body.current, path, line)
      setDirty(isDirty(path))
      // Subscribe after attach so the initial load does not read as an edit.
      const buf = bufFor(path)
      const sub = buf?.model.onDidChangeContent(() => setDirty(isDirty(path)))
      disposers.current.push(() => sub?.dispose())
    })()
    return () => {
      cancelled = true
    }
  }, [path, line, session.cwd])

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

  useEffect(() => {
    if (!path) return
    const onResize = (): void => relayout()
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      detach()
    }
  }, [path])

  // Only handles CHANGES. The first definition happens inside loadMonaco, which
  // has to run before any editor is created — this effect cannot, because on the
  // first open the chunk has not landed yet and loadedMonaco() is still null.
  useEffect(() => {
    const monaco = loadedMonaco()
    if (monaco) retheme(monaco)
  }, [resolvedTheme])

  if (!path) return null
  // (path, cwd) — that order, not the other one. relPath does prefix arithmetic
  // and returns its first argument unchanged when the second does not prefix it,
  // so swapping them fails silently by rendering the cwd as a filename.
  const rel = relPath(path, session.cwd)

  return (
    <div className="plan-scrim" onMouseDown={closeFile}>
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
          <button className="plan-close" aria-label="Close file" onClick={closeFile}>
            <X size={14} />
          </button>
        </header>

        {err ? (
          <div className="plan-body file-body">
            <div className="empty">{err}</div>
          </div>
        ) : (
          <div className="plan-body file-body" ref={body} />
        )}

        <footer className="plan-actions">
          <span className="plan-path">{session.cwd}</span>
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
