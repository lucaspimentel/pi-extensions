# Guard: sandbox-first permission redesign

Status: **draft, brainstorming**. The open questions at the end are not
answered yet. Write no code until they are settled and this doc is updated.

Scope: `extensions/pi-tool-permissions/`, `extensions/plan.ts`,
`extensions/python/`, `extensions/node/`, a new sandboxed `bash`, plus
`extensions/pwsh.ts` and `extensions/subagent/`, where they interact.
Breaking changes, and starting from scratch, are both acceptable.

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

Other relevant current state:

- python/node are implicitly allowed by pi-tool-permissions
  (`SANDBOXED_TOOLS`, `pi-tool-permissions/rules.ts:52`).
- `PermissionMode = "manual" | "edits" | "auto" | "yolo"` is session-only and
  broadcast on `pi.events` channel `tool-permissions:mode` as
  `{ mode, readRoots }`. python/node remount `/workspace` read-write in
  edits/auto/yolo and ignore unknown modes.
- `plan.ts` and pi-tool-permissions do not communicate at all.
- web_fetch currently prompts: no allow rule for it was found in the user
  config.

## Feasibility checks (verified 2026-10-02)

- bubblewrap is 0.9.0 (Ubuntu package `0.9.0-1ubuntu0.3`, `/usr/bin/bwrap`).
  On Ubuntu noble (24.04) the installed and candidate versions are both
  this noble-security point release, so apt offers no newer bwrap. It has
  **no** `--overlay-src` / `--tmp-overlay`
  (`bwrap: Unknown option --overlay-src`).
- The kernel is `6.18.40.1-microsoft-standard-WSL2`. **Unprivileged overlayfs
  inside a user namespace works**:
  `unshare -rm sh -c "mount -t overlay overlay -o lowerdir=...,upperdir=...,workdir=... <mnt>"`
  succeeded, and writes went to `upperdir` while `lowerdir` stayed
  unchanged.
  - **Overlay mounted before bwrap works with stock bwrap 0.9.0:**
    `unshare -rm sh -c "mount -t overlay ... <merged> && bwrap ... --unshare-all --bind <merged> /w -- ..."`
    succeeded (nested user namespace). Writes and `mkdir` inside the sandbox
    landed in upperdir; lowerdir was unchanged. This is the preferred
    approach: no custom bwrap build. The outer step can be `unshare` or a
    small C launcher (the `seccomp-launch.c` pattern).
  - Rejected alternatives: building bwrap 0.10+ (extra dependency outside
    apt), fuse-overlayfs (extra package, slower).
  - Not yet tested: an overlay whose lowerdir is on `/mnt/c` (9p), and how
    upperdir size behaves for large builds (dd-trace-dotnet `obj/` and `bin/`
    run to GBs, so upperdir belongs on disk, not tmpfs).
- Nested tool calls made through `ctx.executeTool` go through `tool_call`
  handlers (pi `docs/extensions.md:148`). codemode is therefore not a
  permission bypass **if** it uses `executeTool`. Unverified for codemode's
  actual implementation.
- Reference implementations:
  - pi `examples/extensions/sandbox` (uses `@anthropic-ai/sandbox-runtime`:
    bwrap, socat network proxy with a domain allowlist, deny-list reads).
  - `examples/extensions/gondolin` (micro-VM).
  - Both override the built-in bash through `createBashTool()` with custom
    `BashOperations`, which keeps the built-in rendering and truncation.

## Proposed paradigm: confinement first

### Principles

1. **The kernel enforces; rules only route.** A rule can never make an
   unconfined action safe. Rules only decide whether an escape from the
   sandbox needs a prompt.
2. **One policy, many enforcers.** A single policy object holds the profile,
   read roots, write roots, protected paths, and network setting. Host tools
   (read/write/edit/grep) and sandbox mounts are both derived from it, so
   they cannot drift apart.
