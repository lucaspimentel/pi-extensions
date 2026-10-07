# Jira extension design (v1)

Date: 2026-10-02. Status: design confirmed via grill-me session; not yet implemented.

> Superseded in part by the v2 section below (transport, tool surface,
> config, permissions). v1 is kept as the historical record: several of its
> choices exist only to work around `acli` gaps that MCP v2 does not have.

## Goal

An ambient, mechanical layer for Jira work in pi: the model gets a validated
tool for ticket updates, and sessions about a ticket start already aware of it.
Judgment-heavy work (drafting epics, triage) is out of scope for v1.

## Components

### 1. `update_jira` tool

- Registered via `pi.registerTool()`.
- One tool with an `action` parameter: `get`, `transition`, `comment`,
  `link_pr`, `create`. Per-action parameter shapes are validated in code.
- Target ticket defaults to the branch's detected ticket; an explicit
  `ticketKey` parameter overrides.
- `link_pr` limitation (verified against acli 1.3.39 on 2026-10-02):
  `acli jira workitem link create` only links work items to work items;
  there is no remote/web link support. v1 implements `link_pr` as a
  progress comment containing the PR URL. Real remote links are deferred
  and would need direct REST or the Atlassian MCP as transport.

### 2. Branch context injection

- Hooked via `pi.on("session_start")` and `pi.on("session_info_changed")`
  (covers branch/cwd changes).
- Detects `KEY-123` anywhere in the branch name (fits the
  `<repo>--<branch>` worktree naming scheme). The pattern is overrideable in
  config, and explicit branch-to-ticket mappings cover branches without a key.
- Injects a compact digest: key, summary, status, assignee, truncated
  description. Silent no-op when nothing is detected.

### 3. Transport

- Spawns `acli` with JSON output flags; reuses acli's OAuth. No second auth
  path (no direct REST token, no MCP HTTP coupling).

### 4. Config

- Single file: `~/.pi/agent/update-jira.json`.
- Fields: `defaultProject`, `branchKeyRegex`, `branchMappings`
  (branch-to-ticket map).
- Created with defaults on first run; hand-editable. Follows the
  pi-tool-permissions.json precedent for extension config files.

### 5. Permissions

- `get` is allow-listed in pi-tool-permissions (read-only).
- `transition`, `comment`, `link_pr`, `create` raise pi's normal ask dialog.
- No silent Jira writes; no separate in-extension confirm layer.

## Failure behavior

- Structured error results: an error kind plus a human-readable message.
  No internal retry loops.
- acli auth failures return guidance to run `acli auth login`.
- Unknown or ambiguous ticket keys return the candidate keys found rather
  than guessing.

## Explicitly deferred

- The `update-jira` skill: still under consideration. The extension is
  designed to stand alone; revisit after real usage. If built, it would own
  judgment work (drafting epics and children, triage) and instruct the model
  to prefer the extension's tool for mechanical updates.
- Commit/PR event hooks (auto progress comments and remote links on commits).
- Ambient UI (status-bar ticket chip, above-editor open-tickets widget,
  transition picker dialogs).

## Facts this design rests on (verified 2026-10-02)

- acli 1.3.39-stable authenticated against Datadog Jira. Flag surfaces for
  every planned action were checked with `--help`:
  `workitem view KEY --json` returns the raw Jira API JSON (summary, status,
  assignee, description under `fields`); `transition` takes
  `--key/--status/--yes/--json`; `comment create` takes `--key/--body/--json`;
  `create` takes `--project/--summary/--type/--description/--parent/--assignee
  (@me supported)/--json`.
- pi extension events used: `session_start`, `session_info_changed`.
  `tool_call` and `UserBashEvent` exist for the deferred hooks.
- Context injection mechanism: `pi.sendMessage()` with a `customType`, as
  used by the session-search and idle-summary extensions; `display: true`
  keeps the injection visible in the transcript without triggering a turn.
- Atlassian remote MCP v2 exists but was rejected as transport: its curated
  toolset couples the extension to an external server's evolve rate.

---

# Jira extension design (v2)

