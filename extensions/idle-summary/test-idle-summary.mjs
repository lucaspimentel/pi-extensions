// run: npx tsx test-idle-summary.mjs  (or: node --experimental-strip-types test-idle-summary.mjs)
//
// Unit tests for the pure model-selection helpers in idle-summary-models.ts.
// Imports the REAL TypeScript module via type-stripping (tsx / node 22.6+) so
// the tests exercise the actual code, not a mirror.

import {
	modelCostScore,
	dedupeModels,
	rankSummaryModels,
	selectSummaryModel,
	modelLabel,
	findConfiguredModel,
	pickableModels,
} from "./idle-summary-models.ts";

// ── Test runner ───────────────────────────────────────────────────────────

let pass = 0, fail = 0;
function test(desc, actual, expected) {
	// Primitives compare by value; arrays/objects compare by structural JSON.
	const ok =
		actual === expected ||
		JSON.stringify(actual) === JSON.stringify(expected);
	console.log((ok ? "  ✓" : "  ✗") + " " + desc);
	if (!ok) {
		console.log(`      got:      ${JSON.stringify(actual)}`);
		console.log(`      expected: ${JSON.stringify(expected)}`);
	}
	ok ? pass++ : fail++;
}
function section(name) {
	console.log(`\n── ${name} ${"─".repeat(Math.max(0, 50 - name.length))}`);
}
function summary() {
	console.log(`\n  ${pass} passed, ${fail} failed`);
	return fail;
}

// ── Fixtures ───────────────────────────────────────────────────────────────

