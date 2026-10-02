# Guard: sandbox-first permission redesign

Status: **design settled (2026-10-02 grilling session); not implemented.**
Six assumptions at the end still need explicit confirmation before coding.

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
  - `bash` runs on the host under host_bash rules and prompts.
  - python/node are unavailable.
  - In research, `bash` runs only commands the string-based read-only tier
    and validators prove read-only; everything else is denied.
- **pwsh:** registered on Windows only (removed on Linux).

## Architecture

- One new **`guard`** extension owns the policy. It contains the permissions
  logic (from pi-tool-permissions), the shared sandbox library (extracted from
  python/node), and the `bash`, `host_bash`, `python`, and `node` tools.
- **plan.ts stays separate.** It requests the research profile from guard
  over `pi.events` and refuses to start `/plan` without an acknowledgment.
- **Rollout:** build guard alongside the old extensions (not loaded by
  default) until it reaches parity, then switch over. No patches to the old
  code in the meantime.

## Config

- New file **`guard.json`** (user and project scopes). It holds profiles
  settings, protected paths, secret masks and per-project opt-outs, the
  web_fetch domain allowlist, and `HostBash(...)` rules (replacing
  `Bash(...)`).
- **`/guard migrate`** converts `pi-tool-permissions.json`:
  - copies every `Bash(...)` rule to `HostBash(...)`
  - drops `nonInteractiveAsk`
  - **lists** rules that look like project-code runners (cargo/dotnet
    build/test/run/restore, pytest, npm run/install, make) for a manual purge.
    Nothing is dropped automatically.

## Tools

| Tool | Behavior |
|---|---|
| `bash` | Always sandboxed, except in yolo. Built with `createBashTool()` plus bwrap-spawning `BashOperations`. One process per call, no persistent shell. |
| `host_bash` | The only escape from the sandbox. Only `HostBash(...)` rules apply to it. |
| `python`, `node` | Persistent sandboxed interpreters (existing design), moved into guard. Unsandboxed in yolo. |
| `pwsh` | Windows only. |

- **No auto-routing:** a sandboxed `bash` call never runs on the host because
  it matches a rule.
- **Failure hints:** when a sandboxed command fails (network unreachable,
  EROFS on a protected or read-only path, path not mounted), the result adds a
  hint to use `host_bash` if host access is required.
- Commands you type with `!` stay unsandboxed.

## Profiles

Session-only, never persisted. Every session starts in **default**; subagent
children start in the inherited profile. Ctrl+Alt+M cycles through all five,
with no confirmation when entering yolo.

| | research | default | auto | trusted | yolo |
|---|---|---|---|---|---|
| Sandboxed workspace | throwaway overlay per call | read-write, protected paths read-only | same as default | same as default | **no sandbox** for bash, python, or node |
| host_bash | hidden or denied | prompt unless rule-allowed | classifier | allowed | allowed |
| write/edit | deny | allowed in write roots | classifier | allowed | allowed |
| Protected paths | deny | prompt | prompt | prompt | allowed |
| Exfil-capable remote reads (web_fetch outside the allowlist) | prompt | prompt | classifier | allowed | allowed |
| Other remote reads (web_search, pup, Jira/Slack reads) | allowed | allowed | allowed | allowed | allowed |
| Remote writes (Slack posts, MCP writes, pup writes) | deny | prompt | classifier | allowed | allowed |

Exfiltration needs a sink the attacker can read:

- **Attacker-readable sinks:** web_fetch to an arbitrary domain (data rides in
  the URL), and Slack posts.
- **Not attacker-readable:** web_search queries (they go to the search
  provider), and pup or Jira reads (your own tenant).

## Sandbox contents

For every profile except yolo:

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
- **Seccomp:** lighter than python/node's. Ban ptrace, bpf, new user
  namespaces, and keyctl. Allow `socket`: build tools need Unix sockets and
  loopback (MSBuild node reuse, test runners), and the network namespace
  already isolates abstract sockets. TIOCSTI is covered by bwrap
  `--new-session`.
- **Overlay mechanics:** mount the overlay in an outer `unshare -rm` (or a
  small C launcher like `seccomp-launch.c`) before bwrap.
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
- `memory_write` stays allowed; each write is shown in the UI.

## Accepted risks

- In default (and auto/trusted), the workspace is writable, so a sandboxed
  command can delete **untracked** files, which git cannot restore. Accepted
  for v1; same exposure as today's edit/write tools in edits mode.
- yolo is 100% unrestricted, at your own risk: no sandbox, no prompts,
  protected paths writable.
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

## Assumptions pending confirmation

1. **python/node in research** use the same throwaway overlay as `bash`,
   lasting for the worker's lifetime, instead of today's read-only mount.
2. **Unsandboxed python/node in yolo** keep the persistent worker and
   protocol; only bwrap and seccomp are skipped.
3. **pwsh on Windows** follows host_bash rules and profiles.
4. **Auto mode's classifier** screens only host_bash, write/edit,
   exfil-capable remote reads, and remote writes. Sandboxed calls skip it.
5. **Degraded mode** keeps both tool names, with `bash` behaving exactly like
   `host_bash`, and shows a persistent footer warning.
6. **`NuGetAudit=false`** is set in the sandbox environment so offline
   restores don't time out or fail builds that treat warnings as errors.

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

## Implementation outline (build alongside, switch over)

1. **Shared sandbox library** in guard: bwrap args, overlay launcher, read
   roots, protected-path and secret overmounts, environment allowlist,
   seccomp launcher.
   - Verify: escape tests (read `~/.ssh`, write `.git/hooks` and `.pi/x.json`,
     `curl`, environment leak, `.exe` via WSL interop, TIOCSTI) and a happy
     path (offline `cargo test`, `dotnet test`).
2. **Policy core:** profiles, decision function, `guard.json` loading,
   `/guard migrate`, cycle and footer status, degraded mode.
   - Verify: decision-level tests for every profile and tool-class cell in the
     profile table; migration round trip.
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
