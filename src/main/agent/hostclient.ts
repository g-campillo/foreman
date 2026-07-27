import { app, shell } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { join } from 'node:path'
import { IPC, type SessionMeta } from '../../shared/types'
import {
  HOST_FILES,
  makeLineReader,
  type HostCall,
  type HostFrame,
  type HostMeta,
} from '../../shared/hostwire'
import { send, showNotification } from '../bridge'

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
}

/** Where all hosts live. Lazy: `app.getPath` throws before ready. */
export function hostsRoot(): string {
  return join(app.getPath('userData'), 'hosts')
}

function hostDir(sessionId: string): string {
  return join(hostsRoot(), sessionId)
}

export class HostClient {
  meta: SessionMeta
  private sock: Socket | null = null
  private nextId = 1
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >()
  /** Buffered until the socket is up, so a call made during connect isn't lost. */
  private readonly outbox: string[] = []
  private connected: Promise<void>
  private closed = false

  private constructor(meta: SessionMeta) {
    this.meta = meta
    this.connected = Promise.resolve()
  }

  // ------------------------------------------------------------- lifecycle

  /** Spawn a brand-new host and wait for its first `hello`. */
  static async start(init: Record<string, unknown>, sessionId: string): Promise<HostClient> {
    const dir = hostDir(sessionId)
    mkdirSync(dir, { recursive: true })

    // Electron's own binary in Node mode: no second runtime to ship, and it
    // resolves identically in dev and inside the signed .app. `detached` plus
    // `unref` is what actually lets it outlive us — without both, quitting
    // Electron takes the host with it and none of this works.
    const script = join(__dirname, 'host.js')
    const child = spawn(process.execPath, [script, dir, JSON.stringify({ ...init, sessionId })], {
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
    await client.attach(dir)
    return client
  }

  /** Re-attach to a host that is already running — the post-crash path. */
  static async adopt(dir: string): Promise<HostClient> {
    const client = new HostClient({} as SessionMeta)
    await client.attach(dir)
    return client
  }

  /**
   * Connect, with retries while the host is still starting up.
   *
   * Resolves on the `hello` frame, which is the first thing a host writes — so
   * by the time this returns, `meta` is real and the caller can put a row in
   * the rail.
   */
  private attach(dir: string): Promise<void> {
    const sockPath = join(dir, HOST_FILES.sock)
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
          sock.destroy()
          // 50 x 100ms — the host has to boot Node and construct a Session.
          if (++tries > 50) return reject(new Error(`host did not come up: ${sockPath}`))
          setTimeout(tryOnce, 100)
        })
        sock.on('close', () => {
          if (this.sock === sock) this.sock = null
          // Not an error: the host may have exited on purpose. Callers see
          // rejections from in-flight calls, and the manager reaps on close.
          for (const [id, p] of this.pending) {
            p.reject(new Error('host disconnected'))
            this.pending.delete(id)
          }
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
    if (frame.t === 'replayed') return
    if (frame.t === 'reply') {
      const p = this.pending.get(frame.id)
      if (!p) return
      this.pending.delete(frame.id)
      if (frame.ok) p.resolve(frame.value)
      else p.reject(new Error(frame.error))
      return
    }

    // An event. Keep our copy of meta in step, then forward verbatim.
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
