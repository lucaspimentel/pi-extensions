# Guard: sandbox-first permission redesign

Status: **design settled (2026-10-02 grilling sessions, including step 0:
assumptions confirmed); step 1 (shared sandbox library) implemented in
`extensions/guard/sandbox/`; step 2 (policy core) implemented and
observe-only in `extensions/guard/index.ts` + `policy/` (2026-10-06); step 3
(tools and enforcement) implemented in `runtime.ts`, `tools/`, and
`filter.ts` after the 2026-10-06/07 design review closed the audit,
lifecycle, and filter gaps (see the decision log); step 4 (plan.ts
integration) implemented in `extensions/plan.ts` (2026-10-07), retired
2026-10-26 in favor of the agent-skills plan skill and deleted 2026-10-28;
step 5 (subagent inheritance) implemented (2026-10-07); dialog gate, spinner,
cancellation, and owned overlays implemented and visually confirmed by the
user (2026-10-09). The save/deny/compound prompt contract below is confirmed
but not implemented; step 6 switchover is not authorized.**

Scope: a new `guard` extension that replaces `extensions/pi-tool-permissions/`
(still loaded until switchover), `extensions/python/`, and
`extensions/node/` (the two standalone directories were deleted 2026-10-28;
see the decision log), plus changes to `extensions/subagent/`. The standalone
`extensions/pwsh.ts` extension and the `extensions/plan.ts` integration were
removed outright (see the decision log).
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
| `/plan` is not read-only | `plan.ts:199` (`narrowTools()`) hides only write/edit. bash, pwsh, python, node, MCP, and subagent stay active. The only other safeguard is prompt text (`plan.ts:55`). (Historical; closed by the research handshake and the 2026-10-07 annotation-aware narrowing, see Planning eligibility below.) (Historical; superseded by retirement of the manifest-registered plan.ts extension on 2026-10-26 in favor of the agent-skills plan skill.) |
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
  timeout. **Superseded for SDK 11 and later:** those SDKs create a
  user-scoped shared-memory directory for named mutexes at
  `~/.dotnet/corefx/Runtime` on every `dotnet` startup (the first-run and
  NuGet-migration path, `System.IO.SharedMemoryHelpers` in
  `System.Private.CoreLib`), so a fully read-only `~/.dotnet` aborts `dotnet`
  before it builds anything with `IOException: Read-only file system`. Only
  that state path is now a per-launch overlay; `~/.dotnet` itself (SDK, host,
  tools) stays a read-only bind. No environment variable moves the path
  (`DOTNET_CLI_HOME` has no effect, `TMPDIR` is not consulted).
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
5. **Tightening only** for subagent inheritance: parents can tighten the
   policy; nothing downstream loosens it.

## Platform

- **Linux/WSL:** the full design.
- **Degraded mode:** native Windows, or Linux where bwrap or user namespaces
  are missing.
  - `bash` is denied by name (it is sandbox-only), `host_bash` is the host
    executor (HostBash rules, the read-only tier and validators), and
    python/node are unavailable. A persistent "no sandbox" footer warning is
    shown. (Superseded 2026-10-26: `bash` and `host_bash` used to be identical
    host executors here; see the sandbox-only decision row.)
  - In research, `host_bash` runs only commands the string-based read-only
    tier and validators prove read-only; everything else is denied, and rules
    never widen that set. (Superseded 2026-10-26: this tier used to run as the
    degraded "sandboxed" bash.)
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
  | Degraded | no bwrap or no user namespaces (or native Windows) | As above: `bash` denied by name, `host_bash` is the host shell (read-only tier only in research), python/node unavailable |

## Architecture

- One new **`guard`** extension owns the policy. It contains the permissions
  logic (from pi-tool-permissions), the shared sandbox library, and the
  `bash`, `host_bash`, `python`, and `node` tools.
- **Sandbox library origin:** written fresh in `extensions/guard/`, copying
  and adapting the logic the python/node extensions duplicated at the time
  (read-root filtering, bwrap args, merged-`/usr` handling, interpreter binds
  including linuxbrew, dependency checks). Their workers, protocols, and
  sessions had already been ported into `guard/tools/python/` and
  `guard/tools/node/`, so the standalone `python/` and `node/` directories
  were deleted on 2026-10-28, before switchover.
- **plan.ts was separate.** It requested the research profile from guard over
  `pi.events` and refused to start `/plan` without an acknowledgment.
  (Historical; superseded by retirement of the manifest-registered plan.ts
  extension on 2026-10-26 in favor of the agent-skills plan skill;
  `isPlanningToolAllowed` and the research channels were deleted on
  2026-10-28.)
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
  the classifier pin, and the natural-language lists. Scalars: project wins;
  lists: union with dedupe. A corrupt file is ignored with a warning and
  never discards the other scope.
- **Classifier model pin** (2026-10-30, supersedes the `classifier`
  `{ provider, model }` object and its project-wins merge): the top-level
  string `"model": "provider/modelId"`, read from the **user file only**.
  Resolution is shared with idle-summary and session-name-llm
  (`extensions/shared/model-pin.ts`): the pinned model when
  `modelRegistry.find` returns it and it has configured auth, otherwise the
  session model (`ctx.model`), priced or not; no pool ranking, pricing, or
  provider preference. An unpinned session model without configured auth
  means no classifier (fallthroughs prompt). An unusable pin is reported
  once per session; a project `model`/`classifier` key is ignored with a
  once-per-session warning; a user `classifier` object warns that it is no
  longer read. The classifier cache key carries the label of the model that
  actually classifies, so a mid-session model switch never reuses another
  model's verdicts, and a `model_select` handler refreshes the auto footer
  label.
- **`/guard migrate`** converts `pi-tool-permissions.json` (user and project
  scopes, including their legacy fallback paths). Everything that has a home
  in guard carries over:
  - `Bash(...)` rules -> `HostBash(...)` in the same slot;
  - `readAllowPaths` -> `readRoots`; `writeAllowPaths` -> `writeRoots`;
  - `WebFetch(domain:x)` allow rules -> `webFetchAllow` URL globs;
  - MCP allow rules -> read entries in `toolClasses`;
  - `bashValidators` and the auto-mode classifier lists as-is; the
    user-scope `autoMode.classifier` becomes `"model": "provider/modelId"`,
    and a project-scope one is listed as dropped (user-file-only pin).

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
| `bash` | Always sandboxed, in every profile: degraded mode and the unlocked raw profiles (yolo, unrestricted) deny a `bash` call by name and name `host_bash` instead, and a workspace lock forces the read-only sandbox back on. Built with `createBashTool()` plus bwrap-spawning `BashOperations`. One process per call, no persistent shell. |
| `host_bash` | The only escape from the sandbox. `HostBash(...)` rules plus the tightened host read-only tier (below) apply to it. |
| `python`, `node` | Persistent interpreters moved into guard. Every sandboxed profile uses a worker-lifetime workspace overlay (read-only in reduced mode); workspace writes never reach the host. Persist outputs in shared scratch. Yolo/unrestricted are fully raw. |
| `pwsh` | Not registered by guard. pi's built-in opt-in `powershell` tool is classified as a host shell on the pwsh tier (`Pwsh(...)` rules) whenever it is enabled. |

- **Read-only tier:** the read-only command tier, the validators
  (duckdb/mlr/find/awk), and the redirect checks apply to `host_bash`
  everywhere it runs: the ordinary host-shell rows (so HostBash deny/ask rules
  are honored) and degraded mode, where research is tier-only.
  (Superseded 2026-10-26: these checks used to cover every path where
  sandboxed `bash` executed on the host, degraded mode and yolo/unrestricted
  raw execution included.) Sandboxed `bash` under the kernel sandbox
  (full/reduced, non-raw) is decided by the profile cell alone: the sandbox
  is the guarantee, so no string-based tier runs. Provably read-only host
  commands auto-allow. The tier has no network commands, and path-taking
  commands are already restricted to cwd and read roots.
- **Tightened host tier** (host_bash only; these cases prompt instead).
  Since the shell-ast adoption (2026-11-06) the tier judges the call's
  **unwrapped argv** plus its structured redirects, never the subject text:
  - `env` and `printenv` as the unwrapped command word are removed from the
    tier (the host environment holds tokens; the sandbox environment is
    scrubbed). `env FOO=1 <cmd>` unwraps to `<cmd>` and no longer trips this
    veto (a reviewed widening);
  - any `$` expansion the analysis reports (`hasParameterExpansion`, which
    includes arithmetic `$((...))` and parameters nested in brace expansion)
    vetoes auto-allow (`echo $GITHUB_TOKEN`); `echo "'$HOME'"` is still
    flagged;
  - the AST analysis is the fail-closed screen: a call whose own span holds a
    construct guard cannot evaluate (command/process substitution,
    backgrounding, grouping, heredocs), or one nested inside `$((...))` /
    `{...}`, prompts before the tier and every allow rule. `command` is not
    read-only (`command touch probe` prompts), and `command -v X` / `-V X`
    are plain queries, not wrappers, so they are never unwrapped to `X`.
    File-output redirects stay with the redirect-aware rule machinery, and
    descriptor dups (`2>&1`) stay tier-eligible; the redirect gate is derived
    from the analysis's redirect structures with the same writeRoots
    exemptions;
  - the read-only name sets and the duckdb/mlr/find/awk validators are fed
    the unwrapped argv, so a wrapper chain (`command ls`, `xargs cat`) is
    judged by its inner command; an input redirect blocks the path-taking
    branches (its target is not in argv);
  - file arguments matching the secret-mask patterns veto auto-allow
    (`cat .env`).
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
  for user, or deny. Host-shell allow suggestions are glob rules for the
  command or step subject (`HostBash(...)` / `Pwsh(...)`); deny suggestions
  stay anchored exact regexes. A subject containing `*` or `?`, or one that
  both starts and ends with `/`, yields a rule that matches more than the
  command shown, and any rule that is not the exact rendering of its subject
  carries a non-blocking advisory note. Saving is offered only if the merged
  patch authorizes the whole call. Show the rule/destination and never
  remove ask/deny rules. Cancel stale approvals without execution or
  persistence. Headless prompts deny. The dialog gate, spinner hiding, final-commit cancellation,
  and ctrl+] owned overlays are implemented; the user confirmed the visual
  check on 2026-10-09. Herdr blocked signaling is implemented (2026-10-09,
  below and in the decision log). The confirmed editor, deny-save, steering,
  and compound-breakdown behavior in
  [Save, deny, and compound prompts](#save-deny-and-compound-prompts) is
  implemented (2026-10-13; see its decision-log entry for the settled RPC
  deferral, steering handoff limits, and capability-limited fallback).
  Other UX items stay separately tracked in the root TODO.md; step 6
  remains unauthorized.
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
  host_bash honors HostBash deny/ask (superseded 2026-10-26: this used to be
  raw/degraded bash, which no longer runs on the host at all); unrestricted
  ignores them except for workspace locks. Keep unavailable worker
  registrations in degraded mode; never fall back to host on a sandbox launch
  error.
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

**Status: implemented 2026-10-13 on the confirmed contract below (the
implementation decisions and remaining limits are recorded in the decision
log entry "Save/deny/compound prompt implementation"); REVISED 2026-10-19,
user-confirmed, and the revision IMPLEMENTED 2026-10-20: per-step allow
saves (step picker with preselection, per-step validation, post-commit
re-prompt loop, save notifications) replace the 2026-10-13
whole-call/bundle allow-save contract whenever the breakdown is reliable;
unreliable breakdowns keep the whole-call suggestion. REVISED 2026-10-26,
user-confirmed and implemented: allow prefills are glob-form (deny prefills
stay anchored exact), and any rule that is not the exact rendering of its
reference subject carries a non-blocking advisory note. REVISED AGAIN
2026-10-26, user-confirmed and implemented: **Allow for this session** adds
memory-only, workspace-scoped host-shell allow rules that reuse this whole
flow. REVISED 2026-11-06: Bash wildcard, regex-shaped, and expansion-marker
prefills use anchored exact regexes; Pwsh is unchanged. See the decision log entries "Per-step allow saves (2026-10-19)",
"Glob-form allow prefills and the not-exact advisory (2026-10-26)", and
"Session-scoped host-shell grants (2026-10-26)". RPC persistent saves and
RPC session command grants are deferred; step 6 remains unauthorized.**

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
- Use flat, explicit execution-approval choices: **Allow once**, **Allow for
  this session**, **Save allow for project**, **Save allow for user**, **Deny
  once**, **Save deny for project**, and **Save deny for user**. Offer save
  actions only where the representation and effective policy support them, and
  offer the session action only where an eligible allow plan exists (which
  already excludes explicit asks and requires the owned stages) and the
  workspace's canonical identity resolves.
- The allow step picker describes what it prefills: allow rules for the
  selected steps. The wording applies to
  the session and the persistent paths alike; only the trailing verb
  ("grant" versus "save") differs.
- **Session-scoped allow grants (2026-10-26).** The session action routes
  through the same picker, prefill, parser, validation loop, advisory, and
  confirm/edit/cancel preview as a project/user allow save; the destination
  and the wording differ (the session path says grant where a save says save,
  including the preview's cancelling action). The reviewed rules are
  installed in memory at the commit boundary and never serialized: no config
  file, session entry, environment variable, or child-inheritance payload
  carries them, and
  `config`, its signature, and every persistence target stay disk-only.
  Lifetime is the session: compaction, tree navigation (including a cwd
  change), `/guard reload`, and profile changes preserve the records; a fresh
  session start or process restart clears them, and child agents never
  receive them. A record is bound to the granting workspace and its
  descendants: applicability requires lexical containment of the current
  workspace AND, when it resolves on disk, physical (realpath) containment,
  so a symlinked descendant that escapes the scope and a lexically-outside
  symlink into it are both rejected; an unresolvable identity fails closed.
  Records for other workspaces go dormant rather than being discarded, so
  returning reactivates them. The rules are ordinary additive allow rules:
  explicit deny/ask precedence, redirect-aware matching, structural-parser
  restrictions, workspace locks, inherited restrictions, and unresolved
  teardown all still outrank them, and `/guard list` shows each record with
  its workspace and active/dormant state (no revocation command; a fresh
  session clears them). Cancellation matches a persistent save (picker esc or
  an empty selection returns to the action menu; editor/preview cancellation
  grants nothing and approves once; abort, staleness, or a vanished workspace
  identity fails closed), the partial-grant re-prompt loop is unchanged, and
  capability-limited hosts are never offered the action.
- **Computed profile switch (2026-11-05).** A host-shell prompt additionally
  offers one `Switch to <rung> (this session only)` action per qualifying
  rung, computed per call from the pure host-shell evaluation (the rungs that
  would allow this exact call, never `yolo` or `unrestricted`). It is a plain
  menu choice, appended last after the save/deny entries, and is neither a
  save nor a cancellation: no rule or root is written and no steering is
  collected. It is applied only after the dialog lease releases (a transition
  inside the lease would cancel its own dialog), through the same profile
  transition as the commands, and the call is re-decided against the
  post-transition policy before it executes (a decision that no longer
  resolves as allow denies). The offer is suppressed whenever
  `profileChangeAllowed` refuses the rung, so a child session with an
  inherited restriction is never offered a rung it cannot hold. Hiding an
  action is not an authorization check: an unoffered label is rejected, never
  treated as authority. Under today's cells only `trusted` can qualify for a
  call that currently prompts: `default` and `allow-edits` share the `prompt`
  host-shell cell and rules are profile-independent, and `auto`'s cell is
  `classify`, which the pure evaluation never resolves (the pinned candidate
  list is an eligibility allow-list, not a promise that every rung appears).
- Explicit ask rules still prohibit allow-saving, but permit supported
  project/user deny saves. Add the deny rule without removing the ask rule;
  existing deny-over-ask precedence applies. Automatic policy denial opens no
  new dialog.

### Compound breakdown and rule suggestions

- Show one prompt containing the original command and each reliably parsed
  step's decision, in the pi-tool-permissions prompt format (header, full
  command, bracketed icon breakdown rows with a » cursor on each prompting
  step, trailing "Why:" line). The breakdown is an explanation, not an
  execution plan: execute the original command unchanged, never the fragments
  separately.
- For an allow save with a reliable breakdown, "Save allow for project" or
  "Save allow for user" first opens a checkbox picker over the breakdown
  steps (the same component the deny save uses) whenever more than one
  prompting step exists. All steps are listed with their action and reason;
  prompting steps (including an unresolved per-step classify cell) are
  selectable and start preselected, so confirming unchanged reproduces the
  old whole-compound bundle; already-allowed steps are unselectable context.
  Escaping the picker or confirming zero selections returns to the action
  menu with nothing granted and nothing executed. A single prompting step
  skips the picker and opens the editor directly.
- Confirming the picker opens the rule editor prefilled with allow rules for
  the selected steps only, anchored to each step's evaluator matching subject.
  Bash subjects carrying `*`, `?`, the expansion marker, or regex-shaped text
  use anchored exact regex prefills. Users may edit them to broaden the rule,
  with a non-blocking advisory. Redirect-requiring prefills contain `>`.
  No redundant rules are generated for already allowed
  steps. No whole-call rule is offered when the breakdown is reliable:
  selecting every prompting step covers everything a whole-command rule
  would authorize, and more, because the step rules also authorize other
  combinations. Explicit ask provenance still prohibits allow-saving
  entirely, so no picker or editor is offered in that case.
- Partial installation is deliberate and supported. This is not a new
  guarantee of crash-safe filesystem writes. The user explicitly accepts
  that the saved rules grant each matching step independently, including
  outside this particular sequence; they are not an exact-sequence-only
  permission.
- After a partial allow save commits (some prompting steps remain
  unselected), guard re-decides the original call with the fresh policy. If
  it still prompts, a fresh approval dialog opens with the breakdown
  recomputed against the saved rules and the full action menu again,
  further saves included. The loop has no iteration cap: every iteration
  requires an explicit commit, and escaping any approval selector denies
  without saving (initial-selector cancellation semantics unchanged). When
  the merged policy already allows the complete call, the save commits and
  the call executes without a further prompt. Owner, epoch, runtime, cwd,
  and config signature staleness checks apply to every iteration unchanged.
- After any rule-save commit, show one info notification naming the scope,
  the destination path, the number of rules saved, and, for a partial allow
  save, how many steps still prompt. This covers the previously silent deny
  saves for symmetry.
- For a compound deny save, first show a multi-select of reliably parsed
  steps and their decisions, with nothing preselected. Require at least one
  selection to continue. Prefill exact deny rules for the selected commands,
  then open the rule editor. Matching a selected step can deny the whole call;
  those rules also deny matching commands outside this sequence.
- If parsing is unreliable, show the original command and mark the breakdown
  unavailable. Retain existing whole-call policy, rather than tightening it
  or presenting guessed fragments as reliable. When the unavailability is
  attributable to a single fragment, the prompt shows that raw fragment on
  an indented "Offending step:" line below the reason (truncated with the
  same 200-character cap); display-only, with no effect on policy or
  suggestions. Generate no guessed allow
  bundle; allow saves keep the existing whole-call suggestion path
  (no picker, no per-step fragments). A deny-save action opens a blank rule
  editor; manually entered rules must be validated against the current whole
  call before saving.

### Editor, validation, and preview

- Every persistent save opens an editor. Shell editors contain one complete
  rule expression per line, initially using allow prefills and anchored exact
  deny suggestions. Every rule must parse and compile and use
  the original shell namespace. Scope, allow/deny slot, and destination are
  controlled by the chosen action, not editable configuration fields.
- Shell rule saves carry a non-blocking advisory for every rule that is not
  the exact rendering of its reference subject: a glob carrying `*` or `?`,
  a bare tool-wide rule, an unparseable line, or a `/regex/` body that
  differs from `^<escapeExactPattern(reference)>$` for every reference. The
  reference is the selected step's matching subject (the redirect-stripped
  `allowSubject` for allow, the normalized `subject` for deny), or the whole
  command on the whole-call path; a rule is compared against any reference,
  so bundle order never changes the verdict. The note is recomputed from the
  current editor text on every render and always appears in the
  confirm/preview step, and it is dropped from the live editor when the row
  budget cannot hold it. Display-only: it never blocks a save, never changes
  validation or persistence, never appears for `webFetchAllow`,
  `readRoots`, or `writeRoots`, and uses neutral wording that never claims
  proven widening.
