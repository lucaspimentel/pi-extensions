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
	registeredTools: Map<string, { execute: (...args: any[]) => Promise<any>; annotations?: Record<string, boolean | undefined> }>;
}

const harnesses: Harness[] = [];

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
		registeredTools: new Map(),
	};
	const api = {
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
			(h.handlers[event] ??= []).push(handler);
			return () => {};
		},
		registerTool: (tool: { name: string; execute: (...args: any[]) => Promise<any>; annotations?: Record<string, boolean | undefined> }) => h.registeredTools.set(tool.name, tool),
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
	harnesses.push(h);
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
	const firstHarness = harnesses.length;
	try {
		return await fn();
	} finally {
		try {
			for (const h of harnesses.slice(firstHarness)) {
				for (const shutdown of h.handlers.session_shutdown ?? []) await shutdown({}, {});
			}
		} finally { process.env.HOME = realHome; }
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
		assert.equal(payload.sandbox.workspaceMode, "rw", "default bash stays rw even in reduced mode");
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
		for (const listener of h.eventListeners["guard:research-request"] ?? []) await listener({ holder: "plan" });
		const ack = h.emitted.find(([c]) => c === "guard:research-ack")?.[1] as { granted: boolean; reason: string; profile: string };
		assert.equal(ack.granted, true);
		assert.equal(ack.profile, "research");
		await handler("profile yolo", ctx);
		assert.ok(h.notifications.some((n) => /blocked/.test(n)));
		await h.shortcuts[0].handler(ctx);
		assert.ok(h.notifications.filter((n) => /blocked/.test(n)).length >= 2, "the cycle is blocked too");

		// Release restores the pre-hold profile (research was already active when
		// the hold was requested, so it stays).
		for (const listener of h.eventListeners["guard:research-release"] ?? []) await listener({ holder: "plan" });
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
		assert.match(h.notifications[0], /\[guard enforce\] bash: allow \(/);
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
		ctx.ui.select = async () => {
			assert.ok(h.notifications.some((message) => message.includes("rule(s)/setting(s) converted")), "preview is shown before the confirmation dialog");
			assert.equal(fs.existsSync(projectConfigPath(cwd)), false, "preview precedes writes");
			return "Write";
		};
		await h.commandHandlers.get("guard")!("migrate", ctx);
		ctx.ui.select = async () => "Write";
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

test("idempotent migration preserves worker namespace when no effective entries change", async () => {
	if (sandboxMode === "degraded") return;
	await withTempHome(async () => {
		const h = makeHarness();
		const cwd = makeTempDir("guard-migrate-noop-worker-");
		fs.mkdirSync(path.join(cwd, ".pi"));
		const legacy = path.join(cwd, ".pi/pi-tool-permissions.local.json");
		const source = JSON.stringify({ allow: ["Bash(echo imported)"] });
		fs.writeFileSync(legacy, source);
		const ctx = harnessCtx(h, cwd, "Write");
		await h.handlers.session_start[0]({}, ctx);
		await h.commandHandlers.get("guard")!("migrate", ctx);
		const worker = h.registeredTools.get("python")!;
		assert.equal((await worker.execute("id", { code: "retained = 73" }, undefined, undefined, ctx)).structuredContent.status, "ok");
		await h.commandHandlers.get("guard")!("migrate", ctx);
		const result = await worker.execute("id", { code: "retained" }, undefined, undefined, ctx);
		assert.equal(result.structuredContent.status, "ok");
		assert.equal(result.structuredContent.repr, "73");
		assert.equal(fs.readFileSync(legacy, "utf8"), source);
	});
});

test("migration confirmation from a replaced session expires even when the new epoch has the same number", async () => {
	await withTempHome(async () => {
		const h = makeHarness();
		const cwd = makeTempDir("guard-migrate-stale-session-");
		fs.mkdirSync(path.join(cwd, ".pi"));
		fs.writeFileSync(path.join(cwd, ".pi/pi-tool-permissions.local.json"), JSON.stringify({ allow: ["Bash(echo imported)"] }));
		const ctx = harnessCtx(h, cwd);
		await h.handlers.session_start[0]({}, ctx);
		let show!: () => void;
		let answer!: (value: string) => void;
		const shown = new Promise<void>((resolve) => { show = resolve; });
		ctx.ui.select = async () => { show(); return new Promise<string>((resolve) => { answer = resolve; }); };
		const migrating = h.commandHandlers.get("guard")!("migrate", ctx);
		await shown;
		await h.handlers.session_start[0]({}, ctx);
		answer("Write");
		await migrating;
		assert.equal(fs.existsSync(projectConfigPath(cwd)), false);
		assert.ok(h.notifications.some((message) => /migration expired/.test(message)));
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
		assert.match(h.notifications.join("\n"), /ENFORCES bash, host_bash, python and node; other tools remain observe-only/);
		assert.match(h.notifications.join("\n"), /unrestricted is command-only/);
	});
});

test("registered python/node workers declare conservative capability metadata", () => {
	const h = makeHarness();
	for (const name of ["python", "node"]) {
		const tool = h.registeredTools.get(name)!;
		assert.deepEqual(tool.annotations, {
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: true,
		}, name);
	}
});

test("registered tools own all four names and reject calls before session initialization", async () => {
	const h = makeHarness();
	assert.deepEqual([...h.registeredTools.keys()].sort(), ["bash", "host_bash", "node", "python"]);
	const ctx = harnessCtx(h, makeTempDir("guard-uninitialized-"));
	for (const name of ["bash", "host_bash", "node", "python"]) {
		await assert.rejects(h.registeredTools.get(name)!.execute("id", { command: "echo should-not-run", code: "1" }, undefined, undefined, ctx), /not initialized/);
		const result = await h.handlers.tool_call[0]({ toolName: name, input: {} }, ctx) as { block: boolean };
		assert.equal(result.block, true);
	}
});

test("registered raw bash honors rules and fixed identities; unrestricted alone skips rules", async () => {
	await withTempHome(async () => {
		const h = makeHarness();
		const cwd = makeTempDir("guard-raw-rules-");
		fs.mkdirSync(path.join(cwd, ".pi"));
		fs.writeFileSync(projectConfigPath(cwd), JSON.stringify({ hostBash: { deny: ["HostBash(echo blocked)"], ask: ["HostBash(echo asked)"] }, toolClasses: { "*": "meta", bash: "remote-read", host_bash: "meta" } }));
		const ctx = harnessCtx(h, cwd);
		await h.handlers.session_start[0]({}, ctx);
		await h.commandHandlers.get("guard")!("profile yolo", ctx);
		for (const name of ["bash", "host_bash"]) {
			await assert.rejects(h.registeredTools.get(name)!.execute("id", { command: "echo blocked" }, undefined, undefined, ctx), /deny rule/);
			const block = await h.handlers.tool_call[0]({ toolName: name, input: { command: "echo blocked" } }, ctx) as { block: boolean };
			assert.equal(block.block, true);
			await assert.rejects(h.registeredTools.get(name)!.execute("id", { command: "echo asked" }, undefined, undefined, ctx), /denied/);
		}
		await h.commandHandlers.get("guard")!("profile unrestricted", ctx);
		const result = await h.registeredTools.get("bash")!.execute("id", { command: "echo blocked" }, undefined, undefined, ctx);
		assert.equal(result.isError, undefined);
		assert.equal(result.structuredContent.exit_code, 0);
		assert.match(result.structuredContent.output, /blocked/);
		await h.handlers.session_shutdown[0]({}, ctx);
	});
});

test("explicit asks offer once/deny only; fallback saves exact effective rules", async () => {
	await withTempHome(async () => {
		const h = makeHarness();
		const cwd = makeTempDir("guard-dialog-");
		fs.mkdirSync(path.join(cwd, ".pi"));
		fs.writeFileSync(projectConfigPath(cwd), JSON.stringify({ hostBash: { ask: ["HostBash(echo asked)"] } }));
		const ctx = harnessCtx(h, cwd);
		await h.handlers.session_start[0]({}, ctx);
		let offered: string[] = [];
		ctx.ui.select = async (_title?: string, options?: string[]) => { offered = options ?? []; return "Deny"; };
		await assert.rejects(h.registeredTools.get("host_bash")!.execute("id", { command: "echo asked" }, undefined, undefined, ctx), /denied/);
		assert.deepEqual(offered, ["Allow once", "Deny"]);
		ctx.ui.select = async (title?: string, options?: string[]) => {
			offered = options ?? [];
			assert.match(title ?? "", /Exact rule: HostBash\(/);
			return "Save for project";
		};
		const result = await h.registeredTools.get("host_bash")!.execute("id", { command: "echo $GUARD_HARNESS_UNSET" }, undefined, undefined, ctx);
		assert.deepEqual(offered, ["Allow once", "Save for project", "Save for user", "Deny"]);
		assert.equal(result.structuredContent.exit_code, 0);
		const saved = JSON.parse(fs.readFileSync(projectConfigPath(cwd), "utf8"));
		assert.deepEqual(saved.hostBash.ask, ["HostBash(echo asked)"]);
		assert.deepEqual(saved.hostBash.allow, ["HostBash(/^echo \\$GUARD_HARNESS_UNSET$/)"]);
		await h.handlers.session_shutdown[0]({}, ctx);
	});
});

test("sandbox bash and both workers share writable scratch at one real host path", async () => {
	if (sandboxMode === "degraded") return;
	await withTempHome(async () => {
		const h = makeHarness();
		const cwd = makeTempDir("guard-shared-scratch-");
		const ctx = harnessCtx(h, cwd);
		await h.handlers.session_start[0]({}, ctx);
		const python = h.registeredTools.get("python")!;
		const node = h.registeredTools.get("node")!;
		const pyStatus = await python.execute("id", { action: "status" }, undefined, undefined, ctx);
		const nodeStatus = await node.execute("id", { action: "status" }, undefined, undefined, ctx);
		const scratch = pyStatus.structuredContent.paths.scratchDir;
		assert.equal(nodeStatus.structuredContent.paths.scratchDir, scratch);
		assert.equal(fs.realpathSync(scratch), scratch);
		const artifact = path.join(scratch, "artifact");
		const shell = await h.registeredTools.get("bash")!.execute("id", { command: `printf shared > '${artifact}'` }, undefined, undefined, ctx);
		assert.equal(shell.structuredContent.exit_code, 0);
		assert.equal((await python.execute("id", { code: `open(${JSON.stringify(artifact)}).read()` }, undefined, undefined, ctx)).structuredContent.status, "ok");
		const javascript = await node.execute("id", { code: `require('fs').readFileSync(${JSON.stringify(artifact)}, 'utf8')` }, undefined, undefined, ctx);
		assert.equal(javascript.structuredContent.status, "ok");
		assert.match(javascript.structuredContent.repr, /shared/);
		await python.execute("id", { action: "reset" }, undefined, undefined, ctx);
		assert.equal(fs.readFileSync(artifact, "utf8"), "shared");
	});
});

test("accepting a save while sandbox work runs waits for teardown before writing protected config", async () => {
	if (sandboxMode === "degraded") return;
	await withTempHome(async () => {
		const h = makeHarness();
		const cwd = makeTempDir("guard-save-active-worker-");
		const ctx = harnessCtx(h, cwd);
		await h.handlers.session_start[0]({}, ctx);
		const worker = h.registeredTools.get("python")!;
		const status = await worker.execute("id", { action: "status" }, undefined, undefined, ctx);
		const marker = path.join(status.structuredContent.paths.scratchDir, "active");
		let show!: () => void;
		let answer!: (choice: string) => void;
		const shown = new Promise<void>((resolve) => { show = resolve; });
		ctx.ui.select = async () => { show(); return new Promise<string>((resolve) => { answer = resolve; }); };
		const saving = h.registeredTools.get("host_bash")!.execute("id", { command: "echo $GUARD_HARNESS_UNSET" }, undefined, undefined, ctx);
		void saving.catch(() => {});
		await shown;
		const executing = worker.execute("id", { code: `import time\nopen(${JSON.stringify(marker)}, 'w').write('ready')\ntime.sleep(2)` }, undefined, undefined, ctx);
		for (let i = 0; i < 300 && !fs.existsSync(marker); i++) await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(fs.existsSync(marker), true);
		answer("Save for project");
		const saved = await saving;
		await executing;
		assert.equal(saved.structuredContent.exit_code, 0);
		assert.equal(fs.existsSync(projectConfigPath(cwd)), true);
		assert.equal((h.emitted.filter(([name]) => name === "guard:profile").at(-1)![1] as { workspaceLocked: boolean }).workspaceLocked, false);
	});
});

test("project rule saving does not quarantine guard's own newly created config when a worker remounts", async () => {
	if (sandboxMode === "degraded") return;
	await withTempHome(async () => {
		const h = makeHarness();
		const cwd = makeTempDir("guard-save-idle-worker-");
		const ctx = harnessCtx(h, cwd, "Save for project");
		await h.handlers.session_start[0]({}, ctx);
		const worker = h.registeredTools.get("python")!;
		assert.equal((await worker.execute("id", { code: "1 + 1" }, undefined, undefined, ctx)).structuredContent.status, "ok");
		await h.registeredTools.get("host_bash")!.execute("id", { command: "echo $GUARD_HARNESS_UNSET" }, undefined, undefined, ctx);
		assert.equal((await worker.execute("id", { code: "2 + 2" }, undefined, undefined, ctx)).structuredContent.status, "ok");
		assert.equal(fs.existsSync(projectConfigPath(cwd)), true);
		assert.equal((h.emitted.filter(([name]) => name === "guard:profile").at(-1)![1] as { workspaceLocked: boolean }).workspaceLocked, false);
	});
});

test("compound suggestions are hidden unless the complete call is authorized", async () => {
	await withTempHome(async () => {
		const h = makeHarness();
		const cwd = makeTempDir("guard-dialog-compound-");
		const ctx = harnessCtx(h, cwd);
		await h.handlers.session_start[0]({}, ctx);
		let offered: string[] = [];
		ctx.ui.select = async (_title?: string, options?: string[]) => { offered = options ?? []; return "Deny"; };
		await assert.rejects(h.registeredTools.get("host_bash")!.execute("id", { command: "echo $GUARD_HARNESS_UNSET; echo $GUARD_SECOND_UNSET" }, undefined, undefined, ctx), /denied/);
		assert.deepEqual(offered, ["Allow once", "Deny"]);
		await h.handlers.session_shutdown[0]({}, ctx);
	});
});

test("aborting a pending owned approval never saves its rule", async () => {
	await withTempHome(async () => {
		const h = makeHarness();
		const cwd = makeTempDir("guard-aborted-approval-");
		const ctx = harnessCtx(h, cwd);
		await h.handlers.session_start[0]({}, ctx);
		let show!: () => void;
		let answer!: (choice: string) => void;
		const shown = new Promise<void>((resolve) => { show = resolve; });
		ctx.ui.select = async () => { show(); return new Promise<string>((resolve) => { answer = resolve; }); };
		const abort = new AbortController();
		const executing = h.registeredTools.get("host_bash")!.execute("id", { command: "echo $GUARD_HARNESS_UNSET" }, abort.signal, undefined, ctx);
		await shown;
		abort.abort();
		answer("Save for project");
		await assert.rejects(executing, /cancel|abort/);
		assert.equal(fs.existsSync(projectConfigPath(cwd)), false);
	});
});

test("stale approvals save nothing and headless dialogs fail closed", async () => {
	await withTempHome(async () => {
		const h = makeHarness();
		const cwd = makeTempDir("guard-dialog-stale-");
		const ctx = harnessCtx(h, cwd);
		await h.handlers.session_start[0]({}, ctx);
		let show!: () => void;
		let answer!: (choice: string) => void;
		const shown = new Promise<void>((resolve) => { show = resolve; });
		ctx.ui.select = async () => { show(); return new Promise<string>((resolve) => { answer = resolve; }); };
		const pending = h.registeredTools.get("host_bash")!.execute("id", { command: "echo $GUARD_UNSET" }, undefined, undefined, ctx);
		await shown;
		await h.commandHandlers.get("guard")!("profile research", ctx);
		answer("Save for project");
		await assert.rejects(pending, /expired/);
		assert.equal(fs.existsSync(projectConfigPath(cwd)), false);
		await h.commandHandlers.get("guard")!("profile default", ctx);
		ctx.hasUI = false;
		await assert.rejects(h.registeredTools.get("host_bash")!.execute("id", { command: "echo $GUARD_UNSET" }, undefined, undefined, ctx), /non-interactive|headless/);
		await h.handlers.session_shutdown[0]({}, ctx);
	});
});

test("guard read grants remount without replay, survive tree replacement and reset on session start", async () => {
	if (sandboxMode === "degraded") return;
	const external = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), ".guard-read-grant-test-")));
	tempDirs.push(external);
	const target = path.join(external, "data.txt");
	fs.writeFileSync(target, "granted-read");
	await withTempHome(async () => {
		const h = makeHarness();
		const cwd = makeTempDir("guard-root-session-");
		const ctx = harnessCtx(h, cwd);
		await h.handlers.session_start[0]({}, ctx);
		let dialogs = 0;
		ctx.ui.select = async (_title?: string, options?: string[]) => {
			dialogs++;
			assert.deepEqual(options, ["Grant for session", "Save for project", "Save for user", "Deny"]);
			return "Grant for session";
		};
		const code = `open(${JSON.stringify(target)}).read()`;
		const result = await h.registeredTools.get("python")!.execute("id", { code }, undefined, undefined, ctx);
		assert.equal(result.structuredContent.status, "permission_needed");
		assert.equal(result.structuredContent.stateLost, true);
		assert.match(result.structuredContent.diagnostic, /not replayed/);
		assert.equal(dialogs, 1);
		assert.equal(fs.existsSync(projectConfigPath(cwd)), false);
		const success = await h.registeredTools.get("python")!.execute("id", { code }, undefined, undefined, ctx);
		assert.equal(success.structuredContent.status, "ok");
		assert.match(success.structuredContent.repr, /granted-read/);
		const before = await h.registeredTools.get("python")!.execute("id", { action: "status" }, undefined, undefined, ctx);
		assert.deepEqual(before.structuredContent.readRoots, [external]);
		const oldScratch = before.structuredContent.paths.scratchDir;
		await h.handlers.session_tree[0]({}, ctx);
		const after = await h.registeredTools.get("python")!.execute("id", { action: "status" }, undefined, undefined, ctx);
		assert.deepEqual(after.structuredContent.readRoots, [external]);
		assert.notEqual(after.structuredContent.paths.scratchDir, oldScratch);
		assert.equal(fs.existsSync(oldScratch), false);
		await h.handlers.session_start[0]({}, ctx);
		const fresh = await h.registeredTools.get("python")!.execute("id", { action: "status" }, undefined, undefined, ctx);
		assert.deepEqual(fresh.structuredContent.readRoots, []);
		await h.handlers.session_shutdown[0]({}, ctx);
	});
});

