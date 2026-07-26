import { create } from 'zustand'
import type {
  Appearance,
  ChatItem,
  ElicitationRequest,
  ModelInfo,
  PermissionRequest,
  RewindResult,
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

  /** Transient one-liner shown above the rail — a kept worktree, a failed open. */
  notice: string | null
  setNotice(notice: string | null): void

  select(id: string): void
  openPath(cwd: string, worktreeBranch?: string): Promise<void>
  newSession(worktreeBranch?: string): Promise<void>
  resume(sessionId: string, cwd: string, title: string): Promise<void>
  hydrate(meta: SessionMeta): Promise<void>
  fork(upToMessageId?: string): Promise<void>
  /** Dry-run preview awaiting confirmation, or null. */
  rewindPreview: { messageId: string; result: RewindResult } | null
  rewind(messageId: string): Promise<void>
  confirmRewind(): Promise<void>
  cancelRewind(): void
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

/**
 * The message a main-process throw was actually raised with.
 *
 * Electron re-wraps it on the way across the bridge as
 * `Error invoking remote method 'session:create': Error: <the real message>`,
 * so showing `err.message` verbatim buries a perfectly good sentence like
 * "Branch foreman/x already exists." behind IPC plumbing. Splitting on the LAST
 * `Error: ` unwraps that without caring how many layers deep it went.
 */
function ipcMessage(err: unknown): string {
  const raw = String((err as Error)?.message ?? err)
  const at = raw.lastIndexOf('Error: ')
  return at === -1 ? raw : raw.slice(at + 'Error: '.length)
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
      ? {
          ...prev,
          ...item,
          name: item.name || prev.name,
          input: item.input ?? prev.input,
          // Progress updates are emitted as 'pending' because that's the only
          // status the tool variant allows on a partial patch. Never let one
          // arriving late put a settled card back into its spinner.
          status: item.status === 'pending' && prev.status !== 'pending' ? prev.status : item.status,
        }
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
  rewindPreview: null,
  diffCounts: {},
  models: [],
  appearance: INITIAL_APPEARANCE,
  resolvedTheme: resolveTheme(INITIAL_APPEARANCE.theme),
  notice: null,

  setNotice(notice) {
    set({ notice })
  },

  select(id) {
    set({ activeId: id })
    void window.foreman.supportedModels(id).then((models: ModelInfo[]) => {
      if (models?.length) set({ models })
    })
  },

  async openPath(cwd, worktreeBranch) {
    let meta: SessionMeta
    try {
      meta = await window.foreman.createSession({ cwd, worktreeBranch })
    } catch (err) {
      // Worktree creation is the one failure mode here that happens for ordinary
      // reasons (branch taken, no commits yet), so it needs saying rather than
      // leaving the New button looking dead.
      set({ notice: ipcMessage(err) })
      return
    }
    set((s) => ({ sessions: [...s.sessions, meta], activeId: meta.id, notice: null }))
    get().select(meta.id)
  },

  async newSession(worktreeBranch) {
    const cwd = await window.foreman.pickDirectory()
    if (!cwd) return
    await get().openPath(cwd, worktreeBranch)
  },

  async resume(sessionId, cwd, title) {
    const meta: SessionMeta = await window.foreman.resumeSession({ cwd, resume: sessionId, title })
    set((s) => ({ sessions: [...s.sessions, meta], activeId: meta.id }))
    get().select(meta.id)
    await get().hydrate(meta)
  },

  /**
   * Fill a session's transcript from disk.
   *
   * ChatItems only ever lived in this store, so before this a resumed session
   * came back with a working agent and an empty conversation. Prepended rather
   * than assigned, so anything the live session has already emitted survives a
   * slow read.
   */
  async hydrate(meta) {
    if (!meta.sdkSessionId) return
    const past: ChatItem[] = await window.foreman.sessionTranscript(meta.sdkSessionId, meta.cwd)
    if (!past.length) return
    set((s) => {
      const live = s.items[meta.id] ?? []
      const seen = new Set(live.map((i) => i.id))
      return { items: { ...s.items, [meta.id]: [...past.filter((p) => !seen.has(p.id)), ...live] } }
    })
  },

  /**
   * Branch the active conversation, optionally slicing it at a message.
   *
   * forkSession only writes the new transcript to disk — it doesn't open it —
   * so this resumes the fork, which is also what hydrates its history.
   */
  async fork(upToMessageId) {
    const cur = get().sessions.find((x) => x.id === get().activeId)
    if (!cur?.sdkSessionId) return
    const forked: string | null = await window.foreman.forkSession(
      cur.sdkSessionId,
      upToMessageId,
      `${cur.title} (branch)`,
    )
    if (!forked) return
    await get().resume(forked, cur.cwd, `${cur.title} (branch)`)
  },

  /**
   * Restore files to their state at a message.
   *
   * The dry run is free and reports exactly what would change, so this only
   * stages a preview — nothing is written until confirmRewind(). Rendered as a
   * card rather than window.confirm(), which in Electron blocks the whole
   * renderer until dismissed.
   */
  async rewind(messageId) {
    const id = get().activeId
    if (!id) return
    const result: RewindResult = await window.foreman.rewind(id, messageId, true)
    set({ rewindPreview: { messageId, result } })
  },

  async confirmRewind() {
    const pending = get().rewindPreview
    const id = get().activeId
    set({ rewindPreview: null })
    if (!pending || !id) return
    const done: RewindResult = await window.foreman.rewind(id, pending.messageId, false)
    // Report the outcome in the transcript rather than a modal, same reasoning.
    set((s) => {
      const list = s.items[id] ?? []
      // File counts come from the PREVIEW: a real rewind doesn't populate
      // filesChanged (measured — it restored a file and reported 0), so reading
      // them off `done` would report "Rewound 0 file(s)" after a successful one.
      // Only skippedLinks is real-rewind-only.
      const n = pending.result.filesChanged.length
      const text = done.canRewind
        ? `Rewound ${n} file${n === 1 ? '' : 's'}${done.skippedLinks ? ` · skipped ${done.skippedLinks} for link safety` : ''}`
        : `Rewind failed: ${done.error ?? 'unknown error'}`
      return {
        items: {
          ...s.items,
          [id]: [...list, { id: crypto.randomUUID(), kind: 'error' as const, text }],
        },
      }
    })
  },

  cancelRewind() {
    set({ rewindPreview: null })
  },

  async close(id) {
    // Closing a worktree session may leave the checkout behind on purpose, and
    // that only comes back from main — the renderer can't tell if it was dirty.
    const { notice } = (await window.foreman.closeSession(id)) ?? {}
    set((s) => {
      const sessions = s.sessions.filter((x) => x.id !== id)
      const { [id]: _drop, ...items } = s.items
      return {
        sessions,
        items,
        activeId: s.activeId === id ? (sessions[0]?.id ?? null) : s.activeId,
        notice: notice ?? s.notice,
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
      set((s) => {
        const sessions = s.sessions.filter((x) => x.id !== sessionId)
        // Repair the selection here, not only in close(): a session can also go
        // away from main's side, and a dangling activeId renders the empty
        // state while a perfectly good session sits in the rail.
        return {
          sessions,
          activeId: s.activeId === sessionId ? (sessions[0]?.id ?? null) : s.activeId,
        }
      })
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
          // A reload empties this store while main keeps the Session objects,
          // so adopted sessions need their transcripts back too.
          await Promise.all(live.map((m) => get().hydrate(m)))
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
