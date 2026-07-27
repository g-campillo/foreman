import { useMemo } from 'react'
import { focusTarget, type FocusTarget } from './derive.mts'
import { useStore } from './store'

/**
 * Where the agent is working, derived from the transcript.
 *
 * No new hook, no new IPC channel, no new ChatItem arm. `session.ts` emits a
 * `tool` ChatItem the moment a tool_use block lands — BEFORE the tool runs — so
 * this already knows the agent is about to read store.ts at offset 40. For a
 * Read the editor can arrive ahead of the agent.
 *
 * SELECTS A PRIMITIVE, and that is the whole reason this is a hook rather than
 * three lines inlined twice. A selector returning a derived array builds a new
 * reference on every store write, and during a streaming turn there is a store
 * write per token — so the tree and the editor would re-render on every token
 * of every message. Selecting the last tool id instead means they re-render
 * when the agent moves, which is the actual signal.
 */
export interface AgentFocus {
  /** The tool call the agent is on right now, or null. */
  current: FocusTarget | null
  /** Absolute paths touched this session, most recent first, capped. */
  recent: string[]
  /** True while that call is still running — what the tree pulses on. */
  live: boolean
}

/** Enough to colour a tree; more than this is noise. */
const RECENT_LIMIT = 12

export function useAgentFocus(sessionId: string | null): AgentFocus {
  // Primitive selectors only. `key` changes when the agent moves to another
  // tool call OR that call settles, and at no other time.
  const key = useStore((s) => {
    if (!sessionId) return null
    const items = s.items[sessionId]
    if (!items) return null
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i]!
      // Subagents stream concurrently and each has its own tool calls; following
      // them would thrash the viewport between four files at once. Main thread
      // only — items with a parentId are excluded.
      if (it.kind === 'tool' && !it.parentId) return `${it.id}:${it.status}`
    }
    return null
  })

  return useMemo<AgentFocus>(() => {
    if (!sessionId) return { current: null, recent: [], live: false }
    // Read the full list once, outside the selector, so the cost is paid when
    // `key` changes rather than on every store write.
    const items = useStore.getState().items[sessionId] ?? []

    let current: FocusTarget | null = null
    let live = false
    const recent: string[] = []

    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i]!
      if (it.kind !== 'tool' || it.parentId) continue
      const t = focusTarget(it.name, it.input)
      if (!t) continue
      if (!current) {
        current = t
        live = it.status === 'pending'
      }
      if (!recent.includes(t.path) && recent.length < RECENT_LIMIT) recent.push(t.path)
    }
    return { current, recent, live }
    // `key` is the dependency; sessionId guards a session switch.
  }, [key, sessionId])
}
