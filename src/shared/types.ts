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

export interface SessionMeta {
  id: string
  title: string
  cwd: string
  status: SessionStatus
  model: string | null
  costUsd: number
  inputTokens: number
  outputTokens: number
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

/** Appearance knobs the renderer persists and applies as CSS custom properties. */
export interface Appearance {
  surfaceAlpha: number
  terminalAlpha: number
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
  diffClear: 'diff:clear',
  evtDiffChanged: 'diff:changed',

  // terminal
  ptyStart: 'pty:start',
  ptyWrite: 'pty:write',
  ptyResize: 'pty:resize',
  ptyKill: 'pty:kill',
  evtPtyData: 'pty:data',
  evtPtyExit: 'pty:exit',

  // misc
  pickDirectory: 'app:pickDirectory',
} as const
