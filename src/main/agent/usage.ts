import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PERMISSION_MODES, type PermissionMode } from '../../shared/types'

/**
 * What Foreman knows about a conversation that the CLI's own transcript cannot
 * answer, kept beside it.
 *
 * Cost was the first such thing and is still the reason this exists. Every
 * stored assistant message carries `message.usage` (input/output/cache tokens),
 * so tokens are recoverable — but **cost is not stored anywhere**:
 * `getSessionMessages` returns only user/assistant/system lines, and no line
 * type carries `total_cost_usd`. Measured across the local store, not assumed.
 * So a resumed session used to come back reading `$0.00 · 0 tok` for a
 * conversation that had cost real money.
 *
 * The permission mode is the second, and it is the same problem for the same
 * reason: the transcript is CLI-owned, has no write API and no field for it, so
 * a reopened conversation was force-reset to whatever the renderer's default
 * pref happened to be — discarding whatever the user had put it in. Everywhere
 * else that record could have lived is worse: `HostMeta` is `rmSync`'d by
 * `shutdown()` and `reapDeadHost()`, which is the exact event it has to survive,
 * and localStorage puts a durable record in the process that is not the source
 * of truth, needs new IPC on the resume path, and races host construction.
 *
 * Renamed from StoredUsage now that it holds more than usage. The FILE and the
 * DIRECTORY keep their names deliberately — renaming either orphans every
 * sidecar already on disk.
 *
 * A file per session, no index and no compaction. `listUsage` below is the
 * directory listing this once said to revisit if it were ever needed — Home's
 * usage panel is that case. Still no index: these are ~80 bytes each, so a
 * readdir plus overlapped reads is tens of milliseconds even at a few thousand.
 */
export interface SessionSidecar {
  costUsd: number
  inputTokens: number
  outputTokens: number
  /**
   * The project this conversation ran in.
   *
   * Written so Home can attribute spend per project without joining against
   * `listSessions()`, which is hard-capped at 40 rows and would leave almost
   * everything unattributed. Absent on sidecars an older build wrote; those
   * backfill the next time that conversation takes a turn.
   */
  cwd?: string
  /**
   * The mode this conversation was last in.
   *
   * Absent on sidecars an older build wrote, and on any conversation whose mode
   * was never changed from the one it started on — both of which fall back to
   * the renderer's configured default, which is the right division: the renderer
   * knows what you configured, this knows what this conversation was.
   *
   * Note this is the one field that can bring a sidecar into existence with no
   * spend against it: changing the mode before the first turn writes the file.
   * Harmless, but it is why `listUsage`'s callers can see a $0 row.
   */
  permissionMode?: PermissionMode
}

/** The old name. Kept so nothing has to be renamed in one go. */
export type StoredUsage = SessionSidecar

/** One sidecar, as `listUsage` returns it. */
export interface UsageRow extends SessionSidecar {
  sdkSessionId: string
}

const EMPTY: SessionSidecar = { costUsd: 0, inputTokens: 0, outputTokens: 0 }

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

export function readUsage(sdkSessionId: string): SessionSidecar {
  const id = safe(sdkSessionId)
  if (!id) return EMPTY
  try {
    const raw = JSON.parse(readFileSync(join(dir(), `${id}.json`), 'utf8')) as Partial<SessionSidecar>
    // Field-by-field, because this is a file on disk that an older build wrote.
    return {
      costUsd: Number(raw.costUsd) || 0,
      inputTokens: Number(raw.inputTokens) || 0,
      outputTokens: Number(raw.outputTokens) || 0,
      ...(typeof raw.cwd === 'string' ? { cwd: raw.cwd } : {}),
      // Membership, NOT `typeof === 'string'`. This is user-editable storage,
      // and this value is passed straight to `query({ permissionMode })` in the
      // Session constructor — a bad one kills the session at startup, before
      // there is any UI to say so.
      ...(PERMISSION_MODES.includes(raw.permissionMode as PermissionMode)
        ? { permissionMode: raw.permissionMode }
        : {}),
    }
  } catch {
    // Missing is the normal case — every session that has never had a turn.
    return EMPTY
  }
}

/**
 * Every sidecar on disk, for Home's usage panel.
 *
 * One unreadable file must not sink the list — a half-written JSON from a crash
 * mid-write should cost that one conversation's figures, not the whole readout.
 */
export async function listUsage(): Promise<UsageRow[]> {
  let names: string[]
  try {
    names = await readdir(dir())
  } catch {
    // No directory until the first turn settles anywhere. Normal on a fresh install.
    return []
  }
  const rows = await Promise.all(
    names.map(async (name): Promise<UsageRow | null> => {
      if (!name.endsWith('.json')) return null
      const id = safe(name.slice(0, -'.json'.length))
      if (!id) return null
      try {
        const raw = JSON.parse(await readFile(join(dir(), name), 'utf8')) as Partial<SessionSidecar>
        // `permissionMode` is deliberately not read here: this list answers
        // "what has everything cost", and a mode has nothing to say to that.
        return {
          sdkSessionId: id,
          costUsd: Number(raw.costUsd) || 0,
          inputTokens: Number(raw.inputTokens) || 0,
          outputTokens: Number(raw.outputTokens) || 0,
          ...(typeof raw.cwd === 'string' ? { cwd: raw.cwd } : {}),
        }
      } catch {
        return null
      }
    }),
  )
  return rows.filter((r): r is UsageRow => r !== null)
}

export function writeUsage(sdkSessionId: string, usage: SessionSidecar): void {
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
