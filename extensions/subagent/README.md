# subagent

Delegate tasks to specialized subagents with isolated context windows. Forked from
pi's example extension (`examples/extensions/subagent` in the pi-coding-agent npm
package); the example's README is authoritative for shared behavior (modes,
streaming, usage display, security model).

## Changes vs the upstream example

- **Bundled agents**: `agents/*.md` ship with the extension and are discovered
  next to `agents.ts` (via `import.meta.url`), so no `~/.pi/agent/agents` setup is
  required. Bundled agents load regardless of `agentScope`.
- **Precedence**: project agents (`.pi/agents/`) override user agents
  (`~/.pi/agent/agents/`) override bundled agents, on name collision. Drop a
  `scout.md` into `~/.pi/agent/agents/` to retune scout's prompt or tools
  without touching the repo.
- **Model overrides**: all agents inherit the dispatching session's model. Pin
  per-agent models in `~/.pi/agent/subagent.json` (see below) without
  duplicating agent files.
- **Panels**: `subagent({ panel, task })` fans one task across a named preset's
  read-only models and merges the answers with a judge model, with per-model
  attribution, a bounded judge input, a retry-then-fallback path, and a fixed
  10-minute per-child timeout. See "Panels".
- **Agent discovery**: the `subagent` tool describes the discovered scope-`user`
  agents, rewritten per request, and the `subagent_list` tool returns the full
  catalog (source, model, tools) without spawning. See "Discovering agents".
- **Read-only tooling**: scout, planner, reviewer, and researcher use
  `ffgrep`/`fffind` instead of `grep`/`find`, and none of them has `bash`. If
  `ffgrep`/`fffind` are not registered (the `@ff-labs/pi-fff` package is
  optional), the extension substitutes the built-in `grep`/`find` at dispatch
  time. The same agents can
  inspect diffs, history, and working-tree state via the allowlisted read-only
  `git_read` tool (extensions/git-read/): diff, log, show, and status only,
  with per-subcommand flag allowlists, no shell, and no repo mutation. PRs,
  issues, checks, Actions runs, and scoped GitHub API reads are reachable via
  the allowlisted read-only `gh_read` tool (extensions/gh-read/): pr
  view/diff/list/checks, issue view/list, auth status, and run list/view as
  native argv commands (run logs are bounded to the first and last 50 KiB of
  output), plus `repo contents`/`repo tree` (pinned file and tree reads),
  `commit checks` (check runs + legacy statuses with bounded continuation),
  `advisory view` (exact CVE/GHSA lookup), `check annotations` (one check
  run's annotations, still a single 100-item page), `repo metadata` (flat
  repository facts: default branch, description, visibility, URLs),
  `pr comments` (inline review comments and replies), `pr reviews`
  (review bodies and verdicts), `issue comments` (conversation comments
  on an issue or PR, from the issues endpoint, unlike inline review
  comments), `pr threads` (GraphQL review threads, resolved and outdated
  included, paged by cursor), and `org team` (one organization team by bare
  org login and team slug, a single unpaged object) as structured API
  operations. Every one of them is a network read (guard class
  `remote-read`), and the API operations work outside a git worktree. The PR
  API operations require explicit `repo` + a positive safe-integer `pr`
  number and `issue comments` requires explicit `repo` + a positive
  safe-integer `issue` number; all accept optional jq and independent
  continuation tokens bound to the same operation/repo/target, except
  `org team`, which is one request with no continuation.
  The REST comment and review reads return verbatim arrays, `pr threads`
  returns the GraphQL `reviewThreads` nodes, and none of these mutable
  listings is a SHA-pinned snapshot; only `pr threads` provides
  resolved/outdated thread state. Native `pr view --comments` and
  `issue comments` cover conversation comments instead of inline discussions.
- **Workflow prompt names**: upstream's `/implement`, `/scout-and-plan`, and
  `/implement-and-review` are renamed to `/scout-plan-implement`,
  `/scout-plan`, and `/implement-review`, so each name lists its chain's stages.
  The chains themselves are unchanged.

## Agents

| Agent     | Tools                                                                                                                                             | Model    |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `scout`   | read, ffgrep, fffind, ls, git_read, gh_read                                                                                                                 | inherit  |
| `planner` | read, ffgrep, fffind, ls, git_read, gh_read                                                                                                                 | inherit  |
| `worker`  | (all default)                                                                                                                                     | inherit  |
| `reviewer` | read, ffgrep, fffind, ls, git_read, gh_read, web_fetch, web_search, slack_search, slack_read_channel, slack_read_thread, session_search, session_excerpt, memory_read, memory_search, memory_status | inherit |
| `researcher` | read, ffgrep, fffind, ls, git_read, gh_read, web_fetch, web_search, slack_search, slack_read_channel, slack_read_thread, session_search, session_excerpt, memory_read, memory_search, memory_status | inherit |
| `panelist` | read, ffgrep, fffind, ls, git_read, gh_read, web_fetch, web_search, slack_search, slack_read_channel, slack_read_thread, session_search, session_excerpt, memory_read, memory_search, memory_status | inherit |
| `judge` (internal) | read, ffgrep, fffind, ls, git_read, gh_read | inherit |

