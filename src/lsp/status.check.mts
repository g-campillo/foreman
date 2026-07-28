/**
 * Self-check for language-server readiness: `npm run check:lspstatus`.
 *
 * All three of these decide what a user is told about a server they cannot see.
 * Get `phaseOf` backwards and the strip shows a green light over a jdtls that is
 * still minutes from answering anything — the exact confusion the indicator
 * exists to end, now with a UI vouching for it. Get `statusDiff` or
 * `throttleStatus` backwards and every $/progress frame becomes a synchronous
 * appendFileSync in the host plus a line replayed to every client that ever
 * reconnects.
 */
import { strict as assert } from 'node:assert'
import { phaseOf, type LspSignal } from './client.mts'
import { statusDiff, throttleStatus } from './registry.mts'
import type { LspStatus } from '../shared/types'

const sig = (over: Partial<LspSignal> = {}): LspSignal => ({
  busy: false,
  percent: null,
  detail: null,
  service: 'silent',
  ...over,
})

// ------------------------------------------------------------------- phaseOf

// THE RULE THIS EXISTS FOR: silence is ready. Every server but jdtls speaks no
// language/status at all, so treating a quiet one as "not ready" would leave
// tsgo pinned at "indexing" for the whole session.
assert.equal(phaseOf(sig()), 'ready')

// An open work token is the server's own word that it is not finished.
assert.equal(phaseOf(sig({ busy: true })), 'indexing')
assert.equal(phaseOf(sig({ busy: true, percent: 40, detail: 'Building x' })), 'indexing')

// jdtls: Starting/Started is NOT ServiceReady, and most of its project build
// happens with no progress token open at all — so `warming` alone has to hold
// the phase down, or a Maven project reads as ready ~3.7s in and answers
// nothing for minutes afterwards.
assert.equal(phaseOf(sig({ service: 'warming' })), 'indexing')
assert.equal(phaseOf(sig({ service: 'warming', busy: true })), 'indexing')

// ServiceReady is the one signal that actually means "answers are trustworthy".
assert.equal(phaseOf(sig({ service: 'ready' })), 'ready')

// ...but a job it opened afterwards still outranks it. The server has said it
// is working; saying otherwise would be us guessing on its behalf.
assert.equal(phaseOf(sig({ service: 'ready', busy: true })), 'indexing')

// A percentage on its own never decides the phase — only `busy` and `service`
// do, and a stale number must not resurrect a finished server.
assert.equal(phaseOf(sig({ percent: 90 })), 'ready')
assert.equal(phaseOf(sig({ percent: 0, busy: true })), 'indexing')

// jdtls's ServiceStatus enum has an Error member, and nothing follows it: after
// a missing JDK or a workspace it could not read, ServiceReady never arrives. A
// server that said it broke must not read as one that is still working — an
// indefinite "indexing the project" over a dead server is the same lie as a
// green light over a warming one, and it is the only failure a LIVE server can
// report (the rest come from detection, the encoding refusal, a thrown
// initialize and the crash cap).
assert.equal(phaseOf(sig({ service: 'failed' })), 'failed')
assert.equal(phaseOf(sig({ service: 'failed', busy: true, percent: 40 })), 'failed')
// Failure outranks the latch too: a server that broke after going ready is
// broken, not ready.
assert.equal(phaseOf(sig({ service: 'failed' }), 'ready'), 'failed')

// THE LATCH. Once a server has been shown as ready, routine background work
// must not drag it back: jdtls, tsgo and pyright all open short work tokens for
// validate-on-save and publish-diagnostics, and every flip is a phase diff —
// flushed past the host's throttle, and mounting a strip that resizes the
// session list under the cursor. This feature is about INITIAL readiness.
assert.equal(phaseOf(sig({ busy: true }), 'ready'), 'ready')
assert.equal(phaseOf(sig({ busy: true, percent: 20, detail: 'Publishing' }), 'ready'), 'ready')
assert.equal(phaseOf(sig({ service: 'warming', busy: true }), 'ready'), 'ready')

