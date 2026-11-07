# compact-tool-view design

Status: design settled; extension, config loader, gist derivation, tests,
`package.json` manifest entries, and TODO rewrite implemented.

## Goal

Replace the collapsed body of a tool result row with a one-line synthesized
summary (a "gist"), or show no body at all, configurable per tool name. Strictly
display-only: the model-facing `content` and `structuredContent`, the call row,
guard policy, and the session file are untouched. The gist is synthesized, not a
truncated preview, so pi's hard-coded per-tool preview caps are irrelevant here.

## Mechanism: one `registerToolRenderer` resolver

The extension makes exactly one `pi.registerToolRenderer(resolver)` call. It
never re-registers a tool with the same name: that replaces the definition and
loses prompt metadata (`Command`/`ToolDefinition` registration), and it would
also drop guard's own shell renderers.

Resolver shape (`dist/core/extensions/types.d.ts:540-545`):

```
(toolName, next) => ToolRenderers | undefined
ToolRenderers = Pick<AnyToolDefinition, "renderShell" | "renderCall" | "renderResult">
```

- `next()` returns the renderers the remaining resolvers (in load order) and the
  registered tool would use. It is called fresh on every invocation, never
  cached across tool rows, so another resolver's state stays live.
- For a name not in the effective table, or marked `stock`, the resolver returns
  `next()` unchanged. That is the same pass-through pi gets from `undefined`, and
  it also propagates `undefined` for a name with no renderer at all.
- Otherwise the resolver returns `{ ...base, renderResult }`. The spread keeps
  `renderShell` and `renderCall`; only `renderResult` is replaced.
- `registerToolRenderer` shipped in pi 1.0.1
  (`CHANGELOG.md:403`, `:412` in the pi install), below this repo's declared
  `^1.3.0` floor in `package.json`, so no minimum-version bump is needed.

Output is a `@earendil-works/pi-tui` `Text`, as the repo's other renderers use.

## Modes

Configured per tool name:

- `gist`: the collapsed body is one gist line (plus extra dimmed lines).
- `hide`: no body; the call row plus a dimmed hint built from
  `context.keyHint("app.tools.expand", "to expand")`.
- `stock`: leave pi's rendering, and remove a name from the defaults.

All default entries are `gist`; nothing hides by default. Presence of a name in
the effective table is the opt-in, even when that tool defines its own renderer.
The shipped defaults deliberately exclude `subagent`, which renders itself.

## Resolver behavior

- Collapsed, final result (`!expanded && !isPartial`): render the gist (or, in
  `hide` mode, the hint).
- Expanded or streaming result: delegate to the base renderer
  (`base.renderResult(...)`) when one exists. The wrap is collapsed-only; the
  gist renders on the final result.
- No base renderer and the view is expanded or partial: a tool with no renderer
  has no stock expanded view to preserve, so render the gist (or hint) anyway.
- Failures (`context.isError`) always surface, ignoring `hide`.
- `hide` mode with a base renderer: collapsed shows the hint, expanded delegates
  to the stock body. This is the general rule from the settled design (expanded
  always delegates to the base renderer when one exists), and it keeps the
  expand hint truthful. Only a hidden tool with no base renderer shows the hint
  in both states. The step-7 live-check note that "`Ctrl+O` expands nothing (no
  stock body exists for hide mode)" is wrong for a tool that has a stock
  renderer such as `read`; the observed behavior is that expanding a hidden tool
  reveals its stock body.

## Gist derivation order

`gistFor(toolName, result, args)` returns element 0 (the primary line) plus any
extra lines, in this order:

1. Failure: `timed out` when `details.killed` or `details.timedOut`, else
   `exit N` when an exit code is available (see below), else
   `error: <first line of the error text>` from the first text block.
2. Typed `details`/`structuredContent` per the default table below. Each typed
   branch is gated on the tool name, so a `bash`-shaped details object on an
   unknown tool falls through to the fallback.
3. Any content blocks beyond the first render verbatim, one dimmed line each.
   This keeps guard's appended warning blocks (`extensions/guard/index.ts`) and
   pi's truncation footers visible in a collapsed row.
4. Fallback: `N lines` from the first text block, or `image` when the result
   carries an image content block.

Content only: durations and elapsed time are never included. Line counts use
`text.split("\n").length` on the first text block.

### What pi forwards to a result renderer (verified against pi 1.5.0)

`ToolExecutionComponent.updateDisplay` calls a result renderer with
`{ content: this.result.content, details: this.result.details }` only
(`dist/modes/interactive/components/tool-execution.js`). `structuredContent` is
not forwarded, and the error flag lives on `ToolRenderContext.isError` (set from
`this.result.isError`), not on the object passed as the result. The plan's
"trigger on `result.isError`" / "`result.structuredContent.exit_code`" is wrong
on both counts against the installed runtime.

