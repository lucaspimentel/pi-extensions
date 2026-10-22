---
description: Rebase current branch onto its parent branch, resolving conflicts
argument-hint: "[base-branch]"
---
Rebase this branch onto its parent branch using the git-rebase-parent script (`git rebase-parent` when on PATH, otherwise `~/.local/bin/git-rebase-parent.sh`):

1. The script requires a clean working tree and no rebase in progress; if the tree is dirty, commit or stash first (ask which if unsure).
2. Run the script with `--keep-on-conflict` (so conflicts stay in progress for you to fix) and `--no-push` (push only if explicitly asked). If a base branch argument was given ($@), pass it as `--parent <branch>`. Run it through `host_bash`: it fetches from origin, which the sandboxed bash cannot do.
3. The script resolves the parent itself: the `--parent` flag, then the open GitHub PR's base branch, then the repo's default branch. Trust that order; do not second-guess it with merge-base archaeology unless the script errors.
4. If the rebase stops on conflicts, resolve them preserving the intent of both sides, `git add` the resolved files, and `git rebase --continue`; repeat until the rebase completes. Then report what was rebased onto what.
