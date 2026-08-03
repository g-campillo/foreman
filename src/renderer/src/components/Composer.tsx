import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowUp,
  FolderOpen,
  FolderPlus,
  GitBranch,
  ListChecks,
  ListPlus,
  Moon,
  Pencil,
  Plus,
  SendToBack,
  ShieldCheck,
  ShieldOff,
  Square,
  X,
  Zap,
} from 'lucide-react'
import {
  PERMISSION_MODES,
  type Attachment,
  type BranchInfo,
  type BranchList,
  type EffortLevel,
  type ImageMediaType,
  type ModelInfo,
  type PermissionMode,
  type SendBlock,
  type SendContent,
  type SessionMeta,
  type SlashCommandInfo,
} from '../../../shared/types'
import { useStore } from '../store'
import { composerBox } from '../composerBox'
import { baseName, branchLabel, filterEntries, recentProjects, tildePath, triggerAt } from '../derive.mts'
import Autocomplete, { type Suggestion } from './Autocomplete'
import MarkdownInput from './MarkdownInput'
import type { MenuItem } from './Menu'
import Picker from './Picker'
import { ContextCard, ContextRing } from './ContextRing'
import { BackgroundTaskCard, BackgroundTaskTray } from './BackgroundTasks'
import QueueTray from './QueueTray'
import { useContextUsage } from '../useContextUsage'

/* The CURRENT sentinel lived here — a fake <option> for "whatever the session is
   already running" when no alias matched, because a native select cannot show a
   value that is not one of its options. The menu just renders the label. */

/** Mirrors ImageMediaType; anything else is silently not attachable. */
const ACCEPTED: readonly ImageMediaType[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

/** null = leave the SDK's own default alone. 'max' is session-scoped.
 *  Values are the SDK's EffortLevel strings; only the labels are ours. */
export const EFFORTS: { value: EffortLevel | ''; label: string }[] = [
  { value: '', label: 'Auto' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
  { value: 'max', label: 'Max' },
]

/** Cap on suggestions rendered at once — a 4000-file repo must not build 4000 rows. */
const MAX_SUGGESTIONS = 50

/** What a message SAYS, images dropped — branchLabel wants prose and an image
 *  block carries a quarter-megabyte of base64. flatMap rather than filter,
 *  because a filter does not narrow the SendBlock union. */
const textOf = (content: SendContent): string =>
  typeof content === 'string'
    ? content
    : content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join(' ')

/** Drop a trailing context-window suffix: 'claude-opus-5[1m]' -> 'claude-opus-5'.
 *  Exported so the empty chat state resolves a display name the same way the
 *  model picker below does. */
export const bareModel = (id: string | null | undefined): string =>
  (id ?? '').replace(/\[[^\]]*\]$/, '')

/**
 * The model a wire id names: `claude-opus-5[1m]` -> `Opus 5`,
 * `claude-haiku-4-5` -> `Haiku 4.5`, `claude-3-5-sonnet-20241022` -> `Sonnet 3.5`.
 *
 * Name and version, nothing else. The `[1m]` bracket is a window size rather
 * than a version, and how much window is left now has its own readout under the
 * composer — repeating it in every label was noise.
 *
 * Derived from the wire id rather than the SDK's `displayName` because the wire
 * id is what `SessionMeta.model` actually holds, so this answers "what am I
 * running" with no lookup into the model list.
 */
export const modelName = (id: string | null | undefined): string => {
  const parts = bareModel(id)
    .replace(/^claude-/, '')
    .split('-')
    .filter(Boolean)
  if (!parts.length) return ''
  // First non-numeric part is the name: dated ids put the version first
  // ('3-5-sonnet-…'), current ones put it last ('haiku-4-5').
  const name = parts.find((p) => !/^\d+$/.test(p)) ?? parts[0]
  // Five digits or more is a release datestamp, not a version component.
  const version = parts.filter((p) => /^\d{1,4}$/.test(p)).join('.')
  const cap = name[0].toUpperCase() + name.slice(1)
  return version ? `${cap} ${version}` : cap
}

/** The context-window bracket as a badge: `claude-opus-5[1m]` -> `1M`. */
const windowTag = (m: ModelInfo): string =>
  ((m.resolvedModel || m.id) ?? '').match(/\[([^\]]+)\]$/)?.[1].toUpperCase() ?? ''

/** A displayName without its parenthetical: `Opus 5 (1M context)` -> `Opus 5`. */
const plainName = (s: string): string => s.replace(/\s*\([^)]*\)\s*$/, '').trim()

/* Path split for the browse popover. String arithmetic rather than node:path,
   which the renderer does not have — the preload surface is IPC only. Both keep
   a directory's trailing slash on the NAME, so the list says `Downloads/`. */
const baseOf = (p: string): string => p.slice(stem(p).lastIndexOf('/') + 1)
const dirOf = (p: string): string => {
  const s = stem(p)
  return s.slice(0, s.lastIndexOf('/')) || '/'
}
const stem = (p: string): string => (p.endsWith('/') ? p.slice(0, -1) : p)

/**
 * Labels for every picker row, computed over the whole list — because two
 * <option>s that render identically are indistinguishable, and uniqueness is not
 * a property any single row can see.
 *
 * The base label is `modelName(resolvedModel)`, so a row is spelled exactly the
 * way the context strip spells the running model. Two exceptions:
 *
 *  - When the SDK's own name says something the wire id cannot — the
 *    `Default (recommended)` row, whose alias resolves to some other model — it
 *    is kept as a prefix. Stripping it would leave Default rendering as a bare
 *    `Opus 5` that both collides with the real Opus row and loses the one word
 *    identifying it. The test is mechanical: if the SDK's name already names the
 *    model, it adds nothing.
 *  - When two rows still collapse — `Opus 5` and `Opus 5 (1M context)` both name
 *    Opus 5 — the colliding rows get the window tag back. Only the colliding
 *    ones: tagging unconditionally would re-add the suffix this exists to remove.
 */
