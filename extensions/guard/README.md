# guard

Sandbox-first permission redesign. Guard replaces `pi-tool-permissions`,
`python`, and `node` with one extension built around a kernel-enforced
sandbox. See `docs/guard-design.md` for the settled design.

**Status: steps 1 to 5 are built here. Step 3 registers guard's own tools
(`bash`, `host_bash`, `python`, `node`) and enforces decisions on them;
non-owned `write`/`edit` calls are also enforced since 2026-10-16 (block on
deny, approval dialog on prompt); every other tool call stays observe-only**
(decisions on `guard:decision`, nothing blocked or prompted), except the
grep/ffgrep secret-mask `tool_result` filter below. **Step 5 adds subagent
profile inheritance** (below). pi-tool-permissions stays loaded and
enforcing until switchover (step 6); the old standalone python/node
extensions were unregistered from the manifest on 2026-10-21 (guard's
ported copies are the only registered python/node tools). The standalone
implementations and their tests were deleted on 2026-10-28 after porting
frame-protocol coverage to `tests/guard-worker-protocol.test.mts`, which tests
the live guard implementations.

## Tools and enforcement (step 3)

`runtime.ts` owns the four tools, one execution queue, and the policy
transitions; `tools/` holds the tool implementations.

### The four tools

| Tool | Implementation |
|---|---|
| `bash` | `createBashTool()` with sandboxed `BashOperations` (`tools/shell.ts`); one bwrap process per call, no persistent shell, and **always sandboxed**: the unlocked raw profiles (yolo, unrestricted) and a host with no sandbox (degraded mode) deny a `bash` call by name and point at `host_bash` instead of silently running it on the host. A workspace lock forces the read-only sandbox back on, so a locked raw profile keeps sandboxed `bash`. |
| `host_bash` | The only sandbox escape: argv-array host exec with `HostBash(...)` rules and the tightened read-only tier. It is the shell for yolo, unrestricted, and degraded mode; in degraded mode the research profile restricts it to the read-only tier (allow rules never widen that set). |
| `python` / `node` | Ports of the old controllers (`tools/python/`, `tools/node/`) onto the shared sandbox: persistent worker, fd-3 JSON protocol, bounded output/timeouts, no code replay. Every sandboxed profile uses a worker-lifetime workspace overlay; reduced mode or a workspace lock degrades to read-only; yolo/unrestricted run the worker raw (full env and filesystem, no launcher, no rlimits). |
| `pwsh` | Not registered by guard. The standalone `pwsh` extension was removed; pi's built-in `powershell` tool is opt-in (`defaultTools`) and, when enabled, is classified as a host shell on the pwsh tier (`Pwsh(...)` rules, no read-only tier). |
| `request_read_access` | Model-callable read-access request (registered by `index.ts`, not an owned executor and never routed through the execution queue). Opens the same guard read-grant dialog the python/node workers use, for an absolute host path outside the sandbox mounts: a session grant or a persistent read root saved to the guard config. One guard-internal `decisionFor` self-check runs first (deny refuses with the cause; an allow still opens the dialog, which is the consent surface; classifier failures fail closed), the entry itself rejects relative paths, and non-interactive contexts refuse with an actionable diagnostic. It mutates guard authorization state (persistent saves write guard.json; applying a grant stops interpreter workers) and never re-runs anything: no code is executed or replayed, and the caller must re-run the read itself after a grant. |

Registration details:

- The old standalone python/node extensions are no longer registered in
  `pi.extensions` (dropped 2026-10-21); guard's copies are the only
  registered python/node tools. In degraded mode guard still registers python/node (they report
  unavailability rather than falling back to the legacy extensions), so the
  old sandboxes' writable `.git`/`.pi` mounts never come back.
- A sandbox launch or scan failure never falls back to host execution; the
  tool result fails closed with the diagnostic and a `host_bash` hint.
- **Fixed identities:** `toolClasses` cannot reclassify the four executors
  (`isOwnedExecutor`); overrides for them are ignored. Every other tool keeps
  the step-2 classification and observe-only behavior.
