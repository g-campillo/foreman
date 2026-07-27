import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { type ServerId } from '../shared/languages.mts'
import type { ServerReport } from '../shared/types'

// require.resolve, from an ESM module. .mts is ESM under the root's
// "type": "commonjs", which is the whole reason these files carry that
// extension — see the block comment in detect.mts.
const require = createRequire(import.meta.url)

/**
 * Finding a language server, without asking the user to configure one.
 *
 * The ladder, most specific first. Every rung is local and cheap — no network,
 * no downloads, nothing that runs without the user having already installed it:
 *
 *   1. an explicit override the user (or the agent) wrote
 *   2. the project's own node_modules/.bin or .venv/bin
 *   3. the project's own toolchain — for TS, THEIR tsgo rather than ours
 *   4. $PATH
 *   5. toolchain-derived (rustup, xcrun)
 *   6. our bundled tsgo, for TypeScript only
 *   7. nothing — and then we ask the agent, we do not act
 *
 * Rung 7 is the interesting one. The tempting shortcut is
 * `npx -y typescript-language-server`, which downloads and executes code from
 * the network with no approval card anywhere. That is a privilege WIDENING
 * dressed up as convenience, and this codebase's rule is tighten-only. Instead
 * the UI offers to compose a message asking the agent to install one; the agent
 * runs it in the terminal it already owns, and `pip install` raises the same
 * approval card any other command would. Zero new privilege.
 */

export interface Resolved {
  cmd: string
  args: string[]
  /** Which rung answered, for the provenance line on every tool result. */
  via: string
}

const OVERRIDES = 'lsp-servers.json'

function overridePath(): string {
  return join(process.env.FOREMAN_USER_DATA ?? '/tmp', OVERRIDES)
}

function readOverrides(): Record<string, { cmd: string; args?: string[] }> {
  try {
    return JSON.parse(readFileSync(overridePath(), 'utf8')) as Record<
      string,
      { cmd: string; args?: string[] }
    >
  } catch {
    return {}
  }
}

/** First existing path, or null. */
function firstFile(...paths: string[]): string | null {
  for (const p of paths) if (p && existsSync(p)) return p
  return null
}