test("project/user read grants persist after teardown without quarantine or legacy events", async () => {
	if (sandboxMode === "degraded") return;
	const external = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), ".guard-saved-grant-test-")));
	tempDirs.push(external);
	const target = path.join(external, "data.txt");
	fs.writeFileSync(target, "allowed");
	for (const choice of ["Save for project", "Save for user"]) await withTempHome(async () => {
		const h = makeHarness();
		const cwd = makeTempDir("guard-grant-persist-");
		const ctx = harnessCtx(h, cwd, choice);
		await h.handlers.session_start[0]({}, ctx);
		const result = await h.registeredTools.get("python")!.execute("id", { code: `open(${JSON.stringify(target)}).read()` }, undefined, undefined, ctx);
		assert.equal(result.structuredContent.status, "permission_needed");
		assert.equal(result.structuredContent.stateLost, true);
		const destination = choice === "Save for project" ? projectConfigPath(cwd) : userConfigPath(process.env.HOME!);
		assert.deepEqual(JSON.parse(fs.readFileSync(destination, "utf8")).readRoots, [external]);
		assert.equal((h.emitted.filter(([name]) => name === "guard:profile").at(-1)![1] as { workspaceLocked: boolean }).workspaceLocked, false);
		assert.equal(h.emitted.some(([name]) => /permissions|read-root-granted/.test(name)), false);
	});
});

