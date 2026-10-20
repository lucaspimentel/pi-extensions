// Component tests for the guard-owned editor and checkbox picker stages
// (ask-components.ts) over the shared owned-stage runner: text preservation,
// empty submission, toggle semantics, occurrence identity, blocked layouts,
// abort settlement, and ctrl+] hide/show with state preservation. Real
// wiring through the registered guard handlers is covered in
// tests/guard-prompt-flow.test.mts and tests/guard-dialogs.test.mts.
// Run: node --test tests/guard-ask-components.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";

import { createGuardEditorStage, createGuardPickerStage, type GuardPickerStep } from "../extensions/guard/ask-components.ts";
import { supportsOwnedStages } from "../extensions/guard/ask-overlay.ts";
import { matchesKey } from "@earendil-works/pi-tui";

const CTRL_BRACKET = "\x1d";
const ENTER = "\r";
const ESC = "\x1b";
const SPACE = " ";
const DOWN = "\x1b[B";

interface FakeOverlay {
	component: { render(width: number): string[]; handleInput(data: string): void; dispose(): void; invalidate(): void };
	handle: { hidden: boolean; focused: boolean; isHidden(): boolean; setHidden(hidden: boolean): void; isFocused(): boolean; hide(): void };
}

function makeFakeHost(rows = 24, opts: { factoryTui?: unknown } = {}) {
	const terminal = { columns: 80, get rows() { return rows; } };
	const tui: any = {
		terminal,
		requestRender() {},
		showOverlay(component: FakeOverlay["component"]) {
			const handle = {
				hidden: false,
				focused: true,
				isHidden: () => handle.hidden,
				setHidden: (hidden: boolean) => { handle.hidden = hidden; },
				isFocused: () => handle.focused,
				hide: () => { handle.focused = false; },
			};
			overlays.push({ component, handle });
			return handle;
		},
	};
	const overlays: FakeOverlay[] = [];
	const widgetEntries = new Map<string, unknown>();
	const inputHandlers: Array<(data: string) => unknown> = [];
	const ui: Record<string, unknown> = {
		notify: () => {},
		select: async () => undefined,
		setWidget: (key: string, content: unknown) => {
			if (content === undefined) {
				const existing = widgetEntries.get(key) as { dispose?(): void } | undefined;
				existing?.dispose?.();
				widgetEntries.delete(key);
				return;
			}
			if (typeof content === "function") {
				widgetEntries.set(key, (content as (t: unknown, theme: unknown) => unknown)(opts.factoryTui !== undefined ? opts.factoryTui : tui, { fg: (_c: string, t: string) => t, bold: (t: string) => t }));
			} else {
				widgetEntries.set(key, content);
			}
		},
		onTerminalInput: (handler: (data: string) => unknown) => {
			inputHandlers.push(handler);
			return () => {
				const index = inputHandlers.indexOf(handler);
				if (index >= 0) inputHandlers.splice(index, 1);
			};
		},
	};
	const dispatchRaw = (data: string): void => {
		for (const handler of [...inputHandlers]) handler(data);
	};
	return { ui, overlays, widgetEntries, inputHandlers, dispatchRaw, tui };
}

const strip = (lines: string[]): string[] => lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));

const editorStage = createGuardEditorStage();
const pickerStage = createGuardPickerStage();

// ── Editor stage ─────────────────────────────────────────────────────────────

test("editor: prefill renders and submit resolves the edited text", async () => {
	const host = makeFakeHost();
	const promise = editorStage(host.ui as never, new AbortController().signal, { title: "guard: save allow rule", prefill: "HostBash(/^echo hi$/)" });
	const overlay = host.overlays[0].component;
	const rendered = strip(overlay.render(80)).join("\n");
	assert.ok(rendered.includes("HostBash(/^echo hi$/)"), "the prefill is rendered");
	// Type a character and submit through the editor's own input handling.
	overlay.handleInput("x");
	overlay.handleInput(ENTER);
	assert.equal(await promise, "HostBash(/^echo hi$/)x", "the edited text is submitted");
	assert.equal(host.widgetEntries.size, 0, "no widget entries survive the stage");
});

test("editor: empty submission resolves empty, not cancellation", async () => {
	const host = makeFakeHost();
	const promise = editorStage(host.ui as never, new AbortController().signal, { title: "guard: manual deny rule" });
	host.overlays[0].component.handleInput(ENTER);
	assert.equal(await promise, "");
});

test("editor: esc cancels and the stage cleans up", async () => {
	const host = makeFakeHost();
	const promise = editorStage(host.ui as never, new AbortController().signal, { title: "t", prefill: "abc" });
	host.overlays[0].component.handleInput(ESC);
	assert.equal(await promise, undefined);
	assert.equal(host.widgetEntries.size, 0);
	assert.equal(host.inputHandlers.length, 0, "the raw toggle listener was removed");
});

