# Guard: sandbox-first permission redesign

Status: **design settled (2026-10-02 grilling sessions, including step 0:
assumptions confirmed); step 1 (shared sandbox library) implemented in
`extensions/guard/sandbox/`; step 2 (policy core) implemented and
observe-only in `extensions/guard/index.ts` + `policy/` (2026-10-06); steps
3+ not implemented.**

Scope: a new `guard` extension that replaces `extensions/pi-tool-permissions/`,
`extensions/python/`, and `extensions/node/`, plus changes to
`extensions/plan.ts`, `extensions/pwsh.ts`, and `extensions/subagent/`.
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
| `/plan` is not read-only | `plan.ts:199` (`narrowTools()`) hides only write/edit. bash, pwsh, python, node, MCP, and subagent stay active. The only other safeguard is prompt text (`plan.ts:55`). |
| python/node writable mounts do not protect paths whose contents later execute outside the sandbox | `python/sandbox.ts` and `node/sandbox.ts` never mention `.git` or `.pi`. In edits/auto/yolo, sandboxed code can write `.git/hooks/*`, `.git/config`, and `.pi/pi-tool-permissions*.json` (the model could grant itself allow rules). |
| `pwsh` runs on the host | `pwsh.ts:127` spawns it directly. On Linux it is equivalent to unsandboxed bash. |
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
- **pwsh:** registered on Windows only (removed on Linux). It is a host-tier
  tool exactly like host_bash (hidden in research, rule-or-prompt in default,
  classifier in auto, allowed in trusted/yolo) with its own `Pwsh(...)` rules.
  pwsh has no read-only tier today, so none carries over.
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
| `python`, `node` | Persistent sandboxed interpreters (existing design), moved into guard. In research: one throwaway overlay per worker lifetime. In yolo and unrestricted: fully raw (see below). |
| `pwsh` | Windows only; host tier, like host_bash. |

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
- Commands you type with `!` stay unsandboxed.

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
| Sandboxed workspace | throwaway overlay (per call for bash, per worker lifetime for python/node) | read-write, protected paths read-only | same as default | same as default | **no sandbox** for bash, python, or node | **no sandbox** |
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
  are denied. Documented gap; step 3 adds a `tool_result` filter that drops
  grep/ffgrep matches from masked files.

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
   `destructiveHint` -> remote write);
4. a **name heuristic** (post/send/create/update/delete/write/... ->
   remote write);
5. anything still unknown is a **remote write** (prompt in default, deny in
   research, classifier in auto, allowed in trusted and above).

MCP calls in both naming styles (pi's built-in `mcp__<server>__<tool>` with
plain arguments, and the pi-mcp-adapter `mcp` proxy with `input.tool`) go
through the same order. **`pup_run`** is classified by its subcommand verb:
list/get/search/query/show/status/aggregate -> remote read;
create/update/delete/mute/edit and anything unrecognized -> remote write.

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

## Subagents

- Children inherit the parent's profile through an environment variable read
  by the child's guard. They cannot loosen it.
- Any prompt in a headless run is denied, including host_bash.
  `nonInteractiveAsk` is deleted.
- Sandboxed work stays free, so workers remain useful.
- **Deferred:** forwarding child prompts to the parent UI.
- Reminder: children load the **installed** extensions from
  `~/.pi/agent/git/github.com/lucaspimentel/pi-extensions`, not the working
  tree. End-to-end testing needs commit, push, and `pi update`.

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
   shared library.
   - Verify: python/node suites pass on the shared library; research overlay
     discards writes; yolo runs unsandboxed.
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
