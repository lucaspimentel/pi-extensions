// Tests for the herdr-tab-name extension.
//
// Covers the pure decision helpers (reset reasons, pane actions, tab actions
// with the single-pane rule and the "pi" placeholder) and drives the REAL
// default export with a mock pi, a stubbed herdr runner, and herdr env vars
// set via process.env, to verify: named-session pane/tab renames, resets on
// /new, /resume, /fork, and name clears, the startup/reload exemption, the
// multi-pane and failed-tab-get suppression rules, subagent exclusion for
// both surfaces, burst ordering, and the outside-herdr no-op.
//
// Run: node tests/herdr-tab-name.test.mts
import assert from "node:assert/strict";

const mod = await import("../extensions/herdr-tab-name.ts");
const {
	UNNAMED_TAB_LABEL,
	cleanLabel,
	isSubagentSession,
	isResetReason,
	resolvePaneAction,
	resolveTabAction,
} = mod;

// ── Pure helpers ─────────────────────────────────────────────────────────────

assert.equal(cleanLabel("  a \n\t b  "), "a b");
assert.equal(cleanLabel("already clean"), "already clean");
assert.equal(cleanLabel("   "), "");

assert.equal(isResetReason("new"), true);
assert.equal(isResetReason("resume"), true);
assert.equal(isResetReason("fork"), true);
assert.equal(isResetReason("startup"), false);
assert.equal(isResetReason("reload"), false);
assert.equal(isResetReason(""), false);
assert.equal(isResetReason("bogus"), false);

assert.equal(isSubagentSession("general#1234ABCD"), true);
assert.equal(isSubagentSession("plain name"), false);
assert.equal(isSubagentSession("plain name", { parentSession: "/tmp/x.jsonl" }), true);

// Pane: named renames (cleaned), unnamed clears, subagents are ignored.
assert.deepEqual(resolvePaneAction("Fix auth bug", false), { kind: "rename", label: "Fix auth bug" });
assert.deepEqual(resolvePaneAction("  Fix \n auth  ", false), { kind: "rename", label: "Fix auth" });
assert.deepEqual(resolvePaneAction("", false), { kind: "clear" });
assert.deepEqual(resolvePaneAction(undefined, false), { kind: "clear" });
assert.deepEqual(resolvePaneAction("Anything", true), { kind: "none" });
assert.deepEqual(resolvePaneAction(undefined, true), { kind: "none" });

// Tab: single-pane only; unnamed becomes the placeholder; unknown count and
// multi-pane tabs are left alone; subagents are ignored.
assert.deepEqual(resolveTabAction("Fix auth bug", false, 1), { kind: "rename", label: "Fix auth bug" });
assert.deepEqual(resolveTabAction(undefined, false, 1), { kind: "rename", label: UNNAMED_TAB_LABEL });
assert.deepEqual(resolveTabAction("", false, 1), { kind: "rename", label: UNNAMED_TAB_LABEL });
assert.equal(UNNAMED_TAB_LABEL, "pi");
assert.deepEqual(resolveTabAction("Fix auth bug", false, 2), { kind: "none" });
assert.deepEqual(resolveTabAction(undefined, false, 2), { kind: "none" });
assert.deepEqual(resolveTabAction("Fix auth bug", false, undefined), { kind: "none" });
assert.deepEqual(resolveTabAction(undefined, false, undefined), { kind: "none" });
assert.deepEqual(resolveTabAction("Fix auth bug", true, 1), { kind: "none" });
assert.deepEqual(resolveTabAction(undefined, true, 1), { kind: "none" });

// ── Integration: real default export with mock pi and stub runner ────────────

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 25));

type Call = { args: string[]; ok: boolean };

type Harness = {
	calls: Call[];
	handlers: Map<string, (event: unknown, ctx: unknown) => Promise<void>>;
	fire: (event: string, payload: unknown) => Promise<void>;
	setName: (name: string | undefined) => void;
	setHeader: (header: { parentSession?: string } | undefined) => void;
	setPaneCount: (count: number | undefined) => void;
	setFailTabGet: (fail: boolean) => void;
};

