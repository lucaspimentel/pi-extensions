# TODO

- [x] Auto-allow read-only tools (grep, ls, glob, etc.) in pwd and subdirectories recursively
  - Today only `Read` gets the implicit `Read(<cwd>/**)` allow rule via `readAllowCwd` (see `index.ts` lines ~95, 115, 155–176, and `cwdRecursiveGlob` at ~218–220).
  - Extend the same pattern to other read-only tools: `grep`, `glob`, and bash read-only commands (`ls`, `cat`, `head`, `tail`, `pwd`, `find` without `-delete/-exec`, `wc`, `file`, `stat`, etc.).
  - For `grep`/`glob` the match field is already `path` (defaults to cwd) — see `getMatchField` near line 333 and `pathRuleString` near line 634, so injecting `Grep(<cwd>/**)` / `Glob(<cwd>/**)` mirrors the existing Read injection.
  - For Bash, decide whether to add a curated allow-list of read-only commands evaluated per subcommand (the compound-bash splitter already exists — see header docs and `decide`/`bash` handling near line 572 / 612), or expose a config flag like `bashReadOnlyAllowCwd`.
  - Make it opt-out via config keys (e.g. `grepAllowCwd`, `globAllowCwd`, `bashReadOnlyAllowCwd`), defaulting to `true` like `readAllowCwd`, and document in the header block + `pi-tool-permissions.example.json` + `README.md`.
  - Add tests in `test-grep-glob.mjs` and `test-bash.mjs` (and possibly a new `test-readonly-cwd.mjs`); wire into `run-all.mjs`.

- [ ] Normalize Windows paths when running Bash under Git Bash / MSYS / Cygwin
  - Affects path comparisons in `index.ts`: `normalizePathSep` (~199), `normalizeMatchPath` (~208), `cwdRecursiveGlob` (~218), `isNoopCd` (~265–268), and bash subcommand path extraction.
  - Under Git Bash, paths can appear as `/c/Users/...`, `/d/source/...`, `~`, or mixed `C:/...` vs `C:\...`. The current `normalizePathSep` only swaps separators — it doesn't unify drive prefixes, so cwd `C:\Users\foo` won't match a bash arg like `/c/Users/foo`.
  - Reference implementation patterns (use `cygpath` to canonicalize):
    - `D:\source\lucaspimentel\claude-plugins\plugins\lucas-dev-tools\scripts\pretool-bash-rules.sh` — the `redundant-cd` rule uses `cygpath -w "$path"` to normalize both cwd and target before comparison.
    - `D:\source\lucaspimentel\claude-plugins\plugins\lucas-dev-tools\skills\copy-pwd\SKILL.md` — uses `cygpath -wa .` to convert MSYS paths to Windows form.
  - Detect Git Bash via env (`MSYSTEM` is `MINGW64`/`MINGW32`/`MSYS`, or `OSTYPE=msys`). Since the extension runs in Node, prefer a pure-JS normalizer (handle `/c/...` → `C:/...`, `~` → home, forward/back slashes, drive-letter casing) rather than shelling out to `cygpath` on every check; fall back to `cygpath` only if needed.
  - Add tests covering: `/c/Users/...` style args, `~`-prefixed paths, mixed slash directions, and drive-letter case differences. Extend `test-bash.mjs` and `test-rules-and-decide.mjs`.

