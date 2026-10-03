// Tests for ask-overlay.ts (ctrl+] hide/show ask dialogs).
//
// ask-overlay.ts has no runtime external imports (dependencies are injected by
// index.ts), so this suite can import it directly under
// `node --experimental-strip-types` without the host packages installed.

import { makeTestRunner } from "./test-helpers.mjs";
import { createAskSelect } from "./ask-overlay.ts";

const { test, section, summary } = makeTestRunner();

// ── Stubs ─────────────────────────────────────────────────────────────────

/** Records constructor args; mimics the subset of ExtensionSelectorComponent ask-overlay uses. */
function makeSelectorStub() {
	const instances = [];
	class StubSelector {
		constructor(title, options, onSelect, onCancel, opts) {
			this.title = title;
			this.options = options;
			this.onSelect = onSelect;
			this.onCancel = onCancel;
			this.opts = opts;
			this.inputLog = [];
			this.disposed = false;
			instances.push(this);
		}
		render() {
			return [`selector(${this.title})`];
		}
		handleInput(data) {
			this.inputLog.push(data);
		}
		dispose() {
			this.disposed = true;
		}
	}
	return { StubSelector, instances };
}

/** Fake ExtensionContext: captures select/custom/onTerminalInput calls. */
function makeCtx({ mode = "tui", withRawInput = true } = {}) {
	const selectCalls = [];
	let customFactory;
	let customOptions;
	let customResolve;
	let terminalHandler;
	const unsubscribed = { count: 0 };
	const notifies = [];
	const ui = {
		select: async (title, options) => {
			selectCalls.push({ title, options });
			return "from-select";
		},
		custom: async (factory, options) => {
			customFactory = factory;
			customOptions = options;
			return new Promise((resolve) => {
				customResolve = resolve;
			});
		},
		notify: (message, type) => notifies.push({ message, type }),
	};
	if (withRawInput) {
		// Host without the raw input hook: omit the method entirely so the
		// typeof guard in askSelect takes the fallback path.
		ui.onTerminalInput = (handler) => {
			terminalHandler = handler;
			return () => {
				unsubscribed.count++;
			};
		};
	}
	const ctx = { mode, ui };
	return { ctx, selectCalls, notifies, getFactory: () => customFactory, getOptions: () => customOptions, done: (result) => customResolve?.(result), getHandler: () => terminalHandler, unsubscribed };
}

/** Fake OverlayHandle with togglable hidden/focused state. */
function makeHandle({ focused = true, hidden = false } = {}) {
	const calls = [];
	return {
		calls,
		isFocused: () => focused,
		isHidden: () => hidden,
		setHidden: (h) => calls.push(h),
	};
}

const REAL_KEY = "\x1d"; // ctrl+] control byte

const { StubSelector, instances } = makeSelectorStub();

const deps = {
	matchesKey: (data, key) => key === "ctrl+]" && data === REAL_KEY,
	isKeyRelease: () => false,
	isKeyRepeat: () => false,
	ExtensionSelectorComponent: StubSelector,
};

// ── Non-TUI fallback ──────────────────────────────────────────────────────

section("Non-TUI fallback");

{
	const { ctx, selectCalls, getFactory, unsubscribed } = makeCtx({ mode: "rpc" });
	const result = await createAskSelect(deps)(ctx, "t", ["a"]);
	test("rpc mode delegates to ctx.ui.select", result, "from-select");
	test("rpc mode makes exactly one select call", selectCalls.length, 1);
	test("rpc mode never opens a custom dialog", getFactory(), undefined);
	test("rpc mode registers no raw listener", unsubscribed.count, 0);
}

{
	const { ctx, getFactory } = makeCtx({ mode: "print" });
	await createAskSelect(deps)(ctx, "t", ["a"]);
	test("print mode never opens a custom dialog", getFactory(), undefined);
}

{
	// Host without onTerminalInput (older pi): must not crash.
	const { ctx, getFactory } = makeCtx({ withRawInput: false });
	const result = await createAskSelect(deps)(ctx, "t", ["a"]);
	test("missing onTerminalInput falls back to select", result, "from-select");
	test("missing onTerminalInput opens no custom dialog", getFactory(), undefined);
}

// ── TUI path: overlay construction ────────────────────────────────────────

section("TUI overlay construction");

{
	const { ctx, selectCalls, getFactory, getOptions } = makeCtx();
	const promise = createAskSelect(deps)(ctx, "Big title", ["Allow once", "Deny once"]);
	await Promise.resolve();
	test("tui mode does not call ctx.ui.select", selectCalls.length, 0);
	const factory = getFactory();
	test("tui mode builds a factory", typeof factory, "function");
	const options = getOptions();
	test("overlay mode enabled", options?.overlay, true);
	test("overlay options present", typeof options?.overlayOptions?.anchor, "string");
	const component = factory({}, { fg: (c, s) => `<${c}>${s}</>` }, {}, () => {});
	test("selector receives title and choices", instances.at(-1)?.title, "Big title");
	const lines = component.render(40);
	test("component renders selector output", lines.some((l) => l.includes("selector(Big title)")), true);
	test("component renders hint line", lines.some((l) => l.includes("ctrl+] hide/show")), true);
	test("hint line is dim-styled", lines.some((l) => l.includes("<dim>ctrl+] hide/show</>")), true);
	component.handleInput("x");
	test("wrapper delegates input to selector", JSON.stringify(instances.at(-1)?.inputLog), JSON.stringify(["x"]));
	// The dialog promise stays pending here (done is never called); do not await it.
	void promise;
}

