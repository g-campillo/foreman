import { memo, useEffect, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'

/** Code blocks longer than this collapse behind a "show all" toggle. */
const LONG_BLOCK_LINES = 18

/**
 * A fenced code block: highlighted by rehype, plus copy and collapse.
 *
 * The line count is read off the DOM rather than the React children, because
 * rehype-highlight has already replaced the raw string with a tree of coloured
 * spans by the time this renders — textContent is the only place the original
 * text still exists in one piece, and it's what Copy needs anyway.
 */
function CodeBlock(props: React.HTMLAttributes<HTMLPreElement>): React.JSX.Element {
  const ref = useRef<HTMLPreElement>(null)
  const [lines, setLines] = useState(0)
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)

  // Deliberately no dependency array: the text changes on every streamed token.
  // Bailing out when the count is unchanged keeps this from looping.
  useEffect(() => {
    const n = ref.current?.textContent?.replace(/\n$/, '').split('\n').length ?? 0
    setLines((prev) => (prev === n ? prev : n))
  })

  const copy = (): void => {
    const text = ref.current?.textContent ?? ''
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    })
  }

  const long = lines > LONG_BLOCK_LINES
  return (
    <div className="code-wrap" data-collapsed={long && !expanded ? '' : undefined}>
      <pre ref={ref} {...props} />
      <div className="code-bar">
        {long && (
          <button className="code-btn" onClick={() => setExpanded((v) => !v)}>
            {expanded ? 'Collapse' : `Show all ${lines} lines`}
          </button>
        )}
        {/* `Show all N lines` above keeps its text — an icon can't render N. */}
        <button
          className="code-btn"
          onClick={copy}
          data-tip={copied ? 'Copied' : 'Copy this block'}
          aria-label={copied ? 'Copied' : 'Copy'}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </button>
      </div>
    </div>
  )
}

const COMPONENTS = {
  pre: CodeBlock,
  // Without target=_blank a click NAVIGATES THE RENDERER — the whole app is
  // replaced by the page and the session UI is gone. main's
  // setWindowOpenHandler turns the new-window request into shell.openExternal.
  a: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a {...props} target="_blank" rel="noreferrer" />
  ),
} as const

/**
 * Assistant markdown.
 *
 * ponytail: re-parses the whole message on every streamed token. Fine for
 * ordinary replies; if a very long message stutters mid-stream, throttle the
 * text prop rather than reaching for an incremental parser.
 */
function Markdown({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        // `detect` so blocks with no language tag still get highlighted, and
        // ignoreMissing so an unknown one degrades to plain text instead of throwing.
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={COMPONENTS}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

// Streaming re-renders the whole transcript on every token; without this, every
// earlier message re-parses its markdown too.
export default memo(Markdown)
