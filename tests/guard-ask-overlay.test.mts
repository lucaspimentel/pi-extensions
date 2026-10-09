// Adapter-level tests for the guard-owned hideable dialog overlay
// (extensions/guard/ask-overlay.ts). Fake-host tests cover the native
// fallback, the widget-bridge lifecycle, ctrl+] toggle semantics, bounded
// rendering, settlement, and the cancellation contract. Real pi-tui tests
// over a controlled terminal boundary cover layout, hide/show, selection
// survival, and the foreign-overlay ownership guarantee. Wiring through the
// registered guard handlers is covered in tests/guard-dialogs.test.mts.
// Run: node --test tests/guard-ask-overlay.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";

import { ExtensionSelectorComponent, initTheme, InteractiveMode } from "@earendil-works/pi-coding-agent";
import {
	isKeyRelease,
	isKeyRepeat,
	matchesKey,
	stripTerminalSequences,
	Text,
	TuiMainScreen,
} from "@earendil-works/pi-tui";
import { createGuardAskSelect } from "../extensions/guard/ask-overlay.ts";

initTheme("dark", false);

const THEME = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const CTRL_BRACKET = "\x1d"; // ctrl+] control byte
const KITTY_PRESS = "\x1b[93;5u";
const KITTY_REPEAT = "\x1b[93;5:2u";
const KITTY_RELEASE = "\x1b[93;5:3u";
const ENTER = "\r";
const ESC = "\x1b";
const DOWN = "\x1b[B";
const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";
const HIDE_HINT = "hide/show";

const askSelect = createGuardAskSelect({ matchesKey, isKeyRelease, isKeyRepeat, ExtensionSelectorComponent });

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function longTitle(lines: number): string {
	return ["guard: host_bash", "ask rule matched", ...Array.from({ length: lines }, (_, i) => `detail line ${i + 1}`)].join("\n");
}

// ── Fake host scaffolding ─────────────────────────────────────────────────────

interface FakeHandle {
	hidden: boolean;
	focused: boolean;
	hideCalls: number;
	isHidden(): boolean;
	setHidden(hidden: boolean): void;
	isFocused(): boolean;
	focus(): void;
	hide(): void;
}

interface FakeOverlay {
	component: { render(width: number): string[]; handleInput(data: string): void; dispose(): void; invalidate(): void };
	options: Record<string, unknown>;
	handle: FakeHandle;
}

/** A fake TUI whose terminal rows can be mutated mid-dialog (resize tests). */
function makeFakeTui(rows?: { value: number }, opts: { failShowOverlay?: Error } = {}) {
	const terminal = { columns: 80, get rows() { return rows?.value ?? 24; } };
	const overlays: FakeOverlay[] = [];
	let hideOverlayCalls = 0;
	const tui: any = {
		terminal,
		requestRender() {},
		showOverlay(component: FakeOverlay["component"], options: Record<string, unknown>) {
			if (opts.failShowOverlay) throw opts.failShowOverlay;
			const handle: FakeHandle = {
				hidden: false,
				focused: true,
				hideCalls: 0,
				isHidden: () => handle.hidden,
				setHidden: (hidden: boolean) => { handle.hidden = hidden; },
				isFocused: () => handle.focused,
				focus: () => { handle.focused = true; },
				hide: () => { handle.hideCalls++; handle.focused = false; handle.hidden = false; },
			};
			overlays.push({ component, options, handle });
			return handle;
		},
		hideOverlay() { hideOverlayCalls++; },
	};
	return { tui, overlays, hideOverlayCount: () => hideOverlayCalls };
}

