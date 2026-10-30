// Tests for the model helpers:
// - extensions/shared/model-selection.ts: modelLabel, dedupeModels,
//   pickableModels (used by guard, idle-summary, session-name-llm and
//   pi-tool-permissions pickers);
// - the cost-ranking helpers that pi-tool-permissions' classifier
//   auto-select uses (hasPrice, isVirtualModel, modelCostScore, rankModels,
//   selectModel), which live in extensions/pi-tool-permissions/rules.ts.
// The virtual-model, auth-fallback and scoped-subset cases were ported from
// the retired extensions/idle-summary/test-idle-summary.mjs; pi-tool-permissions'
// own suites have no virtual-model coverage.
//
// Run: node --test tests/model-selection.test.mts
import assert from "node:assert/strict";
import { test } from "node:test";
import { dedupeModels, modelLabel, pickableModels } from "../extensions/shared/model-selection.ts";
import {
	hasPrice,
	isVirtualModel,
	modelCostScore,
	rankModels,
	selectModel,
} from "../extensions/pi-tool-permissions/rules.ts";

// A minimal Model<Api> stand-in: only the fields these helpers read.
function mk(provider: string, id: string, input: number | null, output: number | null, api = "openai-responses"): any {
	return { provider, id, api, cost: { input, output, cacheRead: 0, cacheWrite: 0 } };
}
const mkVirtual = (provider: string, id: string) => mk(provider, id, 0, 0, "pi-virtual");

const idOf = (m: any) => (m ? `${m.provider}/${m.id}` : undefined);

const anthropicCheap = mk("anthropic", "claude-haiku-4-5", 1, 5);
const anthropicMid = mk("anthropic", "claude-sonnet-5", 2, 10);
const anthropicPricey = mk("anthropic", "claude-opus-5", 15, 75);
const openaiCheap = mk("openai", "gpt-5.6-luna", 0.2, 1.2);
const openaiMid = mk("openai", "gpt-5.6-terra", 2, 12);
const basetenCheap = mk("baseten", "zai-org/GLM-5.2", 0.1, 0.4);
const basetenPricey = mk("baseten", "zai-org/GLM-5.2-Fast", 0.5, 2);
const allModels = [anthropicCheap, anthropicMid, anthropicPricey, openaiCheap, openaiMid, basetenCheap, basetenPricey];
const virtualRouter = mkVirtual("pi", "auto");

// ── Shared helpers ───────────────────────────────────────────────────────────

test("modelLabel joins provider and id", () => {
	assert.equal(modelLabel(anthropicCheap), "anthropic/claude-haiku-4-5");
	assert.equal(modelLabel(basetenCheap), "baseten/zai-org/GLM-5.2");
});

test("dedupeModels keeps first-seen order by provider/id", () => {
	const dupA = mk("anthropic", "haiku", 1, 5);
	const dupB = mk("anthropic", "haiku", 1, 5);
	assert.equal(dedupeModels([dupA, dupB]).length, 1);
	assert.equal(dedupeModels([dupA, dupB])[0], dupA);
	assert.deepEqual(dedupeModels([dupA, mk("openai", "mini", 1, 2)]).map(idOf), ["anthropic/haiku", "openai/mini"]);
});

test("pickableModels: authed only, deduped, sorted by provider then id, virtual models offered", () => {
	assert.deepEqual(
		pickableModels(allModels, () => true).filter((m) => m.provider === "anthropic").map(idOf),
		["anthropic/claude-haiku-4-5", "anthropic/claude-opus-5", "anthropic/claude-sonnet-5"],
	);
	const all = pickableModels(allModels, () => true).map(idOf);
	assert.equal(all.length, allModels.length);
	assert.ok(all.slice(0, 3).every((x) => x!.startsWith("anthropic")) && all[3]!.startsWith("baseten") && all[5]!.startsWith("openai"));
	assert.deepEqual(pickableModels(allModels, (m) => m.provider === "openai").map(idOf), ["openai/gpt-5.6-luna", "openai/gpt-5.6-terra"]);
	assert.equal(pickableModels([anthropicMid, anthropicMid], () => true).length, 1);
	assert.equal(pickableModels([], () => true).length, 0);
	assert.ok(pickableModels([virtualRouter, ...allModels], () => true).some((m) => isVirtualModel(m)), "the picker still offers virtual models");
});

// ── pi-tool-permissions ranking helpers ──────────────────────────────────────

test("hasPrice and modelCostScore", () => {
	assert.equal(hasPrice(anthropicCheap), true);
	assert.equal(hasPrice(mk("x", "free", 0, 0)), true, "zero-cost is still priced");
	assert.equal(hasPrice(mk("openrouter", "glm:free", null, null)), false);
	assert.equal(modelCostScore(anthropicCheap), 6);
	assert.equal(modelCostScore(basetenCheap), 0.5);
	assert.equal(modelCostScore(mk("a", "b", null, null)), 0, "missing rates read as 0");
});

