# guard

Sandbox-first permission redesign. Guard replaces `pi-tool-permissions`,
`python`, and `node` with one extension built around a kernel-enforced
sandbox. See `docs/guard-design.md` for the settled design.

**Status: step 1 (shared sandbox library) and step 2 (policy core) are built
here. Guard is loaded by pi (`pi.extensions`) in observe-only mode:** its
`tool_call` hook computes decisions, publishes them on `guard:decision`, and
never blocks or prompts. pi-tool-permissions stays the enforcing extension
until switchover (step 6). Step 3 (tools, dialogs) builds on both.

## Policy (step 2, observe-only)

The policy core lives in `policy/`: profiles, the decision function, tool
classification, guard.json, the save/migrate helpers, and the session state.

### Profiles and the cycle hotkey

Six session-only profiles; every session starts at `default`, nothing is
persisted:

| | research | default | auto | trusted | yolo | unrestricted |
|---|---|---|---|---|---|---|
| Sandbox workspace (step 3) | overlay (ro unless full mode) | rw | rw | rw | none | none |
| host_bash / pwsh | deny | rules, then tier, then prompt | rules, then tier, then classify | rules, then tier, then allow | deny/ask rules, else allow | allow |
| write/edit (non-protected) | deny | cwd + writeRoots, prompt outside | classify | allow | allow | allow |
| Protected-path write/edit | deny | prompt | prompt | prompt | allow | allow |
| Local reads | as default | cwd + readRoots, prompt outside | as default | as default | allow | allow |
| Secret-mask path via read/grep | deny | deny | deny | deny | allow | allow |
| web_fetch outside webFetchAllow | prompt | prompt | classify | allow | allow | allow |
| Other remote reads | allow | allow | allow | allow | allow | allow |
| Remote writes | deny | prompt | classify | allow | allow | allow |
| Sandboxed exec (bash/python/node) | allow | allow | allow | allow | allow | allow |
| Meta (codemode, subagent, ...) | allow | allow | allow | allow | allow | allow |

- **ctrl+alt+g** cycles research -> default -> auto -> trusted -> yolo ->
  research, no confirmation on entering yolo. `cycleShortcut` in guard.json
  overrides the key (read at load time).
- **unrestricted is never in the cycle**; it is reachable only with
  `/guard profile unrestricted`. Cycling from unrestricted goes to research.
- While plan holds research (the `guard:research-request` /
  `guard:research-release` / `guard:research-ack` handshake), every profile
  change is blocked except staying in research; releasing restores the
  pre-hold profile.

### Host-shell precedence

- **research:** absolute. HostBash/Pwsh rules are ignored; host shells deny.
  In degraded mode, sandboxed bash runs only commands the read-only tier
  proves read-only; allow rules never widen that set.
- **default / auto / trusted:** deny rules > ask rules > the tightened
  read-only tier (host vetoes first: `env`/`printenv` as the command, any `$`
  outside single quotes, file arguments matching the secret-mask patterns
  minus exceptions) > redirect-aware allow rules > the profile cell.
- A top-level file redirect (outside the writeRoots exemptions) is allowed
  only by a redirect-aware allow rule, one whose pattern contains `>` (e.g.
  `HostBash(rg * > *)`). Broad rules and the profile cell never authorize a
  write redirect.
- Compounds (`&&`, `||`, `;`, `|`) are split per subcommand and aggregate as
  deny > prompt > classify > allow; an ambiguous split prompts (denies in
  research), but an explicit deny rule on the raw command still denies.
- **yolo:** deny rules block, ask rules prompt, everything else allows.
- **unrestricted:** allow, rules ignored.
- Non-interactive sessions (`!ctx.hasUI`): prompts collapse to deny.

### Tool classification

Every call maps to exactly one class (`policy/classes.ts`), which selects the
table row. Resolution order:

1. guard.json **`toolClasses`** (exact names or globs; overrides everything),
2. guard's **built-in map** (`read`/`grep`/... local reads; `bash`/`python`/
   `node` sandboxed exec; focused `pup_*` and Slack reads remote reads;
   `codemode`/`tool_search`/`subagent`/`ask_user_question` meta; `web_fetch`
   by URL against `webFetchAllow`; `pup_run` by subcommand verb),
3. the tool's self-declared **annotations** (`readOnlyHint` -> remote read,
   `destructiveHint` -> remote write), looked up from `pi.getAllTools()` on
   first use and cached per session,
4. a **name heuristic** (post/send/create/update/delete/... -> remote write),
5. anything still unknown is a **remote write** (fail closed).

