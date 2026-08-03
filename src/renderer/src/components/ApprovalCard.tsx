import { useEffect, useMemo, useRef, useState } from 'react'
import { Ban, Check, FileCode2, ShieldCheck } from 'lucide-react'
import type { DiffHunk, PermissionRequest } from '../../../shared/types'
import { toHunks } from '../../../shared/diff.mts'
import { describeGrant } from '../../../shared/rules.mts'
import { composerBox } from '../composerBox'
import { focusTarget, relPath } from '../derive.mts'
import { hljsLang } from '../highlight.mts'
import { useStore } from '../store'
import { summarise } from './ToolLine'
import DiffLines from './DiffLines'

/**
 * How long a freshly-focused Allow button ignores ⏎.
 *
 * The naive fear — "⏎ to send, ⏎ again approves" — is not the hazard: an
 * approval needs a full model round trip first. The two real ones are a keystroke
 * already TRAVELLING when focus lands (including the re-arm chain, where
 * answering one prompt hands focus to the next within a frame) and a held ⏎,
 * which fires keydown every ~30ms. 350ms is longer than a deliberate
 * double-press (100-250ms) and far shorter than reading a diff.
 */
const ARM_GRACE_MS = 350

/**
 * Whether taking focus right now would interrupt something.
 *
 * TWO tests, and each catches what the other misses:
 *
 *  - Anything EDITABLE. An elicitation's inputs render inside `.convo`, so
 *    containment alone would sail straight past them.
 *  - Anything outside `.convo` AT ALL: Settings, the command palette, the file
 *    and terminal modals, the diff panel's commit box, the rail's rename field.
 *    Most of what has focus in those is a plain `<button>`, which the editable
 *    test cannot see.
 *
 * TWO exceptions, both of which the outside-`.convo` test would otherwise
 * swallow, and both of which are the cases the feature exists for:
 *
 *  - `<body>`, i.e. nothing is focused. That is the state the app launches in,
 *    and the state focus falls back to the instant the previous approval card
 *    unmounts — so without this the feature would be dead on arrival and dead
 *    again for every second prompt in a row.
 *  - The composer. It is outside `.convo` AND its CodeMirror surface is
 *    contenteditable, so both tests would refuse the steal forever. It is only
 *    ever reached with `composerDirty` already false, i.e. an empty box, which
 *    is not work in progress.
 *
 * ...and ONE thing that outranks both of those exceptions, which is why it is
 * tested first. See the scrim check below.
 */
function focusIsBusy(): boolean {
  /**
   * An OPEN modal beats every exception below, because THE EXCEPTIONS ARE
   * REACHABLE WITH ONE OPEN.
   *
   * Settings, FileModal and TerminalModal contain no `.focus()` call and no
   * `autoFocus` at all, so opening any of them does not move focus. Press ⌘,
   * with an empty composer and focus is still on `<body>` or still in the
   * composer — both exempted below, and `composerDirty` is false because the
   * box is empty. Without this an arriving approval would take focus to a button
   * BEHIND the scrim, scroll the conversation under it, and 350ms later accept
   * a ⏎ for a tool the user never saw.
   *
   * MOUNTED IS NO LONGER THE SAME AS OPEN, which is what `:not()` is for:
   * usePresence keeps a dismissed scrim in the DOM for its 180ms exit. And the
   * `:not()` is on EACH selector rather than around the pair, because two scrims
   * can be mounted at once — a closing palette over an open Settings — and
   * `querySelector` returns the first in DOCUMENT order, which may well be the
   * closing one.
   *
   * Reading a closing scrim as open is not a stall. The arm effect below has
   * deps `[arm]` and `arm` does not flip again for the same request, so a single
   * true reading disarms that card for its entire life: Allow never takes focus,
   * ⏎ does nothing, and the "↵" badge never appears.
   *
   * A DOM query rather than store state, deliberately: these six modals keep
   * their open flags in local `useState` in six different components, so there
   * is nothing to read. And this is a decision about one instant — the same
   * reason `composerDirty` is read rather than subscribed — so a query is the
   * honest shape for it, not a workaround for missing state.
   *
   * Neither scrim is mounted at launch or during the re-arm chain, which are
   * exactly the two states the `<body>` exemption exists to serve, so this costs
   * that exemption nothing.
   */
  if (
    document.querySelector(
      '.plan-scrim:not([data-state="closed"]), .palette-scrim:not([data-state="closed"])',
    )
  )
    return true

  const el = document.activeElement
  if (!(el instanceof HTMLElement) || el === document.body) return false
  if (el.closest('.composer')) return false
  if (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement ||
    el.isContentEditable
  )
    return true
  return !el.closest('.convo')
}

