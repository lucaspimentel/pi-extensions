# Guard: sandbox-first permission redesign

Status: **design settled (2026-10-02 grilling sessions, including step 0:
assumptions confirmed); step 1 (shared sandbox library) implemented in
`extensions/guard/sandbox/`; step 2 (policy core) implemented and
observe-only in `extensions/guard/index.ts` + `policy/` (2026-10-06); step 3
(tools and enforcement) implemented in `runtime.ts`, `tools/`, and
`filter.ts` after the 2026-10-06/07 design review closed the audit,
lifecycle, and filter gaps (see the decision log); step 4 (plan.ts
integration) implemented in `extensions/plan.ts` (2026-10-07); step 5
(subagent inheritance) implemented (2026-10-07); dialog gate, spinner,
cancellation, and owned overlays implemented and visually confirmed by the
user (2026-10-09). The save/deny/compound prompt contract below is confirmed
but not implemented; step 6 switchover is not authorized.**

Scope: a new `guard` extension that replaces `extensions/pi-tool-permissions/`,
`extensions/python/`, and `extensions/node/`, plus changes to
`extensions/plan.ts` and `extensions/subagent/`. (The standalone
`extensions/pwsh.ts` was later removed outright; see the decision log.)
Breaking changes are acceptable.

## Goals

1. Protect against prompt injection and against an AI model that misbehaves
   for any other reason.
2. Reduce permission prompts where possible.

When the two conflict, safety wins.

## Diagnosis: why the current paradigm fails

Today a string pattern match on the command decides whether a call runs
without a prompt. With an adversarial model, the command string says little
about what the command does.

Holes, verified 2026-10-02:

| Hole | Evidence |
|---|---|
| Allow rules run project code on the host with no prompt, with network, credentials, and pi's full environment (API keys) | `~/.pi/agent/pi-tool-permissions.json` allows `cargo build *`, `cargo test *`, `dotnet build *`, `dotnet test *`, `PYTHONPATH=. pytest *`. Two-step escape: edit a test file (allowed in edits mode), then run `cargo test` (allowed). |
| `/plan` is not read-only | `plan.ts:199` (`narrowTools()`) hides only write/edit. bash, pwsh, python, node, MCP, and subagent stay active. The only other safeguard is prompt text (`plan.ts:55`). (Historical; closed by the research handshake and the 2026-10-07 annotation-aware narrowing, see Planning eligibility below.) |
| python/node writable mounts do not protect paths whose contents later execute outside the sandbox | `python/sandbox.ts` and `node/sandbox.ts` never mention `.git` or `.pi`. In edits/auto/yolo, sandboxed code can write `.git/hooks/*`, `.git/config`, and `.pi/pi-tool-permissions*.json` (the model could grant itself allow rules). |
| `pwsh` ran on the host | The since-removed `pwsh` extension spawned it directly; on Linux it was equivalent to unsandboxed bash. pi's built-in `powershell` tool is opt-in (`defaultTools`) and guard classifies it as a host shell. |
| Headless subagent children are safe only because of a config default | `nonInteractiveAsk` is unset in the user config and defaults to deny. Setting it to `"allow"` would let children write freely. |
| Built-in bash inherits pi's full environment | Provider keys, `DD_API_KEY`, `GITHUB_TOKEN`, and similar are visible to every command. |

## Verified facts (2026-10-02)

- **bubblewrap** is 0.9.0 (`/usr/bin/bwrap`, Ubuntu noble package
  `0.9.0-1ubuntu0.3`, the noble-security point release; apt offers nothing
  newer). It has no `--overlay-src` / `--tmp-overlay`.
- **Unprivileged overlayfs** works on kernel
  `6.18.40.1-microsoft-standard-WSL2`. Mounting the overlay **before** bwrap
  works with stock bwrap 0.9.0 (nested user namespace):
  `unshare -rm sh -c "mount -t overlay ... <merged> && bwrap ... --unshare-all --bind <merged> /w -- ..."`.
  Writes and `mkdir` landed in upperdir; lowerdir was unchanged. Building
  bwrap 0.10+ or using fuse-overlayfs is therefore unnecessary.
  - Not yet tested: a lowerdir on `/mnt/c` (9p). upperdir must live on disk,
    not tmpfs, because large builds (dd-trace-dotnet `obj/`, `bin/`) run to
    GBs.
- **codemode is not a bypass.** It calls tools through `ctx.executeTool`
  (pi `dist/extensions/codemode/execute.js:304`). Nested calls go through
  `tool_call` handlers (pi `docs/extensions.md:148`).
- **cargo offline with read-only caches:** `cargo build --offline` inside
  bwrap with `~/.cargo` and `~/.rustup` read-only and no network succeeded,
  for a crate already extracted in `registry/src`. A never-extracted crate
  would need writes there; the per-call cache overlay covers that (untested).
- **dotnet offline with read-only caches:** `dotnet build` (implicit restore)
  inside bwrap with `~/.dotnet` and `~/.nuget` read-only and no network
  succeeded, with `Newtonsoft.Json 13.0.3` from the global packages folder.
  Side effects: `NU1900` vulnerability-audit warnings and about 6 s of restore
  timeout.
- Local paths: dotnet is at `~/.dotnet/dotnet`, cargo at `~/.cargo/bin`, node
  at `/home/linuxbrew/.linuxbrew/bin/node`, pwsh at `~/.dotnet/tools/pwsh`.
- Reference implementations: pi `examples/extensions/sandbox` (uses
  `@anthropic-ai/sandbox-runtime`) and `examples/extensions/gondolin`. Both
  override the built-in bash through `createBashTool()` with custom
  `BashOperations`.

## Principles

1. **The kernel enforces; rules only route.** A rule can never make an
   unconfined action safe. Rules only decide whether leaving the sandbox needs
   a prompt.
2. **One policy, many enforcers.** A single policy object drives both the
   sandbox mounts and the host-side read/write checks, so they cannot
   disagree.
3. **Sandboxed runs cost nothing.** Prompts and classifier calls are spent
   only on escapes and on effects outside the machine.
4. **Fail closed** wherever a sandbox is available. Degraded mode is explicit
   and visible (see Platform).
5. **Tightening only** for holders: plan and subagent parents can tighten the
   policy; nothing downstream loosens it.

## Platform

- **Linux/WSL:** the full design.
- **Degraded mode:** native Windows, or Linux where bwrap or user namespaces
  are missing.
  - `bash` and `host_bash` are both registered and identical host executors
    (HostBash rules, the read-only tier and validators). A persistent
    "no sandbox" footer warning is shown.
  - python/node are unavailable.
  - In research, `bash` runs only commands the string-based read-only tier
    and validators prove read-only; everything else is denied.
- **pwsh:** the standalone `pwsh` extension was removed (2026-10-07); guard
  registers no PowerShell tool of its own. pi's built-in `powershell` tool is
  opt-in via `defaultTools`; when it is enabled, guard classifies it as a
  host-tier tool on the pwsh tier (host-shell class, `shell: "pwsh"`), so
  `Pwsh(...)` rules and the pwsh cells govern it exactly like the old pwsh
  tool. It has no read-only tier, so none carries over.
- **Runtime modes on Linux:**

  | Mode | When | Behavior |
  |---|---|---|
  | Full sandbox | bwrap and the launcher are both available | As designed |
  | Reduced sandbox | bwrap works but the launcher cannot be built (no C compiler or no `libseccomp.so.2`) | bwrap namespaces only: no seccomp, no overlays. The research workspace and the caches fall back to read-only. Footer shows `⚠ reduced sandbox`. |
  | Degraded | no bwrap or no user namespaces (or native Windows) | As above: `bash` = `host_bash`, python/node unavailable |

## Architecture

- One new **`guard`** extension owns the policy. It contains the permissions
  logic (from pi-tool-permissions), the shared sandbox library, and the
  `bash`, `host_bash`, `python`, and `node` tools.
- **Sandbox library origin:** written fresh in `extensions/guard/`, copying
  and adapting the logic python/node duplicate today (read-root filtering,
  bwrap args, merged-`/usr` handling, interpreter binds including linuxbrew,
  dependency checks). `python/` and `node/` stay untouched; their copies are
  deleted at switchover.
- **plan.ts stays separate.** It requests the research profile from guard
  over `pi.events` and refuses to start `/plan` without an acknowledgment.
- **Rollout:** build guard alongside the old extensions until it reaches
  parity, then switch over. No patches to the old code in the meantime.
