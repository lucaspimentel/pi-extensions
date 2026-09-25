# python (sandboxed persistent interpreter)

A pi extension providing one model-callable `python` tool that executes Python
snippets in a **persistent interpreter inside a bubblewrap sandbox**. State
(variables, imports, functions, classes) survives across calls within a
session. Linux only; it never falls back to running Python outside the
sandbox.

## Dependencies

- Linux with user-namespace support (bubblewrap 0.9+ tested)
- `bubblewrap`: `sudo apt install bubblewrap` (Debian/Ubuntu)
- `libseccomp2`: `sudo apt install libseccomp2` (installed by default on most distros)
- System Python 3.10+: `/usr/bin/python3` by default; override with the
  `PI_PYTHON_TOOL_INTERPRETER` environment variable (user-controlled, never
  model-controlled). Bare `python3` on PATH is deliberately not used: it may
  resolve to a non-system interpreter.
- No Python packages are installed or required: the worker uses the standard
  library only, plus system `libseccomp.so.2` via ctypes.

## Tool interface

```
python(action?: "execute" | "reset" | "status", code?: string, timeoutSeconds?: number)
```

- `execute` (default): run `code` in the existing interpreter namespace.
  `timeoutSeconds` (1-120, default 30) is the only limit the caller may vary.
- `reset`: kill the sandbox and interpreter state; scratch files are kept; the
  replacement worker starts lazily on the next execution.
- `status`: report readiness, worker generation, limits, and sandbox paths
  without starting anything.

## Filesystem layout inside the sandbox

| Sandbox path | Host | Permissions |
|---|---|---|
| `/workspace` | the canonical project directory | read-only, or **read-write** in allow-edits/yolo permission modes (see below) |
| `/scratch`   | a private scratch directory under the OS temp dir | writable |
| `/tmp`       | namespace-private tmpfs | writable |
| granted read roots | their host paths, 1:1 | read-only (see below) |

Relative project writes fail while the mount is read-only; outputs belong
under `/scratch`. Scratch files persist across executions and resets and are
deleted when the session ends, reloads, is replaced, or navigates to another
branch (and when the project directory changes). Abrupt host termination can
leave temporary files despite best-effort cleanup.

The worker's stdout/stderr per execution are also streamed to log files under
a logs directory (kept outside the worker-writable scratch mount).

## Permission modes and read roots

The `pi-tool-permissions` extension announces the session permission mode and
read roots on pi's shared event bus (channel `tool-permissions:mode`, payload
`{ mode, readRoots }`). Two things follow:

- In **allow-edits** (`edits`) and **yolo** modes, `/workspace` is mounted
**read-write**, so python code can modify project files the same way
`Write`/`Edit` can in those modes. In `manual` and `auto` modes the mount stays
read-only.
- The effective read roots (persisted `readAllowPaths`, session grants, and
scratch roots when `readAllowScratch` is on) are mounted **read-only at their
host paths, 1:1, in every mode** — the user already granted them to
`Read`/bash, so python reading them grants nothing new.

In both cases:

- Any change kills the running sandbox (interpreter state is discarded,
reported by the normal teardown path); the next execution starts a sandbox
with the new mounts, announced with a UI notification.
- Roots colliding with reserved sandbox mounts (`/tmp`, `/workspace`,
`/scratch`, `/usr`, `/proc`, `/dev`, ...) are skipped, with the reason named in
the notification. Notably the `/tmp` scratch root is never mounted: the
sandbox keeps its namespace-private tmpfs there. Roots inside the project are
skipped too (already readable under `/workspace`); a root *containing* the
project is kept (it also grants sibling directories).
- If `pi-tool-permissions` is not loaded, no events arrive and the sandbox
stays read-only with no extra mounts.
- The mode/root signal is UX, not a security boundary: a stale read-only mount
is always safe, and a writable mount only exists because the user explicitly
switched into a mode that grants unprompted edits.

## Out-of-sandbox read prompts

When python code reads a path that is not mounted into the sandbox (not
`/workspace`, `/scratch`, a granted read root, or runtime dirs), the read
fails with a `permission_needed` result instead of a bare `FileNotFoundError`,
and pi-tool-permissions offers a permission prompt: allow reads from the
covering directory for this session, for the project config, for the user
config, or deny.

- Detection: an audit hook in the worker (covering `open`, `os.listdir`,
`os.scandir`; never `stat`/existence probes) compares requested paths against
the sandbox's own mountpoints read from `/proc/self/mounts`. The hook is UX,
not a security boundary: the kernel mounts remain the enforcement, and the
allow-set is derived from those mounts so it can never drift from them.
- On **allow**: the covering directory is granted (session or persisted to
`readAllowPaths`, shared with the Read/bash tools), the sandbox relaunches
with the new read-only mount, and the code is **replayed once** automatically.
Replay runs on a fresh interpreter (the relaunch discards the old one), so
there are no double side effects; this is a deliberate exception to the
"code is never replayed" rule, gated on the user's explicit grant. Replay may
surface another ungranted path, prompting again; the loop is unbounded but
every cycle needs an explicit grant.
- On **deny**: the result reports the denied path; the covering directory is
remembered for the session and later attempts auto-deny without re-prompting.
- Without pi-tool-permissions loaded (or in non-interactive `pi -p` mode),
there is nobody to prompt: the read denies with an informative error.
- Limitation: the audit hook is per-process. Reads via *subprocesses* spawned
by user code bypass it and simply fail with the kernel's own error.