export const modelLabels = (all: readonly ModelInfo[]): string[] => {
  const base = all.map((m) => {
    const name = modelName(m.resolvedModel)
    if (!name) return m.displayName || m.id
    const own = plainName(m.displayName)
    // Containment, not equality: the alias rows are named 'Opus'/'Haiku', which
    // an equality test treats as new information and renders 'Opus · Opus 5'.
    // Only a name the derived one does NOT already contain is worth keeping —
    // in practice that is the 'Default' row, whose whole identity is that word.
    return name.toLowerCase().includes(own.toLowerCase()) ? name : `${own} · ${name}`
  })
  const counts = new Map<string, number>()
  for (const b of base) counts.set(b, (counts.get(b) ?? 0) + 1)
  // Only the row that actually HAS a window gets tagged — the standard-window
  // twin stays bare, so a collision reads `Opus 5` / `Opus 5 · 1M` rather than
  // tagging both and inventing a distinction for the ordinary one.
  return base.map((b, i) =>
    (counts.get(b) ?? 0) > 1 && windowTag(all[i]) ? `${b} · ${windowTag(all[i])}` : b,
  )
}

/** How each mode is spelled, everywhere. A Record rather than a list, so a sixth
 *  mode added to PERMISSION_MODES cannot ship without being labelled — the same
 *  exhaustiveness MODE_ICON already had. */
const MODE_LABEL: Record<PermissionMode, string> = {
  default: 'Ask',
  acceptEdits: 'Accept edits',
  plan: 'Plan',
  bypassPermissions: 'Bypass',
  dontAsk: "Don't ask",
}

/** Exported so the command palette and Settings offer the same modes, spelled
 *  the same way. Derived from the shared array rather than written out again,
 *  because ⇧Tab cycles that array and a second ordering here would mean the
 *  menu and the keyboard disagreed about what comes next. */
export const MODES: { value: PermissionMode; label: string }[] = PERMISSION_MODES.map((value) => ({
  value,
  label: MODE_LABEL[value],
}))

/** Separate from MODES rather than a field on it, because the command palette
 *  renders its mode entries as text rows and would import lucide for nothing.
 *
 *  Exported, unlike when only this file used it: Settings shows the same five
 *  modes in the same Picker, and a second table of glyphs there is a second
 *  place for a sixth mode to be forgotten. The palette still takes MODES alone. */
export const MODE_ICON: Record<PermissionMode, React.ReactNode> = {
  default: <ShieldCheck size={14} />,
  acceptEdits: <Pencil size={14} />,
  plan: <ListChecks size={14} />,
  bypassPermissions: <Zap size={14} />,
  dontAsk: <ShieldOff size={14} />,
}

/**
 * The two modes the pill tints, and what it says about them.
 *
 * Partial on purpose, and covering exactly two of five. The argument is NOT
 * "these are dangerous" — acceptEdits is too — it is that these are the two
 * where THE PILL IS THE ONLY REMAINING SIGNAL. Bypass suppresses the approval
 * card, which is how the app normally tells you something consequential is
 * happening; dontAsk suppresses it too AND produces tool failures that read as
 * bugs. Every other mode still announces itself by prompting you.
 *
 * Tinting three of five would be the same as tinting none.
 */
const MODE_TONE: Partial<Record<PermissionMode, 'warn' | 'danger'>> = {
  bypassPermissions: 'danger',
  dontAsk: 'warn',
}

/** The trailing text on those same two rows. Exported for the same reason as
 *  MODE_ICON: the picker in Settings is the same picker. */
export const MODE_HINT: Partial<Record<PermissionMode, string>> = {
  bypassPermissions: 'no prompts at all',
  dontAsk: 'denies anything not pre-approved',
}

/* STARTERS lived here: `Plan first` and `Accept edits` chips under the empty
   composer, plus a `New worktree` one beside them. All three were a third row of
   chrome on the one shape that should be smallest — and every one of them said
   something the status row below already says, or now offers as a control. Mode
   is on the mode picker, on ⇧Tab and in the command palette; the worktree is a
   checkbox on the picker bar. */

/**
 * What is open in the composer's one card slot, if anything.
 *
 * ONE SLOT, not a boolean per card. The context breakdown and a background
 * task's detail card are both full-width panels that float directly above the
 * composer, and two independent flags would let both open at once — pushing the
 * composer down the pane and moving send out from under the pointer that just
 * opened one of them. A single nullable state makes that unrepresentable.
 */
type Panel = { kind: 'context' } | { kind: 'task'; taskId: string } | null

/* The `Attachment` interface lived here. It is in shared/types.ts now, because
   the store parks it in a per-session draft and could not import it from a
   component it is itself imported by. Only the four types the API accepts ever
   become one — see ACCEPTED above. */

