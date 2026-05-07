---
name: update-pr-description
description: "Update the PR's title and description to accurately reflect the changes. Use when the user says 'update pr description', 'fix the pr title', 'update the PR body', 'rewrite pr description', 'the pr description is wrong', 'update pr details', or any variation of wanting to refresh or correct a pull request's title or description."
disable-model-invocation: true
---

Update the PR's title and description to accurately reflect the changes.

## Analysis Steps
1. Fetch PR details: `gh pr view --json title,body,commits,files`
2. Review all commits and changes: `gh pr diff`
3. Understand the full scope of changes (not just latest commit)
4. If the PR title and description were not empty, show me a summary of what will change (added, removed, etc) before updating the PR

## Title Requirements
- Keep concise (≤ 72 characters recommended)
- Use imperative mood (e.g., "Add feature" not "Adds feature")
- Accurately summarize the overall change
- If the title already starts with a tag in `[]` (e.g., `[Build]`, `[Azure Function]`), preserve it exactly and only update the rest of the title.
- If there is no existing tag, add an appropriate topic tag in `[]`:
  e.g., "[Azure Function] Add feature"

## Description Requirements
- Follow repository template if available (search case-insensitive):
  - `pull_request_template.md`
  - `.github/pull_request_template.md`
  - `docs/pull_request_template.md`
- If no template, include:
  - Summary of changes (what and why)
  - Testing performed
  - Breaking changes or migration notes (if applicable)
- Keep concise but complete
- Use bullet points for clarity
- End the description with a short, witty joke formatted as a quote from Claude:
  > *"[joke here]"* — Claude 🤖
  If the existing PR description already has a joke, keep the existing one.

## Updating PR

### When editing an existing PR description
1. Save the current PR description to a temp file: `gh pr view --json body --jq .body > "$(mktemp)"`
2. Use the Edit tool to modify the temp file with the new description (this lets the user see the diff and approve before changes are applied)
3. Once approved, apply: `gh pr edit PR_NUMBER --title "..." --body-file <temp-file>`
4. Clean up the temp file

### When creating a new PR or the existing description is empty
1. Write the description directly using `gh pr edit PR_NUMBER --title "..." --body "..."`
   - No temp file needed since there's nothing to diff against
