// Harness tests for the guard extension entry point (extensions/guard/index.ts)
// with a fake pi API object: session_start wiring, the observe-only tool_call
// hook, /guard subcommands, the cycle shortcut, the research hold, debug
// notifications, and the migrate command flow.
// Run: node tests/guard-harness.test.mts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { detectSandboxMode } from "../extensions/guard/sandbox/detect.ts";
import { projectConfigPath, userConfigPath } from "../extensions/guard/policy/config.ts";
import guardExtension from "../extensions/guard/index.ts";

const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
	tempDirs.push(dir);
	return dir;
}

interface Harness {
	handlers: Record<string, Array<(event: unknown, ctx: unknown) => unknown>>;
	commands: Array<{ name: string }>;
	shortcuts: Array<{ shortcut: string; handler: (ctx: unknown) => Promise<void> }>;
	eventListeners: Record<string, Array<(data: unknown) => void>>;
	emitted: Array<[string, unknown]>;
	notifications: string[];
	status: Map<string, string | undefined>;
	commandHandlers: Map<string, (args: string, ctx: unknown) => Promise<void>>;
	tools: Array<{ name: string; annotations?: Record<string, boolean> }>;
}

function makeHarness(tools: Harness["tools"] = []): Harness {
	const h: Harness = {
		handlers: {},
		commands: [],
		shortcuts: [],
		eventListeners: {},
		emitted: [],
		notifications: [],
		status: new Map(),
		commandHandlers: new Map(),
		tools,
	};
	const api = {
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
			(h.handlers[event] ??= []).push(handler);
			return () => {};
		},
		registerTool: () => {},
		registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
			h.commands.push({ name });
			h.commandHandlers.set(name, options.handler);
		},
		registerShortcut(shortcut: string, options: { handler: (ctx: unknown) => Promise<void> }) {
			h.shortcuts.push({ shortcut, handler: options.handler });
		},
		registerFlag: () => {},
		getCommands: () => h.commands,
		getActiveTools: () => h.tools.map((t) => t.name),
		getAllTools: () => h.tools,
		events: {
			on(channel: string, handler: (data: unknown) => void) {
				(h.eventListeners[channel] ??= []).push(handler);
				return () => {};
			},
			emit: (channel: string, data: unknown) => {
				h.emitted.push([channel, data]);
				// Mirror the real bus: listeners see emissions on their channel.
				for (const listener of h.eventListeners[channel] ?? []) listener(data);
			},
		},
	};
	(guardExtension as (api: unknown) => void)(api);
	return h;
}

function harnessCtx(h: Harness, cwd: string, selectResult: string | undefined = undefined) {
	return {
		cwd,
		hasUI: true,
		mode: "tui",
		model: undefined,
		scopedModels: [],
		modelRegistry: {
			getAvailable: () => [],
			hasConfiguredAuth: () => false,
			find: () => undefined,
			streamSimple: () => { throw new Error("no model"); },
		},
		ui: {
			notify: (message: string) => h.notifications.push(message),
			setStatus: (key: string, value: string | undefined) => h.status.set(key, value),
			select: async () => selectResult,
			theme: { fg: (_role: string, s: string) => s },
		},
	};
}

/** Override HOME for the duration of fn so config reads/writes stay in a temp dir. */
async function withTempHome<T>(fn: () => Promise<T> | T): Promise<T> {
	const realHome = process.env.HOME;
	const home = makeTempDir("guard-harness-home-");
	process.env.HOME = home;
	try {
		return await fn();
	} finally {
		process.env.HOME = realHome;
	}
}

const tests: { name: string; fn: () => void | Promise<void> }[] = [];
function test(name: string, fn: () => void | Promise<void>) {
	tests.push({ name, fn });
}

const sandboxMode = detectSandboxMode().mode;

test("harness: session_start initializes state, footer, and the profile event", async () => {
	await withTempHome(async () => {
		const h = makeHarness();
		const cwd = makeTempDir("guard-harness-");
		const ctx = harnessCtx(h, cwd);
		for (const handler of h.handlers["session_start"] ?? []) await handler({}, ctx);
		const status = h.status.get("guard");
		if (sandboxMode === "full") {
			assert.equal(status, undefined, "default profile with a full sandbox shows no footer label");
		} else {
			assert.match(status ?? "", /no sandbox|reduced sandbox/);
		}
		const profileEvents = h.emitted.filter(([c]) => c === "guard:profile");
		assert.equal(profileEvents.length, 1);
		const payload = profileEvents[0][1] as {
			profile: string;
			sandbox: { mode: string; workspaceMode: string; readRoots: string[] };
			workspaceLocked: boolean;
		};
		assert.equal(payload.profile, "default");
		assert.equal(payload.sandbox.mode, sandboxMode);
		assert.equal(payload.sandbox.workspaceMode, sandboxMode === "full" ? "rw" : "rw");
		assert.deepEqual(payload.sandbox.readRoots, []);
		assert.equal(payload.workspaceLocked, false);
	});
});

