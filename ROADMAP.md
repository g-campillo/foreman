# Foreman roadmap — 25 features in 8 batches

Written 2026-07-26. Verified against the installed `@anthropic-ai/claude-agent-sdk@0.3.220`
(`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`) and the current source, not the
docs page — the published API reference is abridged and wrong in several places.

## How this is batched

By **seam, not by theme**. A feature here almost never costs what the feature costs; it
costs the plumbing tax — a new `IPC` key, a preload method, a store field, a `ChatItem`
variant. Pay that tax once per batch and the 2nd–4th feature in the batch runs ~20% of
the first.

| Seam | Cost | Features |
|---|---|---|
| **S1** `query({options})` literal in `session.ts` | nothing — add a field | 5·6·8·9·12·13·15 |
| **S2** control-method bridge (`q.x()` → invoke → preload → store) | write the pattern once | 1·2·5·7·8·10·11·14 |
| **S3** `ChatItem` union + `handle()` switch + `Item` renderer | breaking type change | 6·12·13·20 |
| **S4** composer input pipeline (popover + `MessageParam`) | one popover, one queue-type change | 1·17·18·19 |
| **S5** session history (module-level SDK fns + transcript→ChatItem normaliser) | one normaliser | 3·4·23 |
| **S6** no SDK — Electron main, renderer, git | independent of everything | 16·21·22·24·25 |

Several features appear on two seams: they have an options half and a UI half. That's the
seam boundary, not duplication — the halves land in different batches on purpose.

## Order

| # | Batch | Features | Seam | Size |
|---|---|---|---|---|
| 1 | ✅ One sitting | 15, 9, 13, 5a, 21 | S1 + S6 | ½ day |
| 2 | ✅ Looks finished | 16, 20, 22 | S6 | 1–2 d |
| 3 | ✅ Read-only panels (11 partial) | 2, 14, 11, 10a | S2 | 1–2 d |
| 4 | ✅ Composer | 1, 18, 19, 17 | S4 | 2–3 d |
| 5 | ✅ History | 3, 23, 4 | S5 | 2–3 d |
| 6 | ✅ Time travel + actions | 5b, 7, 12, 8, 10b | S2 + S3 | 2 d |
| 7 | ✅ Subagents | 6 | S3 | 2 d |
| 8 | ✅ Git | 25, 24 | S6 | L |

**If you only do three:** 1, 2, 3. That's ~3 days and closes the "feels unfinished" gap.

**Parallel-safety:** batches 2, 3 and 4 are conflict-free with each other — 3 and 4 only
*add* `IPC` keys, which merges cleanly. Batches **2 and 7 both edit the `Item` switch** in
`Conversation.tsx`, and **5, 6 and 7 all edit the `ChatItem` union**. Serialize those
three, which is also their natural order.

---

# Batch 1 — One sitting

Options-only changes plus one main-process feature. Nothing here touches the renderer's
types, so it can't conflict with anything else. Ships something visible on day one while
the inert options start emitting data you can watch in the stream while building batches
3–7.

**Files:** `src/main/agent/session.ts`, `src/main/index.ts`, `src/main/bridge.ts`

- [x] **21. Native notification + dock badge.** Fire on `status` → `idle` after a run, and
  on `awaiting-approval`, but only when the window is unfocused. Electron's `Notification`
  + `app.dock.setBadge()`. Highest value-per-line in the whole document, and the three web
  apps structurally can't match it.
- [x] **15a. `fallbackModel`.** Comma-separated list; the primary is retried at the start of
  each user turn, so an overload doesn't permanently demote the session.
- [x] **15b. `permissionMode: 'dontAsk'`.** The fourth mode — deny anything not
  pre-approved, never prompt. Add to the `MODES` array in `Composer.tsx`; it's the one
  renderer touch in this batch and it's a one-line array entry.
- [x] **9. `maxBudgetUsd` + `maxTurns`.** A session that blows the cap stops with an
  `error_max_budget_usd` result. You already render cost — this turns the readout into a
  control. Ship with a generous default; the settings UI can come later.
- [x] **13a. `promptSuggestions: true`.** Emits a `prompt_suggestion` message after each
  `result`. Safe to enable blind: unhandled message types fall through `handle()`'s switch.
  UI lands in batch 6.
