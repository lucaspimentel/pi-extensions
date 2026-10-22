// Regression test: wt-tab-status must clear its "working" state on
// agent_settled, not on agent_end.
//
// agent_end fires when the model finishes a turn, but retries, overflow
// compaction, and queued follow-ups keep the agent effectively busy after it.
// Clearing on agent_end makes the tab flicker idle between those. The tab must
// only return to idle when agent_settled fires (all automatic processing done).
//
// This test drives the REAL extension factory with a mocked event registry and
// a mocked ctx.ui, capturing raw stdout so OSC 9;4 writes are asserted exactly.
// It is serial by construction: every scenario uses its own instance + ui
// object, and stdout capture is swapped in/out around synchronous dispatch.
//
// Run: node --test tests/wt-tab-status-lifecycle.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

process.env.WT_SESSION = process.env.WT_SESSION ?? "test-session"; // extension no-ops otherwise

const wtTabStatus = (await import("../extensions/wt-tab-status/index.ts")).default;

const CWD_BASE = path.basename(process.cwd());
const IDLE_TITLE = `✅ π - sess - ${CWD_BASE}`;
const WORKING_TITLE = `π - sess - ${CWD_BASE}`;
const WAITING_TITLE = `❓ π - sess - ${CWD_BASE}`;
const ERROR_TITLE = `❌ π - sess - ${CWD_BASE}`;
const OSC_HIDE = "\x1b]9;4;0;0\x07";
const OSC_SPIN = "\x1b]9;4;3;0\x07";

// ── Per-scenario harness ─────────────────────────────────────────────────────

type Handlers = Record<string, (event: any, ctx: any) => Promise<void> | void>;

function loadInstance(): Handlers {
	const handlers: Handlers = {};
	const pi: any = {
		on(event: string, handler: any) {
			handlers[event] = handler;
		},
		getSessionName: () => "sess",
	};
	wtTabStatus(pi);
	return handlers;
}

interface Scenario {
	handlers: Handlers;
	titles: string[];
	osc: string[];
	ctx: any;
	/** Raw stdout OSC capture; starts empty and accumulates until stopCapture. */
	startCapture(): void;
	stopCapture(): void;
	shutdown(): Promise<void>;
}

function makeCtx(ui: Record<string, any>, opts: { mode?: string; hasUI?: boolean } = {}) {
	return {
		hasUI: opts.hasUI ?? true,
		mode: opts.mode ?? "tui",
		ui,
	};
}

function startScenario(opts: { mode?: string; hasUI?: boolean } = {}): Scenario {
	const handlers = loadInstance();
	const titles: string[] = [];
	let osc: string[] = [];
	const ui: Record<string, any> = {
		setTitle: (t: string) => titles.push(t),
		confirm: async () => true,
		select: async () => undefined,
		input: async () => undefined,
		editor: async () => undefined,
		custom: async () => undefined,
	};
	const ctx = makeCtx(ui, opts);
	const originalWrite = process.stdout.write.bind(process.stdout);
	return {
		handlers,
		titles,
		get osc() {
			return osc;
		},
		ctx,
		startCapture() {
			osc = [];
			// Swallow OSC writes so escape codes never reach the terminal; pass
			// everything else through untouched.
			process.stdout.write = ((chunk: any, ...rest: any[]) => {
				if (typeof chunk === "string" && chunk.includes("\x1b]9;4;")) {
					osc.push(chunk);
					return true;
				}
				return originalWrite(chunk, ...rest);
			}) as any;
		},
		stopCapture() {
			process.stdout.write = originalWrite as any;
		},
		async shutdown() {
			await handlers.session_shutdown?.({ reason: "end" }, ctx);
		},
	};
}

// ── The core lifecycle: settlement, not intermediate ends, ends the busy span ─

