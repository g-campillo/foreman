import { create } from 'zustand'
import type {
  Appearance,
  ChatItem,
  ElicitationRequest,
  ModelInfo,
  PermissionRequest,
  SendContent,
  SessionMeta,
} from '../../shared/types'

interface State {
  sessions: SessionMeta[]
  activeId: string | null
  items: Record<string, ChatItem[]>
  approvals: PermissionRequest[]
  elicitations: ElicitationRequest[]
  diffCounts: Record<string, number>
  models: ModelInfo[]
  appearance: Appearance
  /** appearance.theme with 'auto' already resolved against the OS. */
  resolvedTheme: 'dark' | 'light'

  select(id: string): void
  openPath(cwd: string): Promise<void>
  newSession(): Promise<void>
  resume(sessionId: string, cwd: string, title: string): Promise<void>
  close(id: string): Promise<void>
  send(content: SendContent): Promise<void>
  setAppearance(patch: Partial<Appearance>): void
  bootstrap(): void
}

/** Keep in sync with the :root defaults in theme.css — bootstrap() applies these
 *  over the stylesheet on every launch, so a mismatch silently wins here. */
const DEFAULT_APPEARANCE: Appearance = {
  surfaceAlpha: 0.82,
  terminalAlpha: 0.45,
  theme: 'auto',
  vibrancy: 'under-window',
}

const DARK_QUERY = '(prefers-color-scheme: dark)'

function resolveTheme(t: Appearance['theme']): 'dark' | 'light' {
  if (t !== 'auto') return t
  return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light'
}

/**
 * A light fill needs far more opacity than a dark one to stay legible over the
 * desktop. The window is transparent, so whatever alpha is set here is literally
 * how much wallpaper bleeds through: a dark surface visibly darkens a bright
 * photo even at 0.8, while a near-white surface barely changes it and the
 * dim/faint text greys wash out against it.
 *
 * Remapped across the whole range rather than clamped, so the slider stays live
 * end to end instead of growing a dead zone at the bottom.
 */
function fillFor(alpha: number, theme: 'dark' | 'light'): number {
  return theme === 'light' ? 0.72 + alpha * 0.28 : alpha
}

let booted = false

function loadAppearance(): Appearance {
  try {
    const raw = localStorage.getItem('foreman.appearance')
    if (!raw) return DEFAULT_APPEARANCE
    const saved = JSON.parse(raw) as Partial<Appearance>
    // Take only keys we still know about, so retired ones (the old CSS-blur
    // setting) don't ride along forever in localStorage.
    return {
      surfaceAlpha: saved.surfaceAlpha ?? DEFAULT_APPEARANCE.surfaceAlpha,
      terminalAlpha: saved.terminalAlpha ?? DEFAULT_APPEARANCE.terminalAlpha,
      theme: saved.theme ?? DEFAULT_APPEARANCE.theme,
      vibrancy: saved.vibrancy !== undefined ? saved.vibrancy : DEFAULT_APPEARANCE.vibrancy,
    }
  } catch {
    return DEFAULT_APPEARANCE
  }
}

const INITIAL_APPEARANCE = loadAppearance()

export function applyAppearance(a: Appearance): void {
  const s = document.documentElement.style
  const theme = resolveTheme(a.theme)
  s.setProperty('--surface-alpha', String(fillFor(a.surfaceAlpha, theme)))
  s.setProperty('--terminal-alpha', String(fillFor(a.terminalAlpha, theme)))
  // Everything CSS-side keys off this attribute; nothing else needs telling.
  // The exception is xterm, which takes colour literals rather than CSS vars —
  // it watches resolvedTheme instead, which is why that lives in the store.
  document.documentElement.dataset.theme = theme
  useStore.setState({ resolvedTheme: theme })
  // Blur is a window-level vibrancy material, not CSS — see Appearance.vibrancy.
  void window.foreman.setVibrancy(a.vibrancy)
}

/** Replace-by-id, but merge tool cards so a tool_result doesn't wipe name/input. */
function upsert(list: ChatItem[], item: ChatItem): ChatItem[] {
  const i = list.findIndex((x) => x.id === item.id)
  if (i === -1) return [...list, item]

  const prev = list[i]
  const merged: ChatItem =
    prev.kind === 'tool' && item.kind === 'tool'
      ? { ...prev, ...item, name: item.name || prev.name, input: item.input ?? prev.input }
      : item

  const next = [...list]
  next[i] = merged
  return next
}