// Minimal Model<Api>-shaped objects. Only the fields read by the helpers
// (provider, id, cost.input, cost.output) are populated.
const mk = (provider, id, input, output) => ({
	provider,
	id,
	name: id,
	api: "openai-responses",
	baseUrl: "",
	reasoning: false,
	input: ["text"],
	cost: { input, output, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8192,
});

const anthropicCheap = mk("anthropic", "claude-haiku-4-5", 1, 5);
const anthropicMid = mk("anthropic", "claude-sonnet-5", 2, 10);
const anthropicPricey = mk("anthropic", "claude-opus-5", 15, 75);
const openaiCheap = mk("openai", "gpt-5.6-luna", 0.2, 1.2);
const openaiMid = mk("openai", "gpt-5.6-terra", 2, 12);
const basetenCheap = mk("baseten", "zai-org/GLM-5.2", 0.1, 0.4);
const basetenPricey = mk("baseten", "zai-org/GLM-5.2-Fast", 0.5, 2);

const allModels = [
	anthropicCheap,
	anthropicMid,
	anthropicPricey,
	openaiCheap,
	openaiMid,
	basetenCheap,
	basetenPricey,
];

const idOf = (m) => (m ? `${m.provider}/${m.id}` : undefined);

// ── modelCostScore ─────────────────────────────────────────────────────────

section("modelCostScore");

test("sums input + output rates", modelCostScore(anthropicCheap), 6);
test("sums input + output rates (openai)", modelCostScore(openaiCheap), 1.4);
test("sums input + output rates (baseten)", modelCostScore(basetenCheap), 0.5);
test("zero-cost model scores 0", modelCostScore(mk("x", "free", 0, 0)), 0);

// ── dedupeModels ────────────────────────────────────────────────────────────

section("dedupeModels");

test("dedupes by provider/id keeping first", dedupeModels([anthropicCheap, anthropicCheap]).length, 1);
test("keeps distinct models", dedupeModels([anthropicCheap, openaiCheap]).length, 2);
test("preserves first-seen order", idOf(dedupeModels([openaiMid, openaiCheap, anthropicMid])[0]), "openai/gpt-5.6-terra");
test("same id different provider are distinct", dedupeModels([anthropicCheap, mk("openai", "claude-haiku-4-5", 1, 1)]).length, 2);
test("empty pool stays empty", dedupeModels([]).length, 0);

// ── rankSummaryModels — same-provider-first ordering ───────────────────────

section("rankSummaryModels — same provider first");

const rankedAnthropic = rankSummaryModels(allModels, "anthropic");
test("anthropic models take the first 3 slots", rankedAnthropic.slice(0, 3).every((m) => m.provider === "anthropic"), true);
test("cheapest anthropic is first", idOf(rankedAnthropic[0]), "anthropic/claude-haiku-4-5");
test("mid anthropic is second", idOf(rankedAnthropic[1]), "anthropic/claude-sonnet-5");
test("pricey anthropic is third", idOf(rankedAnthropic[2]), "anthropic/claude-opus-5");
test("after anthropic, cheapest non-anthropic is next", idOf(rankedAnthropic[3]), "baseten/zai-org/GLM-5.2");
test("then next cheapest non-anthropic", idOf(rankedAnthropic[4]), "openai/gpt-5.6-luna");

const rankedOpenai = rankSummaryModels(allModels, "openai");
test("openai models take the first 2 slots", rankedOpenai.slice(0, 2).every((m) => m.provider === "openai"), true);
test("cheapest openai is first", idOf(rankedOpenai[0]), "openai/gpt-5.6-luna");
test("mid openai is second", idOf(rankedOpenai[1]), "openai/gpt-5.6-terra");
test("after openai, cheapest non-openai is next", idOf(rankedOpenai[2]), "baseten/zai-org/GLM-5.2");

const rankedBaseten = rankSummaryModels(allModels, "baseten");
test("baseten models take the first 2 slots", rankedBaseten.slice(0, 2).every((m) => m.provider === "baseten"), true);
test("cheapest baseten is first", idOf(rankedBaseten[0]), "baseten/zai-org/GLM-5.2");

// ── rankSummaryModels — no current provider ────────────────────────────────

section("rankSummaryModels — no current provider");

const rankedNone = rankSummaryModels(allModels, undefined);
test("no provider → pure cost ascending", idOf(rankedNone[0]), "baseten/zai-org/GLM-5.2");
test("no provider → second cheapest overall", idOf(rankedNone[1]), "openai/gpt-5.6-luna");
test("no provider → third is baseten fast (2.5 < haiku 6)", idOf(rankedNone[2]), "baseten/zai-org/GLM-5.2-Fast");
test("no provider → anthropic haiku is 4th", idOf(rankedNone[3]), "anthropic/claude-haiku-4-5");
test("no provider → pricey opus is last", idOf(rankedNone[rankedNone.length - 1]), "anthropic/claude-opus-5");

// ── rankSummaryModels — dedupe + stability ─────────────────────────────────

section("rankSummaryModels — dedupe + stability");

test("dedupes before ranking", rankSummaryModels([anthropicCheap, anthropicCheap, openaiCheap], "anthropic").length, 2);
test("stable tie order: equal costs keep insertion order",
	idOf(rankSummaryModels([mk("a", "x", 1, 1), mk("b", "y", 1, 1)], undefined)[0]), "a/x");

// ── selectSummaryModel — auth gating ──────────────────────────────────────

section("selectSummaryModel — picks cheapest same-provider with auth");

test("anthropic current, all authed → cheapest anthropic",
	idOf(selectSummaryModel(allModels, "anthropic", () => true)), "anthropic/claude-haiku-4-5");
test("openai current, all authed → cheapest openai",
	idOf(selectSummaryModel(allModels, "openai", () => true)), "openai/gpt-5.6-luna");
test("baseten current, all authed → cheapest baseten",
	idOf(selectSummaryModel(allModels, "baseten", () => true)), "baseten/zai-org/GLM-5.2");
test("no current provider, all authed → cheapest overall",
	idOf(selectSummaryModel(allModels, undefined, () => true)), "baseten/zai-org/GLM-5.2");

// ── selectSummaryModel — auth fallback ─────────────────────────────────────

section("selectSummaryModel — falls back when same-provider lacks auth");

const onlyOpenaiAuthed = (m) => m.provider === "openai";
test("anthropic current but only openai authed → cheapest openai",
	idOf(selectSummaryModel(allModels, "anthropic", onlyOpenaiAuthed)), "openai/gpt-5.6-luna");
test("baseten current but only openai authed → cheapest openai",
	idOf(selectSummaryModel(allModels, "baseten", onlyOpenaiAuthed)), "openai/gpt-5.6-luna");

const onlyMidAnthropicAuthed = (m) => m.provider === "anthropic" && m.id === "claude-sonnet-5";
test("anthropic current, only mid anthropic authed → mid anthropic (cheapest authed same provider)",
	idOf(selectSummaryModel(allModels, "anthropic", onlyMidAnthropicAuthed)), "anthropic/claude-sonnet-5");

const onlyPriceyAnthropicAuthed = (m) => m.provider === "anthropic" && m.id === "claude-opus-5";
test("anthropic current, only opus authed → opus (still same provider preferred over cheaper non-anthropic)",
	idOf(selectSummaryModel(allModels, "anthropic", onlyPriceyAnthropicAuthed)), "anthropic/claude-opus-5");

const onlyBasetenCheapAuthed = (m) => m.provider === "baseten" && m.id === "zai-org/GLM-5.2";
test("anthropic current, only baseten cheap authed → baseten cheap (no same-provider option)",
	idOf(selectSummaryModel(allModels, "anthropic", onlyBasetenCheapAuthed)), "baseten/zai-org/GLM-5.2");

// ── selectSummaryModel — no auth at all ────────────────────────────────────

section("selectSummaryModel — no auth");

test("nothing authed → undefined", selectSummaryModel(allModels, "anthropic", () => false), undefined);
test("empty pool → undefined", selectSummaryModel([], "anthropic", () => true), undefined);

// ── selectSummaryModel — scoped subset ────────────────────────────────────

section("selectSummaryModel — scoped subset");

const scoped = [anthropicMid, anthropicPricey, openaiMid];
test("scoped: anthropic current → cheapest scoped anthropic (mid, not haiku)",
	idOf(selectSummaryModel(scoped, "anthropic", () => true)), "anthropic/claude-sonnet-5");
test("scoped: openai current → only scoped openai (terra)",
	idOf(selectSummaryModel(scoped, "openai", () => true)), "openai/gpt-5.6-terra");
test("scoped: baseten current (not in scope) → cheapest scoped overall",
	idOf(selectSummaryModel(scoped, "baseten", () => true)), "anthropic/claude-sonnet-5");

// ── modelLabel ────────────────────────────────────────────────

section("modelLabel");

test("joins provider and id with /", modelLabel(anthropicMid), "anthropic/claude-sonnet-5");
test("joins provider and id with / (openai)", modelLabel(openaiCheap), "openai/gpt-5.6-luna");

// ── findConfiguredModel — provider/modelId override ────────────

section("findConfiguredModel — provider/modelId override");

test("exact provider/modelId match returned",
	idOf(findConfiguredModel(allModels, "anthropic/claude-sonnet-5", () => true)), "anthropic/claude-sonnet-5");
test("override can pick a pricey model the heuristic would never choose",
	idOf(findConfiguredModel(allModels, "anthropic/claude-opus-5", () => true)), "anthropic/claude-opus-5");
test("override can pick from a different provider than current",
	idOf(findConfiguredModel(allModels, "openai/gpt-5.6-terra", () => true)), "openai/gpt-5.6-terra");

// ── findConfiguredModel — bare modelId ──────────────────────

section("findConfiguredModel — bare modelId");

test("bare modelId matches when provider not specified",
	idOf(findConfiguredModel(allModels, "claude-haiku-4-5", () => true)), "anthropic/claude-haiku-4-5");
test("provider/modelId wins over a bare modelId collision",
	idOf(findConfiguredModel(allModels, "anthropic/claude-sonnet-5", () => true)), "anthropic/claude-sonnet-5");

// ── findConfiguredModel — auth gating ──────────────────────────

section("findConfiguredModel — auth gating");

test("override skipped when that model has no auth",
	idOf(findConfiguredModel(allModels, "anthropic/claude-opus-5", (m) => m.id !== "claude-opus-5")), undefined);
test("override skipped → undefined (no fallback to heuristic here)",
	findConfiguredModel(allModels, "anthropic/nonexistent", () => true), undefined);

// ── findConfiguredModel — edge cases ──────────────────────

section("findConfiguredModel — edge cases");

test("undefined override → undefined", findConfiguredModel(allModels, undefined, () => true), undefined);
test("empty string override → undefined", findConfiguredModel(allModels, "   ", () => true), undefined);
test("whitespace-only override → undefined", findConfiguredModel(allModels, "\t\n", () => true), undefined);
test("override is trimmed before matching",
	idOf(findConfiguredModel(allModels, "  anthropic/claude-haiku-4-5  ", () => true)), "anthropic/claude-haiku-4-5");
test("dedupes pool before matching (no double hit)",
	findConfiguredModel([anthropicMid, anthropicMid], "anthropic/claude-sonnet-5", () => true) != null, true);

// ── pickableModels — picker list construction ─────────────────

section("pickableModels — filters to authed, sorts by provider then id");

const pickableAll = pickableModels(allModels, () => true).map(idOf);
test("includes all authed models", pickableAll.length, allModels.length);
test("sorted by provider first",
	pickableModels(allModels, () => true).slice(0, 3).every((m) => m.provider === "anthropic"), true);
test("within provider, sorted by id",
	pickableModels(allModels, () => true)
		.filter((m) => m.provider === "anthropic")
		.map(idOf),
	["anthropic/claude-haiku-4-5", "anthropic/claude-opus-5", "anthropic/claude-sonnet-5"]);
test("provider order: anthropic < baseten < openai",
	pickableAll.slice(0, 3).every((x) => x.startsWith("anthropic"))
		&& pickableAll[3].startsWith("baseten")
		&& pickableAll[5].startsWith("openai"),
	true);

test("excludes models without auth",
	pickableModels(allModels, (m) => m.provider === "openai").map(idOf),
	["openai/gpt-5.6-luna", "openai/gpt-5.6-terra"]);
test("dedupes before filtering", pickableModels([anthropicMid, anthropicMid], () => true).length, 1);
test("empty pool → empty list", pickableModels([], () => true).length, 0);

// ── Exit ───────────────────────────────────────────────────────────────────

const failed = summary();
process.exit(failed > 0 ? 1 : 0);