test("registered raw worker is torn down before research profile and acknowledgment", async () => {
	await withTempHome(async () => {
		const h = makeHarness();
		const cwd = makeTempDir("guard-worker-barrier-");
		const ctx = harnessCtx(h, cwd);
		await h.handlers.session_start[0]({}, ctx);
		await h.commandHandlers.get("guard")!("profile unrestricted", ctx);
		const marker = path.join(cwd, "started");
		let executionSettled = false;
		const pending = h.registeredTools.get("node")!.execute("id", { code: `(async () => { require('fs').writeFileSync(${JSON.stringify(marker)}, 'ready'); await new Promise(() => {}); })()`, timeoutSeconds: 30 }, undefined, undefined, ctx).finally(() => { executionSettled = true; });
		for (let i = 0; i < 300 && !fs.existsSync(marker) && !executionSettled; i++) await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(fs.existsSync(marker), true, "worker reached the execution boundary");
		h.emitted.length = 0;
		await h.eventListeners["guard:research-request"][0]({ holder: "plan" });
		assert.equal(executionSettled, true, "registered execution settles only after actual controller teardown");
		const result = await pending;
		assert.equal(result.isError, true);
		assert.ok(["cancelled", "worker_error"].includes(result.structuredContent.status));
		assert.deepEqual(h.emitted.map(([name]) => name), ["guard:profile", "guard:research-ack"]);
		assert.equal((h.emitted[1][1] as { granted: boolean }).granted, true);
		await h.handlers.session_shutdown[0]({}, ctx);
	});
});

