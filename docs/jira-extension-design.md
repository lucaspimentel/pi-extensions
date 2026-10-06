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

Date: 2026-10-06. Status: core design confirmed via a second grill-me
session; amended after implementation-plan review, not yet implemented.
Resolve the implementation gates below before implementation begins.
Supersedes v1 for transport, tool surface, config, and permissions. The
ambient-context goal remains; its injection mechanism is unresolved.

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
call `mcp__atlassian__*` through `ctx.executeTool()`. The probe did not
establish an event-time transport for session hooks.

`acli` is dropped entirely; there is no fallback transport.

## Components

### 1. Tools

Two tools, named for symmetry so neither reads as the primary one. Both are
registered via `pi.registerTool()` with TypeBox parameter schemas and
per-action validation in code.

**`jira_read`** (`readOnlyHint: true`, `openWorldHint: true`,
`idempotentHint: true`)

- `get` — `getJiraIssue`. The server defaults to `view: "compact"`, not a
guaranteed long field list. Verify the actual payload with a read-only
probe and choose an explicit view if the digest needs fields absent from
compact. Cap the description at 1500 characters with an explicit truncation
marker pointing at the raw escape hatch; handle missing fields and null
bodies. Request markdown but preserve `appliedContentFormat`: the server
can return HTML when markdown would lose rich content. `raw: true` requests
`view: "full"` and `fields: ["*all"]` without local shaping. Read the full
payload from `structuredContent`, which pi does not truncate (`content`
truncates at 20KB); verify that this path retains the complete response.
- `comments` — `listJiraIssueComments` via `executeRead`. Newest-first with
`orderBy: "-created"` and `maxResults: 20`. Expose `startAt` (default 0,
non-negative integer) and return page metadata, including `startAt`,
`maxResults`, and `total`. Preserve returned rich-text format metadata;
the model pages on request.

**`jira_update`** (`readOnlyHint: false`, `openWorldHint: true`)

- `transition` — takes a target **status**. The extension calls
`listJiraIssueTransitions` via `executeRead`, matches the destination status
case-insensitively, and submits an ID only when exactly one transition
matches. No match returns `rejected` listing available destination statuses;
multiple matches return `rejected` with candidate IDs/names for workflow
clarification rather than choosing the first. Transitions requiring fields
outside this action's inputs surface as actionable rejections, not guessed
values. Returns the status the write reports landing in. No alias map or
transition cache.
- `comment` — `addOrEditJiraIssueComment` with a body; new comments default
to markdown and return `commentId`. Rich-text format handling must be
settled under the implementation gates before exposing HTML authoring or
read-modify-write. No ADF construction or temp-file body: these are JSON
arguments, not argv.
- `link_pr` — `createJiraIssueRemoteIssueLink` via `executeWrite`, creating a
native **remote link** in the issue's Web links section rather than a
comment. An explicit URL wins; otherwise run `gh pr view --json url,title`
in the current cwd. Title precedence: optional explicit title, gh title,
then URL. Deduped first: read `listJiraIssueRemoteIssueLinks` via
`executeRead` and string-compare `data[].object.url`; if present, no-op.
A failed or malformed dedupe read prevents creation. Serialize the entire
read-check-create sequence per site/ticket/URL within the extension.
This is best-effort dedupe: other sessions and clients can race, and
transport retries can repeat an uncertain write. Duplicate links are
permanent through the available MCP operations; do not promise exactly-once
creation or add an extension retry loop.
- `edit` — accepts a non-empty `fields` object containing recursively valid
JSON values, including nested objects, arrays, scalars, and null. This
supports raw Jira shapes such as `{"priority":{"id":"2"}}`. Multi-value
fields replace rather than append; explicit null clears supported fields.
The MCP exposes both `fields` and `additional_fields`; name-based resolution
is explicitly documented for `additional_fields`. Verify and pin the
wrapper's routing before promising name/accountId resolution for every
shape. Unknown fields and invalid values surface as server errors.
Rich-text fields also follow the implementation gate below.

Every action: **write response only, no re-fetch** (`transitionJiraIssue`
reports the landed status, `editJiraIssue` returns the issue,
`addOrEditJiraIssueComment` returns the id). One ticket per call: no bulk.

