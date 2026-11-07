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
import { DEFAULT_MODES, loadModes, resolveMode } from "../extensions/compact-tool-view/config.ts";
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

test("memory_write gists the target and mode, not the file preview", () => {
	assert.deepEqual(gistFor("memory_write", { content: [], details: { target: "long_term", mode: "append" } }, {}), ["MEMORY.md appended"]);
	assert.deepEqual(gistFor("memory_write", { content: [], details: { target: "long_term", mode: "overwrite" } }, {}), ["MEMORY.md overwritten"]);
	assert.deepEqual(gistFor("memory_write", { content: [], details: { target: "daily", mode: "append" } }, {}), ["daily log appended"]);
	// An unexpected details shape (or none at all) falls through to the generic
	// line count of the result text, which is the target file preview.
	assert.deepEqual(gistFor("memory_write", textResult("Appended to daily log: /x\ny"), {}), ["2 lines"]);
});

test("scratchpad gists the action, and the counts for list", () => {
	assert.deepEqual(gistFor("scratchpad", { content: [], details: { count: 7, open: 3 } }, { action: "list" }), ["3 open / 7 items"]);
	assert.deepEqual(gistFor("scratchpad", textResult("Scratchpad is empty."), { action: "list" }), ["empty"]);
	assert.deepEqual(gistFor("scratchpad", { content: [], details: { action: "add" } }, { action: "add", text: "x" }), ["item added"]);
	assert.deepEqual(gistFor("scratchpad", { content: [], details: { action: "done" } }, { action: "done", text: "x" }), ["item done"]);
	assert.deepEqual(gistFor("scratchpad", { content: [], details: { action: "undo" } }, { action: "undo", text: "x" }), ["item reopened"]);
	assert.deepEqual(gistFor("scratchpad", { content: [], details: { action: "clear_done", removed: 2 } }, { action: "clear_done" }), ["cleared 2 done items"]);
	assert.deepEqual(gistFor("scratchpad", { content: [], details: { action: "clear_done", removed: 1 } }, { action: "clear_done" }), ["cleared 1 done item"]);
	// Failure paths carry empty details and must not claim a mutation happened.
	assert.deepEqual(gistFor("scratchpad", textResult("No matching open item found for: \"x\""), { action: "done", text: "x" }), ["1 lines"]);
	assert.deepEqual(gistFor("scratchpad", textResult("Error: 'text' is required for add."), { action: "add" }), ["1 lines"]);
});

test("memory_read gists the log list and the resolved daily date", () => {
	assert.deepEqual(gistFor("memory_read", { content: [], details: { files: ["2026-11-06.md", "2026-11-05.md"] } }, { target: "list" }), ["2 daily logs"]);
	assert.deepEqual(gistFor("memory_read", textResult("No daily logs found."), { target: "list" }), ["no daily logs"]);
	assert.deepEqual(
		gistFor(
			"memory_read",
			{ content: [{ type: "text", text: "a\nb\nc" }], details: { path: "/m/daily/2026-11-06.md", date: "2026-11-06" } },
			{ target: "daily" },
		),
		["2026-11-06 log, 3 lines"],
	);
	assert.deepEqual(gistFor("memory_read", textResult("No daily log for 2026-11-01."), { target: "daily", date: "2026-11-01" }), ["no log"]);
	// long_term and scratchpad already gist their line count.
	assert.deepEqual(gistFor("memory_read", textResult("a\nb"), { target: "long_term" }), ["2 lines"]);
});

test("memory_forget and memory_restore gist what changed", () => {
	assert.deepEqual(gistFor("memory_forget", { content: [], details: { path: "/m/MEMORY.md", removed: 3 } }, {}), ["removed 3 entries"]);
	assert.deepEqual(gistFor("memory_forget", { content: [], details: { path: "/m/MEMORY.md", removed: 1 } }, {}), ["removed 1 entry"]);
	assert.deepEqual(gistFor("memory_forget", { content: [], details: { path: "/m/MEMORY.md", removed: 0 } }, {}), ["nothing removed"]);
	assert.deepEqual(
		gistFor("memory_restore", { content: [], details: { recoveryId: "r1", target: "daily", path: "/m/d.md", restored: 2 } }, {}),
		["restored 2 entries"],
	);
	assert.deepEqual(
		gistFor("memory_restore", { content: [], details: { recoveryId: "r1", target: "daily", path: "/m/d.md", restored: 0 } }, {}),
		["already restored"],
	);
	assert.deepEqual(
		gistFor("memory_restore", { content: [], details: { recoveryId: "r1", restoredAt: "2026-11-06T00:00:00.000Z" } }, {}),
		["already restored"],
	);
});

