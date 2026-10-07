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
- **Read-only tooling**: scout, planner, and reviewer use `ffgrep`/`fffind`
  instead of `grep`/`find`, and none of them has `bash`. If `ffgrep`/`fffind`
  are not registered (the `@ff-labs/pi-fff` package is optional), the extension
  substitutes the built-in `grep`/`find` at dispatch time.
- **Workflow prompt names**: upstream's `/implement`, `/scout-and-plan`, and
  `/implement-and-review` are renamed to `/scout-plan-implement`,
  `/scout-plan`, and `/implement-review`, so each name lists its chain's stages.
  The chains themselves are unchanged.

## Agents

| Agent     | Tools                                                                                                                                             | Model    |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `scout`   | read, ffgrep, fffind, ls                                                                                                                          | inherit  |
| `planner` | read, ffgrep, fffind, ls                                                                                                                          | inherit  |
| `worker`  | (all default)                                                                                                                                     | inherit  |
| `reviewer` | read, ffgrep, fffind, web_fetch, web_search, slack_search, slack_read_channel, slack_read_thread, session_search, memory_read, memory_search, memory_status | inherit |

Notes:

- To pin an agent's model, add it to `~/.pi/agent/subagent.json`:

  ```json
  { "models": { "scout": "baseten/zai-org/GLM-5.3-Flash" } }
  ```

  Overrides win over agent frontmatter; unknown agent names and malformed
  entries are warned about and ignored.
- Reviewer is enforced read-only by tool selection: no bash, so no `git diff`.
  Name the files (or describe the changes) in the task.
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
  startup validation, not complete child-tool containment: tools guard does
  not own remain observe-only, and running children keep their launch
  snapshot.

## Workflow prompts

Each command name lists its stages, so what a command skips is visible:

- `/scout-plan <task>`: scout → planner. Gathers context and returns a plan; no implementation
- `/scout-plan-implement <task>`: scout → planner → worker. Gathers context, plans, implements
- `/implement-review <task>`: worker → reviewer → worker. Implements, reviews, applies feedback; no scouting or planning, for well-specified tasks

Each runs as a subagent chain, passing output between steps via `{previous}`.