Date: 2026-10-06; amended 2026-10-07 after a further design interview.
Status: contracts confirmed; not yet implemented. Human design choices are
settled; read-only payload verification remains an implementation gate.
Live-write verification has separate authorization gates below.
Supersedes v1 for transport, tool surface, config, permissions, and context
injection. The first implementation uses a local ticket-key pointer, not
an automatically fetched digest.

## Why the transport changed

The doc's own rejection of MCP (curated toolset couples us to an external
server's evolve rate) is real and was accepted anyway, because every
alternative was worse:

- **`acli` forced four workarounds into the v1 design.** It cannot enumerate
transitions (`view --json` returns `transitions: null`), so v1 had to ship a
blind raw `--status` plus a config alias map. It has no remote/web link
support, so `link_pr` became a comment. Descriptions come back as ADF, so the
extension had to flatten them. Comment listing has no timestamps and only
display-name authors. `--fields=-x` does not trim the default set: it expands
to the whole navigable field set (~478KB).
- **MCP v2 has the missing primitives**, listed under Facts: transition
enumeration, a dedicated remote-link read and write, markdown content
formats, comment listing with real pagination and ordering, and typed JSON
with per-tool annotations.
- **The coupling cost is to a first-party hosted server with published
schemas**, rather than to a third-party CLI whose text output and flag
surface the extension parses. v1→v2 already renamed tools and moved
granular operations behind `discover`/`execute*`; `tool_unavailable` is the
designed answer to that, and the granular operations this design depends on
were confirmed present and re-checkable at runtime.
- **Verified viable inside a tool:** an extension's tool `execute()` can
call `mcp__atlassian__*` through `ctx.executeTool()`. Event handlers do not
have this transport; context injection uses local branch detection only.

`acli` is dropped entirely; there is no fallback transport.

## Components

### 1. Tools

Two tools, named for symmetry so neither reads as the primary one. Both are
registered via `pi.registerTool()` with TypeBox parameter schemas and
per-action validation in code.

**`jira_read`** (`readOnlyHint: true`, `openWorldHint: true`,
`idempotentHint: true`)

- `get` — `getJiraIssue`. For the digest, request `view: "full"` with
`fields: ["summary", "status", "assignee", "description"]` explicitly,
rather than relying on compact defaults. Verify the response shape with a
read-only probe before implementing its parser. Return key, summary,
status, assignee, and description; handle missing fields and null bodies.
Cap the digest description at 1500 characters with an explicit truncation
marker pointing at `raw: true`. Request markdown but preserve
`appliedContentFormat` and server warnings: the server can return HTML when
markdown would lose rich content. A digest, especially truncated HTML, is
not a write-back source. `raw: true` requests `view: "full"` and
`fields: ["*all"]`; its data is the complete server payload, with no local
field shaping. Read the untruncated MCP result from nested
`structuredContent`, not the 20KB-truncated nested `content`. The wrapper's
bounded transcript output does not limit its structured data; oversized
results follow Result contract below.
- `comments` — `listJiraIssueComments` via `executeRead`. Newest-first with
`orderBy: "-created"` and `maxResults: 20`. Expose `startAt` (default 0,
non-negative integer) and return page metadata, including `startAt`,
`maxResults`, and `total`. Preserve returned rich-text format metadata;
the model pages on request.

**`jira_update`** (`readOnlyHint: false`, `openWorldHint: true`)