MCP calls in both naming styles classify the same way: built-in
`mcp__<server>__<tool>` names pass through; the `mcp` proxy classifies as
`mcp__<server>__<input.tool>` (or `mcp:<input.tool>` with no server), so
globs like `mcp__slack__*read*` match.

### Local reads and the directory-grep gap

Reads inside cwd and `readRoots` (~ and `$HOME` expanded) are allowed; a
missing or empty `path` argument means cwd. Outside them, guard would prompt
(session/project/user grants, step 3); `readGrantSuggestion(path)` already
returns the covering directory. Secret masks are **path-level only** in
step 2: a read of a masked file (`.env`, `*.pem`, ...) is denied in every
profile except yolo/unrestricted, but a grep or find over a directory that
happens to contain a masked file is allowed. This is a documented gap; step 3
adds a `tool_result` filter that drops matches from masked files.

### guard.json

User scope `~/.pi/agent/guard.json`, project scope `<cwd>/.pi/guard.local.json`
(machine-local). Keys: `cycleShortcut`, `protectedPaths`, `maskPatterns`,
`maskExceptions`, `webFetchAllow` (URL globs or `/regex/`), `hostBash`
(`allow`/`ask`/`deny` lists of `HostBash(...)` / `Pwsh(...)` rules),
`readRoots`, `writeRoots`, `toolClasses` (name/glob -> class),
`bashValidators`, the `classifier` pin, and the `classifierEnvironment` /
`classifierAllow` / `classifierSoftDeny` / `classifierHardDeny` lists.
Scalars are project-wins; lists union with dedupe; a corrupt file is ignored
with a warning and never discards the other scope.

### /guard subcommands

| Command | Behavior |
|---|---|
| `/guard` | profile picker (all six profiles) |
| `/guard help` | usage |
| `/guard list` | profile, holder, sandbox mode and diagnostics, workspace lock, protected paths, mask exceptions, webFetchAllow count, host-shell rule counts, read/write roots, toolClasses count, classifier, debug state |
| `/guard reload` | reload guard.json, refresh sandbox detection, clear the annotation cache |
| `/guard profile [name]` | set a profile directly (`unrestricted` included) |
| `/guard migrate [dry]` | convert pi-tool-permissions configs (below) |
| `/guard ack` | clear the workspace lock (step 3 sets it on audit findings) |
| `/guard debug on\|off` | session-only; when on, each decision is also shown as a notification |

### Migrate

`/guard migrate` reads the legacy pi-tool-permissions configs (user:
`~/.pi/agent/pi-tool-permissions.json` with a `~/.pi/tool-permissions.json`
fallback; project: `.pi/pi-tool-permissions.local.json` with
`.pi/pi-tool-permissions.json` and `.pi/tool-permissions.json` fallbacks) and
converts everything that has a guard home:

- `Bash(...)` -> `HostBash(...)` in the same slot; `Pwsh(...)` rules kept;
- `readAllowPaths` -> `readRoots`; `writeAllowPaths` and
  `bashAllowRedirectsTo` -> `writeRoots`;
- `WebFetch(...)` allow rules -> `webFetchAllow` verbatim; WebFetch deny/ask
  rules are dropped with a note;
- MCP allow rules (bare `mcp__*` names and `Mcp(...)`) -> `toolClasses`
  entries set to `remote-read`;
- `bashValidators` as-is; `autoMode.classifier` -> `classifier`;
  `autoMode.environment`/`allow`/`soft_deny`/`hard_deny` -> the
  `classifier*` keys.

Dropped (reported, never written): Read/Write/Edit/Grep/Glob/Ls/Find rules,
other tools' rules, `toolDefaults`, `defaultAction`, `nonInteractiveAsk`,
and the implicit-allow toggles. Rules that look like project-code runners
(cargo/dotnet build/test, pytest, npm run/install, make, ...) are copied but
listed for a manual purge. `/guard migrate dry` only previews; without a UI
it behaves like dry. On Write, each scope's patch is unioned into that
scope's file with dedupe, so re-running adds nothing and nothing is ever
removed.

### Events

- `guard:profile`: `{ profile, sandbox: { mode, workspaceMode, readRoots },
  workspaceLocked }` - emitted on session start, every profile change,
  reload, and research release. Step-3 tools subscribe to this.
- `guard:decision`: `{ toolName, class, call, action, reason }` - emitted for
  every mapped tool call, observe-only.
- `guard:research-request` / `guard:research-release` (in) and
  `guard:research-ack` (out, `{ granted, reason, profile }`): the plan.ts
  handshake; wiring lands in step 4.

## Shared sandbox library (`sandbox/`)

