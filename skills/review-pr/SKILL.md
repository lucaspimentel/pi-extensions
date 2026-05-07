---
name: review-pr
description: "Review a pull request for issues and feedback. Use when the user says 'review this PR', 'check this PR', 'look at PR changes', 'review the diff', 'what do you think of this PR', 'post review comments', 'any issues with this PR', 'what changed in this PR', 'are there problems with these changes', 'critique the diff', or any variation of wanting PR feedback or code review."
argument-hint: "[findings|fix|post]"
disable-model-invocation: true
---

Review a pull request and provide detailed feedback on the changes.

## Modes

The skill has three modes, selected by an optional argument:

- `findings` — display review findings only; never modify code or post to GitHub
- `fix` — display findings, then walk through each issue and apply local fixes as commits
- `post` — display findings, then post review comments to GitHub via `gh api`

If no argument is provided, run the findings phase first, then use `AskUserQuestion` to ask whether to `fix`, `post`, or `stop`.

## Review Steps (all modes)

1. Fetch PR details and full diff using `gh pr view` and `gh pr diff`. If the diff is empty, stop and tell the user.
2. Skip generated/vendored files: lock files (`*.lock`, `package-lock.json`, `yarn.lock`), `*.designer.cs`, auto-generated code, vendored dependencies
3. For large PRs, prioritize the most-changed files first
4. Focus on actionable issues, not positive feedback

## Findings Phase (always run first)

- Display all review findings in the CLI output only
- Label each comment with a severity emoji: 🔴 CRITICAL, 🟠 HIGH, 🟡 MEDIUM, 🟢 LOW
- Sort comments by severity (most critical first), then by file path and line number:
  1. 🔴 **CRITICAL**: Security vulnerabilities, data loss, crashes
  2. 🟠 **HIGH**: Logic errors, bugs, incorrect behavior
  3. 🟡 **MEDIUM**: Performance issues, missing error handling
  4. 🟢 **LOW**: Code style, minor improvements, suggestions
- Keep the summary concise: one line per issue with severity, `file_path:line_number`, and a brief description

If no issues were found, say so and stop regardless of mode.

## After Findings

Behavior after the findings phase depends on the mode:

- **`findings` mode**: stop here.
- **`fix` mode**: continue to "Fix Flow" below.
- **`post` mode**: continue to "Post Flow" below.
- **No mode argument**: use `AskUserQuestion` with options `fix`, `post`, `stop`. Then run the corresponding flow (or stop).

## Fix Flow

DO NOT post any comments to GitHub in this flow.

### Step 1 — Ask About Each Issue

For each issue in order, use `AskUserQuestion` to ask what to do. Offer options:
- **"Fix it"** — investigate and implement a fix
- **"Skip"** — do nothing for this issue

Collect answers for **all** issues before applying any fixes. Track each answer as `{issue index, severity, file:line, action}`.

### Step 2 — Apply Fixes

After all answers are collected, work through each "Fix it" issue in order (most critical first):

1. Make the code change
2. Stage and commit the change following the `git-commit` skill conventions (imperative mood, concise subject ≤ 50 chars)
3. Move to the next "Fix it" issue

Skipped issues are not touched.

### Step 3 — Final Summary

If any changes were committed, show a summary listing:
- Issues fixed, with the commit subject for each
- Issues skipped

If no changes were made, no summary is needed.

## Post Flow

- Use `gh api` to create a review with specific line comments
- Endpoint: `repos/OWNER/REPO/pulls/PR_NUMBER/reviews`
- Each comment must specify: `path`, `line` (or `start_line`/`end_line`), `body`
- Include footer in review body: `"\n\n---\n*Review by Claude Code*"`
- ALWAYS use event type: `COMMENT`
- NEVER use `REQUEST_CHANGES` or `APPROVE` — human review required
- Group related comments under a single review

### Comment body guidelines

- Reference code directly with `file_path:line_number`
- Explain why something is an issue, not just what
- Suggest a concrete fix when possible
