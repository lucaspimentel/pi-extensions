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
  `scout.md` into `~/.pi/agent/agents/` to retune scout (e.g. pin `model:`)
  without touching the repo.
- **Agent set**: scout, reviewer, worker (upstream also ships planner).
- **Read-only tooling**: scout and reviewer use `ffgrep`/`fffind` instead of
  `grep`/`find`, and neither has `bash`.

## Agents

| Agent    | Tools                                                                                                                                             | Model    |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `scout`  | read, ffgrep, fffind, ls                                                                                                                          | inherit  |
| `worker` | (all default)                                                                                                                                     | inherit  |
| `reviewer` | read, ffgrep, fffind, web_fetch, web_search, slack_search, slack_read_channel, slack_read_thread, session_search, memory_read, memory_search, memory_status | inherit |

Notes:

- All agents inherit the dispatching session's model and thinking level. To pin
  scout (or any agent) to a cheap/fast model, add a same-name agent file with a
  `model:` frontmatter line to `~/.pi/agent/agents/`.
- Reviewer is enforced read-only by tool selection: no bash, so no `git diff`.
  Name the files (or describe the changes) in the task.
- Worker has no `tools:` line and therefore gets the child process's default
  tool set (your `defaultTools` settings apply). Child processes are
  non-interactive, so tool-permission `ask` outcomes there follow the
  `nonInteractiveAsk` setting in `pi-tool-permissions` (see its README); set it
  to `"allow"` for children to act. Interactive subagent dispatches keep
  prompting under the normal rules.

## Workflow prompt

`/implement-and-review <task>` runs worker -> reviewer -> worker as a chain,
passing output between steps via `{previous}`.