### 2. Branch context injection

Desired payload: one line with key, status, and summary via
`pi.sendMessage()`, `customType: "jira-branch-context"`, `display: true`,
and no triggered turn. Full detail stays behind `jira_read`; silently omit
failed lookups and skip repeated injection for the same branch/cwd within
one session. Reset that suppression when the active session changes.

**Mechanism unresolved:** session handlers receive `ExtensionContext`,
which lacks `executeTool()`. Only tool `execute()` receives
`ExtensionToolContext` with nested tool execution. Also,
`session_info_changed` reports session-name metadata, not git branch or cwd
changes. The earlier claim that these hooks support a fetched Jira digest
and branch-change detection was incorrect.

Before implementation, verify a supported event-time MCP invocation path
and a boundary for rechecking branch/cwd. If none exists, obtain agreement
to narrow the contract to a startup ticket-key pointer enriched after a
Jira tool call. Neither alternative is selected yet; avoid retained stale
tool contexts or a hidden agent turn as a workaround.

### 3. Transport

- Atlassian remote MCP v2 (`https://mcp.atlassian.com/v2/mcp`), signed in
through pi's MCP OAuth. Inside its tool `execute()` handlers, the extension
calls `ctx.executeTool("mcp__atlassian__<tool>", args)`. This does not supply
a transport for session hooks.
- `cloudId` comes from config as the site URL, which the v2 schemas accept
directly (`datadoghq.atlassian.net`); no `getAccessibleAtlassianResources`
round trip.
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
- Timeouts and retries are pi's MCP layer's, not ours: 60s per request
(configurable per server in `mcp.json`, left at the default) and two
automatic retries on 408/429/5xx. The tool call's abort signal propagates to
the nested call, so no subprocess supervision is needed.

### 4. Config

- Single file: `<agentDir>/update-jira.json` (normally
`~/.pi/agent/update-jira.json`).
- Fields: `siteUrl`, `branchKeyRegex`, `branchMappings` (exact branch name to
key). Missing `siteUrl` produces `config_invalid`. Validate the regex and
mapping values before remote calls. `defaultProject` and `statusAliases`
are gone: nothing consumes them now that `create` is out and transitions
resolve from the server.
- Defaults live in memory. The file is **not** created on first run; it is
written only when something needs saving. Malformed JSON produces a visible
warning and the defaults are used, because silently ignoring a broken config
silently changes which ticket gets written.

### 5. Permissions

v1's section is void. Ignore `pi-tool-permissions` entirely. At design time,
`guard` (its designated successor) was observe-only, so Jira writes had
**no enforced gate**. Enforcement belongs to the external guard, not this
extension. Both tools declare the annotations above so guard can classify
remote reads and writes instead of guessing from the name. No in-extension
confirm layer or permission rules are added. Authorization for manual write
verification is a separate prerequisite under Verification.

## Target resolution

Unchanged from v1, re-verified as the right shape:

- Resolved **per call**, not cached at session start, so a mid-session branch
switch or worktree change is honored. pi exposes no git branch in extension
events, so the extension shells out for it in the current cwd.
- `ticketKey` overrides and may name **any** ticket the user can reach.
It is trimmed, uppercased, and validated against `^[A-Z][A-Z0-9]+-\d+$`
before any remote call (`invalid_key` otherwise).
- Otherwise: branch detection via `branchKeyRegex`, then exact
`branchMappings`. Nothing detected → error naming the missing input; multiple
candidate keys → `ambiguous_key` listing them. Never guess.
- One ticket per call; a key argument is a single string, not a list.

## Failure behavior

- `error: <kind>: <message>` in the content, with `isError: true`. The
server's own message and statusCode are appended verbatim; the raw payload
rides along in `details` for the UI. The model distinguishes kinds, not
shapes, because pi only exposes a boolean.
- Kinds: `not_authenticated`, `tool_unavailable`, `invalid_input`,
`not_found`, `rejected` (the server refused the operation, e.g. no matching
transition), plus ticket resolution's `no_ticket`, `invalid_key`,
`ambiguous_key`, and `config_invalid`.
- Auth problems are reported lazily from the failure text with sign-in
guidance, not by a preflight check in every session.
- No retry loops of our own beyond pi's MCP-layer retries. Preserve
cancellation rather than relabeling it as authentication failure; timeout,
malformed-response, and unexpected transport failures must have explicit
fallback handling without pretending a write did not land.