- **Coexistence (steps 2 through 5):** guard is registered in
  `pi.extensions` from step 2 on and runs next to pi-tool-permissions in
  **observe-only** mode: its `tool_call` hook computes each decision,
  publishes it on the `guard:decision` event, and never blocks or prompts.
  `/guard debug on|off` shows the decisions live, so they can be compared
  with the enforcing extension on real sessions. pi-tool-permissions keeps
  enforcing until switchover; guard's own tools (step 3) are the first
  calls guard enforces.
- **Step 3 coexistence contract (settled 2026-10-06):**
  - guard enforces only its own four tools (`bash`, `host_bash`, `python`,
    `node`); every other tool stays observe-only, except the secret-mask
    `tool_result` filter on grep/ffgrep (filtering, not blocking).
  - guard registers all four tools in step 3. guard is declared before the
    `python`/`node` extensions in `pi.extensions` and pi's tool registry is
    first-extension-wins, so guard's copies are authoritative and the old
    extensions go dormant until the switchover deletes them. This also
    closes the old sandboxes' unprotected `.git`/`.pi` writable-mount hole
    at step 3 instead of switchover.
  - pi's `tool_call` handlers run in load order: the first `block` wins,
    otherwise the last non-null result wins. pi-tool-permissions (earlier)
    keeps first shot; guard can block what it allows.
  - pi-tool-permissions is silenced on `host_bash` by a bare
    `"host_bash"` allow entry in `pi-tool-permissions.json`, added manually
    (same shape as the existing bare `"python"` allow). No guard code
    writes another extension's config; the guard README documents the
    entry and `/guard migrate`'s report reminds when it is missing.
  - The three Bash ask rules (`Bash(rm *)`, `Bash(git * push)`,
    `Bash(git push *)`) stay until switchover: they keep prompting on
    guard's sandboxed calls (rare noise) and remain meaningful in degraded
    mode, where sandboxed bash is host exec.
  - Known quirk, documented: pi-tool-permissions' SANDBOXED_TOOLS implicit
    allow keeps auto-allowing guard's python/node, and its mode events
    (ctrl+alt+p) no longer affect guard's python/node workspace; guard's
    profile is the only source of truth for guard's tools.

## Config

- New file **`guard.json`**: user scope at `~/.pi/agent/guard.json`,
  project scope at `<cwd>/.pi/guard.local.json` (machine-local; `.pi/` is a
  protected path, so the model cannot edit it). Keys: `cycleShortcut`,
  `protectedPaths`, `maskPatterns`, `maskExceptions`, `webFetchAllow`,
  `hostBash` (`allow`/`ask`/`deny` lists of `HostBash(...)` rules, replacing
  `Bash(...)`), `readRoots`, `writeRoots`, `toolClasses`, `bashValidators`,
  and the classifier pin and natural-language lists. Scalars: project wins;
  lists: union with dedupe. A corrupt file is ignored with a warning and
  never discards the other scope.
- **`/guard migrate`** converts `pi-tool-permissions.json` (user and project
  scopes, including their legacy fallback paths). Everything that has a home
  in guard carries over:
  - `Bash(...)` rules -> `HostBash(...)` in the same slot;
  - `readAllowPaths` -> `readRoots`; `writeAllowPaths` -> `writeRoots`;
  - `WebFetch(domain:x)` allow rules -> `webFetchAllow` URL globs;
  - MCP allow rules -> read entries in `toolClasses`;
  - `bashValidators`, and the auto-mode classifier pin and lists, as-is.

  Anything without a home (Read/Write/Grep/Glob rules, `toolDefaults`,
  `nonInteractiveAsk`, implicit-allow toggles) is **listed as dropped**.
  Rules that look like project-code runners (cargo/dotnet
  build/test/run/restore, pytest, npm run/install, make, and similar) are
  copied but **listed** for a manual purge; nothing is dropped
  automatically.
- **Migrate writes:** the report is shown first and migrate asks for
  confirmation (`/guard migrate dry` only previews). Lists are unioned with
  dedupe, so re-running changes nothing; existing guard.json entries are
  never removed; each scope writes its own file.

## Tools

| Tool | Behavior |
|---|---|
| `bash` | Always sandboxed, except in yolo and unrestricted. Built with `createBashTool()` plus bwrap-spawning `BashOperations`. One process per call, no persistent shell. |
| `host_bash` | The only escape from the sandbox. `HostBash(...)` rules plus the tightened host read-only tier (below) apply to it. |
| `python`, `node` | Persistent interpreters moved into guard. Every sandboxed profile uses a worker-lifetime workspace overlay (read-only in reduced mode); workspace writes never reach the host. Persist outputs in shared scratch. Yolo/unrestricted are fully raw. |
| `pwsh` | Not registered by guard. pi's built-in opt-in `powershell` tool is classified as a host shell on the pwsh tier (`Pwsh(...)` rules) whenever it is enabled. |

- **Read-only tier on both shells:** the read-only command tier, the
  validators (duckdb/mlr/find/awk), and the redirect checks apply to sandboxed
  `bash` **and** to `host_bash`; provably read-only host commands auto-allow.
  The tier has no network commands, and path-taking commands are already
  restricted to cwd and read roots.
- **Tightened host tier** (host_bash only; these cases prompt instead):
  - `env` and `printenv` are removed from the tier (the host environment
    holds tokens; the sandbox environment is scrubbed);
  - any `$` expansion vetoes auto-allow (`echo $GITHUB_TOKEN`);
  - file arguments matching the secret-mask patterns veto auto-allow
    (`cat .env`).

  Sandboxed `bash` keeps the full tier.
- **python/node in yolo and unrestricted** are fully raw: the persistent worker and protocol
  stay (state, results, replay semantics), but there is no bwrap, no seccomp,
  no rlimits, the full environment, and the full filesystem.
- **Profile switches** that flip a python/node worker's sandbox state (into
  or out of yolo/unrestricted or research) restart the worker with state loss and a
  notification, the same mechanism as today's remount.

- **No auto-routing:** a sandboxed `bash` call never runs on the host because
  it matches a rule.
- **Failure hints:** when a sandboxed command fails (network unreachable,
  EROFS on a protected or read-only path, path not mounted), the result adds a
  hint to use `host_bash` if host access is required.
- **Ask dialogs (implemented step 3):** explicit ask rules currently offer
  allow once or deny. Fallback prompts offer once, save for project, save
  for user, or deny. Host suggestions are exact commands with escaped
  metacharacters; saving is offered only if the merged patch authorizes the
  whole call. Show the exact rule/destination and never remove ask/deny
  rules. Cancel stale approvals without execution or persistence. Headless
  prompts deny. The dialog gate, spinner hiding, final-commit cancellation,
  and ctrl+] owned overlays are implemented; the user confirmed the visual
  check on 2026-10-09. The confirmed but unimplemented editor, deny-save,
  steering, and compound-breakdown behavior is specified in
  [Save, deny, and compound prompts](#save-deny-and-compound-prompts).
  Herdr signaling and other remaining UX items stay separately tracked in
  the root TODO.md; documenting this contract does not authorize
  implementation or step 6.
- **Dialog gate (2026-10-08):** one `DialogGate` instance per guard factory
  serializes execution approvals, read-grant prompts, the profile picker, and
  the migrate confirmation. Ordering is FIFO among requests that reach the
  gate; ordering by original tool-call invocation is not promised when
  asynchronous classification precedes enqueueing. The gate is independent of
  the execution queue:
  dialogs never hold it, and already-authorized executor work proceeds while
  a dialog is open. A caller's AbortSignal removes an aborted queued request
  promptly and, through the SDK selector's `{ signal }` option, cancels an
  open selector; the gate never aborts a caller-owned controller and holds
  the UI lease until the dialog body actually settles (a body that ignores
  cancellation cannot let a second selector open). An answer that arrives
  after cancellation is rejected, not applied. The profile picker and the
  migrate confirmation capture the initiating command operation's `ctx.signal`
  once, before the first await (it is a live getter that returns the current
  agent operation's signal or `undefined` when idle, so rereading it after the
  dialog would transfer or drop ownership, and an operation that began without
  a signal must never attach itself to a later one), pass it to the gate, and
  recheck it through a command-only final commit guard inside the runtime's
  existing `beforeCommit` hook with the captured expected epoch: after all
  asynchronous worker teardown, immediately before runtime policy assignment
  or profile publication (picker) and immediately before the privileged
  configuration writes (migration). Cancellation can therefore prevent the
  requested change even when it lands after selection while teardown is
  pending. The check is a per-operation `Error` marker compared by identity,
  so genuine teardown, storage, audit, and source-validation failures keep
  their existing diagnostics and are never reclassified as cancellation;
  a signal that merely happens to be aborted proves nothing on its own.
  Teardown, approval invalidation, epoch advancement, and audit findings
  already begun are not reversed, workers are never revived, and a completed
  synchronous commit is never rolled back. Expected cancellation is a warning
  notice and a normal command return, not an unhandled rejection. Policy transitions (via the
  central transition wrapper, synchronously before its first await), audit
  workspace locking (via the runtime's lock callback, since locking advances
  the epoch outside the wrapper), session/tree/cwd replacement, and shutdown
  invalidate queued and open dialogs synchronously without awaiting drainage;
  fresh requests are accepted after the new runtime or policy exists and old
  requests are never retried, replayed, or transferred. The lease covers only
  pre-display validation, the selector interaction, and post-answer
  validation, so a successful save, grant, or profile choice releases the
  gate before its own transition and cannot cancel itself while other pending
  dialogs fail closed. Scope is guard-local: unrelated extensions can still
  open competing selectors, and in RPC mode the remote client decides whether
  a cancelled dialog's display closes (the SDK sends no cancellation
  notification). Unresolved-teardown failures are not an invalidation
  trigger; post-answer availability checks reject answers that arrive after
  one appears.
