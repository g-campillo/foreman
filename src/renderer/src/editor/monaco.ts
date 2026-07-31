import { hex, raw, vars } from '../tokens'

/**
 * Monaco, loaded lazily and themed from theme.css.
 *
 * ── Import paths ──────────────────────────────────────────────────────────
 * monaco-editor 0.56 ships an `exports` map ("./*.js": "./esm/vs/*.js"), so the
 * `monaco-editor/esm/vs/...` specifier every tutorial still shows is now a hard
 * MODULE_NOT_FOUND. The paths below are the ones that actually resolve; verify
 * with `node -p "require.resolve('monaco-editor/editor/editor.worker.js')"`
 * before changing them.
 *
 * ── Workers ───────────────────────────────────────────────────────────────
 * These five `?worker` imports are cheap: each emits a small wrapper pointing at
 * a separately-built asset, so app boot pays nothing. Only `import('monaco-editor')`
 * below is the multi-megabyte chunk, and that waits for the first file open.
 *
 * Measured in the PACKAGED build (file://, the loadFile path — dev always passes
 * because its origin is http://localhost): Vite's default `?worker` output loads
 * fine under `worker-src 'self'`, and `?worker&inline` does NOT, because it
 * builds a blob: URL. See the comment on the CSP in index.html.
 *
 * All five are wired on purpose. With only the editor worker, opening a .ts file
 * asks for a `typescript` worker, silently falls through to the default branch,
 * gets an EditorWorker, and fails in a way that looks like a Monaco bug.
 */
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker'
import JsonWorker from 'monaco-editor/language/json/json.worker.js?worker'
import CssWorker from 'monaco-editor/language/css/css.worker.js?worker'
import HtmlWorker from 'monaco-editor/language/html/html.worker.js?worker'
import TsWorker from 'monaco-editor/language/typescript/ts.worker.js?worker'

export type Monaco = typeof import('monaco-editor')

let loading: Promise<Monaco> | null = null

/** Non-null once the chunk has landed, so a re-theme can skip awaiting. */
let cached: Monaco | null = null

export function loadedMonaco(): Monaco | null {
  return cached
}

export function loadMonaco(): Promise<Monaco> {
  if (loading) return loading

  // Assigned before the dynamic import, not at module scope: getWorker is read
  // lazily, but the ordering is not worth betting on.
  ;(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
    getWorker(_id: string, label: string): Worker {
      switch (label) {
        case 'json':
          return new JsonWorker()
        case 'css':
        case 'scss':
        case 'less':
          return new CssWorker()
        case 'html':
        case 'handlebars':
        case 'razor':
          return new HtmlWorker()
        case 'typescript':
        case 'javascript':
          return new TsWorker()
        default:
          return new EditorWorker()
      }
    },
  }

  loading = import('monaco-editor').then((monaco) => {
    // Monaco ships its own TypeScript service, and it does not know about the
    // project's tsconfig or its node_modules. Left on, every .ts file opens
    // under a wall of bogus "Cannot find module 'react'" squiggles.
    //
    // Syntax validation stays ON — that one is real and needs no project
    // context. The division is the same one the endgame wants anyway:
    // Monarch for colour, a real language server for meaning.
    //
    // `monaco.typescript`, NOT `monaco.languages.typescript`: 0.56 moved the
    // four language namespaces to the top level and left a `{ deprecated: true }`
    // stub at the old path. It typechecks as a property access either way, so
    // the old spelling fails at runtime with "cannot read setDiagnosticsOptions
    // of undefined" rather than at build time.
    for (const d of [monaco.typescript.typescriptDefaults, monaco.typescript.javascriptDefaults]) {
      d.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false })

      // And turn off its PROVIDERS, which is the half that actually bites.
      //
      // Switching off diagnostics alone leaves the built-in worker registering
      // hover, definition, references and the rest — and Monaco merges results
      // from every registered provider. The built-in one sees a single file
      // with no tsconfig and no node_modules, so on `render(...)` it answers
      // with the import binding one line up instead of the declaration in
      // another file. That is a *plausible* answer, which is why it took a raw
      // probe to catch: the language server was returning format.ts:1:17 the
      // whole time and go-to-definition still landed on the import.
      //
      // Everything below is now the real server's job. `codeLens: false` too:
      // its reference counts would be single-file and therefore wrong.
      d.setModeConfiguration({
        completionItems: false,
        hovers: false,
        documentSymbols: false,
        definitions: false,
        references: false,
        documentHighlights: false,
        rename: false,
        diagnostics: false,
        documentRangeFormattingEdits: false,
        signatureHelp: false,
        onTypeFormattingEdits: false,
        codeActions: false,
        inlayHints: false,
      })
    }
    // Before anything can call editor.create(). `editorOptions` names the theme
    // 'foreman', and Monaco silently falls back to its own `vs` default for a
    // theme that was never defined — which looks like "the theme is ignored"
    // rather than "the theme does not exist yet".
    applyTheme(monaco)
    cached = monaco
    return monaco
  })

  return loading
}

/**
 * The editor theme, built from the same six --syn-* tokens theme.css already
 * maps onto highlight.js for the transcript.
 *
 * That shared origin IS the unification. Rendering the transcript through Monaco
 * instead was considered and rejected: `monaco.editor.colorize()` is async and
 * per-call, and Markdown.tsx re-parses a message on every streamed token, so it
 * would fire a promise per code block per token — and it would couple the
 * transcript to this lazily-loaded chunk.
 *
 * Monarch does not emit a distinct "function" token, so --syn-fn under-fires
 * here relative to the transcript. That is semantic information a language
 * server provides, not something a grammar can know; it resolves when the LSP
 * lands rather than by inventing a rule for it.
 */