function makeFakeUI(tui: unknown, opts: { setWidget?: boolean; onTerminalInput?: boolean; selectResult?: string | undefined; factoryTui?: unknown } = {}) {
	const widgetEntries = new Map<string, unknown>();
	const bridgeComponents: Array<{ render(width: number): string[] }> = [];
	const widgetCalls: Array<{ key: string; factory: boolean; removal: boolean }> = [];
	const selectCalls: Array<{ title: string; options: string[]; opts: unknown }> = [];
	const inputHandlers: Array<(data: string) => unknown> = [];
	const removedHandlers: string[] = [];
	const notifications: string[] = [];
	const ui: Record<string, unknown> = {
		notify: (message: string) => notifications.push(message),
		select: async (title: string, options: string[], selectOpts?: unknown) => {
			selectCalls.push({ title, options, opts: selectOpts });
			return opts.selectResult;
		},
	};
	if (opts.setWidget !== false) {
		ui.setWidget = (key: string, content: unknown) => {
			if (content === undefined) {
				const existing = widgetEntries.get(key) as { dispose?(): void } | undefined;
				existing?.dispose?.();
				widgetEntries.delete(key);
				widgetCalls.push({ key, factory: false, removal: true });
				return;
			}
			widgetCalls.push({ key, factory: typeof content === "function", removal: false });
			if (typeof content === "function") {
				const component = (content as (t: unknown, th: unknown) => unknown)(opts.factoryTui !== undefined ? opts.factoryTui : tui, THEME) as { render(width: number): string[] };
				widgetEntries.set(key, component);
				bridgeComponents.push(component);
			} else {
				widgetEntries.set(key, content);
			}
		};
	}
	if (opts.onTerminalInput !== false) {
		ui.onTerminalInput = (handler: (data: string) => unknown) => {
			inputHandlers.push(handler);
			return () => {
				const index = inputHandlers.indexOf(handler);
				if (index >= 0) inputHandlers.splice(index, 1);
				removedHandlers.push("removed");
			};
		};
	}
	return { ui, widgetEntries, bridgeComponents, widgetCalls, selectCalls, inputHandlers, removedHandlers, notifications };
}

/** Invoke the adapter without awaiting. The synchronous setup (bridge
 * acquisition and mount) completes before the returned promise is awaited. */
function open(ui: Record<string, unknown>, title: string, options: string[], signal: AbortSignal) {
	const promise = (askSelect as (ui: unknown, title: string, options: string[], signal: AbortSignal) => Promise<string | undefined>)(ui, title, options, signal);
	// A pending promise must never surface as an unhandled rejection; every
	// test settles its dialog explicitly.
	promise.catch(() => {});
	return { promise, raw: promise };
}

// ── Native fallback (before anything is mounted) ──────────────────────────────

test("a host without setWidget falls back to the signal-aware native selector", async () => {
	const { tui } = makeFakeTui();
	const host = makeFakeUI(tui, { setWidget: false });
	const controller = new AbortController();
	const { promise } = open(host.ui, "t", ["a", "b"], controller.signal);
	assert.equal(await promise, undefined, "the fallback resolves through ui.select");
	assert.equal(host.selectCalls.length, 1);
	assert.equal((host.selectCalls[0].opts as { signal?: AbortSignal }).signal, controller.signal, "the native selector receives the dialog signal");
	assert.equal(host.inputHandlers.length, 0, "no raw listener is registered for a fallback");
	assert.equal(host.widgetCalls.length, 0, "no bridge is acquired for a fallback");
});

test("a host without onTerminalInput falls back to the native selector", async () => {
	const { tui } = makeFakeTui();
	const host = makeFakeUI(tui, { onTerminalInput: false });
	const controller = new AbortController();
	await open(host.ui, "t", ["a"], controller.signal).promise;
	assert.equal(host.selectCalls.length, 1);
	assert.equal(host.widgetCalls.length, 0);
});

test("a widget acquisition failure removes the raw listener and propagates", async () => {
	const acquisitionFailure = new Error("probe acquisition failed");
	const { tui, overlays } = makeFakeTui();
	const host = makeFakeUI(tui);
	(host.ui as Record<string, unknown>).setWidget = () => {
		throw acquisitionFailure;
	};
	const controller = new AbortController();
	await assert.rejects(open(host.ui, "t", ["a"], controller.signal).raw, (error: unknown) => error === acquisitionFailure);
	assert.equal(host.inputHandlers.length, 0, "the raw listener was removed");
	assert.equal(overlays.length, 0, "the overlay never mounted");
});

test("a selector construction failure removes the raw listener and propagates", async () => {
	const constructionFailure = new Error("probe construction failed");
	const failingAsk = createGuardAskSelect({
		matchesKey, isKeyRelease, isKeyRepeat,
		ExtensionSelectorComponent: function () {
			throw constructionFailure;
		} as unknown as typeof ExtensionSelectorComponent,
	});
	const { tui, overlays } = makeFakeTui();
	const host = makeFakeUI(tui);
	const controller = new AbortController();
	await assert.rejects((failingAsk as (ui: unknown, title: string, options: string[], signal: AbortSignal) => Promise<string | undefined>)(host.ui, "t", ["a"], controller.signal), (error: unknown) => error === constructionFailure);
	assert.equal(host.inputHandlers.length, 0, "the raw listener was removed");
	assert.equal(overlays.length, 0, "the overlay never mounted");
	assert.equal(host.widgetEntries.size, 0, "the bridge was removed");
});

