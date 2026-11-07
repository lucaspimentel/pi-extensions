# compact-tool-view

Replace the collapsed body of tool result rows with a one-line gist, or hide
the body entirely. Display-only.

## Modes

Per tool name, in `~/.pi/agent/compact-tool-view.json` (a flat JSON map of tool
name to mode):

- `"gist"` (the default for every table entry below): the collapsed body is one
  synthesized summary line, for example `412 lines` for `read` or
  `7 matches in 3 files` for `ffgrep`. Extra content blocks that pi or guard
  appended (for example guard's warning block) still show, one dimmed line
  each.
- `"hide"`: no body; the call row plus a dimmed expand hint. Expanding
  (`Ctrl+O`, or a left-click in fullscreen mode) delegates to the stock body
  when the tool has one.
- `"stock"`: leaves pi's rendering untouched, and removes a name from the
  defaults.

Presence of a name in the effective table is the opt-in. Unknown names are
valid and enable the mode for that name. Failures always surface, ignoring the
mode: `exit N` for exec tools, else `error: <first line>`.

Nothing hides by default. `subagent` is deliberately absent from the defaults
because it renders itself.

## Files

```json
{
  "read": "hide",
  "bash": "stock",
  "my_tool": "gist"
}
```

A missing file means pure defaults. An invalid value (not one of the three
strings) is ignored and reported once at load; a non-object top level or
unparseable JSON is likewise ignored with a warning. The file is re-read when
extensions reload (`/reload`).

## Mechanism

One `pi.registerToolRenderer` resolver, never a tool re-registration: it
returns a copy of the base renderers with only `renderResult` replaced, so
`renderShell` and `renderCall` (including guard's shell call header) are
preserved. The gist is collapsed-only; expanded and streaming views delegate to
the base renderer. Composition: `timestamps` registers its own resolver and
both delegate through `next()`, so they compose in either load order.

`host_bash`, `ffgrep`, and `fffind` are deliberate overrides of renderers those
extensions register.

See [docs/compact-tool-view-design.md](../../docs/compact-tool-view-design.md)
for the full contract.
