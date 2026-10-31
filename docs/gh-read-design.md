# `gh_read` tool: read-only GitHub CLI access for agents

Status: design settled (grill-me review, 2026-10-13; all branches decided).
Implemented: extensions/gh-read/ (validate, spawn, index), shared core at
extensions/shared/bounded-spawn.ts, guard classification, agent rollout, and
tests. The git-read extraction regression guard held: tests/git-read-*.test.mts
passed unmodified after the refactor.

Addition: `pr threads` (see "pr threads"): the GraphQL review-thread read
with resolved/outdated state, implemented as the tenth API operation and the
first (and only) tool-authored GraphQL POST transport.

Addition: `job logs` (see "job logs"). Design settled in a grill-me review on
2026-10-26; NOT yet implemented. It is the first API operation whose response
body is text rather than JSON, and the first to use a windowed retention mode
in the API runner.

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

## Prompt guidance

Purpose: steer agents from raw `gh api` and `gh pr-threads` shell calls to
the operations above and to documented workarounds. Guidance only: no
allowlist, schema, `description`, or `promptSnippet` change. It lives in the
`promptGuidelines` array in `extensions/gh-read/index.ts` (14 bullets).

Corpus (2026-10-29): all 1277 pi sessions, current session excluded; 1536
`gh api` occurrences in total, 405 command lines in the 317 sessions where
`gh_read` was registered. The first table breaks down the shapes seen in
that 405-line sample; it is not a complete decomposition of the sample.

`gh api` shapes in the sample:

| Shape | Count | `gh_read` status |
|---|---|---|
| `gh api user --jq .login` | 148 | covered by `auth status` |
| `issues/{n}/timeline` | 14-21 | uncovered |
| `pulls/{n}/reviews` | 13 | covered by `pr reviews` |
| comments by id | 13 | uncovered |
| `branches` | 12 | uncovered |
| `issues/{n}/comments` | 10 | covered by `issue comments` |
| `graphql` | 9 | `pr threads` covers the review-thread read |
| `commits` | 9 | uncovered |
| `pulls/{n}/comments` | 8 | covered by `pr comments` |
| `search/issues` | 7 | uncovered |
| `git/trees/HEAD` | 5 | covered by `repo tree` |
| `pulls/{n}/files` | 3 | uncovered |

Outside the `gh api` denominator (neither is a `gh api` command line, so
neither counts against the 405):

| Shape | Count |
|---|---|
| `gh pr-threads` (personal gh CLI extension, unsupported by design) | 139 |
| review-reply POSTs (writes) | 60+ |

The covered `gh api` rows sum to 184 at `timeline = 14`
(148 + 13 + 10 + 8 + 5), about half of the 405 lines, so roughly half of the
escapes are a guidance problem, not an allowlist gap.

Guidance added:

- `auth status` instead of `gh api user --jq .login` (folded into the
  `auth status` bullet).
- A mapping from raw endpoints to operation names (`pulls/{n}/reviews` is
  `pr reviews`, `pulls/{n}/comments` is `pr comments`,
  `issues/{n}/comments` is `issue comments`, `git/trees/HEAD` is `repo tree`,
  default branch is `repo metadata`, and the tool-authored GraphQL
  review-thread read is `pr threads`), folded into the API-operations
  bullet.
  Commits are deliberately not named: `commit checks` returns check runs, and
  commit details are an open TODO.
- A bullet for shapes with no dedicated operation: changed-file list
  (`pr diff --name-only`, or `pr view --json files,changedFiles` comparing
  the length of `files` with `changedFiles` to detect a truncated list), one
  review's comments (`pr comments` with jq
  `select(.pull_request_review_id == <id>)`, noting jq applies per batch so
  `source_complete` is the stop condition), a comment by id (parent number
  from `html_url`, then jq `select(.id == <id>)` on the parent listing), and
  resolved/outdated review-thread state pointing at `pr threads` (never
  derive it from comment line fields).
- A write-boundary bullet: `gh_read` never writes; posting replies,
  resolving threads, and submitting reviews need `host_bash`, which guard
  may prompt for depending on the profile. The 60+ review-reply POSTs mean
  `gh_read` can never make PR-review publication shell-free.

Not covered by guidance: the issue/PR timeline (a TODO operation, so no
workaround is claimed), `search/issues`, `commits`, `branches`, and generic
`graphql` reads other than the review-thread read. `gh pr-threads` is named
only here; the guidance now points at `pr threads` for the review-thread
read.

