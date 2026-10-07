# update-jira fixtures

Scrubbed response shapes recorded from read-only probes against the live
Atlassian MCP v2 server (2026-10-07), authorized tickets only. Every fixture
preserves the observed structure and format metadata; ticket prose, customer
content, identities, account IDs, emails, attachment links, and sensitive
custom-field values are replaced with placeholders.

These are parser fixtures, not byte-exact captures. No write-response fixture
exists: write shapes were inspected from schemas only and remain unverified
until authorized smoke testing.

- `issue-digest.json`: getJiraIssue, view "full", explicit
  summary/status/assignee/description fields, markdown requested.
- `issue-raw.json`: getJiraIssue, view "full", fields ["*all"]; the server
  overrode markdown with HTML and attached a warning (trimmed to a few
  representative fields, structure preserved).
- `comments-page.json`: listJiraIssueComments page (startAt 0, maxResults 20,
  orderBy "-created"), HTML applied with the override warning.
- `comments-page-offset.json`: same operation at startAt 10 (last partial page).
- `transitions.json`: listJiraIssueTransitions with expand "transitions.fields",
  including two transitions that share a destination status and one that
  requires a screen field.
- `remote-links.json`: listJiraIssueRemoteIssueLinks with one existing link.
- `remote-links-empty.json`: same operation with no links.
- `error-not-found.json`: the server error envelope observed for an unknown
  issue key (observed verbatim shape, scrubbed key).
- `nested-envelope.json`: the pi nested-outcome shape verified through a
  read-only ctx.executeTool probe (structure only, no ticket data).