- Deliberate broadening to the existing glob, regex, or tool-wide grammar is
  permitted with explicit review. A malformed expression, wrong shell, or
  a merge that fails validation is a validation error. Preserve the entered
  text, explain the problem, and return to editing; do not save or execute
  while invalid.
- Allow-save validation is per-step when the breakdown is reliable: with the
  edited rules merged, every selected step must resolve to allow, the
  aggregate decision must not be deny, and no existing ask or deny rule may
  be bypassed. Broadening that also allows unselected steps, or the entire
  call, is accepted. Deny saves, read-root saves, and allow saves on an
  unreliable breakdown keep the whole-call contract: the merge must
  allow/deny the entire current call as intended.
- A persistent read-root editor contains one plain path. The edited root
  must cover the path that caused the request and pass existing root,
  protected-path, and secret restrictions. Unrelated roots are invalid.
  Grants remain read-only, discard worker state when applied, and never
  replay the code that requested access.
- After valid submission, always show a separate preview, including unchanged
  text: final rules/path, destination, and effect on the current call. Make
  the independent grants explicit, and for a partial allow save state that
  the call still prompts for the unselected steps and a fresh approval
  dialog follows the commit. Provide **Confirm**,
  **Edit**, and **Cancel save**. Edit returns to the editor without mutation.

### Cancellation and denial steering

| Ordinary editor/preview cancellation or empty submission | Outcome |
|---|---|
| Allow-save step picker (esc, or confirmed with zero selections) | Return to the action menu; nothing granted or executed |
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
- The computed profile switch is neither a cancellation nor a save: it writes
  no rule, collects no steering, and appears in no row of the table above.

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
children start in the inherited profile. Seven profiles: research / default /
allow-edits / auto / trusted / yolo / unrestricted.

- **ctrl+alt+g** (mnemonic: guard; overridable with `cycleShortcut`) cycles
  research -> default -> allow-edits -> auto -> trusted -> yolo, with no
  confirmation when entering yolo. The design originally named Ctrl+Alt+M, but
  ctrl+alt+m is indistinguishable from alt+enter in legacy terminal encoding
  (unreachable in herdr), and pi-tool-permissions owns ctrl+alt+p while both
  are loaded.
- **unrestricted** is reachable only with `/guard profile unrestricted`,
  never through the cycle, so one keypress cannot drop the deny rules.
- `/guard` opens a picker; `/guard profile <name>` sets a profile directly.

