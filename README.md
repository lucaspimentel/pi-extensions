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

Pin to a specific ref so `pi update` won't bump it (any branch, tag, or commit
SHA; this repository publishes no tags):

```bash
pi install git:github.com/lucaspimentel/pi-extensions@<commit-sha>
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
- **web** – search the web and fetch & convert web pages (depends on `html-to-text`)
- **wt-tab-status** – updates the Windows Terminal tab title with the current session status; no-op unless `WT_SESSION` is set, and also a no-op inside herdr (`HERDR_ENV=1`), where herdr owns the tab title and reports its own pane state
- **intelligent-terminal** – reports the pi session lifecycle to Microsoft Intelligent Terminal through `wtcli.exe agent-hook --cli-source pi`, so its session list shows the session as Idle, Working, Waiting for input, Error, or Ended: session start/end, a pane re-bind plus prompt submit on every user prompt, `agent.tool.starting` per top-level tool (skipped for nested `codemode`-style calls), `agent.notification` while a blocking dialog is open, `agent.stop` on settle, and `agent.error` only when a turn ends with a provider/API error (`outcome === "error"`; an Esc abort settles as idle, and per-tool failures are deliberately not reported). Emits are fire-and-forget through a serialized queue that keeps at most one pending event per topic and never blocks a turn, because each spawn costs ~150-320 ms. Windows-only, no-op unless `WT_COM_CLSID` and `WT_SESSION` are set and the mode is `tui` or `rpc`, and `PI_INTELLIGENT_TERMINAL=0` disables it; one `warning` notification per process if `wtcli.exe` cannot be found, then silence. Rows show the cwd basename with no CLI suffix, since Intelligent Terminal has no built-in pi provider. Running `pi-acp` as IT's agent catalogs pi's entire on-disk session list under `custom:npx`, after which IT rejects these hooks for those session ids and the extension stays silent for them; the fix is to point IT's agent pane at a built-in agent. See [extensions/intelligent-terminal/README.md](extensions/intelligent-terminal/README.md).
- **external-editor-fix** – fix Ctrl+G external editor on Windows / Git Bash by adding wait flags for GUI editors
- **session-search** – searches past pi sessions across all projects by keyword, exposed as the model-facing `session_search` tool and the interactive `/session-search` command (lazily maintained index at `~/.pi/agent/session-search-index.jsonl`). See [extensions/session-search/README.md](extensions/session-search/README.md).
- **update-jira** – validated Jira read/update tools (`jira_read`: get digest/raw payload and comment pages; `jira_update`: transition, comment, link_pr, edit) over the Atlassian remote MCP v2 server, plus a run-boundary pointer that tells the model which ticket the current git branch resolves to. See [extensions/update-jira/README.md](extensions/update-jira/README.md).
- **ollama-models** – auto-discovers locally pulled Ollama models (`/api/tags`) and registers them with pi as an `ollama` provider, so they show up in `/model` without maintaining `models.json`. Reads `OLLAMA_HOST` for a non-default server; registers nothing when Ollama is not running.
- **subagent** – delegate tasks to specialized subagents with isolated context windows (forked from pi's example extension): single/parallel (max 8, 4 concurrent)/chain modes with `{previous}` chaining, live streaming, per-agent usage stats, and panel mode (`{panel, task}`), which fans one task across a named preset's read-only models and merges the answers with a judge. Ships seven agents: `scout` (recon) and `planner` (self-contained implementation-plan handoff prompts), both read-only via ffgrep/fffind with built-in grep/find fallback; `worker` (full tools for delegated edits); `reviewer` (read-only code review) and `researcher` (read-only evidence synthesis), both with web/slack/memory/session context tools; and the panel-phase `panelist` (researcher-grade read-only) and internal `judge` (code-reading tools only). The discovered agents are listed to the model automatically in the `subagent` tool description (scope `user`), and `subagent_list` returns them programmatically (source, model, tools) plus the raw `panels`/`ignoredPanels` config without spawning anything. All inherit the session model; pin per-agent models and `panels` presets (including each preset's `judge`) in `~/.pi/agent/subagent.json`, and same-name files in `~/.pi/agent/agents/` override agents entirely. The judge receives the panelist blocks verbatim with a bounded per-call tool summary and 50 KiB per answer, retries a failed attempt once, and falls back to labeled per-model sections instead of discarding paid-for answers; every panel child has a fixed 10-minute timeout with a SIGTERM-then-SIGKILL escalation, and zero surviving panelists skip the judge and return an error. Includes the `/scout-plan`, `/scout-plan-implement`, `/implement-review`, and `/scout-plan-implement-review` workflow prompts (names list each chain's stages). See [extensions/subagent/README.md](extensions/subagent/README.md).
- **guard** – sandbox-first permission system: registers `bash`, `host_bash`, `python`, and `node`; sandboxed execution uses kernel-enforced bubblewrap + seccomp, while `host_bash` runs on the host. It enforces decisions on `write`/`edit` too; seven session profiles (`default` → `unrestricted`), HostBash/Pwsh allow/ask/deny rules, a tightened read-only host tier, secret masking, protected paths, read-root grants, workspace-lock auditing, and subagent profile inheritance. `/guard` opens the profile picker; see [extensions/guard/README.md](extensions/guard/README.md) and [docs/guard-design.md](docs/guard-design.md).
- **update-extensions** – `/update-extensions` runs `pi update --extensions` and reloads the runtime in one step
- **timestamps** – dim started/ran/ended timestamp lines on tool calls and results in the transcript and HTML exports when timing information is available
- **git-read** – model-facing `git_read` tool: allowlisted read-only git subcommands (diff, log, show, status) as an argv-array child process, never through a shell. See [docs/git-read-design.md](docs/git-read-design.md).
- **gh-read** – model-facing `gh_read` tool: allowlisted read-only gh subcommands (pr view/diff/list/checks, issue view/list, auth status, run list/view) as an argv-array child process, never through a shell, plus scoped GitHub API reads with structured parameters and worktree-free operation: `repo contents` (decoded file text with line ranges, directory entries), `repo tree` (recursive or shallow), `commit checks` (check runs plus legacy statuses, bounded continuation), `advisory view` (exact CVE/GHSA lookup), `check annotations` (one check run's annotations, single 100-item page with an incompleteness notice at a full page), `repo metadata` (flat repository object: default branch, description, visibility, URLs, and related facts), `org team` (one organization team by bare org login and team slug, a single unpaged object), `pr comments` (inline review comments and replies, unlike conversation comments from `pr view --comments`), `pr reviews` (review bodies and verdicts), `issue comments` (conversation comments on an issue or PR from the issues endpoint, unlike inline review comments), `issue timeline` (conversation-adjacent events for an issue or PR number, with a distinct-`event` inventory and a clip pointer), `pr threads` (GraphQL review threads, resolved and outdated included, with bounded cursor paging at 100 threads per page, each thread's first 100 comments, and at most 10 pages per invocation), and `pr batch` (one call reads up to 15 pull requests across repositories, each target exactly `OWNER/REPO#N`, by running one plain `gh pr view` per target; it returns per-target envelopes in input order, takes an optional gh `--json` field list, and accepts an optional `account` for a secondary GitHub login). The PR API operations require `repo` + a positive safe-integer `pr` number and `issue comments`/`issue timeline` require `repo` + a positive safe-integer `issue` number (a PR number reads that PR's timeline); `pr comments`, `pr reviews`, `issue comments`, and `issue timeline` return verbatim REST arrays with optional jq and independent bounded continuation paging, while `pr threads` returns the GraphQL `reviewThreads` nodes with resolved/outdated state and a cursor continuation; these mutable listings are not SHA-pinned snapshots and the REST reads provide no thread state. `run view --log`/`--log-failed` fetch run or failed-step logs through a dual-window runner that keeps the first and last 50 KiB of stdout (the middle is omitted with an exact byte-count notice) under a 30 s timeout, and a failed native or log read is reported as a tool error carrying its exit code and timeout state in the result details (`exitCode`, `timedOut`) while the text is unchanged. External jq filtering is sandboxed and its gates run before the jq child (for API operations the filter compiles after the fetch); API results are capped at 50 KiB with explicit incompleteness labeling. Prompt guidance steers agents from raw `gh api` to these operations and documents workarounds for the shapes with no operation (changed files, one review's comments, a comment by id), states that writes need `host_bash`, and points multi-endpoint collection at `codemode` fan-out over the API operations instead of `gh api ... --paginate | jq` pipelines. It also steers a multi-PR read to `pr batch` instead of a `for` loop over `gh pr view` in `host_bash`, which guard always prompts on. See [docs/gh-read-design.md](docs/gh-read-design.md).
- **compact-tool-view** – replaces the collapsed body of tool result rows with a synthesized gist (one line per tool, except a failed `codemode` script which is two; typed per tool, with the generic line count as the fallback; opt-in `hide` mode shows no body), configurable per tool name or prefix pattern (`"mcp__*"`) in `~/.pi/agent/compact-tool-view.json` (`"gist" | "hide" | "stock"`, sparse over the code defaults; an exact key beats a pattern, the longest matching pattern wins, and a pattern beats a code default; missing file means defaults). One `pi.registerToolRenderer` resolver, never a tool re-registration; collapsed-only (expanded and streaming views delegate to the stock renderer), extra content blocks such as guard's warning block stay visible as dimmed lines, failures always surface (`timed out` / `exit N` / `error: ...`), and the wrap composes with `timestamps` in either load order. The defaults include `codemode` (`Script completed, N calls[, M failed], L lines[, truncated]`, or a two-line `Script failed` plus the first line after `Script error:`), `tool_search` (`N tools loaded` / `no matches`), and the three MCP resource tools (generic line count); a collapsed `codemode` row replaces pi's own body (nested calls with durations, model-call cost, output preview, full-output path, and the Elapsed/Took timer), which expansion still shows. `host_bash`, `ffgrep`, and `fffind` deliberately override those tools' own renderers. See [docs/compact-tool-view-design.md](docs/compact-tool-view-design.md).
- **personal-overlay** – injects a repository's personal overlay files into the system prompt as a `personal_overlay` section, so a private overlay loads without changing any tracked file in the checkout. The file list is user-scoped and empty by default: configure it in `~/.pi/agent/personal-overlay.json` as `{"files":["AGENTS_PERSONAL.md","CLAUDE_PERSONAL.md"]}` (a top-level array also works). Each entry is a relative path checked in every directory from the repository root down to the working directory, stopping at the nearest `.git` (a directory, or a file in a linked worktree); with no reachable `.git` nothing is read, and the walk never leaves the checkout. Entries are injected root-first, files that resolve to the same real path are injected once (so two symlinked names do not duplicate), the total is capped at 100 KB with an inline truncation note, and `PI_PERSONAL_OVERLAY=0` disables it.