test("snapshot failure locks registered host/raw tools even in unrestricted", async () => {
	if (sandboxMode === "degraded") return;
	await withTempHome(async () => {
		const h = makeHarness();
		const cwd = makeTempDir("guard-lock-tools-");
		fs.mkdirSync(path.join(cwd, ".pi"));
		fs.writeFileSync(projectConfigPath(cwd), JSON.stringify({ protectedPaths: ["../invalid-protection"] }));
		const ctx = harnessCtx(h, cwd);
		await h.handlers.session_start[0]({}, ctx);
		await assert.rejects(h.registeredTools.get("bash")!.execute("id", { command: "echo safe" }, undefined, undefined, ctx), /protectedPaths/);
		assert.ok(h.notifications.some((message) => /snapshot failed/.test(message)));
		await h.commandHandlers.get("guard")!("profile unrestricted", ctx);
		await assert.rejects(h.registeredTools.get("host_bash")!.execute("id", { command: "echo safe" }, undefined, undefined, ctx), /workspace locked/);
		const profile = h.emitted.filter(([name]) => name === "guard:profile").at(-1)![1] as { workspaceLocked: boolean; sandbox: { workspaceMode: string } };
		assert.equal(profile.workspaceLocked, true);
		assert.equal(profile.sandbox.workspaceMode, "ro");
		await h.handlers.session_shutdown[0]({}, ctx);
	});
});

