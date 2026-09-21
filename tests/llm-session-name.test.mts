// Tests for the llm-session-name extension.
//
// Covers the pure helpers (sanitize, truncate, prompt build, config read,
// recent-turns build) and drives the REAL default export with a mock pi/ctx
// to verify: one title per session, regeneration cadence with provenance
// tracking, manual /name locking, the /name-auto force command, fallback
// naming on model failure, and manual /name always winning.
//
// Run: node tests/llm-session-name.test.mts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mod = await import("../extensions/llm-session-name.ts");
const {
	collapseWhitespace,
	truncateFallbackName,
	sanitizeTitle,
	buildTitlePrompt,
	buildRegenerationPrompt,
	buildRecentTurnsText,
	readTurnInterval,
} = mod;

const msgEntry = (role: string, text: string) => ({
	type: "message",
	message: { role, content: [{ type: "text", text }] },
});

// ── Pure helpers ─────────────────────────────────────────────────────────────

assert.equal(collapseWhitespace("  a \n\t b  "), "a b");

assert.equal(truncateFallbackName("short prompt"), "short prompt");
assert.equal(truncateFallbackName("a".repeat(50)), "a".repeat(50));
const truncated = truncateFallbackName("x".repeat(80));
assert.equal(truncated.length, 53); // 50 chars + "..."
assert.ok(truncated.endsWith("..."));

assert.equal(sanitizeTitle('  "Fix   auth\nbug"  '), "Fix auth bug");
assert.equal(sanitizeTitle("`Add tests`"), "Add tests");
assert.equal(sanitizeTitle("y".repeat(70)).length, 60);
assert.equal(sanitizeTitle("   "), "");

const titlePrompt = buildTitlePrompt("please   fix\nthe login bug");
assert.ok(titlePrompt.includes("please fix the login bug"));
assert.ok(titlePrompt.includes("<request>"));

const regenPrompt = buildRegenerationPrompt("Old title", "User: fix  auth\nAssistant: done");
assert.ok(regenPrompt.includes("<current_title>Old title</current_title>"));
assert.ok(regenPrompt.includes("User: fix auth"));
assert.ok(regenPrompt.includes("<recent_conversation>"));
// The recent conversation sample is truncated to the same cap as first prompts.
const longRegen = buildRegenerationPrompt("t", "y".repeat(3000));
assert.ok(longRegen.length < 3000 + 500);

const turns = buildRecentTurnsText(
	[
		msgEntry("user", "u1"),
		msgEntry("assistant", "a1"),
		{ type: "message", message: { role: "system", content: "ignored" } },
		msgEntry("user", "u2"),
	],
	3,
);
assert.ok(turns.includes("Assistant: a1"));
assert.ok(turns.includes("User: u2"));
assert.ok(!turns.includes("u1"), "messages outside the window must be excluded");
assert.ok(!turns.includes("ignored"), "non user/assistant roles must be excluded");

// ── Mock pi/ctx ──────────────────────────────────────────────────────────────

const handlers: Record<string, (event: any, ctx: any) => unknown> = {};
const commands: Record<string, { description: string; handler: (args: string, ctx: any) => Promise<void> }> = {};

function makePi(initialName?: string) {
	let name = initialName;
	let setCalls = 0;
	return {
		name: () => name,
		setCallCount: () => setCalls,
		on(event: string, handler: any) {
			handlers[event] = handler;
		},
		registerCommand(command: string, opts: any) {
			commands[command] = opts;
		},
		getSessionName: () => name,
		setSessionName(next: string) {
			setCalls++;
			name = next;
		},
	};
}

function makeCtx(opts: {
	complete?: (model: any, context: any, options?: any) => Promise<any>;
	authed?: boolean;
	entries?: any[];
} = {}) {
	const ctx: any = {
		sessionManager: {
			getSessionId: () => "s1",
			getBranch: () => opts.entries ?? [],
		},
		model: { provider: "anthropic", id: "claude-x" },
		modelRegistry: {
			hasConfiguredAuth: () => opts.authed ?? true,
			complete: opts.complete ?? (async () => ({ content: [], errorMessage: undefined })),
		},
	};
	ctx.notifies = [] as { msg: string; level?: string }[];
	ctx.ui = { notify: (msg: string, level?: string) => ctx.notifies.push({ msg, level }) };
	return ctx;
}