## Package prompts

- **jira** – `/jira [KEY]` shows a Jira ticket's status, using the current branch's ticket when no key is supplied. See [extensions/update-jira/README.md](extensions/update-jira/README.md).
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
│   ├── */                # multi-file extensions (web, guard, idle-summary, ...)
│   └── shared/           # modules imported by several extensions (model pin, model selection, bounded spawn, agent lifecycle)
└── tests/                # node-runnable test harnesses (*.test.mts)
    └── fixtures/guard-shell/ # curated synthetic-policy shell regressions
```

Runtime npm deps live in the root `package.json` so a single `npm install`
(run by pi after `git clone`) covers all extensions.

Guard uses the pinned `@questi0nm4rk/shell-ast` Bash adapter. Bash allow rules
use canonical pre-unwrap AST subjects; deny/ask also retain raw-spelling
matching ([contract](docs/guard-design.md#canonical-bash-rule-subjects), migration
measurement still pending). The temporary
measurement harness is retired; final measurements and accepted behavior
changes are preserved in [docs/guard-design.md](docs/guard-design.md#shell-ast-adoption-final-measurement-and-retirement-record).
[The shell fixtures](tests/fixtures/guard-shell/README.md) pin mechanisms under
a synthetic policy, not the user-config-specific measurement results.

## Update

```bash
pi update git:github.com/lucaspimentel/pi-extensions
```
