---
description: Run the review panel on a PR, the current branch's PR by default
argument-hint: "[<PR number or URL>] [focus]"
---
Requested: $@

Resolve the target before calling anything.

- If the argument text after `Requested:` begins with a PR number or a pull-request URL, that is the target and any remaining text is extra review focus.
- Otherwise treat all of the argument text as extra review focus and resolve the PR from the working directory: `gh_read` with subcommand `pr view` and no positional argument reads the current branch's PR, and `-R OWNER/REPO` moves that same branch-name lookup to another repository. If no PR resolves, ask me for the number or URL. Never run the panel against a guessed target.
- Say the resolved PR in one line (repository, number, title, head SHA) before starting.
- Get the repository, number, title, and head SHA in one `gh_read` call (`pr view --json number,title,url,headRefOid`, whose returned URL carries the repository).
- Get the local commit with `git_read` subcommand `log` and args `["-n", "1"]`, whose first line begins with `commit <full sha>`. Do not add `--oneline`: it abbreviates the sha, so it cannot be compared reliably with `headRefOid`.
- Hand the head SHA and the local commit to the panel so a panelist can tell whether the working tree is the revision under review; if the `log` call fails, say so and tell the panelists to read the change set from GitHub instead of the local tree.

Then call `subagent({panel: "review", task})` with `task` built from the contract below. If the catalog in the subagent tool description lists no `review` preset, name the presets it does list and ask which to use; never substitute one silently. The contract text is the task: pass it through with the placeholders filled in, and when the request above carried no extra review focus, delete the `<extra review focus>` line instead of leaving it in.

Review pull request <repository>#<number> (<URL>), head commit <head SHA>. The local working tree is at <local HEAD>.
Fetch the PR yourself with `gh_read`: `pr view` for the title, body, and base branch, and `pr diff` for the change set, starting with `--name-only` when the diff is large. Pin the repository on every `gh_read` call so each reviewer reads the same target.
Do not review a diff you did not fetch.
Read the changed files, not the hunks alone: `read`, `ffgrep`, and `fffind` when the working tree is the head commit above and `git_read` `status` reports no uncommitted changes, otherwise `gh_read` `repo contents` with `repo`, `path`, and `ref` set to that commit.
<extra review focus>
Stay read-only: no `bash` is available, so do not attempt builds or tests.
Report `Critical (must fix)`, `Warnings (should fix)`, `Suggestions (consider)`, and a two-to-three sentence `Summary`, citing `file:line` throughout, and end with a `Verdict:` line of either approve, approve with nits, or request changes.

After the tool result: reproduce what the panel returned, the merged review or the labeled per-model sections together with any merge notice, without summarizing it or dropping findings. You may add a short note on where the reviewers disagree and which findings look load-bearing. Do not start fixing anything; ask me which findings to act on.