export function applyTheme(monaco: Monaco): void {
  const css = vars()
  // Read from the DOM rather than taking the resolved theme as an argument.
  // `applyAppearance` already writes it there, it is the same value the CSS
  // tokens above were just resolved against, and it keeps this whole module
  // free of a store import.
  const resolved = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
  const fg = (name: string): string => hex(css, name).slice(1) // rules[] want no '#'

  monaco.editor.defineTheme('foreman', {
    base: resolved === 'dark' ? 'vs-dark' : 'vs',
    // Everything not listed keeps a sane value from the base theme rather than
    // falling back to black-on-black.
    inherit: true,
    rules: [
      { token: 'comment', foreground: fg('--syn-comment'), fontStyle: 'italic' },
      { token: 'comment.doc', foreground: fg('--syn-comment'), fontStyle: 'italic' },
      { token: 'string', foreground: fg('--syn-str') },
      { token: 'string.escape', foreground: fg('--syn-str') },
      { token: 'regexp', foreground: fg('--syn-str') },
      { token: 'number', foreground: fg('--syn-num') },
      { token: 'number.hex', foreground: fg('--syn-num') },
      { token: 'constant', foreground: fg('--syn-num') },
      { token: 'keyword', foreground: fg('--syn-key') },
      // JSON property names come through as `key`, and reading them as strings
      // makes a config file one undifferentiated colour.
      { token: 'key', foreground: fg('--syn-key') },
      { token: 'type', foreground: fg('--syn-type') },
      { token: 'type.identifier', foreground: fg('--syn-type') },
      { token: 'tag', foreground: fg('--syn-type') },
      { token: 'attribute.name', foreground: fg('--syn-type') },
      { token: 'annotation', foreground: fg('--syn-fn') },
      { token: 'metatag', foreground: fg('--syn-fn') },
      { token: 'predefined', foreground: fg('--syn-fn') },
    ],
    colors: {
      // Transparent so the modal's own near-opaque surface shows through — the
      // same move xterm needs, for the same reason, with more surfaces to cover.
      'editor.background': '#00000000',
      'editorGutter.background': '#00000000',
      'minimap.background': '#00000000',
      'editor.lineHighlightBorder': '#00000000',
      'editor.foreground': hex(css, '--text'),
      'editorCursor.foreground': hex(css, '--accent'),
      // Neutral, not accent — --accent is near-white now, and a near-white
      // selection at 30% washes the selected code out instead of marking it.
      'editor.selectionBackground': hex(css, '--text', 0.22),
      'editor.lineHighlightBackground': hex(css, '--surface-3', 0.35),
      'editorLineNumber.foreground': hex(css, '--text-faint'),
      'editorLineNumber.activeForeground': hex(css, '--text-dim'),
      'editorIndentGuide.background1': hex(css, '--border'),
      'editorIndentGuide.activeBackground1': hex(css, '--border-strong'),
      'editorWhitespace.foreground': hex(css, '--text-faint', 0.35),
      // The app hides native scrollbars app-wide, but Monaco's is custom DOM and
      // is not reached by that rule. Kept — a long file in a tall modal needs a
      // position indicator — but toned down to read as the same design language.
      'scrollbarSlider.background': hex(css, '--text-faint', 0.18),
      'scrollbarSlider.hoverBackground': hex(css, '--text-faint', 0.28),
      'scrollbarSlider.activeBackground': hex(css, '--text-dim', 0.35),
      // These three are popovers OVER code. Transparency makes them unreadable,
      // so they are the deliberate exception to everything above.
      'editorWidget.background': hex(css, '--surface-2'),
      'editorWidget.border': hex(css, '--border-strong'),
      'editorSuggestWidget.background': hex(css, '--surface-2'),
      'editorSuggestWidget.selectedBackground': hex(css, '--accent', 0.22),
      'editorHoverWidget.background': hex(css, '--surface-2'),
      'editorStickyScroll.background': hex(css, '--surface'),
      'input.background': hex(css, '--surface-3'),
      'input.foreground': hex(css, '--text'),
    },
  })
  monaco.editor.setTheme('foreman')
}

/** Construction options, in one place so the modal reads as layout only. */
export function editorOptions(css = vars()): Record<string, unknown> {
  return {
    theme: 'foreman',
    fontFamily: raw(css, '--mono'),
    fontSize: 12.5,
    lineHeight: 19,
    // We own a ResizeObserver instead. Monaco's shared one does not help with a
    // container that can be zero-sized, and it will happily lay out to zero.
    automaticLayout: false,
    scrollBeyondLastLine: false,
    renderLineHighlight: 'gutter',
    renderWhitespace: 'selection',
    detectIndentation: true,
    // The three below are off for one reason: each is a per-frame cost the
    // editor pays whether or not you look at it. smoothScrolling animates every
    // wheel tick over several frames instead of one.
    smoothScrolling: false,
    padding: { top: 10, bottom: 10 },
    // Fights a deliberate six-colour palette — the brackets end up louder than
    // the keywords.
    bracketPairColorization: { enabled: false },
    // Nothing else in the app has a context menu, and Monaco's is a VS Code
    // menu full of commands this app does not implement.
    contextmenu: false,
    // A second full-document render, repainted on every edit and every scroll,
    // for a document you are already looking at in a near-fullscreen modal.
    minimap: { enabled: false },
    // Re-computes the enclosing scopes on every scroll frame.
    stickyScroll: { enabled: false },
    scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
  }
}