Notes:

- To pin an agent's model, add it to `~/.pi/agent/subagent.json`:

  ```json
  { "models": { "scout": "baseten/zai-org/GLM-5.3-Flash" } }
  ```

  Overrides win over agent frontmatter; unknown agent names and malformed
  entries are warned about and ignored.
- Reviewer and researcher are read-only by tool selection: no bash, so no
  builds, tests, or repo mutation. Their evidence tools (`git_read`,
  `gh_read`, `web_fetch`, `web_search`, `slack_search`,
  `slack_read_channel`, `slack_read_thread`, `session_search`,
  `session_excerpt`, `memory_read`, `memory_search`, `memory_status`) are
  declared names, not a runtime guarantee: `resolveAgentTools` silently drops a tool the
  dispatching session did not register, and only `ffgrep`/`fffind` have
  substitutes (the built-in `grep`/`find`). Every other dropped name has no
  fallback, so web, Slack, session, memory, git, and GitHub sources can be
  missing at runtime depending on the session's extensions and
  configuration. Name the files (or describe the changes) in the task when
  `git_read` may be unavailable.
- Worker has no `tools:` line and therefore gets the child process's default
  tool set (your `defaultTools` settings apply). Child processes are
  non-interactive, so any guard-owned prompt in a child is denied regardless
  of the legacy `nonInteractiveAsk` setting; sandboxed work stays free.
- **Guard requirement (guard step 5)**: every dispatch asks the parent
  session's guard extension for a fresh snapshot of its effective profile
  immediately before each spawn (single, parallel, chain, and nested alike)
  and refuses to spawn when the guard is absent, uninitialized, transitioning,
  workspace-locked, blocked by unresolved teardown, or mismatched. The child
  receives that profile via `PI_GUARD_INHERIT` plus a startup gate extension
  (`guard-bootstrap.ts`, passed with `--extension`); the child's guard may
  only keep the inherited profile or switch to research, and the child exits
  nonzero before any model or tool execution unless its guard proves it
  consumed the exact contract. Only the profile is inherited: the child loads
  its own guard configuration for its cwd. This is profile inheritance and
  startup validation, not complete child-tool containment: non-owned tools
  other than write/edit remain observe-only, and running children keep their launch
  snapshot.

## Discovering agents

The model is given the discovered agents without a separate call:

- **`subagent` description (per request)**: `prepareLoadout` rewrites the tool
  description on every request with the scope-`user` agents sorted by name, as
  `name (source) [model: ...]: description`. It lists at most 20 agents and
  truncates each description at 160 characters (`...`), adding a
  `(+N more; call subagent_list for the full list)` suffix. When a project
  agents dir exists, a fixed notice points at `agentScope: "both"` without
  naming project agents, so the description never implies they are reachable
  under the default scope. Output is byte-stable across calls (plain name sort,
  no timestamps), so prompt caching is not churned. The per-agent `tools` list
  is deliberately omitted here and available from `subagent_list`. Discovery
  runs synchronously per request; a throw, or no known cwd, leaves the static
  description in place and never breaks the request. Because discovery now runs
  per request, a malformed `subagent.json` or unknown model-override name warns
  on every request instead of once.
- **`subagent_list` tool**: lists the agents for a single optional parameter,
  `agentScope` (`"user"` default, `"project"`, `"both"`), with source, model,
  and tools. It spawns nothing, asks for no confirmation, and never queries the
  guard snapshot; project agents appear only when the scope includes them. It
  declares `outputSchema` (and matching `structuredContent`), so codemode gets
  structured data, and `readOnlyHint`, so it is allowed during planning.

## Panels

`subagent({panel, task})` runs one task across a named preset's read-only models
and merges the answers with a judge. Presets live in `~/.pi/agent/subagent.json`:

