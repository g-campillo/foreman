import { useEffect, useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import type { AgentInfo, SkillInfo } from '../../../../shared/types'
import Row, { GroupHeader } from './Row'

/** Anything without a `plugin:` prefix ships with the app rather than a plugin. */
const BUILT_IN = 'built-in'

interface Entry {
  key: string
  /** What the row shows — the prefix is dropped, the group header carries it. */
  name: string
  description?: string
  meta?: string
}

/**
 * Split `axiom:build-fixer` into its plugin and its short name.
 *
 * Namespacing is the only structure these lists have: ~40 of 47 agents are
 * plugin-prefixed, and rendering them flat means reading the same nine
 * characters forty times before reaching the part that differs. Grouping moves
 * the prefix into the heading and hands the row back to the name.
 *
 * `indexOf` rather than `split`, because a name is only allowed one namespace —
 * a hypothetical `a:b:c` keeps `b:c` as its name rather than silently losing a
 * segment.
 */
function namespaceOf(name: string): { ns: string; short: string } {
  const i = name.indexOf(':')
  return i < 0 ? { ns: BUILT_IN, short: name } : { ns: name.slice(0, i), short: name.slice(i + 1) }
}

/**
 * Group entries under their namespace.
 *
 * `built-in` is pinned first rather than sorted into the b's: it is the set that
 * is always present and never changes, so it makes a stable landmark at the top
 * of a list whose other groups come and go with what is installed.
 */
function group(entries: Entry[]): [string, Entry[]][] {
  const by = new Map<string, Entry[]>()
  for (const e of entries) {
    const { ns, short } = namespaceOf(e.name)
    const list = by.get(ns) ?? []
    list.push({ ...e, name: short })
    by.set(ns, list)
  }
  return [...by.entries()].sort(([a], [b]) =>
    a === BUILT_IN ? -1 : b === BUILT_IN ? 1 : a.localeCompare(b),
  )
}

/** Case-insensitive substring over the full name and the description. Matching
 *  the FULL name, not the shortened one, so typing `axiom` narrows to that
 *  plugin even though no visible row says `axiom`. */
function matches(e: Entry, q: string): boolean {
  if (!q) return true
  const n = q.toLowerCase()
  return e.name.toLowerCase().includes(n) || (e.description ?? '').toLowerCase().includes(n)
}

function Section({
  title,
  entries,
  empty,
}: {
  title: string
  entries: Entry[]
  empty: string
}): React.JSX.Element {
  const groups = group(entries)
  return (
    <>
      <div className="sect-head">
        <span>{title}</span>
        {entries.length > 0 && <span className="sect-n">{entries.length}</span>}
      </div>
      {!entries.length ? (
        <p className="sect-empty">{empty}</p>
      ) : (
        groups.map(([ns, list]) => (
          <div key={ns} className="slist">
            <GroupHeader label={ns} count={list.length} />
            {list.map((e) => (
              <Row key={e.key} name={e.name} meta={e.meta} tip={e.description} />
            ))}
          </div>
        ))
      )}
    </>
  )
}

/**
 * Everything the agent can delegate to, and everything it can read as a
 * procedure.
 *
 * One tab rather than two because they are the same question asked twice — what
 * capabilities does this session have — and because skills alone would be a tab
 * that is empty until you press a button.
 */
export default function AgentsTab({
  sessionId,
  agents,
}: {
  sessionId: string
  /** `null` while the panel's batched fetch is still out — which is not the
   *  same claim as "this session has no agents", and the empty state says so. */
  agents: AgentInfo[] | null
}): React.JSX.Element {
  const [skills, setSkills] = useState<SkillInfo[] | null>(null)
  const [q, setQ] = useState('')

  /* Every visit, not once — this component is mounted only while its tab is
     selected, so mount IS activation and there is no `active` prop to key off.

     Per visit rather than once because the SDK has no read-only skill listing:
     seeing them at all means asking it to re-read the directory, which makes
     "show me the skills" and "pick up the skill I just edited" the same call.
     Re-running it on entry is the only way the list is ever trustworthy.

     `live` guards the unmount that a fast tab-switch causes. */
  useEffect(() => {
    let live = true
    void window.foreman
      .reloadSkills(sessionId)
      .then((s) => {
        if (live) setSkills(s)
      })
      /* An empty list, not a swallowed rejection: `skills` staying null is the
         "Loading…" state, so a silent catch would strand the section on a
         spinner-word forever. Not reachable today — the main process already
         degrades this to [] — but the failure it guards is invisible, which is
         exactly the kind worth costing one line. */
      .catch(() => {
        if (live) setSkills([])
      })
    return () => {
      live = false
    }
  }, [sessionId])

  const agentEntries = useMemo<Entry[]>(
    () =>
      (agents ?? []).map((a) => ({
        key: a.name,
        name: a.name,
        description: a.description,
        meta: a.model ?? 'inherits',
      })),
    [agents],
  )
  const skillEntries = useMemo<Entry[]>(
    () => (skills ?? []).map((s) => ({ key: s.name, name: s.name, description: s.description })),
    [skills],
  )

  const a = agentEntries.filter((e) => matches(e, q))
  const s = skillEntries.filter((e) => matches(e, q))

  return (
    <>
      <div className="sfilter">
        <Search size={12} />
        <input
          value={q}
          placeholder="Filter agents and skills…"
          aria-label="Filter agents and skills"
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {/* "Loading…" and "None available." are different claims, and the panel
          only fetches between turns — so mid-turn the pre-fetch state persists
          for as long as the turn does. Saying "none" for that whole time is
          wrong, and it is the same reasoning the tab counts use. */}
      <Section
        title="Agents"
        entries={a}
        empty={agents === null ? 'Loading…' : q ? 'No agents match.' : 'None available.'}
      />
      <Section
        title="Skills"
        entries={s}
        empty={skills === null ? 'Loading…' : q ? 'No skills match.' : 'None found.'}
      />
    </>
  )
}
