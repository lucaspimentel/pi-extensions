# TODO

- [ ] Normalize Windows paths when running Bash under Git Bash / MSYS / Cygwin
  - Affects path comparisons in `index.ts`: `normalizePathSep` (~199), `normalizeMatchPath` (~208), `cwdRecursiveGlob` (~218), `isNoopCd` (~265–268), and bash subcommand path extraction.
  - Under Git Bash, paths can appear as `/c/Users/...`, `/d/source/...`, `~`, or mixed `C:/...` vs `C:\...`. The current `normalizePathSep` only swaps separators — it doesn't unify drive prefixes, so cwd `C:\Users\foo` won't match a bash arg like `/c/Users/foo`.
  - Reference implementation patterns (use `cygpath` to canonicalize):
    - `D:\source\lucaspimentel\claude-plugins\plugins\lucas-dev-tools\scripts\pretool-bash-rules.sh` — the `redundant-cd` rule uses `cygpath -w "$path"` to normalize both cwd and target before comparison.
    - `D:\source\lucaspimentel\claude-plugins\plugins\lucas-dev-tools\skills\copy-pwd\SKILL.md` — uses `cygpath -wa .` to convert MSYS paths to Windows form.
  - Detect Git Bash via env (`MSYSTEM` is `MINGW64`/`MINGW32`/`MSYS`, or `OSTYPE=msys`). Since the extension runs in Node, prefer a pure-JS normalizer (handle `/c/...` → `C:/...`, `~` → home, forward/back slashes, drive-letter casing) rather than shelling out to `cygpath` on every check; fall back to `cygpath` only if needed.
  - Add tests covering: `/c/Users/...` style args, `~`-prefixed paths, mixed slash directions, and drive-letter case differences. Extend `test-bash.mjs` and `test-rules-and-decide.mjs`.

- [ ] Auto-allow reading `AGENTS.md` / `CLAUDE.md` in parent directories by default
  - Allow `Read` calls for `AGENTS.md` and `CLAUDE.md` in the current working directory and every ancestor directory up to the filesystem root, even when the file is outside the recursive `Read(<cwd>/**)` implicit allow.
  - Likely implement in `loadConfig()` in `index.ts` alongside the existing implicit `Read(${cwdGlobPattern(cwd)})` injection; add exact-path implicit allow rules for each ancestor's `AGENTS.md` and `CLAUDE.md` rather than broad parent-directory globs.
  - Consider an opt-out config flag if needed, and document the behavior in the header docs, `README.md`, and `pi-tool-permissions.example.json`.
  - Add tests in `test-loadconfig.mjs` / `test-read-write-edit.mjs` (and sync `test-helpers.mjs`) covering parent `AGENTS.md` / `CLAUDE.md` allowed, unrelated parent files still denied/asked, and behavior at drive/root boundaries.

- [ ] Evaluate switching multi-step Bash breakdown indicators to emoji
  - Follow-up to the breakdown marker-placement task. The current rendering uses ASCII-safe action glyphs (`[✓]` / `[✗]` / `[?]`) plus a leading `»` (U+00BB) for the active step — see `actionIcon` / `formatBreakdownLine` / `formatBreakdown` in `index.ts` (mirrored in `test-helpers.mjs`).
  - Consider replacing the glyphs with emoji for readability: e.g. `✅` (allow), `❌` or `🚫` (deny), `❓` (ask), `👉` (current step). The `actionIcon` indirection was added specifically so this swap is local to that helper.
  - Investigate terminal/TUI compatibility first: emoji width is often reported as 1 cell but renders as 2, which can break the column-alignment invariant exercised by the `icon column aligned across current/non-current` test in `test-bash.mjs`. Check how pi's TUI (`ctx.ui.select` title block) handles wide characters and whether other extensions already emit emoji.
  - Decide whether the current marker (`»`) should also become an emoji (`👉`) — if so, the gutter width logic in `formatBreakdownLine` will need to account for emoji display width, not just code-point count. Either keep the gutter in cells (using a width helper) or use a leading emoji + space and accept that the icon column shifts when the marker is present (drop the alignment test).
  - If proceeding: update `actionIcon` and the gutter logic in both `index.ts` and `test-helpers.mjs`, refresh the `formatBreakdown — rendering` tests in `test-bash.mjs` (icon assertions, alignment invariant), and consider a config flag (e.g. `breakdownEmoji?: boolean`) so users on emoji-hostile terminals can opt out. Document the flag in the header block, `README.md`, and `pi-tool-permissions.example.json`.

- [ ] Add an interactive settings UI via `SettingsList` for the implicit-allow toggles
  - Pi doesn't expose a first-class "extension settings" API (see `docs/settings.md`, `docs/sdk.md`, `docs/extensions.md`) — each extension owns its own JSON config. pi-tool-permissions already does this via `~/.pi/agent/pi-tool-permissions.json` (user, with a legacy fallback at `~/.pi/tool-permissions.json`) and `<cwd>/.pi/pi-tool-permissions.json` (project, with a legacy fallback at `<cwd>/.pi/tool-permissions.json`). What's missing is an in-TUI editor; users currently have to hand-edit JSON or rely on `/permissions list`.
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
