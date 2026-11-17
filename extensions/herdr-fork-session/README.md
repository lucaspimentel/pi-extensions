# herdr-fork-session

`/herdr-fork-session [branch]` creates an isolated git worktree for a piece of planned work and, when pi runs inside [herdr](https://herdr.dev), opens a new unfocused tab whose root pane runs a pi session forked from the current one (`pi --fork <file|id>`). The command only creates and reports: it never installs dependencies in the new worktree, never passes a project-trust flag to the forked pi, and never sends input to, or answers dialogs in, the forked session.

## Requirements

- An interactive session: `ctx.hasUI` must be true, because the command always asks for a confirmation before creating anything. There is no way to bypass it, and it is never run non-interactively.
- A git repository with a working tree (a bare repository is refused), in the current working directory or a linked worktree of one.
- The herdr-specific steps (the new tab and the forked pi agent) additionally require `HERDR_ENV=1` and `HERDR_WORKSPACE_ID`. When either is missing, only the worktree is created and the command prints how to start the forked session manually.

## Usage

```
/herdr-fork-session [branch]
```

- With no argument, the branch is a slug of the session's display name: lowercased, every run of characters outside `[a-z0-9]` replaced by `-`, runs of `-` collapsed, leading/trailing `-` trimmed, and the result capped at 40 characters. A session with no name is refused; pass a branch.
- An explicit branch is used verbatim (only `/` runs are replaced by `-` when building the path and label), so it must already be a valid git branch name and must not start with `-`. At most one argument is accepted.
- The branch is never prefixed with an owner. Pick whatever name you want; collisions with an existing branch or an existing worktree path are refused before anything is created.
- The worktree is a sibling of the main clone: `<main-clone>--<branch with / replaced by ->`, resolved from `git rev-parse --git-common-dir`, so it is the same path from the main clone and from any linked worktree. When that common directory is not a `.git` directory (a bare repository, or a submodule whose common dir lives under the superproject's `.git/modules`), the main clone comes from `git rev-parse --show-toplevel`; a bare repository has no working tree and is refused.

## What it creates

- Worktree path: `<main-clone>--<sanitized branch>` (a sibling of the main clone).
- Branch: the argument, or the session-name slug, starting at the chosen base commit.
- Base: the current checkout's `HEAD` when it equals the main clone's `HEAD` (confirmed in a dialog), otherwise one of the two, chosen from a list showing `<ref> <short sha> <subject>` for each in the order [current checkout, main clone].
- Tab label: the sanitized branch.
- Agent name: derived from the branch, lowercased, restricted to `[a-z0-9_-]`, starting at its first letter (falling back to `fork`), capped at 32 characters.
- Fork file/id: the current session's file path when available, otherwise its session id.

## Outcomes

Every outcome notifies the user and records a `herdr-fork-session` custom session entry; the four creation outcomes also deliver a one-line next-turn message to the model. Each messaged line starts with its outcome token (`ok: `, `worktree-only: `, `tab-failed: `, `refused-collision: `), and the three outcomes where a forked session could exist (`ok`, `worktree-only`, `tab-failed`) also state that nothing was sent to it. Unknown fields are left undefined in the entry.

| outcome | notify | entry | message | what happened |
| --- | --- | --- | --- | --- |
| `ok` | yes | yes | yes | Worktree created, herdr tab opened, forked pi started. The tab is left unfocused. |
| `worktree-only` | yes | yes | yes | Worktree created outside herdr; the ready-to-run `cd <path> && pi --fork <file>` line (or `/session` guidance when the file is unknown) is reported. |
| `tab-failed` | yes | yes | yes | Worktree created but the tab could not be opened, or the tab opened but pi did not start. The worktree (and tab, when it exists) are kept and reported with a retry line. |
| `refused-collision` | yes | yes | yes | The worktree path or the branch already exists; nothing was created and the existing checkout is named. |
| `refused` | yes | yes | no | Usage error, unnamed session, invalid branch, not a git repository, or no interactive UI. Nothing was created. |
| `failed` | yes | yes | no | `git worktree add` failed (its stderr is reported). Nothing was created. |
| decline | yes | no | no | The confirmation was declined or the base selection was cancelled: `herdr-fork-session cancelled; nothing was created.` |

## Failure behavior

- A collision (the worktree path exists, or a local branch of that name exists) stops before any git mutation, including before the confirmation dialog. When the colliding branch is registered to a worktree whose directory is gone or that git marks prunable, the report says so and points at `git worktree prune` instead of a `cd`.
- A non-zero `git worktree add` is reported as `failed` and no herdr call is made.
- A tab-create or agent-start failure keeps the worktree (and the tab, when it was created) and reports the command's error text plus a retry line. No follow-up `herdr agent get` or `herdr pane read` is issued, no input is sent to the new session, and its dialogs are never answered.
- The caller's `HERDR_TAB_ID` and `HERDR_PANE_ID` are never touched.

## Limitations

- Agent-name uniqueness is best-effort: `herdr agent list` reports a `name` for named live agents and omits it for unnamed ones, so detection (and the `-2`, `-3`, ... escalation) sees only named live agents. An unnamed live agent occupies no name, and a duplicate that detection still misses surfaces later as an `agent start` failure, reported as `tab-failed`.
- No dependency installation and no project-trust handling: the new worktree is a plain checkout, and the forked pi starts with the same trust state as a fresh launch.
- The base dialog cannot express a base other than the current checkout's `HEAD` or the main clone's `HEAD`. If both produce the same `<ref> <short sha> <subject>` string while their shas differ (not expected for distinct commits), the current checkout is used.
- Changes are recorded only as a `herdr-fork-session` custom session entry and a next-turn message; there is no entry renderer, and nothing else in the session is modified.
- `HERDR_TAB_ID` / `HERDR_PANE_ID` are not used to identify the caller, so the command never renames or closes its own tab or pane.

## Debugging

- The command never opens a shell: every child process is an argv-array `execFile` call, so a failing step can be reproduced by running the exact same argv (`git worktree add ...`, `herdr tab create ...`, `herdr agent start ...`) reported in the notification.
- Set `HERDR_ENV` to a non-`1` value (or clear `HERDR_WORKSPACE_ID`) to exercise the worktree-only path without herdr.
