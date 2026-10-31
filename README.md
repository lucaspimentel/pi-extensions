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
- **session-name-llm** – `/name-llm` regenerates the session title on demand from the current title, the session's original prompts and recent turns. Nothing is titled automatically: the command is the only trigger and it replaces a manual `/name` too. A rename that lands while the model call is in flight wins over the generated title. The title model is the pin in `~/.pi/agent/session-name-llm.json` (`"model": "provider/modelId"`) when it is found and has configured auth, otherwise the session's active model; a pin that cannot be used is reported once per session in the result message. `/name-llm model` picks the pin, `/name-llm model clear` removes it.
- **idle-summary** – generates a brief summary of the session when pi has been idle for a while; `/idle-summary` triggers one immediately. The summary model is the pin in `~/.pi/agent/idle-summary.json` (`"model": "provider/modelId"`, next to `timeoutMinutes`) when it is found and has configured auth, otherwise the session's active model (one model per run, no fallback chain); a pin that cannot be used is reported once per session. `/idle-summary model` picks the pin, `/idle-summary model clear` removes it.
- **plan** – moved to the shared [agent-skills](https://github.com/lucaspimentel/agent-skills/blob/main/skills/plan/SKILL.md) repository as an explicitly invoked skill: `/skill:plan` in pi. It supersedes this repository's retired `/plan` extension.
- **stash** – `ctrl+alt+s` / `ctrl+alt+r` stash & restore the editor draft on a disk-backed stack under `~/.pi/agent/pi-stash.json`; `/stash list` shows numbered entries (1 = newest), `/stash pop [n]`, `/stash drop <n>`, `/stash clear`
- **web** – fetch & convert web pages (depends on `html-to-text`)
- **wt-tab-status** – updates the Windows Terminal tab title with the current session status
- **pi-tool-permissions** – Claude Code-style allow/deny/ask permissions
- **external-editor-fix** – fix Ctrl+G external editor on Windows / Git Bash by adding wait flags for GUI editors
- **session-search** – searches past pi sessions across all projects by keyword, exposed as the model-facing `session_search` tool and the interactive `/session-search` command (lazily maintained index at `~/.pi/agent/session-search-index.jsonl`). See [extensions/session-search/README.md](extensions/session-search/README.md).
- **update-jira** – validated Jira read/update tools (`jira_read`: get digest/raw payload and comment pages; `jira_update`: transition, comment, link_pr, edit) over the Atlassian remote MCP v2 server, plus a run-boundary pointer that tells the model which ticket the current git branch resolves to. See [extensions/update-jira/README.md](extensions/update-jira/README.md).
- **ollama-models** – auto-discovers locally pulled Ollama models (`/api/tags`) and registers them with pi as an `ollama` provider, so they show up in `/model` without maintaining `models.json`. Reads `OLLAMA_HOST` for a non-default server; registers nothing when Ollama is not running.
- **slack-via-claude** – read-only Slack tools (`slack_search`, `slack_read_channel`, `slack_read_thread`) backed by the Slack MCP already configured in Claude Code. Spawns `claude --print` with a read-only tool allowlist, so no separate Slack app registration is required.
- **subagent** – delegate tasks to specialized subagents with isolated context windows (forked from pi's example extension): single/parallel (max 8, 4 concurrent)/chain modes with `{previous}` chaining, live streaming, per-agent usage stats. Ships five agents: `scout` (recon) and `planner` (implementation plans), both read-only via ffgrep/fffind with built-in grep/find fallback; `worker` (full tools for delegated edits); `reviewer` (read-only code review) and `researcher` (read-only evidence synthesis), both with web/slack/memory/session context tools. The discovered agents are listed to the model automatically in the `subagent` tool description (scope `user`), and `subagent_list` returns them programmatically (source, model, tools) without spawning anything. All inherit the session model; pin per-agent models in `~/.pi/agent/subagent.json`, and same-name files in `~/.pi/agent/agents/` override agents entirely. Includes the `/scout-plan`, `/scout-plan-implement`, `/implement-review`, and `/scout-plan-implement-review` workflow prompts (names list each chain's stages). See [extensions/subagent/README.md](extensions/subagent/README.md).
- **guard** – sandbox-first permission redesign (the successor to pi-tool-permissions, which stays loaded and enforcing until the step-6 switchover; its `bash`/`python`/`node` copies are the registered tools, and the standalone sandboxed extensions were unregistered on 2026-10-21): registers `bash`, `host_bash`, `python`, and `node` on a kernel-enforced bubblewrap + seccomp sandbox and enforces decisions on `write`/`edit` too; seven session profiles (`default` → `unrestricted`), HostBash/Pwsh allow/ask/deny rules, a tightened read-only host tier, secret masking, protected paths, read-root grants, workspace-lock auditing, and subagent profile inheritance. `/guard` opens the profile picker; see [extensions/guard/README.md](extensions/guard/README.md) and [docs/guard-design.md](docs/guard-design.md).
- **update-extensions** – `/update-extensions` runs `pi update --extensions` and reloads the runtime in one step
- **timestamps** – dim started/ran/ended timestamp lines on every tool call and result in the transcript and HTML exports
- **git-read** – model-facing `git_read` tool: allowlisted read-only git subcommands (diff, log, show, status) as an argv-array child process, never through a shell. See [docs/git-read-design.md](docs/git-read-design.md).
- **gh-read** – model-facing `gh_read` tool: allowlisted read-only gh subcommands (pr view/diff/list/checks, issue view/list, auth status, run list/view) as an argv-array child process, never through a shell, plus scoped GitHub API reads with structured parameters and worktree-free operation: `repo contents` (decoded file text with line ranges, directory entries), `repo tree` (recursive or shallow), `commit checks` (check runs plus legacy statuses, bounded continuation), `advisory view` (exact CVE/GHSA lookup), `check annotations` (one check run's annotations, single 100-item page with an incompleteness notice at a full page), `repo metadata` (flat repository object: default branch, description, visibility, URLs, and related facts), `org team` (one organization team by bare org login and team slug, a single unpaged object), `pr comments` (inline review comments and replies, unlike conversation comments from `pr view --comments`), `pr reviews` (review bodies and verdicts), `issue comments` (conversation comments on an issue or PR from the issues endpoint, unlike inline review comments), and `pr threads` (GraphQL review threads, resolved and outdated included, with bounded cursor paging at 100 threads per page, each thread's first 100 comments, and at most 10 pages per invocation). The PR API operations require `repo` + a positive safe-integer `pr` number and `issue comments` requires `repo` + a positive safe-integer `issue` number; `pr comments`, `pr reviews`, and `issue comments` return verbatim REST arrays with optional jq and independent bounded continuation paging, while `pr threads` returns the GraphQL `reviewThreads` nodes with resolved/outdated state and a cursor continuation; these mutable listings are not SHA-pinned snapshots and the REST reads provide no thread state. `run view --log`/`--log-failed` fetch run or failed-step logs through a dual-window runner that keeps the first and last 50 KiB of stdout (the middle is omitted with an exact byte-count notice) under a 30 s timeout. External jq filtering is sandboxed and its gates run before the jq child (for API operations the filter compiles after the fetch); API results are capped at 50 KiB with explicit incompleteness labeling. Prompt guidance steers agents from raw `gh api` to these operations and documents workarounds for the shapes with no operation (changed files, one review's comments, a comment by id), and states that writes need `host_bash`. See [docs/gh-read-design.md](docs/gh-read-design.md).

## Package prompts

- **git-rebase** – `/git-rebase [base-branch]` rebases the current branch onto its parent branch via the local `git-rebase-parent` script (parent resolution: `--parent` flag, open PR base branch, then repo default branch), keeping conflicts in progress for the agent to resolve. Defined in `prompts/git-rebase.md`.
- **git-clean-worktrees** – moved to the shared [agent-skills](https://github.com/lucaspimentel/agent-skills) repository as an explicitly invoked skill: `/skill:git-clean-worktrees [repository-path]` in pi, `/git-clean-worktrees [repository-path]` in Claude Code. The optional path defaults to the current directory. It inspects one repository, refreshes its actual default branch, proves every target is preserved, and then removes only the worktrees and branches in a plan you approve by digest. It no longer takes a substring filter, and the old prompt was deleted from this repo.

Skills shared between pi and Claude Code live in the separate
[agent-skills](https://github.com/lucaspimentel/agent-skills) repository.

## Layout

```
pi-extensions/
├── package.json          # pi manifest
├── prompts/              # package-level prompt templates (prompts/*.md)
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
