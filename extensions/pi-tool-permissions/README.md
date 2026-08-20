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
| `mcp`                 | `tool` (the MCP tool name, e.g. `slack_slack_*`)   |
| anything else         | `JSON.stringify(input)`                            |

### Tool name matching

Tool names in rules are **case-insensitive** and **underscore-agnostic**. These are all equivalent:

```
WebSearch   websearch   web_search   WEB_SEARCH
WebFetch    webfetch    web_fetch
Mcp         mcp
Bash        bash
Read        read
```

The canonical style used in suggestions and examples is `PascalCase` (e.g. `WebSearch`, `WebFetch`, `Bash`, `Read`, `Mcp`).

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

### MCP

Every MCP tool call arrives as the single pi tool `mcp`, with the real tool name in
its `tool` field (conventionally `<server>_<tool>`, e.g. `slack_slack_search_public_and_private`).
`Mcp(pattern)` rules match against that tool name, so you can allow, deny, or gate
individual MCP tools — or whole servers — with the same glob / regex syntax as the
other tools:

```json
{
  "allow": [
    "Mcp(slack_*)",
    "Mcp(github_*)"
  ],
  "deny":  ["Mcp(slack_slack_post_*)"],
  "ask":   ["Mcp(atlassian_*)"]
}
```

- `Mcp(slack_*)` — every tool on the `slack` server
- `Mcp(slack_slack_search_*)` — a tool family
- `Mcp(slack_slack_search_public_and_private)` — one exact tool
- `Mcp(/atlassian_.*/)` — regex

