/**
 * Self-check for the diff tokenizer: `npm run check:highlight`.
 *
 * Two failure modes, neither of which announces itself. `lowlight.highlight`
 * THROWS on an unregistered grammar, and a throw inside DiffLines blanks the
 * transcript pane. And a zip that slides by one line paints one line's colours
 * onto another, which reads as a real edit rather than as a bug.
 */
import { strict as assert } from 'node:assert'
import type { DiffLine } from '../../shared/types'
import { hljsLang, tokenizeDiff } from './highlight.mts'

const ctx = (text: string): DiffLine => ({ type: 'ctx', text, oldNo: 1, newNo: 1 })
const del = (text: string): DiffLine => ({ type: 'del', text, oldNo: 1, newNo: null })
const add = (text: string): DiffLine => ({ type: 'add', text, oldNo: null, newNo: 1 })

/** Every token on a line, concatenated — must round-trip the source text. */
const textOf = (toks: { text: string }[]): string => toks.map((t) => t.text).join('')

// ------------------------------------------------------------------ hljsLang

{
  // The override table: an LSP languageId no hljs alias covers.
  assert.equal(hljsLang('a.tsx'), 'typescript')
  assert.equal(hljsLang('a.jsx'), 'javascript')
  assert.equal(hljsLang('a.sh'), 'bash')
  assert.equal(hljsLang('a.m'), 'objectivec')
  assert.equal(hljsLang('a.mm'), 'objectivec')
  assert.equal(hljsLang('a.jsonc'), 'json')

  // Passed straight through where hljs already knows the name or an alias.
  assert.equal(hljsLang('a.ts'), 'typescript')
  assert.equal(hljsLang('a.py'), 'python')
  assert.equal(hljsLang('a.go'), 'go')

  // Genuinely absent from the `common` set. Null, NOT the LSP id — handing an
  // unregistered name to lowlight is what throws.
  assert.equal(hljsLang('a.scala'), null, 'scala is not in the common grammar set')
  assert.equal(hljsLang('a.groovy'), null, 'groovy is not in the common grammar set')

  // languageOf's own two nulls, preserved.
  assert.equal(hljsLang('.gitignore'), null, 'a dotfile has no extension')
  assert.equal(hljsLang('README'), null)
  assert.equal(hljsLang('a.wat'), null, 'unknown extension')
}

// --------------------------------------------------------------- tokenizeDiff

// THE CASE THIS FILE EXISTS FOR: a line inside a block comment is only a comment
// because of the line above it. Highlighted alone, ` * main's panel` is not a
// comment at all — hljs sees the apostrophe, opens a string that never closes,
// and paints the rest of the line as one.
{
  const lines = [ctx('/* a comment'), ctx(" * main's panel"), ctx(' */')]
  const toks = tokenizeDiff(lines, 'typescript')
  assert.ok(toks, 'a valid grammar over valid input must tokenize')
  assert.equal(toks.length, 3)
  for (const line of toks)
    assert.ok(
      line.every((t) => t.cls.includes('hljs-comment')),
      'every run of a block comment stays a comment, apostrophe and all',
    )
}

// Line count is preserved exactly, and so is the text of every line — the zip is
// what would slide, and it slides silently.
{
  const lines = [
    ctx('const a = 1'),
    del("const b = 'old'"),
    add("const b = 'new'"),
    add('const c = 2'),
    ctx('export { a, b }'),
  ]
  const toks = tokenizeDiff(lines, 'typescript')
  assert.ok(toks)
  assert.equal(toks.length, lines.length, 'one token array per source line')
  lines.forEach((l, i) => assert.equal(textOf(toks[i]!), l.text, `line ${i} round-trips`))
}

// A pure-addition hunk — a Write, the most common tool-card diff of all. The old
// side is empty, which must NOT read as a line-count mismatch.
{
  const lines = [add('function hi() {'), add("  return 'hi'"), add('}')]
  const toks = tokenizeDiff(lines, 'typescript')
  assert.ok(toks, 'an all-add hunk has no old side and that is not a mismatch')
  assert.equal(toks.length, 3)
  lines.forEach((l, i) => assert.equal(textOf(toks[i]!), l.text))
}

// The mirror: a pure deletion.
{
  const lines = [del('const gone = 1'), del('const also = 2')]
  const toks = tokenizeDiff(lines, 'typescript')
  assert.ok(toks)
  assert.equal(toks.length, 2)
}

// Blank lines survive as empty token arrays rather than collapsing, which is the
// other way the zip could slide.
{
  const lines = [ctx('const a = 1'), ctx(''), ctx('const b = 2')]
  const toks = tokenizeDiff(lines, 'typescript')
  assert.ok(toks)
  assert.equal(toks.length, 3)
  assert.deepEqual(toks[1], [], 'a blank line is an empty token array')
}

// Does not throw on an unregistered grammar. hljsLang already returns null for
// these, so this is defence in depth — but a throw here blanks the pane, and
// "the caller always checks first" is not a property anything enforces.
{
  assert.doesNotThrow(() => tokenizeDiff([ctx('object A')], 'scala'))
  assert.equal(tokenizeDiff([ctx('object A')], 'scala'), null)
  assert.equal(tokenizeDiff([ctx('x')], 'not-a-language'), null)
}

// Nothing to tokenize is null, not an empty array — the caller renders plain.
{
  assert.equal(tokenizeDiff([], 'typescript'), null)
}

console.log('highlight: ok')
