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
| `/workspace` | the canonical project directory | read-only |
| `/scratch`   | a private scratch directory under the OS temp dir | writable |
| `/tmp`       | namespace-private tmpfs | writable |

Relative project writes fail (read-only mount); outputs belong under
`/scratch`. Scratch files persist across executions and resets and are deleted
when the session ends, reloads, is replaced, or navigates to another branch
(and when the project directory changes). Abrupt host termination can leave
temporary files despite best-effort cleanup.

The worker's stdout/stderr per execution are also streamed to log files under
a logs directory (kept outside the worker-writable scratch mount).

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
  and the next execution starts a fresh interpreter. Code is never replayed.
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
