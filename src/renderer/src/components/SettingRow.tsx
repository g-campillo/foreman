/**
 * The two shapes every settings row comes in: label left, control right.
 *
 * TWO COMPONENTS, NOT ONE WITH A BOOLEAN, and that is a correctness argument
 * rather than a taste one. A toggle row has to be a `<label>`, because that is
 * what makes the whole row a hit target for its checkbox and what gives the
 * checkbox its accessible name for free. A choice row must NOT be one: `<label>`
 * forwards its click to the first *labelable* descendant, and a `<button>` — a
 * Picker's trigger — is not labelable, so the wrapper would label nothing,
 * forward nothing, and quietly announce the wrong element. One component taking
 * `asLabel` would make that combination representable; two cannot.
 *
 * Both replace a stacked `<label>` block that put the control UNDER its own
 * caption, at ~51px a row. Beside it, a row is ~32px.
 */

/** Shared by both: the left-hand column, and the 14px glyph slot in front of it. */
interface RowText {
  /** Optional, and rendered at 14px like every other chrome glyph. */
  icon?: React.ReactNode
  label: string
  /** Why the setting exists, under the label. Several of these are decisions
   *  with a real cost, and a bare label cannot say which. */
  hint?: React.ReactNode
}

/**
 * A row whose control is a child — a Picker, a button, anything with its own
 * accessible name. `aria-label` on the control is the caller's job for exactly
 * the reason above: this wrapper cannot label it.
 */
export function SettingRow({
  icon,
  label,
  hint,
  children,
}: RowText & { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="setting">
      <div className="setting-text">
        <span className="setting-label">
          {icon}
          {label}
        </span>
        {hint && <span className="setting-hint">{hint}</span>}
      </div>
      {children}
    </div>
  )
}

/**
 * A boolean row. Takes the value and the setter rather than a child, so the
 * `<label>` can wrap a real `<input type="checkbox">` — the whole reason this is
 * a separate component.
 *
 * The switch is written LAST so tab order follows reading order; the grid puts
 * it in the second column either way.
 */
export function SettingToggle({
  icon,
  label,
  hint,
  value,
  onChange,
}: RowText & { value: boolean; onChange: (v: boolean) => void }): React.JSX.Element {
  return (
    <label className="setting">
      <div className="setting-text">
        <span className="setting-label">
          {icon}
          {label}
        </span>
        {hint && <span className="setting-hint">{hint}</span>}
      </div>
      <input
        className="switch"
        type="checkbox"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  )
}
