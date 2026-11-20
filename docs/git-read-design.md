# `git_read` tool: read-only git access for agents

Status: design settled; extension, argument validation, spawn layer, guard
classification, and agent rollout implemented and shipped.

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

### Call row

`renderCall` in `extensions/git-read/index.ts` draws the collapsed call line;
`extensions/shared/read-tool-call.ts` holds the two pieces it shares with
`gh_read`: quoting one argument into a command line, and the expanded view.

- Collapsed: the raw tool name, bold in `toolTitle`, then the operation in
  `accent` and its argv in `toolOutput`, space-joined as the command you would
  type (`git_read diff HEAD~1 -- src/`). An argument is quoted only when it
  holds whitespace, a quote, or a backslash. An invocation that omits
  `subcommand` and names it in `args[0]` renders that command once. Nothing is
  elided or capped: a long command wraps.
- Streaming: the operation appears as soon as it arrives, and `...` stands in
  while it has not (`renderCall` runs on every argument delta, so a partial
  argument object must render rather than throw).
- Expanded (Ctrl+O, `app.tools.expand`): every argument pi passed, one
  `key: value` line each, in the shape of pi's own fallback renderer
  (`dist/core/tools/render-utils.js`, `formatToolCallWithArgs`, which is not
  exported from the package root): two spaces of indent, strings raw, anything
  else `JSON.stringify(value, null, 2)`, tabs replaced, CRs removed,
  continuation lines indented four further spaces, the block `muted`. The
  `args` array is JSON there, so the expanded view deliberately differs in form
  from the space-joined collapsed line, and `subcommand` leads the list
  whatever order the arguments streamed in.
- Adding `renderCall` makes `timestamps` compose with this tool for the first
  time: its resolver wraps a call renderer only when the tool defines one
  (`extensions/timestamps/index.ts`), so the row gains its dim `ran …` /
  `ended …` line. Exactly one wrap in either load order, because
  `compact-tool-view` spreads the base renderers.

## Implementation status

- `extensions/git-read/validate.ts`: argument validation and final argv
  construction (pure, no pi imports). Shipped.
- `extensions/git-read/spawn.ts`: sanitized environment, worktree gate,
  bounded exec with cap and timeout. Shipped.
- `extensions/git-read/index.ts`: tool registration, schema, and error
  wrapping. Shipped.
- `tests/git-read-validate.test.mts` and `tests/git-read-spawn.test.mts`,
  run via `npm run test:git-read`. Shipped.
- Guard classification: `git_read: "local-read"` in `BUILTIN_CLASSES`
  (`extensions/guard/policy/classes.ts`). Shipped.
- Agent rollout (reviewer/scout/planner `tools:` lines, subagent README
  table). Shipped.

## Invocation contract

- Structured argv, no shell: `{ subcommand: "diff" | "log" | "show" |
  "status", args: string[] }`.
- Tolerant shape fallback: `subcommand` is schema-optional. When it is
  omitted, `args[0]` is promoted to the subcommand if it names an allowlisted
  subcommand (observed model failure mode: the entire command bundled into
  `args`, e.g. `{args: ["status", "--short", "--branch"]}`). A missing
  subcommand whose args[0] is not allowlisted is rejected with an error naming
  the expected shape; explicit unknown subcommands are rejected as before.
  Normalization happens in `normalizeInvocation` (validate.ts) before flag
  validation, and reuses the existing rejection wording.
- Spawning is argv-array only, never `sh -c`. cwd = session cwd.
- Command construction happens in validate.ts during validation: it emits the
  complete final argv, and spawn.ts consumes it verbatim, appending nothing.
  The layouts are:
  - diff/log/show: `[...GLOBAL_OPTIONS, <sub>, ...DIFF_LOG_SHOW_OPTIONS,
    ...args]`
  - status: `[...GLOBAL_OPTIONS, "status", "--porcelain"]`
  `GLOBAL_OPTIONS` (validate.ts) is `--no-pager --no-optional-locks
  -c core.fsmonitor=false -c core.untrackedCache=false
  -c log.showSignature=false -c format.pretty=medium`;
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
- diff-only dangling-range guard: a range token with an omitted endpoint
  (`main...`, `main..`, `..main`, bare `..`) is rejected when combined with
  another rev or pathspec before `--`, because `git diff` parses its
  pre-`--` arguments as range endpoints and exits with a usage error (code
  129) for that combination. A dangling range alone, or followed by `--` and
  pathspecs, is accepted (the empty side defaults to HEAD); `log` and `show`
  accept the combination, so the guard does not apply to them. Rejections
  name the offending token and suggest spelling out both endpoints (e.g.
  `main...HEAD`).

## Allowlists

