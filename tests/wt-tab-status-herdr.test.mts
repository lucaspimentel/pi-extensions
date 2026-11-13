// Regression test: wt-tab-status must be a complete no-op inside herdr.
//
// herdr owns the Windows Terminal tab title and shows its own per-pane
// working/blocked state, so the extension's setTitle(...) override and its
// OSC 9;4 spinner would fight herdr's surfaces. The extension therefore
// returns early when HERDR_ENV === "1" (the marker extensions/herdr-tab-name.ts
// gates on) and registers no handlers at all.
//
// This test drives the REAL extension factory with a mocked event registry
// and a mocked ctx.ui, mutating process.env per scenario (the gate is read at
// registration time, so env mutation between instances works).
//
// Run: node --test tests/wt-tab-status-herdr.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const wtTabStatusModule = await import("../extensions/wt-tab-status/index.ts");
const wtTabStatus = wtTabStatusModule.default;
const { isHerdrSession } = wtTabStatusModule;

const CWD_BASE = path.basename(process.cwd());
const IDLE_TITLE = `✅ π - sess - ${CWD_BASE}`;
const OSC_HIDE = "\x1b]9;4;0;0\x07";

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

/** Runs body with the given env applied, restoring the previous values after. */
async function withEnv(
	env: Record<string, string | undefined>,
	body: () => void | Promise<void>,
): Promise<void> {
	const saved = Object.keys(env).map((k) => [k, process.env[k]] as const);
	try {
		for (const [k, v] of Object.entries(env)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		await body();
	} finally {
		for (const [k, v] of saved) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
}

interface Scenario {
	handlers: Handlers;
	titles: string[];
	osc: string[];
	ctx: any;
	startCapture(): void;
	stopCapture(): void;
}

function startScenario(): Scenario {
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
	const ctx = { hasUI: true, mode: "tui", ui };
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
	};
}

// ── The gate ────────────────────────────────────────────────────────────────

test("HERDR_ENV=1: extension registers no handlers (full no-op)", async () => {
	await withEnv({ WT_SESSION: "test-session", HERDR_ENV: "1" }, () => {
		const handlers = loadInstance();
		assert.deepEqual(
			Object.keys(handlers),
			[],
			"extension must register nothing inside herdr: no title, no OSC, no ctx.ui wrapping",
		);
	});
});

test("control: without HERDR_ENV the extension is active and writes title + OSC", async () => {
	await withEnv({ WT_SESSION: "test-session", HERDR_ENV: undefined }, async () => {
		const sc = startScenario();
		try {
			assert.notDeepEqual(Object.keys(sc.handlers), [], "extension must be active outside herdr");
			sc.startCapture();
			await sc.handlers.session_start({}, sc.ctx);
			assert.deepEqual(sc.titles, [IDLE_TITLE], "session_start shows initial idle");
			assert.deepEqual(sc.osc, [OSC_HIDE], "session_start hides the spinner");
		} finally {
			sc.stopCapture();
		}
	});
});

test("missing WT_SESSION: no-op even without herdr", async () => {
	await withEnv({ WT_SESSION: undefined, HERDR_ENV: undefined }, () => {
		const handlers = loadInstance();
		assert.deepEqual(
			Object.keys(handlers),
			[],
			"extension must be a no-op outside Windows Terminal",
		);
	});
});

test("HERDR_ENV=1 without WT_SESSION: still a no-op", async () => {
	await withEnv({ WT_SESSION: undefined, HERDR_ENV: "1" }, () => {
		const handlers = loadInstance();
		assert.deepEqual(Object.keys(handlers), [], "both gates are no-ops");
	});
});

test("isHerdrSession matches only the exact string \"1\"", () => {
	assert.equal(isHerdrSession({ HERDR_ENV: "1" }), true);
	assert.equal(isHerdrSession({}), false);
	assert.equal(isHerdrSession({ HERDR_ENV: "" }), false);
	assert.equal(isHerdrSession({ HERDR_ENV: "0" }), false);
	assert.equal(isHerdrSession({ HERDR_ENV: "true" }), false);
});
