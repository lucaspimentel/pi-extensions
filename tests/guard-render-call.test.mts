// Regression tests for the call headers of guard's shell tools (bash, host_bash).
//
// Loads the REAL guard extension with a fake pi API that captures registered tools, then asserts
// each shell tool renders a distinct tool-name title line followed by native bash's command
// presentation, delegated through the SDK's public createBashToolDefinition().renderCall. Results,
// execution callbacks, and non-rendering fields must stay untouched, so nothing is executed here:
// results are injected directly into a public ToolExecutionComponent instead.
//
// The SDK's native renderers use the global theme even when passed a mock, so initTheme("dark",
// false) runs before any rendering (watching disabled; no theme state is replaced in production).
//
// Run: node --test tests/guard-render-call.test.mts
import assert from "node:assert/strict";
import { test } from "node:test";

import { createBashToolDefinition, initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

initTheme("dark", false);

import guardExtension from "../extensions/guard/index.ts";

// ── Capture registered tools ─────────────────────────────────────────────────
const tools = new Map<string, any>();

const pi: any = {
	on: () => () => {},
	registerTool: (tool: any) => {
		if (tools.has(tool.name)) throw new Error(`duplicate tool: ${tool.name}`);
		tools.set(tool.name, tool);
	},
	registerCommand: () => {},
	registerShortcut: () => {},
	registerFlag: () => {},
	getCommands: () => [],
	getActiveTools: () => [],
	getAllTools: () => [],
	events: { on: () => () => {}, emit: () => {} },
};
(guardExtension as (api: unknown) => void)(pi);

const bash = tools.get("bash");
const hostBash = tools.get("host_bash");

// ── Helpers ──────────────────────────────────────────────────────────────────
// The SDK always passes its global theme to renderers; the stub only needs the members the
// adapters call. The native renderer ignores the passed theme entirely.
const themeStub = {
	fg: (_role: string, text: string) => text,
	bold: (text: string) => text,
} as any;

interface CallContextOverrides {
	args?: unknown;
	lastComponent?: unknown;
	state?: Record<string, unknown>;
	toolCallId?: string;
	expanded?: boolean;
	executionStarted?: boolean;
	isPartial?: boolean;
}

function makeContext(overrides: CallContextOverrides = {}): any {
	return {
		args: overrides.args ?? {},
		toolCallId: overrides.toolCallId ?? "call-1",
		invalidate: () => {},
		lastComponent: overrides.lastComponent,
		state: overrides.state ?? {},
		cwd: "/tmp/guard-render-call",
		executionStarted: overrides.executionStarted ?? false,
		argsComplete: true,
		isPartial: overrides.isPartial ?? false,
		expanded: overrides.expanded ?? false,
		showImages: false,
		isError: false,
	};
}

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function renderLines(tool: any, args: unknown, width: number, overrides: CallContextOverrides = {}): string[] {
	const component = tool.renderCall(args, themeStub, makeContext(overrides));
	assert.ok(component, "renderCall returned no component");
	return (component.render(width) as string[]).map((line) => stripAnsi(line).trimEnd());
}

// Native reference renderer, obtained the same way the adapter obtains it.
const nativeRenderCall = createBashToolDefinition(process.cwd(), { exposeSessionEnvironment: false }).renderCall!;

function nativeLines(args: unknown, width: number): string[] {
	const component = nativeRenderCall(args as any, themeStub, makeContext());
	return (component.render(width) as string[]).map((line) => stripAnsi(line).trimEnd());
}

const EXAMPLE_COMMAND = "cd /home/lucas/source/lucaspimentel/pi-extensions && npx tsc --noEmit && echo TSC-OK";

// ── Registration shape ───────────────────────────────────────────────────────
test("both guard shell tools are registered with a call renderer and unchanged non-rendering fields", () => {
	for (const [name, tool] of [["bash", bash], ["host_bash", hostBash]] as const) {
		assert.ok(tool, `${name} not registered`);
		assert.equal(tool.name, name);
		assert.equal(tool.label, name);
		assert.equal(typeof tool.renderCall, "function", `${name} renderCall`);
		assert.equal(tool.renderResult, undefined, `${name} must not gain a result renderer`);
		assert.equal(typeof tool.execute, "function", `${name} execute`);
		assert.ok(tool.description, `${name} description`);
		assert.ok(tool.parameters, `${name} parameters`);
	}
	// The guard-specific description markers must survive untouched.
	assert.match(bash.description, /Guard sandboxed except in raw profiles/);
	assert.match(hostBash.description, /Runs on the host, subject to HostBash rules and guard profile/);
});

// ── Header layout ────────────────────────────────────────────────────────────
test("host_bash renders its title line, then the example command with the native $ prompt", () => {
	const lines = renderLines(hostBash, { command: EXAMPLE_COMMAND }, 200);
	assert.equal(lines.length, 2);
	assert.equal(lines[0], "host_bash");
	assert.equal(lines[1], `$ ${EXAMPLE_COMMAND}`);
});

test("bash renders its own title with the same native command presentation", () => {
	const lines = renderLines(bash, { command: EXAMPLE_COMMAND }, 200);
	assert.equal(lines.length, 2);
	assert.equal(lines[0], "bash");
	assert.equal(lines[1], `$ ${EXAMPLE_COMMAND}`);
});

test("the two shell tools stay visibly distinguishable", () => {
	const bashTitle = renderLines(bash, { command: EXAMPLE_COMMAND }, 200)[0];
	const hostTitle = renderLines(hostBash, { command: EXAMPLE_COMMAND }, 200)[0];
	assert.notEqual(bashTitle, hostTitle);
	assert.equal(bashTitle, "bash");
	assert.equal(hostTitle, "host_bash");
});

test("the header avoids the generic inline argument formatting", () => {
	const rendered = renderLines(hostBash, { command: EXAMPLE_COMMAND, timeout: 90 }, 400).join("\n");
	assert.ok(!rendered.includes('command="'), "must not use the generic command= fallback");
});

// ── Native parity ────────────────────────────────────────────────────────────
const PARITY_CASES: Array<{ label: string; args: Record<string, unknown> }> = [
	{ label: "plain command", args: { command: "echo hello" } },
	{ label: "example command", args: { command: EXAMPLE_COMMAND } },
	{ label: "timeout", args: { command: EXAMPLE_COMMAND, timeout: 90 } },
	{ label: "timeout 1s", args: { command: "sleep 5", timeout: 1 } },
	{ label: "no timeout", args: { command: "sleep 5" } },
	{ label: "quotes and backslashes", args: { command: 'echo "a\\b" && printf \'%s\\n\' "c d"' } },
	{ label: "shell operators", args: { command: "a | b > /tmp/out 2>&1; c && d || e &" } },
	{ label: "unicode", args: { command: "echo 'héllo → wörld ✓ 日本語'" } },
	{ label: "multiline command", args: { command: "for i in 1 2 3; do\necho $i\ndone" } },
	{ label: "leading and trailing spaces", args: { command: "  echo kept  " } },
	{ label: "missing command", args: {} },
	{ label: "empty command", args: { command: "" } },
	{ label: "non-string command", args: { command: 42 } },
];

test("command body matches the public native renderer across the parity cases", () => {
	for (const { label, args } of PARITY_CASES) {
		for (const tool of [bash, hostBash]) {
			const lines = renderLines(tool, args, 500);
			const expected = nativeLines(args, 500);
			assert.deepEqual(lines.slice(1), expected, `${tool.name}: ${label}`);
		}
	}
});

test("missing, empty, and invalid commands follow native behavior without throwing", () => {
	assert.deepEqual(renderLines(hostBash, {}, 200), ["host_bash", "$ ..."]);
	assert.deepEqual(renderLines(hostBash, { command: "" }, 200), ["host_bash", "$ ..."]);
	assert.deepEqual(renderLines(hostBash, { command: 42 } as any, 200), ["host_bash", "$ [invalid arg]"]);
});

test("timeout suffix follows native formatting", () => {
	assert.match(renderLines(hostBash, { command: "sleep 5", timeout: 90 }, 400).join("\n"), /\(timeout 90s\)$/);
	assert.doesNotMatch(renderLines(hostBash, { command: "sleep 5" }, 400).join("\n"), /timeout/);
});

// ── Width behavior ───────────────────────────────────────────────────────────
test("a wide terminal renders the long command untruncated on one line", () => {
	const lines = renderLines(hostBash, { command: EXAMPLE_COMMAND }, 2000);
	assert.equal(lines[1], `$ ${EXAMPLE_COMMAND}`);
});

test("narrow widths wrap within the visible-column budget and match native wrapping", () => {
	for (const width of [20, 40, 80]) {
		for (const tool of [bash, hostBash]) {
			const lines = renderLines(tool, { command: EXAMPLE_COMMAND, timeout: 90 }, width);
			assert.equal(lines[0], tool.name);
			for (const line of lines.slice(1)) {
				assert.ok(visibleWidth(line) <= width, `${tool.name}@${width}: line too wide: ${JSON.stringify(line)}`);
			}
			assert.deepEqual(lines.slice(1), nativeLines({ command: EXAMPLE_COMMAND, timeout: 90 }, width), `width ${width}`);
		}
	}
});

// ── Repeated renders and state isolation ─────────────────────────────────────
test("repeated renders with the previous component passed back are stable and reuse it", () => {
	const state: Record<string, unknown> = {};
	const args = { command: EXAMPLE_COMMAND };
	const first = bash.renderCall(args, themeStub, makeContext({ state, args }));
	const firstLines = (first.render(120) as string[]).map((line) => stripAnsi(line).trimEnd());
	const second = bash.renderCall(args, themeStub, makeContext({ state, args, lastComponent: first }));
	assert.equal(second, first, "the outer container should be reused across renders");
	const secondLines = (second.render(120) as string[]).map((line) => stripAnsi(line).trimEnd());
	assert.deepEqual(secondLines, firstLines);
});

test("argument updates re-render with the new command", () => {
	const state: Record<string, unknown> = {};
	const before = renderLines(hostBash, { command: "echo one" }, 200, { state });
	const after = renderLines(hostBash, { command: "echo two" }, 200, { state });
	assert.equal(before[1], "$ echo one");
	assert.equal(after[1], "$ echo two");
});

test("simultaneous tool rows keep components and state isolated", () => {
	const stateA: Record<string, unknown> = {};
	const stateB: Record<string, unknown> = {};
	const linesA = renderLines(bash, { command: "echo alpha" }, 200, { state: stateA, toolCallId: "a" });
	const linesB = renderLines(hostBash, { command: "echo beta" }, 200, { state: stateB, toolCallId: "b" });
	assert.deepEqual(linesA, ["bash", "$ echo alpha"]);
	assert.deepEqual(linesB, ["host_bash", "$ echo beta"]);
	// Re-render row A; row B's state must not have been touched.
	const linesA2 = renderLines(bash, { command: "echo gamma" }, 200, { state: stateA, toolCallId: "a" });
	assert.equal(linesA2[1], "$ echo gamma");
	assert.deepEqual(renderLines(hostBash, { command: "echo beta" }, 200, { state: stateB, toolCallId: "b" }), linesB);
});

test("collapsed and expanded contexts keep the title separate with native call formatting", () => {
	for (const expanded of [false, true]) {
		const lines = renderLines(hostBash, { command: EXAMPLE_COMMAND }, 200, { expanded });
		assert.equal(lines[0], "host_bash");
		assert.equal(lines[1], `$ ${EXAMPLE_COMMAND}`);
	}
});

test("execution started transitions do not throw and keep the header", () => {
	const state: Record<string, unknown> = {};
	const lines = renderLines(hostBash, { command: EXAMPLE_COMMAND }, 200, { state, executionStarted: true });
	assert.equal(lines[0], "host_bash");
	assert.equal(lines[1], `$ ${EXAMPLE_COMMAND}`);
	assert.equal(typeof state.startedAt, "number", "native renderer records the start time in shared state");
});

test("partial (streaming) argument rendering stays native", () => {
	const state: Record<string, unknown> = {};
	const partial = renderLines(hostBash, {}, 200, { state, isPartial: true, argsComplete: false } as CallContextOverrides);
	assert.deepEqual(partial, ["host_bash", "$ ..."]);
	const complete = renderLines(hostBash, { command: "echo done" }, 200, { state, argsComplete: true });
	assert.equal(complete[1], "$ echo done");
});

// ── ToolExecutionComponent integration ───────────────────────────────────────
test("ToolExecutionComponent uses the new header instead of the generic fallback", () => {
	const ui = { requestRender() {} };
	const component = new ToolExecutionComponent("host_bash", "tc1", { command: EXAMPLE_COMMAND }, {}, hostBash, ui, "/tmp/guard-render-call");
	component.markExecutionStarted();
	component.updateResult({ content: [{ type: "text", text: "hello\nworld" }], details: undefined }, false);
	const lines = (component.render(120) as string[]).map((line) => stripAnsi(line).trimEnd());
	const text = lines.join("\n");
	assert.ok(text.includes("host_bash"), "title line present");
	assert.ok(text.includes(`$ ${EXAMPLE_COMMAND}`), "native command line present");
	assert.ok(!text.includes('command="'), "generic fallback must not be used");
	assert.ok(text.includes("hello") && text.includes("world"), "output preview still rendered");
});

test("error results keep the header and render the error content", () => {
	const ui = { requestRender() {} };
	const component = new ToolExecutionComponent("bash", "tc2", { command: "boom" }, {}, bash, ui, "/tmp/guard-render-call");
	component.updateResult({ content: [{ type: "text", text: "command failed: boom" }], details: undefined, isError: true }, false);
	const text = (component.render(120) as string[]).map((line) => stripAnsi(line).trimEnd()).join("\n");
	assert.ok(text.includes("bash"));
	assert.ok(text.includes("$ boom"));
	assert.ok(text.includes("command failed: boom"));
});

test("appended guard warnings remain visible under the existing result presentation", () => {
	const ui = { requestRender() {} };
	const component = new ToolExecutionComponent("host_bash", "tc3", { command: EXAMPLE_COMMAND }, {}, hostBash, ui, "/tmp/guard-render-call");
	const warning = "guard: sandbox violation hint";
	component.updateResult({ content: [{ type: "text", text: "out" }, { type: "text", text: warning }], details: undefined }, false);
	const text = (component.render(120) as string[]).map((line) => stripAnsi(line).trimEnd()).join("\n");
	assert.ok(text.includes(warning), "guard warning text must survive result presentation");
});
