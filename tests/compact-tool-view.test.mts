// compact-tool-view tests: pure gist derivation, the config loader, and the
// registerToolRenderer resolver (collapsed gist replacement, expanded/streaming
// delegation, hide mode, failure surfacing, and name pass-through).
//
// Run: node --test tests/compact-tool-view.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Text } from "@earendil-works/pi-tui";

import compactToolView from "../extensions/compact-tool-view/index.ts";
import timestampsExtension from "../extensions/timestamps/index.ts";
import { DEFAULT_MODES, loadModes } from "../extensions/compact-tool-view/config.ts";
import { gistFor } from "../extensions/compact-tool-view/gist.ts";

// ── Mock scaffolding ──────────────────────────────────────────────────────────

const WIDTH = 1000; // large enough that no wrapping occurs

// fg(role, text) wraps text with visible role markers so assertions can verify
// which role a line used.
const theme: any = {
	fg(role: string, text: string) {
		return `\u27e8${role}\u27e9${text}\u27e8/role\u27e9`;
	},
};

interface Loaded {
	resolver: (toolName: string, next: () => any) => any;
}

function loadExtension(agentDir: string): Loaded {
	// The factory reads the config at factory time via getAgentDir(), which
	// honors PI_CODING_AGENT_DIR.
	process.env.PI_CODING_AGENT_DIR = agentDir;
	let resolver: ((toolName: string, next: () => any) => any) | undefined;
	const pi: any = {
		on() {
			return () => {};
		},
		registerToolRenderer(r: (toolName: string, next: () => any) => any) {
			resolver = r;
		},
	};
	(compactToolView as any)(pi);
	assert.ok(resolver, "extension did not register a tool renderer resolver");
	return { resolver };
}

function makeContext(args: unknown = {}, isError = false): any {
	return {
		args,
		toolCallId: "t1",
		state: {},
		isError,
		keyHint: (keybinding: string, description: string) => `[${keybinding}: ${description}]`,
	};
}

function makeBase() {
	return {
		renderResult: () => new Text("base body"),
	};
}

function renderLines(component: any): string[] {
	return (component.render(WIDTH) as string[]).map((line) => line.replace(/\s+$/, ""));
}

const emptyDir = () => mkdtempSync(join(tmpdir(), "ctv-empty-"));

function configDir(config: Record<string, unknown>): string {
	const dir = mkdtempSync(join(tmpdir(), "ctv-config-"));
	writeFileSync(join(dir, "compact-tool-view.json"), JSON.stringify(config));
	return dir;
}

const textResult = (text: string) => ({ content: [{ type: "text", text }] });

// ── Gist derivation ───────────────────────────────────────────────────────────

test("read gists line count, truncation, and image reads", () => {
	assert.deepEqual(gistFor("read", textResult("a\nb\nc"), {}), ["3 lines"]);
	assert.deepEqual(
		gistFor("read", { content: [{ type: "text", text: "a\nb" }], details: { truncation: { truncated: true, totalLines: 412 } } }, {}),
		["412 lines, truncated"],
	);
	assert.deepEqual(
		gistFor(
			"read",
			{ content: [{ type: "text", text: "Read image file [image/png]" }, { type: "image", data: "x", mimeType: "image/png" }] },
			{},
		),
		["image"],
	);
});

test("bash, host_bash, and powershell gist the structured output line count", () => {
	const result = { content: [{ type: "text", text: "a\nb\nc" }], structuredContent: { output: "a\nb\nc", exit_code: 0 } };
	assert.deepEqual(gistFor("bash", result, {}), ["done (3 lines)"]);
	assert.deepEqual(gistFor("host_bash", result, {}), ["done (3 lines)"]);
	assert.deepEqual(gistFor("powershell", result, {}), ["done (3 lines)"]);
});