test("a contract-conforming selector without SDK internals renders through the recomposition fallback", async () => {
	class MinimalSelector {
		onSelect: (option: string) => void;
		onCancel: () => void;
		constructor(_title: string, _options: string[], onSelect: (option: string) => void, onCancel: () => void) {
			this.onSelect = onSelect;
			this.onCancel = onCancel;
		}
		render() { return ["Allow once", "Deny"]; }
		handleInput(data: string) { if (data === ESC) this.onCancel(); if (data === ENTER) this.onSelect("Allow once"); }
		dispose() {}
		invalidate() {}
	}
	const minimalAsk = createGuardAskSelect({
		matchesKey, isKeyRelease, isKeyRepeat,
		ExtensionSelectorComponent: MinimalSelector as unknown as typeof ExtensionSelectorComponent,
	});
	const { tui, overlays } = makeFakeTui();
	const host = makeFakeUI(tui);
	const controller = new AbortController();
	const promise = (minimalAsk as (ui: unknown, title: string, options: string[], signal: AbortSignal) => Promise<string | undefined>)(host.ui, longTitle(20), ["Allow once", "Deny"], controller.signal);
	promise.catch(() => {});
	assert.doesNotThrow(() => overlays[0].component.render(80), "a selector without the standard output shape renders through the fallback");
	assert.doesNotThrow(() => overlays[0].component.handleInput(DOWN), "input works without SDK internals");
	overlays[0].component.handleInput(ESC);
	assert.equal(await promise, undefined);
});

test("a bridge factory that yields no TUI falls back and leaves no entries", async () => {
	const host = makeFakeUI(undefined, { factoryTui: undefined });
	const controller = new AbortController();
	await open(host.ui, "t", ["a"], controller.signal).promise;
	assert.equal(host.selectCalls.length, 1, "the native selector handled the dialog");
	assert.equal(host.widgetEntries.size, 0, "the bridge was removed even though it yielded nothing");
	assert.equal(host.inputHandlers.length, 0, "the raw listener was removed before falling back");
});

test("a pre-aborted signal rejects before any host interaction", async () => {
	const { tui } = makeFakeTui();
	const host = makeFakeUI(tui);
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(open(host.ui, "t", ["a"], controller.signal).raw);
	assert.equal(host.selectCalls.length, 0);
	assert.equal(host.widgetCalls.length, 0);
	assert.equal(host.inputHandlers.length, 0);
});

// ── Bridge lifecycle and mount ────────────────────────────────────────────────

test("the bridge is acquired with a unique key and removed immediately; the overlay mounts through showOverlay", async () => {
	const { tui, overlays, hideOverlayCount } = makeFakeTui();
	const host = makeFakeUI(tui);
	const controller = new AbortController();
	const { promise } = open(host.ui, "t", ["a", "b"], controller.signal);
	assert.equal(host.widgetCalls.length, 3, "a canary removal precedes the acquisition and the bridge removal");
	assert.equal(host.widgetCalls[0].removal, true, "the canary removal runs first");
	assert.equal(host.widgetCalls[1].factory, true);
	assert.equal(host.widgetCalls[2].removal, true);
	assert.notEqual(host.widgetCalls[1].key, "", "the bridge key is non-empty");
	assert.notEqual(host.widgetCalls[1].key, host.widgetCalls[0].key, "the canary key is unique");
	assert.equal(host.widgetEntries.size, 0, "no persistent widget entry survives");
	assert.equal(overlays.length, 1, "the dialog mounted through TUI.showOverlay");
	assert.deepEqual(overlays[0].options, { anchor: "bottom-center", width: "100%", maxHeight: "100%", margin: { left: 0, right: 0, bottom: 0 } }, "full-width bottom-anchored geometry");
	assert.equal(hideOverlayCount(), 0, "TUI.hideOverlay is never used");
	overlays[0].component.handleInput(ESC);
	assert.equal(await promise, undefined);
});

