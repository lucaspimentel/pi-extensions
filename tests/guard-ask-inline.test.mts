// Inline presentation tests for guard's dialog stages (ask-overlay.ts
// runDialogStage/runInlineStage + the ask-components stage builders): inline
// editor-slot mounting, the row budget, the ctrl+] collapse toggle, the
// yield-to-overlay fallback, and abort semantics. The overlay path itself is
// covered in tests/guard-ask-overlay.test.mts; flow wiring in
// tests/guard-prompt-flow.test.mts.
// Run: node --test tests/guard-ask-inline.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";

import { ExtensionSelectorComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, isKeyRepeat, matchesKey } from "@earendil-works/pi-tui";
import { createGuardEditorStage, createGuardPickerStage, type GuardPickerStep } from "../extensions/guard/ask-components.ts";
import { createGuardAskSelect, inlineRowBudget } from "../extensions/guard/ask-overlay.ts";

initTheme("dark", false);

const THEME = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const CTRL_BRACKET = "\x1d"; // ctrl+] control byte
const KITTY_RELEASE = "\x1b[93;5:3u";
const ENTER = "\r";
const ESC = "\x1b";

const askSelect = createGuardAskSelect({ matchesKey, isKeyRelease, isKeyRepeat, ExtensionSelectorComponent });
const editorStage = createGuardEditorStage();
const pickerStage = createGuardPickerStage();

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// ── Inline fake host ──────────────────────────────────────────────────────

interface InlineMount {
	component: { render(width: number): string[]; handleInput(data: string): void; dispose(): void; invalidate(): void };
	resolve(result: unknown): void;
}

/** A fake TUI with an inline-capable ui.custom. Mirrors the SDK contract:
 * the factory receives (tui, theme, keybindings, done); done resolves the
 * custom promise and the host disposes the component. The overlay leg's
 * setWidget bridge and showOverlay are also provided so yield tests exercise
 * the stacking fallback. */
function makeInlineHost(rows = 24, opts: { hasOverlay?: boolean } = {}) {
	const terminal = { columns: 80, get rows() { return rows; } };
	const overlays: Array<{ component: unknown }> = [];
	const widgetEntries = new Map<string, unknown>();
	const selectCalls: Array<{ title: string; options: string[] }> = [];
	let inline: InlineMount | undefined;
	const tui: any = {
		terminal,
		hasOverlay: () => opts.hasOverlay ?? false,
		requestRender() {},
		showOverlay(component: unknown) {
			overlays.push({ component });
			return {
				hidden: false,
				focused: true,
				isHidden: () => false,
				setHidden: () => {},
				isFocused: () => true,
				hide: () => {},
			};
		},
	};
	const ui: Record<string, unknown> = {
		notify: () => {},
		select: async (title: string, options: string[]) => {
			selectCalls.push({ title, options });
			return undefined;
		},
		custom: (factory: (...args: unknown[]) => unknown, options: unknown) => {
			assert.deepEqual(options, { overlay: false }, "inline mounts use the non-overlay custom options");
			return new Promise((resolve) => {
				const component = factory(tui, THEME, {}, (result: unknown) => resolve(result));
				inline = {
					component: component as InlineMount["component"],
					resolve: (result: unknown) => resolve(result),
				};
			});
		},
		setWidget: (key: string, content: unknown) => {
			if (content === undefined) {
				const existing = widgetEntries.get(key) as { dispose?(): void } | undefined;
				existing?.dispose?.();
				widgetEntries.delete(key);
				return;
			}
			if (typeof content === "function") {
				widgetEntries.set(key, (content as (t: unknown, th: unknown) => unknown)(tui, THEME));
			} else {
				widgetEntries.set(key, content);
			}
		},
		onTerminalInput: () => () => {},
	};
	return {
		ui,
		tui,
		overlays,
		widgetEntries,
		selectCalls,
		inlineComponent: () => inline?.component,
		settleInline: (result: unknown) => inline?.resolve(result),
	};
}

function openStage(ui: unknown, run: (ui: unknown, signal: AbortSignal) => Promise<unknown>) {
	const controller = new AbortController();
	const promise = run(ui, controller.signal);
	promise.catch(() => {});
	return { promise, controller };
}

// ── Row budget ────────────────────────────────────────────────────────────