- Subcommands: `diff`, `log`, `show`, `status`. Anything else is rejected,
  naming the allowed set.
- Flags, per subcommand; unknown flags are rejected, not ignored:
  - `diff`: `--stat`, `--shortstat`, `--numstat`, `--name-only`,
    `--name-status`, `--cached`, `--staged`, `--check`,
    `-w` / `--ignore-all-space`, `-U<n>` / `--unified=<n>` (n: 0-64)
  - `log`: `-p`, `--oneline`, `--stat`, `--no-merges`, `--first-parent`,
    `--decorate`, `-n <n>` / `-n<n>` / `-<n>` / `--max-count=<n>`
    (n: 1-10000), `--format=<f>` / `--pretty=<f>`, `--date=<d>` /
    `--date <d>`, `--author=<p>` / `--author <p>`
  - `show`: `--stat`, `--no-patch` / `-s`, `--oneline`, `-p` / `--patch`,
    `-U<n>` / `--unified=<n>` (n: 0-64), `-n <n>` / `-n<n>` / `-<n>` /
    `--max-count=<n>` (n: 1-10000), `--format=<f>` / `--pretty=<f>`,
    `--date=<d>` / `--date <d>`
  - `status`: flags `--short`, `--branch` (read-only; they combine safely
    with the hardcoded `--porcelain`, so branch headers appear in porcelain
    output); revs and pathspecs are rejected, `--porcelain` itself is never
    user-suppliable and is rejected when passed.
- An alias of an allowlisted flag is allowlisted with it: `--staged` with
  `--cached`, `--ignore-all-space` with `-w`, `-s` with `--no-patch`,
  `--patch` with `-p`, `--pretty` with `--format` (rejections and the emitted
  argv keep the spelling the caller used).
- Value-taking flags validate their value by class. An absent value and a
  present-but-invalid value produce distinct error messages (the latter names
  the value it got):
  - Counts (`-n <n>`, `-n<n>`, `-<n>`, `--max-count=<n>`) and unified context
    (`-U<n>`, `-U <n>`, `--unified=<n>`): a plain integer in range. The count
    shorthand belongs to log and show only and reaches the argv verbatim, so
    `-5` stays `-5`.
  - `--format` / `--pretty`: an exact preset name, or a format string whose
    every `%` sequence is on the specifier allowlist below. Attached form
    only: git rejects a bare `--format` outright, and a bare `--pretty` means
    `--pretty=medium`, which would silently reinterpret the next token as a
    revision. A `%`-free value that is not an exact preset name is rejected
    before spawn, because git resolves such a value as a format name and then
    as a `pretty.<name>` config alias, which is prefix-matched and can itself
    contain any specifier (verified: an alias holding `%G? %h` runs gpg
    through `--format=<alias>`). Exact preset names win over same-named
    aliases, and an alias key cannot contain `%`, so a `%`-containing value is
    always parsed as a format string.
  - `--date`: one value from the closed enum `default`, `relative`, `local`,
    `iso8601`, `iso`, `iso8601-strict`, `iso-strict`, `rfc2822`, `rfc`,
    `short`, `raw`, `unix`, `human`; the free-form `format:` and
    `format-local:` forms are excluded.
  - `--author` (log only): non-empty text without control characters,
    otherwise free, because git matches it as a regular expression (POSIX by
    default; the repository's `grep.patternType` switches it to PCRE, verified
    with a lookbehind pattern). Spaces are allowed, there is no length cap
    (matching revs and pathspecs), and the read's timeout is the only backstop
    for a pathological pattern.
- Preset names accepted for `--format=`/`--pretty=`: `oneline`, `short`,
  `medium`, `full`, `fuller`, `email`, `raw`.
- Format specifier allowlist (the `Set` in `extensions/git-read/validate.ts`
  is the source of truth): `%%`, `%H`, `%h`, `%T`, `%t`, `%P`, `%p`, `%s`,
  `%f`, `%b`, `%B`, `%n`, `%d`, `%D`, `%m`, `%N`, `%e`; the author family
  `%an`, `%aN`, `%ae`, `%aE`, `%al`, `%aL`, `%ad`, `%aD`, `%ar`, `%at`,
  `%ai`, `%aI`, `%as`; the committer family `%cn`, `%cN`, `%ce`, `%cE`,
  `%cl`, `%cL`, `%cd`, `%cD`, `%cr`, `%ct`, `%ci`, `%cI`, `%cs`; the reflog
  family `%gd`, `%gD`, `%gs`, `%gN`, `%gE`, `%gn`, `%ge`. Everything else is
  rejected before spawn, naming the offending sequence: the `%G` signature
  family (`%G?`, `%GG`, `%GS`, `%GK`, `%GF`, `%GP`, `%GT`), `%(...)` atoms,
  `%x` escapes, `%C` colors, `%w(` wrapping, `%<(` / `%>(` padding, unknown
  codes, and a trailing `%`. Git prints an unknown specifier literally
  instead of failing, so this allowlist, not git, is what keeps a format
  string away from the signature family.

