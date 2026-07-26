/**
 * Self-check for session policy: `npm run check:policy`.
 *
 * Worth having because both rules fail *silently*. A broken resultText turns a
 * spend cap into a blank card that reads as a crash; a broken notifyBody either
 * spams the user on every session start or goes quiet exactly when the agent is
 * blocked waiting for them.
 */
import { strict as assert } from 'node:assert'
import { MAX_BUDGET_USD, MAX_TURNS, cap, resultText, notifyBody, normaliseSend } from './policy.mts'

// ------------------------------------------------------------------------ cap

// Unset keeps the default.
delete process.env.FM_TEST_CAP
assert.equal(cap('FM_TEST_CAP', 500), 500)

// An explicit value wins, including a float.
process.env.FM_TEST_CAP = '75'
assert.equal(cap('FM_TEST_CAP', 500), 75)
process.env.FM_TEST_CAP = '12.5'
assert.equal(cap('FM_TEST_CAP', 500), 12.5)

// 0 / off / OFF mean genuinely uncapped, so the option gets omitted entirely.
for (const off of ['0', 'off', 'OFF', ' off ']) {
  process.env.FM_TEST_CAP = off
  assert.equal(cap('FM_TEST_CAP', 500), undefined, `${off} should uncap`)
}

// A typo must NOT silently remove the guard — that's the trap in `Number(x) || d`.
for (const junk of ['abc', '-5', 'NaN', '']) {
  process.env.FM_TEST_CAP = junk
  assert.equal(cap('FM_TEST_CAP', 500), 500, `${JSON.stringify(junk)} should keep the default`)
}
delete process.env.FM_TEST_CAP

// ------------------------------------------------------------------ resultText

// A user Stop beats everything else, including an error subtype.
assert.equal(
  resultText({ interrupted: true, subtype: 'error_during_execution', result: 'ignored' }),
  'stopped',
)

// The normal path: the SDK's own summary text passes through untouched.
assert.equal(resultText({ interrupted: false, subtype: 'success', result: 'all done' }), 'all done')

// Caps carry no `result` field. These must not render blank.
{
  const budget = resultText({ interrupted: false, subtype: 'error_max_budget_usd' })
  assert.notEqual(budget, '', 'budget cap must say something')
  assert.ok(budget.includes(String(MAX_BUDGET_USD)), 'and must name the cap it hit')

  const turns = resultText({ interrupted: false, subtype: 'error_max_turns' })
  assert.ok(turns.includes(String(MAX_TURNS)), 'turn cap must name its limit')
}

// A success with no text, and an unmapped subtype, both stay empty rather than
// leaking a raw subtype into the transcript.
assert.equal(resultText({ interrupted: false, subtype: 'success' }), '')
assert.equal(resultText({ interrupted: false, subtype: 'error_during_execution' }), '')

// -------------------------------------------------------------- normaliseSend

// A plain typed message stays a plain string — no block wrapping unless needed.
assert.equal(normaliseSend('hello'), 'hello')
assert.equal(normaliseSend('   '), null, 'whitespace-only is not a message')
assert.equal(normaliseSend(''), null)
assert.equal(normaliseSend(undefined), null)
assert.equal(normaliseSend({ nope: 1 }), null)
assert.equal(normaliseSend([]), null, 'an empty block list is not a message')

const img = (mediaType: string): unknown => ({
  type: 'image',
  source: { type: 'base64', media_type: mediaType, data: 'AAAA' },
})

// The four media types the API accepts survive; everything else is dropped
// here rather than failing upstream with an error pointing nowhere near the paste.
for (const ok of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
  assert.equal((normaliseSend([img(ok)]) as unknown[]).length, 1, `${ok} accepted`)
}
for (const bad of ['image/heic', 'image/svg+xml', 'image/bmp', 'text/plain', '']) {
  assert.equal(normaliseSend([img(bad)]), null, `${bad} rejected`)
}

// A mixed message keeps order, and drops only the offending block.
{
  const out = normaliseSend([img('image/png'), img('image/heic'), { type: 'text', text: 'look' }])
  assert.deepEqual(
    (out as { type: string }[]).map((b) => b.type),
    ['image', 'text'],
  )
}

// Malformed blocks never reach the SDK.
assert.equal(normaliseSend([null, { type: 'image' }, { type: 'image', source: {} }]), null)
assert.equal(normaliseSend([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' } }]), null,
  'an empty payload is not an image')
assert.equal(normaliseSend([{ type: 'text', text: '  ' }]), null, 'blank text block is dropped')

// An image with no caption is still a message worth sending.
assert.equal((normaliseSend([img('image/png')]) as unknown[]).length, 1)

// ----------------------------------------------------------------- notifyBody

// Start-up settles 'starting' -> 'idle'. Notifying there fires on every new
// session, before the agent has done anything at all.
assert.equal(notifyBody('starting', 'idle', 0), null)

// Finishing a real turn, and failing one, are both worth surfacing.
assert.equal(notifyBody('running', 'idle', 0), 'Turn complete')
assert.equal(notifyBody('running', 'error', 0), 'Turn failed')

// Blocked on the user is the highest-value case, and reports the count.
assert.ok(notifyBody('running', 'awaiting-approval', 2)?.includes('2'))

// Resuming after an approval is not a new turn, and a no-op patch is not a
// transition — neither may fire.
assert.equal(notifyBody('awaiting-approval', 'running', 0), null)
assert.equal(notifyBody('idle', 'idle', 0), null)
assert.equal(notifyBody('running', 'running', 0), null)

console.log('policy: ok')