- **Read grants:** guard-owned session/project/user/deny grants are mounted
  read-only. Legacy grants are not mirrored. A grant restarts workers and
  reports state loss, then returns without automatically replaying code.
- **Protected-path audit (revised step 3):** audit the host workspace around
  all sandboxed executors, including worker teardown boundaries. Compare
  the union of pre/post paths. Quarantine created/replaced protected entries
  and notify without failing an otherwise successful result. Any violation,
  incomplete audit, or quarantine failure locks the workspace. Auditing is
  detection/containment, not kernel prevention; overlay writes are not
  escaped host writes.
- **Workspace lock:** stop writable workers and allow only read-only sandbox
  execution until `/guard ack`. Deny host/raw execution even in
  yolo/unrestricted. Ack cannot override an unresolved teardown.
- **Execution barrier:** serialize guard's four tools, never holding the
  queue during dialogs. Revalidate before spawning. Tightening preempts
  active execution and awaits teardown before policy publication/ack.
  Unresolved teardown blocks further guarded execution.
- **Fixed identities:** toolClasses cannot reclassify guard's four executors.
  Raw/degraded bash honors HostBash deny/ask; unrestricted ignores them
  except for workspace locks. Keep unavailable worker registrations in
  degraded mode; never fall back to host on a sandbox launch error.
- **Worker refresh:** scan before every execute and restart on changed
  effective mask/protected mounts. Research entry/exit, raw/sandbox changes,
  roots/policy mounts, and lock/ack remounts discard interpreter and overlay.
  Default/auto/trusted changes preserve workers when launch policy matches.
- **Shared scratch:** all three sandboxed tools use one session/cwd scratch
  directory at its real absolute host path, without /scratch or /workspace
  aliases. Preserve scratch across reset/crash/remount; remove it on
  session/cwd/tree replacement or shutdown. Logs/quarantine stay separate.
- **Filter failure:** remove masked-file context/grouped blocks and replace
  or remove structured data and secret-bearing metadata too. Unsupported or
  ambiguous formats and filter failures suppress the entire original result
  with a fixed notice.
- Commands you type with `!` stay unsandboxed.

## Save, deny, and compound prompts

**Status: design confirmed by the user on 2026-10-09; not implemented.**
This extends the implemented ask-dialog behavior above. The interview closed
with design agreement only: implementation, configuration changes, and the
step-6 switchover still require authorization.

### Scope and action menu

- Rule-saving actions initially use the existing deterministic host-shell
  representation: `HostBash(...)` and `Pwsh(...)`, including bash routed to
  the host. This does not enable guard enforcement on additional tools;
  Pwsh and other non-owned calls retain their current observation boundary.
- Add no generic per-tool deny schema, worker-code deny representation,
  session deny store, or "Deny and stop" action. Session denial was considered
  and explicitly removed from this scope. Ordinary denial blocks the current
  call without automatically aborting the agent operation.
- Read grants retain their session/project/user/deny choices. The editor
  changes below apply to persistent project/user root saves; no new read-deny
  rule representation is introduced.
- Use flat, explicit execution-approval choices: **Allow once**, **Save allow
  for project**, **Save allow for user**, **Deny once**, **Save deny for
  project**, and **Save deny for user**. Offer save actions only where the
  representation and effective policy support them.
- Explicit ask rules still prohibit allow-saving, but permit supported
  project/user deny saves. Add the deny rule without removing the ask rule;
  existing deny-over-ask precedence applies. Automatic policy denial opens no
  new dialog.

### Compound breakdown and rule suggestions

- Show one prompt containing the original command and each reliably parsed
  step's decision. The breakdown is an explanation, not an execution plan:
  execute the original command unchanged, never the fragments separately.
- For an allow save, suggest anchored, escaped exact rules only for steps
  lacking effective permission. Do not add redundant rules for already
  allowed steps. Offer a generated bundle only when the complete hypothetical
  merge authorizes the entire original call; existing ask/deny rules are not
  removed or bypassed.
- Edit and save that bundle as one logical scope update, with no deliberate
  partial installation of its rules. This is not a new guarantee of
  crash-safe filesystem writes. The user explicitly accepts that the saved
  rules grant each matching step independently, including outside this
  particular sequence; they are not an exact-sequence-only permission.
- For a compound deny save, first show a multi-select of reliably parsed
  steps and their decisions, with nothing preselected. Require at least one
  selection to continue. Prefill exact deny rules for the selected commands,
  then open the rule editor. Matching a selected step can deny the whole call;
  those rules also deny matching commands outside this sequence.
- If parsing is unreliable, show the original command and mark the breakdown
  unavailable. Retain existing whole-call policy, rather than tightening it
  or presenting guessed fragments as reliable. Generate no guessed allow
  bundle. A deny-save action opens a blank rule editor; manually entered
  rules must be validated against the current whole call before saving.

### Editor, validation, and preview

- Every persistent save opens an editor. Shell editors contain one complete
  rule expression per line, initially using anchored, escaped exact
  suggestions. Every rule must parse and compile and use the original shell
  namespace. Scope, allow/deny slot, and destination are controlled by the
  chosen action, not editable configuration fields.
- Deliberate broadening to the existing glob, regex, or tool-wide grammar is
  permitted with explicit review. A malformed expression, wrong shell, or
  hypothetical merge that fails to allow/deny the entire current call as
  intended is a validation error. Preserve the entered text, explain the
  problem, and return to editing; do not save or execute while invalid.
- A persistent read-root editor contains one plain path. The edited root
  must cover the path that caused the request and pass existing root,
  protected-path, and secret restrictions. Unrelated roots are invalid.
  Grants remain read-only, discard worker state when applied, and never
  replay the code that requested access.
- After valid submission, always show a separate preview, including unchanged
  text: final rules/path, destination, and effect on the current call. For
  bundles, make the independent grants explicit. Provide **Confirm**,
  **Edit**, and **Cancel save**. Edit returns to the editor without mutation.

### Cancellation and denial steering

| Ordinary editor/preview cancellation or empty submission | Outcome |
|---|---|
| Allow-rule save | Save nothing; allow the current call once |
| Deny-rule save | Save nothing; deny the current call once |
| Persistent read-root save | Save nothing; grant no access |

- Display these cancellation consequences explicitly. They apply to ordinary
  user cancellation of a save, not owner abort, stale policy/context, or
  lifecycle invalidation. Those failures must never become allow-once or
  grant fallbacks. Cancelling the initial approval selector denies without
  saving or steering.
- After an explicit user denial, including a deny-save that becomes deny-once,
  collect an optional instruction for the agent. Empty or cancelled instruction
  input still denies, without steering. Automatic policy denial and initial
  selector cancellation skip this field.
- For a deny-rule save, collect the optional instruction before the final
  commit. Finish all UI, then perform final validity checks and write the
  rule. Aborting the owner before commit saves nothing; cancelling only the
  instruction field merely skips steering. A nonempty instruction uses the
  existing steering delivery mechanism, not an automatic agent abort.

### Ownership and commit boundaries

