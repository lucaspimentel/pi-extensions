# pi-tool-permissions

A [pi](https://github.com/mariozechner/pi-coding-agent) extension that adds **Claude Code–style configurable tool permissions** with `allow` / `deny` / `ask` lists.

Every time the LLM tries to call a tool, this extension checks the call against your rules and either:

- **allows** it silently,
- **denies** it (returns a block reason to the model), or
- **asks** you interactively, with the option to remember your choice as a new rule.

## Install

Copy or symlink this folder into one of pi's extension locations:

```bash
# Global (all projects)
cp -r ./pi-tool-permissions ~/.pi/agent/extensions/

# Or project-local
cp -r ./pi-tool-permissions .pi/extensions/
```

Or test it without installing:

```bash
pi -e ./pi-tool-permissions/index.ts
```

## Configuration

Rules are loaded from two files, merged together (project overrides user for `defaultAction`; allow/deny/ask lists are concatenated):

- `~/.pi/agent/pi-tool-permissions.json` — user-global
- `<cwd>/.pi/tool-permissions.json` — project-local (recommended for team-shared rules)

For backwards compatibility, if the user-global file above does not exist or cannot be read, the extension falls back to the legacy path `~/.pi/tool-permissions.json`.

See [`tool-permissions.example.json`](./tool-permissions.example.json) for a starter config.

```json
{
  "defaultAction": "ask",
  "allow": ["Read", "Bash(npm test*)"],
  "deny":  ["Bash(rm -rf*)", "Write(.env*)"],
  "ask":   ["Bash(git push*)"],
  "toolDefaults": { "write": "ask" },
  "readAllowCwd": true,
  "grepAllowCwd": true,
  "globAllowCwd": true,
  "lsAllowCwd": true,
  "bashReadOnlyAllowCwd": true
}
```

### Rule syntax

```
ToolName              # matches any call of that tool
ToolName(pattern)     # matches when the tool's "match field" matches the pattern
```

Patterns are simple **case-insensitive globs**:

- `*` — any characters
- `?` — single character
- A space-asterisk pair `" *"` is treated as **optional**, so a rule like
  `Bash(git status *)` matches both `git status` and `git status -s`. This
  mirrors the format the "Allow always (save rule)" prompt suggests, so an
  auto-saved rule covers the bare command form without needing two entries.
  A bare `*` without a leading space is unaffected (e.g. `npm*` still requires
  the matched string to start with `npm`).

Or use a regex by wrapping with slashes: `Bash(/^git (push|tag) /)`. Regex
patterns bypass the `" *"` transform — they are used as-is.

### Path-scoped rules

Append a glob pattern to scope `Read` or `Write` permissions to specific paths. Since pattern
syntax uses `*` for "any characters", use a trailing `*` to match a directory and everything
beneath it:

```json
{
  "allow": [
    "Read(./src/*)",
    "Read(/home/shared/docs/*)",
    "Write(./output/*)"
  ],
  "deny": [
    "Read(.env*)",
    "Write(*/.git/*)"
  ]
}
```

`Write(./output/*)` in the allow list takes priority over the implicit `write → ask`
toolDefault (allow > toolDefaults), so writes to that directory proceed silently without a prompt.

`Grep` and `Glob` follow the same path-scoped syntax. The matched field is the *directory being
searched*, not the search pattern itself — so `Grep(./src/*)` means "allow grep inside `./src`",
not "allow grep for the pattern `./src/*`". When the model calls grep or glob without an explicit
path, the permission system treats it as if `path` were the current working directory.

> **Note:** `Read(./src)` (no trailing `*`) matches only the exact string `"./src"` — it does
> not automatically expand to match files inside the directory. Always use `Read(./src/*)` or
> `Read(./src*)` when you mean "this directory and its contents". The same applies to `Grep` and
> `Glob`.

> **Breaking change:** Rules that previously tried to filter grep/glob by *search pattern*
> (e.g. `"Grep(TODO*)"`) no longer match anything — the match field is now the search directory,
> not the search text. Replace them with path-scoped rules or bare `Grep`/`Glob` to allow all.

### Match fields per tool

| Tool                  | Field matched against the pattern                  |
| --------------------- | -------------------------------------------------- |
| `bash`                | `command`                                          |
| `read`/`write`/`edit` | `path`                                             |
| `grep`                | `path` (directory searched; defaults to cwd)       |
| `glob`                | `path` (directory searched; defaults to cwd)       |
| `ls`                  | `path` (directory listed; defaults to cwd)         |
| `web_fetch`           | `url`                                              |
| `web_search`          | bare rule only — `WebSearch` matches any search    |
| anything else         | `JSON.stringify(input)`                            |

### Tool name matching

Tool names in rules are **case-insensitive** and **underscore-agnostic**. These are all equivalent:

```
WebSearch   websearch   web_search   WEB_SEARCH
WebFetch    webfetch    web_fetch
Bash        bash
Read        read
```

The canonical style used in suggestions and examples is `PascalCase` (e.g. `WebSearch`, `WebFetch`, `Bash`, `Read`).

### WebSearch

`WebSearch` is a bare-only rule — it has no pattern syntax. It simply allows, denies, or gates
all uses of the `web_search` tool:

```json
{ "allow": ["WebSearch"] }
```

### WebFetch

`WebFetch` supports URL glob patterns matched against the full URL:

```json
{
  "allow": [
    "WebFetch(https://github.com/*)",
    "WebFetch(https://*.docs.example.com/*)"
  ],
  "ask": ["WebFetch(*)"]
}
```

**`?` in URL patterns:** In glob syntax `?` means “any single character”, not a query-string
delimiter. For the common case of matching by domain and path this is never an issue. If you need
to match query parameters precisely, use regex syntax:

```json
"WebFetch(/https:\\/\\/example\\.com\\/page\\?q=.*/)"
```

### Implicit defaults

Two safe defaults are injected automatically at session start. They are **never written to disk**.

#### `readAllowCwd` (default: `true`)

Silently allows any `Read` of a file inside the current working directory (recursively). This
means you rarely need a bare `"Read"` entry in your allow list.

Disable it per-project:
```json
{ "readAllowCwd": false }
```

Add extra allowed read roots with explicit rules:
```json
{ "allow": ["Read(/home/shared/docs/*)"] }
```

#### `grepAllowCwd` (default: `true`)

Silently allows any `Grep` call whose search directory is inside the current working directory (recursively). This mirrors `readAllowCwd` for the `grep` tool.

Disable it per-project:
```json
{ "grepAllowCwd": false }
```

#### `globAllowCwd` (default: `true`)

Silently allows any `Glob` call whose search directory is inside the current working directory (recursively). This mirrors `readAllowCwd` for the `glob` tool.

Disable it per-project:
```json
{ "globAllowCwd": false }
```

#### `lsAllowCwd` (default: `true`)

Silently allows any `Ls` call whose listed directory is inside the current working directory (recursively). When the model calls `ls` without a `path`, the permission system treats it as if `path` were the current working directory, so bare `Ls` calls are also auto-allowed.

Disable it per-project:
```json
{ "lsAllowCwd": false }
```

#### `bashReadOnlyAllowCwd` (default: `true`)

Silently allows a curated set of read-only Bash subcommands when every filesystem argument they receive resolves inside the current working directory.

Two tiers of safe commands:

| Tier | Commands | Condition |
| ---- | -------- | --------- |
| **Safe always** — no filesystem access | `pwd`, `echo`, `printf`, `date`, `whoami`, `id`, `hostname`, `uname`, `env`, `printenv`, `true`, `false`, `which`, `type`, `command` | Always allowed |
| **Safe with paths** — read-only filesystem access | `ls`, `cat`, `head`, `tail`, `wc`, `file`, `stat`, `tree`, `du`, `realpath`, `readlink`, `dirname`, `basename` | Allowed when all non-flag arguments resolve inside cwd |

Commands containing output redirections (`>`, `>>`, `2>`, etc.) are **never** auto-allowed, even if the base command is in the safe list — e.g. `echo foo > /tmp/out` is denied.

The compound-command splitter applies first, so each subcommand in a `&&` / `||` / `;` chain is evaluated independently. A chain like `ls && pwd` is fully auto-allowed; `ls && rm -rf .` is denied because `rm` is not on the safe list.

Notably excluded from the safe list: `find` (has `-delete` / `-exec` flags), `grep`/`rg` (covered as dedicated tools), `git` (mixed read/write). Add explicit allow rules for these if needed.

Disable per-project:
```json
{ "bashReadOnlyAllowCwd": false }
```

#### `allowNoopCd` (default: `true`)

Silently allows any `Bash` command that is a no-op `cd` — i.e. one that navigates to the
current working directory and therefore has no side-effects.

Recognised no-op forms:

| Command | Why it's a no-op |
| ------- | ---------------- |
| `cd .` | explicit current-dir reference |
| `cd ./` | same with trailing slash |
| `cd $PWD` | shell variable for cwd |
| `cd ${PWD}` | same, braced form |
| `cd ~+` | bash shorthand for `$PWD` |
| `cd /absolute/path/to/cwd` | resolves to cwd |
| `cd 'quoted/path'` | quoted variant of any of the above |

Bare `cd` (no argument) navigates to `$HOME`, not cwd, so it is **not** treated as a no-op.
Arguments containing unrecognised shell metacharacters (`` ` ``, `$()`, `{}`, `|`, `;`, etc.)
are also rejected for safety — except for the well-known `$PWD` / `${PWD}` forms.

Explicit `deny` rules always win, even when `allowNoopCd` is `true`.

Disable per-project:
```json
{ "allowNoopCd": false }
```

#### `write` → `ask` (automatic)

Unless you explicitly set `toolDefaults.write`, every `Write` call triggers a confirmation
prompt — even if `defaultAction` is `"allow"`. This prevents accidental file mutations in
high-trust sessions.

Override for a specific path (explicit allow wins over toolDefaults):
```json
{ "allow": ["Write(./output/*)"] }
```

Or disable the default entirely:
```json
{ "toolDefaults": { "write": "allow" } }
```

#### `toolDefaults` map

You can set per-tool fallback actions for any tool. They are checked **after** the explicit
allow/deny/ask lists but **before** `defaultAction`:

```json
{
  "toolDefaults": {
    "write":      "ask",
    "web_fetch":  "allow",
    "web_search": "allow"
  }
}
```

### Precedence

For each tool call, the first matching slot wins:

```
deny  >  ask  >  allow  >  toolDefaults  >  defaultAction
```

So a `deny` rule always overrides an `allow` rule, and an explicit `allow` rule always overrides
a `toolDefaults` entry (which is how `Write(./output/*)` in allow can opt out of the implicit
`write → ask` default).

## Interactive prompt

When a call hits an `ask` rule (or `defaultAction: "ask"` with no other match), you'll get:

```
Allow bash?

  rm -rf node_modules

Suggested rule: Bash(rm*)

  > Allow once
    Allow always (save rule)
    Deny once
    Deny always (save rule)
```

Choosing **always** saves the suggested rule into the project-local config (`.pi/tool-permissions.json`).

In non-interactive modes (`-p`, JSON mode), `ask` falls back to **deny** so nothing dangerous slips through automation.

## Allow-all-edits mode

A session-only toggle that auto-approves every `Write` and `Edit` tool call without prompting. It is **never** written to disk and always starts disabled — enabling it only applies to the current session.

Explicit `deny` rules still win even when the mode is on.

### Ways to toggle

| Method | Action |
| ------ | ------ |
| **Ctrl+Shift+E** | Toggle on/off |
| Permission dialog (Write/Edit only) | Choose **"Allow all edits this session"** |
| `/permissions allowalledits` | Toggle |
| `/permissions allowalledits on\|off` | Set explicitly |

When active, a `edits: all allowed` indicator appears in the footer status bar.

## Slash command

```
/permissions                            # show current rules + allow-all-edits state
/permissions allow <rule>               # add an allow rule (project-local)
/permissions deny  <rule>               # add a deny rule
/permissions ask   <rule>               # add an ask rule
/permissions remove <rule>              # remove a rule from any list
/permissions default <allow|deny|ask>
/permissions reload                     # reload config from disk
/permissions allowalledits [on|off|toggle]
```

Examples:

```
/permissions allow Bash(npm test*)
/permissions allow WebSearch
/permissions allow WebFetch(https://github.com/*)
/permissions deny  Write(.env*)
/permissions ask   WebFetch(*)
/permissions default deny
/permissions allowalledits on
```

## How it works

The extension subscribes to pi's `tool_call` event, evaluates the rules, and either lets the call through, returns `{ block, reason }`, or pops a `ctx.ui.select` dialog. See [pi extension docs](https://github.com/mariozechner/pi-coding-agent/blob/main/docs/extensions.md) for the underlying API.
