import { randomUUID } from 'node:crypto'
import { basename, dirname, join, sep } from 'node:path'
import { query, type Query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import {
  IPC,
  type ChatItem,
  type ModelInfo,
  type PermissionMode,
  type SessionMeta,
  type SessionStatus,
} from '../../shared/types'
import { notify, send } from '../bridge'
import { createInputQueue, type InputQueue } from './queue'
import { makeCanUseTool, cancelPending } from './permissions'
import { makeSnapshotHook, makeBashDiffHook, beginSession, clearSnapshots } from './snapshots'
import {
  FALLBACK_MODEL,
  MAX_BUDGET_USD,
  MAX_TURNS,
  notifyBody,
  resultText,
} from './policy.mts'

/**
 * Absolute path to the Claude Code binary the SDK spawns.
 *
 * The SDK resolves this itself from its own location, which is correct in dev
 * but fatal once packaged: require.resolve reports a path inside app.asar, and
 * spawn() is not asar-aware, so it dies with ENOTDIR. Redirect to the unpacked
 * copy. Returns undefined if resolution fails, letting the SDK do its thing.
 */
function claudeExecutable(): string | undefined {
  try {
    const pkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`
    const dir = dirname(require.resolve(`${pkg}/package.json`))
    return join(dir, 'claude').replace(`app.asar${sep}`, `app.asar.unpacked${sep}`)
  } catch {
    return undefined
  }
}

export interface SessionInit {
  cwd: string
  title?: string
  resume?: string
  permissionMode?: PermissionMode
}

export class Session {
  readonly meta: SessionMeta
  private readonly queue: InputQueue = createInputQueue()
  private readonly abort = new AbortController()
  private q: Query | null = null
  private closed = false

  /** Item ids for the text/thinking blocks currently being streamed into. */
  private streamingText: string | null = null
  private streamingThinking: string | null = null
  /** tool_use_id -> ChatItem id, so tool_result can update the right card. */
  private readonly toolItems = new Map<string, string>()
  private pendingApprovals = 0
  /** Set while a user-initiated interrupt is in flight: the turn it aborts comes
   *  back with is_error, which is not a failure the user should see as one. */
  private interrupting = false
  /** Resolves once the CLI subprocess can accept control messages. */
  private readonly ready: Promise<void>

  constructor(init: SessionInit) {
    this.meta = {
      id: randomUUID(),
      title: init.title ?? basename(init.cwd) ?? 'session',
      cwd: init.cwd,
      status: 'starting',
      model: null,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      permissionMode: init.permissionMode ?? 'default',
      createdAt: Date.now(),
    }

    // Must be kicked off before the agent can touch anything, so that whatever
    // is already dirty in the worktree is recorded as the user's, not the agent's.
    beginSession(this.meta.id, init.cwd)

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
        ...(MAX_BUDGET_USD ? { maxBudgetUsd: MAX_BUDGET_USD } : {}),
        ...(MAX_TURNS ? { maxTurns: MAX_TURNS } : {}),
        // Backs up files before the agent modifies them, which is what makes
        // q.rewindFiles() possible later. Inert until something calls it.
        enableFileCheckpointing: true,
        // Emits a `prompt_suggestion` message after each result. Nothing renders
        // it yet; unhandled message types fall through handle()'s switch.
        promptSuggestions: true,
        canUseTool: makeCanUseTool(this.meta.id, (n) => {
          this.pendingApprovals = n
          this.setStatus(n > 0 ? 'awaiting-approval' : 'running')
        }),
        hooks: {
          PreToolUse: makeSnapshotHook(this.meta.id, init.cwd),
          PostToolUse: makeBashDiffHook(this.meta.id),
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
      case 'system':
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
        this.handleStreamEvent(msg.event)
        break

      case 'assistant':
        this.handleAssistant(msg)
        break

      case 'user':
        this.handleToolResults(msg)
        break

      case 'result': {
        const r = msg as Extract<SDKMessage, { type: 'result' }>
        this.streamingText = null
        this.streamingThinking = null
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
          costUsd: r.total_cost_usd ?? this.meta.costUsd,
          // usage, by contrast, IS per-turn, so these do accumulate.
          inputTokens: this.meta.inputTokens + (r.usage?.input_tokens ?? 0),
          outputTokens: this.meta.outputTokens + (r.usage?.output_tokens ?? 0),
        })
        this.setStatus(!interrupted && r.is_error ? 'error' : 'idle')
        break
      }
    }
  }

  /** Live text/thinking deltas. Rendering is upserted, then reconciled below. */
  private handleStreamEvent(event: unknown): void {
    const e = event as { type?: string; delta?: { type?: string; text?: string; thinking?: string } }

    if (e.type === 'content_block_start') {
      // A fresh block begins; the next deltas belong to a new item.
      const block = (event as { content_block?: { type?: string } }).content_block
      if (block?.type === 'text') this.streamingText = null
      if (block?.type === 'thinking') this.streamingThinking = null
      return
    }

    if (e.type !== 'content_block_delta' || !e.delta) return

    if (e.delta.type === 'text_delta' && e.delta.text) {
      if (!this.streamingText) {
        this.streamingText = randomUUID()
        this.emit({ id: this.streamingText, kind: 'assistant', text: e.delta.text })
      } else {
        send(IPC.evtDelta, {
          sessionId: this.meta.id,
          itemId: this.streamingText,
          text: e.delta.text,
        })
      }
      this.setStatus('running')
    } else if (e.delta.type === 'thinking_delta' && e.delta.thinking) {
      if (!this.streamingThinking) {
        this.streamingThinking = randomUUID()
        this.emit({ id: this.streamingThinking, kind: 'thinking', text: e.delta.thinking })
      } else {
        send(IPC.evtDelta, {
          sessionId: this.meta.id,
          itemId: this.streamingThinking,
          text: e.delta.thinking,
        })
      }
      this.setStatus('running')
    }
  }

  /**
   * The authoritative assistant turn. Text items are re-emitted with the final
   * text (upsert by id) so a dropped stream event can't leave the UI truncated;
   * tool_use blocks become cards here, since deltas don't carry them usefully.
   */
  private handleAssistant(msg: Extract<SDKMessage, { type: 'assistant' }>): void {
    // The system/init frame carries no model, so this is where we learn it.
    const model = msg.message?.model
    if (typeof model === 'string' && model !== this.meta.model) this.patchMeta({ model })

    for (const block of msg.message?.content ?? []) {
      if (block.type === 'text') {
        const id = this.streamingText ?? randomUUID()
        this.emit({ id, kind: 'assistant', text: block.text })
        this.streamingText = null
      } else if (block.type === 'tool_use') {
        const itemId = randomUUID()
        this.toolItems.set(block.id, itemId)
        this.emit({
          id: itemId,
          kind: 'tool',
          name: block.name,
          input: block.input,
          status: 'pending',
        })
      }
    }
    this.streamingThinking = null
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

  send(text: string): void {
    this.emit({ id: randomUUID(), kind: 'user', text })
    this.setStatus('running')
    this.queue.push(text)
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

  close(): void {
    if (this.closed) return
    this.closed = true
    cancelPending(this.meta.id)
    clearSnapshots(this.meta.id)
    this.queue.end()
    try {
      this.q?.close()
    } catch {
      /* already gone */
    }
    this.abort.abort()
  }
}
