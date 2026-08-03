/**
 * The IPC contract. Shared by main, preload, and renderer.
 *
 * Main normalises raw Agent SDK messages into ChatItems before they cross the
 * bridge, so the renderer never imports the SDK and never has to track its churn.
 */

export type SessionStatus = 'starting' | 'idle' | 'running' | 'awaiting-approval' | 'error'

/**
 * Mirrors the SDK's own union, minus 'auto' (no UI for the classifier yet).
 * 'dontAsk' denies anything not pre-approved instead of prompting.
 *
 * An array first and a type derived from it, rather than a bare union, because
 * two places now need the modes at RUNTIME and neither can be trusted to keep a
 * hand-written copy in step: the composer's ⇧Tab cycles through this order, and
 * the usage sidecar VALIDATES against it — that file is user-editable storage,
 * and a bad mode reaching `query({permissionMode})` kills the session at
 * startup. `as const` is what keeps the derived type exactly as narrow as the
 * hand-written union was.
 */
export const PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
  'dontAsk',
] as const

export type PermissionMode = (typeof PERMISSION_MODES)[number]

/** Mirrors the SDK's EffortLevel. 'max' is session-scoped and never persisted. */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** Mirrors the SDK's own task status union, from `task_updated`'s patch. */
export type BackgroundTaskStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'killed'
  | 'paused'

/**
 * One live background task, as the tray chip and its detail card need it.
 *
 * Everything past `description` is folded in from the SDK's task EDGES —
 * task_started, task_progress, task_updated, task_notification — while
 * membership in the tray comes from the `background_tasks_changed` LEVEL, which
 * carries ids only. The SDK is explicit that the two streams must not be
 * correlated and that their relative order is unspecified, so main keeps a side
 * table and projects this shape out of it; see Session.noteTask.
 *
 * Nothing persists this, so its shape can change freely — the sidecar holds
 * cost, tokens and permission mode and nothing else.
 */
