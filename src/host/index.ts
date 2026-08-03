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
import { dirname, join } from 'node:path'
import { execFile } from 'node:child_process'
import { setSink, send } from '../shared/sink'
import {
  serverPids,
  disposeAll,
  recheck,
  setStatusListener,
  statusDiff,
  throttleStatus,
} from '../lsp/registry.mts'
import { handleFromRenderer, lspRequest } from '../lsp/proxy.mts'
import { IPC, type LspStatus } from '../shared/types'
import {
  HOST_FILES,
  makeLineReader,
  sockPathProblem,
  type HostCall,
  type HostFrame,
  type HostMeta,
} from '../shared/hostwire'
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

/**
 * Passed in rather than derived: it lives outside `dir` to stay under the
 * sun_path limit, and the app is the one that decides where. The fallback is
 * only for a host launched by an older build's client.
 */
const sockPath = process.argv[4] || join(dir, HOST_FILES.sock)
const sockProblem = sockPathProblem(sockPath)
if (sockProblem) {
  // Without this the only symptom is `listen EINVAL` several lines into a log
  // file, which names neither the cause nor the limit.
  console.error(`[host] refusing to start: ${sockProblem}`)
  process.exit(2)
}

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
    // So a future launch can find this socket without re-deriving where the
    // running build happened to put it.
    sock: sockPath,
    // Echoed straight back out of the init JSON: the app is the only side that
    // can compute it, and meta.json is the only place it survives to the next
    // run — where a stale env is the difference between "reconnect failed" and
    // "reconnect cannot possibly work here".
    pathId: typeof init.pathId === 'string' ? init.pathId : undefined,
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

// ----------------------------------------------------------- lsp status

/**
 * How often a percentage-only change may become an event.
 *
 * The sink above is why this exists at all: every event costs a SYNCHRONOUS
 * appendFileSync before it is delivered, and is replayed to every client that
 * ever reconnects. Relaying $/progress at the server's own cadence would put a
 * write on the critical path per frame and grow the log without bound, for a
 * number that changes faster than anyone can read it.
 */
const LSP_STATUS_MS = 1000

let sentStatus: LspStatus[] = []
let pendingStatus: LspStatus[] | null = null
let statusTimer: NodeJS.Timeout | null = null

function flushLspStatus(): void {
  if (statusTimer) {
    clearTimeout(statusTimer)
    statusTimer = null
  }
  const list = pendingStatus
  pendingStatus = null
  if (!list || statusDiff(list, sentStatus) === 'same') return
  sentStatus = list
  session?.setLspStatus(list)
}

/**
 * The registry's listener. A phase change is what the user is actually waiting
 * for, so it goes out on the spot; a moving percentage rides the timer.
 *
 * The decision itself is `throttleStatus`, in the registry, so `check:lspstatus`
 * can pin it — including the case that has no send at all, where what matters is
 * that the pending frame is DROPPED rather than left for the timer.
 */
function onLspStatus(list: LspStatus[]): void {
  const { pending, now } = throttleStatus(list, sentStatus)
  pendingStatus = pending
  if (now) return flushLspStatus()
  if (pending && !statusTimer) {
    statusTimer = setTimeout(flushLspStatus, LSP_STATUS_MS)
    statusTimer.unref?.()
  }
}

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
  editQueued: (itemId: never, content: never) => session.editQueued(itemId, content),
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

  /** Drop cached detection failures after the user installs a server. */
  lspRecheck: () => { recheck(); return true },

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
    // The log is read asynchronously while live frames keep going out on the
    // same socket, so an old lspStatus patch can land AFTER a newer one and the
    // store merges in arrival order. Every other REPLACE-semantics meta field is
    // corrected by the next turn; this one is not — once the fleet settles,
    // onLspStatus dedups everything and no corrective event is ever emitted, so
    // a reconnecting renderer would sit under "indexing 40%" forever. Re-stating
    // the truth once the seam is past closes it.
    if (sentStatus.length) session?.setLspStatus(sentStatus)
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
  // Before anything can open a document, so the first server to start is seen
  // starting rather than appearing already warm.
  setStatusListener(onLspStatus)
  writeMeta(session)
  findAgentPid()
  // meta.json is written once at startup, but sdkSessionId and title are only
  // learned later (a resumed id, an auto-title). Re-stamp on a cadence rather
  // than threading a callback through Session for two fields.
  metaTimer = setInterval(() => writeMeta(session), 5000)
  metaTimer.unref?.()

  // A stale socket file from a host that died uncleanly would make bind fail.
  try {
    mkdirSync(dirname(sockPath), { recursive: true })
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
