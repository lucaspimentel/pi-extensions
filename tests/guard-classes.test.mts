// Unit tests for guard's tool classification (policy/classes.ts), the
// suggestion helpers (policy/suggest.ts), and addToConfigScope. Decision,
// config, state, migration, and the extension harness live in the other
// guard-* test files.
//
// Run: node tests/guard-classes.test.mts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { mergeConfig, loadUserConfigRaw, loadProjectConfigRaw, type GuardConfig } from "../extensions/guard/policy/config.ts";
import {
	classificationName,
	classifyToolCall,
	isToolClass,
	pupRunClass,
	type ToolClass,
} from "../extensions/guard/policy/classes.ts";
import { suggestRule, suggestRemoteReadRule, readGrantSuggestion, addToConfigScope } from "../extensions/guard/policy/suggest.ts";
import type { GuardCall, PolicyState } from "../extensions/guard/policy/decision.ts";

const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
	tempDirs.push(dir);
	return dir;
}

function makePolicy(cwd = "/home/user/proj", overrides: Partial<PolicyState> = {}): PolicyState {
	return {
		profile: "default",
		config: mergeConfig({}, {}, cwd),
		sandboxMode: "full",
		cwd,
		workspaceLocked: false,
		interactive: true,
		...overrides,
	};
}

const tests: { name: string; fn: () => void | Promise<void> }[] = [];
function test(name: string, fn: () => void | Promise<void>) {
	tests.push({ name, fn });
}

// ── Built-in map ──────────────────────────────────────────────────────────────

test("every built-in tool name maps to its class", () => {
	const cases: Array<[string, ToolClass]> = [
		["read", "local-read"],
		["grep", "local-read"],
		["find", "local-read"],
		["ls", "local-read"],
		["fffind", "local-read"],
		["ffgrep", "local-read"],
		["session_search", "local-read"],
		["memory_read", "local-read"],
		["memory_search", "local-read"],
		["memory_status", "local-read"],
		["write", "local-write"],
		["edit", "local-write"],
		["memory_write", "local-write"],
		["memory_forget", "local-write"],
		["memory_restore", "local-write"],
		["scratchpad", "local-write"],
		["host_bash", "host-shell"],
		["pwsh", "host-shell"],
		["bash", "sandboxed-exec"],
		["python", "sandboxed-exec"],
		["node", "sandboxed-exec"],
		["web_search", "remote-read"],
		["pup_logs_search", "remote-read"],
		["pup_logs_aggregate", "remote-read"],
		["pup_metrics_query", "remote-read"],
		["pup_traces_search", "remote-read"],
		["pup_monitors_list", "remote-read"],
		["pup_apm_services", "remote-read"],
		["pup_auth_status", "remote-read"],
		["slack_read_channel", "remote-read"],
		["slack_read_thread", "remote-read"],
		["slack_search", "remote-read"],
		["codemode", "meta"],
		["tool_search", "meta"],
		["subagent", "meta"],
		["ask_user_question", "meta"],
	];
	for (const [name, cls] of cases) {
		assert.equal(classifyToolCall(name, {}), cls, name);
	}
});

// ── MCP styles ────────────────────────────────────────────────────────────────

test("built-in MCP names pass through; the proxy builds mcp__server__tool or mcp:tool", () => {
	assert.equal(classificationName("mcp__atlassian__getIssue"), "mcp__atlassian__getIssue");
	assert.equal(classificationName("read"), "read");
	assert.equal(classificationName("mcp", { tool: "search", server: "slack" }), "mcp__slack__search");
	assert.equal(classificationName("mcp", { tool: "search" }), "mcp:search");
	assert.equal(classificationName("mcp", {}), "mcp");
});