```json
{
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

- `agent` defaults to the bundled `panelist`, and `models` takes 1 to 4 ids;
  duplicates are deduped with a warning, and a malformed preset is warned about
  and ignored. `subagent_list` reports the raw `panels` config and the
  `ignoredPanels` reasons.
- `judge` is optional and resolves in this order: the inline `judge` argument,
  the preset's `judge`, the per-agent `models.judge` override, then the
  dispatching session's model. `judge: "none"` (or `null`) skips the merge and
  returns labeled per-model sections. A `model:` pin in a `judge.md` override is
  not part of that chain.
- `/panel <preset> <text>` is a prompt template that calls the tool with the
  text passed unchanged.

What a call does:

- Panelists spawn in parallel (4 concurrent) with their own `--model`, their
  resolved read-only tool list, the per-model thinking level from settings or
  the session level, a common cwd, and a fresh guard snapshot each. A panelist
  agent that declares `write`/`edit`/`bash`, or declares no `tools:` line, is
  refused before any confirmation or spawn.
- Each panel child has a fixed 10-minute wall-clock timeout behind an opt-in
  `runSingleAgent` option, so the legacy single/tasks/chain modes stay
  unbounded. One shared, idempotent kill controller sends SIGTERM and then
  SIGKILL five seconds later only if the child has not actually exited (it
  tracks `exit`/`close`, not `proc.killed`, which SIGTERM already sets). A
  timed-out child is a failure (`timed out after 10 minutes`, nonzero exit,
  `terminationReason: "timeout"`) with its partial output and usage intact.
- The judge runs `runSingleAgent` with agent `judge`, the fixed code-reading
  tool list (read, ffgrep, fffind, ls, git_read, gh_read; never `subagent`),
  the resolved judge model and thinking level, and the panelist blocks as its
  task: the exact `### PANELIST <model>` header, the repeated task, a bounded
  tool-use summary, the status, and the answer (each answer capped at 50 KiB).
  A failed panelist keeps its block with its error and its partial text under an
  explicit incomplete label.
- A failed judge attempt (nonzero or error exit, captured spawn error, guard
  refusal, or a whitespace-only exit-zero answer) is retried exactly once with
  identical input, model, thinking level, and tools, each attempt taking its own
  fresh guard snapshot. A timeout or abort is terminal; an abort before the
  retry produces the merge-aborted fallback instead. After two failures the
  content falls back to the labeled per-model sections. Panelist answers are
  never discarded.
- Zero surviving panelists skip the judge and return an error result.
- Content is one header line, the applicable short notices (`merge-skipped`,
  `merge-failed`, `merge-aborted`, `partial-merge`, `single-model-merge`,
  `no-survivors`), the merged review or the labeled sections, per-model usage
  lines, an error line plus usage for each failed panelist, the judge usage line
  (noting the retry), and a `Total:` across every panelist and every judge
  attempt. Context tokens are never summed, so the total has no `ctx:` field.
- Details keep each panelist's full messages, uncapped answer, and tool-call
  summary under `results`, the judge with every attempt's raw output under
  `judge`, plus the effective panel config, the notices, and the uncapped merged
  text. Panelist records carry no `step`.
- Display: the collapsed row reproduces the model-facing content with only its
  metadata lines dimmed (the header, the notices, and the trailing usage block),
  always ending with `(Ctrl+O to expand)`. Expanding shows the merged review
  when there is one, then a section per panelist (mark, tool calls, error line
  and answer, usage) and the judge with every attempt, then a `Total:`. A
  running panel shows progress from details instead, with `⏳` for pending
  sections and no expand hint.

Tool availability is a runtime property, not a declaration. `resolveAgentTools`
drops every declared name the dispatching session did not register, and only
`ffgrep`/`fffind` have substitutes, so the same preset can see fewer tools in a
session without the optional search package or the git/GitHub/Slack extensions.

## Choosing an agent

- `scout`: locate code and summarize how it connects; compressed context for
  a handoff.
- `planner`: turn context and requirements into a self-contained implementation
  plan written as a handoff prompt a fresh session could implement from scratch.
- `researcher`: investigate a question and synthesize evidence with
  citations, uncertainty, and gaps; no implementation steps or verdicts.
- `worker`: execute the task with the full default tool set.
- `reviewer`: inspect changes and return a code-review verdict.

Single-agent example:

```json
{"agent":"researcher","task":"Investigate why this behavior changed; synthesize relevant available evidence with citations and identify uncertainty."}
```

## Workflow prompts

Each command name lists its stages, so what a command skips is visible:

- `/scout-plan <task>`: scout → planner. Gathers context and returns a plan; no implementation
- `/scout-plan-implement <task>`: scout → planner → worker. Gathers context, plans, implements
- `/implement-review <task>`: worker → reviewer → worker. Implements, reviews, applies feedback; no scouting or planning, for well-specified tasks
- `/scout-plan-implement-review <task>`: scout → planner → worker → reviewer → worker. Full pipeline: context, plan, implement, review, apply feedback; the review-and-fix loop runs unattended (no human checkpoint between implement and fix)

Each runs as a subagent chain, passing output between steps via `{previous}`.