- Tool results add failure hints (network unreachable, EROFS on a protected
  or read-only path, missing mount) pointing at `host_bash`. When the failed
  command is detected as network- or credential-dependent (`gh`, `curl`,
  `git push/fetch`, package installs; advisory first-token match, fail open),
  the hint names the command and directs the model to re-run it with
  `host_bash` instead of retrying in the sandbox. When the failed command
  mentions path arguments that are not visible in the effective bwrap mounts
  (advisory token scan over the parsed mount table, fail open), the hint
  names them as not visible in this sandbox and directs the model to
  `host_bash` or the `read` tool ("do not retry with bash") while still
  hedging causation ("Other causes are possible"): a mention never blocks
  execution, opens a dialog, or claims to be the cause. The `bash` and
  `host_bash` descriptions state the same routing rules up front, including
  the filesystem boundary, the real workspace and session scratch paths, and
  the private sandbox `/tmp`; the two shells carry distinct tool-list
  snippets and share two routing guidelines. The bash failure hint points at the
  `request_read_access` tool for persistent read access: the tool opens the
  guard read-grant dialog for an absolute path (the worker `permission_needed`
  path shares the same dialog through the shared `requestReadGrant` helper),
  so the hint no longer points at manual `readRoots` editing.

### Execution queue and transitions

