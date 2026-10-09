// Timestamps extension tests: pure formatting helpers, the registerToolRenderer
// wrapper (composition, partial data, result line placement), delta anchoring,
// and history backfill from a fake session branch.
//
// Run: node --test tests/timestamps.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";

import type { Component } from "@earendil-works/pi-tui";
import { Container, Text } from "@earendil-works/pi-tui";

import timestampsExtension from "../extensions/timestamps/index.ts";
import {
	formatAbsolute,
	formatDelta,
	formatDuration,
	formatResultLine,
} from "../extensions/timestamps/format.ts";

// ── Mock scaffolding ──────────────────────────────────────────────────────────

const WIDTH = 1000; // large enough that no wrapping occurs

// fg(role, text) wraps text with visible role markers so assertions can verify
// the "dim" role is used.
const theme: any = {
	fg(role: string, text: string) {
		return `⟨${role}⟩${text}⟨/role⟩`;
	},
};

interface Loaded {
	resolver: (toolName: string, next: () => any) => any;
	handler(event: string): ((...args: any[]) => any) | undefined;
}

function loadExtension(): Loaded {
	const handlers = new Map<string, (...args: any[]) => any>();
	let resolver: ((toolName: string, next: () => any) => any) | undefined;
	const pi: any = {
		on(event: string, handler: (...args: any[]) => any) {
			handlers.set(event, handler);
			return () => {};
		},
		registerToolRenderer(r: (toolName: string, next: () => any) => any) {
			resolver = r;
		},
	};
	(timestampsExtension as any)(pi);
	assert.ok(resolver, "extension did not register a tool renderer resolver");
	return {
		resolver,
		handler(event: string) {
			return handlers.get(event);
		},
	};
}

interface RenderContext {
	toolCallId: string;
	state: Record<string, unknown>;
	lastComponent: Component | undefined;
	invalidate: () => void;
}

function makeContext(toolCallId: string): RenderContext {
	return { toolCallId, state: {}, lastComponent: undefined, invalidate: () => {} };
}

/** A fake native call renderer: a Container with a header Text child. */
function makeBaseRenderers() {
	return {
		renderers: {
			renderCall(_args: any, _theme: any, _context: any): Component {
				const container = new Container();
				container.addChild(new Text("● tool header"));
				return container;
			},
			renderResult(_result: any, _options: any, _theme: any, _context: any): Component {
				const container = new Container();
				container.addChild(new Text("⎿ result header"));
				container.addChild(new Text("  result body"));
				return container;
			},
		},
	};
}

function renderLines(component: any): string[] {
	// Trailing padding is stripped so line-level assertions can anchor on $.
	return (component.render(WIDTH) as string[]).map((line) => line.replace(/\s+$/, ""));
}

function tsLineOf(lines: string[]): string | undefined {
	return lines.find((line) => line.includes("⟨dim⟩"));
}

// ── Formatting helpers ────────────────────────────────────────────────────────

test("formatAbsolute renders local HH:MM:SS on the same day", () => {
	// Built from local date parts so the assertion holds in any timezone.
	const at = (day: number, h: number, m: number, s: number) => new Date(2026, 9, day, h, m, s).getTime();
	assert.equal(formatAbsolute(at(8, 14, 32, 5), at(8, 23, 0, 0)), "14:32:05");
	assert.equal(formatAbsolute(at(8, 0, 0, 0), at(8, 12, 0, 0)), "00:00:00");
});

test("formatAbsolute prefixes MM-DD on previous days", () => {
	const yesterday = new Date(2026, 9, 7, 18, 52, 11).getTime();
	const today = new Date(2026, 9, 8, 9, 0, 0).getTime();
	assert.equal(formatAbsolute(yesterday, today), "10-07 18:52:11");
});

test("formatDelta switches units at 60s and 1h", () => {
	assert.equal(formatDelta(3000), "+3s");
	assert.equal(formatDelta(0), "+0s");
	assert.equal(formatDelta(59999), "+59s");
	assert.equal(formatDelta(60000), "+1:00");
	assert.equal(formatDelta(107000), "+1:47");
	assert.equal(formatDelta(3599000), "+59:59");
	assert.equal(formatDelta(3600000), "+1:00:00");
	assert.equal(formatDelta(3723000), "+1:02:03");
});