const textResponse = (text: string) => ({
	content: [{ type: "text", text }],
	errorMessage: undefined,
});

// ── Extension flow ───────────────────────────────────────────────────────────

// 1. Success: first turn_end titles the session from the first prompt.
{
	const pi = makePi();
	mod.default(pi as any);
	assert.ok(handlers.before_agent_start && handlers.turn_end && handlers.session_start);

	await handlers.before_agent_start({ prompt: "refactor  the\nauth module" }, makeCtx());
	const completeCalls: any[] = [];
	const ctx = makeCtx({
		complete: async (model, context) => {
			completeCalls.push({ model, context });
			return textResponse('  "Refactor  the\nauth   module"  ');
		},
	});
	await handlers.turn_end({ turnIndex: 0 }, ctx);
	assert.equal(pi.name(), "Refactor the auth module");
	assert.equal(completeCalls.length, 1);
	assert.ok(JSON.stringify(completeCalls[0].context).includes("refactor the auth module"));

	// 2. Second turn_end must not re-title.
	await handlers.turn_end({ turnIndex: 1 }, ctx);
	assert.equal(completeCalls.length, 1);
	assert.equal(pi.name(), "Refactor the auth module");
}

// 3. Model failure (throw) falls back to the truncated prompt.
{
	const pi = makePi();
	mod.default(pi as any);
	await handlers.before_agent_start({ prompt: "w".repeat(80) }, makeCtx());
	const ctx = makeCtx({
		complete: async () => {
			throw new Error("no auth");
		},
	});
	await handlers.turn_end({}, ctx);
	assert.equal(pi.name(), `${"w".repeat(50)}...`);
}

// 4. Error response (errorMessage, empty content) also falls back.
{
	const pi = makePi();
	mod.default(pi as any);
	await handlers.before_agent_start({ prompt: "rate limited prompt" }, makeCtx());
	const ctx = makeCtx({
		complete: async () => ({ content: [], errorMessage: "429 rate limit" }),
	});
	await handlers.turn_end({}, ctx);
	assert.equal(pi.name(), "rate limited prompt");
}

// 5. Pre-named session: never calls the model, never renames.
{
	const pi = makePi("manual name");
	mod.default(pi as any);
	await handlers.before_agent_start({ prompt: "some prompt" }, makeCtx());
	let completeCalls = 0;
	const ctx = makeCtx({
		complete: async () => {
			completeCalls++;
			return textResponse("generated");
		},
	});
	await handlers.turn_end({}, ctx);
	assert.equal(completeCalls, 0);
	assert.equal(pi.name(), "manual name");
}

// 6. Name set manually DURING the model await: generated title is discarded.
{
	const pi = makePi();
	mod.default(pi as any);
	await handlers.before_agent_start({ prompt: "some other prompt" }, makeCtx());
	const ctx = makeCtx({
		complete: async () => {
			pi.setSessionName("manual mid-flight");
			return textResponse("generated title");
		},
	});
	await handlers.turn_end({}, ctx);
	assert.equal(pi.name(), "manual mid-flight");
}

// 7. No model / unauthed model: silent fallback.
{
	const pi = makePi();
	mod.default(pi as any);
	await handlers.before_agent_start({ prompt: "unauthed prompt" }, makeCtx());
	const ctx = makeCtx({ authed: false, complete: async () => textResponse("never") });
	await handlers.turn_end({}, ctx);
	assert.equal(pi.name(), "unauthed prompt");
}