- `transition` — accepts exactly one of target **status** or
`transitionId`, both non-empty strings. The extension calls
`listJiraIssueTransitions` via `executeRead`. For a status, match its
destination case-insensitively and submit an ID only when exactly one
transition matches. No match returns `rejected` listing available
candidates; multiple matches return `rejected` with candidate IDs, names,
and destination statuses. For an explicit ID, verify that it is among the
currently available transitions before submitting it; do not require a
status as well. Transitions requiring fields outside this action's inputs
surface as actionable rejections, not guessed values; transition fields
remain outside the wrapper. Return the status the write reports landing
in. No alias map or transition cache.
- `comment` — add only, using `addOrEditJiraIssueComment` with a non-empty
body and no `commentId`. Expose `contentFormat: "markdown" | "html"`,
defaulting to markdown, and return the created `commentId`. Existing-comment
edits, visibility settings, JSM-specific comment modes, and attachment
operations are outside this wrapper. Preserve format metadata and warnings
from the write response. HTML feature rejection is surfaced, never retried
as markdown. No ADF construction or temp-file input body: these are JSON
arguments, not argv.
- `link_pr` — `createJiraIssueRemoteIssueLink` via `executeWrite`, creating a
native **remote link** in the issue's Web links section rather than a
comment. An explicit URL wins; otherwise run `gh pr view --json url,title`
in the current cwd. Accept syntactically valid HTTPS web URLs without
credentials; the name describes normal use, not verified PR identity.
Do not fetch the URL or restrict its host to github.com. Preserve the
supplied URL string for exact dedupe; do not canonicalize it. Title
precedence: optional explicit non-empty title, gh title, then URL. A failed
or malformed gh result prevents mutation. Deduped first: read
`listJiraIssueRemoteIssueLinks` via `executeRead` and string-compare
`data[].object.url`; if present, return an explicit no-op. A failed or
malformed dedupe read prevents creation. The entire read-check-create
sequence runs inside the per-ticket write queue below.
This is best-effort dedupe: other sessions and clients can race, and MCP
authentication/session-recovery paths can replay requests. Duplicate links
are permanent through the available MCP operations; do not promise
exactly-once creation or add an extension retry loop.
- `edit` — accepts a non-empty `fields` object containing recursively valid
JSON values, including nested objects, arrays, scalars, and null. Forward
it unchanged as MCP `fields`, never `additional_fields`. Support raw Jira
field keys/IDs and shapes such as `{"priority":{"id":"2"}}`; do not promise
human-readable name resolution or coerce names/accountIds locally.
Multi-value fields replace rather than append; explicit null clears
supported fields. Unknown fields and invalid values surface as server
errors. `description` and `environment`, when supplied as bodies, must be
complete strings accompanied by explicit
`contentFormat: "markdown" | "html"`; null clears do not require a body
format. Raw ADF objects for these bodies are not accepted.
For read-modify-write, tool guidance requires a full read of the current
body and preservation of its actual format: HTML-returned bodies must be
written as HTML. The wrapper performs no preflight body read, automatic
conversion, or merge, and cannot guarantee preservation of content the
caller omitted. Custom rich-text fields also require callers to use the
server's supported shape/format; free-form JSON is not a losslessness
guarantee. Surface HTML feature rejection without a markdown downgrade.

Every mutation: **write response only, no re-fetch**
(`transitionJiraIssue` reports the landed status, `editJiraIssue` returns the
issue, `addOrEditJiraIssueComment` returns the id). A successful edit does
not prove that every edited field is echoed in the response. Even an
uncertain write does not trigger an automatic verification read; return
`write_outcome_unknown` with separate-read guidance. One ticket per call:
no bulk.

Resolve and snapshot config, cwd, and target once per call before queueing.
Serialize all mutations by normalized site/ticket within this extension
runtime, including their transition enumeration or link dedupe reads.
Cancellation while queued prevents any remote dispatch; release the queue
on every completion path. Read-only calls remain concurrent. This orders
local writes, not writes from other sessions/clients, and supplies no
optimistic locking or transaction across calls.

### 2. Branch context injection

The first implementation emits a **local ticket-key pointer**, not a
fetched digest. At `before_agent_start`, reread config and detect the branch
using that handler's `ctx.cwd`. Return a custom `message` with
`customType: "jira-branch-context"`, `display: true`, and a one-line pointer
naming the resolved key and directing the model to `jira_read` for details.
It participates in the current user-driven run without triggering another
turn. No MCP call, fetched-summary cache, retained tool context, or
post-tool enrichment is involved.

Track only the last emitted state, including normalized site, cwd, branch,
and resolution outcome, in the message's `details`. Emit on a change,
including A → B → A; do not use a session-wide set that suppresses a
returning target. An initially unresolved target with no prior pointer in
the active transcript emits nothing. After a pointer has been emitted, a
changed unresolved state emits a visible correction saying there is no
resolved default ticket, with the reason (`no_ticket`, `ambiguous_key`,
invalid key, or Git detection failure). An explicit tool target never
changes the ambient branch pointer.

Invalid config blocks all Jira calls and normally suppresses context
injection. Exception: if a pointer was previously emitted, clear it once
with a minimal `config_invalid` correction. A UI warning is not a
substitute for correcting stale model context. Returning to valid config
allows a fresh pointer on the next boundary.

