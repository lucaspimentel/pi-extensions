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
