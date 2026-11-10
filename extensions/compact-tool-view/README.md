# compact-tool-view

Replace the collapsed body of tool result rows with a synthesized gist (usually
one line, two for a failed `codemode` script), or hide the body entirely.
Display-only.

## Modes

Per tool name, in `~/.pi/agent/compact-tool-view.json` (a flat JSON map of tool
name or prefix pattern to mode):

- `"gist"` (the default for every table entry below): the collapsed body is a
  synthesized summary line set (one line for every tool except `codemode`, whose
  failure is two normal lines), for example `412 lines` for `read` or
  `7 matches in 3 files` for `ffgrep`. Extra content blocks that pi or guard
  appended (for example guard's warning block) still show, one dimmed line
  each.
- `"hide"`: no body; the call row plus a dimmed expand hint. Expanding
  (`Ctrl+O`, or a left-click in fullscreen mode) delegates to the stock body
  when the tool has one.
- `"stock"`: leaves pi's rendering untouched, and removes a name from the
  defaults.

A key whose only `*` is its final character is a prefix pattern, so
`"mcp__*": "gist"` covers every MCP tool with one line. An exact key beats a
pattern, the longest matching pattern wins, and a pattern beats a code default;
a `stock` pattern means no gist, and an exact `stock` still wins over a pattern.
A key with a `*` anywhere else is invalid and warns.

Presence of a name in the effective table is the opt-in. Unknown names are
valid and enable the mode for that name. Failures always surface, ignoring the
mode: `exit N` for exec tools (or `timed out` for a killed or timed-out exec),
else `error: <first line>`.

Nothing hides by default. `subagent` is deliberately absent from the defaults
because it renders itself. The `pi-memory` tools (`memory_write`, `scratchpad`,
`memory_read`, `memory_forget`, `memory_restore`, `memory_search`,
`memory_status`) are absent as well, and so are `gitlab_read` and the `pup_*`
family (`pup_*` is meant to be enabled as one pattern); each has a typed line of
its own, so adding its name or pattern to the file enables that line.

In the defaults even though they ship their own renderers: `codemode` and
`tool_search`. Their gists are
`Script completed, N calls[, M failed], L lines[, truncated]` and
`N tools loaded` (`no matches` when empty). Only the collapsed result body is
replaced; expanding shows pi's own view, which for `codemode` means the nested
calls with their statuses and durations, the model call cost, a five-line output
preview, the `Full output: <path>` line, and the `Elapsed`/`Took` timer. A failed script collapses to two normal lines instead:
`Script failed, N calls[, M failed]` and the first line after `Script error:`;
without pi's error block the single generic `error: <first line>` shows. Counts
are fixed plural (`1 calls`, `1 lines`), matching the pup lines. Also in the
defaults: `list_mcp_resources`, `list_mcp_resource_templates`, and
`read_mcp_resource`, which have no renderer of their own and gist the generic
line count.

## Files

```json
{
  "read": "hide",
  "bash": "stock",
  "mcp__*": "gist",
  "pup_*": "gist",
  "my_tool": "gist"
}
```

A missing file means pure defaults. An invalid value (not one of the three
strings), or a key with a `*` anywhere but the end, is ignored and reported once
at load; a non-object top level or unparseable JSON is likewise ignored with a
warning. The file is re-read when extensions reload (`/reload`).

## Mechanism

One `pi.registerToolRenderer` resolver, never a tool re-registration: it
returns a copy of the base renderers with only `renderResult` replaced, so
`renderShell` and `renderCall` (including guard's shell call header) are
preserved. The gist is collapsed-only; expanded and streaming views delegate to
the base renderer. Composition: `timestamps` registers its own resolver and
both delegate through `next()`, so they compose in either load order.

`host_bash`, `ffgrep`, and `fffind` are deliberate overrides of renderers those
extensions register, and `codemode` is a deliberate collapsed-only override of
pi's own codemode renderer.

See [docs/compact-tool-view-design.md](../../docs/compact-tool-view-design.md)
for the full contract.
