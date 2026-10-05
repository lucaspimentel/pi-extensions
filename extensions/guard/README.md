# guard

Sandbox-first permission redesign. Guard replaces `pi-tool-permissions`,
`python`, and `node` with one extension built around a kernel-enforced
sandbox. See `docs/guard-design.md` for the settled design.

**Status: step 1 of the implementation outline (shared sandbox library) is
built here; guard is not loaded by pi yet** and is not in the `pi.extensions`
list. Steps 2 (policy core) and 3 (tools) build on `sandbox/`.

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
  integration (`tests/guard-sandbox-integration.test.mts`) suites. The
  integration suite drives the real sandbox (escape attempts, protected paths,
  overlays, offline `cargo test` and `dotnet build`) and skips with an explicit
  reason when the runtime cannot reach full mode.
