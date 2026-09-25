# TODO

> See also [`extensions/pi-tool-permissions/TODO.md`](extensions/pi-tool-permissions/TODO.md) for the pi-tool-permissions extension's own task list.

- [ ] Python + pi-tool-permissions integration, step 1: make tool-permissions python-aware
  - Today the `python` tool is a generic unknown tool to pi-tool-permissions: no match field in `getMatchField` (`extensions/pi-tool-permissions/rules.ts:1719` JSON.stringifies the whole input for unknown tools, so `Python(...)` rules are near-unusable), no implicit toolDefault, so every call falls to `defaultAction` (usually "ask") despite the sandbox being more restricted than the read-only bash tier that is already auto-allowed.
  - Add an implicit `toolDefaults.python = "allow"` (all modes); explicit `toolDefaults: {"python": "ask"}` must keep winning in every mode (explicit entries beat implicit ones, see the explicit vs implicit toolDefaults split in `rules.ts` `decideWithReason`).
  - `python reset`/`python status` are pure bookkeeping (like `allowNoopCd`) and should always allow.
  - Optionally add a `python` match field (the `code` param) so users can write rules like `Python(*import socket*)`.
  - Tests: `extensions/pi-tool-permissions/test-rules-and-decide.mjs`.

- [ ] Python + pi-tool-permissions integration, step 2: wire permission modes into the sandbox
  - In allow-edits mode, mount `/workspace` read-write (currently hard-coded `--ro-bind` in `extensions/python/sandbox.ts:277`); manual/auto keep read-only or prompt.
  - Trust framing: the ro mount is the kernel-level enforcement; switching to rw trusts python like Write/Edit, which is exactly edits mode's semantics. Document in the python README threat model.
  - Cross-extension communication: pi-tool-permissions already emits custom events (`pi.events.emit("herdr:blocked", ...)` at `extensions/pi-tool-permissions/index.ts:749`); python listens for a `tool-permissions:mode` event, or share a module.
  - bwrap mounts are fixed at launch, so a mode flip takes effect on relaunch: either notify + restart sandbox (state loss) or apply on next launch.
  - Add an ask-dialog escalation option: "Switch to allow-edits and remount /workspace read-write".

- [ ] Python + pi-tool-permissions integration, step 3: permission prompts for out-of-sandbox reads
  - Install a `sys.addaudithook` in `extensions/python/worker.py` for the `open` event before user code; any absolute path outside the known mount set raises a dedicated exception, worker returns a new protocol frame `{type:"result", status:"permission_needed", path}` (see `extensions/python/protocol.ts`).
  - Parent flow (`extensions/python/session.ts` -> `index.ts`): ask dialog reusing pi-tool-permissions' read-root escalation UX and persisted `readAllowPaths`, so grants are shared with Read/bash tools. Options: allow this session / persist / deny.
  - On grant: relaunch sandbox with an extra `--ro-bind hostpath hostpath` and re-execute the code once; this deliberately breaks the "code is never replayed" invariant and must only happen via the user's explicit dialog approval. On deny: return a PermissionError-style result.
  - Cheaper v1 alternative (no replay): audit hook raises PermissionError, grant applies to the next call instead of the current one.
  - Audit hook is UX, not a security boundary: kernel mounts remain the enforcement (python README threat model). Add a design doc alongside `extensions/pi-tool-permissions/docs/permission-modes-design.md`.