Reset suppression on every `session_start` and successful `session_tree`.
Use `ctx.sessionManager.getBranch()` to reconstruct whether the active
transcript contains a prior Jira pointer/correction, so an unresolved or
broken-config resume can clear a restored pointer instead of treating the
transcript as empty. New/resumed/forked sessions and reload get a fresh
pointer or necessary correction at their next run; tree navigation does
not retain suppression from an abandoned transcript branch. Recheck at
run boundaries, not through a watcher or immediately after arbitrary shell
commands. Tool calls still
resolve the branch independently, honoring changes within a run.

Verified in installed pi 1.0.4: `before_agent_start` supports the returned
visible custom message and `ctx.cwd`, but receives `ExtensionContext`
without `executeTool()`. `session_info_changed` is session-name metadata,
not git branch/cwd notification. These replace v1's hook assumptions.

### 3. Transport

- Atlassian remote MCP v2 (`https://mcp.atlassian.com/v2/mcp`), signed in
through pi's MCP OAuth. Inside its tool `execute()` handlers, the extension
calls `ctx.executeTool("mcp__atlassian__<tool>", args)`. This does not supply
a transport for session hooks.
- `cloudId` comes from config as the site URL, which the v2 schemas accept
directly (`https://datadoghq.atlassian.net`); no
`getAccessibleAtlassianResources` round trip.
- Nested calls run through the same `tool_call`/`tool_result` hooks with
`parentToolCallId` set, get the id `<parentId>/<n>`, and never enter the
transcript: the wrapper is responsible for surfacing everything the model
needs in its own result and `details`.
- Nested tool failures return an outcome with `isError: true`, not a thrown
tool failure. Parse `outcome.result.structuredContent` as the raw MCP
`CallToolResult`, including its JSON text blocks and server error flags;
outer success does not prove the server operation succeeded. Example:
`{"error":true,"message":"Issue \"SLES-1\" not found","statusCode":404}`.
Guard missing blocks, non-JSON content, and malformed payloads; keep raw
failure evidence in `details`. Local parsing and subprocess failures still
need explicit handling.
- MCP timeouts are pi's: 60s per request, configurable per server in
`mcp.json`, left at the default; progress notifications can reset them.
Static inspection of installed pi 1.0.4 distinguishes **connection/setup
retries** from **tool-call retries**. Connection/setup retries twice on
qualifying network/408/429/5xx failures; `tools/call` is not retried for
those failures, even for read-only tools. Authentication challenge and
expired-MCP-session recovery can replay a request, so this is not an
exactly-once guarantee. Add no wrapper retry loop.
- Propagate the tool's abort signal to nested calls, queued work, and local
Git/gh subprocesses. MCP cancellation does not prove an already-dispatched
write was rolled back. Local subprocess failures require handling even
though no subprocess carries the Jira transport.

### 4. Config

- Single file: `<agentDir>/update-jira.json` (normally
`~/.pi/agent/update-jira.json`).
- Fields: `siteUrl`, `branchKeyRegex`, `branchMappings` (exact branch name to
key). Require an explicit HTTPS site origin without credentials; normalize
its trailing slash for site identity. No implicit Datadog site. A missing
file or missing site is `config_invalid`, not an authorization to use a
fallback site. Validate the object shape, regex, and every mapping value
before remote calls. `defaultProject` and `statusAliases` are gone: nothing
consumes them now that `create` is out and transitions resolve from the
server.
- Defaults for optional fields live in memory: `branchKeyRegex` is
`\b[A-Z][A-Z0-9]+-\d+\b` with case-insensitive matching, and
`branchMappings` is empty. A custom regex is a pattern string with the same
case-insensitive, all-matches behavior; capture groups are ignored. Reject
invalid patterns and those matching empty input. Any zero-length match
encountered during scanning is `config_invalid`, not a key or an invitation
to loop.
- Reread config before each tool call and `before_agent_start`, then use
one immutable snapshot for that operation. A fix takes effect without
`/reload`; a change while queued cannot retarget that call. Malformed JSON,
invalid configuration, and read errors fail closed with `config_invalid`,
not default fallback. Warn visibly once per unchanged invalid state; valid
config resets warning suppression. In non-UI modes, tool errors and any
pointer-clearing message still carry the failure.
- The extension never creates or writes the file. There is no config-saving
feature; optional defaults do not imply a persistence side effect.

