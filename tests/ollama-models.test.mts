// Test harness for the Ollama model auto-discovery extension.
//
// Exercises the exported `toPiModel` mapping against representative
// /api/tags payloads, and `fetchOllamaModels` against a dead endpoint
// (graceful degradation) and, when Ollama is running locally, the live
// endpoint.
//
// Run: node tests/ollama-models.test.mts
import assert from "node:assert/strict";
import { fetchOllamaModels, toPiModel } from "../extensions/ollama-models.ts";

async function main() {
	// ── toPiModel mapping ──────────────────────────────────────────────────────
	const qwen = toPiModel({
		name: "qwen3.5:9b",
		details: {
			parameter_size: "9.7B",
			quantization_level: "Q4_K_M",
			context_length: 262144,
		},
		capabilities: ["vision", "completion", "tools", "thinking"],
	});
	assert.equal(qwen.id, "qwen3.5:9b");
	assert.equal(qwen.name, "Ollama qwen3.5:9b (9.7B)");
	assert.equal(qwen.reasoning, true);
	assert.deepEqual(qwen.input, ["text", "image"]);
	assert.equal(qwen.contextWindow, 262144);
	assert.equal(qwen.maxTokens, 32768); // context/8 clamped to cap
	assert.deepEqual(qwen.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	assert.deepEqual(qwen.compat, { supportsDeveloperRole: false, supportsReasoningEffort: false });

	const plain = toPiModel({ name: "llama3.1:8b" });
	assert.equal(plain.reasoning, false);
	assert.deepEqual(plain.input, ["text"]);
	assert.equal(plain.contextWindow, 128000); // default
	assert.equal(plain.maxTokens, 16000); // 128000/8
	assert.equal(plain.name, "Ollama llama3.1:8b");

	// Small context floor: never below 4096.
	const tiny = toPiModel({ name: "m", details: { context_length: 1000 } });
	assert.equal(tiny.maxTokens, 4096);

	// ── fetchOllamaModels ──────────────────────────────────────────────────────
	// Aborted fetch must resolve to undefined, never throw (graceful degradation path).
	const aborted = await fetchOllamaModels(AbortSignal.abort());
	assert.ok(aborted === undefined, "aborted fetch should resolve undefined");

	// Live endpoint (skipped when Ollama is not running).
	const live = await fetchOllamaModels();
	if (live !== undefined) {
		assert.ok(Array.isArray(live) && live.length > 0, "live models should be non-empty");
		assert.ok(live.every((m) => typeof m.id === "string" && m.contextWindow > 0));
		console.log(`live check ok (${live.length} models: ${live.map((m) => m.id).join(", ")})`);
	} else {
		console.log("live check skipped (Ollama not running)");
	}

	console.log("ollama-models: all tests passed");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