test("memory_search gists the result count, mode, and embedding state", () => {
	assert.deepEqual(
		gistFor("memory_search", { content: [], details: { mode: "keyword", query: "x", count: 7, needsEmbed: false } }, {}),
		["7 results (keyword)"],
	);
	assert.deepEqual(
		gistFor("memory_search", { content: [], details: { mode: "semantic", query: "x", count: 0, needsEmbed: true } }, {}),
		["0 results (semantic), embeddings missing"],
	);
	assert.deepEqual(
		gistFor("memory_search", { content: [], details: { mode: "deep", query: "x", count: 0, needsEmbed: true, embedStarted: true } }, {}),
		["0 results (deep), embeddings started"],
	);
});

test("memory_status gists the health summary", () => {
	assert.deepEqual(
		gistFor("memory_status", { content: [], details: { qmd: true, collection: true, embeddings: "ready" } }, {}),
		["qmd ok, collection ok, embeddings ready"],
	);
	assert.deepEqual(
		gistFor("memory_status", { content: [], details: { qmd: true, collection: false, embeddings: "n/a" } }, {}),
		["qmd ok, collection missing, embeddings n/a"],
	);
	assert.deepEqual(gistFor("memory_status", { content: [], details: { qmd: false, embeddings: "n/a" } }, {}), ["qmd unavailable"]);
});

test("gitlab_read gists a timeout or a non-zero exit, and falls back otherwise", () => {
	// gitlab-read never sets isError, so these lines come from the typed branch.
	assert.deepEqual(gistFor("gitlab_read", { content: [], details: { subcommand: "job-status", timedOut: true, exitCode: null } }, {}), [
		"timed out",
	]);
	assert.deepEqual(gistFor("gitlab_read", { content: [], details: { subcommand: "pipeline-status", timedOut: false, exitCode: 128 } }, {}), [
		"exit 128",
	]);
	assert.deepEqual(
		gistFor("gitlab_read", { content: [{ type: "text", text: "a\nb" }], details: { subcommand: "pipeline-status", timedOut: false, exitCode: 0 } }, {}),
		["2 lines"],
	);
	// The validation-failure shape carries only the subcommand.
	assert.deepEqual(
		gistFor("gitlab_read", { content: [{ type: "text", text: "gitlab_read: nope" }], details: { subcommand: "job-status" } }, {}),
		["1 lines"],
	);
});

test("pup_* gists the item count from pup's JSON envelope", () => {
	const pupResult = (parsed: unknown, refreshed = false) => ({
		content: [{ type: "text", text: "$ pup monitors list\n\n{...}" }],
		details: { argv: [], exitCode: 0, killed: false, refreshed, parsed },
	});
	// The item paths were verified against the installed CLI: pup wraps every
	// payload in its own envelope, so the array sits below `data`.
	assert.deepEqual(gistFor("pup_monitors_list", pupResult({ data: [{ id: 1 }, { id: 2 }] }), {}), ["2 monitors"]);
	assert.deepEqual(gistFor("pup_logs_search", pupResult({ data: [{}, {}, {}] }), {}), ["3 logs"]);
	assert.deepEqual(gistFor("pup_traces_search", pupResult({ data: [{}] }), {}), ["1 traces"]);
	assert.deepEqual(gistFor("pup_apm_services", pupResult({ data: { attributes: { services: ["a", "b", "c", "d"] } } }), {}), [
		"4 services",
	]);
	assert.deepEqual(gistFor("pup_logs_aggregate", pupResult({ data: { buckets: [{}] } }), {}), ["1 buckets"]);
	assert.deepEqual(gistFor("pup_metrics_query", pupResult({ data: { series: [{}] } }), {}), ["1 series"]);
	// pup_run is the escape hatch, so its noun is the generic one.
	assert.deepEqual(gistFor("pup_run", pupResult({ data: [{}, {}] }, false), {}), ["2 items"]);
	assert.deepEqual(gistFor("pup_monitors_list", pupResult({ data: [] }), {}), ["0 monitors"]);
	assert.deepEqual(gistFor("pup_monitors_list", pupResult({ data: [{}] }, true), {}), ["1 monitors, auth refreshed"]);
});

test("pup_* falls back to the line count on an unexpected payload", () => {
	const withParsed = (parsed: unknown, text: string) => ({ content: [{ type: "text", text }], details: { parsed } });
	// A wrapper the count path does not match, a non-JSON stdout (no `parsed`),
	// and a pup tool without a typed line all fall through.
	assert.deepEqual(gistFor("pup_run", withParsed({ data: { items: [] } }, "a"), {}), ["1 lines"]);
	assert.deepEqual(gistFor("pup_run", withParsed({ items: [{}] }, "a"), {}), ["1 lines"]);
	assert.deepEqual(gistFor("pup_monitors_list", withParsed({ data: { items: [] } }, "a\nb\nc"), {}), ["3 lines"]);
	assert.deepEqual(
		gistFor("pup_monitors_list", { content: [{ type: "text", text: "a\nb" }], details: { argv: [], exitCode: 0, killed: false, refreshed: false } }, {}),
		["2 lines"],
	);
});