The resolver therefore seeds the error flag from `context.isError` before calling
`gistFor`, and the failure gist tries, in order: `details.killed` (`pup_*`) or
`details.timedOut` (`gh_read`), either of which wins because such a process can
still report `exitCode: 0`, then a non-zero `details.exitCode` (forwarded
`details` is the reliable structured source), then `structuredContent.exit_code`
when a caller forwards it anyway, then `/Command exited with code (\d+)/` in the
first text block (which the native shell tools always append on a non-zero
exit), then `error: <first line>`. The same forwarding gap means the `bash` line count comes
from the model-facing first text block rather than the full
`structuredContent.output`; the count is the model-facing output's line count.

## Default effective table

Every entry below is `gist`.

| Tool | Gist |
| --- | --- |
| `read` | `N lines`; `N lines, truncated` when `details.truncation.truncated` (N is `truncation.totalLines` when present); `image` when the result carries an image block |
| `bash`, `host_bash`, `powershell` | `done (N lines)` from the first text block (`structuredContent.output` when a caller forwards it) |
| `edit` | `+A / -R` counting `+`/`-` lines in `details.diff` |
| `grep` | `N matches`; `N+ matches` when `details.matchLimitReached` (N is that limit) |
| `find` | `N files`; `N+ files` when `details.resultLimitReached` |
| `ls` | `N entries`; `N+ entries` when `details.entryLimitReached` |
| `ffgrep` | `N matches in M files` from `details.{totalMatched,totalFiles}` |
| `fffind` | `N files` from `details.totalMatched` |
| `python`, `node` | the worker status from `details.status` (`ok`, `runtime_error`, ...) |
| `git_read`, `web_fetch`, `web_search`, `session_search`, `session_excerpt`, `jira_read`, `jira_update`, `subagent_list`, `request_read_access` | generic `N lines` |
| `gh_read` | `timed out` from `details.timedOut`; `exit N` from a non-zero `details.exitCode`; otherwise generic `N lines` on success. Its `gh` argv and log runners set `isError: true` on every failure and report both fields in `details` (its API path keeps its own `isError` handling, whose failures render through the shared `error: <first line>` path), and a successful read has no count noun because its payloads are heterogeneous |
| `write` | `N lines written` from `context.args.content` (see the assumption below) |
| `subagent` | not in the defaults (it renders itself) |

### `pi-memory` tools (typed lines, not in the defaults)

`pi-memory` registers `memory_write`, `scratchpad`, `memory_read`,
`memory_forget`, `memory_restore`, `memory_search`, and `memory_status`. None is
a default, so each needs its name in the config; their typed lines (shapes
verified against pi-memory 0.4.2) are:

| Tool | Gist |
| --- | --- |
| `memory_write` | `MEMORY.md appended`, `MEMORY.md overwritten`, or `daily log appended` from `details.{target,mode}`. The result text embeds a preview of the target file, so the generic line count says nothing useful here |
| `scratchpad` | `A open / B items` from `details.{open,count}` for a non-empty `list`, `empty` for an empty one, and the action for a mutation (`item added`, `item done`, `item reopened`, `cleared N done items`) |
| `memory_read` | `N daily logs` / `no daily logs` from `details.files` for `list`; `<date> log, N lines` for a `daily` file that exists, `no log` when it does not; `long_term` and `scratchpad` fall through to `N lines` |
| `memory_forget` | `removed N entries` (or `entry`) from `details.removed`; `nothing removed` when it is 0 |
| `memory_restore` | `restored N entries` from `details.restored`; `already restored` when it is 0 or `details.restoredAt` is set |
| `memory_search` | `N results (mode)` from `details.{count,mode}`, with `, embeddings started` / `, embeddings missing` from `details.{embedStarted,needsEmbed}` |
| `memory_status` | `qmd ok, collection ok/missing, embeddings <state>` from `details.{qmd,collection,embeddings}`; `qmd unavailable` when qmd is missing |

Each branch is gated on its tool name. A `details` shape that matches nothing
falls through to the generic line count, except `scratchpad` `list` on an empty
file and `memory_read` `daily` with no `details.path`, which gist `empty` and
`no log` from the empty shape pi-memory returns there. Mutation claims come from
`details`, never from `context.args`: the args look identical whether or not the
mutation matched (a `done` for a string that is not there returns `details: {}`),
so gating on args would report a change that never happened.

### External tools (typed lines, not in the defaults)

`gitlab_read` and the `pup_*` family are registered outside this repository
(`lucas-pimentel-coding-agent-tools` and the local `dd-pup-pi` user extension),
so none of them is a code default: each needs a key in the config file, and the
family is meant to be covered by a single prefix pattern. Their typed lines
(shapes verified on 2026-11-07 against the installed tools) are:

| Tool | Gist |
| --- | --- |
| `gitlab_read` | `timed out` from `details.timedOut`; `exit N` from a non-zero `details.exitCode`; otherwise generic `N lines`. Its result never sets `isError`, so a failure is recognized in the typed branch, not the failure branch |
| `pup_monitors_list` | `N monitors` from the length of `details.parsed.data` |
| `pup_logs_search` | `N logs` from `details.parsed.data` |
| `pup_traces_search` | `N traces` from `details.parsed.data` |
| `pup_apm_services` | `N services` from `details.parsed.data.attributes.services` |
| `pup_logs_aggregate` | `N buckets` from `details.parsed.data.buckets` |
| `pup_metrics_query` | `N series` from `details.parsed.data.series` |
| `pup_run` | `N items` from the length of `details.parsed.data`, the escape hatch's only verified envelope entry point; any other payload keeps the generic line count |
| `pup_auth_status` | generic `N lines`: it returns a flat `{ authenticated, site, org, expires_at, ... }` object with nothing to count |
| any `pup_*` failure | `exit N` from `details.exitCode`, or `timed out` when `details.killed` |

