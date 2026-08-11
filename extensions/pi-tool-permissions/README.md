# pi-tool-permissions

A [pi](https://github.com/earendil-works/pi) extension that adds **Claude Code–style configurable tool permissions** with `allow` / `deny` / `ask` lists.

Every time the LLM tries to call a tool, this extension checks the call against your rules and either:

- **allows** it silently,
- **denies** it (returns a block reason to the model), or
- **asks** you interactively, with the option to remember your choice as a new rule.

## Install

Install via the [pi-extensions](https://github.com/lucaspimentel/pi-extensions) package (includes all extensions and skills):

```bash
# Global (all projects)
pi install git:github.com/lucaspimentel/pi-extensions

# Project-local
pi install -l git:github.com/lucaspimentel/pi-extensions
```

Or try without installing:

```bash
pi -e git:github.com/lucaspimentel/pi-extensions
```

## Configuration

Rules are loaded from two files, merged together (project overrides user for `defaultAction`; allow/deny/ask lists are concatenated):

- `~/.pi/agent/pi-tool-permissions.json` — user-global
- `<cwd>/.pi/pi-tool-permissions.local.json` — project-local (machine-local; the `.local.json` suffix is the convention for per-checkout settings that should *not* be committed to git)

For backwards compatibility:
- If the user-global file above does not exist or cannot be read, the extension falls back to the legacy path `~/.pi/tool-permissions.json`.
- If the project-local `pi-tool-permissions.local.json` does not exist, the extension reads (in order) the legacy paths `<cwd>/.pi/pi-tool-permissions.json` and `<cwd>/.pi/tool-permissions.json`. The first time a rule is saved, any legacy files are automatically migrated to `<cwd>/.pi/pi-tool-permissions.local.json` and deleted.

See [`pi-tool-permissions.example.json`](./pi-tool-permissions.example.json) for a starter config.

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
  "readAllowSkills": true,
  "readAllowPiDocs": true,
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

#### `readAllowSkills` (default: `true`)

Silently allows `Read`, `Ls`, `Glob`, and `Grep` calls targeting pi's known skill roots, so the agent can load `SKILL.md` and related files (helper scripts, references) and explore the skills tree without prompting. Skill files commonly live outside the project's cwd, where the cwd-based implicit rules don't reach.

Covered roots (relative to your home directory):

| Path | Purpose |
| ---- | ------- |
| `~/.pi/agent/skills/**` | user-global pi skills |
| `~/.pi/agent/git/**/skills/**` | skills inside cloned skill repos |
| `~/.agents/skills/**` | alternate user-global skill location |

Only read-only tools (`Read`/`Ls`/`Glob`/`Grep`) are affected — `Write` and `Edit` to these paths still go through the normal permission flow (and the implicit `write → ask` default).

Disable it per-project:
```json
{ "readAllowSkills": false }
```

#### `readAllowPiDocs` (default: `true`)

Silently allows `Read`, `Ls`, `Glob`, and `Grep` calls targeting pi's bundled README, docs, and examples package, so the agent can answer questions about pi itself and discover example code without prompting. These files live inside the globally-installed npm package, outside any project cwd.

Covered roots (relative to your home directory):

| Path | Purpose |
| ---- | ------- |
| `~/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/**` | Windows global npm |
| `~/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/**` | `npm config set prefix ~/.npm-global` |
| `~/.nvm/versions/node/*/lib/node_modules/@earendil-works/pi-coding-agent/**` | nvm |
| `~/.volta/tools/image/node/*/lib/node_modules/@earendil-works/pi-coding-agent/**` | volta |
| `~/.local/share/npm/lib/node_modules/@earendil-works/pi-coding-agent/**` | XDG-style npm |
| `~/Library/Application Support/npm/lib/node_modules/@earendil-works/pi-coding-agent/**` | macOS |

System-wide install paths (`/usr/local/lib/...`, `/usr/lib/...`) are not covered. Only read-only tools (`Read`/`Ls`/`Glob`/`Grep`) are affected — `Write` and `Edit` still go through the normal permission flow.

Disable it per-project:
```json
{ "readAllowPiDocs": false }
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

Choosing **always** opens a second selector asking *where* to save the rule:

```
Save rule where?

  > Project (.pi/pi-tool-permissions.local.json)
    User    (~/.pi/agent/pi-tool-permissions.json)
```

The default is **Project** (machine-local, not committed). Pick **User** to apply the rule across every project on this machine. Pressing **Esc** cancels the save (the in-flight command still respects whatever once-decision the user already made: an allow-always cancel proceeds without a saved rule; a deny-always cancel still blocks just this one call).

### Compound Bash commands

When a single `Bash` call chains multiple subcommands (e.g. `cd foo && npm test && git status`), the prompt is shown once per `ask` subcommand. In addition to the choices above, the compound prompt offers:

```
  > Allow once
    Allow ALL steps once
    Allow always (save rule)
    Deny once
    Deny always (save rule)
```

**Allow ALL steps once** silently approves every remaining `ask` subcommand in the *current* Bash invocation without saving any rule and without re-prompting. It is scoped to this one compound command — the next independent Bash call starts from scratch. Compounds that contain a `deny` subcommand are still rejected up-front and never reach this prompt.

After you save a rule via **Allow always** / **Deny always**, the remaining subcommands of the *same* Bash invocation are re-evaluated against the new rule:

- A saved `allow` rule that matches downstream steps silently allows them — no second prompt. Example: `rg foo && rg bar`, saving `Bash(rg *)` on the first step skips the second.
- A saved `deny` rule that matches a downstream step blocks the whole command immediately with a `Blocked by tool-permissions deny rule` reason.
- Downstream steps that still resolve to `ask` continue to prompt normally, and their breakdown icons in the next dialog reflect the freshly-saved rule.

**Allow ALL steps once** still wins over any later rule-driven decision: once chosen, every remaining step is silently allowed regardless of newly-saved rules.

#### Control flow (`for` / `while` / `until` / `if` / `select`)

Structural control-flow keywords are elided from the per-subcommand breakdown so only real commands enter the prompt. Two categories:

| Category | Keywords | Effect |
|---|---|---|
| **Iteration heads** (whole part elided) | `for VAR in …`, `for ((…))`, bare `for VAR`, `select VAR in …`, bare `select VAR` | No command runs — part is silently dropped |
| **Pure structural tokens** (whole part elided) | `do`, `done`, `then`, `else`, `fi` | No command runs — part is silently dropped |
| **Prefix keywords** (keyword stripped, residue evaluated) | `while`, `until`, `if`, `elif` and leading-keyword forms of `do`/`then`/`else` | The command *after* the keyword is extracted and evaluated |

Examples:
- `for f in *.txt; do cat $f; done` → prompts once for `cat $f`
- `while true; do sleep 1; done` → prompts for `true` and `sleep 1`
- `if grep foo file; then echo found; fi` → prompts for `grep foo file` and `echo found`
- `if a; then b; elif c; then d; else e; fi` → prompts for `a`, `b`, `c`, `d`, `e`
- `select x in a b c; do echo $x; done` → prompts once for `echo $x`

Nested constructs collapse in one pass (e.g. `do while true` → `true`). When filtering leaves a single command the breakdown downgrades to a simpler single-command dialog.

> `case` statements are kept as a single unit and prompt once for the whole block. Pattern-clause `)` characters would otherwise look like unmatched parentheses to the splitter, so the entire `case … esac` command is evaluated as one command against your allow/deny rules. Add an explicit `Bash(case*)` allow rule to auto-approve familiar case blocks.

In non-interactive modes (`-p`, JSON mode), `ask` falls back to **deny** so nothing dangerous slips through automation.

## Allow-all-edits mode

A session-only toggle that auto-approves every `Write` and `Edit` tool call without prompting. It is **never** written to disk and always starts disabled — enabling it only applies to the current session.

Explicit `deny` rules still win even when the mode is on.

### Ways to toggle

| Method | Action |
| ------ | ------ |
| **Ctrl+Alt+E** | Toggle on/off |
| Permission dialog (Write/Edit only) | Choose **"Allow all edits this session"** |
| `/permissions allowalledits` | Toggle |
| `/permissions allowalledits on\|off` | Set explicitly |

When active, a `✏️ all edits allowed` indicator appears in the footer status bar.

## Slash command

```
/permissions                            # show current rules + allow-all-edits + auto-mode state
/permissions list                       # alias for bare /permissions
/permissions allow <rule> [--user]      # add an allow rule (default: project-local)
/permissions deny  <rule> [--user]      # add a deny rule
/permissions ask   <rule> [--user]      # add an ask rule
/permissions remove <rule> [--user]     # remove a rule (searches project by default; --user searches user config)
/permissions default <allow|deny|ask|auto> [--user]
/permissions reload                     # reload config from disk
/permissions allowalledits [on|off|toggle]
/permissions auto [on|off|toggle]       # toggle auto-mode (LLM classifier) for this session
```

All write subcommands (`allow`/`deny`/`ask`/`remove`/`default`) accept `--user` to target the user-global config (`~/.pi/agent/pi-tool-permissions.json`); the default is the project-local `.pi/pi-tool-permissions.local.json`. `/permissions list` tags each rule with its source: `[implicit]`, `[user]`, `[project]`, or `[user+project]` when the same rule lives in both files.

Examples:

```
/permissions allow Bash(npm test*)
/permissions allow Bash(rg *) --user
/permissions allow WebSearch
/permissions allow WebFetch(https://github.com/*)
/permissions deny  Write(.env*)
/permissions ask   WebFetch(*)
/permissions default deny
/permissions default deny --user
/permissions allowalledits on
/permissions auto on
```

## Auto mode (defaultAction: "auto")

Auto mode is a middle ground between Manual (prompt for everything) and `bypassPermissions` (prompt for nothing). Set `"defaultAction": "auto"` and turn on the session toggle, and before each tool call that **falls through the static rules**, a cheap/fast LLM **classifier** screens the action against natural-language `allow` / `soft_deny` / `hard_deny` lists plus an `environment` fact list, then either allows silently, prompts (with the classifier's reason), or blocks.

It is layered **on top of** the existing static rules, not alongside them:

- `deny` rules block *before* the classifier is consulted (neither the classifier nor user intent can override).
- `ask` rules always prompt (the classifier cannot auto-approve a matching action).
- The classifier only decides for actions that fall through to `defaultAction: "auto"`.

Auto mode is **off by default** and **never persisted** (session-only, like allow-all-edits). Even with `defaultAction: "auto"` in config, the classifier only runs while the session toggle is on; otherwise fallthroughs behave as `ask` (safe default). Explicit `deny` rules always win.

> **Status:** The type/config spine, session toggle, `/permissions auto` subcommand, footer indicator, and the classifier runtime are wired. When auto-mode is engaged and a classifier model is available, fallthroughs are screened by the classifier; otherwise they behave as `ask` (safe fallback). See [`docs/auto-mode-design.md`](./docs/auto-mode-design.md) for the full design.

### Ways to toggle

| Method | Action |
| ------ | ------ |
| **Ctrl+Alt+A** | Toggle on/off |
| `/permissions auto` | Toggle |
| `/permissions auto on\|off` | Set explicitly |

When active, a `🤖 auto mode on` indicator appears in the footer status bar.

### Config

```json
{
  "defaultAction": "auto",
  "autoMode": {
    "classifier": { "provider": "anthropic", "model": "claude-haiku-4-5" },
    "environment": [
      "Trusted repo: github.com/lucaspimentel/*",
      "Trusted domains: *.internal.example.com"
    ],
    "allow":     ["Running tests and linters"],
    "soft_deny": ["Force pushing, deleting remote branches"],
    "hard_deny": ["Sending repo contents to third-party APIs"],
    "classifyAllShell": true
  }
}
```

| Field | Default | Purpose |
| ----- | ------- | ------- |
| `classifier` | _(auto-select)_ | Optional explicit model pin (`{ provider, model }`). If omitted, a haiku-tier model is auto-selected from the available pool, preferring the currently selected model's provider. |
| `environment` | `[]` | Free-text facts shown to the classifier (e.g. trusted repos/domains). Inherently user-specific — no default. |
| `allow` | `["Running tests and linters"]` | NL descriptions of actions to silently allow. |
| `soft_deny` | `["Force pushing, deleting remote branches"]` | NL descriptions of actions to prompt for (with the classifier's reason). |
| `hard_deny` | `["Sending repo contents to third-party APIs"]` | NL descriptions of actions to always block. |
| `classifyAllShell` | `true` | When `true`, route every bash subcommand (including read-only auto-allowed ones) through the classifier. |

The `allow` / `soft_deny` / `hard_deny` lists and `classifyAllShell` have **sane defaults** baked in — a bare `{ "defaultAction": "auto" }` with no `autoMode` block works out of the box. Your configured lists are **additive** on top of the defaults (concatenated + deduped), so you can extend them without losing the safe baseline. `classifier` and `environment` have no defaults — they're inherently user-specific. To override `classifyAllShell` back to `false`, set it explicitly.

In non-interactive modes (`-p`, JSON mode), classifier `soft_deny` and no-match verdicts fall back to **deny** so automation can't silently run something the classifier flagged.

See [`docs/auto-mode-design.md`](./docs/auto-mode-design.md) for the full design.

## How it works

The extension subscribes to pi's `tool_call` event, evaluates the rules, and either lets the call through, returns `{ block, reason }`, or pops a `ctx.ui.select` dialog. See [pi extension docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md) for the underlying API.