test("pup_auth_status gists the auth state and site", () => {
	const withParsed = (parsed: unknown, text: string) => ({ content: [{ type: "text", text }], details: { parsed } });
	// Authenticated and not authenticated mirror each other, with the site read
	// from `parsed.site` (never hardcoded).
	assert.deepEqual(gistFor("pup_auth_status", withParsed({ authenticated: true, site: "datadoghq.com" }, "a\nb"), {}), [
		"authenticated (datadoghq.com)",
	]);
	assert.deepEqual(gistFor("pup_auth_status", withParsed({ authenticated: false, site: "datadoghq.com" }, "a\nb"), {}), [
		"not authenticated (datadoghq.com)",
	]);
	// A missing or empty site drops the parenthetical.
	assert.deepEqual(gistFor("pup_auth_status", withParsed({ authenticated: true }, "a\nb"), {}), ["authenticated"]);
	assert.deepEqual(gistFor("pup_auth_status", withParsed({ authenticated: false, site: "" }, "a\nb"), {}), ["not authenticated"]);
	// `refresh: true` is a pre-step, not a state on this line: no `, auth refreshed`.
	assert.deepEqual(
		gistFor(
			"pup_auth_status",
			{ content: [{ type: "text", text: "a\nb" }], details: { parsed: { authenticated: true, site: "datadoghq.com" }, refreshed: true } },
			{},
		),
		["authenticated (datadoghq.com)"],
	);
	// Any other shape (no boolean `authenticated`, no `parsed`) keeps the generic line count.
	assert.deepEqual(gistFor("pup_auth_status", withParsed({ authenticated: "yes", site: "datadoghq.com" }, "a\nb"), {}), ["2 lines"]);
	assert.deepEqual(gistFor("pup_auth_status", withParsed(undefined, "a\nb"), {}), ["2 lines"]);
});

test("pup failures gist the exit code or a timeout from details", () => {
	const failure = (details: Record<string, unknown>) => ({
		content: [{ type: "text", text: "$ pup monitors list  → exit 1" }],
		details,
		isError: true,
	});
	assert.deepEqual(gistFor("pup_monitors_list", failure({ exitCode: 1, killed: false }), {}), ["exit 1"]);
	assert.deepEqual(gistFor("pup_monitors_list", failure({ exitCode: 137, killed: true }), {}), ["timed out"]);
	// The numeric details exit code is the shared failure path, not pup-specific.
	assert.deepEqual(gistFor("unknown_tool", failure({ exitCode: 3 }), {}), ["exit 3"]);
	assert.deepEqual(gistFor("gitlab_read", failure({ exitCode: 3 }), {}), ["exit 3"]);
});

test("gh_read gists its structured failure and keeps a success on the line count", () => {
	const ghFailure = (details: Record<string, unknown>, text: string) => ({ content: [{ type: "text", text }], details, isError: true });
	// gh-read now sets isError and carries both fields, so the failure path (not
	// a typed branch) produces these lines.
	assert.deepEqual(gistFor("gh_read", ghFailure({ subcommand: "run view", exitCode: null, timedOut: true }, ""), {}), ["timed out"]);
	assert.deepEqual(
		gistFor("gh_read", ghFailure({ subcommand: "pr list", exitCode: 128, timedOut: false }, "gh_read: gh exited with code 128\nboom"), {}),
		["exit 128"],
	);
	assert.deepEqual(
		gistFor("gh_read", ghFailure({ subcommand: "pr list", exitCode: null, timedOut: false }, "gh_read: not inside a git worktree"), {}),
		["error: gh_read: not inside a git worktree"],
	);
	// A successful read has no count noun: heterogeneous payloads keep the count.
	assert.deepEqual(
		gistFor("gh_read", { content: [{ type: "text", text: "a\nb" }], details: { subcommand: "pr list", exitCode: 0, timedOut: false } }, {}),
		["2 lines"],
	);
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
	const { table, warning } = loadModes(join(emptyDir(), "compact-tool-view.json"));
	assert.equal(warning, undefined);
	assert.equal(resolveMode(table, "read"), "gist");
	assert.equal(resolveMode(table, "subagent"), undefined);
	assert.equal(DEFAULT_MODES.read, "gist");
});