- The step picker, editor, preview, and steering field belong to the same
  admitted guard interaction. Every TUI stage retains ctrl+] hide/show;
  hiding preserves selections/text and the FIFO lease, grants nothing, and
  does not restore the spinner. Hide the spinner for the whole admitted
  interaction and restore it before releasing the lease on settlement.
- Retain the factory-scoped gate, owned-resource cleanup, private selector
  signal, captured owner signal, and context/runtime/epoch checks. Use public
  components/APIs for signal-aware editors; native `ui.editor()` has no signal
  option and is not sufficient on its own. No SDK patches/upgrades, private
  field access, global dialog coordinator, or extra execution queue.
- Complete the UI and post-answer validation and release the narrow lease
  before persistence or policy transition. Re-read configuration and validate
  the actual edited patch against the latest effective policy, not a newly
  generated suggestion. Retain final commit barriers through any teardown;
  no await separates the final check from the synchronous commit.
- Aborted/stale requests are never retried, replayed, or transferred to a new
  owner. Preserve genuine storage/teardown/audit errors, do not revive workers
  or roll back completed commits, and retain headless denial and the existing
  RPC display-cancellation limitation. The executor queue remains independent;
  authorized work does not wait for interaction.

## Profiles

Session-only, never persisted. Every session starts in **default**; subagent
children start in the inherited profile. Six profiles: research / default /
auto / trusted / yolo / unrestricted.

- **ctrl+alt+g** (mnemonic: guard; overridable with `cycleShortcut`) cycles
  research -> default -> auto -> trusted -> yolo, with no confirmation when
  entering yolo. The design originally named Ctrl+Alt+M, but ctrl+alt+m is
  indistinguishable from alt+enter in legacy terminal encoding (unreachable
  in herdr), and pi-tool-permissions owns ctrl+alt+p while both are loaded.
- **unrestricted** is reachable only with `/guard profile unrestricted`,
  never through the cycle, so one keypress cannot drop the deny rules.
- `/guard` opens a picker; `/guard profile <name>` sets a profile directly.

| | research | default | auto | trusted | yolo | unrestricted |
|---|---|---|---|---|---|---|
| Sandboxed workspace | throwaway overlay (per call for bash, per worker lifetime for python/node) | bash read-write with protected paths read-only; python/node worker-lifetime overlay | same as default | same as default | **no sandbox** for bash, python, or node | **no sandbox** |
| host_bash | deny (rules ignored) | prompt unless rule-allowed | classifier | allowed | allowed | allowed |
| write/edit | deny | allowed in cwd and write roots, prompt outside | classifier | allowed | allowed | allowed |
| Protected paths | deny | prompt | prompt | prompt | allowed | allowed |
| Local reads (read/grep/find/ls) | as default | allowed in cwd and read roots, prompt outside | as default | as default | allowed | allowed |
| Secret-mask files via read/grep | deny | deny | deny | deny | allowed | allowed |
| Exfil-capable remote reads (web_fetch outside the allowlist) | prompt | prompt | classifier | allowed | allowed | allowed |
| Other remote reads (web_search, pup, Jira/Slack reads) | allowed | allowed | allowed | allowed | allowed | allowed |
| Remote writes (Slack posts, MCP writes, pup writes) | deny | prompt | classifier | allowed | allowed | allowed |
| HostBash deny/ask rules | ignored (cell is deny) | apply | apply | apply | **apply** | **ignored** |

### Rule precedence

| Profile | Host shell (host_bash, pwsh, and sandboxed bash in degraded mode) |
|---|---|
| research | Absolute: rules change nothing. host_bash and pwsh deny; in degraded mode sandboxed bash runs only commands the read-only tier proves safe (allow rules do not widen it). |
| default, auto, trusted | HostBash deny > ask > allow, then the tightened read-only tier, then the profile cell (and in auto, the classifier for the remainder). |
| yolo | deny rules block and ask rules prompt; everything else is allowed. Your explicit rules are the last safety net. |
| unrestricted | 100% unrestricted: no sandbox, rules ignored, nothing prompts. |

### Local reads

- Reads inside cwd and the read roots are allowed. Outside them, a prompt
  offers a grant for the session, the project (`.pi/guard.local.json`
  `readRoots`), or the user (`~/.pi/agent/guard.json` `readRoots`). Grants
  are also mounted read-only into the sandboxes (step 3), as today.
- Files matching the secret-mask patterns (minus exceptions) are denied to
  read/grep in every profile except yolo and unrestricted, matching the
  sandbox masks.
- **Step-2 mask scope (path-level only):** the decision function sees only
  the call's path argument, so a grep or find over a directory that happens
  to contain a masked file is allowed; only direct reads of masked paths
  are denied. Documented gap; step 3 adds a `tool_result` filter (settled
  2026-10-06): grep/ffgrep matches whose file path matches the mask
  patterns (minus exceptions) are dropped and one summary line is appended
  ("N matches in masked files omitted"); `structuredContent` is replaced
  alongside `content`. Applies in every profile except yolo and
  unrestricted. `read` and `find` stay path-level.

### Tool classification

Every pi tool call maps to one tool class (host shell, sandboxed execution,
local read, local write, exfil-capable remote read, other remote read,
remote write, meta). Resolution order:

1. guard's **built-in map** (pi built-ins and this repo's tools; e.g.
   python/node sandboxed, subagent/codemode meta with nested calls gated
   individually, focused `pup_*` tools remote reads);
2. the guard.json **`toolClasses`** map (exact names or globs), which
   overrides the built-in map;
3. the tool's **annotations** (`readOnlyHint` -> remote read,
   `destructiveHint` -> remote write; a contradictory pair fails closed:
   `destructiveHint: true` wins over `readOnlyHint: true`);
4. a **name heuristic** (post/send/create/update/delete/write/... ->
   remote write);
5. anything still unknown is a **remote write** (prompt in default, deny in
   research, classifier in auto, allowed in trusted and above).

MCP calls in both naming styles (pi's built-in `mcp__<server>__<tool>` with
plain arguments, and the pi-mcp-adapter `mcp` proxy with `input.tool`) go
through the same order. **`pup_run`** is classified by its subcommand verb:
list/get/search/query/show/status/aggregate -> remote read;
create/update/delete/mute/edit and anything unrecognized -> remote write.
Annotations are author-provided, unverified hints; missing hints do not
establish read-only behavior, and `destructiveHint: false` means
non-destructive, not necessarily non-writing.

Built-in recognition consults own map entries only (`Object.hasOwn`), in
classification and planning alike: the built-in map is an ordinary frozen
object, so inherited Object.prototype names such as `constructor` or
`__proto__` are NOT built-ins. They are ordinary custom tools and follow the
normal annotation/configuration/fallback rules; no name is reserved or
prohibited.

### Planning eligibility (`/plan` narrowing)

When `/plan` holds the research profile, the CURRENTLY ACTIVE tool set is
filtered at planning entry (`isPlanningToolAllowed` in `policy/classes.ts`,
applied in `plan.ts` over a fresh `pi.getAllTools()` annotation lookup; no
long-lived planning cache). Rules, in order:

1. Built-in **host-shell and local-write** tools are removed regardless of
   annotations: `host_bash`, `pwsh`, `powershell`, `write`, `edit`, and the
   memory/scratchpad writes. A misleading read-only hint cannot revive them.
2. Built-in **local-read, remote-read, sandboxed-exec, and meta** tools stay:
   safe reads, the guard-owned sandboxed interpreters (`bash`, `python`,
   `node`), and the approved orchestration tools (`codemode`, `tool_search`,
   `subagent`, `ask_user_question`).
3. Every other tool needs explicit adequate annotations:
   `readOnlyHint === true && destructiveHint !== true`. Unknown custom tools
   and write-capable MCP tools are removed (fail closed).

Notes:

- guard.json `toolClasses` overrides do NOT create planning exceptions; the
  built-in map is authoritative for the exceptions.
- Input-dependent wrappers (`web_fetch`, `pup_run`) are not in the built-in
  map, so they qualify only through explicit annotations. Possible read-only
  argument combinations never make a whole tool planning-safe; unannotated
  `pup_run` is removed.
- Built-in recognition uses explicit own map entries only, so inherited
  property names (`constructor`, `__proto__`) are ordinary custom tools:
  unannotated or conflicting-hint instances are removed, adequately
  read-only annotated instances stay, and no name is prohibited.
- Only the active set is filtered; registered-but-inactive tools are never
  activated. The pre-plan set is snapshotted before narrowing and restored
  exactly on every exit path.
