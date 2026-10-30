// Tests for the shared global model pin (extensions/shared/model-pin.ts):
// ref parsing, coercion, file read/write/clear, resolution and the
// once-per-session notifier.
//
// Run: node --test tests/model-pin.test.mts
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	MODEL_PIN_KEY,
	clearModelPin,
	coerceModelPin,
	createIgnoredPinNotifier,
	describeIgnoredPin,
	parseModelRef,
	readModelPin,
	resolveModel,
	writeModelPin,
} from "../extensions/shared/model-pin.ts";

const mk = (provider: string, id: string): any => ({ provider, id, api: "openai-completions", cost: { input: 1, output: 1 } });

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "model-pin-"));
}

function registry(models: any[], authed: (m: any) => boolean = () => true) {
	const calls: string[] = [];
	return {
		calls,
		find(provider: string, id: string) {
			calls.push(`${provider}/${id}`);
			return models.find((m) => m.provider === provider && m.id === id);
		},
		hasConfiguredAuth: (m: any) => authed(m),
	};
}

test("MODEL_PIN_KEY is model", () => {
	assert.equal(MODEL_PIN_KEY, "model");
});

test("parseModelRef: ref matrix", () => {
	const cases: Array<[string, unknown]> = [
		["anthropic/claude-haiku-4-5", { provider: "anthropic", modelId: "claude-haiku-4-5" }],
		["baseten/zai-org/GLM-5.2", { provider: "baseten", modelId: "zai-org/GLM-5.2" }],
		["  openai/gpt-5  ", { provider: "openai", modelId: "gpt-5" }],
		["noslash", undefined],
		["/x", undefined],
		["x/", undefined],
		["", undefined],
		["   ", undefined],
		["/", undefined],
	];
	for (const [ref, expected] of cases) assert.deepEqual(parseModelRef(ref), expected, JSON.stringify(ref));
});

test("coerceModelPin: undefined, valid, number, object, unparsable string", () => {
	assert.deepEqual(coerceModelPin(undefined, "x.json"), {});
	assert.deepEqual(coerceModelPin(" a/b ", "x.json"), { ref: "a/b" });
	for (const raw of [42, { provider: "a", model: "b" }, "noslash", null, ["a/b"]]) {
		const r = coerceModelPin(raw, "x.json");
		assert.equal(r.ref, undefined, JSON.stringify(raw));
		assert.equal(r.warning, 'x.json: "model" must be a "provider/modelId" string; ignoring it');
	}
});

