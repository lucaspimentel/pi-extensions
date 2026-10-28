# session-search

Search past pi sessions by keyword, across all projects.

## Why

Recall of past work is by content ("that session where we built the fake-intake
sampler"), not by project or date — and pi sessions live in one global tree
(`~/.pi/agent/sessions/`) that is painful to grep by hand (205MB of JSONL,
branch dupes, tool-result noise).

## Surfaces

- **Tool `session_search`** (model-facing): ranked hits with session path,
  date, project cwd, name, and snippets labeled by origin (user message /
  assistant text / summary).
- **Tool `session_excerpt`** (model-facing): the transcript excerpt around a
  hit, so the agent never has to parse session JSONL. Session files open with
  metadata and a ~90KB `role:"system"` message holding the full system prompt
  and every tool schema, and their `toolResult` lines can reach hundreds of KB,
  against the `read` tool's 50KB output cap: a raw read returns the header and
  never reaches the conversation. See "Excerpts" below.
- **Command `/session-search <query>`**: same search interactively; with a UI,
  arrow-select a session to preview its full card (all snippets, name, dates,
  path), then **Resume session**, **Copy path**, **Load context into
  session**, or go back to the list. Without a UI (RPC/print modes), it prints the tool-style rendering
  instead.
- **Resume session**: switches the running pi process to the selected session via
  `ctx.switchSession` (the same flow as `/resume`): full history, no excerpt,
  no model turn. Offered for non-subagent hits only; cancel or error falls back
  to the list. After a successful switch the previous session stays resumable
  via `/resume`, and the resumed session becomes the one excluded from search.
- **Load context into session**: extracts a transcript excerpt and injects it
  into the current session as a `session-search-context` message, triggering a
  model turn so the agent picks up the context immediately. Runs the same
  excerpt flow as the `session_excerpt` tool (see "Excerpts"), anchored on the
  query that produced the hit. Note: the injected message is itself a
  custom_message, so future refreshes index it as a summary of the session that
  loaded it.
- **`/session-search rebuild`**: force a full re-parse (normally refresh is
  lazy and incremental).
- **`/session-search help`**: usage.

## Excerpts

The `session_excerpt` tool (and the TUI action above) reads exactly one session
file and returns a bounded excerpt:

- **Anchor**: with a `query`, the file is parsed and the query is re-matched
  inside that single session; the matched entries' timestamps anchor the window
  (symmetric ±5 messages around the first match, widened to cover the rest).
  Without a query, or when the query matches nothing in that session, the
  excerpt is the **tail**: the last 10 indexable entries, labeled as a tail (or
  as a missed query) in both the header text and the envelope.
- **Content**: user and assistant text plus summaries (compaction and
  custom messages), rendered as `[HH:MM:SS] role: text`. Tool results, system
  messages, tool-call-only messages, and blocklisted injected boilerplate are
  excluded.
- **Caps** (fixed, no parameters): 2KB per message and 16KB total, enforced by
  UTF-8 byte length; when the budget is tight, entries farthest from the anchor
  are dropped, but anchor entries and the window center always survive.
- **Path validation**: the path must resolve inside the sessions directory,
  must be an existing regular `*.jsonl` file, and must carry a `session` header.
  Canonical (symlink-resolved) containment is checked too, so a symlink inside
  the tree cannot escape it; a symlinked sessions root itself is fine. Reading
  the currently active session's own file is allowed and flagged `selfSession`.
- **Result**: the rendered text plus one flat envelope as both
  `structuredContent` and `details.result`:
  `{ ok, path, sessionId, name?, cwd, started, selfSession, anchored, messageCount,
  truncated, body, error? }`. `anchored` is `{ ts }`, `{ tail: true }`, or
  `{ queryMissed: true }` and is only meaningful when `ok` is true.
- **Failures** are results, never throws: `isError: true` with
  `error.kind` in `outside_sessions` (outside the tree, including symlink
  escapes), `unreadable` (missing, not a regular file, read error), or
  `not_a_session` (not `*.jsonl`, or no session header). A cancelled call
  reports `cancelled`. A valid session with nothing indexable is a *success*
  with `messageCount: 0` and an empty body.

## Query syntax

- Plain terms are whitespace-split and ANDed (every term must match somewhere
  in the session), case-insensitive substring: `fake-intake sampler 1385`.
- A query starting with `/` is a regex: `/error.?sampler`.
- Tool-only filters: `cwd` (substring), `since`/`until` (ISO dates on last
  activity), `in` (`user` | `assistant` | `summary`), `limit` (default 10).
- The active session (the one doing the searching) is always excluded from
  results, in both the tool and `/session-search`.

## Ranking

Tiers by match origin: **user (300) > assistant (200) > summary (100)**;
subagent sessions are halved within their tier; then total hit count and
recency (<=7d +50, <=30d +25, <=365d +10). Up to 4 snippets are kept per hit,
clipped to +-60 characters and labeled with origin: the tool output shows the
first 2, the `/session-search` preview card shows all. Summaries include
their source: `compaction`, `idle-summary`, etc.

## Index

The sessions directory follows pi's own resolution, shared by the search and the
excerpt tool: an explicit home argument, else `PI_CODING_AGENT_DIR` +
`/sessions` when that variable is set, else `~/.pi/agent/sessions` (pi's
`join(getAgentDir(), "sessions")`).

The index lives at `~/.pi/agent/session-search-index.jsonl`, one line per
session (override with `SESSION_SEARCH_INDEX_FILE`); it deliberately does not
move with `PI_CODING_AGENT_DIR`. Refresh happens lazily on every use: stat all
session files (~ms for ~700 files), re-parse only files whose `(mtime, size)`
changed, prune deleted ones, and persist only when something changed. The
first-ever search blocks for the one-time full parse (~1-2s for 205MB);
afterwards queries run in tens of milliseconds.

Indexed content per session:

- `session` metadata: id, cwd, started, parentSession; `session_info` name
- user and assistant message text (string content or `text` blocks),
  head-capped at 8KB per entry
- `compaction.summary` and `custom_message` content, tagged as summaries
- identical user text replayed on multiple branches is kept once with a
  `branches` count
- subagent sessions (`session_info` name like `general-purpose#4d4119cf`) are
  indexed but ranked lower

Excluded: `toolResult`, tool-call-only assistant messages, `model_change` /
`usage` / other bookkeeping, and known system-injected boilerplate (messages
starting with `<skill`, `<system`, `<extension`, ... — see the data-driven
`BLOCKLIST_PREFIXES` in `parse.ts`). Pastes that merely start with `<` are kept.

## Files

- `parse.ts` - pure parser: session JSONL -> `SessionSummary` (no pi imports)
- `search.ts` - query parsing, AND/regex matching, ranking, snippets
- `store.ts` - index load/save + incremental refresh, sessions-directory
  resolution
- `context.ts` - pure window selection: anchored windows and tails, with the
  caps, used by both the tool and the TUI action
- `excerpt.ts` - single-file orchestration: path validation, read, envelope and
  tool-result construction
- `schema.ts` - the flat excerpt output schema (typebox) and result types
- `index.ts` - extension factory: registers both tools and `/session-search`

## Tests

```
node tests/session-search.test.mts
```
