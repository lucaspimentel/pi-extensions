---
name: git-commit
description: "Commit pending changes to git, optionally pushing after. Use when the user says 'commit', 'commit my changes', 'commit all', 'commit everything', 'save my work to git', 'stage and commit', or any variation of wanting to create a git commit. Accepts an optional 'push' keyword to push after committing, and optionally specific file names or a description of what to commit."
---

Commit pending changes to git.
If the user's arguments include the keyword `push`, push the new commits after committing. Otherwise, do not push.

## Workflow

Start by running `git status` to check the current state.

### If anything is already staged

Commit exactly what is staged as a **single commit**. Do not split it into multiple commits, do not stage additional files, and do not unstage anything. The user has curated the staging area intentionally — respect it.

If the user provided an argument mentioning specific files but something different is staged, tell the user about the mismatch and ask how to proceed rather than silently changing the staging area.

### If nothing is staged

Analyze all pending changes (unstaged modifications, untracked files) and determine how to group them into logical commits. Consider:

- **File proximity**: changes in the same module/directory often belong together
- **Semantic cohesion**: related changes (e.g., a feature + its tests + its docs) should be one commit
- **Independence**: unrelated changes (e.g., a bug fix and a new feature) should be separate commits

Then stage and commit each group in sequence. If the user's argument narrows the scope (specific files, "all", etc.), honor that:
- Specific files or paths → stage and commit only those files (single commit)
- "all", "everything" → stage everything (`git add -A`) and split into logical commits if warranted
- If all changes are cohesive → a single commit is fine; don't split for the sake of splitting

## Commit messages
- Keep subject line concise (≤ 50 chars recommended)
- Write in imperative mood (e.g., use "Add feature", not "Added feature" or "Adds feature")
- Each commit should represent a single logical change

## Windows path handling
- If you are already in the correct directory, run `git` commands directly — don't prepend `cd <path> &&`.
- In git bash on Windows, these path forms are equivalent: `D:\foo`, `D:/foo`, `/d/foo`. Don't try to cd between them.

## Push (only if requested)

After all commits succeed, if `push` was requested:

1. Check if the current branch has an upstream: `git rev-parse --abbrev-ref @{upstream}`
2. If no upstream: `git push -u origin HEAD`
3. Otherwise: `git push`
4. **Never force-push.** If push fails due to diverged history, report the error and let the user decide.