export default function Composer({ session }: { session: SessionMeta }): React.JSX.Element {
  const send = useStore((s) => s.send)
  const models = useStore((s) => s.models)
  // Computed over the whole list rather than per row, because disambiguating a
  // collision means knowing what the other rows render as.
  const modelRows = useMemo(() => modelLabels(models), [models])
  const close = useStore((s) => s.close)
  const wake = useStore((s) => s.wake)
  const openPath = useStore((s) => s.openPath)
  const openProject = useStore((s) => s.openProject)
  // Only for the picker's pre-first-turn fallback: the session was created with
  // this model, but meta.model stays null until an assistant message reports one.
  const prefs = useStore((s) => s.prefs)
  /** Nothing said yet, so the session can still be recreated somewhere else. */
  const fresh = useStore((s) => (s.items[session.id]?.length ?? 0) === 0)
  // For the project picker. Seeded from live sessions only — Home and
  // ProjectChooser also fold in past sessions, but those need an IPC fetch and
  // the composer is not a place to pay for one on every session switch.
  const sessions = useStore((s) => s.sessions)
  const hiddenProjects = useStore((s) => s.hiddenProjects)
  /** Live branch, kept fresh by the diff panel. worktree.branch is frozen at
   *  creation and lies after a checkout, so it is only the fallback. */
  const branch = useStore((s) => s.branches[session.id] ?? null)
  const checkoutBranch = useStore((s) => s.checkoutBranch)
  /* The pickable list, read on every menu open and never cached — see the
     Picker's `onOpen`. Kept between opens so re-opening does not flash an empty
     menu, and cleared on a session change so the last project's branches never
     appear under this one's.

     The WHOLE BranchList, not just its rows: `detachedAt` is the only place a
     detached HEAD's sha reaches the renderer at all. The store's `branches[id]`
     comes from `readStatus`, which uses `branch --show-current` and prints
     nothing when detached — so without this the label reads `no branch` and the
     sha you need to get back to your commits is nowhere on screen. */
  const [branchList, setBranchList] = useState<BranchList | null>(null)
  const branches = branchList?.branches ?? []
  useEffect(() => setBranchList(null), [session.cwd])
  const loadBranches = (): void => {
    void window.foreman.listBranches(session.cwd).then(setBranchList)
  }
  /* Fetched here rather than inside the ring, because the ring and the card it
     opens are siblings — the ring sits under the composer, the card floats above
     it, so neither can own the poll for the other. */
  const { view: usage } = useContextUsage(session)
  const [panel, setPanel] = useState<Panel>(null)
  const picker = useRef<HTMLInputElement>(null)
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [caret, setCaret] = useState(0)
  const [cursor, setCursor] = useState(0)
  const [commands, setCommands] = useState<SlashCommandInfo[]>([])
  const [files, setFiles] = useState<string[]>([])
  /** Directory listing for a mention that points outside the project. */
  const [browsed, setBrowsed] = useState<string[]>([])
  /**
   * The session whose Worktree box is ticked, or null.
   *
   * KEYED BY SESSION ID rather than a bare boolean, because App renders one
   * unkeyed `<Composer>` — a boolean would stay ticked across a session switch
   * and silently branch the wrong conversation on its first message.
   */
  const [wantFor, setWantFor] = useState<string | null>(null)
  const setComposerDirty = useStore((s) => s.setComposerDirty)
  const saveDraft = useStore((s) => s.saveDraft)
  const dropDraft = useStore((s) => s.dropDraft)

  /**
   * The session can still be moved into a worktree: nothing said yet, not
   * already in one, and it HAS a host to move.
   *
   * `!session.asleep` is the load-bearing third clause. `fresh` is
   * `items.length === 0`, which is true of an asleep row while its transcript is
   * still being read — and permanently if sessionTranscript comes back empty,
   * which it does on any read error. Ticking the box then ran hopThenSend:
   * a brand-new empty session, followed by `close()` on the asleep one. The
   * conversation being read would vanish and be replaced by an empty one.
   */
  const canWorktree = fresh && !session.worktree && !session.asleep
  /** Ticked for THIS session, and it still has somewhere to go. */
  const wantWorktree = wantFor === session.id && canWorktree

  const busy = session.status === 'running' || session.status === 'awaiting-approval'
  /** Nothing to send. Drives both the disabled state and its tooltip. */
  const empty = !text.trim() && attachments.length === 0

  /* Mirrored into the store as a FLAG, never as the text: the approval card has
     to know whether stealing focus would interrupt something, and that is one
     bit. Lifting `text` itself would put a store write on every keystroke and
     notify every subscriber in the app; this writes at most twice per message,
     because setComposerDirty short-circuits when nothing flipped. */
  useEffect(() => setComposerDirty(!empty), [empty, setComposerDirty])

  /* PER-SESSION DRAFTS, without a store write per keystroke.

     `text`, `attachments` and `caret` stay exactly where they were — local
     state — and the store is touched only when the session under the composer
     changes. This ref is what makes that possible: written during render, so the
     effect below can read the OUTGOING session's contents without listing them
     in its deps and re-running on every character.

     Safe to write here because the session change does not touch `text`: the
     render that first sees the new session still holds the old one's draft,
     which is precisely what has to be filed away. */
  const live = useRef({ text, attachments, caret })
  live.current = { text, attachments, caret }
  const shown = useRef(session.id)

  useEffect(() => {
    const prev = shown.current
    if (prev === session.id) return
    shown.current = session.id
    // Not for a session that has gone away under us — which is exactly what the
    // worktree hop does, closing the old conversation the moment the new one is
    // open. Filing its draft would leave a row nothing can ever read again.
    if (useStore.getState().sessions.some((x) => x.id === prev)) saveDraft(prev, live.current)
    // getState rather than a subscription: this reads the map exactly once per
    // switch, and subscribing would re-render the composer whenever any OTHER
    // session's draft was filed.
    const next = useStore.getState().drafts[session.id]
    setText(next?.text ?? '')
    setAttachments(next?.attachments ?? [])
    setCaret(next?.caret ?? 0)
  }, [session.id, saveDraft])

  // Commands are fixed for the session's lifetime, so once is enough.
  useEffect(() => {
    setCommands([])
    setFiles([])
    void window.foreman.supportedCommands(session.id).then(setCommands)
  }, [session.id])

  const trigger = triggerAt(text, caret)
  const mentioning = trigger?.kind === 'file'

  // Files are NOT fixed — the agent creates them mid-session, and those are
  // exactly the ones you want to mention. Refetched when a mention opens rather
  // than once per session, which is one git call per `@` typed, not per keystroke.
  useEffect(() => {
    if (mentioning) void window.foreman.projectFiles(session.id, session.cwd).then(setFiles)
  }, [mentioning, session.id, session.cwd])

  /** The mention has left the project: `@/Users/…` or `@~/…`. Null otherwise. */
  const browsing = mentioning && /^[~/]/.test(trigger.query) ? trigger.query : null

  // The project's file list structurally cannot answer these — `git ls-files`
  // only ever emits paths inside the repo — so they get their own source, which
  // completes one directory at a time.
  //
  // Refetched per keystroke rather than once per `@`, unlike the branch above,
  // because the query IS the directory: there is nothing to cache across it.
  // That is a local readdir of a single directory, so no debounce. `live` guards
  // the out-of-order resolve that fast typing would otherwise produce.
  useEffect(() => {
    if (browsing === null) {
      setBrowsed([])
      return
    }
    let live = true
    void window.foreman.browsePath(browsing).then((p) => {
      if (live) setBrowsed(p)
    })
    return () => {
      live = false
    }
  }, [browsing])

  /** Showing the predicted next prompt as an overlay on the empty input. */
  const ghost = !text && !busy && session.promptSuggestion

  const suggestions = useMemo<Suggestion[]>(() => {
    if (!trigger) return []
    // Already prefix-matched against a real directory in main, and already
    // sorted. filterEntries would re-filter what is correct and, worse, reorder
    // it by subsequence score — so this branch skips it. Name in front, folder
    // behind: an absolute path is mostly prefix, and the tail is what you read.
    if (browsing !== null) {
      return browsed
        .map((p) => ({ value: `@${p}`, label: baseOf(p), hint: dirOf(p) }))
        .slice(0, MAX_SUGGESTIONS)
    }
    const pool: Suggestion[] =
      trigger.kind === 'command'
        ? commands.map((c) => ({
            value: `/${c.name}`,
            label: `/${c.name}`,
            hint: c.argumentHint || c.description,
          }))
        : files.map((f) => ({ value: `@${f}`, label: f }))
    return filterEntries(pool, trigger.query).slice(0, MAX_SUGGESTIONS)
  }, [trigger?.kind, trigger?.query, commands, files, browsing, browsed])

  // A stale cursor would insert the wrong completion once the list shrinks.
  useEffect(() => setCursor(0), [trigger?.query, trigger?.kind])

  const pick = (s: Suggestion): void => {
    if (!trigger) return
    // A directory completes to itself and keeps the mention OPEN, so the next
    // segment can be typed straight away. The trailing space that normally ends
    // a mention would end the trigger on a half-typed path — and browsePath
    // marks directories with the trailing slash precisely so this can tell.
    const tail = s.value.endsWith('/') ? '' : ' '
    // Replace from the trigger character to the caret, keeping whatever the
    // user had already typed after it.
    const next = `${text.slice(0, trigger.start)}${s.value}${tail}${text.slice(caret)}`
    const pos = trigger.start + s.value.length + tail.length
    setText(next)
    setCaret(pos)
    // The editor syncs both from props; it just needs the focus back, since the
    // click that picked the suggestion took it.
    requestAnimationFrame(() => composerBox.current?.focus())
  }

  const submit = (): void => {
    const t = text.trim()
    if (!t && attachments.length === 0) return

    /* pinToBottom() used to fire here. It lives in the store's onQueue handler
       now, on the 'started' edge — a queued message no longer enters the
       transcript at all, so on the busy path there was nothing at the bottom to
       scroll to and the pin only stole the reader's place in the answer. */

    // Stay a plain string unless there's actually something attached — the
    // block form is only needed for images.
    const content = attachments.length
      ? ([
          ...attachments.map(
            (a): SendBlock => ({
              type: 'image',
              source: { type: 'base64', media_type: a.mediaType, data: a.data },
            }),
          ),
          ...(t ? [{ type: 'text', text: t } as SendBlock] : []),
        ] as SendBlock[])
      : t

    if (wantWorktree) {
      void hopThenSend(content)
      return
    }

    // Sending is the only thing that needs an agent, so it is the only thing
    // that starts one. Reading the conversation costs nothing.
    if (session.asleep) {
      void wakeThenSend(content)
      return
    }

    void send(content)
    clearDraft()
  }

  /**
   * The asleep conversation, woken by the message that needs it.
   *
   * WAKE, THEN SEND — the same create-then-act ordering hopThenSend uses below
   * and for the same reason: if starting the host fails, the draft and the
   * attachments are all still here and the notice says why.
   *
   * The id is passed EXPLICITLY rather than left to the store's activeId. Waking
   * boots a host, a CLI and an MCP fleet — seconds — and wake() repoints
   * activeId only if the user has not moved in the meantime. Without this, one
   * rail click during the wait delivers the message to whichever conversation
   * they moved to.
   */
  const wakeThenSend = async (content: SendContent): Promise<void> => {
    const woken = await wake(session.id)
    if (!woken) return
    await send(content, woken.id)
    clearDraft()
  }

  /** Empties the field AND the session's parked copy — a sent message must not
   *  come back when you switch away and return. */
  const clearDraft = (): void => {
    setText('')
    setAttachments([])
    setCaret(0)
    dropDraft(session.id)
  }

  /**
   * The Worktree checkbox, cashed in on the first message.
   *
   * Ticking the box is INTENT, not an action: a session's cwd is decided by
   * createSession and never changes, so "run this in a worktree" is really
   * close-and-reopen, and doing that the moment a checkbox is clicked would
   * destroy and rebuild a session for a box the user might untick again.
   *
   * CREATE, THEN CLOSE — the order is the whole of it, and the reverse was a
   * live bug. `createWorktree` refuses a branch that already exists, and
   * `removeWorktree` never deletes the branch ref, so a second attempt with the
   * same session title fails for perfectly ordinary reasons. Closing first left
   * you with ZERO sessions and a red notice: the conversation was already gone
   * by the time the failure was known. This way a failure costs nothing — the
   * session, the draft and the attachments are all still here, and openPath has
   * already put git's reason in the rail notice.
   *
   * The new session's id IS threaded through to `send`, where this used to lean
   * on the store's activeId. openPath does repoint it — but a rail click between
   * the create and the send would repoint it again, and the message would land
   * in someone else's conversation. The message itself is `content`, captured
   * before any of this — it does NOT ride on the composer's text, which the
   * per-session draft swap clears the moment the session changes under it.
   */
  const hopThenSend = async (content: SendContent): Promise<void> => {
    // Not a worktree yet, so cwd is the project directory — the right base. The
    // branch name is derived rather than prompted: a checkbox that opens a text
    // field isn't a checkbox. Never blank — branchSlug('') makes a degenerate ref.
    //
    // FROM THE MESSAGE, not from `session.title`. The title of a fresh
    // conversation is `basename(cwd)`, so every worktree in a project asked for
    // the same branch and the second one failed outright. What the user just
    // typed is both unique enough and the only thing on screen that says what
    // this agent is for. The title falls in behind it for the rare message with
    // no words in it at all — see branchLabel.
    const name =
      branchLabel(textOf(content)) || session.title?.trim() || `session-${Date.now().toString(36)}`
    const moved = await openPath(session.cwd, name)
    if (!moved) return

    await close(session.id)
    await send(content, moved.id)
    setWantFor(null)
    clearDraft()
  }

  const addFiles = (list: FileList | File[]): void => {
    for (const file of Array.from(list)) {
      // Rejected here rather than at send time, so an unsupported paste says so
      // immediately instead of failing a turn later.
      if (!ACCEPTED.includes(file.type as ImageMediaType)) continue
      const reader = new FileReader()
      reader.onload = () => {
        // readAsDataURL gives "data:<mime>;base64,<data>"; the wire wants the
        // media type and the payload separately.
        const [, data] = String(reader.result).split(',')
        if (!data) return
        setAttachments((a) => [
          ...a,
          {
            id: crypto.randomUUID(),
            mediaType: file.type as ImageMediaType,
            data,
            name: file.name || 'pasted image',
          },
        ])
      }
      reader.readAsDataURL(file)
    }
  }

  /* `goWorktree` lived here — the close-then-reopen the menu row and the chip
     both called. It is `hopThenSend` above now, deferred to the first message
     and with the two halves the other way round; see its docblock for why the
     order was a bug rather than a preference. */

  /** Accepting the predicted prompt has to move the caret too, or it lands at 0. */
  const acceptGhost = (): void => {
    const s = session.promptSuggestion ?? ''
    setText(s)
    setCaret(s.length)
    composerBox.current?.focus()
  }

  // ------------------------------------------------------------------ menus

  /* `compact` lived here — the boolean that gave a fresh session a tall, wrapped
     three-row card and everything after it a single-row pill. There is one shape
     now, the small one. The tall form was never carrying anything the pill does
     not: the settings moved to the status row a release ago, the starter chips
     are gone, and what was left was a 60px-minimum empty box on the one screen
     with nothing in it. The field grows to 140px as you type either way. */

  const root = session.worktree?.repoRoot ?? session.cwd
  const projectName = baseName(root) || 'project'
  const stemPath = (p: string): string => (p.endsWith('/') ? p.slice(0, -1) : p)

  const recents = useMemo(
    () => recentProjects(sessions, [], hiddenProjects).slice(0, 8),
    [sessions, hiddenProjects],
  )

  const projectItems: MenuItem[] = [
    ...recents.map((p) => ({
      id: p.hint,
      label: p.label,
      // `~/code/foreman`. The id and the checked test stay on the RAW path —
      // this is a display string, and matching on it would compare a shortened
      // path against an absolute `root`.
      hint: tildePath(p.hint, window.foreman.homeDir),
      icon: <FolderOpen size={14} />,
      checked: stemPath(p.hint) === stemPath(root),
      onSelect: () => void openPath(p.hint),
    })),
    { kind: 'divider' as const },
    {
      id: 'browse',
      label: 'Browse…',
      icon: <FolderPlus size={14} />,
      onSelect: () => void openProject(),
    },
  ]

  /* `detached at <sha>` rather than a bare `no branch` once the list has been
     read: on a detached HEAD that sha is the ONLY way back to the commits you
     are standing on, and git's own status says it in those words. Still falls
     back to `no branch` before the first read, which is all the store's null
     branch can honestly claim. */
  /* Named for what it holds rather than where it is drawn: `branchLabel` is the
     derivation that names a NEW branch from a message, imported above. */
  const currentBranch =
    branch ??
    session.worktree?.branch ??
    (branchList?.detachedAt ? `detached at ${branchList.detachedAt}` : 'no branch')

  /* One row per branch. The remote arm passes `b.remote` straight through, and
     main matches BOTH fields against a fresh enumeration before building argv —
     so a row is a request to switch to something git itself just named, not a
     string this component invented. */
  const branchRow = (b: BranchInfo): MenuItem => ({
    // The full refname: unique across local and remote, where `name` is not.
    id: b.ref,
    label: b.name,
    icon: <GitBranch size={14} />,
    checked: b.current,
    // Git refuses to check a branch out in two worktrees at once, so the row is
    // dead and says where the other copy is rather than failing on click.
    hint: b.checkedOutAt ?? undefined,
    disabled: !!b.checkedOutAt,
    onSelect: () => void checkoutBranch(session.cwd, b.name, b.remote),
  })

  const localBranches = branches.filter((b) => !b.remote)
  const remoteBranches = branches.filter((b) => b.remote)
  const branchItems: MenuItem[] =
    localBranches.length || remoteBranches.length
      ? [
          ...(localBranches.length
            ? [{ kind: 'section' as const, label: 'Local' }, ...localBranches.map(branchRow)]
            : []),
          ...(remoteBranches.length
            ? [
                { kind: 'divider' as const },
                { kind: 'section' as const, label: 'Remote' },
                ...remoteBranches.map(branchRow),
              ]
            : []),
        ]
      : // Before the first read resolves, and for a cwd that is not a repository
        // at all. A menu that opens empty reads as broken; this reads as loading.
        [
          { kind: 'section' as const, label: 'Branch' },
          { id: 'current', label: currentBranch, icon: <GitBranch size={14} />, checked: true },
        ]

  const current =
    models.find((m) => m.resolvedModel === session.model) ??
    (session.model
      ? models.find((m) => bareModel(m.resolvedModel) === bareModel(session.model))
      : models.find((m) => m.id === (prefs.model || 'default')))
  const effortLabel = EFFORTS.find((e) => e.value === (session.effort ?? ''))?.label ?? 'Auto'
  // modelName reads the wire id, which is null until the first turn reports one —
  // so the row label for the session's configured default is the fallback.
  const modelText =
    modelName(session.model) ||
    (current ? modelRows[models.indexOf(current)] : (session.model ?? 'Loading…'))
  /** Effort rides on the model label rather than taking a second control, which
   *  is how Cursor folds thinking level into the model name. 'Auto' is the
   *  default and says nothing, so it stays off the trigger. */
  const modelLabel = session.effort ? `${modelText} · ${effortLabel}` : modelText

  const modelItems: MenuItem[] = [
    ...models.map((m, i) => ({
      id: m.id,
      label: modelRows[i],
      checked: m.id === current?.id,
      onSelect: () => void window.foreman.setModel(session.id, m.id),
    })),
    { kind: 'divider' as const },
    { kind: 'section' as const, label: 'Effort' },
    ...EFFORTS.map((e) => ({
      id: `effort-${e.value || 'auto'}`,
      label: e.label,
      checked: (session.effort ?? '') === e.value,
      onSelect: () => void window.foreman.setEffort(session.id, e.value || null),
    })),
  ]

  /* The modes lived inside the `+` menu for one release, and that was the whole
     bug: a `+` glyph reads as "attach a file", the menu had no section header,
     and nothing in the window said which mode was live. The feature was alive
     and invisible. They are a labelled trigger on the toolbar now — bottom-left,
     which is where Cursor puts its own mode control and the mirror of the model
     picker on the right. No section header in the menu: the trigger already
     reads `Plan ⌄`. */
  const modeItems: MenuItem[] = MODES.map((m) => ({
    id: m.value,
    label: m.label,
    icon: MODE_ICON[m.value],
    hint: MODE_HINT[m.value],
    checked: session.permissionMode === m.value,
    onSelect: () => void window.foreman.setPermissionMode(session.id, m.value),
  }))

  /* The four status pickers. Each carries a placement class, because they now
     all live on ONE row and the row has to decide which of them gives width
     first — see `.composer-bar` in theme.css.

     None of them passes `align` any more. They sit at the LEFT of a row at the
     foot of the window, where `align="right"` computes a negative x and clamps
     to the window edge — the menu ends up under the rail rather than under its
     trigger. Menu already flips upward on its own for a control this low, which
     the branch picker has been proving since it moved down here. */
  const projectPicker = (
    <Picker
      className="composer-project"
      icon={<FolderOpen size={12} />}
      label={projectName}
      items={projectItems}
      ariaLabel="Project"
      tip="Project — pick another to start a session there"
      search={recents.length > 6}
      searchPlaceholder="Find a project…"
    />
  )
  const branchPicker = (
    <Picker
      className="composer-branch"
      icon={<GitBranch size={12} />}
      label={currentBranch}
      items={branchItems}
      ariaLabel="Branch"
      tip="Branch this session is working on — pick another to check it out"
      onOpen={loadBranches}
      /* No `search` prop, unlike the project and model pickers: those count a
         list they already hold, and this one's arrives after the menu is open.
         Counting `branches` here would be deciding from state one render behind
         the rows actually drawn — Menu's own `items.length >= SEARCHABLE`
         default is measured against exactly what it renders. */
      searchPlaceholder="Find a branch…"
    />
  )
  /* Effort rides on the model label rather than taking a second control — see
     `modelLabel`. It used to sit inside the card next to send; on the status row
     it is beside the mode, which is the other thing that decides what the next
     turn actually does. */
  const modelPicker = (
    <Picker
      className="composer-model"
      label={modelLabel}
      items={modelItems}
      ariaLabel="Model and reasoning effort"
      tip="Model, and how long it thinks before answering"
      search={models.length > 6}
      searchPlaceholder="Find a model…"
    />
  )
  /* The live permission mode, always on screen. Its label is the whole point of
     the feature — there is deliberately NO icon-only fallback at narrow widths,
     because that would reintroduce the exact "which one is on?" problem this
     exists to fix. It is last in the row and the last to give width: the shrink
     weights in `.composer-bar` make branch and model ellipsis first, and this
     one never truncates. */
  const modePicker = (
    <Picker
      className="composer-mode"
      icon={MODE_ICON[session.permissionMode]}
      label={MODE_LABEL[session.permissionMode]}
      items={modeItems}
      tone={MODE_TONE[session.permissionMode]}
      ariaLabel="Permission mode"
      tip="What the agent may do without asking  ⇧Tab"
    />
  )

  /* Outside the card, above it. Cursor's tray is its `__header`, absolutely
     positioned clear of the input — in the card it would break the compact
     single row, and it is status rather than part of the field.

     The chips' markup and their 1s clock live in BackgroundTasks.tsx: a ticker
     here would repaint the editor and every open menu once a second. */
  const bgTray = session.backgroundTasks.length > 0 && (
    <BackgroundTaskTray
      session={session}
      openTask={panel?.kind === 'task' ? panel.taskId : null}
      onOpen={(taskId) => setPanel(taskId ? { kind: 'task', taskId } : null)}
    />
  )

  /* DERIVED from the live set rather than held as its own state, so a task that
     finishes takes its card away with it — the level drops the id, this resolves
     to undefined, and nothing renders. An effect that closed the card on the
     same event would be a second writer of the same fact, racing the first. */
  const openTask =
    panel?.kind === 'task'
      ? session.backgroundTasks.find((t) => t.taskId === panel.taskId)
      : undefined

  return (
    <div className="composer">
      {attachments.length > 0 && (
        <div className="attachments">
          {attachments.map((a) => (
            <span key={a.id} className="chip">
              <img src={`data:${a.mediaType};base64,${a.data}`} alt="" />
              {a.name}
              <button
                data-tip={`Remove ${a.name}`}
                aria-label={`Remove ${a.name}`}
                onClick={() => setAttachments((list) => list.filter((x) => x.id !== a.id))}
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}

      {bgTray}

      {/* Same slot, and for the same reason: what is queued is status about the
          composer, not part of the field. Its own component so its editor state
          cannot force a composer re-render. */}
      <QueueTray sessionId={session.id} />

      {/* THE ONE CARD SLOT — see the Panel type. The `compact &&` gate is gone
          with it: the ring exists in both shapes now, so a card that could only
          open in one of them was a control whose result was invisible. */}
      {panel?.kind === 'context' && usage && (
        <ContextCard usage={usage} costUsd={session.costUsd} onClose={() => setPanel(null)} />
      )}
      {openTask && (
        <BackgroundTaskCard session={session} task={openTask} onClose={() => setPanel(null)} />
      )}

      {/* The project/branch pair used to be duplicated here, above the card on a
          fresh session, with a second copy below it once a conversation existed.
          There is one status row now and it is always below — see
          `.composer-bar` at the foot of this component. */}

      {/* One card: the field, and only the controls that ACT on it — `+`, the
          two busy-only buttons, send. Cursor draws the input and its own buttons
          on one rounded surface, which is what makes the composer read as one
          object rather than a field with a toolbar bolted under it.

          The settings that used to sit in here with them — mode and model — are
          on the status row below (see `.composer-bar` at the foot of this
          component). That is not a return to the pre-card layout: what moved out
          is what described the NEXT TURN rather than the field, and in here it
          competed with send for width and swapped sides between the two shapes.

          The border, radius and fill moved here from .composer-editor, which is
          now transparent — otherwise there would be a box drawn inside a box.

          The controls are direct children rather than living in a `.composer-row`
          wrapper, and that is still load-bearing with one shape: the `+` has to
          sit BEFORE the input, which it does with `order: -1`, and a child of a
          later sibling cannot reorder across it. */}
      <div className="composer-card">
        <div className="composer-input">
          {/* Ghost text for the predicted next prompt. Only while the box is
              empty and idle — overlaying a suggestion on real typing is noise. */}
          {ghost && (
            <button
              className="ghost"
              data-tip="Predicted next prompt — Tab to use"
              onClick={acceptGhost}
            >
              {session.promptSuggestion}
            </button>
          )}
          {suggestions.length > 0 && (
            <Autocomplete items={suggestions} cursor={cursor} onPick={pick} />
          )}
          <MarkdownInput
            viewRef={composerBox}
            value={text}
            caret={caret}
            // The ghost is an overlay on this same box, so leaving the
            // placeholder on paints the two strings on top of each other.
            placeholder={
              ghost ? '' : busy ? 'Queue a message…' : `Message the agent in ${session.title}…`
            }
            // One channel for both, because in CodeMirror a caret move and an edit
            // arrive as the same update — and `triggerAt` needs the pair in step.
            onChange={(next, pos) => {
              setText(next)
              setCaret(pos)
            }}
            onPaste={(e) => {
              const imgs = Array.from(e.clipboardData?.files ?? []).filter((f) =>
                ACCEPTED.includes(f.type as ImageMediaType),
              )
              if (!imgs.length) return
              e.preventDefault() // or the filename lands in the editor too
              addFiles(imgs)
            }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              if (!e.dataTransfer?.files.length) return
              e.preventDefault()
              addFiles(e.dataTransfer.files)
            }}
            onKeyDown={(e) => {
              // ⇧Tab cycles the permission mode, matching the CLI.
              //
              // FIRST, before both Tab branches below: the autocomplete's accept
              // tests bare `Tab` and so does the ghost's, so either would swallow
              // this. preventDefault beats defaultKeymap's indentLess too.
              //
              // Composer-scoped and deliberately NOT global. This handler runs at
              // Prec.highest inside CodeMirror (see MarkdownInput), so it fires
              // only while the composer has focus. The window-level handler in
              // App.tsx gates on `if (!e.metaKey) return`, and removing that to
              // fit a bare ⇧Tab would route every keystroke in the app through
              // it — while the only editable-target guard in the codebase tests
              // HTMLTextAreaElement | HTMLInputElement, which catches neither
              // CodeMirror nor Monaco nor xterm. Typing a capital letter would
              // cycle the permission mode.
              //
              // Cost, accepted knowingly: ⇧Tab is no longer a focus-escape from
              // the text box. The CLI only cycles from its prompt too.
              if (e.key === 'Tab' && e.shiftKey) {
                e.preventDefault()
                const i = PERMISSION_MODES.indexOf(session.permissionMode)
                void window.foreman.setPermissionMode(
                  session.id,
                  PERMISSION_MODES[(i + 1) % PERMISSION_MODES.length],
                )
                return
              }
              if (suggestions.length) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setCursor((c) => Math.min(c + 1, suggestions.length - 1))
                  return
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setCursor((c) => Math.max(c - 1, 0))
                  return
                }
                // Enter completes rather than sends while the popover is open —
                // otherwise picking a file would fire off a half-typed message.
                if (e.key === 'Enter' || e.key === 'Tab') {
                  e.preventDefault()
                  pick(suggestions[cursor])
                  return
                }
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setCaret(-1) // closes the popover without touching the text
                  return
                }
              }
              if (e.key === 'Tab' && !text && session.promptSuggestion) {
                e.preventDefault()
                acceptGhost()
                return
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit()
              }
            }}
          />
        </div>

        {/* The background-task tray used to sit here, between the input and the
            controls. It moved out of the card entirely — see `bgTray` above. */}

        {/* Cursor's `+`, back to meaning one thing. It briefly held a menu whose
            first five rows were the permission modes, which is how a control the
            whole app steers on ended up behind a glyph that reads as "attach a
            file" — and with no menu it does not need one: a single row is a
            button. Images could otherwise only ever arrive by paste or drop. */}
        <button
          className="composer-add"
          type="button"
          aria-label="Attach an image"
          data-tip="Attach an image"
          onClick={() => picker.current?.click()}
        >
          <Plus size={14} />
        </button>

        {/* The mode pill and the model picker lived here, inside the card, one
            on each side of this spacer. Both moved to the status row: they are
            settings you glance at rather than parts of the field, and in here
            they competed with send for width and changed places between the two
            shapes. The SPACER STAYS — without it `+` and send collapse together
            at the left of the card. */}
        <span className="spacer" />

        {/* The running cost used to sit here. It moved to ContextStrip below:
            it is a readout rather than a control, and this row had no width left
            for it. Two decimals there — cents are the unit anyone reads, and a
            sub-cent turn showing $0.00 is the accepted trade. */}

        {/* Send stays available while running: the queue holds the message and
            the transcript shows it as cancellable until the agent picks it up. */}
        {busy && (
          <>
            {/* Moves in-flight Bash/subagent work to the background so the turn
                continues instead of blocking on a long command. */}
            <button
              className="btn"
              data-tip="Run in-flight work in the background, so the turn continues"
              aria-label="Run in-flight work in the background"
              onClick={() => void window.foreman.backgroundTasks(session.id)}
            >
              <SendToBack size={14} />
            </button>
            {/* A square is the most universally-read control glyph there is, and
                it only exists while running, so its context is unambiguous.
                Cursor puts theirs in the send position rather than beside it —
                here the send button still has to hold a queued message, so both
                stay. */}
            <button
              className="btn"
              data-variant="danger"
              data-tip="Stop the agent  Esc"
              aria-label="Stop the agent"
              onClick={() => void window.foreman.interrupt(session.id)}
            >
              <Square size={14} />
            </button>
          </>
        )}
        {/* Said BEFORE the click rather than after, and beside send rather than
            in a modal: starting an agent takes a few seconds and about 2 GB, so
            it is worth knowing that ⏎ is what does it. A label, not a button —
            the send button is still the control, this just names what it will
            do. Gone the instant the session is awake. */}
        {session.asleep && (
          <span className="composer-wake" data-tip="This conversation has no agent running">
            <Moon size={12} />
            Send to wake
          </span>
        )}

        {/* Icon-only: this is the core loop, bound to ⏎ and pressed hundreds of
            times a session — the two glyphs read the state better than the two
            words did, and the word was pure chrome. ArrowUp rather than a paper
            plane, which is what Cursor's white circle holds. */}
        {/* data-tip rides on the wrapper, not the button: the button is disabled
            while `empty`, and a disabled control fires no pointer events, so the
            one tip that explains the disabled state would never appear. */}
        <span
          className="tw"
          data-tip={
            empty
              ? 'Type a message first'
              : session.asleep
                ? 'Start the agent and send this  ⏎'
                : busy
                  ? 'Queue this message — the agent picks it up when the turn ends  ⏎'
                  : 'Send  ⏎'
          }
        >
          <button
            className="btn"
            data-variant="primary"
            onClick={submit}
            disabled={empty}
            aria-label={busy ? 'Queue this message' : 'Send'}
          >
            {busy ? <ListPlus size={14} /> : <ArrowUp size={14} />}
          </button>
        </span>
      </div>

      {/* The status row: what this turn will run as, left to right, with the
          context ring at the far end. One unconditional row, where there used to
          be two conditional ones — a project/branch pair above the fresh card
          and a branch/ring pair below the follow-up one.

          Everything on it is a fact about the next turn rather than a part of
          the field: where it runs, on what branch, as which model, under which
          permission mode, against how much window. Inside the card they were
          competing with send for width and moving between the two shapes.

          The project picker is the one thing still conditional. ⌘N already
          starts a conversation in this project and the branch picker's menu can
          reach any other, so once a conversation exists it would only be
          restating the session's own directory. */}
      <div className="composer-bar">
        {fresh && projectPicker}
        {branchPicker}
        {/* The worktree opt-in. A native checkbox on the picker row rather than
            the menu row and the chip it replaces: those were two controls 40px
            apart that both fired immediately, and one of them could leave you
            with no sessions at all. This one is a statement of intent — nothing
            happens until ⏎, and unticking it costs nothing.

            Only offered while the session can still move: its cwd is fixed at
            creation, so once a message exists there is nowhere to go — and an
            asleep session has no host to move. See `canWorktree`. */}
        {canWorktree && (
          <label className="composer-worktree" data-tip="Run this in its own worktree and branch">
            <input
              type="checkbox"
              checked={wantWorktree}
              onChange={(e) => setWantFor(e.target.checked ? session.id : null)}
            />
            Worktree
          </label>
        )}
        {modelPicker}
        {modePicker}
        <span className="spacer" />
        {usage && (
          <ContextRing
            usage={usage}
            open={panel?.kind === 'context'}
            onToggle={() =>
              setPanel((p) => (p?.kind === 'context' ? null : { kind: 'context' }))
            }
          />
        )}
      </div>

      {/* The starter chips lived here — see the note where STARTERS was. */}

      {/* Images could only ever arrive by paste or drop before. The `+` above
          needs something to click, and a hidden input is the only way to open
          the file picker without a visible control of its own. */}
      <input
        ref={picker}
        type="file"
        accept={ACCEPTED.join(',')}
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) addFiles(e.target.files)
          // Or picking the same file twice in a row fires no change event.
          e.target.value = ''
        }}
      />
    </div>
  )
}
