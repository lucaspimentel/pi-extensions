# TODO

- [x] Auto-allow read-only tools (grep, ls, glob, etc.) in pwd and subdirectories recursively
  - Today only `Read` gets the implicit `Read(<cwd>/**)` allow rule via `readAllowCwd` (see `index.ts` lines ~95, 115, 155–176, and `cwdRecursiveGlob` at ~218–220).
  - Extend the same pattern to other read-only tools: `grep`, `glob`, and bash read-only commands (`ls`, `cat`, `head`, `tail`, `pwd`, `find` without `-delete/-exec`, `wc`, `file`, `stat`, etc.).
  - For `grep`/`glob` the match field is already `path` (defaults to cwd) — see `getMatchField` near line 333 and `pathRuleString` near line 634, so injecting `Grep(<cwd>/**)` / `Glob(<cwd>/**)` mirrors the existing Read injection.
  - For Bash, decide whether to add a curated allow-list of read-only commands evaluated per subcommand (the compound-bash splitter already exists — see header docs and `decide`/`bash` handling near line 572 / 612), or expose a config flag like `bashReadOnlyAllowCwd`.
  - Make it opt-out via config keys (e.g. `grepAllowCwd`, `globAllowCwd`, `bashReadOnlyAllowCwd`), defaulting to `true` like `readAllowCwd`, and document in the header block + `tool-permissions.example.json` + `README.md`.
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
  - Consider an opt-out config flag if needed, and document the behavior in the header docs, `README.md`, and `tool-permissions.example.json`.
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

- [ ] Auto-allow pi to read its own skill files by default
  - Skill files are commonly outside the project cwd (e.g. under `~/.pi/agent/git/.../skills/<skill>/SKILL.md`), so they are not covered by the existing implicit `Read(<cwd>/**)` allow in `loadConfig()`.
  - Add a safe default that permits `Read` calls for pi-managed skill files needed by the agent, ideally scoped to known skill directories / `SKILL.md` files rather than broad access to all of `~/.pi`.
  - Consider whether this should be implemented as implicit exact `Read(...)` rules discovered from registered skill metadata, a constrained glob such as `~/.pi/agent/**/skills/**/SKILL.md`, or both Windows/Unix-normalized variants.
  - Document the behavior and add tests in `test-loadconfig.mjs` / `test-read-write-edit.mjs` (and sync `test-helpers.mjs`) covering skill files allowed while unrelated files in the same tree remain subject to normal permissions.

- [ ] Auto-allow the built-in `Ls` tool in pwd and subdirectories recursively
  - Gap in the previously-completed first item: that task said "grep, ls, glob, etc." but only `Read`/`Grep`/`Glob` got an implicit `<Tool>(<cwd>/**)` injection. The pi built-in `Ls` tool (distinct from the Bash `ls` subcommand handled via `READONLY_BASH_WITH_PATHS` in `index.ts` ~329) currently falls through to the default `ask` action.
  - Reference: `loadConfig()` in `index.ts` ~191–200 pushes `Read(${cwdGlobPattern(cwd)})`, `Grep(...)`, `Glob(...)` into `implicitAllow` — add `Ls(${cwdGlobPattern(cwd)})` the same way.
  - Add a `lsAllowCwd?: boolean` config key (default `true`) on `Config` (~107–119) and `LoadedConfig` (~133–142); resolve it in `loadConfig()` (~186–190) and surface it on `cfg.implicit` (~217). Mirror the `grepAllowCwd`/`globAllowCwd` shape exactly.
  - Update the `/permissions list` output (~1097–1100) to include `lsAllowCwd: ${cfg.implicit.lsAllowCwd}`.
  - Verify `Ls` uses a `path` match field (or whatever field `getMatchField`/`pathRuleString` already returns for it near lines 333 / 634) so `Ls(<cwd>/**)` actually matches built-in `ls` calls; if not, extend those helpers.
  - Document in the header block (`index.ts` ~37–54), `README.md`, and `tool-permissions.example.json`.
  - Add tests in `test-loadconfig.mjs` (implicit rule presence + opt-out) and a small case in `test-rules-and-decide.mjs` or a new `test-readonly-cwd.mjs` confirming an `Ls` call inside cwd is auto-allowed and one outside still asks/denies. Sync `test-helpers.mjs` and wire into `run-all.mjs`.

- [ ] Improve multi-step Bash breakdown indicators and current-step marker placement
  - In `index.ts`, the compound Bash permission dialog builds `breakdownLines` in the `isCompound` prompt loop and currently renders status icons like `[✓]`, `[?]`, `[✗]` plus a trailing current-step marker (`◄`) after the command text.
  - Move the current-step marker to the left side of the line so the active step is visible before long command text, e.g. `▶ [?] git commit ...` or `👉 [?] git commit ...`.
  - Decide whether to keep plain symbols for terminal compatibility or switch to emoji indicators (`✅`, `❌`/`🚫`, `❓`, `👉`) for readability; consider alignment, monospace width variance, and fallback behavior in terminals that render emoji poorly.
  - Add/update UI snapshot or string-building tests if available so the breakdown format remains stable.
