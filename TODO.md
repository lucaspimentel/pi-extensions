# TODO

> See also [`extensions/pi-tool-permissions/TODO.md`](extensions/pi-tool-permissions/TODO.md) for the pi-tool-permissions extension's own task list.

- [x] Python + pi-tool-permissions integration, step 1: make tool-permissions python-aware (2026-09-25)
  - Done: implicit allow for the sandboxed python tool in every mode, implemented as a dedicated branch in `decideWithReason` (after explicit `toolDefaults`, before the mode strategy) so it is never demoted below the auto-mode classifier. `python reset`/`status` always allow (bookkeeping, like `allowNoopCd`); explicit `toolDefaults.python` still wins for `execute` in every mode; explicit bare `Python` deny/ask rules keep normal precedence. Per design, `Python(x)` pattern rules are NOT supported (patterns would match the raw JSON of the input).
  - `/permissions list` shows `python: implicit allow (sandboxed; override with toolDefaults.python)` or the explicit override value.
  - Documented in the `index.ts` header block and README; 28 new tests in `test-rules-and-decide.mjs`.

- [x] Python + pi-tool-permissions integration, step 2: wire permission modes into the sandbox (2026-09-25)
  - Done: allow-edits and yolo modes mount `/workspace` read-write; manual and auto keep it read-only (auto-mode behavior deliberately deferred). pi-tool-permissions broadcasts the mode on pi's shared event bus (channel `tool-permissions:mode`, payload `{ mode }`) from `applyMode` and on `session_start`; the python extension subscribes at init, maps `edits`/`yolo` to a `writableWorkspace` launch-spec flag (`--bind` instead of `--ro-bind`), and on a flip mid-session disposes the running sandbox eagerly (state loss via the normal teardown path) with a UI notification. If pi-tool-permissions is not loaded, the sandbox stays read-only.
  - The mapping lives in `pythonWritableWorkspace()` in pi-tool-permissions `rules.ts`; python duplicates the two-line mapping (not imported) to keep the extensions decoupled.
  - Trust framing documented in the python README (new "Permission modes" section + threat-model bullet) and the pi-tool-permissions README ("Effect on the python tool"); the python tool's description/prompt guidelines now state the mount is read-only except in allow-edits/yolo.
  - The ask-dialog escalation option ("Switch to allow-edits and remount /workspace read-write") was deliberately deferred.
  - Tests: `buildBwrapArgs` mount-flag unit tests + mode-event wiring tests in `tests/python-unit.test.mts`; `pythonWritableWorkspace` cases in `test-rules-and-decide.mjs`.

- [x] Python + pi-tool-permissions integration, step 2.5: auto-mount existing read roots into the sandbox (2026-09-25)
  - Done: the effective read roots (persisted `readAllowPaths` + session grants + scratch roots when `readAllowScratch` is on, i.e. `sessionCfg().readRoots`) are mounted read-only into the python sandbox 1:1 at their host paths, in every mode. Transport: the `tool-permissions:mode` event payload was extended to `{ mode, readRoots }` (one event = full state = one relaunch decision, no debounce needed); emitted from `applyMode`, `session_start`, every read-root grant point (session scratch, session root, persisted project/user grants), and `reload()` when a ctx is available.
  - Collision policy: roots at/under reserved sandbox mounts (`/tmp`, `/workspace`, `/scratch`, `/usr`, `/bin`, `/lib`, `/lib64`, `/sbin`, `/proc`, `/dev`, `/worker.py`) are skipped with a notification; notably `/tmp` never shadows the namespace-private tmpfs. Roots inside the project are skipped (covered by `/workspace`); a root *containing* the project is kept (it grants sibling dirs). Nested roots dedupe to the shallowest. Non-absolute paths and `"/"` are rejected.
  - Filtering lives in `filterMountableReadRoots()` in `extensions/python/sandbox.ts` (exported, unit-tested); `buildBwrapArgs` mounts the pre-filtered roots with `--ro-bind-try` so a vanished root degrades to a missing mount instead of failing startup. `WorkerLaunchSpec.readRoots`, `ControllerOptions.readRoots`, and `StatusReport.readRoots` were added; `renderStatus` and the tool description/prompt guidelines list the mounted roots.
  - Relaunch: eager dispose + single notify on any mode/roots change (reuse of the step-2 pattern); identical events are no-ops.
  - Tests: filter/bind/controller/event cases in `tests/python-unit.test.mts`. Step 3 (audit-hook prompts) now only needs to cover previously-ungranted paths.

- [ ] Python + pi-tool-permissions integration, step 3: permission prompts for out-of-sandbox reads
  - Install a `sys.addaudithook` in `extensions/python/worker.py` for the `open` event before user code; any absolute path outside the known mount set raises a dedicated exception, worker returns a new protocol frame `{type:"result", status:"permission_needed", path}` (see `extensions/python/protocol.ts`).
  - Parent flow (`extensions/python/session.ts` -> `index.ts`): ask dialog reusing pi-tool-permissions' read-root escalation UX and persisted `readAllowPaths`, so grants are shared with Read/bash tools. Options: allow this session / persist / deny.
  - On grant: relaunch sandbox with an extra `--ro-bind hostpath hostpath` and re-execute the code once; this deliberately breaks the "code is never replayed" invariant and must only happen via the user's explicit dialog approval. On deny: return a PermissionError-style result.
  - Cheaper v1 alternative (no replay): audit hook raises PermissionError, grant applies to the next call instead of the current one.
  - Audit hook is UX, not a security boundary: kernel mounts remain the enforcement (python README threat model). Add a design doc alongside `extensions/pi-tool-permissions/docs/permission-modes-design.md`.
  - Risk framing: seccomp already blocks all sockets, so an out-of-sandbox read cannot be exfiltrated over the network; the worst case is secrets entering the model context via stdout. Step 2.5 (auto-mounting already-granted read roots) shrinks the set of paths that need this prompt flow to previously-ungranted paths only.
  - Both this and step 2.5 trigger sandbox relaunches: debounce disposal so simultaneous grant/mode changes restart the sandbox once.
