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
  non-interactive, so tool-permission `ask` outcomes there follow the
  `nonInteractiveAsk` setting in `pi-tool-permissions` (see its README); set it
  to `"allow"` for children to act. Interactive subagent dispatches keep
  prompting under the normal rules.

## Workflow prompts

- `/implement <task>` — scout → planner → worker: gather context, plan, implement
- `/scout-and-plan <task>` — scout → planner: context and plan, no implementation
- `/implement-and-review <task>` — worker → reviewer → worker: implement, review, apply feedback

Each runs as a subagent chain, passing output between steps via `{previous}`.
