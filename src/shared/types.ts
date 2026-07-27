/**
 * The IPC contract. Shared by main, preload, and renderer.
 *
 * Main normalises raw Agent SDK messages into ChatItems before they cross the
 * bridge, so the renderer never imports the SDK and never has to track its churn.
 */

export type SessionStatus = 'starting' | 'idle' | 'running' | 'awaiting-approval' | 'error'

/** Mirrors the SDK's own union, minus 'auto' (no UI for the classifier yet).
 *  'dontAsk' denies anything not pre-approved instead of prompting. */
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' | 'dontAsk'

/** Mirrors the SDK's EffortLevel. 'max' is session-scoped and never persisted. */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface BackgroundTask {
  taskId: string
  taskType: string
  description: string
  /**
   * Live progress, joined onto the task by `task_id`.
   *
   * The SDK already emits all of this on `task_progress` roughly every 30s;
   * before this it was only ever folded onto the in-transcript Task card, so a
   * *backgrounded* task showed as an opaque chip with no way to see inside it.
   *
   * `background_tasks_changed` has REPLACE semantics and carries none of these,
   * so they have to be merged by taskId when the set changes or every chip goes
   * blank the moment another task starts or finishes.
   */
  progress?: string
  lastTool?: string
  tokens?: number
}

/** Result of rewindFiles, used both for the dry-run preview and the real thing. */
export interface RewindResult {
  canRewind: boolean
  error?: string
  filesChanged: string[]
  insertions: number
  deletions: number
  /** Only populated on a real rewind: files skipped for link-safety reasons. */
  skippedLinks?: number
}

/**
 * An isolated checkout a session owns, so parallel agents on one repo don't
 * collide. `repoRoot` is the *original* repository, which is what git commands
 * about the worktree itself (add, remove, list) have to run against.
 */
export interface WorktreeInfo {
  path: string
  branch: string
  repoRoot: string
}

export interface SessionMeta {
  id: string
  title: string
  cwd: string
  status: SessionStatus
  model: string | null
  costUsd: number
  inputTokens: number
  outputTokens: number
  /**
   * Wall-clock start of the in-flight turn; null between turns.
   *
   * Main's clock rather than a renderer-side mount timestamp, because
   * Conversation and Composer are rendered unkeyed — a status line that
   * survives a tab switch would otherwise keep timing the old session's turn.
   */
  turnStartedAt: number | null
  /**
   * Output tokens seen so far in the in-flight turn.
   *
   * Deliberately NOT folded into inputTokens/outputTokens: those are the
   * authoritative cumulative totals, written once from `result`, and mixing a
   * running estimate into them would double-count when `r.usage` lands.
   *
   * Advances per assistant message, which is the finest granularity available —
   * usage rides the message, not the token deltas — so it steps in chunks.
   */
  turnTokens: number
  permissionMode: PermissionMode
  createdAt: number
  /** null until set; the SDK's own default applies while it is. */
  effort: EffortLevel | null
  /** Predicted next prompt from the last turn, shown as composer ghost text. */
  promptSuggestion: string | null
  /** Live background tasks. REPLACE semantics — the SDK sends the whole set. */
  backgroundTasks: BackgroundTask[]
  /**
   * The session id the SDK/CLI actually uses.
   *
   * Equals `id` for a fresh session, because we mint it and pass it as
   * `sessionId`. On resume we must NOT pass one (the CLI rejects --session-id
   * with --resume), so the SDK keeps the original and this diverges from `id`.
   * Anything addressing the session on disk — transcripts, fork, rename —
   * needs this one, not `id`.
   */
  sdkSessionId: string | null
  /** Set when this session runs in its own worktree instead of the project cwd. */
  worktree?: WorktreeInfo
}

/**
 * What the composer can send.
 *
 * Mirrors the SDK's MessageParam content without importing it, so the renderer
 * stays SDK-free. A bare string is still legal and is what a plain typed message
 * sends — the block form only appears once there's an attachment.
 */
/** The only image types the API accepts. Anything else is rejected upstream. */
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

export type SendBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: ImageMediaType; data: string } }