/** `which`, without a shell. */
function onPath(bin: string): string | null {
  try {
    const out = execFileSync('/usr/bin/which', [bin], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const line = out.trim().split('\n')[0]
    return line && existsSync(line) ? line : null
  } catch {
    return null
  }
}

function run(cmd: string, args: string[]): string | null {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

/**
 * tsgo, the LSP server that ships inside the `typescript` package from v7.
 *
 * Undocumented — `--lsp` is absent from `--help --all` — but measured working
 * on 7.0.2: it answers initialize with hover, definition, references, rename
 * (with prepareProvider), callHierarchy, a pull diagnosticProvider with
 * interFileDependencies, and positionEncoding utf-16.
 *
 * `from` lets this resolve the PROJECT's copy as well as our own. Theirs is
 * strictly better when it exists: it is the compiler their code is written
 * against, so its answers match their build.
 */
function tsgo(from?: string): string | null {
  try {
    // No `paths` means "resolve from this module's own location", i.e. the app's
    // own node_modules — which is exactly what the bundled fallback wants, and
    // avoids needing __dirname (absent in ESM, and this file is .mts so that it
    // can run under bare node).
    const pkgPath = from
      ? require.resolve('typescript/package.json', { paths: [from] })
      : require.resolve('typescript/package.json')
    const major = Number(
      (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string }).version.split('.')[0],
    )
    if (!Number.isFinite(major) || major < 7) return null // 6.x has no --lsp
    const platform = `@typescript/typescript-${process.platform}-${process.arch}`
    const dir = dirname(
      require.resolve(`${platform}/package.json`, {
        paths: from ? [dirname(pkgPath), from] : [dirname(pkgPath)],
      }),
    )
    // spawn() is not asar-aware, so a packaged path has to be redirected at the
    // unpacked copy — the same move claudeExecutable() makes, for the same
    // reason, and the reason `@typescript/typescript-*` is in asarUnpack.
    const bin = join(dir, 'lib', 'tsc').replace(`app.asar${sep}`, `app.asar.unpacked${sep}`)
    return existsSync(bin) ? bin : null
  } catch {
    return null
  }
}

/**
 * Where clangd's compilation database lives, or null.
 *
 * `compile_flags.txt` and `.clangd` count too: both are legitimate ways to tell
 * clangd how the project builds, and a header-only or single-TU project may
 * reasonably have only those.
 */
const DB_DIRS = ['', 'build', 'out', 'cmake-build-debug', '.build']

function compileDb(cwd: string): string | null {
  for (const d of DB_DIRS) {
    const dir = d ? join(cwd, d) : cwd
    if (
      existsSync(join(dir, 'compile_commands.json')) ||
      existsSync(join(dir, 'compile_flags.txt')) ||
      existsSync(join(dir, '.clangd'))
    ) {
      return dir
    }
  }
  return null
}

/**
 * The Eclipse JDT language server's launcher.
 *
 * Homebrew installs it as an opt/ symlink and does NOT put it on PATH, so
 * `which jdtls` misses a perfectly good install — checking the well-known
 * locations first is what makes this work out of the box.
 */
function jdtlsBin(): string | null {
  return (
    onPath('jdtls') ??
    onPath('jdt-language-server') ??
    firstFile(
      '/opt/homebrew/opt/jdtls/bin/jdtls',
      '/usr/local/opt/jdtls/bin/jdtls',
      `${process.env.HOME ?? ''}/.local/share/nvim/mason/bin/jdtls`,
    )
  )
}

/**
 * A real JDK, or null.
 *
 * `/usr/libexec/java_home` is the canonical macOS answer and, importantly,
 * FAILS when none is installed rather than pointing at the stub — which is
 * exactly the distinction that matters here.
 */
function javaHome(): string | null {
  if (process.env.JAVA_HOME && existsSync(join(process.env.JAVA_HOME, 'bin', 'java'))) {
    return process.env.JAVA_HOME
  }
  const home = run('/usr/libexec/java_home', [])
  if (home && existsSync(join(home, 'bin', 'java'))) return home
  // java_home only knows about system-registered JVMs, so a perfectly good
  // SDKMAN or Homebrew JDK is invisible to it — which is how a machine with
  // three JDKs installed still reports "Unable to locate a Java Runtime".
  const h = process.env.HOME ?? ''
  return firstFile(
    join(h, '.sdkman/candidates/java/current/bin/java'),
    '/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home/bin/java',
    '/usr/local/opt/openjdk/libexec/openjdk.jdk/Contents/Home/bin/java',
    join(h, '.asdf/shims/java'),
  )
}

/** A filesystem-safe key for a project path. */
function slug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(-80) || 'root'
}

function relOf(cwd: string, path: string): string {
  return path === cwd ? '.' : path.slice(cwd.length + 1)
}