- **This is entry-time declaration filtering, not execution containment.**
  Registered `codemode`/`deferred` tools can remain callable without being
  declared active; `tool_search` or another extension can change activation
  afterwards; nested non-owned calls stay observe-only until the step-6
  switchover; trusted extensions have host privileges; and annotations are
  unverified author hints.

Conservative static capability metadata is declared on this repo's own
tools so they qualify correctly: web_fetch/web_search and the Slack reads
are read-only open-world; session_search is read-only closed-domain (its
index maintenance is separate); guard's python/node are declared
write-capable and open-world because raw profiles expose the host.

**Auto mode's classifier** screens only host_bash, pwsh, write/edit,
exfil-capable remote reads, and remote writes. Every sandboxed call skips it;
this retires today's "writable + classified" screening of python/node.

Exfiltration needs a sink the attacker can read:

- **Attacker-readable sinks:** web_fetch to an arbitrary domain (data rides in
  the URL), and Slack posts.
- **Not attacker-readable:** web_search queries (they go to the search
  provider), and pup or Jira reads (your own tenant).

## Sandbox contents

For every profile except yolo and unrestricted:

- **Reads** come only from allowed locations: workspace, granted read roots,
  `/usr`, a minimal `/etc`, and toolchains.
- **Never mounted:** `~/.ssh`, the ssh-agent socket, `~/.config/gh`,
  `~/.aws`, `~/.azure`, `~/.npmrc`, `~/.git-credentials`, `~/.docker`, pup
  tokens, `/run`, `/mnt/c`.
- **Environment:** allowlist only (`PATH`, `HOME`, `TMPDIR`, `LANG`,
  toolchain variables). No tokens or API keys.
- **Network:** none (`--unshare-net`; loopback still works, so local test
  servers run). A package-registry proxy comes **after the switchover**:
  host-side HTTP proxy with a registry allowlist, reached through a
  bind-mounted Unix socket and an in-sandbox forwarder, with `HTTP(S)_PROXY`
  set. Until then, restores and installs go through host_bash.
- **Caches and toolchains** (`~/.cargo`, `~/.rustup`, `~/.dotnet`,
  `~/.nuget`, `~/.npm`): read-only lowerdir plus a throwaway overlay per call.
  Lock files and first-time crate extraction work; nothing persists, so a
  sandboxed command cannot poison a package that later runs on the host.
- **Seccomp:** one policy for bash, python, and node, lighter than today's
  python/node policy. Ban ptrace, bpf, userfaultfd, perf_event_open,
  process_vm_readv/writev, kexec_load/kexec_file_load, open_by_handle_at,
  name_to_handle_at, new user namespaces, and keyctl. Allow `socket` and
  `socketpair`: build tools need Unix sockets and loopback (MSBuild node
  reuse, test runners), including builds launched from python/node
  subprocesses, and the network namespace already isolates abstract sockets.
  Accepted cost: a Unix socket inside a mounted directory (workspace or read
  root) is connectable from all three tools. TIOCSTI is covered by bwrap
  `--new-session`.
- **Resource limits** (set by the launcher, replacing the `prlimit` binary):
  - python/node keep today's limits: RLIMIT_AS 512 MiB (python) / 2 GiB
    (node), RLIMIT_FSIZE 16 MiB, RLIMIT_NOFILE 128, no core dumps.
  - bash: no core dumps only. RLIMIT_AS breaks .NET and V8 startup (they
    reserve large virtual address ranges), so there are no address-space,
    file-size, or descriptor caps; timeouts remain the main runaway guard.
- **NuGet audit:** `NuGetAudit=false` is set in every sandbox environment
  (MSBuild reads environment variables as properties), so offline restores
  neither stall on the audit fetch nor fail builds that treat the `NU1900`
  warning as an error. Guard's README documents that vulnerability auditing
  is off inside the sandbox.
- **Launcher:** one compiled C binary (generalized from node's
  `seccomp-launch.c`) with two modes. No shell anywhere; everything is argv.
  - **Outer mode:** create user and mount namespaces, mount the overlays
    (research workspace, cache layers), then exec bwrap (verified: stock bwrap
    0.9.0 runs inside the nested user namespace).
  - **Inner mode** (inside bwrap): install seccomp, set rlimits, then exec
    the target: `bash -c`, the python worker, or the node worker. Replaces
    python's in-worker ctypes seccomp install.
  - Overlay upper layers live on disk under the session scratch area (not
    tmpfs) and are removed when the overlay ends.
- **Launcher build and cache:**
  - compiled on demand with cc/gcc/clang against the runtime
    `libseccomp.so.2` (no dev package; the ABI is declared by hand);
  - cached at `~/.cache/pi-guard/<arch>-<sha256(source + flags)>/`
    (`XDG_CACHE_HOME` honored), directory created 0700, ownership and mode
    verified before exec (another user's or a group/world-writable directory
    is refused);
  - atomic compile (temp file + rename); recompiles only when the source or
    flags change; the soname link means libseccomp upgrades need no rebuild;
  - after a successful compile, sibling `<arch>-<hash>` directories older
    than 7 days are pruned (younger ones may belong to a running session of
    another guard version).
- **WSL interop** needs an explicit escape test: running a `.exe` from inside
  the sandbox must fail (`WSL_INTEROP` cleared, `/run/WSL` not mounted).

## Protected paths

Read-only in every sandbox. For write/edit: deny in research, prompt from
default through trusted, allowed in yolo.

- Workspace: `.git/hooks`, `.git/config`, `.git/info`, `.pi/`, `.claude/`,
  `.agents/`, `.vscode/`, `.idea/`, `.envrc`.
- Repo instruction files: `AGENTS.md`, `CLAUDE.md`, repo `skills/`.
- Host: `~/.pi/agent/**` (config, installed extensions, memory) and shell rc
  files (`~/.zshrc`, `~/.bashrc`, `~/.profile`).
- Git worktrees: the workspace `.git` is a file pointing into the main clone's
  `.git/worktrees/<name>`. The main clone's `.git` is mounted with the same
  protections.

## Secrets

A built-in list of patterns (`.env*`, `*.pem`, `*.key`, and similar):

- masked to `/dev/null` inside sandboxes
- denied to read/grep
- per-project opt-out in `guard.json` (e.g. `.env.example`)

## Memory and instruction persistence

- Repo instruction files are protected paths (see above).
- `memory_write` stays allowed. guard adds no UI of its own: pi's default
  tool-call rendering already shows every write in the transcript.

## Accepted risks

- In default (and auto/trusted), the workspace is writable, so a sandboxed
  command can delete **untracked** files, which git cannot restore. Accepted
  for v1; same exposure as today's edit/write tools in edits mode.
- yolo runs without a sandbox and with protected paths writable; only your
  HostBash deny/ask rules still apply. unrestricted is 100% unrestricted, at
  your own risk: no sandbox, no rules, no prompts.
- Degraded mode relies on string-based rules, as today.
- Persistent background work can read newly exposed live-workspace files
  before the next execute refreshes mounts; overlays are not immutable
  snapshots. Raw descendants can escape tracking, so tightening cannot
  promise to revoke them or undo previous host effects.

## /plan integration

- Entering `/plan` switches the profile to research, held by plan.
- While plan holds research, profile changes (cycle or command) are
  **blocked** with a notice; `/plan cancel` is the way out.
- Every exit path restores the profile that was active before `/plan`:
  - `restoreTools`
  - the clear-context branch (`plan.ts:299`, which today skips
    `restoreTools`)
  - the cancelled new-session branch
  - recovery in `session_start` and `session_tree`
- plan keeps `narrowTools()` (hides write/edit) and now also hides
  `host_bash`.
- Research is also reachable directly through the cycle.

## Subagents (step 5)

Each dispatched child runs with an immutable inherited profile for its
process lifetime. It can only keep that profile or switch to research
(subject to the usual research-hold rules); there is no ordinal ceiling,
because the ladder is not a permission ordering (`default` can allow what
`auto` denies through classification, so an `auto` child must not be able to
move to `default`). Ordinary sessions without inheritance keep their existing
behavior.

### Contract

- One environment variable, `PI_GUARD_INHERIT`, carries a bounded, strictly
  validated JSON object `{ version: 1, profile, nonce }` (`policy/inheritance.ts`,
  pure, no `process.env` access). An absent variable denotes an ordinary
  session; an explicitly present empty or invalid variable blocks the child:
  guard keeps an explicit blocked state (no executable runtime, owned
  executors fail closed, profile changes and research refuse) and never
  initializes a default-profile fallback.