test("formatDuration uses one decimal under 10s and adaptive units above", () => {
	assert.equal(formatDuration(2100), "2.1s");
	assert.equal(formatDuration(9950), "9.9s");
	assert.equal(formatDuration(10000), "10s");
	assert.equal(formatDuration(14000), "14s");
	assert.equal(formatDuration(59900), "59s");
	assert.equal(formatDuration(74000), "1m14s");
	assert.equal(formatDuration(3723000), "1:02:03");
});

test("formatResultLine prefixes the duration only when included, known, and non-zero", () => {
	const now = new Date(2026, 9, 8, 15, 0, 0).getTime();
	const end = new Date(2026, 9, 8, 14, 32, 7).getTime();
	assert.equal(formatResultLine(2100, end, now, true), "ran 2.1s  ended 14:32:07");
	assert.equal(formatResultLine(2100, end, now, false), "ended 14:32:07");
	assert.equal(formatResultLine(undefined, end, now, true), "ended 14:32:07");
	assert.equal(formatResultLine(undefined, end, now, false), "ended 14:32:07");
	// Sub-100ms durations would read as 0.0s, so they are omitted.
	assert.equal(formatResultLine(0, end, now, true), "ended 14:32:07");
	assert.equal(formatResultLine(40, end, now, true), "ended 14:32:07");
	assert.equal(formatResultLine(99, end, now, true), "ended 14:32:07");
	assert.equal(formatResultLine(100, end, now, true), "ran 0.1s  ended 14:32:07");
});

// ── Resolver wiring ───────────────────────────────────────────────────────────

test("resolver augments base renderers and preserves their output", () => {
	const loaded = loadExtension();
	const base = makeBaseRenderers();
	const wrapped = loaded.resolver("bash", () => base.renderers);
	assert.ok(wrapped, "resolver returned undefined for a known base");
	assert.notEqual(wrapped.renderCall, base.renderers.renderCall);
	assert.notEqual(wrapped.renderResult, base.renderers.renderResult);

	const lines = renderLines(wrapped.renderCall({ command: "ls" }, theme, makeContext("call-1")));
	assert.ok(lines.some((line) => line.includes("● tool header")), "base header line missing");
});

test("resolver returns undefined when no base renderers exist", () => {
	const loaded = loadExtension();
	assert.equal(loaded.resolver("mystery", () => undefined), undefined);
});

test("call line is omitted entirely when the call id is unknown", () => {
	const loaded = loadExtension();
	const base = makeBaseRenderers();
	const wrapped = loaded.resolver("bash", () => base.renderers);
	const lines = renderLines(wrapped.renderCall({}, theme, makeContext("unknown-id")));
	assert.ok(lines.every((line) => !line.includes("⟨dim⟩")), `unexpected timestamp line: ${JSON.stringify(lines)}`);
	assert.ok(lines.some((line) => line.includes("● tool header")), "base header line missing");
});

// ── Live capture and rendering ────────────────────────────────────────────────

test("live call renders absolute and delta immediately, running elapsed once 100ms pass", async () => {
	const loaded = loadExtension();
	const base = makeBaseRenderers();
	const wrapped = loaded.resolver("read", () => base.renderers);

	const userTs = Date.now() - 3000;
	loaded.handler("message_end")!({ type: "message_end", message: { role: "user", timestamp: userTs } });
	loaded.handler("tool_execution_start")!({ type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: {} });

	// Right after execution starts the elapsed time is sub-100ms and omitted.
	const instant = tsLineOf(renderLines(wrapped.renderCall({}, theme, makeContext("c1"))));
	assert.ok(instant, "no dim timestamp line");
	assert.match(instant!, /^\s*⟨dim⟩\d\d:\d\d:\d\d  \+3s⟨\/role⟩$/);
	assert.ok(!instant!.includes("ran "), "sub-100ms elapsed must be omitted");

	await new Promise((resolve) => setTimeout(resolve, 150));
	const tsLine = tsLineOf(renderLines(wrapped.renderCall({}, theme, makeContext("c1"))));
	assert.ok(tsLine, "no dim timestamp line after 100ms");
	assert.match(tsLine!, /^\s*⟨dim⟩\d\d:\d\d:\d\d  \+3s  ran \d+\.\ds…⟨\/role⟩$/);
});

