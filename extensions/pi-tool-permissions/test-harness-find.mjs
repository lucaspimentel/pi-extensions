// Manual harness: loads the real index.ts with --experimental-strip-types and
// drives the session_start / tool_call handlers with a stubbed ExtensionAPI.
// Not part of run-all.mjs. Run: node --experimental-strip-types test-harness-find.mjs

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const results = [];
function check(name, actual, expected) {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	results.push(ok);
	console.log(`${ok ? "  ✓" : "  ✗"} ${name}${ok ? "" : `  got: ${JSON.stringify(actual)}  expected: ${JSON.stringify(expected)}`}`);
}

function makeApi() {
	const handlers = {};
	let promptShown = null;
	const ui = {
		select: async (...args) => { promptShown = args; return "Deny once"; },
		notify: () => {},
		setStatus: () => {},
		setWorkingVisible: () => {},
		input: async () => "",
		editor: async () => "",
	};
	const api = {
		on: (event, fn) => { handlers[event] = fn; },
		registerShortcut: () => {},
		registerCommand: () => {},
		sendUserMessage: () => {},
		events: { emit: () => {} },
	};
	return { api, handlers, getPrompt: () => promptShown, resetPrompt: () => { promptShown = null; }, ui };
}

async function loadExtension(projectConfig, dir) {
	dir = dir ?? mkdtempSync(join(tmpdir(), "pi-find-harness-"));
	mkdirSync(join(dir, ".pi"), { recursive: true });
	writeFileSync(join(dir, ".pi", "pi-tool-permissions.local.json"), JSON.stringify(projectConfig ?? {}));
	const mod = await import("./index.ts");
	const { api, handlers, getPrompt, resetPrompt, ui } = makeApi();
	mod.default(api);
	const ctx = { cwd: dir, hasUI: true, mode: "tui", ui, modelRegistry: {} };
	await handlers.session_start({}, ctx);
	return { dir, toolCall: (toolName, input) => handlers.tool_call({ toolName, input }, ctx), getPrompt, resetPrompt };
}

// ── 1. Default config: bare find (no path) is silently allowed ───────────
{
	const ext = await loadExtension({});
	const r = await ext.toolCall("find", { pattern: "AGENTS.md", limit: 20 });
	check("find with no path → no decision (allowed)", r, undefined);
	check("find with no path → no prompt shown", ext.getPrompt(), null);
	const r2 = await ext.toolCall("find", { pattern: "*.ts", path: join(ext.dir, "src") });
	check("find under cwd → no decision (allowed)", r2, undefined);
	check("find under cwd → no prompt shown", ext.getPrompt(), null);
	const r3 = await ext.toolCall("find", { pattern: "*", path: "/etc" });
	check("find outside cwd → prompt decision (deny once)", r3?.block, true);
	check("find outside cwd → prompt was shown", Array.isArray(ext.getPrompt()), true);
	const r4 = await ext.toolCall("bash", { command: "ls" });
	check("bash ls → no decision (allowed)", r4, undefined);
	const r5 = await ext.toolCall("grep", { pattern: "x" });
	check("grep with no path → no decision (allowed)", r5, undefined);
	const r6 = await ext.toolCall("read", { path: join(ext.dir, "AGENTS.md") });
	check("read under cwd → no decision (allowed)", r6, undefined);
	rmSync(ext.dir, { recursive: true, force: true });
}

// ── 2. findAllowCwd: false → find prompts again ──────────────────────────
{
	const ext = await loadExtension({ findAllowCwd: false });
	const r = await ext.toolCall("find", { pattern: "AGENTS.md" });
	check("findAllowCwd:false → find prompts (blocked)", r?.block, true);
	check("findAllowCwd:false → prompt was shown", Array.isArray(ext.getPrompt()), true);
	ext.resetPrompt();
	const r2 = await ext.toolCall("grep", { pattern: "x" });
	check("findAllowCwd:false → grep still allowed", r2, undefined);
	const r3 = await ext.toolCall("ls", {});
	check("findAllowCwd:false → ls still allowed", r3, undefined);
	rmSync(ext.dir, { recursive: true, force: true });
}

// ── 3. Explicit deny rule blocks find under a path ───────────────────────
{
	const dir = mkdtempSync(join(tmpdir(), "pi-find-harness-"));
	const cwdFwd = dir.replace(/\\/g, "/");
	const ext = await loadExtension({ deny: [`Find(${cwdFwd}/secret/**)`] }, dir);
	const r = await ext.toolCall("find", { pattern: "*.key", path: join(ext.dir, "secret") });
	check("explicit Find deny → blocked", r?.block, true);
	rmSync(ext.dir, { recursive: true, force: true });
}

console.log(results.every(Boolean) ? "\nharness: all checks passed" : "\nharness: FAILURES");
process.exit(results.every(Boolean) ? 0 : 1);
