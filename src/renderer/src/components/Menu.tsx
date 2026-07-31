import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronRight } from 'lucide-react'
import { filterEntries } from '../derive.mts'

/** Anchor-to-menu gap, and the smallest menu-to-window margin. Cursor's. */
const GAP = 6
const EDGE = 8

/** Rows past this many get a search row for free. Below it, searching is noise. */
const SEARCHABLE = 8

export interface MenuAction {
  kind?: 'item'
  /** Stable across re-renders — this is the React key and the roving-focus id. */
  id: string
  label: string
  /** Fills the 14px leading slot. Every row reserves it, so labels line up even
   *  in a menu where only some rows have a glyph. */
  icon?: React.ReactNode
  /** Trailing text: a keybinding, a model's context size, an agent type. Also
   *  the secondary field `filterEntries` matches on. */
  hint?: string
  /** Renders a trailing check. Cursor marks selection this way and never with a
   *  fill — a filled row already means "focused" here. */
  checked?: boolean
  disabled?: boolean
  /** Opens to the right on hover, →, or Enter. Mutually exclusive with onSelect. */
  submenu?: MenuItem[]
  onSelect?: () => void
}

export type MenuItem =
  | MenuAction
  | { kind: 'section'; label: string }
  | { kind: 'divider'; id?: string }

const isAction = (i: MenuItem): i is MenuAction => i.kind === undefined || i.kind === 'item'

export interface MenuProps {
  /** The element to hang off. Null closes the menu. */
  anchor: HTMLElement | null
  items: MenuItem[]
  onClose: () => void
  /** Which anchor edge the menu lines up with. Right for menus that open from a
   *  control sitting near the window's right edge, so they grow inward. */
  align?: 'left' | 'right'
  /** Force the search row on or off. Defaults to "on past SEARCHABLE rows". */
  search?: boolean
  searchPlaceholder?: string
  /** Set on submenus so they open beside their parent row rather than under it. */
  side?: boolean
}

/**
 * The anchored menu. Cursor's `.ui-menu`, which is the one primitive this
 * codebase never had — every picker was a native `<select>`, and a native select
 * cannot hold an icon, cannot draw its own chevron and opens OS chrome that no
 * amount of CSS reaches.
 *
 * Portalled to `.app` rather than rendered in place, for the reason Tooltip
 * documents at length: `.pane-fill` carries `contain: paint`, which makes every
 * pane the containing block for its `position: fixed` descendants AND clips them
 * with the pane's own overflow. A menu opened from the composer would be cut off
 * at the chat column's edge. `.app` is the only escape, and it is where Settings,
 * FileModal, TerminalModal and Tooltip already live.
 *
 * Positioning is imperative and runs in useLayoutEffect, so the menu is placed
 * in the same frame it mounts — measuring in an effect would paint one frame at
 * (0,0) first, which reads as a flash in the corner of the window.
 */
