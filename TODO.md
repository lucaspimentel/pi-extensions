# TODO

> See also [`extensions/pi-tool-permissions/TODO.md`](extensions/pi-tool-permissions/TODO.md) for the pi-tool-permissions extension's own task list.

- [ ] Make slash-command style consistent across extensions.
	- Current state (audit via `registerCommand` calls):
	  - `pi-tool-permissions` uses a single root `/permissions` with subcommands: `/permissions list`, `/permissions allow <rule>`, `/permissions auto`, `/permissions auto model`, etc. (`extensions/pi-tool-permissions/index.ts:2811`).
	  - `stash` used flat prefixed siblings: `/pop`, `/stash-list`, `/stash-drop`, `/stash-clear` (note `/pop` lacked the prefix entirely, and there was no `/stash` parent command). Now migrated, see Migration progress below.
	  - `idle-summary` uses flat siblings `/summary` and `/summary-model` (`extensions/idle-summary/index.ts:303,313`) rather than `/summary model`.
	  - `plan` used flat siblings `/plan` and `/plan-cancel` rather than `/plan cancel` (now migrated, see Migration progress below).
	- Decide on one convention (likely the hierarchical `/root <subcommand>` style used by `permissions`, since it scales best and keeps the command namespace clean), then migrate the other three extensions.
	- Migration touches: `registerCommand` names + their `getArgumentCompletions`/`handler` argument parsing, help text strings, README references, and any skills/tests that invoke the old names. Keep backward-compatible aliases for the old flat names during a deprecation window if practical.
	- Migration progress: `plan` and `stash` migrated.
	  - `plan`: `/plan cancel` now cancels (exact-match subcommand, with argument completion), the flat `/plan-cancel` is kept as a deprecated alias routed to the same cancellation, header/README docs updated, and command-level tests added to `tests/plan.test.mts` via a mocked `ExtensionAPI`.
	  - `stash`: canonical root `/stash` with `list`, `pop [n]`, `drop <n>`, `clear`, and `help` subcommands, plus hierarchical argument completion (subcommands first, then entry indexes for pop/drop, values carrying the subcommand since completion replaces the whole argument text). Flat `/pop`, `/stash-list`, `/stash-drop`, `/stash-clear` kept as deprecated aliases routed to shared handlers; header/README docs and user-facing messages updated; `tests/stash.test.mts` migrated to the canonical names with alias compatibility checks. Remaining: `idle-summary`.

- [x] Expand `extensions/plan.ts` `SAFE_BASH` allowlist with more read-only commands. Added `cd`, `stat`, `file`, `du`, `df`, `date`, `whoami`, `hostname`, `uname`, `sort`/`uniq`/`cut`/`column`/`jq`/`type`/`diff`/`basename`/`dirname`/`realpath`/`readlink`, `env`/`printenv` (argument-free / single-lookup forms only), and scoped git read-only subcommands (`git worktree list`, `git tag`/`-l`/`--list`, `git reflog`/`show`, `git stash list`, `git show-ref`, `git submodule status`, `git diff-tree`, `git shortlog`, `git config --list`).
	- Since `cd` only matters as a compound prefix (`cd sub && ls`), also added compound-command splitting: `isSafeBash` now splits on top-level `&&`/`||`/`|`/`;`/newlines (ported `splitTopLevelShell`/`consumeHeredoc` from `pi-tool-permissions/index.ts`) and requires every segment to independently match `SAFE_BASH`, failing closed on unmatched quotes/parens or top-level command substitution (`$(...)`/`` `...` ``). This also fixed two pre-existing bypasses: `cat foo | sh` and `echo $(./evil.sh)` were previously allowed.
	- `sort -o` (writes a file) and `env <cmd>` (runs an arbitrary program) added to `DESTRUCTIVE_BASH` as backstops.
	- Tests added in `tests/plan.test.mts`; block message now names the specific reason/segment instead of a generic "not in allowlist".
	- Verified: `node tests/plan.test.mts` and `npx tsc --noEmit` both clean.
