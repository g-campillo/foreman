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
import { newestSession, projectKey } from './derive.mts'

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
  /* `draft` / `startDraft` / `cancelDraft` and `home` / `showHome` /
     `leaveHome` lived here, along with the `onHome` selector below them.

     Both views are gone. The Home dashboard duplicated what the rail already
     lists, and the draft chooser existed only to ask which project a new
     conversation belonged to — which `newSession()` answers by opening the
     directory picker when there is no project to inherit. What is left is the
     conversation, which is the app. */

  /**
   * Projects the user removed from the recents list.
   *
   * A DISPLAY FILTER AND NOTHING ELSE. `~/.claude/projects` belongs to the
   * Claude CLI as much as to us, so a removed project stays resumable from the
   * CLI, from the rail's history browser, and from search. Nothing on disk is
   * ever deleted.
   */
  hiddenProjects: string[]
  hideProject(path: string): void
  clearHiddenProjects(): void

  /**
   * The file the editor modal is showing, absolute path, or null when closed.
   *
   * In the store rather than App state for the same reason `home` is: a file row
   * in the tree, a path on a diff row, a tool card six levels down in
   * Conversation and the palette all need to open a file, and threading a
   * callback to each of them is how prop drilling starts.
   *
   * `line` is a one-shot reveal target, not a stored cursor. The editor keeps
   * view state per path and restores it when no line is given, so re-opening a
   * file lands where you left it rather than at the top.
   */
  editor: { path: string; line: number | null } | null
  openFile(path: string, line?: number): void
  closeFile(): void

  /**
   * A transcript row to scroll to and flash — the editor pointing back at the
   * conversation.
   *
   * The only half of follow-the-agent that needs storing. Everything pointing
   * the other way is DERIVED from `items`, because the transcript already knows
   * which file the agent is working on and duplicating that into state would
   * give it a second version to disagree with.
   */
  focusItemId: string | null
  revealItem(itemId: string | null): void

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
export const DEFAULT_APPEARANCE: Appearance = {
  theme: 'auto',
  trafficLights: true,
  // The side pane used to be 0.85fr, which rendered ~620px on a 1600px window
  // and ~1000px on a 2560px one. A px default cannot track that; 520 is a sane
  // fixed start for a diff or terminal pane.
  railWidth: 244,
  sideWidth: 520,
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
      theme: saved.theme ?? DEFAULT_APPEARANCE.theme,
      // `??` is right even for a boolean: a persisted `false` survives, and only
      // a missing key falls back to the default.
      trafficLights: saved.trafficLights ?? DEFAULT_APPEARANCE.trafficLights,
      railWidth: saved.railWidth ?? DEFAULT_APPEARANCE.railWidth,
      sideWidth: saved.sideWidth ?? DEFAULT_APPEARANCE.sideWidth,
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

function loadHiddenProjects(): string[] {
  try {
    const raw = localStorage.getItem('foreman.hiddenProjects')
    const saved = raw ? (JSON.parse(raw) as unknown) : null
    // Element-wise, same reasoning as loadModels: this is user-editable storage.
    return Array.isArray(saved) ? saved.filter((x): x is string => typeof x === 'string') : []
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
  // The raw dragged widths. theme.css clamps these into --rail-w / --side-w, so
  // a window too narrow to honour them overrides without overwriting — see the
  // comment on Appearance.railWidth.
  s.setProperty('--rail-w-user', `${a.railWidth}px`)
  s.setProperty('--side-w-user', `${a.sideWidth}px`)
  // Everything CSS-side keys off this attribute; nothing else needs telling.
  // The exception is xterm, which takes colour literals rather than CSS vars —
  // it watches resolvedTheme instead, which is why that lives in the store.
  document.documentElement.dataset.theme = theme
  useStore.setState({ resolvedTheme: theme })
  // There is deliberately no window-background push here any more. The window is
  // transparent with a native vibrancy material behind it, so its pre-paint
  // colour is pinned to #00000000 at creation — pushing a theme's opaque --bg
  // would land in front of the material and cancel the blur on every flip.
  //
  // A window-level call, plus an attribute so .rail-head can drop
  // the 84px it reserves for buttons that may not be there. toggleAttribute
  // rather than dataset — assigning undefined writes the string "undefined",
  // which an attribute selector reads as present.
  void window.foreman.setTrafficLights(a.trafficLights)
  document.documentElement.toggleAttribute('data-no-traffic-lights', !a.trafficLights)
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

/**
 * Streamed token deltas, buffered per session per item and applied once a frame.
 *
 * The naive handler did a findIndex over every item, a list copy, a new item, a
 * new items record and a `prev.text + text` concat PER TOKEN, each one a full
 * React commit — O(n) per token, so O(n²) over a message, at whatever rate the
 * model streams. Buffering makes all of that once-per-frame instead of
 * once-per-token, and the string concat once per frame per item.
 *
 * Note the buffer holds the deltas, not the joined text: the store stays the
 * single source of truth for what an item says, so nothing here can go stale
 * against a rewind or a replay.
 */
const pendingText = new Map<string, Map<string, string>>()
let deltaFrame: number | null = null

/**
 * Apply every buffered delta in one set(), and cancel any pending frame.
 *
 * Safe to call at any time, and it has to be called before anything that reads
 * or replaces an item's text — see onItem, which would otherwise overwrite an
 * item whose tail is still sitting in this buffer.
 */
function flushDeltas(): void {
  if (deltaFrame !== null) {
    cancelAnimationFrame(deltaFrame)
    deltaFrame = null
  }
  if (pendingText.size === 0) return
  const batch = [...pendingText]
  pendingText.clear()

  useStore.setState((s) => {
    const items = { ...s.items }
    let touched = false
    for (const [sessionId, byItem] of batch) {
      const list = items[sessionId]
      if (!list) continue
      const next = [...list]
      let touchedList = false
      for (const [itemId, text] of byItem) {
        const i = next.findIndex((x) => x.id === itemId)
        if (i === -1) continue
        const prev = next[i]
        if (prev.kind !== 'assistant' && prev.kind !== 'thinking') continue
        next[i] = { ...prev, text: prev.text + text }
        touchedList = true
      }
      if (!touchedList) continue
      items[sessionId] = next
      touched = true
    }
    return touched ? { items } : s
  })
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
  // Starts false and is raised by bootstrap only when there is nothing live and
  // no project was asked for — so a reload lands back on its session.
  hiddenProjects: loadHiddenProjects(),
  editor: null,
  focusItemId: null,

  setNotice(notice) {
    set({ notice })
  },

  openFile(path, line) {
    set({ editor: { path, line: line ?? null } })
  },

  closeFile() {
    set({ editor: null })
  },

  revealItem(focusItemId) {
    set({ focusItemId })
  },

  hideProject(path) {
    const key = projectKey(path)
    const cur = get().hiddenProjects
    if (cur.includes(key)) return
    const hiddenProjects = [...cur, key]
    set({ hiddenProjects })
    localStorage.setItem('foreman.hiddenProjects', JSON.stringify(hiddenProjects))
  },

  clearHiddenProjects() {
    set({ hiddenProjects: [] })
    localStorage.removeItem('foreman.hiddenProjects')
  },

  setPrefs(patch) {
    const prefs = { ...get().prefs, ...patch }
    set({ prefs })
    localStorage.setItem('foreman.prefs', JSON.stringify(prefs))
    pushPolicy(prefs)
  },

  select(id) {
    set({ activeId: id })
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
    // every entry point into "new conversation" funnels through.
    set((s) => ({ sessions: [...s.sessions, meta], activeId: meta.id, notice: null }))
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
    set((s) => ({ sessions: [...s.sessions, meta], activeId: meta.id }))
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
        // newestSession, not sessions[0]: this array is in insertion order, so
        // its [0] is the OLDEST — which is the rail's bottom row now that the
        // rail draws newest-first. Closing a session would send the selection
        // to the far end of the list.
        activeId: s.activeId === id ? (newestSession(sessions)?.id ?? null) : s.activeId,
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

    // A trailing partial would otherwise die with the window.
    window.addEventListener('beforeunload', flushDeltas)

    window.foreman.onItem(({ sessionId, item }: { sessionId: string; item: ChatItem }) => {
      // First, and not optional: an item event carries the WHOLE text for its
      // id, so upserting it over an item whose tail is still buffered would drop
      // that tail — and then the next flush would append it a second time on top
      // of the complete text.
      flushDeltas()
      set((s) => ({ items: { ...s.items, [sessionId]: upsert(s.items[sessionId] ?? [], item) } }))
    })

    // Buffered, not applied — see flushDeltas. One React commit per frame rather
    // than one per token.
    window.foreman.onDelta(
      ({ sessionId, itemId, text }: { sessionId: string; itemId: string; text: string }) => {
        let byItem = pendingText.get(sessionId)
        if (!byItem) {
          byItem = new Map()
          pendingText.set(sessionId, byItem)
        }
        byItem.set(itemId, (byItem.get(itemId) ?? '') + text)
        if (deltaFrame === null) {
          deltaFrame = requestAnimationFrame(() => {
            deltaFrame = null
            flushDeltas()
          })
        }
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
      // Land whatever is buffered before the session goes; after this its items
      // are unreachable and the tail is simply lost.
      flushDeltas()
      pendingText.delete(sessionId)
      set((s) => {
        const sessions = s.sessions.filter((x) => x.id !== sessionId)
        // Repair the selection here, not only in close(): a session can also go
        // away from main's side, and a dangling activeId renders the empty
        // state while a perfectly good session sits in the rail.
        return {
          sessions,
          // newestSession for the same reason as close() above.
          activeId: s.activeId === sessionId ? (newestSession(sessions)?.id ?? null) : s.activeId,
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
          // main returns these in ITS insertion order (a Map spread), so live[0]
          // is the oldest — the rail's bottom row. Select what the rail actually
          // shows first instead. Non-null inside this `live?.length` guard.
          get().select(newestSession(live)!.id)
          // Transcripts come from each host's event log, NOT from disk. The log
          // carries the same ChatItem ids the live stream uses, so replaying it
          // merges cleanly with anything already in flight — whereas re-reading
          // the stored messages would duplicate every one of them under
          // different ids. Called here, after onItem is registered above, which
          // is the earliest moment a backlog can actually be received.
          await window.foreman.replaySessions()
          return
        }
        // Still inside this .then, so it still loses the race above. Do not lift.
        const p: string | null = await window.foreman.initialProject()
        if (p) {
          // `foreman <path>` / FOREMAN_OPEN is an explicit instruction. Honour it
          // and land in the conversation — openPath calls select(), which clears
          // `home` — rather than bouncing off Home first.
          await get().openPath(p)
          return
        }
        // Nothing live and nothing asked for. There is no launch destination to
        // fall back to any more — the chat pane renders its own empty state, and
        // the rail's New conversation row opens the directory picker.
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

/* The `onHome` selector lived here. With Home gone, "no active session" is not
   a route to anywhere — it is just the absence of a conversation, which the chat
   pane renders directly. close() and onRemoved still need no repair of their
   own: activeId pointing at a session that no longer exists makes
   `activeSession` undefined, which is exactly the state that renders empty. */