test("edit gists added and removed line counts", () => {
	const diff = "+1 a\n+2 b\n+3 c\n+4 d\n-1 e\n-2 f\n 3 g";
	assert.deepEqual(gistFor("edit", { content: [], details: { diff } }, {}), ["+4 / -2"]);
});

test("grep, find, and ls gist counts with limit markers", () => {
	assert.deepEqual(gistFor("grep", textResult("a:1:x\nb:2:y"), {}), ["2 matches"]);
	assert.deepEqual(gistFor("grep", { content: [], details: { matchLimitReached: 7 } }, {}), ["7+ matches"]);
	assert.deepEqual(gistFor("find", textResult("a\nb\nc"), {}), ["3 files"]);
	assert.deepEqual(gistFor("find", { content: [], details: { resultLimitReached: 23 } }, {}), ["23+ files"]);
	assert.deepEqual(gistFor("ls", textResult(Array.from({ length: 14 }, (_, i) => `e${i}`).join("\n")), {}), ["14 entries"]);
	assert.deepEqual(gistFor("ls", { content: [], details: { entryLimitReached: 14 } }, {}), ["14+ entries"]);
});

test("ffgrep and fffind gist their typed totals", () => {
	assert.deepEqual(gistFor("ffgrep", { content: [], details: { totalMatched: 7, totalFiles: 3 } }, {}), ["7 matches in 3 files"]);
	assert.deepEqual(gistFor("fffind", { content: [], details: { totalMatched: 23, totalFiles: 40 } }, {}), ["23 files"]);
});

test("python and node gist the worker status", () => {
	assert.deepEqual(gistFor("python", { content: [], details: { status: "ok" } }, {}), ["ok"]);
	assert.deepEqual(gistFor("node", { content: [], details: { status: "runtime_error" } }, {}), ["runtime_error"]);
});

test("write gists the line count from the call arguments", () => {
	assert.deepEqual(gistFor("write", textResult("Successfully wrote to /x"), { content: "a\nb\nc" }), ["3 lines written"]);
});

test("tools without a typed gist fall back to the line count or image", () => {
	assert.deepEqual(gistFor("web_fetch", textResult("a\nb"), {}), ["2 lines"]);
	assert.deepEqual(gistFor("unknown_tool", { content: [{ type: "image", data: "x", mimeType: "image/png" }] }, {}), ["image"]);
});

test("an unexpected details shape falls through to the generic fallback", () => {
	// A bash-shaped details object on an unknown tool must not be read.
	assert.deepEqual(gistFor("unknown_tool", { content: [{ type: "text", text: "a\nb" }], details: { diff: "+x" } }, {}), ["2 lines"]);
	assert.deepEqual(gistFor("read", { content: [{ type: "text", text: "a\nb" }], details: { truncation: "nope" } }, {}), ["2 lines"]);
});

test("failures surface exit codes and the first error line", () => {
	assert.deepEqual(
		gistFor("bash", { content: [{ type: "text", text: "boom" }], structuredContent: { exit_code: 1 }, isError: true }, {}),
		["exit 1"],
	);
	// pi's ToolExecutionComponent does not forward structuredContent; the native
	// shell tools append the exit status to the model-facing text instead.
	assert.deepEqual(
		gistFor("bash", { content: [{ type: "text", text: "boom\n\nCommand exited with code 3" }], isError: true }, {}),
		["exit 3"],
	);
	assert.deepEqual(gistFor("web_fetch", { content: [{ type: "text", text: "boom\nmore" }], isError: true }, {}), ["error: boom"]);
});

test("content blocks beyond the first render as extra dimmed lines", () => {
	assert.deepEqual(
		gistFor("read", { content: [{ type: "text", text: "a\nb\nc" }, { type: "text", text: "guard: rule saved" }] }, {}),
		["3 lines", "guard: rule saved"],
	);
});

// ── Config loader ─────────────────────────────────────────────────────────────

