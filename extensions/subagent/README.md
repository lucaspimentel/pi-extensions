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

## Choosing an agent

- `scout`: locate code and summarize how it connects; compressed context for
  a handoff.
- `planner`: turn context and requirements into an ordered implementation
  plan.
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
