# Node.js sandboxed persistent worker: design and scope

Status: design validated by prototype on 2026-09-28. See `worker-proto.mjs` and
`harness-proto.mjs` in this directory (40/40 checks pass, including the
bubblewrap launch recipe). This doc folds the prototype findings into an
implementation plan for an `extensions/node/` extension mirroring
`extensions/python/`.

## Goal

A `node` tool with the same contract as the `python` tool: one model-callable
tool executing JavaScript snippets in a persistent interpreter (a long-lived
`vm` context) inside a bubblewrap sandbox, with state surviving across calls
within a session. Linux only, fails closed.

```
node(action?: "execute" | "reset" | "status", code?: string, timeoutSeconds?: number)
```

## What is reused from extensions/python (language-agnostic)

| Python extension piece | Reuse |
|---|---|
| `sandbox.ts` (bwrap argv, mounts, read-root filtering) | Directly, plus the node launch recipe below |
| `limits.ts` (sizes, rlimits, timeouts) | Directly |
| `protocol.ts` (line-JSON framing, frame validation, `FrameStream`) | Directly; identical frame shapes |
| `session.ts` (lifecycle, teardown, mode/read-root bus wiring, timeout kill, log streaming) | Directly; worker spawn args differ |
| pi-tool-permissions integration (writable `/workspace` in allow-edits/yolo, mounted read roots, `toolDefaults.node` implicit allow) | Same wiring; new tool name in `rules.ts` |
| Threat model and README structure | Same |

The python README's semantics sections (persistence, recovery, no replay, no
interaction) carry over almost verbatim.

## Validated worker design (from the prototype)

- **Persistence**: one `vm.createContext` for the worker's lifetime; user code
  runs via `vm.runInContext(code, context, { filename: "<node>" })`. Both the
  global object AND the global lexical environment are shared across scripts,
  so `let`/`const`/`class` and `function` declarations persist across
  executions, not just `var`. Validated.