## Limits

| Limit | Default |
|---|---|
| Source code size | 64 KiB UTF-8 |
| Execution wall time | 30 s (max requestable 120 s) |
| Worker startup deadline | 10 s |
| Cleanup deadline | 5 s |
| Captured stdout + stderr | 1 MiB per execution |
| Model-facing result | pi's 50 KiB / 2,000-line ceiling |
| Final-expression repr | 8 KiB |
| Protocol frame | 128 KiB |
| Per-process virtual address space (RLIMIT_AS) | 512 MiB |
| Per-file size (RLIMIT_FSIZE) | 16 MiB |
| Open file descriptors (RLIMIT_NOFILE) | 128 |
| Core dumps | disabled |

The OS limits are per-process/per-file, applied before any user code and
inherited by subprocesses. They are **not** aggregate quotas: a process can
fork children that each get their own address space, and nothing caps total
scratch-directory size. The scratch and log directories grow until the
session disposes them.

## Semantics

- **Persistence**: namespace state survives ordinary executions and even
  ordinary Python exceptions (execution is *not transactional*: mutations
  before an error remain).
- **Results**: stdout, stderr, exceptions (bounded traceback), and the final
  expression's bounded repr are returned separately. For JSON output, print
  `json.dumps(...)` yourself.
- **Recovery**: on timeout, cancellation, output-limit overflow, worker death,
  or protocol failure, the entire sandbox is killed (including `setsid`
  descendants), captured partial output is returned, state loss is reported,
  and the next execution starts a fresh interpreter. Code is never replayed
  automatically (the one exception: the out-of-sandbox read prompt flow above,
  which replays once after an explicit grant).
- **No interaction**: `input()` meets immediate EOF (worker stdin is
  `/dev/null` during execution); no top-level await in v1.
- **Trailing output**: after a result, output pipes drain briefly so a spawned
  subprocess's trailing output stays with its own execution; output arriving
  after the drain window is discarded.

## Isolation

Implemented with bubblewrap (no Docker, no shell anywhere; everything is
spawned as argv arrays):

- New user, mount, PID, IPC, UTS, and network namespaces; nested
  user-namespace creation is disabled inside the sandbox.
- Capabilities dropped; new session; parent-death cleanup
  (`--die-with-parent` plus `PR_SET_PDEATHSIG` in the worker).
- A seccomp policy (system libseccomp) installed before any user code blocks
  `socket`, `socketpair`, `ptrace`, `bpf`, `userfaultfd`,
  `perf_event_open`, `process_vm_*`, kexec, and handle syscalls. This blocks
  external network access **and** connections to host Unix-domain sockets
  exposed through bind mounts, which a network namespace alone does not
  prevent.
- Only required runtime paths (`/usr`, merged-`/usr` links, the interpreter)
  are exposed read-only, plus the project at `/workspace`, the scratch bind at
  `/scratch`, and the worker file. `/proc` is namespace-local: the sandbox
  sees only its own processes. `/dev` is minimal; `/tmp` is a private tmpfs.
- The environment is cleared; the worker gets only `PATH`, `HOME=/scratch`,
  `TMPDIR=/tmp`, and `LANG`. Python runs with `-I -S -B -u -X utf8`.
- The host home directory, agent credentials, SSH agent, Docker socket, and
  host temporary directory are never mounted.

Startup fails closed with an actionable diagnostic when the platform,
bubblewrap, libseccomp, the interpreter, or kernel namespace support is
missing; nothing degrades to unsandboxed execution, and unrelated extensions
keep working.

## Threat model (read this)

- **Project files are readable, including secrets inside the mounted
  project.** If the sandbox can read a file, the executed code can too.
- **In allow-edits/yolo permission modes, project files are also writable.**
  The `/workspace` mount flips to read-write when the user explicitly switches
  into those modes; the mount flag itself remains kernel-enforced.
- **Other pi tools are unchanged and unrestricted.** This extension sandboxes
  only its own `python` tool; it does not sandbox pi, bash, or anything else.
- Python-language restrictions and the protocol framing are **not security
  boundaries**; the isolation comes from the kernel namespaces, seccomp, and
  the read-only mounts.
- The sandbox **shares the host kernel**; a kernel escape would compromise the
  host.
- Resource limits are **not** aggregate memory, process-count, or disk quotas.

## Testing

```
npm run test:python          # unit + integration
node --test tests/python-unit.test.mts
node --test tests/python-integration.test.mts
```

Integration tests run the real sandbox (launching dozens of bubblewrap
instances) and skip with an explicit reason on unsupported machines.
