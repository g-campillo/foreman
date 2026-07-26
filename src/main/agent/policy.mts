/**
 * Session-level policy: the runaway guardrails, plus the two rules derived from
 * them that are branchy enough to get wrong silently.
 *
 * Deliberately free of Electron and SDK imports so `npm run check:policy` can
 * load it under plain node — same arrangement as porcelain.mts.
 */
import { isAbsolute, relative, sep } from 'node:path'
import type {
  ImageMediaType,
  SendBlock,
  SendContent,
  SessionStatus,
} from '../../shared/types'

/**
 * Runtime copy of ImageMediaType.
 *
 * It has to be duplicated rather than imported: this module is loaded by bare
 * node for `npm run check:policy`, and a *value* import from a .ts file under
 * the root package's "type": "commonjs" does not resolve. The assertion below
 * turns any drift between the two into a compile error, in both directions.
 */
const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const
type SameSet<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never
const _mediaTypesMatchShared: SameSet<(typeof IMAGE_MEDIA_TYPES)[number], ImageMediaType> = true
void _mediaTypesMatchShared

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
 * Validates composer content on its way to the SDK.
 *
 * A trust boundary: this arrives over IPC as `unknown`, and the API accepts only
 * four image media types — a pasted HEIC or SVG would otherwise be rejected
 * upstream with an error that points nowhere near the paste that caused it.
 * Bad blocks are dropped rather than sent.
 *
 * Returns null when nothing survives, so the caller can skip the send entirely
 * instead of queueing an empty turn.
 */
export function normaliseSend(raw: unknown): SendContent | null {
  if (typeof raw === 'string') return raw.trim() ? raw : null
  if (!Array.isArray(raw)) return null

  const blocks: SendBlock[] = []
  for (const entry of raw) {
    const b = entry as Record<string, unknown> | null
    if (!b) continue

    if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
      blocks.push({ type: 'text', text: b.text })
      continue
    }
    if (b.type === 'image') {
      const src = b.source as Record<string, unknown> | null
      if (
        src &&
        src.type === 'base64' &&
        typeof src.data === 'string' &&
        src.data.length > 0 &&
        IMAGE_MEDIA_TYPES.includes(src.media_type as never)
      ) {
        blocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: src.media_type as ImageMediaType,
            data: src.data,
          },
        })
      }
    }
  }
  return blocks.length ? blocks : null
}

/**
 * Turn whatever the user typed into something usable as BOTH a git ref and a
 * directory name.
 *
 * A trust boundary: this string is handed to `git worktree add -b` and becomes a
 * path under userData. Git's own ref rules reject a long tail of things (spaces,
 * `..`, `~^:?*[`, a leading or trailing dot, a trailing `.lock`, an empty
 * component), and a path needs stricter treatment still — `/` would nest, `..`
 * would escape. Allow-listing four characters is far shorter than encoding
 * git-check-ref-format, and being stricter than git is harmless here.
 *
 * Never returns '' — an empty branch name would make `foreman/` a ref, which git
 * rejects, and the error would point at git rather than at the empty input.
 */
export function branchSlug(raw: string): string {
  const s = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    // Leading/trailing dots and dashes are the ref-format landmines: '.foo' and
    // 'foo.' are both invalid, and '-foo' reads as a flag in argv.
    .replace(/^[-.]+|[-.]+$/g, '')
    // Collapsed last, because trimming the ends can expose a new '..' pair.
    .replace(/\.{2,}/g, '.')
    .slice(0, 60)
    .replace(/[-.]+$/, '')
  return s || 'agent'
}

/**
 * True when `path` is `dir` or sits underneath it.
 *
 * Via `relative` rather than a prefix test, because `'/repo-other'.startsWith('/repo')`
 * is true and would quietly pull a sibling checkout into this session's diff.
 *
 * This is what keeps the diff panel to files the session could actually commit.
 * Getting it wrong in the generous direction is loud — plan files reappear in
 * the panel as a row of `../../../`. Getting it wrong in the strict direction is
 * silent, and the user simply never sees an edit the agent made.
 */
export function within(dir: string, path: string): boolean {
  const rel = relative(dir, path)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
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
