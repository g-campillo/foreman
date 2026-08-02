/**
 * The session panel's one list row, shared by MCP servers, agents and skills.
 *
 * Dense on purpose. There are four MCP servers on a typical machine but ~47
 * agents and ~62 skills, and a two-line row at that count is a 1,900px scroll
 * for descriptions that get truncated mid-sentence anyway. So the row is a
 * single 26px line and the description lives in the tooltip, where it wraps and
 * is read in full.
 *
 * `data-tip` rather than `title`: `Tooltip` renders one bubble at .app level
 * precisely because `.pane { overflow: hidden }` and `.pane-fill`'s
 * `contain: paint` clip anything a pane tries to float itself. A native title
 * escapes that, but then the app has two tooltip treatments — so everything
 * hoverable in here goes through the same one.
 */

/** Status hues are the panel's, not the row's — see `.mcp-dot[data-status]`. */
export function StatusDot({ status }: { status?: string }): React.JSX.Element {
  return <i className="mcp-dot" data-status={status} />
}

/**
 * The right-hand status word.
 *
 * A pill rather than bold text because these read as states (`failed`,
 * `sign in`) sitting beside counts (`6 tools`), and a shared shape is what stops
 * the eye parsing the count as another state.
 */
export function Pill({
  children,
  tone,
}: {
  children: React.ReactNode
  /** Omitted for the neutral case. Matches `.spill[data-tone]`. */
  tone?: 'ok' | 'warn' | 'danger'
}): React.JSX.Element {
  return (
    <span className="spill" data-tone={tone}>
      {children}
    </span>
  )
}

/**
 * A namespace heading inside a tab: `axiom ──────── 34`.
 *
 * The rule between label and count is what keeps a bare word from reading as
 * another row; `.sect-head` was not reused because that is the tab-level
 * heading and nesting two identical uppercase labels loses the hierarchy.
 */
export function GroupHeader({ label, count }: { label: string; count: number }): React.JSX.Element {
  return (
    <div className="sgrp">
      <span>{label}</span>
      <i />
      <span>{count}</span>
    </div>
  )
}

export default function Row({
  dot,
  name,
  note,
  meta,
  tip,
  sub,
  actions,
}: {
  /** MCP status, drawn as a coloured dot. Absent for agents and skills. */
  dot?: string
  name: string
  /** Dim trailing text on the name line — MCP scope, an agent's namespace. */
  note?: string
  /** Right-aligned. A count, a model name, or a <Pill>. */
  meta?: React.ReactNode
  /** Hover detail. The description, in full. */
  tip?: string
  /** The failure carve-out: a second line, only when something is wrong. */
  sub?: string
  actions?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="srow" data-tip={tip || undefined}>
      <div className="srow-main">
        {dot !== undefined && <StatusDot status={dot} />}
        <span className="srow-name">{name}</span>
        {note && <span className="srow-note">{note}</span>}
        {/* Guarded, not always rendered: a skill row has no meta, and an empty
            box still eats one 8px gap from the name's width — across ~62 rows
            that is a column of truncation bought for nothing. */}
        {meta !== undefined && <span className="srow-meta">{meta}</span>}
        {actions && <span className="srow-acts">{actions}</span>}
      </div>
      {sub && <div className="srow-sub">{sub}</div>}
    </div>
  )
}