- [x] **5a. `enableFileCheckpointing: true`.** Just makes backups; unlocks
  `q.rewindFiles()` in batch 6. Safe to enable blind.

> **Trap: do NOT add `forwardSubagentText` here.** Subagent text arrives as ordinary
> assistant messages with `parent_tool_use_id` set, and `handleAssistant()` doesn't check
> that field — it will interleave subagent chatter into the main transcript. It is the one
> option in this document that regresses the app if turned on before its renderer.
> It belongs in batch 7. (`agentProgressSummaries` is safe early; it only affects
> `task_progress` events, which nothing handles yet.)

**Done when:** an unfocused Foreman raises a notification on turn-complete, and the `Ask /
Accept edits / Plan / Bypass / Don't ask` dropdown has five entries.

---

# Batch 2 — Looks finished

No SDK at all. Pure renderer work, and the largest perceived-quality gap in the app.

**Files:** `src/renderer/src/components/Conversation.tsx`, `App.tsx`, `theme.css`

- [x] **16. Markdown + syntax-highlighted code blocks.** `Conversation.tsx` currently
  renders `{item.text}` raw. Add copy buttons and collapse long blocks while you're in
  there. All three of Claude, Codex and Gemini do this; it's why they read as finished.
- [x] **20. Todo/plan strip.** ~~The `TodoWrite` tool stream~~ **this SDK has no `TodoWrite`** —
  it emits `TaskCreate` (one call per task, id returned in the *result* text) plus
  `TaskUpdate` (one call per status change), so the strip folds those events. `TodoWrite`
  is still handled as a whole-list rewrite in case another config emits it. The tool stream
  is already flowing through your tool cards. Pin the latest list to a header strip instead of burying it in scrollback.
  No new plumbing — read the last `TodoWrite` item out of the existing store.
- [x] **22. Command palette (⌘P).** Sessions, files, and later slash commands. Today ⌘K
  cycles sessions, which is the placeholder version of this.

> Batch 7 also edits the `Item` switch in `Conversation.tsx`. Land this first.

---

# Batch 3 — Read-only panels

Four `q.x()` calls that return data and render a panel. Build the invoke→preload→store
pattern once for the context meter; the other three are then near-copies.

**Files:** `src/shared/types.ts` (new `IPC` keys), `src/main/agent/session.ts`,
`src/main/agent/manager.ts`, `src/preload/index.ts`, `src/renderer/src/store.ts`, new
components

- [x] **2. Context-window meter.** `q.getContextUsage()` returns a *per-category* breakdown
  — system prompt, tools, messages, MCP tools, memory files — not just a total. Gemini CLI
  shows a bare percentage; nobody shows the breakdown. Cheap differentiator, and it's the
  one that makes long sessions legible.
- [x] **14. Usage + account chip.** `q.accountInfo()` gives email, org and subscription
  type. `q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` gives session
  cost/token totals plus plan rate-limit windows (5-hour, 7-day, per-model).
  **Caveat:** that method name is a promise that it will change. Wrap it in try/catch and
  don't build UI that breaks when it disappears. `rate_limits_available` is false for API
  key / Bedrock / Vertex sessions.
- [~] **11. Skills & agent personas — PARTIAL.** `q.supportedAgents()` → `AgentInfo[]`, plus the
  `skills: 'all' | string[]` option and `q.reloadSkills()`. Listing + `reloadSkills()` are done. The persona picker is NOT:
  `agent` / `agents` are **constructor-only** (there is no `setAgent` on `Query`), so
  switching persona means recreating the session and losing its context. It belongs with a
  create-session flow, not a rail toggle. The `skills` option is likewise constructor-only.
- [x] **10a. MCP status panel.** `q.mcpServerStatus()` → connected / failed / needs-auth /
  pending. Claude Desktop's connectors UI. Mutators are batch 6.