test("instant tool shows no duration anywhere", () => {
	const loaded = loadExtension();
	const base = makeBaseRenderers();
	const wrapped = loaded.resolver("read", () => base.renderers);

	loaded.handler("tool_execution_start")!({ type: "tool_execution_start", toolCallId: "z1", toolName: "read", args: {} });
	loaded.handler("tool_execution_end")!({
		type: "tool_execution_end",
		toolCallId: "z1",
		toolName: "read",
		result: {},
		isError: false,
		durationMs: 0,
	});

	const callLine = tsLineOf(renderLines(wrapped.renderCall({}, theme, makeContext("z1"))));
	assert.ok(callLine, "no dim call line");
	assert.ok(!callLine!.includes("ran "), `zero-duration call line must omit ran: ${callLine}`);

	const resultLine = tsLineOf(
		renderLines(wrapped.renderResult({ content: [] }, { expanded: false, isPartial: false }, theme, makeContext("z1"))),
	);
	assert.ok(resultLine, "no dim result line");
	assert.match(resultLine!, /^\s*⟨dim⟩ended \d\d:\d\d:\d\d⟨\/role⟩$/);
});

test("completed call line drops the ran segment; the duration moves to the result line", () => {
	const loaded = loadExtension();
	const base = makeBaseRenderers();
	const wrapped = loaded.resolver("read", () => base.renderers);

	loaded.handler("message_end")!({ type: "message_end", message: { role: "user", timestamp: Date.now() - 10_000 } });
	loaded.handler("tool_execution_start")!({ type: "tool_execution_start", toolCallId: "c2", toolName: "read", args: {} });
	loaded.handler("tool_execution_end")!({
		type: "tool_execution_end",
		toolCallId: "c2",
		toolName: "read",
		result: {},
		isError: false,
		durationMs: 2100,
	});

	const tsLine = tsLineOf(renderLines(wrapped.renderCall({}, theme, makeContext("c2"))));
	assert.ok(tsLine, "no dim timestamp line");
	assert.match(tsLine!, /^\s*⟨dim⟩\d\d:\d\d:\d\d  \+\d+s⟨\/role⟩$/);
	assert.ok(!tsLine!.includes("ran "), "completed call line must not show the duration");
	assert.ok(!tsLine!.includes("…"), "completed call must not show the running suffix");

	const resultLine = tsLineOf(
		renderLines(wrapped.renderResult({ content: [] }, { expanded: false, isPartial: false }, theme, makeContext("c2"))),
	);
	assert.ok(resultLine, "no dim result line");
	assert.match(resultLine!, /^\s*⟨dim⟩ran 2\.1s  ended \d\d:\d\d:\d\d⟨\/role⟩$/);
});

test("shell tools never show the extension's own duration", () => {
	const loaded = loadExtension();
	const base = makeBaseRenderers();
	const wrapped = loaded.resolver("bash", () => base.renderers);

	loaded.handler("message_end")!({ type: "message_end", message: { role: "user", timestamp: Date.now() - 5000 } });
	loaded.handler("tool_execution_start")!({ type: "tool_execution_start", toolCallId: "s1", toolName: "bash", args: {} });

	const running = tsLineOf(renderLines(wrapped.renderCall({}, theme, makeContext("s1"))));
	assert.ok(running, "no dim line while running");
	assert.match(running!, /^\s*⟨dim⟩\d\d:\d\d:\d\d  \+\d+s⟨\/role⟩$/);
	assert.ok(!running!.includes("ran "), "running shell call line must not show the duration");

	loaded.handler("tool_execution_end")!({
		type: "tool_execution_end",
		toolCallId: "s1",
		toolName: "bash",
		result: {},
		isError: false,
		durationMs: 3000,
	});

	const done = tsLineOf(renderLines(wrapped.renderCall({}, theme, makeContext("s1"))));
	assert.ok(done, "no dim line when completed");
	assert.ok(!done!.includes("ran "), "completed shell call line must not show the duration");

	const resultLine = tsLineOf(
		renderLines(wrapped.renderResult({ content: [] }, { expanded: false, isPartial: false }, theme, makeContext("s1"))),
	);
	assert.ok(resultLine, "no dim result line");
	assert.match(resultLine!, /^\s*⟨dim⟩ended \d\d:\d\d:\d\d⟨\/role⟩$/);
});

// ── Backfill from session history ─────────────────────────────────────────────

interface FakeMessage {
	role: string;
	timestamp: number;
	content?: unknown;
	toolCallId?: string;
}

function branchEntry(message: FakeMessage) {
	return { type: "message", message };
}

/** Today's wall-clock time, so same-day (time-only) assertions hold on any run date. */
function atToday(h: number, m: number, s: number): number {
	const now = new Date();
	return new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, s).getTime();
}

