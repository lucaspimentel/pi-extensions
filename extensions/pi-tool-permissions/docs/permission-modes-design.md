# Permission modes design

Status: implemented. This document supersedes the toggle-based design in
`docs/auto-mode-design.md` (kept for historical context on the classifier
layer, which is unchanged).

## Problem

The extension grew two independent, session-only booleans:

- `allowAllEdits`: short-circuits any `ask` for write/edit tools *after*
  `decide()` returns, inside the `tool_call` handler.
- `autoModeEnabled`: makes `decide()` return an `"auto"` sentinel for
  fallthroughs so the handler can screen them with the LLM classifier.

Two booleans that both change the same decision pipeline do not compose
cleanly: their interaction lives in ad-hoc handler code, the precedence story
is implicit, and every future idea (e.g. a planned "yolo" toggle) would add
another independent boolean with its own pairwise interactions.

## Solution

Replace the toggles (and the planned yolo toggle) with a single session-only
**mode enum**:

```ts
export type PermissionMode = "manual" | "edits" | "auto" | "yolo";
```

- Starts at `"manual"` every session. Never persisted, never written to any
  config file.
- No config-schema changes. `defaultAction` semantics are untouched.
- The mode is threaded through `decide()` / `decideCompound()` as a parameter,
  so the whole precedence chain is visible in one pure function instead of
  being split between `rules.ts` and handler code.

## Precedence

```
deny  >  ask rules  >  allow rules  >  explicit toolDefaults  >  <mode strategy for everything else>
```

The static layers (deny/ask/allow rules, read-only-bash / no-op-cd /
pure-var-assign short-circuits) behave identically in every mode. The only
mode-dependent part is the strategy for the non-explicit remainder. The
read-only-bash short-circuit is skipped when
`mode === "auto" && cfg.autoMode.classifyAllShell` (unchanged from the old
`autoActive` behavior).

### Mode strategies

| Mode    | Unknown fallthrough                          | Write/Edit (implicit guard)                                     |
| ------- | -------------------------------------------- | --------------------------------------------------------------- |
| `manual` | `defaultAction`                              | ask (current behavior)                                          |
| `edits`  | `defaultAction`                              | allow                                                           |
| `auto`   | classifier, `no_match` → `defaultAction`     | classifier (soft_deny → prompt; no model → stub ask, as before) |
| `yolo`   | allow                                        | allow                                                           |

Mechanics inside `decide()`, after the allow-rule check:

1. **Explicit `toolDefaults`** (`cfg.explicitToolDefaults`, newly exposed by
   `ResolvedConfig`) are looked up and returned directly in every mode,
   including `yolo`.
2. `mode === "yolo"` returns `"allow"` for everything else.
3. An **implicit toolDefault** (`cfg.implicit.toolDefaults`, currently only
   the injected `write → "ask"` guard):
   - in `auto` mode returns the `"auto"` sentinel (the classifier screens
     writes);
   - in `edits` mode returns `"allow"` for write/edit tools, otherwise the
     implicit action (`"ask"`), which preserves `manual` behavior exactly;
   - otherwise (manual) returns the implicit action.
4. `mode === "auto"` fallthrough returns the `"auto"` sentinel.
5. Everything else returns `cfg.defaultAction`.

Note the semantic change in `auto`: the implicit `write → ask` guard is
demoted *below* the classifier (it is implicit, not explicit). In auto mode,
write/edit calls therefore fall through to the classifier. The default allow
list already contains "Editing files in a source-controlled repository
(changes are reversible via git)", so repo edits silently allow and
out-of-repo writes soft-deny to a prompt. Explicit `toolDefaults.write` set
by the user still wins over the classifier.

## Invariants (all modes)

- Explicit `deny` rules win before anything else, including the classifier
  and `yolo`.
- Explicit `ask` rules always prompt; no mode can auto-approve a matching
  action.
- Explicit `toolDefaults` always win and are never screened by the classifier.
- The classifier's `hard_deny > soft_deny > allow` verdict ordering is
  unchanged (`verdictToAction` untouched).
- `yolo` never returns the `"auto"` sentinel: no classifier call ever happens
  in `yolo` mode.
- Compound handling is unchanged: a compound containing a static `ask` sub
  uses the per-sub prompt loop; compounds with no `ask` subs are classified
  as a whole in `auto` mode (`shouldClassifyWholeCompound` untouched).
- Session-only state: every session starts at `manual`; nothing is persisted.

## UI

| Surface | Change |
| ------- | ------ |
| **Ctrl+Alt+M** | Cycles `manual → edits → auto → yolo → manual` (replaces `ctrl+alt+e` and `ctrl+alt+a`) |
| `/permissions mode` | Bare shows the current mode; `/permissions mode <name>` sets it (usage warning for invalid values) |
| `/permissions auto` | Bare form is now an alias for `mode auto`; `auto model` / `auto debug` subcommands unchanged |
| `/permissions allowalledits` | Deprecated alias for `mode edits` (prints a note) |
| Footer | Single status key: `✏️ edits`, `🤖 auto: <model-id>` (or `🤖 auto (no classifier)`), `💀 yolo`; blank for manual |
| Write/Edit dialogs | "Switch to edits mode (this session)" replaces "Allow all edits this session" |
| All dialogs | Keep "Switch to auto mode", gain "Switch to yolo mode"; "Allow once" remains the default selection |
| `/permissions list` | Single `mode (this session): <mode>` line |

## Accepted sharp edges

- **The permissiveness ladder is approximate.** Ordering the modes
  `manual < edits < auto < yolo` is intuitive but not strict: the classifier's
  `hard_deny` verdicts can make `auto` *stricter* than `edits` for a specific
  action (e.g. an out-of-repo write prompts in `auto` but is silently allowed
  in `edits`).
- **`yolo` silently allows redirect fallthroughs.** A command like
  `rg x > out.txt` under a `Bash(rg *)` allow rule is not covered by that rule
  (the redirect-aware allow filter requires a `>`-containing pattern), so it
  would normally prompt. In `yolo` mode the fallthrough returns `"allow"` —
  the file write happens with no confirmation.
- **`yolo` silently allows unmatched MCP tools.** Unknown MCP tools have no
  static rule and no `toolDefaults` entry, so the fallthrough allows them.
- **`auto` without a classifier model stubs writes to `ask`.** Because the
  implicit write guard sits below the classifier in `auto` mode, a session
  with no classifier model available screens writes as `ask` (safe stub) —
  the same fallback the classifier layer has always used for `no_match`
  verdicts without a model.
