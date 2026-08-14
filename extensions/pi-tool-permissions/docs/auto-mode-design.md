# Auto Permissions Mode — Design Doc

> Claude Code–style `"auto"` `defaultAction` for `pi-tool-permissions`, backed by an LLM safety classifier.

## Status

- **2026-08-11** — Updated auto-mode TODO for pi-ai 0.84 `modelRegistry` migration (commit `ee68d35`). TODO entry in `TODO.md` now points at `ctx.modelRegistry.find()` / `hasConfiguredAuth()` / `complete()` and the current `extensions/idle-summary/index.ts` template, not the removed `@earendil-works/pi-ai` main-entry `complete()`/`getModel()`.
- **2026-08-12** — Simplified auto mode from a `defaultAction: "auto"` value into a **session-toggle layer** between `toolDefaults` and `defaultAction`. `defaultAction` is back to `allow | deny | ask`; legacy `"auto"` coerces to `"ask"`. The `/permissions auto` toggle alone now engages the classifier — no on-disk `defaultAction: "auto"` requirement. `no_match` verdicts fall through to `defaultAction`; "classifier unavailable" stubs to `ask`. Removed `effectiveAction` / `sessionDefaultAction` / `resolveConfig` / `switchToAutoMode`.
- **Next** — Implement type/config spine for `"auto"` `defaultAction`, then classifier runtime.

## Goal

Add a middle-ground permission mode between Manual (prompt for everything) and `bypassPermissions` (prompt for nothing). Before each tool call that falls through the static-rule layer **and any `toolDefaults`**, a **safety classifier** (a separate, cheap/fast LLM call) screens the action:

- **Safe** → runs silently.
- **Risky** → still prompts (with the classifier's reason).

It is layered **as a precedence layer between `toolDefaults` and `defaultAction`**, not alongside them:

```
deny > ask > allow > toolDefaults > auto (if session toggle on) > defaultAction
```

- `deny` rules block *before* the classifier is consulted (neither classifier nor user intent can override).
- `ask` rules always prompt (classifier cannot auto-approve a matching action).
- `toolDefaults` (e.g. the implicit `write → ask` guard) win over the classifier — a per-tool deterministic action is never screened by the LLM.
- The classifier only decides for actions that fall through all of those — true unknowns.

Reference: Claude Code's auto mode — https://code.claude.com/docs/en/permission-modes and https://code.claude.com/docs/en/auto-mode-config.

## Non-goals

- Replacing static `deny`/`ask` rules as the load-bearing safety layer. A glob `deny` rule is deterministic; an LLM verdict is not. The classifier is a convenience layer, never the only thing stopping `rm -rf /`.
- Persisting auto-mode state. It is session-only, off by default, mirroring the existing allow-all-edits toggle.

## Architecture

Slots in as a **session-toggle layer between `toolDefaults` and `defaultAction`**, not a new system or a `defaultAction` value. pi's extension API provides every primitive needed: the `tool_call` event hook can `{ block: true, reason }`, mutate `event.input`, and `await ctx.ui.confirm/select`. The existing `pi-tool-permissions` already implements the static-rule layer (`deny`/`ask`/`allow` lists + `toolDefaults` + `defaultAction`, precedence `deny > ask > allow > toolDefaults > defaultAction`), the interactive prompt, the compound-bash splitter, persistence, and the `/permissions` slash command. Auto mode inserts one more slot: `… > toolDefaults > auto (if toggle on) > defaultAction`.

### Model access (post-0.84)

No `pi.ai` on the `ExtensionAPI`. As of pi-ai 0.84, `complete()`/`getModel()` are **not** exported from the `@earendil-works/pi-ai` main entry — they live only under the deprecated `@earendil-works/pi-ai/compat` subpath (marked `@deprecated`, slated for deletion with the ModelManager migration). The sanctioned facade is `ctx.modelRegistry` (a `ModelRegistry` instance — see `core/model-registry.d.ts`, documented "Synchronous compatibility facade exposed to extensions"), which exposes:

- `find(provider, id)` — sync, plain-string args
- `hasConfiguredAuth(model)` — sync auth gate
- `getAvailable()` — pool of configured models
- `complete(model, context)` — resolves provider auth internally, no auth threading

Template: `extensions/idle-summary/index.ts` + `idle-summary-models.ts` (note: moved out of the old `extensions/idle-summary.ts` path in commit `d1a3504`). That extension uses type-only `Api`/`Model` imports from `@earendil-works/pi-ai`, builds the pool from `ctx.scopedModels` (falling back to `ctx.modelRegistry.getAvailable()`), ranks via `selectSummaryModel` (**same provider as the currently selected model first** — cheapest-to-most-expensive within that provider — then all other providers in ascending cost order; see `rankSummaryModels` in `idle-summary-models.ts`, with `currentProvider = ctx.model?.provider`), gates with `ctx.modelRegistry.hasConfiguredAuth(model)`, and calls `await ctx.modelRegistry.complete(model, { messages })`. **Reuse that pattern — not the old `getModel`/threaded-auth form.**

## Proposed config shape

Extends `Config` / `LoadedConfig` in `index.ts` (~107–142):

```jsonc
{
  "defaultAction": "ask",
  "autoMode": {
    // Optional explicit pin. If omitted, the classifier model is selected
    // from the available pool using the same ranking as idle-summary:
    // prefer models from the currently selected model's provider (cheapest
    // first within that provider), then other providers in ascending cost.
    // In either case, restrict to a haiku-tier / fast-cheap model — never the
    // main reasoning model.
    "classifier": { "provider": "anthropic", "model": "claude-haiku-4-5" },
    "environment": [
      "Trusted repo: github.com/lucaspimentel/*",
      "Trusted domains: *.internal.example.com"
    ],
    "allow":     ["Running tests and linters"],
    "soft_deny": ["Force pushing, deleting remote branches", "Creating a pull request or pushing a branch on GitHub via gh, modifying remote state"],
    "hard_deny": ["Sending data to third-party APIs or external services for telemetry, analytics, or exfiltration (not normal GitHub dev actions like opening PRs or pushing branches via gh)"],
    "classifyAllShell": true
  }
}
```

## Decision flow

When no static rule or `toolDefaults` entry matches and the session toggle is on:

1. Run the classifier with the action + environment + NL rules.
2. Map the verdict:
   - `hard_deny` match (or classifier verdict) → **block**
   - `soft_deny` match → **prompt with reason** (reuse existing `ctx.ui.select` dialog); in non-interactive modes → **deny** (can't prompt)
   - `allow` match → **allow silently**
   - `no_match` → **fall through to `defaultAction`** (the classifier ran and had no opinion, so the user's terminal default applies — in both interactive and non-interactive modes)
3. When the toggle is on but **no classifier model is available**, the auto layer stubs to **prompt** (`ask`) rather than applying `defaultAction` — screening was requested but couldn't be performed, so prompt instead. (The non-interactive `!ctx.hasUI` branch then blocks `ask`.)

**Static precedence invariant**: `deny`/`ask`/`toolDefaults` at the top of `decide()` already win, so the classifier only sees true fallthroughs. Keep it that way — the classifier is never the first thing consulted.

**NL-list precedence**: when an action matches more than one of the `allow`/`soft_deny`/`hard_deny` lists, the more-severe verdict wins — `hard_deny > soft_deny > allow`. The classifier emits a single verdict, so precedence is enforced by the prompt instruction (not by code); this mirrors the static `deny > ask > allow` chain and removes any `allow`-overrides-`deny` escape hatch at the classifier layer.

## Session toggle

Mirrors the existing allow-all-edits one:

- `Ctrl+Alt+A` shortcut
- `/permissions auto on|off|toggle` subcommand
- `🤖 auto mode on` footer indicator via `ctx.ui.setStatus`
- **"Switch to auto mode (this session)"** option in any permission dialog (just flips the toggle — same as the hotkey, but contextual)

Auto mode is **off by default** and **never persisted** (session-only), like allow-all-edits. The toggle alone engages the classifier — there is no on-disk `defaultAction: "auto"` requirement (that value is no longer valid and is coerced to `"ask"`). Explicit `deny` rules still win even when auto mode is on.

## Caching

Cache verdicts by `hash(toolName, JSON.stringify(input), rulesetHash)` to avoid re-classifying identical calls in a loop and to bound token cost — every unmatched tool call becomes a model round-trip otherwise. Pick a fast/cheap classifier model (haiku-class), never the main reasoning model.

## UI/UX

- Surface the classifier's reason string in the block/prompt UI (Claude Code's "Blocked by classifier" message).
- Add a `/permissions auto` subcommand to view/edit the NL `environment`/`allow`/`soft_deny`/`hard_deny` lists.

## Implementation plan

The work splits into a **type/config spine** (small, mechanical, unblocks everything else) and the **classifier runtime** (the real new logic).

### Step 1 — Type/config spine (do first, no LLM yet)

Foundation; nothing else compiles cleanly without it. Independently shippable.

1. **Widen `Action`** (`index.ts` ~151): `type Action = "allow" | "deny" | "ask" | "auto"`. Audit every `switch`/comparison on `Action` — `decide()`'s tail (`return cfg.defaultAction;` at ~1135) is the main seam; the prompt loop and `decideCompound` only handle `allow`/`deny`/`ask` today, so `"auto"` must fall through to a new branch, not be treated as `ask`.
2. **Add the `autoMode` config shape** to `Config` (~154) and `LoadedConfig` (~179): `classifier`, `environment`, `allow`/`soft_deny`/`hard_deny` NL lists, `classifyAllShell`. Mirror through `loadConfig()` resolution (~315) and `cfg.implicit`/`cfg.autoMode` surfaces.
3. **Add the session toggle** mirroring `allowAllEdits`: module-level `autoModeEnabled` flag, `Ctrl+Alt+A` keybinding, `/permissions auto on|off|toggle` subcommand, `🤖 auto mode on` `ctx.ui.setStatus` footer. Off-by-default, never persisted. Lets you exercise the path even before the classifier exists (toggle on → every fallthrough becomes `ask`, since there's no classifier yet).
4. **Update `/permissions list`** (~1562) to show `autoMode` state and the NL rule lists.
5. **Docs + example json**: header block (~26–150), `README.md`, `pi-tool-permissions.example.json`.

**Deliverable**: `"auto"` is a valid `defaultAction`, the toggle works, and the `/permissions` surface shows it — but a fallthrough still just prompts because the classifier isn't wired. Clean, reviewable, shippable slice that unblocks step 2 without touching the LLM path.

### Step 2 — Classifier runtime (the real work)

6. **Classifier call seam.** Following the TODO guidance: use `ctx.modelRegistry.find()` + `hasConfiguredAuth()` + `ctx.modelRegistry.complete(model, { messages })`, pool from `ctx.scopedModels`/`getAvailable()`, template on `extensions/idle-summary/index.ts` + `idle-summary-models.ts`. **Model selection mirrors `idle-summary`'s `selectSummaryModel`/`rankSummaryModels`: if `autoMode.classifier` is explicitly set, `ctx.modelRegistry.find(provider, id)` it directly; otherwise rank the pool with `currentProvider = ctx.model?.provider` (same-provider models first, cheapest within that provider first, then other providers ascending cost) and pick the first with configured auth. In both cases restrict to a haiku-tier / fast-cheap model — never the main reasoning model.** Extract the classifier into a pure helper (`classifyAction(model, toolName, input, autoMode) → { verdict, reason }`) with `complete` injected as a seam so it's unit-testable without HTTP.
7. **Wire into `decide()`'s tail**: when `defaultAction === "auto"` (and the session toggle is on), call the classifier instead of returning `"ask"`. Map `hard_deny`→`deny`, `soft_deny`→`ask` (with reason surfaced), `allow`→`allow`, no-match→`ask`. Preserve the static precedence invariant.
8. **Non-interactive fallback**: in `ctx.mode === "print"`/`"json"`, `soft_deny` and no-match resolve to `deny`.
9. **Verdict cache** by `hash(toolName, JSON.stringify(input), rulesetHash)` to bound token cost on loops.
10. **`classifyAllShell`**: when set, route every bash subcommand (including ones that would auto-allow via `bashReadOnlyAllowCwd`) through the classifier — decide where this hooks in relative to the read-only/no-op-cd short-circuits in `decide()` (~1124–1128).

### Step 3 — Tests

11. `test-rules-and-decide.mjs`: verdict→action mapping + the **deny/ask-beat-classifier invariant** by injecting a fake `complete` (the seam from step 6). Cover `hard_deny`/`soft_deny`/`allow`/no-match, non-interactive deny fallback, and cache hits.
12. Wire any new test file into `run-all.mjs`.

### Suggested first commit

Step 1 alone — type/config spine + toggle + docs, with the classifier stubbed to "no classifier configured → behave as `ask`".

## Docs to update when implementing

- `index.ts` header block (~26–150)
- `README.md` (new `## Auto mode` section)
- `pi-tool-permissions.example.json`
- `TODO.md` (mark step checkboxes as completed)