Because all MCP calls share toolName `mcp`, a useful baseline is `"toolDefaults": { "mcp": "ask" }`
(prompt for any MCP tool that no static rule covers). Per-MCP-tool *defaults* aren't
expressible in `toolDefaults` (the key would collide); use an `ask` rule to force a
prompt for a specific tool instead. Static rules match on the tool name only — to
discriminate by argument values, use [auto mode](#auto-mode), whose classifier sees
the full call (tool name + parsed args).

The interactive prompt renders the parsed arguments one-per-line instead of raw
JSON, e.g.:

```
Allow MCP tool slack_slack_search_public_and_private?

  query: from:<@UA81XRMD2> after:2026-08-11 before:2026-08-13
  sort:  timestamp
  limit: 20
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

Commands containing top-level *file* output redirections (`>`, `>>`, `2>`, `&>`, etc.) are **never** auto-allowed, even if the base command is in the safe list — e.g. `echo foo > /tmp/out` is denied. Descriptor-to-descriptor redirects such as `2>&1` / `1>&2` / `>&2` are **not** file writes (they only rearrange existing streams) and stay auto-allowable, so common combined-output patterns like `cmd 2>&1` are not blocked. Redirects to `/dev/null` (the Unix null device — writes are discarded, nothing persisted) are likewise **not** file writes, so idioms like `cmd 2>/dev/null` or `cmd >/dev/null 2>&1` stay auto-allowable.

The compound-command splitter applies first, so each subcommand in a `&&` / `||` / `;` chain is evaluated independently. A chain like `ls && pwd` is fully auto-allowed; `ls && rm -rf .` is denied because `rm` is not on the safe list.

Notably excluded from the safe list: `find` (has `-delete` / `-exec` flags), `grep`/`rg` (covered as dedicated tools), `git` (mixed read/write). Add explicit allow rules for these if needed.

Disable per-project:
```json
{ "bashReadOnlyAllowCwd": false }
```

#### Redirected Bash commands (write-risk)

A Bash command containing a top-level *file* output redirection (`>`, `>>`, `2>`, `&>`, `n>>`, …) is treated as a **write-risk** operation. A broad allow rule whose pattern contains no `>` will **not** auto-allow a redirected form — e.g. with `Bash(rg *)` in `allow`, `rg x > out.txt` falls through to `ask` / `toolDefaults` / `defaultAction` rather than being silently allowed.

To pre-authorize a redirected command, add an explicit **redirect-aware** rule whose pattern includes the `>` operator:

```json
{ "allow": ["Bash(rg *)", "Bash(rg * > *)"] }
```

Notes:
- The `>` in a rule pattern is literal, so `Bash(rg * > *)` covers `rg x > out.txt` but **not** `rg x >> out.txt` — add `Bash(rg * >> *)` separately for the append form.
- `deny` and `ask` rules are **redirect-agnostic** and always still apply, so safety rules win over a redirected command even when a redirect-aware `allow` rule exists.
- Descriptor-to-descriptor redirects (`2>&1`, `1>&2`, `>&2`, `>&-`) are **not** file writes and are exempt from this filter — `cmd 2>&1` is still covered by a broad `Bash(cmd *)` rule.
- Redirects to `/dev/null` (the Unix null device) are **not** file writes either — `cmd 2>/dev/null` and `cmd >/dev/null 2>&1` stay auto-allowable and covered by broad rules. Only an *exact* `/dev/null` target is exempted; subpaths like `/dev/null/x` stay write-risk. Process substitution `>(...)` still counts as a write.
- `toolDefaults` and `defaultAction` are **not** gated by the redirect filter.
- `pwsh` is out of scope (different redirection syntax) and stays redirect-agnostic.

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
deny  >  ask  >  allow  >  toolDefaults  >  auto (if session toggle on)  >  defaultAction
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

Every permission dialog also offers a **"Switch to auto mode (this session)"** choice (see [Auto mode](#auto-mode) below) when auto mode isn't already active. It appears at the **top** of the choice list — and since pi's selector defaults the cursor to the first item, it's the default action when auto mode is off (press Enter to switch to auto mode, or move down to pick an allow/deny choice).

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

This option only appears when **more than one** subcommand in the chain actually needs human approval — with a single `ask` step it's identical to **Allow once**, so it's omitted to keep the dialog uncluttered.

After you save a rule via **Allow always** / **Deny always**, the remaining subcommands of the *same* Bash invocation are re-evaluated against the new rule:

- A saved `allow` rule that matches downstream steps silently allows them — no second prompt. Example: `rg foo && rg bar`, saving `Bash(rg *)` on the first step skips the second.
- A saved `deny` rule that matches a downstream step blocks the whole command immediately with a `Blocked by tool-permissions deny rule` reason.
- Downstream steps that still resolve to `ask` continue to prompt normally, and their breakdown icons in the next dialog reflect the freshly-saved rule.

**Allow ALL steps once** still wins over any later rule-driven decision: once chosen, every remaining step is silently allowed regardless of newly-saved rules.

> In **auto mode**, a compound with no static `ask`/`deny` sub is instead classified as a single whole command (one verdict for the entire chain) and never enters this per-sub loop. See [Compound Bash in auto mode](#compound-bash-in-auto-mode).

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
/permissions                            # show this help
/permissions help                       # show this help
/permissions list                       # show current rules + allow-all-edits + auto-mode state
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
/permissions allow Mcp(slack_*)
/permissions deny  Mcp(slack_slack_post_*)
/permissions deny  Write(.env*)
/permissions ask   WebFetch(*)
/permissions ask   Mcp(atlassian_*)
/permissions default deny
/permissions default deny --user
/permissions allowalledits on
/permissions auto on
```

## Auto mode

Auto mode is a **session-toggle layer between `toolDefaults` and `defaultAction`** — a middle ground between Manual (prompt for everything) and `bypassPermissions` (prompt for nothing). Turn on the session toggle, and before each tool call that **falls through the static rules AND any `toolDefaults`**, a cheap/fast LLM **classifier** screens the action against natural-language `allow` / `soft_deny` / `hard_deny` lists plus an `environment` fact list, then either allows silently, prompts (with the classifier's reason), or blocks.

It is a **layer in the precedence chain**, not a `defaultAction` value:

```
deny > ask > allow > toolDefaults > auto (if session toggle on) > defaultAction
```

- `deny` rules block *before* the classifier is consulted (neither the classifier nor user intent can override).
- `ask` rules always prompt (the classifier cannot auto-approve a matching action).
- `toolDefaults` (e.g. the implicit `write → ask` guard) win over the classifier — a per-tool deterministic action is never screened by the LLM.
- The classifier only decides for actions that fall through all of those — true unknowns.

When an action matches more than one NL list, the more-severe verdict wins: **`hard_deny > soft_deny > allow`** (the classifier emits a single verdict, so precedence is enforced by the prompt instruction, not by code). This mirrors the static `deny > ask > allow` chain — there is no `allow`-overrides-`deny` escape hatch at the classifier layer.

**Verdict mapping:**

| Classifier verdict | Result |
| --- | --- |
| `allow` | allow (silent) |
| `hard_deny` | block |
| `soft_deny` | prompt with reason (deny in non-interactive modes — can't prompt) |
| `no_match` | fall through to `defaultAction` (the classifier ran and had no opinion, so the user's terminal default applies) |

When the toggle is on but **no classifier model is available**, the auto layer stubs to `ask` (safe) rather than applying `defaultAction` — screening was requested but couldn't be performed, so prompt instead.

Auto mode is **off by default** and **never persisted** (session-only, like allow-all-edits). `defaultAction` is never `"auto"` — legacy configs that still set it are coerced to `"ask"` with a warning. Explicit `deny` rules always win.

> **Status:** The session toggle, `/permissions auto` subcommand, footer indicator, and the classifier runtime are wired. When the toggle is on and a classifier model is available, fallthroughs are screened by the classifier; if no model is available they prompt (`ask`); if the toggle is off, fallthroughs use `defaultAction`. See [`docs/auto-mode-design.md`](./docs/auto-mode-design.md) for the full design.

#### Call context sent to the classifier

Besides the action itself (tool + command/path/URL) and your `environment` facts, the classifier receives a **`Context:` block of facts about this specific call**:

- `Working directory: <cwd>` and whether it is inside a git working tree (with the repo root).
- For `read`/`write`/`edit`/`grep`/`glob`/`ls`: the **resolved absolute target path** and whether *it* is inside a git working tree.
- For `bash`: if the command starts with a literal `cd <dir>`, that directory and its git status — so the facts describe the repository actually being touched rather than the session cwd. For `pwsh`, the `cwd` argument is used the same way.

This exists because the raw action alone is often too thin to judge. A bare `Path: projects.md` gave the model no way to know the edit was reversible via git, so repo-local edits were soft-denied by the "Editing a file outside a source-controlled repository" rule. With the context block, `Editing files in a source-controlled repository` matches and the edit is allowed silently.

Repo detection is a **pure filesystem `.git` probe** walking up from the path — no `git` subprocess, so it stays fast. Consequence: an *untracked* file inside a repo still counts as "inside a git repository".

The context facts are part of the classifier's per-session verdict cache key, so a verdict from one directory is never reused in another.

#### Compound Bash in auto mode

When a compound Bash command (e.g. `cd foo && npm test && git status`) falls through to the auto layer, the classifier screens the **whole compound as a single command** — it sees the full context and emits one verdict for the entire chain, rather than judging each subcommand in isolation. This applies whenever the compound contains no static `ask` sub and no static `deny` sub (the common case where every sub is an `allow`/`auto` fall-through).

The safety invariants are preserved:

- A static `deny` sub still blocks the whole command up-front (the classifier is never consulted).
- A static `ask` sub still triggers the per-sub prompt loop, so user-authored "always prompt" rules fire exactly as in manual mode — the whole-compound shortcut never shadows them.

See also [Compound Bash commands](#compound-bash-commands) for the per-sub prompt behavior in manual mode.

When the per-sub loop *is* used, a leading `cd <dir>` from the full command is applied to each sub's context facts, so `cd /repo && git commit ...` is judged against `/repo`, not the session cwd.

#### Local git commits vs. pushing

The default NL lists split git by reversibility rather than by "writes vs. reads":

- **Allowed:** staging and committing locally (`git add`, `git commit`, `git stash`), creating/switching local branches and tags — all trivially undone via `git reset` / `git reflog`.
- **Soft-denied (prompt):** `git push` (publishes local work to a shared remote), and history rewrites or work-discarding operations (`git rebase`, `commit --amend`, `reset --hard`, `filter-branch`, `push --force`, deleting branches/stashes).

So `git add -A && git commit -m ...` runs silently, while anything that leaves your machine or destroys recoverable state still asks. Verdict precedence (`hard_deny > soft_deny > allow`) means a chain like `git commit && git push` correctly lands on the prompt.

### Ways to toggle

| Method | Action |
| ------ | ------ |
| **Ctrl+Alt+A** | Toggle on/off |
| Any permission dialog | Choose **"Switch to auto mode (this session)"** |
| `/permissions auto` | Toggle |
| `/permissions auto on\|off` | Set explicitly |

When active, a `🤖 auto mode on` indicator appears in the footer status bar.

The **"Switch to auto mode (this session)"** dialog option just flips the toggle — it's the same as the hotkey, but contextual (available right where you're already being prompted). It only appears when auto mode isn't already active.

### Config

```json
{
  "defaultAction": "ask",
  "autoMode": {
    "classifier": { "provider": "anthropic", "model": "claude-haiku-4-5" },
    "environment": [
      "Trusted repo: github.com/lucaspimentel/*",
      "Trusted domains: *.internal.example.com"
    ],
    "allow":     [
      "Running tests and linters",
      "Editing files in a source-controlled repository (changes are reversible via git)",
      "Read-only inspection commands (e.g. pwd, ls, cat, head, tail, wc, stat, file, du, df)",
      "Searching the codebase with grep, rg, find, or glob",
      "Running git status, git diff, git log, and other read-only git queries",
      "Read-only GitHub API requests (e.g. fetching files, listing issues, reading repos) via gh or the web API",
      "Read-only GitHub API call to fetch a file, not sending data or modifying remote state",
      "Read-only Atlassian API call to fetch a Jira issue",
      "Read-only Atlassian API call to fetch a Confluence page",
      "Read-only Confluence search query using CQL",
      "Assigns a string to a variable, no side effects",
      "Executes a no-op command that does nothing",
      "Read-only HTTP GET request to a public package registry (e.g. crates.io, npm, NuGet, PyPI, Maven Central, pkg.go.dev) to look up published versions or package metadata, not sending data or modifying remote state",
      "Fetching a public URL with curl or wget and parsing the response locally (e.g. with jq), in a loop or pipeline, without submitting data or writing files"
    ],
    "soft_deny": [
      "Force pushing, deleting remote branches",
      "Bulk or recursive file deletions (e.g. rm -rf, rm -r, Remove-Item -Recurse)",
      "Editing a file outside a source-controlled repository",
      "Creating a pull request or pushing a branch on GitHub via gh, modifying remote state"
    ],
    "hard_deny": ["Sending data to third-party APIs or external services for telemetry, analytics, or exfiltration (not normal GitHub dev actions like opening PRs or pushing branches via gh)"],
    "classifyAllShell": true
  }
}
```

| Field | Default | Purpose |
| ----- | ------- | ------- |
| `classifier` | _(auto-select)_ | Optional explicit model pin (`{ provider, model }`). If omitted, a haiku-tier model is auto-selected from the available pool, preferring the currently selected model's provider. |
| `environment` | `[]` | Free-text facts shown to the classifier (e.g. trusted repos/domains). Inherently user-specific — no default. |
| `allow` | See [`DEFAULT_AUTO_MODE.allow`](./index.ts) | NL descriptions of actions to silently allow. |
| `soft_deny` | See [`DEFAULT_AUTO_MODE.soft_deny`](./index.ts) | NL descriptions of actions to prompt for (with the classifier's reason). |
| `hard_deny` | `["Sending data to third-party APIs or external services for telemetry, analytics, or exfiltration (not normal GitHub dev actions like opening PRs or pushing branches via gh)"]` | NL descriptions of actions to always block. |
| `classifyAllShell` | `true` | When `true`, route every bash command (including read-only auto-allowed ones) through the classifier. Compounds with no static `ask`/`deny` sub are classified as one whole command; compounds containing a static `ask` sub still prompt per-sub. |

The `allow` / `soft_deny` / `hard_deny` lists and `classifyAllShell` have **sane defaults** baked in — a bare `{ "autoMode": { ... } }` (or no `autoMode` block at all) works out of the box once the session toggle is on. Your configured lists are **additive** on top of the defaults (concatenated + deduped), so you can extend them without losing the safe baseline. `classifier` and `environment` have no defaults — they're inherently user-specific. To override `classifyAllShell` back to `false`, set it explicitly.

`defaultAction` is independent of auto mode: it's the terminal fallback (`allow` / `deny` / `ask`) used when the classifier returns `no_match` (or when the toggle is off). The `autoMode` block configures the classifier itself.

In non-interactive modes (`-p`, JSON mode), classifier `soft_deny` verdicts fall back to **deny** (can't prompt); `no_match` falls through to `defaultAction` (so automation respects the user's terminal default).

See [`docs/auto-mode-design.md`](./docs/auto-mode-design.md) for the full design.

## How it works

The extension subscribes to pi's `tool_call` event, evaluates the rules, and either lets the call through, returns `{ block, reason }`, or pops a `ctx.ui.select` dialog. See [pi extension docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md) for the underlying API.