test("a bridge removal failure fails the dialog before any widget exists or mounts", async () => {
	const removalFailure = new Error("probe removal failed");
	const { tui, overlays } = makeFakeTui();
	const host = makeFakeUI(tui);
	const originalSetWidget = host.ui.setWidget as (key: string, content: unknown) => void;
	(host.ui as Record<string, unknown>).setWidget = (key: string, content: unknown) => {
		if (content === undefined) throw removalFailure; // every removal fails, canary included
		originalSetWidget(key, content);
	};
	const controller = new AbortController();
	await assert.rejects(open(host.ui, "t", ["a"], controller.signal).raw, (error: unknown) => error === removalFailure, "the removal failure propagates as a genuine setup error");
	assert.equal(host.widgetEntries.size, 0, "no bridge entry was ever created");
	assert.equal(overlays.length, 0, "the overlay never mounted");
	assert.equal(host.inputHandlers.length, 0, "the raw listener was removed");
	assert.equal(host.selectCalls.length, 0, "a failed display is never retried through the native selector");
});

test("the bridge component renders zero lines", async () => {
	const { tui, overlays } = makeFakeTui();
	const host = makeFakeUI(tui);
	const controller = new AbortController();
	const { promise } = open(host.ui, longTitle(3), ["a", "b"], controller.signal);
	assert.equal(host.bridgeComponents.length, 1, "the bridge component was created");
	assert.equal(host.bridgeComponents[0].render(80).length, 0, "the bridge renders zero lines, so it never displaces content");
	overlays[0].component.handleInput(ESC);
	await promise;
});

// ── Selector semantics ────────────────────────────────────────────────────────

test("enter resolves the highlighted label and arrow keys move the selection", async () => {
	const { tui, overlays } = makeFakeTui();
	const host = makeFakeUI(tui);
	const controller = new AbortController();
	const { promise } = open(host.ui, "guard: pick", ["Allow once", "Deny"], controller.signal);
	overlays[0].component.handleInput(DOWN);
	overlays[0].component.handleInput(ENTER);
	assert.equal(await promise, "Deny", "the selection state is preserved and enter resolves the highlighted label");
});

test("esc resolves undefined", async () => {
	const { tui, overlays } = makeFakeTui();
	const host = makeFakeUI(tui);
	const controller = new AbortController();
	const { promise } = open(host.ui, "guard: pick", ["Allow once", "Deny"], controller.signal);
	overlays[0].component.handleInput(ESC);
	assert.equal(await promise, undefined, "cancel keeps the native selector contract");
});

// ── ctrl+] toggle semantics ───────────────────────────────────────────────────

test("ctrl+] toggles hidden, notifies once, and consumes the key", async () => {
	const { tui, overlays } = makeFakeTui();
	const host = makeFakeUI(tui);
	const controller = new AbortController();
	const { promise } = open(host.ui, "t", ["a", "b"], controller.signal);
	const toggle = host.inputHandlers[0] as (data: string) => { consume?: boolean } | undefined;
	assert.equal(toggle("x"), undefined, "unrelated keys pass through untouched");
	assert.deepEqual(toggle(CTRL_BRACKET), { consume: true }, "the press is consumed");
	assert.equal(overlays[0].handle.hidden, true, "the dialog is hidden");
	assert.equal(host.notifications.filter((n) => /hidden/.test(n)).length, 1, "exactly one hidden notification");
	assert.deepEqual(toggle(CTRL_BRACKET), { consume: true }, "the second press is consumed");
	assert.equal(overlays[0].handle.hidden, false, "the dialog is shown again");
	assert.equal(host.notifications.filter((n) => /hidden/.test(n)).length, 1, "the notification is not repeated");
	overlays[0].component.handleInput(ESC);
	await promise;
});

test("kitty repeat and release events consume without toggling", async () => {
	const { tui, overlays } = makeFakeTui();
	const host = makeFakeUI(tui);
	const controller = new AbortController();
	const { promise } = open(host.ui, "t", ["a", "b"], controller.signal);
	const toggle = host.inputHandlers[0] as (data: string) => { consume?: boolean } | undefined;
	assert.deepEqual(toggle(KITTY_PRESS), { consume: true }, "the kitty press toggles");
	assert.equal(overlays[0].handle.hidden, true);
	assert.deepEqual(toggle(KITTY_REPEAT), { consume: true }, "the repeat is consumed");
	assert.deepEqual(toggle(KITTY_RELEASE), { consume: true }, "the release is consumed");
	assert.equal(overlays[0].handle.hidden, true, "repeat and release never toggle");
	assert.deepEqual(toggle(CTRL_BRACKET), { consume: true }, "the control-byte press toggles back");
	assert.equal(overlays[0].handle.hidden, false);
	overlays[0].component.handleInput(ESC);
	await promise;
});

