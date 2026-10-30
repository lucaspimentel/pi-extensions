// Regression test for the stale-ctx leak in the idle-summary extension.
//
// Drives the REAL default export with a mock `pi`/`ctx`. The /idle-summary command
// handler awaits generateAndShowSummary(ctx) with no .catch, so if a
// /reload or session replacement invalidates the ctx during the model
// complete() await, any post-await ctx/pi touch throws the stale-ctx error
// and propagates. The fix bails on a `generation` counter bumped by
// session_shutdown (which fires before the runner is invalidated) before
// touching ctx/pi. A counter rather than a boolean, because pi's resource
// loader caches the loaded extension set, so the SAME closure is reused
// across session replacement (/new, /resume, /fork, /switchSession) -- a
// boolean reset on session_start would clear the flag out from under an old
// in-flight run (scenario 4 below).
//
// Also covers the global summary model pin: pinned model used, unusable pin
// falling back to the session model, the once-per-session ignored-pin notice,
// /idle-summary model clear, and the picker write/cancel/error paths.
//
// Run: node tests/idle-summary.test.mts
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate the global config: a real ~/.pi/agent/idle-summary.json (pin or
// timeoutMinutes) must never leak into these tests. Set before the import;
// getAgentDir() reads the variable on every call.
const agentDir = mkdtempSync(join(tmpdir(), "idle-summary-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const configFile = join(agentDir, "idle-summary.json");
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));
const setConfig = (value: Record<string, unknown> | undefined) => {
	rmSync(configFile, { recursive: true, force: true });
	if (value) writeFileSync(configFile, JSON.stringify(value));
};

const idleSummary = (await import("../extensions/idle-summary/index.ts")).default;
const { resolveIdleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS } = await import(
	"../extensions/idle-summary/idle-summary-models.ts"
);

// ── Mock pi: capture event handlers + command + sendMessage ─────────────────
const handlers: Record<string, (event: any, ctx: any) => unknown> = {};
const commands: Record<string, any> = {};
let sendMessageCalls: any[] = [];
let notifyCalls: Array<{ message: string; type?: string }> = [];
let selectCalls = 0;
let selectItems: string[][] = [];
let selectAnswer: string | undefined;
let streamModels: any[] = [];

const pi: any = {
	on(event: string, handler: any) {
		handlers[event] = handler;
	},
	registerCommand(name: string, opts: any) {
		commands[name] = opts;
	},
	registerMessageRenderer() {},
	sendMessage(msg: any) {
		// Faithful to real pi: a stale runner throws on sendMessage too, not just
		// on ctx.hasUI/ctx.ui.notify.
		if (stale) throw STALE_ERR;
		sendMessageCalls.push(msg);
	},
};

idleSummary(pi);

assert.ok(commands["idle-summary"], "/idle-summary command should be registered");
assert.ok(!commands.summary, "old /summary command name must be removed");
assert.ok(!commands["summary-model"], "deprecated /summary-model alias must be removed");
assert.ok(handlers.session_start, "session_start handler should be registered");
assert.ok(handlers.session_shutdown, "session_shutdown handler should be registered");

// ── Stale-ctx simulation ────────────────────────────────────────────────────
// After session_shutdown + invalidation, real pi throws on any ctx/pi touch.
// Model that with a `stale` flag so hasUI/notify/sendMessage throw, proving
// the fix bails BEFORE the touch rather than relying on a catch.
const STALE_ERR = new Error(
	"This extension ctx is stale after session replacement or reload. " +
		"Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), " +
		"ctx.switchSession(), or ctx.reload().",
);
let stale = false;

// Controllable model completion: a single shared deferred per scenario,
// resolved once by the test. All candidates in the for-loop await the same
// promise (the failure path iterates >1 candidate), so resolving once unblocks
// every iteration with the same value.
let resolveComplete!: (value: any) => void;
let completePromise!: Promise<any>;

// Minimal Model<Api> stand-ins (only the fields read by the candidate logic).
const pool = [
	{
		provider: "anthropic",
		id: "claude-haiku-4-5",
		name: "claude-haiku-4-5",
		api: "openai-responses",
		baseUrl: "",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 5, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8192,
	},
	{
		provider: "openai",
		id: "gpt-5.6-luna",
		name: "gpt-5.6-luna",
		api: "openai-responses",
		baseUrl: "",
		reasoning: false,
		input: ["text"],
		cost: { input: 0.2, output: 1.2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8192,
	},
];

function makeCtx(overrides: Partial<any> = {}): any {
	return {
		get hasUI() {
			if (stale) throw STALE_ERR;
			return true;
		},
		mode: "tui",
		cwd: process.cwd(),
		scopedModels: [],
		// The summary uses the session model when there is no pin.
		model: pool[0],
		signal: new AbortController().signal,
		sessionManager: {
			// A non-empty conversation so buildConversationText returns content.
			getBranch: () => [
				{ type: "message", message: { role: "user", content: "hello" } },
			],
		},
		modelRegistry: {
			getAvailable: () => pool,
			hasConfiguredAuth: () => true,
			find: (provider: string, id: string) => pool.find((m) => m.provider === provider && m.id === id),
			// streamSimple(model, { messages }).result() is the call shape the
			// extension uses (since bcf1d8f); every call awaits the same deferred.
			streamSimple: (model: any) => {
				streamModels.push(model);
				return { result: async () => completePromise };
			},
		},
		ui: {
			notify: (message: string, type?: string) => {
				if (stale) throw STALE_ERR;
				notifyCalls.push({ message, type });
			},
			// Cancelled picker: proves the model path was taken without ever
			// writing the (real, global) summary model config.
			select: async (_title: string, items: string[], _opts: any) => {
				selectCalls++;
				selectItems.push(items);
				return selectAnswer;
			},
		},
		...overrides,
	};
}

function resetScenario() {
	stale = false;
	sendMessageCalls = [];
	notifyCalls = [];
	selectCalls = 0;
	selectItems = [];
	selectAnswer = undefined;
	streamModels = [];
	completePromise = new Promise<any>((r) => {
		resolveComplete = r;
	});
	handlers.session_start({}, makeCtx()); // no-op for `generation`; just clears the idle timer
}

async function runSummary() {
	await commands["idle-summary"].handler("", makeCtx());
}

// ── Tests ─────────────────────────────────────────────────────────────────

// ── Idle timeout resolution ────────────────────────────────────────────────
// Pure helper tests: no file IO, no extension runtime.

function testIdleTimeoutResolution() {
	const DEFAULT = DEFAULT_IDLE_TIMEOUT_MS;
	assert.equal(DEFAULT, 180_000, "default idle timeout should be 3 minutes");

	// Missing value: default, not invalid.
	assert.deepEqual(resolveIdleTimeoutMs(undefined), { timeoutMs: DEFAULT, invalid: false });

	// Valid positive numbers (fractional minutes allowed).
	assert.deepEqual(resolveIdleTimeoutMs(1), { timeoutMs: 60_000, invalid: false });
	assert.deepEqual(resolveIdleTimeoutMs(3), { timeoutMs: 180_000, invalid: false });
	assert.deepEqual(resolveIdleTimeoutMs(0.5), { timeoutMs: 30_000, invalid: false });

	// Present but invalid: default + invalid flag (notify once).
	for (const bad of [0, -5, NaN, Infinity, -Infinity, "3", null, true, {}]) {
		assert.deepEqual(
			resolveIdleTimeoutMs(bad as unknown),
			{ timeoutMs: DEFAULT, invalid: true },
			`timeoutMinutes=${JSON.stringify(String(bad))} should be invalid`,
		);
	}
	console.log("  ✓ idle-timeout resolution: 5 checks passed");
}

// ── Timer arming (agent_end) ────────────────────────────────────────────────
// The extension reads the REAL user config for timeoutMinutes, so this only
// asserts invariants that hold regardless of the user's config: a positive,
// finite timer is armed on agent_end and cleaned up on shutdown.

function testAgentEndArmsTimer() {
	const realSetTimeout = globalThis.setTimeout;
	let armedDelay: number | undefined;
	let armedTimer: any;
	(globalThis as any).setTimeout = ((fn: any, delay: number) => {
		armedDelay = delay;
		// Real timer (immediately clearable) so cleanup paths stay exercisable.
		armedTimer = realSetTimeout(() => {}, delay);
		return armedTimer;
	}) as any;
	try {
		const ctx = makeCtx();
		handlers.agent_end({}, ctx);
		assert.equal(typeof armedDelay, "number", "agent_end should arm the idle timer");
		assert.ok(Number.isFinite(armedDelay) && (armedDelay as number) > 0, "armed delay should be positive and finite");

		handlers.session_shutdown({}, makeCtx()); // clears the idle timer
	} finally {
		(globalThis as any).setTimeout = realSetTimeout;
		if (armedTimer) clearTimeout(armedTimer);
	}
	console.log("  ✓ agent_end timer arming: 2 checks passed");
}

async function main() {
	testIdleTimeoutResolution();
	testAgentEndArmsTimer();
	// 1. Happy path: no shutdown, summary is produced and sent.
	resetScenario();
	const happy = runSummary();
	resolveComplete({ content: [{ type: "text", text: "Worked on tests. Status: green." }] });
	await happy;
	assert.equal(sendMessageCalls.length, 1, "happy path should send the summary");
	assert.equal(
		(sendMessageCalls[0] as any).content,
		"Worked on tests. Status: green.",
		"happy path should send the produced summary text",
	);
	assert.equal(notifyCalls.length, 0, "happy path should not notify");

	// 2. Shutdown during a SUCCESSFUL summary: must bail silently, no stale throw.
	//    (Previously: pi.sendMessage would throw stale-ctx and propagate from /idle-summary.)
	resetScenario();
	const p2 = runSummary();
	// Mid-await: session_shutdown fires (before runner invalidation), then ctx goes stale.
	handlers.session_shutdown({}, makeCtx());
	stale = true;
	resolveComplete({ content: [{ type: "text", text: "late summary" }] });
	await p2; // must NOT throw
	assert.equal(sendMessageCalls.length, 0, "shutdown should suppress sendMessage");
	assert.equal(notifyCalls.length, 0, "shutdown should bail before any ctx/ui touch");

	// 3. Shutdown during a FAILED summary (all candidates empty): must bail before
	//    the `ctx.hasUI` / `ctx.ui.notify` failure branch. This is the exact path
	//    that leaked the stale-ctx error as a "command:summary" error after reload.
	resetScenario();
	const p3 = runSummary();
	handlers.session_shutdown({}, makeCtx());
	stale = true;
	resolveComplete({ content: [], errorMessage: "rate limited" });
	await p3; // must NOT throw
	assert.equal(sendMessageCalls.length, 0, "failed+shutdown should suppress sendMessage");
	assert.equal(notifyCalls.length, 0, "failed+shutdown must bail before ctx.hasUI/notify");

	// 4. SESSION REPLACEMENT ordering (/new, /resume, /fork, /switchSession), as
	//    opposed to /reload. Real ordering (agent-session-runtime.js):
	//      teardownCurrent(): emit session_shutdown -> session.dispose() (ctx goes stale)
	//      createRuntime():   emit session_start for the NEW session
	//      ...later: the OLD in-flight /idle-summary's model await finally resolves.
	//    Because pi's resource loader caches the loaded extension set, session
	//    replacement reuses the SAME closure (unlike /reload, which clears the
	//    cache and gets a fresh one). A boolean `shutdown` reset by session_start
	//    would be cleared out from under the old run here, letting it slip past
	//    the guard and touch the new session's stale ctx. The `generation`
	//    counter has no reset to race against.
	resetScenario();
	const p4 = runSummary();
	handlers.session_shutdown({}, makeCtx()); // old session tears down: generation++
	stale = true; // session.dispose(): old ctx/pi are now stale
	handlers.session_start({}, makeCtx()); // new session starts; must NOT re-open the guard
	resolveComplete({ content: [], errorMessage: "rate limited" }); // old run's await returns
	await p4; // must NOT throw
	assert.equal(sendMessageCalls.length, 0, "session replacement must suppress sendMessage");
	assert.equal(notifyCalls.length, 0, "session replacement must bail before ctx.hasUI/notify");

	// 5. /idle-summary model routes to the model picker, not summary generation.
	resetScenario();
	await commands["idle-summary"].handler("model", makeCtx());
	assert.equal(selectCalls, 1, "/idle-summary model should open the model picker");
	assert.equal(sendMessageCalls.length, 0, "/idle-summary model should not generate a summary");
	assert.equal(notifyCalls.length, 0, "cancelled picker should notify nothing");

	// 5c. Root argument completion offers the `model` subcommand.
	const modelCompletions = commands["idle-summary"].getArgumentCompletions("");
	assert.ok(modelCompletions, "expected completion for empty prefix");
	assert.deepEqual(
		modelCompletions.map((i: any) => i.value),
		["model", "model clear"],
	);
	assert.deepEqual(commands["idle-summary"].getArgumentCompletions("model ")?.map((i: any) => i.value), ["model clear"]);
	assert.equal(commands["idle-summary"].getArgumentCompletions("mo")?.[0]?.value, "model");
	assert.equal(commands["idle-summary"].getArgumentCompletions("zzz"), null);

	// 5d. Non-interactive ctx: the picker path warns instead of generating.
	resetScenario();
	const headlessCtx = makeCtx({ hasUI: false });
	await commands["idle-summary"].handler("model", headlessCtx);
	assert.equal(selectCalls, 0, "no picker without a UI");
	assert.match(notifyCalls[notifyCalls.length - 1]?.message ?? "", /needs an interactive UI/);
	assert.equal(notifyCalls[notifyCalls.length - 1]?.type, "warning");
	assert.equal(sendMessageCalls.length, 0);

	console.log("  ✓ idle-summary stale-ctx regression: 4 scenarios passed");
	console.log("  ✓ idle-summary /idle-summary model dispatch: 3 checks passed");

	await testModelPin();
	console.log("  ✓ idle-summary model pin: resolution, notices, clear, picker");
}

const resolved = (text: string) => resolveComplete({ content: [{ type: "text", text }] });

async function testModelPin() {
	// A. A usable pin is the summary model.
	setConfig({ model: "openai/gpt-5.6-luna" });
	resetScenario();
	notifyCalls = [];
	const a = runSummary();
	resolved("pinned summary");
	await a;
	assert.equal(streamModels.length, 1, "one model call per run");
	assert.equal(streamModels[0].id, "gpt-5.6-luna", "the pinned model is used");
	assert.equal(sendMessageCalls[0]?.details?.model, "openai/gpt-5.6-luna");

	// B. An unusable pin falls back to the session model (one call, no chain).
	setConfig({ model: "x/y" });
	resetScenario();
	const b = runSummary();
	resolved("fallback summary");
	await b;
	assert.deepEqual(streamModels.map((m) => m.id), ["claude-haiku-4-5"], "the session model is used");
	assert.equal(sendMessageCalls[0]?.details?.model, "anthropic/claude-haiku-4-5");

	// C. A failed run is reported once with the existing text; no fallback chain.
	setConfig(undefined);
	resetScenario();
	const c = runSummary();
	resolveComplete({ content: [], errorMessage: "rate limited" });
	await c;
	assert.equal(streamModels.length, 1, "no second model is tried");
	assert.deepEqual(notifyCalls, [{ message: "idle-summary: no model produced a summary. rate limited", type: "warning" }]);

	// D. Unpriced session model still produces output; no model or an unpinned
	// model without auth bails silently.
	resetScenario();
	const unpriced = { provider: "openrouter", id: "z-ai/glm-5.2:free", api: "openai-completions" };
	const d = commands["idle-summary"].handler("", makeCtx({ model: unpriced }));
	resolved("free summary");
	await d;
	assert.equal(sendMessageCalls[0]?.details?.model, "openrouter/z-ai/glm-5.2:free");
	resetScenario();
	await commands["idle-summary"].handler("", makeCtx({ model: undefined }));
	const noAuthCtx = makeCtx();
	noAuthCtx.modelRegistry = { ...noAuthCtx.modelRegistry, hasConfiguredAuth: () => false };
	await commands["idle-summary"].handler("", noAuthCtx);
	assert.equal(streamModels.length, 0, "no call without a usable model");
	assert.equal(sendMessageCalls.length + notifyCalls.length, 0, "silent bail");

	// E. Ignored-pin notice: once per session, again after a new session_start.
	setConfig({ model: "x/y" });
	resetScenario(); // session_start #1 (notifies)
	const ignoredNotice = 'idle-summary: pinned model "x/y" ignored (not found); using the session model anthropic/claude-haiku-4-5.';
	const noticeCount = () => notifyCalls.filter((n) => n.message === ignoredNotice).length;
	assert.equal(noticeCount(), 1, "one notice at session start");
	assert.equal(notifyCalls.find((n) => n.message === ignoredNotice)?.type, "warning");
	const e = runSummary();
	resolved("summary");
	await e;
	assert.equal(noticeCount(), 1, "a run does not repeat the notice");
	handlers.session_start({}, makeCtx());
	assert.equal(noticeCount(), 2, "a new session reports it again");
	// A corrupt config reports the read warning; a stale ctx with a pin never throws.
	writeFileSync(configFile, "{ nope");
	notifyCalls = [];
	handlers.session_start({}, makeCtx());
	assert.match(notifyCalls[0]?.message ?? "", /^idle-summary: .*failed to read .*ignoring the model pin$/);
	setConfig({ model: "x/y" });
	stale = true;
	handlers.session_start({}, makeCtx()); // must NOT throw
	stale = false;

	// F. /idle-summary model clear: with and without a pin; timeoutMinutes survives.
	setConfig({ timeoutMinutes: 7 });
	resetScenario();
	await commands["idle-summary"].handler("model clear", makeCtx());
	assert.deepEqual(notifyCalls, [{ message: "No summary model pin set.", type: "info" }]);
	assert.equal(readFileSync(configFile, "utf8"), JSON.stringify({ timeoutMinutes: 7 }), "no write without a pin");
	setConfig({ model: "openai/gpt-5.6-luna", timeoutMinutes: 7 });
	resetScenario();
	await commands["idle-summary"].handler("model clear", makeCtx());
	assert.deepEqual(notifyCalls.map((n) => n.message), ["Summary model pin cleared; using the session model."]);
	assert.deepEqual(JSON.parse(readFileSync(configFile, "utf8")), { timeoutMinutes: 7 }, "timeoutMinutes survives the clear");
	resetScenario();
	await commands["idle-summary"].handler("model bogus", makeCtx());
	assert.equal(notifyCalls[0]?.type, "warning");
	assert.match(notifyCalls[0]?.message ?? "", /^Usage: \/idle-summary model/);
	assert.equal(sendMessageCalls.length, 0, "an unknown model sub-command never generates");

	// G. Picker: resolved model pre-highlighted; a pick writes the pin and
	// keeps timeoutMinutes; cancel writes nothing; a write error warns.
	setConfig({ timeoutMinutes: 7 });
	resetScenario();
	selectAnswer = "openai/gpt-5.6-luna";
	await commands["idle-summary"].handler("model", makeCtx());
	assert.deepEqual(selectItems[0], ["anthropic/claude-haiku-4-5", "openai/gpt-5.6-luna"], "the session model is first when unpinned");
	assert.deepEqual(JSON.parse(readFileSync(configFile, "utf8")), { timeoutMinutes: 7, model: "openai/gpt-5.6-luna" });
	assert.deepEqual(notifyCalls, [{ message: "Summary model set to openai/gpt-5.6-luna", type: "info" }]);
	resetScenario();
	await commands["idle-summary"].handler("model", makeCtx());
	assert.equal(selectItems[0][0], "openai/gpt-5.6-luna", "the pin is pre-highlighted");
	assert.equal(notifyCalls.length, 0, "cancel notifies nothing");
	assert.deepEqual(JSON.parse(readFileSync(configFile, "utf8")), { timeoutMinutes: 7, model: "openai/gpt-5.6-luna" }, "cancel writes nothing");
	setConfig(undefined);
	mkdirSync(configFile); // a directory where the file goes: the write fails
	resetScenario();
	notifyCalls = []; // session_start reported the unreadable file; only the write matters here
	selectAnswer = "openai/gpt-5.6-luna";
	await commands["idle-summary"].handler("model", makeCtx());
	assert.match(notifyCalls[0]?.message ?? "", /^idle-summary: could not save the summary model/);
	assert.ok(!notifyCalls.some((n) => n.message.startsWith("Summary model set to")), "no success after a failed write");
	setConfig(undefined);
	assert.equal(existsSync(configFile), false);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