Every `pup` command wraps its payload in pup's own `{ data, metadata, status }`
envelope, so the count path is per tool rather than a top-level array. A payload
that does not match its path (including a non-JSON stdout, which leaves
`details.parsed` unset) falls through to the generic line count, and every pup
noun is deliberately fixed plural (`1 monitors`, `1 buckets`). A count line gains
`, auth refreshed` when `details.refreshed` is set, the only place that state
surfaces.

Deliberate renderer overrides: `host_bash` overrides guard's own shell result
renderer (`extensions/guard/index.ts`, `extensions/guard/tools/shell-render.ts`),
and `ffgrep`/`fffind` override the renderers `@ff-labs/pi-fff` registers. The
gist replaces those collapsed bodies on purpose.

## Config

`~/.pi/agent/compact-tool-view.json`, resolved with `getAgentDir()` from
`@earendil-works/pi-coding-agent` (never `homedir()`), following the
`extensions/idle-summary/index.ts` and `extensions/shared/model-pin.ts` patterns.
A flat JSON map of tool name or prefix pattern to `"gist" | "hide" | "stock"`,
sparse overrides over the code defaults.

- Missing file: pure defaults, no warning.
- Unknown name: kept; it enables the mode for that name.
- `stock`: no gist for that name, even over a matching pattern.
- Invalid value (not one of the three strings), a non-object top level, or
  unparseable JSON: the entry (or the whole file) is ignored and reported once
  at load via `ctx.ui.notify(..., "warning")`.
- A key whose only `*` is its final character is a prefix pattern: the prefix is
  the key minus that `*`, so `"mcp__*"` covers `mcp__slack__search` and `"*"`
  covers every tool name. A key with a `*` anywhere else (for example
  `"mcp__*__read*"` or `"*foo"`) is an invalid key and joins the same single
  warning.

Precedence, highest first: a file exact entry, a file exact `stock`, the longest
matching file pattern (a matching `stock` pattern means no gist and does not fall
through to a shorter pattern or a default), then the code default. So a pattern
can cover a name that has a code default, while an explicit exact `stock` in the
file still suppresses that name; the code defaults themselves stay exact-only.
Matching is case-sensitive, like the plain name lookup it replaced.

No command, no keybinding, no runtime toggle. The config is read at factory time,
and `/reload` re-runs the factory, so `/reload` picks up edits.

## The `write` assumption

`write`'s gist is `N lines written`, derived from `context.args.content`. Its
result carries only `Successfully wrote to <path>` and its `details` is
`undefined` (`dist/core/tools/write.d.ts` types details as `undefined`), so the
result alone cannot produce the count. `writeSchema` has a `content` string
field, so `context.args.content` is available at render time. This is an
assumption about the renderer context, stated as such: if a future pi stops
passing `content` in the render context, the gist falls back to the generic
`N lines`.

## Composition with `timestamps`

`extensions/timestamps/index.ts` already registers a resolver that delegates
through `next()` and wraps `renderCall`/`renderResult` for every tool name.
Resolvers compose in extension load order and both delegate through `next()`, so
neither assumes it is outermost and both keep working. `next()` is called fresh
on every invocation.

Verified at the resolver level: pi's chain is `resolvers[0](name, () => resolvers[1](...))`, so the first resolver is outermost. In the shipped order (`timestamps` is listed before `compact-tool-view` in `package.json`), `timestamps` wraps the collapsed gist and its dim result line (`ran 2.0s`) still renders under it, and the call-row `started` line is untouched either way. If `compact-tool-view` were outermost, the collapsed gist replaces the base result wholesale and that result line is not rendered collapsed (expanded still shows it, because expanded delegates to the base). This is a consequence of replacing `renderResult`, accepted by the settled design; only the order in the manifest changes which of the two happens.

## Out of scope

- `!`/`!!` user-bash output (unreachable: `BashExecutionComponent` is constructed
  directly by pi's `interactive-mode.js`).
- The model-facing `content` and `structuredContent`.
- Call-row clamping.
- `-p`/RPC hosts (no renderer path there).
- Guard policy (no tool name or classification changes).

## Tests

`tests/compact-tool-view.test.mts` covers the pure gist table, the config loader
(defaults, overrides, `stock`, unknown names, invalid values, bad top level,
prefix patterns, pattern precedence, and invalid keys), and the resolver wiring
(collapsed gist replacement, expanded/streaming delegation, `hide`,
failure-over-`hide`, extra dimmed lines, pattern wrapping, and unknown/`stock`
pass-through). The file is listed in the explicit `test:ci` script in
`package.json`; an unlisted file never runs.
