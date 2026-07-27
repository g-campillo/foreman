/**
 * A detached agent host: one process per session, outliving the app.
 *
 * This is what makes an agent survive Electron. Before it, `Session` lived in
 * the main process, so quitting killed the turn — and a *crash* was worse:
 * `before-quit` never fires, so the `claude` child was orphaned with dead stdio
 * and wedged forever.
 *
 * Now Electron is a client. It spawns this, talks to it over a unix socket, and
 * can come and go; the agent keeps working and every event it emits is appended
 * to a log that a reconnecting app replays to rebuild the transcript.
 *
 * Runs under bare Node (`ELECTRON_RUN_AS_NODE=1` on Electron's own binary, so
 * there is no second runtime to ship). Nothing reachable from here may import
 * `electron` — that is why permissions/elicitation/gitdiff had their ipcMain
 * registrations split out, and why events go through `shared/sink`.
 */
import { createServer, type Socket } from 'node:net'
import { appendFileSync, mkdirSync, writeFileSync, createReadStream, existsSync, unlinkSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { setSink, send } from '../shared/sink'
import { serverPids, disposeAll } from '../lsp/registry.mts'
import { handleFromRenderer, lspRequest } from '../lsp/proxy.mts'
import { IPC } from '../shared/types'
import { HOST_FILES, makeLineReader, type HostCall, type HostFrame, type HostMeta } from '../shared/hostwire'
import { Session } from '../main/agent/session'
import { hydrateInto } from './hydrate'
import { pendingPermissions, respondPermission } from '../main/agent/permissions'
import { pendingElicitations, respondElicitation } from '../main/agent/elicitation'

/**
 * How long a host stays up with nobody attached and nothing running.
 *
 * The point of this process is to outlive the app, so it deliberately does NOT
 * exit when the last client disconnects. But "outlive" cannot mean "forever" —
 * quitting the app would then leak an agent per session, permanently. Half an
 * hour is long enough to survive a crash-and-relaunch and a lunch break.
 */
const IDLE_EXIT_MS = Number(process.env.FOREMAN_HOST_IDLE_MS ?? 30 * 60 * 1000)

/** Guards against an unbounded log on a very long session. */
const MAX_LOG_BYTES = Number(process.env.FOREMAN_HOST_LOG_BYTES ?? 64 * 1024 * 1024)

const dir = process.argv[2]
const init = JSON.parse(process.argv[3] ?? '{}')
if (!dir) {
  console.error('[host] usage: host <dir> <initJson>')
  process.exit(2)
}

mkdirSync(dir, { recursive: true })
const eventsPath = join(dir, HOST_FILES.events)
const metaPath = join(dir, HOST_FILES.meta)
const sockPath = join(dir, HOST_FILES.sock)

const clients = new Set<Socket>()
let logBytes = 0
let logFull = false

/**
 * The `claude` child's pid, discovered rather than reported.
 *
 * The SDK does not expose it — `Query` has no pid member — so the only handle
 * on it is the process tree: it is spawned by us, so it is our direct child.
 * Worth the `pgrep`, because it is the ONLY thing that makes a crash-orphaned
 * agent killable. If this host is SIGKILLed, nothing else records that pid and
 * the agent runs until the machine reboots.
 */
let agentPid: number | undefined
function findAgentPid(): void {
  execFile('pgrep', ['-P', String(process.pid)], (err, stdout) => {
    if (err) return
    const pids = stdout.split('\n').map((l) => Number(l.trim())).filter(Boolean)
    // One child in practice; take the first and re-stamp meta with it.
    if (pids.length) {
      agentPid = pids[0]
      writeMeta(session)
    }
  })
}

function writeMeta(session: Session): void {
  const meta: HostMeta = {
    sessionId: session.meta.id,
    pid: process.pid,
    // Recorded so a crashed host's orphaned agent is killable on next launch.
    agentPid,
    // Same, for the language servers. writeMeta runs on a timer, so this stays
    // current as servers start lazily rather than only reflecting session start.
    lspPids: serverPids(),
    cwd: session.meta.cwd,
    title: session.meta.title,
    sdkSessionId: session.meta.sdkSessionId,
    startedAt: Date.now(),
  }
  try {
    writeFileSync(metaPath, JSON.stringify(meta))
  } catch (err) {
    console.error('[host] meta write failed:', err)
  }
}

function push(frame: HostFrame): void {
  const line = `${JSON.stringify(frame)}\n`
  for (const c of clients) c.write(line)
}

/**
 * The sink: log first, then push.
 *
 * Log-first is what makes a crash survivable — an event recorded but not
 * delivered is replayed on reconnect, whereas the reverse would lose it.
 */
setSink((channel, payload) => {
  const frame: HostFrame = { t: 'event', channel, payload }
  if (!logFull) {
    const line = `${JSON.stringify(frame)}\n`
    try {
      appendFileSync(eventsPath, line)
      logBytes += Buffer.byteLength(line)
      if (logBytes > MAX_LOG_BYTES) {
        logFull = true
        console.error('[host] event log capped at', MAX_LOG_BYTES, 'bytes; live only from here')
      }
    } catch (err) {
      console.error('[host] log append failed:', err)
    }
  }
  push(frame)
})

/** Assigned by `main()` below; every reader is a closure that runs after it. */
let session: Session
let metaTimer: NodeJS.Timeout | null = null

// --------------------------------------------------------------- control

/**
 * Everything the app can ask a session to do.
 *
 * One entry per `ipcMain.handle` the manager used to own — same names, same
 * arguments — which is what kept the move mechanical.
 */
const METHODS: Record<string, (...a: never[]) => unknown> = {
  meta: () => session.meta,
  send: (content: never) => session.send(content),
  cancelQueued: (itemId: never) => session.cancelQueued(itemId),
  interrupt: () => session.interrupt(),
  setPermissionMode: (mode: never) => session.setPermissionMode(mode),
  setModel: (model: never) => session.setModel(model),
  setEffort: (effort: never) => session.setEffort(effort),
  models: () => session.models(),
  commands: () => session.commands(),
  rewind: (id: never, dryRun: never) => session.rewind(id, dryRun),
  background: (toolUseId: never) => session.background(toolUseId),
  stopTask: (taskId: never) => session.stopTask(taskId),
  toggleMcp: (name: never, enabled: never) => session.toggleMcp(name, enabled),
  reconnectMcp: (name: never) => session.reconnectMcp(name),
  setMcpPermissionOverride: (name: never, mode: never) =>
    session.setMcpPermissionOverride(name, mode),
  contextUsage: () => session.contextUsage(),
  account: () => session.account(),
  usage: () => session.usage(),
  agents: () => session.agents(),
  mcpStatus: () => session.mcpStatus(),
  reloadSkills: () => session.reloadSkills(),
  setTitle: (title: never) => session.setTitle(title),

  /** A direct LSP request from the renderer, answered in the same round-trip. */
  lspRequest: (method: never, params: never) => lspRequest(method, params),

  /** One JSON-RPC frame from the renderer's Monaco LSP client. */
  lspSend: async (msg: never) => {
    const reply = await handleFromRenderer(msg)
    if (reply) send(IPC.evtLspMessage, { sessionId: session.meta.id, msg: reply })
    return true
  },

  // Prompts park in THIS process now, so answering them happens here too.
  respondPermission: (answer: never) => respondPermission(answer),
  respondElicitation: (answer: never) => respondElicitation(answer),
  pending: () => ({
    approvals: pendingPermissions(session.meta.id),
    elicitations: pendingElicitations(session.meta.id),
  }),

  /** Stream the backlog to the caller. Requested once the renderer is listening. */
  replay: () => {
    for (const sock of clients) replay(sock)
    return true
  },

  /**
   * Explicit teardown — the user closed the session. Distinct from detaching.
   *
   * Deferred a tick so the reply is written before the socket goes away; the
   * client waits on it before reaping this directory.
   */
  shutdown: () => {
    setTimeout(shutdown, 50)
    return true
  },
}

async function handleCall(sock: Socket, call: HostCall): Promise<void> {
  const fn = METHODS[call.method]
  const reply = (frame: HostFrame): void => {
    if (!sock.destroyed) sock.write(`${JSON.stringify(frame)}\n`)
  }
  if (!fn) return reply({ t: 'reply', id: call.id, ok: false, error: `no method ${call.method}` })
  try {
    // `as never[]` because METHODS is deliberately heterogeneous; the app side
    // is the typed surface (see hostclient.ts).
    const value = await (fn as (...a: unknown[]) => unknown)(...(call.args as never[]))
    reply({ t: 'reply', id: call.id, ok: true, value: value ?? null })
  } catch (err) {
    reply({ t: 'reply', id: call.id, ok: false, error: String(err) })
  }
}

/** Stream the backlog to a freshly-attached client, then mark the seam. */
function replay(sock: Socket): void {
  const done = (): void => {
    if (!sock.destroyed) sock.write(`${JSON.stringify({ t: 'replayed' } satisfies HostFrame)}\n`)
  }
  if (!existsSync(eventsPath)) return done()
  const rl = createInterface({ input: createReadStream(eventsPath, 'utf8'), crlfDelay: Infinity })
  rl.on('line', (line) => {
    if (line.trim() && !sock.destroyed) sock.write(`${line}\n`)
  })
  rl.on('close', done)
  rl.on('error', done)
}

const server = createServer((sock) => {
  clients.add(sock)
  sock.on('error', () => undefined)
  sock.on('close', () => {
    clients.delete(sock)
    armIdleExit()
  })
  sock.on('data', makeLineReader((line) => {
    try {
      void handleCall(sock, JSON.parse(line) as HostCall)
    } catch {
      /* a malformed line must not take the host down */
    }
  }))

  // `hello` only. The backlog is NOT pushed here: at adopt time the app has no
  // renderer yet, so an automatic replay would stream the whole transcript into
  // a null sink and be lost. The client asks for it once its window is up.
  sock.write(`${JSON.stringify({ t: 'hello', meta: session.meta } satisfies HostFrame)}\n`)
  armIdleExit()
})

server.on('error', (err) => {
  console.error('[host] listen failed:', err)
  process.exit(1)
})

/**
 * Startup, in the one order that is correct.
 *
 * A resumed conversation's stored history is written to the log BEFORE the
 * session starts, so the log reads as history-then-live rather than
 * interleaving the two. That ordering is the whole reason this is a function:
 * it needs an await, and a CJS bundle has no top-level await.
 *
 * The socket only opens once the session exists, so no call can arrive before
 * there is something to call it on.
 */
async function main(): Promise<void> {
  if (typeof init.resume === 'string' && init.resume) {
    await hydrateInto(init.resume, String(init.cwd ?? ''), init.sessionId as string)
  }

  session = new Session(init)
  writeMeta(session)
  findAgentPid()
  // meta.json is written once at startup, but sdkSessionId and title are only
  // learned later (a resumed id, an auto-title). Re-stamp on a cadence rather
  // than threading a callback through Session for two fields.
  metaTimer = setInterval(() => writeMeta(session), 5000)
  metaTimer.unref?.()

  // A stale socket file from a host that died uncleanly would make bind fail.
  try {
    if (existsSync(sockPath)) unlinkSync(sockPath)
  } catch {
    /* best effort */
  }
  server.listen(sockPath)
  console.error(`[host] up: session=${session.meta.id} pid=${process.pid} dir=${dir}`)
}

// ------------------------------------------------------------ idle + exit

let idleTimer: NodeJS.Timeout | null = null

/**
 * Exit if nobody attaches for a while AND nothing is happening.
 *
 * Both halves matter: a running turn with no client is exactly the case this
 * whole process exists to support, so work in flight always wins over the
 * timer, and the check is re-armed rather than cancelled.
 */
function armIdleExit(): void {
  if (idleTimer) clearTimeout(idleTimer)
  if (clients.size > 0) return
  idleTimer = setTimeout(() => {
    const busy =
      session?.meta.status === 'running' || session?.meta.status === 'awaiting-approval'
    if (clients.size === 0 && !busy) {
      console.error('[host] idle with no client; exiting')
      shutdown()
    } else {
      armIdleExit()
    }
  }, IDLE_EXIT_MS)
}

function shutdown(): void {
  if (metaTimer) clearInterval(metaTimer)
  try {
    session?.close()
  } catch {
    /* already gone */
  }
  // Language servers are children of THIS process, so nothing else collects
  // them. Fire-and-forget: the exit timeout below bounds how long we wait, and
  // the pid list in meta is the backstop if it does not finish.
  void disposeAll()
  try {
    server.close()
    if (existsSync(sockPath)) unlinkSync(sockPath)
  } catch {
    /* best effort */
  }
  // The SDK's own teardown is async; give it a beat, then go regardless.
  setTimeout(() => process.exit(0), 250).unref?.()
}

// A supervisor asking us to stop is a real teardown, not a detach.
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
// A crash here must not leave the agent running with nothing owning it.
process.on('uncaughtException', (err) => {
  console.error('[host] uncaught:', err)
  shutdown()
})

void main().catch((err) => {
  console.error('[host] startup failed:', err)
  process.exit(1)
})
