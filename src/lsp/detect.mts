import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import type { ServerId } from './languages.mts'

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
      return { cmd: found, args: [`--compile-commands-dir=${cwd}`], via: 'clangd' }
    }
  }
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