export function resolveServer(id: ServerId, cwd: string): Resolved | null {
  const override = readOverrides()[`${cwd}::${id}`] ?? readOverrides()[id]
  if (override?.cmd && existsSync(override.cmd)) {
    return { cmd: override.cmd, args: override.args ?? [], via: 'override' }
  }

  const bin = (name: string): string => join(cwd, 'node_modules', '.bin', name)

  switch (id) {
    case 'ts': {
      const theirs = tsgo(cwd)
      if (theirs) return { cmd: theirs, args: ['--lsp', '--stdio'], via: 'project tsgo' }
      const tsserver = firstFile(bin('typescript-language-server'))
      if (tsserver) return { cmd: tsserver, args: ['--stdio'], via: 'project typescript-language-server' }
      const ours = tsgo()
      if (ours) return { cmd: ours, args: ['--lsp', '--stdio'], via: 'bundled tsgo' }
      const global = onPath('typescript-language-server')
      return global ? { cmd: global, args: ['--stdio'], via: 'PATH' } : null
    }

    case 'swift': {
      // Already at /usr/bin on any Mac with the developer tools, which is why
      // Swift is second in line after TypeScript rather than fifth: it is the
      // most visceral demonstration that the fleet is real, given that
      // name-based reference search returns literally zero on same-module Swift.
      const found = firstFile('/usr/bin/sourcekit-lsp') ?? onPath('sourcekit-lsp') ?? run('xcrun', ['--find', 'sourcekit-lsp'])
      return found && existsSync(found) ? { cmd: found, args: [], via: 'sourcekit-lsp' } : null
    }

    case 'java': {
      const bin = jdtlsBin()
      // jdtls is a Java program. Without a JDK it starts, fails to launch the
      // JVM, and dies — the same "installed but unusable" shape as clangd
      // without a compilation database, and worth the same refusal. On macOS
      // this is especially easy to miss: /usr/bin/java EXISTS on a machine with
      // no JDK at all, as a stub whose only job is to tell you to install one.
      if (!bin || !javaHome()) return null
      return {
        cmd: bin,
        // jdtls keeps per-project index state and will not share one directory
        // between projects. Keyed by cwd under userData rather than written
        // into the project, which would show up in the user's git status.
        args: ['-data', join(process.env.FOREMAN_USER_DATA ?? '/tmp', 'jdtls', slug(cwd))],
        via: 'jdtls',
      }
    }

    case 'python': {
      const local = firstFile(
        join(cwd, '.venv', 'bin', 'pyright-langserver'),
        join(cwd, '.venv', 'bin', 'basedpyright-langserver'),
        bin('pyright-langserver'),
      )
      if (local) return { cmd: local, args: ['--stdio'], via: 'project venv' }
      const global = onPath('pyright-langserver') ?? onPath('basedpyright-langserver')
      if (global) return { cmd: global, args: ['--stdio'], via: 'PATH' }
      const pylsp = firstFile(join(cwd, '.venv', 'bin', 'pylsp')) ?? onPath('pylsp')
      return pylsp ? { cmd: pylsp, args: [], via: 'pylsp' } : null
    }

    case 'rust': {
      const found = onPath('rust-analyzer') ?? run('rustup', ['which', 'rust-analyzer'])
      return found && existsSync(found) ? { cmd: found, args: [], via: 'rust-analyzer' } : null
    }

    case 'go': {
      const gopath = run('go', ['env', 'GOPATH'])
      const found = onPath('gopls') ?? (gopath ? firstFile(join(gopath, 'bin', 'gopls')) : null)
      return found ? { cmd: found, args: [], via: 'gopls' } : null
    }

    case 'clangd': {
      const found = onPath('clangd') ?? firstFile('/usr/bin/clangd') ?? run('xcrun', ['--find', 'clangd'])
      if (!found || !existsSync(found)) return null
      // A clangd with no compilation database is the silent-empty failure this
      // codebase keeps trying to avoid: it starts, it answers every request,
      // and every answer is nothing, because it does not know the include paths
      // or the standard the project builds with. Refusing to start is the loud
      // version, and `whyMissing` turns it into a sentence the user can act on.
      const db = compileDb(cwd)
      if (!db) return null
      return { cmd: found, args: [`--compile-commands-dir=${db}`], via: `clangd (${relOf(cwd, db)})` }
    }
  }
}

/**
 * Everything the UI needs to say about one language, in one object.
 *
 * Built by asking the same `resolveServer` the runtime uses — not a parallel
 * list that can disagree with it. A status screen that says "installed" for a
 * server the registry then fails to start is worse than no status screen.
 */

const META: Record<ServerId, { label: string; extensions: string; install?: string }> = {
  ts: {
    label: 'TypeScript · JavaScript',
    extensions: '.ts .tsx .mts .cts .js .jsx .mjs .cjs',
    // Nothing to install: tsgo ships with the app.
  },
  swift: {
    label: 'Swift',
    extensions: '.swift',
    install: 'xcode-select --install',
  },
  java: {
    label: 'Java',
    extensions: '.java',
    install: 'brew install jdtls openjdk',
  },
  python: {
    label: 'Python',
    extensions: '.py .pyi',
    // npm rather than pip: it does not need a virtualenv to be active, which is
    // the failure mode of `pip install` from a shell that is not in one.
    install: 'npm install -g pyright',
  },
  rust: {
    label: 'Rust',
    extensions: '.rs',
    install: 'rustup component add rust-analyzer',
  },
  go: {
    label: 'Go',
    extensions: '.go',
    install: 'go install golang.org/x/tools/gopls@latest',
  },
  clangd: {
    label: 'C · C++ · Objective-C',
    extensions: '.c .h .cc .cpp .hpp .m .mm',
    install: 'xcode-select --install',
  },
}

export const SERVER_IDS: ServerId[] = ['ts', 'swift', 'java', 'python', 'rust', 'go', 'clangd']