test("MCP calls classify through toolClasses globs against the classification name", () => {
	// No annotations, no built-in entry: unknown MCP tools fail closed to remote-write.
	assert.equal(classifyToolCall("mcp__atlassian__discover"), "remote-write");
	assert.equal(
		classifyToolCall("mcp__atlassian__discover", {}, { toolClasses: { "mcp__atlassian__*": "remote-read" } }),
		"remote-read",
	);
	// Proxy style with a server: the glob targets mcp__slack__*read*.
	assert.equal(
		classifyToolCall("mcp", { tool: "read_thread", server: "slack" }, { toolClasses: { "mcp__slack__*read*": "remote-read" } }),
		"remote-read",
	);
	// Proxy style without a server: mcp:<tool> keys.
	assert.equal(
		classifyToolCall("mcp", { tool: "read_thread" }, { toolClasses: { "mcp:read*": "remote-read" } }),
		"remote-read",
	);
	// A write-ish MCP name still fails closed without a toolClasses entry.
	assert.equal(classifyToolCall("mcp__slack__post_message"), "remote-write");
});

// ── toolClasses overrides ─────────────────────────────────────────────────────

test("toolClasses exact entries and globs beat the built-in map", () => {
	assert.equal(
		classifyToolCall("read", {}, { toolClasses: { read: "remote-write" } }),
		"remote-write",
		"exact entry overrides the built-in map",
	);
	assert.equal(
		classifyToolCall("bash", {}, { toolClasses: { "py*": "meta" } }),
		"sandboxed-exec",
		"unrelated globs do not fire",
	);
	assert.equal(
		classifyToolCall("python", {}, { toolClasses: { "py*": "meta" } }),
		"meta",
		"glob entry overrides the built-in map",
	);
	// Invalid values are skipped (config coercion warns; defense in depth).
	assert.equal(
		classifyToolCall("read", {}, { toolClasses: { read: "nonsense" } as unknown as Record<string, ToolClass> }),
		"local-read",
	);
});

// ── Annotations, heuristic, fallback ─────────────────────────────────────────

test("annotation fallback: readOnlyHint to remote-read, destructiveHint to remote-write", () => {
	const readOnly = { readOnlyHint: true, destructiveHint: false };
	const destructive = { readOnlyHint: false, destructiveHint: true };
	assert.equal(classifyToolCall("widget_flip", {}, { getAnnotations: () => readOnly }), "remote-read");
	assert.equal(classifyToolCall("widget_flip", {}, { getAnnotations: () => destructive }), "remote-write");
	// readOnlyHint wins when both are set (read is the weaker claim; the
	// heuristic and fallback still catch write-ish names only without hints).
	const both = { readOnlyHint: true, destructiveHint: true };
	assert.equal(classifyToolCall("widget_flip", {}, { getAnnotations: () => both }), "remote-read");
	// The injected lookup is consulted with the classification name (proxy style included).
	const seen: string[] = [];
	classifyToolCall("mcp", { tool: "flip", server: "s" }, { getAnnotations: (n) => { seen.push(n); return undefined; } });
	assert.deepEqual(seen, ["mcp__s__flip"]);
});

test("name heuristic maps write-ish tool names to remote-write; unknown tools fail closed", () => {
	for (const name of ["slack_send_message", "issue_create", "page_update", "file_upload", "merge_pr", "transition_issue"]) {
		assert.equal(classifyToolCall(name), "remote-write", name);
	}
	// A read-ish name without hints or entries still fails closed.
	assert.equal(classifyToolCall("frobnicate"), "remote-write");
	// Built-in entries beat the heuristic (memory_write carries "write").
	assert.equal(classifyToolCall("memory_write"), "local-write");
});

// ── web_fetch and pup_run ─────────────────────────────────────────────────────

test("web_fetch classifies by the webFetchAllow URL globs", () => {
	assert.equal(classifyToolCall("web_fetch", { url: "https://docs.example.com/x" }), "exfil-remote-read", "no allowlist: exfil-capable");
	assert.equal(
		classifyToolCall("web_fetch", { url: "https://github.com/x" }, { webFetchAllow: ["https://github.com/*"] }),
		"remote-read",
	);
	assert.equal(
		classifyToolCall("web_fetch", { url: "https://evil.example.com" }, { webFetchAllow: ["https://github.com/*"] }),
		"exfil-remote-read",
	);
});

