---
description: Clean up worktrees and branches in ~/source/datadog that are already merged
argument-hint: "[repo-or-filter]"
---
Clean up merged worktrees under `~/source/datadog/`. Scope: if arguments were given ($@), only consider worktrees whose path contains that text; otherwise consider all of them.

Run everything through `host_bash`: the paths are outside the sandbox mounts and the checks need network (`gh`, fetches).

## Candidates

Worktree directories follow two naming forms next to their main clone:

- `<repo>--<branch>` (current convention, e.g. `dd-trace-rs--lpimentel-extract-trace-propagation`)
- `<repo>.<branch>` (older convention, e.g. `dd-trace-py.storms-improve-az-durable-orchestrator-tracing`)

Ignore plain repo clones and anything that is not a git worktree (verify with `git -C <dir> rev-parse --git-common-dir` and comparing against the dir's own `.git`).

## Per-worktree checks

For each candidate, gather, without changing anything:

1. Branch: `git -C <dir> branch --show-current` (note detached HEAD if empty).
2. Cleanliness: `git -C <dir> status --porcelain` (empty means clean; untracked files count as dirty).
3. Unpushed work: `git -C <dir> log --oneline @{u}..` after `git -C <dir> fetch origin` (any output means unpushed commits; a missing upstream counts as unpushed).
4. Merged status: find the real owner/repo with `git -C <dir> remote get-url origin` (folder names are not reliable owners), then `gh pr list -R <owner>/<repo> --head <branch> --state merged --json number,mergedAt`. If gh returns 403 (work EMU repos need the work account), report the worktree as "needs manual check" instead of switching accounts or deleting.
5. Squash merges are the norm: git ancestry (`git branch --merged`) will NOT show them as merged. Rely on the PR state from step 4, not ancestry.

## Removal policy

Delete a worktree and its branch only when ALL of: clean tree, no unpushed commits, and PR confirmed merged (or branch fully merged into the remote default branch for non-PR branches). Otherwise keep it and say why.

- Remove with `git -C <main-clone-path> worktree remove <worktree-path>`.
- Delete the branch with `git -C <main-clone-path> branch -d <branch>`. Never `-D`; if `-d` refuses, the branch is not merged, keep it and report.
- If a check is ambiguous or a command errors, keep that worktree and move on.

## Report

End with a compact table: worktree, branch, PR (number or "none"), action taken (removed / kept + reason). Do not touch remote branches.
