# TODO

- [ ] Expand `DEFAULT_AUTO_MODE.allow` in `extensions/pi-tool-permissions/index.ts` with 5 new NL entries so the auto-mode classifier auto-allows more read-only/reversible actions out of the box (additive on top of user/project config):
	- `"Editing files in a source-controlled repository (changes are reversible via git)"` — covers `Edit` tool `no_match` prompts (e.g. "Editing a source file is not covered by the listed allow, soft deny, or hard deny rules."). Note: only affects `Edit`; `Write` has an implicit `toolDefaults["write"] = "ask"` guard (`index.ts:446`) that fires before the auto layer, so `Write` calls never reach the classifier. Covering `Write` is a separate change.
	- `"Read-only inspection commands (pwd, ls, cat, head, tail, wc, stat, file, du, df)"` — covers "Read-only inspection command that does not match any allow or deny rules."
	- `"Searching the codebase with grep, rg, find, or glob"` — covers "The command is a read-only search for a directory, not matching any allow or deny rules."
	- `"Running git status, git diff, git log, and other read-only git queries"`
	- `"Read-only GitHub API requests (e.g. fetching files, listing issues, reading repos) via gh or the web API"` — covers "The action is a read-only GitHub API request to fetch a file…"
  - Update the `allow` defaults table row in `extensions/pi-tool-permissions/README.md` (~line 545) to match.
  - Update 3 assertions in `extensions/pi-tool-permissions/test-rules-and-decide.mjs` (~lines 350, 363, 375) that check the default allow list. Introduce a `DEFAULT_ALLOW` constant at the top mirroring `DEFAULT_AUTO_MODE.allow` and use `DEFAULT_ALLOW.join("|")` (plain string concatenation, not template literals — a template-literal syntax error bit the last attempt) in the assertions.
  - Verify: `node run-all.mjs` (expect 145 passed, 0 failed, all 6 suites pass) and `npx tsc --noEmit` (clean).