// 8. Session replacement: session_start resets per-session state, so a new
// session's first turn gets its own title.
{
	const pi = makePi();
	let sessionId = "a";
	const ctxFor = (id: string) => ({ sessionManager: { getSessionId: () => id }, ...makeCtx({ complete: async () => textResponse("title") }) });
	mod.default(pi as any);
	await handlers.before_agent_start({ prompt: "first session prompt" }, ctxFor("a"));
	await handlers.turn_end({}, ctxFor("a"));
	assert.equal(pi.name(), "title");
	await handlers.session_start({ reason: "new" }, ctxFor("b"));
	pi.setSessionName(""); // /new starts an unnamed session in real pi
	const customCtx = {
		sessionManager: { getSessionId: () => "b" },
		model: { provider: "anthropic", id: "claude-x" },
		modelRegistry: {
			hasConfiguredAuth: () => true,
			complete: async () => textResponse("second title"),
		},
	};
	await handlers.before_agent_start({ prompt: "second session prompt" }, customCtx);
	await handlers.turn_end({}, customCtx);
	assert.equal(pi.name(), "second title");
}

// 9. Regeneration cadence: nothing between cadence points; at the next one
// (turn 11 for the default interval) the title regenerates from the current
// title plus recent turns.
{
	const pi = makePi();
	mod.default(pi as any);
	await handlers.before_agent_start({ prompt: "initial prompt" }, makeCtx());
	const completeCalls: any[] = [];
	const responses = ["first title", "second title"];
	const ctx = makeCtx({
		complete: async (_model, context) => {
			completeCalls.push(context);
			return textResponse(responses[completeCalls.length - 1]);
		},
		entries: [msgEntry("user", "now working on the parser"), msgEntry("assistant", "ok")],
	});
	await handlers.turn_end({}, ctx); // turn 1: first title
	assert.equal(pi.name(), "first title");
	for (let t = 2; t <= 10; t++) await handlers.turn_end({}, ctx);
	assert.equal(completeCalls.length, 1, "no regeneration before the cadence point");
	assert.equal(pi.name(), "first title");
	await handlers.turn_end({}, ctx); // turn 11: regeneration
	assert.equal(completeCalls.length, 2);
	assert.equal(pi.name(), "second title");
	const sent = JSON.stringify(completeCalls[1]);
	assert.ok(sent.includes("first title"), "regeneration prompt must include the current title");
	assert.ok(sent.includes("now working on the parser"), "regeneration prompt must include recent turns");
}

// 10. Manual /name after a generated title locks the session: no further
// regeneration at any later cadence point.
{
	const pi = makePi();
	mod.default(pi as any);
	await handlers.before_agent_start({ prompt: "p" }, makeCtx());
	let calls = 0;
	const ctx = makeCtx({
		complete: async () => {
			calls++;
			return textResponse("t");
		},
		entries: [msgEntry("user", "recent")],
	});
	await handlers.turn_end({}, ctx); // turn 1: first title
	assert.equal(pi.name(), "t");
	pi.setSessionName("my manual name");
	for (let t = 2; t <= 21; t++) await handlers.turn_end({}, ctx);
	assert.equal(calls, 1, "manual rename must block all regeneration");
	assert.equal(pi.name(), "my manual name");
}

// 11. Clearing the name also locks the session.
{
	const pi = makePi();
	mod.default(pi as any);
	await handlers.before_agent_start({ prompt: "p" }, makeCtx());
	let calls = 0;
	const ctx = makeCtx({
		complete: async () => {
			calls++;
			return textResponse("t");
		},
		entries: [msgEntry("user", "recent")],
	});
	await handlers.turn_end({}, ctx); // turn 1
	pi.setSessionName("");
	for (let t = 2; t <= 11; t++) await handlers.turn_end({}, ctx);
	assert.equal(calls, 1, "a cleared name must block regeneration");
	assert.equal(pi.name(), "");
}