### 5. Permissions

v1's section is void. Ignore `pi-tool-permissions` entirely. At design time,
`guard` (its designated successor) was observe-only, so Jira writes had
**no enforced gate**. Enforcement belongs to the external guard, not this
extension. Both tools declare the annotations above so guard can classify
remote reads and writes instead of guessing from the name. No in-extension
confirm layer or permission rules are added. Authorization for manual write
verification is a separate prerequisite under Verification.

## Target resolution

Explicit targets override local branch detection; injected context never
supplies an implicit fallback:

- Resolved **per call**, not cached at session start, so a mid-session branch
switch or worktree change is honored. pi exposes no git branch in extension
events, so the extension shells out for it in the current cwd.
- `ticketKey` overrides and may name **any** ticket the user can reach.
It is trimmed, uppercased, and validated against `^[A-Z][A-Z0-9]+-\d+$`
before any remote call (`invalid_key` otherwise).
- Otherwise: scan the current branch with `branchKeyRegex`. Each whole
match is a candidate, normalized and validated by the same rule as an
explicit key. Capture groups are ignored. Deduplicate repeated occurrences
of the same normalized key; distinct multiple keys produce `ambiguous_key`
listing them. Only zero regex matches falls back to exact `branchMappings`;
a mapping does not override an invalid or ambiguous regex result. Normalize
and validate mapping targets by the same key rule. Nothing detected →
`no_ticket` naming the missing input. Never use a historical injected key
as a fallback.
- Detached HEAD/no branch is `no_ticket`; genuine Git execution failures
are `subprocess_failed`, not a successful no-ticket lookup. Explicit
`ticketKey` bypasses Git resolution but not config validation.
- One ticket per call; a key argument is a single string, not a list.

## Result contract

Both tools declare an `outputSchema` and return matching
`structuredContent`, so codemode callers receive complete data rather than
transcript text. The envelope identifies the action and resolved ticket,
contains `data` on success or an `error` with kind/message on failure, and
includes `spillPath` when present. `raw: true` puts the complete server
payload in `data` without field shaping. Keep original MCP response/error
evidence in structured output and `details`; normal read digests retain
their documented shaping. Mutation text distinguishes applied writes from
no-ops and reports only status/IDs/values actually supplied by the server.

Bound model-facing `content` for **every** result, including comments,
write responses, and failure evidence, not only raw reads. Use a fixed
16 KiB UTF-8 budget for the complete text, including its truncation marker
and spill-path guidance. If output would exceed it, save the complete
structured result as JSON in a private session-local temporary directory,
then return bounded text identifying the action/target and file path.
The description's separate 1500-character digest cap remains unchanged.

Use owner-only directory/file permissions where supported (0700/0600 on
POSIX), the OS temporary location rather than the repository, and
best-effort idempotent cleanup on `session_shutdown`. Do not create
resources in the extension factory. Crash leftovers can contain sensitive
ticket data, and old transcript paths may disappear after cleanup; disclose
both limitations. Programmatic full data does not depend on the file.
A spill failure returns bounded text explaining that the file is
unavailable while retaining complete structured data. It must not turn a
confirmed applied write into an error suggesting that the mutation failed.

## Failure behavior