// ── Selection and cancel resolve ──────────────────────────────────────────

section("Resolution");

{
	const { ctx, done, getFactory, unsubscribed } = makeCtx();
	const promise = createAskSelect(deps)(ctx, "t", ["a", "b"]);
	await Promise.resolve();
	const factory = getFactory();
	const component = factory({}, { fg: (_c, s) => s }, {}, done);
	const selector = instances.at(-1);
	selector.onSelect("a");
	test("onSelect resolves the chosen label", await promise, "a");
	test("listener removed after resolution", unsubscribed.count, 1);
	// dispose delegation: the host's close() calls component.dispose(), which
	// must reach the selector (it owns the optional countdown timer).
	component.dispose();
	test("dispose delegates to selector", selector.disposed, true);
	void component;
}

{
	const { ctx, done, getFactory, unsubscribed } = makeCtx();
	const promise = createAskSelect(deps)(ctx, "t", ["a"]);
	await Promise.resolve();
	const factory = getFactory();
	const component = factory({}, { fg: (_c, s) => s }, {}, done);
	instances.at(-1).onCancel();
	test("onCancel resolves undefined", await promise, undefined);
	test("listener removed after cancel", unsubscribed.count, 1);
	void component;
}

// ── ctrl+] toggle behavior ────────────────────────────────────────────────

section("ctrl+] toggle");

{
	const { ctx, done, getFactory, getHandler, getOptions, notifies } = makeCtx();
	const promise = createAskSelect(deps)(ctx, "t", ["a"]);
	await Promise.resolve();
	const factory = getFactory();
	const component = factory({}, { fg: (_c, s) => s }, {}, done);

	// Before the handle exists, the raw listener is a no-op.
	test("no handle yet: keystroke ignored", getHandler()(REAL_KEY), undefined);

	// Visible + focused: first press hides.
	const handle = makeHandle({ focused: true, hidden: false });
	getOptions().onHandle(handle);
	test("focused press toggles to hidden", JSON.stringify(getHandler()(REAL_KEY)), JSON.stringify({ consume: true }));
	test("setHidden(true) called", JSON.stringify(handle.calls), JSON.stringify([true]));
	test("hide announces once", JSON.stringify(notifies), JSON.stringify([{ message: "Prompt hidden: press ctrl+] to reopen", type: "info" }]));

	// Hidden: second press re-shows (raw listener is what makes this possible).
	const hiddenHandle = makeHandle({ focused: false, hidden: true });
	getOptions().onHandle(hiddenHandle);
	test("hidden press toggles back to visible", JSON.stringify(getHandler()(REAL_KEY)), JSON.stringify({ consume: true }));
	test("setHidden(false) called", JSON.stringify(hiddenHandle.calls), JSON.stringify([false]));
	test("hide announced only once", notifies.length, 1);

	// Other keys pass through untouched.
	test("unrelated key passes through", getHandler()("q"), undefined);

	// Kitty release/repeat events are consumed but never toggle.
	const releaseHandle = makeHandle({ focused: true, hidden: false });
	getOptions().onHandle(releaseHandle);
	const releaseDeps = { ...deps, isKeyRelease: () => true };
	const releaseSelect = createAskSelect(releaseDeps);
	const p2 = releaseSelect(ctx, "t2", ["a"]);
	await Promise.resolve();
	const f2 = getFactory();
	const c2 = f2({}, { fg: (_c, s) => s }, {}, done);
	const h2 = makeHandle({ focused: true, hidden: false });
	getOptions().onHandle(h2);
	test("key release consumed without toggling", JSON.stringify(getHandler()(REAL_KEY)), JSON.stringify({ consume: true }));
	test("key release made no setHidden call", JSON.stringify(h2.calls), JSON.stringify([]));
	void component;
	void c2;
	void p2; // left pending on purpose (done never called for the second stub dialog)
}

{
	// Overlay on top of ours (not focused, not hidden): never toggle underneath it.
	const { ctx, done, getFactory, getHandler, getOptions } = makeCtx();
	const promise = createAskSelect(deps)(ctx, "t", ["a"]);
	await Promise.resolve();
	const factory = getFactory();
	const component = factory({}, { fg: (_c, s) => s }, {}, done);
	const handle = makeHandle({ focused: false, hidden: false });
	getOptions().onHandle(handle);
	test("unfocused visible overlay: keystroke left to other overlays", getHandler()(REAL_KEY), undefined);
	test("no setHidden call while unfocused", JSON.stringify(handle.calls), JSON.stringify([]));
	void promise; // left pending on purpose
}

process.exitCode = summary();