test("config: overrides win, stock removes a default, and unknown names are kept", () => {
	const path = join(configDir({ read: "hide", bash: "stock", mytool: "gist" }), "compact-tool-view.json");
	const { table, warning } = loadModes(path);
	assert.equal(warning, undefined);
	assert.equal(resolveMode(table, "read"), "hide");
	assert.equal(resolveMode(table, "bash"), undefined);
	assert.equal(resolveMode(table, "mytool"), "gist");
});

test("config: invalid values are skipped and folded into one warning", () => {
	const path = join(configDir({ read: "weird", bash: 5 }), "compact-tool-view.json");
	const { table, warning } = loadModes(path);
	assert.equal(resolveMode(table, "read"), "gist");
	assert.equal(resolveMode(table, "bash"), "gist");
	assert.ok(warning, "expected a warning");
	assert.ok(warning!.includes('read="weird"'), warning);
	assert.ok(warning!.includes("bash=5"), warning);
});

test("config: a non-object top level and unparseable JSON warn and keep defaults", () => {
	const dir = mkdtempSync(join(tmpdir(), "ctv-bad-"));
	const path = join(dir, "compact-tool-view.json");
	writeFileSync(path, "[1,2]");
	assert.ok(loadModes(path).warning);
	assert.equal(resolveMode(loadModes(path).table, "read"), "gist");
	writeFileSync(path, "{not json");
	assert.ok(loadModes(path).warning);
	assert.equal(resolveMode(loadModes(path).table, "read"), "gist");
});

test("config: a prefix pattern covers a whole tool family", () => {
	const path = join(configDir({ "mcp__*": "gist" }), "compact-tool-view.json");
	const { table, warning } = loadModes(path);
	assert.equal(warning, undefined);
	assert.equal(resolveMode(table, "mcp__atlassian__search"), "gist");
	assert.equal(resolveMode(table, "mcp__"), "gist");
	assert.equal(resolveMode(table, "mcpx"), undefined);
});

test("config: the longest matching pattern wins, and \"*\" matches everything", () => {
	const path = join(configDir({ "*": "hide", "mcp__*": "gist" }), "compact-tool-view.json");
	const { table } = loadModes(path);
	assert.equal(resolveMode(table, "read"), "hide");
	assert.equal(resolveMode(table, "zzz"), "hide");
	assert.equal(resolveMode(table, "mcp__foo"), "gist");
});

test("config: an exact entry beats a pattern, including an exact stock", () => {
	const path = join(configDir({ "mcp__*": "hide", "mcp__foo": "gist" }), "compact-tool-view.json");
	const { table } = loadModes(path);
	assert.equal(resolveMode(table, "mcp__foo"), "gist");
	assert.equal(resolveMode(table, "mcp__bar"), "hide");

	const stocked = loadModes(join(configDir({ "mcp__*": "gist", "mcp__foo": "stock" }), "compact-tool-view.json")).table;
	assert.equal(resolveMode(stocked, "mcp__foo"), undefined);
	assert.equal(resolveMode(stocked, "mcp__bar"), "gist");
});

test("config: a pattern beats a code default, and a stock pattern means no gist", () => {
	const path = join(configDir({ "r*": "hide", "pup_*": "stock", subagent: "gist" }), "compact-tool-view.json");
	const { table } = loadModes(path);
	assert.equal(resolveMode(table, "read"), "hide");
	assert.equal(resolveMode(table, "pup_run"), undefined);
	assert.equal(resolveMode(table, "subagent"), "gist");
});

test("config: a misplaced * is an invalid key and folds into the one warning", () => {
	const path = join(configDir({ "mcp__*__read*": "gist", "*foo": "gist", "**": "hide" }), "compact-tool-view.json");
	const { table, warning } = loadModes(path);
	assert.ok(warning, "expected a warning");
	assert.ok(warning!.includes('invalid key "mcp__*__read*"'), warning);
	assert.ok(warning!.includes('invalid key "*foo"'), warning);
	assert.ok(warning!.includes('invalid key "**"'), warning);
	assert.equal(resolveMode(table, "mcp__x__ready"), undefined);
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

test("a config pattern wraps every matching tool name", () => {
	const loaded = loadExtension(configDir({ "mcp__*": "gist" }));
	const wrapped = loaded.resolver("mcp__atlassian__search", () => makeBase());
	const lines = renderLines(
		wrapped.renderResult({ content: [{ type: "text", text: "a\nb" }] }, { expanded: false, isPartial: false }, theme, makeContext()),
	);
	assert.ok(lines.some((line) => line.includes("\u27e8toolOutput\u27e92 lines")), JSON.stringify(lines));
	const base = makeBase();
	assert.equal(loaded.resolver("mcpx", () => base), base);
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