- **Final-expression repr, no AST parser**: `vm.runInContext` returns the
  script's completion value, which for code ending in an expression statement
  IS that expression's value. This replaces python's ast-based
  `split_final_expression` entirely. Validated:
  - trailing expression -> its value; `var`/function/class declarations ->
    `undefined` (returned as `repr: null`, like python's None);
  - divergence from the node REPL (accepted, arguably better): a trailing
    `if`/block/loop also yields a completion value;
  - exceptions behave like python: not transactional, state mutated before a
    throw stays mutated, worker survives.
- **Repr**: `util.inspect(value, { depth: 2, maxArrayLength: 100,
  maxStringLength: 1024, breakLength: 80 })`, head-bounded at 8 KiB with
  `...[truncated]`.
- **Output capture**: no console patching needed. The real `console` is
  injected into the context; `console.log` writes fd 1, which the parent
  captures per-execution (same fd-level capture as worker.py). Trailing async
  output (e.g. `setTimeout(..., 25)`) arrives within the drain window.
  Validated.
- **Event loop liveness**: requests are read from fd 0 asynchronously
  (`readline` over `fs.createReadStream(null, { fd: 0 })`), so the loop stays
  live between requests and timers/microtasks scheduled by user code run.
  A synchronous infinite loop blocks the loop; the parent enforces the wall
  clock by SIGKILL, exactly like python. Validated (kill + fresh worker with
  empty state).
- **Worker survival**: `unhandledRejection` and `uncaughtException` handlers
  log to stderr and keep the worker alive; a `process` shim in the context
  makes `process.exit()` throw with an informative message instead of killing
  the worker (node cannot intercept a real `process.exit`). Validated.
- **Context globals**: an empty vm context has nothing; inject console, the
  process shim, timers (`setTimeout`/`setInterval`/`setImmediate` and clear
  counterparts), `queueMicrotask`, `structuredClone`, `Buffer`, `URL`,
  `TextEncoder`/`TextDecoder`. No `require`, no `import` (validated:
  `typeof require === 'undefined'` in the context).

## fd layout (identical to worker.py)

- fd 0: requests (parent -> worker). Worker reads it asynchronously.
- fd 1/2: user output pipes, captured by the parent per execution.
- fd 3: response channel (`fs.writeSync(3, json + "\n")`), wired via
  `spawn` with `stdio: ["pipe","pipe","pipe","pipe"]`.

**Delta vs worker.py**: the dup-fd-0-then-`/dev/null` detach does not port:
`open('/proc/self/fd/0')` fails with ENXIO when fd 0 is a child_process pipe
(it works for shell pipes). The worker reads fd 0 directly. Exposure analysis:
user code in the vm context has no path to fd 0 without a full vm escape
(below), and spawning subprocesses already requires such an escape (no
`require`/`import` inside), so subprocesses inheriting fd 0 adds nothing new.

## Sandbox launch recipe

Same skeleton as `buildBwrapArgs`, with these node-specific points (validated
by harness section D):

- **Interpreter binding differs from python**:
  - System node: `fs.realpathSync(process.execPath)` and bind the resolved
    binary's directory read-only at its host path.
  - Homebrew node (this machine): `process.execPath` is a symlink chain into
    `/home/linuxbrew/Cellar/node/<ver>/bin/node` and the binary links shared
    libraries from `/home/linuxbrew/opt/*`. Bind `/home/linuxbrew` read-only
    when the realpath is under it. `sandbox.ts`'s interpreter-binding logic
    needs this branch.
- Mount the worker file 1:1 read-only at its host path (as done for
  worker.py), plus `/usr`, merged-`/usr` symlinks, namespace-local
  `/proc`/`/dev`, private tmpfs `/tmp`, project at `/workspace`, scratch at
  `/scratch`, granted read roots.
- Worker flags: none special needed in the prototype; a real implementation
  should consider `--max-old-space-size` to back the RLIMIT_AS story and
  `--no-experimental-fetch`/`--disallow-code-generation-from-strings` are NOT
  applicable (code generation via `vm` is fine inside the sandbox; threat
  model unchanged).

## Security model (unchanged boundary, weaker in-language guardrails)

- **The vm module is convenience, not a security boundary.** Host-realm
  objects injected into the context (the real console, timer functions)
  enable full escapes: `console.log.constructor("return process")()` reaches
  the host realm. This is irrelevant to isolation because the worker process
  itself lives inside the bubblewrap sandbox; the kernel namespaces, mounts,
  and (eventually) seccomp are the boundary. Identical posture to python,
  where `eval` escapes are equally available.
- Project files readable (writable in allow-edits/yolo), other pi tools
  unaffected, shared host kernel: same threat-model bullets as python.

## Protocol deltas

- `ready` frame: `nodeVersion` field instead of `pythonVersion` (or a shared
  `runtimeVersion` field renamed in both; pick during implementation, both
  copies ship in one commit, protocol version bump not needed as there are no
  external consumers).
- `result` status: `node_error` instead of `python_error` (or keep a shared
  `runtime_error`; same decision).
- Everything else (frame shapes, validation, limits, bounded
  repr/traceback/message) identical.
- Error stacks include worker-internal frames (`Script.runInContext`,
  readline internals). The real implementation should trim stack frames below
  the user-script boundary for the model-facing traceback.

## v1 scope cuts (deliberate)

1. **Out-of-sandbox read prompts: cut.** Node has no `sys.addaudithook`
   equivalent. The candidate mapping for later is Node's permission model
   (`node --permission --allow-fs-read=<mount> ...`), catching
   `ERR_ACCESS_DENIED` (which carries the path) and feeding the existing
   prompt/replay plumbing, but the flag is still experimental in the current
   LTS lines. v1 fails closed with an informative error; kernel mounts
   enforce. Give the prompt flow its own pass once the flag stabilizes.
2. **Top-level await: cut** (matches python v1). Wrapping code in an async
   IIFE would destroy persistence (declarations become function-local), and
   `vm.SourceTextModule` runs module code in module scope, which also does
   not persist. Models can use `.then()`/IIFE patterns. Revisit only if this
   proves to hurt in practice.

## Open questions

1. **Seccomp strategy** (the one real gap vs python). worker.py loads
   system libseccomp via ctypes and blocks socket/socketpair/ptrace/... Node
   has no stdlib FFI. Options:
   a. Rely on the network namespace (blocks AF_INET/AF_INET6) plus the fact
      that we never bind-mount host Unix-domain sockets into the sandbox, so
      `socket()`/`socketpair()` can only reach sandbox-local peers. Weaker
      than python (no ptrace/bpf block), but the concrete risks those
      syscalls guard against (escaping via ptrace of bwrap, host socket
      connects) are already covered by pid-namespace isolation and mount
      policy.
   b. `bwrap --seccomp <fd>`: pre-generate the BPF program in the parent
      (requires libseccomp access from the extension; possible via a tiny
      compiled helper or once at install time) and pass the fd. Keeps the
      policy identical to python without any node-side FFI.
   c. Add an FFI dependency (koffi) to load libseccomp from the worker, as
      worker.py does. Rejected for v1: a native npm dependency in a sandbox
      worker is maintenance weight.
   Recommendation: (a) for v1 with the mount policy tightened (never mount
   host sockets, document why), (b) as the follow-up hardening step.
2. **Tool name and prompt guidelines**: `node` (subject to pi's tool-naming
   conventions); description should tell the model `JSON.stringify` output
   is manual, like python's `json.dumps` note.
3. **Memory limit shape**: RLIMIT_AS 512 MiB is per-process; node reserves
   sizeable virtual address space at startup (V8, ICU). The prototype ran
   fine unbounded; a real worker must launch with RLIMIT_AS under bwrap and
   verify node still starts (if not, use `--max-old-space-size` + a larger
   AS limit). Unverified; test during implementation.

## Implementation checklist (sketch)

1. `extensions/node/` package: `index.ts`, `session.ts`, `sandbox.ts`,
   `protocol.ts`, `limits.ts`, `worker.mjs` (worker is plain JS, not TS: it
   runs inside the sandbox on the host node binary).
   Verify: `node` tool appears with execute/reset/status; status reports
   limits and sandbox paths.
2. Port `buildBwrapArgs` launch recipe incl. brew/system interpreter binding.
   Verify: harness D-section equivalents as integration tests.
3. Port session wiring: mode/read-root events, timeout SIGKILL + relaunch,
   log streaming. Verify: unit tests mirroring `tests/python-unit.test.mts`.
4. pi-tool-permissions: add `node` to the sandboxed-tool implicit-allow
   branch and `nodeWritableWorkspace()` mapping. Verify:
   `test-rules-and-decide.mjs` cases.
5. README for `extensions/node/` (adapt python's, with the deltas above).