/**
 * Languages Monaco colours but no server here understands.
 *
 * Listed EXPLICITLY, and that is the point. Without this, a .java file looked
 * exactly like a .json one — `serverFor` returns null for both, so the editor
 * said nothing and the user could not tell "we deliberately let Monaco handle
 * this" from "we have never heard of your language". Silence meaning two
 * opposite things is the failure this whole surface exists to prevent.
 */
const HIGHLIGHT_ONLY: { label: string; extensions: string; why: string }[] = [
  { label: 'Kotlin', extensions: '.kt .kts', why: 'kotlin-language-server is a separate project.' },
  { label: 'Scala', extensions: '.scala .sc', why: 'Metals is a separate project.' },
  { label: 'Groovy · Gradle', extensions: '.groovy .gradle', why: 'No widely-used server.' },
  { label: 'Ruby, PHP, Elixir, and ~70 more', extensions: '', why: 'Monaco has grammars; no server is wired.' },
]

/** The highlight-only languages, as reports, so one list can show everything. */
export function highlightOnly(): ServerReport[] {
  return HIGHLIGHT_ONLY.map((h, i) => ({
    id: `hl${i}` as ServerId,
    label: h.label,
    extensions: h.extensions,
    state: 'highlight-only' as const,
    detail: h.why,
  }))
}

/** One report per language, for the Settings list and the editor's strip. */
export function reportServers(cwd: string): ServerReport[] {
  return [...SERVER_IDS.map((id) => {
    const meta = META[id]
    const resolved = resolveServer(id, cwd)
    if (resolved) {
      // `install` deliberately dropped once it is ready. Leaving it set makes
      // the object read as "here is how to install this" for something already
      // installed, and invites a caller to show it without checking `state`.
      return { id, label: meta.label, extensions: meta.extensions, state: 'ready' as const, detail: resolved.via }
    }

    // clangd is the one case where "not ready" usually means "installed but the
    // project has no compilation database" — a different problem with a
    // different fix, and saying "not installed" would send the user to brew for
    // something they already have.
    if (id === 'clangd' && (onPath('clangd') ?? firstFile('/usr/bin/clangd'))) {
      return {
        id,
        ...meta,
        state: 'unconfigured' as const,
        detail: 'clangd is installed, but this project has no compilation database.',
        install: 'cmake -DCMAKE_EXPORT_COMPILE_COMMANDS=ON -B build',
        hint: 'Or `bear -- make`, or commit a compile_flags.txt. clangd cannot resolve includes without one, so it would answer every request with nothing.',
      }
    }

    // Same shape as clangd's: installed but unusable is a different problem
    // with a different fix, and "not installed" would send the user to brew for
    // something they already have.
    if (id === 'java' && jdtlsBin() && !javaHome()) {
      return {
        id,
        ...meta,
        state: 'unconfigured' as const,
        detail: 'jdtls is installed, but there is no JDK to run it.',
        install: 'brew install openjdk',
        hint: 'On macOS /usr/bin/java exists even with no JDK — it is a stub that only tells you to install one, which is why this is easy to miss.',
      }
    }

    return {
      id,
      ...meta,
      state: 'missing' as const,
      detail: `Looked in ${searchedFor(id, cwd).join(', ')}`,
    }
  }), ...highlightOnly()]
}

/**
 * Where we looked, for the "no server found" message.
 *
 * Shown to the user verbatim. "No Python language server" invites a shrug;
 * naming the four places we checked invites a fix.
 */
export function searchedFor(id: ServerId, cwd: string): string[] {
  switch (id) {
    case 'ts':
      return [`${cwd}/node_modules/typescript`, `${cwd}/node_modules/.bin`, 'bundled tsgo', '$PATH']
    case 'java':
      return ['$PATH', '/opt/homebrew/opt/jdtls/bin', '~/.local/share/nvim/mason/bin']
    case 'python':
      return [`${cwd}/.venv/bin`, `${cwd}/node_modules/.bin`, '$PATH']
    case 'swift':
      return ['/usr/bin/sourcekit-lsp', 'xcrun --find sourcekit-lsp', '$PATH']
    case 'rust':
      return ['rustup which rust-analyzer', '$PATH']
    case 'go':
      return ['$(go env GOPATH)/bin/gopls', '$PATH']
    case 'clangd':
      return ['/usr/bin/clangd', 'xcrun --find clangd', '$PATH']
  }
}