test("editor: abort while open rejects and cleans up", async () => {
	const host = makeFakeHost();
	const controller = new AbortController();
	const promise = editorStage(host.ui as never, controller.signal, { title: "t", prefill: "abc" });
	promise.catch(() => {});
	controller.abort();
	await assert.rejects(promise, /abort|cancel/);
	assert.equal(host.widgetEntries.size, 0);
	assert.equal(host.inputHandlers.length, 0);
});

test("editor: ctrl+] hide/show preserves the typed text", async () => {
	const host = makeFakeHost();
	const controller = new AbortController();
	const promise = editorStage(host.ui as never, controller.signal, { title: "t", prefill: "HostBash(ls)" });
	const { component, handle } = host.overlays[0];
	assert.ok(supportsOwnedStages(host.ui as never));
	host.dispatchRaw(CTRL_BRACKET);
	assert.equal(handle.isHidden(), true, "the dialog hid");
	host.dispatchRaw(CTRL_BRACKET);
	assert.equal(handle.isHidden(), false, "the dialog re-showed");
	component.handleInput("X");
	component.handleInput(ENTER);
	assert.equal(await promise, "HostBash(ls)X", "the text survived the toggle");
});

test("editor: a terminal too short for the editor blocks submission but keeps esc", async () => {
	const host = makeFakeHost(4);
	const promise = editorStage(host.ui as never, new AbortController().signal, { title: "guard: save allow rule", prefill: "HostBash(ls)" });
	const overlay = host.overlays[0].component;
	const rendered = strip(overlay.render(80)).join("\n");
	assert.ok(rendered.includes("too short"), "the blocked warning renders");
	overlay.handleInput("\r");
	assert.equal(host.overlays.length, 1, "enter does not submit a blocked editor");
	overlay.handleInput(ESC);
	assert.equal(await promise, undefined);
});

// ── Picker stage ─────────────────────────────────────────────────────────────

const steps: GuardPickerStep[] = [
	{ occurrenceId: 0, label: "echo a", detail: "allow (read-only tier)" },
	{ occurrenceId: 1, label: "curl https://example.com", detail: "prompt (host shell cell)" },
	{ occurrenceId: 2, label: "curl https://example.com", detail: "prompt (host shell cell)" },
];

test("picker: nothing is preselected and space toggles the highlighted step", async () => {
	const host = makeFakeHost();
	const promise = pickerStage(host.ui as never, new AbortController().signal, { title: "guard: save deny rules", steps });
	const overlay = host.overlays[0].component;
	let rendered = strip(overlay.render(80)).join("\n");
	assert.ok(rendered.split("○").length - 1 >= 3, "all steps render unchecked");
	overlay.handleInput(SPACE);
	rendered = strip(overlay.render(80)).join("\n");
	assert.ok(rendered.includes("◉ echo a"), "the highlighted step toggled to checked");
	assert.ok(rendered.split("○").length - 1 >= 2, "the others stay unchecked");
	overlay.handleInput(ENTER);
	assert.deepEqual(await promise, [0], "enter continues with the selected occurrence ID");
});

test("picker: enter with no selection does not settle; esc cancels", async () => {
	const host = makeFakeHost();
	const promise = pickerStage(host.ui as never, new AbortController().signal, { title: "t", steps });
	const overlay = host.overlays[0].component;
	overlay.render(80);
	overlay.handleInput(ENTER);
	assert.equal(host.overlays.length, 1, "enter with no selection keeps the dialog open");
	overlay.handleInput(ESC);
	assert.equal(await promise, undefined);
});

test("picker: duplicate command text keeps distinct identities", async () => {
	const host = makeFakeHost();
	const promise = pickerStage(host.ui as never, new AbortController().signal, { title: "t", steps });
	const overlay = host.overlays[0].component;
	overlay.render(80);
	overlay.handleInput(DOWN); // highlight occurrence 1
	overlay.handleInput(SPACE);
	overlay.handleInput(ENTER);
	assert.deepEqual(await promise, [1], "only the second duplicate is selected");
});

test("picker: multi-selection returns every selected occurrence ID", async () => {
	const host = makeFakeHost();
	const promise = pickerStage(host.ui as never, new AbortController().signal, { title: "t", steps });
	const overlay = host.overlays[0].component;
	overlay.render(80);
	overlay.handleInput(SPACE); // check 0
	overlay.handleInput(DOWN);
	overlay.handleInput(SPACE); // check 1
	overlay.handleInput(DOWN);
	overlay.handleInput(SPACE); // check 2
	overlay.handleInput(ENTER);
	assert.deepEqual(await promise, [0, 1, 2]);
});

