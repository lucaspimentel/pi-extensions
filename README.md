# pi-extensions

Personal [pi-coding-agent](https://github.com/earendil-works/pi) extensions.

## Install

Global (all projects):

```bash
pi install git:github.com/lucaspimentel/pi-extensions
```

Project-local (writes to `.pi/settings.json`):

```bash
pi install -l git:github.com/lucaspimentel/pi-extensions
```

Pin to a specific ref so `pi update` won't bump it:

```bash
pi install git:github.com/lucaspimentel/pi-extensions@v0.1.0
```

Try without installing:

```bash
pi -e git:github.com/lucaspimentel/pi-extensions
```

## Contents

### Extensions

- **colored-footer** – custom footer styling
- **herdr-ask-user-bridge** – reports "waiting for user to answer question" to [herdr](https://herdr.dev) while the `ask_user_question` tool is awaiting input, so herdr panes show blocked state with a reason (requires the `@juicesharp/rpiv-ask-user-question` extension and herdr's pi integration)
- **herdr-tab-name** – mirrors the pi session display name onto the herdr pane label (always) and the tab label (single-pane tabs only) via `herdr pane rename` / `herdr tab rename`; unnamed sessions reset the labels (`/new`, `/resume`, `/fork`, and name clears: pane label cleared, single-pane tab set to `pi`; plain launches exempt); no-op outside herdr, and subagent child sessions never touch either surface
- **llm-session-name** – generates a short session title from the first user prompt with the session's active model and keeps it fresh every N turns (configurable via `<agentDir>/llm-session-name.json`). A manual `/name` rename locks the session against regeneration; `/name-auto` forces one regeneration that bypasses the lock
- **idle-summary** – generates a brief summary of the session when pi has been idle for a while; `/idle-summary` triggers one immediately, `/idle-summary model` picks the model used for summaries
- **plan** – `/plan <task>` disables the `write` and `edit` tools (everything else stays active, including unrestricted bash and MCP tools) and asks the planner for a self-contained handoff prompt (imperative voice, zero assumed context: task, relevant files, constraints, numbered steps, verification criteria). When the planning turn settles, the plan is copied to the clipboard (platform-detected; `PI_PLAN_CLIPBOARD=off` disables) and a menu asks what to do next: implement in this session, clear context via a fresh replacement session and implement from just the plan, decline with feedback so the planner retries (planning mode stays on), or stop. It does **not** switch the model or thinking effort — pick your planner model yourself before `/plan` and switch back afterwards (`/plan cancel` restores early; the old `/plan-cancel` still works as a deprecated alias)
- **stash** – `ctrl+alt+s` / `ctrl+alt+r` stash & restore the editor draft on a disk-backed stack under `~/.pi/agent/pi-stash.json`; `/stash list` shows numbered entries (1 = newest), `/stash pop [n]`, `/stash drop <n>`, `/stash clear` (the old flat names `/pop`, `/stash-list`, `/stash-drop`, `/stash-clear` still work as deprecated aliases)
- **web** – fetch & convert web pages (depends on `html-to-text`)
- **wt-tab-status** – updates the Windows Terminal tab title with the current session status
- **pi-tool-permissions** – Claude Code-style allow/deny/ask permissions
- **external-editor-fix** – fix Ctrl+G external editor on Windows / Git Bash by adding wait flags for GUI editors
- **python** – persistent, sandboxed Python interpreter tool (Linux + bubblewrap): variables/imports survive across calls, the project is mounted read-only at `/workspace`, a private scratch directory is writable at `/scratch`, and network/sockets are blocked via seccomp. Timeouts, cancellation, or crashes kill the whole sandbox (including `setsid` descendants) and are reported with partial output; never falls back to unsandboxed execution. See [extensions/python/README.md](extensions/python/README.md) for the threat model and limits.
- **node** – persistent, sandboxed Node.js interpreter tool mirroring the python tool (Linux + bubblewrap + prlimit + a compiled seccomp launcher). Same mount/state/timeout contract, with node-specific deltas (no top-level await, `require` for builtins and project modules). See [extensions/node/README.md](extensions/node/README.md).
- **session-search** – searches past pi sessions across all projects by keyword, exposed as the model-facing `session_search` tool and the interactive `/session-search` command (lazily maintained index at `~/.pi/agent/session-search-index.jsonl`). See [extensions/session-search/README.md](extensions/session-search/README.md).
- **update-jira** – validated Jira read/update tools (`jira_read`: get digest/raw payload and comment pages; `jira_update`: transition, comment, link_pr, edit) over the Atlassian remote MCP v2 server, plus a run-boundary pointer that tells the model which ticket the current git branch resolves to. See [extensions/update-jira/README.md](extensions/update-jira/README.md).
- **ollama-models** – auto-discovers locally pulled Ollama models (`/api/tags`) and registers them with pi as an `ollama` provider, so they show up in `/model` without maintaining `models.json`. Reads `OLLAMA_HOST` for a non-default server; registers nothing when Ollama is not running.
- **slack-via-claude** – read-only Slack tools (`slack_search`, `slack_read_channel`, `slack_read_thread`) backed by the Slack MCP already configured in Claude Code. Spawns `claude --print` with a read-only tool allowlist, so no separate Slack app registration is required.
- **subagent** – delegate tasks to specialized subagents with isolated context windows (forked from pi's example extension): single/parallel (max 8, 4 concurrent)/chain modes with `{previous}` chaining, live streaming, per-agent usage stats. Ships four agents: `scout` (recon) and `planner` (implementation plans), both read-only via ffgrep/fffind with built-in grep/find fallback; `reviewer` (read-only code review with web/slack/memory/session context tools); `worker` (full tools for delegated edits). All inherit the session model; pin per-agent models in `~/.pi/agent/subagent.json`, and same-name files in `~/.pi/agent/agents/` override agents entirely. Includes the `/scout-plan`, `/scout-plan-implement`, `/implement-review`, and `/scout-plan-implement-review` workflow prompts (names list each chain's stages). See [extensions/subagent/README.md](extensions/subagent/README.md).
- **guard** – sandbox-first permission redesign (the successor to pi-tool-permissions, which stays loaded and enforcing until the step-6 switchover; guard is declared first, so its `bash`/`python`/`node` copies win first-registration-wins and the old sandboxed extensions go dormant): registers `bash`, `host_bash`, `python`, and `node` on a kernel-enforced bubblewrap + seccomp sandbox and enforces decisions on `write`/`edit` too; seven session profiles (`default` → `unrestricted`), HostBash/Pwsh allow/ask/deny rules, a tightened read-only host tier, secret masking, protected paths, read-root grants, workspace-lock auditing, and subagent profile inheritance. `/guard` opens the profile picker; see [extensions/guard/README.md](extensions/guard/README.md) and [docs/guard-design.md](docs/guard-design.md).
- **update-extensions** – `/update-extensions` runs `pi update --extensions` and reloads the runtime in one step
- **timestamps** – dim started/ran/ended timestamp lines on every tool call and result in the transcript and HTML exports
- **git-read** – model-facing `git_read` tool: allowlisted read-only git subcommands (diff, log, show, status) as an argv-array child process, never through a shell. See [docs/git-read-design.md](docs/git-read-design.md).
- **gh-read** – model-facing `gh_read` tool: allowlisted read-only gh subcommands (pr view/diff/list/checks, issue view/list, auth status, run list/view) as an argv-array child process, never through a shell, plus five pinned GitHub API reads with structured parameters and worktree-free operation: `repo contents` (decoded file text with line ranges, directory entries), `repo tree` (recursive or shallow), `commit checks` (check runs plus legacy statuses, bounded continuation), `advisory view` (exact CVE/GHSA lookup), and `check annotations` (one check run's annotations, single 100-item page with an incompleteness notice at a full page). `run view --log`/`--log-failed` fetch run or failed-step logs through a dual-window runner that keeps the first and last 50 KiB of stdout (the middle is omitted with an exact byte-count notice) under a 30 s timeout. External jq filtering is preflighted and sandboxed; API results are capped at 50 KiB with explicit incompleteness labeling. See [docs/gh-read-design.md](docs/gh-read-design.md).

Skills shared between pi and Claude Code live in the separate
[agent-skills](https://github.com/lucaspimentel/agent-skills) repository.

## Layout

```
pi-extensions/
├── package.json          # pi manifest
├── extensions/
│   ├── *.ts              # single-file extensions
│   └── */                # multi-file extensions (web, pi-tool-permissions, idle-summary, ...)
└── tests/                # node-runnable test harnesses (*.test.mts)
```

Runtime npm deps live in the root `package.json` so a single `npm install`
(run by pi after `git clone`) covers all extensions.

## Update

```bash
pi update git:github.com/lucaspimentel/pi-extensions
```
