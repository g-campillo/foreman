/**
 * Self-check for the language table and URI handling: `npm run check:lsp`.
 *
 * The URI cases matter more than they look. A mismatched URI does not throw —
 * the client simply never associates a response with a document, so the feature
 * appears to be unimplemented rather than broken.
 */
import { strict as assert } from 'node:assert'
import { languageOf, serverFor, toUri, fromUri, sameUri } from './languages.mts'

// -------------------------------------------------------------- languageOf

assert.equal(languageOf('/a/b/x.ts'), 'typescript')
assert.equal(languageOf('/a/b/x.tsx'), 'typescriptreact', 'tsx is NOT plain typescript')
assert.equal(languageOf('/a/b/x.mts'), 'typescript')
assert.equal(languageOf('x.SWIFT'), 'swift', 'extension match is case-insensitive')
assert.equal(languageOf('/a/b/noext'), null)
assert.equal(languageOf('/a/b/.gitignore'), null, 'a dotfile has no extension')
assert.equal(languageOf('/a/b/.env.local'), null, 'unknown extension -> null')
assert.equal(languageOf('/weird.path.dir/file.py'), 'python', 'dots in a directory do not confuse it')

// -------------------------------------------------------------- serverFor

assert.equal(serverFor('/a/x.ts'), 'ts')
assert.equal(serverFor('/a/x.jsx'), 'ts', 'one server owns the whole JS/TS family')
assert.equal(serverFor('/a/x.swift'), 'swift')
assert.equal(serverFor('/a/x.cpp'), 'clangd')
assert.equal(serverFor('/a/x.m'), 'clangd')
// Monaco already ships services for these; an external process would duplicate
// them. null is the decision, not an omission.
assert.equal(serverFor('/a/x.json'), null)
assert.equal(serverFor('/a/x.css'), null)
assert.equal(serverFor('/a/x.md'), null)
assert.equal(serverFor('/a/README'), null)

// -------------------------------------------------------------------- URIs

assert.equal(toUri('/a/b/c.ts'), 'file:///a/b/c.ts')
assert.equal(fromUri('file:///a/b/c.ts'), '/a/b/c.ts')
assert.equal(fromUri('not-a-uri'), 'not-a-uri', 'non-file URIs pass through')

// Round-trip the paths that actually break naive implementations.
for (const p of [
  '/a/my dir/file.ts',
  '/a/café 🎉/x.ts',
  '/a/b/name#with?chars.ts',
  '/a/b/100%.ts',
  '/a/b/plus+sign.ts',
]) {
  assert.equal(fromUri(toUri(p)), p, `round-trip ${p}`)
  assert.ok(!toUri(p).includes(' '), `no raw space in the URI for ${p}`)
}
// Separators must survive as separators, not become %2F. Six parts, because
// 'file:///a/b/c.ts' splits to ['file:', '', '', 'a', 'b', 'c.ts'].
assert.equal(toUri('/a/b/c.ts').split('/').length, 6)
assert.ok(!toUri('/a/b/c.ts').includes('%2F'), 'separators are not encoded')

// ---------------------------------------------------------------- sameUri

assert.ok(sameUri('file:///A/b.ts', 'file:///a/b.ts', 'darwin'), 'darwin folds case')
assert.ok(!sameUri('file:///A/b.ts', 'file:///a/b.ts', 'linux'), 'linux does not')
assert.ok(sameUri('file:///a/b.ts', 'file:///a/b.ts', 'linux'), 'identical still matches')
// The exact shape tsgo produced: it lowercased the whole path in a registration.
assert.ok(
  sameUri('file:///users/gcampillo/code/foreman/x.ts', 'file:///Users/gcampillo/code/foreman/x.ts', 'darwin'),
  'the tsgo lowercasing case',
)

console.log('lsp/languages: ok')