test("harness: tool_call observer records decisions and never blocks", async () => {
	await withTempHome(async () => {
		const h = makeHarness();
		const cwd = makeTempDir("guard-harness-obs-");
		const ctx = harnessCtx(h, cwd);
		for (const handler of h.handlers["session_start"] ?? []) await handler({}, ctx);
		h.emitted.length = 0;
		const observers = h.handlers["tool_call"] ?? [];
		assert.equal(observers.length, 1, "exactly one observe hook");

		// Sandboxed bash allows and emits a decision.
		const result = await observers[0]({ toolName: "bash", input: { command: "ls" } }, ctx);
		assert.equal(result, undefined, "the observer must never return a block");
		const decisions = h.emitted.filter(([c]) => c === "guard:decision");
		assert.equal(decisions.length, 1);
		const payload = decisions[0][1] as { action: string; class: string; call: { kind: string }; reason: string };
		assert.equal(payload.action, "allow");
		assert.equal(payload.class, "sandboxed-exec");
		assert.equal(payload.call.kind, "sandboxed-exec");

		// A host-shell command that would be denied is observed as deny, never blocked.
		fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
		fs.writeFileSync(projectConfigPath(cwd), JSON.stringify({ hostBash: { deny: ["Pwsh(rm -rf*)"] } }), "utf8");
		for (const handler of h.handlers["session_start"] ?? []) await handler({}, ctx);
		h.emitted.length = 0;
		await observers[0]({ toolName: "pwsh", input: { command: "rm -rf ./build" } }, ctx);
		const denyPayload = h.emitted.filter(([c]) => c === "guard:decision").at(-1)?.[1] as { action: string; class: string };
		assert.equal(denyPayload.action, "deny");
		assert.equal(denyPayload.class, "host-shell");
		assert.equal(h.emitted.filter(([c]) => c === "guard:decision").length, 1);

		// A protected-path write is observed as a prompt decision (never enforced).
		await observers[0]({ toolName: "write", input: { path: path.join(cwd, "AGENTS.md"), content: "x" } }, ctx);
		const writeDecision = h.emitted.filter(([c]) => c === "guard:decision").at(-1)?.[1] as { action: string; class: string };
		assert.equal(writeDecision.action, "prompt");
		assert.equal(writeDecision.class, "local-write");

		// Local reads inside cwd are observed as allow.
		await observers[0]({ toolName: "read", input: { path: path.join(cwd, "src.ts") } }, ctx);
		const readDecision = h.emitted.filter(([c]) => c === "guard:decision").at(-1)?.[1] as { action: string; class: string };
		assert.equal(readDecision.action, "allow");
		assert.equal(readDecision.class, "local-read");

		// Unknown tools classify (fallback remote-write) and still observe.
		await observers[0]({ toolName: "frobnicate", input: {} }, ctx);
		const unknown = h.emitted.filter(([c]) => c === "guard:decision").at(-1)?.[1] as { action: string; class: string };
		assert.equal(unknown.class, "remote-write");
		assert.equal(unknown.action, "prompt", "remote writes prompt in default (observe-only)");
	});
});

test("harness: tool_call observer errors never break the call", async () => {
	await withTempHome(async () => {
		const h = makeHarness();
		const cwd = makeTempDir("guard-harness-err-");
		const ctx = harnessCtx(h, cwd);
		for (const handler of h.handlers["session_start"] ?? []) await handler({}, ctx);
		const observers = h.handlers["tool_call"] ?? [];
		// A broken notify (debug on) must not throw out of the hook.
		h.notifications.length = 0;
		for (const handler of h.handlers["session_start"] ?? []) await handler({}, ctx);
		await h.commandHandlers.get("guard")!("debug on", ctx);
		(ctx.ui as { notify: (m: string) => void }).notify = () => { throw new Error("ui gone"); };
		const result = await observers[0]({ toolName: "bash", input: { command: "ls" } }, ctx);
		assert.equal(result, undefined);
	});
});

