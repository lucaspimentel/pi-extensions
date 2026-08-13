---
name: ship
description: "Run one or more release actions: version, changelog, docs, commit, tag, push, watch, release. With no arguments, auto-detects needed actions from repo state and asks for confirmation. Use when the user says 'ship', 'ship it', 'ship <target>', 'version and push', 'tag and push', 'bump version and push', 'release', 'cut a release', 'publish', 'ship and watch', 'push and watch CI', 'tag and watch', or any combination of these release steps."
allowed-tools: Bash(git status *) Bash(git log *) Bash(git tag --list *) Bash(git rev-parse *) Bash(git diff *) Bash(gh run list *) Bash(gh run watch *) Bash(gh release list *) Bash(sleep *)
disable-model-invocation: true
---

Release automation skill. Load the repo's shipping config, parse the user's arguments, then run the requested actions in canonical order.

## 0 — Load repo config

1. Find the repo root: `git rev-parse --show-toplevel`
2. Look for `.ship.yml` at the repo root. Read it if found.

### If `.ship.yml` exists

Parse the YAML. The schema has two modes:

**Single-target** (no `targets` key):
```yaml
actions: [version, changelog, docs, commit, tag, push, watch, release]  # default: all 8
version-files:        # required if version action is enabled
  - Directory.Build.props
changelog-file: CHANGELOG.md    # default: CHANGELOG.md
tag-format: "v{version}"        # default: v{version}
```

**Multi-target** (has `targets` key):
```yaml
targets:
  <target-name>:
    actions: [...]
    version-files: [...]
    changelog-file: <path>
    tag-format: <format>
```

When `targets` is present, top-level keys are ignored. Each target has its own config.

**Defaults** for omitted keys:

| Key | Default |
|---|---|
| `actions` | all 8 actions |
| `version-files` | (none — must be specified if `version` is in actions) |
| `changelog-file` | `CHANGELOG.md` |
| `tag-format` | `v{version}` |

**Multi-target selection:**

1. If the user passed a target name as an argument, use it.
2. Otherwise, try to infer the target from changed files — run `git status --porcelain` and match paths against each target's `version-files` and `changelog-file`.
3. If exactly one target matches, show it and ask for confirmation.
4. If ambiguous or no match, present the target list and ask which to ship.
5. Load the selected target's config as the active config for this run.

### If `.ship.yml` does not exist — onboarding flow

Guide the user through creating a config:

1. **Auto-discover** (no user interaction needed):
   - Glob for version files: `Directory.*.props`, `**/*.csproj`, `package.json`, `.claude-plugin/marketplace.json`, `Cargo.toml`, `pyproject.toml`. For `.csproj` and `.props` files, grep for `<Version>` to confirm they declare a version.
   - Glob for `**/CHANGELOG.md`
   - Check for git tags: `git tag --list 'v*' --sort=-creatordate`
   - Check for GitHub releases: `gh release list --limit 1`
   - Detect multi-target signals: `marketplace.json` with multiple plugin entries, or multiple `CHANGELOG.md` files in separate directories

2. **Propose config** — show the user what was discovered and a proposed `.ship.yml`:
   - If version files found → include `version-files`
   - If no tags/releases → set `actions` to exclude `tag`, `watch`, `release`
   - If multi-target signals → use the `targets` structure
   - If nothing found → propose `actions: [commit, push]`

3. **Create and continue** — after user confirms (with any edits), create `.ship.yml` and proceed with the ship run. The file gets committed in the same run.

4. **If user declines** — proceed with the detected settings ephemerally for this run only. Remind the user they can create `.ship.yml` later.

## 1 — Parse arguments

Extract from the skill arguments:

- **Target name** (for multi-target repos): matches a key in the `targets` map
- **Action keywords**: `version`, `changelog`, `docs`, `commit`, `tag`, `push`, `watch`, `release` (case-insensitive)
- **Version specifier** (optional, only relevant when `version` is requested): one of
  - An explicit semver version like `2.0.0` or `1.5.0`
  - A semver keyword: `major`, `minor`, `patch`
  - Nothing (auto-determine — see version action below)

**Filter actions against config**: only actions listed in the config's `actions` list are allowed. If the user explicitly requests an action not in the config, warn them and ask whether to proceed.

