# `git_read` tool: read-only git access for agents

Status: design settled after review rounds. Not implemented.

## Problem

There is no safe way for an agent to run read-only git commands. `bash` grants
full repo mutation, so read-only agents (e.g. the `reviewer`/`scout`/`planner`
subagents in `extensions/subagent/`) simply have no `bash`, which means no
`git diff`/`git log`. Workarounds (dispatcher pastes diffs into task text) are
clunky and lossy.

## Goal

A general-purpose tool, provisionally `git_read`, that any agent (main session,
subagents, user agents) can be granted to run a whitelisted set of read-only git
commands. It is deliberately not tied to any one agent; agents opt in via their
`tools:` frontmatter like any other tool.

## Identity and registration

- Extension dir `extensions/git-read/`, tool name `git_read` (snake_case,
  matching `session_search` and the other repo tools).
- Registered via `pi.registerTool` in every session that loads the extension;
  sessions opt in via `--tools git_read` / `defaultTools`. Children receive it
  only if the dispatching session registered it (existing `resolveAgentTools`
  filter, `extensions/subagent/index.ts:37-50`; no subagent mechanism change).
- Guard: `git_read: "local-read"` in `BUILTIN_CLASSES`
  (`extensions/guard/policy/classes.ts:72`). Classification keys on the tool
  name like every other entry; the git child process is spawned by the
  extension host itself, so no sandboxed-exec classification is involved.

## Invocation contract

- Structured argv, no shell: `{ subcommand: "diff" | "log" | "show" |
  "status", args: string[] }`.
- Spawning is argv-array only, never `sh -c`. cwd = session cwd.
- Command construction, in order: global options (below), then the
  subcommand, then validated args. Global options are injected for every
  subcommand; diff-specific flags are injected only for diff/log/show
  (`status` does not accept them).

## Worktree enforcement

- Before any read command, run `git rev-parse --show-toplevel` (with the same
  sanitized environment) and verify the session cwd is inside the returned
  toplevel; otherwise return "not inside a git worktree".
- Rationale: outside a repository, `git diff` can implicitly operate in
  no-index mode on two paths instead of failing; the check closes that.
- Do not claim reads are "provably inside the worktree": lexical path checks
  keep pathspecs worktree-relative, but git legitimately reads config and git
  metadata from outside the worktree. The guarantee is: no pathspec escapes
  the worktree, and no repo-external file is opened in no-index mode.

## Argument validation

Args are split at the first standalone `--` token: tokens before it are
candidate revs, tokens after it are paths. Without `--`, a token is accepted
if it passes either validator (safe-union: both validators reject everything
dangerous, and git's own rev-vs-path disambiguation then applies).

- Rev tokens: must not start with `-`, must be non-empty, no whitespace or
  control characters. `..`, `...`, `~`, `^`, and `rev:path` forms are allowed
  (they resolve inside the object database, which is repo-scoped by
  definition).
- Path tokens: must not start with `-`; reject absolute paths and any `..`
  path segment; reject backslashes as separators. Glob characters (`*`, `?`)
  are allowed; pathspec matching is repo-scoped. (`main..next` is rev-valid
  and path-invalid, so it is accepted under the union rule only as a rev;
  `../x` is neither and is rejected.)

## Allowlists

- Subcommands: `diff`, `log`, `show`, `status`. Anything else is rejected,
  naming the allowed set.
- Flags, per subcommand; unknown flags are rejected, not ignored:
  - `diff`: `--stat`, `--shortstat`, `--numstat`, `--name-only`,
    `--name-status`, `--cached`, `--staged`, `-U<n>` / `--unified=<n>`
    (n: 0-64)
  - `log`: `-p`, `--oneline`, `--stat`, `-n <n>` / `--max-count=<n>`
    (n: 1-10000)
  - `show`: `--stat`, `-U<n>` / `--unified=<n>`
  - `status`: none; `--porcelain` is hardcoded, any extra arg rejected.
- Value-taking flags validate their value as a plain integer; both `-U 5` and
  `-U5` forms accepted.

## Trust model for config, env, and helpers

A shell-free spawn is necessary but not sufficient: git can execute things
configured in the repo or inherited from the environment. Mitigations, all
injected by the tool and never user-suppliable:

- Global options for every subcommand: `--no-pager`, `--no-optional-locks`
  (a nominally read-only `status` otherwise refreshes and can rewrite the
  index), `-c core.fsmonitor=false` (blocks the filesystem-monitor hook),
  `-c core.untrackedCache=false`.
- Diff/log/show only: `--no-ext-diff`, `--no-textconv`.
- Environment for the child: `GIT_PAGER=cat`, `GIT_TERMINAL_PROMPT=0`,
  `GIT_ASKPASS=echo`; `GIT_CONFIG_SYSTEM=/dev/null`,
  `GIT_CONFIG_GLOBAL=/dev/null` (repo config still applies, which is
  intended; the `-c` overrides above win over it). Stripped from the
  inherited environment before spawn: `GIT_DIR`, `GIT_WORK_TREE`,
  `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`,
  `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_COMMON_DIR`, `GIT_NAMESPACE`,
  `GIT_CONFIG_COUNT`, `GIT_EXTERNAL_DIFF`.
- Known residual path: signed-commit verification only runs with
  `--show-signature`, which is not on the allowlist; if a future flag could
  trigger external execution, it does not enter the allowlist without a
  matching mitigation here.

## Resource limits and failure contract

- `OUTPUT_CAP = 50 KiB`, shared across stdout and stderr combined, counted in
  bytes, matching `PER_TASK_OUTPUT_CAP`
  (`extensions/subagent/index.ts:42`). `TIMEOUT_MS = 15s`. Named constants.
- Both streams are drained continuously; retained output is bounded as it
  arrives (bytes past the cap are discarded, not buffered). The process is
  never allowed to block on pipe backpressure.
- On timeout: SIGTERM the child, escalate to SIGKILL, and reap it before
  returning.
- Exit 0 -> success output. Nonzero exit (bad rev, not a repo) -> error
  result with stderr plus any stdout. Timeout and spawn failure -> error.
  Truncation is not an error: truncated output plus a notice line (bytes
  shown / bytes total).

## Rollout

- Same change adds `git_read` to the bundled read-only agents' `tools:` lines
  (`reviewer`/`scout`/`planner`) and the subagent README table. Still opt-in
  per session, since children only receive registered tools.

## Tests

- Valid forms: path-limited diff (`git diff HEAD~1 -- src/`), revision-ranged
  log (`-p`, `main...origin/main`), `show`, `status --porcelain`.
- Rejections: non-allowlisted subcommands, unknown flags, flags in `status`,
  absolute paths, `..` path segments, empty tokens, value-flag non-integer
  values.
- Separator handling: `--` splitting; mixed tokens without `--`.
- Command-specific injection: diff flags absent from `status` argv; global
  options present for all four.
- Outside a worktree: tool errors via the toplevel check (no no-index mode).
- Configured helpers / inherited overrides: fsmonitor, ext-diff, textconv,
  pager, prompt, and `GIT_DIR`-family env stripping each verified (argv and
  env assertions; index unchanged after `status`).
- Bounded streaming: output past the cap discarded live, not buffered;
  byte-based counting; timeout kills and reaps the child.

## Original handoff notes

The initial brainstorm (allowlist proposal, design sketch, constraints,
original acceptance criteria) is preserved in git history and was superseded
by the settled sections above; the constraints and non-goals still apply:
no write-adjacent commands even if "usually harmless", expand the allowlist
only on demonstrated need, do not weaken any agent's read-only posture, and
do not bypass the user's guard/sandbox policies.