## Trust model for config, env, and helpers

A shell-free spawn is necessary but not sufficient: git can execute things
configured in the repo or inherited from the environment. Mitigations, all
injected by the tool and never user-suppliable:

- Global options for every subcommand: `--no-pager`, `--no-optional-locks`
  (a nominally read-only `status` otherwise refreshes and can rewrite the
  index), `-c core.fsmonitor=false` (blocks the filesystem-monitor hook),
  `-c core.untrackedCache=false`, `-c log.showSignature=false` and
  `-c format.pretty=medium` (block config-driven signature display, which runs
  `gpg.program`).
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
- External execution through signature display: the `%G` specifiers (`%G?`,
  `%GG`, `%GS`, `%GK`, `%GF`, `%GP`, `%GT`) each run signature verification,
  which executes the program named by `gpg.program` in the repository's own
  config (verified for each specifier). Every route to it is closed: they are
  absent from the format allowlist, the two ways a format *value* could reach
  them outside the scan cannot (git prints an unknown specifier literally
  instead of failing, so the check is a positive allowlist, and a `%`-free
  value is only accepted as an exact preset name, so a `pretty.<name>` config
  alias cannot be expanded instead), the `-c log.showSignature=false` and
  `-c format.pretty=medium` overrides close the config-driven paths, and
  `--show-signature` is not on the allowlist. If a future flag could trigger
  external execution, it does not enter the allowlist without a matching
  mitigation here.

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
    then stdout. Exit 0 stays the only success: `git diff --check` exits 2
    when it finds whitespace errors, so such a run reports `git exited with
    code 2` with the findings as the body, and no flag reclassifies that.
  - truncation (appended to the text, never an error):
    `[git_read: output truncated, showing <retained> of <total> bytes]`
- Every failure also sets `isError: true` and reports structured fields in
  `details`: `exitCode` (the child's code, or null when no child exited),
  `timedOut`, `truncated`, and a prefix-free `failureReason`. Rejections before
  spawn report `exitCode: null` with the validation reason. The reason restates
  the text above without its `git_read: ` prefix, because a compact result row
  shows it bare under a title that already names the tool. `isError` is a
  model-facing change (pi forwards the flag to the model) and is what makes a
  collapsed failure read `exit 128` or `error: not inside a git worktree`
  instead of a line count.
- A capped run is not a failure: `ok` stays true and `details.truncated` is
  true, which a compact row renders as `N lines, truncated`.

## Rollout

Shipped: `git_read` is on the bundled read-only agents' `tools:` lines
(`reviewer`/`scout`/`planner`) and in the subagent README table. Still
opt-in per session: children only receive tools the dispatching session
registered, and `git_read` has no fallback, so sessions whose `defaultTools`
exclude it leave the agents without it.

## Tests

- `tests/git-read-validate.test.mts`: argv construction for all four
  subcommands, the design's valid forms, every value-flag class and bound, all
  rejections (including each signature specifier, alone and embedded, the
  `%%G?`/`%%%G?`/`%n%G?` boundaries, and a `%`-free value that is not a preset),
  the format specifier allowlist, separator/union handling, and error-message
  contents.
- `tests/git-read-spawn.test.mts`: worktree gate (including outside-worktree
  and symlink cases), environment assertions (stripped and injected vars,
  index unchanged after `status`), caps and truncation, timeout escalation,
  the exit-code contract, a real-git run of every newly allowlisted flag form
  (counts and shorthand, log/show booleans, presets, specifiers, date values,
  author patterns), `diff --check` exit 2 with and without `-w`, a repository
  config that aliases a `pretty.<name>` to `%G?` to prove the alias cannot be
  invoked or hijack a `%`-containing value, a repository config of
  `log.showSignature=true` plus a `format.pretty` of `%G? %h` over a commit
  with a signature header to prove the injected overrides keep gpg from
  running, and proof that a rejected format value spawns nothing.
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
- The guard treats `git_read` as `local-read` in every profile.

## Original handoff notes

The initial brainstorm (allowlist proposal, design sketch, constraints,
original acceptance criteria) is preserved in git history and was superseded
by the settled sections and the acceptance criteria above; the constraints
and non-goals still apply: no write-adjacent commands even if "usually
harmless", expand the allowlist only on demonstrated need, do not weaken any
agent's read-only posture, and do not bypass the user's guard/sandbox
policies.