test("inlineRowBudget caps at 70 percent of rows with a floor of 12", () => {
	assert.equal(inlineRowBudget(24), 16);
	assert.equal(inlineRowBudget(100), 70);
	assert.equal(inlineRowBudget(10), 10, "never exceeds the terminal's own rows");
	assert.ok(inlineRowBudget(Number.POSITIVE_INFINITY) === Number.POSITIVE_INFINITY);
});

// ── Inline selector mounting ──────────────────────────────────────────────

test("a TUI host with ui.custom mounts the selector inline, not as an overlay", async () => {
	const host = makeInlineHost();
	const { promise } = openStage(host.ui, (ui, signal) => (askSelect as (ui: unknown, title: string, options: string[], signal: AbortSignal) => Promise<string | undefined>)(ui, "guard: bash", ["Allow once", "Deny once"], signal));
	await tick();
	assert.ok(host.inlineComponent(), "the selector mounted inline");
	assert.equal(host.overlays.length, 0, "no overlay was mounted");
	assert.equal(host.widgetEntries.size, 0, "no setWidget bridge was acquired");
	const lines = host.inlineComponent()!.render(80);
	assert.ok(lines.length > 0, "the selector renders");
	host.inlineComponent()!.handleInput(ENTER);
	assert.equal(await promise, "Allow once", "the selection settles through the host completion");
});

test("inline renders respect the row budget", async () => {
	const host = makeInlineHost(24); // budget = 16
	const { promise } = openStage(host.ui, (ui, signal) => (askSelect as (ui: unknown, title: string, options: string[], signal: AbortSignal) => Promise<string | undefined>)(ui, "guard: bash", ["a", "b"], signal));
	await tick();
	assert.ok(host.inlineComponent()!.render(80).length <= inlineRowBudget(24));
	host.inlineComponent()!.handleInput(ESC);
	assert.equal(await promise, undefined);
});

// ── Collapse toggle ───────────────────────────────────────────────────────

test("ctrl+] collapses the inline prompt to one line and re-expands", async () => {
	const host = makeInlineHost();
	const { promise } = openStage(host.ui, (ui, signal) => (askSelect as (ui: unknown, title: string, options: string[], signal: AbortSignal) => Promise<string | undefined>)(ui, "guard: bash", ["a", "b"], signal));
	await tick();
	const component = host.inlineComponent()!;
	assert.ok(component.render(80).length > 1);
	component.handleInput(CTRL_BRACKET);
	const collapsed = component.render(80);
	assert.equal(collapsed.length, 1, "collapsed renders exactly one hint line");
	assert.match(collapsed[0], /collapsed/);
	component.handleInput(CTRL_BRACKET);
	assert.ok(component.render(80).length > 1, "ctrl+] re-expands");
	component.handleInput(ENTER);
	assert.equal(await promise, "a");
});

test("a kitty release event does not toggle the collapse", async () => {
	const host = makeInlineHost();
	const { promise } = openStage(host.ui, (ui, signal) => (askSelect as (ui: unknown, title: string, options: string[], signal: AbortSignal) => Promise<string | undefined>)(ui, "t", ["a"], signal));
	await tick();
	const component = host.inlineComponent()!;
	component.handleInput(KITTY_RELEASE);
	assert.ok(component.render(80).length > 1, "still expanded");
	component.handleInput(ESC);
	assert.equal(await promise, undefined);
});

test("esc cancels while collapsed", async () => {
	const host = makeInlineHost();
	const { promise } = openStage(host.ui, (ui, signal) => (askSelect as (ui: unknown, title: string, options: string[], signal: AbortSignal) => Promise<string | undefined>)(ui, "t", ["a"], signal));
	await tick();
	const component = host.inlineComponent()!;
	component.handleInput(CTRL_BRACKET);
	component.handleInput(ESC);
	assert.equal(await promise, undefined, "esc while collapsed cancels the stage");
});

// ── Yield to an open overlay ─────────────────────────────────────────────

