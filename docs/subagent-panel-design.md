# `subagent` panel fan-out: N read-only models, one judge merge

Status: design settled 2026-10-29 (interview-driven; see "Decisions" below).
Implemented on 2026-11-02: Step 2, the `panels` config, agent `role`, and the
bundled `panelist`/`judge` agents (`4bd6ae1`), and Step 3, the panel tool
surface, the read-only fan-out, the `subagent_list` payload, and the `/panel`
prompt template (`492b41f`). Step 4 (the judge spawn and merge) is implemented:
the judge dispatch, the bounded judge input with per-call tool summaries, the
opt-in 10-minute per-child timeout, the retry/fallback matrix, the separate
judge attempt records, the notices, and the content/usage assembly. Step 1 (the
`/panel` command spike) is resolved: a command handler cannot land a tool
result, so `/panel` ships as a prompt template. Step 5 (the collapsed and
expanded display) is implemented; the live run in Step 6 is what remains.
Everything else in this document is decided.

Addition (2026-11-02, second interview round; see "Agent roles", "Config",
"Tool contract", "`subagent_list` contract", and "Verification plan"): the judge
is a bundled, overridable agent, so its model still resolves through the
per-agent `models.judge` override and no new config key is introduced; a new
`role` frontmatter key separates `delegate` from `internal` agents, and an
internal agent is reachable only through a panel; and `subagent_list` reports
the raw `panels` config alongside the presets it ignored.

