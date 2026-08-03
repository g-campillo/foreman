import { app, shell } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, unlinkSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { dirname, join } from 'node:path'
import { IPC, type SessionMeta } from '../../shared/types'
import {
  HOST_FILES,
  makeLineReader,
  sockPathFor,
  sockPathProblem,
  type HostCall,
  type HostFrame,
  type HostMeta,
} from '../../shared/hostwire'
import { send, showNotification } from '../bridge'
import { currentPathId, shellPathReady } from '../shellpath'

/**
 * Electron's handle on a detached agent host.
 *
 * The app is now a *client* of its own agents. Everything the manager used to
 * call on a `Session` directly is a socket round-trip, and every event the
 * session emits arrives over the same socket and is forwarded to the renderer
 * unchanged — so the renderer never learns any of this happened.
 */

/**
 * Agent lifetime policy, pushed from Settings.
 *
 * Main cannot read localStorage, and these decide what happens on quit — so the
 * renderer sends them at bootstrap and on every change. The defaults here match
 * the store's, so a quit before the renderer ever booted still behaves sanely.
 */
export const policy = {
  lifetime: 'persist' as 'persist' | 'stop',
  idleMinutes: 30,
  notifications: true,
  /**
   * The spend and turn caps from Settings, 0 for "no cap".
   *
   * Here as well as on each SessionInit because MAIN sometimes starts a host on
   * its own — `rehome` restarts one mid-send, with no renderer call to carry the
   * caps in on. Without them a re-homed session would silently drop back to the
   * FOREMAN_MAX_* env defaults, which is a policy change nobody asked for and
   * nothing on screen to say so.
   */
  maxBudgetUsd: 0,
  maxTurns: 0,
}

/** Where all hosts live. Lazy: `app.getPath` throws before ready. */
export function hostsRoot(): string {
  return join(app.getPath('userData'), 'hosts')
}

function hostDir(sessionId: string): string {
  return join(hostsRoot(), sessionId)
}

/**
 * This session's socket. Short by construction — see `sockPathFor`, which
 * explains why it cannot live inside the host directory.
 */
function hostSock(sessionId: string): string {
  return sockPathFor(app.getPath('userData'), sessionId)
}

/**
 * The socket of a host that is already running.
 *
 * Recorded in its meta since the move; hosts started by an older build have no
 * `sock` field and still have theirs in the old place.
 */
function sockOf(dir: string, meta: HostMeta): string {
  return meta.sock ?? join(dir, HOST_FILES.sock)
}

export class HostClient {
  meta: SessionMeta
  /**
   * The PATH this host was actually spawned with, as a fingerprint.
   *
   * A process's environment is frozen at `spawn`, so a host started before the
   * login-shell PATH arrived — or by a build older than it — can never connect
   * an MCP server that needs `npx`, however many times the button is pressed.
   * Set from `currentPathId()` for a host we start, and read back out of
   * `meta.json` for one we adopt, which is the only way it survives a restart.
   * Undefined means "older build", which is the same stale case.
   */
  pathId: string | undefined
  /**
   * When this host last did anything, for the idle sweep in the manager.
   *
   * Bumped on EVENT FRAMES ONLY — see onLine. Not on `call`, deliberately: the
   * read-only panels poll through `callOr`, so counting a call would let an open
   * side panel keep a session alive forever, which is the same "the timer never
   * fires" bug the host's own armIdleExit has. A user message is not missed by
   * this: it produces evtItem and evtMeta from the host within milliseconds.
   */
  lastActivity = Date.now()
  /**
   * Called when the socket closes WITHOUT a detach or a shutdown.
   *
   * The comment that used to sit on the close handler said "the manager reaps on
   * close", and it described behaviour that did not exist: a dead host left a
   * rail row backed by a HostClient with `sock === null`, which answered every
   * call with a rejection and could never be revived. The manager sets this so a
   * lost host degrades to an asleep row — a conversation you can wake — rather
   * than a lie about a running agent.
   */
  onLost: ((sessionId: string) => void) | undefined
  private sock: Socket | null = null
  private nextId = 1
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >()
  /** Buffered until the socket is up, so a call made during connect isn't lost. */
  private readonly outbox: string[] = []
  /** Resolvers parked on the next `replayed` frame — see replay(). */
  private replayWaiters: (() => void)[] = []
  private connected: Promise<void>
  private closed = false