- `error: <kind>: <message>` in the content, with `isError: true`. Include
the server's own message/statusCode verbatim when they fit the text budget;
otherwise use a bounded summary and spill guidance. The complete evidence
remains in structured output and `details`. The model gets a textual kind;
programmatic callers also get the structured error.
- Kinds: `not_authenticated`, `tool_unavailable`, `invalid_input`,
`not_found`, `rejected` (the server refused the operation, e.g. no matching
transition), ticket resolution's `no_ticket`, `invalid_key`,
`ambiguous_key`, and `config_invalid`, plus `permission_denied` (a known
nested guard block), `subprocess_failed`, `transport_error`,
`invalid_response`, `cancelled`, and `write_outcome_unknown`.
Pre-dispatch validation/permission denial means no mutation was submitted;
do not mistake a blocked nested call for a
server rejection or authentication failure.
- Auth problems are reported lazily from the failure text with sign-in
guidance, not by a preflight check in every session.
- No wrapper retry loops. Before a mutation is dispatched, transport/read
failures use their ordinary kinds and cancellation uses `cancelled`.
After dispatch, a timeout, cancellation, missing/malformed response, or
transport failure without definitive success/rejection evidence becomes
`write_outcome_unknown`. Include target/action, the underlying cause, and
guidance to verify with a separate read before considering a retry. Preserve
cancellation as the cause; never relabel it as authentication failure.
Definitive success remains success even if cancellation arrives afterward.
A server error flag is not proof of rollback: preserve any partial-effect
evidence, and treat an ambiguous post-dispatch 5xx/error as unknown rather
than asserting nothing changed. For reads, malformed responses use
`invalid_response`; they have no mutation outcome.

## Verification

1. **Read-only discovery:** recheck live schemas and record transitions,
comments, remote links, and explicit-field/full issue views. Pin the nested
MCP envelope, digest parser, format metadata, and raw completeness. Confirm
that the chosen raw `fields` routing matches the schema; wrapper name
resolution is not part of the contract. Scrub ticket content and personal
data from committed fixtures. Write-operation discovery inspects schemas
only; obtaining a sample write response waits for authorized smoke testing.
2. **Offline tests:** use an injectable stub transport and Node's built-in
test runner, with no network or Jira writes. Cover all six actions,
config/key/branch validation, missing fields and null descriptions,
truncation and format metadata, comment pagination, zero/one/multiple
transition matches, required-field rejections, nested edit values, link
no-op and read failures, concurrent dedupe, missing tools, every error
kind, malformed/non-JSON responses, and cancellation. Also cover explicit
transition IDs; explicit body formats and HTML rejection without downgrade;
verbatim edit routing; whole-match regex extraction and duplicate keys;
config live reload, fail-closed behavior, and snapshot stability; per-ticket
write ordering and queued cancellation; before/after-dispatch uncertainty;
all-result byte limits, full structured output, spill failure after confirmed
writes, and private-file cleanup. Registration/lifecycle tests cover pointer
changes, A → B → A, clearing, initial unresolved no-op, config-failure
clearing, `session_start`, successful `session_tree`, restored-pointer
clearing on unresolved resumes, explicit-target non-interference, and
branch changes within a run. Hooks make no MCP calls.
3. **Repository checks:** run `npx tsc --noEmit`, `npm run test:jira`, and the
full existing test suite. Report pass/fail counts and distinguish existing
unrelated failures from regressions.
4. **Authorized manual writes:** obtain a user-designated scratch ticket
and approval for the specific mutation scope before any live write,
including transport probes. Agree on the transition path, comment text,
permanent remote-link URL/title, and edit fields/formats. Verify a permitted
return transition before leaving the original status; do not assume
workflows are reversible. Exercise comment, edit, transition-and-return (including ID
selection where practical), link creation, and duplicate-link no-op.
An HTML body round-trip requires separate approval for its complete body
and evidence that the site's HTML feature is enabled; schema support alone
is not a verified round-trip. Restore approved editable values where
possible; acknowledge comments and links that will remain. No automated test writes
to Jira and no unrelated ticket mutations.
5. **Smoke results:** confirm the created link appears as
`data[].object.url`, verify returned write status/IDs, and test fresh-session
pointers, clearing, reload/tree reset, and branch/cwd changes against the
run-boundary injection contract.
Manual verification reads do not introduce a post-write re-fetch into the
production tools. Record observed payload shapes and unresolved assumptions.

## Implementation scope and handoff