export default function Menu({
  anchor,
  items,
  onClose,
  align = 'left',
  search,
  searchPlaceholder = 'Search…',
  side = false,
}: MenuProps): React.JSX.Element | null {
  const box = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  /** The row a submenu is open on, and the row element it hangs off. */
  const [sub, setSub] = useState<{ id: string; el: HTMLElement } | null>(null)

  const actions = useMemo(() => items.filter(isAction), [items])
  const showSearch = search ?? actions.length >= SEARCHABLE

  // Sections and dividers drop out entirely while filtering: a heading over
  // nothing, or a rule between two empty groups, is worse than an ungrouped list.
  const shown = useMemo<MenuItem[]>(() => {
    if (!query.trim()) return items
    return filterEntries(actions, query)
  }, [items, actions, query])

  const rows = useMemo(() => shown.filter(isAction), [shown])

  // Clamp rather than reset: filtering down to fewer rows than the cursor index
  // would otherwise leave nothing focused and Enter doing nothing.
  useEffect(() => {
    setCursor((c) => Math.min(c, Math.max(0, rows.length - 1)))
  }, [rows.length])

  const choose = useCallback(
    (item: MenuAction, el: HTMLElement | null): void => {
      if (item.disabled) return
      if (item.submenu) {
        if (el) setSub({ id: item.id, el })
        return
      }
      item.onSelect?.()
      onClose()
    },
    [onClose],
  )

  useLayoutEffect(() => {
    const el = box.current
    if (!el || !anchor) return

    const place = (): void => {
      // Reset before measuring, or yesterday's clamp caps today's natural width.
      el.style.left = '0px'
      el.style.top = '0px'
      el.style.maxHeight = ''

      const a = anchor.getBoundingClientRect()
      const self = el.getBoundingClientRect()

      // A submenu opens beside its row; everything else opens under its trigger.
      const wantX = side
        ? a.right + GAP
        : align === 'right'
          ? a.right - self.width
          : a.left
      const x = Math.min(Math.max(wantX, EDGE), window.innerWidth - self.width - EDGE)

      const under = side ? a.top : a.bottom + GAP
      const over = side ? a.bottom - self.height : a.top - self.height - GAP
      // Flip only when there is genuinely more room the other way. A menu that
      // flips the moment it *almost* fits ends up jumping between openings as
      // the row list changes length by one.
      const roomBelow = window.innerHeight - under - EDGE
      const flip = self.height > roomBelow && a.top - EDGE > roomBelow
      const y = Math.min(Math.max(flip ? over : under, EDGE), window.innerHeight - self.height - EDGE)

      el.style.left = `${Math.round(x)}px`
      el.style.top = `${Math.round(y)}px`
      // Long lists scroll inside the menu rather than running off the window.
      el.style.maxHeight = `${Math.round(window.innerHeight - y - EDGE)}px`
    }

    place()
    // The anchor can move under an open menu: the composer grows a row as the
    // background tray appears, the rail reflows when a session finishes.
    const ro = new ResizeObserver(place)
    ro.observe(anchor)
    ro.observe(el)
    return () => ro.disconnect()
  }, [anchor, align, side, shown])

  useEffect(() => {
    if (!anchor) return

    // pointerdown, not click: a click lands after the trigger's own handler has
    // already toggled the menu back open, so the menu would never close by
    // clicking its own trigger. Ignoring the anchor's subtree is what lets the
    // trigger do the toggling.
    const onDown = (e: PointerEvent): void => {
      const t = e.target
      if (!(t instanceof Node)) return
      if (box.current?.contains(t) || anchor.contains(t)) return
      // A submenu portals outside this menu's box, so it needs its own check or
      // clicking a submenu row would close the parent out from under it.
      if (t instanceof Element && t.closest('.menu')) return
      onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        if (sub) setSub(null)
        else onClose()
      }
    }
    // Capture, and only for scrollers: the menu is fixed and the anchor is not,
    // so a transcript scrolling under an open menu would strand it.
    const onScroll = (e: Event): void => {
      if (box.current?.contains(e.target as Node)) return
      onClose()
    }

    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', onClose)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('resize', onClose)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [anchor, onClose, sub])

  // Focus the search box if there is one, else the menu itself, so arrow keys
  // work without the user having to click a row first.
  useEffect(() => {
    const el = box.current
    if (!el) return
    const input = el.querySelector('input')
    if (input instanceof HTMLInputElement) input.focus()
    else el.focus()
  }, [anchor])

  useEffect(() => {
    box.current?.querySelector('[data-sel]')?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  if (!anchor) return null

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor((c) => (rows.length ? (c + 1) % rows.length : 0))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => (rows.length ? (c - 1 + rows.length) % rows.length : 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const item = rows[cursor]
      if (item) {
        const el = box.current?.querySelector('[data-sel]')
        choose(item, el instanceof HTMLElement ? el : null)
      }
    } else if (e.key === 'ArrowRight' && rows[cursor]?.submenu) {
      e.preventDefault()
      const el = box.current?.querySelector('[data-sel]')
      if (el instanceof HTMLElement) setSub({ id: rows[cursor].id, el })
    } else if (e.key === 'ArrowLeft' && sub) {
      e.preventDefault()
      setSub(null)
    }
  }

  const app = document.querySelector('.app') ?? document.body
  let i = -1

  return createPortal(
    <>
      <div
        className="menu"
        ref={box}
        role="menu"
        tabIndex={-1}
        data-side={side ? '' : undefined}
        onKeyDown={onKeyDown}
      >
        {showSearch && (
          <div className="menu-search">
            <input
              value={query}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        )}

        <div className="menu-list">
          {shown.map((item, n) => {
            if (item.kind === 'divider') return <div key={item.id ?? `d${n}`} className="menu-rule" />
            if (item.kind === 'section')
              return (
                <div key={`s${n}`} className="menu-section">
                  {item.label}
                </div>
              )

            i += 1
            const at = i
            return (
              <button
                key={item.id}
                className="menu-row"
                role="menuitem"
                data-sel={at === cursor ? '' : undefined}
                data-open={sub?.id === item.id ? '' : undefined}
                disabled={item.disabled}
                aria-checked={item.checked}
                // The pointer moving over a row IS the selection, matching every
                // native menu — otherwise the keyboard cursor and the hover
                // highlight disagree and two rows look focused at once.
                onPointerMove={() => setCursor(at)}
                onPointerEnter={(e) => {
                  if (item.submenu) setSub({ id: item.id, el: e.currentTarget })
                  else setSub(null)
                }}
                onClick={(e) => choose(item, e.currentTarget)}
              >
                <span className="menu-icon">{item.icon}</span>
                <span className="menu-label">{item.label}</span>
                {item.hint && <span className="menu-hint">{item.hint}</span>}
                {item.checked && <Check size={12} className="menu-check" />}
                {item.submenu && <ChevronRight size={12} className="menu-more" />}
              </button>
            )
          })}

          {!shown.length && <div className="menu-empty">No matches</div>}
        </div>
      </div>

      {sub && (
        <Menu
          side
          anchor={sub.el}
          items={rows.find((r) => r.id === sub.id)?.submenu ?? []}
          onClose={onClose}
        />
      )}
    </>,
    app,
  )
}