test("research publishes effective profile before ack; initial requests fail", async () => {
	await withTempHome(async () => {
		const h = makeHarness();
		await h.eventListeners["guard:research-request"][0]({ holder: "plan" });
		assert.equal((h.emitted.at(-1)![1] as { granted: boolean }).granted, false);
		const ctx = harnessCtx(h, makeTempDir("guard-research-ack-"));
		await h.handlers.session_start[0]({}, ctx);
		h.emitted.length = 0;
		await h.eventListeners["guard:research-request"][0]({ holder: "plan" });
		assert.deepEqual(h.emitted.map(([name]) => name), ["guard:profile", "guard:research-ack"]);
		assert.equal((h.emitted[0][1] as { profile: string }).profile, "research");
		await h.handlers.session_tree[0]({}, ctx);
		assert.equal((h.emitted.filter(([name]) => name === "guard:profile").at(-1)![1] as { profile: string }).profile, "research", "tree replacement preserves the active research hold");
		await h.eventListeners["guard:research-release"][0]({ holder: "plan" });
		assert.equal((h.emitted.filter(([name]) => name === "guard:profile").at(-1)![1] as { profile: string }).profile, "default");
		await h.handlers.session_shutdown[0]({}, ctx);
		await h.handlers.session_shutdown[0]({}, ctx);
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
