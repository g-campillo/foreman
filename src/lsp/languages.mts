/**
 * Extension -> LSP languageId -> which server owns it.
 *
 * Pure and dependency-free so `npm run check:lsp` can run it under bare node,
 * same rule as policy.mts and porcelain.mts.
 *
 * languageIds are the ones in the LSP spec's table, not invented: a server
 * matches on them, and getting `typescriptreact` wrong to `typescript` makes
 * .tsx files silently lose JSX handling rather than fail loudly.
 */

/** Server ids. One process per id, per session. */
export type ServerId = 'ts' | 'swift' | 'python' | 'rust' | 'go' | 'clangd'

const BY_EXT: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'typescriptreact',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascriptreact',
  swift: 'swift',
  py: 'python',
  pyi: 'python',
  rs: 'rust',
  go: 'go',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  m: 'objective-c',
  mm: 'objective-cpp',
  json: 'json',
  jsonc: 'jsonc',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  md: 'markdown',
  yml: 'yaml',
  yaml: 'yaml',
  sh: 'shellscript',
  toml: 'toml',
}

const OWNER: Record<string, ServerId> = {
  typescript: 'ts',
  typescriptreact: 'ts',
  javascript: 'ts',
  javascriptreact: 'ts',
  swift: 'swift',
  python: 'python',
  rust: 'rust',
  go: 'go',
  c: 'clangd',
  cpp: 'clangd',
  'objective-c': 'clangd',
  'objective-cpp': 'clangd',
}

/** The LSP languageId for a path, or null when we have no idea. */
export function languageOf(path: string): string | null {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  // A leading dot is a dotfile, not an extension: `.gitignore` has no type.
  if (dot <= 0) return null
  return BY_EXT[base.slice(dot + 1).toLowerCase()] ?? null
}

/**
 * Which server should answer for a path, or null when none should.
 *
 * json/css/html/markdown deliberately return null: Monaco already ships web
 * language services for those and they need no external process. Wiring a
 * server for them would duplicate what the editor does for free.
 */
export function serverFor(path: string): ServerId | null {
  const lang = languageOf(path)
  return lang ? (OWNER[lang] ?? null) : null
}

/** file:// URI for an absolute path, percent-encoding each segment. */
export function toUri(path: string): string {
  return `file://${path.split('/').map(encodeURIComponent).join('/')}`
}

/** Inverse of toUri. Returns the input unchanged if it is not a file URI. */
export function fromUri(uri: string): string {
  if (!uri.startsWith('file://')) return uri
  return decodeURIComponent(uri.slice('file://'.length))
}

/**
 * Compare two URIs for identity.
 *
 * Case-insensitive on darwin, and that is not pedantry: tsgo lowercases paths
 * in some of its responses (a registration came back as `/users/gcampillo/...`
 * against a real path of `/Users/gcampillo/...`). A case-sensitive comparison
 * silently drops those messages, which reads as "diagnostics do not work" with
 * nothing in the logs.
 */
export function sameUri(a: string, b: string, platform: string = process.platform): boolean {
  return platform === 'darwin' || platform === 'win32'
    ? a.toLowerCase() === b.toLowerCase()
    : a === b
}