| Module | Purpose |
|---|---|
| `spec.ts` | `LaunchSpec` types, rlimit sets, mask and protected-name lists, env allowlist builder |
| `launcher.c` | Two-mode C launcher: overlay mounting outside bwrap, seccomp and rlimits inside it |
| `launcher.ts` | Launcher compile, cache, permission checks, sibling pruning |
| `detect.ts` | Runtime-mode detection (full / reduced / degraded) with probes |
| `scan.ts` | Per-launch mask and protected-path discovery (fd, find fallback) |
| `bwrap.ts` | Pure bubblewrap argv builder and the read-root filter |
| `audit.ts` | Pre-call snapshot, post-call audit, quarantine |
| `nuget.ts` | NuGet.Config sanitizer |
| `run.ts` | `spawnSandboxed()`: runtime dirs, spawn, cleanup |

### Runtime modes

`detectSandboxMode()` reports one of three modes; results are cached per
process (reset with `resetSandboxDetection()` for tests).

| Mode | When | Behavior |
|---|---|---|
| `full` | Linux, bwrap present, the compiled launcher works | Overlays, seccomp, rlimits through the launcher |
| `reduced` | bwrap works but the launcher is unavailable (no compiler, no libseccomp, compile or probe failure, unusable cache dir) | bwrap namespaces only: no seccomp, no overlays. Overlay requests degrade to read-only. Rlimits via `prlimit` when present. The diagnostic is reported. |
| `degraded` | not Linux, no bwrap, or the bwrap namespace probe fails | `spawnSandboxed` refuses (throws); the caller runs host execution |

Fail closed: every missing requirement reports the lower mode with an
actionable diagnostic. Nothing here ever widens what the sandbox can see.

### Filesystem layout inside the sandbox

Paths are 1:1 with host paths: the workspace, read roots, toolchains, and
cache dirs all appear at their real absolute paths. Binds are applied in this
order; later binds shadow earlier ones.

| Layer | Content |
|---|---|
| Namespaces | user (with `--disable-userns`), pid, ipc, uts, net; `--die-with-parent --new-session --cap-drop ALL` |
| System | namespace-local `/proc`, minimal `/dev`, tmpfs `/dev/shm` and `/tmp`, read-only `/usr` (merged-`/usr` symlinks or classic dirs) |
| Minimal `/etc` | `ld.so.cache`, `localtime`, `alternatives`, `ssl`, `ca-certificates`, `gitconfig` (all try-binds), plus generated `passwd` and `group` containing only the current user. Nothing else from `/etc`. |
| Home | a private empty tmpfs over the real `$HOME` (keeps `~/.ssh`, `~/.config/gh`, `~/.aws`, `~/.azure`, `~/.npmrc`, `~/.git-credentials`, `~/.docker`, pup tokens, `~/.pi/agent`, and shell rc files out), then read-only toolchain binds: `~/.rustup`, `~/.cargo/bin`, `~/.dotnet`, `~/.nvm`, `~/.local/bin`, `/home/linuxbrew` |
| Caches | `~/.cargo/registry`, `~/.cargo/git`, `~/.nuget/packages`, `~/.npm`, 1:1. In full mode with `cacheOverlays` each is a per-launch overlay (writes land in the upper layer and are discarded); otherwise read-only. |
| Credentials | `/dev/null` over `~/.cargo/credentials` and `credentials.toml` when they exist; a sanitized copy of `~/.nuget/NuGet/NuGet.Config` (credentials and apikeys sections removed) over the original |
| Read roots | granted host dirs, read-only, 1:1, filtered against reserved mountpoints and the workspace |
| Workspace | at its real path: read-write, read-only, or the launcher-mounted overlay view (full mode); in reduced mode an overlay workspace degrades to read-only |
| Protected paths | top-level entries (`.git` as a whole, `.pi`, `.claude`, `.agents`, `.vscode`, `skills`, `.envrc`, `AGENTS.md`, `CLAUDE.md`, ...) bound read-only when they exist; nested `AGENTS.md`, `CLAUDE.md`, `.envrc`, and `.git` entries from the scan; a worktree's common dir |
| Secret masks | `/dev/null` over every workspace file matching a mask pattern |

Secret masks apply to the **workspace only**, not to granted read roots:
scanning large read roots on every call would be costly. This is a documented
limitation: a credential file inside a granted read root is visible.

### Environment

`--clearenv` removes everything inherited, then only these keys are set:
`PATH` (existing toolchain bin dirs, then `/usr/local/bin:/usr/bin:/bin`),
`HOME`, `USER`, `LOGNAME`, `TMPDIR=/tmp`, `LANG=C.UTF-8`, `CARGO_HOME` and
`RUSTUP_HOME` when those dirs exist, `DOTNET_ROOT` when it exists,
`DOTNET_CLI_TELEMETRY_OPTOUT=1`, `DOTNET_NOLOGO=1`,
`DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1`, `NuGetAudit=false`, then `extraEnv`.
Reserved keys cannot be overridden and `WSL_INTEROP`, `WSLENV`, and
`SSH_AUTH_SOCK` can never be set.

