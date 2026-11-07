# AGENTS.md

This file provides guidance to coding agents (Claude Code, pi) when working with code in this repository.

## What this is

A pi package: personal extensions for the [pi-coding-agent](https://github.com/earendil-works/pi) (`@earendil-works/pi-coding-agent`). It is loaded by pi, not run standalone. The `pi` key in `package.json` is the manifest: `pi.extensions` lists every extension entry point (single `.ts` files or directories with an `index.ts`) and `pi.prompts` lists prompt-template globs. A new extension or prompt directory must be added there to be loaded. `README.md` has a per-extension summary; keep it in sync when adding or changing one.

Pi core packages (`pi-coding-agent`, `pi-ai`, `pi-tui`, `pi-agent-core`, `typebox`) are peer dependencies. Only `html-to-text` is a real runtime dependency.

## Commands

```bash
npm ci                    # install (CI uses this)
npx tsc --noEmit          # typecheck (covers extensions/**/*.ts only; tests are not typechecked)
npm run test:ci           # CI suite (Node 22 and 26)
npm run test:guard        # guard suite (also runs the git-read and gh-read tests)
npm run test:gh-read      # also: test:git-read, test:jira, test:timestamps
node --test tests/<name>.test.mts   # single test file
node --test --test-name-pattern="<substring>" tests/<name>.test.mts   # single test
```

- Tests are `.mts` files run directly by Node (type stripping, no build step). Some guard tests are plain scripts run with `node tests/<file>.mts` instead of `node --test`; `package.json` scripts show which.
- **A new test file must be added to the `test:ci` script in `package.json`** (an explicit file list, not a glob), or CI will not run it. Add it to `test:guard` / the per-extension script too when relevant.
- When running tests from inside a pi session with guard active, prefix with `env -u PI_GUARD_INHERIT` (a subagent-inherited profile variable that otherwise changes guard behavior). Use `host_bash` if node is unavailable on the sandboxed PATH.
- `wt-tab-status` has its own legacy `.mjs` suite under its extension directory (`node run-all.mjs`); it is not part of `test:ci` apart from the `wt-tab-status-*` files in `tests/`.
- CI also installs `libseccomp-dev` because the guard sandbox compiles `extensions/guard/sandbox/launcher.c`.

## Architecture

- `extensions/` holds one extension per file or directory. `extensions/shared/` holds modules imported by several extensions (model pin, model selection, bounded spawn); use it rather than duplicating.
- `tests/` holds node-runnable harnesses, mostly one per extension area. Tests exercise the real TypeScript modules, usually with fake pi/`ExtensionAPI` objects and spawn-override seams (e.g. `setSpawnOverride` in `subagent/index.ts`) instead of real network or processes.
- `docs/*-design.md` are the settled designs for the larger extensions (guard, gh-read, git-read, jira, subagent panel, compact-tool-view). Read the relevant doc before changing behavior; code, tool descriptions, prompt guidelines, README, and tests are expected to stay consistent with it.
- `TODO.md` tracks planned work with file/line anchors and the verification steps for each item; check it before extending gh-read, subagent, guard, or compact-tool-view.
- `prompts/` holds package-level prompt templates; extensions can ship their own under `extensions/<name>/prompts/`.

### Big pieces

- **guard** (`extensions/guard/`): sandbox-first permission system. Registers `bash`, `host_bash`, `python`, `node`; sandboxed execution uses bubblewrap + seccomp (`sandbox/`), while `host_bash` runs on the host. Policy decision logic in `policy/` (profiles, rules, classifier, protected paths, inheritance) and tool implementations in `tools/`. Subagents inherit the parent profile via the `PI_GUARD_INHERIT` env var. See `extensions/guard/README.md` and `docs/guard-design.md`.
- **gh-read / git-read**: model-facing read-only tools that run an allowlisted subcommand as an argv-array child process, never through a shell. Each has `validate.ts` (allowlists and argument validation), `spawn.ts` (bounded execution), and `index.ts` (tool schema, description, `promptGuidelines`). gh-read adds `api.ts`/`api-spawn.ts`/`jq.ts`/`log-spawn.ts` for structured API operations with bounded paging and output caps. Adding an operation touches validation, schema, dispatch, prompt guidance, tests, README, and the design doc together (TODO.md lists the exact anchors).
- **subagent**: delegates to agents defined in `extensions/subagent/agents/` with isolated context; per-agent model pins come from `subagent.json` in pi's agent directory (default `~/.pi/agent/`).
- Several extensions read per-user config from `~/.pi/agent/` (model pins, state files); they are resolved at runtime, not stored here.

## Conventions

- Source files use tabs for indentation.
- Extensions are TypeScript with `strict` and `verbatimModuleSyntax: false`; imports use explicit `.ts` extensions (`allowImportingTsExtensions`).
- The operation/subcommand count should not be written in prose or test names (they go stale); use count-free wording.
