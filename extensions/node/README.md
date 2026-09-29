# node (sandboxed persistent interpreter)

A pi extension providing one model-callable `node` tool that executes JavaScript
snippets in a **persistent vm context inside a bubblewrap sandbox**. State
(variables, functions, classes, including `let`/`const` declarations) survives
across calls within a session. Linux only; it never falls back to running
JavaScript outside the sandbox.

It mirrors the `python` extension (`../python/`); this README documents the
shared mechanics briefly and the node-specific deltas in full.

## Dependencies

- Linux with user-namespace support (bubblewrap 0.9+ tested)
- `bubblewrap`: `sudo apt install bubblewrap` (Debian/Ubuntu)
- `prlimit` (util-linux): applies the worker's rlimits; installed by default
  on most distros. The node worker cannot set its own rlimits (node has no
  setrlimit API), so the sandbox launches it through `/usr/bin/prlimit`.
- Node.js 20+: the running pi binary itself by default (symlink-resolved);
  override with the `PI_NODE_TOOL_INTERPRETER` environment variable
  (user-controlled, never model-controlled). Homebrew installs are supported:
  the extension binds `/home/linuxbrew` read-only (the binary lives in
  `Cellar/` behind a symlink chain and links libraries from
  `/home/linuxbrew/opt/*`).
- No npm packages are installed or required: the worker uses node builtins
  only.

## Tool interface

```
node(action?: "execute" | "reset" | "status", code?: string, timeoutSeconds?: number)
```

- `execute` (default): run `code` in the existing vm context.
  `timeoutSeconds` (1-120, default 30) is the only limit the caller may vary.
- `reset`: kill the sandbox and context state; scratch files are kept; the
  replacement worker starts lazily on the next execution.
- `status`: report readiness, worker generation, limits, and sandbox paths
  without starting anything.

## What user code can reach

An empty vm context has no globals; the worker injects:

- `console` (output is captured by the parent), `Buffer`, `URL`,
  `TextEncoder`/`TextDecoder`, `structuredClone`, `queueMicrotask`, and the
  timer functions.
- A `process` shim: `platform`, `arch`, `version`, empty `env`, `cwd()`.
  `process.exit()` throws with an informative message; node cannot intercept
  a real `process.exit`, so the shim is the only way to keep the worker alive.
- `require`, built on `createRequire("/workspace/")`: node builtins (`fs`,
  `path`, `crypto`, ...) load directly, project files load by path or via the
  project's `node_modules`. The sandbox mounts remain the read boundary:
  requires outside the mounts fail with the kernel's own error.

Not available: dynamic `import()` (vm scripts have no
`importModuleDynamically` callback), top-level await (wrapping in an async
function would destroy persistence), and any path to the worker's own
protocol channel.

## Filesystem layout inside the sandbox

| Sandbox path | Host | Permissions |
|---|---|---|
| `/workspace` | the canonical project directory | read-only, or **read-write** in allow-edits/yolo permission modes |
| `/scratch`   | a private scratch directory under the OS temp dir | writable |
| `/tmp`       | namespace-private tmpfs | writable |
| granted read roots | their host paths, 1:1 | read-only |

Relative project writes fail while the mount is read-only; outputs belong
under `/scratch`. Scratch files persist across executions and resets and are
deleted when the session ends, reloads, is replaced, or navigates to another
branch. The worker's stdout/stderr per execution are also streamed to log
files under a logs directory (kept outside the worker-writable scratch
mount).

## Permission modes and read roots

Identical to the python tool: pi-tool-permissions announces the session mode
and read roots on the shared event bus (`tool-permissions:mode`, payload
`{ mode, readRoots }`). In allow-edits/yolo modes `/workspace` is mounted
read-write; the effective read roots are mounted read-only 1:1 in every mode.
Any change kills the running sandbox (state loss) and the next execution
starts a fresh one, announced with a UI notification. If pi-tool-permissions
is not loaded, the sandbox stays read-only with no extra mounts. The mode
signal is UX, not a security boundary.

## Limits

| Limit | Default |
|---|---|
| Source code size | 64 KiB UTF-8 |
| Execution wall time | 30 s (max requestable 120 s) |
| Worker startup deadline | 10 s |
| Cleanup deadline | 5 s |
| Captured stdout + stderr | 1 MiB per execution |
| Model-facing result | pi's 50 KiB / 2,000-line ceiling |
| Final-expression inspect | 8 KiB |
| Protocol frame | 128 KiB |
| Per-process virtual address space (RLIMIT_AS, via prlimit) | 2 GiB |
| V8 old-space heap (`--max-old-space-size`) | 512 MiB |
| Per-file size (RLIMIT_FSIZE) | 16 MiB |
| Open file descriptors (RLIMIT_NOFILE) | 128 |
| Core dumps | disabled |

