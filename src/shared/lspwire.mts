/**
 * LSP's wire framing: `Content-Length: N\r\n\r\n<N bytes of JSON>`.
 *
 * Deliberately not `vscode-jsonrpc`. hostwire.ts states the principle for the
 * app's own protocol — "not a real RPC library, because a dependency for that
 * would be larger than the protocol" — and it holds here for the same reason.
 * The types are worth borrowing; the fifty lines below are not.
 *
 * `makeLineReader` in hostwire.ts CANNOT be reused, and the reason is subtle
 * enough to be worth stating: it accumulates a `string`, and Content-Length
 * counts BYTES. A string accumulator gets the arithmetic wrong for any
 * non-ASCII payload, and corrupts a multi-byte codepoint that lands across a
 * chunk boundary. Everything here works on Buffers for that one reason.
 *
 * No Electron, no SDK — same rule as policy.mts and porcelain.mts, so
 * `npm run check:lspwire` can run it under bare node.
 */

const CRLF2 = Buffer.from('\r\n\r\n')
const LF2 = Buffer.from('\n\n')

/** JSON-RPC codes LSP gives specific meanings to. */
export const LSP_ERR = {
  /** Answer to $/cancelRequest. Resolve to null; do NOT reject — a rejected
   *  completion logs a scary error every time someone types. */
  RequestCancelled: -32800,
  /** The document changed under an in-flight request. Same treatment. */
  ContentModified: -32801,
  ServerNotInitialized: -32002,
} as const

export function encode(msg: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(msg), 'utf8')
  // Length is body.length — the Buffer's byte count, not the string's.
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body])
}

/**
 * Where the header block ends, and how many bytes the terminator took.
 *
 * `\n\n` is tolerated alongside the spec's `\r\n\r\n` because non-conformant
 * servers exist and the cost of accepting one is nil. There is no ambiguity
 * between them: `\r\n\r\n` is `0D 0A 0D 0A`, which contains no `0A 0A`, so a
 * conformant terminator can never be mistaken for the lenient one.
 */
function headerEnd(buf: Buffer): { at: number; len: number } | null {
  const crlf = buf.indexOf(CRLF2)
  const lf = buf.indexOf(LF2)
  if (crlf === -1 && lf === -1) return null
  if (crlf === -1) return { at: lf, len: 2 }
  if (lf === -1) return { at: crlf, len: 4 }
  return crlf < lf ? { at: crlf, len: 4 } : { at: lf, len: 2 }
}

/**
 * A stateful chunk handler. Feed it whatever the pipe gives you, in any sizes.
 *
 * A message that fails to parse is dropped rather than thrown: the framing is
 * still intact, so the NEXT message is recoverable, and taking down the reader
 * over one bad body would lose an otherwise healthy server.
 */
export function makeFrameReader(onMessage: (msg: unknown) => void): (chunk: Buffer) => void {
  let buf: Buffer = Buffer.alloc(0)

  return (chunk: Buffer): void => {
    buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk])

    for (;;) {
      const end = headerEnd(buf)
      if (!end) return // header incomplete — keep everything, wait for more

      const header = buf.subarray(0, end.at).toString('ascii')
      const match = /content-length:\s*(\d+)/i.exec(header)
      if (!match) {
        // A header block with no length is unusable. Discard it and carry on
        // rather than stalling on it forever — a server that logs to stdout
        // before its first frame would otherwise wedge the connection.
        buf = buf.subarray(end.at + end.len)
        continue
      }

      const len = Number(match[1])
      const start = end.at + end.len
      if (buf.length < start + len) return // body incomplete — wait

      const body = buf.subarray(start, start + len)
      buf = buf.subarray(start + len)
      try {
        onMessage(JSON.parse(body.toString('utf8')))
      } catch {
        /* malformed body; framing survives, so the next message is fine */
      }
    }
  }
}
