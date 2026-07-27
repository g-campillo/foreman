import { create } from 'zustand'
import type {
  Appearance,
  ChatItem,
  Prefs,
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
  /** Live checked-out branch per session, from git. null on a detached HEAD. */
  branches: Record<string, string | null>
  models: ModelInfo[]
  appearance: Appearance
  /** appearance.theme with 'auto' already resolved against the OS. */
  resolvedTheme: 'dark' | 'light'
  /** App behaviour. The session-start three are never written by the composer. */
  prefs: Prefs
  setPrefs(patch: Partial<Prefs>): void

  /** Transient one-liner shown above the rail — a kept worktree, a failed open. */
  notice: string | null
  setNotice(notice: string | null): void

  /**
   * A conversation that exists in the UI but has no project yet.
   *
   * Renderer-only and deliberately so: `createSession` requires a cwd (an empty
   * one resolves to the process's own directory and silently starts the agent
   * in the wrong place), so there is nothing to create in main until a project
   * is picked. This is the Claude-app flow — open a new conversation, then say
   * where it runs — without a half-built session in the manager.
   */
  draft: boolean
  startDraft(): void
  cancelDraft(): void

  select(id: string): void
  openPath(cwd: string, worktreeBranch?: string): Promise<void>
  newSession(worktreeBranch?: string): Promise<void>
  /** Always asks for a folder — the "different repo" case ⌘N no longer covers. */
  openProject(worktreeBranch?: string): Promise<void>
  resume(sessionId: string, cwd: string, title: string): Promise<void>
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

/**
 * Out-of-the-box behaviour.
 *
 * `agentLifetime: 'persist'` is the deliberate default: it is what makes a
 * crash survivable, and the 30-minute idle stop is what keeps that from leaking
 * an agent per session forever.
 */
const DEFAULT_PREFS: Prefs = {
  permissionMode: 'default',
  model: '',
  effort: null,
  agentLifetime: 'persist',
  agentIdleMinutes: 30,
  autoTitle: true,
  notifications: true,
  workingVerbs: true,
  maxBudgetUsd: 0,
  maxTurns: 0,
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

/** Same key-by-key pick as loadAppearance, for the same reason: a retired key
 *  must not ride along in localStorage forever. `??` throughout, so a `false`
 *  or `0` the user actually chose is kept rather than falling back. */
function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem('foreman.prefs')
    if (!raw) return DEFAULT_PREFS
    const v = JSON.parse(raw) as Partial<Prefs>
    return {
      permissionMode: v.permissionMode ?? DEFAULT_PREFS.permissionMode,
      model: v.model ?? DEFAULT_PREFS.model,
      effort: v.effort ?? DEFAULT_PREFS.effort,
      agentLifetime: v.agentLifetime ?? DEFAULT_PREFS.agentLifetime,
      agentIdleMinutes: v.agentIdleMinutes ?? DEFAULT_PREFS.agentIdleMinutes,
      autoTitle: v.autoTitle ?? DEFAULT_PREFS.autoTitle,
      notifications: v.notifications ?? DEFAULT_PREFS.notifications,
      workingVerbs: v.workingVerbs ?? DEFAULT_PREFS.workingVerbs,
      maxBudgetUsd: v.maxBudgetUsd ?? DEFAULT_PREFS.maxBudgetUsd,
      maxTurns: v.maxTurns ?? DEFAULT_PREFS.maxTurns,
    }
  } catch {
    return DEFAULT_PREFS
  }
}

/** Main can't read localStorage, and these decide what happens on quit. */
function pushPolicy(p: Prefs): void {
  void window.foreman.setAgentPolicy({
    lifetime: p.agentLifetime,
    idleMinutes: p.agentIdleMinutes,
    notifications: p.notifications,
  })
}

/**
 * The model list, cached from the last live session.
 *
 * Settings needs it before any session exists — the list only comes from
 * `supportedModels(sessionId)` — and it also stops the composer's picker
 * showing 'Loading…' for the first frames after launch. Stale by construction,
 * and overwritten by the real list as soon as a session reports one.
 */
function loadModels(): ModelInfo[] {
  try {
    const raw = localStorage.getItem('foreman.models')
    const saved = raw ? (JSON.parse(raw) as unknown) : null
    return Array.isArray(saved) ? (saved as ModelInfo[]) : []
  } catch {
    return []
  }
}

/**
 * The subset of prefs a session is created with.
 *
 * Sent at creation rather than applied afterwards: setModel/setEffort need the
 * CLI subprocess to be ready, so patching a fresh session would flash the wrong
 * values first. Empty/zero values are OMITTED, not sent — '' is not a model
 * alias and 0 means "no cap", and both must be absent rather than present.
 */
