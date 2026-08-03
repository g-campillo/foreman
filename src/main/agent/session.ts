import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { query, renameSession, type Query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import {
  IPC,
  type AccountInfo,
  type AgentInfo,
  type BackgroundTask,
  type BackgroundTaskStatus,
  type ChatItem,
  type ContextUsage,
  type EffortLevel,
  type LspStatus,
  type McpActionResult,
  type McpServerInfo,
  type ModelInfo,
  type PermissionMode,
  type RateWindow,
  type RewindResult,
  type SessionMeta,
  type SendContent,
  type SessionStatus,
  type SkillInfo,
  type SlashCommandInfo,
  type UsageInfo,
  type WorktreeInfo,
} from '../../shared/types'
import { notify, send } from '../../shared/sink'
import { createInputQueue, type InputQueue } from './queue'
import { makeCanUseTool, cancelPending } from './permissions'
import { makeOnElicitation, cancelPendingElicitations } from './elicitation'
import { makeDiffHook } from './gitdiff'
import { PLAN_AGENTS, makePlanHook } from './plan'
import { lspMcpServer, READ_ONLY_TOOLS } from '../../lsp/tools'
import { makeDiagnosticsHook } from '../../lsp/diagnose'
import { claudeExecutable } from './executable'
import { proposeTitle } from './title'
import { readUsage, writeUsage, type SessionSidecar } from './usage'
import {
  FALLBACK_MODEL,
  MAX_BUDGET_USD,
  MAX_TURNS,
  normaliseSend,
  notifyBody,
  resultText,
} from './policy.mts'

export interface SessionInit {
  cwd: string
  /**
   * Pre-minted session id.
   *
   * The manager chooses it, because it also names the host's directory on disk
   * and the client needs it before the host process exists. Without this the
   * Session would mint a second uuid and `meta.id` would not match the
   * directory the client is talking to — so shutdown would reap nothing.
   */
  sessionId?: string
  title?: string
  resume?: string
  permissionMode?: PermissionMode
  effort?: EffortLevel
  /** Model alias to start on, from the user's configured default. Absent or ''
   *  leaves the SDK's own default alone. */
  model?: string
  /** Name the conversation from its first message. Off skips the extra call. */
  autoTitle?: boolean
  /** Per-session caps from Settings. Absent falls back to the env defaults. */
  maxBudgetUsd?: number
  maxTurns?: number
  /** Set by the manager once it has actually created the worktree. `cwd` is
   *  already the worktree path by then; this is what the rail displays and what
   *  close() needs to clean it up. */
  worktree?: WorktreeInfo
}

/**
 * Total input for a turn, cache included.
 *
 * `input_tokens` alone is only the UNCACHED remainder — measured at 2 on a
 * $0.11 turn, because prompt caching moves essentially all of it into the two
 * cache counters. A "tokens in" readout built on it reads as broken, so both
 * are folded in: cache reads are billed (at a discount) and are real context.
 *
 * The cache fields are `number | null` rather than optional, because the two
 * callers pass two different usage shapes: `result` carries the SDK's own
 * non-nullable one, while an assistant message carries the API's BetaUsage,
 * where an uncached request reports the cache counters as literal null. `?? 0`
 * covers both, and narrowing this back to `?: number` breaks the second caller.
 */
function inputTokensOf(u: {
  input_tokens?: number | null
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
} | null | undefined): number {
  if (!u) return 0
  return (
    (u.input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0)
  )
}

/**
 * Everything learned about one task from the SDK's edge stream.
 *
 * A SIDE TABLE, keyed by task_id, and the shape of it is the fix. The tray used
 * to be built by merging each new `background_tasks_changed` payload against the
 * previous array — which only ever worked because every field it preserved was
 * written by `task_progress`, i.e. AFTER membership. `startedAt`, `toolUseId`
 * and `subagentType` come from `task_started`, and the SDK says plainly that
 * the level and the edges may arrive in either order: the very first thing that
 * happens to a backgrounded task is the one that would be dropped.
 *
 * So membership and knowledge are kept apart. Edges fold in here whether or not
 * the task is in the tray — a foreground subagent's start is recorded too, and
 * is waiting if it is later backgrounded — and the level decides only WHICH of
 * these rows the renderer is shown.
 */
interface TaskInfo {
  description?: string
  taskType?: string
  /** Written once, never overwritten. See noteTask. */
  startedAt?: number
  toolUseId?: string
  subagentType?: string
  workflowName?: string
  toolUses?: number
  tokens?: number
  progress?: string
  lastTool?: string
  status?: BackgroundTaskStatus
  error?: string
  pausedMs?: number
  /** Finished for good. Half of the GC test — see sweepTasks. */
  terminal?: boolean
  /** When `terminal` was first set. Stamped once, and it is what stops the
   *  chip's clock — see noteTask. */
  endedAt?: number
}

/** Statuses a task never comes back from. 'paused' and 'pending' are not here. */
const TERMINAL: ReadonlySet<BackgroundTaskStatus> = new Set<BackgroundTaskStatus>([
  'completed',
  'failed',
  'killed',
])

export class Session {
  readonly meta: SessionMeta
  // A message leaving the queue is the moment it stops being cancellable, and
  // the moment the session is genuinely working on it.
  private readonly queue: InputQueue = createInputQueue((itemId) => {
    send(IPC.evtQueue, { sessionId: this.meta.id, itemId, state: 'started' })
    // Here rather than in setStatus: 'awaiting-approval' -> 'running' re-enters
    // that method, so a permission prompt mid-turn would zero the clock. A
    // message leaving the queue happens exactly once per turn.
    //
    // `contextTokens` is deliberately NOT reset with them. It is a level, not a
    // per-turn counter — the window is exactly as full the instant after you
    // press send as the instant before — and a gauge that empties on send reads
    // as a bug. It is replaced wholesale by the next assistant message.
    this.patchMeta({ turnStartedAt: Date.now(), turnTokens: 0 })
    this.setStatus('running')
  })
  private readonly abort = new AbortController()
  private q: Query | null = null
  private closed = false

  /**
   * Item ids for the text/thinking blocks currently being streamed into, keyed
   * by parent_tool_use_id ('' for the main thread). Maps rather than scalars
   * because subagents stream concurrently with the main thread and with each
   * other — a single slot would splice their deltas into one item.
   */
  private readonly streamingText = new Map<string, string>()
  private readonly streamingThinking = new Map<string, string>()
  /** tool_use_id -> ChatItem id, so tool_result can update the right card. */
  private readonly toolItems = new Map<string, string>()
  /**
   * The task side table, and the tray's membership, kept apart on purpose — see
   * TaskInfo above.
   *
   * Instance fields rather than module state because the level is PER-PROCESS:
   * the SDK emits nothing at startup and expects the set to be empty until the
   * first membership change, and a Session owns exactly one query(). So these
   * are born empty with the CLI and die with it, which is the contract.
   */
  private readonly taskInfo = new Map<string, TaskInfo>()
  private taskMembers: { taskId: string; taskType: string }[] = []
  private pendingApprovals = 0
  /**
   * Auto-titling state.
   *
   * `named` means the caller already chose a title — a worktree branch name, or
   * a resumed session's stored one — and naming it again would overwrite
   * something the user picked. `titled` makes the attempt once-only regardless
   * of outcome, so a failed call doesn't retry on every subsequent message.
   * `pendingTitle` is held until the first turn ends, because renameSession
   * writes to the session's transcript file, which does not exist yet when the
   * first message is sent.
   */
  private readonly named: boolean
  /** Settings' "name conversations automatically". Off means never attempt it. */
  private readonly autoTitleOn: boolean
  private titled = false
  private pendingTitle: string | null = null
  /** Spend from previous runs of this conversation — see the constructor. */
  private readonly restoredCost: number
  /** Set while a user-initiated interrupt is in flight: the turn it aborts comes
   *  back with is_error, which is not a failure the user should see as one. */
  private interrupting = false
  /** Resolves once the CLI subprocess can accept control messages. */
  private readonly ready: Promise<void>

  constructor(init: SessionInit) {
    const id = init.sessionId ?? randomUUID()
    this.named = Boolean(init.title)
    this.autoTitleOn = init.autoTitle !== false
    // What we already knew about this conversation before this run. A literal
    // zero for a fresh session, so a genuinely new one is untouched by anything
    // below; for a resumed one it comes back off the sidecar, because the CLI's
    // own `total_cost_usd` restarts from zero on resume and its transcript has
    // nowhere to record a permission mode at all.
    const prior: SessionSidecar = init.resume
      ? readUsage(init.resume)
      : { costUsd: 0, inputTokens: 0, outputTokens: 0 }
    this.restoredCost = prior.costUsd
    this.meta = {
      id,
      title: init.title ?? basename(init.cwd) ?? 'session',
      cwd: init.cwd,
      status: 'starting',
      model: null,
      costUsd: prior.costUsd,
      inputTokens: prior.inputTokens,
      outputTokens: prior.outputTokens,
      turnStartedAt: null,
      turnTokens: 0,
      // Unknown until the first request reports one. Not restored from the
      // sidecar with cost and tokens above: those are cumulative facts about the
      // conversation, this is a reading of a window that does not exist yet.
      contextTokens: null,
      // What this conversation WAS beats what the renderer configures a new one
      // to be. Resolved here rather than in the renderer's resume() because it
      // has to be known BEFORE query() is constructed twelve lines down —
      // otherwise the session starts on the wrong mode and gets patched, which
      // is exactly the flash sessionPrefs() exists to avoid.
      permissionMode: prior.permissionMode ?? init.permissionMode ?? 'default',
      createdAt: Date.now(),
      effort: init.effort ?? null,
      promptSuggestion: null,
      backgroundTasks: [],
      // Fresh: we mint the id and hand it to the SDK, so the two agree.
      // Resume: `init.resume` IS the SDK's session id, and ours differs.
      // Either way this is the id that addresses the session on disk.
      sdkSessionId: init.resume ?? id,
      ...(init.worktree ? { worktree: init.worktree } : {}),
    }

    this.q = query({
      prompt: this.queue,
      options: {
        cwd: init.cwd,
        // Mint our own id so the renderer can key off it immediately instead of
        // waiting for the system/init frame — but ONLY on a fresh session. The
        // CLI rejects --session-id alongside --resume unless --fork-session is
        // set, so on resume we let the SDK keep the original id. Our meta.id
        // stays the internal routing handle either way.
        ...(init.resume ? { resume: init.resume } : { sessionId: this.meta.id }),
        permissionMode: this.meta.permissionMode,
        includePartialMessages: true,
        allowDangerouslySkipPermissions: true, // lets the mode switcher offer bypass
        fallbackModel: FALLBACK_MODEL,
        // Spread rather than assign: FOREMAN_MAX_*=0 means "no cap at all", and
        // the key has to be absent for that, not present-and-undefined.
        // Settings first, env as the fallback, absent for "no cap" — the key
        // has to be missing, not present-and-undefined.
        ...((init.maxBudgetUsd ?? MAX_BUDGET_USD)
          ? { maxBudgetUsd: init.maxBudgetUsd ?? MAX_BUDGET_USD }
          : {}),
        ...((init.maxTurns ?? MAX_TURNS) ? { maxTurns: init.maxTurns ?? MAX_TURNS } : {}),
        // Backs up files before the agent modifies them, which is what makes
        // q.rewindFiles() possible later. Inert until something calls it.
        enableFileCheckpointing: true,
        promptSuggestions: true,
        // Subagent text/thinking arrives as ordinary assistant messages with
        // parent_tool_use_id set. This MUST stay in the same commit as the
        // parent_tool_use_id routing below (handleAssistant, handleStreamEvent)
        // or subagent chatter interleaves into the main transcript.
        forwardSubagentText: true,
        // Forks the subagent every ~30s for a present-tense summary on
        // task_progress. Reuses its model and prompt cache, so it's near-free.
        agentProgressSummaries: true,
        // Markdown rather than the 'html' the roadmap suggested: we already have
        // a markdown renderer, and react-markdown drops raw HTML by default —
        // so this avoids putting model-authored HTML through
        // dangerouslySetInnerHTML in a renderer that can reach the network.
        toolConfig: { askUserQuestion: { previewFormat: 'markdown' } },
        // Adaptive lets the model choose per turn; the effort dropdown steers it.
        thinking: { type: 'adaptive' },
        ...(init.effort ? { effort: init.effort } : {}),
        // Spread, not assign: '' is the "Default (recommended)" alias, and the
        // key has to be ABSENT for the SDK to pick — present-and-empty is an
        // unresolvable model name.
        ...(init.model ? { model: init.model } : {}),
        // Undocumented payload shapes, so this only observes for now — answering
        // 'cancelled' is the contract's required reply for an unhandled kind.
        onUserDialog: async (request) => {
          console.error('[user-dialog]', JSON.stringify(request).slice(0, 900))
          return { behavior: 'cancelled' }
        },
        canUseTool: makeCanUseTool(
          this.meta.id,
          (n) => {
            this.pendingApprovals = n
            this.setStatus(n > 0 ? 'awaiting-approval' : 'running')
          },
          // Approving a plan changes the mode through the permission result, so
          // meta has to follow it there — patchMeta only, since the CLI already
          // applied it and calling setPermissionMode would just echo it back.
          (mode) => this.patchMeta({ permissionMode: mode }),
        ),
        // Without this the SDK auto-declines every MCP elicitation, which
        // silently kills OAuth for any server that needs it.
        onElicitation: makeOnElicitation(this.meta.id),
        // The language servers, as tools. One field — the MCP panel,
        // mcpStatus(), the toggle and the permission override all already
        // exist and pick this up for free.
        mcpServers: { lsp: lspMcpServer() },
        // The read-only half auto-allowed. Measured: MCP calls DO reach
        // canUseTool, so without this every reference lookup raises a prompt.
        // It widens nothing — the agent can already Read any file, and asking a
        // compiler where a symbol lives reveals less than reading it would. The
        // write tools are deliberately absent and keep prompting.
        allowedTools: READ_ONLY_TOOLS,
        // Named roles for the plan-approval "with subagents" path. Constructor-
        // only — Query cannot add an agent mid-session and reinitialize() takes
        // no arguments — so they are passed for every session and cost nothing
        // until one is invoked. settingSources is not passed, so any filesystem
        // agents in ~/.claude/agents still load and merge alongside these.
        agents: PLAN_AGENTS,
        hooks: {
          // Two matchers on one event: a one-git-call badge refresh on writes,
          // and the plan-orchestration directive on ExitPlanMode. Verified live
          // that both are heard — the diff badge still refreshes with the second
          // installed.
          PostToolUse: [
            ...makeDiffHook(this.meta.id, init.cwd),
            ...makePlanHook(this.meta.id),
          ],
          // Separate from the diff hook on purpose. That one is a one-git-call
          // badge refresh per tool; this one runs once per BATCH, because five
          // parallel Edits should diagnose once rather than five times racing,
          // and because PostToolBatch lands before the next model request —
          // which is the only place a "you just broke three things" message is
          // worth anything.
          PostToolBatch: makeDiagnosticsHook(init.cwd),
        },
        pathToClaudeCodeExecutable: claudeExecutable(),
        abortController: this.abort,
        stderr: (data) => console.error(`[session ${this.meta.id}]`, data),
      },
    })

    // Control methods write to the CLI subprocess, which throws
    // "ProcessTransport is not ready for writing" until init completes.
    this.ready = this.q
      .initializationResult()
      .then(() => {
        // In streaming-input mode the system/init frame doesn't arrive until the
        // first message, so without this the rail sits on "starting" forever
        // even though the session is ready for input.
        if (this.meta.status === 'starting') this.setStatus('idle')
      })
      .catch(() => undefined)

    void this.pump()
  }

  // ---------------------------------------------------------------- outbound

  private emit(item: ChatItem): void {
    send(IPC.evtItem, { sessionId: this.meta.id, item })
  }

  private patchMeta(patch: Partial<SessionMeta>): void {
    Object.assign(this.meta, patch)
    send(IPC.evtMeta, { sessionId: this.meta.id, patch })
    // Keyed off the PATCH, not called from each writer. There are already two
    // writers of permissionMode — setPermissionMode() and the plan-approval
    // onModeChanged callback in the constructor — and a third can be added by
    // someone with no reason to know this file needs telling.
    if ('permissionMode' in patch || 'costUsd' in patch) this.persistSidecar()
  }

  /**
   * Everything about this conversation the CLI's transcript cannot hold.
   *
   * Whole-record, because writeUsage replaces the file: writing only the fields
   * that changed would erase the others. Cheap either way — one ~80-byte file,
   * and the cadence is unchanged from when the cost write sat inline in the
   * `result` handler, since 'costUsd' is patched exactly once per turn.
   */
  private persistSidecar(): void {
    if (!this.meta.sdkSessionId) return
    writeUsage(this.meta.sdkSessionId, {
      // The project, not the scratch worktree — attribution should survive the
      // worktree being removed. Already canonical: createSession realpaths the cwd.
      cwd: this.meta.worktree?.repoRoot ?? this.meta.cwd,
      costUsd: this.meta.costUsd,
      inputTokens: this.meta.inputTokens,
      outputTokens: this.meta.outputTokens,
      permissionMode: this.meta.permissionMode,
    })
  }

  private setStatus(status: SessionStatus): void {
    if (this.meta.status === status) return
    const was = this.meta.status
    this.patchMeta({ status })

    // Hold queued messages while a turn is in flight, and release one when it
    // ends. Anything other than an in-flight turn (including 'starting' and
    // 'error') leaves the gate open, so a session that never reaches idle can
    // still send rather than stalling messages here forever.
    this.queue.setGate(status !== 'running' && status !== 'awaiting-approval')

    const body = notifyBody(was, status, this.pendingApprovals)
    if (body) notify(this.meta.title, body)
  }

  // ------------------------------------------------------------------- pump

  private async pump(): Promise<void> {
    try {
      for await (const msg of this.q!) this.handle(msg)
    } catch (err) {
      if (!this.closed) {
        this.emit({ id: randomUUID(), kind: 'error', text: String(err) })
        this.setStatus('error')
      }
    }
  }

  private handle(msg: SDKMessage): void {
    // Unhandled types fall through deliberately. Verified arriving today:
    // `prompt_suggestion` (enabled below, rendered in batch 6) and
    // `rate_limit_event`, which carries the plan's 5-hour/7-day windows and is
    // a steadier source for those than the experimental usage API.
    switch (msg.type) {
      // Predicted next prompt, emitted after each result. Rendered as composer
      // ghost text; absence is normal (first turn, plan mode, after API errors).
      case 'prompt_suggestion':
        this.patchMeta({ promptSuggestion: msg.suggestion || null })
        break

      case 'system':
        // THE LEVEL. Ids only, REPLACE semantics, and the SDK's own note says
        // its order against the task_started/task_notification edges is
        // unspecified — so this decides membership and nothing else. Everything
        // a chip actually shows comes out of the side table, which the edges
        // fill in whenever they happen to arrive.
        if (msg.subtype === 'background_tasks_changed') {
          for (const t of msg.tasks) {
            const info = this.taskInfo.get(t.task_id) ?? {}
            // What we already learned wins over the level's copy: this payload
            // is a snapshot of the description at membership time, while
            // task_updated can refine it afterwards.
            info.description ??= t.description
            info.taskType ??= t.task_type
            // A clock the chip can start from even when we never saw the start
            // edge — an adopted host replaying its log mid-task is the case.
            // Never overwrites a real one: task_started writes into this same
            // row whether or not the task was a member at the time.
            info.startedAt ??= Date.now()
            this.taskInfo.set(t.task_id, info)
          }
          this.taskMembers = msg.tasks.map((t) => ({ taskId: t.task_id, taskType: t.task_type }))
          this.sweepTasks()
          this.projectTasks()
          break
        }
        // The first thing a task says about itself, and ~30s before any
        // task_progress could: this is where the clock, the tool card it
        // belongs to and what KIND of work it is are learned.
        //
        // It deliberately does NOT touch membership. Every subagent starts in
        // the foreground, and a task_started that seeded the tray would put a
        // chip under the composer for work the transcript is already showing.
        if (msg.subtype === 'task_started') {
          this.noteTask(
            msg.task_id,
            {
              description: msg.description,
              taskType: msg.task_type,
              subagentType: msg.subagent_type,
              workflowName: msg.workflow_name,
              toolUseId: msg.tool_use_id,
              status: 'running',
            },
            Date.now(),
          )
          break
        }
        // A wire-safe patch of whatever changed on the task. Merged, not
        // replaced.
        //
        // `is_backgrounded` is IGNORED: membership belongs to the level, and
        // honouring it here would put a chip in the tray the level has not
        // admitted — the exact correlation between the two streams the SDK
        // tells consumers not to make.
        //
        // `end_time` is ignored in favour of the `endedAt` noteTask stamps when
        // the terminal flag first lands. It appears on only one of the several
        // edges that can end a task, so honouring it would freeze the chip's
        // clock on a completion and leave it running on a kill — and `startedAt`
        // is our own clock anyway, so an SDK timestamp on one end of a duration
        // and a local one on the other is a subtraction between two clocks.
        if (msg.subtype === 'task_updated') {
          const p = msg.patch
          this.noteTask(msg.task_id, {
            status: p.status,
            description: p.description,
            error: p.error,
            pausedMs: p.total_paused_ms,
            ...(p.status && TERMINAL.has(p.status) ? { terminal: true } : {}),
          })
          break
        }
        // Rolling AI summary of a running subagent. Folded onto the Task card
        // rather than emitted as its own item, so it reads as a status line on
        // the work it describes instead of scrolling past as noise.
        if (msg.subtype === 'task_progress') {
          const itemId = msg.tool_use_id ? this.toolItems.get(msg.tool_use_id) : undefined
          if (itemId) {
            this.emit({
              id: itemId,
              kind: 'tool',
              name: '',
              input: undefined,
              status: 'pending',
              progress: msg.summary || msg.last_tool_name || msg.description,
            })
          }
          // The same event also feeds the background tray, joined on task_id —
          // for a BACKGROUNDED task the transcript card above says "running in
          // the background" and never updates again, so this is the only place
          // its progress can be seen. noteTask no-ops the projection when the
          // task isn't in the tray, while still recording what it said.
          //
          // `duration_ms` is a START FLOOR and never the clock. It is measured
          // when the summary was forked, which is up to ~30s ago, so using it
          // to drive elapsed time would make the chip's clock jump backwards
          // every time a progress message landed. On first sight of a task
          // whose start edge we missed it is the best lower bound available.
          this.noteTask(
            msg.task_id,
            {
              description: msg.description,
              subagentType: msg.subagent_type,
              toolUseId: msg.tool_use_id,
              progress: msg.summary,
              lastTool: msg.last_tool_name,
              tokens: msg.usage?.total_tokens,
              toolUses: msg.usage?.tool_uses,
            },
            msg.usage?.duration_ms ? Date.now() - msg.usage.duration_ms : undefined,
          )
          break
        }
        // A finished background task or subagent reports here; the changed-set
        // message handles removal, so this only surfaces the outcome.
        if (msg.subtype === 'task_notification') {
          // The tray half. The level takes the chip away a beat later, and this
          // is what makes the card say how it ended in the meantime — 'stopped'
          // on the wire is 'killed' in the SDK's own status vocabulary, which is
          // the one BackgroundTaskStatus mirrors.
          this.noteTask(msg.task_id, {
            status:
              msg.status === 'completed' ? 'completed' : msg.status === 'failed' ? 'failed' : 'killed',
            terminal: true,
          })
          // The other sweep site, and the only one a session with no background
          // work ever reaches — see sweepTasks. A row that is still in the tray
          // survives it, so this cannot take a live chip away.
          this.sweepTasks()
          if (!msg.skip_transcript) {
            // Prefer settling the card that started the work: a backgrounded
            // tool already returned "running in the background", so this is the
            // only place its true outcome shows up. `summary` is deliberately
            // dropped here — it's the subagent's full report, which already
            // arrives as the tool_result, and it is not a one-line status.
            // Clearing `progress` retires the live status line with the work.
            const itemId = msg.tool_use_id ? this.toolItems.get(msg.tool_use_id) : undefined
            this.emit(
              itemId
                ? {
                    id: itemId,
                    kind: 'tool',
                    name: '',
                    input: undefined,
                    status: msg.status === 'completed' ? 'done' : 'error',
                    progress: undefined,
                  }
                : {
                    id: randomUUID(),
                    kind: 'tool',
                    name: `background · ${msg.status}`,
                    input: undefined,
                    status: msg.status === 'completed' ? 'done' : 'error',
                    result: msg.summary,
                  },
            )
          }
          break
        }
        // Compaction just rewrote the conversation, so the window occupancy
        // fell — usually by most of it. The estimate `handleAssistant` keeps is
        // now describing a conversation that no longer exists, and nothing else
        // would correct it until the next assistant message lands, so the ring
        // would sit red through the very turn that fixed it. `post_tokens` is
        // optional in the SDK's own metadata; null means "unknown", which the
        // renderer reads as "fall back to the polled figure".
        if (msg.subtype === 'compact_boundary') {
          this.patchMeta({ contextTokens: msg.compact_metadata.post_tokens ?? null })
          break
        }
        // Only the init frame means "ready", and only while we're still starting.
        // In streaming-input mode init doesn't arrive until the first user
        // message is already in flight, so it lands MID-TURN — without the
        // status guard it marks a running session idle a second after send,
        // which reads as a finished turn to anything watching (the rail, and
        // turn-complete notifications). Verified live: running/idle/running/idle
        // across one turn. Other system subtypes arrive mid-turn too.
        // (The init frame carries no `model` — that comes off the assistant
        // message, verified against the live SDK.)
        if (msg.subtype === 'init' && this.meta.status === 'starting') this.setStatus('idle')
        break

      // /clear, a plan-mode exit, a fresh conversation under the same session:
      // the window is empty again. A top-level message type rather than a
      // `system` subtype, unlike compact_boundary — so it cannot live in the
      // branch above however alike the two read.
      //
      // Only the context level is reset here. The transcript is deliberately
      // left alone: the renderer's store is the record of what was said, and
      // clearing the model's window does not unsay it.
      case 'conversation_reset':
        this.patchMeta({ contextTokens: null })
        break

      case 'stream_event':
        // Deltas carry parent_tool_use_id too — routing only handleAssistant
        // would still splice live subagent text into the main transcript.
        this.handleStreamEvent(msg.event, msg.parent_tool_use_id)
        break

      case 'assistant':
        this.handleAssistant(msg)
        break

      case 'user':
        this.handleToolResults(msg)
        break

      case 'result': {
        const r = msg as Extract<SDKMessage, { type: 'result' }>
        this.streamingText.clear()
        this.streamingThinking.clear()
        // The per-turn line wants this turn's spend, which is the delta against
        // the previous running total.
        const turnCost = Math.max(0, (r.total_cost_usd ?? 0) - this.meta.costUsd)
        const interrupted = this.interrupting
        this.interrupting = false
        this.emit({
          id: randomUUID(),
          kind: 'result',
          text: resultText({
            interrupted,
            result: 'result' in r ? r.result : undefined,
            subtype: r.subtype,
          }),
          costUsd: turnCost,
          durationMs: r.duration_ms ?? 0,
          isError: !interrupted && Boolean(r.is_error),
        })
        this.patchMeta({
          // total_cost_usd is the running SESSION total, not this turn's delta —
          // verified against the live SDK. Adding it would compound every turn.
          //
          // `restoredCost` is what a resumed session already spent before this
          // run: the CLI's running total restarts at zero on resume, so without
          // the offset a reopened conversation would report only today's spend.
          costUsd: this.restoredCost + (r.total_cost_usd ?? 0),
          // usage, by contrast, IS per-turn, so these do accumulate.
          inputTokens: this.meta.inputTokens + inputTokensOf(r.usage),
          outputTokens: this.meta.outputTokens + (r.usage?.output_tokens ?? 0),
          // The turn is over: stop the clock, and let the authoritative figure
          // replace the running estimate. `r.usage` is already per-turn, so this
          // is a set rather than an add. Falls back to the estimate if the SDK
          // sent no usage at all.
          turnStartedAt: null,
          turnTokens: r.usage?.output_tokens ?? this.meta.turnTokens,
        })
        // The sidecar write that used to sit here is gone: the patchMeta above
        // carries 'costUsd', which is what now triggers persistSidecar(). Same
        // single call per turn, byte-for-byte the same cadence.
        this.setStatus(!interrupted && r.is_error ? 'error' : 'idle')
        // The transcript file exists by now, so an auto-title can reach disk.
        this.persistTitle()
        break
      }
    }
  }

  /**
   * Fold one task edge into the side table, and re-project if it is on screen.
   *
   * `undefined` values are SKIPPED rather than assigned, because these patches
   * are built straight off optional SDK fields: a task_progress that carries no
   * summary would otherwise wipe the summary the previous one set, which is
   * exactly the "every chip goes blank" failure the old merge-by-array was
   * written to avoid.
   *
   * `startedAt` is separate from the patch and is written ONCE. Three sources
   * can supply it — the start edge, the level, and task_progress's duration
   * floor — and they disagree by seconds; a clock that jumped whenever a later
   * one arrived would be worse than no clock.
   */
  private noteTask(taskId: string, patch: Partial<TaskInfo>, startedAt?: number): void {
    const info = this.taskInfo.get(taskId) ?? {}
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) (info as Record<string, unknown>)[k] = v
    }
    if (startedAt !== undefined) info.startedAt ??= startedAt
    // STAMPED HERE, once, because the renderer's clock is `now - startedAt` and
    // has no other way to learn that it should stop. The SDK's own `end_time` is
    // deliberately not used for it: it appears on one of the several edges that
    // can end a task, so a chip's clock would freeze for a completion and keep
    // running for a kill. This is set by whichever edge got here first.
    if (info.terminal) info.endedAt ??= Date.now()
    this.taskInfo.set(taskId, info)
    // Not a member: recorded, but nothing on screen changes. This is what lets
    // a foreground subagent's start edge be kept without putting a chip in the
    // tray, ready for the moment it is backgrounded.
    if (this.taskMembers.some((m) => m.taskId === taskId)) this.projectTasks()
  }

  /**
   * Drop side-table rows that are finished AND not in the tray.
   *
   * BOTH halves are required. Dropping on membership alone would throw away the
   * outcome of a task whose notification is still in flight — the two streams
   * have no defined order — and dropping on terminal alone would empty a chip
   * that is still on screen.
   *
   * Called from the level AND from task_notification, and the second call site
   * is the one that matters for memory: the level only fires when a BACKGROUND
   * task starts or ends, so a session that runs two hundred foreground subagents
   * and backgrounds none would have swept exactly never, accumulating a row per
   * subagent for the life of the session. Those rows are terminal and were never
   * members, so they go here at the moment they finish.
   */
  private sweepTasks(): void {
    for (const [id, info] of this.taskInfo) {
      if (info.terminal && !this.taskMembers.some((m) => m.taskId === id)) {
        this.taskInfo.delete(id)
      }
    }
  }

  /**
   * THE SINGLE WRITER of meta.backgroundTasks.
   *
   * Everything else writes to the side table and calls this, so the renderer's
   * array is a pure projection of (membership × knowledge) and can never end up
   * carrying a task the level has dropped or missing a field an edge supplied
   * out of order.
   */
  private projectTasks(): void {
    const tasks: BackgroundTask[] = this.taskMembers.map(({ taskId, taskType }) => {
      const i = this.taskInfo.get(taskId) ?? {}
      // Re-resolved on EVERY projection rather than stored once, because the
      // tool card can be registered AFTER the task announces itself:
      // handleAssistant writes toolItems when the tool_use block lands, and a
      // task_started that beat it would otherwise be stuck with no card to
      // link to for the rest of its life.
      const itemId = i.toolUseId ? this.toolItems.get(i.toolUseId) : undefined
      return {
        taskId,
        taskType: i.taskType ?? taskType,
        description: i.description ?? '',
        // Seeded on membership, so this fallback is unreachable — it exists
        // because `startedAt` is required and inventing `0` would render a
        // 57-year-old task.
        startedAt: i.startedAt ?? Date.now(),
        // MUST be projected, not just kept: `terminal` never crosses the bridge,
        // so without this the chip of a task that reported 'completed' before
        // the level dropped it — the unspecified ordering this whole side table
        // exists for — would say "completed" with the clock still running.
        ...(i.endedAt ? { endedAt: i.endedAt } : {}),
        ...(i.pausedMs ? { pausedMs: i.pausedMs } : {}),
        ...(i.subagentType ? { subagentType: i.subagentType } : {}),
        ...(i.workflowName ? { workflowName: i.workflowName } : {}),
        ...(i.toolUses ? { toolUses: i.toolUses } : {}),
        ...(i.status ? { status: i.status } : {}),
        ...(i.error ? { error: i.error } : {}),
        ...(itemId ? { itemId } : {}),
        ...(i.progress ? { progress: i.progress } : {}),
        ...(i.lastTool ? { lastTool: i.lastTool } : {}),
        ...(i.tokens ? { tokens: i.tokens } : {}),
      }
    })
    this.patchMeta({ backgroundTasks: tasks })
  }

  /**
   * The Task card a subagent's output belongs under, or undefined for the main
   * thread. A miss degrades to top-level rather than dropping the item — the
   * pre-subagent behaviour, which is the safe direction to fail in.
   */
  private parentItem(parentToolUseId: string | null | undefined): string | undefined {
    return parentToolUseId ? this.toolItems.get(parentToolUseId) : undefined
  }

  /** Live text/thinking deltas. Rendering is upserted, then reconciled below. */
  private handleStreamEvent(event: unknown, parentToolUseId: string | null): void {
    const e = event as { type?: string; delta?: { type?: string; text?: string; thinking?: string } }
    const key = parentToolUseId ?? ''

    if (e.type === 'content_block_start') {
      // A fresh block begins; the next deltas belong to a new item.
      const block = (event as { content_block?: { type?: string } }).content_block
      if (block?.type === 'text') this.streamingText.delete(key)
      if (block?.type === 'thinking') this.streamingThinking.delete(key)
      return
    }

    if (e.type !== 'content_block_delta' || !e.delta) return

    const parentId = this.parentItem(parentToolUseId)
    const stream = (map: Map<string, string>, kind: 'assistant' | 'thinking', text: string): void => {
      const id = map.get(key)
      if (id) {
        send(IPC.evtDelta, { sessionId: this.meta.id, itemId: id, text })
      } else {
        const fresh = randomUUID()
        map.set(key, fresh)
        this.emit({ id: fresh, kind, text, ...(parentId ? { parentId } : {}) })
      }
      this.setStatus('running')
    }

    if (e.delta.type === 'text_delta' && e.delta.text) {
      stream(this.streamingText, 'assistant', e.delta.text)
    } else if (e.delta.type === 'thinking_delta' && e.delta.thinking) {
      stream(this.streamingThinking, 'thinking', e.delta.thinking)
    }
  }

  /**
   * The authoritative assistant turn. Text items are re-emitted with the final
   * text (upsert by id) so a dropped stream event can't leave the UI truncated;
   * tool_use blocks become cards here, since deltas don't carry them usefully.
   */
  private handleAssistant(msg: Extract<SDKMessage, { type: 'assistant' }>): void {
    const key = msg.parent_tool_use_id ?? ''
    const parentId = this.parentItem(msg.parent_tool_use_id)
    const under = parentId ? { parentId } : {}

    // The system/init frame carries no model, so this is where we learn it —
    // but only from the main thread. A subagent can run a different model
    // (AgentInfo.model), and stamping that here flips the model picker mid-turn
    // and then leaves it wrong once the subagent finishes.
    const model = msg.message?.model
    if (!msg.parent_tool_use_id && typeof model === 'string' && model !== this.meta.model) {
      this.patchMeta({ model })
    }

    // Main thread only, for the same reason as the model above: a subagent's
    // output is billed to this turn, but counting it here makes the running
    // total jump as subagents interleave — and a subagent has its own context
    // window, so its occupancy is not this conversation's. Their tokens still
    // land in the authoritative `result` totals.
    //
    // One patch for both figures, and it costs no extra IPC: `turnTokens`
    // already sends one here, so the live window level rides along for free.
    // `contextTokens` is a SET rather than an add — input is the whole
    // conversation re-sent, so this request's input plus what it just produced
    // IS the occupancy the next request will start from.
    const u = msg.message?.usage
    const out = u?.output_tokens
    if (!msg.parent_tool_use_id && typeof out === 'number') {
      this.patchMeta({
        turnTokens: this.meta.turnTokens + out,
        contextTokens: inputTokensOf(u) + out,
      })
    }

    for (const block of msg.message?.content ?? []) {
      if (block.type === 'text') {
        const id = this.streamingText.get(key) ?? randomUUID()
        // msg.uuid is the SDK's id for this assistant turn — the one
        // resumeSessionAt takes. Our own `id` keys the streaming upsert and is
        // unrelated to it.
        this.emit({ id, kind: 'assistant', text: block.text, uuid: msg.uuid, ...under })
        this.streamingText.delete(key)
      } else if (block.type === 'tool_use') {
        const itemId = randomUUID()
        this.toolItems.set(block.id, itemId)
        this.emit({
          id: itemId,
          kind: 'tool',
          name: block.name,
          input: block.input,
          status: 'pending',
          ...under,
        })
      }
    }
    this.streamingThinking.delete(key)
  }

  private handleToolResults(msg: Extract<SDKMessage, { type: 'user' }>): void {
    const content = msg.message?.content
    if (!Array.isArray(content)) return

    for (const block of content) {
      if (block.type !== 'tool_result') continue
      const itemId = this.toolItems.get(block.tool_use_id)
      if (!itemId) continue

      const raw = block.content
      const text =
        typeof raw === 'string'
          ? raw
          : Array.isArray(raw)
            ? raw.map((c) => ('text' in c && typeof c.text === 'string' ? c.text : '')).join('')
            : ''

      this.emit({
        id: itemId,
        kind: 'tool',
        name: '',
        input: undefined,
        status: block.is_error ? 'error' : 'done',
        result: text.slice(0, 4000),
      })
    }
  }

  // ---------------------------------------------------------------- controls

  /**
   * Accepts block content, not just a string, so attachments ride the same path
   * as text. A bare string stays a bare string on the wire — the block form only
   * appears when there is actually something attached.
   *
   * The item is emitted immediately and marked `queued`, so a message typed
   * during a run shows up straight away and stays cancellable until the SDK
   * actually pulls it off the queue.
   */
  send(raw: SendContent): void {
    const content = normaliseSend(raw)
    if (content === null) return
    const id = randomUUID()
    const text =
      typeof content === 'string'
        ? content
        : content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n')
    const images =
      typeof content === 'string'
        ? []
        : content.flatMap((b) =>
            b.type === 'image' ? [`data:${b.source.media_type};base64,${b.source.data}`] : [],
          )

    const busy = this.meta.status === 'running' || this.meta.status === 'awaiting-approval'
    this.emit({
      id,
      kind: 'user',
      text,
      // Same value as `id` by construction — see queue.push. Carried explicitly
      // so consumers don't have to know that coincidence.
      uuid: id,
      ...(images.length ? { images } : {}),
      ...(busy ? { queued: true } : {}),
    })
    // No setStatus here: pushing is enough. If the gate is open the generator
    // picks it up immediately and onDequeue flips the status, which is the same
    // signal for a first message and a released one.
    this.queue.push(content, id)

    // Name the conversation off its opening message. Fire-and-forget and
    // deliberately not awaited — the turn must not wait on a title.
    if (text.trim()) void this.autoTitle(text)
  }

  setTitle(title: string): void {
    this.patchMeta({ title })
  }

  /**
   * This session's language servers, as the LSP registry in this process sees
   * them. REPLACE semantics — the whole fleet, every time.
   *
   * A method rather than the host sending evtMeta by hand, so `this.meta` stays
   * in step with what the renderer was told: `hello` and the `meta` call both
   * answer from it, and a client attaching mid-index would otherwise be told
   * nothing until the next frame happened to arrive.
   */
  setLspStatus(list: LspStatus[]): void {
    this.patchMeta({ lspStatus: list })
  }

  /**
   * Give the conversation a real name, once, from its first message.
   *
   * Two-stage on purpose. The rail is patched as soon as the title arrives, so
   * "foreman" becomes something meaningful within a second or two of sending.
   * Persisting it waits for the first turn to finish (see the `result` branch),
   * because renameSession writes into the session's transcript file and that
   * file does not exist until the CLI has written to it.
   */
  private async autoTitle(firstMessage: string): Promise<void> {
    if (this.titled || this.named || !this.autoTitleOn) return
    this.titled = true

    const title = await proposeTitle(firstMessage, this.meta.cwd)
    // A dead session must not get its title patched back onto a rail row that
    // has already gone.
    if (!title || this.closed) return
    this.patchMeta({ title })
    this.pendingTitle = title
  }

  /** Write the auto-title through to disk, so History inherits it too. */
  private persistTitle(): void {
    const title = this.pendingTitle
    const sdkId = this.meta.sdkSessionId
    if (!title || !sdkId) return
    this.pendingTitle = null
    // renameSession sets `customTitle`, which listSessions prefers over the
    // summary — so the good name shows up in the History rail as well.
    void renameSession(sdkId, title).catch((e) => console.warn('[title] rename failed:', e))
  }

  // ---------------------------------------------------- time travel + actions

  /**
   * Restore files to their state at a user message.
   *
   * With dryRun this is the confirmation preview — the SDK reports what *would*
   * change without touching anything, which is why the card can show a file
   * count before the user commits. Requires enableFileCheckpointing, on since
   * batch 1.
   */
  async rewind(userMessageId: string, dryRun: boolean): Promise<RewindResult> {
    await this.ready
    try {
      const r = await this.q?.rewindFiles(userMessageId, { dryRun })
      if (!r) return { canRewind: false, error: 'No session', filesChanged: [], insertions: 0, deletions: 0 }
      return {
        canRewind: r.canRewind,
        error: r.error,
        filesChanged: r.filesChanged ?? [],
        insertions: r.insertions ?? 0,
        deletions: r.deletions ?? 0,
        skippedLinks: r.skippedLinks,
      }
    } catch (err) {
      return { canRewind: false, error: String(err), filesChanged: [], insertions: 0, deletions: 0 }
    }
  }

  async setEffort(effort: EffortLevel | null): Promise<void> {
    await this.ready
    await this.q
      ?.applyFlagSettings({ effortLevel: effort })
      .catch((e) => console.warn('[setEffort]', e))
    this.patchMeta({ effort })
  }

  /** Move in-flight work to the background so the turn can continue. */
  async background(toolUseId?: string): Promise<boolean> {
    await this.ready
    return (await this.q?.backgroundTasks(toolUseId).catch(() => false)) ?? false
  }

  async stopTask(taskId: string): Promise<void> {
    await this.ready
    await this.q?.stopTask(taskId).catch((e) => console.warn('[stopTask]', e))
  }

  async toggleMcp(serverName: string, enabled: boolean): Promise<void> {
    await this.ready
    await this.q?.toggleMcpServer(serverName, enabled).catch((e) => console.warn('[mcpToggle]', e))
  }

  /**
   * Reconnect one MCP server, and say what happened.
   *
   * The only control here that returns a result, because it is the only one
   * whose failure the user is left staring at: the row goes red, the button
   * looks inert, and the reason — almost always `Executable not found in
   * $PATH` — died in a `console.warn` inside a detached host process nobody
   * opens. Reported rather than thrown so `callOr`'s deliberate swallow in the
   * manager stays intact.
   */
  async reconnectMcp(serverName: string): Promise<McpActionResult> {
    await this.ready
    try {
      await this.q?.reconnectMcpServer(serverName)
      return { ok: true }
    } catch (err) {
      console.warn('[mcpReconnect]', err)
      return { ok: false, error: String((err as Error)?.message ?? err) }
    }
  }

  /**
   * Tighten-only by construction: the SDK's override can restrict a server's
   * permission handling but never widen it, so this is safe to expose directly.
   */
  async setMcpPermissionOverride(
    serverName: string,
    mode: 'default' | 'auto' | null,
  ): Promise<string | undefined> {
    await this.ready
    const r = await this.q
      ?.setMcpPermissionModeOverride(serverName, mode)
      .catch((e) => ({ warning: String(e) }))
    return r?.warning
  }

  /** Withdraw a message that hasn't reached the SDK yet. */
  cancelQueued(itemId: string): boolean {
    const dropped = this.queue.cancel(itemId)
    if (dropped) send(IPC.evtQueue, { sessionId: this.meta.id, itemId, state: 'dropped' })
    return dropped
  }

  async commands(): Promise<SlashCommandInfo[]> {
    await this.ready
    const list = await this.q?.supportedCommands().catch(() => [])
    return (list ?? []).map((c) => ({
      name: c.name,
      description: c.description,
      argumentHint: c.argumentHint,
    }))
  }

  async interrupt(): Promise<void> {
    this.interrupting = true
    await this.ready
    await this.q?.interrupt().catch(() => {})
    this.setStatus('idle')
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    await this.ready
    // Never let a control call take the session down with it.
    await this.q?.setPermissionMode(mode).catch((e) => console.warn('[setMode]', e))
    this.patchMeta({ permissionMode: mode })
  }

  async setModel(model: string): Promise<void> {
    await this.ready
    await this.q?.setModel(model).catch((e) => console.warn('[setModel]', e))
    this.patchMeta({ model })
  }

  async models(): Promise<ModelInfo[]> {
    await this.ready
    const list = await this.q?.supportedModels().catch(() => [])
    // The SDK's field is `value` (not `model`/`id`); `resolvedModel` is the
    // canonical wire id an alias expands to.
    return (list ?? []).map((m) => ({
      id: m.value,
      displayName: m.displayName,
      resolvedModel: m.resolvedModel,
    }))
  }

  // ------------------------------------------------------- read-only panels
  //
  // All of these are best-effort: a control call that fails must never take the
  // session down, so every one degrades to null/[] and the panel says so.

  async contextUsage(): Promise<ContextUsage | null> {
    await this.ready
    const u = await this.q?.getContextUsage().catch(() => null)
    if (!u) return null
    return {
      categories: u.categories.map((c) => ({
        name: c.name,
        tokens: c.tokens,
        isDeferred: c.isDeferred,
      })),
      totalTokens: u.totalTokens,
      maxTokens: u.maxTokens,
      percentage: u.percentage,
      model: u.model,
      memoryFiles: u.memoryFiles.map((f) => ({ path: f.path, tokens: f.tokens })),
      mcpTools: u.mcpTools.map((t) => ({
        name: t.name,
        serverName: t.serverName,
        tokens: t.tokens,
      })),
    }
  }

  async account(): Promise<AccountInfo | null> {
    await this.ready
    const a = await this.q?.accountInfo().catch(() => null)
    return a
      ? {
          email: a.email,
          organization: a.organization,
          subscriptionType: a.subscriptionType,
          apiProvider: a.apiProvider,
        }
      : null
  }

  /**
   * The method name is a promise that it will change, so this is wrapped
   * tighter than the rest: any throw, and any shape that isn't what we expect,
   * degrades to null rather than breaking the panel.
   */
  async usage(): Promise<UsageInfo | null> {
    await this.ready
    try {
      const u = await this.q?.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()
      if (!u) return null

      const rl = u.rate_limits
      const windows: RateWindow[] = []
      const push = (label: string, w?: { utilization: number | null; resets_at: string | null } | null): void => {
        if (w) windows.push({ label, utilization: w.utilization, resetsAt: w.resets_at })
      }
      push('5-hour', rl?.five_hour)
      push('7-day', rl?.seven_day)
      push('7-day Opus', rl?.seven_day_opus)
      push('7-day Sonnet', rl?.seven_day_sonnet)
      for (const m of rl?.model_scoped ?? []) {
        windows.push({ label: m.display_name, utilization: m.utilization, resetsAt: m.resets_at })
      }

      return {
        costUsd: u.session?.total_cost_usd ?? 0,
        linesAdded: u.session?.total_lines_added ?? 0,
        linesRemoved: u.session?.total_lines_removed ?? 0,
        subscriptionType: u.subscription_type ?? null,
        rateLimitsAvailable: Boolean(u.rate_limits_available),
        windows,
      }
    } catch {
      return null
    }
  }

  async agents(): Promise<AgentInfo[]> {
    await this.ready
    const list = await this.q?.supportedAgents().catch(() => [])
    return (list ?? []).map((a) => ({ name: a.name, description: a.description, model: a.model }))
  }

  async mcpStatus(): Promise<McpServerInfo[]> {
    await this.ready
    const list = await this.q?.mcpServerStatus().catch(() => [])
    return (list ?? []).map((s) => ({
      name: s.name,
      status: s.status,
      error: s.error,
      toolCount: s.tools?.length ?? 0,
      scope: s.scope,
    }))
  }

  /** There is no read-only skills listing in the SDK — reloading is how you get one. */
  async reloadSkills(): Promise<SkillInfo[]> {
    await this.ready
    const res = await this.q?.reloadSkills().catch(() => null)
    return (res?.skills ?? []).map((s) => ({ name: s.name, description: s.description }))
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    cancelPending(this.meta.id)
    cancelPendingElicitations(this.meta.id)
    // Nothing to clear for diffs — they're read from git on demand, and the
    // session leaves the renderer's store entirely via evtRemoved.
    this.queue.end()
    try {
      this.q?.close()
    } catch {
      /* already gone */
    }
    this.abort.abort()
  }
}