- The four tools serialize through one queue; permission dialogs do not hold
  it (other calls proceed; the dialog's call waits). Dialogs themselves
  serialize through the separate guard-owned dialog gate.
- Policy is revalidated after the queue wait and immediately before spawn.
- A tightening transition (research entry/exit, raw/sandbox change, effective
  root/mask/protected change, lock/ack remount) preempts active execution,
  awaits teardown, and only then publishes `guard:profile` or acknowledges.
  If a known process does not finish teardown within the deadline, guarded
  execution is blocked and `/guard ack` cannot clear it.
- Workers restart (interpreter state and workspace overlay discarded; scratch
  preserved) on research entry/exit, raw/sandbox changes, effective mount-set
  changes, and lock/ack remounts. default/auto/trusted changes preserve the
  worker when the effective launch policy is unchanged.
- Before each worker execute, guard re-scans the workspace mask/protected
  mount set and restarts the worker if it changed.

### Workspace, scratch, and audit

- Sandboxed bash and both workers share one scratch directory per session/cwd
  at its real absolute host path (no `/scratch` or `/workspace` aliases);
  it is mounted writable and persists across reset, crash, and policy-driven
  restarts. Session, cwd, `/tree` replacement, and shutdown remove it. Logs
  and quarantine are separate and never mounted writable.
- The tool descriptions are rebuilt on every request from the session's real
  workspace and scratch paths, so the boundary text names where the model can
  actually write. Granted read roots stay a category ("read roots you were
  granted") and are never enumerated, so a grant cannot change the request
  payload. The sandbox `/tmp` is a private tmpfs: the host `/tmp` is not
  visible, and a truncated bash result's `full_output_path` is a host temp
  file to read with `read` or `host_bash`.
- The pre/post protected-path audit runs around every sandboxed execution
  (bash process and worker execute/teardown). Created/replaced/missing
  protected entries are quarantined and notified without failing an otherwise
  successful result. Any violation, an incomplete audit (scan failure), or a
  failed quarantine **locks the workspace**: writable workers stop, sandboxed
  execution continues read-only, and host/raw execution is denied even in
  yolo/unrestricted until `/guard ack`.

### Dialogs and grants

- All five guard dialogs (execution approval, read grant, `/guard` profile
  picker, `/guard migrate` confirmation) serialize through **one dialog
  gate** owned by the guard factory (`extensions/guard/dialogs.ts`). Pi's TUI
  keeps at most one extension selector alive; the gate guarantees two live
  guard dialog bodies never overlap. The gate is independent of the
  execution queue: dialogs never hold it, and already-authorized executor
  work proceeds while another call awaits a dialog. The fifth dialog is the
  `/guard model` classifier picker (`index.ts`); it shares the same gate,
  spinner hiding, and `herdr:blocked` coverage as the other four.
- Cancellation: aborting the owning operation's signal removes an aborted
  queued request promptly and cancels an open selector through the SDK's
  `{ signal }` option. The gate never aborts a caller-owned controller, holds
  the UI lease until the dialog body actually settles, and rejects answers
  that arrive after cancellation. The profile picker and migrate confirmation
  additionally capture the initiating command operation's `ctx.signal` once
  (a live getter that would return `undefined` or another operation's signal
  if reread) and honour it through the final synchronous commit: cancellation
  after selection prevents profile publication and migration writes, including
  while worker teardown is still pending. Idle commands may have no owning
  signal; teardown, invalidation, and epoch advancement already begun are not
  reversed, and a completed synchronous commit is never rolled back. Expected
  cancellation is a warning notice and a normal return, not an unhandled
  rejection. Scope is guard-local: unrelated extensions
  can still open competing selectors, and in RPC mode the remote client
  decides whether a cancelled dialog's display closes.
- Invalidation: policy transitions, audit workspace locking, session/tree/cwd
  replacement, and shutdown cancel queued and open dialogs synchronously and
  fail closed. Fresh requests are accepted after the new runtime or policy
  exists; old requests are never retried or replayed. The gate lease covers
  only validation plus the selector interaction, so a successful save, grant,
  or profile choice cannot cancel itself.
- While an admitted dialog awaits input in TUI mode, guard hides the working
  spinner for the **entire interaction** (every stage: selector, editor,
  preview, picker, steering input) and restores it when the dialog settles
  (presentation only: visibility failures are ignored and never change the
  outcome). The same interval emits `herdr:blocked` (see Events). Queued
  requests do not affect spinner visibility.
- In TUI mode each dialog renders as a **hideable overlay**
  (`extensions/guard/ask-overlay.ts`): full-width, anchored to the bottom,
  with a ctrl+] hide/show toggle registered on raw terminal input
  (press-only, active while the overlay is focused or hidden, consumed so
  pi's editor binding never fires, one "prompt hidden" notice). The dialog
  deliberately does not use `ctx.ui.custom`: the SDK's custom-overlay
  completion callback pops the last overlay, which under a foreign overlay
  removes the wrong one. The adapter borrows the renderer through a
  zero-height widget bridge it removes immediately, mounts through the
  public `TUI.showOverlay`, and owns the returned handle (`setHidden` for
  the toggle, `handle.hide()` for removal), so cancelling under a foreign
  overlay leaves the foreign overlay focused and mounted. Long details are
  bounded to the terminal height with page-key access to the overflow at
  any title budget (including a one-line window): PgUp/PgDn on the overlay
  path and on regular-mode hosts, `ctrl+u`/`ctrl+d` for the inline
  editor-slot presentation on a fullscreen host, whose viewport consumes
  plain pageUp/pageDown before any focused component that is not an
  overlay. A terminal too short to show the decision controls disables
  approval with a wrapped warning while keeping Esc; approval eligibility
  is recomputed from the live terminal dimensions on every input, never
  from a previous paint. The bounded title uses public API only: a twin
  selector measures the real rendered controls at each width (wrapped
  option labels and key hints included) and verifies the recomposition of
  the selector's public render
  output; SDK-private fields are never touched. Every setup failure runs
  one owned-resource cleanup and propagates the genuine error. The host's
  bridge-removal path is verified with a canary removal before the bridge
  is borrowed, which filters hosts that refuse every deletion; the bridge
  key stays in the cleanup boundary so a post-canary deletion failure is
  retried best-effort there; an entry can only remain if both deletion
  attempts fail. Hosts without the required capabilities fall back to the
  plain signal-aware selector
  before anything is mounted; failed or cancelled displays are never
  retried. Ownership is guard-local: foreign
  extensions using the unsafe `ui.custom` path are not fixed by this.
- An explicit HostBash/Pwsh **ask-rule match** offers allow once, deny once
  (with optional steering), and supported deny saves; saving cannot override
  the ask, and neither an allow save nor a session grant is offered.
- **Allow for this session** (capable TUI hosts, eligible allow plans only,
  and only when the workspace's canonical identity resolves): the same
  per-step picker, rule editor, validation, and preview as a persistent allow
  save, but the reviewed rules are installed in memory alone and the grant is
  worded as one (the preview's cancelling action reads **Cancel grant**
  instead of **Cancel save**). Nothing is
  written to the config, and the grant is bound to the granting workspace and
  its descendants: it applies there and stays dormant elsewhere in the
  session, so navigating back reactivates it. Grants survive compaction,
  tree navigation, `/guard reload`, and profile changes, are never inherited
  by subagent children, and are discarded by a fresh session or restart.
  Matching rules authorize their steps independently, including outside the
  original sequence. `/guard list` reports each record with its workspace and
  its active/dormant state (there is no revocation command; a fresh session
  is the way to clear them). Cancellation matches a persistent save: picker
  esc or an empty selection returns to the action menu, and editor/preview
  cancellation grants nothing and approves the current call once, while
  abort, staleness, or an unresolvable workspace identity fails closed.
- Approval prompts use the pi-tool-permissions prompt format: a friendly
  header ("Allow Bash?", or "Allow Bash subcommand?" for a multi-step
  breakdown), the full command (truncated at 200 characters) or the code for
  non-shell executors, a bracketed icon breakdown of each reliably parsed
  step's decision (✓ allow, ? ask/classify, ✗ deny, with a » cursor on each
  prompting step), and a trailing "Why:" line with the aggregate
  decision reason. Unavailable breakdowns are explicitly marked ("Breakdown
  unavailable: ...", plus an indented "Offending step:" line with the raw
  fragment that caused the unavailability when one is identifiable, and a
  labeled failing step when attributed) and never
  become guessed rules.
- **Persistent saves** (capable TUI hosts only; capability gaps are detected
  before the dialog and keep once actions): every save opens an editor (one
  complete rule expression per line, original shell namespace enforced;
  glob/regex/tool-wide broadening allowed with review; allow prefills are
  globs of the step or command subject and deny prefills stay anchored
  exact) and then a separate
  **Confirm/Edit/Cancel save** preview showing the final entries, the exact
  destination file, and the validated effect on the current call (for rule
  saves: each rule permits/blocks its matching command independently,
  including outside this sequence). Invalid edits preserve the submitted
  text and loop with an error. Ordinary cancellation or an empty submission
  saves nothing with the documented fallback: allow-save becomes allow-once,
  deny-save becomes deny-once (steering still offered), and a read-root save
  grants nothing. The actual reviewed patch is revalidated against re-read
  configuration at the final commit barrier; abort, staleness, and setup
  failures never grant authority. For compound commands a reliable
  breakdown opens a per-step allow picker (prompting steps preselected and
  selectable, allowed steps unselectable context; esc or confirming zero
  selections returns to the action menu) and prefills glob rules for the
  selected steps only; per-step validation requires every selected step to
  resolve allow, and a partial save opens a fresh approval dialog after the
  commit. Unreliable breakdowns keep the whole-call suggestion path. A rule
  that is not the exact rendering of its subject (a glob carrying `*` or
  `?`, a bare tool-wide rule, or a differing hand-written regex) shows a
  non-blocking neutral advisory under the editor and in the preview; it is
  dropped from the live editor when the rows do not fit, never blocks a
  save, and never appears for `webFetchAllow`, `readRoots`, or `writeRoots`.
  Every rule-save commit (allow and deny) emits one info notification
  naming the scope, destination, and rule count. Deny saves use a checkbox
  picker of the parsed steps (nothing preselected, duplicates keep distinct
  identities) and a blank manual editor when parsing is unreliable.
- **Denial steering:** after an explicit user denial (Deny once or a deny
  save, including its cancellation) guard collects an optional instruction
  and hands it to the agent via `sendUserMessage(deliverAs: "steer")`
  immediately after the ownership check. Initial selector cancellation and
  automatic policy denial skip steering; empty or cancelled input still
  denies without steering. Once handed to the SDK, existing SDK semantics
  apply: input hooks may delay dispatch beyond a later abort, and guard
  claims no post-dispatch cancellation.
- In RPC mode persistent saves and session command grants are deferred:
  once actions, session read grants, and signal-aware native steering input
  remain, and no native editor is ever invoked.
- A fallback prompt (capability-limited hosts) offers allow once or deny
  once; existing ask/deny rules are never removed.
- If policy changes while a dialog is open, the approval is stale: nothing
  runs and nothing is saved.
- Local reads outside cwd/readRoots keep the session/project/user/deny grant
  shape; persistent project/user grants open a single-path root editor and
  preview (the edited root must cover the requesting path and pass the
  existing grant/mount restrictions), session grants stay one-stage, grants
  are validated, mounted read-only, restart workers, report the state loss,
  and return **without replaying the code**. Legacy pi-tool-permissions
  grants are not mirrored during coexistence.
- Non-interactive contexts (print mode, subagent children) deny prompts;
  sandboxed work stays free.

### Subagent inheritance (step 5)

When the subagent extension dispatches a child, it asks guard for a fresh
snapshot of the effective profile over a synchronous bus handshake
(`guard:subagent-snapshot-request`/`guard:subagent-snapshot-ack`) immediately
before each spawn, and passes the profile in `PI_GUARD_INHERIT` together with
a child startup gate extension. The child's guard initializes in that profile
and cannot leave it except for research (the ladder is not a permission
ordering, so there is no ceiling to clamp to); the restriction survives
commands, the picker, the cycle shortcut, reload, and session replacement.
An explicitly present but invalid `PI_GUARD_INHERIT` blocks the child's guard
entirely (no runtime, owned executors fail closed) instead of falling back to
an ordinary default session. Dispatch is fail-closed: an absent,
uninitialized, transitioning, workspace-locked, teardown-blocked, or
mismatched parent guard refuses the spawn with a diagnostic instead of
defaulting. Only the profile is inherited; the child loads its own guard
configuration for its cwd, and a locked parent refuses dispatch rather than
transmitting its lock. Each synchronous handshake query requires exactly one
correlated acknowledgment: every additional matching acknowledgment,
including an identical duplicate, fails closed (the dispatch refuses; the
child exits nonzero before any delegated execution).

The child's guard proves contract consumption (version, nonce, profile,
restriction installed, runtime available) to the child startup gate over
`guard:child-contract-request`/`guard:child-contract-ack`; without that proof
the child exits nonzero before any delegated model or tool execution.

Limits: besides the four executors, guard enforces only `write`/`edit`, so
local reads and remote tools in the child remain observe-only during
coexistence; child cwd/config differences can change per-call permissions;
running children keep their launch snapshot (entering research does not
tighten them retroactively); environment inheritance governs supported
subagent dispatch, not arbitrary processes launched through permitted raw
host execution; and trusted extensions run with host privileges, so the
handshake is not a defense against malicious extensions.

### grep/ffgrep secret-mask filter

`filter.ts` hooks `tool_result` for `grep` and `ffgrep`: in every profile
except yolo/unrestricted, matches from files whose basename matches the mask
patterns (minus exceptions) are dropped together with their context and
grouped blocks, a `N matches in masked files omitted` line is appended, and
structured content/details are replaced or removed. Unsupported or ambiguous
output formats, and any filtering failure, **suppress the entire result**
with a fixed notice; filter errors never leak the original output. `read`
and `find` remain path-level (a direct masked-path read is denied in step 2;
a directory listing is not filtered).

## Policy (step 2)

The policy core lives in `policy/`: profiles, the decision function, tool
classification, guard.json, the save/migrate helpers, and the session state.

### Profiles and the cycle hotkey

Seven session-only profiles; every session starts at `default`, nothing is
persisted. Write/edit decisions are ENFORCED for non-owned tools (block on
deny, approval dialog on prompt); everything else except the grep/ffgrep mask
filter stays observe-only:

| | research | default | allow-edits | auto | trusted | yolo | unrestricted |
|---|---|---|---|---|---|---|---|
| Sandbox workspace (step 3) | overlay (ro unless full mode) | rw | rw | rw | rw | none | none |
| host_bash / pwsh | deny | rules, then tier, then prompt | as default | rules, then tier, then classify | rules, then tier, then allow | deny/ask rules, else allow | allow |
| write/edit (non-protected) | deny | prompt every write (in-root or not) | cwd + writeRoots, prompt outside | roots gate, then classify (out-of-root always prompts) | allow | allow | allow |
| Protected-path write/edit | deny | prompt | prompt | prompt | prompt | allow | allow |
| Local reads | as default | cwd + readRoots, prompt outside | as default | as default | as default | allow | allow |
| Secret-mask path via read/grep | deny | deny | deny | deny | deny | allow | allow |
| web_fetch outside webFetchAllow | prompt | prompt | prompt | classify | allow | allow | allow |
| Other remote reads | allow | allow | allow | allow | allow | allow | allow |
| Remote writes | deny | prompt | prompt | classify | allow | allow | allow |
| Sandboxed exec: bash | allow | allow | allow | allow | allow | deny (no sandbox) | deny (no sandbox) |
| Sandboxed exec: python/node | allow | allow | allow | allow | allow | allow (raw) | allow (raw) |
| Meta (codemode, subagent, ...) | allow | allow | allow | allow | allow | allow | allow |

- **ctrl+alt+g** cycles research -> default -> allow-edits -> auto ->
  trusted -> yolo -> research, no confirmation on entering yolo.
  `cycleShortcut` in guard.json overrides the key (read at load time).
- **allow-edits** is default plus silent in-root write/edit: its approval
  dialog (offered on in-root non-protected prompts in `default`) switches the
  session to the rung and approves the current call; switching back to
  `default` restores prompting. Children inherit the rung but cannot
  self-escalate into it. In `auto`, the classifier never rules on out-of-root
  writes: they always prompt.
- **unrestricted is never in the cycle**; it is reachable only with
  `/guard profile unrestricted`. Cycling from unrestricted goes to research.
- In `yolo` and `unrestricted` the workers run raw but `bash` does not: it is
  denied by name, so a shell command on the host is always an explicit
  `host_bash` call. A workspace lock forces the read-only sandbox back on for
  `bash` even in those profiles.

### Host-shell precedence

- **research:** absolute. HostBash/Pwsh rules are ignored; host shells deny.
  Degraded mode is the one exception: there is no sandbox at all, so
  `host_bash` runs only commands the read-only tier proves read-only, and
  allow rules never widen that set (`bash` is denied by name there).
- **default / auto / trusted:** deny rules > ask rules > the tightened
  read-only tier (host vetoes first: `env`/`printenv` as the command, any `$`
  outside single quotes, the active-construct screen (command/process
  substitution, backgrounding, grouping, heredocs, unhandled separators,
  unterminated quotes; `command` removed from the safe list), file arguments
  matching the secret-mask patterns minus exceptions) > redirect-aware allow
  rules > the profile cell. A command with a discarded structural head (a
  loop/case head removed by step projection) derives no allow authorization
  on any step and a purely structural command prompts.
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
   `destructiveHint` -> remote write; a contradictory pair fails closed:
   `destructiveHint: true` wins over `readOnlyHint: true`), looked up from
   `pi.getAllTools()` on first use and cached per session,