test("readModelPin: missing, corrupt, array, valid, invalid value", () => {
	const dir = tempDir();
	try {
		assert.deepEqual(readModelPin(join(dir, "missing.json")), {});
		const corrupt = join(dir, "corrupt.json");
		writeFileSync(corrupt, "{ not json");
		const c = readModelPin(corrupt);
		assert.equal(c.ref, undefined);
		assert.match(c.warning ?? "", /corrupt\.json: failed to read .*ignoring the model pin/);
		const arr = join(dir, "array.json");
		writeFileSync(arr, "[]");
		const a = readModelPin(arr);
		assert.equal(a.ref, undefined);
		assert.match(a.warning ?? "", /top-level value must be an object; ignoring the model pin/);
		const ok = join(dir, "ok.json");
		writeFileSync(ok, JSON.stringify({ model: "baseten/zai-org/GLM-5.2", timeoutMinutes: 5 }));
		assert.deepEqual(readModelPin(ok), { ref: "baseten/zai-org/GLM-5.2" });
		writeFileSync(ok, JSON.stringify({ timeoutMinutes: 5 }));
		assert.deepEqual(readModelPin(ok), {}, "no model key is no pin");
		writeFileSync(ok, JSON.stringify({ model: { provider: "a", model: "b" } }));
		assert.match(readModelPin(ok).warning ?? "", /"model" must be a "provider\/modelId" string/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("writeModelPin: sibling keys survive, directory is created, corrupt file is overwritten", () => {
	const dir = tempDir();
	try {
		const nested = join(dir, "a", "b", "cfg.json");
		assert.deepEqual(writeModelPin(nested, "p/m"), { warnings: [] });
		assert.equal(readFileSync(nested, "utf8"), '{\n  "model": "p/m"\n}\n');

		const withSiblings = join(dir, "siblings.json");
		writeFileSync(withSiblings, JSON.stringify({ timeoutMinutes: 7, hostBash: { allow: ["x"] }, model: "old/one" }));
		assert.deepEqual(writeModelPin(withSiblings, "new/two"), { warnings: [] });
		assert.deepEqual(JSON.parse(readFileSync(withSiblings, "utf8")), { timeoutMinutes: 7, hostBash: { allow: ["x"] }, model: "new/two" });
		assert.ok(readFileSync(withSiblings, "utf8").endsWith("}\n"));

		const corrupt = join(dir, "corrupt.json");
		writeFileSync(corrupt, "{ nope");
		const result = writeModelPin(corrupt, "p/m");
		assert.equal(result.warnings.length, 1);
		assert.match(result.warnings[0], /overwriting it/);
		assert.deepEqual(JSON.parse(readFileSync(corrupt, "utf8")), { model: "p/m" });

		assert.throws(() => writeModelPin(join(dir, "bad.json"), "noslash"), /invalid model reference/);
		assert.equal(existsSync(join(dir, "bad.json")), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("writeModelPin: write errors throw", () => {
	const dir = tempDir();
	try {
		// A directory where the file should be makes writeFileSync fail.
		const target = join(dir, "is-a-dir.json");
		mkdirSync(target);
		assert.throws(() => writeModelPin(target, "p/m"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("clearModelPin: false on missing file or key, removes only model", () => {
	const dir = tempDir();
	try {
		assert.equal(clearModelPin(join(dir, "missing.json")), false);
		const noKey = join(dir, "nokey.json");
		const noKeyText = '{"timeoutMinutes":3}';
		writeFileSync(noKey, noKeyText);
		assert.equal(clearModelPin(noKey), false);
		assert.equal(readFileSync(noKey, "utf8"), noKeyText, "no write when there is no model key");
		const corrupt = join(dir, "corrupt.json");
		writeFileSync(corrupt, "{ nope");
		assert.equal(clearModelPin(corrupt), false);
		assert.equal(readFileSync(corrupt, "utf8"), "{ nope");

		const withPin = join(dir, "pin.json");
		writeFileSync(withPin, JSON.stringify({ model: "p/m", timeoutMinutes: 3, other: [1] }));
		assert.equal(clearModelPin(withPin), true);
		assert.deepEqual(JSON.parse(readFileSync(withPin, "utf8")), { timeoutMinutes: 3, other: [1] });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("resolveModel: pinned and authed wins", () => {
	const pinned = mk("baseten", "zai-org/GLM-5.2");
	const ctxModel = mk("anthropic", "claude-x");
	const reg = registry([pinned]);
	assert.deepEqual(resolveModel("baseten/zai-org/GLM-5.2", ctxModel, reg), { model: pinned, pinned: true });
	assert.deepEqual(reg.calls, ["baseten/zai-org/GLM-5.2"]);
});

test("resolveModel: not-found, no-auth and invalid fall back to ctx.model", () => {
	const pinned = mk("baseten", "glm");
	const ctxModel = mk("anthropic", "claude-x");
	assert.deepEqual(resolveModel("x/y", ctxModel, registry([pinned])), { model: ctxModel, pinned: false, ignoredPin: { ref: "x/y", reason: "not-found" } });
	assert.deepEqual(resolveModel("baseten/glm", ctxModel, registry([pinned], () => false)), { model: ctxModel, pinned: false, ignoredPin: { ref: "baseten/glm", reason: "no-auth" } });
	const invalidReg = registry([pinned]);
	assert.deepEqual(resolveModel("noslash", ctxModel, invalidReg), { model: ctxModel, pinned: false, ignoredPin: { ref: "noslash", reason: "invalid" } });
	assert.deepEqual(invalidReg.calls, [], "an invalid ref is never looked up");
});

test("resolveModel: no pin returns ctx.model without lookup, unauthed ctx.model as-is", () => {
	const ctxModel = mk("anthropic", "claude-x");
	const reg = registry([ctxModel], () => false);
	assert.deepEqual(resolveModel(undefined, ctxModel, reg), { model: ctxModel, pinned: false });
	assert.deepEqual(resolveModel(undefined, undefined, reg), { model: undefined, pinned: false });
	assert.deepEqual(resolveModel("x/y", undefined, reg), { model: undefined, pinned: false, ignoredPin: { ref: "x/y", reason: "not-found" } });
	assert.deepEqual(reg.calls, ["x/y"], "find is called only when there is a pin");
});

test("describeIgnoredPin: names the pin, reason and fallback", () => {
	assert.equal(
		describeIgnoredPin("idle-summary", { ref: "x/y", reason: "not-found" }, mk("anthropic", "claude-x")),
		'idle-summary: pinned model "x/y" ignored (not found); using the session model anthropic/claude-x.',
	);
	assert.match(describeIgnoredPin("guard", { ref: "a/b", reason: "no-auth" }, undefined), /no configured auth\); using the session model \(none available\)\./);
	assert.match(describeIgnoredPin("guard", { ref: "nope", reason: "invalid" }, undefined), /not a "provider\/modelId" reference/);
});

test("createIgnoredPinNotifier: once per ref, reset re-arms, different refs fire", () => {
	const n = createIgnoredPinNotifier();
	const fired: string[] = [];
	assert.equal(n.notifyOnce("a/b", () => fired.push("a/b")), true);
	assert.equal(n.notifyOnce("a/b", () => fired.push("a/b")), false);
	assert.equal(n.notifyOnce("c/d", () => fired.push("c/d")), true);
	n.reset();
	assert.equal(n.notifyOnce("a/b", () => fired.push("a/b")), true);
	assert.deepEqual(fired, ["a/b", "c/d", "a/b"]);
	// A throwing emitter does not consume the notice.
	assert.throws(() => n.notifyOnce("e/f", () => { throw new Error("stale"); }));
	assert.equal(n.notifyOnce("e/f", () => fired.push("e/f")), true);
});