  private constructor(meta: SessionMeta) {
    this.meta = meta
    this.connected = Promise.resolve()
  }

  // ------------------------------------------------------------- lifecycle

  /** Spawn a brand-new host and wait for its first `hello`. */
  static async start(init: Record<string, unknown>, sessionId: string): Promise<HostClient> {
    // The host's env is whatever ours is at this instant, and it keeps it for
    // life — so a session started in the second before the login shell answers
    // would inherit the stripped launch PATH permanently. Free on every launch
    // but the first, where the cached answer has already resolved this.
    await shellPathReady

    const dir = hostDir(sessionId)
    mkdirSync(dir, { recursive: true })

    // The socket sits outside `dir` to stay under the sun_path limit, so its
    // own parent has to exist before the host tries to bind.
    const sock = hostSock(sessionId)
    mkdirSync(dirname(sock), { recursive: true })
    // Nothing downstream can recover from this, and an unchecked overrun shows
    // up as an unexplained EINVAL in a log file nobody thinks to open.
    const problem = sockPathProblem(sock)
    if (problem) throw new Error(`cannot start host: ${problem}`)

    // Electron's own binary in Node mode: no second runtime to ship, and it
    // resolves identically in dev and inside the signed .app. `detached` plus
    // `unref` is what actually lets it outlive us — without both, quitting
    // Electron takes the host with it and none of this works.
    const script = join(__dirname, 'host.js')
    // `pathId` rides in with the init JSON so the host can echo it back through
    // meta.json, which is the one place a fact about this spawn survives into a
    // later run of the app — the point at which it is needed.
    const pathId = currentPathId()
    const child = spawn(process.execPath, [script, dir, JSON.stringify({ ...init, sessionId, pathId }), sock], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        // The host reads this to decide how long to stay up unattended. 0 in
        // Settings means "no limit", which the host spells as a huge number
        // rather than a special case.
        FOREMAN_HOST_IDLE_MS: String(
          policy.idleMinutes > 0 ? policy.idleMinutes * 60_000 : Number.MAX_SAFE_INTEGER,
        ),
      },
      detached: true,
      // Was 'ignore', which threw away everything the host said. That is fine
      // right up until something inside it misbehaves — a language server that
      // will not spawn, an SDK warning, a stack trace — and then there is no
      // record of it anywhere, because a detached process has no terminal to
      // inherit. Appending to a file in the host's own directory keeps the
      // process detached (the fds are real files, not our pipes, so nothing
      // holds this parent alive) and makes the host debuggable at all.
      stdio: ['ignore', openSync(join(dir, HOST_FILES.log), 'a'), openSync(join(dir, HOST_FILES.log), 'a')],
    })
    child.unref()

    const client = new HostClient({} as SessionMeta)
    client.pathId = pathId
    await client.attach(sock)
    return client
  }

  /** Re-attach to a host that is already running — the post-crash path. */
  static async adopt(found: FoundHost): Promise<HostClient> {
    const client = new HostClient({} as SessionMeta)
    client.pathId = found.meta.pathId
    await client.attach(sockOf(found.dir, found.meta))
    return client
  }

  /**
   * Connect, with retries while the host is still starting up.
   *
   * Resolves on the `hello` frame, which is the first thing a host writes — so
   * by the time this returns, `meta` is real and the caller can put a row in
   * the rail.
   */
  private attach(sockPath: string): Promise<void> {
    this.connected = new Promise<void>((resolve, reject) => {
      let tries = 0
      const tryOnce = (): void => {
        const sock = connect(sockPath)
        sock.on('connect', () => {
          this.sock = sock
          for (const line of this.outbox.splice(0)) sock.write(line)
        })
        sock.on('data', makeLineReader((line) => this.onLine(line, resolve)))
        sock.on('error', () => {
          // An error on a socket that HAS connected is a lost host, not the
          // startup race this retry loop exists for — and the close handler
          // below owns it. Reconnecting anyway would leave a second client
          // forwarding frames for a row `onLost` has already marked asleep,
          // with nothing on screen that names the connection keeping the agent
          // alive. Harmless before `onLost` existed; not any more.
          const live = this.sock === sock
          sock.destroy()
          if (live) return
          // 50 x 100ms — the host has to boot Node and construct a Session.
          if (++tries > 50) return reject(new Error(`host did not come up: ${sockPath}`))
          setTimeout(tryOnce, 100)
        })
        sock.on('close', () => {
          // A socket that never reached 'connect' was never this client's.
          // The retry loop below destroys each failed attempt, which fires this
          // handler too — and treating that as a loss would latch `closed`
          // before the host had even come up, disarming shutdown() forever.
          const wasLive = this.sock === sock
          if (wasLive) this.sock = null
          // Not an error in itself: the host may have exited on purpose.
          for (const [id, p] of this.pending) {
            p.reject(new Error('host disconnected'))
            this.pending.delete(id)
          }
          // RESOLVED, not rejected. A backlog that will never arrive is still a
          // finished replay as far as the renderer is concerned — and leaving
          // these parked would strand `hydrating`, which suppresses the empty
          // state, so the composer would sit bottom-pinned over nothing forever.
          for (const done of this.replayWaiters.splice(0)) done()
          // `closed` is set by detach() and shutdown() BEFORE they end the
          // socket, so this fires only for a close nobody asked for — the host
          // crashed, or exited on its own idle timer. See onLost.
          if (!wasLive || this.closed) return
          this.closed = true
          this.onLost?.(this.meta.id)
        })
      }
      tryOnce()
    })
    return this.connected
  }

  private onLine(line: string, onHello?: () => void): void {
    let frame: HostFrame
    try {
      frame = JSON.parse(line) as HostFrame
    } catch {
      return
    }

    if (frame.t === 'hello') {
      this.meta = frame.meta
      onHello?.()
      return
    }
    // THE SEAM, and it is load-bearing rather than informational: the host's
    // `replay` method returns the instant it has opened the log, so the ordinary
    // reply frame says nothing about whether the backlog has arrived. This frame
    // does. See replay() for who is waiting on it.
    if (frame.t === 'replayed') {
      // ONE waiter per frame, FIFO. The host writes exactly one of these per
      // `replay` call, and two calls can be in flight at once — a resume racing
      // bootstrap's re-adoption. Draining the whole queue would let the first
      // seam answer for a backlog still streaming behind it.
      this.replayWaiters.shift()?.()
      return
    }
    if (frame.t === 'reply') {
      const p = this.pending.get(frame.id)
      if (!p) return
      this.pending.delete(frame.id)
      if (frame.ok) p.resolve(frame.value)
      else p.reject(new Error(frame.error))
      return
    }

    // An event — the agent actually did something. This is the clock the
    // manager's idle sweep reads; see lastActivity for why replies are not.
    this.lastActivity = Date.now()

    // Keep our copy of meta in step, then forward verbatim.
    if (frame.channel === IPC.evtMeta) {
      const p = frame.payload as { sessionId: string; patch: Partial<SessionMeta> }
      this.meta = { ...this.meta, ...p.patch }
    }
    // Two channels are for main, not the renderer — they are the things only
    // Electron can do, which is exactly why the host has to ask.
    if (frame.channel === IPC.evtNotify) {
      if (!policy.notifications) return
      const { title, body } = frame.payload as { title: string; body: string }
      showNotification(title, body)
      return
    }
    if (frame.channel === IPC.evtOpenUrl) {
      const { url } = frame.payload as { url: string }
      void shell.openExternal(url).catch(() => undefined)
      return
    }
    send(frame.channel, frame.payload)
  }

  // ---------------------------------------------------------------- calls

  async call<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
    await this.connected
    const id = this.nextId++
    const line = `${JSON.stringify({ id, method, args } satisfies HostCall)}\n`
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      if (this.sock) this.sock.write(line)
      else this.outbox.push(line)
    })
  }

  /**
   * Stream this host's backlog, and WAIT for it to land.
   *
   * `call('replay')` is not enough and the difference is a visible bug. The
   * host's `replay` method opens the event log and returns `true` immediately;
   * the file is then read asynchronously and the frames go out behind the reply.
   * So a caller awaiting the call resolves while the transcript is still in
   * flight — which is exactly what made the renderer's `hydrating` flag clear a
   * round trip too early, and a resumed session paint the empty-state layout and
   * then snap out of it.
   *
   * The `replayed` frame is the real end marker and always has been; nothing was
   * listening to it. Registered BEFORE the call is written, because a host with
   * no log at all emits `replayed` synchronously inside its own handler and
   * therefore ahead of the reply.
   */
  async replay(): Promise<void> {
    await this.connected
    const landed = new Promise<void>((resolve) => this.replayWaiters.push(resolve))
    await this.call('replay')
    await landed
  }

  /**
   * Detach without stopping the agent.
   *
   * This is the quit path, and the whole point of the feature: the host keeps
   * running, keeps appending to its log, and is re-adopted next launch.
   */
  detach(): void {
    this.closed = true
    this.sock?.end()
    this.sock = null
  }

  /** Stop the agent for good and delete its directory — the user closed it. */
  async shutdown(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.call('shutdown').catch(() => undefined)
    this.sock?.end()
    this.sock = null
    try {
      rmSync(hostDir(this.meta.id), { recursive: true, force: true })
      // The socket is no longer inside that directory, so removing it is now a
      // separate step — miss it and `run/` accretes a dead file per session.
      unlinkSync(hostSock(this.meta.id))
    } catch {
      /* best effort — a leftover directory is reaped at next launch */
    }
  }
}