test("a visible but unfocused overlay passes ctrl+] through untouched", async () => {
	const { tui, overlays } = makeFakeTui();
	const host = makeFakeUI(tui);
	const controller = new AbortController();
	const { promise } = open(host.ui, "t", ["a", "b"], controller.signal);
	overlays[0].handle.focused = false; // another overlay owns input
	assert.equal(host.inputHandlers[0](CTRL_BRACKET), undefined, "the toggle passes through");
	assert.equal(overlays[0].handle.hidden, false, "no toggle happened");
	overlays[0].component.handleInput(ESC);
	await promise;
});

// ── Settlement and cancellation ───────────────────────────────────────────────

test("settling removes only owned resources and ignores late callbacks", async () => {
	const { tui, overlays } = makeFakeTui();
	const host = makeFakeUI(tui);
	const controller = new AbortController();
	const { promise, raw } = open(host.ui, "t", ["a", "b"], controller.signal);
	const overlay = overlays[0];
	const toggle = host.inputHandlers[0] as (data: string) => unknown;
	overlay.component.handleInput(ENTER);
	assert.equal(await promise, "a", "enter resolves the highlighted label");
	assert.equal(overlay.handle.hideCalls, 1, "the owned handle removed the overlay exactly once");
	assert.equal(host.removedHandlers.length, 1, "the raw listener was removed");
	assert.equal(host.inputHandlers.length, 0);
	assert.equal(host.widgetEntries.size, 0);
	assert.equal(toggle(CTRL_BRACKET), undefined, "the removed listener no longer toggles");
	assert.doesNotThrow(() => overlay.component.handleInput(ENTER), "a late callback after settlement is ignored");
	assert.doesNotThrow(() => overlay.component.dispose(), "dispose stays idempotent");
	void raw;
});

test("aborting while open rejects, removes the overlay, and ignores late callbacks", async () => {
	const { tui, overlays } = makeFakeTui();
	const host = makeFakeUI(tui);
	const controller = new AbortController();
	const { raw } = open(host.ui, "t", ["a", "b"], controller.signal);
	const overlay = overlays[0];
	controller.abort();
	await assert.rejects(raw, /abort|cancel/, "the caller receives the cancellation");
	assert.equal(overlay.handle.hideCalls, 1, "the overlay was removed through the owned handle");
	assert.equal(host.inputHandlers.length, 0, "the raw listener was removed");
	assert.equal(host.widgetEntries.size, 0);
	assert.doesNotThrow(() => overlay.component.handleInput(ENTER), "a late selection after abort is ignored");
	await tick();
});

test("aborting while hidden also cleans up", async () => {
	const { tui, overlays } = makeFakeTui();
	const host = makeFakeUI(tui);
	const controller = new AbortController();
	const { raw } = open(host.ui, "t", ["a", "b"], controller.signal);
	(host.inputHandlers[0] as (data: string) => unknown)(CTRL_BRACKET); // hide
	assert.equal(overlays[0].handle.hidden, true);
	controller.abort();
	await assert.rejects(raw);
	assert.equal(overlays[0].handle.hideCalls, 1, "hide() removes a hidden overlay");
	assert.equal(host.inputHandlers.length, 0);
	await tick();
});

test("a genuine mount failure propagates and is not retried", async () => {
	const failure = new Error("overlay mount failed");
	const { tui, hideOverlayCount } = makeFakeTui(undefined, { failShowOverlay: failure });
	const host = makeFakeUI(tui);
	const controller = new AbortController();
	await assert.rejects(open(host.ui, "t", ["a"], controller.signal).raw, (error: unknown) => error === failure, "the original error propagates");
	assert.equal(host.selectCalls.length, 0, "a failed display is never retried through the native selector");
	assert.equal(host.inputHandlers.length, 0, "the raw listener was removed after the failure");
	assert.equal(host.widgetEntries.size, 0, "the bridge was removed");
	assert.equal(hideOverlayCount(), 0);
});

// ── Bounded rendering (real selector over a controlled terminal) ──────────────

test("a tall dialog is bounded so the decision controls stay visible", async () => {
	const { tui, overlays } = makeFakeTui();
	const host = makeFakeUI(tui);
	const controller = new AbortController();
	const { promise } = open(host.ui, longTitle(40), ["Allow once", "Deny"], controller.signal);
	const lines = overlays[0].component.render(80);
	assert.ok(lines.length <= 24, `the overlay fits the terminal (${lines.length} lines)`);
	const plain = lines.map(stripTerminalSequences);
	assert.ok(plain.some((line) => line.includes("Allow once")), "Allow once is visible");
	assert.ok(plain.some((line) => line.includes("Deny")), "Deny is visible");
	assert.ok(plain.some((line) => line.includes(HIDE_HINT)), "the hide hint is visible");
	assert.ok(plain.some((line) => line.includes("PgUp/PgDn")), "the overflow indicator is visible");
	overlays[0].component.handleInput(ESC);
	await promise;
});