test("pup_run classifies by subcommand verb", () => {
	assert.equal(pupRunClass({ args: ["logs", "search"] }), "remote-read");
	assert.equal(pupRunClass({ args: ["monitors", "list"] }), "remote-read");
	assert.equal(pupRunClass({ args: ["monitors", "create"] }), "remote-write");
	assert.equal(pupRunClass({ args: ["monitors", "frobnicate"] }), "remote-write", "unknown verbs fail closed");
	assert.equal(pupRunClass({ args: [] }), "remote-write");
	assert.equal(pupRunClass({ args: ["--help"] }), "remote-read");
	assert.equal(pupRunClass({ args: ["downtime", "mute", "id"] }), "remote-write");
	// String argv and a missing args field.
	assert.equal(pupRunClass({ args: "logs search --q x" }), "remote-read");
	assert.equal(pupRunClass({}), "remote-write");
	assert.equal(classifyToolCall("pup_run", { args: ["logs", "search"] }), "remote-read");
});

test("isToolClass validates class names", () => {
	assert.equal(isToolClass("remote-read"), true);
	assert.equal(isToolClass("nonsense"), false);
	assert.equal(isToolClass(42), false);
});

// ── suggestRule ───────────────────────────────────────────────────────────────

test("suggestRule: host shell suggests the first two tokens with a wildcard", () => {
	const policy = makePolicy();
	const two = suggestRule({ kind: "host-shell", shell: "host-bash", command: "cargo test --release foo" }, policy);
	assert.deepEqual(two, { hostBash: { allow: ["HostBash(cargo test *)"] } });
	const one = suggestRule({ kind: "host-shell", shell: "host-bash", command: "make" }, policy);
	assert.deepEqual(one, { hostBash: { allow: ["HostBash(make *)"] } });
	const pwsh = suggestRule({ kind: "host-shell", shell: "pwsh", command: "Get-Content x.txt" }, policy);
	assert.deepEqual(pwsh, { hostBash: { allow: ["Pwsh(Get-Content x.txt *)"] } });
	assert.equal(suggestRule({ kind: "host-shell", shell: "host-bash", command: "" }, policy), null);
});

test("suggestRule: web_fetch suggests an https host glob", () => {
	assert.deepEqual(
		suggestRule({ kind: "web-fetch", url: "https://docs.datadoghq.com/api/?q=1" }, makePolicy()),
		{ webFetchAllow: ["https://docs.datadoghq.com/*"] },
	);
	assert.equal(suggestRule({ kind: "web-fetch", url: "not a url" }, makePolicy()), null);
});

test("suggestRule: outside-root read suggests the covering directory; outside-root write suggests its directory", () => {
	const cwd = makeTempDir("guard-suggest-");
	fs.mkdirSync(path.join(cwd, "exists"), { recursive: true });
	fs.writeFileSync(path.join(cwd, "exists", "file.txt"), "x");
	const policy = makePolicy(cwd);
	const readPatch = suggestRule({ kind: "local-read", tool: "read", path: `${cwd}/exists/file.txt` }, policy);
	assert.ok(readPatch && Array.isArray(readPatch.readRoots));
	assert.equal(readPatch.readRoots[0], `${cwd}/exists`, "the nearest existing directory of the target");
	// Missing directories walk up to the nearest existing one.
	const missing = suggestRule({ kind: "local-read", tool: "read", path: `${cwd}/no/such/file.txt` }, policy);
	assert.ok(missing && Array.isArray(missing.readRoots));
	assert.equal(missing.readRoots[0], cwd, "walks up to the nearest existing directory");
	const writePatch = suggestRule({ kind: "local-write", tool: "write", path: `${cwd}/exists/out.txt` }, policy);
	assert.deepEqual(writePatch, { writeRoots: [`${cwd}/exists`] });
	assert.equal(readGrantSuggestion("relative/file.txt", cwd), cwd, "relative paths resolve against cwd");
});