/**
 * Hosts on disk, and what state they are in.
 *
 * Called once at launch. Three outcomes per directory, and the third is the one
 * that exists only because of crashes.
 */
export interface FoundHost {
  dir: string
  meta: HostMeta
  live: boolean
}

export function scanHosts(): FoundHost[] {
  const root = hostsRoot()
  if (!existsSync(root)) return []
  const out: FoundHost[] = []
  for (const name of readdirSync(root)) {
    const dir = join(root, name)
    try {
      const meta = JSON.parse(readFileSync(join(dir, HOST_FILES.meta), 'utf8')) as HostMeta
      out.push({ dir, meta, live: isAlive(meta.pid) })
    } catch {
      // No readable meta: a half-written directory from a host that died during
      // startup. Nothing to adopt and nothing to kill.
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* best effort */
      }
    }
  }
  return out
}

/**
 * Clean up after a host that died uncleanly.
 *
 * The agent it spawned is now orphaned — reparented to init, holding an API
 * connection, with nothing that will ever reap it. This is the crash-path leak
 * `before-quit` structurally cannot reach, and the recorded `agentPid` is the
 * only handle on it.
 */
export function reapDeadHost(found: FoundHost): void {
  const { agentPid, lspPids } = found.meta
  if (agentPid && isAlive(agentPid)) {
    try {
      process.kill(agentPid, 'SIGTERM')
      console.warn(`[hosts] reaped orphaned agent pid=${agentPid} from a crashed host`)
    } catch {
      /* already gone, or not ours */
    }
  }
  // Same treatment for the language servers. They are grandchildren, so nothing
  // else in the tree will collect them.
  for (const pid of lspPids ?? []) {
    if (!isAlive(pid)) continue
    try {
      process.kill(pid, 'SIGTERM')
      console.warn(`[hosts] reaped orphaned language server pid=${pid}`)
    } catch {
      /* already gone, or not ours */
    }
  }
  try {
    rmSync(found.dir, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
  // Outside found.dir since the socket moved, so the rmSync above does not
  // cover it. Stale sockets are harmless to connect to but never disappear.
  try {
    unlinkSync(sockOf(found.dir, found.meta))
  } catch {
    /* already gone */
  }
}

/** Signal 0 delivers nothing and only reports whether the pid exists. */
function isAlive(pid: number): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM means the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}
