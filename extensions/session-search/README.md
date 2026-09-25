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
  assistant text / summary). The agent can then read the hit's session file
  directly for the full transcript (JSONL, one JSON object per line).
- **Command `/find-sessions <query>`**: same search interactively; with a UI,
  arrow-select a session to preview its full card (all snippets, name, dates,
  path), then **Copy path**, **Load context into session**, or go back to the
  list. Without a UI (RPC/print modes), it prints the tool-style rendering
  instead.
- **Load context into session**: extracts a transcript excerpt (±5 user/assistant
  messages around the matched entry, plus summaries; per-message cap 2KB, total
  cap 16KB; tool results excluded) and injects it into the current session as a
  `session-search-context` message, triggering a model turn so the agent picks
  up the context immediately. Note: the injected message is itself a
  custom_message, so future refreshes index it as a summary of the session that
  loaded it.
- **`/find-sessions rebuild`**: force a full re-parse (normally refresh is
  lazy and incremental).
- **`/find-sessions help`**: usage.

## Query syntax

- Plain terms are whitespace-split and ANDed (every term must match somewhere
  in the session), case-insensitive substring: `fake-intake sampler 1385`.
- A query starting with `/` is a regex: `/error.?sampler`.
- Tool-only filters: `cwd` (substring), `since`/`until` (ISO dates on last
  activity), `in` (`user` | `assistant` | `summary`), `limit` (default 10).

## Ranking

Tiers by match origin: **user (300) > assistant (200) > summary (100)**;
subagent sessions are halved within their tier; then total hit count and
recency (<=7d +50, <=30d +25, <=365d +10). Up to 4 snippets are kept per hit,
clipped to +-60 characters and labeled with origin: the tool output shows the
first 2, the `/find-sessions` preview card shows all. Summaries include
their source: `compaction`, `idle-summary`, etc.

## Index

`~/.pi/agent/session-search-index.jsonl`, one line per session (override with
`SESSION_SEARCH_INDEX_FILE`). Refresh happens lazily on every use: stat all
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
- `store.ts` - index load/save + incremental refresh
- `context.ts` - windowed transcript extraction for "Load context into session"
- `index.ts` - extension factory: registers the tool and `/find-sessions`

## Tests

```
node tests/session-search.test.mts
```
