# `gh_read` tool: read-only GitHub CLI access for agents

Status: design settled (grill-me review, 2026-10-13; all branches decided).
Implemented: extensions/gh-read/ (validate, spawn, index), shared core at
extensions/shared/bounded-spawn.ts, guard classification, agent rollout, and
tests. The git-read extraction regression guard held: tests/git-read-*.test.mts
passed unmodified after the refactor.

## Problem

Read-only agents (the `reviewer`/`scout`/`planner` subagents in
`extensions/subagent/`) have no way to see PRs or issues. `git_read`
(extensions/git-read/) covers local repo data but not GitHub state: review
comments, check status, PR lists, issue bodies. The current workaround is the
dispatcher pasting content into task text, which is clunky and lossy. In the
main session, `gh` is only reachable through `bash`, which the guard prompts
on every invocation.

## Goal

A tool `gh_read`, structurally mirroring `git_read`, that runs an allowlisted
set of read-only `gh` subcommands as an argv-array child process, never
through a shell. Two consumers: no-bash subagents, and fewer guard prompts in
the main session. Deliberately not tied to any one agent; agents opt in via
`tools:` frontmatter like any other tool.

## Identity and registration

- Extension dir `extensions/gh-read/`, tool name `gh_read` (snake_case,
  matching `git_read` and `session_search`).
- Registered via `pi.registerTool`; sessions opt in via `--tools gh_read` /
  `defaultTools`; children receive it only if the dispatching session
  registered it (same `resolveAgentTools` filter as `git_read`).
- Guard: `gh_read: "remote-read"` in `BUILTIN_CLASSES`
  (`extensions/guard/policy/classes.ts`). Unlike `git_read` (`local-read`),
  this is a network read: every invocation makes an API call to github.com or
  an enterprise host. `remote-read` already exists for `web_search`, the
  pup_* tools, and the slack reads, so no new class is needed. Settled:
  no guard core changes are required, because the remote-read cell is
  `allow` in every profile (`otherRemoteReadCell`,
  `extensions/guard/policy/profiles.ts:160`).

## Invocation contract