// 12. /name-auto bypasses the manual lock, adopts the new title as
// extension-owned, and periodic regeneration resumes.
{
	const pi = makePi();
	mod.default(pi as any);
	await handlers.before_agent_start({ prompt: "p" }, makeCtx());
	let calls = 0;
	const ctx = makeCtx({
		complete: async () => {
			calls++;
			return textResponse(calls === 1 ? "t1" : "forced title");
		},
		entries: [msgEntry("user", "latest focus")],
	});
	await handlers.turn_end({}, ctx); // turn 1: t1
	pi.setSessionName("manual");
	for (let t = 2; t <= 11; t++) await handlers.turn_end({}, ctx);
	assert.equal(calls, 1, "locked session must not regenerate on cadence");
	assert.ok(commands["name-auto"], "/name-auto must be registered");
	await commands["name-auto"].handler("", ctx);
	assert.equal(calls, 2, "/name-auto must force a regeneration");
	assert.equal(pi.name(), "forced title");
	assert.ok(
		ctx.notifies.some((n: { msg: string }) => n.msg.includes("forced title")),
		"/name-auto must notify with the new title",
	);
	// Ownership resumed: the next cadence point regenerates again.
	for (let t = 12; t <= 21; t++) await handlers.turn_end({}, ctx);
	assert.equal(calls, 3);
	assert.equal(pi.name(), "forced title");
}

// 13. Regeneration failure keeps the existing name and retries at the next
// cadence point (no lock, no degradation).
{
	const pi = makePi();
	mod.default(pi as any);
	await handlers.before_agent_start({ prompt: "p" }, makeCtx());
	let calls = 0;
	const ctx = makeCtx({
		complete: async () => {
			calls++;
			if (calls === 1) return textResponse("good title");
			throw new Error("api down");
		},
		entries: [msgEntry("user", "recent stuff")],
	});
	await handlers.turn_end({}, ctx); // turn 1
	assert.equal(pi.name(), "good title");
	for (let t = 2; t <= 11; t++) await handlers.turn_end({}, ctx);
	assert.equal(calls, 2, "regeneration must be attempted at the cadence point");
	assert.equal(pi.name(), "good title", "failed regeneration must keep the existing name");
	for (let t = 12; t <= 21; t++) await handlers.turn_end({}, ctx);
	assert.equal(calls, 3, "a failed regeneration must not lock the session");
	assert.equal(pi.name(), "good title");
}

// 14. No thrash: an identical regenerated title must not call setSessionName.
{
	const pi = makePi();
	mod.default(pi as any);
	await handlers.before_agent_start({ prompt: "p" }, makeCtx());
	let calls = 0;
	const ctx = makeCtx({
		complete: async () => {
			calls++;
			return textResponse("same title");
		},
		entries: [msgEntry("user", "recent")],
	});
	await handlers.turn_end({}, ctx);
	assert.equal(pi.setCallCount(), 1);
	for (let t = 2; t <= 11; t++) await handlers.turn_end({}, ctx);
	assert.equal(calls, 2);
	assert.equal(pi.setCallCount(), 1, "identical title must not re-set the session name");
	assert.equal(pi.name(), "same title");
}

// 15. Config reading and cadence honoring a configured interval.
{
	const dir = mkdtempSync(join(tmpdir(), "lsn-config-"));
	const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		assert.equal(readTurnInterval(dir), 10, "missing config falls back to the default");
		writeFileSync(join(dir, "llm-session-name.json"), JSON.stringify({ turnInterval: 3 }));
		assert.equal(readTurnInterval(dir), 3);
		writeFileSync(join(dir, "llm-session-name.json"), "{ not json");
		assert.equal(readTurnInterval(dir), 10, "corrupt config falls back to the default");
		writeFileSync(join(dir, "llm-session-name.json"), JSON.stringify({ turnInterval: 0 }));
		assert.equal(readTurnInterval(dir), 10, "zero interval falls back to the default");
		writeFileSync(join(dir, "llm-session-name.json"), JSON.stringify({ turnInterval: 2.5 }));
		assert.equal(readTurnInterval(dir), 10, "non-integer interval falls back to the default");

		// Cadence honors the configured interval: with turnInterval 3 the
		// regeneration fires on turn 4.
		writeFileSync(join(dir, "llm-session-name.json"), JSON.stringify({ turnInterval: 3 }));
		process.env.PI_CODING_AGENT_DIR = dir;
		const pi = makePi();
		mod.default(pi as any);
		await handlers.before_agent_start({ prompt: "interval prompt" }, makeCtx());
		let calls = 0;
		const ctx = makeCtx({
			complete: async () => {
				calls++;
				return textResponse(calls === 1 ? "t1" : "t2");
			},
			entries: [msgEntry("user", "recent")],
		});
		await handlers.turn_end({}, ctx);
		for (let t = 2; t <= 3; t++) await handlers.turn_end({}, ctx);
		assert.equal(calls, 1);
		await handlers.turn_end({}, ctx); // turn 4
		assert.equal(calls, 2);
		assert.equal(pi.name(), "t2");
	} finally {
		if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
		rmSync(dir, { recursive: true, force: true });
	}
}