/**
 * The approval prompt — now showing what it is asking you to approve.
 *
 * It used to render `summarise()` alone: "Allow Write? src/config.ts". You were
 * approving a file write sight unseen. It now renders the actual diff, and for
 * a Write it lets you accept only part of it.
 *
 * THIS CARD IS NEVER REPLACED BY ANYTHING. The editor is an additional surface,
 * never a substitute — a prompt answerable only somewhere the user might not
 * have open is a prompt that can be lost. main/index.ts hides the window rather
 * than destroying it on ⌘W for exactly this reason, and `pendingRequests()`
 * re-seeds these after a reload. Everything the editor can do, this can do.
 *
 * Per-hunk is offered only where it is EXPRESSIBLE, which is narrower than the
 * plan assumed:
 *
 *   Write — yes. The input is the whole file, so accepted hunks recompose into
 *           a new `content`. Verified end to end: two proposed changes,
 *           approving one, and the rejected line stayed at its original value.
 *   Edit  — no. One old_string and one new_string is a single atom with nothing
 *           to subset, so no ticks are drawn and the UI does not pretend. Same
 *           refusal DiffLines already makes by rendering an Edit preview with
 *           numbers={false}, since those strings are fragments.
 *   MultiEdit — the plan expected this to be the main case. It DOES NOT EXIST
 *           in @anthropic-ai/claude-agent-sdk@0.3.220: zero occurrences in
 *           sdk.d.ts, and a live agent reports it is not among its tools. The
 *           subsetting code is kept because it is tested and costs nothing, and
 *           this codebase already carries MultiEdit branches elsewhere for the
 *           same reason — but nothing reaches it today.
 */