- Structured argv, no shell: `{ subcommand, args }` where `subcommand` is a
  literal union of the six two-word commands below (modeled as one string so
  the schema stays flat like `git_read`'s):
  - `pr view`, `pr diff`, `pr list`, `issue view`, `issue list`, `auth status`
- Command construction happens in validate.ts during validation: it emits the
  complete final argv `[<noun>, <verb>, ...validatedArgs]`, and spawn.ts
  consumes it verbatim, appending nothing. The command position never
  contains user text, so gh aliases (`pr ls`) and gh extensions
  (`gh <custom-name>`, which execute external binaries) are unreachable by
  construction.
- `auth status` is the one deviation: validate.ts appends the tool-authored
  tokens `--json hosts` after the validated args (constructed directly,
  bypassing the validation loop). The user never supplies `--json`; gh's JSON
  output gives a stable, greppable payload instead of styled text.
- No `--` separator logic: unlike git, there is no rev-vs-path ambiguity and
  no pathspec concept. Every token is validated against its flag's rule.

## Allowlists (verified against gh 2.102.0 help output)

Per-subcommand flags; unknown flags are rejected, not ignored. `-w`/`--web`
is excluded everywhere (opens a browser). `-t`/`--template` is excluded for
v1 (Go templates are argv-safe but add no capability `--jq` lacks).

- `pr view [<number> | <branch>]`: `--comments`/`-c`, `--json <fields>`,
  `--jq <expr>`
- `pr diff [<number> | <branch>]`: `--name-only`, `--patch`,
  `--color always|never|auto` (value validated),
  `--exclude <glob>` (repeatable). `--allow-escape-sequences` is excluded:
  gh neutralizes terminal escape sequences by default and the tool keeps
  that guarantee.
- `pr list`: `--limit <n>` (1..1000, integer), `--state open|closed|merged|all`
  (value validated), `--author <v>`, `--assignee <v>`, `--label <v>`
  (repeatable), `--head <v>`, `--base <v>`, `--search <q>`, `--draft`,
  `--json <fields>`, `--jq <expr>`
- `issue view <number>`: `--comments`, `--json <fields>`, `--jq <expr>`
  (gh also accepts URLs here; URLs are excluded in v1)
- `issue list`: same as `pr list` minus `merged` in `--state`, minus
  `--head`/`--base`/`--draft`, plus `--mention <v>`, `--milestone <v>`
- The five repo subcommands (not `auth status`): `-R/--repo [HOST/]OWNER/REPO`,
  value validated
  against `^([A-Za-z0-9.-]+/)?[A-Za-z0-9-]+/[A-Za-z0-9_.-]+$`. Cross-repo reads
  are still reads; the strict regex prevents using the flag to smuggle other
  argv shapes. `-R/--repo` is NOT allowlisted for `auth status` (no repo
  context exists); there it is rejected as an unknown flag.
- `auth status` (no positionals): `--active`/`-a` (boolean, active account
  only), `--hostname <host>` (filter-token rule), `--jq <expr>`. `--json` is
  tool-authored (appended as `--json hosts`), never user-supplied.
  `--show-token`/`-t` and `--template` are excluded: the tool never handles
  or displays tokens (see Non-goals).

Value validation:

- `<fields>` for `--json`: `^[A-Za-z0-9_,]+$`. gh itself rejects unknown
  field names, so the tool validates shape, not membership.
- `<expr>` for `--jq`: non-empty, no control characters. jq runs embedded in
  gh; it cannot execute anything.
- String filter values (`--author`, `--label`, `--search`, `--hostname`, ...):
  non-empty, not starting with `-`, no whitespace or control characters (same
  CONTROL_RE rule as git_read's tokens).
- PR/issue number or branch argument: `^[0-9]+$`, or the string-filter token
  rule (branch names contain `/`, which is fine; they go to the API, never
  to a filesystem).

## Worktree enforcement

Same gate as `git_read`: before any read, run
`git rev-parse --show-toplevel` (sanitized environment) and verify the
session cwd is inside it via `cwdInsideToplevel`; otherwise return
`gh_read: not inside a git worktree`. Rationale: without `-R`, gh infers the
repository from the git remote of the current repo, so the tool is defined
only inside a worktree. With `-R` the gate is still applied for a single,
simple contract (no per-argument conditional gating).

One exemption: `auth status` skips the gate entirely (spawn.ts derives the
exemption from the validated argv, `argv[0] === "auth" && argv[1] ===
"status"`). It reports login state for gh's known hosts and needs no
repository context, so it is useful precisely where the other five are not:
outside any worktree. The other five keep the gate unchanged.

## Trust model for env and config

gh has no repo-level config (unlike git), so the trust surface is the
inherited environment plus the user-level gh config. All injections live in
spawn.ts, assigned after stripping so they always win:

- Injected: `GH_PROMPT_DISABLED=1` (gh fails instead of hanging on an
  interactive prompt, e.g. `pr view` with an ambiguous state or an
  unauthenticated session), `GH_PAGER=cat`, `GH_NO_UPDATE_NOTIFIER=1`,
  `GH_NO_EXTENSION_UPDATE_NOTIFIER=1`, `NO_COLOR=1`.
- Stripped: `GH_HOST` and `GH_REPO` (prevent redirecting API targets;
  `-R` is the only validated way to select another repo), `GH_CONFIG_DIR`
  (pin the default config location), `GH_DEBUG` (verbose/HTTP logging on
  stderr), `GH_FORCE_TTY`, `GH_MDWIDTH`, `GLAMOUR_STYLE` (can name a local
  style file: a read side channel), `GH_BROWSER`/`BROWSER`,
  `GH_EDITOR`/`GIT_EDITOR`/`VISUAL`/`EDITOR`, `GH_PATH`, `GH_EXTENSION`,
  `GH_TELEMETRY` (set to `log` only prints to stderr, but stripping keeps
  telemetry behavior deterministic).
- Kept: `GH_TOKEN`/`GITHUB_TOKEN`/`GH_ENTERPRISE_TOKEN` and the default
  config dir. Auth is gh's own domain; the tool neither handles nor masks
  tokens. `http_unix_socket` in the user's gh config could redirect API
  traffic; that config is user-level and trusted (residual path, same
  spirit as git_read's "git legitimately reads config from outside the
  worktree" note).

Known residual path: if a future gh version adds a flag on these subcommands
that spawns a process or opens a browser, it does not enter the allowlist
without a matching mitigation here.

## Shared bounded-spawn extraction

The mechanics of `git-read/spawn.ts` (argv-array spawn, continuous drain,
byte-capped retention, UTF-8-safe decode, timeout SIGTERM->SIGKILL, reaping)
are identical for this tool. Extracted into
`extensions/shared/bounded-spawn.ts` (`boundedExec(binary, argv, env, cwd)`),
with git-read refactored onto it without behavior change, verified by the
existing `tests/git-read-spawn.test.mts` suite (`npm run test:git-read`).
`git-read`-specific logic (worktree gate, git env sanitization) stays in
`extensions/git-read/`; gh-read imports the sanitized git env from there for
its rev-parse gate.

Resource limits, with one deviation: `OUTPUT_CAP = 50 KiB` shared across
stdout+stderr, same as `git_read`; `TIMEOUT_MS = 15s`,
`KILL_ESCALATION_MS = 5s`. 15s covers a single API round trip comfortably;
if `--search` or high `--limit` invocations page repeatedly and time out in
testing, raise `TIMEOUT_MS` for this tool only and document it here.

Failure contract mirrors `git_read` exactly, with `gh_read:`/`gh` prefixes:
never throws; `ok` true only for exit 0 without timeout or spawn error;
truncation noted inline; exit-code and timeout messages name what happened.
GitHub API and auth errors (including 403 from the wrong active gh account)
pass through verbatim; the tool does no error-shape matching and appends no
hints (settled: passthrough only).

## GitHub account caveat (documented, not solved)

`gh` has a single active account (no per-host automatic selection like git's
`includeIf`). A ddoghq EMU repo 403s while the personal account is active
and vice versa; the tool inherits whatever `gh auth` state exists and
surfaces the API error verbatim. Switching accounts remains a manual user
step (see dd-tools/docs/git-multi-account-setup.md).

Note on `auth status` JSON output: gh's `--json` mode always exits 0 unless
there is a fatal error (per gh's `statusRun`: "In machine-friendly mode, we
always exit with no error"), including when logged out or when `--hostname`
matches nothing. So the common "not logged in" outcome is `ok: true` with an
empty `{"hosts":{}}` payload, not the nonzero-exit failure contract; the
exit-1 path only fires on fatal errors. An empty `hosts` payload means not
logged in.

## Rollout (after implementation)

Settled in the grill-me review:

- Guard classification entry, as above (no core changes).
- All three bundled read-only agents (`reviewer`, `scout`, `planner`) get
  `gh_read` on their `tools:` lines, matching `git_read`; subagent README
  table updated.
- The main session gets `gh_read` via `defaultTools`, and `git_read` joins
  it there too (it stops being opt-in-only). This supersedes the earlier
  "no defaultTools change" stance; without it the fewer-guard-prompts
  motivation is unmet. Whether the entry lands in user-level settings.json
  or project `.pi/` settings is an implementation-time choice.

## Tests

- `tests/gh-read-validate.test.mts`: argv construction for all six
  subcommands, value-flag bounds (`--limit`, `--state`, `--color`), the
  `-R` regex (accept/reject cases), `--json` field-shape, `--jq` and filter
  token rules, `auth status` happy paths with appended `--json hosts`,
  `auth status` rejections (`--json`/`--show-token`/`--template`/`-R` as
  unknown flags, positionals, filter-token and jq value rules, no attached
  `-a` short form), all with error-message contents.
- `tests/gh-read-spawn.test.mts`: worktree gate (and the `auth status`
  exemption: no git spawn at all, while `pr list` still gates), environment
  assertions (stripped and injected vars), caps and truncation, timeout
  escalation, exit-code contract including `auth status` passthrough.
  Reuse the git-read spawn test harness patterns.
- Regression guard for the extraction: existing
  `tests/git-read-spawn.test.mts` must pass unmodified.

## Acceptance criteria

- A read-only agent (no `bash`) with `gh_read` but no other network tools
  can list a repo's open PRs, view a PR with comments, and view its diff.
- Non-allowlisted subcommands (including every write verb: `pr create`,
  `pr merge`, `issue close`, `gh api`), unknown flags, and unsafe values are
  rejected with clear errors naming the allowed set, verified by tests.
- No invocation can open a browser, hang on an interactive prompt, or emit
  un-neutralized terminal escape sequences.
- The guard classifies `gh_read` as `remote-read` in every profile; the
  remote-read cell already allows it everywhere, verified against
  `extensions/guard/policy/profiles.ts:160`.
- The main session has `gh_read` and `git_read` via `defaultTools`, and the
  reviewer/scout/planner agents reach `gh_read` through their `tools:`
  lines.

## Non-goals

- No write or write-adjacent commands, even "usually harmless" ones
  (`pr edit`, `issue comment` are out; so is `pr checkout`, which mutates
  the worktree).
- No `gh api`, `gh search`, `gh release`, `gh run` for v1; expand the
  allowlist only on demonstrated need, one design-review cycle per addition.
- No URL arguments, no `--template`, no `--web` forms.
- No token handling, masking, or account switching inside the tool. Keeping
  `--show-token` off the `auth status` allowlist is what keeps this non-goal
  true: token values never enter tool output through any allowlisted path.
- Do not bypass the user's guard/sandbox policies: `remote-read` classification
  means guard profiles still decide, per profile, whether network reads are
  allowed at all.