If no action keywords are found, **auto-detect** actions based on repo state (only considering actions in the config's `actions` list):

1. **Check for uncommitted changes** — run `git status --porcelain`. If there are dirty/untracked files → add `commit`.
2. **Check for unpushed commits** — run `git log @{upstream}..HEAD --oneline 2>/dev/null`. If any commits are listed → add `push`. If there is no upstream (command fails) → also add `push` (need to set up tracking).
3. **Check for untagged version** (only if `tag` is in config actions) — read the current version from the config's `version-files` and check if a matching tag exists using the config's `tag-format` (`git tag --list '<formatted-tag>'`). If no matching tag → add `tag`.
4. **Auto-add watch** — if both `tag` and `push` are detected (either explicitly or via auto-detect), also add `watch` (pushing a tag typically triggers CI workflows).
5. **Auto-add release** — if both `changelog` and `watch` are in the action set (from explicit request or implicit rules), also add `release` (CI typically creates a GitHub release from the tag, and we should update it with changelog content).

Present the detected actions as a **multi-select checklist** so the user can toggle individual actions on or off. **Pre-select all detected actions.**

If no actions are detected, tell the user everything is up to date and stop.

**Implicit changelog**: If `version` is requested but `changelog` is not explicitly listed, add `changelog` automatically — version bumps should be logged. Only add if `changelog` is in the config's `actions` list.

**Implicit commit**: If any action that modifies files is requested (`version`, `changelog`, `docs`) but `commit` is not explicitly listed, add `commit` automatically — those file changes need to be committed. Only add if `commit` is in the config's `actions` list.

Reorder the requested actions into **canonical order**: version → changelog → docs → commit → tag → push → watch → release. Always execute in this order regardless of argument order.

## 2 — Early version resolution (if version requested)

If `version` is requested and no explicit version was given, resolve the target version **before running any actions**:

1. **Discover the current version** from the config's `version-files`. Read each file and extract the version using per-file-type parsing:
   - `*.csproj` / `Directory.Build.props` / `Directory.Packages.props` — `<Version>` or `<PackageVersion>` element
   - `package.json` — `"version"` field
   - `*.json` (structured data) — parse the JSON, find the object whose `name` field matches the active target name, then read its `"version"` field (e.g., in a `plugins` array)
   - `*.md` (markdown) — look for the target name in headings (e.g., `# target-name v1.2.3`) or in a markdown table row where the first column contains the target name, then extract the version string
   - `Cargo.toml` — `version` in `[package]`
   - `pyproject.toml` — `version` field

   **Multi-entry files**: Some files (e.g., `marketplace.json`, root `README.md`) contain version entries for multiple targets. When reading, match by the active target name to find the correct entry. When multiple files contain conflicting versions, ask the user which is authoritative.
2. **If a semver keyword was given** (`major`, `minor`, `patch`): compute the new version by incrementing that component of the current version.
3. **If no specifier at all**: auto-suggest by inspecting changes since the last version tag:
   - Run `git tag --list '<tag-format-glob>' --sort=-creatordate` (using the config's `tag-format` with `{version}` replaced by `*`) to find the latest version tag
   - Run `git diff <latest-tag>...HEAD --stat` to see what changed
   - If any breaking/major signal → suggest major
   - If new features or new files → suggest minor
   - Otherwise → suggest patch
   - **Ask the user to confirm** the suggested version before continuing

Print the resolved target version so the user can see it, then proceed.

## 3 — Execute actions in canonical order

Run only the requested actions, in order. Stop immediately on failure.

### version

Update the version string in **all** files listed in the config's `version-files`. For files that contain entries for multiple targets (e.g., a JSON file with multiple versioned entries, or a markdown table with multiple rows), update **only** the entry matching the active target — do not modify entries for other targets. The skill already knows how to parse and edit each file type. After editing, briefly list which files were updated.

### changelog

Delegate to the `update-changelog` skill. Pass the resolved version and the config's `changelog-file` path if it differs from the default `CHANGELOG.md`.

### docs

Delegate to the `update-docs` skill.

### commit

Delegate to the `git-commit` skill.

### tag

1. Use the resolved version from Section 2 if available; otherwise, read the current version from the config's `version-files`.
2. Format the tag using the config's `tag-format` (replace `{version}` with the actual version).
3. Create an annotated tag: `git tag -a <formatted-tag> -m "<formatted-tag>"`
4. Report the tag that was created.

### push

1. Check if the current branch has an upstream: `git rev-parse --abbrev-ref @{upstream}`
2. If no upstream: `git push -u origin HEAD`
3. Otherwise: `git push`
4. If the `tag` action was also requested in this run: `git push origin <formatted-tag>` (push only the specific tag, not all local tags)
5. **Never force-push.** If push fails due to diverged history, report the error and let the user decide.

### watch

1. Run `sleep 5` to allow GitHub to register the push event.
2. List recent workflow runs: `gh run list --limit 5 --json databaseId,name,status,event,createdAt`. If `gh` fails with an auth error, report the issue and skip the watch action.
3. Filter for runs that started within the last 60 seconds (compare `createdAt` to the current time).
4. If no runs found, run `sleep 5` and retry once. If still no runs, report "No CI workflows were triggered" and stop.
5. For each run, call `gh run watch --exit-status <id>` using the Bash tool's `timeout` parameter set to `600000` (10 minutes) to stream progress until completion. The `--exit-status` flag returns a non-zero exit code on failure, making pass/fail detection reliable.
6. Report final status (pass/fail) for each workflow.

### release

Update the GitHub release that CI created from the pushed tag with changelog content.

1. Read the changelog entry for the current version from the config's `changelog-file`.
2. Delegate to the `update-changelog` skill. Pass the formatted tag name as the version, the config's `changelog-file` path, and explicitly instruct it to **only update the GitHub release** — skip finding/inserting a changelog file entry (the `changelog` action already handled that earlier in this run). The skill should use `gh release edit` with the changelog entry content as release notes.
