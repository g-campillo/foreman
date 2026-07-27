/**
 * Self-check for the LSP framer: `npm run check:lspwire`.
 *
 * Every case here is a real shipped bug in somebody's LSP client. Framing fails
 * silently and asymmetrically — a client that mishandles a split header does not
 * crash, it just stops answering, and the server looks broken instead.
 */
import { strict as assert } from 'node:assert'
import { encode, makeFrameReader, LSP_ERR } from './lspwire.mts'

const collect = (): { got: unknown[]; feed: (c: Buffer) => void } => {
  const got: unknown[] = []
  return { got, feed: makeFrameReader((m) => got.push(m)) }
}

// ------------------------------------------------------------------- encode

{
  const out = encode({ jsonrpc: '2.0', id: 1, method: 'x' })
  const text = out.toString('utf8')
  assert.ok(text.startsWith('Content-Length: '), 'header first')
  assert.ok(text.includes('\r\n\r\n'), 'CRLF terminator')
  const declared = Number(/Content-Length: (\d+)/.exec(text)![1])
  const body = out.subarray(out.indexOf('\r\n\r\n') + 4)
  assert.equal(declared, body.length, 'declared length is the BODY BYTE count')
}

// The bug this whole module exists to avoid: bytes, not characters.
{
  const msg = { s: '日本語 🎉 café' }
  const out = encode(msg)
  const declared = Number(/Content-Length: (\d+)/.exec(out.toString('utf8'))![1])
  const asString = JSON.stringify(msg).length
  assert.notEqual(declared, asString, 'byte length must differ from char length here')
  assert.equal(declared, Buffer.byteLength(JSON.stringify(msg), 'utf8'))
}

// ------------------------------------------------------------------ decode

{
  const { got, feed } = collect()
  feed(encode({ a: 1 }))
  assert.deepEqual(got, [{ a: 1 }], 'one whole message')
}

// Two complete messages arriving in a single chunk: the loop has to drain, not
// handle one and return.
{
  const { got, feed } = collect()
  feed(Buffer.concat([encode({ a: 1 }), encode({ b: 2 })]))
  assert.deepEqual(got, [{ a: 1 }, { b: 2 }], 'both messages from one chunk')
}

// THE case. Split at every single byte offset — headers, terminator and body —
// and the result must be identical every time.
{
  const whole = Buffer.concat([encode({ hello: 'wörld 🎉' }), encode({ n: 2 })])
  for (let i = 0; i <= whole.length; i++) {
    const { got, feed } = collect()
    feed(whole.subarray(0, i))
    feed(whole.subarray(i))
    assert.deepEqual(got, [{ hello: 'wörld 🎉' }, { n: 2 }], `split at byte ${i}`)
  }
}

// One byte at a time — the pathological version of the above.
{
  const whole = encode({ drip: '日本語' })
  const { got, feed } = collect()
  for (const b of whole) feed(Buffer.from([b]))
  assert.deepEqual(got, [{ drip: '日本語' }], 'byte-at-a-time')
}

// A multibyte codepoint split across chunks. This is what a string accumulator
// corrupts: Buffer.concat of two halves is exact, string concat of two
// toString()s is not.
{
  const whole = encode({ e: '🎉🎉🎉' })
  const mid = whole.length - 5 // lands inside a 4-byte emoji
  const { got, feed } = collect()
  feed(whole.subarray(0, mid))
  feed(whole.subarray(mid))
  assert.deepEqual(got, [{ e: '🎉🎉🎉' }], 'multibyte across a chunk boundary')
}

// Optional headers must be tolerated and ignored.
{
  const body = Buffer.from(JSON.stringify({ ok: 1 }), 'utf8')
  const { got, feed } = collect()
  feed(
    Buffer.concat([
      Buffer.from(
        `Content-Length: ${body.length}\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n`,
      ),
      body,
    ]),
  )
  assert.deepEqual(got, [{ ok: 1 }], 'Content-Type ignored')
}

// Header casing is not guaranteed by every server.
{
  const body = Buffer.from(JSON.stringify({ ok: 2 }), 'utf8')
  const { got, feed } = collect()
  feed(Buffer.concat([Buffer.from(`content-length:${body.length}\r\n\r\n`), body]))
  assert.deepEqual(got, [{ ok: 2 }], 'lowercase header, no space after colon')
}

// Bare \n\n from a non-conformant server.
{
  const body = Buffer.from(JSON.stringify({ ok: 3 }), 'utf8')
  const { got, feed } = collect()
  feed(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\n\n`), body]))
  assert.deepEqual(got, [{ ok: 3 }], 'LF-only terminator tolerated')
}

// A complete header with no body yet must emit nothing AND not consume, so the
// body still lands when it arrives.
{
  const { got, feed } = collect()
  feed(Buffer.from('Content-Length: 12\r\n\r\n'))
  assert.deepEqual(got, [], 'header alone emits nothing')
  feed(Buffer.from('{"a":"bcd"}'.padEnd(12)))
  assert.equal(got.length, 1, 'body completes the frame')
}

// Garbage before a valid frame — a server that logs to stdout. Must not deadlock.
{
  const { got, feed } = collect()
  feed(Buffer.concat([Buffer.from('starting up...\n\n'), encode({ after: true })]))
  assert.deepEqual(got, [{ after: true }], 'unparseable header block is skipped, not fatal')
}

// A malformed body kills that message only; framing survives it.
{
  const { got, feed } = collect()
  const bad = Buffer.from('not json')
  feed(Buffer.concat([Buffer.from(`Content-Length: ${bad.length}\r\n\r\n`), bad, encode({ n: 9 })]))
  assert.deepEqual(got, [{ n: 9 }], 'bad body dropped, next message still read')
}

// Zero-length body: legal framing, unparseable, must not stall the stream.
{
  const { got, feed } = collect()
  feed(Buffer.concat([Buffer.from('Content-Length: 0\r\n\r\n'), encode({ n: 10 })]))
  assert.deepEqual(got, [{ n: 10 }], 'empty body skipped cleanly')
}

assert.equal(LSP_ERR.RequestCancelled, -32800)

console.log('lspwire: ok')