test("rankModels: same provider first, then ascending cost; dedupe and stable ties", () => {
	assert.deepEqual(rankModels(allModels, "anthropic").slice(0, 3).map(idOf), ["anthropic/claude-haiku-4-5", "anthropic/claude-sonnet-5", "anthropic/claude-opus-5"]);
	assert.equal(idOf(rankModels(allModels, "anthropic")[3]), "baseten/zai-org/GLM-5.2");
	assert.equal(idOf(rankModels(allModels, undefined)[0]), "baseten/zai-org/GLM-5.2", "no current provider: cheapest overall");
	assert.equal(rankModels([anthropicCheap, anthropicCheap, openaiCheap], "anthropic").length, 2);
	assert.equal(idOf(rankModels([mk("a", "x", 1, 1), mk("b", "y", 1, 1)], undefined)[0]), "a/x");
});

test("rankModels ignores unpriced models", () => {
	const ranked = rankModels([...allModels, mk("openrouter", "z-ai/glm-5.2:free", null, null), mk("anthropic", "claude-haiku-0", null, null)], "anthropic");
	assert.equal(ranked.some((m) => !hasPrice(m)), false);
	assert.equal(idOf(ranked[0]), "anthropic/claude-haiku-4-5", "an unpriced model never leaps to the front");
	assert.equal(idOf(ranked[1]), "anthropic/claude-sonnet-5");
});

test("rankModels and selectModel exclude virtual models", () => {
	const withVirtual = [virtualRouter, ...allModels];
	assert.equal(isVirtualModel(virtualRouter), true);
	assert.equal(isVirtualModel(anthropicCheap), false);
	const ranked = rankModels(withVirtual, undefined);
	assert.equal(ranked.some((m) => isVirtualModel(m)), false, "never ranked");
	assert.equal(idOf(ranked[0]), "baseten/zai-org/GLM-5.2", "virtual $0 cost does not mask the cheapest physical model");
	assert.equal(idOf(rankModels(withVirtual, "pi")[0]), "baseten/zai-org/GLM-5.2", "excluded even when its provider is current");
	assert.equal(idOf(rankModels(withVirtual, "anthropic")[0]), "anthropic/claude-haiku-4-5");
	assert.equal(rankModels([virtualRouter, mkVirtual("pi", "auto-2")], undefined).length, 0);
	assert.equal(idOf(selectModel(withVirtual, undefined, () => true)), "baseten/zai-org/GLM-5.2");
});

test("selectModel: cheapest authed, same provider preferred, auth fallback", () => {
	assert.equal(idOf(selectModel(allModels, "anthropic", () => true)), "anthropic/claude-haiku-4-5");
	assert.equal(idOf(selectModel(allModels, "openai", () => true)), "openai/gpt-5.6-luna");
	assert.equal(idOf(selectModel(allModels, undefined, () => true)), "baseten/zai-org/GLM-5.2");
	const onlyOpenai = (m: any) => m.provider === "openai";
	assert.equal(idOf(selectModel(allModels, "anthropic", onlyOpenai)), "openai/gpt-5.6-luna");
	assert.equal(idOf(selectModel(allModels, "baseten", onlyOpenai)), "openai/gpt-5.6-luna");
	assert.equal(idOf(selectModel(allModels, "anthropic", (m: any) => m.id === "claude-sonnet-5")), "anthropic/claude-sonnet-5");
	assert.equal(idOf(selectModel(allModels, "anthropic", (m: any) => m.id === "claude-opus-5")), "anthropic/claude-opus-5", "same provider beats a cheaper other provider");
	assert.equal(idOf(selectModel(allModels, "anthropic", (m: any) => m.id === "zai-org/GLM-5.2")), "baseten/zai-org/GLM-5.2");
	assert.equal(selectModel(allModels, "anthropic", () => false), undefined);
	assert.equal(selectModel([], "anthropic", () => true), undefined);
});

test("selectModel over a scoped subset", () => {
	const scoped = [anthropicMid, anthropicPricey, openaiMid];
	assert.equal(idOf(selectModel(scoped, "anthropic", () => true)), "anthropic/claude-sonnet-5");
	assert.equal(idOf(selectModel(scoped, "openai", () => true)), "openai/gpt-5.6-terra");
	assert.equal(idOf(selectModel(scoped, "baseten", () => true)), "anthropic/claude-sonnet-5", "provider not in scope: cheapest scoped overall");
});