- [x] **10c. `onElicitation` — this one is a bug fix, not a feature.** Confirmed with a probe
  MCP server: without the callback a form elicitation returns `{"action":"decline"}` to the
  server and no prompt is ever shown. Now round-trips real values.
  **Correction to the OAuth claim:** URL-mode elicitation never reaches a host callback —
  the CLI advertises `elicitation: {}` to MCP servers, so a server's own capability check
  (`if (!clientCapabilities?.elicitation?.url) throw`) rejects it first. Not fixable here;
  MCP OAuth goes through the `needs-auth` status instead. Grouped here because it's the same
  subsystem; do it first in the batch.

**Also cheap while you're in this seam:** `q.supportedCommands()` exists too, but its UI
belongs in batch 4 — see the note there.

---

# Batch 4 — Composer

One autocomplete popover and one change to the queue's input type unlock all four.

**Files:** `src/renderer/src/components/Composer.tsx`, `src/main/agent/queue.ts`,
`src/main/agent/session.ts`, `src/shared/types.ts`

- [x] **The queue already took blocks.** `queue.push(content: Content)` was already
  `string | ContentBlockParam[]`; only `Session.send` and the IPC narrowed it to a string, so
  the "breaking change" was two signatures, not a rewrite. **The real work was elsewhere:**
  the SDK sits in `for await` on the queue permanently, so a pushed message is pulled within
  microseconds — a mid-turn message was handed over and its "queued" marker cleared before
  it could render. Queued messages only exist because the generator is now gated while a
  turn is in flight.
- [x] **1. Slash commands.** `q.supportedCommands()` → `SlashCommand[]`. Typing `/` opens
  the menu. **This looks like an SDK feature and is filed under S2, but its real cost is
  the popover — the same widget as `@`-mentions. Split them and you build it twice.**
- [x] **18. `@`-file mentions with fuzzy autocomplete.** Same popover, different trigger and
  data source. `q.readFile(path, {maxBytes, encoding})` gives a hover preview that respects
  the session's read-permission rules rather than bypassing them.
- [x] **19. Queue messages while the agent runs.** Type-ahead: the composer currently just
  shows Stop. Your push-queue already supports it. `interrupt()` now resolves to a receipt
  carrying `still_queued` uuids of async user messages that will *still* run unless
  cancelled — surface and cancel those, or Stop will feel like it lied.
- [x] **17. Image / file attachments.** Paste a screenshot into the composer. Falls out of
  the `MessageParam` change above; Claude and Gemini both lean on this hard.

---

# Batch 5 — History

Module-level SDK functions (not methods on `Query`), so they don't need a live session.
One transcript→`ChatItem` normaliser serves all three.

**Files:** `src/main/agent/manager.ts`, `src/shared/types.ts`, `src/renderer/src/store.ts`,
`src/renderer/src/components/SessionRail.tsx`

- [x] **First commit of this batch: thread the SDK's message `uuid` onto `ChatItem`.**
  Today `ChatItem.id` is a locally-minted `randomUUID()`. But `rewindFiles(userMessageId)`
  and the `resumeSessionAt` option both want the *SDK's* `SDKAssistantMessage.uuid`.
  Without that field, features 3, 4, 5 and 23 are all unbuildable. ~10 lines in `handle()`
  and the union — and it makes batch 6's rewind fall out for free.
- [x] **3. Real transcript on resume.** `getSessionMessages(sessionId, {dir, limit, offset,
  includeSystemMessages})` — note the id is a positional arg, not part of the options. A resumed session currently comes back with an empty
  conversation, because `ChatItem`s only ever lived in the renderer. This is the fix, and
  it's the highest-value item in the batch.
- [x] **23. Search across session transcripts.** `listSessions({dir})` (already wired for
  `sessionPastList`) + `getSessionMessages()` + the normaliser from #3.
- [x] **4. Branch a conversation.** `forkSession({upToMessageId, title})` plus the
  `resumeSessionAt` option. Claude.ai's edit-and-retry. **Needs #3** — forking into an
  empty conversation view is worse than not forking. `renameSession()` is right there too,
  for renaming in the rail.

---

# Batch 6 — Time travel + actions

Back to the S2 bridge, but the mutator half: control methods that *do* something, each
fronted by a card with a button. Also spends the `prompt_suggestion` and `AskUserQuestion`
message types enabled in batch 1.

**Files:** `src/main/agent/session.ts`, `src/preload/index.ts`, `src/shared/types.ts`,
`src/renderer/src/components/`