test("picker: ctrl+] hide/show preserves selections", async () => {
	const host = makeFakeHost();
	const controller = new AbortController();
	const promise = pickerStage(host.ui as never, controller.signal, { title: "t", steps });
	const { component, handle } = host.overlays[0];
	component.render(80);
	component.handleInput(SPACE);
	host.dispatchRaw(CTRL_BRACKET);
	assert.equal(handle.isHidden(), true);
	host.dispatchRaw(CTRL_BRACKET);
	assert.equal(handle.isHidden(), false);
	component.handleInput(ENTER);
	assert.deepEqual(await promise, [0], "the selection survived the toggle");
});

test("picker: a terminal too short blocks selection but keeps esc", async () => {
	const host = makeFakeHost(4);
	const promise = pickerStage(host.ui as never, new AbortController().signal, { title: "guard: save deny rules", steps });
	const overlay = host.overlays[0].component;
	const rendered = strip(overlay.render(80)).join("\n");
	assert.ok(rendered.includes("too short"));
	overlay.handleInput(SPACE);
	overlay.handleInput(ENTER);
	assert.equal(host.overlays.length, 1, "selection does not settle a blocked picker");
	overlay.handleInput(ESC);
	assert.equal(await promise, undefined);
});

test("picker: reject construction with no steps", () => {
	const host = makeFakeHost();
	assert.rejects(pickerStage(host.ui as never, new AbortController().signal, { title: "t", steps: [] }), /at least one step/);
});

test("both stages fail closed on a host without owned-stage capabilities", async () => {
	const ui = { select: async () => undefined } as never;
	const controller = new AbortController();
	await assert.rejects(editorStage(ui, controller.signal, { title: "t" }), /capabilities/);
	await assert.rejects(pickerStage(ui, controller.signal, { title: "t", steps }), /capabilities/);
});

test("picker: preselection renders checked and never checks an unselectable row", async () => {
	const host = makeFakeHost();
	const rows: GuardPickerStep[] = [
		{ occurrenceId: 0, label: "echo a", detail: "allow (read-only tier)", selectable: false },
		{ occurrenceId: 1, label: "curl https://example.com", detail: "prompt (host shell cell)" },
	];
	const promise = pickerStage(host.ui as never, new AbortController().signal, { title: "t", steps: rows, preselectedOccurrenceIds: [0, 1, 9] });
	const rendered = strip(host.overlays[0].component.render(80)).join("\n");
	assert.ok(rendered.includes("\u25cb echo a"), "the unselectable row is never preselected");
	assert.ok(rendered.includes("\u25c9 curl https://example.com"), "the prompting row starts checked");
	host.overlays[0].component.handleInput(ENTER);
	assert.deepEqual(await promise, [1], "missing IDs (9) are ignored");
});

test("picker: space on an unselectable row is a no-op", async () => {
	const host = makeFakeHost();
	const rows: GuardPickerStep[] = [
		{ occurrenceId: 0, label: "echo a", detail: "allow (read-only tier)", selectable: false },
		{ occurrenceId: 1, label: "curl https://example.com", detail: "prompt (host shell cell)" },
	];
	const promise = pickerStage(host.ui as never, new AbortController().signal, { title: "t", steps: rows, preselectedOccurrenceIds: [1] });
	const overlay = host.overlays[0].component;
	overlay.render(80);
	overlay.handleInput(SPACE); // highlighted row 0 is unselectable: no toggle
	const rendered = strip(overlay.render(80)).join("\n");
	assert.ok(!rendered.includes("\u25c9 echo a"), "the unselectable row stays unchecked");
	overlay.handleInput(ENTER);
	assert.deepEqual(await promise, [1], "the preselected prompting row survives the no-op toggle");
});

test("picker: requireSelection false settles an empty selection on enter; default ignores it", async () => {
	{
		const host = makeFakeHost();
		const promise = pickerStage(host.ui as never, new AbortController().signal, { title: "t", steps, requireSelection: false });
		const overlay = host.overlays[0].component;
		overlay.render(80);
		overlay.handleInput(ENTER);
		assert.deepEqual(await promise, [], "the allow picker may confirm zero selections");
	}
	{
		const host = makeFakeHost();
		const promise = pickerStage(host.ui as never, new AbortController().signal, { title: "t", steps });
		const overlay = host.overlays[0].component;
		overlay.render(80);
		overlay.handleInput(ENTER);
		assert.equal(host.overlays.length, 1, "the deny default still requires a selection");
		overlay.handleInput(ESC);
		assert.equal(await promise, undefined);
	}
});

test("space key matching sanity for the picker toggle", () => {
	assert.ok(matchesKey(SPACE, "space"));
});

// ── Runner ──────────────────────────────────────────────────────────────────────────
