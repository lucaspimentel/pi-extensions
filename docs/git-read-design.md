# `git_read` tool: read-only git access for agents

Status: design settled; extension, argument validation, and spawn layer
implemented and shipped. Pending: guard classification (`local-read`) and
agent rollout.

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

## Implementation status

- `extensions/git-read/validate.ts`: argument validation and final argv
  construction (pure, no pi imports). Shipped.
- `extensions/git-read/spawn.ts`: sanitized environment, worktree gate,
  bounded exec with cap and timeout. Shipped.
- `extensions/git-read/index.ts`: tool registration, schema, and error
  wrapping. Shipped.
- `tests/git-read-validate.test.mts` and `tests/git-read-spawn.test.mts`,
  run via `npm run test:git-read`. Shipped.
- Guard classification in `extensions/guard/policy/classes.ts`. Pending.
- Agent rollout (reviewer/scout/planner `tools:` lines, subagent README
  table). Pending.

## Invocation contract

- Structured argv, no shell: `{ subcommand: "diff" | "log" | "show" |
  "status", args: string[] }`.
- Spawning is argv-array only, never `sh -c`. cwd = session cwd.
- Command construction happens in validate.ts during validation: it emits the
  complete final argv, and spawn.ts consumes it verbatim, appending nothing.
  The layouts are:
  - diff/log/show: `[...GLOBAL_OPTIONS, <sub>, ...DIFF_LOG_SHOW_OPTIONS,
    ...args]`
  - status: `[...GLOBAL_OPTIONS, "status", "--porcelain"]`
  `GLOBAL_OPTIONS` (validate.ts) is `--no-pager --no-optional-locks
  -c core.fsmonitor=false -c core.untrackedCache=false`;
  `DIFF_LOG_SHOW_OPTIONS` is `--no-ext-diff --no-textconv`, injected
  immediately after the subcommand for diff/log/show only (`status` does not
  accept them).

## Worktree enforcement

- Before any read command, run `git rev-parse --show-toplevel` as a separate
  invocation with `GLOBAL_OPTIONS` prepended (same sanitized environment) and
  verify the session cwd is inside the returned toplevel; otherwise return
  `git_read: not inside a git worktree`. The comparison is symlink-aware:
  both paths are resolved and then realpathed when possible, so a symlinked
  session cwd still matches the toplevel git resolved (`cwdInsideToplevel`
  in spawn.ts).
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
  path segment; reject backslashes as separators; reject whitespace and
  control characters. Glob characters (`*`, `?`) are allowed; pathspec
  matching is repo-scoped. (`main..next` is rev-valid and path-invalid, so it
  is accepted under the union rule only as a rev; `../x` is neither and is
  rejected. Tokens that pass the rev validator but carry path-dangerous
  constructs: absolute, backslash, `..` segment, are rejected by the union
  rule, since git would fall back to treating them as pathspecs.)

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
  `-U5` forms accepted. An absent value and a present-but-invalid value
  produce distinct error messages (the latter names the value it got).

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
  `GIT_CONFIG_COUNT`, `GIT_EXTERNAL_DIFF`. These live in `INJECTED_ENV` and
  `STRIPPED_ENV` in spawn.ts; injected values are assigned after stripping,
  so they always win over anything inherited. Everything else (PATH, HOME,
  locale) is inherited untouched.
- Known residual path: signed-commit verification only runs with
  `--show-signature`, which is not on the allowlist; if a future flag could
  trigger external execution, it does not enter the allowlist without a
  matching mitigation here.

## Resource limits and failure contract

- `OUTPUT_CAP = 50 KiB`, shared across stdout and stderr combined, counted in
  bytes, matching `PER_TASK_OUTPUT_CAP`
  (`extensions/subagent/index.ts:42`). `TIMEOUT_MS = 15s`,
  `KILL_ESCALATION_MS = 5s`. Named constants.
- Both streams are drained continuously; retained output is bounded as it
  arrives (bytes past the cap are discarded, not buffered). Each stream's
  retained slices are tracked separately while their combined total respects
  `OUTPUT_CAP`. Chunks are decoded once at the end so a multibyte UTF-8
  character split across chunks survives intact. The child never blocks on
  pipe backpressure.
- On timeout: SIGTERM the child, escalate to SIGKILL after
  `KILL_ESCALATION_MS`, and reap it (close/error) before returning. No
  process-group kill: under the sanitized environment (no pager, no
  fsmonitor, no ext-diff/textconv, nulled configs) no descendants are
  expected, so plain child kill suffices.
- Exact failure shapes; the result never throws, and `ok` is true only for
  exit 0 without timeout or spawn error:
  - spawn failure: `git_read: failed to run git: <message>`
  - timeout: `git_read: git timed out after 15000 ms`, plus any collected
    output
  - nonzero exit: `git_read: git exited with code <N>`, followed by stderr
    then stdout
  - truncation (appended to the text, never an error):
    `[git_read: output truncated, showing <retained> of <total> bytes]`

## Rollout

Pending: add `git_read` to the bundled read-only agents' `tools:` lines
(`reviewer`/`scout`/`planner`) and the subagent README table. Still opt-in
per session, since children only receive registered tools.

## Tests

- `tests/git-read-validate.test.mts`: argv construction for all four
  subcommands, the design's valid forms, value-flag bounds, all rejections,
  separator/union handling, and error-message contents.
- `tests/git-read-spawn.test.mts`: worktree gate (including outside-worktree
  and symlink cases), environment assertions (stripped and injected vars,
  index unchanged after `status`), caps and truncation, timeout escalation,
  and the exit-code contract.
- Run both via `npm run test:git-read`.

## Acceptance criteria (current)

- Read-only agents can run allowlisted `diff`/`log`/`show`/`status` forms,
  including path-limited and revision-ranged invocations.
- Non-allowlisted subcommands, unknown flags, and unsafe tokens are rejected
  with clear errors naming the allowed set, verified by tests.
- A read-only agent (no `bash`) can complete a "review the last commit" task
  with no diff text in its prompt.
- Main-session opt-in works via `--tools git_read` / `defaultTools` without
  registering it globally.
- Once guard classification lands, the guard treats `git_read` as
  `local-read` in every profile.

## Original handoff notes

The initial brainstorm (allowlist proposal, design sketch, constraints,
original acceptance criteria) is preserved in git history and was superseded
by the settled sections and the acceptance criteria above; the constraints
and non-goals still apply: no write-adjacent commands even if "usually
harmless", expand the allowlist only on demonstrated need, do not weaken any
agent's read-only posture, and do not bypass the user's guard/sandbox
policies.