- [x] Handle backslash line-continuation (`\` at end of line) in bash command splitting
  - Example: `foo && \\\n bar` — currently the `\` escape handler in `splitTopLevelShell` (`index.ts` ~449–453) consumes `\` + the following `\n` as a literal escape pair, so the newline is *not* treated as a separator. For `foo \\\n bar` (no `&&`) the result is a single subcommand string containing an embedded `\\\n`, which can confuse downstream tokenization (arg extraction, path matching, `isNoopCd`, etc.).
  - Decide the correct semantics: a backslash immediately followed by a newline (outside single quotes) is shell line-continuation and should be *removed* (joining the two lines into one logical command), not preserved as a literal escape. The current code treats it the same as any other `\X` escape.
  - Fix likely lives in the backslash branch around `index.ts:449`: if `cmd[i+1] === "\n"` (or `\r\n`), drop both characters instead of appending them. Make sure this only applies outside single quotes (already gated) and consider double-quote context (POSIX: inside double quotes, `\<newline>` is also a line continuation).
  - Also revisit the newline split branch at ~539: once continuations are stripped earlier, the remaining bare newlines correctly act as separators.
  - Add tests in `test-bash.mjs` covering: `foo && \\\n bar` (compound, should split into `foo` and `bar`), `foo \\\n bar` (single command `foo bar`), continuation inside double quotes, and a literal `\` followed by a non-newline char (must remain an escape, not a continuation).

- [ ] Improve `for` loop handling in Bash permission splitting
  - For multiline Bash loops like `for x in ...; do <command>; done` / `for x in ...\ndo <command>\ndone`, do not ask for permissions on structural shell keywords (`for`, `do`, `done`); only evaluate the actual command(s) inside the loop body.
  - Likely touches `splitTopLevelShell` and compound handling in `index.ts` (around the operator/newline splitter and `decideCompound`), because top-level newlines currently become split points and `decideCompound` evaluates every resulting part.
  - Keep `test-helpers.mjs` in sync with `index.ts` and add coverage in `test-bash.mjs` for multiline `for` loops, including a read-only/allowed body and an ask/deny body.

- [ ] Handle Bash output redirection (`>`, `>>`, `2>`, `&>`) as a write-risk operation
  - `index.ts` already has `hasTopLevelOutputRedirect()` and uses it to prevent auto-allowing commands in `isReadOnlyBashSubcommand()`, but explicit broad allow rules such as `Bash(rg *)` could still allow `rg "x" > results.txt` because `rg` is evaluated as a normal single Bash command.
  - Consider detecting top-level output redirection during Bash permission evaluation and treating the command as write-risk: force `ask`, match/evaluate as a write-like operation, or require a separate explicit allow rule for redirected output paths.
  - Preserve shell parsing safety: respect quotes/escapes/heredocs like the compound splitter does, and add tests for `>`, `>>`, descriptor redirects, quoted `>` literals, pipes to `tee`, and compound commands where only one subcommand redirects.
  - Special-case stderr-to-stdout redirects as read-only/no-write-risk because models commonly use them for combined output capture/logging: e.g. `2>&1`, `1>&2`? Decide exact scope carefully, but `2>&1` should not be treated like writing to a file.

- [ ] Auto-allow reading `AGENTS.md` / `CLAUDE.md` in parent directories by default
  - Allow `Read` calls for `AGENTS.md` and `CLAUDE.md` in the current working directory and every ancestor directory up to the filesystem root, even when the file is outside the recursive `Read(<cwd>/**)` implicit allow.
  - Likely implement in `loadConfig()` in `index.ts` alongside the existing implicit `Read(${cwdGlobPattern(cwd)})` injection; add exact-path implicit allow rules for each ancestor's `AGENTS.md` and `CLAUDE.md` rather than broad parent-directory globs.
  - Consider an opt-out config flag if needed, and document the behavior in the header docs, `README.md`, and `pi-tool-permissions.example.json`.
  - Add tests in `test-loadconfig.mjs` / `test-read-write-edit.mjs` (and sync `test-helpers.mjs`) covering parent `AGENTS.md` / `CLAUDE.md` allowed, unrelated parent files still denied/asked, and behavior at drive/root boundaries.

- [ ] Add an “Allow ALL steps once” option for multi-step Bash permission prompts
  - In `index.ts`, compound Bash handling currently prompts each `ask` subcommand one-by-one inside the `isCompound` branch around the `ctx.ui.select()` dialog; choices are `Allow once`, `Allow always (save rule)`, `Deny once`, and `Deny always (save rule)`.
  - Add a one-time option that permits every remaining `ask` step in the current multi-step Bash command without saving rules, while preserving explicit `deny` behavior from `decideCompound()`.
  - Keep wording distinct from persistent rule saves (e.g. “Allow ALL steps once”), and consider whether selecting it on any subcommand should immediately allow the whole compound command or only skip remaining ask prompts.
  - Add coverage in `test-bash.mjs` or a UI-focused test if available for compounds with multiple ask steps, mixed allow/ask steps, and deny-containing compounds.

- [ ] Re-apply newly saved Bash rules to remaining steps in the same multi-step command
  - In `index.ts`, the compound Bash prompt loop iterates over `breakdown.filter((b) => b.action === "ask")`, so the set of prompts is fixed before any `Allow always (save rule)` / `Deny always (save rule)` choice updates the config.
  - After saving a new allow/deny rule and reloading `cfg`, re-evaluate remaining subcommands so newly matching steps are skipped/allowed or blocked without asking again in the same Bash command.
  - Preserve the current behavior for the step that was just approved/denied, and handle interactions with the planned “Allow ALL steps once” option.
  - Add tests or UI harness coverage for commands with repeated similar steps (e.g. two `git status`/`npm`-style subcommands) where saving a rule on the first prompt affects the later prompts.

- [x] Auto-allow pi to read its own skill files by default
  - Skill files are commonly outside the project cwd (e.g. under `~/.pi/agent/git/.../skills/<skill>/SKILL.md`), so they are not covered by the existing implicit `Read(<cwd>/**)` allow in `loadConfig()`.
  - Add a safe default that permits `Read` calls for pi-managed skill files needed by the agent, ideally scoped to known skill directories / `SKILL.md` files rather than broad access to all of `~/.pi`.
  - Consider whether this should be implemented as implicit exact `Read(...)` rules discovered from registered skill metadata, a constrained glob such as `~/.pi/agent/**/skills/**/SKILL.md`, or both Windows/Unix-normalized variants.
  - Document the behavior and add tests in `test-loadconfig.mjs` / `test-read-write-edit.mjs` (and sync `test-helpers.mjs`) covering skill files allowed while unrelated files in the same tree remain subject to normal permissions.

- [x] Auto-allow the built-in `Ls` tool in pwd and subdirectories recursively
  - Gap in the previously-completed first item: that task said "grep, ls, glob, etc." but only `Read`/`Grep`/`Glob` got an implicit `<Tool>(<cwd>/**)` injection. The pi built-in `Ls` tool (distinct from the Bash `ls` subcommand handled via `READONLY_BASH_WITH_PATHS` in `index.ts` ~329) currently falls through to the default `ask` action.
  - Reference: `loadConfig()` in `index.ts` ~191–200 pushes `Read(${cwdGlobPattern(cwd)})`, `Grep(...)`, `Glob(...)` into `implicitAllow` — add `Ls(${cwdGlobPattern(cwd)})` the same way.
  - Add a `lsAllowCwd?: boolean` config key (default `true`) on `Config` (~107–119) and `LoadedConfig` (~133–142); resolve it in `loadConfig()` (~186–190) and surface it on `cfg.implicit` (~217). Mirror the `grepAllowCwd`/`globAllowCwd` shape exactly.
  - Update the `/permissions list` output (~1097–1100) to include `lsAllowCwd: ${cfg.implicit.lsAllowCwd}`.
  - Verify `Ls` uses a `path` match field (or whatever field `getMatchField`/`pathRuleString` already returns for it near lines 333 / 634) so `Ls(<cwd>/**)` actually matches built-in `ls` calls; if not, extend those helpers.
  - Document in the header block (`index.ts` ~37–54), `README.md`, and `pi-tool-permissions.example.json`.
  - Add tests in `test-loadconfig.mjs` (implicit rule presence + opt-out) and a small case in `test-rules-and-decide.mjs` or a new `test-readonly-cwd.mjs` confirming an `Ls` call inside cwd is auto-allowed and one outside still asks/denies. Sync `test-helpers.mjs` and wire into `run-all.mjs`.

- [ ] When saving an "always allow/deny" rule, let the user choose project-level or user-level
  - In `index.ts`, `addRule()` (~1061–1066) always writes to the project config via `saveProjectConfig(cwd, ...)`. When the user picks `Allow always (save rule)` or `Deny always (save rule)` (~963–986, ~1008–1041), add a follow-up prompt asking where to save: `Project (<cwd>/.pi/tool-permissions.json)` or `User (~/.pi/agent/pi-tool-permissions.json)`.
  - Add a `saveUserRule(action, rule)` helper mirroring `addRule` but reading/writing `USER_CONFIG` (`~146`), alongside the existing `loadProjectConfigRaw` / `saveProjectConfig` helpers.
  - All four "always" call-sites invoke `addRule(ctx.cwd, ...)` — update each to branch on the user's scope choice; keep the project path as the default so existing behavior is unchanged if the prompt is skipped somehow.
  - Add tests in `test-rules-and-decide.mjs` covering: rule saved to project config (existing behavior), rule saved to user config, and subsequent `loadConfig()` merging both.

- [x] Improve multi-step Bash breakdown indicators and current-step marker placement
  - In `index.ts`, the compound Bash permission dialog builds `breakdownLines` in the `isCompound` prompt loop and currently rendered status icons like `[✓]`, `[?]`, `[✗]` plus a trailing current-step marker (`◄`) after the command text.
  - Done: extracted `actionIcon` / `formatBreakdownLine` / `formatBreakdown` helpers in `index.ts` (mirrored in `test-helpers.mjs`); moved the current-step marker to the left side using a fixed 3-char gutter (`" » "` for the current row, `"   "` otherwise) so the action-icon column stays aligned. Used `»` (U+00BB) for the current-step marker — single-cell on every terminal and doesn't collide with the `>` shell-redirect operator. Kept ASCII glyphs (`✓` / `✗` / `?`) for the per-row action icons — see the follow-up TODO below for the emoji variant.
  - Tests added in `test-bash.mjs` under `formatBreakdown — rendering` (17 cases) covering icon mapping, gutter widths, column alignment regression guard, multi-row joining, exactly-one-marker invariant, `null`-currentSub case, and empty input.

- [ ] Evaluate switching multi-step Bash breakdown indicators to emoji
  - Follow-up to the breakdown marker-placement task above. The current rendering uses ASCII-safe action glyphs (`[✓]` / `[✗]` / `[?]`) plus a leading `»` (U+00BB) for the active step — see `actionIcon` / `formatBreakdownLine` / `formatBreakdown` in `index.ts` (mirrored in `test-helpers.mjs`).
  - Consider replacing the glyphs with emoji for readability: e.g. `✅` (allow), `❌` or `🚫` (deny), `❓` (ask), `👉` (current step). The `actionIcon` indirection was added specifically so this swap is local to that helper.
  - Investigate terminal/TUI compatibility first: emoji width is often reported as 1 cell but renders as 2, which can break the column-alignment invariant exercised by the `icon column aligned across current/non-current` test in `test-bash.mjs`. Check how pi’s TUI (`ctx.ui.select` title block) handles wide characters and whether other extensions already emit emoji.
  - Decide whether the current marker (`»`) should also become an emoji (`👉`) — if so, the gutter width logic in `formatBreakdownLine` will need to account for emoji display width, not just code-point count. Either keep the gutter in cells (using a width helper) or use a leading emoji + space and accept that the icon column shifts when the marker is present (drop the alignment test).
  - If proceeding: update `actionIcon` and the gutter logic in both `index.ts` and `test-helpers.mjs`, refresh the `formatBreakdown — rendering` tests in `test-bash.mjs` (icon assertions, alignment invariant), and consider a config flag (e.g. `breakdownEmoji?: boolean`) so users on emoji-hostile terminals can opt out. Document the flag in the header block, `README.md`, and `pi-tool-permissions.example.json`.

- [ ] Add an interactive settings UI via `SettingsList` for the implicit-allow toggles
  - Pi doesn't expose a first-class "extension settings" API (see `docs/settings.md`, `docs/sdk.md`, `docs/extensions.md`) — each extension owns its own JSON config. pi-tool-permissions already does this via `~/.pi/agent/pi-tool-permissions.json` (user, with a legacy fallback at `~/.pi/tool-permissions.json`) and `<cwd>/.pi/tool-permissions.json` (project). What's missing is an in-TUI editor; users currently have to hand-edit JSON or rely on `/permissions list`.
  - Add a new subcommand (e.g. `/permissions settings`) that opens `SettingsList` from `@earendil-works/pi-tui` with `getSettingsListTheme()` (see `docs/tui.md` Pattern 3 and `examples/extensions/tools.ts`). Expose the existing boolean knobs as toggleable rows:
    - `readAllowCwd`, `grepAllowCwd`, `globAllowCwd`, `lsAllowCwd`
    - `readAllowSkills`, `bashReadOnlyAllowCwd`, `allowNoopCd`
    - Any future flags (e.g. `breakdownEmoji?` from the emoji-indicator TODO).
  - On each change: persist via the existing `saveProjectConfig` helper (or a new `saveUserConfig` helper — see the "project-level vs user-level" TODO) and reload via `loadConfig(ctx.cwd)`. Ask the user once at open time which scope to edit (project vs user) so the chosen target is unambiguous.
  - Keep the existing `/permissions list` read-only output — `settings` is for editing, `list` is for inspecting. Make sure both stay in sync after a settings change (re-render or notify on save).
  - Document the new subcommand in the header block of `index.ts` and `README.md`. Tests: cover the persistence side (round-trip toggle through `saveProjectConfig` / `loadConfig`) in `test-loadconfig.mjs` or `test-rules-and-decide.mjs`; the TUI side is hard to unit-test — a manual smoke test is acceptable.

- [ ] Auto-allow reading skills from any registered location (not just canonical roots)
  - Gap in the completed `readAllowSkills` work (commit `d38f0e1`): `skillReadGlobs(home)` in `index.ts` (~304) only covers `~/.pi/agent/skills/**`, `~/.pi/agent/git/**/skills/**`, and `~/.agents/skills/**`. Skills registered from arbitrary locations — e.g. development checkouts like `D:\source\lucaspimentel\pi-extensions\skills\<name>\SKILL.md` — are not covered and still hit `ask` when pi auto-loads them.
  - Pi exposes each loaded skill's path in the system prompt's `<available_skills>` block via a `<location>` tag, so the information is available at runtime. Investigate whether pi's extension API (`@earendil-works/pi-coding-agent` — see `docs/sdk.md`, `docs/extensions.md`, `docs/skills.md`) surfaces skill metadata to extensions (e.g. on `ExtensionAPI` / `ExtensionContext`); if so, enumerate registered skills at extension init and inject exact `Read(<absolute-path-to-SKILL.md>)` rules per skill. Prefer exact paths over broad globs to keep scope tight.
  - If no such API exists, options are: (a) request one upstream, (b) parse the system prompt / agent state if accessible, or (c) widen `skillReadGlobs` to also include `<repo>/skills/**` when the project has a `skills/` folder (broader but discoverable from cwd alone). Lean toward (a)+(c) as a pragmatic combo.
  - Wire into the existing `readAllowSkills` flag rather than adding a new flag — it's the same conceptual feature, just a more complete implementation. Update the header docstring in `index.ts` (~61–68) and `README.md` to describe the broadened coverage.
  - Tests: extend `test-loadconfig.mjs` (and sync `test-helpers.mjs` — see `loadConfigFromObjects`'s optional `home` param) covering: a skill registered outside the canonical roots is auto-allowed, unrelated siblings in the same parent dir remain `ask`, and the existing canonical-root assertions still pass.

- [x] Auto-allow reading pi's own bundled docs by default
  - Pi ships its README + docs inside its globally-installed npm package, e.g. `~/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/README.md` and `~/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/docs/**`. These are outside any project cwd and outside the existing skill roots, so `Read` calls against them currently fall through to `ask` and create friction whenever the user asks pi about itself.
  - Mirror the existing `readAllowSkills` pattern in `index.ts`: the `skillReadGlobs(home)` helper (~304) returns a list of normalized glob patterns and `loadConfig()` (~226) pushes them into `implicitAllow` when the flag is on. Add a parallel `piDocsReadGlobs(home)` helper and a `readAllowPiDocs?: boolean` config key (default `true`).
  - Globs to cover (Windows + cross-platform npm layouts):
    - `<home>/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/**` (Windows global npm)
    - `<home>/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/**` and `<home>/.nvm/versions/node/*/lib/node_modules/@earendil-works/pi-coding-agent/**` (common Unix layouts)
    - Consider also `/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/**` and `/usr/lib/node_modules/...` for system-wide installs; these are not under `home` so decide whether to inject them unconditionally or skip.
  - Wire up the new flag everywhere the existing implicit flags appear: `Config` (~107–119) + `LoadedConfig` (~133–142) types, resolution in `loadConfig()` (~186–210), `cfg.implicit` surface (~247), and the `/permissions list` output (~1188). Mirror the shape of `readAllowSkills` exactly.
  - Document in the header block of `index.ts` (~37–68, near the existing `readAllowSkills` docs), `README.md`, and `pi-tool-permissions.example.json`.
  - Tests: extend `test-loadconfig.mjs` (and sync `test-helpers.mjs` if it duplicates the loader) covering the implicit globs being present when the flag is on, absent when off, and a `Read` decision inside the pi-coding-agent docs path being auto-allowed while unrelated files in `node_modules` still ask/deny. Wire any new test file into `run-all.mjs`.

- [ ] Rename project config file to `pi-tool-permissions.json` (with legacy fallback)
  - Today the project config lives at `<cwd>/.pi/tool-permissions.json` (constant `PROJECT_CONFIG_REL` in `index.ts` ~168). The user config has already been renamed to the pi-prefixed form (`USER_CONFIG = ~/.pi/agent/pi-tool-permissions.json`) with a legacy fallback (`LEGACY_USER_CONFIG = ~/.pi/tool-permissions.json`). The project file should follow the same convention for naming consistency across both scopes.
  - Add a new constant `PROJECT_CONFIG_REL = join(".pi", "pi-tool-permissions.json")` and a `LEGACY_PROJECT_CONFIG_REL = join(".pi", "tool-permissions.json")`. Update the reader (`loadProjectConfigRaw` and any other readers — grep for `PROJECT_CONFIG_REL` and the literal string `tool-permissions.json`) to mirror the user-config pattern: prefer the new file; fall back to the legacy file only when the new one is absent.
  - Update the writer / `saveProjectConfig` to always write to the new path. Decide whether to auto-migrate (rename old → new on first write) or leave the legacy file in place; auto-migrate is simpler for users.
  - Update the header-block docs in `index.ts` (~26–28 currently list `<cwd>/.pi/tool-permissions.json`), `README.md`, and `pi-tool-permissions.example.json`. Also update the related TODO entries that reference the project path (the "project-level vs user-level" TODO and the SettingsList TODO above).
  - Tests: extend `test-loadconfig.mjs` (and sync `test-helpers.mjs` if it duplicates the project-loader) covering: only-new-file present, only-legacy-file present (fallback works), both present (new wins), neither present, and round-trip via `saveProjectConfig` writing to the new name.