3. **Sandboxed runs cost nothing.** Prompts and classifier round trips are
   spent only on escapes and on effects outside the machine.
4. **Fail closed.** If the policy component is not loaded, executors use the
   most restrictive profile and never fall back to unsandboxed execution.
5. **Tightening only.** A holder (plan, a subagent parent) can tighten the
   policy. Nothing downstream can loosen it.

### Tool classes

| Class | Tools |
|---|---|
| Confined execution | `bash` (new, sandboxed), `python`, `node` |
| Host execution (escape) | `host_bash` (new name for the unsandboxed built-in), `pwsh` |
| Local read | read, grep, find, ls, fffind, ffgrep, session_search, memory_read, memory_search |
| Local write | write, edit, memory_write, memory_forget, scratchpad |
| Remote read | web_fetch, web_search, `pup_*` reads, MCP read tools |
| Remote write | MCP writes, pup writes |
| Meta | subagent, codemode, ask_user_question |

Exfiltration needs a sink the attacker can read. Under that view:

- **Attacker-readable sinks:** web_fetch to an arbitrary domain (data rides
  in the URL), and Slack posts.
- **Not attacker-readable:** web_search queries (they go to the search
  provider), and pup or Jira reads (your own tenant).

The sandbox does not close remote-tool channels, so they are gated
separately.

### Profiles (replace the mode enum)

| | research (`/plan`) | default | auto | yolo |
|---|---|---|---|---|
| Sandboxed workspace | throwaway overlay (writes discarded) | read-write except protected paths | same as default | same as default |
| Sandbox network | none | none (v2: package-registry proxy) | none | none |
| Local writes | deny | allow inside write roots, except protected paths | classifier | allow, except protected paths |
| Host escape | deny (tool hidden) | ask, unless a rule allows | classifier | allow |
| Remote read | allowlist | allowlist or ask | classifier | allow |
| Remote write | deny | ask | classifier | allow |

- The sandbox stays on in every profile, **including yolo**. Yolo only stops
  prompting for escapes.
- In auto mode, the classifier screens only escapes and remote effects.
  Sandboxed calls skip it, which also cuts classifier cost.

### Sandboxed `bash`

- Same tool name, `bash`, so the model's habit works for us. Built with
  `createBashTool()` plus a bwrap-spawning `BashOperations`.
- One process per call, like the built-in. No persistent shell, so no
  worker/protocol layer is needed (unlike python/node).
- **Reads:** allowlist, as in python/node. Anything read can reach the
  model's context and leave through a remote tool. Mounted:
  - workspace and granted read roots
  - `/usr` and a minimal `/etc`
  - toolchains, read-only (`~/.cargo/bin`, `~/.rustup`, `~/.dotnet`,
    `~/.nvm`, `~/.local/bin`)
  - package caches (see open question 11)

  Never mounted: `~/.ssh`, the ssh-agent socket, `~/.config/gh`, `~/.aws`,
  `~/.azure`, `~/.npmrc`, `~/.git-credentials`, `~/.docker`, pup tokens,
  `/run`, `/mnt/c`.
- **Writes:** workspace per profile, private `/tmp`, scratch. Protected
  paths are bind-mounted read-only on top of the workspace.
- **Environment:** allowlist only (`PATH`, `HOME`, `TMPDIR`, `LANG`,
  toolchain variables). Strips all keys and tokens.
- **Network:** `--unshare-net` (loopback still works, so local test servers
  run). v2 adds a host-side HTTP proxy with a package-registry allowlist,
  reached through a bind-mounted Unix socket and an in-sandbox forwarder,
  with `HTTP(S)_PROXY` set. Every allowlisted domain is also a possible
  exfiltration sink, so keep the list to registries.
- **Seccomp:** lighter than python/node. Keep the bans on ptrace, bpf, new
  user namespaces, and keyctl. Do **not** ban `socket`: build tools need Unix
  sockets and loopback (MSBuild node reuse, test runners), and the network
  namespace already isolates abstract sockets. TIOCSTI is covered by bwrap
  `--new-session`.
