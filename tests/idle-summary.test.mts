// Regression test for the stale-ctx leak in the idle-summary extension.
//
// Drives the REAL default export with a mock `pi`/`ctx`. The /summary command
// handler awaits generateAndShowSummary(ctx) with no .catch, so if a
// /reload or session replacement invalidates the ctx during the model
// complete() await, any post-await ctx/pi touch throws the stale-ctx error
// and propagates. The fix bails on a `shutdown` flag set by session_shutdown
// (which fires before the runner is invalidated) before touching ctx/pi.
//
// Run: node tests/idle-summary.test.mts
import assert from "node:assert/strict";

const idleSummary = (await import("../extensions/idle-summary/index.ts")).default;

// ── Mock pi: capture event handlers + command + sendMessage ─────────────────
const handlers: Record<string, (event: any, ctx: any) => unknown> = {};
const commands: Record<string, any> = {};
let sendMessageCalls: any[] = [];
let notifyCalls: Array<{ message: string; type?: string }> = [];

const pi: any = {
	on(event: string, handler: any) {
		handlers[event] = handler;
	},
	registerCommand(name: string, opts: any) {
		commands[name] = opts;
	},
	registerMessageRenderer() {},
	sendMessage(msg: any) {
		sendMessageCalls.push(msg);
	},
};

idleSummary(pi);

assert.ok(commands.summary, "/summary command should be registered");
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

function makeCtx(): any {
	return {
		get hasUI() {
			if (stale) throw STALE_ERR;
			return true;
		},
		mode: "tui",
		cwd: process.cwd(),
		scopedModels: [],
		model: undefined,
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
			complete: async () => completePromise,
		},
		ui: {
			notify: (message: string, type?: string) => {
				if (stale) throw STALE_ERR;
				notifyCalls.push({ message, type });
			},
		},
	};
}

function resetScenario() {
	stale = false;
	sendMessageCalls = [];
	notifyCalls = [];
	completePromise = new Promise<any>((r) => {
		resolveComplete = r;
	});
	handlers.session_start({}, makeCtx()); // resets the `shutdown` flag
}

async function runSummary() {
	await commands.summary.handler("", makeCtx());
}

// ── Tests ─────────────────────────────────────────────────────────────────

async function main() {
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
	//    (Previously: pi.sendMessage would throw stale-ctx and propagate from /summary.)
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

	console.log("  ✓ idle-summary stale-ctx regression: 3 scenarios passed");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