- [x] **5b. Rewind.** `q.rewindFiles(userMessageId, {dryRun: true})` returns
  `{canRewind, error?, stats}` — so the confirmation card's preview is free. Then call it
  for real. Gemini's `/restore`, Claude Code's double-Esc. Complements your existing
  per-*file* revert with per-*turn* rewind. Needs batch 5's uuid threading.
- [x] **7. Background tasks.** `q.backgroundTasks(toolUseId?)` moves in-flight Bash commands
  and subagents to the background — the blocking tool returns "running in the background"
  and the turn continues. `q.stopTask(taskId)` kills one. A 4-minute `npm test` drops to a
  tray instead of stalling the agent. Ctrl+B equivalent.
- [x] **12. `AskUserQuestion` as a real card.** Uses `previewFormat: **'markdown'**`, not
  'html' — we already have a markdown renderer, and react-markdown drops raw HTML, so this
  avoids running model-authored HTML through dangerouslySetInnerHTML.
  **The answer channel is not obvious:** the tool arrives via `canUseTool`, NOT
  `onUserDialog`, and *allowing* it just runs it — it then reports "The user did not answer
  the questions", because the CLI collects answers from its own interactive UI. A permission
  **deny** carries a `message` that becomes the tool_result, and that is the only way to get
  an answer back. Verified: the model replied "Tabs it is." The agent asks a multiple-choice question and you render
  actual buttons instead of a JSON blob. Uniquely IDE-shaped — the CLI can't render HTML
  previews.
- [x] **13b. Prompt-suggestion chip.** Render the `prompt_suggestion` message enabled in
  batch 1 as ghost text in the composer. It piggybacks the parent's prompt cache, so it's
  nearly free. Suppressed on the first turn, after API errors, and in plan mode — don't
  treat absence as a bug.
- [x] **8. Effort + thinking controls.** `effort: 'low'|'medium'|'high'|'xhigh'|'max'` and
  `thinking: {type: 'adaptive'|'enabled'|'disabled'}` as constructor options, changeable
  mid-session via `q.applyFlagSettings({effortLevel})`. One dropdown beside the model
  picker. Note `'max'` is session-scoped and never persisted to settings files.
- [x] **10b. MCP mutators.** `toggleMcpServer()`, `reconnectMcpServer()`, `setMcpServers()`,
  `setMcpPermissionModeOverride(server, 'default'|'auto'|null)`. The last is tighten-only —
  it can never widen privilege — so it's safe to expose directly.

---

# Batch 7 — Subagents

The one genuinely new render path. Today a `Task` tool call is a single opaque card.

**Files:** `src/main/agent/session.ts`, `src/shared/types.ts`,
`src/renderer/src/components/Conversation.tsx`

- [x] **6. Subagent tree.** Enabled `forwardSubagentText: true` **together with** the
  `parent_tool_use_id` routing, in one commit. Three corrections to the plan above:
  **(a) `handleStreamEvent` was the missing third site** — `SDKPartialAssistantMessage`
  carries `parent_tool_use_id` too, so routing only the assistant/user handlers still
  splices live subagent *deltas* into the main transcript. `handleToolResults`, by
  contrast, needed **no** change: it merges by `tool_use_id` onto a card that already
  carries its parent. **(b) The streaming slots had to become maps** keyed by
  `parent_tool_use_id` — subagents stream concurrently with the main thread, and a single
  `streamingText` scalar splices their deltas into one item. **(c) `handleAssistant` was
  clobbering `meta.model`** with the subagent's model, flipping the model picker mid-turn.
  Guarded to the main thread.
  Shape: one optional `parentId` on the `ChatItem` union, grouped in the renderer, so the
  store stays a flat upsert-by-id array and nested subagents recurse for free. The tool is
  named **`Agent`** on the wire, not `Task` — `summarise()` fell through to dumping the
  whole prompt until that case was added. `agentProgressSummaries: true` lands on
  `task_progress` as a rolling `progress` line on the card; `task_notification` now settles
  the *originating* card instead of adding a floating one, and clears `progress` rather
  than writing its summary (that text is already the tool_result).
  **Resume caveat, measured:** the CLI does not persist subagent messages in the parent
  session's transcript — a resumed session shows the Agent card with its report and no
  nest. See the note in `transcript.mts`.