test("backfill approximates start and end and anchors the first delta at the user prompt", () => {
	const loaded = loadExtension();
	const base = makeBaseRenderers();
	const wrapped = loaded.resolver("read", () => base.renderers);

	const userTs = atToday(14, 32, 0);
	const assistantTs = atToday(14, 32, 5);
	const firstResultTs = atToday(14, 32, 9);
	const secondResultTs = atToday(14, 33, 0);
	const branch = [
		branchEntry({ role: "user", timestamp: userTs }),
		branchEntry({
			role: "assistant",
			timestamp: assistantTs,
			content: [{ type: "toolCall", id: "b1" }, { type: "toolCall", id: "b2" }],
		}),
		branchEntry({ role: "toolResult", timestamp: firstResultTs, toolCallId: "b1" }),
		branchEntry({ role: "toolResult", timestamp: secondResultTs, toolCallId: "b2" }),
	];
	loaded.handler("session_start")!(
		{ type: "session_start", reason: "resume" },
		{ sessionManager: { getBranch: () => branch } },
	);

	// Parallel calls share the assistant timestamp as their start proxy, so both
	// show the same delta (from the user prompt). The approximate elapsed value
	// (end minus the start proxy) appears on the result line, not the call line.
	const first = tsLineOf(renderLines(wrapped.renderCall({}, theme, makeContext("b1"))));
	assert.ok(first, "no dim line for b1");
	assert.match(first!, /^\s*⟨dim⟩14:32:05  \+5s⟨\/role⟩$/);

	const firstResult = tsLineOf(
		renderLines(wrapped.renderResult({ content: [] }, { expanded: false, isPartial: false }, theme, makeContext("b1"))),
	);
	assert.ok(firstResult, "no dim result line for b1");
	assert.match(firstResult!, /^\s*⟨dim⟩ran 4\.0s  ended 14:32:09⟨\/role⟩$/);

	const second = tsLineOf(renderLines(wrapped.renderCall({}, theme, makeContext("b2"))));
	assert.ok(second, "no dim line for b2");
	assert.match(second!, /^\s*⟨dim⟩14:32:05  \+5s⟨\/role⟩$/);

	const secondResult = tsLineOf(
		renderLines(wrapped.renderResult({ content: [] }, { expanded: false, isPartial: false }, theme, makeContext("b2"))),
	);
	assert.ok(secondResult, "no dim result line for b2");
	assert.match(secondResult!, /^\s*⟨dim⟩ran 55s  ended 14:33:00⟨\/role⟩$/);
});

test("later backfilled batch anchors its delta at the previous tool result", () => {
	const loaded = loadExtension();
	const base = makeBaseRenderers();
	const wrapped = loaded.resolver("read", () => base.renderers);

	const userTs = atToday(14, 32, 0);
	const assistant1Ts = atToday(14, 32, 5);
	const result1Ts = atToday(14, 32, 9);
	const assistant2Ts = atToday(14, 32, 30);
	const result2Ts = atToday(14, 32, 40);
	const branch = [
		branchEntry({ role: "user", timestamp: userTs }),
		branchEntry({ role: "assistant", timestamp: assistant1Ts, content: [{ type: "toolCall", id: "n1" }] }),
		branchEntry({ role: "toolResult", timestamp: result1Ts, toolCallId: "n1" }),
		branchEntry({ role: "assistant", timestamp: assistant2Ts, content: [{ type: "toolCall", id: "n2" }] }),
		branchEntry({ role: "toolResult", timestamp: result2Ts, toolCallId: "n2" }),
	];
	loaded.handler("session_start")!(
		{ type: "session_start", reason: "resume" },
		{ sessionManager: { getBranch: () => branch } },
	);

	const second = tsLineOf(renderLines(wrapped.renderCall({}, theme, makeContext("n2"))));
	assert.ok(second, "no dim line for n2");
	assert.match(second!, /^\s*⟨dim⟩14:32:30  \+21s⟨\/role⟩$/);

	const secondResult = tsLineOf(
		renderLines(wrapped.renderResult({ content: [] }, { expanded: false, isPartial: false }, theme, makeContext("n2"))),
	);
	assert.ok(secondResult, "no dim result line for n2");
	assert.match(secondResult!, /^\s*⟨dim⟩ran 10s  ended 14:32:40⟨\/role⟩$/);
});

