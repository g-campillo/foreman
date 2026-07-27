import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { query, renameSession, type Query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import {
  IPC,
  type AccountInfo,
  type AgentInfo,
  type ChatItem,
  type ContextUsage,
  type EffortLevel,
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
import { lspMcpServer, READ_ONLY_TOOLS } from '../../lsp/tools'
import { makeDiagnosticsHook } from '../../lsp/diagnose'
import { claudeExecutable } from './executable'
import { proposeTitle } from './title'
import { readUsage, writeUsage } from './usage'
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
 */
function inputTokensOf(u: {
  input_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
} | null | undefined): number {
  if (!u) return 0
  return (
    (u.input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0)
  )
}

export class Session {
  readonly meta: SessionMeta
  // A message leaving the queue is the moment it stops being cancellable, and
  // the moment the session is genuinely working on it.
  private readonly queue: InputQueue = createInputQueue((itemId) => {
    send(IPC.evtQueue, { sessionId: this.meta.id, itemId, state: 'started' })
    // Here rather than in setStatus: 'awaiting-approval' -> 'running' re-enters
    // that method, so a permission prompt mid-turn would zero the clock. A
    // message leaving the queue happens exactly once per turn.
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
    // What this conversation had already spent before this run. Zero for a
    // fresh session; for a resumed one it comes back off the sidecar, because
    // the CLI's own `total_cost_usd` restarts from zero on resume.
    const prior = init.resume ? readUsage(init.resume) : { costUsd: 0, inputTokens: 0, outputTokens: 0 }
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
      permissionMode: init.permissionMode ?? 'default',
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
        hooks: {
          PostToolUse: makeDiffHook(this.meta.id, init.cwd),
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
        // REPLACE semantics — the SDK sends the complete live set each time,
        // and it carries no progress fields. So merge rather than assign: a
        // straight map would blank every chip's live status the moment any
        // other task started or finished.
        if (msg.subtype === 'background_tasks_changed') {
          const known = new Map(this.meta.backgroundTasks.map((t) => [t.taskId, t]))
          this.patchMeta({
            backgroundTasks: msg.tasks.map((t) => {
              const prev = known.get(t.task_id)
              return {
                taskId: t.task_id,
                taskType: t.task_type,
                description: t.description,
                ...(prev?.progress ? { progress: prev.progress } : {}),
                ...(prev?.lastTool ? { lastTool: prev.lastTool } : {}),
                ...(prev?.tokens ? { tokens: prev.tokens } : {}),
              }
            }),
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
          // its progress can be seen. No-ops when the task isn't backgrounded.
          const at = this.meta.backgroundTasks.findIndex((t) => t.taskId === msg.task_id)
          if (at !== -1) {
            const next = [...this.meta.backgroundTasks]
            next[at] = {
              ...next[at],
              ...(msg.summary ? { progress: msg.summary } : {}),
              ...(msg.last_tool_name ? { lastTool: msg.last_tool_name } : {}),
              ...(msg.usage?.total_tokens ? { tokens: msg.usage.total_tokens } : {}),
            }
            this.patchMeta({ backgroundTasks: next })
          }
          break
        }
        // A finished background task or subagent reports here; the changed-set
        // message handles removal, so this only surfaces the outcome.
        if (msg.subtype === 'task_notification') {
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
        // Cost is in no transcript the CLI writes, so it only survives a resume
        // if we record it ourselves. Cheap: one ~80-byte file per turn.
        if (this.meta.sdkSessionId) {
          writeUsage(this.meta.sdkSessionId, {
            // The project, not the scratch worktree — attribution should survive
            // the worktree being removed. Already canonical: createSession
            // realpaths the cwd.
            cwd: this.meta.worktree?.repoRoot ?? this.meta.cwd,
            costUsd: this.meta.costUsd,
            inputTokens: this.meta.inputTokens,
            outputTokens: this.meta.outputTokens,
          })
        }
        this.setStatus(!interrupted && r.is_error ? 'error' : 'idle')
        // The transcript file exists by now, so an auto-title can reach disk.
        this.persistTitle()
        break
      }
    }
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
    // total jump as subagents interleave. Their tokens still land in the
    // authoritative `result` totals.
    const out = msg.message?.usage?.output_tokens
    if (!msg.parent_tool_use_id && typeof out === 'number') {
      this.patchMeta({ turnTokens: this.meta.turnTokens + out })
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

  async reconnectMcp(serverName: string): Promise<void> {
    await this.ready
    await this.q?.reconnectMcpServer(serverName).catch((e) => console.warn('[mcpReconnect]', e))
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