- The guard factory parses the contract once per process, so later
  environment changes cannot relax a running child. The nonce is a fresh
  per-child correlation identifier, not a credential; no credentials or
  policy configuration travel in the contract.
- Only the profile is inherited. The child loads its own user/project guard
  configuration for its cwd; parent rules, masks, roots, session read grants,
  workspace locks, scratch, workers, and research-holder ownership are never
  copied. A locked parent refuses dispatch rather than transmitting its lock.

### Snapshot at each spawn

The subagent extension queries the parent guard over a synchronous bus
handshake (`guard:subagent-snapshot-request`/`ack`, versioned, correlated) at
every actual spawn: single dispatch, each parallel task (including tasks
waiting for a concurrency slot), each later chain step, and nested dispatch.
The query runs after all asynchronous prompt preparation and immediately
before `spawn()`, with no await in between; cached `guard:profile` events are
not used because they cannot distinguish an idle runtime from a transition in
progress. The responder is synchronous and read-only, and refuses when the
guard is absent or uninitialized, transitioning, workspace-locked, blocked by
unresolved teardown, has invalid inheritance, or answers for a mismatched
cwd. Dispatch fails closed: no defaulting to `default`, no unguarded
fallback. The handshake requires exactly one correlated synchronous
acknowledgment: every additional matching acknowledgment, including an
identical duplicate, refuses the dispatch, because multiple responses
indicate an ambiguous or duplicated responder configuration. Responses with
unrelated correlation identifiers are ignored and do not count as
duplicates. Already-running children keep their launch snapshot; entering
research does not retroactively tighten existing children, and there is no
live policy propagation.

### Child startup gate

The child also receives `extensions/subagent/guard-bootstrap.ts` via
`--extension` (resolved through `import.meta.url`, never the child cwd). At
the child's first agent start, after session initialization and before the
first delegated model request, it demands proof over a second synchronous
channel (`guard:child-contract-request`/`ack`) that the child's guard
consumed the exact contract: supported version, matching nonce, matching
inherited profile, the restriction installed, and a valid current profile
with an available runtime. Exactly one correlated synchronous
acknowledgment is required; every additional matching acknowledgment,
including an identical duplicate, fails the gate. An ordinary
`guard:profile` event or a coincidentally matching `default` profile is not
proof; a guard without the responder never answers, so older implementations
fail the gate. The gate
revalidates on every run and blocks tool calls until proof exists. On
missing, stale, invalid, or refused proof the dedicated child writes one
bounded stderr line and exits nonzero before any delegated execution; stdout
stays reserved for pi's JSON events. The fatal path is child-only: pi catches
handler errors and print mode has no shutdown handler, so an ordinary parent
session must never load this bootstrap.

### Headless denial

Any prompt in a headless run is denied, including host_bash, regardless of
the legacy `nonInteractiveAsk` setting. Sandboxed work stays free, so workers
remain useful.

### Accepted limitations

- This step provides profile inheritance and startup validation only, not
  complete child-tool containment: guard enforces `bash`, `host_bash`,
  `python`, and `node`; `write`, `edit`, local reads, and remote tools stay
  observe-only during coexistence.
- Child cwd/config differences can change per-call permissions.
- Running children retain their original snapshot.
- Environment inheritance governs supported subagent dispatch, not arbitrary
  processes launched through permitted raw host execution.
- Trusted extensions run with host privileges; the handshake is not a defense
  against malicious extensions.
- **Deferred:** forwarding child prompts to the parent UI.
- Reminder: children load the **installed** extensions from
  `~/.pi/agent/git/github.com/lucaspimentel/pi-extensions`, not the working
  tree. End-to-end testing against the installed package needs commit, push,
  and `pi update`.

## Decision log (2026-10-02)