const makeHarness = (): Harness => {
	const calls: Call[] = [];
	let paneCount: number | undefined = 1;
	let failTabGet = false;
	let currentName: string | undefined;
	let header: { parentSession?: string } | undefined;
	const run = async (args: string[]): Promise<string> => {
		const isTabGet = args[0] === "tab" && args[1] === "get";
		const ok = !(failTabGet && isTabGet);
		calls.push({ args, ok });
		if (!ok) throw new Error("herdr unavailable");
		if (isTabGet) {
			return JSON.stringify({ result: { tab: { pane_count: paneCount } }, type: "tab_info" });
		}
		return "";
	};
	const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
	const pi = {
		on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => {
			handlers.set(event, handler);
		},
		getSessionName: () => currentName,
	};
	const ctx = { sessionManager: { getHeader: () => header } };
	const fire = async (event: string, payload: unknown) => {
		const handler = handlers.get(event);
		assert.ok(handler, `no ${event} handler registered`);
		await handler(payload, ctx);
	};
	return {
		run,
		calls,
		handlers,
		pi,
		fire,
		setName: (n) => {
			currentName = n;
		},
		setHeader: (hdr) => {
			header = hdr;
		},
		setPaneCount: (n) => {
			paneCount = n;
		},
		setFailTabGet: (fail) => {
			failTabGet = fail;
		},
	};
};

// The factory's real signature takes ExtensionAPI; tests pass a mock through
// this loosened alias.
const loadExtension = mod.default as unknown as (
	pi: unknown,
	deps?: { run?: (args: string[]) => Promise<string> },
) => unknown;

// herdr env gate: set before the first loadExtension call, restored at the end.
const savedEnv = { ...process.env };
process.env.HERDR_ENV = "1";
process.env.HERDR_TAB_ID = "wX:t1";
process.env.HERDR_PANE_ID = "wX:p1";

const RESET_ARGS = ["pane", "rename", "wX:p1", "--clear"];
const tabGetArgs = () => ["tab", "get", "wX:t1"];
const paneRenameArgs = (label: string) => ["pane", "rename", "wX:p1", label];
const tabRenameArgs = (label: string) => ["tab", "rename", "wX:t1", label];

// Reset on /new: pane cleared, single-pane tab gets the placeholder.
{
	const h = makeHarness();
	loadExtension(h.pi, { run: h.run });
	await h.fire("session_start", { type: "session_start", reason: "new" });
	await flush();
	assert.deepEqual(
		h.calls.map((c) => c.args),
		[RESET_ARGS, tabGetArgs(), tabRenameArgs("pi")],
	);
}

// Reset on /resume and /fork; startup and reload are exempt.
for (const reason of ["resume", "fork"] as const) {
	const h = makeHarness();
	loadExtension(h.pi, { run: h.run });
	await h.fire("session_start", { type: "session_start", reason });
	await flush();
	assert.deepEqual(
		h.calls.map((c) => c.args),
		[RESET_ARGS, tabGetArgs(), tabRenameArgs("pi")],
		`reason ${reason} should reset`,
	);
}
for (const reason of ["startup", "reload"] as const) {
	const h = makeHarness();
	loadExtension(h.pi, { run: h.run });
	await h.fire("session_start", { type: "session_start", reason });
	await flush();
	assert.deepEqual(h.calls, [], `reason ${reason} must not touch herdr`);
}

// A named session renames regardless of the session_start reason.
{
	const h = makeHarness();
	loadExtension(h.pi, { run: h.run });
	h.setName("Fix  auth bug");
	await h.fire("session_start", { type: "session_start", reason: "startup" });
	await flush();
	assert.deepEqual(
		h.calls.map((c) => c.args),
		[paneRenameArgs("Fix auth bug"), tabGetArgs(), tabRenameArgs("Fix auth bug")],
	);
}