## Verification

1. **Read-only discovery:** recheck live schemas and record transitions,
comments, remote links, and issue views. Scrub ticket content and personal
data from committed fixtures. Write-operation discovery inspects schemas
only; obtaining a sample write response waits for authorized smoke testing.
2. **Offline tests:** use an injectable stub transport and Node's built-in
test runner, with no network or Jira writes. Cover all six actions,
config/key/branch validation, missing fields and null descriptions,
truncation and format metadata, comment pagination, zero/one/multiple
transition matches, required-field rejections, nested edit values, link
no-op and read failures, concurrent dedupe, missing tools, every error
kind, malformed/non-JSON responses, and cancellation. Include registration
and lifecycle tests for the injection mechanism once chosen.
3. **Repository checks:** run `npx tsc --noEmit`, `npm run test:jira`, and the
full existing test suite. Report pass/fail counts and distinguish existing
unrelated failures from regressions.
4. **Authorized manual writes:** obtain a user-designated scratch ticket
and approval for the specific mutation scope before any live write,
including transport probes. Agree on the transition path, comment text,
permanent remote-link URL/title, and edit fields. Verify a permitted return
transition before leaving the original status; do not assume workflows are
reversible. Exercise comment, edit, transition-and-return, link creation,
and duplicate-link no-op. Restore approved editable values where possible;
acknowledge comments and links that will remain. No automated test writes
to Jira and no unrelated ticket mutations.
5. **Smoke results:** confirm the created link appears as
`data[].object.url`, verify returned write status/IDs, and test fresh-session
context plus branch/cwd changes against the agreed injection contract.
Manual verification reads do not introduce a post-write re-fetch into the
production tools. Record observed payload shapes and unresolved assumptions.

## Implementation scope and handoff

- Implement both tools, all six actions, config, branch resolution, and the
agreed injection mechanism in one pass after the gates below are resolved.
- Use existing TypeScript/TypeBox conventions, no new npm dependencies.
Pure modules avoid pi-runtime value imports; tool factories accept an
injectable `Transport` for offline tests.
- Package `extensions/update-jira/` with `index.ts`, `config.ts`, `branch.ts`,
`mcp.ts`, `digest.ts`, `read-tool.ts`, and `update-tool.ts`; register
`"./extensions/update-jira"` in `package.json`'s `pi.extensions` array.
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
- `assign`, and any action beyond `edit`'s free-form fields object.

## Facts this design rests on (verified 2026-10-06)

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
- pi MCP behavior: per-request `timeout` defaults to 60s and is configurable
per server in `mcp.json`; HTTP 408/429/5xx are retried twice; a dropped
connection reconnects on the next call.
- The atlassian server's `cloudId` is required on essentially every operation
and is never remembered: the tool descriptions say to fetch it once per
session and pass it explicitly each call. A site URL is accepted in its
place, which is why config stores `siteUrl`.

## Implementation gates (unresolved)

- **Injection:** establish and verify a supported event-time invocation and
branch/cwd refresh mechanism, or obtain agreement to the narrower
startup-pointer/enrichment contract under Branch context injection.
- **Rich text:** choose a loss-preserving write contract: expose
`contentFormat` for HTML where supported, or explicitly reject unsupported
rich-content edits. Preserve the read format metadata either way and verify
feature availability before any authorized rich-content round-trip.
- **Read/edit payloads:** use read-only probes to pin the digest view and
raw response shape; verify the `fields` versus `additional_fields` routing
contract without a write. Defer any behavior that cannot be established
from schemas/reads to an approved scratch-ticket smoke test.

Resolve and record these choices before marking v2 implementation-ready.
Remote-link creation response shape remains a smoke-test check, not an
excuse for an earlier live write.