test("harness: /guard profile, cycle shortcut, research hold, and ack", async () => {
	await withTempHome(async () => {
		const h = makeHarness();
		const cwd = makeTempDir("guard-harness-cmd-");
		const ctx = harnessCtx(h, cwd);
		for (const handler of h.handlers["session_start"] ?? []) await handler({}, ctx);
		const handler = h.commandHandlers.get("guard");
		assert.ok(handler, "/guard command registered");
		h.emitted.length = 0;

		// Direct profile set, including the command-only unrestricted.
		await handler("profile unrestricted", ctx);
		assert.ok(h.notifications.some((n) => /Profile: unrestricted/.test(n)));
		const unrestrictedEvent = h.emitted.filter(([c]) => c === "guard:profile").at(-1)?.[1] as { profile: string };
		assert.equal(unrestrictedEvent.profile, "unrestricted");
		assert.match(h.status.get("guard") ?? "", /unrestricted/);

		// The cycle shortcut is registered with the settled key.
		assert.ok(h.shortcuts.some((s) => s.shortcut === "ctrl+alt+g"), "ctrl+alt+g is the default cycle hotkey");
		// Cycling from unrestricted goes to research.
		h.emitted.length = 0;
		h.notifications.length = 0;
		await h.shortcuts[0].handler(ctx);
		assert.ok(h.notifications.some((n) => /Profile: research/.test(n)), "cycling from unrestricted goes to research");

		// Hold research, then a profile change is blocked with a notice.
		h.emitted.length = 0;
		h.notifications.length = 0;
		for (const listener of h.eventListeners["guard:research-request"] ?? []) listener({ holder: "plan" });
		const ack = h.emitted.find(([c]) => c === "guard:research-ack")?.[1] as { granted: boolean; reason: string; profile: string };
		assert.equal(ack.granted, true);
		assert.equal(ack.profile, "research");
		await handler("profile yolo", ctx);
		assert.ok(h.notifications.some((n) => /blocked/.test(n)));
		await h.shortcuts[0].handler(ctx);
		assert.ok(h.notifications.filter((n) => /blocked/.test(n)).length >= 2, "the cycle is blocked too");

		// Release restores the pre-hold profile (research was already active when
		// the hold was requested, so it stays).
		for (const listener of h.eventListeners["guard:research-release"] ?? []) listener({ holder: "plan" });
		const restored = h.emitted.filter(([c]) => c === "guard:profile").at(-1)?.[1] as { profile: string };
		assert.equal(restored.profile, "research", "release broadcasts the restored profile");

		// /guard ack with no lock reports cleanly.
		h.notifications.length = 0;
		await handler("ack", ctx);
		assert.ok(h.notifications.some((n) => /Workspace is not locked/.test(n)));
	});
});