export const useStore = create<State>((set, get) => ({
  sessions: [],
  activeId: null,
  items: {},
  approvals: [],
  elicitations: [],
  diffCounts: {},
  models: [],
  appearance: INITIAL_APPEARANCE,
  resolvedTheme: resolveTheme(INITIAL_APPEARANCE.theme),

  select(id) {
    set({ activeId: id })
    void window.foreman.supportedModels(id).then((models: ModelInfo[]) => {
      if (models?.length) set({ models })
    })
  },

  async openPath(cwd) {
    const meta: SessionMeta = await window.foreman.createSession({ cwd })
    set((s) => ({ sessions: [...s.sessions, meta], activeId: meta.id }))
    get().select(meta.id)
  },

  async newSession() {
    const cwd = await window.foreman.pickDirectory()
    if (!cwd) return
    await get().openPath(cwd)
  },

  async resume(sessionId, cwd, title) {
    const meta: SessionMeta = await window.foreman.resumeSession({ cwd, resume: sessionId, title })
    set((s) => ({ sessions: [...s.sessions, meta], activeId: meta.id }))
    get().select(meta.id)
  },

  async close(id) {
    await window.foreman.closeSession(id)
    set((s) => {
      const sessions = s.sessions.filter((x) => x.id !== id)
      const { [id]: _drop, ...items } = s.items
      return {
        sessions,
        items,
        activeId: s.activeId === id ? (sessions[0]?.id ?? null) : s.activeId,
      }
    })
  },

  async send(content) {
    const id = get().activeId
    if (!id) return
    // Blocks are only built when there's an attachment, and an attachment with
    // no text is still worth sending.
    if (typeof content === 'string' && !content.trim()) return
    if (Array.isArray(content) && content.length === 0) return
    await window.foreman.sendMessage(id, content)
  },

  setAppearance(patch) {
    const appearance = { ...get().appearance, ...patch }
    set({ appearance })
    applyAppearance(appearance)
    localStorage.setItem('foreman.appearance', JSON.stringify(appearance))
  },

  bootstrap() {
    // HMR re-executes main.tsx, which would register a second set of IPC
    // listeners; every event then lands twice and non-idempotent reducers
    // (approvals) end up with duplicate entries.
    if (booted) return
    booted = true

    applyAppearance(get().appearance)

    window.foreman.onItem(({ sessionId, item }: { sessionId: string; item: ChatItem }) => {
      set((s) => ({ items: { ...s.items, [sessionId]: upsert(s.items[sessionId] ?? [], item) } }))
    })

    window.foreman.onDelta(
      ({ sessionId, itemId, text }: { sessionId: string; itemId: string; text: string }) => {
        set((s) => {
          const list = s.items[sessionId]
          if (!list) return s
          const i = list.findIndex((x) => x.id === itemId)
          if (i === -1) return s
          const prev = list[i]
          if (prev.kind !== 'assistant' && prev.kind !== 'thinking') return s
          const next = [...list]
          next[i] = { ...prev, text: prev.text + text }
          return { items: { ...s.items, [sessionId]: next } }
        })
      },
    )

    window.foreman.onMeta(
      ({ sessionId, patch }: { sessionId: string; patch: Partial<SessionMeta> }) => {
        set((s) => ({
          sessions: s.sessions.map((x) => (x.id === sessionId ? { ...x, ...patch } : x)),
        }))
      },
    )

    window.foreman.onRemoved(({ sessionId }: { sessionId: string }) => {
      set((s) => ({ sessions: s.sessions.filter((x) => x.id !== sessionId) }))
    })

    window.foreman.onQueue(
      ({
        sessionId,
        itemId,
        state,
      }: {
        sessionId: string
        itemId: string
        state: 'started' | 'dropped'
      }) => {
        set((s) => {
          const list = s.items[sessionId]
          if (!list) return s
          const next =
            state === 'dropped'
              ? list.filter((x) => x.id !== itemId)
              : list.map((x) => (x.id === itemId && x.kind === 'user' ? { ...x, queued: false } : x))
          return { items: { ...s.items, [sessionId]: next } }
        })
      },
    )

    window.foreman.onPermissionRequest((req: PermissionRequest) => {
      set((s) =>
        s.approvals.some((a) => a.requestId === req.requestId)
          ? s
          : { approvals: [...s.approvals, req] },
      )
    })

    window.foreman.onPermissionResolved(({ requestId }: { requestId: string }) => {
      set((s) => ({ approvals: s.approvals.filter((a) => a.requestId !== requestId) }))
    })

    window.foreman.onElicitationRequest((req: ElicitationRequest) => {
      set((s) =>
        s.elicitations.some((e) => e.requestId === req.requestId)
          ? s
          : { elicitations: [...s.elicitations, req] },
      )
    })

    window.foreman.onElicitationResolved(({ requestId }: { requestId: string }) => {
      set((s) => ({ elicitations: s.elicitations.filter((e) => e.requestId !== requestId) }))
    })

    window.foreman.onDiffChanged(({ sessionId, count }: { sessionId: string; count: number }) => {
      set((s) => ({ diffCounts: { ...s.diffCounts, [sessionId]: count } }))
    })

    // A renderer reload empties this store, but main still holds the live Session
    // objects — so re-adopt them. Opening the initial project lives here too, and
    // not in an App effect, because it must lose the race with this: otherwise a
    // reload opens a second session on the same cwd.
    // ponytail: transcripts come back empty, since ChatItems only ever lived in
    // this store. A bounded per-session ring buffer in main is the fix if it bites.
    void window.foreman
      .listSessions()
      .then(async (live: SessionMeta[]) => {
        if (live?.length) {
          set({ sessions: live })
          get().select(live[0].id)
          return
        }
        const p: string | null = await window.foreman.initialProject()
        if (p) await get().openPath(p)
      })
      .catch(() => undefined)
  },
}))

// Follow the OS while the theme is 'auto'. Registered here, once, rather than
// inside applyAppearance — which runs on every slider drag and would stack a
// fresh listener each time.
window.matchMedia(DARK_QUERY).addEventListener('change', () => {
  const a = useStore.getState().appearance
  if (a.theme === 'auto') applyAppearance(a)
})

export const activeSession = (s: State): SessionMeta | undefined =>
  s.sessions.find((x) => x.id === s.activeId)
