---
name: update-github-actions
description: "Update outdated GitHub Actions in workflow files and pin them to commit hashes for supply-chain security. Use when the user says 'update github actions', 'update actions', 'bump github actions', 'update workflow actions', 'pin github actions', 'update action versions', 'bump action versions', 'update workflow dependencies', 'pin actions to sha', or any variation of wanting to update or pin GitHub Actions used in .github/workflows."
disable-model-invocation: true
allowed-tools: Bash(gh api *)
---

Update GitHub Actions in workflow files to their latest versions, pinned by commit SHA for security and reproducibility.

## Step 1 — Find workflow files

Glob for `.github/workflows/*.yml` and `.github/workflows/*.yaml`. Read each file. If none are found, inform the user and stop.

## Step 2 — Extract action references

For each workflow file, find all `uses:` lines that reference actions in `owner/repo@ref` format. Ignore:
- Local actions (paths starting with `./`)
- Docker actions (paths starting with `docker://`)
- Reusable workflow references (paths containing `.github/workflows/`)
- Actions already pinned to a full 40-character SHA

Build a deduplicated list of actions with their current refs (e.g. `actions/checkout@v4`).

## Step 3 — Resolve latest versions and commit SHAs

For each unique action, determine the latest version tag within the same major version and resolve its commit SHA. If any `gh api` call fails (auth error, rate limit, repo not found), skip that action with a warning rather than aborting the entire process.

### 3a — Find the latest tag for the current major version

Extract the major version from the current ref (e.g. `@v4` → major `4`, `@v3.2.1` → major `3`). Then find the latest release whose tag matches the same major version:

```bash
gh api repos/{owner}/{repo}/releases --jq '[.[] | select(.tag_name | test("^v{major}([.]|$)"))][0].tag_name'
```

If no matching release exists, fall back to listing tags:

```bash
gh api repos/{owner}/{repo}/tags --jq '[.[] | select(.name | test("^v{major}([.]|$)"))][0].name'
```

If both return empty, skip the action and report "no matching releases found" in the results table.

### 3b — Resolve the tag to a commit SHA

Fetch the git ref and check its object type in a single call:

```bash
gh api repos/{owner}/{repo}/git/ref/tags/{tag} --jq '.object | "\(.type) \(.sha)"'
```

If the type is `commit`, use the SHA directly. If the type is `tag` (annotated tag), dereference it:

```bash
gh api repos/{owner}/{repo}/git/tags/{sha} --jq '.object.sha'
```

## Step 4 — Present proposed changes

Show the user a table of proposed updates before applying anything. Exclude actions that are already at the latest version/SHA.

| Workflow file | Action | Current ref | New pinned ref |
|---|---|---|---|

Ask the user to confirm before proceeding. If the user wants to skip specific actions, respect that.

## Step 5 — Apply updates

For each confirmed action reference, update the `uses:` line to the pinned format with a tag comment for readability:

```yaml
# Before
uses: actions/checkout@v4

# After
uses: actions/checkout@<full-sha> # v4.2.2
```

The comment after the SHA shows the tag name so humans can tell which version is pinned at a glance.

Do not commit or push changes unless also asked to do so.