export type SendContent = string | SendBlock[]

export interface SlashCommandInfo {
  name: string
  description: string
  argumentHint: string
}

/**
 * `parentId`, where present, is the ChatItem id of the `Task` tool card whose
 * subagent produced this item — the flat-list form of a nested transcript. The
 * renderer groups on it rather than main building a tree, so the store stays a
 * flat upsert-by-id array. Absent means the main thread; a subagent inside a
 * subagent chains naturally, since its parent card is itself parented.
 */
export type ChatItem =
  | {
      id: string
      kind: 'user'
      text: string
      /** data: URLs for pasted attachments, so the transcript can show them. */
      images?: string[]
      /** Still sitting in our input queue, and therefore still cancellable. */
      queued?: boolean
      /**
       * The SDK's message uuid. For user messages this equals `id`, because we
       * stamp our own id onto the SDKUserMessage before queueing it — which is
       * what makes rewindFiles() and forkSession({upToMessageId}) addressable
       * from a rendered item.
       */
      uuid?: string
    }
  | {
      id: string
      kind: 'assistant'
      text: string
      /** SDKAssistantMessage.uuid — what resumeSessionAt wants. */
      uuid?: string
      parentId?: string
    }
  | { id: string; kind: 'thinking'; text: string; parentId?: string }
  | {
      id: string
      kind: 'tool'
      name: string
      input: unknown
      status: 'pending' | 'done' | 'error'
      result?: string
      /**
       * Rolling one-line status for long-running work: the AI progress summary
       * from `task_progress`, or the settle summary from `task_notification`.
       * Kept off `result` so a subagent's own report is never overwritten.
       */
      progress?: string
      parentId?: string
    }
  | { id: string; kind: 'result'; text: string; costUsd: number; durationMs: number; isError: boolean }
  | { id: string; kind: 'error'; text: string }

export interface PermissionRequest {
  requestId: string
  sessionId: string
  toolName: string
  input: Record<string, unknown>
  /** Present when the SDK offers "always allow"-style rule suggestions. */
  hasSuggestions: boolean
}

export interface FileDiff {
  path: string
  /** Path relative to the session cwd, for display. */
  relPath: string
  /** null when the agent created the file. */
  before: string | null
  after: string | null
  added: number
  removed: number
  hunks: DiffHunk[]
  /** Set when the row deliberately has no hunks: 'binary', 'too large to diff'. */
  note?: string
}

export interface DiffHunk {
  oldStart: number
  newStart: number
  lines: DiffLine[]
}

export interface DiffLine {
  type: 'add' | 'del' | 'ctx'
  text: string
  oldNo: number | null
  newNo: number | null
}

export interface ModelInfo {
  /** The alias to pass to setModel — may be '' for "Default (recommended)". */
  id: string
  displayName: string
  /** Canonical wire id the alias resolves to, e.g. 'sonnet' -> 'claude-sonnet-5'.
   *  This is what matches against SessionMeta.model. */
  resolvedModel?: string
}

// ------------------------------------------------------- read-only panels

export interface ContextUsage {
  /**
   * System prompt, tools, messages, MCP tools, memory files — the SDK's own split.
   *
   * The SDK's `color` field is deliberately NOT carried across: it holds CLI
   * theme keys ('inactive', 'promptBorder'), not CSS colours, so it would render
   * as nothing. The panel assigns its own theme-aware palette instead.
   */
  categories: { name: string; tokens: number; isDeferred?: boolean }[]
  totalTokens: number
  maxTokens: number
  percentage: number
  model: string
  memoryFiles: { path: string; tokens: number }[]
  mcpTools: { name: string; serverName: string; tokens: number }[]
}

export interface AccountInfo {
  email?: string
  organization?: string
  subscriptionType?: string
  /** Anthropic OAuth fields are only populated when this is 'firstParty'. */
  apiProvider?: string
}

export interface RateWindow {
  label: string
  /** 0–100, or null when the server didn't report it. */
  utilization: number | null
  resetsAt?: string | null
}