4. a **name heuristic** (post/send/create/update/delete/... -> remote write),
5. anything still unknown is a **remote write** (fail closed).

MCP calls in both naming styles classify the same way: built-in
`mcp__<server>__<tool>` names pass through; the `mcp` proxy classifies as
`mcp__<server>__<input.tool>` (or `mcp:<input.tool>` with no server), so
globs like `mcp__slack__*read*` match.

One built-in mapping carries a containment exemption: `session_excerpt` reads a
single file from the sessions directory (pi's `~/.pi/agent/sessions`, or
`PI_CODING_AGENT_DIR` + `/sessions` when that variable is set), which is that
tool's own data rather than workspace data, so `decideLocalRead` treats a path
inside that tree as in-root. The exemption is scoped to that tool by name:
`read` and every other local-read tool keep ordinary containment for the same
paths, and the secret-mask check still runs first. The sessions-root
computation is pure (environment plus homedir, no filesystem access), and a
test asserts it matches the extension's own resolution.

Annotations are author-provided, unverified hints. Missing hints do not
establish read-only behavior, and `destructiveHint: false` means
non-destructive, not necessarily non-writing.

Built-in recognition consults own map entries only: inherited
Object.prototype names such as `constructor` or `__proto__` are ordinary
custom tools (classification follows the normal
annotation/configuration/fallback rules; no name is reserved).

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
`maskExceptions`, `discoveryPruneNames`, `discoveryMatchCap`,
`discoveryTimeoutMs`, `webFetchAllow` (URL globs or `/regex/`), `hostBash`
(`allow`/`ask`/`deny` lists of `HostBash(...)` / `Pwsh(...)` rules),
`readRoots`, `writeRoots`, `toolClasses` (name/glob -> class),
`bashValidators`, the `classifier` pin, and the `classifierEnvironment` /
`classifierAllow` / `classifierSoftDeny` / `classifierHardDeny` lists.
Scalars are project-wins with a fallback to the built-in default;
`discoveryMatchCap` (integer 1..200000) and `discoveryTimeoutMs` ms (integer
1..600000) fall back project-valid, then user-valid, then the defaults 500 and
5000. Lists union with dedupe; `discoveryPruneNames` is additionally sorted and
drops entries that duplicate a built-in prune name, so reordering or repetition
cannot change policy keys. Invalid values are warned about and ignored; a
corrupt file is ignored with a warning and never discards the other scope.

