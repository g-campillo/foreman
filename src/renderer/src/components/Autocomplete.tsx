import { useEffect, useRef } from 'react'

export interface Suggestion {
  /** Inserted into the composer when chosen. */
  value: string
  label: string
  hint?: string
}

/**
 * The composer's completion popover.
 *
 * One widget for both triggers on purpose: slash commands and @-file mentions
 * differ only in what fills `items`, and building them separately means building
 * this twice.
 *
 * The selected index is owned by the composer, because the composer owns the
 * keyboard — the textarea keeps focus the whole time, so Arrow/Enter/Tab have to
 * be handled where the keystrokes actually land.
 */
export default function Autocomplete({
  items,
  cursor,
  onPick,
}: {
  items: Suggestion[]
  cursor: number
  onPick: (s: Suggestion) => void
}): React.JSX.Element | null {
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    box.current?.querySelector('[data-sel]')?.scrollIntoView({ block: 'nearest' })
  }, [cursor, items])

  if (!items.length) return null

  return (
    <div className="ac" ref={box}>
      {items.map((s, i) => (
        <button
          key={s.value}
          className="ac-row"
          data-sel={i === cursor ? '' : undefined}
          // mousedown, not click: the textarea must not lose focus, and click
          // fires after the blur that would already have closed the popover.
          onMouseDown={(e) => {
            e.preventDefault()
            onPick(s)
          }}
        >
          <span className="ac-label">{s.label}</span>
          {s.hint && <span className="ac-hint">{s.hint}</span>}
        </button>
      ))}
    </div>
  )
}
