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

Date: 2026-10-06. Status: design confirmed via a second grill-me session;
not yet implemented. Supersedes v1 for transport, tool surface, config, and
permissions. The goal, the branch-context injection, and the deferred list
are unchanged in spirit.

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
- **Verified viable before committing:** an extension can call
`mcp__atlassian__*` tools through `ctx.executeTool()`.

`acli` is dropped entirely; there is no fallback transport.

## Components

### 1. Tools

Two tools, named for symmetry so neither reads as the primary one. Both are
registered via `pi.registerTool()` with TypeBox parameter schemas and
per-action validation in code.

**`jira_read`** (`readOnlyHint: true`, `openWorldHint: true`,
`idempotentHint: true`)

- `get` — `getJiraIssue`. Returns the server's default field set (summary,
description, status, issuetype, priority, labels, components, assignee,
reporter, created, updated, resolution, project) with the description in
markdown, capped at ~1500 characters with an explicit truncation marker
pointing at the raw escape hatch. `raw: true` requests `fields: ["*all"]` and
is read from `structuredContent`, which pi does not truncate (`content`
truncates at 20KB).
- `comments` — `listJiraIssueComments` via `executeRead`. Returns the first
page plus `total`; the model pages on request.

**`jira_update`** (`readOnlyHint: false`, `openWorldHint: true`)

- `transition` — takes a target **status**. The extension calls
`listJiraIssueTransitions` via `executeRead`, matches the status a transition
leads to (case-insensitive), and passes that transition's id. No match
returns `rejected` listing the statuses actually available. Returns the
status the write reports landing in. No alias map, no caching in v1.
- `comment` — `addOrEditJiraIssueComment` with a markdown body. Returns the
`commentId`. No ADF construction, no temp-file body: these are JSON
arguments, not argv.
- `link_pr` — `createJiraIssueRemoteIssueLink` via `executeWrite`, creating a
native **remote link** in the issue's Web links section rather than a
comment. `title` comes from `gh pr view --json url,title` when the gh
fallback runs, otherwise it is the URL. Deduped first: read
`listJiraIssueRemoteIssueLinks` via `executeRead` and string-compare
`data[].object.url`; if present, no-op. When the dedupe read itself fails,
the call errors rather than risking a duplicate, because duplicates are
permanent.
- `edit` — `editJiraIssue` with a `fields` object, shape-validated only
(non-empty; scalar, array, or null values). The server resolves
human-readable names and accountIds; `null` clears a field. Unknown field
names surface as server errors rather than silently creating anything.

Every action: **write response only, no re-fetch** (`transitionJiraIssue`
reports the landed status, `editJiraIssue` returns the issue,
`addOrEditJiraIssueComment` returns the id). One ticket per call: no bulk.

### 2. Branch context injection

Unchanged in mechanism from v1: hooked on `session_start` and
`session_info_changed`, branch detected from the branch name with a
configurable regex plus explicit `branchMappings`. The payload narrows to
one line — key, status, summary — via `pi.sendMessage()` with a `customType`
and `display: true` (a transcript note that does not trigger a turn). Silent
no-op when nothing is detected. Full detail stays behind `jira_read`.

### 3. Transport

- Atlassian remote MCP v2 (`https://mcp.atlassian.com/v2/mcp`), signed in
through pi's MCP OAuth. The extension calls its tools with
`ctx.executeTool("mcp__atlassian__<tool>", args)`.
- `cloudId` comes from config as the site URL, which the v2 schemas accept
directly (`datadoghq.atlassian.net`); no `getAccessibleAtlassianResources`
round trip.
- Nested calls run through the same `tool_call`/`tool_result` hooks with
`parentToolCallId` set, get the id `<parentId>/<n>`, and never enter the
transcript: the wrapper is responsible for surfacing everything the model
needs in its own result and `details`.
- Failures never throw. They arrive as results with `isError: true` and the
server's own text, e.g.
`{"error":true,"message":"Issue \"SLES-1\" not found","statusCode":404}`.
- Timeouts and retries are pi's MCP layer's, not ours: 60s per request
(configurable per server in `mcp.json`, left at the default) and two
automatic retries on 408/429/5xx. The tool call's abort signal propagates to
the nested call, so no subprocess supervision is needed.

### 4. Config

- Single file: `~/.pi/agent/update-jira.json`.
- Fields: `siteUrl`, `branchKeyRegex`, `branchMappings` (exact branch name to
key). `defaultProject` and `statusAliases` are gone: nothing consumes them
now that `create` is out and transitions resolve from the server.
- Defaults live in memory. The file is **not** created on first run; it is
written only when something needs saving. Malformed JSON produces a visible
warning and the defaults are used, because silently ignoring a broken config
silently changes which ticket gets written.

### 5. Permissions

v1's section is void. It assumed `pi-tool-permissions`, which is being
removed, and `guard` (its designated successor) is observe-only today. So v1
has **no enforced gate**: `jira_update` writes go through unless and until
guard enforces. Both tools declare the annotations above so guard's ladder
classifies them (read-only → remote read, otherwise remote write) instead of
guessing from the name. No in-extension confirm layer is added.

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
- No retry loops of our own beyond pi's MCP-layer retries.

## Verification

- Unit tests under `tests/`, using a stub transport (recorded MCP payloads,
no network), covering branch resolution, key validation, digest capping,
transition matching, link dedupe, and every error kind.
- A manual smoke test against a scratch ticket. No test writes to Jira.
- The first smoke test must confirm that a
`createJiraIssueRemoteIssueLink`-created link surfaces with the PR URL as
`data[].object.url`, since dedupe string-compares exactly that (see Open
items).

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
- `transitionJiraIssue`: "Take transitionId from listJiraIssueTransitions;
transitionName is the transition's own name, not the target status. Returns
the status the issue actually landed in, so no read-back is needed." The
schema accepts only the id, so resolution has to go through
`listJiraIssueTransitions`, whose description adds: "when the user names a
target status, match the status a transition leads to, not the transition's
name."
- `getJiraIssue`: default fields as listed above; reports how many comments an
issue has but not the comments themselves; `view` is
`compact | evidence | full`; `responseContentFormat` is `markdown | adf`.
- `editJiraIssue`: resolves field names and accountIds server-side, `null`
clears a field, multi-value fields are set (not appended), and the response
is `getJiraIssue`'s default field set.
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
(`agent-session.js:1136-1145`). Verified empirically with a throwaway
extension: name spelling `mcp__atlassian__<tool>`, nested ids
`<parentId>/<n>`, hooks fire with `parentToolCallId`, no transcript entry
(the parent result carries a bounded `nestedCalls` record), and
`structuredContent` holds the untruncated `CallToolResult` while `content`
truncates text at 20KB.
- pi MCP behavior: per-request `timeout` defaults to 60s and is configurable
per server in `mcp.json`; HTTP 408/429/5xx are retried twice; a dropped
connection reconnects on the next call.
- The atlassian server's `cloudId` is required on essentially every operation
and is never remembered: the tool descriptions say to fetch it once per
session and pass it explicitly each call. A site URL is accepted in its
place, which is why config stores `siteUrl`.

## Open items (small, decided at implementation time)

- `comments` ordering and page size: default to the server's order with a
sane limit, and expose only what the model actually needs to page.
- Injection `customType` string and whether it gets a custom renderer beyond
`display: true`.
- Whether `jira_read`'s description cap should ever become configurable (a
constant is assumed for v1).
- Extension packaging: `extensions/update-jira/` with config, branch, MCP, and
digest modules plus the two tool files, registered in `package.json`'s
`pi.extensions` array; tests as `tests/update-jira-*.test.mts`.