export default function ApprovalCard({
  req,
  arm,
}: {
  req: PermissionRequest
  /**
   * This is the prompt ⏎ should answer.
   *
   * Decided by `armedApproval` in derive.mts, not here: it is a property of the
   * whole pending set (a plan or a question anywhere in it disarms everything),
   * which no single card can see.
   */
  arm?: boolean
}): React.JSX.Element {
  const gist = summarise(req.toolName, req.input)
  const openFile = useStore((s) => s.openFile)
  const cwd = useStore((s) => s.sessions.find((x) => x.id === req.sessionId)?.cwd ?? '')
  const [before, setBefore] = useState<string | null>(null)
  /** Hunks the user has UNticked. Tracks rejections rather than acceptances, so
   *  everything is accepted by default and nothing is silently off. */
  const [rejected, setRejected] = useState<Set<number>>(new Set())

  const target = useMemo(() => focusTarget(req.toolName, req.input), [req.toolName, req.input])
  const path = target?.path ?? ''
  const proposed = typeof req.input.content === 'string' ? req.input.content : null
  const partial = req.toolName === 'Write' && proposed !== null

  // Read what is on disk, so the diff is against reality rather than a guess.
  useEffect(() => {
    if (!partial || !path || !cwd) return
    let cancelled = false
    void window.foreman.readFile(cwd, path).then((res) => {
      if (!cancelled) setBefore(res.ok ? res.text : '')
    })
    return () => {
      cancelled = true
    }
  }, [partial, path, cwd])

  const hunks: DiffHunk[] | null = useMemo(() => {
    if (partial && before !== null && proposed !== null) return toHunks(before, proposed, path)
    if (req.toolName === 'Edit') {
      const i = req.input as Record<string, unknown>
      const o = typeof i.old_string === 'string' ? i.old_string : ''
      const n = typeof i.new_string === 'string' ? i.new_string : ''
      return o || n ? toHunks(o, n, path) : null
    }
    return null
  }, [partial, before, proposed, path, req.toolName, req.input])

  const tickable = partial && hunks !== null && hunks.length > 1

  /**
   * Whether "Always allow" is offered at all.
   *
   * HIDDEN, not disabled — conditional presence is already how this card handles
   * `tickable` and `target`, and "the CLI produced no rule matching this call" is
   * not something the user can act on. The second half mirrors the host's own
   * `!updatedInput` guard: "allow every future Write to this path, but trim THIS
   * one" is incoherent, and the host refuses that combination independently, so
   * this is a courtesy rather than the enforcement.
   */
  const rules = req.rules ?? []
  const canAlways = rules.length > 0 && !(tickable && rejected.size > 0)

  const respond = (behavior: 'allow' | 'deny'): void => {
    // Indices, never content. The host subsets its OWN copy of the input, so
    // this can only ever remove something the agent proposed — never add or
    // alter one. Tighten-only, never widen.
    const keep = tickable
      ? hunks.map((_, n) => n).filter((n) => !rejected.has(n))
      : undefined
    void window.foreman.respondPermission(req.requestId, behavior, { keep })
  }

  const kept = hunks ? hunks.length - rejected.size : 0

  // ----------------------------------------------------------- ⏎ approves

  const allow = useRef<HTMLButtonElement>(null)
  /** When this button took focus, for ARM_GRACE_MS. */
  const armedAt = useRef(0)

  /**
   * Hand focus to Allow, so ⏎ activates it NATIVELY.
   *
   * `composerDirty` is READ, not subscribed: this is a decision about one
   * instant — the moment the prompt arrives — and subscribing would re-run the
   * steal every time the composer happened to empty.
   *
   * `focus()` WITHOUT `{ preventScroll: true }`, deliberately. This file's own
   * docblock argues that a prompt answerable only somewhere the user might not
   * be looking is a prompt that can be lost; scrolling it into view is the point.
   *
   * Under StrictMode this runs twice in dev and re-focuses the same button,
   * which is harmless. Do NOT add a `done.current` guard to "fix" it — that
   * would skip the real run.
   */
  useEffect(() => {
    if (!arm) return
    if (useStore.getState().composerDirty) return
    if (focusIsBusy()) return
    const el = allow.current
    if (!el) return
    armedAt.current = performance.now()
    el.focus()
  }, [arm])

  /**
   * Keys arriving at a focus the user never asked for.
   *
   * Double-firing is harmless throughout: `settle()` in permissions.ts returns
   * false for an id no longer parked, so there is no local disabled state to
   * keep in step.
   */
  const onAllowKey = (e: React.KeyboardEvent<HTMLButtonElement>): void => {
    // A HELD key. keydown repeats every ~30ms and a <button> activates on
    // keydown (unlike Space, which waits for keyup), so one leaned-on ⏎ would
    // answer this prompt and then the next one to arm.
    if (e.repeat) {
      e.preventDefault()
      return
    }

    // SPACE IS THE REAL HAZARD, and it is not obvious: a <button> activates on
    // it, so someone typing a reply into a focus they never asked for approves
    // on their first word break. Escape rides along because four modals bind a
    // bare window-level Escape and this must not reach any of them.
    if (e.key === ' ' || e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      composerBox.current?.focus()
      return
    }

    // Anything still travelling when focus landed — see ARM_GRACE_MS.
    if (e.key === 'Enter' && performance.now() - armedAt.current < ARM_GRACE_MS) {
      e.preventDefault()
      return
    }

    // Any printable key belongs to the message you were writing, and is
    // deliberately NOT preventDefault'd: the character itself has to land in the
    // composer, which only works because this focus() is synchronous within the
    // same keydown. That is the whole reason composerBox is a module ref.
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      composerBox.current?.focus()
    }
  }

  return (
    <div className="approval">
      <div className="approval-title">
        Allow <code>{req.toolName}</code>?
      </div>
      {gist && <div className="approval-input">{gist}</div>}

      {/* Wrapped, so the hunks sit on a tighter rhythm than the card's own gap —
          a three-hunk change is one proposal, not three adjacent cards. */}
      {hunks && hunks.length > 0 && (
        <div className="approval-hunks">
          {hunks.map((h, n) => (
            <div
              key={n}
              className="approval-hunk"
              data-off={tickable && rejected.has(n) ? '' : undefined}
            >
              {tickable && (
                <label className="approval-tick">
                  <input
                    type="checkbox"
                    checked={!rejected.has(n)}
                    onChange={() =>
                      setRejected((r) => {
                        const next = new Set(r)
                        if (next.has(n)) next.delete(n)
                        else next.add(n)
                        return next
                      })
                    }
                  />
                  <span>Hunk {n + 1}</span>
                </label>
              )}
              <DiffLines hunks={[h]} numbers={partial} maxLines={14} lang={hljsLang(path)} />
            </div>
          ))}
        </div>
      )}

      <div className="approval-actions">
        {/* Both keep their words: these grant or refuse a real permission, and
            an icon-only Allow beside an icon+text Deny reads as a bug. */}
        <button
          ref={allow}
          className="btn approval-allow"
          data-variant="primary"
          onKeyDown={onAllowKey}
          onClick={() => respond('allow')}
        >
          <Check size={14} />
          {tickable && rejected.size ? `Allow ${kept} of ${hunks.length}` : 'Allow'}
          {/* Only visible while focused, and hidden by OPACITY rather than
              display so the button never changes width under the pointer. Its
              reveal is delayed to match ARM_GRACE_MS — a badge promising ⏎
              during the window that deliberately ignores ⏎ is a lie. */}
          <span className="approval-key" aria-hidden="true">
            ↵
          </span>
        </button>
        <button className="btn" data-variant="danger" onClick={() => respond('deny')}>
          <Ban size={14} />
          Deny
        </button>
        {/* THIRD, after Deny, and with no variant of its own. Allow and Deny keep
            the positions muscle memory has for them, and the one button here
            that writes a LASTING rule sits past the one you have to aim at
            deliberately. Second position would put it exactly where an overshoot
            from Allow lands — and "Allow"/"Always allow" share a two-letter
            prefix, so the misread and the misclick would compound. */}
        {canAlways && (
          <button
            className="btn"
            onClick={() =>
              void window.foreman.respondPermission(req.requestId, 'allow', { alwaysAllow: true })
            }
          >
            <ShieldCheck size={14} />
            Always allow
          </button>
        )}
        {/* Opens the file so the change can be read in context. Deliberately
            does NOT answer the prompt: reading before deciding must not mean
            deciding, which is the rule PlanCard's modal already follows. */}
        {target && (
          <button
            className="btn approval-open"
            title="Open the file. This does not answer the prompt."
            onClick={() => openFile(target.path, target.line ?? undefined)}
          >
            <FileCode2 size={14} />
            {relPath(target.path, cwd)}
          </button>
        )}
      </div>

      {/* Under the row, not in a tooltip. These rules differ enormously in
          reach — `Read` is every file on the machine, `Bash(npm run build:*)` is
          one command — and a permission you cannot read is not consent.
          It names the settings FILE, because the honest objection to sending the
          CLI's suggestions back verbatim is that a click can write into your
          repo, and the answer to that is to say which file BEFORE the click, not
          to quietly downgrade the grant to something the button's own label
          would contradict.
          ponytail: confirm the destinations the CLI really sends. Its own
          docstring says suggestions stop prompts "during this session", which
          hints they may already be `destination: 'session'` — in which case
          scopeLabel already reads "this conversation only" and nothing here
          changes. It names whatever actually arrives either way. */}
      {canAlways && <div className="approval-rules">{describeGrant(rules)}</div>}
    </div>
  )
}
