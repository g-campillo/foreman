import { dirname, join, sep } from 'node:path'

/**
 * Absolute path to the Claude Code binary the SDK spawns.
 *
 * The SDK resolves this itself from its own location, which is correct in dev
 * but fatal once packaged: require.resolve reports a path inside app.asar, and
 * spawn() is not asar-aware, so it dies with ENOTDIR. Redirect to the unpacked
 * copy. Returns undefined if resolution fails, letting the SDK do its thing.
 *
 * Its own module because every `query()` in the app needs it — the session and
 * the titler — and having the titler import it from session.ts would be a cycle.
 */
export function claudeExecutable(): string | undefined {
  try {
    const pkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`
    const dir = dirname(require.resolve(`${pkg}/package.json`))
    return join(dir, 'claude').replace(`app.asar${sep}`, `app.asar.unpacked${sep}`)
  } catch {
    return undefined
  }
}