test("historical call without an end omits the elapsed segment", () => {
	const loaded = loadExtension();
	const base = makeBaseRenderers();
	const wrapped = loaded.resolver("bash", () => base.renderers);

	const assistantTs = new Date(2026, 9, 7, 10, 0, 0).getTime();
	loaded.handler("session_start")!(
		{ type: "session_start", reason: "resume" },
		{
			sessionManager: {
				getBranch: () => [
					branchEntry({ role: "assistant", timestamp: assistantTs, content: [{ type: "toolCall", id: "h1" }] }),
				],
			},
		},
	);

	const tsLine = tsLineOf(renderLines(wrapped.renderCall({}, theme, makeContext("h1"))));
	assert.ok(tsLine, "no dim timestamp line");
	assert.ok(tsLine!.includes("10-07 10:00:00"), `date-prefixed absolute missing: ${tsLine}`);
	assert.ok(!/ran /.test(tsLine!), `elapsed must be omitted without an end: ${tsLine}`);
});

test("message_end events anchor live deltas between calls", () => {
	const loaded = loadExtension();
	const base = makeBaseRenderers();
	const wrapped = loaded.resolver("bash", () => base.renderers);

	const before = Date.now();
	loaded.handler("tool_execution_start")!({ type: "tool_execution_start", toolCallId: "l1", toolName: "bash", args: {} });
	loaded.handler("tool_execution_end")!({ type: "tool_execution_end", toolCallId: "l1", toolName: "bash", result: {}, isError: false, durationMs: 100 });
	loaded.handler("message_end")!({ type: "message_end", message: { role: "toolResult", timestamp: before - 2000 } });
	loaded.handler("tool_execution_start")!({ type: "tool_execution_start", toolCallId: "l2", toolName: "bash", args: {} });

	const tsLine = tsLineOf(renderLines(wrapped.renderCall({}, theme, makeContext("l2"))));
	assert.ok(tsLine, "no dim line for l2");
	assert.match(tsLine!, /\+2s/);
});

// ── Result rendering ──────────────────────────────────────────────────────────

test("result line sits at the bottom of a Container result", () => {
	const loaded = loadExtension();
	const base = makeBaseRenderers();
	const wrapped = loaded.resolver("read", () => base.renderers);

	loaded.handler("tool_execution_start")!({ type: "tool_execution_start", toolCallId: "r1", toolName: "read", args: {} });
	loaded.handler("tool_execution_end")!({ type: "tool_execution_end", toolCallId: "r1", toolName: "read", result: {}, isError: false, durationMs: 500 });

	const result = wrapped.renderResult({ content: [] }, { expanded: false, isPartial: false }, theme, makeContext("r1"));
	const lines = renderLines(result);
	const headerIndex = lines.findIndex((line) => line.includes("⎿ result header"));
	const endIndex = lines.findIndex((line) => line.includes("⟨dim⟩"));
	const bodyIndex = lines.findIndex((line) => line.includes("result body"));
	assert.ok(headerIndex !== -1 && endIndex !== -1 && bodyIndex !== -1, JSON.stringify(lines));
	assert.ok(endIndex > headerIndex && endIndex > bodyIndex, `ended line misplaced: ${JSON.stringify(lines)}`);
	const lastContentIndex = lines.reduce((last, line, index) => (line.trim() ? index : last), -1);
	assert.equal(endIndex, lastContentIndex, `ended line must be the last content line: ${JSON.stringify(lines)}`);
	assert.match(lines[endIndex]!, /ran 0\.5s  ended \d\d:\d\d:\d\d/);
});

test("partial results do not show an ended line", () => {
	const loaded = loadExtension();
	const base = makeBaseRenderers();
	const wrapped = loaded.resolver("bash", () => base.renderers);

	loaded.handler("tool_execution_start")!({ type: "tool_execution_start", toolCallId: "p1", toolName: "bash", args: {} });
	loaded.handler("tool_execution_end")!({ type: "tool_execution_end", toolCallId: "p1", toolName: "bash", result: {}, isError: false, durationMs: 100 });

	const lines = renderLines(
		wrapped.renderResult({ content: [] }, { expanded: false, isPartial: true }, theme, makeContext("p1")),
	);
	assert.ok(!lines.some((line) => line.includes("ended")), JSON.stringify(lines));
});

// ── Lifecycle ─────────────────────────────────────────────────────────────────

test("session_shutdown stops tickers without throwing", () => {
	const loaded = loadExtension();
	const base = makeBaseRenderers();
	const wrapped = loaded.resolver("bash", () => base.renderers);

	loaded.handler("tool_execution_start")!({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} });
	wrapped.renderCall({}, theme, makeContext("t1"));
	loaded.handler("session_shutdown")!({ type: "session_shutdown" });
	// After shutdown the row must still render (without a live ticker).
	const component = wrapped.renderCall({}, theme, makeContext("t1"));
	assert.ok(component);
});
