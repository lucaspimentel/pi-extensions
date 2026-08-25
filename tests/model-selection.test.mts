// Test harness for the shared model-selection helpers used by both
// idle-summary (idle-summary-models.ts) and pi-tool-permissions (index.ts).
// Exercises the REAL exports from extensions/shared/model-selection.ts —
// each extension's own test suite (extensions/idle-summary/test-idle-summary.mjs,
// extensions/pi-tool-permissions/test-rules-and-decide.mjs) separately covers
// its own re-exports/wrappers around these functions.
//
// Run: node tests/model-selection.test.mts
import assert from "node:assert/strict";
import {
	dedupeModels,
	hasPrice,
	modelCostScore,
	modelLabel,
	pickableModels,
	rankModels,
	selectModel,
} from "../extensions/shared/model-selection.ts";

// A minimal Model<Api> stand-in — only the fields these helpers read.
function mk(provider: string, id: string, input: number | null, output: number | null): any {
	return { provider, id, cost: { input, output, cacheRead: 0, cacheWrite: 0 } };
}

const idOf = (m: any) => `${m.provider}/${m.id}`;

async function main() {
	// ── modelLabel ─────────────────────────────────────────────────────────
	assert.equal(modelLabel(mk("anthropic", "claude-haiku-4-5", 1, 5)), "anthropic/claude-haiku-4-5");

	// ── hasPrice ───────────────────────────────────────────────────────────
	assert.equal(hasPrice(mk("anthropic", "haiku", 1, 5)), true, "priced model");
	assert.equal(hasPrice(mk("x", "free", 0, 0)), true, "zero-cost is still priced");
	assert.equal(hasPrice(mk("openrouter", "glm:free", null, null)), false, "unpriced model");

	// ── modelCostScore ─────────────────────────────────────────────────────
	assert.equal(modelCostScore(mk("a", "b", 1, 5)), 6);
	assert.equal(modelCostScore(mk("a", "b", null, null)), 0, "missing rates treated as 0");

	// ── dedupeModels ───────────────────────────────────────────────────────
	const dupA = mk("anthropic", "haiku", 1, 5);
	const dupB = mk("anthropic", "haiku", 1, 5);
	assert.deepEqual(dedupeModels([dupA, dupB]).length, 1, "dedupes by provider/id");
	assert.deepEqual(dedupeModels([dupA, mk("openai", "mini", 1, 2)]).map(idOf), ["anthropic/haiku", "openai/mini"]);

	// ── rankModels ─────────────────────────────────────────────────────────
	const pool = [
		mk("openai", "gpt-4o", 5, 15),
		mk("anthropic", "haiku", 1, 5),
		mk("anthropic", "sonnet", 3, 15),
		mk("openai", "mini", 1, 2),
	];
	const ranked = rankModels(pool, "anthropic");
	assert.deepEqual(ranked.map(idOf), ["anthropic/haiku", "anthropic/sonnet", "openai/mini", "openai/gpt-4o"]);

	// Unpriced models are ignored entirely — never treated as "free" and never
	// leap to the front of the ranking (the bug fixed alongside this extraction).
	const withUnpriced = [...pool, mk("openrouter", "free-1", null, null), mk("anthropic", "free-2", null, null)];
	const rankedIgnoreUnpriced = rankModels(withUnpriced, "anthropic");
	assert.equal(rankedIgnoreUnpriced.some((m: any) => !hasPrice(m)), false, "unpriced models dropped");
	assert.equal(idOf(rankedIgnoreUnpriced[0]), "anthropic/haiku", "unpriced model does not leap to front");

	// ── selectModel ────────────────────────────────────────────────────────
	const allAuth = () => true;
	const noneAuth = () => false;
	assert.equal(idOf(selectModel(pool, "anthropic", allAuth)!), "anthropic/haiku", "prefers same provider, cheapest first");
	assert.equal(idOf(selectModel(pool, "google", allAuth)!), "openai/mini", "falls back to cheapest other provider");
	assert.equal(selectModel(pool, "anthropic", noneAuth), undefined, "no authed model -> undefined");

	// ── pickableModels ─────────────────────────────────────────────────────
	const pickable = pickableModels(pool, allAuth);
	assert.deepEqual(pickable.map(idOf), ["anthropic/haiku", "anthropic/sonnet", "openai/gpt-4o", "openai/mini"], "sorted by provider then id");
	assert.deepEqual(pickableModels(pool, (m: any) => m.provider === "openai").map(idOf), ["openai/gpt-4o", "openai/mini"], "excludes unauthed");
	assert.equal(pickableModels([dupA, dupB], allAuth).length, 1, "dedupes before filtering");

	console.log("All model-selection tests passed.");
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