export interface UsageInfo {
  costUsd: number
  linesAdded: number
  linesRemoved: number
  subscriptionType: string | null
  /** False for API-key / Bedrock / Vertex sessions; `windows` is then empty. */
  rateLimitsAvailable: boolean
  windows: RateWindow[]
}

export interface McpServerInfo {
  name: string
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled'
  error?: string
  toolCount: number
  scope?: string
}

export interface AgentInfo {
  name: string
  description: string
  model?: string
}

export interface SkillInfo {
  name: string
  description?: string
}

/**
 * An MCP server asking the user for something mid-turn.
 *
 * `schema` crosses the bridge as plain JSON rather than being normalised in
 * main, the same way PermissionRequest.input does — it's ordinary JSON Schema,
 * not an SDK type, so the renderer can read it without importing the SDK.
 */
export interface ElicitationRequest {
  requestId: string
  sessionId: string
  serverName: string
  message: string
  title?: string
  description?: string
  mode: 'form' | 'url'
  /** Present for 'url' mode — an OAuth page, already opened in the browser. */
  url?: string
  schema?: Record<string, unknown>
}

export type ElicitationAction = 'accept' | 'decline' | 'cancel'

export interface PastSession {
  sessionId: string
  summary: string
  cwd?: string
  /** Epoch ms. The SDK's field is `lastModified`, not a date string. */
  lastModified?: number
  gitBranch?: string
}

export interface TranscriptSearchHit {
  sessionId: string
  summary: string
  /** Required to resume: the CLI looks for a session under its project dir, so
   *  resuming without it searches the wrong place and finds nothing. */
  cwd?: string
  lastModified?: number
  /** Text around the first match, for the result row. */
  snippet: string
  matches: number
}

/** What happens to running agents when Foreman quits. */
export type AgentLifetime = 'persist' | 'stop'

/**
 * Everything the app persists about behaviour, as opposed to looks.
 *
 * Separate from Appearance because none of this is CSS: some of it rides out on
 * createSession, some is pushed to main as policy, some is pure renderer.
 *
 * The session-start three are deliberately one-way — changing mode/model/effort
 * in the composer steers *that* conversation and never writes back here, so a
 * session you flipped to Bypass doesn't quietly make Bypass your default.
 */
export interface Prefs {
  // --- what a new conversation starts with ---
  permissionMode: PermissionMode
  /** Model alias. '' means "leave the SDK's own default alone". */
  model: string
  /** null means the same for effort. */
  effort: EffortLevel | null

  // --- agent lifetime (pushed to main; see IPC.agentPolicy) ---
  /**
   * 'persist' keeps agents working after the app quits, and is what makes a
   * crash survivable — the app re-adopts them next launch. 'stop' shuts them
   * down on quit; a crash can't be intercepted either way, so a crash-survivor
   * is still adopted rather than orphaned.
   */
  agentLifetime: AgentLifetime
  /** Minutes an unattended agent keeps running before stopping itself. 0 = forever. */
  agentIdleMinutes: number

  // --- conversation behaviour ---
  /** Name conversations from their first message. Costs about $0.004 each. */
  autoTitle: boolean
  /** Desktop notifications for turn-complete and approval-needed. */
  notifications: boolean
  /** The rotating status verbs under a running turn. Purely cosmetic. */
  workingVerbs: boolean

  // --- per-session safety caps. 0 = no cap. ---
  maxBudgetUsd: number
  maxTurns: number
}