| Topic | Decision |
|---|---|
| Platform | Linux/WSL full; Windows and missing-bwrap Linux degraded |
| Architecture | One guard extension; plan separate with ack handshake |
| Escape shape | Separate `host_bash` tool |
| Manual profile | Dropped |
| Remote gating | By attacker-readable sink |
| Workspace secrets | Mask list with per-project opt-out |
| Instruction files | Protected; memory_write allowed and shown |
| Ladder | research / default / auto / trusted / yolo |
| yolo | 100% unrestricted, sandboxes off (bash, python, node) |
| Research execution | Throwaway overlay |
| Untracked-file loss | Accepted for v1 |
| Sandbox unavailable | Degrade like Windows |
| Degraded research | Read-only bash tier only |
| Auto-routing | No |
| Rule migration | Manual purge; `/guard migrate` lists suspected code runners |
| pwsh | Windows only |
| Subagents | Inherit profile; never escape; prompt forwarding deferred |
| Config | New `guard.json` plus `/guard migrate` |
| Caches | Read-only plus per-call overlay |
| Research remote reads | Same as default (prompt for exfil-capable) |
| Research entry | In the cycle; yolo also in the cycle |
| Rollout | Build alongside, switch over at parity |
| Network proxy | After switchover |
| Plan vs cycle | Profile changes blocked while plan holds research |
| After /plan | Restore pre-plan profile |
| yolo entry | No confirmation |
| Start profile | default, always |
| python/node research overlay (step 0) | One throwaway overlay per worker lifetime |
| python/node in yolo (step 0) | Fully raw: worker kept; no bwrap, seccomp, rlimits; full env and filesystem |
| pwsh on Windows (step 0) | Host tier like host_bash, own `Pwsh(...)` rules |
| Auto classifier scope (step 0) | host_bash, pwsh, write/edit, exfil-capable remote reads, remote writes; sandboxed calls skip it |
| Degraded tools (step 0) | Both names registered, identical host executors, footer warning |
| NuGet audit (step 0) | `NuGetAudit=false` in sandboxes, documented |
| Read-only tier on host_bash (step 0) | Applies, tightened: no env/printenv, `$` expansion and secret-mask file args veto |
| Sandbox library origin | Fresh in guard, borrowing the duplicated python/node code; old extensions untouched |
| Seccomp mechanism | One compiled C launcher for bash, python, and node; python's ctypes install dropped |
| Overlay step | Launcher outer mode (no shell) |
| Seccomp policy | One lighter policy for all three (socket allowed) |
| Launcher unavailable | Reduced sandbox (bwrap only, no seccomp or overlays, read-only fallback) |
| Launcher cache | `~/.cache/pi-guard/<arch>-<hash>/`, 0700, verified; prune siblings older than 7 days after compile |
| Rlimits | Per tool: python/node keep today's; bash core 0 only |
| Sandbox paths (step 1) | 1:1 with host paths for every tool (workspace, read roots, toolchains, caches); python/node move off /workspace in step 3 |
| .git protection (step 1) | The entire top-level .git is read-only; git writes go through host_bash |
| Protected-path gap (step 1) | Top-level and nested binds plus a post-call audit: created/replaced/missing detection, quarantine (never deleted), lockWrites |
| Mask discovery (step 1) | Every launch, one scan for masks and nested protected entries: fd with a find fallback, pruned build dirs and .git contents, 5 s timeout and a 500-match cap that fail the launch |
| Toolchain credentials (step 1) | /dev/null over ~/.cargo/credentials(.toml); a sanitized NuGet.Config copy (packageSourceCredentials and apikeys removed) over the original |
| Userns blocking (step 1) | bwrap --disable-userns with --unshare-user, not seccomp |
| Mask scope (step 1) | Workspace only; granted read roots are not scanned (cost); documented limitation |
| Mask exceptions (step 1) | .env.example, .env.sample, .env.template by default; guard.json per-project overrides arrive in step 2 |
| Mask mechanism (step 1) | /dev/null via --dev-bind: a device bind made with --ro-bind inside the user namespace is nodev-enforced and reads fail with EACCES |
| Project nuget.config (step 1) | Workspace-level nuget.config files are left alone (masking would break restore); listed in the threat model |
| Scan failure (step 1) | Scan timeout or cap fails the launch with an actionable diagnostic; never launches unmasked |
| Step-2 runtime (step 2) | Observe-only, registered in pi.extensions; decisions on `guard:decision`; `/guard debug on\|off` |
| Ladder (step 2) | Six profiles: research / default / auto / trusted / yolo / unrestricted (supersedes the five-profile ladder) |
| Two yolo tiers (step 2) | yolo: no sandbox, HostBash deny/ask rules still apply; unrestricted: no sandbox, rules ignored |
| Cycle hotkey (step 2) | ctrl+alt+g (overridable via cycleShortcut); cycles research..yolo; unrestricted is command-only; supersedes Ctrl+Alt+M |
| Research rules (step 2) | Absolute: HostBash rules change nothing; host shells deny; degraded sandboxed bash read-only tier only |
| Local reads (step 2) | Port today's model: allow in cwd and read roots, prompt outside with session/project/user grants; secret-mask files denied to read/grep except in yolo and unrestricted |
| Tool classification (step 2) | Built-in map, then guard.json toolClasses, then annotations, then name heuristic; unknown is a remote write; same for both MCP naming styles |
| pup_run (step 2) | Classified by subcommand verb (reads allowed, writes and unknown verbs are remote writes) |
| Migrate scope (step 2) | Everything with a guard home (HostBash, read/write roots, webFetchAllow, MCP toolClasses, validators, classifier); the rest listed as dropped |
| Migrate writes (step 2) | Preview and confirm; union with dedupe, idempotent, never removes entries; per scope |
| Prompt UX (step 2) | Step 2 adds pure suggestRule and save helpers; dialogs land with enforcement in step 3 |
| memory_write (step 2) | No guard UI; pi's default tool-call rendering shows writes (supersedes "shown in the UI") |
| Step-2 implementation (2026-10-06) | Policy core shipped observe-only: six profiles, decision function, classification, guard.json with toolClasses, /guard (list/reload/profile/migrate/ack/debug), ctrl+alt+g cycle, footer status, migrate (preview + confirm, idempotent union); tests in tests/guard-{policy,classes,migrate,harness}.test.mts |
| Step-2 mask scope (2026-10-06) | Secret-mask read denial is path-level only in step 2; a directory grep that touches a masked file is allowed; step 3 adds a tool_result filter dropping matches from masked files |
| Step-3 enforcement scope (2026-10-06) | guard enforces only its own four tools; other tools stay observe-only except the grep/ffgrep mask filter (filtering, not blocking) |
| Step-3 registration (2026-10-06) | All four tools registered in step 3; guard wins the registry (declared first, first-extension-wins) and the old python/node extensions go dormant until switchover; closes the old sandboxes' .git/.pi hole early |
| Step-3 host_bash silencing (2026-10-06) | Manual bare "host_bash" allow entry in pi-tool-permissions.json; README documents it, /guard migrate reminds when missing; guard never writes another extension's config |
| Step-3 Bash ask rules (2026-10-06) | The three Bash ask rules (rm, git push) stay until switchover; they keep prompting on sandboxed calls and stay meaningful in degraded mode |
| Step-3 dialogs (2026-10-06) | Allow once / allow and save the suggested rule / deny; no mid-dialog profile switching; local-read grants keep session/project/user/deny; headless prompts deny |
| Step-3 mask filter (2026-10-06) | tool_result filter on grep/ffgrep: drop matches from masked paths, append a summary line, replace structuredContent too; every profile except yolo/unrestricted |
| Step-3 audit response (2026-10-06) | Escaped protected-path writes are quarantined and notified; the tool result is not failed (defense-in-depth telemetry, not a denial path) |
| Step-3 review: isolation | Worker-lifetime overlays in every sandboxed profile; shared real-path scratch persists across remounts; reduced workers read-only |
| Step-3 review: lifecycle | Serialized execution; tightening preempts and awaits teardown; failed teardown blocks; research boundaries reset; scans before worker execute |
| Step-3 review: audits | All sandboxed tools and teardown boundaries; union of pre/post paths; any violation or incomplete containment locks and denies host/raw even in unrestricted |
| Step-3 review: dialogs | Explicit asks once/deny; fallback exact rules, project/user choice, save only effective patches; stale approvals cancel; grants never replay |
| Step-3 review: ownership | Fixed executor identities; guard-owned roots only; raw bash honors HostBash rules; failed sandbox launches never fall back |
| Step-3 review: filtering | Context, structured data and metadata redacted; unsupported or failed parsing suppresses the entire result |
| Step-3 review: residual risks | Idle background reads may precede mount refresh; raw descendants may escape tracking |
| Step-3 implementation (2026-10-07) | Shipped: four tools registered ahead of python/node (authoritative, dormant old extensions), one execution queue with pre-spawn revalidation and fail-closed transitions, worker-lifetime overlays plus shared real-path scratch, audits around all sandboxed execution with union pre/post comparison and violation/scan/quarantine locking, exact/effective rule saving with stale-approval cancellation, no grant replay, fixed executor identities, raw bash under HostBash rules, and the fail-closed grep/ffgrep mask filter; suites guard-{sandbox,policy,classes,migrate,filter,workers,runtime,harness} |
| Step-4 implementation (2026-10-07) | Shipped: /plan requests the research hold before narrowing and refuses without an ack (timeout covers guard-absent); narrowTools hides host_bash; every exit path releases (awaited release-ack, background release on recovery/clear-context, warning on failed release); menu only on completed agent_before_settle (Batch B) |
| Step-5 restriction shape (2026-10-07) | Allow-list (inherited profile + research), not an ordinal ceiling: the ladder is not a permission ordering, so an auto child must not reach default; refusals explain instead of clamping |
| pwsh extension removed (2026-10-07) | `extensions/pwsh.ts` deleted and unregistered: pi's built-in `powershell` tool (opt-in via `defaultTools`) replaces it. Guard classifies the built-in name as a host shell on the pwsh tier (`shell: "pwsh"`, `Pwsh(...)` rules, pwsh cells, no read-only tier); `Pwsh(...)` rules in guard.json keep applying. pi-tool-permissions pwsh handling left untouched until switchover; user settings untouched |
| Step-5 snapshot (2026-10-07) | Fresh synchronous snapshot query per actual spawn (single, each parallel task, each chain step, nested); no cached profile events; no retroactive tightening of running children |
| Step-5 child config (2026-10-07) | Profile only: the child loads its own config for its cwd; locks are never transmitted (locked parents refuse dispatch) |
| Step-5 gate (2026-10-07) | Dedicated bootstrap extension passed with --extension; synchronous contract ack proves version/nonce/profile/restriction/runtime; child-only fatal path (stderr + exit 1) because pi catches handler errors and print mode has no shutdown handler |
| Step-5 scope (2026-10-07) | Profile inheritance and startup validation only: write/edit/local reads/remote tools stay observe-only; parent prompt forwarding and broader process supervision deferred |
| Step-5 single responder (2026-10-07) | Require exactly one correlated synchronous acknowledgment per handshake query; every additional matching acknowledgment, including an identical duplicate, fails closed regardless of order, validity, version, or payload |
| Bash ask read-root escalation (2026-10-07) | Deliberate omission: bash/host_bash ask dialogs offer no inline read-root grant (pi-tool-permissions did, `extensions/pi-tool-permissions/index.ts:999-1129`). Read roots are granted only via the python/node permission_needed path, where kernel-enforced read-only mounts make the grant meaningful |
| Annotation fallback (2026-10-07) | A destructive hint wins over a contradictory read-only hint: conflicting self-declared claims classify as remote-write; the rest of the precedence order is unchanged |
| Built-in lookup hardening (2026-10-07) | Built-in recognition uses explicit own map entries only (`Object.hasOwn`) in both `classifyToolCall` and `isPlanningToolAllowed`: inherited Object.prototype names (`constructor`, `__proto__`) are ordinary custom tools, so they follow the normal annotation/configuration/fallback rules (unannotated or conflicting-hint instances are removed during planning and classified remote-write; adequately read-only annotated instances stay and classify remote-read); no name is reserved or prohibited |
| Dialog mutex (2026-10-08) | One guard-owned FIFO `DialogGate` per factory (not per dialog kind, runtime, or session) serializes approvals, read grants, the profile picker, and migrate confirmation. A plain promise-chain mutex was rejected as the mechanism: it cannot remove aborted queued requests promptly or cancel open selectors. Cancellation combines the caller's signal with a private per-request signal passed to the SDK selector's `{ signal }` option; policy and lifecycle boundaries invalidate synchronously; the lease spans pre-display validation, the selector, and post-answer validation only. See the Ask dialogs section for the full contract. |
| Spinner hiding (2026-10-08) | All four admitted TUI selectors hide the working spinner before opening and restore it on every settle path through one TUI-only selector wrapper (`gatedSelect` in `guard/index.ts`); restoration always passes `true` because the UI API has no visibility getter, matching the legacy extension. Visibility failures are caught as presentation-only: they never change authorization, replace a selector result or error, or block gate cleanup. Queued, stale-before-display, headless, and dry requests never toggle visibility, and queued cancellation cannot restore the spinner underneath another open selector. RPC is untouched: its setter is a no-op, so non-TUI modes skip the toggling entirely |
| Command cancellation through final commit (2026-10-08) | The profile picker and migrate confirmation capture the initiating command operation's `ctx.signal` once (a live SDK getter; rereading after the dialog would return `undefined` or another operation's signal) and pass it to the shared gate, closing the gap where the two command dialogs ran with empty gate options. The captured signal is rechecked through a command-only final commit guard inside the runtime's existing `beforeCommit` hook with the captured expected epoch: after asynchronous teardown, before policy assignment/publication (picker) and before privileged configuration writes (migration), so cancellation during pending teardown prevents the requested change. Classification is by per-operation Error identity only; genuine teardown, storage, audit, and source-validation failures keep their diagnostics. Direct `/guard profile <name>`, profile cycling, reload, ack, approvals, and read grants are unchanged; no rollback of completed commits or started teardown; expected cancellation is a warning notice and a normal return. Suites: `tests/guard-dialogs.test.mts` (registration-level, both commands), `tests/guard-runtime.test.mts` (teardown ordering). |
| Hideable overlay delivery (2026-10-09) | The four TUI dialogs render through a guard-owned overlay adapter (`guard/ask-overlay.ts`) instead of `ctx.ui.custom`: the SDK's custom-overlay completion callback pops the LAST overlay, and a controlled probe proved that cancelling a hidden guard overlay under a foreign overlay removes the foreign overlay while its promise stays pending and leaves the cancelled overlay mounted (host 1.1.0 has the same implementation; do not patch or upgrade the SDK for this). The adapter borrows the renderer through a uniquely keyed zero-height `ui.setWidget` bridge removed immediately (the host's removal path is verified with a canary removal before borrowing, which filters hosts that refuse every deletion; the bridge key stays inside the owned-resource cleanup boundary so a post-canary deletion failure is retried best-effort there, and an entry can only remain if both deletion attempts fail), mounts through public `TUI.showOverlay`, and owns the returned handle: `setHidden` for the ctrl+] toggle (raw `ui.onTerminalInput`, press-only, focused-or-hidden only, consumes the key) and `handle.hide()` for removal, which preserves a foreign overlay's focus. Every setup failure (bridge removal, acquisition, selector construction, mounting) runs one owned-resource cleanup and propagates the genuine error; failed or cancelled displays are never retried. The details body is bounded by MEASURED chrome (a one-line-title twin selector verifies the recomposition of the selector's public render output at the current width, so wrapped option labels and key hints are budgeted exactly; the adapter never touches SDK-private fields), with PgUp/PgDn access to overflow at any title budget including a one-line window; approval eligibility is recomputed from the live terminal dimensions on every input (fail closed before the first paint), and a terminal whose controls alone cannot fit disables approval with a wrapped warning while keeping Esc. Capability gaps fall back to the signal-aware native selector before mounting. Ownership is guard-local: no global overlay coordinator, and foreign extensions using the unsafe `ui.custom` completion path remain exposed. Suites: `tests/guard-ask-overlay.test.mts` (adapter + real pi-tui boundary), `tests/guard-dialogs.test.mts` (wiring through the registered handlers); offline PTY smoke with a real pi subprocess verified open/hide/show/apply; the user completed the visual checklist and reported "done, looks good" on 2026-10-09 (user-confirmed, not assistant-observed). Review follow-up (2026-10-09): the five findings from the post-commit review are fixed; the review probe asserting visible choices and the hide hint in an 8-column terminal is unsatisfiable (the compositor truncates overlay lines to the resolved width, and the measured chrome alone is 27 rows), so the fail-closed blocked state is the implemented behavior there |
| Save/deny/compound prompt design (2026-10-09) | User-confirmed design only, not implemented: flat actions, persistent rule/root editors, validated preview, independent allow-rule bundles for needed steps, multi-select deny suggestions, manual deny entry on unreliable parsing, and optional steering collected before commit. No session deny or deny-and-stop; all TUI stages retain owned hide/show and the existing gate/commit barriers. See Save, deny, and compound prompts. Implementation and step 6 remain unauthorized. |
| Planning eligibility (2026-10-07) | `/plan` filters the ACTIVE set through `isPlanningToolAllowed`: built-in host-shell/local-write removed regardless of hints; built-in read/sandboxed/meta classes stay; everything else needs `readOnlyHint === true && destructiveHint !== true` from a fresh getAllTools lookup; toolClasses overrides create no planning exceptions; input-dependent wrappers qualify only via explicit annotations |
| Worker capability metadata (2026-10-07) | Conservative static annotations on this repo's tools: web/web_search/Slack reads read-only open-world, session_search read-only closed-domain, guard python/node write-capable open-world (raw profiles expose the host); read-only hints describe intended operations, not the absence of internal caches or index files |
| Plan narrowing limits (2026-10-07) | Entry-time declaration filtering only, not execution containment: codemode/deferred tools can remain callable, tool_search or another extension can change activation afterwards, nested non-owned calls stay observe-only until step 6, trusted extensions have host privileges, annotations are unverified author hints |