**NuGet vulnerability auditing is off inside the sandbox** (`NuGetAudit=false`,
MSBuild reads environment variables as properties): offline restores would
otherwise stall on the audit fetch and emit `NU1900` warnings. Vulnerability
auditing therefore does not run for sandboxed .NET builds; use `host_bash`
(step 3) when you need it.

### Seccomp policy

The compiled launcher installs the policy inside the sandbox (default allow,
`EPERM` for): `ptrace`, `bpf`, `userfaultfd`, `perf_event_open`,
`process_vm_readv`, `process_vm_writev`, `kexec_load`, `kexec_file_load`,
`open_by_handle_at`, `name_to_handle_at`, `keyctl`, `add_key`, `request_key`.

- `socket` and `socketpair` are allowed: build tools need Unix sockets and
  loopback (MSBuild node reuse, test runners). The network namespace already
  isolates external traffic and abstract sockets.
- New user namespaces are prevented by bwrap `--disable-userns` (with
  `--unshare-user`), **not** by seccomp. `unshare -U ...` fails inside the
  sandbox.
- rlimits are set by the same launcher (`RLIMITS_PYTHON`: AS 512 MiB, FSIZE
  16 MiB, NOFILE 128, CORE 0; `RLIMITS_NODE`: AS 2 GiB plus the rest;
  `RLIMITS_SHELL`: CORE 0 only, because RLIMIT_AS breaks .NET and V8
  startup).

### Protected-path audit and quarantine

Nested read-only binds are bypassable with a parent rename
(`mv sub sub2; mkdir sub; echo evil > sub/AGENTS.md`), and protected paths
that did not exist before a call are not bound at all. The post-call audit
closes that gap:

- `snapshotProtected()` records `dev`/`ino`/type for top-level protected names
  plus nested scan results before the launch.
- `auditProtected()` rescans after the process exits and reports `created`,
  `replaced` (dev/ino changed: the parent-rename attack), and `missing`
  (moved away) entries.
- Created and replaced entries are moved into
  `<runtimeDir>/quarantine/<timestamp>/` (never deleted; cross-device falls
  back to copy-then-remove).
- `lockWrites` is true when replaced or missing entries were seen; step 2
  turns that into "workspace read-only until `/guard ack`".

### Scanner

Every launch scans the workspace once for mask matches and nested protected
entries (fd when available, `find` fallback with identical semantics; hidden
files included, ignore rules off because secrets are usually gitignored,
`node_modules`/`bin`/`obj`/`target` and `.git` contents pruned while nested
`.git` entries are still reported). A 5 s timeout or more than 500 classified
matches fails the launch with an actionable diagnostic: it never launches
unmasked.

### Kill-on-abort

The library does not truncate output or enforce timeouts; step 3 tools own
that. It makes killing possible: bwrap runs with `--die-with-parent` in its
own process group, so killing the outer launcher (or bwrap) tears the whole
process tree down, and `kill(-pid)` on the returned child's pid works too.

## Threat model

- **Same kernel.** The sandbox is namespaces plus seccomp, not a VM. A kernel
  escape escapes everything.
- **Read roots are not secret-masked** (see the limitation above).
- **Protected-path binds plus the post-call audit:** a background process
  left behind by a persistent worker (python/node, step 3) can act between
  audits; the audit runs after calls, not continuously.
- **Workspace secrets are matched only by filename patterns.** A secret stored
  under a non-matching name is not masked.
- **Project-level `nuget.config` files inside the workspace** can also carry
  credentials. Masking them would break restore, so they are left alone in
  step 1.
- **Accepted by design:** in read-write mode a sandboxed command can delete
  untracked workspace files; Unix sockets inside mounted directories are
  connectable from the sandbox.

## Tests

- `npm run test:guard`: unit (`tests/guard-sandbox-unit.test.mts`) and
  integration (`tests/guard-sandbox-integration.test.mts`) suites for the
  sandbox library, plus the policy suites: `tests/guard-policy.test.mts`
  (decision table, host shell, protected paths, local reads, config, state),
  `tests/guard-classes.test.mts` (classification, suggestions, save helper),
  `tests/guard-migrate.test.mts` (migrate fixtures and idempotence), and
  `tests/guard-harness.test.mts` (extension entry point with a fake pi API).
  The integration suite drives the real sandbox (escape attempts, protected
  paths, overlays, offline `cargo test` and `dotnet build`) and skips with an
  explicit reason when the runtime cannot reach full mode.
