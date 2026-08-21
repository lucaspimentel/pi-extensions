# TODO

> See also [`extensions/pi-tool-permissions/TODO.md`](extensions/pi-tool-permissions/TODO.md) for the pi-tool-permissions extension's own task list.

- [x] Expand `extensions/plan.ts` `SAFE_BASH` allowlist with more read-only commands. Added `cd`, `stat`, `file`, `du`, `df`, `date`, `whoami`, `hostname`, `uname`, `sort`/`uniq`/`cut`/`column`/`jq`/`type`/`diff`/`basename`/`dirname`/`realpath`/`readlink`, `env`/`printenv` (argument-free / single-lookup forms only), and scoped git read-only subcommands (`git worktree list`, `git tag`/`-l`/`--list`, `git reflog`/`show`, `git stash list`, `git show-ref`, `git submodule status`, `git diff-tree`, `git shortlog`, `git config --list`).
	- Since `cd` only matters as a compound prefix (`cd sub && ls`), also added compound-command splitting: `isSafeBash` now splits on top-level `&&`/`||`/`|`/`;`/newlines (ported `splitTopLevelShell`/`consumeHeredoc` from `pi-tool-permissions/index.ts`) and requires every segment to independently match `SAFE_BASH`, failing closed on unmatched quotes/parens or top-level command substitution (`$(...)`/`` `...` ``). This also fixed two pre-existing bypasses: `cat foo | sh` and `echo $(./evil.sh)` were previously allowed.
	- `sort -o` (writes a file) and `env <cmd>` (runs an arbitrary program) added to `DESTRUCTIVE_BASH` as backstops.
	- Tests added in `tests/plan.test.mts`; block message now names the specific reason/segment instead of a generic "not in allowlist".
	- Verified: `node tests/plan.test.mts` and `npx tsc --noEmit` both clean.