test("agent_settled ends the working span; agent_end does not", async () => {
	const sc = startScenario();
	try {
		await sc.handlers.session_start({}, sc.ctx);
		assert.deepEqual(sc.titles, [IDLE_TITLE], "session_start shows initial idle");
		sc.startCapture();

		await sc.handlers.agent_start({}, sc.ctx);
		assert.deepEqual(sc.titles, [IDLE_TITLE, WORKING_TITLE], "first start shows working");
		assert.deepEqual(sc.osc, [OSC_SPIN], "first start starts the spinner");

		// Intermediate turn boundaries: no idle flash, no duplicate writes.
		await sc.handlers.agent_end?.({}, sc.ctx); // absent after the fix; no-op if present
		assert.deepEqual(sc.titles, [IDLE_TITLE, WORKING_TITLE], "agent_end must not change the title");
		assert.deepEqual(sc.osc, [OSC_SPIN], "agent_end must not touch the spinner");

		await sc.handlers.agent_start({}, sc.ctx); // queued follow-up: still working, deduped
		assert.deepEqual(sc.titles, [IDLE_TITLE, WORKING_TITLE], "repeated start must not rewrite the title");
		assert.deepEqual(sc.osc, [OSC_SPIN], "repeated start must not rewrite the spinner");

		await sc.handlers.agent_end?.({}, sc.ctx);
		assert.deepEqual(sc.titles, [IDLE_TITLE, WORKING_TITLE], "second agent_end must not change the title");
		assert.deepEqual(sc.osc, [OSC_SPIN], "second agent_end must not touch the spinner");

		// Settlement is the single transition to idle.
		await sc.handlers.agent_settled?.({ aborted: false }, sc.ctx);
		assert.deepEqual(sc.titles, [IDLE_TITLE, WORKING_TITLE, IDLE_TITLE], "settlement shows idle");
		assert.deepEqual(sc.osc, [OSC_SPIN, OSC_HIDE], "settlement hides the spinner");
	} finally {
		sc.stopCapture();
		await sc.shutdown();
	}
});

test("agent_settled is registered as a required handler", () => {
	const handlers = loadInstance();
	assert.ok(handlers.agent_settled, "agent_settled must be registered");
	assert.ok(!handlers.agent_end, "agent_end must no longer be registered");
});

test("aborted settlement also clears working", async () => {
	const sc = startScenario();
	try {
		await sc.handlers.session_start({}, sc.ctx);
		sc.startCapture();
		await sc.handlers.agent_start({}, sc.ctx);
		await sc.handlers.agent_settled?.({ aborted: true }, sc.ctx);
		assert.deepEqual(sc.titles, [IDLE_TITLE, WORKING_TITLE, IDLE_TITLE], "aborted settlement shows idle");
		assert.deepEqual(sc.osc, [OSC_SPIN, OSC_HIDE], "aborted settlement hides the spinner");
	} finally {
		sc.stopCapture();
		await sc.shutdown();
	}
});

// ── Dialogs ──────────────────────────────────────────────────────────────────

test("dialog close before settlement returns to working; over idle after settlement", async () => {
	const sc = startScenario();
	try {
		await sc.handlers.session_start({}, sc.ctx);
		sc.startCapture();
		await sc.handlers.agent_start({}, sc.ctx);
		assert.deepEqual(sc.titles, [IDLE_TITLE, WORKING_TITLE]);

		await sc.ctx.ui.confirm("Allow?", "run tool"); // wrapper dispatches open/close
		assert.deepEqual(
			sc.titles,
			[IDLE_TITLE, WORKING_TITLE, WAITING_TITLE, WORKING_TITLE],
			"dialog shows waiting, close returns to working",
		);

		await sc.handlers.agent_settled?.({ aborted: false }, sc.ctx);
		assert.deepEqual(
			sc.titles,
			[IDLE_TITLE, WORKING_TITLE, WAITING_TITLE, WORKING_TITLE, IDLE_TITLE],
			"settlement shows idle",
		);

		// Dialog over the idle tab: waiting, then back to idle.
		await sc.ctx.ui.confirm("Allow?", "again");
		assert.deepEqual(
			sc.titles,
			[IDLE_TITLE, WORKING_TITLE, WAITING_TITLE, WORKING_TITLE, IDLE_TITLE, WAITING_TITLE, IDLE_TITLE],
			"dialog over idle shows waiting then idle",
		);
	} finally {
		sc.stopCapture();
		await sc.shutdown();
	}
});

// ── Sticky error through settlement ──────────────────────────────────────────

