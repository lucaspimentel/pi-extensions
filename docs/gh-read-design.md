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
  literal union of the seven two-word native commands below (modeled as one
  string so the schema stays flat like `git_read`'s):
  - `pr view`, `pr diff`, `pr list`, `pr checks`, `issue view`, `issue list`,
    `auth status`
- Four narrowly scoped GitHub API operations share the same tool with
  structured parameters instead of an args array: `repo contents`,
  `repo tree`, `commit checks`, `advisory view` (see "GitHub API operations").
  Mixing shapes is rejected in both directions: native subcommands reject
  structured fields, API operations reject `args`.
- Command construction happens in validate.ts during validation: it emits the
  complete final argv `[<noun>, <verb>, ...validatedArgs]`, and spawn.ts
  consumes it verbatim, appending nothing. The command position never
  contains user text, so gh aliases (`pr ls`) and gh extensions
  (`gh <custom-name>`, which execute external binaries) are unreachable by
  construction.
- `auth status` is the one deviation: validate.ts appends the tool-authored
  tokens `--json hosts` after the validated args (constructed directly,
  bypassing the validation loop). gh's JSON output gives a stable, greppable
  payload instead of styled text. A user-supplied `--json hosts` (separate or
  attached form) is tolerated and dropped as redundant with the appended
  tokens; any other field list is rejected naming `hosts` as the only
  supported value.
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
- `pr checks [<number> | <branch>]`: `--required`, `--jq <expr>`,
  `-R/--repo [HOST/]OWNER/REPO` (a selector is required with `-R`; gh has no
  current-branch context to infer a PR from). `--json` is tool-authored:
  validate.ts appends exactly
  `--json bucket,completedAt,description,event,link,name,startedAt,state,workflow`
  after the validated args (mirroring the auth status `--json hosts`
  pattern), so caller field selection is impossible; a user-supplied `--json`
  with that exact field list is tolerated and dropped, any other field list
  is rejected. Watch (`--watch`/`-w`), `--web`, `--interval`, `--fail-fast`,
  and `--template` are excluded. Verified against gh 2.102.1 source: JSON
  export happens BEFORE the failed/pending exit logic, so JSON mode exits 0
  even with failed or pending checks, and the check states are read from the
  JSON data. Exit codes 1 and 8 are never reinterpreted as success: they
  flow through the normal failure contract with whatever output gh printed.
  Native no-checks/no-required-checks errors pass through verbatim.
- The seven repo subcommands (not `auth status`): `-R/--repo [HOST/]OWNER/REPO`,
  value validated
  against `^([A-Za-z0-9.-]+/)?[A-Za-z0-9-]+/[A-Za-z0-9_.-]+$`. Cross-repo reads
  are still reads; the strict regex prevents using the flag to smuggle other
  argv shapes. `-R/--repo` is NOT allowlisted for `auth status` (no repo
  context exists); there it is rejected as an unknown flag.
- `auth status` (no positionals): `--active`/`-a` (boolean, active account
  only), `--hostname <host>` (filter-token rule), `--jq <expr>`. `--json` is
  tool-authored (appended as `--json hosts`); a user-supplied `--json hosts`
  is tolerated and dropped, any other fields value is rejected.
  `--show-token`/`-t` and `--template` are excluded: the tool never handles
  or displays tokens (see Non-goals).
- `run list` (no positionals): `--all`/`-a` (boolean, include disabled
  workflows), `--branch <v>`/`-b`, `--commit <v>`/`-c` (a value only here:
  `-c` stays boolean on `pr view`/`issue view`), `--created <v>` (date
  ranges use gh's `'..'`-style range syntax: the filter-token rule forbids
  spaces, so `2026-01-01..2026-02-01` is fine and a spaced date is not),
  `--event <v>`/`-e`, `--limit <n>`/`-L` (1..1000), `--status <v>`/`-s`,
  `--user <v>`/`-u`, `--workflow <v>`/`-w` (a value only here: `-w` stays an
  unknown flag on `pr view` and `pr checks`), `--json <fields>`,
  `--jq <expr>`. All filter values use the generic filter-token rule
  (non-empty, no leading `-`, no whitespace or control characters), so
  `--created` and `--workflow` values cannot contain spaces: use `'..'
  -style` date ranges and workflow file names. `-a` is boolean here and a
  value only on `run view`; collisions resolve purely by per-subcommand
  scoping.
- `run view <run-id>` (exactly one digits-only positional; interactive
  selection is not supported): `--log` (full run or, with `--job`, one
  job's log), `--log-failed` (failed steps only), `--verbose`/`-v`,
  `--attempt <n>`/`-a` (1..1000; a value only here: `-a` stays boolean on
  `auth status` and `run list`), `--job <id>`/`-j` (strict digits, kept as a
  STRING in argv so job ids beyond 2^53 pass through verbatim),
  `--json <fields>`, `--jq <expr>`. `--web`/`-w` (opens a browser),
  `--template`/`-t`, and `--exit-status` (failed runs already arrive as
  data via `pr checks` and `run list` status fields) are unknown-flag
  rejections; the `run ls` alias is not in the subcommand union, and
  watch/rerun/download are out of scope entirely.
- Attached short forms stay limited to `-L`/`-R` (the `/^(-L|-R)(.+)$/`
  rule): `-a2`, `-j123`, `-bmain`, and `-wci.yml` are unknown-flag
  rejections on every subcommand; use the separate value token or the
  `--flag=value` form.
- Output-mode passthrough policy: the tool performs NO mutual-exclusion
  checks between output modes. `--log` combined with `--log-failed`, log
  flags combined with `--json`/`--jq`, and `--jq` without `--json` are all
  passed to gh verbatim, and gh's own errors (including its refusal of
  meaningless combinations) surface unchanged through the failure contract.

Value validation (native commands):

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

## GitHub API operations

The six structured operations (`repo contents`, `repo tree`, `commit
checks`, `advisory view`, `check annotations`, `repo metadata`) make read-only GET requests to api.github.com
ONLY, always inside `gh`, with a fixed tool-authored argv (see "API
runner"). They name an explicit repository, so they are exempt from the
worktree gate and work anywhere. Validation is complete at runtime (calls
that bypass schema validation still get checked): unknown or mixed fields,
wrong types, missing required fields, unsafe integers, and malformed
continuations are rejected before any child runs.

- Repositories are exact `OWNER/REPO` on github.com (no host prefix; the
  legacy `-R` host-prefixed form stays native-only). Endpoint segments and
  query values are percent-encoded per segment inside api.ts. Injection-test
  inputs (braces, percent escapes, slashes, `?`, `#`, leading dashes, `@`)
  are transported literally or rejected: path segments that cannot be
  encoded (lone surrogates) fail validation; `.`, `..`, empty, leading and
  trailing slash segments are rejected outright. gh placeholder expansion
  (`:owner`) is unreachable because `:` is percent-encoded, and no caller
  text reaches a flag position (the endpoint argument always starts with
  `repos/` or `advisories/`).
- Ref pinning: an omitted ref resolves through repository default-branch
  metadata; branch/tag/short-SHA refs resolve through the commits endpoint
  once to a full 40-hex commit SHA. The requested target and resolved SHA
  are reported, and every dependent read is pinned to the SHA (query
  `ref=<sha>` or URL path). A complete lowercase 40-hex input is used
  directly (it is already immutable); uppercase hex and short SHAs still
  resolve through the API.

### repo contents

Required `repo`, `path` (empty string = repository root); optional `ref`,
1-based inclusive `start_line`/`end_line` (omitted end = EOF; end alone =
`1..end`), and `jq`. Directory listings return GitHub-shaped entries; a
1,000-entry listing (GitHub's contents page cap) is conservatively marked
possibly incomplete with a tree-read recommendation. File text is decoded
strictly from base64 and served only as valid UTF-8 up to 1 MiB decoded;
NUL-containing content (binary heuristic), invalid UTF-8, oversized files,
and nonordinary types (submodules, unknown types) return metadata with a
reason instead of content, and are NOT errors. Line ranges apply only to
text and preserve original line endings and trailing-newline behavior; jq
applies only to directory JSON, never file text. In-repository symlink
targets that resolve to ordinary files are followed exactly one level;
broken, non-file, or root-escaping targets return metadata. External URLs,
download URLs, and submodules are never followed.

### repo tree

Required `repo`; optional `ref`, subtree `path`, `recursive` (default
true), `jq`. The commit's tree SHA is resolved, then the tree is read with
`recursive=1` appended, or with the `recursive` query parameter omitted
entirely in shallow mode. Upstream fields (`type`, `mode`, SHA,
`truncated`) are preserved as-is; a truncated upstream tree is reported and
NEVER repaired by expanding subtrees. A subtree path filters entries to the
exact path and its children.

### commit checks

Required `repo`, `ref`; optional `jq`, `continuation`. Both sources are
fetched against the one resolved immutable SHA: check runs (with
`filter=latest`) and legacy statuses (combined-status endpoint, latest per
context, newest occurrence wins). Output assembles
`{check_runs:[...], statuses:[...]}` preserving source fields; history is
never substituted, mergeability is never inferred, and aggregate green is
never claimed. Auto-pagination runs at most 10 pages x 100 items per
source per invocation via strictly validated `Link` headers: origin must
be https://api.github.com, the path must match, every invariant query
parameter must be present and unchanged, no unexpected parameter may
appear, and the page must be exactly current + 1; requests are always
reconstructed from tool-owned templates, and foreign URLs, cycles, and
ambiguous links are rejected as per-source errors. Stops between complete
responses (page or budget limits) are nonerror incompleteness;
interrupted/truncated responses are errors. A versioned, size-bounded
continuation token carries the operation, target/query, pinned SHA, and
independent per-source page/done states; it is matched against the
invocation (repo + ref, or id + type), resumed refs are never re-resolved,
completed-source data is preserved when the other source fails, and retry
positions are retained. Note: check results are mutable CI state, not a
transactional snapshot; GitHub also bounds which check suites it returns
for old commits (service-side), so local completion does not prove
historical completeness.

### advisory view

Required `id` (exact `CVE-YYYY-NNNN` or `GHSA-xxxx-xxxx-xxxx` identifier;
anything else is rejected); optional `type`, `jq`, `continuation`. GHSAs
are fetched directly as one object; `type` and `continuation` are rejected
for GHSA ids. CVEs are queried as array searches with an explicit type
defaulting to `reviewed` (also `unreviewed`, `malware`); the searched type
is reported, and an empty result is a successful search of that type, not
proof of global absence. Vulnerable/patched/withdrawn fields pass through;
advisory content is mutable and can be withdrawn or amended after a read.
CVE searches reuse the bounded Link-header pagination and continuation
machinery of commit checks.

### check annotations

Required `repo`, `check_run_id` (a safe integer >= 1, never coerced from a
string); optional `jq`. A single tool-authored GET
`repos/{owner}/{repo}/check-runs/{id}/annotations?per_page=100` is issued:
no ref resolution, no pagination, no Link parsing, no continuation, exactly
ONE request ever, even at 100 items. The response body MUST be a JSON
array; an object, a string, or invalid JSON is an error with a reason.
The incompleteness notice (`only the first page was fetched; the listing
may be incomplete`) is computed from the ORIGINAL response array BEFORE jq,
at exactly 100 items only, and survives jq-empty and jq-scalar output as
well as 50 KiB display truncation, because renderData carries notices
through its jq path and renderResult renders notices in the metadata head,
which is always complete. HTTP 404/403 outcomes pass through verbatim with
no retry or error-shape matching.

### repo metadata

Required `repo`; optional `jq`. A single tool-authored GET
`repos/{owner}/{repo}` returns the flat REST repository object (default
branch, description, visibility, created/updated/pushed dates, web/clone/SSH
URLs, license, primary language, archived/fork/template flags, topics,
homepage, star/fork/issue counts, size) as one unpaged request: no ref
resolution, no pagination, no Link parsing, no continuation, exactly ONE
request ever. The body MUST be a JSON object (arrays, strings, and invalid
JSON are errors). The response passes through verbatim, including the
viewer-specific `.permissions` object (the authenticated token's admin/maintain/push/triage/pull
facts), which metadata labels as token-dependent without rewriting anything.
Narrow with jq (e.g. `.default_branch`). Settled (interview, 2026-10-21):
this supersedes the original "via `gh repo view`" plan for the repository
metadata follow-up, because `gh repo view --json` is GraphQL-backed with
relationship collections (`issues`, `pullRequests`, `milestones`, ...) that
would let non-metadata data through the door, and its text mode prints the
README; the README stays covered by `repo contents` instead.

### API runner (api-spawn.ts)

A dedicated runner per invocation, separate from the native executor
(which keeps its 15 s / 50 KiB contract unchanged). Every request is a
fixed argv: `gh api --hostname github.com --method GET --header "Accept:
application/vnd.github+json" --header "X-GitHub-Api-Version: 2022-11-28"
--include <encoded-path>`; no caller flags, field arguments, or
`--paginate`. One monotonic 30-second deadline is shared across ref
resolution, all paged children, and jq. The captured-output budget is 8
MiB of gh response stdout CUMULATIVELY (resolution requests and response
headers included). Honest scope: this bounds what the tool CAPTURES, not
network transfer or gh's internal memory use. Header blocks are bounded
separately (64 KiB) and stderr diagnostics cumulatively (16 KiB). Streams
are drained continuously; on overflow, deadline, or cancellation the child
gets SIGTERM then SIGKILL (5 s teardown grace, documented separately from
the deadline) and is reaped before the promise resolves. A response whose
bytes were dropped mid-stream is rejected as interrupted even when the
retained prefix would parse. Malformed UTF-8 bodies reject the response
instead of silently substituting replacement characters. Spawn function
and clock are injectable seams; tests run network-free.

### External jq filtering (jq.ts)

jq is optional (only invoked when requested) and preflighted BEFORE any
network access: absolute executable resolution, a lexical security check,
and compilation by jq itself (`jq -c -n <expr>`; exit 3 rejects). The
lexical check is grounded in jq's grammar, not substring regexes: it
recognizes comments, strings, escapes, executable tokens, and nested
string interpolation; rejects executable module/import/include constructs
including data imports; inspects executable code inside interpolations;
permits benign property names and quoted keywords such as `.include` and
`"include"`; and rejects malformed or unsupported lexical constructs
rather than guessing. jq 1.7 loads no modules at startup (verified against
the jq manual/source: loading happens only via import/include, which the
lexical gate rejects; there is no config file). Defense in depth: the jq
child gets a minimal environment (exactly HOME and LC_ALL, no inherited
credentials or loader-injection variables) with HOME overridden to a
tool-owned guard FILE, proven unusable as a directory, so `~/.jq` and
`$HOME/.jq` search locations cannot exist. `-L` is never passed and no
caller-controlled flags, module paths, filter files, or input files are
accepted; the expression is one argv element and the document flows
through stdin. The binary's own directory ($ORIGIN) is a residual path,
accepted because writing there requires root and canary tests assert
startup loads nothing. Output is compact JSON lines; zero output is an
empty filtered result, not failure; jq applies once to the final newly
fetched batch, never to tool metadata. Target, completeness, errors, and
continuation stay outside filtered output.

### API result shape and display cap

API metadata (target/SHA, `source_complete`, reasons/per-source state,
errors, `output_truncated`, next continuation) renders outside the data
block and is also exposed in tool details. Validation, auth, parse,
timeout, jq, and partial-source failures set `isError: true` while
preserving useful results. The ENTIRE displayed API result is capped at
50 KiB including metadata, escaping, diagnostics, and notices (metadata
space reserved); on overflow the data becomes an explicitly incomplete
UTF-8-safe prefix preview labeled "NOT complete JSON" plus narrowing
guidance. Source completeness and display clipping are distinct facts. No
hidden full payload is retained in details or on disk. Native command
result conventions are unchanged.

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
repository context, so it is useful precisely where the other seven are not:
outside any worktree. The other seven keep the gate unchanged, including
`run view --log`: the dual-window log runner reuses the identical
worktreeCheckPassed gate even though `run view` accepts `-R` (settled
one-simple-contract rule).

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

### Log output (log-spawn.ts, run view --log/--log-failed)

Log-carrying invocations are selected by the structured `logMode` state
that validate.ts sets when a validated boolean `--log`/`--log-failed` token
is accepted for `run view`; index.ts never inspects argv tokens. A `--jq`
VALUE equal to `--log` is consumed as a value token and can never select
the runner. Those invocations take the gh-read-local dual-window runner
(log-spawn.ts) instead of the shared core: stdout is captured as the FIRST
50 KiB plus the LAST 50 KiB (100 KiB worst case; the middle is dropped)
with a separate 50 KiB stderr head cap so failure diagnostics are never
starved by log bytes. When nothing is dropped the output is byte-identical
to the child's stdout; otherwise the exact notice
`[gh_read: <N> bytes omitted, showing first and last 50 KiB]` is inserted,
where N counts discarded SOURCE bytes (UTF-8-safe window-edge trims are
decode hygiene, at most 3 bytes per edge, and are never counted). The 30 s
timeout (SIGTERM, then SIGKILL after 5 s) covers gh's zip fetch plus the
per-job API fallback. Honest scope: these are CAPTURED-OUTPUT bounds only;
gh's internal zip download and temp storage are not bounded by this tool.
Very large logs legitimately time out as failures with the retained
windows and stderr kept as diagnostics. Narrow first: `--log-failed` for
failed-step logs only, or `-j <job id> --log` for one job's log. The
dual-window shape may later be adopted elsewhere, but WITHOUT modifying
`extensions/shared/bounded-spawn.ts`: the shared module keeps its single
cap, and the log runner deliberately does NOT use `boundedExec` (different
bounds) while reusing its `OUTPUT_CAP`/`KILL_ESCALATION_MS` constants.
Non-log invocations keep the 15 s / 50 KiB contract unchanged.

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

- `tests/gh-read-validate.test.mts`: argv construction for all nine
  subcommands, value-flag bounds (`--limit`, `--state`, `--color`,
  `--attempt`), the
  `-R` regex (accept/reject cases), `--json` field-shape, `--jq` and filter
  token rules, `auth status` happy paths with appended `--json hosts`,
  `auth status` rejections (`--json` with fields other than `hosts`,
  `--show-token`/`--template`/`-R` as unknown flags, positionals, filter-token
  and jq value rules, no attached `-a` short form), `pr checks` argv with
  appended tool JSON fields, `-R`-requires-selector, watch/web/interval/
  fail-fast/template rejections, tool-parameter discrimination (mixed shapes
  rejected both directions), and full API-operation validation (required
  fields, path injection inputs, line bounds, continuation shapes, advisory
  identifier/type rules, schema-bypass coverage). Run coverage: the `run
  list` argv matrix (flags in input order, `--limit` bounds incl. attached
  `-L50`, `-R`, `--json`/`--jq` rules, filter-token rejections, `--all`, no
  positionals, `--`/unknown-flag rejections), `run view` (missing and
  non-numeric positionals with the interactive-selection reason, `--attempt`
  bounds, `--job` strict digits kept as a verbatim string beyond 2^53, log
  and verbose booleans, `-R`+`--jq`), per-subcommand collision resolution
  (`-w`/`-c`/`-a`), `run ls` rejection via `validateToolParams`, structured
  `logMode` state (true only for validated `--log`/`--log-failed`; a `--jq`
  value of `--log` stays false with the value intact), and `check
  annotations` validation (missing/invalid `check_run_id` incl. strings
  never coerced, unknown fields, `continuation` rejected, jq rules), and
  `repo metadata` validation (required repo, optional jq only, ref/path/
  continuation rejected).
- `tests/gh-read-spawn.test.mts`: worktree gate (and the `auth status`
  exemption: no git spawn at all, while `pr list` still gates), environment
  assertions (stripped and injected vars), caps and truncation, timeout
  escalation, exit-code contract including `auth status` passthrough.
  Reuse the git-read spawn test harness patterns. Log runner coverage
  through its own spawn seam (gate still arriving via the shared seam as
  spawn 0): byte-identical under-cap output, exact 100 KiB boundary and
  100 KiB + 1 with N = 1, dual-window content assertions with the middle
  marker absent, 1-byte/7-byte/64 KiB chunked drains, multibyte characters
  straddling window edges with no U+FFFD, concurrent 120 KiB stdout +
  60 KiB stderr on a nonzero exit proving the 50 KiB stderr head is fully
  retained beside both stdout windows and the exact omission notice,
  timeout SIGTERM/SIGKILL escalation via an injected clock with reaping
  parity, spawn errors, cancellation mid-stream and abort-before-spawn
  (zero spawns), argv verbatim plus env/option parity, and the gate still
  applying to `run view --log` even with `-R`.
- `tests/gh-read-api-spawn.test.mts`: the API runner network-free through
  its spawn/clock seams: tool-authored argv and sanitized env, no git gate,
  header/body framing with redirect-block skipping, HTTP error passthrough,
  malformed UTF-8 rejection, exact cumulative budget boundary,
  mid-response overflow (kill, poison, later stops), up-front budget
  stops, header/stderr caps, deadline SIGTERM->SIGKILL escalation and
  reaping, pre-spawn deadline/cancellation refusals, and spawn errors.
- `tests/gh-read-api.test.mts`: orchestration with a scripted requester
  seam: ref resolution and pinning (default branch, explicit refs, 40-hex
  fast path), text files with CRLF/EOF-preserving line ranges, binary/
  non-UTF-8/oversized metadata results, 1,000-entry directory flags,
  symlink following (one level, broken/non-file/root-escape), submodules,
  trees (recursive query omission in shallow mode, subtree filters,
  upstream truncation preserved), combined checks (pinned SHA, status
  dedupe, sequential Link paging, malicious/foreign/mutating/misordered
  next-link rejection, page-limit stops with continuations, failed-source
  data retention, resume without re-resolution, mismatch rejection),
  advisories (direct GHSA, CVE defaults and types, empty results,
  continuation matching), jq applied once to the final batch, and the
  50 KiB display cap with incomplete-prefix labeling. Check annotations:
  0/99/100 items with the notice only at exactly 100, endpoint exactness
  with one request even at 100 items, the notice surviving jq scalar and
  jq-empty output and coexisting with 50 KiB display truncation, jq applied
  exactly once, non-array bodies (object, string, invalid JSON) as errors,
  and 404/403 passthrough with no retry. Repo metadata: one unpaged request
  with the flat object passed through verbatim, jq applied once, non-object
  bodies (array, string, invalid JSON) as errors, and 404/403 passthrough.
- `tests/gh-read-jq.test.mts`: REAL-jq coverage (required in CI): lexical
  security matrix (benign keywords, imports incl. interpolations, malformed
  constructs), preflight compile rejection, zero/multi-value output, env/
  $ENV isolation asserting exactly HOME+LC_ALL, HOME guard-file canaries,
  startup module canary, runtime errors, and output-cap truncation.
- `tests/gh-read-tool.test.mts`: registered-tool coverage through a capture
  stub and the spawn seams: schema shape without outputSchema, fail-closed
  validation errors with zero spawns, native path (gate + argv verbatim,
  details.subcommand), `pr checks` tool-authored JSON fields reaching the
  child, and the API path end to end (no worktree gate, pinned SHA,
  partial-source isError with preserved data and continuation). Run
  coverage: `run list` end to end with argv verbatim, `run view --log`
  routed to the log runner via the structured `logMode` state (the shared
  seam captures only the rev-parse gate; the log seam captures the gh
  child), `run view` without log flags keeping the shared runner, `check
  annotations` end to end through the API seam with no git-gate spawn and
  the tool-authored annotations argv, zero spawns on rejected run-family
  params, and the three new schema literals plus the `check_run_id` field.
  Repo metadata end to end: tool-authored `repos/{owner}/{repo}` GET with no
  git-gate spawn and the full object (viewer permissions included) as data.
- Regression guard for the extraction: existing
  `tests/git-read-spawn.test.mts` must pass unmodified.

## Acceptance criteria

- A read-only agent (no `bash`) with `gh_read` but no other network tools
  can list a repo's open PRs, view a PR with comments, and view its diff.
- The same agent can triage GitHub Actions runs: `run list` finds runs,
  `run view` (numeric run id, no interactive selection) shows a summary or,
  with `--log`/`--log-failed`, bounded first-and-last-50 KiB log output, and
  `check annotations` fetches one check run's annotations with an explicit
  incompleteness notice at a full page.
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
- No `gh api` (direct, with caller flags), `gh search`, `gh release`; the
  `gh run` surface stays limited to the read-only `run list`/`run view`
  pair: `gh run watch`, `gh run rerun`, `gh run download`, and
  `--exit-status` remain excluded. Expand the allowlist only on demonstrated
  need, one design-review cycle per addition.
- No URL arguments, no `--template`, no `--web` forms.
- No token handling, masking, or account switching inside the tool. Keeping
  `--show-token` off the `auth status` allowlist is what keeps this non-goal
  true: token values never enter tool output through any allowlisted path.
- Do not bypass the user's guard/sandbox policies: `remote-read` classification
  means guard profiles still decide, per profile, whether network reads are
  allowed at all.
