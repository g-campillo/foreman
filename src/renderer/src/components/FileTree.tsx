import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronRight, File, Folder, FolderOpen, Search } from 'lucide-react'
import type { FileList, SessionMeta } from '../../../shared/types'
import { buildTree, filterEntries, type TreeNode } from '../derive.mts'
import { useStore } from '../store'

/**
 * ⌘4. The project's files, and what changed in them.
 *
 * A tree rather than a flat list because a flat one is what the @-mention
 * popover already is, and it answers a different question: the popover is "find
 * the file I am naming", this is "show me the shape of the project". They share
 * the git call and nothing else.
 *
 * Collapsed by default, so only the root's children are ever in the DOM — which
 * is why there is no virtualisation here and does not need to be. Nobody hand
 * expands twenty thousand rows, and the filter box is the escape hatch for the
 * case where they would want to.
 */

interface Props {
  session: SessionMeta
  visible: boolean
}

/** A single porcelain code, collapsed to what the dot should mean. */
function statusOf(code: string | undefined): 'added' | 'changed' | null {
  if (!code) return null
  return code.includes('?') || code.includes('A') ? 'added' : 'changed'
}

export default function FileTree({ session, visible }: Props): React.JSX.Element {
  const [list, setList] = useState<FileList | null>(null)
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [query, setQuery] = useState('')
  const openFile = useStore((s) => s.openFile)
  const editorPath = useStore((s) => s.editor?.path ?? null)
  // The agent's writes already push this on every edit — the tree gets its
  // refresh signal for free rather than polling. Same hook DiffPanel rides.
  const bump = useStore((s) => s.diffCounts[session.id] ?? 0)

  const refresh = useCallback(() => {
    void window.foreman.fileTree(session.cwd).then(setList)
  }, [session.cwd])

  useEffect(() => {
    if (!visible) return
    refresh()
    // Anything the ⌘2 terminal or an external editor did lands on the way back
    // in. No watcher: this repo already learned what watching a tree does during
    // an `npm install`.
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [visible, refresh, bump])

  const tree = useMemo(() => buildTree(list?.paths ?? []), [list])

  // Filtering flattens deliberately: once you are searching, the hierarchy is
  // noise and the ranking is the answer. Reuses the palette's scorer rather than
  // growing a second one — same subsequence matching, same tie-breaks.
  const hits = useMemo(() => {
    if (!query.trim()) return null
    const entries = (list?.paths ?? []).map((p) => ({ label: p }))
    return filterEntries(entries, query).slice(0, 200).map((e) => e.label)
  }, [list, query])

  const row = (node: TreeNode, depth: number): React.JSX.Element[] => {
    const isDir = node.children !== undefined
    const expanded = open[node.path] ?? false
    const status = statusOf(list?.dirty?.[node.path])
    const abs = `${session.cwd}/${node.path}`

    const self = (
      <button
        key={node.path}
        className="ft-row"
        data-dir={isDir || undefined}
        data-active={!isDir && abs === editorPath}
        data-status={status ?? undefined}
        // Indent with padding rather than nested <ul>s: the rows stay siblings,
        // so a filtered flat list and a nested tree render through one component.
        style={{ paddingLeft: 6 + depth * 12 }}
        title={node.path}
        onClick={() => (isDir ? setOpen((o) => ({ ...o, [node.path]: !expanded })) : openFile(abs))}
      >
        {isDir ? (
          <>
            <ChevronRight size={12} className="ft-caret" data-open={expanded || undefined} />
            {expanded ? <FolderOpen size={13} /> : <Folder size={13} />}
          </>
        ) : (
          <File size={13} className="ft-file-icon" />
        )}
        <span className="ft-name">{node.name}</span>
        {status && <span className="ft-dot" />}
      </button>
    )

    return expanded && node.children
      ? [self, ...node.children.flatMap((c) => row(c, depth + 1))]
      : [self]
  }

  if (!list) return <div className="empty">Loading files…</div>

  return (
    <div className="ft">
      <div className="ft-search">
        <Search size={13} />
        <input
          value={query}
          placeholder="Filter files"
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          // Escape clears rather than closing the panel: the panel has its own
          // close button, and losing a filter is the cheaper of the two.
          onKeyDown={(e) => {
            if (e.key === 'Escape' && query) {
              e.stopPropagation()
              setQuery('')
            }
          }}
        />
      </div>

      <div className="ft-list">
        {hits
          ? hits.map((p) => {
              const abs = `${session.cwd}/${p}`
              const status = statusOf(list.dirty?.[p])
              return (
                <button
                  key={p}
                  className="ft-row"
                  data-active={abs === editorPath}
                  data-status={status ?? undefined}
                  style={{ paddingLeft: 6 }}
                  title={p}
                  onClick={() => openFile(abs)}
                >
                  <File size={13} className="ft-file-icon" />
                  {/* The whole path, because a bare filename is ambiguous the
                      moment a repo has two index.ts — and it usually does. */}
                  <span className="ft-name ft-path">{p}</span>
                  {status && <span className="ft-dot" />}
                </button>
              )
            })
          : tree.flatMap((n) => row(n, 0))}

        {hits?.length === 0 && <div className="empty">No match</div>}
        {!hits && tree.length === 0 && <div className="empty">No files</div>}
      </div>

      {/* A clipped popover is invisible and harmless; a clipped tree looks like
          the repo is missing files. Say so rather than quietly ending. */}
      {list.truncated && (
        <div className="ft-note">Showing the first {list.paths.length} files. Filter to narrow.</div>
      )}
    </div>
  )
}