// It is a latch, not a floor: everything below `ready` still moves freely, so
// the first index reports exactly as it did before.
assert.equal(phaseOf(sig({ busy: true }), 'indexing'), 'indexing')
assert.equal(phaseOf(sig({ busy: true }), 'starting'), 'indexing')
assert.equal(phaseOf(sig(), 'indexing'), 'ready', 'the first arrival at ready still happens')

// ---------------------------------------------------------------- statusDiff

const st = (over: Partial<LspStatus> = {}): LspStatus => ({
  id: 'java',
  via: 'jdtls',
  phase: 'indexing',
  percent: null,
  detail: null,
  ...over,
})

assert.equal(statusDiff([], []), 'same', 'nothing at all is not a change')
assert.equal(statusDiff([st()], [st()]), 'same', 'field-by-field — identity says nothing')

// A server appearing or going away is a phase change even if nothing else moved.
assert.equal(statusDiff([st()], []), 'phase')
assert.equal(statusDiff([], [st()]), 'phase')

assert.equal(statusDiff([st({ phase: 'ready' })], [st()]), 'phase')
assert.equal(statusDiff([st({ phase: 'failed' })], [st()]), 'phase')
assert.equal(statusDiff([st({ id: 'ts' })], [st()]), 'phase', 'a different server in the slot')
assert.equal(statusDiff([st({ via: 'PATH' })], [st()]), 'phase', 'a rung change is a restart')

// The throttled cases: the numbers moved and nothing else did.
assert.equal(statusDiff([st({ percent: 40 })], [st()]), 'percent')
assert.equal(statusDiff([st({ percent: 41 })], [st({ percent: 40 })]), 'percent')
assert.equal(statusDiff([st({ detail: 'Building x' })], [st()]), 'percent')

// Order is part of the snapshot: lspStatuses builds from Map iteration order,
// so two lists holding the same servers in a different order really are a
// different rendering and must not compare equal.
assert.equal(
  statusDiff([st({ id: 'ts' }), st({ id: 'java' })], [st({ id: 'java' }), st({ id: 'ts' })]),
  'phase',
)

// A phase change ALWAYS wins over a percentage one, in either position —
// otherwise a server going ready could be held back a second behind another
// server's progress tick.
assert.equal(
  statusDiff(
    [st({ percent: 40 }), st({ id: 'ts', phase: 'ready' })],
    [st({ percent: 10 }), st({ id: 'ts', phase: 'starting' })],
  ),
  'phase',
)

// ------------------------------------------------------------ throttleStatus

// A phase change goes out on the spot; that is what the user is waiting for.
assert.deepEqual(throttleStatus([st()], []), { pending: [st()], now: true })
assert.deepEqual(throttleStatus([st({ phase: 'ready' })], [st()]), {
  pending: [st({ phase: 'ready' })],
  now: true,
})

// Numbers ride the timer instead.
assert.deepEqual(throttleStatus([st({ percent: 40 })], [st()]), {
  pending: [st({ percent: 40 })],
  now: false,
})

// THE PENDING RESET. Sent state is `Building X`; a frame saying `Building Y`
// arms the timer; then live state comes back to `Building X`. Holding `Y` here
// would send it a second later, leave `sentStatus` describing a frame that no
// longer exists, and — because every later comparison is against that record —
// stay wrong until something else moves. On a server that then goes quiet,
// forever. So a `same` frame must DROP what the timer is holding.
const sent = [st({ percent: 40, detail: 'Building X' })]
assert.deepEqual(throttleStatus([st({ percent: 40, detail: 'Building Y' })], sent), {
  pending: [st({ percent: 40, detail: 'Building Y' })],
  now: false,
})
assert.deepEqual(throttleStatus(sent, sent), { pending: null, now: false })

console.log('lspstatus: ok')
