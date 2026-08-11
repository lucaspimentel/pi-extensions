# TODO

- [ ] Update `extensions/idle-summary.ts` `MODEL_CANDIDATES` to the latest models
  - Current list (lines 36–40): `anthropic/claude-haiku-4-5` → `anthropic/claude-sonnet-4-6` → `openai/gpt-5.4-mini`. The header doc comment (line 8) is already stale — it says `claude-sonnet-4-5` and `openai/gpt-4.1-mini`, neither of which match the code.
  - Proposed update (keep the cheap-fast-first priority order):
    - `anthropic/claude-haiku-4-5` — still the latest haiku (no haiku-5 in the catalog yet); $1/$5 per M, 200k ctx. Keep as primary.
    - `anthropic/claude-sonnet-5` — replaces `claude-sonnet-4-6`; cheaper ($2/$10 vs $3/$15 per M), 1M ctx, reasoning, `xhigh`/`max` thinking. Catalog: `dist/providers/data/anthropic.json`.
    - `openai/gpt-5.6-luna` — replaces `gpt-5.4-mini`; $0.2/$1.2 per M, 272k ctx, reasoning, supports `max` thinking + `supportsExplicitPromptCacheMode`. Luna is the small/cheap tier of the 5.6 family (luna < terra $2/$12 < sol $5/$30). Catalog: `dist/providers/data/openai.json`.
  - Also fix the stale header comment on line 8 to match whatever the new list becomes (it currently mentions sonnet-4-5 / gpt-4.1-mini, which never matched the code).
  - Verify each candidate id actually resolves via `getModel(provider, id)` from `@earendil-works/pi-ai` — the ids above are taken from the bundled provider catalogs (`pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/providers/data/{anthropic,openai}.json`), so they should resolve, but a quick smoke test (run pi with the extension and trigger `/summary`) confirms the `auth?.ok && auth.apiKey` branch is reached.
  - No tests exist for `idle-summary.ts` (it has no test file in `extensions/pi-tool-permissions/run-all.mjs` or elsewhere), so this is a manual smoke-test change. If a test harness is desired later, the model-selection loop would need to be extracted to a pure helper that takes `getModel` / `getApiKeyAndHeaders` as injected deps.