- **Failure hints:** when a sandboxed command fails (network unreachable,
  EROFS on a protected or read-only path, path not mounted), the result adds
  a hint: "this ran sandboxed; use host_bash if host access is required".
- **WSL interop** needs an explicit escape test: running a `.exe` from inside
  the sandbox must fail (`WSL_INTEROP` cleared, `/run/WSL` not mounted).
- Commands typed with `!` stay unsandboxed.

### Protected paths

Read-only inside every sandbox. For write/edit they prompt even in yolo
(pending question 4).

- Workspace: `.git/hooks`, `.git/config`, `.git/info`, `.pi/`, `.claude/`,
  `.agents/`, `.vscode/`, `.idea/`, `.envrc`, plus possibly instruction files
  (`AGENTS.md`, `CLAUDE.md`, repo `skills/`); see question 3.
- Git worktrees: the workspace `.git` is a file pointing into the main
  clone's `.git/worktrees/<name>`. The main clone's `.git` must be mounted,
  with the same protections.
- Host: `~/.pi/agent/**` (config, installed extensions, memory), and shell rc
  files (`~/.zshrc`, `~/.bashrc`, `~/.profile`).

### Research profile and `/plan`

This absorbs the earlier handoff, "read-only enforcement during `/plan`".

- plan.ts becomes a client of the policy component. It requests the
  `research` profile with a holder id (`"plan"`) and releases it on **every**
  exit path:
  - `restoreTools`
  - the clear-context branch (`plan.ts:299`, which today skips
    `restoreTools`)
  - the cancelled-newSession branch
  - recovery in `session_start` and `session_tree`
- Track holders as a set (`"plan"`, `"user"`) so releasing one does not clear
  the other.
- Refuse to start `/plan` if the policy component does not acknowledge the
  request (fail closed), instead of warning and continuing.
- plan keeps `narrowTools()` for the model-facing tool list and also hides
  `host_bash`.
- Resolutions of the handoff's open decisions under this design:
  - Refused calls are **denied**, not asked. This is cheap because builds and
    tests run in the throwaway overlay.
  - `writeAllowPaths` targets are not writable in research.
  - MCP: only an explicit read-only allowlist (the
    `mcp__slack__*` / `mcp__atlassian__*` read rules in the user config).
  - Subagents: children inherit research mode.

### Subagents

- Children inherit the profile and holders through an environment variable
  read by the child's policy component. They cannot loosen it.
- Escapes always deny in headless runs. Delete `nonInteractiveAsk`.
- Sandboxed work is free, so workers stay useful without prompts.
- Reminder: children load the **installed** extensions from
  `~/.pi/agent/git/github.com/lucaspimentel/pi-extensions`, not the working
  tree. End-to-end testing needs commit, push, and `pi update`.

### Architecture

Proposal (pending question 12): merge pi-tool-permissions, the shared
sandbox library, and the `bash` / `host_bash` / `python` / `node` tools into
one `guard` extension that owns the policy. This removes the
cross-extension event-bus races and the "permissions not loaded" fallbacks.
plan stays a separate client and communicates over the bus with an
acknowledgment handshake.

## Open questions

Bracketed text is the current lean, not a decision.

### Threat model

1. **Remote reads:** gate by "attacker-readable sink" (web_fetch per domain,
   Slack posts) rather than prompting on every remote call? [Yes]
2. **Secrets inside the workspace** (`.env*`, `*.pem`, `appsettings.*.json`
   with keys): mask them in the sandbox (bind `/dev/null` over them) and deny
   them to `read`? This costs false positives such as `.env.example`. [Mask a
   well-known list, with per-project opt-out]
3. **Instruction files** (`AGENTS.md`, `CLAUDE.md`, repo skills) and
   `memory_write` can carry an injection into future sessions. Protect them,
   or rely on diff review? [Protect repo instruction files; leave memory_write
   allowed but show writes in the UI]
