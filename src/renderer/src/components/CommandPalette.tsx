import { useEffect, useMemo, useRef, useState } from 'react'
import type { PermissionMode } from '../../../shared/types'
import { useStore } from '../store'
import { filterEntries } from '../derive.mts'
import { MODES } from './Composer'

interface Entry {
  id: string
  label: string
  hint?: string
  group: string
  run: () => void
}

export interface PaletteActions {
  /** Opens the side panel. Deliberately not a toggle — "Show diff" from the
   *  palette must never close a diff that's already open. */
  showPanel(panel: 'diff' | 'terminal' | 'session'): void
  showSettings(): void
}

/**
 * ⌘P. Replaces the ⌘K session-cycling placeholder.
 *
 * Everything here is an action that does something today. Files are deliberately
 * absent: there's no editor to open one in, so they only become useful in batch
 * 4, where @-mentions give them both a data source and a destination.
 */
export default function CommandPalette({
  actions,
  onClose,
}: {
  actions: PaletteActions
  onClose: () => void
}): React.JSX.Element {
  const sessions = useStore((s) => s.sessions)
  const activeId = useStore((s) => s.activeId)
  const models = useStore((s) => s.models)
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const entries = useMemo<Entry[]>(() => {
    const { select, newSession, openProject, close, startDraft } = useStore.getState()
    const out: Entry[] = []

    for (const s of sessions) {
      if (s.id === activeId) continue
      out.push({
        id: `session:${s.id}`,
        label: s.title,
        hint: s.cwd,
        group: 'Sessions',
        run: () => select(s.id),
      })
    }

    out.push(
      {
        id: 'new',
        label: 'New conversation',
        hint: '⌘N · this project',
        group: 'Session',
        run: () => void newSession(),
      },
      {
        id: 'new-in',
        label: 'New conversation in another project…',
        hint: '⇧⌘N',
        group: 'Session',
        run: startDraft,
      },
      {
        id: 'open',
        label: 'Open project…',
        group: 'Session',
        run: () => void openProject(),
      },
      { id: 'settings', label: 'Settings', hint: '⌘,', group: 'View', run: actions.showSettings },
      { id: 'diff', label: 'Show diff', hint: '⌘1', group: 'View', run: () => actions.showPanel('diff') },
      { id: 'term', label: 'Show terminal', hint: '⌘2', group: 'View', run: () => actions.showPanel('terminal') },
      { id: 'sess', label: 'Show session info', hint: '⌘3', group: 'View', run: () => actions.showPanel('session') },
    )

    if (activeId) {
      const id = activeId
      out.push({
        id: 'close',
        label: 'Close session',
        hint: sessions.find((s) => s.id === id)?.title,
        group: 'Session',
        run: () => void close(id),
      })
      for (const m of MODES) {
        out.push({
          id: `mode:${m.value}`,
          label: `Permission mode: ${m.label}`,
          group: 'Session',
          run: () => void window.foreman.setPermissionMode(id, m.value as PermissionMode),
        })
      }
      for (const m of models) {
        out.push({
          id: `model:${m.id}`,
          label: `Model: ${m.displayName}`,
          group: 'Session',
          run: () => void window.foreman.setModel(id, m.id),
        })
      }
    }
    return out
  }, [sessions, activeId, models, actions])

  const shown = useMemo(() => filterEntries(entries, query), [entries, query])

  // A stale cursor would run the wrong entry when the list shrinks under it.
  useEffect(() => setCursor(0), [query])

  useEffect(() => {
    listRef.current?.querySelector('[data-sel]')?.scrollIntoView({ block: 'nearest' })
  }, [cursor, shown])

  const run = (entry: Entry | undefined): void => {
    if (!entry) return
    onClose()
    entry.run()
  }

  return (
    <div className="palette-scrim" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          className="palette-input"
          autoFocus
          value={query}
          placeholder="Jump to a session, or run a command…"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose()
            else if (e.key === 'Enter') run(shown[cursor])
            else if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) {
              e.preventDefault()
              setCursor((c) => Math.min(c + 1, shown.length - 1))
            } else if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) {
              e.preventDefault()
              setCursor((c) => Math.max(c - 1, 0))
            }
          }}
        />

        <div className="palette-list" ref={listRef}>
          {shown.length === 0 && <div className="palette-empty">No matches</div>}
          {shown.map((entry, i) => (
            <button
              key={entry.id}
              className="palette-row"
              data-sel={i === cursor ? '' : undefined}
              // onMouseMove, not onMouseEnter: enter also fires when a row is
              // inserted under a stationary cursor, which would hand the
              // selection to whatever the pointer happened to be resting on the
              // instant the palette opened.
              onMouseMove={() => setCursor(i)}
              onClick={() => run(entry)}
            >
              <span className="palette-group">{entry.group}</span>
              <span className="palette-label">{entry.label}</span>
              {entry.hint && <span className="palette-hint">{entry.hint}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