RLIMIT_AS is 2 GiB (not python's 512 MiB) because node cannot start under a
smaller address space: the V8 CodeRange reservation fails at startup below
roughly 2 GiB (measured on node 26). The effective JS heap ceiling is the
512 MiB old-space cap; RLIMIT_AS backstops native allocations, Buffers, and
mmaps. Oversized Buffer allocations throw a catchable `RangeError`; extreme
heap growth crashes the worker (state loss), like python's hard-exhaustion
path. As in python, these are per-process/per-file limits inherited by
subprocesses, not aggregate quotas.

## Semantics

- **Persistence**: both the global object and the global lexical environment
  are shared across executions, so `var`, `let`, `const`, function, and class
  declarations all persist. Ordinary exceptions keep context state
  (execution is not transactional: mutations before an error remain).
- **Results**: stdout, stderr, exceptions (bounded, worker-frame-free
  traceback), and the final expression's value (bounded `util.inspect`,
  `undefined` not shown) are returned separately. Unlike python's
  trailing-statement rule, the script's *completion value* is returned: a
  trailing `if`/block/loop yields the last evaluated expression's value, and
  declarations yield nothing. For JSON output, print `JSON.stringify(...)`
  yourself.
- **Recovery**: on timeout, cancellation, output-limit overflow, worker
  death, or protocol failure, the entire sandbox is killed, captured partial
  output is returned, state loss is reported, and the next execution starts
  a fresh worker. Code is never replayed automatically.
- **No interaction**: there is no readable stdin; no top-level await.
- **Trailing output**: after a result, output pipes drain briefly (50 ms
  quiet window, 2 s cap; longer when live sandbox processes exist). Timer
  callbacks scheduled by user code must fire within that window to be
  captured; later output is discarded.

## Isolation

Implemented with bubblewrap (no Docker, no shell anywhere; everything is
spawned as argv arrays), mirroring the python tool:

- New user, mount, PID, IPC, UTS, and network namespaces; nested
  user-namespace creation is disabled inside the sandbox.
- Capabilities dropped; new session; parent-death cleanup.
- Only required runtime paths are exposed read-only (`/usr`, merged-`/usr`
  links, the interpreter's install tree or `/home/linuxbrew`, `prlimit`), plus
  the project at `/workspace`, the scratch bind at `/scratch`, and the worker
  file. `/proc` is namespace-local. `/dev` is minimal; `/tmp` is a private
  tmpfs.
- The environment is cleared; the worker gets only `PATH`, `HOME=/scratch`,
  `TMPDIR=/tmp`, and `LANG`. `NODE_OPTIONS` never reaches the sandboxed node.

### Deltas vs the python tool

- **No seccomp policy.** worker.py loads system libseccomp via ctypes and
  blocks `socket`, `socketpair`, `ptrace`, `bpf`, and related syscalls. Node
  has no stdlib FFI, so the node worker has no equivalent. Consequences:
  - External network remains impossible (network namespace blocks
    AF_INET/AF_INET6, for the worker and any process it spawns).
  - No host Unix-domain socket is ever mounted, so host sockets are
    unreachable through the filesystem. **A socket inside the mounted
    project or read roots, however, is connectable** (pinned by an
    integration test so a future hardening step flips it deliberately).
  - `ptrace`/`bpf`-class syscalls are not blocked; the pid namespace and
    dropped capabilities remain the defense there.
  - Candidate future hardening: `bwrap --seccomp <fd>` with a BPF program
    pre-generated in the parent (no in-worker FFI needed).
- **No out-of-sandbox read prompts.** Node has no audit-hook equivalent
  (`sys.addaudithook` is python-only). Reads outside the mounts fail closed
  with the kernel's own error. Node's experimental `--permission` flag is the
  candidate for a later prompt flow.
- **Rlimits via prlimit**, not in-worker `resource.setrlimit` (node has no
  setrlimit API).

Startup fails closed with an actionable diagnostic when the platform,
bubblewrap, prlimit, the interpreter, or kernel namespace support is missing;
nothing degrades to unsandboxed execution, and unrelated extensions keep
working.

## Threat model (read this)

- **Project files are readable, including secrets inside the mounted
  project.** If the sandbox can read a file, the executed code can too (it
  has `require('fs')`).
- **In allow-edits/yolo permission modes, project files are also writable.**
- **The vm module is convenience, not a security boundary.** Host-realm
  objects injected into the context (console, timers, require) enable full
  escapes from the vm into the worker process. The isolation boundary is the
  bubblewrap sandbox around the worker, not the vm context. (The python
  worker has the same property; `eval` escapes are equally available there.)
- **A Unix-domain socket inside the mounted project or read roots is
  connectable** (no seccomp; see Deltas above). Keep listening sockets out of
  the project while untrusted code runs, or grant no read roots you do not
  trust.
- Other pi tools are unchanged and unrestricted; this extension sandboxes
  only its own `node` tool.
- The sandbox shares the host kernel; a kernel escape would compromise the
  host.
- Resource limits are not aggregate memory, process-count, or disk quotas.

## Testing

```
npm run test:node            # unit + integration
node --test tests/node-unit.test.mts
node --test tests/node-integration.test.mts
```

Integration tests run the real sandbox (launching dozens of bubblewrap
instances) and skip with an explicit reason on unsupported machines.