### /guard subcommands

| Command | Behavior |
|---|---|
| `/guard` | profile picker (all seven profiles) |
| `/guard help` | usage |
| `/guard list` | profile, sandbox mode and diagnostics, workspace lock, protected paths, mask exceptions, discovery scan settings (cap, timeout, pruned basenames, collisions), webFetchAllow count, persistent host-shell rule counts, session host-shell grants (workspace, active/dormant) and the session rules in force for the current workspace, read/write roots, toolClasses count, classifier, debug state |
| `/guard reload` | reload guard.json, refresh sandbox detection, clear the annotation cache |
| `/guard profile [name]` | set a profile directly (`unrestricted` included) |
| `/guard model` / `/guard model clear` | pin the auto-mode classifier model to user config (picker over models with configured auth; `clear` resumes auto-select). A project-scope `classifier` pin in `.pi/guard.local.json` overrides the user pin and is a manual config edit |
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
- `guard:decision`: `{ toolName, class, call, action, reason, fromCodemode }` - emitted for
  every mapped tool call, observe-only. `fromCodemode` is true when the call was
  issued by another tool (a codemode script, MCP wrapper, or subagent tool:
  `parentToolCallId` set on the event, or a `<parent id>/<n>` `toolCallId`); in
  that case `reason` carries the suffix `(from codemode script)`, which also
  appears in the debug notify, block/deny reasons, the headless prompt deny,
  and approval dialog titles (including the read-grant dialog a nested
  `python`/`node` worker or `request_read_access` call opens).
