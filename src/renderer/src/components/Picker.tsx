import { useCallback, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import Menu, { type MenuItem } from './Menu'

/**
 * Open-state for anything that hangs a Menu off itself.
 *
 * The anchor is the trigger's own element rather than a coordinate, because
 * Menu re-measures on resize and a stored point cannot follow a control that
 * moves — and these controls do move: the composer's row reflows as the
 * background tray appears and as the model label changes width.
 */
export function useMenu(): {
  ref: React.RefObject<HTMLButtonElement | null>
  anchor: HTMLElement | null
  toggle: () => void
  close: () => void
} {
  const ref = useRef<HTMLButtonElement>(null)
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  return {
    ref,
    anchor,
    // Reading the ref at click time rather than on mount: the trigger can be
    // conditionally rendered (the stop button only exists while busy), and a
    // mount-time read would capture null for those.
    toggle: useCallback(() => setAnchor((cur) => (cur ? null : ref.current)), []),
    close: useCallback(() => setAnchor(null), []),
  }
}

/**
 * Cursor's picker: plain text, a chevron, and no box at all.
 *
 * This replaces the `.ctl` + native `<select>` pairing, which existed only
 * because a native select cannot hold an icon — the glyph had to be a sibling
 * and the select padded to clear it. Their pickers read as a label you can
 * press, not as a form field, and that only works once the menu is ours.
 */
export default function Picker({
  icon,
  label,
  items,
  tip,
  align,
  search,
  searchPlaceholder,
  disabled,
  ariaLabel,
}: {
  icon?: React.ReactNode
  label: string
  items: MenuItem[]
  tip?: string
  align?: 'left' | 'right'
  search?: boolean
  searchPlaceholder?: string
  disabled?: boolean
  ariaLabel: string
}): React.JSX.Element {
  const menu = useMenu()
  return (
    <>
      <button
        className="picker"
        ref={menu.ref}
        type="button"
        disabled={disabled}
        data-open={menu.anchor ? '' : undefined}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={!!menu.anchor}
        data-tip={tip}
        onClick={menu.toggle}
      >
        {icon}
        <span className="picker-label">{label}</span>
        <ChevronDown size={12} className="picker-chevron" />
      </button>
      <Menu
        anchor={menu.anchor}
        items={items}
        onClose={menu.close}
        align={align}
        search={search}
        searchPlaceholder={searchPlaceholder}
      />
    </>
  )
}

/**
 * An icon-only trigger that opens a Menu — the composer's `+`, the session
 * header's `…`. Shape comes from `className`, so this stays a behaviour wrapper
 * rather than a second button style.
 */
export function MenuButton({
  children,
  items,
  className = 'btn',
  tip,
  align,
  search,
  searchPlaceholder,
  disabled,
  ariaLabel,
}: {
  children: React.ReactNode
  items: MenuItem[]
  className?: string
  tip?: string
  align?: 'left' | 'right'
  search?: boolean
  searchPlaceholder?: string
  disabled?: boolean
  ariaLabel: string
}): React.JSX.Element {
  const menu = useMenu()
  return (
    <>
      <button
        className={className}
        ref={menu.ref}
        type="button"
        disabled={disabled}
        data-open={menu.anchor ? '' : undefined}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={!!menu.anchor}
        data-tip={tip}
        onClick={menu.toggle}
      >
        {children}
      </button>
      <Menu
        anchor={menu.anchor}
        items={items}
        onClose={menu.close}
        align={align}
        search={search}
        searchPlaceholder={searchPlaceholder}
      />
    </>
  )
}