test("config: a missing file is pure defaults with no warning", () => {
	const { modes, warning } = loadModes(join(emptyDir(), "compact-tool-view.json"));
	assert.equal(warning, undefined);
	assert.equal(modes.read, "gist");
	assert.equal(modes.subagent, undefined);
	assert.equal(DEFAULT_MODES.read, "gist");
});

test("config: overrides win, stock removes a default, and unknown names are kept", () => {
	const path = join(configDir({ read: "hide", bash: "stock", mytool: "gist" }), "compact-tool-view.json");
	const { modes, warning } = loadModes(path);
	assert.equal(warning, undefined);
	assert.equal(modes.read, "hide");
	assert.equal(modes.bash, undefined);
	assert.equal(modes.mytool, "gist");
});

test("config: invalid values are skipped and folded into one warning", () => {
	const path = join(configDir({ read: "weird", bash: 5 }), "compact-tool-view.json");
	const { modes, warning } = loadModes(path);
	assert.equal(modes.read, "gist");
	assert.equal(modes.bash, "gist");
	assert.ok(warning, "expected a warning");
	assert.ok(warning!.includes('read="weird"'), warning);
	assert.ok(warning!.includes("bash=5"), warning);
});

test("config: a non-object top level and unparseable JSON warn and keep defaults", () => {
	const dir = mkdtempSync(join(tmpdir(), "ctv-bad-"));
	const path = join(dir, "compact-tool-view.json");
	writeFileSync(path, "[1,2]");
	assert.ok(loadModes(path).warning);
	assert.equal(loadModes(path).modes.read, "gist");
	writeFileSync(path, "{not json");
	assert.ok(loadModes(path).warning);
	assert.equal(loadModes(path).modes.read, "gist");
});

// ── Resolver wiring ───────────────────────────────────────────────────────────

test("resolver replaces the collapsed base result with the gist", () => {
	const loaded = loadExtension(emptyDir());
	const wrapped = loaded.resolver("read", () => makeBase());
	const lines = renderLines(
		wrapped.renderResult({ content: [{ type: "text", text: "a\nb\nc" }] }, { expanded: false, isPartial: false }, theme, makeContext()),
	);
	assert.ok(lines.some((line) => line.includes("\u27e8toolOutput\u27e93 lines")), JSON.stringify(lines));
	assert.ok(!lines.some((line) => line.includes("base body")), JSON.stringify(lines));
});

test("expanded and streaming views delegate to the base renderer", () => {
	const loaded = loadExtension(emptyDir());
	const sentinel = new Text("BASE");
	const wrapped = loaded.resolver("read", () => ({ renderResult: () => sentinel }));
	assert.equal(wrapped.renderResult({ content: [] }, { expanded: true, isPartial: false }, theme, makeContext()), sentinel);
	assert.equal(wrapped.renderResult({ content: [] }, { expanded: false, isPartial: true }, theme, makeContext()), sentinel);
});

test("unknown and stock names pass through unchanged", () => {
	const base = makeBase();
	assert.equal(loadExtension(emptyDir()).resolver("mystery", () => base), base);
	assert.equal(loadExtension(emptyDir()).resolver("mystery", () => undefined), undefined);
	assert.equal(loadExtension(configDir({ read: "stock" })).resolver("read", () => base), base);
});

test("hide mode shows only the dimmed expand hint when collapsed", () => {
	const loaded = loadExtension(configDir({ read: "hide" }));
	const wrapped = loaded.resolver("read", () => makeBase());
	const lines = renderLines(
		wrapped.renderResult({ content: [{ type: "text", text: "secret body" }] }, { expanded: false, isPartial: false }, theme, makeContext()),
	);
	assert.ok(lines.some((line) => line.includes("\u27e8muted\u27e9[app.tools.expand: to expand]")), JSON.stringify(lines));
	assert.ok(!lines.some((line) => line.includes("secret body")), JSON.stringify(lines));
	assert.ok(!lines.some((line) => line.includes("base body")), JSON.stringify(lines));
});