4. **Protected paths in yolo:** still prompt? [Yes. Yolo means "don't ask
   about the work", not "let the model rewrite its own guardrails"]

### Profiles

5. **Drop manual (prompt on every edit)?** Alternatives: keep it, or a
   staging overlay where sandbox writes land in an overlay and an approved
   diff is applied. The staging overlay is heavy: deletes, permissions, large
   `obj/` trees. [Drop manual; staging overlay later, if ever]
6. **Untracked-file loss** (a sandboxed `rm` of untracked, non-ignored files
   is not git-reversible): accept, or snapshot before each sandboxed call?
   [Accept for v1]
7. **Research mode execution:** run builds and tests in the throwaway
   overlay, or forbid execution beyond read-only commands? [Overlay]

### Escapes

8. **Separate `host_bash` tool or a `sandbox: false` parameter on `bash`?**
   [Separate tool: plan can hide it, `Bash(...)` rules naturally apply only
   to escapes, and the model reaches for `bash` by habit]
9. **Auto-routing:** run a sandboxed `bash` call on the host silently when it
   matches a host allow rule (e.g. `gh pr view *`)? [No: it brings back
   string-match trust]
10. **Allow-rule migration:** `Bash(...)` rules come to mean "may escape
    without a prompt". Delete every rule for commands that run project code
    (cargo/dotnet build/test, pytest, `npm run`)? Without a network proxy,
    `dotnet restore` and `npm install` then prompt every time, and they run
    project code on the host when approved. [Delete; make the registry proxy
    the v2 priority]
11. **Package caches in the sandbox:** read-only, or a throwaway overlay per
    call? Never writable, because a poisoned package would later run
    unsandboxed. [Overlay; needs testing with cargo and NuGet, which may need
    to write lock files]

### Architecture and platform

12. **One `guard` extension, or coordination over the event bus?** [Merge;
    plan fails closed without an acknowledgment]
13. **pwsh on Linux:** sandbox it, or host-only escape tier? [Host-only]
14. **Native Windows pi:** must any of this work there? bwrap is Linux-only.
    [WSL/Linux only; Windows keeps today's prompting behavior]
15. **Subagents:** may headless children ever perform host actions (git push,
    gh)? [No; the parent does those]

### Rollout

16. Phases or a big-bang rewrite? [Phases; each one closes a real hole on its
    own]

## Proposed rollout (pending answers)

1. **Shared sandbox library.** Extract the common parts of
   `python/sandbox.ts` and `node/sandbox.ts` (bwrap args, read-root mounts,
   mode-event handling, seccomp launcher) into `extensions/shared`. Add
   protected-path read-only overmounts.
   - Verify: python/node suites pass, and new tests show that writes to
     `.git/hooks/x` and `.pi/x.json` fail in writable mode.
2. **Policy component and profiles.** Replace the mode enum with profiles.
   Add the research profile and holder tracking; integrate plan.ts with an
   acknowledgment handshake and release on every exit path.
   - Verify: decide-level tests (research refuses `sed -i`, `git commit`,
     write/edit, python/node writes, and broad-allow-rule matches; explicit
     deny still wins), holder tests, session-reset tests, and python/node
     staying read-only under research even when the profile would otherwise
     be writable.
3. **Sandboxed `bash` and `host_bash`.**
   - Verify, escape tests: read `~/.ssh`, write `.git/hooks`, `curl`,
     environment leak, `.exe` via WSL interop, TIOCSTI.
   - Verify, happy path: offline `cargo test` and `dotnet test`.
4. **Config purge.** Remove project-code-executing allow rules; delete
   `nonInteractiveAsk`.
5. **Package-registry network proxy** for the sandbox.
6. **Optional:** staging overlay for reviewed writes.

Test commands today: `node extensions/pi-tool-permissions/run-all.mjs`,
`npm run test:python`, and the node equivalents under `tests/`.