test("PgUp/PgDn scrolls the overflow and every detail line stays reachable", async () => {
	const { tui, overlays } = makeFakeTui();
	const host = makeFakeUI(tui);
	const controller = new AbortController();
	const { promise } = open(host.ui, `${longTitle(40)}\nexact rule: echo asked`, ["Allow once", "Deny"], controller.signal);
	const overlay = overlays[0].component;
	const first = overlay.render(80).map(stripTerminalSequences);
	assert.ok(first.some((line) => line.includes("detail line 1")), "the window starts at the top");
	assert.ok(!first.some((line) => line.includes("exact rule")), "the tail is initially out of view");
	overlay.handleInput(PAGE_DOWN);
	const second = overlay.render(80).map(stripTerminalSequences);
	assert.ok(second.some((line) => line.includes("above")), "the indicator reports scrolled-away lines");
	for (let i = 0; i < 10; i++) overlay.handleInput(PAGE_DOWN);
	const bottom = overlay.render(80).map(stripTerminalSequences);
	assert.ok(bottom.some((line) => line.includes("exact rule")), "the tail is reachable by keyboard");
	assert.ok(!bottom.some((line) => line.includes("detail line 1")), "the head scrolled out of view");
	for (let i = 0; i < 10; i++) overlay.handleInput(PAGE_UP);
	const top = overlay.render(80).map(stripTerminalSequences);
	assert.ok(top.some((line) => line.includes("detail line 1")), "paging back returns to the top");
	overlay.handleInput(ESC);
	await promise;
});

test("a terminal too short for the decision controls disables approval but keeps cancel", async () => {
	const rows = { value: 5 };
	const { tui, overlays } = makeFakeTui(rows);
	const host = makeFakeUI(tui);
	const controller = new AbortController();
	const { promise, raw } = open(host.ui, longTitle(10), ["Allow once", "Deny"], controller.signal);
	const overlay = overlays[0].component;
	const lines = overlay.render(80).map(stripTerminalSequences);
	assert.ok(lines.some((line) => line.includes("too short")), "the warning replaces the dialog");
	overlay.handleInput(ENTER);
	overlay.handleInput(DOWN);
	const stillPending = await Promise.race([
		promise.then(() => "settled"),
		tick().then(() => "pending"),
	]);
	assert.equal(stillPending, "pending", "enter and navigation never settle a too-short dialog");
	rows.value = 30; // resize: the dialog re-enables without remounting
	const grown = overlay.render(80).map(stripTerminalSequences);
	assert.ok(grown.some((line) => line.includes("Allow once")), "the decision controls are visible again");
	overlay.handleInput(ENTER);
	assert.equal(await raw, "Allow once", "approval works again after the resize");
	void promise;
});

test("enter before the first render stays pending in a too-short terminal", async () => {
	const rows = { value: 5 };
	const { tui, overlays } = makeFakeTui(rows);
	const host = makeFakeUI(tui);
	const controller = new AbortController();
	const { promise, raw } = open(host.ui, longTitle(10), ["Allow once", "Deny"], controller.signal);
	// No render has happened; the input path must evaluate the live geometry.
	overlays[0].component.handleInput(ENTER);
	const stillPending = await Promise.race([
		promise.then(() => "settled"),
		tick().then(() => "pending"),
	]);
	assert.equal(stillPending, "pending", "confirmation is disabled before the first paint in a five-row terminal");
	overlays[0].component.handleInput(ESC);
	assert.equal(await raw, undefined, "esc still cancels");
	void promise;
});

test("shrinking without a repaint disables confirmation on the next input", async () => {
	const rows = { value: 24 };
	const { tui, overlays } = makeFakeTui(rows);
	const host = makeFakeUI(tui);
	const controller = new AbortController();
	const { promise, raw } = open(host.ui, longTitle(10), ["Allow once", "Deny"], controller.signal);
	overlays[0].component.render(80); // painted at 24 rows
	rows.value = 5; // shrink without a repaint
	overlays[0].component.handleInput(ENTER);
	const stillPending = await Promise.race([
		promise.then(() => "settled"),
		tick().then(() => "pending"),
	]);
	assert.equal(stillPending, "pending", "confirmation must not use the previous render's safety flag");
	overlays[0].component.handleInput(ESC);
	assert.equal(await raw, undefined);
	void promise;
});