Codex and Antigravity both lead with this view. With batch 8 it's the strategic bet — see
below.

---

# Batch 8 — Git

**Files:** `src/main/agent/manager.ts`, `src/main/agent/snapshots.ts`,
`src/renderer/src/components/DiffPanel.tsx`

- [x] **25. Stage / commit from the diff panel.** Was a short hop, as predicted. A tickbox
  per file plus a message field; `git add -- <paths>` then `git commit -m … -- <paths>`.
  The pathspec on `commit` is the load-bearing part — it keeps the commit to what was
  ticked, so anything the user staged by hand, or another session is mid-edit on in the
  same worktree, is left alone. Committed files then drop out of the panel (they are no
  longer pending), which is `Mark reviewed` scoped to the commit. Errors are surfaced
  verbatim: `git()` in `snapshots.ts` deliberately swallows failures, so this needed a
  `gitTry()` that keeps stderr — verified against a real "Author identity unknown", where
  the message is the entire value of the feature.
- [x] **24. Parallel agents per repo via git worktrees.** `manager.ts`'s one-agent-per-cwd
  assumption turned out to be the *only* thing in the way: everything downstream
  (snapshots, pty, @-mentions, the git baseline) already keys off the resolved cwd, so
  isolation cost a swap there plus `worktrees.ts`. Worktrees live under `userData`, on
  `foreman/<slug>` branches cut from the **main** worktree's HEAD — `--git-common-dir`,
  not `--show-toplevel`, so branching from an already-branched session doesn't record a
  parent that can be deleted out from under it.
  **The safety rule is the design:** a worktree is removed on close only when it has no
  uncommitted changes. Committed work is never at risk either way — the branch ref
  outlives the checkout — so a clean removal loses nothing, and a dirty one is kept with
  its path reported in the rail. Feature 25 is how you get from dirty to clean, which is
  why they belong in one batch.
  **Not built:** the simultaneous side-by-side diff of three agents. Selecting a session
  already switches the diff panel to that worktree's changes, so the comparison is
  sequential rather than side-by-side. `additionalDirectories` (multi-root) also skipped.
  Worktrees are deliberately not reaped at app quit — see the comment on
  `disposeAllSessions`.

**6 + 24 together is the biggest strategic bet in this document.** A subagent tree plus
worktree isolation is the one thing none of Claude, Codex or Gemini ships well on the
desktop.

---

## Feature index

Numbers are stable; batches reference them.

| # | Feature | Batch |
|---|---|---|
| 1 | Slash commands | 4 |
| 2 | Context-window meter | 3 |
| 3 | Real transcript on resume | 5 |
| 4 | Branch a conversation | 5 |
| 5 | Checkpoint + rewind | 1 (option), 6 (UI) |
| 6 | Subagent tree | 7 |
| 7 | Background tasks | 6 |
| 8 | Effort + thinking controls | 6 |
| 9 | Spend guardrails | 1 |
| 10 | MCP panel + `onElicitation` | 3 (status), 6 (mutators) |
| 11 | Skills & agent personas | 3 |
| 12 | `AskUserQuestion` cards | 6 |
| 13 | Prompt suggestions | 1 (option), 6 (UI) |
| 14 | Usage / plan limits + account | 3 |
| 15 | `fallbackModel` + `dontAsk` mode | 1 |
| 16 | Markdown + code blocks | 2 |
| 17 | Image / file attachments | 4 |
| 18 | `@`-file mentions | 4 |
| 19 | Queue messages while running | 4 |
| 20 | Todo/plan strip | 2 |
| 21 | Native notifications + dock badge | 1 |
| 22 | Command palette | 2 |
| 23 | Transcript search | 5 |
| 24 | Git worktree isolation | 8 |
| 25 | Commit from diff panel | 8 |

Three of these are bug fixes wearing feature costumes: **3** (resume shows nothing),
**10c** (`onElicitation` missing ⇒ MCP auth silently declined), **15b** (`dontAsk`
unreachable).

Effort estimates are rough and assume one person who already knows this codebase.
