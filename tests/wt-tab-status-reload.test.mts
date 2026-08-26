// Regression test: wt-tab-status must not leave stale ctx.ui dialog wrappers
// behind across /reload.
//
// pi reuses ONE ExtensionUIContext object for the whole process: AgentSession
// .reload() keeps `_extensionUIContext` and hands the same object to the new
// runner, while `oldRunner.invalidate()` makes the old ctx stale. Nothing in
// InteractiveMode.resetExtensionUI() restores monkey-patched ui methods.
//
// So an extension that wraps ctx.ui.confirm/select/... and captures `ctx` in the
// wrapper leaves a wrapper holding a dead ctx installed on the shared object.
// The next dialog then throws:
//   "This extension ctx is stale after session replacement or reload."
// and each reload stacks another layer.
//
// This test simulates that lifecycle: one shared `ui`, N reload cycles, then a
// dialog. It fails if any dialog touches a stale ctx or if wrappers stack.
//
// Run: node tests/wt-tab-status-reload.test.mts
import assert from "node:assert/strict";

process.env.WT_SESSION = process.env.WT_SESSION ?? "test-session"; // extension no-ops otherwise

const wtTabStatus = (await import("../extensions/wt-tab-status/index.ts")).default;

const STALE_MSG =
	"This extension ctx is stale after session replacement or reload. " +
	"Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), " +
	"ctx.switchSession(), or ctx.reload().";

// ── The single, process-wide ui object (what pi actually does) ───────────────
const titles: string[] = [];
let confirmCalls = 0;

const sharedUi: Record<string, any> = {
	setTitle: (t: string) => titles.push(t),
	confirm: async (_title: string, _message: string) => {
		confirmCalls++;
		return true;
	},
	select: async () => undefined,
	input: async () => undefined,
	editor: async () => undefined,
	custom: async () => undefined,
};

// ── One extension instance == one runner generation ─────────────────────────
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

// A ctx whose getters throw once invalidated, mirroring runner.assertActive().
function makeCtx() {
	let stale = false;
	const ctx: any = {
		get hasUI() {
			if (stale) throw new Error(STALE_MSG);
			return true;
		},
		get ui() {
			if (stale) throw new Error(STALE_MSG);
			return sharedUi;
		},
		get cwd() {
			if (stale) throw new Error(STALE_MSG);
			return process.cwd();
		},
	};
	return { ctx, invalidate: () => (stale = true) };
}

/** One full reload generation: session_start .. session_shutdown + invalidate. */
async function reloadCycle() {
	const handlers = loadInstance();
	const { ctx, invalidate } = makeCtx();
	await handlers.session_start?.({}, ctx);
	await handlers.agent_start?.({}, ctx);
	await handlers.agent_end?.({}, ctx);
	// /reload: session_shutdown fires, THEN the runner is invalidated.
	await handlers.session_shutdown?.({ reason: "reload" }, ctx);
	invalidate();
	return handlers;
}

async function main() {
	// Generation 0, then two reloads — the stacking case.
	await reloadCycle();
	await reloadCycle();

	// Live generation after the reloads.
	const handlers = loadInstance();
	const { ctx } = makeCtx();
	await handlers.session_start?.({}, ctx);

	// A dialog goes through whatever wrappers are installed on the shared ui.
	// Pre-fix this threw the stale-ctx error from a dead generation's wrapper.
	confirmCalls = 0;
	const answer = await sharedUi.confirm("Allow?", "run tool");
	assert.equal(answer, true, "dialog should return the underlying result");
	assert.equal(confirmCalls, 1, "underlying confirm should run exactly once (no stacked wrappers)");

	// The live generation still tracks dialog state (waiting -> idle).
	await handlers.agent_start?.({}, ctx);
	titles.length = 0;
	await sharedUi.confirm("Allow?", "again");
	assert.ok(
		titles.some((t) => t.includes("❓")),
		"live instance should still show the waiting glyph while a dialog is open",
	);

	// Dialogs resolving after shutdown must not throw either.
	await handlers.session_shutdown?.({ reason: "reload" }, ctx);
	const late = await sharedUi.confirm("Allow?", "after shutdown");
	assert.equal(late, true, "dialog after session_shutdown should not throw");

	console.log("  ✓ wt-tab-status reload regression: no stale ctx.ui wrappers, no stacking");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