- `herdr:blocked`: `{ active: true, label: "guard: awaiting user input" }`
  while a guard dialog (approval, read grant, profile picker, migrate
  confirm, including every save/picker/editor/steering stage inside one)
  awaits the user, and `{ active: false }` when it settles. Reported so the
  herdr pane shows blocked instead of "working"; ignored outside herdr.
  Emitted once per admitted interaction from the shared `admittedDialog`
  wrapper, unconditionally (no `HERDR_ENV` check), matching
  pi-tool-permissions and the herdr ask-user bridge.

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
| `host-paths.ts` | Sensitive host paths that are never mountable, alias resolution, containment helper |
| `nuget.ts` | NuGet.Config sanitizer |
| `run.ts` | `spawnSandboxed()`: runtime dirs, spawn, cleanup |

### Runtime modes

`detectSandboxMode()` reports one of three modes; results are cached per
process (reset with `resetSandboxDetection()` for tests).

| Mode | When | Behavior |
|---|---|---|
| `full` | Linux, bwrap present, the compiled launcher works | Overlays, seccomp, rlimits through the launcher |
| `reduced` | bwrap works but the launcher is unavailable (no compiler, no libseccomp, compile or probe failure, unusable cache dir) | bwrap namespaces only: no seccomp, no overlays. Overlay requests degrade to read-only. Rlimits via `prlimit` when present. The diagnostic is reported. |
| `degraded` | not Linux, no bwrap, or the bwrap namespace probe fails | `spawnSandboxed` refuses (throws). `bash` is denied by name (it is sandbox-only), python/node are unavailable, and `host_bash` is the host shell; in the research profile `host_bash` is limited to the read-only tier |

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
- rlimits are set by the same launcher (`RLIMITS_PYTHON`: AS 2 GiB, FSIZE
  16 MiB, NOFILE 128, CORE 0; `RLIMITS_NODE`: the same values;
  `RLIMITS_SHELL`: CORE 0 only, because RLIMIT_AS breaks .NET, V8, and Go
  startup: gh cannot start below ~2 GiB of address space).

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
- `lockWrites` is true when any violation is seen (created, replaced, or
  missing entries) or when the post-call scan or a quarantine move fails;
  step 3 turns that into "workspace read-only and host/raw execution denied
  until `/guard ack`". The audit compares the union of pre- and post-call
  paths, so a removed nested protected entry is detected too.