test("unrecovered tool error survives settlement; later success exposes idle", async () => {
	const sc = startScenario();
	try {
		await sc.handlers.session_start({}, sc.ctx);
		sc.startCapture();
		await sc.handlers.agent_start({}, sc.ctx);
		await sc.handlers.tool_result({ isError: true }, sc.ctx);
		assert.deepEqual(sc.titles, [IDLE_TITLE, WORKING_TITLE, ERROR_TITLE], "tool error shows error");

		// Settlement preserves the sticky error: state stays error, deduped, no write.
		await sc.handlers.agent_settled?.({ aborted: false }, sc.ctx);
		assert.deepEqual(
			sc.titles,
			[IDLE_TITLE, WORKING_TITLE, ERROR_TITLE],
			"settlement keeps the sticky error (deduped, no rewrite)",
		);

		// With agentRunning already cleared, a successful tool result lands on idle.
		await sc.handlers.tool_result({ isError: false }, sc.ctx);
		assert.deepEqual(
			sc.titles,
			[IDLE_TITLE, WORKING_TITLE, ERROR_TITLE, IDLE_TITLE],
			"later successful tool result exposes idle (agentRunning already cleared)",
		);

		await sc.handlers.agent_settled?.({ aborted: false }, sc.ctx);
		assert.deepEqual(
			sc.titles,
			[IDLE_TITLE, WORKING_TITLE, ERROR_TITLE, IDLE_TITLE],
			"final settlement is deduped (already idle)",
		);
	} finally {
		sc.stopCapture();
		await sc.shutdown();
	}
});

// ── Dedupe and shutdown ──────────────────────────────────────────────────────

test("repeated settlement produces no duplicate output", async () => {
	const sc = startScenario();
	try {
		await sc.handlers.session_start({}, sc.ctx);
		sc.startCapture();
		await sc.handlers.agent_start({}, sc.ctx);
		await sc.handlers.agent_settled?.({ aborted: false }, sc.ctx);
		await sc.handlers.agent_settled?.({ aborted: false }, sc.ctx);
		assert.deepEqual(sc.titles, [IDLE_TITLE, WORKING_TITLE, IDLE_TITLE], "second settlement is deduped");
		assert.deepEqual(sc.osc, [OSC_SPIN, OSC_HIDE], "second settlement writes no OSC");
	} finally {
		sc.stopCapture();
		await sc.shutdown();
	}
});

test("shutdown during active work clears running without settlement", async () => {
	const sc = startScenario();
	try {
		await sc.handlers.session_start({}, sc.ctx);
		sc.startCapture();
		await sc.handlers.agent_start({}, sc.ctx);
		await sc.handlers.session_shutdown({ reason: "end" }, sc.ctx);
		assert.deepEqual(sc.titles, [IDLE_TITLE, WORKING_TITLE, IDLE_TITLE], "shutdown shows idle");
		assert.deepEqual(sc.osc, [OSC_SPIN, OSC_HIDE], "shutdown hides the spinner");
		sc.stopCapture();
	} finally {
		sc.stopCapture();
	}
});

// ── Modes ────────────────────────────────────────────────────────────────────

test("RPC mode (hasUI, mode=rpc): titles update, no raw stdout writes", async () => {
	const sc = startScenario({ mode: "rpc" });
	try {
		await sc.handlers.session_start({}, sc.ctx);
		sc.startCapture();
		await sc.handlers.agent_start({}, sc.ctx);
		await sc.handlers.agent_settled?.({ aborted: false }, sc.ctx);
		assert.deepEqual(
			sc.titles,
			[IDLE_TITLE, WORKING_TITLE, IDLE_TITLE],
			"RPC mode still updates the tab title",
		);
		assert.deepEqual(sc.osc, [], "RPC mode must never write OSC to raw stdout");
	} finally {
		sc.stopCapture();
		await sc.shutdown();
	}
});

test("hasUI false: no title and no OSC output", async () => {
	const sc = startScenario({ hasUI: false });
	try {
		await sc.handlers.session_start({}, sc.ctx);
		sc.startCapture();
		await sc.handlers.agent_start({}, sc.ctx);
		await sc.handlers.agent_settled?.({ aborted: false }, sc.ctx);
		assert.deepEqual(sc.titles, [], "headless mode writes no titles");
		assert.deepEqual(sc.osc, [], "headless mode writes no OSC");
	} finally {
		sc.stopCapture();
		await sc.shutdown();
	}
});

test("missing WT_SESSION: extension registers no handlers (no-op)", () => {
	const hadSession = "WT_SESSION" in process.env;
	const saved = process.env.WT_SESSION;
	try {
		delete process.env.WT_SESSION;
		const handlers = loadInstance();
		assert.deepEqual(Object.keys(handlers), [], "extension must be a no-op outside Windows Terminal");
	} finally {
		if (hadSession) process.env.WT_SESSION = saved;
	}
});