## Implementation outline (build alongside, switch over)

1. **Shared sandbox library** in guard: bwrap args, the two-mode C launcher
   (overlays, seccomp, rlimits) and its cache, read roots, protected-path and
   secret overmounts, environment allowlist, full/reduced mode detection.
   - Verify: escape tests (read `~/.ssh`, write `.git/hooks` and `.pi/x.json`,
     read a masked `.env`, `curl`, environment leak, `.exe` via WSL interop,
     TIOCSTI); happy path (offline `cargo test`, `dotnet test`; a
     research-overlay write leaves the workspace untouched; a cache-overlay
     write does not persist); launcher tests (cache keying, the 0700 and
     ownership check refusing a foreign or group/world-writable directory,
     pruning, reduced vs full mode selection).
2. **Policy core:** six profiles and the rule precedence table, decision
   function (including local reads and secret-mask read denial), tool
   classification (built-in map, `toolClasses`, annotations, heuristic,
   `pup_run` verbs, both MCP styles), `guard.json` loading, pure
   `suggestRule` and save helpers, `/guard migrate` (full scope, preview +
   confirm, idempotent union), ctrl+alt+g cycle, `/guard debug`, footer
   status, degraded mode; registered in `pi.extensions` in observe-only
   mode.
   - Verify: decision-level tests for every profile and tool-class cell in
     the profile table (research with allow/ask rules, yolo vs unrestricted
     with deny/ask rules); classification tests (built-ins, both MCP styles,
     `pup_run` verbs, toolClasses override, annotation fallback, unknown
     tool); migration fixtures (every conversion, dropped list, runner list,
     second run is a no-op); `npm run test:guard` includes the policy
     suite; a live pi session loads guard without a shortcut conflict.
3. **Tools:** sandboxed `bash`, `host_bash`, and python/node ported onto the
   shared library; registered in `pi.extensions` ahead of the old
   python/node extensions, which go dormant; enforcement on for guard's
   own tools plus the mask filter.
   - Verify: python/node suites pass on the shared library; research overlay
     discards writes; yolo runs unsandboxed; escape tests (read `~/.ssh`,
     write `.git/hooks`, read a masked `.env`, `curl`, environment leak)
     fail inside the sandbox; mask filter drops grep/ffgrep matches and
     notes the omission; ask dialogs offer allow/rule/deny and persist the
     suggested rule; audit quarantines an injected protected-path write and
     only warns; /guard migrate reminds when `host_bash` is not
     allow-listed in pi-tool-permissions.
4. **plan.ts integration:** research request with acknowledgment, lock while
   held, restore on every exit path.
   - Verify: each exit path (accept, clear-context, revise then stop,
     `/plan cancel`, resume mid-plan) restores the pre-plan profile.
5. **Subagent inheritance** through an environment variable; headless prompts
   deny.
6. **Switchover:** load guard by default, unload pi-tool-permissions, python,
   and node; remove pwsh on Linux.
7. **Later:** package-registry network proxy; prompt forwarding for
   subagents.

Test commands today: `node extensions/pi-tool-permissions/run-all.mjs`,
`npm run test:python`, and the node equivalents under `tests/`.