Verification (2026-10-30, against DataDog/dd-trace-dotnet#9397):
`pr diff --name-only` returned 8 files; `pr view --json files,changedFiles`
returned 8/8; jq `select(.pull_request_review_id == 5699725775)` gave 2 hits;
comment 4287875152 was recovered from its `html_url` and matched in the
parent listing. The `-R OWNER/REPO` form of `pr diff --name-only` was also run and returned
the same 8 paths. The silent 100-file cap behind `pr view --json files` is
cited from `TODO.md` and was not re-verified.

## Invocation contract

- Structured argv, no shell: `{ subcommand, args }` where `subcommand` is a
  literal union of the nine two-word native commands below (modeled as one
  string so the schema stays flat like `git_read`'s):
  - `pr view`, `pr diff`, `pr list`, `pr checks`, `issue view`, `issue list`,
    `auth status`, `run list`, `run view`
- Narrowly scoped GitHub API operations share the same tool with
  structured parameters instead of an args array (all are implemented except
  `job logs`, which is designed but not yet implemented, see "job logs"):
  `repo contents`, `repo tree`, `commit checks`, `advisory view`,
  `check annotations`, `repo metadata`, `pr comments`, `pr reviews`,
  `issue comments`, `pr threads`, and `job logs` (see "GitHub API
  operations").
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
- The eight repo subcommands (not `auth status`): `-R/--repo [HOST/]OWNER/REPO`,
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

The designed structured operations (`repo contents`, `repo tree`,
`commit checks`, `advisory view`, `check annotations`, `repo metadata`,
`pr comments`, `pr reviews`, `issue comments`, `pr threads`, `job logs`)
make read-only requests to api.github.com ONLY, always inside `gh`, with a
fixed tool-authored argv (see "API runner"); all are implemented except
`job logs`, which is designed but not yet implemented. Every operation but
`job logs` returns JSON; `pr threads` sends a tool-authored GraphQL POST
instead of a REST GET, and `job logs` returns a job's log as text. They name
an explicit repository, so they are exempt from the
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
  (`:owner`) is unreachable because `:` is percent-encoded, and the REST
  endpoint argument always starts with `repos/` or `advisories/`, never with
  caller text. The GraphQL read is the one operation whose request carries
  caller-derived values in flag positions: it rides `-f`/`-F` variable
  pairs whose names are GraphQL names and whose values are validated
  non-control strings (at most 512 characters) or a safe integer.
- Ref pinning (repo contents/tree and commit checks only): an omitted ref
  resolves through repository default-branch metadata; branch/tag/short-SHA
  refs resolve through the commits endpoint
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

### pr comments and pr reviews

Each operation requires explicit `repo` (`OWNER/REPO` on github.com) and
`pr` (a positive safe-integer PR number, never coerced from a string).
Only `jq` and `continuation` are optional. Branch names, URLs, `args`,
`ref`, and unrelated structured fields are rejected before spawning.
There is no worktree gate, ref resolution, or SHA pinning for either read.

#### pr comments

Tool-authored GET
`repos/{owner}/{repo}/pulls/{pr}/comments?per_page=100&page=<n>`.
Returns a verbatim REST array of inline review comments, including
replies carrying `in_reply_to_id`. Fields such as `path`, `line`, `side`,
`original_line`, `diff_hunk`, `commit_id`, `body`, and `html_url` pass
through without projection or thread reconstruction. This is distinct
from PR conversation comments exposed by native `pr view --comments`.

#### pr reviews

Tool-authored GET
`repos/{owner}/{repo}/pulls/{pr}/reviews?per_page=100&page=<n>`.
Returns a separate verbatim REST array of review bodies and verdicts,
preserving fields such as `user.login`, `state`, `body`, `submitted_at`,
and `commit_id`. No latest-verdict reduction or aggregate approval state
is computed.

#### Shared PR read guarantees

Each response body must be a JSON array; objects, strings, and invalid JSON
are errors. Each operation pages independently, at most 10 pages x 100
items per invocation, reusing the strict Link validation and tool-owned
request reconstruction of commit checks. No combined result object,
combined comments/reviews token, or automatic cross-operation fetch exists.
A versioned, size-bounded continuation binds the operation, repo, PR number,
and next-page state; it must be returned unchanged with the same
`subcommand` + `repo` + `pr`. Tokens cannot cross operations or targets.
Resumes fetch only the next batch, not earlier batches. Completed pages
are retained if a later page fails, with the failed page kept as the retry
position; page/budget stops between complete responses are nonerror
incompleteness, while request/parse/interruption failures remain errors.
HTTP errors pass through without automatic retries.

These are mutable, non-transactional listings: comments/reviews can change
between pages and between calls, so offset paging can miss or duplicate
items. Source completion means the observed listing was exhausted, not a
historical snapshot or proof of an unchanged review state. Metadata reports
the PR target, completeness, and continuation without fabricating a resolved
SHA. Neither operation supplies `isResolved`/`isOutdated` review-thread
state, infers resolution from line fields, nor reconstructs complete thread
history; that is what `pr threads` provides over a tool-authored GraphQL
POST (see "pr threads" below).

The existing API bounds apply unchanged: one 30 s shared deadline, 8 MiB
cumulative captured-output budget, external jq applied once to the newly
fetched array, and the 50 KiB display cap. Target/completeness/errors/continuation remain outside jq and survive
empty or scalar output and display truncation. For example:

```json
{"subcommand":"pr comments","repo":"DataDog/dd-trace-dotnet","pr":9479,"jq":".[] | {author: .user.login, path, line, body, html_url}"}
```

### pr threads

Required explicit `repo` (`OWNER/REPO` on github.com) and `pr` (a positive
safe-integer PR number, never coerced from a string, branch, or URL). Only
`jq` and `continuation` are optional. `args`, `ref`, `first`, `cursor`,
`resolved`, `depth`, `issue`, and any other unrelated structured field are
rejected before spawning. There is no worktree gate, no ref resolution, and
no SHA pinning.

The transport is tool-authored and is the only GraphQL request the tool ever
makes: `gh api graphql --hostname github.com --method POST --header "Accept:
application/vnd.github+json" --header "X-GitHub-Api-Version: 2022-11-28"
--include -f query=<fixed document>` followed by one variable pair per
argument, in caller order. The document is a module constant
(`REVIEW_THREADS_QUERY` in api.ts), never caller-supplied text:

```graphql
query($owner:String!,$repo:String!,$pr:Int!,$cursor:String){repository(owner:$owner,name:$repo){pullRequest(number:$pr){url reviewThreads(first:100, after:$cursor){totalCount pageInfo{hasNextPage endCursor} nodes{id isResolved isOutdated path line startLine comments(first:100){totalCount pageInfo{hasNextPage endCursor} nodes{id databaseId author{login __typename} body createdAt url}}}}}}}
```

GitHub's `-f` does NOT expand `{placeholder}` values while `-F` does, so
every caller-derived string (owner, repo, cursor) rides `-f` and only the
validated integer (`pr`) uses `-F`; a `{` or `%` in a repository name is
therefore transported literally. The runner shares the one 30 s deadline,
the 8 MiB cumulative captured-output budget, the 64 KiB header block cap,
the 16 KiB cumulative stderr cap, strict UTF-8 decoding, poisoning, and the
SIGTERM-then-SIGKILL teardown of "API runner" above. Exit code 1 is
tolerated ONLY when the HTTP status is 2xx and the decoded body parses to a
JSON object, because `gh api graphql` exits 1 when a body carries usable
partial data beside an `errors` array; exit 0 keeps its meaning, every other
nonzero code (including 2) stays an error, a non-2xx status stays an error
carrying `httpStatus`, and the REST transports keep the original
exit-0-only rule.

The payload is the verbatim `reviewThreads.nodes` array: `id`, `isResolved`,
`isOutdated`, `path`, `line`, `startLine`, and each thread's
`comments.nodes` are passed through with nothing normalized, filtered, or
reconstructed, so resolved and outdated threads are returned alongside
unresolved ones. There is one shape rule with two buckets:

- Malformed shapes are errors (never a zero-thread success): a non-object
  body, missing or null `data`, a null or non-object `repository`,
  `pullRequest`, or `reviewThreads`, a missing or non-array `nodes`, and a
  missing, null, or non-boolean `pageInfo.hasNextPage`.
- A well-formed page with `hasNextPage: true` and a missing or unusable
  `endCursor` is a NON-error incomplete stop: its nodes are returned,
  `source_complete` is false, an explicit `incomplete_reason` is set, and NO
  continuation is emitted (there is no position to continue from).

Bounds: 100 threads per page, each thread's first 100 comments, and at most
10 pages, so up to 1,000 threads per invocation. This supersedes the earlier
"bounded pagination for threads and comments": per-thread comment paging is
unsupported in this version and is recorded as a follow-up in `TODO.md`.
Threads whose `comments.totalCount` exceeds the returned `comments.nodes`
are counted in `threads_with_truncated_comments`, and comments restart at
their first page on resume.

The continuation payload is `{v:1, op:"pr threads", repo, pr, first:100,
cursor}`, where `cursor` is the last observed `endCursor`, or null for a
first-page retry. Decoding requires `op === "pr threads"`, a string `repo`, a
positive safe-integer `pr`, `first === 100`, and a `cursor` that is exactly
null or a 1..512-character printable-ASCII string; the token is then matched
against repo and pr before any request runs. A continuation is emitted
whenever the traversal is not done, including on the error path, where the
retry cursor is the cursor used for the failed request (null for a
first-page failure); page-limit and between-response budget/deadline stops
are nonerror incompleteness, and only the non-continuable incomplete stop
above suppresses the token.

Mutability: threads and comments are mutable reads, not commit-pinned or
transactional snapshots, and cursor paging can miss or duplicate threads
that change between pages, so completion describes the observed traversal
only. Every result carries three standing notices (resolved/outdated threads
are included unfiltered; the mutability caveat; and the per-thread comment
bound), initialized before continuation matching so they survive mismatch
errors, jq errors, and display clipping. GraphQL `errors` messages are
sanitized per page, then deduped and bounded once for the invocation to 10
notice lines plus an omission count, so a multi-page traversal cannot
multiply the metadata head.

```json
{"subcommand":"pr threads","repo":"DataDog/dd-trace-dotnet","pr":9397,"jq":".[] | select(.isResolved == false) | {path, line, isOutdated, author: .comments.nodes[0].author.login}"}
```

### issue comments

Required explicit `repo` (`OWNER/REPO` on github.com) and `issue`
(a positive safe-integer issue number, never coerced from a string, branch,
or URL). Only `jq` and `continuation` are optional. `pr`, `args`, branch
names, URLs, endpoint/page controls (`path`, `ref`, `page`, `per_page`), and
any other unrelated structured field (including redirection-shaped names
such as `2>&1`) are rejected before spawning. There is no worktree gate, no
ref resolution, and no SHA pinning.

Tool-authored GET
`repos/{owner}/{repo}/issues/{issue}/comments?per_page=100&page=<n>`.
Returns the verbatim REST conversation-comment array for the issue. Because
GitHub models PRs as issues, the same endpoint also returns PR conversation
comments; this is the CONVERSATION thread, distinct from the inline review
comments and replies that `pr comments` returns from
`/pulls/{pr}/comments`. Fields such as `id`, `user.login`, `created_at`,
`updated_at`, `body`, `html_url`, and unknown nested members pass through
without projection or thread reconstruction. `issue comments` never emits a
`pr` metadata field and never requests a `/pulls/` path.

It reuses the shared bounded discussion-read engine unchanged: array-body
validation with objects/strings/invalid JSON as errors, at most 10 pages x
100 items per invocation, strict tool-owned Link validation and request
reconstruction, independent target-bound continuation, retained pages with
the failed page as the retry position, nonerror budget/deadline stops,
jq once on the newly fetched array, and the 50 KiB display cap. Every
result carries a standing notice distinguishing conversation comments from
inline review reads; the notice is initialized before continuation matching
so it survives handler errors, jq-empty/scalar/error output, and display
clipping. Issue metadata reports `repo`, `issue`, `source_complete`,
`items_returned`, `pages_fetched`, and `resumed`; mutability is described as
a mutable, offset-paged listing that may miss or duplicate items, unlike
the review-specific resolved/outdated caveat that stays with the PR review
operations.

```json
{"subcommand":"issue comments","repo":"DataDog/dd-trace-js","issue":10775,"jq":".[] | select(.user.login==\"lucaspimentel\") | {created: .created_at, body: (.body[:200])}"}
```

A structured issue body/metadata read (title, state, labels, body, author)
is deliberately NOT added here; it is recorded as a separate follow-up in
`TODO.md`.

`check annotations` remains a single-page operation with its existing
exactly-100-items incompleteness notice; it does not adopt PR pagination.

### job logs

Required explicit `repo` (`OWNER/REPO` on github.com) and `job_id`. `job_id`
is a digits string, because job ids are int64 and may exceed 2^53; a JSON
number is also accepted when it is a safe integer and is normalized to its
string form, while a number beyond 2^53 is rejected naming the string form,
so an id can never be silently rounded onto a different job. Only those two
fields are accepted: `args`, `jq`, `continuation`, URLs, branches, `ref`,
line ranges, and any other structured field are rejected before spawning.
There is no worktree gate and no rev resolution.

Tool-authored GET `repos/{owner}/{repo}/actions/jobs/{job_id}/logs`. This is
the first API operation whose response body is TEXT, not JSON: `gh` follows
the redirect to a signed blob host internally and the printed stream has only
the final response block, whose body the tool never parses as JSON and never
filters with jq. The body is the raw job log, timestamps plus content and
BOM-prefixed on the first line, with no job/step prefixes, unlike
`gh run view --log`.

Settled in the grill-me review (2026-10-26):

- Input surface is `{repo, job_id}` only, as above.
- Worktree-gate EXEMPT, like the other ten API operations and unlike
  `run view --log`, because the target repository is explicit and the common
  case is debugging CI from a directory that is not a checkout.
- Retention is the first 50 KiB plus the last 50 KiB of the response BODY
  (header block excluded), reported with the exact existing notice
  `[gh_read: <N> bytes omitted, showing first and last 50 KiB]`, where N
  counts discarded body bytes. UTF-8-safe edge trimming applies (at most 3
  bytes per window edge, not counted), matching log-spawn's hygiene. There is
  no ceiling and no poisoning: the cumulative 8 MiB budget never fails this
  operation, because only 100 KiB is retained and the child stays bounded by
  the shared 30 s deadline and continuous draining.
- The window is selected by bytes, not lines; the middle is dropped, never
  re-ordered or re-wrapped, and no line range is offered.
- Decoding stays STRICT, unchanged from the other API bodies: a malformed
  UTF-8 window rejects the response with `response body contained malformed
  UTF-8`. Bytes dropped from the middle are never decoded, so only the
  retained window can fail the read.
- The result is the text plus metadata `repo`, `job_id`, `http_status`,
  `body_bytes`, `retained_bytes`, `omitted_bytes`, and `windowed`, and a
  standing notice marking the text as one job's log with raw runner
  timestamps (`run view --log` prefixes each line with job and step names
  instead). An empty 200 body is a successful empty result with a
  `no log output for this job` notice, not an error.
- A deadline expiry, cancellation, or interrupted response is
  `isError: true` with the error text AND the retained window still in the
  content, so a timed-out large log still yields its head and tail. HTTP
  errors pass through verbatim with no shape matching and no extra request.
  An IN-PROGRESS job's logs endpoint redirects to a signed blob that does not
  exist yet, surfacing as gh exit 1, HTTP 404, stderr `gh: HTTP 404`, and an
  Azure `BlobNotFound` XML body; a nonexistent job id gives gh exit 1, HTTP
  404, stderr `gh: Not Found (HTTP 404)`, and a GitHub JSON body. Both are
  404s, so the description states that a job's logs exist only once the job
  completes and the tool does not sniff the body to tell them apart.
- Guidance: `job logs` is the way to read one job's log from a job id;
  `run view -j <job id> --log` remains available but downloads the whole
  run's log ZIP and prefixes lines with job/step names. Run-level text logs
  are impossible through the API (`/actions/runs/{id}/logs` returns a ZIP,
  verified), so `run view --log` stays the run-level path.

```json
{"subcommand":"job logs","repo":"DataDog/datadog-lambda-extension","job_id":"121616708699"}
```

Verified shapes (2026-10-26, gh 2.102.x): a completed job returns 200
`text/plain` with a BOM-prefixed first line (63,437 bytes for the example
above); an in-progress job and a nonexistent job id both return the 404s
described above; `/actions/runs/{id}/logs` returns a ZIP (197,959 bytes for
that same 11-job run), which is why only the job-scoped endpoint is exposed.

Not verified: a completed job with a zero-byte log body. The empty-body rule
above is a documented default; skipped and in-progress jobs 404 instead, so
the case looks unreachable in practice. Also not encoded as behavior: the
Azure blob host receives no credentials from the tool, since `gh` owns the
redirect and `--hostname github.com` is fixed.

Out of scope here: a JSON job-metadata operation on `actions/jobs/{id}`
(name, status, conclusion, steps, run_id) is recorded as a follow-up in
`TODO.md` rather than bundled, so this operation costs exactly one request.

### API runner (api-spawn.ts)

A dedicated runner per invocation, separate from the native executor
(which keeps its 15 s / 50 KiB contract unchanged). Every REST request is a
fixed argv: `gh api --hostname github.com --method GET --header "Accept:
application/vnd.github+json" --header "X-GitHub-Api-Version: 2022-11-28"
--include <encoded-path>`; no caller flags, field arguments, or
`--paginate`. The one other transport is the tool-authored GraphQL POST used
by `pr threads`, documented under "pr threads"; it shares this runner's
deadline, budget, header/stderr caps, strict decode, and teardown. One
monotonic 30-second deadline is shared across ref resolution, all paged
children, and jq. The captured-output budget is 8
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

One per-operation retention mode was added for `job logs`: the default
"full" mode above is unchanged for the other ten operations, while
"window" mode keeps the first 50 KiB and last 50 KiB of the response BODY,
still counts every byte for the omission metadata, never poisons on growth
past the 8 MiB budget, and carries the retained window on the error path so a
deadline or interrupt can return it. The header/body split, the 64 KiB
header block, the 16 KiB stderr cap, the strict UTF-8 decode, and the shared
30 s deadline apply to both modes. The ten existing operations must remain
byte-identical; their budget and poison tests are re-pinned against the
unchanged "full" mode.

### External jq filtering (jq.ts)

jq is optional (only invoked when requested). Three gates run before the
jq child: absolute executable resolution, a lexical security check, and
compilation by jq itself (`jq -c -n <expr>`; exit 3 rejects). For API
operations the compile gate runs after the GitHub fetch, because the only
`prepareJq` call sits inside `runToolJq`, which `renderData` reaches once
the data is already in hand (compile-on-the-way-in); hoisting it ahead of
the first request is a known follow-up (`TODO.md`). The
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

PR continuation payloads carry `v: 1`, `op` (`pr comments` or `pr reviews`),
`repo`, numeric `pr`, `perPage: 100`, and `source: {page, done: false}`.
issue-comments payloads are the same shape with `op: "issue comments"` and a
numeric `issue` instead of `pr`. The `pr threads` payload is cursor-based,
not offset-based: `{v:1, op:"pr threads", repo, pr, first:100, cursor}` (see
"pr threads"). Before any request, the decoder requires a
non-array source object and a positive safe-integer page, then the handler
matches operation/repo/target exactly (issue comment tokens also require a
positive safe-integer issue; a legacy-v1 PR token never satisfies an issue
invocation and vice versa). Tokens are opaque bounded payloads, not signed
credentials. They are not bound to jq, so a resumed batch may use a
different filter. Existing commit-checks, CVE, and PR token formats remain
unchanged; the version is not bumped.

PR metadata includes `repo`, `pr`, `source_complete`, `items_returned`
(before jq), `pages_fetched`, and `resumed: true` on resumption. Issue
comments metadata is identical with `issue` in place of `pr`. Incomplete
reads include `continuation` plus `incomplete_reason` for nonerror stops or
`source_error` for failures. HTTP, interruption, JSON, extraction, and
invalid-Link failures preserve accepted items and set `isError`; no failed
request is automatically retried. Request/parse failures retain the failed
page for retry; invalid Links retain the shared engine's tool-owned next
page, never a page derived from the rejected URL. Continuation encoding
failure is itself an error. Page-limit and between-response budget/deadline
stops are nonerror incompleteness. Exactly 100 items without a next Link is
complete. Display clipping alone never creates a continuation or changes
source completeness.

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

The text-mode exception is `job logs`: its result is raw log text rendered
through the window described under "job logs" rather than the JSON pipeline,
so jq, continuation, and the 50 KiB "NOT complete JSON" prefix preview do not
apply. Its display bound is the 100 KiB window plus metadata and notices.
Metadata is `repo`, `job_id`, `http_status`, `body_bytes`, `retained_bytes`,
`omitted_bytes`, and `windowed`; a windowed read also carries the exact
omission notice in the text, and every read carries the standing one-job
format notice. Failures still set `isError: true`, and a timeout or an
interrupted read keeps the retained window in the content instead of
dropping it.

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
repository context, so it is useful precisely where the other eight are not:
outside any worktree. The other eight keep the gate unchanged, including
`run view --log`: the dual-window log runner reuses the identical
worktreeCheckPassed gate even though `run view` accepts `-R` (settled
one-simple-contract rule). Separately, the ten implemented API operations
are exempt as a class, as documented under "GitHub API operations";
`job logs` inherits that exemption even though it returns log text, so a CI
log can be read from a directory that is not a checkout while `run view
--log` still cannot.

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

`job logs` deliberately does NOT use this runner: it is an API operation
using the API runner's windowed mode, gate-exempt, and `isError: true` on a
failed read, while `run view --log` stays native, gated, and reports failures
as text with no `isError`. The window size and the omission notice string are
shared; the two paths are otherwise separate.

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
step (see dd-tools/docs/git-multi-account-setup.md). API operations always
use the ambient `gh` active account and accept no account selector, so a
read that needs a secondary account must stay on the host shell.

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
  continuation rejected). PR coverage: `pr comments`/`pr reviews` require
  explicit repo and positive safe-integer pr, reject string/branch/URL PR
  selectors and unrelated fields, and validate operation/repo/PR-bound
  continuations, including calls that bypass schema validation. Issue
  coverage: `issue comments` requires explicit repo and positive safe-integer
  issue, rejects string/branch/URL selectors, `pr`, `args`, endpoint/page
  controls, and redirection-shaped fields, and validates
  operation/repo/issue-bound continuations, including schema-bypass calls.
  Job-logs coverage: `job logs` requires an explicit repo and a digits-string
  `job_id` (a safe-integer number is accepted and normalized; a number beyond
  2^53 is rejected with the pass-it-as-a-string message), and rejects `args`,
  URLs, branches, jq, continuation, and unknown fields, including
  schema-bypass calls. Review-thread coverage: `pr threads` requires an
  explicit repo and a positive safe-integer pr, validates
  continuation/jq transport, rejects `args`, `ref`, `first`, `cursor`,
  `resolved`, `depth`, `issue`, and redirection-shaped fields before target
  validation, and rejects `pr` on every other API operation and on native
  subcommands.
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
  Windowed-mode coverage: head+tail retention with the exact omission count,
  body-only byte accounting (the header block is excluded), no poisoning on
  growth past the 8 MiB budget, the retained window returned on the deadline
  and interrupted paths, and strict UTF-8 rejection of a malformed window.
  GraphQL coverage: the exact first-call and resume argv (`-f` for strings,
  `-F` for the integer, a `-f cursor=` pair only on resume) with spawn
  options identical to REST, exit-0 acceptance, 2xx exit-1 acceptance with a
  JSON object body, rejection of non-JSON/array/null bodies and of exit 2,
  a 401 JSON body rejected with `httpStatus`, the REST exit-0-only
  regression, a budget shared across `request` and `graphql` plus poisoning
  refusal of a later call, pre-spawn deadline and cancellation refusals,
  SIGTERM->SIGKILL reaping of a GraphQL child, and invalid query/variable
  rejections with zero spawns.
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
  PR coverage: exact comments/reviews endpoints with no ref resolution,
  verbatim arrays including replies and review states, independent bounded
  Link paging and target-bound resume, retained data/retry positions on
  later-page errors, jq once on the newly fetched array with metadata
  preserved, and array-body validation/error passthrough. Issue coverage:
  the exact issues-comments endpoint with no ref resolution or `/pulls/`
  request, verbatim realistic conversation comments (user.login, created_at,
  updated_at, body, html_url, unknown nested fields), literal v1 token
  compatibility and cross-operation/cross-target rejection with zero
  requests, the same bounded paging/retry/error/jq/display-cap matrix, and
  the mandatory distinction/mutability notices surviving scalar, empty,
  failed-jq, invalid-continuation, and clipped output. Existing single-page
  annotations behavior remains a regression check. Job-logs orchestration:
  the text body rendered with the standing one-job notice and the
  raw-timestamp warning, windowing at exactly 100 KiB and the 100 KiB + 1
  boundary with N = 1, empty-body success with the no-log-output notice,
  `isError: true` with the retained window on timeout/interrupt, 404/403
  passthrough with no shape matching and no extra request, and jq/continuation
  rejection with zero requests. Review-thread orchestration: one GraphQL call
  with no REST request and verbatim nodes (resolved and outdated included),
  two pages in one invocation and a resume that holds only the new batch
  with the resume notice, a resume token whose cursor is null, the 10-page
  limit with the tenth endCursor as the continuation, every token mismatch
  in both directions (wrong op/repo/pr, `first: 99`, empty/oversized/numeric/
  non-object cursors, cross-operation tokens) with zero requests, retained
  threads plus the failed page's cursor on a later-page error, a null
  first-page retry cursor, budget and deadline stops as nonerror
  incompleteness with a continuation, the unusable-endCursor stop as
  nonerror incompleteness WITHOUT a continuation, malformed shapes as errors
  (never a zero-thread success), truncated-comment counting with a null node
  skipped, message dedupe/sanitization/bounding, jq once on the node array
  with metadata and notices unfiltered, display clipping, and a continuation
  encode failure.
- `tests/gh-read-jq.test.mts`: REAL-jq coverage (required in CI): lexical
  security matrix (benign keywords, imports incl. interpolations, malformed
  constructs), preflight compile rejection, zero/multi-value output, env/
  $ENV isolation asserting exactly HOME+LC_ALL, HOME guard-file canaries,
  startup module canary, runtime errors, output-cap truncation, and the exact
  issue-comments example filter (author selection, `created_at` projection,
  and 200-character body slicing with another author excluded).
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
  PR coverage: both schema literals plus the numeric pr field, tool
  guidance distinguishing inline comments/replies, review bodies/verdicts,
  and conversation comments, and end-to-end worktree-free API routing.
  Issue coverage: the `issue comments` schema literal plus the numeric issue
  field, guidance distinguishing conversation comments from inline review
  reads (endpoint named), fail-closed validation with zero spawns, exact
  fixed GET argv outside a worktree with no git gate, `details.subcommand`,
  issue metadata, raw REST fields passed through, and continuation resume
  plus cross-operation rejection. Read-only/idempotent/open-world tool
  annotations remain unchanged. Job-logs routing: the `job logs` schema
  literal plus a `job_id` field accepting digits strings and safe numbers,
  the tool-authored `repos/{owner}/{repo}/actions/jobs/{job_id}/logs` GET
  with no git-gate spawn even outside a worktree, `details.subcommand`,
  guidance stating that logs exist only once the job completes and preferring
  `job logs` over `run view -j --log`, and fail-closed validation with zero
  spawns. Review-thread coverage: the `pr threads` schema literal in the
  schema text, description/snippet/guideline assertions (operation-name
  mapping, resolved/outdated pointer, the never-derive-it warning, and the
  unchanged 14-bullet count), fail-closed validation with zero spawns for
  missing/invalid pr, `args`, `ref`, `cursor`, `first`, and `2>&1`, the exact
  tool-authored GraphQL POST argv with a valid payload and no git-gate
  spawn, `details.subcommand`, a resume run whose argv carries
  `-f cursor=<c>`, cross-operation token rejection before any request, a
  2xx exit-1 read accepted end to end with the GraphQL error visible, and
  the GraphQL message bound applied once per invocation (dedupe across
  pages, at most 10 notice lines plus one omission count) rather than per
  page.
- `tests/guard-classes.test.mts`: built-in `gh_read` mapping and every
  discussion operation (`pr comments`, `pr reviews`, `pr threads`,
  `issue comments`) classify as `remote-read`; configured class overrides
  win.
- Prompt guidance: `tests/gh-read-tool.test.mts` asserts per-topic guideline
  substrings (auth status instead of `gh api user`, operation-name mapping,
  `pr diff --name-only`, `files,changedFiles`, `pull_request_review_id`,
  `html_url` plus `select(.id ==`, thread-state "do not derive it" together
  with the `pr threads` pointer, the `host_bash` write boundary) and the
  14-bullet count.
- Regression guard for the extraction: existing
  `tests/git-read-spawn.test.mts` must pass unmodified.

## Acceptance criteria

- A read-only agent (no `bash`) with `gh_read` but no other network tools
  can list a repo's open PRs, view a PR with comments, and view its diff.
- The same agent can fetch inline PR review comments/replies with `pr
  comments` and review bodies/verdicts with `pr reviews`, using explicit
  `repo` + numeric `pr`, verbatim arrays, and independent bounded
  continuations without a worktree. No resolved/outdated state is claimed.
- The same agent can fetch an issue's (or PR's) conversation comments with
  `issue comments` using explicit `repo` + numeric `issue`, verbatim arrays,
  and an independent bounded continuation, without a worktree and without
  any `pr` metadata or `/pulls/` request; the result distinguishes itself
  from inline PR review reads and never claims review-thread state.
- The same agent can fetch a PR's review threads with resolved/outdated
  state via `pr threads`, using explicit `repo` + numeric `pr` and a cursor
  continuation, outside a worktree and without any caller-supplied GraphQL
  text; malformed responses are errors, and an unusable cursor is reported
  as incompleteness rather than a complete read.
- The same agent can triage GitHub Actions runs: `run list` finds runs,
  `run view` (numeric run id, no interactive selection) shows a summary or,
  with `--log`/`--log-failed`, bounded first-and-last-50 KiB log output, and
  `check annotations` fetches one check run's annotations with an explicit
  incompleteness notice at a full page.
- The same agent can read one job's log from a CI failure with `job logs`,
  using an explicit `repo` + `job_id` and no worktree, receiving either the
  full text, a first-and-last-50 KiB window with an exact omitted-byte count,
  or an error carrying the retained window when the read times out.
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
- No `gh api` in the `gh_read` allowlist (direct, with caller flags), no
  `gh search`, no `gh release`; this scopes the tool's allowlist, not agent
  behavior, so the prompt guidance above still discourages shelling out to
  raw `gh api` through `host_bash`. The `gh run` surface stays limited to the
  read-only `run list`/`run view` pair: `gh run watch`, `gh run rerun`,
  `gh run download`, and `--exit-status` remain excluded. Expand the
  allowlist only on demonstrated need, one design-review cycle per addition.
- No run-level or all-jobs log reads: `/actions/runs/{id}/logs` returns a ZIP
  (verified), so `job logs` is job-scoped only and `run view --log` stays the
  run-level path. No step filtering (there is no per-step log endpoint), no
  jq over log text, no line ranges, and no URL or branch `job_id` selectors.
- No job-metadata operation (`actions/jobs/{id}`) in this change: it is
  recorded in `TODO.md` as its own follow-up, so `job logs` never grows a
  second request for name, status, or conclusion.
- No GraphQL mutations and no caller-supplied GraphQL text: `pr threads`
  sends one fixed tool-authored document with validated variables, and every
  other operation stays on REST. The REST PR operations still provide no
  resolved/outdated thread state, and no jq filter or comment line field can
  manufacture it.
- No URL arguments, no `--template`, no `--web` forms.
- No token handling, masking, or account switching inside the tool. Keeping
  `--show-token` off the `auth status` allowlist is what keeps this non-goal
  true: token values never enter tool output through any allowlisted path.
- Do not bypass the user's guard/sandbox policies: `remote-read` classification
  means guard profiles still decide, per profile, whether network reads are
  allowed at all.