test("suggestRemoteReadRule only fires on prompts on read-classified calls", () => {
	assert.deepEqual(
		suggestRemoteReadRule("mcp__atlassian__getIssue", {}, "prompt"),
		{ toolClasses: { mcp__atlassian__getIssue: "remote-read" } },
	);
	assert.equal(suggestRemoteReadRule("mcp__atlassian__getIssue", {}, "allow"), null);
	assert.equal(suggestRemoteReadRule("mcp__atlassian__getIssue", {}, "deny"), null);
	// Plain suggestRule returns null for remote prompts; the dialog variant above is the home.
	assert.equal(suggestRule({ kind: "remote-read", tool: "pup" }, makePolicy()), null);
});

// ── addToConfigScope ──────────────────────────────────────────────────────────

test("addToConfigScope unions with dedupe, never removes, and is idempotent", () => {
	const home = makeTempDir("guard-scope-home-");
	const cwd = makeTempDir("guard-scope-cwd-");
	saveSeed(home, { hostBash: { deny: ["HostBash(rm -rf*)"] }, webFetchAllow: ["https://a.example.com/*"], toolClasses: { keep: "remote-read" }, cycleShortcut: "ctrl+alt+q" });
	const patch: Partial<GuardConfig> = {
		readRoots: ["/tmp/docs", "/tmp/docs"],
		webFetchAllow: ["https://b.example.com/*", "https://a.example.com/*"],
		hostBash: { allow: ["HostBash(git status*)"] },
		toolClasses: { "mcp__atlassian__*": "remote-read", keep: "remote-write" },
	};
	const r1 = addToConfigScope("user", patch, { home, cwd });
	assert.ok(r1.path.endsWith(path.join(".pi", "agent", "guard.json")));
	assert.ok(r1.added > 0);
	const cfg = loadUserConfigRaw(home);
	assert.deepEqual(cfg.readRoots, ["/tmp/docs"]);
	assert.deepEqual(cfg.webFetchAllow, ["https://a.example.com/*", "https://b.example.com/*"], "existing entries stay first, patch appends");
	assert.deepEqual(cfg.hostBash?.deny, ["HostBash(rm -rf*)"], "existing deny rules are never removed");
	assert.deepEqual(cfg.hostBash?.allow, ["HostBash(git status*)"]);
	assert.equal(cfg.toolClasses?.keep, "remote-read", "existing toolClasses values win (never removed)");
	assert.equal(cfg.toolClasses?.["mcp__atlassian__*"], "remote-read");
	assert.equal(cfg.cycleShortcut, "ctrl+alt+q", "untouched scalars survive");
	// Second run: nothing added.
	const r2 = addToConfigScope("user", patch, { home, cwd });
	assert.equal(r2.added, 0);
	// Project scope writes .pi/guard.local.json.
	const rp = addToConfigScope("project", { readRoots: ["/tmp/p"] }, { home, cwd });
	assert.ok(rp.path.endsWith(path.join(".pi", "guard.local.json")));
	assert.deepEqual(loadProjectConfigRaw(cwd).readRoots, ["/tmp/p"]);
});

function saveSeed(home: string, cfg: GuardConfig): void {
	fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
	fs.writeFileSync(path.join(home, ".pi", "agent", "guard.json"), JSON.stringify(cfg, null, 2), "utf8");
}

// ── Runner ────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
for (const t of tests) {
	try {
		const r = t.fn();
		if (r instanceof Promise) await r;
		passed++;
		console.log(`  ok ${t.name}`);
	} catch (err) {
		failed++;
		console.error(`  FAIL ${t.name}:`, err);
	}
}
console.log(`\n${passed} passed, ${failed} failed`);
for (const dir of tempDirs) {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		// Best-effort cleanup.
	}
}
if (failed > 0) process.exit(1);
process.exit(0);