- Implement both tools, all six actions, config, branch resolution,
run-boundary pointers, the per-ticket write queue, and bounded structured
results after the read-only gate below is resolved. Authorized smoke tests
follow implementation; they are not permission to probe writes earlier.
- Use existing TypeScript/TypeBox conventions, no new npm dependencies.
Pure modules avoid pi-runtime value imports; tool factories accept an
injectable `Transport` for offline tests.
- Package `extensions/update-jira/` with `index.ts`, `config.ts`, `branch.ts`,
`mcp.ts`, `digest.ts`, `context.ts`, `results.ts`, `write-queue.ts`,
`read-tool.ts`, and `update-tool.ts`; register `"./extensions/update-jira"`
in `package.json`'s `pi.extensions` array. Keep context, output, and queue
logic independently testable without retained runtime tool contexts.
- Add `tests/update-jira-unit.test.mts`, `tests/update-jira-tools.test.mts`,
and `test:jira`; update the README extension list and relevant TODO entry.
Keep unrelated guard code/tests and existing TODO/guard-design changes
untouched. Leave implementation uncommitted and unpushed unless requested.
- Description cap is a constant (1500 characters); no custom injection
renderer is required initially.

## Explicitly deferred

- The `update-jira` skill, commit/PR event hooks, and ambient UI, all as in
v1.
- `create` (ticket creation): dropped from v1. It needs `--project` every
call, is judgment-heavy (parents, epics, acceptance criteria), and is better
served by the deferred skill or the MCP tools used directly.
- Bulk operations: acli was the batching transport, and the MCP server has no
batching primitive. One ticket per call is the v1 shape.
- A dedicated `assign` action, name-aware `additional_fields`, transition
fields, existing-comment edits, visibility/JSM-specific controls,
attachments, and any action beyond the specified free-form edit contract.
Raw supported assignee fields may still be submitted through `edit`.
- Automatic fetched branch digests, event-time MCP transport, and post-tool
context enrichment. The pointer is intentionally local and key-only.

## Facts this design rests on (verified 2026-10-06; amendments 2026-10-07)

The original empirical MCP observations below are dated 2026-10-06.
2026-10-07 rechecked the current registry's get/edit/comment schemas and
statically inspected installed pi 1.0.4 lifecycle/retry behavior. No new
live ticket read, write, or rich-content round-trip was performed in that
interview.