test("a one-row title budget pages to the hidden tail", async () => {
	const rows = { value: 11 };
	const { tui, overlays } = makeFakeTui(rows);
	const host = makeFakeUI(tui);
	const controller = new AbortController();
	const { promise } = open(host.ui, `${longTitle(40)}\nexact rule: echo asked`, ["Allow once", "Deny"], controller.signal);
	const overlay = overlays[0].component;
	const first = overlay.render(80).map(stripTerminalSequences);
	assert.ok(first.length <= 11, `the dialog fits eleven rows (${first.length})`);
	assert.ok(!first.some((line) => line.includes("exact rule")), "the tail starts out of view");
	for (let i = 0; i < 50; i++) {
		overlay.handleInput(PAGE_DOWN);
		overlay.render(80);
	}
	const paged = overlay.render(80).map(stripTerminalSequences);
	assert.ok(paged.some((line) => line.includes("exact rule")), "fifty page-downs reach the exact-rule tail through the one-line window");
	overlay.handleInput(ESC);
	await promise;
});

test("an 18-column viewport keeps every control and the hide hint within 24 rows", async () => {
	const { tui, overlays } = makeFakeTui();
	const host = makeFakeUI(tui);
	const controller = new AbortController();
	const { promise } = open(host.ui, longTitle(40), ["Allow once", "Deny"], controller.signal);
	const lines = overlays[0].component.render(18).map(stripTerminalSequences);
	assert.ok(lines.length <= 24, `the measured budget fits the viewport (${lines.length} rows)`);
	assert.ok(lines.some((line) => line.includes("Allow once")), "Allow once is visible");
	assert.ok(lines.some((line) => line.includes("Deny")), "Deny is visible");
	assert.ok(lines.some((line) => line.includes(HIDE_HINT)), "the hide hint survived the narrow viewport");
	overlays[0].component.handleInput(ESC);
	await promise;
});

test("shrinking the terminal re-bounds the window on the next render", async () => {
	const rows = { value: 40 };
	const { tui, overlays } = makeFakeTui(rows);
	const host = makeFakeUI(tui);
	const controller = new AbortController();
	const { promise } = open(host.ui, longTitle(20), ["Allow once", "Deny"], controller.signal);
	const overlay = overlays[0].component;
	const tall = overlay.render(80).map(stripTerminalSequences);
	assert.ok(tall.some((line) => line.includes("detail line 20")), "everything fits in 40 rows");
	assert.ok(!tall.some((line) => line.includes("PgUp/PgDn")), "no indicator while everything fits");
	rows.value = 12;
	const shrunk = overlay.render(80);
	assert.ok(shrunk.length <= 12, `the overlay re-bounds to the shrunk terminal (${shrunk.length} lines)`);
	assert.ok(shrunk.map(stripTerminalSequences).some((line) => line.includes("Deny")), "the choices stay visible after shrinking");
	overlay.handleInput(ESC);
	await promise;
});

// ── Real pi-tui: layout, hide/show, focus, and ownership ─────────────────────

function makeRealTui(rows = 24, columns = 80) {
	const terminal = {
		columns, rows, kittyProtocolActive: false,
		start() {}, stop() {}, write() {}, moveBy() {}, hideCursor() {}, showCursor() {},
		clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {},
	};
	return new TuiMainScreen(terminal as never);
}

/** A ui whose setWidget routes through the real InteractiveMode host method
 * (production widget lifecycle) and whose onTerminalInput registers through
 * the real TUI input-listener path, so tests dispatch keys exactly the way
 * the terminal loop does. */
function makeHostedUI(tuiInstance: TuiMainScreen) {
	const host = {
		ui: tuiInstance,
		extensionWidgetsAbove: new Map<string, unknown>(),
		extensionWidgetsBelow: new Map<string, unknown>(),
		renderWidgets() {},
	};
	const setExtensionWidget = (InteractiveMode.prototype as unknown as { setExtensionWidget: (this: unknown, key: string, content: unknown, options?: unknown) => void }).setExtensionWidget;
	const inputHandlers: Array<(data: string) => unknown> = [];
	const ui: Record<string, unknown> = {
		notify: () => {},
		select: async () => undefined,
		setWidget: (key: string, content: unknown, options?: unknown) => setExtensionWidget.call(host, key, content, options),
		onTerminalInput: (handler: (data: string) => unknown) => {
			inputHandlers.push(handler);
			return tuiInstance.addInputListener(handler as never);
		},
	};
	const dispatch = (data: string): void => {
		(tuiInstance as unknown as { handleTerminalInput(data: string): void }).handleTerminalInput(data);
	};
	return { ui, host, inputHandlers, dispatch };
}

