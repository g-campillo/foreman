/**
 * Session-level policy: the runaway guardrails, plus the two rules derived from
 * them that are branchy enough to get wrong silently.
 *
 * Deliberately free of Electron and SDK imports so `npm run check:policy` can
 * load it under plain node — same arrangement as porcelain.mts.
 */
import type { SessionStatus } from '../../shared/types'

/**
 * Reads a cap from the environment.
 *
 * `0` or `off` means genuinely uncapped — the option is then omitted from the
 * query rather than passed as a number, so the SDK never enforces one. Anything
 * unparseable keeps the default: a typo must not silently remove a guard, which
 * is the failure mode of the obvious `Number(x) || fallback`.
 */
export function cap(name: string, fallback: number): number | undefined {
  const raw = process.env[name]?.trim().toLowerCase()
  if (!raw) return fallback
  if (raw === '0' || raw === 'off') return undefined
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/**
 * Runaway guardrails. Deliberately far above real use: they exist to stop a loop
 * that has gone wrong, not to budget a day's work, so tripping one is a bug
 * report rather than a routine event.
 *
 * These are *per session*, and on a subscription the dollar figure is notional —
 * the plan's own rate limits are the real backstop, which is why the budget cap
 * sits high enough that long 1M-context sessions never graze it.
 *
 * ponytail: global, not per-project. Move onto SessionInit when settings land.
 */
export const MAX_BUDGET_USD = cap('FOREMAN_MAX_BUDGET_USD', 1000)
export const MAX_TURNS = cap('FOREMAN_MAX_TURNS', 20_000)

/**
 * Tried when the primary model is overloaded. The primary is re-tried at the
 * start of each user turn, so an outage can't permanently demote the session.
 * Comma-separated for a longer chain.
 */
export const FALLBACK_MODEL = process.env.FOREMAN_FALLBACK_MODEL ?? 'sonnet'

const STOP_REASON: Record<string, string> = {
  error_max_budget_usd: `Stopped: session cost cap${MAX_BUDGET_USD ? ` of $${MAX_BUDGET_USD}` : ''} reached.`,
  error_max_turns: `Stopped: turn cap${MAX_TURNS ? ` of ${MAX_TURNS}` : ''} reached.`,
}

/**
 * Text for a `result` ChatItem.
 *
 * The STOP_REASON leg is the whole point: hitting a cap yields an
 * SDKResultError, which has no `result` field at all, so without it a capped-out
 * session stops against a blank error card and looks like a crash.
 */
export function resultText(r: {
  interrupted: boolean
  result?: unknown
  subtype: string
}): string {
  if (r.interrupted) return 'stopped'
  if (typeof r.result === 'string') return r.result
  return STOP_REASON[r.subtype] ?? ''
}

/**
 * Body for a desktop notification on a status change, or null when the
 * transition isn't worth interrupting someone for.
 */
export function notifyBody(
  was: SessionStatus,
  now: SessionStatus,
  pendingApprovals: number,
): string | null {
  if (was === now) return null
  if (now === 'awaiting-approval') return `Waiting on you — ${pendingApprovals} approval(s)`
  // Only leaving a *run* counts as finishing. Start-up settles straight from
  // 'starting' to 'idle', and that must not raise a "turn complete".
  if (was === 'running' && now === 'idle') return 'Turn complete'
  if (was === 'running' && now === 'error') return 'Turn failed'
  return null
}
