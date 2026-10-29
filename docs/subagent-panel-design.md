# `subagent` panel fan-out: N read-only models, one judge merge

Status: design settled 2026-10-29 (interview-driven; see "Decisions" below).
Not implemented. Step 1 is an unresolved spike that gates the `/panel` command
design; everything else in this document is decided.

Everything lands in `extensions/subagent/`. The standalone `model-panel`
extension is explicitly deferred, not cancelled: see "Deferred".

## Problem

Getting a second opinion from a different model today means either switching the
session model (losing the first model's answer) or running `subagent` twice by
hand, in which case both children inherit the dispatching session's model
anyway (`extensions/subagent/index.ts:391-392`: `const inheritsDispatchConfig =
!agent.model`, then `agent.model ?? dispatchDefaults.model`), so the two
"opinions" are the same model twice. `TaskItem` accepts only
`{agent, task, cwd}` (`:559-563`), so there is no way to name a model per child.

There is also nothing that collates multiple answers into one review: the
parallel mode concatenates per-task results (`:885-895`), leaving the reader to
do the comparison.

## Goal

One prompt, N named models in parallel, one merged result with per-model
attribution, usable both by the model (`subagent` tool) and by the user
(`/panel`), reusing the existing spawn, guard-inheritance, streaming, and
usage-reporting machinery.

## Non-goals

- No new extension in this step.
- No write-capable panelists: read-only is enforced, not requested.
- No "combine panel with tasks/chain" in this step (deferred).
- No consensus voting, no disagreement diffing, no schema-enforced merge.

## Verified facts

Facts gathered from pi 1.4.0 (`@earendil-works/pi-coding-agent`) and this repo
before the design was settled:

- Child dispatch is a real `pi` process: `["--mode","json","-p","--no-session"]`
  plus `--model`, `--tools`, `--thinking`, `--append-system-prompt`
  (`extensions/subagent/index.ts:390-399`), JSONL events parsed on stdout
  (`:465-500`), SIGTERM then SIGKILL after 5s on abort (`:528-534`).
- Limits in force today: `MAX_PARALLEL_TASKS = 8`, `MAX_CONCURRENCY = 4`,
  `PER_TASK_OUTPUT_CAP = 50 KiB` (`:54-57`).
- Tool names missing from the dispatching session are dropped, with substitutes
  only for `ffgrep`/`fffind` (`resolveAgentTools`, `:66-78`).
- Guard coupling is per spawn and fail-closed: a fresh parent snapshot
  immediately before spawn, the child startup gate passed with `--extension`,
  and the profile in `PI_GUARD_INHERIT` (`:443-457`, `guard-snapshot.ts:45`).
- Per-agent model overrides already exist in `~/.pi/agent/subagent.json` under
  `models` (`agents.ts:170-215`), which is the natural home for a new `panels`
  key.
- Extension commands are first class and receive the literal argument string:
  `registerCommand(name, { description, getArgumentCompletions, handler(args,
  ctx) })` (`dist/core/extensions/types.d.ts:1171-1177`). There is no
  model-invocable flag on commands; tools are the only model-facing surface.
- Commands execute immediately even mid-stream
  (`dist/core/agent-session.d.ts:546`), and `ctx.waitForIdle()` exists.
- `pi.sendUserMessage(content, { deliverAs, expandPromptTemplates })` starts a
  run whose `before_agent_start.messageType` is `"user"`
  (`types.d.ts:1267-1270`, `:727-733`).
- `pi.appendEntry(customType, data)` plus `registerEntryRenderer` produce
  transcript entries that never enter LLM context (`types.d.ts:1253`,
  `:1271-1273`).
- Nested tool execution from a command handler is the unproven part:
  `ExtensionToolContext.executeTool` is backed only in tool-execution contexts
  ("Without it, nested calls fail", `types.d.ts:269-277`).
- `ctx.scopedModels` and `ctx.modelRegistry` expose the models this session can
  actually use (`types.d.ts:225-232`), which is what preset validation keys on.
- Prompt templates expand arguments before the text reaches the agent, and an
  extension command with the same name wins over a same-named template
  (`docs/prompt-templates.md` in the pi install).

## Config

New `panels` key in `~/.pi/agent/subagent.json`, alongside the existing
per-agent `models` overrides:

```json
{
  "models": { "scout": "baseten/zai-org/GLM-5.3-Flash" },
  "panels": {
    "review": {
      "agent": "reviewer",
      "models": ["anthropic/claude-opus-5-5", "openai/openai/gpt-6.1-sol"],
      "judge": "anthropic/claude-sonnet-5-5"
    },
    "ask": { "models": ["google/gemini-4-argon", "baseten/kimi-k3"] }
  }
}
```

- `agent` optional, defaults to the bundled `panelist`.
- `judge` optional; absent means the dispatching session's model judges.
  `judge: "none"` (or `null`) skips the merge entirely and returns labeled
  per-panelist sections.
- `models` required, 1 to 4 entries; more than 4 is an error naming the cap;
  duplicate ids are deduped with a warning.
- Parsing and validation live next to `applyModelOverrides()`
  (`extensions/subagent/agents.ts:181`). Malformed panels warn and are ignored,
  matching how malformed per-agent overrides behave today. A preset naming an
  unknown agent warns at load and fails at call time listing the valid agents.
  The panel catalog is rebuilt per request on the same path as the agent catalog
  (`prepareLoadout`), so a malformed `panels` entry warns on every request
  rather than once.
- Bundled `agents/panelist.md` (researcher-grade read-only tools) and
  `agents/judge.md` (code-reading tools only) ship with the extension and are
  overridable from `~/.pi/agent/agents/` like every other bundled agent.

## Tool contract

New `subagent` parameters:

| Param | Meaning |
| --- | --- |
| `panel` | Preset name. Expands to N panelists plus a judge. |
| `models` | Inline override of the preset's model list, for this call only. |
| `judge` | Inline override of the preset's judge (`"none"` allowed). |
| `agent` | Inline override of the preset's agent. |
| `task` | The task text, as in single mode. |
| `model` | New optional per-task `model` on a single task or on `tasks[]` entries, for manual pairs without a preset. |

- `panel` is mutually exclusive with `agent`/`task` (single), `tasks`, and
  `chain`. Supplying more than one mode is an error naming the conflicting
  fields.
- `models`, `judge`, and `agent` are overrides of a named preset and are
  rejected without `panel`: a one-off pair with no preset is expressed with the
  new per-task `model` on a single task or `tasks[]` entry instead. The 4-model
  cap applies to the effective list after overrides.
- A preset's `agent` resolves through the same discovery as every other agent
  (bundled, then user, then project, per `agentScope`), so naming a project
  agent requires `agentScope: "both"` or `"project"`, the existing
  `confirmProjectAgents` confirmation still applies when the resolved agent is
  project-sourced, and `cwd` selects the panelists' working directory as it does
  in parallel mode.
- Model ids are validated against `ctx.scopedModels`/`ctx.modelRegistry` before
  any child spawns. An unknown preset, an unusable model, or an unknown agent
  fails with the valid options listed. Nothing spawns on a typo.
- The tool description gains a byte-stable panel section modeled on
  `formatAgentCatalog` (`agents.ts:230-250`): plain name sort, up to 10 presets,
  models joined with `" + "`, `(judge: X)` only when explicitly configured,
  `(agent: Y)` only when not the default panelist, and a `(+N more)` suffix past
  the cap. No timestamps, so prompt caching is not churned.
- `promptGuidelines` gains a line describing when to use `panel` versus a manual
  `tasks[]` pair.

## Spawn contract

Panelists reuse `runSingleAgent`'s path with explicit models:

- argv: `--mode json -p --no-session --model <id> --tools <agent tools>
  [--thinking <level>] --append-system-prompt <tmpfile> "Task: <text>"`, plus
  `--extension <guard-bootstrap>` (`:390-457`).
- `--thinking` is `settings.modelThinkingLevels[model]` when configured,
  otherwise the session's current level. Today the level is only forwarded when
  the agent has no pinned model (`:391-395`), which is exactly the case a panel
  changes.
- Tools are the preset agent's declared names intersected with what the session
  registered (`resolveAgentTools`, `:66-78`).
- Wall-clock timeout of 10 minutes per child, implemented as a per-child timer
  that invokes the same kill sequence abort uses (SIGTERM, then SIGKILL after
  5s, `:528-534`) rather than the parent `AbortSignal`; a timed-out child is
  reported as a failed panelist labeled with the timeout, not a thrown error.
- Each child's final answer is capped at `PER_TASK_OUTPUT_CAP` before it enters
  the judge prompt.
- Guard: one fresh snapshot per spawn, N+1 snapshots per panel, unchanged
  semantics and unchanged refusal behavior (`:443-457`).
- Concurrency: panelists spawn through `mapWithConcurrencyLimit` with the
  existing `MAX_CONCURRENCY`; with the 4-model cap a panel never queues.

The judge is spawned by the same code path, with `agents/judge.md` as its system
prompt, the code-reading tool set, and the framed panel output as its task.

## Merge contract

Judge input, one block per panelist:

```
### PANELIST <model id>
task: <the task text>
tools: read src/Foo.cs, gh_read pr diff, ffgrep BuildSampleRate
<final answer, capped at 50 KiB>
```

Included: the final answer plus a summary of the tools each panelist actually
called, which is what lets the judge tell a checked finding from an assumed one
without paying for full transcripts.

Judge output is a prompt convention, not a schema: `SHARED` / `<MODEL> ONLY` /
`CONFLICTS` sections, each finding carrying a `file:line` and its attribution,
using a short label per model (full id on first use). A judge that ignores the
convention degrades to a merged review rather than failing the call.

Judge tools: the code-reading set (read, ffgrep, fffind, ls, git_read, gh_read),
narrower than the panelists' researcher-grade set, so a CONFLICT can be settled
by opening the file or diff without making every merge pay for web/Slack/memory
work.

Result shape:

- Tool content: merged review, then per-panelist usage lines and the judge usage
  line (turns, tokens, cost), plus a total line for parity with the parallel
  view's collapsed `Total:` (`:1245-1246`).
- Tool details: every panelist's full messages, its raw review text, its
  tool-call summary, the judge's raw output, and the panel config actually used.
- `judge: "none"`: content is the labeled per-panelist sections with a
  "merge skipped" notice and no judge usage line.

## `/panel` command

Step 1 is a spike, because the mechanism is genuinely unproven: can a command
handler run the panel and land a real tool result outside an agent run, or is
`executeTool()` unavailable there (`types.d.ts:269-277`)?

- If the spike succeeds: `/panel <preset> <text>` is an extension command that
  drives the same panel core, so the prompt reaches panelists byte for byte and
  the result arrives through the normal tool pipeline with details and renderer.
- If the spike fails: ship a `/panel` prompt template that instructs the model
  to call `subagent({panel, task})`, accepting model-mediated rewording, and
  defer the command to `TODO.md`.
- Either way: no args lists the configured presets; a preset name is required
  (no default preset is guessed, and a bare first token that names no preset is
  an error suggesting the closest one); `getArgumentCompletions` completes
  preset names on the command path; the implementation waits for idle, since
  commands run even mid-stream; and any injected result is labeled as panel
  output rather than appearing as the user's own message.

## Read-only guarantees

- A preset whose agent declares `write`/`edit`/`bash`, or declares no `tools:`
  line at all (which means the default tool set, including those), is refused
  with the offending tools named. `worker` is therefore not a valid panelist
  agent, and read-only cannot be configured away.
- Panelists never receive `subagent`, so panels cannot nest.
- Tool names the session did not register are still dropped at spawn time, with
  substitutes only for `ffgrep`/`fffind`. With the researcher-grade set this
  means web/Slack/session/memory sources can silently differ between sessions;
  the README must say so rather than implying parity.

## Failure semantics

- Panelist failure: survivors are merged and the result is labeled as a
  single-model (or partial) merge, with the failing model and its error text.
  One provider outage never discards the other answers.
- Zero successful panelists: no judge call; the failures are returned.
- Judge failure: one retry, then the per-panelist sections with a notice that
  the merge failed. Paid-for panel output is never discarded.
- Abort: Ctrl+C kills all children through the existing signal path.

## Display

Collapsed tool row shows the merged review with per-panelist and judge usage
lines; expanding reveals each raw review. This mirrors the existing parallel
renderer (`:1160-1250`) rather than introducing a new comparison view.

## Verification plan

1. Spike nested execution from a command handler; record the result in this
   document and in `TODO.md` either way.
2. Panel config parsing and validation as pure functions: malformed panels, the
   4-model cap, duplicate ids, unknown agent, inline-override precedence.
3. Spawn assertions through the existing `setSpawnOverride` seam
   (`index.ts:319`, used by `tests/subagent-tool.test.mts`): one child per
   panelist with its own `--model`, the judge child's argv and tool set, timeout
   kill, survivor merge labeling, judge retry-then-fallback, `judge: "none"`,
   mutual-exclusion errors, write-tool preset refusal, the effective-list cap,
   rejection of `models`/`judge`/`agent` without `panel`, the project-agent
   confirmation under `agentScope: "both"`, and byte-stability of the
   description catalog.
4. Renderer assertions for collapsed versus expanded result views.
5. One live run on a cheap pair (`baseten/glm-5-3-flash` +
   `baseten/deepseek-v4-1-flash`) to confirm a real merge produces the section
   structure and usage lines.
6. Full suite via `env -u PI_GUARD_INHERIT npm run test:ci` through `host_bash`
   (node is not on guard's sandboxed PATH), plus `README.md` updates in
   `extensions/subagent/README.md` and the repo `README.md`.

## Decisions made without asking

Called by the implementer, open to revision:

- More than 4 models in a preset is a hard error; duplicates are deduped with a
  warning rather than rejected.
- The catalog lists at most 10 presets, mirroring `formatAgentCatalog`'s shape.
- Timeout is a fixed 10 minutes per child (no preset field for it).
- `judge: "none"` and `judge` absent are distinct: absent means session model,
  `none` means no merge.
- Judge sections use short model labels after the first full-id mention.

## Deferred

Tracked in `TODO.md`, with rationale:

- Standalone `model-panel` extension (own tool, presets file, comparison
  rendering) if the `subagent` shape proves too cramped. The differentiators
  that would justify it: side-by-side rendering and a preset surface that is not
  `subagent.json`.
- Combining `panel` with `tasks`/`chain` (panel then hand the merge to a worker).
- A per-call cost cap or estimate.
- Panel-specific `appendEntry` transcript rendering for the command path.
- `/panel` as an extension command if the spike fails.
