# Jira extension design (v1)

Date: 2026-10-02. Status: design confirmed via grill-me session; not yet implemented.

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