/** Appearance knobs the renderer persists and applies as CSS custom properties. */
export interface Appearance {
  surfaceAlpha: number
  terminalAlpha: number
  /**
   * Session rail width in px, as the user dragged it.
   *
   * The raw number, not the effective one — theme.css clamps it against the
   * window with clamp(), so a narrow window can override this without
   * overwriting it. Shrink the window and grow it back and the number returns.
   */
  railWidth: number
  /** Side panel width in px. Same clamping story as railWidth. */
  sideWidth: number
  /** 'auto' follows the OS live via matchMedia; the other two pin it. */
  theme: 'auto' | 'dark' | 'light'
  /**
   * macOS vibrancy material, or null for none.
   *
   * This is the only thing that actually blurs the desktop behind the window.
   * CSS backdrop-filter can't: the window is transparent, so Chromium has no
   * in-page backdrop to sample. NSGlassEffectView (electron-liquid-glass) gives
   * translucency and the Tahoe material but leaves the desktop sharp.
   *
   * Trade-off: vibrancy overrides the Liquid Glass material. Blur on means
   * vibrancy's look; blur off means pure Liquid Glass.
   */
  vibrancy: string | null
  /**
   * The macOS close/minimise/zoom buttons.
   *
   * macOS only, and safe to turn off only because the app installs no Menu of
   * its own — Electron's default template is therefore active, so ⌘Q and ⌘W
   * still work when the buttons are gone. If a custom Menu is ever added, keep
   * the quit and close roles or this setting becomes a trap on a frameless
   * window.
   */
  trafficLights: boolean
}

/**
 * A file read for the editor.
 *
 * A discriminated union rather than the neutral-empty shape the read-only
 * panels use (`callOr(sessionId, [], 'agents')`). Neutral-empty is right when
 * the worst case is a panel rendering "unavailable"; it is catastrophic here,
 * because an empty read that opens a tab is one ⌘S away from truncating the
 * file. The editor must be able to tell denied from missing from unreadable,
 * and a tab never opens on `ok: false`.
 */
export type FileRead =
  | {
      ok: true
      text: string
      mtimeMs: number
      size: number
      /** Stripped on read, re-prepended on write. Monaco has no BOM concept. */
      bom: boolean
      /** The renderer sets the model's EOL from this — see files.ts. */
      eol: 'lf' | 'crlf'
    }
  | { ok: false; reason: 'missing' | 'binary' | 'too-large' | 'outside' | 'io'; error: string }

export type FileWrite =
  | { ok: true; mtimeMs: number }
  /** `stale` carries the mtime we found, so the conflict UI can re-read. */
  | { ok: false; reason: 'stale' | 'outside' | 'io'; error: string; mtimeMs?: number }

/** `truncated` matters for the tree: a clipped popover is invisible, a clipped
 *  tree looks like the repo is missing files. */
export interface FileList {
  paths: string[]
  truncated: boolean
  /**
   * Repo-relative paths git considers dirty, keyed to their porcelain code.
   *
   * Rides along on the tree's round-trip because `git status` is one more cheap
   * call next to the `git ls-files` we are already making, and it is what turns
   * the tree from a file picker into a view of what changed. Absent for the
   * @-mention popover, which has no room to show it.
   */
  dirty?: Record<string, string>
}

/**
 * What one language's server support looks like for a given project.
 *
 * A wire type, so it lives here with the others. Built by asking the same
 * `resolveServer` the runtime uses rather than a parallel list — a status
 * screen claiming "installed" for a server that then fails to start is worse
 * than no status screen.
 */
export type ServerId = 'ts' | 'swift' | 'java' | 'python' | 'rust' | 'go' | 'clangd'

export interface ServerReport {
  id: ServerId
  label: string
  extensions: string
  /**
   * `unconfigured` — the binary is there but the project is not set up for it
   *   (clangd with no compilation database, jdtls with no JDK).
   * `highlight-only` — Monaco colours it and no server here understands it.
   *   Listed rather than omitted, so silence never has to mean two things.
   */
  state: 'ready' | 'missing' | 'unconfigured' | 'highlight-only'
  detail: string
  /** A shell command that fixes it, if there is one. */
  install?: string
  hint?: string
}

