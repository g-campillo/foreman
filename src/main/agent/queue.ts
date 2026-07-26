import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

type Content = SDKUserMessage['message']['content']

export interface InputQueue extends AsyncIterable<SDKUserMessage> {
  push(content: Content): void
  end(): void
}

/**
 * Push-driven AsyncIterable for the SDK's streaming input mode.
 *
 * Streaming mode is not optional: interrupt(), setPermissionMode(), and
 * setModel() only exist when `prompt` is an AsyncIterable. The generator
 * deliberately never returns — that is what keeps the session alive between
 * turns instead of tearing down the CLI subprocess after each one.
 */
export function createInputQueue(): InputQueue {
  const pending: SDKUserMessage[] = []
  let wake: (() => void) | null = null
  let closed = false

  return {
    push(content: Content) {
      if (closed) return
      pending.push({
        type: 'user',
        message: { role: 'user', content },
        parent_tool_use_id: null,
      })
      wake?.()
      wake = null
    },
    end() {
      closed = true
      wake?.()
      wake = null
    },
    async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
      for (;;) {
        while (pending.length) yield pending.shift()!
        if (closed) return
        await new Promise<void>((resolve) => {
          wake = resolve
        })
      }
    },
  }
}