### Scanner

Every launch scans the workspace once for mask matches and nested protected
entries (fd when available, `find` fallback with identical semantics; hidden
files included, ignore rules off because secrets are usually gitignored; the
built-in prune basenames `node_modules`/`bin`/`obj`/`target` and `.git`
contents are pruned while nested `.git` entries are still reported).

Pruning matches basenames at any depth, for files and directories alike, and a
matching directory's subtree is never descended into; the workspace root itself
is exempt even when its own basename matches. Pruned entries remain mounted in
the sandbox: pruning is discovery-only, so a secret under a pruned basename is
**not** masked and stays readable inside the sandbox.

The defaults are tunable per config: `discoveryPruneNames` adds extra prune
basenames, `discoveryMatchCap` raises the 500-match cap, and
`discoveryTimeoutMs` raises the 5000 ms timeout; both scanners read the same
effective settings. A scan that exceeds the effective cap or timeout fails the
launch with an actionable diagnostic, so the defaults stay fail-closed.
Weakening values are reported once per session and listed by `/guard list`.

A workspace such as `$HOME` typically trips the default cap or timeout. The
pattern is a project-scope `guard.local.json` at the workspace root (for a
`$HOME` session that is `~/.pi/guard.local.json`), which is read only when the
session cwd is that directory, adding the big generated trees (for example
`source`, `go`, `.cargo`, `.cache`, `.nvm`) to `discoveryPruneNames`.
Credential-bearing trees (`.config`, `.local`, `.pi`, `.gnupg`) stay scanned.

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
  left behind by a persistent worker can act between audits, and can read
  newly exposed live-workspace files before the next execute refreshes the
  mounts; workspace overlays are disposable, not immutable snapshots.
