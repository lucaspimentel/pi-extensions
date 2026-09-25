# Read-prompts design (python tool, step 3)

How reads of unmounted paths in the sandboxed python tool surface a permission
prompt instead of a bare `FileNotFoundError`, and how grants flow back into the
sandbox.

## Problem

The python sandbox mounts only the project (`/workspace`, read-only or
read-write per permission mode), scratch (`/scratch`), runtime dirs (`/usr`,
`/proc`, `/dev`), and the read roots granted to other tools (auto-mounted by
the step-2.5 integration). A read of anything else fails with a bare
`FileNotFoundError` and no escalation path, even though the user might happily
grant it.

## Detection (worker side)

- `sys.addaudithook` installed in `worker.py` before any user code, hooking
  only the `open`, `os.listdir`, and `os.scandir` audit events. `stat` and
  existence probes are deliberately excluded: they are the weakest signal (no
  content read) and accidental glob patterns over outside paths would trigger
  prompt storms.
- The readable allow-set is derived at worker startup from the mountpoints in
  `/proc/self/mounts` (excluding `/`). Because read roots are mounted 1:1, the
  sandbox mountpoint *is* the host path, and the derived set can never drift
  from what the kernel enforces. No protocol change is needed to carry the
  mount list.
- Relative paths resolve against the cwd; candidates that fail the literal
  prefix check get a `realpath` so symlinks pointing back into mounted
  territory do not trigger prompts.
- The hook is UX, not a security boundary: the kernel mounts remain the
  enforcement. It fails open: an error inside the hook lets the open proceed
  to the kernel's own (failing) result.
- An ungranted path raises `SandboxReadDenied` immediately (fail fast, one
  path per prompt cycle). `execute_code` reports it as a `permission_needed`
  result frame carrying the path. Interpreter state is preserved (ordinary
  exception path) and the worker stays alive.

## Prompt transport (bus round trip)

The event bus is fire-and-forget, so the round trip is correlated by id:

1. python emits `tool-permissions:prompt` `{ id, path }`.
2. pi-tool-permissions renders the dialog via its session-start-captured
   `ExtensionContext`, styled after its existing read-root escalation:
   allow reads from the covering directory (parent of the requested path) for
   **this session**, the **project** config, or the **user** config, or
   **deny**.
3. The verdict arrives as `tool-permissions:promptResult` `{ id, outcome }`;
   python resolves the pending promise keyed by `id`.
4. Timeout (~30 s), an absent listener (pi-tool-permissions not loaded), or a
   non-interactive context (`pi -p`, `!ctx.hasUI`) settles as **deny** with an
   informative diagnostic. The python extension never hangs on a missing
   verdict.

## Grant handling

- **Ordering contract**: on allow, pi-tool-permissions persists the grant
  (session `sessionReadRoots` or persisted `readAllowPaths` via its own config
  helpers) and re-broadcasts `{ mode, readRoots }` on
  `tool-permissions:mode` **before** emitting the verdict. The python side's
  step-2.5 handler therefore updates its module state and disposes the
  controller before the awaiting code resumes.
- **Replay-once**: python re-fetches the controller (fresh sandbox with the
  new read-only mount) and re-executes the stored code + timeout
  automatically. The relaunch already destroyed the old interpreter, so the
  replay runs on a fresh namespace with no double side effects; this is a
  deliberate, user-gated exception to the "code is never replayed" rule.
- The prompt/replay loop is unbounded but user-gated: replay may surface
  another ungranted path, prompting again, and every cycle requires an
  explicit grant.
- **Denial memory**: a denied covering directory is remembered python-side for
  the session; later attempts auto-deny with an informative error instead of
  re-prompting.

## Risk framing and limitations

- seccomp already blocks all sockets, so an out-of-sandbox read cannot be
  exfiltrated over the network; the worst case is secrets entering the model
  context via stdout.
- Step 2.5 auto-mounts already-granted read roots, so the prompt only fires
  for previously-ungranted paths.
- The audit hook is per-process: reads via subprocesses spawned by user code
  bypass it and simply fail with the kernel's own error.
- Mounts added by grants are always read-only; the writable `/workspace`
  surface (edits/yolo modes) is unchanged by this feature.

## Channel reference

| Channel | Direction | Payload |
| --- | --- | --- |
| `tool-permissions:prompt` | python → tool-permissions | `{ id: number, path: string }` |
| `tool-permissions:promptResult` | tool-permissions → python | `{ id: number, outcome: "allow" \| "deny" }` |
| `tool-permissions:mode` | tool-permissions → python | `{ mode, readRoots }` (re-broadcast before an allow verdict) |
