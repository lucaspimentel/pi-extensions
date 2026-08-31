# TODO

> See also [`extensions/pi-tool-permissions/TODO.md`](extensions/pi-tool-permissions/TODO.md) for the pi-tool-permissions extension's own task list.

- [ ] Make slash-command style consistent across extensions.
	- Current state (audit via `registerCommand` calls):
	  - `pi-tool-permissions` uses a single root `/permissions` with subcommands: `/permissions list`, `/permissions allow <rule>`, `/permissions auto`, `/permissions auto model`, etc. (`extensions/pi-tool-permissions/index.ts:2811`).
	  - `stash` uses flat prefixed siblings: `/pop`, `/stash-list`, `/stash-drop`, `/stash-clear` (`extensions/stash.ts:229-272`). Note `/pop` lacks the `stash-` prefix entirely, and there is no `/stash` parent command to mirror the `/permissions` pattern.
	  - `idle-summary` uses flat siblings `/summary` and `/summary-model` (`extensions/idle-summary/index.ts:303,313`) rather than `/summary model`.
	  - `plan` uses flat siblings `/plan` and `/plan-cancel` (`extensions/plan.ts:417,424`) rather than `/plan cancel`.
	- Decide on one convention (likely the hierarchical `/root <subcommand>` style used by `permissions`, since it scales best and keeps the command namespace clean), then migrate the other three extensions.
	- Migration touches: `registerCommand` names + their `getArgumentCompletions`/`handler` argument parsing, help text strings, README references, and any skills/tests that invoke the old names. Keep backward-compatible aliases for the old flat names during a deprecation window if practical.

- [x] Expand `extensions/plan.ts` `SAFE_BASH` allowlist with more read-only commands. Added `cd`, `stat`, `file`, `du`, `df`, `date`, `whoami`, `hostname`, `uname`, `sort`/`uniq`/`cut`/`column`/`jq`/`type`/`diff`/`basename`/`dirname`/`realpath`/`readlink`, `env`/`printenv` (argument-free / single-lookup forms only), and scoped git read-only subcommands (`git worktree list`, `git tag`/`-l`/`--list`, `git reflog`/`show`, `git stash list`, `git show-ref`, `git submodule status`, `git diff-tree`, `git shortlog`, `git config --list`).
	- Since `cd` only matters as a compound prefix (`cd sub && ls`), also added compound-command splitting: `isSafeBash` now splits on top-level `&&`/`||`/`|`/`;`/newlines (ported `splitTopLevelShell`/`consumeHeredoc` from `pi-tool-permissions/index.ts`) and requires every segment to independently match `SAFE_BASH`, failing closed on unmatched quotes/parens or top-level command substitution (`$(...)`/`` `...` ``). This also fixed two pre-existing bypasses: `cat foo | sh` and `echo $(./evil.sh)` were previously allowed.
	- `sort -o` (writes a file) and `env <cmd>` (runs an arbitrary program) added to `DESTRUCTIVE_BASH` as backstops.
	- Tests added in `tests/plan.test.mts`; block message now names the specific reason/segment instead of a generic "not in allowlist".
	- Verified: `node tests/plan.test.mts` and `npx tsc --noEmit` both clean.