// ── herdr-tab-name: rename via a fake herdr on PATH ──────────────────────────

const tmp = mkdtempSync(join(tmpdir(), "herdr-tab-test-"));
const binDir = join(tmp, "bin");
mkdirSync(binDir, { recursive: true });
const logFile = join(tmp, "calls.log");
rmSync(logFile, { force: true });
writeFileSync(
	join(binDir, "herdr"),
	`#!/bin/sh\necho "$@" >> ${JSON.stringify(logFile)}\n`,
	{ mode: 0o755 },
);

const tabMod = await import("../extensions/herdr-tab-name.ts");
assert.equal(tabMod.cleanLabel("  a \n b  "), "a b");

const tabHandlers: Record<string, (event: any, ctx: any) => unknown> = {};
function makeTabPi() {
	return {
		on(event: string, handler: any) {
			tabHandlers[event] = handler;
		},
		getSessionName: () => undefined,
	};
}

const prevEnv = process.env.HERDR_ENV;
const prevTab = process.env.HERDR_TAB_ID;
const prevPath = process.env.PATH;

try {
	// Gating: outside herdr, no handlers are registered.
	delete process.env.HERDR_ENV;
	delete process.env.HERDR_TAB_ID;
	assert.equal(tabMod.default(makeTabPi() as any), undefined);
	assert.ok(!tabHandlers.session_info_changed, "must be a no-op outside herdr");

	// Enabled: handlers registered; renames go through the fake herdr.
	process.env.HERDR_ENV = "1";
	process.env.HERDR_TAB_ID = "w1:t9";
	process.env.PATH = `${binDir}:${process.env.PATH}`;
	assert.equal(tabMod.default(makeTabPi() as any), undefined);
	assert.ok(tabHandlers.session_info_changed && tabHandlers.session_start);

	const waitForLog = async (lines: number) => {
		for (let i = 0; i < 100; i++) {
			const content = (await import("node:fs")).readFileSync(logFile, "utf8").trim();
			if (content && content.split("\n").length >= lines) return content.split("\n");
			await new Promise((r) => setTimeout(r, 20));
		}
		throw new Error(`timed out waiting for ${lines} herdr calls`);
	};

	await tabHandlers.session_info_changed({ name: "  my   title " }, {});
	const lines = await waitForLog(1);
	const PREFIX = "tab rename w1:t9 ";
	assert.ok(lines[0].startsWith(PREFIX), `unexpected call: ${lines[0]}`);
	assert.equal(lines[0].slice(PREFIX.length), "my title");

	// Cleared name must not rename.
	await tabHandlers.session_info_changed({ name: undefined }, {});
	await tabHandlers.session_info_changed({ name: "" }, {});
	await new Promise((r) => setTimeout(r, 100));
	const after = (await import("node:fs")).readFileSync(logFile, "utf8").trim().split("\n");
	assert.equal(after.length, 1, "cleared/empty names must not rename the tab");

	// A second rename queues after the first; last label wins server-side.
	await tabHandlers.session_info_changed({ name: "renamed again" }, {});
	const all = await waitForLog(2);
	assert.ok(all[1].startsWith(PREFIX), `unexpected call: ${all[1]}`);
	assert.equal(all[1].slice(PREFIX.length), "renamed again");
} finally {
	process.env.HERDR_ENV = prevEnv;
	process.env.HERDR_TAB_ID = prevTab;
	process.env.PATH = prevPath;
	rmSync(tmp, { recursive: true, force: true });
}

console.log("llm-session-name + herdr-tab-name: all assertions passed");
