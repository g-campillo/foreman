/**
 * Self-check for the rule-description helpers: `npm run check:rules`.
 *
 * This is the copy under an "Always allow" button, and the button sends the
 * SDK's suggestions back VERBATIM — so a rule this file fails to name is a
 * permission granted with nothing on screen about it. That is why the last
 * block matters most: an update type this build has never heard of still has to
 * produce words.
 */
import { strict as assert } from 'node:assert'
import type { SuggestedUpdate } from './types'
import { describeGrant, ruleLabel, scopeLabel } from './rules.mts'

// ------------------------------------------------------------------ ruleLabel

// The two shapes the CLI actually sends, and they must never look alike: the
// bare name is EVERY use of that tool, the parenthesised one is a single
// command pattern.
assert.equal(ruleLabel({ toolName: 'Bash', ruleContent: 'npm run build:*' }), 'Bash(npm run build:*)')
assert.equal(ruleLabel({ toolName: 'Read' }), 'Read')
assert.equal(ruleLabel({ toolName: 'Read', ruleContent: '' }), 'Read', 'empty content is no content')
// Degenerate shapes come off the wire; a bare `(x)` would name no tool at all.
assert.equal(ruleLabel({ toolName: '', ruleContent: 'x' }), 'an unnamed tool(x)')
assert.equal(ruleLabel({ toolName: '' }), 'an unnamed tool')

// ----------------------------------------------------------------- scopeLabel

// Every branch names the FILE, because "localSettings" tells the user nothing
// and ".claude/settings.local.json" tells them a click writes into their repo.
assert.equal(scopeLabel('userSettings'), '~/.claude/settings.json')
assert.equal(scopeLabel('projectSettings'), '.claude/settings.json')
assert.equal(scopeLabel('localSettings'), '.claude/settings.local.json')
// The two that are not files say so rather than inventing a path.
assert.equal(scopeLabel('session'), 'this conversation only')
assert.equal(scopeLabel('cliArg'), "this run's command-line flags")
// Reachable: destinations arrive off the wire and out of a replayed event log.
assert.equal(scopeLabel(undefined), 'a scope this build does not recognise')
assert.equal(
  scopeLabel('somethingNew' as never),
  'a scope this build does not recognise',
  'an unknown destination must not render as its own enum name',
)
// Every label has to read after the word "in", which is how describeGrant uses
// them — a label starting with a capital or ending in punctuation would not.
for (const scope of [
  'userSettings',
  'projectSettings',
  'localSettings',
  'session',
  'cliArg',
  undefined,
] as const) {
  const label = scopeLabel(scope)
  assert.ok(label.length > 0, `scopeLabel(${scope}) must say something`)
  assert.doesNotMatch(label, /[.;]$/, `scopeLabel(${scope}) must not end a sentence`)
}

// --------------------------------------------------------------- describeGrant

// Nothing offered, nothing said. THIS is what makes the card's hide-the-button
// branch a one-liner rather than a second emptiness test.
assert.equal(describeGrant([]), '')

// One rule, the common case: the exact rule and the exact file, in one sentence.
{
  const one = describeGrant([
    {
      type: 'addRules',
      rules: [{ toolName: 'Bash', ruleContent: 'npm run build:*' }],
      behavior: 'allow',
      destination: 'localSettings',
    },
  ])
  assert.equal(one, 'Always allow Bash(npm run build:*), in .claude/settings.local.json.')
}

// Several rules in one update read as a list, not as repeated clauses.
{
  const many = describeGrant([
    {
      type: 'addRules',
      rules: [{ toolName: 'Read' }, { toolName: 'Glob' }, { toolName: 'Bash', ruleContent: 'ls:*' }],
      behavior: 'allow',
      destination: 'projectSettings',
    },
  ])
  assert.equal(many, 'Always allow Read, Glob and Bash(ls:*), in .claude/settings.json.')
}

// Two updates with DIFFERENT destinations. The reach of a grant is the whole
// point, so a sentence that named only the first file would be a lie about the
// second.
{
  const split = describeGrant([
    { type: 'addRules', rules: [{ toolName: 'Read' }], behavior: 'allow', destination: 'session' },
    {
      type: 'addRules',
      rules: [{ toolName: 'Write' }],
      behavior: 'allow',
      destination: 'userSettings',
    },
  ])
  assert.ok(split.includes('this conversation only'))
  assert.ok(split.includes('~/.claude/settings.json'))
  assert.equal(split.split(';').length, 2, 'one clause per update')
  assert.ok(split.endsWith('.'), 'still one sentence')
}

// A deny suggestion must not read as an allow — the word is the whole content.
{
  const denied = describeGrant([
    {
      type: 'addRules',
      rules: [{ toolName: 'Bash', ruleContent: 'rm:*' }],
      behavior: 'deny',
      destination: 'localSettings',
    },
  ])
  assert.ok(denied.startsWith('Always deny '), denied)
  assert.equal(denied.includes('allow'), false, 'a deny rule must never contain the word allow')
}

// The remaining arms of the union. Every one has to produce words, because the
// click grants all of them verbatim.
{
  const said = (u: SuggestedUpdate): string => describeGrant([u])
  assert.match(
    said({ type: 'replaceRules', rules: [{ toolName: 'Read' }], behavior: 'ask', destination: 'session' }),
    /Replace the ask rules with Read/,
  )
  assert.match(
    said({ type: 'removeRules', rules: [{ toolName: 'Read' }], behavior: 'allow', destination: 'session' }),
    /Remove Read from the allow rules/,
  )
  assert.match(said({ type: 'setMode', mode: 'acceptEdits', destination: 'session' }), /acceptEdits/)
  assert.match(
    said({ type: 'addDirectories', directories: ['/tmp/x', '/tmp/y'], destination: 'localSettings' }),
    /access to \/tmp\/x and \/tmp\/y/,
  )
  assert.match(
    said({ type: 'removeDirectories', directories: ['/tmp/x'], destination: 'localSettings' }),
    /Take away the agent's access to \/tmp\/x/,
  )
}

// THE SAFETY PROPERTY. A permission update type from a future SDK is still
// granted by the click, so it still has to appear on screen — and it has to name
// itself, or the sentence is describing a permission the user cannot look up.
{
  const future = { type: 'addSomethingNew', destination: 'userSettings' } as unknown as SuggestedUpdate
  const said = describeGrant([future])
  assert.ok(said.includes('addSomethingNew'), said)
  assert.ok(said.includes('~/.claude/settings.json'), 'the destination still survives')
}

// ...including one carrying no type at all, which is what a malformed frame
// looks like. Silence is the one output that is not allowed.
{
  const said = describeGrant([{} as unknown as SuggestedUpdate])
  assert.notEqual(said, '', 'a malformed update must not vanish')
  assert.doesNotThrow(() => describeGrant([null as unknown as SuggestedUpdate]))
}

console.log('rules: ok')
