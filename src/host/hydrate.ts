import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk'
import { IPC } from '../shared/types'
import { send } from '../shared/sink'
import { normaliseTranscript, type StoredMessage } from '../main/agent/transcript.mts'

/** Matches the manager's own cap; long enough for any real session. */
const TRANSCRIPT_LIMIT = 5000

/**
 * Replay a stored conversation into this host's event log.
 *
 * Emitted as ordinary `evtItem`s so they are indistinguishable from live ones:
 * the log stays the single description of the transcript, and a client that
 * reconnects after a crash gets the whole thing from one place.
 *
 * Never throws — a session that cannot be read back is still perfectly usable,
 * it just opens with an empty pane.
 */
export async function hydrateInto(
  sdkSessionId: string,
  cwd: string,
  sessionId: string,
): Promise<void> {
  try {
    let msgs = await getSessionMessages(sdkSessionId, { dir: cwd, limit: TRANSCRIPT_LIMIT })
    // A SCOPED READ THAT COMES BACK EMPTY IS NOT PROOF THERE IS NOTHING TO READ.
    // `dir` names the project directory the transcript is filed under, and a
    // re-homed session is by definition running somewhere other than where its
    // conversation was recorded — its worktree is gone. With no `dir` the SDK
    // scans every project directory, so this finds a transcript that exists at
    // all, wherever it was written. Cheap, because it only runs when the first
    // read found nothing.
    if (msgs.length === 0) {
      msgs = await getSessionMessages(sdkSessionId, { limit: TRANSCRIPT_LIMIT })
    }
    for (const item of normaliseTranscript(msgs as unknown as StoredMessage[])) {
      send(IPC.evtItem, { sessionId, item })
    }
  } catch (err) {
    console.error('[host] transcript hydrate failed:', err)
  }
}