Addition (2026-11-18; see "Config", "Tool contract", "`subagent_list` contract",
and "Merge contract"): preset config is nested as `panelists` (1 to 4 entries of
`{agent?, model}`, deduped by the pair) plus `judge` (`{agent?, model}`, `null`,
or omitted), replacing the flat `agent`/`models`/judge-string form, which is now
refused with a migration reason; the `subagent` tool parameters mirror that shape
(`panelists` and `judge` replace `models`); `subagent_list` reports resolved
values rather than the file's raw text; the compact panel catalog in the tool
description lists preset names only; and a new bundled, internal `judge-review`
agent merges a review panel into the review findings format instead of the
generic `SHARED` / `<MODEL> ONLY` / `CONFLICTS` sections, which `judge.md` keeps.

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
before the design was settled, and re-verified against 1.5.0, which is the
installed release (`pi --version` on 2026-10-29; `~/.pi/agent/install/releases/`
holds 1.4.0 and 1.5.0):

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
- A command handler cannot land a tool result (verified 2026-10-29 against
  pi 1.5.0, the installed release). `ExtensionCommandContext extends
  ExtensionContext` with session-control methods only (`types.d.ts:306-330`),
  and `ExtensionRunner.createCommandContext()` adds no `tools` and no
  `executeTool()` (`dist/core/extensions/runner.js:724-760`): both come solely
  from `createToolContext()` (`:696-723`), whose nested-call action is wired in
  `agent-session.js:2863-2864` where no command context can reach it.
  `ExtensionAPI` exposes no nested execution either, `ToolInfo` is a `Pick`
  without `execute` (`types.d.ts:1600`), and `ReadonlySessionManager` is a
  `Pick` with no append (`session-manager.d.ts:178`). Even where nested calls
  exist they are absent from the transcript by design ("It does not appear in
  the transcript; a bounded record of it is kept as `nestedCalls` on the
  calling tool's result message", `types.d.ts:292-295`), and
  `_tryExecuteExtensionCommand` awaits the handler and returns only "handled",
  so nothing a handler returns reaches the transcript
  (`agent-session.js:1716-1734`).
- The channels a command handler does have are not tool results.
  `sendMessage` with `registerMessageRenderer` yields a custom-message
  transcript row (`types.d.ts:1280-1284`, `:1273`), and `appendEntry` with
  `registerEntryRenderer` yields a custom entry that never enters LLM context
  (`:1295`, `:1277`); neither carries tool `details` and neither runs the
  `subagent` tool renderer. A throwaway `/panel-spike` command, run in RPC
  mode with only that probe loaded (`--mode rpc -ne -e <probe> --no-session
  --offline`), reported `hasExecuteTool: false`, `hasToolsArray: false`,
  `getAllToolsHasExecute: false`, a `contextKeys` list matching
  `createCommandContext` exactly, a successful
  `message_start`/`message_end` pair for the custom message, one
  `entry_appended` record, zero `tool_execution_*` records, and the RPC
  response `{"id":"spike1","disposition":"handled"}`.
- `ctx.scopedModels` and `ctx.modelRegistry` expose the models this session can
  actually use (`types.d.ts:225-232`). Preset and inline model validation keys on
  the scoped list, since it is the set the session was configured for.
- Prompt templates expand arguments before the text reaches the agent, and an
  extension command with the same name wins over a same-named template
  (`docs/prompt-templates.md` in the pi install).
- Agent frontmatter is read as `name`, `description`, `tools`, and `model` only
  (`AgentFrontmatter`, `agents.ts:44`), and discovery copies exactly those
  fields into `AgentConfig` (`:104`), so a `role:` line is silently ignored
  today. Names resolve through one name-keyed `Map` walked bundled, then user,
  then project (`discoverAgents`, `agents.ts:146`), which is where role
  inheritance hooks in.

## Agent roles: delegate and internal

Agent frontmatter gains an optional `role` key with exactly two values:
`delegate` (the default when the key is absent) and `internal`. `role` is part
of the agent schema, not a panel setting: it describes what an agent is, never
how a preset happens to use it.

- `extensions/subagent/agents/judge.md` declares `role: internal`, so the judge
  is not dispatchable on its own, only as a panel's merge step.
- `extensions/subagent/agents/judge-review.md` (added 2026-11-18) is a second
  internal merge agent for review presets: same fixed tool set and no model pin,
  with the findings-format body described in "Merge contract". It is the agent a
  `review` preset names in `judge.agent`.
- `extensions/subagent/agents/panelist.md` declares no `role` line and stays a
  `delegate`. Its only special property is being the default value of a panelist
  entry's `agent` field, which is a configuration fact: any read-only delegate
  may be a panelist agent.

Role resolves through the agent precedence chain by name, with one deliberate
difference from prompts and tools: those are taken wholly from the most
specific file that defines the agent, whereas an absent `role` falls back down
the chain. So the most specific explicit `role` declaration wins (project over
user over bundled), and the bundled agent's role applies when no file in the
chain declares one. The judge therefore stays `internal` for an
override at `~/.pi/agent/agents/judge.md` until that file declares
`role: delegate`, and a user or project agent with no bundled counterpart can
declare `role: internal` itself.

Effects:

- A directly dispatched internal agent is refused: the `subagent` tool returns
  an error naming the agent and pointing at the panel path
  (`subagent({panel, task})`). The panel's own panelist and judge resolution
  goes through the same discovery and bypasses that check.
- Internal agents are omitted from the per-request `subagent` tool description
  catalog and from the unknown-agent error text; both list dispatchable agents
  only. `subagent_list` shows them, marked, because the full catalog is its
  purpose.
- A preset whose panelist entry names an internal agent is refused, and the
  default `panelist` resolution goes through the same check. A preset's
  `judge.agent` must also be `internal`: an explicit judge agent that resolves to
  a delegate is refused with an error telling the user to declare
  `role: internal`, because a merge agent that is also directly dispatchable
  blurs what the merge prompt is. The bundled `judge` and `judge-review` agents
  satisfy it, and an override file that omits `role` inherits `internal` by name
  (see the precedence rule above), so only a deliberate `role: delegate` breaks.

## Config

New `panels` key in `~/.pi/agent/subagent.json`, alongside the existing
per-agent `models` overrides:

```json
{
  "models": { "scout": "baseten/zai-org/GLM-5.3-Flash" },
  "panels": {
    "review": {
      "panelists": [
        { "agent": "reviewer", "model": "anthropic/claude-opus-5-5" },
        { "agent": "reviewer", "model": "openai/openai/gpt-6.1-sol" }
      ],
      "judge": { "agent": "judge-review", "model": "anthropic/claude-sonnet-5-5" }
    },
    "ask": { "panelists": [{ "model": "google/gemini-4-argon" }, { "model": "baseten/kimi-k3" }] }
  }
}
```

- `panelists` required, 1 to 4 entries of `{agent?, model}`. `agent` defaults to
  the bundled `panelist`, and entries may name different agents. Entries are
  deduped by the `(agent, model)` pair with a warning, so the same model under
  two different agents is a legitimate second panelist; more than 4 entries is
  an error naming the cap, checked before deduplication.
- `judge` optional, `{agent?, model}`. `agent` defaults to the bundled `judge`;
  `model` resolves in this order: the inline `judge` argument, then this
  preset's `judge.model`, then the per-agent override keyed by the resolved
  judge agent name (`models.judge` for the default agent, `models.judge-review`
  for a review preset), then the dispatching session's model. `judge: null`
  skips the merge entirely and returns labeled per-panelist sections.
- Review presets name `judge-review` so the merge follows the findings format
  ("Merge contract"); leaving `judge` out keeps the generic `judge` merge.
- The flat form is refused, not coerced: a preset with an `agent` key, a
  `models` key, or a `judge` string (including `"none"`) is dropped with the
  reason `"agent"/"models"/judge string form is no longer accepted; use
  "panelists": [{"agent": ..., "model": ...}] and "judge": {"agent": ...,
  "model": ...}`. A silent upgrade would have to guess which panelist each
  model belonged to.
- `judge.agent` must resolve at user scope only (bundled, then user; a project
  agent can never satisfy it) and must be `role: internal`. Discovery warns and
  keeps the preset, naming the missing agent or the non-internal one; the call
  itself refuses it. This is the same shape as the panelist-agent check, applied
  against the scope the judge actually resolves in.
- Parsing and validation live next to `applyModelOverrides()`
  (`extensions/subagent/agents.ts`), as a pure `parsePanels` (no filesystem,
  no console) that returns the usable presets plus an `ignoredPanels` list of
  `{name, reason}`. Malformed panels warn and are ignored, matching how
  malformed per-agent overrides behave today. A panelist entry naming an unknown
  agent, and a `judge.agent` that is unknown or not internal, warn at load and
  fail at call time listing the valid agents. The panel catalog is rebuilt per
  request on the same path as the agent catalog (`prepareLoadout`), so a
  malformed `panels` entry warns on every request rather than once. The request
  path prints those warnings on stderr from the same `reason` strings that
  `ignoredPanels` reports and that `subagent_list` returns (see "`subagent_list`
  contract"), so the console warning and the tool result cannot drift.
- Bundled `agents/panelist.md` (researcher-grade read-only tools),
  `agents/judge.md` (generic merge, code-reading tools only), and
  `agents/judge-review.md` (review findings merge, same tools) ship with the
  extension and are overridable from `~/.pi/agent/agents/` like every other
  bundled agent. `judge.md` and `judge-review.md` declare `role: internal`,
  while `agents/panelist.md` declares no `role` line and therefore stays a
  delegate (see "Agent roles").

## Tool contract

New `subagent` parameters:

| Param | Meaning |
| --- | --- |
| `panel` | Preset name. Expands to N panelists, and to the judge once the merge lands. Requires `task`. |
| `panelists` | Inline replacement for the preset's panelist list (1 to 4 entries of `{agent?, model}`), for this call only. Entries normalize and dedupe exactly like config entries. |
| `judge` | Inline replacement for the preset's judge: `{agent?, model}`, or `null` to disable the merge. |
| `agent` | The single mode's agent. It no longer overrides a panel's panelists; each entry names its own agent. |
| `task` | The task text, as in single mode, shared by every panelist. |
| `model` | Optional per-child `model` on a single task, a `tasks[]` entry, or a `chain[]` step, for manual pairs without a preset. |

- `panel` is mutually exclusive with `agent`/`task` (single), `tasks`, and
  `chain`. Supplying more than one mode is an error naming the conflicting
  fields.
- `panelists` and `judge` are overrides of a named preset and are rejected
  without `panel`: a one-off pair with no preset is expressed with the new
  per-child `model` on a single task, a `tasks[]` entry, or a `chain[]` step
  instead. The 4-entry cap applies to the effective list after overrides. The
  retired `models` array is named explicitly rather than ignored, because the
  schema no longer declares it and an extra property would otherwise run the
  preset's own panelists silently.
- Each panelist entry resolves its own agent from the panel's `cwd` through the
  same discovery as every other agent (bundled, then user, then project, per
  `agentScope`), so naming a project agent requires `agentScope: "both"` or
  `"project"`, and the existing `confirmProjectAgents` confirmation applies to
  every project-sourced panelist whose directory is not the trusted session
  project's `.pi/agents`. `cwd` selects the panelists' working directory as it
  does in parallel mode. An entry naming an internal agent is refused here, the
  same check the default `panelist` resolution runs, and a directly dispatched
  internal agent is refused before any spawn with an error naming the agent and
  pointing at the panel path (see "Agent roles"). `judge.agent` resolves at user
  scope only and must be internal, as "Config" describes.
- Model ids are validated against `ctx.scopedModels` before any child spawns, as
  the implementation does: an empty scoped list means no scoping is configured,
  so any non-blank id is accepted, and a model that is scoped but has no usable
  credential is still left to fail in the child. Validation error fields name the
  entry (`panelists[1].model`, `judge.agent`). An unknown preset, an unusable
  model, or an unknown agent fails with the valid options listed, as a tool
  error. Nothing spawns on a typo.
- The tool description gains a byte-stable panel section: plain name sort, up to
  10 presets, **preset names only**, and a `(+N more)` suffix past the cap. Models,
  panelist agents, and the judge agent are deliberately absent, so an internal
  agent's name never reaches the description and the sentence stays small; the
  full resolved values are one `subagent_list` call away. The section appears
  only when at least one panel's every panelist agent resolves to a dispatchable
  agent: with no `panels` key, or only ignored or unusable ones, no panel
  sentence and no `Panels: none` placeholder are appended, so the description
  differs from an unconfigured session only through the agent catalog itself.
  No timestamps, so prompt caching is not churned.
- The panel catalog rides the same per-request rewrite as the agent catalog:
  pure `formatPanelCatalog` lives in `agents.ts` (see "Code and test layout")
  and `index.ts` appends its result to the description that `prepareLoadout`
  returns.
- `promptGuidelines` gains a line describing when to use `panel` versus a manual
  `tasks[]` pair.

## `subagent_list` contract

`subagent_list` gains two fields, present in both `structuredContent` and the
text output and always present, as empty arrays when nothing is configured.
Existing shape assertions change accordingly:

- `panels: [{ name, panelists, judge }]` reports the **resolved** configuration:
  every panelist entry carries its effective agent name (the default
  `panelist` filled in), and `judge` is `{ agent, model }` with the effective
  judge agent and the configured model, `null` when that model is unset, or
  `null` for the whole field when the merge is disabled. The judge model chain
  is not resolved here: it ends at the dispatching session's model, which a
  listing cannot know, so an unset model is reported as `null` rather than
  guessed. File-level whitespace and explicit-omission detail is therefore not
  recoverable from this field; a preset whose panelist agent does not resolve is
  still listed, with the name as written and a diagnostic reason.
- `ignoredPanels: [{ name, reason }]` reports the presets dropped at parse time.
  `reason` is the same string the load path writes to stderr, so the console
  warning and the tool result cannot drift (see "Config").
- The panel listing reuses the existing 100-entry cap and the `(+N more)` suffix
  discipline.
- Agent entries gain a `role` field (`delegate` or `internal`), and the text
  output marks internal agents. `subagent_list` is the surface that shows them:
  the `subagent` description and the unknown-agent error list dispatchable
  agents only (see "Agent roles").

This listing is the resolved configuration, not a run's. The result of an
actual panel run carries the effective configuration it used in its `details`
(see "Merge contract"), which is a different surface with a different contract.

## Spawn contract

Panelists reuse `runSingleAgent`'s path with explicit models:

- argv: `--mode json -p --no-session --model <id> --tools <agent tools>
  [--thinking <level>] --append-system-prompt <tmpfile> "Task: <text>"`, plus
  `--extension <guard-bootstrap>` (`:390-457`).
- `--thinking` is `settings.modelThinkingLevels[model]` when configured,
  otherwise the session's current level. Today the level is only forwarded when
  the agent has no pinned model (`:391-395`), which is exactly the case a panel
  changes.
- Tools are each entry's agent's declared names intersected with what the session
  registered (`resolveAgentTools`, `:66-78`), resolved once per entry.
- Wall-clock timeout of 10 minutes per child, opt-in through a `timeoutMs`
  field on `runSingleAgent`'s child options, so the legacy modes stay unbounded.
  It fires one shared, idempotent kill controller that the abort path uses too:
  SIGTERM immediately, then SIGKILL after 5 s only if the child has not actually
  exited (tracked through `exit`/`close`, never `proc.killed`, which SIGTERM
  already sets). A timed-out child is a `status: "failed"` result with
  `exitCode: null`, `terminationSignal` set,
  `terminationReason: "timeout"`, the error `timed out after 10 minutes`, and
  its collected messages and usage intact, not a thrown error.
- Each panelist's final answer is capped at `PER_TASK_OUTPUT_CAP` before it
  enters the judge prompt; headers, the repeated task, and diagnostic labels are
  outside that budget, and there is no aggregate ceiling on the judge input.
- Guard: one fresh snapshot per spawn, so N snapshots for a panel of N plus one
  per judge attempt, fewer when a pre-spawn refusal never reaches the snapshot;
  unchanged semantics and unchanged refusal behavior (`:443-457`).
- Concurrency: panelists spawn through `mapWithConcurrencyLimit` with the
  existing `MAX_CONCURRENCY`; with the 4-model cap a panel never queues.

The judge is spawned by the same code path with the resolved judge agent's body
as its system prompt (`agents/judge.md` by default, `agents/judge-review.md` for a
preset that names it). Its task is the panelist blocks verbatim
(`promptMode: "verbatim"`, no `Task: ` prefix, no format restatement); its tool
list is the fixed code-reading set resolved by the panel path itself, never the
override agent's declaration; its model and thinking level are the resolved
effective ones; and every attempt carries the parent guard snapshot and its own
fresh inheritance nonce. The judge prompt is a bundled agent file, resolved from
bundled and user scope only (a project `.pi/agents/judge.md` never shadows it),
so `~/.pi/agent/agents/judge.md` retunes it. The same rule covers a
`judge.agent` a preset names, which must itself be `internal`.

## Merge contract

Judge input, one block per panelist in effective configured order:

```
### PANELIST <model id>
task: <the task text>
tools: read src/Foo.cs, gh_read pr diff, ffgrep BuildSampleRate
status: completed
<final answer, capped at 50 KiB>
```

A failed panelist keeps its slot, its error, and any partial text under an
explicit incomplete label:

```
### PANELIST <model id>
task: <the task text>
tools: (none)
status: failed
error: <short failure reason>
[Incomplete partial answer:]
<partial text, capped at 50 KiB; may be empty>
```

The `PANELIST` header, the repeated task, the `status` line, and the diagnostic
labels are outside the 50 KiB answer budget, and the input has no aggregate
ceiling. `tools` is a bounded summary of what that panelist actually called:
known tools render their identifying arguments (the file path for a read, search
patterns, Git/GitHub operation arguments), each displayed argument bounded to
about 80 characters by eliding its middle, so the head keeps the argument's
shape and the tail keeps the file name or the end of a pattern that a right-edge
cut used to remove, which rendered distinct files as identical entries. Unknown
tools fall back to a small deterministic scalar selection, repetitions collapse
with counts (so repeated reads of one file become `read src/Foo.cs x3`), a
failure appears only when a correlated tool result reported `isError`, and only
the first 20 distinct entries are listed with a `(+N more)` suffix. An argument that arrives as an array, such as a Git
invocation's revs and pathspecs or a `gh_read` operation's flags, is joined into
that entry so two calls differing only in their arguments stay distinct; a
non-scalar entry inside such an array is skipped rather than given an invented
representation, so two calls differing only there still share an entry. It never includes tool-result bodies or transcripts.

Included: the final answer plus a summary of the tools each panelist actually
called, which is what lets the judge tell a checked finding from an assumed one
without paying for full transcripts.

Judge output is a prompt convention, not a schema. The bundled `judge` agent
asks for `SHARED` / `<MODEL> ONLY` / `CONFLICTS` sections, each finding carrying
a `file:line` and its attribution, using a short label per model (full id on
first use). A judge that ignores the convention degrades to a plain merged
review rather than failing the call; nonconforming but nonempty prose is still
the merged content.

### `judge-review`: the review findings format

A preset that names `judge.agent: "judge-review"` merges into the findings
format of the `review-pr` skill (`~/source/lucaspimentel/agent-skills/skills/
review-pr/SKILL.md`, "Findings Phase"), so a review panel's output reads like the
single-agent skill's. Panelists keep their own output (`reviewer.md` still emits
`Files Reviewed` / `Critical` / `Warnings` / `Suggestions` / `Summary`); only the
merge changes. The body of `agents/judge-review.md` is the contract:

- `## Findings`: one line per distinct issue, sorted by severity, then path, then
  line, as `- 🔴 CRITICAL \`path/to/file.ts:42\` - what is wrong and why it matters
  [claude-opus-5-5, gpt-6.1-sol]`. Severities are the skill's four: CRITICAL
  (security, data loss, crashes), HIGH (logic errors, bugs, wrong behavior),
  MEDIUM (performance, missing error handling), LOW (style, minor, suggestions).
  A label is the last path segment of that panelist's model ID from its
  `### PANELIST <model>` header, so `anthropic/claude-opus-5-5` is
  `claude-opus-5-5`; the bracket names every panelist that reported the issue, and
  labels are never invented. Two blocks that would produce the same label (one
  model under two agents, or two ids sharing a final segment) are each qualified
  with their full model ID, so the bracket never names one label for two
  panelists. The panelist headings map onto the severities
  (`Critical` to CRITICAL, `Warnings` to HIGH or MEDIUM by stated impact,
  `Suggestions` to LOW), and a heading that contradicts the stated impact is
  regraded.- `## Conflicts`: only when panelists disagree about whether something is a
  defect; those items stay out of the findings list and each line names who claims
  what and the evidence on each side, leaving the disagreement open when it cannot
  be settled. A disagreement about severity alone is not a conflict: it stays in
  the findings at the most severe label proposed.
- `## Summary`: two to three sentences on what the change does and the overall
  risk, introducing no finding absent from the list.
- An italic coverage line, always, even when nothing failed and even in the clean
  case: `_2 of 2 panelists answered._`. It is unconditional so a merge of fewer
  answers can never read as a clean review; the panel's own `partial-merge`
  notice above the merge stays as the machine-readable version.
- Clean case: `## Findings` followed by `No issues were found.` and the coverage
  line, with no conflicts and no summary.

The judge remains read-only and keeps the generic contract's framing rules: it
weights only what a panelist actually answered, treats a tool summary as evidence
of inspection rather than of correctness, never turns repetition into proof,
never invents a citation, and preserves consequential minority findings.

Judge tools: the code-reading set (read, ffgrep, fffind, ls, git_read, gh_read),
narrower than the panelists' researcher-grade set, so a CONFLICT can be settled
by opening the file or diff without making every merge pay for web/Slack/memory
work. The panel path passes this list itself, so an override of
`agents/judge.md` that omits or widens its `tools:` line cannot change it, and
`subagent` is never in the list.

Result shape:

- Tool content, in order: one plain header line naming the preset, the effective
  model count, and the judge (or `none`); the applicable short notices (see
  below); the capped merged review, or the capped labeled per-model sections
  when there is no merge; one usage line per successful panelist labeled with
  its effective requested model; an error line per failed panelist plus its
  usage when any usage field is nonzero; one judge usage line, aggregating both
  attempts and noting the retry, with the failure reason when no merge was
  produced; and a `Total:` across every panelist and every judge attempt.
  Context tokens are never summed, so the total has no `ctx:` field.
- Tool details: `mode: "panel"`, the effective panel config, every panelist's
  full messages, its uncapped final text (`output`), its tool-call summary, the
  judge as a separate top-level record with its raw output, usage, and every
  attempt (each keeping its messages, stderr, error, and uncapped output), the
  notices, and the uncapped successful merged text. Panelist records carry no
  `step`.
- `judge: null`: no judge spawn, a `merge-skipped` notice, the labeled
  per-panelist sections, and no judge usage line.

Notices are short one-line reasons (`merge-skipped`, `merge-failed`,
`merge-aborted`, `partial-merge`, `single-model-merge`, `no-survivors`); full
diagnostics stay in `details`. A produced merge of one survivor is labeled
`single-model-merge`, and any failure among the panelists adds `partial-merge`
naming each failing model with a short error.

## `/panel` and `/review-panel` prompt templates

Step 1 is resolved (2026-10-29, pi 1.5.0): a command handler cannot execute a
tool or produce a tool result, so `/panel` ships as a prompt template.

- `extensions/subagent/prompts/panel.md` takes `<preset> <text>` and
  instructs the model to call `subagent({panel, task})` with the text passed
  unchanged. The prompt therefore reaches panelists through the model, which
  may reword it, and the result arrives mid-run as a normal tool result with
  `details` and the existing renderer, which is what the command path could
  not provide.
- A preset name is required: no default preset is guessed, and with fewer than
  two arguments the template asks the model to report the presets named in the
  tool description rather than pick one. Preset discoverability comes from that
  catalog, because a template cannot list presets dynamically and
  `getArgumentCompletions` exists only for extension commands, so the "no
  arguments lists the presets" behavior is not available on this path.
- Any injected result is labeled as panel output rather than appearing as the
  user's own message.
- `/review-panel [<PR number or URL>] [focus]`
  (`extensions/subagent/prompts/review-panel.md`, added 2026-11-17) is a second
  template on the same surface, scoped to one pull request. It resolves the
  target, prints the repository, number, title, and head SHA in one line, makes one
  `subagent({panel: "review", task})` call, and stops at the result: the template
  tells the main session to reproduce the panel output as returned and ask which
  findings to act on, never to start fixing. Unlike `/panel` it names its preset
  in the template instead of taking one as an argument, so the required-preset
  rule above is satisfied by the template rather than by the user. The panelists
  fetch the PR themselves, so the diff is read once per panelist instead of being
  inlined by the main session; a missing `review` preset is reported, never
  substituted silently. The local `HEAD` is read with `git_read` `log` and
  `-n 1`, and the optional `[focus]` text replaces the contract's `<extra
  review focus>` line, which is deleted when the request carries no focus.

## Read-only guarantees

- A panelist entry whose agent declares `write`/`edit`/`bash`, or declares no
  `tools:` line at all (which means the default tool set, including those), is
  refused with the offending tools named. `worker` is therefore not a valid
  panelist agent, and read-only cannot be configured away. The check reads the
  declared tool names, so a preset cannot widen a panelist beyond its
  declaration; whether an individual declared tool is genuinely read-only is not
  verified. The check runs per entry, because one panel may mix read-only agents.
- Panelists never receive `subagent`, so panels cannot nest, and the panel path
  passes each entry's resolved tool list for that child rather than letting the
  agent's declaration stand alone. The judge is passed the fixed code-reading
  list the same way, whichever judge agent a preset names, so an override
  declaration can narrow it in effect (by making a tool unavailable) but never
  widen it. When nothing survives resolution the child is launched with
  `--no-tools` instead of falling back to the default tool set, which is the
  behavior a fully dropped list used to get.
- Tool names the session did not register are still dropped at spawn time, with
  substitutes only for `ffgrep`/`fffind`. With the researcher-grade set this
  means web/Slack/session/memory sources can silently differ between sessions;
  the README must say so rather than implying parity.

## Failure semantics

- Validation failures are tool errors that list the valid options: an unknown
  preset (the configured preset names, or the `subagent.json` path a user has to
  edit when no preset is configured or every preset in it was ignored), an
  unusable model (the usable ids), an unknown or internal agent (the
  dispatchable agent names), a rejected panelist
  declaration (the offending tools), and the mode conflicts. The single, tasks,
  and chain validation failures return errors too, which they did not before.
- Panelist failure: survivors are still merged and the result is labeled as a
  `single-model-merge` and/or `partial-merge` notice, naming the failing model
  and a short error; one provider outage never discards the other answers.
- Zero successful panelists: no judge call; the failures are returned with a
  `no-survivors` notice and an error result.
- Judge failure: exactly one retry with identical input, model, thinking level,
  and tools, each attempt taking its own fresh guard snapshot. A retry is not
  attempted after a timeout or an abort, and an already-aborted signal before
  the retry produces the merge-aborted fallback instead. When both attempts
  fail, the content falls back to the labeled per-panelist sections with a
  `merge-failed` (or `merge-aborted`) notice; paid-for panel output is never
  discarded.
- Judge attempt failure is a nonzero/error result, a captured spawn error, a
  guard refusal, or a whitespace-only exit-zero answer; the empty answer is
  recorded as a failure rather than as the `(no output)` placeholder.
- Failed-child text carries every distinct piece of evidence, labeled in the
  order `Error`, `Signal`, `stderr`, `Assistant output` and deduplicated, so a
  child that exits nonzero with both an error message and stderr output reports
  both instead of losing one. The bounded one-line reason (`boundedLine`, 160
  characters) stays the short form for collapsed rows and the judge input, and
  it now falls back to `Terminated by signal <signal>` when only a signal was
  observed.
- Abort: Ctrl+C kills all children through the existing signal path, and the
  run reports the abort as a result in every mode instead of a rejection. The
  aborted children keep `status: "aborted"`, their collected messages, and
  their usage, so an abort during the panelist phase still returns the partial
  answers (and, with no survivor, the `no-survivors` notice), and an abort
  during or before the merge returns the panelists' answers with the judge's
  partial output under a `merge-aborted` notice.

## Display

The panel tool row mirrors the other modes. While the panel runs, the
collapsed row is derived from `details`, never from the model-facing content: a
`⏳` header carrying `<n>/<total> done, <k> running, <p> pending`, one line per
model with only a mark (`✓`, `✗`, `⏳`), and, once `details.judge` exists, a
`⏳ judge <model> merging…` line that notes the attempt when a retry is under
way. There is no expand hint until the run finishes. A panelist that has only
streamed still counts as running: its slot in `details` keeps `status:
"running"` until its final result lands, and a panelist that has not been
dispatched yet stays `"pending"`, so the row and the notice gate never mistake a
streaming panelist for a finished one. `isPartial` marks a streaming emit as
well, which keeps the row in progress while the judge alone is still working.

When it finishes, the collapsed row is a status icon (`✓` merged, `◐` unmerged
with survivors, `✗` zero survivors) followed by the model-facing content
reproduced verbatim, with dim styling on only its metadata lines: the header,
the notice lines that follow it, and the trailing usage block plus `Total:`,
found by walking back from the final `Total:` line to the blank line that
precedes the usage run. The row always ends with `(Ctrl+O to expand)`.

Expanding renders a container: the status icon and header, the dim notice
lines, a dim `Task:` line printed once, and, only when a merge was produced, a
`─── merged review ───` label with the merge as `Markdown`. Each panelist then
gets a section (`─── <model> ✓/✗/⏳`, its tool calls as `→ …`, a dim error line
and an incompletely labeled answer when it failed, its answer as `Markdown`, and
its usage line, which is omitted while the panelist is still pending), followed
by the judge section (`─── judge <model> ✓/✗/⏳`,
with `(N attempts)` and per-attempt `attempt N` labels only when there was more
than one attempt, a dim error line for a failed attempt, the tools it called,
its raw output as `Markdown`, and its summed usage), and a final `Total:` across
every panelist and every judge attempt. When nothing merged, the merge slot is
skipped entirely, since the per-model sections carry that text with more detail.
A running panel renders the same container from whatever exists, pending
sections marked `⏳`.

Only the renderer adds styling; the model-facing content stays ANSI-free.
Notices describe finished runs only: `buildPanelNotices` returns an empty list
while any panelist is unsettled or the judge phase is in flight, so a mid-run
emit never reports a survivor count or a merge verdict. The single, chain, and
parallel rows print the same failure diagnostics in their expanded views (the
error, the termination signal, and stderr bounded to its first 2 KiB) and their
collapsed views show a one-line failure summary in place of `(no output)`.

## Code and test layout

Steps 2 to 4 implemented the pure functions, the harness extraction, the tool
wiring, and the judge orchestration described below.

- Pure functions live in `extensions/subagent/agents.ts`, beside the ones they
  mirror: `parsePanels` next to `applyModelOverrides` (`:181`), and
  `formatPanelCatalog`/`formatPanelList` next to `formatAgentCatalog` (`:237`)
  and `formatAgentList` (`:256`). They take values and return strings or
  objects, never touching the filesystem or the console, so tests import
  `agents.ts` directly and need no fake pi. `applyModelOverrides` returns the
  accepted, normalized override map, and `discoverAgents` exposes it as
  `configuredModels` so judge resolution can tell a configuration override from
  an agent frontmatter pin.
- `extensions/subagent/panel.ts` holds the other pure panel helpers:
  `buildToolCallSummary`, `buildPanelistBlock`, `buildPanelJudgeInput`, and the
  shared `truncateTaskOutput`/`PER_TASK_OUTPUT_CAP` used by both the judge input
  and the legacy parallel renderer. No I/O and no console, so
  `tests/subagent-panels.test.mts` imports it directly.
- `extensions/subagent/index.ts` appends the panel catalog to the loadout that
  `prepareLoadout` returns, next to the agent catalog, and holds the tool-level
  wiring: parameter validation (per panelist entry and for the judge), the
  refusals in "Agent roles", the `subagent_list` payload, the per-entry panelist
  fan-out, the judge state machine with its single retry, the shared child kill
  controller, and the content, notice, and usage assembly (`aggregateUsage`,
  `buildPanelNotices`, `formatLabeledPanelReviews`, `formatPanelContent`).
- The fake-pi harness moves out of `tests/subagent-tool.test.mts` into
  `tests/subagent-harness.mts` in its own commit, before the panel work. The new
  file has no `.test.` suffix, is imported rather than run, and is deliberately
  not on the `test:ci` list. It owns three spawn modes: a throwing mode for
  tests that must never spawn, a recording mode that returns the recorded
  argv/env with a restore, and `installControlledSpawn` for the judge lifecycle
  tests, whose children stay alive until the test emits stdout, stderr, an
  error, an exit, or a close. Its captured child records every signal passed to
  `kill` and keeps `killed = true` after SIGTERM, so the escalation path cannot
  rely on that flag. A `waitFor` helper yields on `setImmediate`, which node:test
  mock timers for `setTimeout` never intercept, and bounds itself with a real
  wall-clock deadline rather than an iteration count, since a few thousand
  immediate ticks can drain while a spawn still waits on its temp prompt file
  under full-suite load.
- A new `tests/subagent-panels.test.mts` (added to the `test:ci` list in
  `package.json`) holds the pure parsing, validation, override-precedence,
  configured-model provenance, role-inheritance, catalog-rendering, judge-input,
  truncation, and tool-summary tests. Spawn, mutual-exclusion, judge dispatch,
  retry/fallback, abort/timeout, and description assertions stay in
  `tests/subagent-tool.test.mts`, whose bundled-agent list grows by `judge` and
  `panelist`.

## Verification plan

1. Spike nested execution from a command handler: done (2026-10-29, pi 1.5.0).
   No nested execution and no tool-result path exist in a command context; the
   finding is recorded in `## Verified facts` and in `TODO.md`, and `/panel`
   is a prompt template as a result.
2. Panel config parsing and validation as pure functions in
   `extensions/subagent/agents.ts`, in `tests/subagent-panels.test.mts`:
   malformed panels, the entry cap, duplicate panelists, unknown panelist and
   judge agents, inline-override precedence, resolved values in the
   `subagent_list` payload, role parsing and inheritance through the agent
   precedence chain, and the `formatPanelCatalog`/`formatPanelList` rendering
   (cap, `(+N more)` suffix, byte-stability). Done with Step 2; the nested shape
   and the names-only catalog are covered by item 7.
3. Spawn assertions through the `setSpawnOverride` seam (`index.ts:319`) with
   the harness imported from `tests/subagent-harness.mts`, staying in
   `tests/subagent-tool.test.mts`: one child per panelist with its own
   `--model`, mutual-exclusion errors, write-tool preset refusal, internal-agent
   refusal both on direct dispatch and as a panelist entry's `agent`, rejection
   of `panelists`/`judge` without `panel`, the project-agent confirmation
   under `agentScope: "both"`, catalog byte-stability including that a config
   without panels appends no panel sentence, per-child `model` in the legacy
   modes, and guard snapshots. Done with Step 3. Completed by Step 4: the judge
   child's argv (verbatim blocks, no `Task: ` prefix), its fixed tool set under
   hostile or absent override declarations, `judge: null`, the
   configured-model precedence with a frontmatter pin that adds no level, the
   appended judge prompt inspected mid-spawn, guard snapshots and nonces per
   attempt, partial and single-survivor merge labeling, zero survivors, the
   retry matrix (ordinary failure, emitted spawn error, synchronous spawn
   throw, guard refusal, empty or whitespace-only answer), terminal timeout,
   abort during and before the merge, usage and total accounting, nonconforming
   judge prose, merged-output truncation, and the child lifecycle cases
   (10-minute SIGTERM, SIGKILL five seconds later while `killed` is already
   true, a real exit during the grace period preventing SIGKILL, null-code
   signal exits, timer/listener cleanup, the legacy modes never acquiring the
   timer, and abort reusing the same escalation).
4. Renderer assertions for collapsed versus expanded result views. Done with
   Step 5: exact ANSI-stripped text through a theme stub with visible role
   markers for the merged collapsed and expanded views, the running collapsed
   and expanded views, the unmerged expanded view (merge slot skipped), a
   zero-panelist fallback, and the judge retry, plus the mid-run notice gate.
5. One live run on a cheap pair (`baseten/glm-5-3-flash` +
   `baseten/deepseek-v4-1-flash`) to confirm a real merge produces the section
   structure and usage lines. Not done; deferred to Step 6.
6. Full suite via `env -u PI_GUARD_INHERIT npm run test:ci` through `host_bash`
   (node is not on guard's sandboxed PATH), plus `extensions/subagent/README.md`
   (the panel surface, the `role` concept, the `panels` config, and the
   `subagent_list` fields) and the repo `README.md`, both updated with Step 4.
   The live run remains.
7. The nested `panelists`/`judge` config, the mirrored tool parameters, the
   resolved `subagent_list` values, the names-only catalog, and the
   `judge-review` merge format (2026-11-18; see "Config", "Tool contract",
   "`subagent_list` contract", and "Merge contract"). Done in this change:
   `parsePanels` cases for the new shapes, the migration refusal, pair dedupe,
   the per-entry cap, judge omission/`null`/object forms, and frozen-input
   immutability in `tests/subagent-panels.test.mts`; discovery diagnostics for
   unresolved panelist agents and for a missing or non-internal judge agent,
   plus the bundled `judge-review` agent's tools, role, and contract body, in the
   same file; the tool-level cases in `tests/subagent-tool.test.mts` for the
   parameter schemas, the per-entry preflight and model field paths, the
   effective `details.panel` shape, two panelists with different agents and tool
   lists, the judge agent's prompt and fixed tools, the delegate-judge refusal,
   project shadowing, the resolved listing, and the names-only catalog. Verified
   with `npx tsc --noEmit`, both suites, and the live run in item 5.

## Decisions made without asking

Called by the implementer, open to revision:

- More than 4 models in a preset is a hard error; duplicates are deduped with a
  warning rather than rejected.
- The catalog lists at most 10 presets, mirroring `formatAgentCatalog`'s shape.
- Timeout is a fixed 10 minutes per panel child (no preset field for it), and it
  is terminal: a timed-out judge is never retried.
- The judge retries exactly once after an ordinary failure, with identical
  input, model, thinking level, and tools, and each attempt takes its own fresh
  guard snapshot.
- `judge: null` and an omitted `judge` are distinct: omitted falls through to
  the per-agent override keyed by the resolved judge agent name and then the
  session model, while `null` means no merge at all.
- Judge sections use short model labels after the first full-id mention.
- The `role` key has exactly two values. A future value must describe what the
  agent is, a capability or a dispatch class, never how a preset happens to use
  it.
- The unknown-agent error text lists dispatchable agents only, so internal
  agents are omitted from it exactly as they are from the description catalog.
- (2026-11-18) The flat preset form is refused with a migration reason rather
  than accepted as an alias, and `judge: "none"` is dropped in favor of `null`;
  one shape per concept was worth the one-time config edit.
- (2026-11-18) Panelist entries dedupe by `(agent, model)`, so one model may run
  under two agents; the cap still counts entries, not distinct models.
- (2026-11-18) Duplicate inline `panelists` collapse silently, matching how the
  inline model override behaved, because `details.panel` reports what ran.
- (2026-11-18) The compact catalog lists preset names only; models, agents, and
  the judge are read from `subagent_list` instead.
- (2026-11-18) The review merge reports attribution with the last path segment of
  each panelist's model id, and the coverage line is unconditional.
- (2026-11-18) A configured `judge.agent` must be `internal`, and it resolves at
  user scope only, mirroring the bundled judge's rule.

## Deferred

Tracked in `TODO.md`, with rationale:

- Standalone `model-panel` extension (own tool, presets file, comparison
  rendering) if the `subagent` shape proves too cramped. The differentiators
  that would justify it: side-by-side rendering and a preset surface that is not
  `subagent.json`.
- Combining `panel` with `tasks`/`chain` (panel then hand the merge to a worker).
- A per-call cost cap or estimate.
- Panel-specific `appendEntry` transcript rendering for the command path.
- `/panel` as an extension command: it needs nested tool execution and a
  tool-result entry, neither of which a command handler has (verified 2026-10-29
  against pi 1.5.0); revisit only if pi exposes one. The prompt-template path is
  what ships instead.
