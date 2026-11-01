// Tests for the shared model picker helpers.
//
// Run: node --test tests/model-selection.test.mts
import assert from "node:assert/strict";
import { test } from "node:test";
import { dedupeModels, modelLabel, pickableModels } from "../extensions/shared/model-selection.ts";

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
	assert.ok(pickableModels([virtualRouter, ...allModels], () => true).some((m) => m.api === "pi-virtual"), "the picker still offers virtual models");
});
