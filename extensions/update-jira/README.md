# update-jira

Validated Jira tools for pi, backed by the Atlassian remote MCP v2 server
(`https://mcp.atlassian.com/v2/mcp`, signed in through pi's MCP OAuth). Two
model-facing tools plus a local run-boundary ticket pointer. Design:
[`docs/jira-extension-design.md`](../../docs/jira-extension-design.md) (v2).

## Prerequisites

1. The `atlassian` MCP server must be configured and signed in (`pi mcp list`
   shows `atlassian: connected`; `/mcp login atlassian` signs in). The
   extension adds no other authentication path and never provisions anything.
2. Create `<agentDir>/update-jira.json` manually (normally
   `~/.pi/agent/update-jira.json`). The extension never creates or writes the
   file, and a missing or invalid file fails closed: every tool call and the
   branch pointer report `config_invalid` until it is fixed.

```json
{
	"siteUrl": "https://datadoghq.atlassian.net",
	"branchKeyRegex": "\\b[A-Z][A-Z0-9]+-\\d+\\b",
	"branchMappings": {
		"main": "PROJ-100"
	}
}
```

- `siteUrl` (required): an explicit HTTPS site origin. No credentials, no
  path (other than the origin's trailing slash), no query or fragment. The
  trailing slash is normalized for site identity. There is no implicit
  Datadog site and no fallback.
- `branchKeyRegex` (optional): a case-insensitive pattern scanned for whole
  matches in the branch name (capture groups are ignored). Defaults to
  `\b[A-Z][A-Z0-9]+-\d+\b`. Invalid patterns and patterns that match empty
  input are rejected; a zero-length match while scanning is a configuration
  failure.
- `branchMappings` (optional): exact branch name to ticket key. Consulted
  only when the regex found zero matches. Keys are normalized (trimmed,
  uppercased) and must match `PROJ-123` shape.

The file is re-read at every tool call and run boundary, so fixes apply
without `/reload`. Unknown keys, malformed JSON, and invalid values are
fail-closed errors.

## Tools

### `jira_read` (read-only)

- `action: "get"`: a digest of key, summary, status, assignee, and the
  description capped at 1500 characters (with a truncation marker pointing at
  `raw: true`). `raw: true` instead returns the complete server payload
  (view `full`, fields `["*all"]`) with no local shaping. The server may
  return bodies as HTML when markdown would lose rich content: the applied
  format and any warning are preserved, and a digest is never a safe
  write-back source.
- `action: "comments"`: one page of comments, newest-first (`maxResults: 20`,
  `orderBy: "-created"`), with pagination metadata (`startAt`, `maxResults`,
  `total`, `isLast`). Page by passing `startAt`; nothing is fetched
  automatically.

### `jira_update` (remote writes)

- `transition`: by destination status (matched case-insensitively against the
  issue's current transitions) or explicit `transitionId` (verified against
  the enumeration). Zero or multiple matches are rejected with the
  candidates. Transitions requiring screen fields are rejected with the
  required field names rather than guessed values. Reports the landed status
  the write returned.
- `comment`: add-only. `contentFormat` defaults to markdown; HTML requires
  the site's HTML feature and a rejection is never retried as markdown.
  Existing-comment edits, visibility, JSM modes, and attachments are outside
  this wrapper.
- `link_pr`: creates a native remote link in the issue's Web links section
  (not a comment). `url` defaults to `gh pr view --json url,title` in the
  working directory. The URL is stored exactly as supplied and is never
  fetched or verified as a PR. Dedupe is best-effort: an exact URL match
  returns an explicit no-op, but other sessions and clients can race, MCP
  recovery can replay a request, and duplicates are permanent (no available
  operation removes a remote link).
- `edit`: forwards `fields` unchanged as raw Jira field keys/IDs (never
  `additional_fields`, no local name resolution). Multi-value fields replace
  rather than append; `null` clears. `description`/`environment` must be
  complete string bodies with an explicit `contentFormat` matching the format
  the server returned on read (HTML bodies must be written back as HTML);
  raw ADF objects are rejected. There is no pre-read, merge, or conversion:
  omitted content is not preserved, and the response may not echo every
  edited field.

Mutations for the same site/ticket are serialized inside this extension
(including their enumeration/dedupe reads); writes from other sessions and
clients are not ordered. Every write reports its response only: no
re-fetch, no retry, no automatic verification read. If a write's outcome is
uncertain (timeout, cancellation, malformed or ambiguous response), the
result is `write_outcome_unknown` and must be verified with a separate read
before any retry.

### Ticket target

`ticketKey` overrides branch detection (it may name any ticket the user can
reach; it is trimmed, uppercased, and validated). Otherwise the current git
branch (in the call's working directory) is scanned with `branchKeyRegex`;
distinct multiple keys are `ambiguous_key`; zero matches fall back to exact
`branchMappings`. Nothing detected is `no_ticket`. The target is resolved
per call, so a branch switch mid-session is honored.

### Branch pointer

At each run boundary (`before_agent_start`) the extension emits a one-line
custom message naming the ticket key resolved from the current branch and
directing the model to `jira_read`. It makes no MCP call and triggers no
extra turn. Changes are emitted, including A -> B -> A; an initially
unresolved branch emits nothing; after a pointer, a changed unresolved state
or broken configuration emits a visible correction. Suppression resets on
`session_start` and `/tree` (state is reconstructed from the active
transcript branch). Explicit `ticketKey` arguments never touch the pointer.

## Results

Both tools declare an `outputSchema` and return a matching
`structuredContent` envelope (`tool`, `action`, `site`, `ticket`, `ok`,
`data` or structured `error`, optional `spillPath`), so codemode callers get
complete data. Original MCP response/error evidence is kept in the
structured output and `details`.

The complete model-facing text is capped at 16 KiB UTF-8 for every result.
Oversized results spill the complete envelope as JSON into a private
session-local directory under the OS temporary location (owner-only
permissions on POSIX, 0700/0600) and return bounded text identifying the
action, target, and spill path. Spill directories are cleaned best-effort on
`session_shutdown`. Two limitations: a crash can leave spill files containing
sensitive ticket data behind, and old transcript references to spill paths
disappear after cleanup. A spill failure never converts a confirmed applied
mutation into a mutation failure; the complete data stays in the structured
result.

## Permissions

The tools declare MCP-style annotations (`jira_read` is read-only,
idempotent, open-world; `jira_update` is a remote write). Enforcement belongs
to external guard machinery; this extension adds no confirmation layer and
ignores pi-tool-permissions.

## Error kinds

`not_authenticated` (with sign-in guidance, reported lazily), `tool_unavailable`,
`invalid_input`, `not_found`, `rejected` (server refused, e.g. no matching
transition), `no_ticket`, `invalid_key`, `ambiguous_key`, `config_invalid`,
`permission_denied` (a known pre-dispatch block), `subprocess_failed`,
`transport_error`, `invalid_response`, `cancelled`, and
`write_outcome_unknown`. Pre-dispatch failures mean nothing was submitted;
post-dispatch uncertainty is never relabelled as a server rejection or
authentication failure, and cancellation after a definitive success leaves
the success intact.

## Verification status

Offline behavior (configuration, resolution, queues, envelope/budget/spill
handling, transport argument routing, pointer lifecycle) is covered by
`npm run test:jira` against scrubbed fixtures recorded from read-only probes
(`tests/fixtures/update-jira/`). Live write responses (transition, comment,
edit, remote-link creation), HTML full-body round-trips, and the link no-op
against a live ticket remain pending separately authorized smoke tests on a
user-designated scratch ticket.