test("hide mode delegates to a base renderer when expanded", () => {
	const loaded = loadExtension(configDir({ read: "hide" }));
	const sentinel = new Text("BASE");
	const wrapped = loaded.resolver("read", () => ({ renderResult: () => sentinel }));
	assert.equal(wrapped.renderResult({ content: [] }, { expanded: true, isPartial: false }, theme, makeContext()), sentinel);
});

test("a failure carried on the render context overrides hide mode", () => {
	const loaded = loadExtension(configDir({ read: "hide" }));
	const wrapped = loaded.resolver("read", () => makeBase());
	// pi forwards only content/details; isError arrives on the render context.
	const result = { content: [{ type: "text", text: "boom" }] };
	const lines = renderLines(wrapped.renderResult(result, { expanded: false, isPartial: false }, theme, makeContext({}, true)));
	assert.ok(lines.some((line) => line.includes("error: boom")), JSON.stringify(lines));
	assert.ok(!lines.some((line) => line.includes("app.tools.expand")), JSON.stringify(lines));
});

test("a tool with no base renderer still gists, collapsed and expanded", () => {
	const loaded = loadExtension(emptyDir());
	const wrapped = loaded.resolver("write", () => undefined);
	const result = { content: [{ type: "text", text: "Successfully wrote to /x" }] };
	const collapsed = renderLines(wrapped.renderResult(result, { expanded: false, isPartial: false }, theme, makeContext({ content: "a\nb\nc" })));
	assert.ok(collapsed.some((line) => line.includes("3 lines written")), JSON.stringify(collapsed));
	const expanded = renderLines(wrapped.renderResult(result, { expanded: true, isPartial: false }, theme, makeContext({ content: "a\nb" })));
	assert.ok(expanded.some((line) => line.includes("2 lines written")), JSON.stringify(expanded));
});

test("extra content blocks render as a second dimmed line under the gist", () => {
	const loaded = loadExtension(emptyDir());
	const wrapped = loaded.resolver("read", () => makeBase());
	const result = { content: [{ type: "text", text: "a\nb" }, { type: "text", text: "guard warning" }] };
	const lines = renderLines(wrapped.renderResult(result, { expanded: false, isPartial: false }, theme, makeContext()));
	assert.ok(lines.some((line) => line.includes("\u27e8toolOutput\u27e92 lines")), JSON.stringify(lines));
	assert.ok(lines.some((line) => line.includes("\u27e8muted\u27e9guard warning")), JSON.stringify(lines));
});

test("composition: timestamps wraps the collapsed gist when it loads first", () => {
	// pi builds the chain in load order: the first resolver is outermost and
	// calls next(). timestamps is listed before compact-tool-view in
	// package.json, so it wraps our collapsed gist and still adds its dim
	// result line. Both delegate through next(), so neither assumes the order.
	const handlers = new Map<string, (...args: any[]) => any>();
	let tsResolver: any;
	const tsPi: any = {
		on(event: string, handler: (...args: any[]) => any) {
			handlers.set(event, handler);
			return () => {};
		},
		registerToolRenderer(r: any) {
			tsResolver = r;
		},
	};
	(timestampsExtension as any)(tsPi);
	const loaded = loadExtension(emptyDir());
	const wrapped = tsResolver("read", () => loaded.resolver("read", () => makeBase()));
	handlers.get("tool_execution_start")!({ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: {} });
	handlers.get("tool_execution_end")!({ type: "tool_execution_end", toolCallId: "t1", toolName: "read", result: {}, isError: false, durationMs: 2000 });
	const lines = renderLines(
		wrapped.renderResult({ content: [{ type: "text", text: "a\nb\nc" }] }, { expanded: false, isPartial: false }, theme, makeContext()),
	);
	assert.ok(lines.some((line) => line.includes("\u27e8toolOutput\u27e93 lines")), JSON.stringify(lines));
	assert.ok(lines.some((line) => line.includes("\u27e8dim\u27e9ran ")), JSON.stringify(lines));
});