export const IPC = {
  // session lifecycle
  sessionCreate: 'session:create',
  sessionResume: 'session:resume',
  sessionClose: 'session:close',
  sessionList: 'session:list',
  sessionSend: 'session:send',
  sessionInterrupt: 'session:interrupt',
  sessionSetMode: 'session:setMode',
  sessionSetModel: 'session:setModel',
  sessionModels: 'session:models',
  sessionPastList: 'session:pastList',
  /** Ask every adopted host to stream its event log. Called by the renderer
   *  once its listeners are registered — see store.bootstrap. */
  sessionReplay: 'session:replay',
  /** Renderer -> main: agent lifetime + notification policy, from Settings.
   *  Main can't read localStorage, and these decide what happens on quit. */
  agentPolicy: 'app:agentPolicy',
  sessionCancelQueued: 'session:cancelQueued',

  // time travel + actions
  sessionRewind: 'session:rewind',
  sessionSetEffort: 'session:setEffort',
  sessionBackground: 'session:background',
  sessionStopTask: 'session:stopTask',
  mcpToggle: 'mcp:toggle',
  mcpReconnect: 'mcp:reconnect',
  mcpPermissionOverride: 'mcp:permissionOverride',

  // history
  sessionTranscript: 'session:transcript',
  sessionSearch: 'session:search',
  sessionFork: 'session:fork',
  sessionRename: 'session:rename',

  // composer autocomplete
  sessionCommands: 'session:commands',
  sessionFiles: 'session:files',

  // read-only panels
  sessionContextUsage: 'session:contextUsage',
  sessionAccount: 'session:account',
  sessionUsage: 'session:usage',
  sessionAgents: 'session:agents',
  sessionMcpStatus: 'session:mcpStatus',
  sessionReloadSkills: 'session:reloadSkills',

  // Every persisted usage sidecar, for Home. NOT sessionUsage above, which is
  // one live session's SDK-reported figures.
  usageList: 'usage:list',

  // session → renderer events
  evtItem: 'session:item',
  evtDelta: 'session:delta',
  evtMeta: 'session:meta',
  evtRemoved: 'session:removed',
  /** A queued user message left the queue: 'started' (now running) or 'dropped'. */
  evtQueue: 'session:queue',

  // permissions
  permRequest: 'permission:request',
  permResolved: 'permission:resolved',
  permRespond: 'permission:respond',

  // MCP elicitation (OAuth prompts and structured input)
  elicitRequest: 'elicit:request',
  elicitResolved: 'elicit:resolved',
  elicitRespond: 'elicit:respond',

  // diffs
  diffList: 'diff:list',
  diffRevert: 'diff:revert',
  diffCommit: 'diff:commit',
  evtDiffChanged: 'diff:changed',

  // editor file I/O. No event channel: reconciliation reuses evtDiffChanged,
  // which the PostToolUse hook already fires on every agent write.
  fileRead: 'file:read',
  fileWrite: 'file:write',
  fileStat: 'file:stat',
  fileTree: 'file:tree',
  /** Directory listing for an @-mention that has left the project. Takes a raw
   *  query and no cwd — being session-free is the entire point of it. */
  fileBrowse: 'file:browse',

  // The renderer's LSP client, multiplexed onto the host's fleet by lsp/proxy.
  // A raw JSON-RPC frame in each direction: the message IS the payload.
  lspSend: 'lsp:send',
  evtLspMessage: 'lsp:message',
  /** Request/response for the hand-rolled location providers, which need a
   *  promise rather than a frame that comes back later as an event. */
  lspRequest: 'lsp:request',
  /** Which language servers this project can actually use. Answered in MAIN,
   *  not the host: it is pure detection against a cwd, so it works for a
   *  session whose host has gone away — same posture as the diff handlers. */
  lspServers: 'lsp:servers',
  /** Forget cached "not installed" results, after the user installs one. */
  lspRecheck: 'lsp:recheck',

  // terminal
  ptyStart: 'pty:start',
  ptyWrite: 'pty:write',
  ptyResize: 'pty:resize',
  ptyKill: 'pty:kill',
  evtPtyData: 'pty:data',
  evtPtyExit: 'pty:exit',

  /** Host -> app: show a desktop notification. Only main can build one, and
   *  only main knows whether the window is focused. */
  evtNotify: 'app:notify',
  /** Host -> app: open this URL in the browser (an MCP OAuth page). */
  evtOpenUrl: 'app:openUrl',

  // misc
  pickDirectory: 'app:pickDirectory',
  /** Prompts still parked in main, for a renderer that lost its copy. */
  pendingList: 'pending:list',
} as const