| | research | default | allow-edits | auto | trusted | yolo | unrestricted |
|---|---|---|---|---|---|---|---|
| Sandboxed workspace | throwaway overlay (per call for bash, per worker lifetime for python/node) | bash read-write with protected paths read-only; python/node worker-lifetime overlay | same as default | same as default | same as default | **no sandbox** for bash, python, or node | **no sandbox** |
| host_bash | deny (rules ignored) | prompt unless rule-allowed; also offers the computed profile switch | as default | classifier | allowed | allowed | allowed |
| write/edit | deny | prompt every non-protected write/edit (see below) | allowed in cwd and write roots, prompt outside (the rung's purpose) | roots gate, then classifier (see below) | allowed | allowed | allowed |
| Protected paths | deny | prompt | prompt | prompt | prompt | allowed | allowed |
| Local reads (read/grep/find/ls) | as default | allowed in cwd and read roots, prompt outside | as default | as default | as default | allowed | allowed |
| Secret-mask files via read/grep | deny | deny | deny | deny | deny | allowed | allowed |
| Exfil-capable remote reads (web_fetch outside the allowlist) | prompt | prompt | prompt | classifier | allowed | allowed | allowed |
| Other remote reads (web_search, pup, Jira/Slack reads) | allowed | allowed | allowed | allowed | allowed | allowed | allowed |
| Remote writes (Slack posts, MCP writes, pup writes) | deny | prompt | prompt | classifier | allowed | allowed | allowed |
| HostBash deny/ask rules | ignored (cell is deny) | apply | apply | apply | apply | **apply** | **ignored** |

Write/edit is ENFORCED for non-owned tools (settled 2026-10-16; previously
the observe-only hook computed these decisions without acting on them):

### Write/edit enforcement and the allow-edits rung (settled 2026-10-16)

- **Premise.** pi-tool-permissions is retired (disabled in the user's setup);
  guard is the only permissions extension. Enforcement lands unconditionally:
  no coexistence mode, no flag, no deferral protocol.
- **Where enforcement lives.** The existing `tool_call` hook. On `deny` it
  returns `{ block: true, reason }` (the model sees the refusal); on `prompt`
  it opens the approval dialog inside the hook. The SDK holds the tool call
  while the hook awaits (dispatch is sequential per batch, and a `block`
  short-circuits later extensions' handlers), and the DialogGate serializes
  dialogs across batches.
- **default.** Every non-protected write/edit prompts, in-root and
  out-of-root alike: Allow once / Deny once (explicit denial offers optional
  steering, matching the executor deny flow) and, on in-root prompts, Switch
  to allow-edits, which authorizes the current call and lands the session on
  the rung. Denying or allow-once does not change the mode: the next write
  prompts again.
- **allow-edits** (new rung between default and auto; identical to default in
  every other cell): in-root non-protected write/edit is allowed silently;
  out-of-root still prompts (Allow once / Deny once + steering, no rung
  switch); protected paths still prompt. Clearing = switching back to
  `default` through existing profile machinery. The name follows
  pi-tool-permissions' "allow edits" mode.
- **auto.** Write-root containment gates the classifier: outside cwd and
  `writeRoots`, write/edit always prompts regardless of the classifier
  verdict; inside the roots the classifier rules as today (allow / soft_deny
  -> prompt / hard_deny -> block / no_match or failure -> prompt fail-safe).
  The classifier is never authoritative for an out-of-root write.
- **Every profile.** The workspace lock (step-3 audit findings, cleared by
  `/guard ack`) also blocks write/edit while held. Headless contexts and
  subagent children deny prompts. Dialog cancellation and post-answer
  staleness (epoch, runtime, cwd, config signature, mirroring `authorize`)
  deny without running anything. Protected paths keep their existing cells.
- **Inheritance.** `allow-edits` rides the standard profile inheritance; the
  versioned `PI_GUARD_INHERIT` contract gets a version bump (new valid
  profile value; parent and child ship together, so an old child seeing the
  new value fails closed). The child escape rule is unchanged: a child cannot
  leave its inherited profile except to `research`, so a `default` child
  cannot self-escalate into `allow-edits`; only a parent already on the rung
  passes the capability down. The former plan.ts research hold/restore was
  generic over profiles and covered the new rung unchanged. (Historical;
  superseded by retirement of the manifest-registered plan.ts extension on
  2026-10-26 in favor of the agent-skills plan skill.)
- **Out of scope, recorded.** Write/Edit path-rule grammar and persistent
  saves (TODO follow-up); enforcement for local reads and remote classes;
  session-scoped write grants; a `request_write_access` tool;
  `memory_write`/`scratchpad` (pathless local writes) keep their existing
  cells. Evidence motivating this step (2026-10-16, real session): on the
  `default` profile an `edit` outside cwd and every `writeRoots` silently
  succeeded because only owned executors ever block
  (`guard/index.ts:301-316`); the README table described decisions that were
  computed but never acted on.
- **Host-shell analogue (2026-11-05).** The same shape now exists for
  host-shell prompts: an in-dialog `Switch to <rung> (this session only)`
  choice, applied after the lease and re-decided before execution. It differs
  from the write/edit switch in three ways: the candidate set is computed per
  call from the pure host-shell evaluation rather than a fixed rung; there is
  a mandatory post-transition re-decide, so a rung that no longer resolves to
  allow denies instead of running; and the offer is suppressed by
  `profileChangeAllowed`, so an inherited child is never offered a rung
  outside its restriction. Like the write/edit switch, it requires no owned
  editor/picker stages.

### Rule precedence

| Profile | Host shell (host_bash in every mode, pwsh where enabled; `bash` is sandbox-only) |
|---|---|
| research | Absolute: rules change nothing. host_bash and pwsh deny in full/reduced mode; in degraded mode host_bash runs only commands the read-only tier proves safe, and allow rules do not widen it. (Superseded 2026-10-26: that tier used to run as the degraded sandboxed bash; `bash` is now denied by name there.) |
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
classification: the built-in map is an ordinary frozen
object, so inherited Object.prototype names such as `constructor` or
`__proto__` are NOT built-ins. They are ordinary custom tools and follow the
normal annotation/configuration/fallback rules; no name is reserved or
prohibited.

### Planning eligibility (`/plan` narrowing)

(Historical; superseded by retirement of the manifest-registered plan.ts
  extension on 2026-10-26 in favor of the agent-skills plan skill.)
`isPlanningToolAllowed` and this filter were deleted on 2026-10-28.

When `/plan` held the research profile, the CURRENTLY ACTIVE tool set was
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

## Model-visible guard state (before_agent_start)

The model sees guard's effective mode as one advisory prompt section,
`guard_state`, written by a `before_agent_start` handler in `index.ts` and
rebuilt on every run (pi normalizes fresh prompt options per run, so a
mutation never carries over; a change lands as a patch for that section
alone). It is rendered by the pure `policy/mode-line.ts` from the same
per-profile cells the decision core uses, so the text cannot contradict
enforcement. Nothing in the policy path reads it: the kernel still enforces,
the line only routes.

One line, fixed clause order, semicolon separated:

`guard: profile <name>[ (inherited, cannot be loosened)]; sandbox <mode>; host shell <consequence>; writes <consequence>[; /guard ack clears the lock]`

- `profile` names the ladder value verbatim for every profile, `yolo` and
  `unrestricted` included; only the classifier identity is left out (the
  footer's classifier label exists for the user).
- `sandbox` is `full`, `reduced (workspace overlay degrades to read-only)`,
  `degraded (no sandbox; bash and interpreters unavailable)`, or
  `none (tools run raw)` for an unlocked raw profile, and switches to
  `<mode> (workspace locked: read-only)` under the workspace lock. A locked
  raw profile therefore loses the raw clause, mirroring `bashRunsOnHost`.
- `host shell` and `writes` state the cell-level consequence: `denied`
  (research), `rules, then read-only tier, then prompt` (default,
  allow-edits), `rules, then read-only tier, then classifier` (auto),
  `rules, then read-only tier, then allow` (trusted),
  `deny/ask rules, else allow` (yolo), `allow` (unrestricted),
  `prompted (in-root or not)` (default writes),
  `in-root allowed, out-of-root prompt` (allow-edits),
  `in-root classified, out-of-root prompt` (auto), `allowed`
  (trusted/yolo/unrestricted). Degraded research renders
  `read-only tier only (degraded)`, and the lock rewrites them to
  `denied (workspace locked)` and `writes stopped (workspace locked)` with the
  `/guard ack clears the lock` tail. Per-command rules, session grants, and
  the remote/secret-mask cells are deliberately absent: they are too granular
  for one line or already covered by the tool descriptions and the deny
  reasons the model reads when it hits them.
- Expected text at full sandbox, unlocked, not inherited:
  - research: `guard: profile research; sandbox full; host shell denied; writes denied`
  - default: `guard: profile default; sandbox full; host shell rules, then read-only tier, then prompt; writes prompted (in-root or not)`
  - allow-edits: `guard: profile allow-edits; sandbox full; host shell rules, then read-only tier, then prompt; writes in-root allowed, out-of-root prompt`
  - auto: `guard: profile auto; sandbox full; host shell rules, then read-only tier, then classifier; writes in-root classified, out-of-root prompt`
  - trusted: `guard: profile trusted; sandbox full; host shell rules, then read-only tier, then allow; writes allowed`
  - yolo: `guard: profile yolo; sandbox none (tools run raw); host shell deny/ask rules, else allow; writes allowed`
  - unrestricted: `guard: profile unrestricted; sandbox none (tools run raw); host shell allow; writes allowed`
- Blocked states replace the line: `guard: session blocked (inherited
  contract invalid); tool execution denied` (invalid ambient inheritance
  contract, so no executable runtime exists) and `guard: execution blocked
  (unresolved teardown); tool execution denied`. Before `session_start`
  installs the session state nothing is emitted at all. When a clause cannot
  be resolved the section reads `guard: initialized; effective state
  unavailable` and the user is notified, so presence of the section stays a
  reliable signal that guard is up.
- Freshness is the run boundary: a profile switch (including the computed
  switch accepted inside an approval dialog) or a lock that lands mid-run
  appears on the next user turn. Every lag is informational, because the
  policy still blocks the call.
- Every session gets it, subagent children included: a child renders its
  inherited profile with the `(inherited, cannot be loosened)` suffix, which
  stays visible even after the child itself moves to research.
- Out of scope, recorded: a model-callable status tool, `context_with_system`
  per-LLM-call freshness, changes to existing decision-reason wording, and
  any new enforcement.

Suites: `tests/guard-mode-line.test.mts` (the exact line for every profile,
the sandbox/lock/inherited variants, the blocked and fallback states, and
drift guards against `bashRunsOnHost`, `effectiveWorkspaceMode`, `decide`,
and `decideLocalWrite`) and `tests/guard-harness.test.mts` (the real handler:
no section before initialization, a rebuilt section per run, a profile change
reflected on the next run, and the blocked and locked lines).

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
  `~/.nuget`, `~/.npm`): toolchains are read-only binds, with a write exception
  only where a toolchain demands one. Caches (`~/.cargo/registry`,
  `~/.cargo/git`, `~/.nuget/packages`, `~/.npm`) and the .NET state path
  (`~/.dotnet/corefx`, added for SDK 11 named-mutex files) are a read-only
  lowerdir plus a throwaway overlay per call.
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
  - python/node share today's node limits: RLIMIT_AS 2 GiB, RLIMIT_FSIZE
    16 MiB, RLIMIT_NOFILE 128, no core dumps. The 2 GiB address space is the
    minimum verified for Go subprocesses (gh dies with "failed to reserve
    page summary memory" below ~2 GiB) and covers V8's large reservations.
  - bash: no core dumps only. RLIMIT_AS breaks .NET, V8, and Go startup (they
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

(Historical; superseded by retirement of the manifest-registered plan.ts
  extension on 2026-10-26 in favor of the agent-skills plan skill.) Nothing in
  the registered extension set emits `guard:research-request` any more; the
  request/ack/release machinery and its tests were deleted on 2026-10-28.

- Entering `/plan` switched the profile to research, held by plan.
- While plan held research, profile changes (cycle or command) were
  **blocked** with a notice; `/plan cancel` was the way out.
- Every exit path restored the profile that was active before `/plan`:
  - `restoreTools`
  - the clear-context branch (`plan.ts:299`, which skipped
    `restoreTools`)
  - the cancelled new-session branch
  - recovery in `session_start` and `session_tree`
- plan kept `narrowTools()` (hid write/edit) and also hid
  `host_bash`.
- Research is also reachable directly through the cycle.

## Subagents (step 5)

Each dispatched child runs with an immutable inherited profile for its
process lifetime. It can only keep that profile or switch to research; there
is no ordinal ceiling, because the ladder is not a permission ordering
(`default` can allow what `auto` denies through classification, so an `auto`
child must not be able to move to `default`). Ordinary sessions without
inheritance keep their existing behavior.

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
  workspace locks, scratch, and workers are never
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
guard is uninitialized, transitioning, workspace-locked, blocked by
unresolved teardown, has invalid inheritance, or answers for a mismatched
cwd. A refusal is final: no defaulting to `default`. Only a snapshot that
produced no correlated acknowledgment at all reaches the guard-absent test
described next, which decides between refusing and dispatching ungated. The
handshake requires exactly one correlated synchronous
acknowledgment: every additional matching acknowledgment, including an
identical duplicate, refuses the dispatch, because multiple responses
indicate an ambiguous or duplicated responder configuration. Responses with
unrelated correlation identifiers are ignored and do not count as
duplicates. Already-running children keep their launch snapshot; entering
research does not retroactively tighten existing children, and there is no
live policy propagation.

### Guard-absent dispatch

A session with no guard extension loaded behaves like the stock subagent
extension, while a loaded guard that cannot answer still refuses. The querier
separates those cases with two further signals, both consulted only when the
snapshot produced no correlated acknowledgment:

- **Presence ping** (`guard:extension-present-request`/`ack`; all channel
  names and payload types live in `guard/policy/handshake.ts`, shared by both
  extensions). Guard's factory registers the responder at extension load,
  before and independently of session state, so it answers even when the
  session is blocked by invalid inheritance or a workspace lock. It carries
  no profile and never authorizes a guarded dispatch; its only job is to turn
  silence into "loaded but unresponsive". The same correlation discipline
  applies: exactly one matching synchronous acknowledgment, duplicates and
  unsupported versions count as present, unrelated acknowledgments are
  ignored, and a request without a correlatable id gets no answer at all.
- **Command provenance**: any registered extension command whose directory is
  an `extensions/guard` directory proves a loaded guard. This covers a guard
  too old to have the presence responder and a handler that yields before
  acknowledging. It is matched by layout rather than exact path, so a
  working-tree install next to an installed package still matches. Both
  `baseDir` and the directory of `path` are checked, because pi reports the
  package base for a package extension (sometimes the package root, not the
  directory holding the entry) and no `baseDir` at all for an extension added
  with `--extension`; either candidate matching is enough. Tool provenance is
  deliberately not used: `--tools`, `--exclude-tools`, and `defaultTools`
  filter custom tools out of the registry, which would make a loaded guard
  look absent.

A presence answer, a duplicate or unreadable presence acknowledgment, a
presence-query emission failure, or a guard-layout command all resolve to
"loaded but unresponsive" and refuse with a diagnostic that names the
snapshot handshake. Only double silence dispatches ungated: no
`PI_GUARD_INHERIT` override and no `--extension` startup gate, with the
ambient environment passed through untouched, so a child whose own cwd
configuration loads guard still applies any inherited restriction rather
than losing it. The verdict is recomputed at every spawn and never cached;
there is no configuration knob, no opt-out, and no user-visible notice. The
snapshot failure shape carries the branch (`kind`: `absent`, `refused`,
`malformed`, `duplicate`), and only `absent` may reach this test.

A set `PI_GUARD_INHERIT` is deliberately not treated as evidence that guard
should be present. The child startup gate makes that combination unreachable
in a real session: a dispatched child that carries the contract without a
guard extension exits nonzero before its first agent run, and a child that
carries it with guard present is talking to a live guard anyway. Reading the
variable would therefore add a branch that no real session can produce while
reintroducing an authorization decision on inherited environment state.

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
- Guard-absent dispatch is a liveness distinction, not an authorization one: a
  guard that fails during load before registering anything reads as absent, so
  the dispatch proceeds ungated. Its enforcement never came up in that process
  either, so this is a silent downgrade of intent rather than an escalation,
  and it is not detected.
- The guard-layout command match assumes guard stays at `extensions/guard`;
  relocating it requires updating that match.
- A child dispatched ungated sees no guard either, so its own dispatches
  resolve the same way. A task cwd whose own configuration loads guard yields
  an ordinary guarded child at `default`, which is stricter than the parent
  and is accepted rather than detected.
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
| Plan vs cycle | Profile changes blocked while plan holds research. (Historical; superseded by retirement of the manifest-registered plan.ts extension on 2026-10-26 in favor of the agent-skills plan skill.) |
| After /plan | Restore pre-plan profile. (Historical; superseded by retirement of the manifest-registered plan.ts extension on 2026-10-26 in favor of the agent-skills plan skill.) |
| yolo entry | No confirmation |
| Start profile | default, always |
| python/node research overlay (step 0) | One throwaway overlay per worker lifetime |
| python/node in yolo (step 0) | Fully raw: worker kept; no bwrap, seccomp, rlimits; full env and filesystem |
| pwsh on Windows (step 0) | Host tier like host_bash, own `Pwsh(...)` rules |
| Auto classifier scope (step 0) | host_bash, pwsh, write/edit, exfil-capable remote reads, remote writes; sandboxed calls skip it |
| Degraded tools (step 0) | Both names registered, identical host executors, footer warning. (Superseded 2026-10-26: `bash` is now denied by name in degraded mode and `host_bash` is the only host shell.) |
| NuGet audit (step 0) | `NuGetAudit=false` in sandboxes, documented |
| Read-only tier on host_bash (step 0) | Applies, tightened: no env/printenv, `$` expansion (quote-correct scanner), active-construct screen (2026-10-21: substitution, backgrounding, grouping, heredocs, unhandled separators, unterminated quotes; `command` removed from the safe list), and secret-mask file args veto |
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
| Mask discovery (step 1) | Every launch, one scan for masks and nested protected entries: fd with a find fallback, pruned build dirs and .git contents, 5 s timeout and a 500-match cap that fail the launch; cap, timeout and prune basenames became tunable 2026-10-23 (see the discovery-knobs row) |
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
| Research rules (step 2) | Absolute: HostBash rules change nothing; host shells deny; degraded sandboxed bash read-only tier only. (Superseded 2026-10-26: `bash` is sandbox-only, so that degraded tier now runs as `host_bash`.) |
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
| Step-3 dialogs (2026-10-06) | Allow once / allow and save the suggested rule / deny; no mid-dialog profile switching (superseded 2026-11-05 for host-shell prompts: the computed profile switch; write/edit keeps its own switch); local-read grants keep session/project/user/deny; headless prompts deny |
| Step-3 mask filter (2026-10-06) | tool_result filter on grep/ffgrep: drop matches from masked paths, append a summary line, replace structuredContent too; every profile except yolo/unrestricted |
| Step-3 audit response (2026-10-06) | Escaped protected-path writes are quarantined and notified; the tool result is not failed (defense-in-depth telemetry, not a denial path) |
| Step-3 review: isolation | Worker-lifetime overlays in every sandboxed profile; shared real-path scratch persists across remounts; reduced workers read-only |
| Step-3 review: lifecycle | Serialized execution; tightening preempts and awaits teardown; failed teardown blocks; research boundaries reset; scans before worker execute |
| Step-3 review: audits | All sandboxed tools and teardown boundaries; union of pre/post paths; any violation or incomplete containment locks and denies host/raw even in unrestricted |
| Step-3 review: dialogs | Explicit asks once/deny; fallback exact rules, project/user choice, save only effective patches; stale approvals cancel; grants never replay |
| Step-3 review: ownership | Fixed executor identities; guard-owned roots only; raw bash honors HostBash rules (superseded 2026-10-26: raw bash no longer exists, host_bash carries the rules); failed sandbox launches never fall back |
| Step-3 review: filtering | Context, structured data and metadata redacted; unsupported or failed parsing suppresses the entire result |
| Step-3 review: residual risks | Idle background reads may precede mount refresh; raw descendants may escape tracking |
| Step-3 implementation (2026-10-07) | Shipped: four tools registered ahead of python/node (authoritative, dormant old extensions), one execution queue with pre-spawn revalidation and fail-closed transitions, worker-lifetime overlays plus shared real-path scratch, audits around all sandboxed execution with union pre/post comparison and violation/scan/quarantine locking, exact/effective rule saving with stale-approval cancellation, no grant replay, fixed executor identities, raw bash under HostBash rules (superseded 2026-10-26: bash is sandbox-only and host_bash carries the rules), and the fail-closed grep/ffgrep mask filter; suites guard-{sandbox,policy,classes,migrate,filter,workers,runtime,harness} |
| Step-4 implementation (2026-10-07) | Shipped: /plan requests the research hold before narrowing and refuses without an ack (timeout covers guard-absent); narrowTools hides host_bash; every exit path releases (awaited release-ack, background release on recovery/clear-context, warning on failed release); menu only on completed agent_before_settle (Batch B). (Historical; superseded by retirement of the manifest-registered plan.ts extension on 2026-10-26 in favor of the agent-skills plan skill.) |
| Step-5 restriction shape (2026-10-07) | Allow-list (inherited profile + research), not an ordinal ceiling: the ladder is not a permission ordering, so an auto child must not reach default; refusals explain instead of clamping |
| pwsh extension removed (2026-10-07) | `extensions/pwsh.ts` deleted and unregistered: pi's built-in `powershell` tool (opt-in via `defaultTools`) replaces it. Guard classifies the built-in name as a host shell on the pwsh tier (`shell: "pwsh"`, `Pwsh(...)` rules, pwsh cells, no read-only tier); `Pwsh(...)` rules in guard.json keep applying. pi-tool-permissions pwsh handling left untouched until switchover; user settings untouched |
| Step-5 snapshot (2026-10-07) | Fresh synchronous snapshot query per actual spawn (single, each parallel task, each chain step, nested); no cached profile events; no retroactive tightening of running children |
| Step-5 child config (2026-10-07) | Profile only: the child loads its own config for its cwd; locks are never transmitted (locked parents refuse dispatch) |
| Step-5 gate (2026-10-07) | Dedicated bootstrap extension passed with --extension; synchronous contract ack proves version/nonce/profile/restriction/runtime; child-only fatal path (stderr + exit 1) because pi catches handler errors and print mode has no shutdown handler |
| Step-5 scope (2026-10-07) | Profile inheritance and startup validation only: write/edit/local reads/remote tools stay observe-only; parent prompt forwarding and broader process supervision deferred |
| Step-5 single responder (2026-10-07) | Require exactly one correlated synchronous acknowledgment per handshake query; every additional matching acknowledgment, including an identical duplicate, fails closed regardless of order, validity, version, or payload |
| Bash ask read-root escalation (2026-10-07) | Deliberate omission: bash/host_bash ask dialogs offer no inline read-root grant (pi-tool-permissions did, `extensions/pi-tool-permissions/index.ts:999-1129`). Read roots are granted only via the python/node permission_needed path, where kernel-enforced read-only mounts make the grant meaningful |
| Annotation fallback (2026-10-07) | A destructive hint wins over a contradictory read-only hint: conflicting self-declared claims classify as remote-write; the rest of the precedence order is unchanged |
| Built-in lookup hardening (2026-10-07) | Built-in recognition uses explicit own map entries only (`Object.hasOwn`) in `classifyToolCall` (and formerly `isPlanningToolAllowed`): inherited Object.prototype names (`constructor`, `__proto__`) are ordinary custom tools, so they follow the normal annotation/configuration/fallback rules (unannotated or conflicting-hint instances were removed during planning and classify remote-write; adequately read-only annotated instances stayed and classify remote-read); no name is reserved or prohibited |
| Dialog mutex (2026-10-08) | One guard-owned FIFO `DialogGate` per factory (not per dialog kind, runtime, or session) serializes approvals, read grants, the profile picker, and migrate confirmation. A plain promise-chain mutex was rejected as the mechanism: it cannot remove aborted queued requests promptly or cancel open selectors. Cancellation combines the caller's signal with a private per-request signal passed to the SDK selector's `{ signal }` option; policy and lifecycle boundaries invalidate synchronously; the lease spans pre-display validation, the selector, and post-answer validation only. See the Ask dialogs section for the full contract. |
| Spinner hiding (2026-10-08) | All four admitted TUI selectors hide the working spinner before opening and restore it on every settle path through one TUI-only selector wrapper (`gatedSelect` in `guard/index.ts`); restoration always passes `true` because the UI API has no visibility getter, matching the legacy extension. Visibility failures are caught as presentation-only: they never change authorization, replace a selector result or error, or block gate cleanup. Queued, stale-before-display, headless, and dry requests never toggle visibility, and queued cancellation cannot restore the spinner underneath another open selector. RPC is untouched: its setter is a no-op, so non-TUI modes skip the toggling entirely (since 2026-10-09 the restore call itself is guarded to TUI mode for the same reason) |
| Command cancellation through final commit (2026-10-08) | The profile picker and migrate confirmation capture the initiating command operation's `ctx.signal` once (a live SDK getter; rereading after the dialog would return `undefined` or another operation's signal) and pass it to the shared gate, closing the gap where the two command dialogs ran with empty gate options. The captured signal is rechecked through a command-only final commit guard inside the runtime's existing `beforeCommit` hook with the captured expected epoch: after asynchronous teardown, before policy assignment/publication (picker) and before privileged configuration writes (migration), so cancellation during pending teardown prevents the requested change. Classification is by per-operation Error identity only; genuine teardown, storage, audit, and source-validation failures keep their diagnostics. Direct `/guard profile <name>`, profile cycling, reload, ack, approvals, and read grants are unchanged; no rollback of completed commits or started teardown; expected cancellation is a warning notice and a normal return. Suites: `tests/guard-dialogs.test.mts` (registration-level, both commands), `tests/guard-runtime.test.mts` (teardown ordering). |
| Hideable overlay delivery (2026-10-09) | The four TUI dialogs render through a guard-owned overlay adapter (`guard/ask-overlay.ts`) instead of `ctx.ui.custom`: the SDK's custom-overlay completion callback pops the LAST overlay, and a controlled probe proved that cancelling a hidden guard overlay under a foreign overlay removes the foreign overlay while its promise stays pending and leaves the cancelled overlay mounted (host 1.1.0 has the same implementation; do not patch or upgrade the SDK for this). The adapter borrows the renderer through a uniquely keyed zero-height `ui.setWidget` bridge removed immediately (the host's removal path is verified with a canary removal before borrowing, which filters hosts that refuse every deletion; the bridge key stays inside the owned-resource cleanup boundary so a post-canary deletion failure is retried best-effort there, and an entry can only remain if both deletion attempts fail), mounts through public `TUI.showOverlay`, and owns the returned handle: `setHidden` for the ctrl+] toggle (raw `ui.onTerminalInput`, press-only, focused-or-hidden only, consumes the key) and `handle.hide()` for removal, which preserves a foreign overlay's focus. Every setup failure (bridge removal, acquisition, selector construction, mounting) runs one owned-resource cleanup and propagates the genuine error; failed or cancelled displays are never retried. The details body is bounded by MEASURED chrome (a one-line-title twin selector verifies the recomposition of the selector's public render output at the current width, so wrapped option labels and key hints are budgeted exactly; the adapter never touches SDK-private fields), with PgUp/PgDn access to overflow at any title budget including a one-line window; approval eligibility is recomputed from the live terminal dimensions on every input (fail closed before the first paint), and a terminal whose controls alone cannot fit disables approval with a wrapped warning while keeping Esc. Capability gaps fall back to the signal-aware native selector before mounting. Ownership is guard-local: no global overlay coordinator, and foreign extensions using the unsafe `ui.custom` completion path remain exposed. Suites: `tests/guard-ask-overlay.test.mts` (adapter + real pi-tui boundary), `tests/guard-dialogs.test.mts` (wiring through the registered handlers); offline PTY smoke with a real pi subprocess verified open/hide/show/apply; the user completed the visual checklist and reported "done, looks good" on 2026-10-09 (user-confirmed, not assistant-observed). Review follow-up (2026-10-09): the five findings from the post-commit review are fixed; the review probe asserting visible choices and the hide hint in an 8-column terminal is unsatisfiable (the compositor truncates overlay lines to the resolved width, and the measured chrome alone is 27 rows), so the fail-closed blocked state is the implemented behavior there. NOTE (2026-10-20): pi 1.3.0 fixed the pop-last completion bug (#10648/#10999), so the owned-overlay path is no longer load-bearing against the SDK; it remains the stacking fallback (see the inline delivery row below) |
| Inline editor-slot delivery (2026-10-20) | All guard prompt stages (selector, rule editor, checkbox picker) mount INLINE in Pi's editor slot by default via `ui.custom(factory, { overlay: false })` (`guard/ask-overlay.ts` `runDialogStage`/`runInlineStage`), so the transcript stays visible while a prompt is open (the user's original complaint: the overlay covered the last messages and forced ctrl+] to read them). Stage components are shared by both presentations; the layout row count comes from the stage context's `rowsFor()`: the full terminal for overlays, `max(12, floor(rows * 0.7))` capped at the terminal (the same budget idiom rpiv-ask-user-question uses, since the host clips the editor slot from the bottom) for inline. ctrl+] collapses an inline prompt to a one-line hint inside the component (which keeps focus, so the same key re-expands and Esc still cancels); the owned overlay keeps the raw-listener hide/show. When an overlay is already on screen at mount, the inline factory yields and the stage remounts through the owned overlay path (stacking); a host with `ui.custom` but no setWidget/onTerminalInput still mounts inline and only fails closed if it also has an overlay open. Abort semantics are presentation-identical: the host mount settles first (the editor is restored, the component disposed), then the stage rejects with the same cancellation error the overlay path uses. Editor/picker stage availability (`ownedStagesFor`) relaxed from the setWidget/onTerminalInput probe to TUI + `ui.custom`. Known limitation, shared with rpiv: pi has one editor slot and no public API to detect a foreign inline occupant, so a native selector opened mid-prompt (e.g. /model) displaces an inline prompt without settling it; the FIFO gate still serializes guard's own dialogs. Suite: `tests/guard-ask-inline.test.mts` |
| Herdr blocked signaling (2026-10-09) | Every guard dialog reports pane status to herdr: `gatedSelect` in `guard/index.ts` emits `herdr:blocked { active: true, label: "guard: awaiting user input" }` before the mode check and `{ active: false }` in its `finally`, so all four dialogs (approvals, read grants, profile picker, migrate confirmation) are covered by one choke point on every settle path (answer, abort, cancellation, expiry, error). Deliberate deviations from the legacy port, settled with the user: uniform label instead of per-tool labels, coverage of the two command dialogs (legacy only covered approval and read-root prompts), unconditional emission with no `HERDR_ENV` check (gating stays herdr's consumer-side responsibility, matching `pi-tool-permissions` and `herdr-ask-user-bridge.ts`), and per-dialog release with no gate-level latching, so back-to-back queued approvals may briefly flash "working" between dialogs (user-accepted). Emission covers RPC as well as TUI. Companion cleanup: the `finally` guards `setWorkingVisible(true)` to TUI mode, since the non-TUI path returns before hiding the spinner and the RPC setter is a no-op. Cosmetic only: the gate, enforcement, and overlay are untouched. Documented in `guard/README.md` (Events) |
| Save/deny/compound prompt design (2026-10-09) | User-confirmed design only, not implemented: flat actions, persistent rule/root editors, validated preview, independent allow-rule bundles for needed steps, multi-select deny suggestions, manual deny entry on unreliable parsing, and optional steering collected before commit. No session deny or deny-and-stop; all TUI stages retain owned hide/show and the existing gate/commit barriers. See Save, deny, and compound prompts. Implementation and step 6 remain unauthorized. |
| Offending-fragment line (2026-10-22) | Unavailable breakdowns that are attributable to a single fragment carry it in an additive optional `offending` field on `BreakdownReliability` (the now-retired shell-splitter module: populated at the length-mismatch, per-step structural mismatch, and unreliable-construct returns; left unset for Pwsh, empty-step, and early-return profiles), and `executionPromptTitle` (`prompt-flow.ts`) renders it as an indented "Offending step:" line directly below the "Breakdown unavailable:" reason, truncated with the same 200-character cap as the full command. Presentation-only: policy routing, decisions, and suggestions are unchanged. Suites: `tests/guard-explain.test.mts`, `tests/guard-prompt-flow.test.mts` |
| Save/deny/compound prompt implementation (2026-10-13) | The confirmed contract is implemented across `policy/decision.ts` (`explainHostShellCommand`: the per-step projection of exactly the aggregate evaluation, never re-decided fragments), the now-retired shell-splitter module (`assessBreakdownReliability`: conservative presentation-only reliability; Pwsh, ambiguous splits, structural constructs, substitutions, background execution, grouping, and inline comments are unavailable), `policy/save.ts` (pure parsing/validation: existing-grammar rule lines with namespace rejection, complete-call hypothetical merges via `decide(originalCall)`, whole-call vs per-step allow plans, selected-occurrence deny plans, one-plain-path root parsing), `ask-overlay.ts` (`runOwnedStage`: the extracted canary/bridge/toggle/cleanup lifecycle shared by every stage), `ask-components.ts` (public Editor and SelectList checkbox picker), `prompt-flow.ts` (authority-free stage orchestration with typed outcomes; no persistence, steering delivery, or transitions), and `index.ts` wiring (final-commit revalidation of the ACTUAL reviewed patch/root against re-read config plus session roots inside `beforeCommit` with no await before the additive one-scope write; owning-commit epoch recorded synchronously for the steering ownership check). Settled implementation decisions: RPC persistent saves are DEFERRED (once actions, session read grants, and signal-aware native steering input remain; no native `ui.editor` call is ever made); the steering handoff uses the existing `pi.sendUserMessage(..., { deliverAs: "steer" })` semantics the user explicitly accepted (guard checks captured owner/runtime/cwd/epoch synchronously immediately before dispatch and suppresses on invalidity, but claims no post-dispatch cancellation or SDK-bound ownership); capability-limited TUI hosts detect missing capabilities BEFORE the dialog and keep once/session-grant actions with native `ui.input({ signal })` steering, never falling back to authority from a failed stage; the spinner and `herdr:blocked` now span the entire admitted interaction (one interval per dialog body, not per selector); and the deny picker opens for any reliable breakdown (single-step included) with nothing preselected. Remaining limits: breakdown reliability gates presentation/suggestions only (policy routing unchanged); ordinary cancellation effects are exactly the documented once/deny/no-grant fallbacks while abort/staleness/setup failures never grant authority; bundles grant each matching step independently outside the sequence. Quoted punctuation inside strings (e.g. commit messages) does not make the breakdown unavailable (since 2026-10-15): the inert-construct checks (process substitution, heredoc, background execution, subshell or brace grouping, inline comments) run on text with quoted segments blanked, mirroring the splitter's quote semantics, while command and parameter substitution still flag on the raw text because double-quoted forms remain active in bash. Suites: `tests/guard-explain.test.mts`, `tests/guard-save.test.mts`, `tests/guard-ask-components.test.mts`, `tests/guard-prompt-flow.test.mts`, plus updated `guard-dialogs`/`guard-harness` wiring coverage; all wired into `test:guard` |
| Planning eligibility (2026-10-07) | `/plan` filters the ACTIVE set through `isPlanningToolAllowed`: built-in host-shell/local-write removed regardless of hints; built-in read/sandboxed/meta classes stay; everything else needs `readOnlyHint === true && destructiveHint !== true` from a fresh getAllTools lookup; toolClasses overrides create no planning exceptions; input-dependent wrappers qualify only via explicit annotations. (Historical; superseded by retirement of the manifest-registered plan.ts extension on 2026-10-26 in favor of the agent-skills plan skill.) |
| Worker capability metadata (2026-10-07) | Conservative static annotations on this repo's tools: web/web_search/Slack reads read-only open-world, session_search read-only closed-domain, guard python/node write-capable open-world (raw profiles expose the host); read-only hints describe intended operations, not the absence of internal caches or index files |
| Plan narrowing limits (2026-10-07) | Entry-time declaration filtering only, not execution containment: codemode/deferred tools can remain callable, tool_search or another extension can change activation afterwards, nested non-owned calls stay observe-only until step 6, trusted extensions have host privileges, annotations are unverified author hints. (Historical; superseded by retirement of the manifest-registered plan.ts extension on 2026-10-26 in favor of the agent-skills plan skill.) |
| Unmounted-path failure hints (2026-10-16) | Sandboxed bash failures get a path hint that states the invisibility, directs the action (host_bash or the read tool, "do not retry with bash"), and still hedges causation ("Other causes are possible"): `mountTable` parses the final bwrap argv into visible locations (bind/tmpfs/symlink/special), `EffectiveLaunch.mountedPaths` carries it to `executeShell`, and `unmountedPathCandidates` flags absolute/~ path tokens invisible lexically or by host realpath. Settled constraints: detection is advisory only (echo/printf/grep may mention paths without touching them), it never blocks execution, opens a dialog, or claims the path caused the failure; no pre-flight fail-fast and no classifier reclassification; the bash hint no longer offers a read grant because only the python/node workers can trigger that dialog (`permission_needed`), pointing at host_bash and the user-managed readRoots configuration instead; an explicit model-callable read-access request (reusing the read-grant flow, never replaying commands) is deferred to a separate step and requires verifying that `handleReadGrant`'s transition is reusable by a fifth owned executor. Suites: `tests/guard-shell-hints.test.mts` |
| request_read_access tool (2026-10-16) | Implemented (PR 2). Helper extraction: `handleReadGrant` is replaced by `requestReadGrant(rt, requesterName, requestPath, ctx, signal, caller)` returning a typed `GrantOutcome` (`granted` with committed root, scope, and `savedTo` destination for persistent saves; `denied` (explicit denial: the helper delivers steering itself and the outcome carries no payload); `refused` with a diagnostic); success is never inferred from absent diagnostics or message text, and both the worker path and the tool MUST go through the helper (dual adoption is mandatory, no drift). The worker call site projects the outcome into the existing response fields (diagnostic/stateLost/stateLostReason) byte-identically; an empty refusal diagnostic is the worker's silent no-UI passthrough, while the tool gets an actionable no-UI diagnostic. The `beforeCommit` order is preserved exactly: assertCallActive -> config-signature race check against the POST-DIALOG diskConfig snapshot -> root revalidation -> sessionReadRoots/addToConfigScope -> loadConfig; the outer try/catch maps epoch/config-race/teardown failures to `refused`. Capability-limited UI (no owned editor stages, computed once BEFORE the dialog) degrades to session grant + deny; a non-grant outcome under it carries the "only a session grant was offerable" note (appended to every refused diagnostic in the helper, including catch-path refusals, and to the denied tool text in execute, since the denied outcome has no diagnostic field). REVISED decision contract (supersedes the groundwork row's "non-allow = refusal"): deny refuses with the cause-specific reason and no dialog; prompt with no UI refuses with an actionable diagnostic (in practice `resolveDecision` collapses non-interactive prompts to deny first, so the branch is defensive); prompt with UI and allow BOTH open the read-grant dialog, which is the consent surface (an allow decision never grants automatically); classifier failures and indeterminate verdicts (`no_match`: "classifier call failed" / "classifier had no verdict" reason markers, matched in execute because `resolveDecision` maps them to prompt) fail closed. The execute flow is ordered: runtime check -> pre-aborted signal -> isAbsolute entry check (no dialog, no decisionFor) -> ONE `decisionFor` self-check -> post-await recheck before any UI (owning signal, `rt !== runtime` plus an epoch recheck against the epoch captured BEFORE the `decisionFor` self-check, mirroring `authorize`'s post-await epoch recheck and `assertDialogCurrent`, plus `rt.assertAvailable()` so a stale captured runtime is rejected, and cwd) -> `requestReadGrant(..., "tool")` -> typed result mapping (success text names root, scope, destination for saves, and the worker-disposal consequence "running interpreter workers were stopped; their state was discarded; previously run code was not replayed"). The tool is NOT in OWNED_EXECUTORS, never routed via `rt.run`/the execution queue, and has no renderCall; it is classified `remote-write` (annotations: readOnlyHint false, destructiveHint false, idempotentHint false, openWorldHint true). Exactly one policy evaluation per call at the execute level; the observe-only `tool_call` hook's own evaluation is deduped by the classifier cache. Hint rewiring: `SHELL_SANDBOX_FAILURE_HINT` and `SANDBOX_FAILURE_HINT` name `request_read_access` instead of the manual readRoots-editing/read-grant sentences (no-fallback tails kept), the bash description gains an append-only tool clause (render-call-pinned phrases untouched; superseded 2026-10-26, when the bash and host_bash descriptions were rewritten around the sandbox-only rule), and the shell-hints suite asserts the tool name. Tests: `tests/guard-request-access.test.mts` (harness-level, real closure, bwrap-independent) covers registration shape, non-ownership, relative-path refusal, the decision table through the registered hook + execute, real classifier plumbing (tool name + `{ path }` in the prompt; classifierEnvironment/classifierAllow do not bypass or block; one completion per call via the cache), session/project/user grants with destination and no-replay wording, deny steering via `deliverSteering`/`pi.sendUserMessage({ deliverAs: "steer" })`, cancellation, no-UI, capability-limited UI, mid-dialog abort, concurrency (one gate serializes; the loser sees invalidation), post-decisionFor staleness, and the config-race/epoch scenarios. Two documented test-level divergences from the task spec, verified against the design: (1) an out-of-band write to guard.local.json DURING the open dialog is absorbed by the post-dialog snapshot and the confirmed grant commits (union merge preserves the racer); guard's own writers cannot mutate config mid-dialog because config writes need transitions that invalidate the gate first, so the only mid-dialog writers are out-of-band and the "no commit" expectation for that interval is unimplementable without breaking worker byte-identity; a mid-dialog writer that also advances the epoch (e.g. /guard reload) is caught by the dialog-gate invalidation, and the literal "Read grant expired; nothing saved or replayed" epoch message is defense-in-depth unreachable through wrapper transitions because they invalidate the gate first. (2) a write strictly AFTER the post-dialog snapshot is caught deterministically by the config-signature check by holding the grant transaction behind the teardown of a preempted host bash whose setsid'd grandchild keeps the stdio pipe open for a fixed interval, then writing once inside that window; the assertion is the "config changed while waiting; nothing saved or replayed" refusal with no committed root | 
| request_read_access groundwork (2026-10-16) | Verification + spec only, no production code. Evidence: `handleReadGrant` (index.ts:502) is a factory closure whose body is worker-independent except for labels and the trigger payload; it chains epoch capture, `validateReadGrant(readGrantSuggestion(path, cwd), cwd)` (runtime.ts:365, suggest.ts:27), the DialogGate (`dialogs.ts`), `runReadGrantPrompt` (prompt-flow.ts, session grant / project+user root saves / deny with steering), the extension-local `transition` wrapper (index.ts:219: synchronous dialog invalidation, then `rt.transition` with `preempt`, `invalidateWorkers`, `expectedEpoch`, and a `beforeCommit` that rechecks the config signature against a post-dialog snapshot before any write, then `addToConfigScope` or sessionRoots), and `deliverSteering` on explicit denial; it runs after `rt.run` returns, so the dialog never holds the execution queue. Verdict: reusable after extracting the shared read-grant body into a helper; PR 2 MUST route both the worker path and the new tool through that helper (no optional adoption). Tool spec: name `request_read_access`, parameters `{ path: string }` (the entry must enforce `path.isAbsolute` itself; `readGrantSuggestion` resolves rather than rejects relative input, and `validateReadGrant` judges only the resolved location); NOT in OWNED_EXECUTORS and not routed through `rt.run`/the execution queue; `readOnlyHint: false` (it mutates authorization state and persistent saves write guard.json) hence planning-ineligible and default-classified `remote-write` (fail closed, `classifyToolCall` unknown-name fallback) unless toolClasses pins otherwise; guard is observe-only for non-executor tools in step 3, so the tool's execute performs one guard-internal `decisionFor` self-check (not a duplicate of any interception); no-UI and capability-limited-UI (no editor: session grant + deny only) return distinct actionable diagnostics; denial delivers steering; cancellation grants nothing; stale epoch and config race fail closed before any write; nothing is ever replayed. Spike: `tests/guard-request-access-spike.test.mts` reproduces the interaction test-locally with an injected full-mode detection and a fake worker (bwrap-independent): 14 tests covering session grant, project save, unrelated-root editor rejection, denial steering, selector cancellation, no-UI, capability-limited UI, mid-dialog abort, stale-epoch commit, config race, worker disposal + active preemption + queued invalidation, gate serialization, and the path contracts. Boundary: this proves the primitives compose without a worker; it does not test the production closure or a registered tool. PR 2 items: the helper extraction with both callers, tool registration + description wording (then update the PR 1 bash hint to point at the tool), the decisionFor self-check wiring, and the entry-side isAbsolute check |
| Non-owned write/edit enforcement + allow-edits rung (2026-10-16) | Settled by interview after a real-session finding: on `default`, an `edit` outside cwd and every `writeRoots` silently succeeded because the `tool_call` hook is enforce-only for owned executors (`bash`, `host_bash`, `python`, `node`) and observe-only for everything else, so computed `prompt`/`deny` decisions never acted. Premise: pi-tool-permissions is retired (disabled in the user's settings), so no coexistence mode: enforcement lands unconditionally, no flag. Scope: write/edit only (path-carrying local writes); local reads, remote classes, and pathless local writes (`memory_write`/`scratchpad`) stay observe-only. SDK facts pinned first (scout): `emitToolCall` awaits handlers sequentially in registration order and short-circuits on the first `block: true` (runner.js:956-971), a handler may await a dialog and the agent loop holds the call (`agent-loop.js:493-495`), and per-batch preparation is sequential, so dialogs serialize naturally plus the DialogGate across batches. Structure: a SEVENTH profile rung `allow-edits` between `default` and `auto` in the ladder and ctrl+alt+g cycle (supersedes the interviewed "session flag on default" intermediate; the rung makes the state visible and clearable through existing profile machinery and mirrors pi-tool-permissions' "allow edits" mode). default: every non-protected write/edit prompts (in-root and out), Allow once / Deny once (+ steering on explicit denial) and Switch to allow-edits on in-root prompts (authorizes the current call and lands the rung); allow-once/deny never changes the mode. allow-edits: in-root non-protected write/edit allowed silently, out-of-root prompts, protected paths prompt, every other cell identical to default. auto: roots gate BEFORE classify, out-of-root always prompts regardless of verdict, in-root classifier mapping unchanged (allow / soft_deny -> prompt / hard_deny -> block / no_match or failure -> prompt). Every profile: workspace lock also blocks write/edit; headless and subagent-child prompts deny; dialog cancellation and post-answer staleness (epoch, runtime, cwd, config signature, mirroring `authorize`) deny. Inheritance: `allow-edits` rides the standard versioned `PI_GUARD_INHERIT` contract with a version bump (parent and child ship together; old child + new value fails closed); child escape rule unchanged (only `research`), so a `default` child cannot self-escalate into the rung; plan.ts hold/restore was generic (that extension was retired 2026-10-26, so this clause is historical). Out of scope, recorded: Write/Edit path-rule grammar and persistent saves (TODO follow-up), reads/remote enforcement, session write grants, a `request_write_access` tool. TODO updated: the non-owned item carries the settled design plus an implementation sub-item, and a save-parity TODO was added |
| Per-step allow saves (2026-10-19) | User-confirmed design only, NOT implemented: revises the 2026-10-13 allow-save contract (motivated by comparing against pi-tool-permissions' per-subcommand save loop). Scope: per-step allow saves, per-step validation, the post-commit re-prompt loop, and save notifications. Explicitly out of scope, settled during the interview: an "allow remaining steps once" action (redundant, Allow once already approves every prompting step exactly once in guard's single-gate model), glob-variant editor prefill (exact rules only), session-scoped step allows, /guard rules management, and deny-picker changes. Reliable breakdown: "Save allow for project/user" opens the checkbox picker (the deny picker component) over all breakdown steps whenever more than one prompting step exists; prompting and unresolved-classify steps are selectable and start PRESELECTED (deselect to narrow; confirming unchanged reproduces the old bundle); allowed steps are unselectable context; esc or confirming zero selections returns to the action menu with nothing granted or executed; a single prompting step skips the picker. Confirming prefills the editor with anchored exact rules for the selected steps only (each step's evaluator matching subject; a redirect-requiring step's prefill is its verbatim subject, whose pattern necessarily contains ">"), and the whole-call exact rule is no longer offered when the breakdown is reliable (full selection strictly covers it); unreliable breakdowns keep the existing whole-call path with no picker. Per-step validation contract (replaces whole-call validateShellSave at all three index.ts checkpoints): after the hypothetical merge, every selected step must resolve allow, the aggregate must not be deny, and no existing ask/deny rule is bypassed; deliberate broadening that allows unselected steps or the entire call is accepted, and when the merge allows the complete call the save commits and the call executes without a further prompt. Explicit-ask provenance still prohibits allow-saving entirely. Commit machinery unchanged (staleness barrier, one-scope additive write, epoch checks). After a partial save commits, guard re-decides the original call: still prompting opens a fresh approval dialog with the breakdown recomputed against the saved rules and the full action menu again, saves included; the loop has no cap (each iteration requires an explicit commit; escaping any approval selector denies without saving; initial-selector cancellation unchanged). The cancellation table gains the picker row; editor/preview cancellation keeps its documented allow-once fallback. After any rule-save commit (allow and the previously silent deny saves), one info notification: scope, destination path, rule count, and for partial saves the number of steps still prompting. The 2026-10-13 whole-call/bundle contract remains the implemented behavior until this lands. SUPERSEDED: implemented 2026-10-20 (commit `bd7acbf`); the 2026-10-13 whole-call exact suggestion survives only for unreliable breakdowns. REVERSED IN PART (2026-10-26): the "glob-variant editor prefill (exact rules only)" exclusion is reversed; allow prefills are glob-form and the not-exact advisory is shown (see the "Glob-form allow prefills and the not-exact advisory (2026-10-26)" row). SUPERSEDED IN PART (2026-10-26): the "session-scoped step allows" exclusion is reversed; session-scoped host-shell grants are implemented (see the "Session-scoped host-shell grants (2026-10-26)" row) while the remaining exclusions stand |
| Standalone python/node retirement (2026-10-21, user-authorized) | `./extensions/python` and `./extensions/node` were dropped from `pi.extensions` (commit `1c298b4`); guard's ported copies (`guard/tools/python`, `guard/tools/node`) are the only registered python/node tools. Supersedes the step-3 coexistence contract's first-extension-wins dormancy mechanism above: the old extensions no longer load at all, and the writable-mount hole they carried is closed by absence rather than by registration order. The standalone directories and their unit/integration suites were deleted on 2026-10-28 after porting frame-protocol coverage to `tests/guard-worker-protocol.test.mts` against guard's live modules; `test:python`/`test:node` were removed. Remaining at switchover: guard on by default and pi-tool-permissions off |
| Host-tier active-construct screen (2026-10-21) | Surgical fail-closed fix (dependency-free; the shell-ast parser adapter remains a later item) closing five verified false allows on the tightened host tier: `` echo `touch probe` ``, `echo <(touch probe)`, `printf x & touch probe`, `command touch probe`, and `for x in $(touch probe); do echo ok; done` all returned allow, "read-only host command (tightened tier)". Causes: `READONLY_BASH_SAFE_ALWAYS` trusted `command`/`echo`/`printf` regardless of arguments; the tokenizer ignores operators so a backgrounded second command vanished; process substitution and backticks were never screened (the `$` veto has quote-semantics bugs: a single quote inside double quotes toggled the wrong state, so `echo "'$HOME'"` slipped through); structural stripping discarded loop heads whose word lists execute (`for x in $(touch probe); do done` ran the substitution under "no commands after structural stripping"). Fix: `activeConstructReason` in `policy/decision.ts` screens for substitution (quote-correct), process substitution, background execution, grouping, heredocs/here-strings, unhandled separators, and unterminated quotes, and gates `hostTierAllowReason` (which also covers the degraded research tier); a discarded structural head marks the whole projection unfaithful so no step derives allow authorization (tier, plain allow rules, redirect-aware allow rules all skipped; deny/ask rules still apply) and a purely structural command prompts instead of allowing. `command` removed from `READONLY_BASH_SAFE_ALWAYS` (`command -v git` prompts too; conservative, no flag parsing). Accepted compatibility changes (all fail-safe, prompt-not-deny): compound commands with a discarded structural head prompt; `echo {a,b}` braces, `cat <<EOF` heredocs, and `[[ a && b ]]` conditionals prompt; in degraded research a compound like `ls -la && pwd` is denied instead of tier-allowed (the old pass came from `&&` being containment-checked as a literal path token). Trusted simple commands keep their behavior (`echo hello`, `printf x`, `ls 2>&1`, `timeout 120 ls`, `which`/`type`, quoted punctuation, escaped separators). Suites: `tests/guard-{policy,explain,save,prompt-flow}.test.mts` via `npm run test:guard` |
| shell-ast re-spike (2026-11-06) | Measurement only, no production change: a committed the now-retired measurement harness (its own `package.json`, exact pin `@questi0nm4rk/shell-ast@0.8.0`, never registered in `pi.extensions`, never loaded by pi) re-measured the candidate parser over the corpus of every `bash`/`host_bash` command in the local session transcripts (36,201 calls -> 34,969 unique from 1,388 files). Warm (3 warmup + 30 timed iterations per command, all tiers, same corpus on every arm): shell-ast `parse` 0.2956 ms median of per-command medians vs 0.4994 ms for today's end-to-end `explainHostShellCommand` path (0.59x) and 0.0022 ms for `splitTopLevelShell` alone (136x); the ratio against today's path is p50 0.52, p95 6.18, max 92.5, so the average favours shell-ast while a minority of long commands cost far more. Cold (10 boots per arm, fresh headless `pi -p` probe extension, offsets from each process's own time origin so pi's startup cancels): module import 1.37 ms, wasm compile + first parse 34.91 ms, headline 36.28 ms on the first guarded command, steady RSS +17.91 MiB at that first parse (peak RSS delta is noise; the middle arm proves the wasm compiles at first parse, not at import). Coverage: 11/34,969 commands raise `ParseSyntaxError` and `bash -n` also rejects 9 of those, so only 2 are pure parser gaps; 274/34,969 invoke a wrapper the package does NOT unwrap (`command` 191, `xargs` 83) because the wrapper registry is unreachable through the package's `exports` map (only `.` and `./semantic` are importable), so the adapter must walk those itself while `findAll(ast, "CallExpr")` covers the other four recorded false-allow constructions directly. Battery rebuilt from the 2026-10-20 claims, which were never written down: typed-node matrix 13/13 against the real type names (`IfClause`/`WhileClause`/`ForClause`/`CaseClause`), 6/6 malformed inputs raise `ParseSyntaxError`, an over-cap input raises `ParseSizeError` (four `kind`s total), and all five host-tier false-allow constructions are surfaced by the AST while guard already prompts on all five today, confirming the 2026-10-21 screen closed them. Package facts re-verified: `dependencies: {}`, tarball unpacked 4,389,634 B with a 4,228,590 B wasm, `engines: node>=18`, `parse()` genuinely async, and the license question is a version split rather than a conflict: `0.8.0` (published 2026-06-09) is MIT in registry metadata, the tarball `package.json`, and an MIT `LICENSE` file the tarball ships, while the repo was relicensed to MPL-2.0 on 2026-10-12 (commit `f46a0044`) and `0.8.1-beta.0` (2026-10-14) is MPL-2.0 in those same three places, so pinning `0.8.0` keeps MIT terms and any bump moves to file-level copyleft. Boundary: no guard source, root manifest, lockfile, or `test:ci` change, and the committed artifacts are text-free (command hashes plus shape counts only, the corpus itself gitignored and regenerated locally). VERDICT (2026-11-06): ADOPT `@questi0nm4rk/shell-ast@0.8.0`, decided by the reviewer from the reviewed re-spike results preserved in this document with no pre-committed thresholds, accepting the numbers above; the scope is the pinned version only, and the adapter (TODO adoption steps 3-7) plus any bump past `0.8.0` (which moves to MPL-2.0) stay downstream and are not authorized by the decision. |
| Shell-ast adapter, Stages 1-2 (2026-11-06) | Historical intermediate state, superseded by the corrections and final retirement record below. Working-tree implementation of TODO adoption steps 3-4: `policy/shellast.ts` (new) is the only parser boundary. Lazy single-flight load with a pinned SHA-256 integrity check (`SHELL_AST_WASM_SHA256`), every `ShellAstError` kind mapped to the existing fail-closed prompt path, and `analyzeHostCommand` projecting a `ShellCommandAnalysis` (ordered `ShellExecCall`s with a raw-source-slice `subject`, unwrapped `argv`, assignments, `hasParameterExpansion`, per-call `complete`/`cause`, plus a whole-command `complete`). Node positions are UTF-8 BYTE offsets, so subjects and assignments are sliced from a `Buffer` of the parsed string, never `src.slice`; a leading BOM is stripped before parsing so offsets stay aligned. `policy/shell-text.ts` (new) holds the moved text helpers (`stripTrailingHarmlessRedirects`, `stripTimeoutPrefix`), re-exported by the legacy splitter at this stage until that splitter was retired later. Wired through `policy/decision.ts` (`evaluateHostShell(Sub)`, with `decide`/`resolveDecision`/`explainHostShellCommand`/`qualifyingSwitchRungs` taking the analysis as a REQUIRED `ShellCommandAnalysis | null`), `policy/save.ts`, `policy/suggest.ts`, and `index.ts` (parse once at the `tool_call` boundary and thread it; `executeShell` analyses the command itself for the sandbox failure hint, because `analysisFor` is null for a sandboxed call). Historical subject contract (superseded by "Canonical Bash rule subjects" below): a subject is the RAW SOURCE SLICE of the call's whole chain, not a canonical argv rendering, so `VAR=`-prefixed and redirect-aware rule text keeps matching; `argv` is the separate unwrapped-executing-vector field. Two fail-closed guards are re-wired rather than dropped: `evaluateHostShellSub`'s `tierEligible` parameter still gates the tier and every allow rule on an unfaithful projection. Bash always passes true because `analysis.complete` is the fail-closed gate checked by the caller (any flagged construct makes the whole analysis incomplete before per-step evaluation), while pwsh computes it from `stripStructuralKeywords` on each split part, so a discarded structural head still blocks allow rules; that branch is reachable and covered by tests. Only the genuinely unreachable `evaluations.length === 0` branch (a complete analysis always has at least one call) was DELETED, with pwsh's empty-part case handled in `evaluatePwshCommand`. Consequence the Stage-5-7 decision-diff fixture must enumerate: an incomplete command is never checked against allow rules, so a previously-matching explicit allow rule (e.g. `HostBash(echo $(compute))`) no longer authorizes it (allow -> prompt). That tightening is intended (an unfaithful projection must not auto-allow) but is broader than "commands the parser cannot parse" and is currently pinned only by the incomplete-analysis tests, not by a per-change fixture. Per-call completeness now also marks a call whose own subtree contains a flagged construct and populates the prompt's `offending` step. Pwsh at this stage was unchanged: no AST, no bash tier; `evaluatePwshCommand` kept the pre-adapter `splitTopLevelShell` split so per-step `Pwsh(...)` deny/ask rules still matched a compound and an ambiguous split still prompted (whole-command matching would have let a previously denied compound fall through to the allow cell). Later reverted to whole-command evaluation; see the corrections row below. Stage 5-7 deletions/fixtures are DEFERRED, not silently skipped: at this stage the legacy splitter still exported `splitTopLevelShell` and `stripStructuralKeywords` (then used by pwsh) plus the dead `assessBreakdownReliability`; the `bashtier.ts` tokenizer paths are untouched; and no decision-diff corpus/fixture file exists. Remaining steps: move the per-command read-only judgment onto AST argv, retire the legacy splitter and the `bashtier.ts` tokenizer paths, and port the spike battery plus a fixture file enumerating each decision change with action + cause. Suites: new `tests/guard-shellast.test.mts` (load/integrity, every cause, wrapper walk, byte-offset subjects, per-call completeness, redirect param expansion) and `tests/shellast-sync{,-worker}.mts` (synchronous test façade); adapted `tests/guard-{policy,classes,explain,save,prompt-flow,shell-hints,mode-line}.test.mts`; `tests/guard-harness.test.mts` drives the real `executeShell` sandbox-hint wiring; `tests/guard-shellast.test.mts` is registered in both `test:ci` and `test:guard`. |
| Shell-ast adapter corrections: per-call completeness and whole-command pwsh (2026-11-06) | Historical intermediate state; the final retirement record below supersedes its deferred-measurement and kept-splitter notes. Follow-up to "Shell-ast adapter, Stages 1-2" that corrects three working-tree semantics. (1) Per-call completeness: `policy/shellast.ts` separates the analysis-level cause from per-call causes. The analysis-level `cause`/`complete` is set ONLY when no reliable call list exists: `parser-unavailable`, `parse-error`, `size-cap`, `no-command`, `function-definition`, `state-change`, the whole-command constructs that wrap or sit between calls (`background`, `grouped`, `subshell`, `heredoc`; new `WHOLE_COMMAND_CAUSES`), and any flagged construct that falls outside every call's span. A construct inside one call's own span (`command-substitution`, `process-substitution`, an unrecognized wrapper node, a redirect expansion) sets only `ShellExecCall.complete = false` with its own `cause` and leaves `analysis.complete = true`. `policy/decision.ts` `evaluateHostShell` takes the whole-command branch only when `analysis == null || analysis.cause !== null`; otherwise it evaluates every call, passing that call's completeness (its cause rendered by the new `shellAnalysisCauseReason`) into `evaluateHostShellSub`. The step order is deny rule > ask rule > yolo allow > incomplete prompt > read-only tier > redirect-aware allow rule > plain allow rule > profile cell, so an incomplete call prompts without reaching the tier or any allow rule while its complete siblings keep exactly today's decision; aggregation is unchanged (deny > prompt > classify > allow), so a deny rule matched on an incomplete call still DENIES. `analysis.calls.find((c) => !c.complete)?.subject` still names the offending step for the prompt and breakdown. (2) Rules never authorize incompleteness, at either level: this is the intent of (1), not a separate code path, and it must NOT be "fixed" by matching rules earlier. An explicit `HostBash(echo *)` allow rule (or a whole-command-shaped allow rule) does not authorize `echo $(date)`, which prompts; pinned in `tests/guard-policy.test.mts`. This is an accepted tightening over the pre-adapter splitter; its exact size is DEFERRED to the stage-4 corpus/decision-diff, which must enumerate every allow -> prompt it introduces. (3) Pwsh reverts to the settled whole-command design: `evaluatePwshCommand` no longer calls `splitTopLevelShell`/`stripStructuralKeywords`. Pwsh is ONE step, so whole-command-text `Pwsh(...)` deny/ask/allow rules match the whole text, yolo allows, and the pwsh profile cell governs an unruled command (default/allow-edits/auto prompt, trusted allows); the one fail-closed exception is a malformed command (an unterminated quote), which prompts instead of reaching an allow cell. The per-step split, the ambiguity branch, the per-step `tierEligible` gate, and the bash read-only tier are gone; the `evaluateHostShellSub` `tierEligible` parameter is removed entirely (the incomplete prompt replaces it). The pwsh breakdown reason is now "PowerShell commands are evaluated as one whole command (no per-step breakdown)". Retired as dead: `assessBreakdownReliability`, `unreliableConstructReason`, `stripQuotedSegments`, and `stripStructuralKeywords`. `splitTopLevelShell` is KEPT because the now-retired parser-only benchmark still imports it as the parser-only baseline (the module header now marks it legacy); `consumeHeredoc` stays with it. Suites: `tests/guard-shellast.test.mts` (per-call causes split from analysis causes; a complete sibling stays decidable), and `tests/guard-{policy,explain,save}.test.mts` updated for the pwsh and per-call changes. |
| Shell-ast adapter, Stage 3: the read-only tier judges argv (2026-11-06) | TODO adoption step 5. `policy/decision.ts`'s `hostTierAllowReason` no longer tokenizes the subject text: it takes an argv-based input (`argv`, `redirects`, `hasParameterExpansion`, `pureAssignment`, `requiresRedirectAwareAllow`) and the `isReadOnlyBashSubcommand` / `validatorApprovedBashReason` / `isPureVariableAssignment` string path is retired. `policy/bashtier.ts` gains `isReadOnlyBashArgv` (the same name sets judged on argv) and `validatorApprovedBashArgv` (the four validators fed argv), and the retired `isReadOnlyBashSubcommand`/`validatorApprovedBashReason`/`isPureVariableAssignment`/`ASSIGN_PREFIX_BUILTINS`/`hasUnquotedSeparator` plus `tokenizeSimple` are deleted (the read-only name sets are KEPT: the new function reads them). `requiresRedirectAwareAllow` is now derived from the analysis's structured redirects (`ShellExecCall.redirects`, op + resolved target) through the new `hasWritableRedirect`, with unchanged writeRoots/readRoots semantics (a `/dev/null` target, an allowed-root target, and a descriptor dup/close stay exempt; a dynamic target is never exempt); the text scanner remains only for pwsh. The semantic layer stays and is also fed argv: the env/printenv command-word veto on `argv[0]`, the secret-mask veto on `argv`, and the `$` veto on the analysis's `hasParameterExpansion` (the fresh text scan is no longer on the path); the duckdb/mlr/find/awk validators take argv directly (no redirect tokens leak into their argument checks). Adapter fixes required by the move: `manualWrapWalk` no longer unwraps `command -v X`/`command -V X` (plain queries, not wrappers; they prompt), while `command ls`/`xargs cat` keep unwrapping; and the package's `walk` treats `ArithmExp` and `BraceExp` as leaves, so `detectConstructs` recurses into `$((...))`/`{a,$(cmd)}` and `hasParameterExpansion` reports arithmetic and brace-nested expansions (closing substitutions the old `activeConstructReason` text screen caught). Subject/rule matching is unchanged (the raw-source-slice `subject` still matches deny/ask/allow rules; only the tier's inputs moved). The degraded-research whole-command tier is now the same argv judgment over a complete, single-call analysis (a compound is not collapsible into one whole-command check, so it still denies, preserving the 2026-10-21 behavior). Widenings introduced by the argv move (ACCEPTED as reviewed recoveries on 2026-11-06; the run-2 decision diff measures 132 changed cells over 43 commands, `prompt -> allow` 88 plus `classify -> allow` 44, with no allow -> deny and no deny -> allow): wrapper chains (`command ls`, `command cat <inside>`, `xargs cat`), registry-unwrapped wrappers (`nice ls`, `env ls`, `env FOO=1 ls`) where the env veto no longer sees the whole command, `[[ a && b ]]`, and `echo {a,b}` are now tier-ALLOWs where the pre-adapter tier prompted; `env`/`printenv` with no inner command still veto, and `command touch probe`, `command cat .env`, `command cat /etc/passwd` still prompt. No allow -> deny or deny -> allow is introduced. `activeConstructReason` and `hasDollarExpansionOutsideSingleQuotes` are DELETED (they had no production callers) together with their standalone tests in `tests/guard-policy.test.mts`; see the "pwsh redirect scanner and traversal-coverage guarantee" row below for the replacement. Suites: `tests/guard-{policy,shellast,explain,save,prompt-flow}.test.mts` via `npm run test:guard`, with new tier tests (wrapper-chain widenings, the argv-fed vetoes, the arithmetic/brace traversal fixes, and the redirect gate). |
| pwsh redirect scanner and traversal-coverage guarantee (2026-11-06) | Two follow-ups to Stage 3. (1) The pwsh text redirect scanner `stripExemptRedirects`/`hasTopLevelFileRedirect` in `policy/bashtier.ts` had an enter/exit asymmetry: the double-quote branch tested `!inSingle && !inDouble`, so a closing `"` could never reset `inDouble` and every later `>` was invisible. Bash moved to structured redirects in Stage 3, but pwsh still uses this text path, so `echo "p" > /home/z` was authorized by a permissive pwsh cell (trusted) instead of requiring a redirect-aware allow rule. Fixed by testing each toggle against the OTHER states only (single/double/backtick all toggle both ways; a backslash escape still works inside double quotes and outside, never inside single quotes). This is pwsh-only (pwsh is not in the decision-diff corpus) and cannot appear in the host-bash decision diff; regression tests at the scanner level plus a pwsh decision test pin it. The other scanner in the same file, `stripLineContinuations` (the single-quote handling at `policy/bashtier.ts:58`), is symmetric (`if (ch === "'") inSingle = !inSingle` is unconditional, so it always exits); it is context-blind rather than asymmetric (it does not track double quotes, so a `'` inside a double-quoted word wrongly toggles `inSingle`), a pre-existing correctness nit with no authorization effect, left unchanged. (2) The 2026-10-21 `activeConstructReason` text screen is replaced by a traversal-coverage guarantee in `policy/shellast.ts`: `NODE_DISPOSITIONS: Record<ShellNode["type"], NodeDisposition>` classifies every node type the package can emit as `descend`, `leaf` (semantics represented elsewhere, e.g. `ParamExp` -> `hasParameterExpansion`), or `cause`; `buildConstructVisitor` derives the construct walk from that table, and a `Proxy` raises `unrecognized-node` for any node type absent from the table instead of letting the package walk silently treat it as a leaf. The package's walk treats `ArithmExp`/`BraceExp` as leaves, so those two carry `manualRecurse` and a construct nested in `$((...))`/`{a,$(cmd)}` stays flagged; `ParamExp` and `CStyleLoop` are the other walker leaves and are classified `leaf` (the `$` veto / their enclosing `ForClause` cause cover them). `tests/guard-shellast.test.mts` resolves the declared `ShellNode` union from the shipped `types.d.ts` at runtime, fails if the disposition table or the per-type case table misses a type, and induces one command per type (`Comment` and `TestDecl` are marked not-inducible with the reason: the walk never visits a `Comment`, and the 0.8.0 parser rejects Bats `@test` syntax). The five 2026-10-21 false-allow constructions stay pinned as prompting by the AST tests. No bash decision changes: the dead functions had no callers, the visitor refactor is behavior-identical, and the Proxy path needs a node type the parser cannot emit. |
| Discovery knobs (2026-10-23) | The workspace-discovery scan is tunable per config while the fail-closed defaults and prune semantics are unchanged. Prune matching stays basename-based at any depth for files and directories, a matching directory subtree is never descended, and the workspace root is now exempt: `findScanArgs` adds `! -path <glob-escaped workspace>` (fd already exempts the search root; verified empirically). `SCAN_MATCH_CAP_DEFAULT` (500) and `SCAN_TIMEOUT_MS_DEFAULT` (5000) move to `sandbox/spec.ts`, and three optional config keys are added: `discoveryPruneNames` (extras unioned with the built-ins, deduped, built-in duplicates dropped, sorted so reordering or duplication cannot change `launchPolicyKey`), `discoveryMatchCap` (1..200000), and `discoveryTimeoutMs` ms (1..600000); the two scalars fall back project-valid, then user-valid, then the default. `scan.ts` unions the built-ins itself (extras only in `ScanOptions.pruneNames`), and the cap and timeout diagnostics name the effective value and the config key. Weakening values fire one notice per session (reset on `session_start`) and stay inspectable through an added `/guard list` line (cap, timeout, effective pruned basenames, collision warnings). Pruned entries remain mounted: pruning is discovery-only, so a secret under a pruned basename is not masked. A `$HOME` session uses a project-scope `~/.pi/guard.local.json`, read only when the cwd is `$HOME`, to add the large generated trees. Suites: `tests/guard-{sandbox-unit,policy,harness,runtime,classes,migrate,sandbox-integration}.test.mts` |
| Launch mask and scanner-kind fixes (2026-10-23) | Two verified pre-existing defects are fixed. (1) `tools/shell.ts` and the worker controller passed the config mask extras as `LaunchSpec.maskPatterns`, and `spawnSandboxed` forwarded them as the complete `scanWorkspace` pattern set, so the default empty extras list replaced `DEFAULT_MASK_PATTERNS` and left secrets unmasked on launch paths (audits merged the defaults); `spawnSandboxed` now unions the built-ins with the extras, and `LaunchSpec.maskPatterns`/`maskExceptions` are documented as extras. (2) When fd was absent, `detect.ts` returned `fdPath: "/usr/bin/find"` with `scanner: "find"`, but `run.ts` and `runtime.auditOptions` passed only `fdPath`, and `scan.ts` inferred the kind from `fdPath`, so the fallback ran find with fd argv; both call sites now thread `detection.scanner`. Regression tests: `tests/guard-sandbox-integration.test.mts` (an empty extras list still masks; the find-fallback detection scans and masks through the real launch path). |
| Glob-form allow prefills and the not-exact advisory (2026-10-26) | Implemented. Allow prefills switch from the anchored-regex form `HostBash(/^<escaped>$/)` to glob form `HostBash(<subject>)` / `Pwsh(<subject>)`, at BOTH allow sites: `globAllowRule` (renamed from `exactAllowRule`) in `policy/save.ts` used by `planAllowSave`, and the host-shell branch of `suggestRule` in `policy/suggest.ts` used by `effectiveAllowSuggestion` for unreliable breakdowns. Deny prefills stay anchored exact (`exactDenyRule` unchanged), so allow and deny are deliberately asymmetric. No migration and no config toggle: existing `/^...$/` rules remain valid and equivalent, and a metacharacter-free glob compiles to the same anchored, case-insensitive match. Broadening is accepted and documented: `compilePattern` cannot express a literal `*` or `?` and turns a `" *"` pair into optional space, and a subject whose text both starts and ends with `/` is compiled as an UNANCHORED regex (`/tmp/` becomes `/tmp/i`, matching `cd /tmp/` and `rm -rf /var/tmp`); validation still accepts those rules because they match the original subject, while an uncompilable body like `/(/` is rejected on the save path (`parseShellRuleLine` reports the parse error and re-prompts). Non-blocking advisory: `notExactShellRules(text, references)` in `policy/save.ts` is a pure, total, display-only predicate (never called by a validator, plan builder, or commit path) returning rule lines that are not the exact rendering of any reference; `notExactNoteFor` in `prompt-flow.ts` turns the count into neutral singular/plural wording (never asserting proven widening). References are the selected steps' `allowSubject` (allow) or `subject` (deny), or the whole command on the whole-call and manual-deny paths. The note is threaded to the editor as an optional fourth `PromptFlowIO.editor` parameter (`noteFor`) rendered by `ask-components.ts` as dim rows between the editor text and the hint; it is recomputed from `editor.getText()` on every render, dropped when the row budget cannot hold it, and deliberately excluded from BOTH fit checks so it can never disable submission (the stage degrades by dropping the note, never by blocking). It also always appears as a line in the confirm/preview text, so capability-limited hosts that lack the owned editor stage still see it, and it never appears for `webFetchAllow`, `readRoots`, or `writeRoots` saves. Suites: `tests/guard-save.test.mts` (glob builder, `notExactShellRules` silent/flagged/order-independence, the `/tmp/` broadening, the redirect allow-subject versus deny-subject distinction, a broadened glob still validating), `tests/guard-classes.test.mts` (whole-call host-shell suggestions in both namespaces, anchoring), `tests/guard-prompt-flow.test.mts` (Pwsh whole-call prefill, advisory in editor and preview, preview reflects the final edited rules, deny prefill silence versus a hand-edited broad deny, read-root editors receive no note), `tests/guard-ask-components.test.mts` (the live advisory appears and clears; a tight row budget drops it without blocking submission), `tests/guard-ask-inline.test.mts` (the advisory never breaks the inline row budget), plus updated `guard-harness`/`guard-dialogs` saved-rule expectations; all wired into `test:guard` |

| Session-scoped host-shell grants (2026-10-26) | User-confirmed and implemented. Adds **Allow for this session** to eligible host-shell approval prompts, superseding the "session-scoped step allows" exclusion in the 2026-10-19 row (that exclusion listed it as out of scope; the later glob-prefill revision is unchanged). Scope: host shells only (`HostBash`/`Pwsh` rule shapes); no session deny store, no session roots beyond the existing read grants, no enforcement change for python/node or sandboxed bash, and no reopening of the raw/degraded-bash denial. Flow: `prompt-flow.ts` gains a `session-allow` outcome and a `sessionAllowSupported`/`sessionScopeLabel` eligibility pair; the session action renders immediately after `Allow once` and reuses the SAME picker/prefill/parse/validate/not-exact-advisory/preview implementation as a persistent allow save (one `target` label drives every stage; the session path differs only in the destination, the lifetime/scope lines, and "grant" instead of "save" in the panel, editor, picker, and cancellation wording), so a forged or scripted "Allow for this session" answer on a host that did not offer it throws rather than approving. The session preview states the memory-only destination, the lifetime, and the workspace scope instead of a config path, and the preview never claims an exact-match-only permission. The allow picker wording was corrected for BOTH paths in the same change: it now says the selected steps get glob allow rules instead of "exact" rules, matching the glob-form prefills. Store: `session-shell-rules.ts` (`SessionShellRuleStore`) holds immutable, deduplicated `{ scope, rules }` records in a factory-local variable; `resolveWorkspaceScope` canonicalizes the granting workspace (null, hence ineligible, when the directory does not resolve) and `scopeContains` requires lexical containment AND physical realpath containment of the current workspace, so symlink escapes in either direction and unresolvable identities fail closed, comparisons inherit the platform's `path.relative` case semantics (a differently cased spelling of the same directory is rejected on case-sensitive platforms; fail closed), and dormant records stay recorded for later reactivation. A second grant for the same physical directory extends the existing record (accumulating every workspace spelling and canonical root, displaying the newest spelling) instead of replacing it, and `list()` hands out copies so a caller cannot mutate a stored record. Effective policy: one `overlaySessionPolicy(cfg, cwd)` helper now applies the session read roots AND the applicable session allow rules, and is used by `effectiveConfig`, `policyWithSessionOverlays` (fresh-disk validation), and both `transition` policy constructions, so no construction path can drop a grant; `config`, `configSignature`, patches, and `addToConfigScope` remain disk-only, and a later persistent save writes only its reviewed rules. Commit: `authorize` re-resolves the workspace, revalidates the ACTUAL reviewed rules at the same three checkpoints as a save against fresh disk policy plus currently applicable grants, and requires the captured workspace to still resolve to the same canonical identity at answer time and inside the barrier, so validation and installation can never describe different directories. The candidate policy does include already-installed session rules, and the reviewed rules may not lean on them: the plan and picker only select steps the plan-time policy still prompts for, that same snapshot validated the editor submission in-dialog, and the store is add-only within a session, so the commit candidate is a monotone superset of the validated one; a concurrent grant re-enters through the latest/fresh revalidation and a racing transition is rejected by the expected-epoch barrier. The record is installed inside `beforeCommit` after the config-signature race check with the owning epoch recorded synchronously, so the post-commit policy already carries the new rules; the original call is re-decided, a partial grant re-prompts, and abort/staleness/teardown failures never execute or fall back to allow-once. Lifecycle: `startSession` resets the store only on a fresh session; `session_tree` (including a cwd change), `/guard reload`, classification-config reloads, profile changes and lock transitions all preserve it; the subagent snapshot ack still carries `version`/`id`/`ok`/`profile` only. Inspection: `/guard list` labels the two sources separately instead of relying on adjacency: `persistent host-shell rules: <n> deny, <n> ask, <n> allow` (computed from the disk config, so it stays the persistent count) followed by `session host-shell grants (this session only, never written to config): <records with workspace and active/dormant state>` and, when any record applies here, `session rules in force here: <rules>`; a revocation command is deliberately absent. Suites: `tests/guard-session-shell-rules.test.mts` (scope resolution, containment, symlink containment, alias accumulation for one physical directory, dedupe, immutable listing copies, dormant reactivation, reset), `tests/guard-prompt-flow.test.mts` (menu placement and eligibility, shared flow, preview disclosures, cancellation, forged answer), `tests/guard-harness.test.mts` (grant and silent re-run, disk isolation, lifetime across tree/reload/profile and a fresh session, sibling-workspace dormancy and reactivation, no leak into a later persistent save, unresolved-workspace ineligibility, commit-time workspace-vanish failure, partial-grant re-prompt completion, partial-grant abort, child payload shape), `tests/guard-dialogs.test.mts` (explicit ask offers neither allow saves nor a session grant; updated menu indices), and `tests/guard-subagent.test.mts` (the serialized contract names no rules); all wired into `test:ci` and `test:guard` |
| Sandbox-only bash and explicit host boundary (2026-10-26) | Settled by interview after a real-session misrouting: a model asked to read `/tmp/handoff-*.md` used sandboxed `bash`, hit the empty private tmpfs, and only then switched tools, because `bash` meant two different things (ephemeral sandbox normally, host shell in yolo/unrestricted and degraded mode), the description never named `/tmp` or the scratch path, and the tool snippet was identical to `host_bash`'s. Chosen: make `bash` mean one thing. `policy/decision.ts` exports `bashRunsOnHost(policy)` (`sandboxMode === "degraded" || (!workspaceLocked && (yolo || unrestricted))`), used by BOTH the decision layer and `executeShell`'s host route so they cannot drift; `decide()`'s sandboxed-exec branch denies a bash call there with `bash is sandbox-only; in <profile> it would run on the host: use host_bash (same permissions here) instead` (degraded: `bash is sandbox-only and this host has no sandbox (degraded mode): use host_bash instead`), so a deny reason is the nudge because it reaches the model as the block reason. `decideDegradedSandboxedExec` is deleted and its research tier moves verbatim into the shared host-shell evaluator (`evaluateHostShell`, so `explainHostShellCommand` and `decideHostShellCommand` cannot disagree): research + degraded + `host-bash` takes the whole-command read-only tier (`degradedResearchTierReason`, rules ignored, allow rules never widen it, no fabricated per-step approvals, unavailable breakdown naming the whole-command check); full/reduced research and pwsh stay absolute deny; the workspace lock still outranks everything, so a locked raw profile keeps read-only sandboxed bash. Prompt text: all boundary prose lives in `tools/shell.ts` (`SandboxPaths`, `sandboxBoundaryText`, `bashToolDescription`, `hostBashToolDescription`, `workerToolDescription`, `SANDBOX_TOOL_ROUTING`, `BASH_SANDBOX_NOTE`, `TRUNCATED_OUTPUT_NOTE`, `READ_GRANT_NOTE`, `SANDBOX_TOOL_GUIDELINES`, distinct `BASH_PROMPT_SNIPPET`/`HOST_BASH_PROMPT_SNIPPET`); one `prepareLoadout` hook is attached to all four executors and re-runs per request, substituting the live `runtime.policy.cwd` and `runtime.scratchDir` (static usable fallback at registration), while granted read roots stay a category and are never enumerated so a grant cannot churn the request payload; the descriptions state the private sandbox `/tmp` (host `/tmp` absent), the host temp file a truncated result points at, `read`/`host_bash` as the host-file routes, and the degraded/research exception. Hints: the unmounted-path hint becomes action-directive but keeps the causation hedge (`...are not visible in this sandbox: X. If the command needs them, use host_bash (or the read tool to read them); do not retry with bash. Other causes are possible.`), `SHELL_SANDBOX_FAILURE_HINT` names the private tmpfs, and `SANDBOX_FAILURE_HINT` is unchanged. python/node keep raw execution in yolo/unrestricted by design. Naming the ungated `read` tool as the host-file reader is deliberate and its host-path gating is deferred (TODO.md). The guard-side plan.ts orphans (`isPlanningToolAllowed`, the research-hold request path) were subsequently deleted on 2026-10-28; gating the `read` tool for host paths remains a separate TODO item. Suites: `tests/guard-{policy,explain,shell-hints,render-call,harness,dialogs,subagent}.test.mts` via `npm run test:guard` |
| Fullscreen page-key reach (2026-10-28) | Bug found in a real session (`tuiMode: "fullscreen"`): guard's inline prompt advertised "PgUp/PgDn to scroll" while those keys scrolled the transcript instead. Root cause is host-side, not guard-side: `TuiAltScreen` registers its transcript-scroll shortcuts (`tui.altScreen.pageUp`/`pageDown`, which deliberately shadow the editor's same bindings in fullscreen) on raw terminal input in its constructor, before any extension or component listener, and defers only to a focused overlay (`tui-alt-screen.js` `shouldDeferViewportInputToOverlay`, dispatch at the page keys). Guard's inline editor-slot mount is a focused component, not an overlay, so the `matchesKey(data, "pageup")` branch in `guard/ask-overlay.ts` was unreachable there and the overflow detail lines could not be reached at all; `ui.onTerminalInput` cannot intercept them either (extension listeners are registered after the viewport listener). Verified with a throwaway probe against the real `TuiAltScreen`/`TuiMainScreen` (fullscreen+inline: pageUp/pageDown swallowed, and invisible even to a later-added raw listener; fullscreen+overlay and regular mode: delivered) plus candidate-key delivery (ctrl+u/ctrl+d, shift+pageUp/pageDown, alt+pageUp/pageDown, ctrl+f/b all arrive; only plain pageUp/pageDown are shadowed). Fix is guard-local: `guardPageKeys(presentation, tui.mode)` in `guard/ask-overlay.ts` resolves the receivable keys and the advertised label together, `GuardStageContext` carries `presentation` (`"inline" | "overlay"`), and both the selector and the picker detail windows page with `ctrl+u`/`ctrl+d` when mounted inline on a fullscreen host, keeping PgUp/PgDn on the overlay path and on regular-mode or mode-less hosts. The editor stage is untouched (pi's Editor owns those keys there and nothing pages a details window). Suites: `tests/guard-ask-inline.test.mts` (key mapping, fullscreen inline paging, regular-mode and omitted-mode regression) and `tests/guard-ask-overlay.test.mts` (a fullscreen host keeps PgUp/PgDn on the overlay path). Upstream gap, not filed: a pi-tui opt-out that `shouldDeferViewportInputToOverlay` honors for a focused component would let PgUp/PgDn work for inline prompts on fullscreen hosts everywhere, including pi's own inline dialogs, whose `tui.select.pageUp` bindings are starved the same way. |
| Planning integration retirement (2026-10-28) | Deleted the unregistered `extensions/plan.ts`, `isPlanningToolAllowed` and its doc block, research-hold state/helpers and all four event channels, and hold/planning-only tests. Research remains a profile with its existing ladder/cycle position, `/guard profile research`, and child inheritance escape rule. Historical planning rows are retained as history, not live contracts. Suites: `tests/guard-{policy,classes,harness,subagent}.test.mts` via `npm run test:guard` (profile ladder and cycle order, `/guard profile` and ack, classification own-key lookup, subagent inheritance) |
| Computed host-shell profile switch (2026-11-05) | User-confirmed and implemented. The host-shell approval dialog offers one `Switch to <rung> (this session only)` action per qualifying rung, computed per call as `qualifyingSwitchRungs(call, policy)` (`policy/decision.ts`): the pinned candidate set `SWITCH_CANDIDATES = [allow-edits, auto, trusted]` filtered to rungs whose pure `explainHostShellCommand` re-decision would allow this exact call, excluding the current profile, then filtered by `profileChangeAllowed` so a child with an inherited restriction cannot escalate. The ladder is not a permission ordering, so the candidate set is an eligibility allow-list, not a promise that every rung appears; under today's cells only `trusted` can qualify for a prompting call (`default` and `allow-edits` share the `prompt` cell and rules are profile-independent; `auto`'s `classify` cell is never resolved here), and that collapse is asserted in `tests/guard-policy.test.mts`. The flow surface (`prompt-flow.ts`) gains `switchProfileLabel`, an `ExecutionFlowOutcome` member, and a `switchProfileRungs` dep; an unoffered label falls through to the existing unexpected-answer throw (hiding an action is not an authorization check), and the action is appended last after the save/deny entries. `authorize` applies it AFTER the dialog lease releases through the same `transition` as the write/edit switch (no persistence or command options), emits the exact `Profile: <rung> (this session only)` notice, re-decides the original call against the post-transition policy, and returns the POST-transition epoch (a stale epoch would reject execution). No owned editor/picker stages are required (it is a plain selector choice, mirroring `runWriteEditPrompt`'s `offerSwitch`), so a capability-limited host still sees it; the previously pinned `deepEqual(offered, ["Allow once", "Deny once"])` capability-limited menu assertion was updated accordingly. This supersedes the "no mid-dialog profile switching" clause of the 2026-10-06 Step-3 dialogs row for host-shell prompts only: write/edit prompts keep their separate switch, and no other dialog gains a switch. Suites: `tests/guard-policy.test.mts` (the computed set, the collapse, suppression of explicit asks, ambiguous splits, and the current profile), `tests/guard-prompt-flow.test.mts` (label, last placement, one action per rung, forged-label rejection), `tests/guard-harness.test.mts` (end to end: lands the rung, executes with the post-transition epoch, session-only with no config written, child suppression, capability-limited menu shape), and `tests/guard-dialogs.test.mts` (the switch applies after the lease and invalidates a queued command dialog); all wired into `test:ci` and `test:guard`. |

| Model-visible guard state (2026-11-05) | User-confirmed and implemented. One advisory `guard_state` prompt section per run, written by a `before_agent_start` handler in `index.ts` and rendered by the new pure `policy/mode-line.ts` from the same per-profile cells the decision core uses (`hostShellCell`, `writeEditCell`) plus the runtime-mode and lock adjustments (`bashRunsOnHost`, `effectiveWorkspaceMode`), so the text cannot contradict enforcement; no policy code reads it. Fixed one-line contract `guard: profile <name>[ (inherited, cannot be loosened)]; sandbox <mode>; host shell <consequence>; writes <consequence>[; /guard ack clears the lock]`, naming every profile verbatim (classifier identity excluded), with the degraded/reduced clauses and the lock-aware rewrites plus the remedy tail. Blocked sessions render `guard: session blocked (inherited contract invalid); tool execution denied` or `guard: execution blocked (unresolved teardown); tool execution denied`; an unrenderable clause renders `guard: initialized; effective state unavailable` plus a user notice (as does a failed sections write); nothing is emitted before initialization. Freshness is the run boundary (a mid-run switch or lock appears next turn; every lag is informational), and children render their inherited profile. Chosen over a `<rules>` bullet (a change would re-send the whole rules section, and a custom system prompt suppresses `<rules>` entirely) and over `context_with_system` per-LLM-call freshness (an extra request-rewriting hook that must preserve the index-0 system message and its tool declarations). Suites: `tests/guard-mode-line.test.mts` and `tests/guard-harness.test.mts`, wired into `test:ci` and `test:guard`. |
| Guard-absent subagent dispatch (2026-11-13) | Settled by an interview after a guard-disabled session found every dispatch refused (`subagent`, `panel`, and `chain` unusable while the parent session was itself unguarded). Guard and subagent now share `guard/policy/handshake.ts` (all three channel pairs and their payload types). Guard's factory registers an unconditional load-time presence responder (`guard:extension-present-request`/`ack`) that answers before and independently of session state, carries no profile, and authorizes nothing. The subagent querier consults it, plus command provenance (an `extensions/guard`-layout registered command), only when the snapshot produced no correlated acknowledgment, distinguished by a new `kind` field on the snapshot failure shape (`absent` | `refused` | `malformed` | `duplicate`). Double silence dispatches ungated (no `PI_GUARD_INHERIT` override, no `--extension` startup gate, ambient environment untouched); a presence answer, duplicate or unreadable presence ack, presence-query emission failure, or guard-layout command refuses with a diagnostic that names the snapshot handshake. Per-spawn, no cache, no knob, no notice. Tool provenance was rejected because `--tools`/`--exclude-tools`/`defaultTools` filter custom tools out of the registry. Tests: `tests/guard-subagent.test.mts` (presence responder, presence-query matrix, failure kinds, ungated/unresponsive dispatch), `tests/subagent-tool.test.mts` + `tests/subagent-harness.mts` (absent vs unresponsive branch fixtures). Two commits: the inert guard ping first, then the subagent side. |

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
   held, restore on every exit path. (Historical; superseded by retirement of
   the manifest-registered plan.ts extension on 2026-10-26 in favor of the
   agent-skills plan skill.)
   - Verify: each exit path (accept, clear-context, revise then stop,
     `/plan cancel`, resume mid-plan) restores the pre-plan profile.
5. **Subagent inheritance** through an environment variable; headless prompts
   deny.
6. **Switchover:** load guard by default, unload pi-tool-permissions, python,
   and node; remove pwsh on Linux.
7. **Later:** package-registry network proxy; prompt forwarding for
   subagents.

Current verification: `npx tsc --noEmit`, `npm run test:guard`, and
`npm run test:ci`. The standalone `test:python` and `test:node` targets were
removed on 2026-10-28; guard's live worker suites include frame-protocol
coverage for both runtimes.

## Canonical Bash rule subjects

Accepted 2026-11-06, all six contract gates approved; the later expansion-syntax
correction below supersedes the initial literal-word rendering. Measurement is
not authorization to rewrite user rules. This contract supersedes the
raw-subject contract in the historical Stages 1-2 row above.

- `policy/shell-subject.ts` contains pure, JSON-serializable word, assignment,
  redirect and UTF-8 byte-span projections and renderers. `chainArgv` is captured
  BEFORE wrapper unwrapping. The tier continues to judge unwrapped `argv`.
- A literal word's value concatenates its literal parts with shell quote removal
  and quote-context-aware backslash decoding. Empty words render as `''`. Words
  containing whitespace, quotes, backslashes, shell metacharacters, `~`, `$` or
  backticks render single-quoted, escaping embedded quotes as `'\''`.
  Unquoted glob, tilde, brace and extglob syntax is conservatively detected
  separately from expansion nodes and rendered as `@guard:exp:` plus the
  lowercase hex encoding of the whole word's UTF-8 source. Even inert syntax
  may be encoded; quoted or escaped literal syntax stays literal. A word whose
  only expansion reason is unquoted tilde is the dedicated `tilde` kind and
  keeps its unquoted source spelling (see "Tilde is its own eligible word
  kind"), so it is not encoded. Literal
  values starting with the marker are quoted, and source-preserving words
  starting with it are escaped, case-insensitively, to reserve the namespace. This
  prevents an unquoted expanding word from sharing the quoted literal's allow
  subject. Active-expansion eligibility (accepted 2026-11-07) closes the
  remaining compatibility hole: a call whose projected words include kind
  `expanding` (unquoted glob/brace/extglob spellings, and tilde combined with a
  dynamic node) or kind `dynamic`
  (parameter, command, arithmetic or process substitution, including inside
  double quotes) is INELIGIBLE for allow-rule authorization, so no legacy
  glob/regex pattern — broad, marker-shaped, or an exact marker spelling such
  as `HostBash(custom @guard:exp:2a)` — can authorize it; such steps fall
  through to deny/ask (which keep matching current canonical, previous
  canonical and raw spellings, rule-first), the read-only tier, and the
  profile cell, so trusted still allows and default/auto/allow-edits prompt.
  Kinds `tilde`, `source` and `literal` stay eligible. This is rule
  eligibility, not
  profile scope: yolo/unrestricted are unaffected. Save/suggest paths refuse
  to plan allow rules for expansion-bearing steps (allow once only), and the
  audit reports allow rules whose patterns textually match marker subjects as
  the compatibility boundary. Pwsh has no parser: its subjects are unchanged
  and its matching is out of scope for this eligibility gate (documented
  limitation).
  Absent that syntax, a dynamic word (parameter, command, arithmetic or process
  substitution) keeps its source spelling, including quotes. Words containing
  locale-translated `$"..."` or ANSI-C `$'...'` strings also retain their full
  source spelling when not encoded (`kind: "source"`), without claiming a
  static decoded value.
- Leading assignments render `NAME=value` (or `NAME+=value`), quoting only the
  value. Assignment values are not pathname- or brace-expanded; unquoted tilde
  is conservatively encoded. Expanding redirect targets are unresolved and
  cannot qualify for a write-root or `/dev/null` exemption. Redirects follow the argv in source order as ` [descriptor]op target`,
  including the target's canonical spelling. Declarations, arrays, indexed
  assignments and `[[ ... ]]` instead keep their source spelling; this preserves
  their existing completeness and accepted tier behavior.
- `subject` and `allowSubject` are null on incomplete calls. `allowSubject` strips
  harmless trailing redirects from a complete subject. `rawSubject` retains the
  legacy continuation-folded, timeout-stripped slice for display and safety
  matching only. `tierNoopCdSubject` separately preserves the no-op-cd input.
  Spans index the continuation-folded, BOM-free source in UTF-8 bytes.
- Whole-command deny/ask match raw text, nullable `canonicalJoin` and nullable
  `previousCanonicalJoin`; per-step deny/ask match the new canonical, previous
  canonical and raw subjects. Each list is traversed RULES FIRST, so the
  earliest matching rule retains its identity regardless of spelling. The
  previous forms preserve prior safety coverage, not allow authority. Bash
  allow rules match new canonical per-step subjects ONLY. Display, offending
  fragments and aggregate reason attribution retain raw spelling.
- Compound joins replace call spans and keep the typed operators and genuine
  newlines; backslash continuations are folded as before. A comment, negation
  the projection cannot represent, or an incomplete call makes the join null.
  Safety lists retain raw fallback. Incomplete analysis/parser failure prompts
  before the tier or allow rules, but after deny, ask and yolo. Unrestricted
  still allows without consulting the analysis; research is unchanged. Pwsh remains raw and
  whole-command, without a Bash canonical projection.
- Suggestions use canonical per-step subjects, never guessed raw Bash rules.
  Bash subjects containing `*`, `?`, the expansion marker, or regex-shaped
  text use anchored exact regex prefills so suggested allow rules do not
  accidentally treat subject data as wildcard syntax. Users may explicitly
  broaden the reviewed rule. Bash prefill generation refuses a newline in the
  original command or rendered subject, including folded continuations, so
  encoding cannot hide it. Matching still works (ordinary glob `*` cannot cross a newline).
  Explicit-ask save prohibitions and whole-original-call validation are unchanged.

Verification seam: `tests/guard-shell-subject.test.mts` covers the renderer,
analysis projection, explanation and save APIs. The migration audit freezes and
hashes inputs and reports per-rule eligible coverage as well as decisions;
coverage is independent of winning-rule and tier/profile authorization, and
unexercised rules remain unverified. Before any user-config rewrite or curated
fixture regeneration, review that evidence. Neither follows automatically from
this correction.

### Expansion-syntax correction measurement (2026-11-06, Linux)

Replayed the existing frozen corpus and config, not a new harvest: 35,439
observed commands and 6 labelled probes, evaluated as host Bash across seven
profiles and user/empty configs (496,230 paired cells). Against pre-switch
`f47aefe`, there were 489 action changes (322 allow to prompt, 161 allow to
classify, 4 prompt to allow, 2 classify to allow); 31 allow rules lost
coverage and 117 rules were unexercised. Measurement SHA-256:
`11b99df2bf8b5979d11dcb444de0477edeafb3083097f3e3a84307b9810a5498`.
Against committed canonical `7302c00`, the same frozen policy/audit sources
showed no decision or per-rule coverage changes; 121 rules were unexercised.
Measurement SHA-256:
`57f4e55894ff80671d277745f74ace913803c63b8f804b8976216aa80bd345ea`.
Against the pre-switch baseline, three allow rules gained one command each:
quote normalization explains both newly allowed GitHub API commands and the
third, a date command already allowed by the tier. The 31 rule losses include
four tilde rules and predominantly timeout-prefixed commands among the other
losses. The final candidate did not gain any rules against committed canonical.
The original corpus did not exercise the synthetic literal-versus-expanding
collision; focused tests cover it. The config had 340 allow and 2 ask rules,
with no deny rules, so zero observed safety losses is not general safety proof.
Private artifacts and limitations are described in
`tools/shell-subject-audit/README.md`; no personal rules or fixtures were changed.

### Active-expansion eligibility (accepted 2026-11-07, Linux)

Decision: allow-rule eligibility now excludes any call whose projected words
carry active shell expansion (kinds `expanding` and `dynamic`, including
substitutions inside double quotes), closing the marker-matching widening the
2026-11-06 audit could not fix: a legacy glob/regex rule such as
`HostBash(npm install @*)` textually matches the `@guard:exp:` encoding of
`npm install *`, and reserving the marker namespace cannot revoke that under
the unchanged grammar, so authority is revoked through eligibility instead.
Denied/asked commands are unaffected (deny/ask keep current canonical,
previous canonical and raw spellings, rule-first); the read-only tier and
profile cells are untouched (trusted still allows, default/auto/allow-edits
prompt, with the skipped rule named in the prompt reason); save/suggest
refuse to plan allow rules for expansion-bearing steps (allow once only);
and the audit excludes expansion-bearing allow candidates and reports
`markerMatchingAllowRules`. Accepted compatibility loss: every saved allow
rule that previously authorized `$`-bearing or glob-bearing commands now
prompts; there is no expansion-aware persistent rule type yet (an explicit,
versioned contract is a possible future item). Pwsh is unchanged (no
parser). Fixture expectations were updated surgically for three `echo "$…"`
steps previously allowed by `HostBash(echo *)` (see
`tests/fixtures/guard-shell/README.md`).

### Tilde is its own eligible word kind (amended 2026-11-07, Linux)

The first measurement of the eligibility change (frozen corpus, the author's
guard config) put 1,494 of 2,614 newly prompting commands in the tilde-only
category, led by `cd ~/…` (1,589 corpus commands), so the user amended the
scope: unquoted tilde stops being active expansion. It becomes a dedicated
`tilde` word kind, rendered as its own unquoted source spelling (so
`cd ~/x` keeps the subject `cd ~/x`) and eligible for legacy allow rules;
save/suggest therefore plan a readable `HostBash(cd ~/x)` instead of
refusing.

The kind is decided in `projectRuleWord`, where quote context and the dynamic
visitor are still available, and is never re-derived from source text later.
A word with any glob/brace/extglob syntax, or that carries tilde expansion
*and* a dynamic node (`~/x$N`, `~/$X`), stays `expanding`: marker-encoded and
ineligible. A quoted or escaped tilde stays a literal.

Distinctness is what keeps this safe. A literal word whose value contains `~`
is always rendered single-quoted (`'~/x'`), and the escaped spelling `\~/x`
collapses to that same quoted literal, while a `dynamic` or `source` word
always retains `$`, a backtick or parentheses. No other word kind can
produce the unquoted `~/x`, so a rule can never reach a quoted or escaped `~`
through the tilde kind, and the marker encoding is not needed for it. Scope
covers `~/x`, `~user/x`, `~+`, `~-` and genuine assignment-value tilde
(`f=~/x`, previously ineligible); `[[ ... ]]` keeps its conservative scan, so
a tilde there still flags the clause. Mixed expansion is unchanged and
negative-tested: `~/x*`, `~/{a,b}`, `~/$X`, `$HOME/x` and `echo "$HOME"`
still prompt and are still refused by save/suggest.

Covered by `tests/guard-shell-subject.test.mts` (rendering, eligibility,
collision matrix, deny/ask precedence), `tests/guard-shellast.test.mts` (the
per-call flag) and `tests/guard-save.test.mts` (save → compile → match round
trip for `~/x`, `~user/x`, `~/'a b'`, `~/"literal*"`, `~/literal\*`, with
negative matches against the quoted and escaped spellings). The audit adds
`tildeEligibilityGains`, `unexplainedEligibilityGains` and
`eligibilityLosses`: every step that became allow-eligible must carry only
tilde words, and anything else is reported as an unexplained gain.

## Shell-ast adoption: final measurement and retirement record

This final record supersedes the intermediate stage notes above, including
their deferred-fixture/measurement and kept-splitter statements.
The adapter and argv tier are complete. The temporary measurement harness,
including raw gitignored corpora/outputs, is retired. The legacy shell-splitter
module and its last benchmark-only caller are deleted. The retained text
helpers are `stripTrailingHarmlessRedirects` and `stripTimeoutPrefix` in
`extensions/guard/policy/shell-text.ts`.

### Scope, provenance, and final totals

Measured 2026-11-06 against the pre-adapter HEAD baseline, with one command
mapped to host-shell/host-bash (including commands harvested as sandboxed
bash, whose actual sandbox policy does not parse them). Both runs evaluate
the same 34,969 real commands (28,301 bash, 6,668 host_bash) plus 11 synthetic
inputs across seven profiles and two configs: the measured user's real
guard config (338 allow rules) and an empty config. Cwd was this repository;
sandbox mode full, interactive true, workspace unlocked. Classify outcomes
were left unresolved. These are user-config-specific measurements, NOT
claims about the synthetic regression policy.

| Metric | Run 1 (09:13 UTC) | Run 2 (09:50 UTC, final argv tier) |
| --- | ---: | ---: |
| Paired cells | 489,720 | 489,720 |
| Real / synthetic cells | 489,566 / 154 | 489,566 / 154 |
| Changed cells | 38,133 | 38,772 |
| Action-changing | 17,345 | 17,779 |
| Reason-class-only | 20,788 | 20,993 |
| Duplicate keys / consistency errors | 0 / 0 | 0 / 0 |
| Previously allowed, now denied | 0 | 0 |
| Deny to prompt or allow | 0 | 0 |
| Rule-matched, now incomplete prompt (cells / commands) | 1,802 / 1,148 | 1,802 / 1,148 |
| Yolo ask lost (cells / commands) | 184 / 184 | 184 / 184 |
| Recoveries, all groups (cells / commands) | 218 / 195 | 368 / 244 |
| Read-only-tier widening commands | 3 | 43 |

Full numeric summaries (including group totals, transitions, distinct-command
counts, and audit counters) are retained here rather than linking deleted
outputs:

<details>
<summary>Run 1 numeric summary</summary>

```json
{
  "generatedAt": "2026-11-06T09:13:24.828Z",
  "corpus": {
    "real": 34969,
    "evaluatedReal": 34969,
    "bash": 28301,
    "hostBash": 6668,
    "synthetic": 11
  },
  "expectedPairedLines": 489720,
  "pairedLines": 489720,
  "realCells": 489566,
  "syntheticCells": 154,
  "changedCells": 38133,
  "actionChangingCells": 17345,
  "reasonOnlyChanges": 20788,
  "duplicateKeys": 0,
  "consistencyErrors": [],
  "groupTotals": {
    "incompleteness": 37904,
    "rule-matching": 214,
    "read-only-tier": 15
  },
  "groupActionChanging": {
    "incompleteness": 17140,
    "rule-matching": 196,
    "read-only-tier": 9
  },
  "groupDistinctCommands": {
    "incompleteness": 4931,
    "rule-matching": 192,
    "read-only-tier": 5
  },
  "groupTransitionTypes": {
    "incompleteness": {
      "classify->prompt": 7936,
      "allow->prompt": 9180,
      "same-action-reason-change": 20764,
      "prompt->allow": 16,
      "prompt->classify": 8
    },
    "rule-matching": {
      "prompt->allow": 190,
      "classify->allow": 3,
      "same-action-reason-change": 18,
      "classify->prompt": 1,
      "allow->prompt": 2
    },
    "read-only-tier": {
      "prompt->allow": 6,
      "classify->allow": 3,
      "same-action-reason-change": 6
    }
  },
  "allowPromptNotIncomplete": 2,
  "allowPromptNotIncompleteByGroup": {
    "rule-matching": 2
  },
  "allowPromptRuleAnyCfg": 2,
  "allowPromptRuleUser": 2,
  "allowedNowDenied": 0,
  "denyToPromptOrAllow": 0,
  "denyToPrompt": 0,
  "denyToAllow": 0,
  "ruleMatchedNowPrompts": {
    "cells": 1802,
    "commands": 1148
  },
  "yoloAskLost": {
    "cells": 184,
    "commands": 184,
    "byCause": {
      "grouped": 46,
      "heredoc": 111,
      "subshell": 16,
      "function-definition": 6,
      "background": 4,
      "unrecognized-node": 1
    }
  },
  "askGained": {
    "cells": 3,
    "commands": 1
  },
  "recoveries": {
    "cells": 218,
    "commands": 195
  },
  "candidates": 4980
}
```

</details>

<details>
<summary>Run 2 numeric summary</summary>

```json
{
  "generatedAt": "2026-11-06T09:50:21.057Z",
  "corpus": {
    "real": 34969,
    "evaluatedReal": 34969,
    "bash": 28301,
    "hostBash": 6668,
    "synthetic": 11
  },
  "expectedPairedLines": 489720,
  "pairedLines": 489720,
  "realCells": 489566,
  "syntheticCells": 154,
  "changedCells": 38772,
  "actionChangingCells": 17779,
  "reasonOnlyChanges": 20993,
  "duplicateKeys": 0,
  "consistencyErrors": [],
  "groupTotals": {
    "incompleteness": 37912,
    "rule-matching": 346,
    "read-only-tier": 204,
    "profile-cell": 310
  },
  "groupActionChanging": {
    "incompleteness": 17136,
    "rule-matching": 250,
    "profile-cell": 220,
    "read-only-tier": 173
  },
  "groupDistinctCommands": {
    "incompleteness": 4931,
    "rule-matching": 233,
    "read-only-tier": 88,
    "profile-cell": 125
  },
  "groupTransitionTypes": {
    "incompleteness": {
      "classify->prompt": 7930,
      "allow->prompt": 9182,
      "same-action-reason-change": 20776,
      "prompt->allow": 16,
      "prompt->classify": 8
    },
    "rule-matching": {
      "same-action-reason-change": 96,
      "prompt->allow": 208,
      "allow->prompt": 27,
      "classify->allow": 12,
      "classify->prompt": 1,
      "allow->classify": 2
    },
    "read-only-tier": {
      "same-action-reason-change": 31,
      "allow->prompt": 41,
      "prompt->allow": 88,
      "classify->allow": 44
    },
    "profile-cell": {
      "classify->prompt": 131,
      "allow->prompt": 89,
      "same-action-reason-change": 90
    }
  },
  "allowPromptNotIncomplete": 157,
  "allowPromptNotIncompleteByGroup": {
    "rule-matching": 27,
    "profile-cell": 89,
    "read-only-tier": 41
  },
  "allowPromptRuleAnyCfg": 27,
  "allowPromptRuleUser": 27,
  "allowedNowDenied": 0,
  "denyToPromptOrAllow": 0,
  "denyToPrompt": 0,
  "denyToAllow": 0,
  "ruleMatchedNowPrompts": {
    "cells": 1802,
    "commands": 1148
  },
  "yoloAskLost": {
    "cells": 184,
    "commands": 184,
    "byCause": {
      "grouped": 46,
      "heredoc": 111,
      "subshell": 16,
      "function-definition": 6,
      "background": 4,
      "unrecognized-node": 1
    }
  },
  "askGained": {
    "cells": 3,
    "commands": 1
  },
  "recoveries": {
    "cells": 368,
    "commands": 244
  },
  "candidates": 5159
}
```

</details>

### Confirmed decisions

- **Accepted incompleteness tightening:** 1,802 cells / 1,148 commands that
  matched an allow rule now prompt because the projection is incomplete.
  Never move allow rules before completeness to recover them. Complete
  siblings remain decidable; deny/ask rules still precede per-call
  completeness. Whole-command constructs take the fail-closed branch.
- **Accepted yolo ask-rule loosening:** 184 cells / 184 commands. Whole-command
  incompleteness prevents rediscovering inner per-step ask rules. Raw
  whole-command deny/ask rules still win. Breakdown: grouped 46, heredoc
  111, subshell 16, function-definition 6, background 4, unrecognized-node 1.
  This is deliberate, not an unexplained fixture allow.
- **Redirect false-allow correction:** 151 changed cells fix writes that
  escaped the old redirect scan, notably after a quoted argument. Bash now
  uses structured redirects: only a redirect-aware allow rule may authorize
  a non-exempt write. Root-contained writes, /dev/null and descriptor
  dup/close remain exempt; dynamic targets are not exempt.
- **Pwsh scanner fix:** its quote scanner could enter but not leave double
  quotes, hiding a subsequent `>`. Symmetric toggling now catches
  `echo "p" > <outside>` before a trusted cell can allow it. Pwsh was NOT
  in the measured Bash corpus; its scanner and policy regressions are
  covered separately. Whole-command Pwsh rules and lack of a Bash tier stay
  unchanged; broader pwsh enforcement is still deferred.
- **Accepted tier recovery list:** exactly 43 commands, 132 changed cells:
  88 prompt-to-allow and 44 classify-to-allow. Three commands already widened
  in run 1; 40 are new in run 2. This includes manual/registry wrapper
  handling, assignment-prefixed commands, no-op cd, quote-correct regex
  arguments, brace expansion, and test clauses. Focused synthetic cases
  separately pin `command`, `xargs`, `nice`, `env`, `[[ a && b ]]`
  and `echo {a,b}`; `command -v`/`-V` are plain queries, not wrappers,
  and still prompt. Env/printenv without an inner command, secret-file
  arguments and out-of-root reads still veto the tier. No batch loosening
  or effects-based projection is authorized.
- **Traversal-coverage guarantee:** the exhaustive
  `NODE_DISPOSITIONS: Record<ShellNode["type"], NodeDisposition>` table
  classifies every emitted node as descend/leaf/cause. A Proxy fails closed
  with `unrecognized-node` for unknown node types. Explicit manual recursion
  into arithmetic/brace walker leaves catches nested substitutions.
  Per-type tests compare the table against the shipped declared node union
  and induce every inducible type. Comment/TestDecl exceptions and the
  ParamExp/CStyleLoop coverage rationale remain documented above.
- **Curated fixtures, not a replay of user config:** the permanent
  [fixture README](../tests/fixtures/guard-shell/README.md) documents provenance,
  placeholders and the reviewed allow inventory. The small synthetic policy
  derives cwd/readRoots/writeRoots from one fresh temp root. All 11 parser
  rejects and the entire accepted 43-command list are retained in full,
  except home-path and sensitive-identifier substitution; incompleteness is
  sampled by cause, never one row per changed command. Each row asserts
  action, machine adapter cause and evaluator-reported matched rule ID,
  plus per-step action/cause/rule/redirect gate. No prose is asserted.
  The fixtures and existing adapter battery run in both test scripts.
  `Decision.matchedRule` is additive observation metadata, not a routing
  change. No unexplained fixture allow was found.

### Accepted recovery commands, full path-independent list

The following commands retain run-2 source hashes as fixture IDs. Paths use
the synthetic placeholder vocabulary, not the measured user's roots.
This list identifies the accepted measurement set; it does not assert that
all commands allow under arbitrary config. In the synthetic fixture policy,
38 allow and five prompt because original git/gh/dynamic-path rules are absent.
Historical file names in search arguments are literal command data, not
references to files that must still exist.

```text
widen-16569879817e
sudo -n true 2>&1 && echo "sudo ok" || echo "sudo needs password"

widen-3364b8f21390
find {{READ}}/user/source/datadog/libdatadog -name "*.rs" -path "*trace*" | xargs grep -ln "ErrorsSampler" 2>/dev/null

widen-90316e02c998
grep -n "^<<<<<<<\|^=======$\|^>>>>>>>" bottlecap/src/traces/stats_concentrator_service.rs

widen-e9c006ad3bbb
grep -n "^<<<<<<<\|^|||||||\|^=======$\|^>>>>>>>" bottlecap/src/traces/stats_concentrator_service.rs

widen-e3ab4519f039
find {{READ}}/user/.cargo/registry/src -maxdepth 2 -name "libdd-trace-utils-*" -type d | head -1 | xargs -I{} grep -rn "fn send_with_retry\|is_retriable\|RETRIABLE\|backoff\|retry" {} -l | head -3

widen-06a705915425
rg -n 'Deserialize|runner.Run|Assert.Empty\(tracerGitMetadata\)' profiler/test/Datadog.Profiler.IntegrationTests/DebugInfo/GitMetadataTest.cs; rg -n ThrowIfHandlerFailed profiler/test/Datadog.Profiler.IntegrationTests/Helpers/{MockDatadogAgent,TestApplicationRunner}.cs

widen-a2c233e66db3
rg -n "appendRules|defaultRules|'\\$" packages/dd-trace/src/config/index.js | head; rg -n "cloudPayloadTagging" packages/dd-trace/src/config/defaults.js -A 30 | head -60

widen-8c9008ad5b0e
rg -n "defaultRules|\\$\\." packages/dd-trace/src/payload-tagging/config/*.js | head -30

widen-95f42cebe07d
ls packages/dd-trace/src/payload-tagging/config/ && rg -n "appendRules|\\$" packages/dd-trace/src/payload-tagging/config/index.js | head -30

widen-2d1f718cda42
rg -n 'from_tags|TracePropagationStyle|TracePropagationBehaviorExtract' datadog-opentelemetry/src/core/configuration/configuration.rs | head -25; rg -n 'pub\(crate\) fn (extract_baggage|ot_extract_rv|ot_sanitize|ot_set_rv_th|get_extractors|get_injectors)|pub\(crate\) fn from_header' datadog-trace-propagation/src || true; rg -n '#\[doc\(hidden\)\]' datadog-trace-propagation/src/{baggage.rs,config.rs,tracecontext.rs}

widen-e90dd3fcb745
printf '%s\n' '--- direct libdd references in new crate ---'; rg -n "libdd[-_]" datadog-trace-propagation || true; printf '%s\n' '--- public exports ---'; rg -n '^pub (mod|use|trait|struct|enum|const|fn)|^pub\(crate\) mod' datadog-trace-propagation/src/{lib.rs,configuration.rs,sampling.rs,context.rs,carrier.rs,datadog.rs,tracecontext.rs,b3.rs,b3multi.rs,baggage.rs} | head -240

widen-4fdb01ff20c4
date; TZ=America/Toronto date; echo "---"; git -C {{READ}}/user/source/datadog/lucas-pimentel rev-parse --show-toplevel

widen-7ac794d83b0a
date; TZ=America/New_York date; echo "---"; ls {{READ}}/user/source/datadog/lucas-pimentel/daily-summaries/ 2>/dev/null | tail -20

widen-e7afcf3cb5c3
ls -la graphify-out/ | grep -vE "^\s*$"; echo "==="; ls graphify-out/semantic* 2>/dev/null | head

widen-badfe9716311
WORKSPACE="{{READ}}/user/source/datadog/lucas-pimentel"; SOURCE_ROOT="{{READ}}/user/source/datadog"; date; TZ=America/New_York date; ls "$WORKSPACE/daily-summaries/" 2>/dev/null | tail -20; gh auth status 2>&1 | head -20; gh api user --jq .login

widen-8c79484816a4
grep -n "80f1649\|residual gap\|no linked PR visible\|no PR yet\|further touch 2026-09-23\|assigned Lucas.$" projects.md | head; echo ---; grep -n "### Problems" projects.md

widen-ce0557dd3dc9
date; echo "---"; TZ=America/New_York date; echo "---"; git rev-parse --show-toplevel 2>/dev/null; echo "---"; pwd

widen-5e00b368f1c0
TZ=America/New_York date '+%F %T %Z'

widen-9ba40f33ba50
ls {{READ}}/user/source/datadog/lucas-pimentel/.agent/skills/yesterday-summary/scripts/ 2>/dev/null; ls {{READ}}/user/source/datadog/lucas-pimentel/.agent/skills/yesterday-summary/references/ 2>/dev/null; date; TZ=America/New_York date; ls {{READ}}/user/source/datadog/lucas-pimentel/daily-summaries/ 2>/dev/null | tail -5

widen-54fddca0344a
WORKSPACE="{{READ}}/user/source/datadog/lucas-pimentel"
echo "TZ check:"; TZ=America/New_York date
echo "--- gh auth ---"
gh auth status 2>&1 | grep -E "github.com|account" | head -20
echo "--- pr-threads probe ---"
gh pr-threads list DataDog dd-trace-dotnet 1 --all 2>&1 | head -3
echo "--- existing output ---"
ls -la "$WORKSPACE/daily-summaries/" 2>/dev/null | tail -5
echo "--- scripts ---"
ls "$WORKSPACE/.agent/skills/yesterday-summary/scripts/" "$WORKSPACE/.agent/skills/yesterday-summary/references/" 2>&1

widen-eb096e88ca18
ls {{READ}}/user/source/datadog/lucas-pimentel/.pi/skills/yesterday-summary/ {{READ}}/user/source/datadog/lucas-pimentel/.pi/skills/yesterday-summary/scripts/ {{READ}}/user/source/datadog/lucas-pimentel/.pi/skills/yesterday-summary/references/ 2>&1; echo ---; ls {{READ}}/user/source/datadog/lucas-pimentel/daily-summaries/ 2>&1 | tail -5; echo ---; date; TZ=America/New_York date

widen-c317dabba32f
TZ=America/New_York date && echo "---" && gh auth status 2>&1 | head -30

widen-0aea39d156c9
date; date -u; cat {{READ}}/timezone 2>/dev/null; TZ=America/New_York date "+%Y-%m-%d %H:%M %Z"

widen-5029d0496694
date; TZ=America/New_York date '+%Y-%m-%d %A %H:%M %Z'

widen-a44dc0e65fe3
grep -nE 'awk .*NR == 1|all GitLab scripts show|Unify `--help`' skills/gitlab-status/scripts/{bridges,find-pipeline,job-status,pipeline-status}.sh skills/gitlab-failure-survey/scripts/{classify-test-failures,fetch-pipelines,survey-job-traces,survey-pipeline-variables}.sh tests/gitlab-mocked.sh TODO.md

widen-bb59be0de147
rg -n 'baseURL|baseUrl|BASE_URL|ENDPOINT' node_modules/@earendil-works/pi-ai/dist/{providers/anthropic.js,providers/google.js,providers/openai.js,providers/baseten.js,providers/typesafe.js,api/anthropic.js,api/google.js,api/openai-responses.js} | head -55; rg -n 'version' node_modules/@earendil-works/{pi-ai,pi-coding-agent}/package.json | head

widen-7546ec79e66f
rg -n 'Memory|memory|ModelsStore' node_modules/@earendil-works/pi-ai/dist/index.d.ts node_modules/@earendil-works/pi-ai/dist/models-store.d.ts; rg -n 'client\?|baseUrl\?|endpoint|baseURL|url\?' node_modules/@earendil-works/pi-ai/dist/api/{anthropic-messages,google-generative-ai,openai-responses,openai-completions,typesafe-system-one}.d.ts; rg -n 'questions|must|empty' node_modules/@earendil-works/pi-ai/dist/api/typesafe-system-one*.js

widen-422576376929
grep -n -E 'sha256_of\(\)|verified_sha256\(\)|^lock_hash|case "\$guard_rc"' scripts/cargo-audit-release-gate.sh; grep -n -E 'usage_error\(\)|rc" -eq 0' scripts/cargo-audit-report-guard.sh; grep -n -E 'for fake_env, rc, message|if text is None' scripts/tests/audit-release-gate/test_release_gate.py

widen-2642e31ec5c4
grep -n "fn apply_error_rescue\b\|fn apply_error_rescue_at\|fn rescue_with_sampler\|fn lock_sampler\|fn new_error_sampler\|fn resolve_payload_env\|fn span_view\|fn sample_and_stamp\|let Some(root) = chunk.spans.get(root_index)\|fn default_error_sampler\|fn sampler_for\|fn parse_error_sampler_config\|^///$" crates/datadog-trace-agent/src/trace_processor.rs | head -20; grep -n "fn new_error_sampler\|default_error_sampler" crates/datadog-trace-agent/src/trace_processor.rs | head

widen-36167f85b071
rg -n "fn valid_stats_body|fn stats_body|fn wait_for|stats_payload\(\s*$|fn stats_payload\b|fn client_payload" crates/datadog-mock-intake/src/lib.rs | head

widen-a60d404f958d
grep -rln "orchestrator\|OrchestratorURL\|OrchestratorFunction" --include=*.ts --include=*.py --include=*.js . | grep -iv node_modules | grep -iv cdk.out | head; echo "=== CDK stack files ==="; find . -path ./node_modules -prune -o -name "*.ts" -print 2>/dev/null | xargs grep -ln "Orchestrator\|orchestrator" 2>/dev/null | grep -iv cdk.out | head

widen-a4c1f4d8568e
rg -n '500 chars|truncat|first child|assumes|grep -oE|deterministic|usually inflated' .claude/skills/ci-triage/references/{known-failures,pipeline-structure}.md .claude/skills/ci-triage/SKILL.md

widen-543cc23b8454
rg -n "key.json|A\"|\"B\"|\"C\"|LETTERS" src/shuffle.ts | head -8; rg -n "command|case " src/cli.ts | head -10; rg -n "localStorage|scores" src/review.ts | head -5

widen-e68ec43ab749
find {{CWD}} -name "package.json" | grep -v node_modules | xargs grep -l "mariozechner" 2>/dev/null

widen-1a77ba1e1f48
rg -n "permissions allow|\"allow\"|'allow'|case \"allow\"" {{CWD}}/extensions/pi-tool-permissions/index.ts | head; rg -n "permissions allow" {{CWD}} -r 2>/dev/null | head

widen-25424c62a4c8
printf '\nPi documentation sizes:\n'; wc -l node_modules/@earendil-works/pi-coding-agent/docs/{extensions,tui,sdk,keybindings,themes,rpc-commands,json}.md; printf '\nTest entry points:\n'; rg -n '^test\(|^function test|All .*tests passed|^const tests|^async function main|^after\(' tests/guard-policy.test.mts tests/guard-classes.test.mts tests/guard-harness.test.mts tests/guard-dialogs.test.mts tests/guard-test-temp.mts | head -80; printf '\nNested instruction files:\n'; rg --files --hidden -g AGENTS.md -g CLAUDE.md extensions/guard tests docs 2>/dev/null || true

widen-91e2f60197a2
cd {{CWD}} && rg -rn "Theme" node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts | head -5 && rg -n "class Theme|selectList|editor" node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme*.d.ts 2>/dev/null | head; find node_modules/@earendil-works/pi-coding-agent/dist -name "*.d.ts" | xargs rg -ln "class Theme" 2>/dev/null | head -3

widen-39bfb21dec39
file extensions/guard/tools/shell-render.ts extensions/guard/index.ts extensions/timestamps/index.ts; echo ---; grep -c $'\r' extensions/guard/tools/shell-render.ts extensions/guard/index.ts extensions/timestamps/index.ts; echo ---; wc -l extensions/guard/tools/shell-render.ts

widen-9208e1f14f27
grep -l "formatDelta" {{READ}}/user/.pi/agent/sessions/--home-lucas-source-lucaspimentel-pi-extensions--/*.jsonl | xargs ls -t | head -3

widen-98cf302d071e
cd {{CWD}} && rg -n "formatDelta|deltaFor|anchors|delta" extensions/timestamps/ | head -40; echo ---; rg -n $'\r' extensions/timestamps/ | head; echo ---; file extensions/timestamps/*.ts

widen-9a7412c766be
rg -n 'READONLY_BASH_SAFE_ALWAYS|export function splitTopLevelShell|export function assessBreakdownReliability|Iteration / case|for\|select|export function stripStructural|export function tokenizeSimple|function evaluateHostShell|const reliability|function hostTierAllowReason|export function hostTierVetoReason|if \(READONLY_BASH_SAFE_ALWAYS' extensions/guard/policy/{shellsplit,bashtier,decision}.ts

widen-75f1aed44dee
cd {{CWD}} && ls -la tests/fixtures/ | head && echo "=== precedent: test files importing other test modules ===" && grep -rn "^import .*from \"\./" tests/*.mts | grep -v "\.\./extensions" | head -20 && echo "=== guard-harness head ===" && head -20 tests/guard-harness.test.mts && echo "=== does test:ci include a non-test helper? ===" && grep -o "tests/[a-z0-9-]*\.mts" package.json | sort -u | wc -l

widen-2f4c7d74ba91
cd {{CWD}} && grep -rn "nine\|ten \|ten$\|nine-\|ten-" README.md docs/gh-read-design.md extensions/gh-read/index.ts extensions/gh-read/validate.ts extensions/gh-read/api.ts TODO.md tests/gh-read-tool.test.mts tests/gh-read-validate.test.mts 2>/dev/null | grep -vi "nine-item\|ten-item" | head -40
```

