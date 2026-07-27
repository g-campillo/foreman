import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * What a conversation has cost so far, kept beside the transcript.
 *
 * The CLI's own transcript cannot answer this. Every stored assistant message
 * carries `message.usage` (input/output/cache tokens), so tokens are
 * recoverable — but **cost is not stored anywhere**: `getSessionMessages`
 * returns only user/assistant/system lines, and no line type carries
 * `total_cost_usd`. Measured across the local store, not assumed.
 *
 * So a resumed session used to come back reading `$0.00 · 0 tok` for a
 * conversation that had cost real money. This is the sidecar that fixes it: one
 * small JSON per SDK session id, written as each turn settles.
 *
 * ponytail: a file per session, no index and no compaction. These are ~80 bytes
 * each; revisit only if the directory ever needs listing rather than lookup.
 */
export interface StoredUsage {
  costUsd: number
  inputTokens: number
  outputTokens: number
}

const EMPTY: StoredUsage = { costUsd: 0, inputTokens: 0, outputTokens: 0 }

/**
 * Deliberately NOT `app.getPath('userData')`.
 *
 * This module is reachable from `Session`, which runs inside a detached host —
 * a plain Node process where `require('electron')` returns a *path string*, so
 * `app` is undefined and `app.getPath` throws. Main publishes the directory as
 * an env var at startup and the host inherits it through spawn.
 */
function dir(): string {
  const base = process.env.FOREMAN_USER_DATA
  if (!base) throw new Error('FOREMAN_USER_DATA is unset — main must publish it before use')
  return join(base, 'usage')
}

/** A session id reaching the filesystem — reject anything that isn't a plain id. */
function safe(sdkSessionId: string): string | null {
  return /^[A-Za-z0-9_-]+$/.test(sdkSessionId) ? sdkSessionId : null
}

export function readUsage(sdkSessionId: string): StoredUsage {
  const id = safe(sdkSessionId)
  if (!id) return EMPTY
  try {
    const raw = JSON.parse(readFileSync(join(dir(), `${id}.json`), 'utf8')) as Partial<StoredUsage>
    // Field-by-field, because this is a file on disk that an older build wrote.
    return {
      costUsd: Number(raw.costUsd) || 0,
      inputTokens: Number(raw.inputTokens) || 0,
      outputTokens: Number(raw.outputTokens) || 0,
    }
  } catch {
    // Missing is the normal case — every session that has never had a turn.
    return EMPTY
  }
}

export function writeUsage(sdkSessionId: string, usage: StoredUsage): void {
  const id = safe(sdkSessionId)
  if (!id) return
  try {
    mkdirSync(dir(), { recursive: true })
    writeFileSync(join(dir(), `${id}.json`), JSON.stringify(usage))
  } catch (err) {
    // Losing a cost readout must never take a turn down with it.
    console.warn('[usage] write failed:', err)
  }
}