test("real TUI: a tall dialog keeps the decision controls visible in 24 rows", async () => {
	const tuiInstance = makeRealTui();
	const { ui, host, dispatch } = makeHostedUI(tuiInstance);
	const controller = new AbortController();
	const { promise } = open(ui, longTitle(40), ["Allow once", "Deny"], controller.signal);
	try {
		tuiInstance.start();
		tuiInstance.renderNow(true);
		const plain = tuiInstance.captureRenderState().previousLines.map(stripTerminalSequences);
		assert.ok(plain.some((line) => line.includes("Allow once")), "Allow once survived the terminal height");
		assert.ok(plain.some((line) => line.includes("Deny")), "Deny survived the terminal height");
		assert.ok(plain.some((line) => line.includes(HIDE_HINT)), "the hide hint is rendered");
		assert.equal(host.extensionWidgetsAbove.size + host.extensionWidgetsBelow.size, 0, "the widget bridge left no persistent entries");
	} finally {
		dispatch(ESC);
	}
	assert.equal(await promise, undefined, "the dialog settled through the real input path");
});

test("real TUI: ctrl+] hides and re-shows the dialog", async () => {
	const tuiInstance = makeRealTui();
	const { ui, dispatch } = makeHostedUI(tuiInstance);
	const controller = new AbortController();
	const { promise } = open(ui, longTitle(40), ["Allow once", "Deny"], controller.signal);
	try {
		tuiInstance.start();
		tuiInstance.renderNow(true);
		dispatch(CTRL_BRACKET);
		tuiInstance.renderNow(true);
		let plain = tuiInstance.captureRenderState().previousLines.map(stripTerminalSequences);
		assert.ok(!plain.some((line) => line.includes("Allow once")), "the hidden dialog is not rendered");
		dispatch(CTRL_BRACKET);
		tuiInstance.renderNow(true);
		plain = tuiInstance.captureRenderState().previousLines.map(stripTerminalSequences);
		assert.ok(plain.some((line) => line.includes("Allow once")), "the dialog is rendered again");
	} finally {
		dispatch(ESC);
	}
	assert.equal(await promise, undefined);
});

test("real TUI: selection survives hide/show", async () => {
	const tuiInstance = makeRealTui();
	const { ui, dispatch } = makeHostedUI(tuiInstance);
	const controller = new AbortController();
	const { raw } = open(ui, "guard: pick", ["Allow once", "Save for project", "Deny"], controller.signal);
	try {
		tuiInstance.start();
		dispatch(DOWN);
		dispatch(CTRL_BRACKET); // hide with the second option selected
		dispatch(CTRL_BRACKET); // re-show
		dispatch(ENTER);
	} catch (error) {
		controller.abort();
		throw error;
	}
	assert.equal(await raw, "Save for project", "the selection made before hiding survived the toggle");
});

test("real TUI: settling under a foreign overlay removes only the guard overlay", async () => {
	const tuiInstance = makeRealTui();
	const { ui, dispatch } = makeHostedUI(tuiInstance);
	const controller = new AbortController();
	const { raw } = open(ui, "guard: pick", ["Allow once", "Deny"], controller.signal);
	tuiInstance.start();
	// A foreign overlay stacked above the guard dialog owns the focus, so
	// keystrokes reach the foreign overlay, not the guard dialog.
	const foreign = tuiInstance.showOverlay(new Text("foreign overlay", 0, 0));
	assert.equal(foreign.isFocused(), true, "the foreign overlay owns the focus");
	controller.abort(); // settle the guard dialog from outside while the foreign overlay is up
	await assert.rejects(raw, /abort|cancel/, "the guard dialog settled without touching the foreign overlay");
	assert.equal(foreign.isFocused(), true, "the foreign overlay keeps the focus");
	assert.equal(foreign.isHidden(), false, "the foreign overlay is untouched");
	assert.equal(tuiInstance.hasOverlayEntries, true, "the foreign overlay is still mounted");
	foreign.hide();
	assert.equal(tuiInstance.hasOverlayEntries, false, "only guard-owned overlays were removed");
});