test("harness: /guard debug on produces observe notifications", async () => {
	await withTempHome(async () => {
		const h = makeHarness();
		const cwd = makeTempDir("guard-harness-debug-");
		const ctx = harnessCtx(h, cwd);
		for (const handler of h.handlers["session_start"] ?? []) await handler({}, ctx);
		const handler = h.commandHandlers.get("guard");
		const observers = h.handlers["tool_call"] ?? [];
		h.notifications.length = 0;
		await observers[0]({ toolName: "bash", input: { command: "ls" } }, ctx);
		assert.equal(h.notifications.length, 0, "debug off: no notifications");
		await handler!("debug on", ctx);
		h.notifications.length = 0;
		await observers[0]({ toolName: "bash", input: { command: "ls" } }, ctx);
		assert.equal(h.notifications.length, 1);
		assert.match(h.notifications[0], /\[guard observe\] bash: allow \(/);
		await handler!("debug off", ctx);
		h.notifications.length = 0;
		await observers[0]({ toolName: "bash", input: { command: "ls" } }, ctx);
		assert.equal(h.notifications.length, 0);
	});
});

test("harness: /guard migrate dry writes nothing", async () => {
	await withTempHome(async () => {
		const h = makeHarness();
		const cwd = makeTempDir("guard-mig-dry-cwd-");
		fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
		fs.writeFileSync(path.join(cwd, ".pi", "pi-tool-permissions.local.json"), JSON.stringify({ allow: ["Bash(dotnet build *)"] }), "utf8");
		const ctx = harnessCtx(h, cwd);
		for (const handler of h.handlers["session_start"] ?? []) await handler({}, ctx);
		h.notifications.length = 0;
		await h.commandHandlers.get("guard")!("migrate dry", ctx);
		assert.ok(h.notifications.some((n) => /migrate \(dry\)/.test(n)));
		assert.ok(h.notifications.some((n) => /HostBash\(dotnet build \*\)/.test(n)), "the report shows the converted rule");
		assert.equal(fs.existsSync(projectConfigPath(cwd)), false, "dry writes nothing");
		assert.equal(fs.existsSync(userConfigPath(process.env.HOME as string)), false, "dry writes nothing to the user scope");
	});
});

test("harness: /guard migrate with a confirm choice writes both scopes idempotently", async () => {
	await withTempHome(async () => {
		const home = process.env.HOME as string;
		const h = makeHarness();
		const cwd = makeTempDir("guard-mig-write-cwd-");
		fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
		fs.writeFileSync(path.join(cwd, ".pi", "pi-tool-permissions.local.json"), JSON.stringify({ allow: ["Bash(dotnet build *)"] }), "utf8");
		fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
		fs.writeFileSync(path.join(home, ".pi", "agent", "pi-tool-permissions.json"), JSON.stringify({ allow: ["Bash(git status*)"], readAllowPaths: ["/tmp/docs"] }), "utf8");
		const ctx = harnessCtx(h, cwd, "Write");
		for (const handler of h.handlers["session_start"] ?? []) await handler({}, ctx);
		h.notifications.length = 0;
		await h.commandHandlers.get("guard")!("migrate", ctx);
		const projectCfg = JSON.parse(fs.readFileSync(projectConfigPath(cwd), "utf8")) as { hostBash?: { allow?: string[] } };
		assert.deepEqual(projectCfg.hostBash?.allow, ["HostBash(dotnet build *)"], "project scope written");
		const userCfg = JSON.parse(fs.readFileSync(userConfigPath(home), "utf8")) as { hostBash?: { allow?: string[] }; readRoots?: string[] };
		assert.deepEqual(userCfg.hostBash?.allow, ["HostBash(git status*)"], "user scope written");
		assert.deepEqual(userCfg.readRoots, ["/tmp/docs"], "readAllowPaths became readRoots");
		assert.ok(h.notifications.some((n) => /wrote \d+ new entr/.test(n)));
		assert.ok(h.notifications.some((n) => /union with dedupe/.test(n)));

		// Second run with Cancel: files unchanged.
		const before = fs.readFileSync(projectConfigPath(cwd), "utf8");
		const ctxCancel = harnessCtx(h, cwd, "Cancel");
		await h.commandHandlers.get("guard")!("migrate", ctxCancel);
		assert.ok(h.notifications.some((n) => /cancelled/.test(n)));
		assert.equal(fs.readFileSync(projectConfigPath(cwd), "utf8"), before);

		// Second run with Write: adds nothing.
		h.notifications.length = 0;
		await h.commandHandlers.get("guard")!("migrate", ctx);
		assert.ok(h.notifications.some((n) => /wrote 0 new entries/.test(n)), "re-running adds nothing");
	});
});

test("harness: /guard list and reload report the effective policy", async () => {
	await withTempHome(async () => {
		const h = makeHarness();
		const cwd = makeTempDir("guard-harness-list-");
		const ctx = harnessCtx(h, cwd);
		for (const handler of h.handlers["session_start"] ?? []) await handler({}, ctx);
		h.notifications.length = 0;
		await h.commandHandlers.get("guard")!("list", ctx);
		const list = h.notifications.join("\n");
		assert.match(list, /profile \(this session\): default/);
		assert.match(list, new RegExp(`sandbox: ${sandboxMode}`));
		assert.match(list, /workspace: unlocked/);
		assert.match(list, /host shell rules: 0 deny, 0 ask, 0 allow/);
		assert.match(list, /toolClasses overrides: 0/);
		assert.match(list, /debug: off/);
		h.notifications.length = 0;
		await h.commandHandlers.get("guard")!("reload", ctx);
		assert.ok(h.notifications.some((n) => /config reloaded/.test(n)));
		// help mentions the observe-only coexistence note.
		h.notifications.length = 0;
		await h.commandHandlers.get("guard")!("help", ctx);
		assert.match(h.notifications.join("\n"), /OBSERVES/);
		assert.match(h.notifications.join("\n"), /unrestricted is command-only/);
	});
});

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
