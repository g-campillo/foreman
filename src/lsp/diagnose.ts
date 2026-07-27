import type { HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk'
import * as reg from './registry.mts'
import { serverFor } from '../shared/languages.mts'
import { diagnostics as fmtDiagnostics, provenance, type Diag } from './format.mts'

/**
 * The agent sees the type errors it just introduced, before it decides what to
 * do next.
 *
 * Fires on PostToolBatch, NOT PostToolUse, and the SDK's own docstring is why:
 * "Fired once after every tool call in a batch has resolved, before the next
 * model request. PostToolUse fires per-tool and may run concurrently for
 * parallel tool calls." All three clauses matter — five parallel Edits should
 * diagnose once rather than five times racing each other, the result has to
 * land before the model chooses its next action to be worth anything, and
 * concurrent invocations would race the document mirror.
 *
 * makeDiffHook stays on PostToolUse, untouched. It is a one-git-call badge
 * refresh; this is a different job on a different cadence.
 *
 * No CLI agent has this, because a CLI has no persistent language server to ask.
 */

/**
 * Files we have already reported errors in, so they get re-checked next time
 * even if this batch did not touch them.
 *
 * tsgo advertises interFileDependencies: an edit here breaks a file over there,
 * and reporting only the edited file hides half the damage. This is also what
 * lets the "clean" message fire — without it, a fix in A that repairs B would
 * never re-check B and the agent would never learn it had recovered.
 */
const reported = new Set<string>()

/** The last set we injected, to detect "nothing changed, stop retrying". */
let lastSet = ''
let repeats = 0
let lastCount = 0

/** Injections used this turn. Reset whenever the error set actually changes. */
let budget = 0
const MAX_PER_TURN = 3

const key = (path: string, d: Diag): string =>
  `${path}:${d.range.start.line}:${d.code ?? ''}:${d.message.slice(0, 60)}`

function pathsFrom(calls: Array<{ tool_name?: string; tool_input?: unknown }>): {
  paths: string[]
  sawBash: boolean
} {
  const paths = new Set<string>()
  let sawBash = false
  for (const c of calls) {
    if (c.tool_name === 'Bash' || c.tool_name === 'BashOutput') {
      // Bash can touch anything, so its inputs tell us nothing useful. The
      // caller falls back to a git delta rather than guessing.
      sawBash = true
      continue
    }
    const input = c.tool_input as { file_path?: string; path?: string; edits?: unknown } | undefined
    const p = input?.file_path ?? input?.path
    if (typeof p === 'string' && serverFor(p)) paths.add(p)
  }
  return { paths: [...paths], sawBash }
}

export function resetTurn(): void {
  budget = 0
}

export function makeDiagnosticsHook(cwd: string): HookCallbackMatcher[] {
  reg.setRoot(cwd)

  return [
    {
      hooks: [
        async (input): Promise<Record<string, unknown>> => {
          const calls = (input as { tool_calls?: Array<{ tool_name?: string; tool_input?: unknown }> })
            .tool_calls
          if (!calls?.length) return { continue: true }

          const { paths, sawBash } = pathsFrom(calls)
          // Scoped to what this batch touched, plus anything already carrying
          // errors. Deliberately NOT every open document: the agent should hear
          // about the damage it just did, not be handed a project-wide error
          // list it did not cause and will feel obliged to go fix.
          //
          // A Bash call can touch anything, so its inputs tell us nothing — fall
          // back to re-checking whatever the fleet already has open.
          const watch = new Set([...paths, ...reported])
          if (sawBash) for (const p of reg.openDocPaths()) watch.add(p)
          if (!watch.size) return { continue: true }

          try {
            await reg.filesChanged([...watch])
          } catch {
            return { continue: true }
          }

          const t0 = Date.now()
          const rows: Array<{ path: string; diags: Diag[] }> = []
          const seen: string[] = []
          for (const p of watch) {
            // Errors only. Warnings are noise, and every one costs tokens in
            // the model's context for the rest of the turn.
            const diags = ((await reg.diagnose(p)) as Diag[]).filter((d) => (d.severity ?? 1) === 1)
            if (diags.length) {
              rows.push({ path: p, diags })
              for (const d of diags) seen.push(key(p, d))
              reported.add(p)
            } else {
              reported.delete(p)
            }
          }

          const setId = seen.sort().join('|')

          // Recovered. Say so explicitly — a model that is not told the errors
          // are gone goes looking for them again, which costs more than the
          // sentence does.
          if (!rows.length) {
            const had = lastCount
            lastSet = ''
            repeats = 0
            lastCount = 0
            budget = 0
            return had
              ? {
                  continue: true,
                  hookSpecificOutput: {
                    hookEventName: 'PostToolBatch',
                    additionalContext: `<lsp-diagnostics>\nClean — the ${had} error(s) from the previous edit are gone.\n</lsp-diagnostics>`,
                  },
                }
              : { continue: true }
          }

          // Layer 2: the identical set, again. Repeating it invites the same
          // failed fix; saying so once invites a different approach.
          if (setId === lastSet) {
            repeats += 1
            if (repeats > 1) return { continue: true }
            return {
              continue: true,
              hookSpecificOutput: {
                hookEventName: 'PostToolBatch',
                additionalContext: `<lsp-diagnostics>\nThe same ${seen.length} error(s) are still present after your last edit. Stop and reconsider the approach rather than retrying the same fix.\n</lsp-diagnostics>`,
              },
            }
          }

          // Layer 4: getting worse, twice running. This is the one that actually
          // stops a runaway.
          const escalating = lastCount > 0 && seen.length > lastCount
          lastSet = setId
          repeats = 0
          const prev = lastCount
          lastCount = seen.length

          // Layer 3: a per-turn ceiling. The push stops; the pull tool remains.
          if (budget >= MAX_PER_TURN) return { continue: true }
          budget += 1

          const id = serverFor(rows[0]!.path) ?? 'ts'
          const prov = provenance(id, reg.statusLine(id), Date.now() - t0)
          const body = fmtDiagnostics(cwd, rows, prov)
          const tail = escalating
            ? `\n\nError count went ${prev} → ${seen.length}. Your fixes are making it worse — revert your last change and describe the problem instead of trying again.`
            : '\n\nThese are from the language server, not a guess. Fix them before continuing.'

          return {
            continue: true,
            hookSpecificOutput: {
              hookEventName: 'PostToolBatch',
              additionalContext: `<lsp-diagnostics>\n${seen.length} error(s) after the last edit:\n\n${body}${tail}\n</lsp-diagnostics>`,
            },
          }
        },
      ],
    },
  ]
}