test("an overlay on screen at mount stacks the owned overlay instead of mounting inline", async () => {
	const host = makeInlineHost(24, { hasOverlay: true });
	const { promise } = openStage(host.ui, (ui, signal) => (askSelect as (ui: unknown, title: string, options: string[], signal: AbortSignal) => Promise<string | undefined>)(ui, "t", ["a", "b"], signal));
	await tick();
	assert.equal(host.overlays.length, 1, "the stage remounted through the owned overlay");
	const overlayComponent = host.overlays[0]!.component as { handleInput(data: string): void };
	overlayComponent.handleInput(ENTER);
	assert.equal(await promise, "a");
});

// ── Abort ────────────────────────────────────────────────────────────────

test("aborting the dialog signal rejects with the shared cancellation error", async () => {
	const host = makeInlineHost();
	const { promise, controller } = openStage(host.ui, (ui, signal) => (askSelect as (ui: unknown, title: string, options: string[], signal: AbortSignal) => Promise<string | undefined>)(ui, "t", ["a"], signal));
	await tick();
	controller.abort(new Error("guard: dialog cancelled: call aborted"));
	await assert.rejects(promise, /guard: dialog cancelled/);
});

// ── Editor and picker inline ──────────────────────────────────────────────

test("the editor stage mounts inline and honors the row budget", async () => {
	const host = makeInlineHost(24); // budget = 16
	const { promise } = openStage(host.ui, (ui, signal) => (editorStage as (ui: unknown, signal: AbortSignal, options: { title: string; prefill: string }) => Promise<string | undefined>)(ui, signal, { title: "guard: edit rules", prefill: "Bash(git *)" }));
	await tick();
	assert.ok(host.inlineComponent(), "the editor mounted inline");
	const lines = host.inlineComponent()!.render(80);
	assert.ok(lines.length <= inlineRowBudget(24), `editor render ${lines.length} exceeds the budget`);
	host.inlineComponent()!.handleInput(ENTER);
	assert.equal(await promise, "Bash(git *)", "enter submits the editor text inline");
});

test("the editor advisory never breaks the inline row budget", async () => {
	const host = makeInlineHost(24); // budget = 16
	const advisory = "Note: this rule is not limited to the exact command shown; it may match other commands and combinations.";
	const { promise } = openStage(host.ui, (ui, signal) => (editorStage as (ui: unknown, signal: AbortSignal, options: { title: string; prefill: string; noteFor?: (text: string) => string | undefined }) => Promise<string | undefined>)(ui, signal, { title: "guard: edit rules", prefill: "Bash(git *)", noteFor: () => advisory }));
	await tick();
	const lines = host.inlineComponent()!.render(80);
	const text = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");
	assert.ok(lines.length <= inlineRowBudget(24), `editor render ${lines.length} exceeds the budget`);
	assert.ok(!text.includes("too short"), "the advisory must not push the inline editor into the blocked state");
	host.inlineComponent()!.handleInput(ENTER);
	assert.equal(await promise, "Bash(git *)", "the text is submitted with the advisory present or dropped");
});

test("the picker stage mounts inline and cancels through esc", async () => {
	const steps: GuardPickerStep[] = [
		{ occurrenceId: 0, label: "git status", detail: "allowed by default" },
		{ occurrenceId: 1, label: "rm -rf build", detail: "prompting step" },
	];
	const host = makeInlineHost(24);
	const { promise } = openStage(host.ui, (ui, signal) => (pickerStage as (ui: unknown, signal: AbortSignal, options: { title: string; steps: GuardPickerStep[] }) => Promise<number[] | undefined>)(ui, signal, { title: "guard: select steps", steps }));
	await tick();
	assert.ok(host.inlineComponent(), "the picker mounted inline");
	assert.ok(host.inlineComponent()!.render(80).length <= inlineRowBudget(24));
	host.inlineComponent()!.handleInput(ESC);
	assert.equal(await promise, undefined);
});

// ── Capability boundaries ────────────────────────────────────────────────

test("a host with custom but no owned-overlay capabilities still mounts inline", async () => {
	const host = makeInlineHost();
	delete host.ui.setWidget;
	delete host.ui.onTerminalInput;
	const { promise } = openStage(host.ui, (ui, signal) => (askSelect as (ui: unknown, title: string, options: string[], signal: AbortSignal) => Promise<string | undefined>)(ui, "t", ["a", "b"], signal));
	await tick();
	assert.ok(host.inlineComponent(), "inline needs only ui.custom");
	host.inlineComponent()!.handleInput(ENTER);
	assert.equal(await promise, "a");
});
