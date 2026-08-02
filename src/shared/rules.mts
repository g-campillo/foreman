import type { RuleScope, RuleValue, SuggestedUpdate } from './types'

/**
 * Saying out loud what an "always allow" click would actually grant.
 *
 * Lives in shared/ beside diff.mts, and for the same reason: it is pure, it is
 * checkable under bare node, and it is the kind of code that drifts silently.
 * A wrong label here does not throw — it just tells the user they are granting
 * something narrower than they are.
 *
 * THE SAFETY PROPERTY, and the reason describeGrant has a catch-all arm: the
 * click sends `alwaysAllow: true` and the host replays the SDK's suggestions
 * VERBATIM. So anything this file cannot name is still granted — it is just
 * granted invisibly. Every arm of the union has to produce words, including one
 * this build has never heard of.
 *
 * `.mts` so `npm run check:rules` can load it under bare node; the only import
 * is type-only, which node's type-stripping erases.
 */

/**
 * The FILE a rule lands in, not the SDK's enum name.
 *
 * `localSettings` tells the user nothing; `.claude/settings.local.json` tells
 * them a click is about to write into their repo. That is the honest objection
 * to sending the CLI's suggestions back verbatim, and naming the file before
 * the click is the answer to it — not quietly downgrading the grant to
 * something the button's own label would contradict.
 *
 * Every label is phrased to follow the word "in", because describeGrant reads
 * `…, in ${scopeLabel(destination)}`. Two of these are not files and say so.
 *
 * `undefined` is reachable: `rules` comes off the wire (and out of a replayed
 * event log), so a destination this build does not know about must produce a
 * cautious phrase rather than the word "undefined".
 */
export function scopeLabel(scope: RuleScope | undefined): string {
  switch (scope) {
    case 'userSettings':
      return '~/.claude/settings.json'
    case 'projectSettings':
      return '.claude/settings.json'
    case 'localSettings':
      return '.claude/settings.local.json'
    case 'session':
      return 'this conversation only'
    case 'cliArg':
      return "this run's command-line flags"
    default:
      return 'a scope this build does not recognise'
  }
}

/** `Bash` + `npm run build:*` -> `Bash(npm run build:*)`. A rule with no content
 *  is the whole tool, and renders as the bare name — which is a much wider grant
 *  than the parenthesised form, so the two must never look alike. */
export function ruleLabel({ toolName, ruleContent }: RuleValue): string {
  const name = toolName || 'an unnamed tool'
  return ruleContent ? `${name}(${ruleContent})` : name
}

/** `a`, `a and b`, `a, b and c`. Oxford-free, matching the app's other prose. */
function list(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? 'nothing'
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/**
 * Every field any arm of the union carries, all optional.
 *
 * The union is read through this rather than narrowed arm by arm because these
 * objects come off the wire: an arm from a newer SDK has to reach the catch-all
 * below with its own type name intact, not throw on a field this build expects
 * and it never sent.
 */
interface LooseUpdate {
  type?: string
  destination?: RuleScope
  rules?: RuleValue[]
  behavior?: string
  mode?: string
  directories?: string[]
}

/** One update, as a clause. Ends without punctuation — describeGrant joins. */
function describeOne(update: SuggestedUpdate): string {
  // `?? {}` is not decoration: a null in the array is what a malformed frame
  // looks like, and a throw here would blank the whole approval card.
  const u = (update ?? {}) as LooseUpdate

  const where = `, in ${scopeLabel(u.destination)}`
  const rules = (): string => list((u.rules ?? []).map(ruleLabel))
  const dirs = (): string => list(u.directories ?? [])
  // The SDK's behaviours are already the words we want — 'allow', 'deny', 'ask'.
  const behavior = u.behavior ?? 'allow'

  switch (u.type) {
    case 'addRules':
      return `Always ${behavior} ${rules()}${where}`
    case 'replaceRules':
      return `Replace the ${behavior} rules with ${rules()}${where}`
    case 'removeRules':
      return `Remove ${rules()} from the ${behavior} rules${where}`
    case 'setMode':
      return `Switch the permission mode to ${u.mode ?? 'an unnamed mode'}${where}`
    case 'addDirectories':
      return `Give the agent access to ${dirs()}${where}`
    case 'removeDirectories':
      return `Take away the agent's access to ${dirs()}${where}`
    default:
      // THE WHOLE POINT OF THIS ARM. A permission update type added by a future
      // SDK is still granted by the click, so it still has to appear on screen —
      // naming itself is the least this can do, and silence is the one thing it
      // must never do.
      return `Apply an unrecognised permission change (${u.type || 'no type'})${where}`
  }
}

/**
 * One sentence describing everything a click would grant, or '' for nothing.
 *
 * The empty string is what makes the card's hide-the-button branch a one-liner:
 * no suggestions means no grant to describe and no button to press.
 *
 * NOT a tooltip at the call site, deliberately. These rules differ enormously in
 * reach — `Read` is every file on the machine, `Bash(npm run build:*)` is one
 * command — and a permission you cannot read is not consent.
 */
export function describeGrant(updates: readonly SuggestedUpdate[]): string {
  const parts = updates.map(describeOne).filter(Boolean)
  return parts.length ? `${parts.join('; ')}.` : ''
}