// session_info_changed: named renames; cleared (undefined or "") resets.
{
	const h = makeHarness();
	loadExtension(h.pi, { run: h.run });
	await h.fire("session_info_changed", { type: "session_info_changed", name: "Fix auth bug" });
	await flush();
	assert.deepEqual(
		h.calls.map((c) => c.args),
		[paneRenameArgs("Fix auth bug"), tabGetArgs(), tabRenameArgs("Fix auth bug")],
	);

	h.calls.length = 0;
	await h.fire("session_info_changed", { type: "session_info_changed", name: undefined });
	await flush();
	assert.deepEqual(
		h.calls.map((c) => c.args),
		[RESET_ARGS, tabGetArgs(), tabRenameArgs("pi")],
	);

	h.calls.length = 0;
	await h.fire("session_info_changed", { type: "session_info_changed", name: "" });
	await flush();
	assert.deepEqual(
		h.calls.map((c) => c.args),
		[RESET_ARGS, tabGetArgs(), tabRenameArgs("pi")],
	);
}

// Subagent exclusion covers both surfaces, rename and reset paths alike.
{
	const h = makeHarness();
	loadExtension(h.pi, { run: h.run });
	h.setName("general#1234ABCD");
	await h.fire("session_start", { type: "session_start", reason: "new" });
	await h.fire("session_info_changed", { type: "session_info_changed", name: "general#1234ABCD" });
	await flush();
	assert.deepEqual(h.calls, [], "subagent names must never touch herdr");

	h.calls.length = 0;
	h.setName("Plain Name");
	h.setHeader({ parentSession: "/tmp/parent.jsonl" });
	await h.fire("session_info_changed", { type: "session_info_changed", name: "Plain Name" });
	await flush();
	assert.deepEqual(h.calls, [], "parentSession header must suppress all herdr calls");
}

// Multi-pane tabs are never renamed, but the pane still is.
{
	const h = makeHarness();
	loadExtension(h.pi, { run: h.run });
	h.setPaneCount(2);
	await h.fire("session_info_changed", { type: "session_info_changed", name: "Fix auth bug" });
	await flush();
	assert.deepEqual(
		h.calls.map((c) => c.args),
		[paneRenameArgs("Fix auth bug"), tabGetArgs()],
	);

	h.calls.length = 0;
	await h.fire("session_info_changed", { type: "session_info_changed", name: undefined });
	await flush();
	assert.deepEqual(
		h.calls.map((c) => c.args),
		[RESET_ARGS, tabGetArgs()],
		"multi-pane unnamed reset clears the pane but leaves the tab alone",
	);
}

// A failed `herdr tab get` skips only the tab rename.
{
	const h = makeHarness();
	loadExtension(h.pi, { run: h.run });
	h.setFailTabGet(true);
	await h.fire("session_info_changed", { type: "session_info_changed", name: "Fix auth bug" });
	await flush();
	assert.deepEqual(
		h.calls.map((c) => c.args),
		[paneRenameArgs("Fix auth bug"), tabGetArgs()],
	);
	assert.equal(h.calls[1].ok, false, "tab get failure must be recorded and swallowed");
}

// Burst ordering: the last name wins for both surfaces.
{
	const h = makeHarness();
	loadExtension(h.pi, { run: h.run });
	for (const name of ["First Title", "Second Title", "Third Title"]) {
		await h.fire("session_info_changed", { type: "session_info_changed", name });
	}
	await flush();
	const paneLabels = h.calls.filter((c) => c.args[0] === "pane" && c.args[1] === "rename");
	const tabLabels = h.calls.filter((c) => c.args[0] === "tab" && c.args[1] === "rename");
	assert.equal(paneLabels.at(-1)?.args[3], "Third Title");
	assert.equal(tabLabels.at(-1)?.args[3], "Third Title");
}

// No-op outside herdr: missing env registers no handlers at all.
{
	process.env.HERDR_ENV = "0";
	const h = makeHarness();
	loadExtension(h.pi, { run: h.run });
	assert.deepEqual([...h.handlers.keys()], []);
}

// Restore the environment for any test run after this one.
process.env.HERDR_ENV = savedEnv.HERDR_ENV;
process.env.HERDR_TAB_ID = savedEnv.HERDR_TAB_ID;
process.env.HERDR_PANE_ID = savedEnv.HERDR_PANE_ID;

console.log("All herdr-tab-name tests passed.");
