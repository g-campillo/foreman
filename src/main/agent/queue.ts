import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

type Content = SDKUserMessage['message']['content']

export interface InputQueue extends AsyncIterable<SDKUserMessage> {
  /** `id` is the ChatItem id, so the renderer can cancel the thing it drew. */
  push(content: Content, id: string): void
  /** True if the message was still queued and has now been dropped. */
  cancel(id: string): boolean
  /**
   * Rewrite a queued message's content IN PLACE, keeping its position.
   *
   * In place rather than cancel-and-re-push, and that is the whole reason this
   * exists: two messages queued behind a long turn are a sequence the user
   * chose, and editing the first must not send it after the second. False when
   * the message has already been handed to the SDK, which is the race the tray's
   * editor has to close on.
   */
  replace(id: string, content: Content): boolean
  /** What is queued under `id` right now, or null once it has left. The edit
   *  path reads it to carry the message's images across a text-only rewrite. */
  peek(id: string): Content | null
  /** While closed, messages accumulate instead of being handed to the SDK. */
  setGate(open: boolean): void
  end(): void
}

/**
 * Push-driven AsyncIterable for the SDK's streaming input mode.
 *
 * Streaming mode is not optional: interrupt(), setPermissionMode(), and
 * setModel() only exist when `prompt` is an AsyncIterable. The generator
 * deliberately never returns — that is what keeps the session alive between
 * turns instead of tearing down the CLI subprocess after each one.
 *
 * Cancellation lives here rather than going through the SDK, because the SDK
 * offers no way to withdraw a queued message: `interrupt()` reports
 * `still_queued` uuids but `Query` has no matching cancel method.
 *
 * The gate is what makes that possible. The SDK sits in `for await` on this
 * generator permanently, so without it a pushed message is pulled within
 * microseconds — measured: a message sent mid-turn was handed over and its
 * "queued" marker cleared before it could ever render. Holding the message here
 * while a turn is in flight is what gives it a visible, cancellable life.
 */
export function createInputQueue(onDequeue?: (id: string) => void): InputQueue {
  const pending: { id: string; msg: SDKUserMessage }[] = []
  let wake: (() => void) | null = null
  let closed = false
  // Open by default: a session that never reaches 'idle' (failed init) must
  // still pass messages through rather than stalling them here forever.
  let gateOpen = true

  return {
    push(content: Content, id: string) {
      if (closed) return
      pending.push({
        id,
        // Stamping our ChatItem id as the SDK's message uuid is what makes a
        // rendered message addressable later: rewindFiles(userMessageId) and
        // forkSession({upToMessageId}) both take this uuid. It also puts the
        // message on interrupt()'s `still_queued` receipt, which only lists
        // uuid-stamped messages.
        msg: {
          type: 'user',
          message: { role: 'user', content },
          parent_tool_use_id: null,
          uuid: id as `${string}-${string}-${string}-${string}-${string}`,
        },
      })
      wake?.()
      wake = null
    },
    cancel(id: string) {
      const i = pending.findIndex((p) => p.id === id)
      if (i === -1) return false
      pending.splice(i, 1)
      return true
    },
    replace(id: string, content: Content) {
      const entry = pending.find((p) => p.id === id)
      if (!entry) return false
      // The message object, not the entry: `uuid` is the id the renderer already
      // drew and what interrupt()'s still_queued receipt lists, so it has to
      // survive the edit untouched.
      entry.msg = { ...entry.msg, message: { ...entry.msg.message, content } }
      return true
    },
    peek(id: string) {
      return pending.find((p) => p.id === id)?.msg.message.content ?? null
    },
    setGate(open: boolean) {
      gateOpen = open
      if (open) {
        wake?.()
        wake = null
      }
    },
    end() {
      closed = true
      wake?.()
      wake = null
    },
    async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
      for (;;) {
        while (gateOpen && pending.length) {
          const next = pending.shift()!
          // Announced only once it is genuinely out of the queue, so the
          // renderer never offers a cancel that would silently do nothing.
          // The callback closes the gate again, which is what limits this to
          // one message per turn.
          onDequeue?.(next.id)
          yield next.msg
        }
        if (closed) return
        await new Promise<void>((resolve) => {
          wake = resolve
        })
      }
    },
  }
}
