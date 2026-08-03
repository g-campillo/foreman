import type { AgentDefinition, HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk'
import { READ_ONLY_TOOLS } from '../../lsp/tools'
import { takeOrchestration } from './permissions'

/**
 * What the model is told the moment a plan is approved with "subagents".
 *
 * Delivered on a PostToolUse hook rather than as a message, and that choice is
 * the whole design. The input queue is gated shut for the length of a turn
 * (queue.ts, driven from setStatus), so a message pushed at approval time does
 * not reach the model until the turn ENDS — by which point the agent has
 * already implemented the plan by itself. A hook's `additionalContext` lands
 * before the next model request, which is exactly the seam this needs.
 *
 * Verified live before being built on, because none of it is documented:
 * PostToolUse does fire for ExitPlanMode, `additionalContext` is honoured on it,
 * and it arrives in time — a probe telling the model to say PINEAPPLE produced
 * PINEAPPLE as the first word of the post-approval message. Same mechanism the
 * LSP diagnostics hook already depends on (lsp/diagnose.ts).
 *
 * Worth recording from that probe: the hook's `tool_input` for ExitPlanMode is
 * EMPTY — the plan arrives in `tool_response`. So rewriting `updatedInput` on
 * the permission answer, the obvious-looking alternative, could never have
 * worked regardless of the `planWasEdited` question.
 *
 * THE VERBATIM INSISTENCE IN STEPS 1, 2 AND 4 IS LOAD-BEARING. The implementer
 * now ticks the user's checklist itself — it has to, since this agent spends
 * the whole implementation blocked inside one Agent call — and `latestTodos`
 * joins its tasks to these rows on the step's TEXT, the two id spaces being
 * indistinguishable. Reword a step on the way down and its row simply stops
 * advancing on screen.
 *
 * Step 5 is the backstop for that, and it is what bounds the worst case: with
 * every step paraphrased, nothing matched and the renderer's positional
 * fallback ruled out, the checklist degrades to what it did before any of this
 * existed — one late catch-up — instead of sitting stuck forever.
 *
 * Tagged like the diagnostics injection, so anything the model did not write
 * itself is visibly framed in its own context.
 */
export const ORCHESTRATION = `<foreman-orchestration>
The user approved this plan with "Approve · subagents". Carry it out by
delegating, not by editing files yourself.

1. Call TaskCreate once per step of the plan BEFORE you delegate anything, with
   the step's own wording, verbatim. TaskUpdate each one to "in_progress" /
   "completed" as the work lands.
2. Spawn the \`implementer\` agent (Agent tool, subagent_type: "implementer") and
   give it the plan plus the absolute paths it names, quoting every step VERBATIM
   in the same wording you just used as its subject. Wait for it.
3. Then spawn \`reviewer\` and \`tester\`. Issue both in the SAME message so they
   run in parallel, and wait for both. Give the reviewer the plan text, so it has
   a spec to review against rather than an opinion.
4. If either reports a problem, delegate the fix back to \`implementer\`, quoting
   the steps it must revisit in their original wording, then re-run \`tester\`
   once. Stop after that single repair round and report what is still
   outstanding rather than looping.
5. TaskUpdate to "completed" any step you carried out yourself, and any step the
   implementer finished but did not tick.
6. Finish with a short summary: what changed, what the reviewer found, what the
   tests did.

Edit files directly only to unblock a subagent that cannot proceed. If the Agent
tool is not available in this session, implement the plan yourself and say so in
your first message.
</foreman-orchestration>`

/**
 * Seeds the checklist strip above the transcript.
 *
 * Injected on EVERY plan approval, not only the delegating one, and that is the
 * fix rather than a nicety. TodoStrip and `latestTodos` have folded TaskCreate /
 * TaskUpdate into a plan strip since they were written, and across every project
 * directory on this machine `TaskCreate` fires only when something asks for it —
 * nothing in Foreman ever did. The feature was complete and invisible.
 *
 * Same delivery seam as ORCHESTRATION below it, for the same reason: a message
 * pushed at approval time sits behind the queue gate until the turn ENDS, by
 * which point the work is done and a checklist is an epitaph.
 *
 * `TodoWrite` is deliberately not mentioned: it does not exist in the installed
 * SDK. Naming a tool the model cannot call spends a turn on the failure.
 */
export const CHECKLIST = `<foreman-checklist>
Before doing any of the work, call TaskCreate once per step of the approved plan,
in plan order, with the step's own wording as the subject. Then TaskUpdate each
one to "in_progress" as you start it and "completed" as you finish it, so the
user can watch the plan advance. Use TaskUpdate with status "deleted" for a step
the plan turned out not to need.
</foreman-checklist>`

/**
 * The three roles, passed at construction because `agents` is a constructor-only
 * option — Query exposes no way to add one mid-session, and `reinitialize()`
 * takes no arguments.
 *
 * Passed UNCONDITIONALLY for every session. They cost three descriptions in the
 * Agent tool's schema and nothing else until one is invoked, whereas gating them
 * on the button would mean rebuilding the session in order to use it.
 *
 * `settingSources` is not passed, so filesystem agents in ~/.claude/agents still
 * load alongside these. There are none on this machine today, which is precisely
 * why shipping them matters: without them "use subagents" has no roles to name.
 *
 * `tools` is a STEER, not a sandbox — reviewer and tester both hold Bash, and
 * Bash can write. The point of the list is to keep each agent in role. What
 * actually contains them is canUseTool, which still fires for subagent calls.
 */
export const PLAN_AGENTS: Record<string, AgentDefinition> = {
  implementer: {
    description:
      'Implements an already-approved plan. Give it the full plan text and the absolute paths it names. Use for the code-writing half of a plan; never for reviewing or testing its own work.',
    tools: [
      'Read',
      'Edit',
      'Write',
      'MultiEdit',
      'NotebookEdit',
      'Glob',
      'Grep',
      'Bash',
      // THESE TWO DRIVE THE PARENT'S CHECKLIST, not a list of this agent's own.
      //
      // `latestTodos` folds a subagent's task calls into the plan strip the user
      // is watching, joined on the SUBJECT TEXT — the two id spaces collide,
      // both numbering from 1, so the wording of a step is the only thing the
      // two threads share. That is why the prompt below insists a step be copied
      // rather than summarised: THE TEXT IS THE JOIN KEY, and a paraphrased step
      // simply stops advancing on screen.
      //
      // Withholding them is what used to make the strip sit still for the whole
      // implementation: the parent owned the checklist and was blocked inside one
      // Agent call until the moment everything ticked at once.
      'TaskCreate',
      'TaskUpdate',
      // `TaskList` stays out, and `TodoWrite` does not exist in the installed
      // SDK at all. TaskList would only let the model read back a list it was
      // handed in its own prompt, and an unused tool schema is pure context cost
      // on every request; title.ts measures the same trade at $0.038 -> $0.0037.
      //
      // `reviewer` and `tester` hold none of the three, and that is the same
      // decision made the other way: their breakdown of the work is not the
      // plan, and one that happened to be the same length as it would be a
      // candidate for `latestTodos`'s positional fallback.
      ...READ_ONLY_TOOLS,
    ],
    prompt: [
      'You implement an approved plan, exactly as written.',
      '',
      'The plan is the spec. Do not redesign it, do not expand its scope, and do',
      'not skip steps you disagree with — if a step is wrong or impossible, do the',
      'rest and say so in your report.',
      '',
      'The user is watching a checklist of those steps. Call TaskCreate once per',
      "step, in plan order, with the step's wording COPIED EXACTLY — not",
      'summarised — then TaskUpdate each one to "in_progress" as you start it and',
      '"completed" as you finish it. Those rows are matched back to the plan by',
      'their text, so a step you reword is a step that stops moving on screen. Do',
      'not add a task the plan did not name and do not delete one: a step you did',
      'not do stays visibly unfinished, which is the point.',
      '',
      'Match the surrounding code: its naming, its error handling, its comment',
      'style. Prefer editing an existing file over adding a new one.',
      '',
      'Do not commit. Do not run the test suite — a separate agent does that.',
      '',
      'Report back: every file you changed and why, every step of the plan you did',
      'not complete, and anything you found that the plan got wrong.',
    ].join('\n'),
  },
  reviewer: {
    description:
      'Reviews a finished implementation against the plan it was meant to follow. Read-only: it reports, it never fixes. Use after the implementer returns.',
    tools: ['Read', 'Glob', 'Grep', 'Bash', ...READ_ONLY_TOOLS],
    prompt: [
      'You review work that has just been done against the plan it was meant to',
      'follow. You do not fix anything — you report.',
      '',
      'Start from `git diff` and `git status`: the diff is what actually changed,',
      'and it is the only honest input. Then read the plan and check the diff',
      'against it.',
      '',
      'Answer four questions, in this order:',
      '  1. Does every step of the plan appear in the diff?',
      '  2. Does anything in the diff go BEYOND the plan?',
      '  3. Is it correct — edge cases, error paths, types, resource cleanup?',
      '  4. Does it match the conventions of the code around it?',
      '',
      'Use lsp_diagnostics rather than guessing whether something compiles.',
      '',
      'Be specific: file and line, what is wrong, what it should be. An approval',
      'with no findings is a valid and useful result — say so plainly rather than',
      'inventing something to justify the review.',
    ].join('\n'),
  },
  tester: {
    description:
      "Builds, typechecks and runs the project's tests, then reports what failed. Does not fix anything. Use after the implementer returns.",
    tools: ['Read', 'Glob', 'Grep', 'Bash', ...READ_ONLY_TOOLS],
    prompt: [
      'You verify that the project still builds and its tests still pass. You do',
      'not fix anything — you report.',
      '',
      "Find the project's own commands first: read package.json scripts, a",
      'Makefile, pom.xml, or the equivalent. Run the typecheck/build and the test',
      'suite. Do not invent a test runner the project does not use, and do not',
      'install anything.',
      '',
      'If the project has no tests, say exactly that — do not write some.',
      '',
      'Report: the exact commands you ran, pass/fail for each, and the failing',
      'output trimmed to the part that identifies the failure. Do not paraphrase',
      'an error; quote it.',
    ].join('\n'),
  },
}

/**
 * The directives, delivered at the one moment they are useful.
 *
 * Its own PostToolUse matcher rather than folding into the PostToolBatch
 * diagnostics hook: a separate event with a separate matcher, so there is no
 * question of two hooks on one event competing to be heard.
 *
 * CHECKLIST rides EVERY approval and ORCHESTRATION only the delegating one. The
 * split is the point: seeding the plan strip is worth doing whichever Approve
 * button was pressed, whereas "delegate this" is a choice the user made and must
 * not be inherited by a plain approval later in the same session — which is what
 * takeOrchestration's read-and-clear guarantees.
 */
export function makePlanHook(sessionId: string): HookCallbackMatcher[] {
  return [
    {
      matcher: 'ExitPlanMode',
      hooks: [
        async (input) => {
          if (input.hook_event_name !== 'PostToolUse') return { continue: true }
          const orchestrate = takeOrchestration(sessionId)
          return {
            continue: true,
            hookSpecificOutput: {
              hookEventName: 'PostToolUse',
              additionalContext: orchestrate ? `${CHECKLIST}\n\n${ORCHESTRATION}` : CHECKLIST,
            },
          }
        },
      ],
    },
  ]
}