export interface BackgroundTask {
  taskId: string
  taskType: string
  description: string
  /**
   * Epoch ms, from `task_started` — which lands ~30s before the first
   * task_progress could. REQUIRED, because a chip whose clock is optional has
   * no clock: the tray would have to render a blank where the elapsed time goes
   * for the first half-minute of every task, which is exactly the window in
   * which people wonder whether anything is happening. Floored from
   * task_progress's `duration_ms` if a start edge was somehow missed.
   */
  startedAt: number
  /**
   * When the task finished, if it has. THE CHIP'S CLOCK STOPS HERE.
   *
   * Without it the renderer has only `now - startedAt`, and a task whose
   * completion arrives before the level drops its id — the ordering the SDK
   * declines to specify — renders as "completed" with the elapsed time still
   * counting up.
   */
  endedAt?: number
  /** Time spent paused, so the elapsed clock can say so rather than lying. */
  pausedMs?: number
  /** 'code-reviewer' and friends — what KIND of work this is, for the chip. */
  subagentType?: string
  /** meta.name of a local workflow, the same slot subagentType fills. */
  workflowName?: string
  /** Tool calls made so far, from task_progress. */
  toolUses?: number
  status?: BackgroundTaskStatus
  /** Set when the task failed. Shown on the card, never truncated into a chip. */
  error?: string
  /**
   * ChatItem id of the Task card this work belongs to, so the card can offer
   * "Show in transcript". Absent for an ambient/skip_transcript task, which has
   * no card to show — the button says so rather than silently doing nothing.
   */
  itemId?: string
  /**
   * Live progress, joined onto the task by `task_id`.
   *
   * The SDK emits all of this on `task_progress` roughly every 30s; before this
   * it was only ever folded onto the in-transcript Task card, so a *backgrounded*
   * task showed as an opaque chip with no way to see inside it.
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
   * Output tokens seen so far in the in-flight turn, subagents included. Zero
   * between turns.
   *
   * Deliberately NOT folded into inputTokens/outputTokens: those are the
   * authoritative cumulative totals, written once from `result`, and mixing a
   * running estimate into them would double-count when `r.usage` lands. For the
   * same reason this is reset to 0 at turn end rather than left holding the
   * final figure — `sessionTokens` in derive.mts adds the two, and the total is
   * only correct if exactly one of them owns a given turn at a time.
   *
   * Advances per assistant message, which is the finest granularity available —
   * usage rides the message, not the token deltas — so it steps in chunks. It is
   * de-duplicated by `message.id` in main, because several messages per API turn
   * carry the same complete usage object; see Session.turnUsage.
   */
  turnTokens: number
  /**
   * How full the context window is right now, as of the last request. null until
   * a turn has reported one.
   *
   * A LEVEL, not a counter, and that is the whole reason it is its own field. The
   * same double-count argument `turnTokens` makes above applies here an order of
   * magnitude harder: this is the ENTIRE conversation re-sent on every request,
   * so folding it into inputTokens/outputTokens/turnTokens would add the whole
   * window to the cumulative totals once per assistant message and report a
   * $0.11 turn as tens of millions of tokens.
   *
   * Levels go down as well as up — compaction is exactly that — so nothing may
   * accumulate it or Math.max it against the polled figure.
   *
   * Not persisted to the sidecar: a window occupancy from a previous run says
   * nothing about the window a resumed conversation actually has.
   */
  contextTokens: number | null
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
  /**
   * No host behind this conversation: previewed from disk, or hibernated.
   *
   * RENDERER-OWNED. Main never sets it, because main's `sessions` map is
   * `Map<id, HostClient>` and a HostClient *is* a live host — a hostless entry
   * in there would muddy `sessionsUnder`, `callOr` and `replaySessions`, each of
   * which is written on the assumption that membership means "there is a process
   * to talk to". Main says a session went away (`evtHibernated`); the renderer
   * decides that the row stays and what it now looks like.
   *
   * An asleep session's transcript comes from `IPC.sessionTranscript` on demand
   * and its items are ordinary ChatItems, so nothing downstream of the store —
   * Conversation included — needs to know about this at all.
   */
  asleep?: boolean
  /** Set when this session runs in its own worktree instead of the project cwd. */
  worktree?: WorktreeInfo
  /**
   * This session's language servers, as they report themselves.
   *
   * REPLACE semantics, like backgroundTasks: the host sends the whole fleet
   * every time, because a per-server patch would need the renderer to know when
   * a server has gone away. Absent until the first one starts, which is on the
   * first document opened in a language — see LspStrip for why that is lazy.
   */
  lspStatus?: LspStatus[]
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

/**
 * One image staged in the composer, before it becomes a SendBlock.
 *
 * Here rather than in Composer.tsx, which owned it, because the store now parks
 * a per-session draft — and a store importing a shape out of a leaf component it
 * is imported BY is a cycle waiting to be made runtime. `data` is base64 with no
 * `data:` prefix, which is what the wire format wants; the `data:` URL form only
 * exists for the `<img>` previews.
 */
export interface Attachment {
  id: string
  mediaType: ImageMediaType
  data: string
  name: string
}

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

/**
 * Where a permission rule would be written.
 *
 * Mirrors the SDK's PermissionUpdateDestination, so the renderer never imports
 * the SDK — the same refusal every other type in this file makes. `scopeLabel`
 * in shared/rules.mts turns each of these into the FILE it names, because a
 * grant whose location you cannot read is not consent.
 */
export type RuleScope =
  | 'userSettings'
  | 'projectSettings'
  | 'localSettings'
  | 'session'
  | 'cliArg'

/** One rule. `Bash` + `npm run build:*`, or a bare tool name meaning all of it. */
export interface RuleValue {
  toolName: string
  /** The argument pattern the rule matches. Absent means the whole tool. */
  ruleContent?: string
}

/**
 * A permission change the SDK offered alongside a prompt — the "you will not be
 * asked again" half of an approval.
 *
 * Mirrors the SDK's PermissionUpdate union. DISPLAY ONLY: the host keeps the
 * real suggestions on its own waiter and replays those verbatim, so the renderer
 * answers `alwaysAllow: true` and can never name a rule, a tool or a
 * destination. This copy exists purely so the card can say what the click grants
 * BEFORE it happens — see describeGrant in shared/rules.mts, which is total over
 * this union for exactly that reason.
 */
export type SuggestedUpdate =
  | {
      type: 'addRules' | 'replaceRules' | 'removeRules'
      rules: RuleValue[]
      behavior: 'allow' | 'deny' | 'ask'
      destination: RuleScope
    }
  | { type: 'setMode'; mode: PermissionMode; destination: RuleScope }
  | {
      type: 'addDirectories' | 'removeDirectories'
      directories: string[]
      destination: RuleScope
    }

export interface PermissionRequest {
  requestId: string
  sessionId: string
  toolName: string
  input: Record<string, unknown>
  /**
   * The SDK's own "always allow"-style suggestions, for display.
   *
   * Optional, and that is not laziness: the host's on-disk event log gets
   * replayed when the app re-adopts a live agent, so a request an older build
   * wrote carries no rules at all. That has to render as "no always-allow
   * offered" rather than crash.
   */
  rules?: SuggestedUpdate[]
}

/**
 * Arguments of a permission answer, as they arrive from the renderer.
 *
 * Lives here rather than beside the host's respondPermission because the
 * preload bridge takes it as an options object — six positionals was already
 * one too many, and PlanCard's note about "if a seventh parameter ever lands
 * here" was written the turn before one did.
 */
export interface PermissionAnswer {
  requestId: string
  behavior: 'allow' | 'deny'
  /** Replaces the default deny text; see the AskUserQuestion note below. */
  message?: string
  /**
   * Permission mode to switch to as part of the same allow.
   *
   * This rides on the permission result rather than going out as a separate
   * setPermissionMode call because approving ExitPlanMode makes the CLI change
   * the mode too — two writers, and whichever landed second would win.
   * `updatedPermissions` is applied with the decision, so the user's pick can't
   * lose that race.
   */
  setMode?: PermissionMode
  /**
   * Allow this, and stop being asked about it.
   *
   * A BARE BOOLEAN, deliberately. The rules actually granted are the SDK's own
   * suggestions, which the host kept on the waiter and never sent anywhere — so
   * this cannot name a tool, a pattern or a settings file, and a compromised or
   * simply buggy renderer cannot widen a grant beyond what the CLI itself
   * proposed for this exact call. Same trust boundary `keep` draws by sending
   * indices instead of content, one step further: not even indices.
   *
   * `PermissionRequest.rules` is the display copy the card reads to say what
   * this would do. The two are never compared — the host does not trust it, it
   * simply does not need it.
   */
  alwaysAllow?: boolean
  /**
   * Indices of the edits/hunks the user actually accepted. Absent means all.
   *
   * INDICES, never content, and that is the whole safety argument. The host
   * subsets its OWN copy of the tool input, so the renderer cannot name bytes
   * that reach disk — a nasty new trust boundary collapses into a bounds check.
   * See subsetMultiEdit in shared/diff.mts for the property that buys.
   */
  keep?: number[]
  /**
   * Approving a plan AND handing the work to subagents.
   *
   * Rides the permission answer for the same reason `setMode` does, only more
   * so: it has to be known BEFORE the tool runs. The input queue is gated shut
   * for the whole turn, so a follow-up message would not reach the model until
   * after it had already implemented the plan alone. The directive itself
   * travels on a PostToolUse hook — see plan.ts — and this flag is only how the
   * click reaches it.
   */
  subagents?: boolean
}

/** One row of the composer's branch menu. */
export interface BranchInfo {
  /** The branch name with any remote prefix stripped: `origin/fix/x` -> `fix/x`.
   *  This is what a checkout names, on both arms. */
  name: string
  /** The remote it lives on, or null for a local branch. A remote row means
   *  "no local branch of this name exists" — see parseRefs' dedup. */
  remote: string | null
  /** The full refname. Unique across local and remote, so it is the menu key. */
  ref: string
  current: boolean
  /** Absolute path of the OTHER worktree holding this branch, when one does.
   *  Git refuses to check a branch out twice, so the row is disabled and this
   *  path is its hint — pre-detected, rather than letting the click fail. */
  checkedOutAt: string | null
  upstream: string | null
  /** Tip's committer date, epoch seconds. 0 for an unborn branch. */
  updatedAt: number
}

export interface BranchList {
  /** The checked-out branch, or null on a detached HEAD. */
  current: string | null
  /** Short sha of a detached HEAD, else null. */
  detachedAt: string | null
  branches: BranchInfo[]
}

export interface CheckoutResult {
  ok: boolean
  /** Git's own stderr, verbatim — "Your local changes would be overwritten…" is
   *  a better message than anything we could write over it. */
  error?: string
  /** Succeeded, but something was left behind worth saying out loud. */
  notice?: string
  branch?: string
}

/**
 * What the ⌘1 badge reports: how much is uncommitted, in files AND in lines.
 *
 * `files` is `git status`'s dirty count, not numstat's record count, because the
 * panel renders one row per dirty path — including the ones numstat cannot see
 * (untracked) and the ones it reports as zero (a chmod +x). The line totals come
 * from `git diff --numstat` plus a walk of the untracked files; see readStats.
 *
 * Known and accepted divergence from the panel's own jsdiff totals: a
 * `.gitattributes -diff` mark, `core.autocrlf` normalisation and a non-Myers
 * `diff.algorithm` each make git count differently from structuredPatch. Two
 * numbers a line or two apart is a far smaller problem than reading every dirty
 * file on every agent tool call would be.
 */
export interface DiffStats {
  files: number
  added: number
  removed: number
}

/** The `evtDiffChanged` payload. One event carries every downstream refresh:
 *  the badge, the composer's branch label, the file tree and the diff panel. */
export interface DiffChanged extends DiffStats {
  sessionId: string
  /** null on a detached HEAD, or when the cwd is not a repository at all. */
  branch: string | null
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

/**
 * The MCP tab's whole payload, not just the list.
 *
 * `staleEnv` is set when the session's host was spawned with a different PATH
 * than this process now has — usually because the host predates the app
 * learning the user's login-shell PATH. A host's environment is frozen at
 * `spawn`, so reconnecting a server inside one of those cannot succeed however
 * many times it is tried, and the panel says so instead of drawing another red
 * row with no explanation. Carried alongside the list rather than on its own
 * channel: it is a property of the session, and the tab already makes exactly
 * one call.
 */
export interface McpStatus {
  servers: McpServerInfo[]
  staleEnv: boolean
}

/**
 * The result of pressing one of the MCP tab's buttons.
 *
 * A result rather than a throw, deliberately: `callOr` in the manager swallows
 * rejections on purpose so a panel opened mid-teardown renders "unavailable"
 * rather than failing the renderer's invoke, and that swallow is worth keeping.
 * So the reason a reconnect failed travels as a value, which is the difference
 * between a button that looks broken and one that tells you `npx` is missing.
 */
export interface McpActionResult {
  ok: boolean
  error?: string
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
  /**
   * Minutes an idle agent keeps its processes before going to sleep. 0 = never.
   *
   * It used to mean "after the app has let go of it", which never happened:
   * main holds a socket to every host for as long as Foreman is open, so the
   * host's own idle timer was permanently disarmed and this number did nothing
   * while the app ran. Main enforces it now — see sweepIdleSessions — and it
   * enforces it as SLEEP rather than as a stop: the conversation stays in the
   * rail, and sending to it starts the agent again.
   */
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

/** Appearance knobs the renderer persists and applies as CSS: custom properties
 *  mostly, and attributes for the two a property cannot express — see railOpen
 *  and trafficLights. */
export interface Appearance {
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
  /**
   * How much of the chat pane the TRANSCRIPT is allowed to use.
   *
   * The composer is not in the deal: it stays pinned at --composer-max-w in
   * every setting, because a 2000px-wide prompt box is not what the empty
   * gutters were asking for. 'comfortable' is the behaviour the app has always
   * had — the two share one number — so an upgrade changes nothing until this
   * is touched.
   *
   * A choice rather than a pixel width because there is nothing to drag: unlike
   * railWidth/sideWidth there is no seam here, and three named stops answer the
   * real question ("is this a laptop or a 32-inch display") without inventing a
   * control.
   */
  transcriptWidth: 'comfortable' | 'wide' | 'full'
  /**
   * Whether the session rail is showing at all. ⌘B.
   *
   * Beside the widths because it is the same kind of thing — where the user left
   * the furniture — but it is the one Appearance key that does NOT ride out as a
   * custom property. Collapsing takes the rail out of the grid entirely, and the
   * rail is the FIRST track: a width of zero would still leave the column there
   * for its divider and its resize seam to sit in. So App renders it as an
   * attribute on `.app`, exactly as it does the open panel.
   */
  railOpen: boolean
  /**
   * 'auto' follows the OS live via matchMedia; the other two pin it.
   *
   * The only look knob left, and deliberately so. The window is transparent
   * again with a native 'under-window' vibrancy material behind it, but the
   * surface alphas that sit on top of it are fixed tokens (--surface-a and
   * --rail-a in theme.css) rather than user controls — they are tuned per theme
   * against Cursor's own numbers, and a slider over them mostly produces
   * illegible text. Persisted Appearance objects from the era when opacity and
   * blur WERE controls still carry those keys; loadAppearance picks key by key,
   * so they are simply never read again.
   */
  theme: 'auto' | 'dark' | 'light'
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
   * `ready` means A BINARY WAS DETECTED — nothing more. It is `resolveServer`
   *   answering in the main process, and says nothing about whether the fleet in
   *   the host has one running, let alone one that has finished indexing. That
   *   is `LspStatus.phase`, computed from a different fact in a different
   *   process; conflating the two is how a green light ends up meaning nothing.
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

/**
 * What one running language server is doing right now.
 *
 * The counterpart to ServerReport, and deliberately not merged with it: that one
 * answers "is a server installed", this one answers "is it answering yet". The
 * gap between those is the whole reason this type exists — jdtls returns from
 * `initialize` in under four seconds on a Maven project and then spends minutes
 * building the project model, during which every completion comes back empty.
 * A `ready` that only meant "the handshake finished" would be a green light over
 * a server that cannot answer anything, which is worse than no light at all.
 *
 * Per session, because the LSP registry is a host-process singleton and one host
 * serves one session: three sessions on one repo really do run three fleets.
 */
export interface LspStatus {
  id: ServerId
  /** The resolution rung, e.g. 'jdtls', 'project tsgo' — Resolved.via. */
  via: string
  /**
   * `starting` — spawned, handshake in flight.
   * `indexing` — initialized, but its own reports say it is still working.
   * `ready` — nothing outstanding; answers can be trusted.
   * `failed` — detection or the handshake gave up. `detail` says why.
   */
  phase: 'starting' | 'indexing' | 'ready' | 'failed'
  /** 0-100 when the server reports it; null when it only says "busy". */
  percent: number | null
  /** The server's own message, e.g. 'Building eeo-nrc-efile-dev'. */
  detail: string | null
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
  /** Rewrite a queued message IN PLACE. Its own channel rather than a cancel
   *  plus a send, because the queue is an order and re-pushing would move the
   *  edited message behind anything queued after it. */
  sessionEditQueued: 'session:editQueued',

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
  /**
   * The host behind a session is gone, but the CONVERSATION is not.
   *
   * Deliberately not evtRemoved, and the difference is everything downstream:
   * removed means the row goes and the worktree is reclaimed, this means the row
   * stays and turns asleep. Emitted by the idle sweep, and by a host that
   * disconnected without being asked to — a dead host degrades to a row you can
   * wake rather than a row that lies about having an agent behind it.
   */
  evtHibernated: 'session:hibernated',
  /** Renderer -> main: which session is on screen, so the idle sweep never
   *  reclaims the one being read. Main has to hold this rather than asking the
   *  renderer to veto, or main can believe it hibernated a session it did not. */
  sessionActive: 'session:active',
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
  /** Branches for the composer's picker, and the checkout behind it. Beside the
   *  diff channels because they share their posture: read git against a cwd,
   *  answered in main, no session state. */
  gitBranches: 'git:branches',
  gitCheckout: 'git:checkout',

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