- `pi mcp list`: `atlassian` connected, 21 tools, exposure `codemode`, signed
in via `mcp-auth.json`. The curated list is `getAccessibleAtlassianResources`,
`atlassianUserInfo`, `getConfluenceContent`, `createConfluenceContent`,
`updateConfluenceContent`, `searchConfluence`, `getJiraIssue`,
`searchJiraIssuesUsingJql`, `createJiraIssue`, `editJiraIssue`,
`transitionJiraIssue`, `addOrEditJiraIssueComment`, `getLoomVideo`,
`getGraphContext`, `getGraphObject`, `addGraphContext`, `discover`,
`executeRead`, `executeWrite`, `executeDestructive`, `search`. The cached tool
list in `~/.pi/agent/mcp-cache.json` is stale v1-era data (it still shows
`getConfluencePage`, `addCommentToJiraIssue`, `getTransitionsForJiraIssue`);
probe with `tools/list` rather than trusting it.
- `discover` (~316 operations across products) confirmed the granular
operations this design needs, each with full input schemas:
`listJiraIssueTransitions` (`executeRead`), `listJiraIssueComments`
(`executeRead`), `listJiraIssueRemoteIssueLinks` (`executeRead`),
`createJiraIssueRemoteIssueLink` (`executeWrite`, inputs `url`, `title`,
`summary`, `relationship`).
- `transitionJiraIssue`: accepts `transitionId` or `transitionName`. The
name is the transition's own name, not its destination status. The wrapper
resolves a requested status through `listJiraIssueTransitions` and submits
an unambiguous ID. The write reports the status actually landed in; no
production read-back is needed.
- `getJiraIssue`: `view` is `compact | evidence | full`, default compact;
reports comment counts rather than providing a comments page.
`responseContentFormat` is `markdown | html`, not ADF. The live description
says unsupported markdown bodies are returned as HTML automatically, with
`appliedContentFormat` identifying the result. This is a schema guarantee,
not yet a locally observed rich-content round-trip.
- `editJiraIssue`: exposes `fields` and `additional_fields`; explicitly
documents name-based resolution for `additional_fields` and accepts raw
Jira shapes. Null clears supported fields and multi-value fields are set,
not appended. `contentFormat: "html"` preserves rich bodies but requires
the server's HTML-format feature; markdown writes can drop inline media.
The response uses `getJiraIssue`'s default fields, so edited fields may not
be echoed.
- `listJiraIssueRemoteIssueLinks` returns `data[].object.url` (with
`data[].object.title` and an optional `relationship`). It never returns a
`globalId`, and the operation's own text says: "the same URL added twice
becomes two separate links, and no operation removes one" and "Check here
before calling createJiraIssueRemoteIssueLink". **Do not pass
`responseFields` to it**: that returned `{"data":[{},{}]}` on a real issue.
Neither `getGraphContext` (returned 1 of 2 existing Web links on a real
ticket) nor `getGraphObject` nor any `getJiraIssue` view/expand is a usable
dedupe read.
- `ctx.executeTool()` reaches MCP tools: the callable set is
`exposure === "codemode" || "deferred"` plus active `direct` tools
(`agent-session.js:1136-1145`). Verified empirically inside a throwaway
extension's tool `execute()`: name spelling `mcp__atlassian__<tool>`, nested ids
`<parentId>/<n>`, hooks fire with `parentToolCallId`, no transcript entry
(the parent result carries a bounded `nestedCalls` record), and
`structuredContent` holds the untruncated `CallToolResult` while `content`
truncates text at 20KB. The installed pi 1.0.4 declarations distinguish
`ExtensionContext` from `ExtensionToolContext`; only the latter has
`executeTool()`. `SessionInfoChangedEvent` contains session-name metadata,
not git branch/cwd information. These facts invalidate the original
session-hook transport assumption.
- pi MCP behavior, corrected by static inspection on 2026-10-07:
per-request `timeout` defaults to 60s and is configurable per server in
`mcp.json`; progress resets it. In installed pi 1.0.4,
`dist/extensions/mcp/runtime.js:193-239` does not retry tool calls for
transient network/HTTP errors; its expired-session recovery can replay one.
Connection/setup retries twice on network TypeError/408/429/5xx except 501
(`dist/extensions/mcp/runtime.js:275-294`). The HTTP transport can replay
after an authentication challenge. A dropped connection reconnects on the
next call. The broad two-retries wording in `docs/mcp.md:100` concerns
connection behavior, not a guarantee about mutations; its tool-call
qualification at `docs/mcp.md:248` is the relevant distinction.
- pi context/lifecycle behavior, statically verified 2026-10-07:
`dist/core/extensions/types.d.ts:1090-1094` declares a returned custom
message for `before_agent_start`; the runner inserts it into the existing
run (`dist/core/extensions/runner.js:1121-1150`). The context has cwd but no
nested tool execution. `session_start` reasons include startup, reload,
new, resume, and fork (`dist/core/extensions/types.d.ts:554-561`). Successful
tree navigation emits `session_tree` after restoring context
(`dist/core/agent-session.js:3336-3348`), without replacing the extension
runtime; this is why pointer suppression resets there as well.
- The atlassian server's `cloudId` is required on essentially every operation
and is never remembered: the tool descriptions say to fetch it once per
session and pass it explicitly each call. A site URL is accepted in its
place, which is why config stores `siteUrl`.

## Verification gates remaining

The context, rich-text input, edit routing, and failure contracts are
selected above; there is no unresolved choice of event-time transport.

- **Before payload-parser implementation:** use read-only probes to pin the
explicit-field digest and raw response shapes, nested envelope, comment
pagination, transitions, and remote-link dedupe data. Record scrubbed
fixtures and confirm the untruncated structured path. Current schemas
support the chosen `fields` passthrough; any server behavior not provable
from schemas/reads remains a smoke-test check, not a speculative promise.
- **Before any live mutation:** obtain the scratch-ticket and mutation-scope
approval described under Verification, including permanent artifacts and a
permitted return transition. No write probes before that approval.
- **Before claiming rich-content preservation:** verify the site's HTML
feature and perform an approved full-body round-trip. The wrapper requires
explicit format and complete input but does not itself establish lossless
caller edits. A truncated digest is never evidence of a safe write-back.
- **Before declaring implementation verified:** pass offline/repository
checks and authorized smoke tests; record observed write responses,
including remote-link creation. No new write response shapes were observed
in the 2026-10-07 design interview.

These are evidence and authorization gates, not unselected design
alternatives. Leave the extension unimplemented until the read-only
payload gate is satisfied, and unverified until the applicable checks pass.