- **Raw execution (yolo/unrestricted) has no namespace boundary:** detached
  descendants can escape process tracking, and a tightening transition can
  stop known processes but cannot revoke escaped ones or undo prior host
  effects.
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
  (decision table, host shell and the active-construct screen, protected
  paths, local reads, config, state), `tests/guard-classes.test.mts`
  (classification, suggestions, save helper), `tests/guard-migrate.test.mts`
  (migrate fixtures and idempotence), `tests/guard-filter.test.mts`
  (grep/ffgrep mask filter), `tests/guard-workers.test.mts` (ported
  python/node controllers on the shared sandbox, real workers),
  `tests/guard-runtime.test.mts` (queue, transitions, locks, dialogs), and
  `tests/guard-harness.test.mts` (extension entry point with a fake pi API).
  The dialog/save/explanation surfaces have their own suites
  (`tests/guard-{dialogs,ask-overlay,ask-inline,ask-components,explain,save,session-shell-rules,prompt-flow,render-call,shell-hints,subagent}.test.mts`);
  `tests/guard-session-shell-rules.test.mts` covers the memory-only session
  grant store on its own (workspace/descendant scope, symlink containment,
  dedupe, dormant reactivation), while the harness and dialog suites cover
  the approval wiring, disk isolation, and lifecycle;
  the script wires all of them, together with the read-only git/gh tool
  suites, in one run.
  The sandbox and worker integration suites drive the real sandbox (escape
  attempts, protected paths, overlays, offline `cargo test` and
  `dotnet build`) and skip with an explicit reason when the runtime cannot
  reach full mode.