function sessionPrefs(p: Prefs): Record<string, unknown> {
  return {
    permissionMode: p.permissionMode,
    autoTitle: p.autoTitle,
    ...(p.model ? { model: p.model } : {}),
    ...(p.effort ? { effort: p.effort } : {}),
    ...(p.maxBudgetUsd > 0 ? { maxBudgetUsd: p.maxBudgetUsd } : {}),
    ...(p.maxTurns > 0 ? { maxTurns: p.maxTurns } : {}),
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
  branches: {},
  models: loadModels(),
  appearance: INITIAL_APPEARANCE,
  resolvedTheme: resolveTheme(INITIAL_APPEARANCE.theme),
  prefs: loadPrefs(),
  notice: null,
  draft: false,

  setNotice(notice) {
    set({ notice })
  },

  startDraft() {
    set({ draft: true })
  },

  cancelDraft() {
    set({ draft: false })
  },

  setPrefs(patch) {
    const prefs = { ...get().prefs, ...patch }
    set({ prefs })
    localStorage.setItem('foreman.prefs', JSON.stringify(prefs))
    pushPolicy(prefs)
  },

  select(id) {
    // Clears the draft too: picking an existing conversation is a perfectly
    // good way to abandon a new one, and without this the chooser would stay
    // up over whichever session you just clicked.
    set({ activeId: id, draft: false })
    void window.foreman.supportedModels(id).then((models: ModelInfo[]) => {
      if (!models?.length) return
      set({ models })
      // Cached so Settings has a list before any session exists — see loadModels.
      localStorage.setItem('foreman.models', JSON.stringify(models))
    })
  },

  async openPath(cwd, worktreeBranch) {
    let meta: SessionMeta
    try {
      // The configured defaults ride out here rather than being applied after
      // the fact: setModel/setEffort need the CLI subprocess to be ready, so
      // patching a fresh session would flash the wrong values first.
      meta = await window.foreman.createSession({ cwd, worktreeBranch, ...sessionPrefs(get().prefs) })
    } catch (err) {
      // Worktree creation is the one failure mode here that happens for ordinary
      // reasons (branch taken, no commits yet), so it needs saying rather than
      // leaving the New button looking dead.
      set({ notice: ipcMessage(err) })
      return
    }
    // The draft resolves the moment a project is chosen — this is the one call
    // every entry point into "new conversation" funnels through.
    set((s) => ({ sessions: [...s.sessions, meta], activeId: meta.id, notice: null, draft: false }))
    get().select(meta.id)
  },

  /**
   * ⌘N and the New button: another conversation in the project you're already
   * in. Only falls back to the folder picker when there's nothing open to infer
   * a project from — being asked to pick a folder you already have open is the
   * wrong answer to "new conversation".
   */
  async newSession(worktreeBranch) {
    const cwd = activeSession(get())?.cwd
    if (cwd) return get().openPath(cwd, worktreeBranch)
    await get().openProject(worktreeBranch)
  },

  async openProject(worktreeBranch) {
    const cwd = await window.foreman.pickDirectory()
    if (!cwd) return
    await get().openPath(cwd, worktreeBranch)
  },

  async resume(sessionId, cwd, title) {
    // Defaults apply on resume too: without them a reopened conversation lands
    // on the SDK's 'default' mode regardless of what the user configured, which
    // is strictly more surprising than honouring their setting.
    const meta: SessionMeta = await window.foreman.resumeSession({
      cwd,
      resume: sessionId,
      title,
      ...sessionPrefs(get().prefs),
    })
    set((s) => ({ sessions: [...s.sessions, meta], activeId: meta.id, draft: false }))
    get().select(meta.id)
    // No hydrate() here: the host reads the stored transcript into its own
    // event log at startup and streams it as ordinary items, so it arrives on
    // the same channel as everything else.
    await window.foreman.replaySessions()
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
    // Main starts with no policy; tell it before anything can quit.
    pushPolicy(get().prefs)

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

    window.foreman.onDiffChanged(
      ({
        sessionId,
        count,
        branch,
      }: {
        sessionId: string
        count: number
        branch: string | null
      }) => {
        set((s) => {
          // Bail when nothing moved. computeDiffs emits this as a side effect of
          // the very call DiffPanel makes, and `bump` is in that effect's deps —
          // so without the guard, listing diffs would schedule another listing.
          if (s.diffCounts[sessionId] === count && s.branches[sessionId] === branch) return s
          return {
            diffCounts: { ...s.diffCounts, [sessionId]: count },
            branches: { ...s.branches, [sessionId]: branch },
          }
        })
      },
    )

    // Re-adopt whatever is already running. This covers a renderer reload as it
    // always did, and now also an app RESTART: agents live in detached host
    // processes, so a quit — or a crash — leaves them working, and main has
    // already re-attached to them by the time this runs.
    //
    // Opening the initial project lives here too, and not in an App effect,
    // because it must lose the race with this: otherwise a reload opens a
    // second session on the same cwd.
    void window.foreman
      .listSessions()
      .then(async (live: SessionMeta[]) => {
        if (live?.length) {
          set({ sessions: live })
          get().select(live[0].id)
          // Transcripts come from each host's event log, NOT from disk. The log
          // carries the same ChatItem ids the live stream uses, so replaying it
          // merges cleanly with anything already in flight — whereas re-reading
          // the stored messages would duplicate every one of them under
          // different ids. Called here, after onItem is registered above, which
          // is the earliest moment a backlog can actually be received.
          await window.foreman.replaySessions()
          return
        }
        const p: string | null = await window.foreman.initialProject()
        if (p) await get().openPath(p)
      })
      .catch(() => undefined)

    // Main parks canUseTool's promise in its `waiting` map, but the card lives
    // only here — so a renderer that reloads with one outstanding leaves the
    // session pinned to 'awaiting-approval' with its queue gate shut and nothing
    // on screen to answer. Deliberately NOT chained onto listSessions(): cards
    // are filtered by sessionId when rendered, so arrival order is irrelevant,
    // and an independent statement can't break that chain. Merge rather than
    // assign, so a request landing between the invoke and the resolve survives.
    void window.foreman
      .pendingRequests()
      .then(
        ({
          approvals,
          elicitations,
        }: {
          approvals: PermissionRequest[]
          elicitations: ElicitationRequest[]
        }) => {
          set((s) => ({
            approvals: [
              ...approvals.filter((p) => !s.approvals.some((a) => a.requestId === p.requestId)),
              ...s.approvals,
            ],
            elicitations: [
              ...elicitations.filter((p) => !s.elicitations.some((e) => e.requestId === p.requestId)),
              ...s.elicitations,
            ],
          }))
        },
      )
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
