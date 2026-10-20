// Harness tests for the guard extension entry point (extensions/guard/index.ts)
// with a fake pi API object: session_start wiring, the observe-only tool_call
// hook, /guard subcommands, the cycle shortcut, the research hold, debug
// notifications, and the migrate command flow.
// Run: node tests/guard-harness.test.mts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { initTheme } from "@earendil-works/pi-coding-agent";
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
	steering: Array<{ text: string; deliverAs?: string }>;
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
		steering: [],
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
		sendUserMessage: (text: string, options?: { deliverAs?: string }) => { h.steering.push({ text, deliverAs: options?.deliverAs }); },
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

function harnessCtx(h: Harness, cwd: string, selectResult: string | undefined = undefined, inputResult: string | undefined = undefined) {
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
			setWorkingVisible: (_visible: boolean) => {},
			select: async () => selectResult,
			input: async () => inputResult,
			theme: { fg: (_role: string, s: string) => s },
		},
	};
}

/** Install the owned-stage capabilities over a controlled fake TUI and drive
 * mounted stages automatically: scripted DOWN-count answers for selector
 * menus, Enter to submit editor prefills, Enter to confirm previews, and
 * space+Enter to continue the deny picker. Mirrors the controlled boundary of
 * a real pi TUI host: `ui.custom` mounts stages INLINE (guard's default
 * presentation) and the setWidget/showOverlay bridge covers the stacking
 * fallback. Optional per-stage actions override the automatic answer for the
 * re-prompt loop tests (picker esc, editor cancellation, a paused second
 * selector). */
function installOwnedAutopilot(ctx: { ui: Record<string, unknown> }, menuDowns: number[], actions: { picker?: (component: any) => void; editor?: (component: any) => void; selector?: (component: any, index: number) => void } = {}): Array<{ kind: string; text: string }> {
	const overlays: Array<{ kind: string; text: string }> = [];
	let selectorIndex = 0;
	const drive = (component: any): void => {
		setTimeout(() => {
			let text = "";
			try {
				text = component.render(120).map((line: string) => line.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");
			} catch { text = ""; }
			let kind = "selector";
			if (text.includes("space toggle")) kind = "picker";
			else if (text.includes("enter submit")) kind = "editor";
			else if (text.includes("Confirm")) kind = "preview";
			overlays.push({ kind, text });
			if (kind === "editor" || kind === "preview") (actions.editor && kind === "editor" ? actions.editor : (c: any) => c.handleInput("\r"))(component);
			else if (kind === "picker") (actions.picker ?? ((c: any) => { c.handleInput(" "); c.handleInput("\r"); }))(component);
			else (actions.selector ?? ((c: any, i: number) => {
				const downs = menuDowns[i] ?? 0;
				for (let d = 0; d < downs; d++) c.handleInput("\u001b[B");
				c.handleInput("\r");
			}))(component, selectorIndex++);
		}, 0);
	};
	const fakeTui: any = {
		terminal: { columns: 120, rows: 40 },
		requestRender() {},
		hasOverlay: () => false,
		showOverlay(component: any) {
			const handle = {
				hidden: false, focused: true,
				isHidden: () => false, setHidden: () => {},
				isFocused: () => true, hide: () => {},
			};
			drive(component);
			return handle;
		},
	};
	ctx.ui.setWidget = (key: string, content: unknown) => {
		if (content === undefined) return;
		if (typeof content === "function") {
			(content as (t: unknown, th: unknown) => unknown)(fakeTui, { fg: (_c: string, s: string) => s, bold: (s: string) => s });
		}
	};
	ctx.ui.onTerminalInput = () => () => {};
	ctx.ui.custom = (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: unknown) => void) => unknown, options: unknown) => {
		if (JSON.stringify(options) !== JSON.stringify({ overlay: false })) throw new Error(`harness autopilot: unexpected custom options ${JSON.stringify(options)}`);
		return new Promise((resolve) => {
			const component = factory(fakeTui, { fg: (_c: string, s: string) => s, bold: (s: string) => s }, {}, resolve);
			drive(component);
		});
	};
	return overlays;
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

// Owned-stage tests construct the real ExtensionSelectorComponent/Editor,
// which require an initialized host theme.
initTheme("dark", false);

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

		// A protected-path write is ENFORCED now: the decision is prompt, and the
		// dialog (scripted select: undefined) denies without steering.
		await observers[0]({ toolName: "write", input: { path: path.join(cwd, "AGENTS.md"), content: "x" } }, ctx);
		const writeDecision = h.emitted.filter(([c]) => c === "guard:decision").at(-1)?.[1] as { action: string; class: string; enforcement: boolean };
		assert.equal(writeDecision.action, "prompt");
		assert.equal(writeDecision.class, "local-write");
		assert.equal(writeDecision.enforcement, true, "write/edit emits the enforcement flag");

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
		const shown = new Promise<void>((resolve) => { show = resolve; });
		ctx.ui.select = async (_title?: string, _options?: string[], opts?: { signal?: AbortSignal }) => {
			show();
			if (opts?.signal?.aborted) return undefined;
			return new Promise<string>((resolve) => {
				opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
			});
		};
		const migrating = h.commandHandlers.get("guard")!("migrate", ctx);
		await shown;
		// Cancellation settles automatically when the replacement session starts.
		await h.handlers.session_start[0]({}, ctx);
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
		assert.match(h.notifications.join("\n"), /ENFORCES bash, host_bash, python, node and write\/edit; other non-owned tools remain observe-only/);
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

test("registered tools own all five names and reject calls before session initialization", async () => {
	const h = makeHarness();
	assert.deepEqual([...h.registeredTools.keys()].sort(), ["bash", "host_bash", "node", "python", "request_read_access"]);
	const ctx = harnessCtx(h, makeTempDir("guard-uninitialized-"));
	for (const name of ["bash", "host_bash", "node", "python"]) {
		await assert.rejects(h.registeredTools.get(name)!.execute("id", { command: "echo should-not-run", code: "1" }, undefined, undefined, ctx), /not initialized/);
		const result = await h.handlers.tool_call[0]({ toolName: name, input: {} }, ctx) as { block: boolean };
		assert.equal(result.block, true);
	}
	await assert.rejects(h.registeredTools.get("request_read_access")!.execute("id", { path: "/tmp/x" }, undefined, undefined, ctx), /not initialized/);
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
		ctx.ui.select = async (_title?: string, options?: string[]) => { offered = options ?? []; return "Deny once"; };
		await assert.rejects(h.registeredTools.get("host_bash")!.execute("id", { command: "echo asked" }, undefined, undefined, ctx), /denied/);
		assert.deepEqual(offered, ["Allow once", "Deny once"], "capability-limited hosts keep once actions only");
		// With owned stages, the explicit ask still permits deny saves but never
		// allow saves, and the whole-call exact rule saves through editor+preview.
		const overlays = installOwnedAutopilot(ctx as { ui: Record<string, unknown> }, [2]); // "Save deny for project"
		await assert.rejects(h.registeredTools.get("host_bash")!.execute("id", { command: "echo asked" }, undefined, undefined, ctx), /denied/);
		assert.deepEqual(overlays.map((o) => o.kind), ["selector", "picker", "editor", "preview"]);
		assert.doesNotMatch(overlays[0].text, /Save allow for/, "explicit ask never offers allow saves");
		assert.match(overlays[3].text, /Confirm deny save \(project\)/);
		assert.deepEqual(JSON.parse(fs.readFileSync(projectConfigPath(cwd), "utf8")).hostBash.deny, ["HostBash(/^echo asked$/)"]);
		const saveOverlays = installOwnedAutopilot(ctx as { ui: Record<string, unknown> }, [1]); // "Save allow for project"
		const result = await h.registeredTools.get("host_bash")!.execute("id", { command: "echo $GUARD_HARNESS_UNSET" }, undefined, undefined, ctx);
		assert.equal(saveOverlays[0].kind, "selector");
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
		// A worker is already executing when the save interaction begins, so the
		// save transition must wait for its teardown before writing config.
		const executing = worker.execute("id", { code: `import time\nopen(${JSON.stringify(marker)}, 'w').write('ready')\ntime.sleep(2)` }, undefined, undefined, ctx);
		for (let i = 0; i < 300 && !fs.existsSync(marker); i++) await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(fs.existsSync(marker), true);
		installOwnedAutopilot(ctx as { ui: Record<string, unknown> }, [1]); // "Save allow for project"
		const saved = await h.registeredTools.get("host_bash")!.execute("id", { command: "echo $GUARD_HARNESS_UNSET" }, undefined, undefined, ctx);
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
		const ctx = harnessCtx(h, cwd);
		await h.handlers.session_start[0]({}, ctx);
		const worker = h.registeredTools.get("python")!;
		assert.equal((await worker.execute("id", { code: "1 + 1" }, undefined, undefined, ctx)).structuredContent.status, "ok");
		installOwnedAutopilot(ctx as { ui: Record<string, unknown> }, [1]); // "Save allow for project"
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
		ctx.ui.select = async (_title?: string, options?: string[]) => { offered = options ?? []; return "Deny once"; };
		await assert.rejects(h.registeredTools.get("host_bash")!.execute("id", { command: "echo $GUARD_HARNESS_UNSET; echo $GUARD_SECOND_UNSET" }, undefined, undefined, ctx), /denied/);
		assert.deepEqual(offered, ["Allow once", "Deny once"]);
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
		ctx.ui.select = async (_title?: string, _options?: string[], opts?: { signal?: AbortSignal }) => {
			show();
			if (opts?.signal?.aborted) return undefined;
			return new Promise<string>((resolve) => {
				answer = (choice) => resolve(choice);
				opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
			});
		};
		const abort = new AbortController();
		const executing = h.registeredTools.get("host_bash")!.execute("id", { command: "echo $GUARD_HARNESS_UNSET" }, abort.signal, undefined, ctx);
		void executing.catch(() => {});
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
		const shown = new Promise<void>((resolve) => { show = resolve; });
		ctx.ui.select = async (_title?: string, _options?: string[], opts?: { signal?: AbortSignal }) => {
			show();
			if (opts?.signal?.aborted) return undefined;
			return new Promise<string>((resolve) => {
				opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
			});
		};
		const pending = h.registeredTools.get("host_bash")!.execute("id", { command: "echo $GUARD_UNSET" }, undefined, undefined, ctx);
		void pending.catch(() => {});
		await shown;
		// Cancellation settles automatically; no manual answer is needed.
		await h.commandHandlers.get("guard")!("profile research", ctx);
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
			assert.deepEqual(options, ["Grant for session", "Deny"], "capability-limited hosts keep the session grant and explicit denial only");
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
	for (const [choice, downs] of [["Save for project", 1], ["Save for user", 2]] as const) await withTempHome(async () => {
		const h = makeHarness();
		const cwd = makeTempDir("guard-grant-persist-");
		const ctx = harnessCtx(h, cwd);
		await h.handlers.session_start[0]({}, ctx);
		// Menu answer, then the root editor submits the suggested root, then the
		// preview is confirmed.
		installOwnedAutopilot(ctx as { ui: Record<string, unknown> }, [downs]);
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
	if (sandboxMode === "degraded") return; // persistent workers are denied in degraded mode
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

// ── Enforced write/edit (settled 2026-10-16 design) ─────────────────────────

test("enforced write/edit: allow once runs, deny once blocks with steering, esc blocks", async () => {
	await withTempHome(async () => {
		const h = makeHarness();
		const cwd = makeTempDir("guard-harness-enforce-");
		const observers = h.handlers["tool_call"] ?? [];
		// Allow once on an in-root default write.
		const allowCtx = harnessCtx(h, cwd, "Allow once");
		for (const handler of h.handlers["session_start"] ?? []) await handler({}, allowCtx);
		const result = await observers[0]({ toolName: "edit", input: { path: path.join(cwd, "a.ts") } }, allowCtx);
		assert.equal(result, undefined, "allow once lets the call run");
		// Deny once with a steering instruction.
		const denyCtx = harnessCtx(h, cwd, "Deny once", "write the test first instead");
		const denied = await observers[0]({ toolName: "edit", input: { path: path.join(cwd, "a.ts") } }, denyCtx);
		assert.deepEqual(denied, { block: true, reason: "guard: write/edit denied" });
		assert.deepEqual(h.steering, [{ text: "write the test first instead", deliverAs: "steer" }]);
		// esc (selector cancellation): non-explicit deny, no steering.
		const escCtx = harnessCtx(h, cwd);
		const esc = await observers[0]({ toolName: "edit", input: { path: path.join(cwd, "a.ts") } }, escCtx);
		assert.deepEqual(esc, { block: true, reason: "guard: write/edit denied" });
		assert.equal(h.steering.length, 1, "selector cancellation skips steering");
	});
});

test("enforced write/edit: the switch lands allow-edits and later in-root writes run silently", async () => {
	await withTempHome(async () => {
		const h = makeHarness();
		const cwd = makeTempDir("guard-harness-switch-");
		const observers = h.handlers["tool_call"] ?? [];
		const switchCtx = harnessCtx(h, cwd, "Switch to allow-edits");
		for (const handler of h.handlers["session_start"] ?? []) await handler({}, switchCtx);
		const result = await observers[0]({ toolName: "write", input: { path: path.join(cwd, "a.ts"), content: "x" } }, switchCtx);
		assert.equal(result, undefined, "the switch authorizes the current call");
		assert.ok(h.notifications.some((n) => /Profile: allow-edits/.test(n)), "the rung transition is announced");
		// A later in-root write runs with no dialog: the scripted select would
		// return "Switch to allow-edits" again, which in allow-edits would never
		// be consulted; an out-of-root write still prompts.
		const silentCtx = harnessCtx(h, cwd);
		const second = await observers[0]({ toolName: "write", input: { path: path.join(cwd, "b.ts"), content: "y" } }, silentCtx);
		assert.equal(second, undefined, "in-root writes run without a dialog on the rung");
		const outOfRoot = await observers[0]({ toolName: "write", input: { path: "/etc/hosts" } }, silentCtx);
		assert.deepEqual(outOfRoot, { block: true, reason: "guard: write/edit denied" }, "out-of-root writes still prompt (scripted undefined = deny)");
	});
});

test("enforced write/edit: out-of-root and protected prompts never offer the switch; headless denies", async () => {
	await withTempHome(async () => {
		const h = makeHarness();
		const cwd = makeTempDir("guard-harness-noswitch-");
		const observers = h.handlers["tool_call"] ?? [];
		const ctx = harnessCtx(h, cwd);
		for (const handler of h.handlers["session_start"] ?? []) await handler({}, ctx);
		// Record the selector options through a wrapper around ui.select.
		const seen: string[][] = [];
		(ctx.ui as Record<string, unknown>).select = async (_title: string, options: string[]) => {
			seen.push(options);
			return undefined;
		};
		const outOfRoot = await observers[0]({ toolName: "edit", input: { path: "/etc/hosts" } }, ctx);
		assert.deepEqual(outOfRoot, { block: true, reason: "guard: write/edit denied" });
		assert.ok(seen[0].includes("Deny once"));
		assert.ok(!seen[0].includes("Switch to allow-edits"), "out-of-root prompts never offer the switch");
		const protectedWrite = await observers[0]({ toolName: "edit", input: { path: path.join(cwd, "AGENTS.md") } }, ctx);
		assert.deepEqual(protectedWrite, { block: true, reason: "guard: write/edit denied" });
		assert.ok(!seen[1].includes("Switch to allow-edits"), "protected-path prompts never offer the switch");
		// Headless contexts deny without a dialog: resolveDecision collapses
		// non-interactive prompts to deny before enforcement sees them.
		const headless = { ...ctx, hasUI: false, mode: "rpc" };
		const headlessResult = await observers[0]({ toolName: "edit", input: { path: path.join(cwd, "a.ts") } }, headless);
		assert.equal(headlessResult?.block, true);
		assert.match((headlessResult as { reason: string }).reason, /non-interactive prompt collapses to deny/);
		assert.equal(seen.length, 2, "headless denial opens no dialog");
	});
});

test("enforced write/edit: research denies without a dialog; a default child cannot self-escalate", async () => {
	await withTempHome(async () => {
		const h = makeHarness();
		const cwd = makeTempDir("guard-harness-research-");
		const observers = h.handlers["tool_call"] ?? [];
		const ctx = harnessCtx(h, cwd);
		for (const handler of h.handlers["session_start"] ?? []) await handler({}, ctx);
		await h.commandHandlers.get("guard")!("profile research", ctx);
		const seen: string[][] = [];
		(ctx.ui as Record<string, unknown>).select = async (_title: string, options: string[]) => {
			seen.push(options);
			return undefined;
		};
		const result = await observers[0]({ toolName: "edit", input: { path: path.join(cwd, "a.ts") } }, ctx);
		assert.deepEqual(result, { block: true, reason: "guard: local write: denied in research" });
		assert.equal(seen.length, 0, "research denies with no dialog");
	});
});

// ── Per-step allow saves: re-prompt loop, notifications, cancellation ────────

const COMPOUND = "echo $GUARD_HARNESS_UNSET && echo $GUARD_SECOND_UNSET";
const savedRules = (cwd: string): string[] => {
	const cfg = JSON.parse(fs.readFileSync(projectConfigPath(cwd), "utf8")) as { hostBash?: { allow?: string[]; deny?: string[] } };
	return cfg.hostBash?.allow ?? [];
};

test("per-step allow save: partial commit re-prompts with the saved step allowed, then Allow once completes", async () => {
	await withTempHome(async () => {
		const h = makeHarness();
		const cwd = makeTempDir("guard-perstep-partial-");
		const ctx = harnessCtx(h, cwd);
		await h.handlers.session_start[0]({}, ctx);
		// Default picker action toggles the highlighted (preselected) first step
		// off, so only the second prompting step is saved.
		const overlays = installOwnedAutopilot(ctx as { ui: Record<string, unknown> }, [1, 0]);
		const result = await h.registeredTools.get("host_bash")!.execute("id", { command: COMPOUND }, undefined, undefined, ctx);
		assert.equal(result.structuredContent.exit_code, 0, "the compound command executed after the second dialog");
		assert.deepEqual(overlays.map((o) => o.kind), ["selector", "picker", "editor", "preview", "selector"], "a fresh approval dialog followed the partial save");
		assert.match(overlays[1].text, /Select the steps to allow \(project\)/, "the picker opened over the breakdown steps");
		assert.match(overlays[1].text, /◉ echo \$GUARD_HARNESS_UNSET/, "prompting steps start preselected");
		const saved = savedRules(cwd);
		assert.deepEqual(saved, ["HostBash(/^echo \\$GUARD_SECOND_UNSET$/)"], "exactly the selected step's rule was saved");
		// The fresh dialog recomputes the breakdown: the saved step is allowed context.
		assert.ok(overlays[4].text.includes("[✓] echo $GUARD_SECOND_UNSET"), "the saved step now shows as allowed", overlays[4].text);
		assert.ok(overlays[4].text.includes("» [?] echo $GUARD_HARNESS_UNSET"), "the unselected step still prompts");
		const saveNotices = h.notifications.filter((n) => /saved \d+ allow rule/.test(n));
		assert.equal(saveNotices.length, 1, "exactly one save notification");
		assert.match(saveNotices[0], /saved 1 allow rule\(s\) for project \(/);
		assert.match(saveNotices[0], /guard\.local\.json/);
		assert.match(saveNotices[0], /; 1 step\(s\) still prompt/);
		await h.handlers.session_shutdown[0]({}, ctx);
	});
});

test("per-step allow save: full coverage commits once, executes, and omits the still-prompt clause", async () => {
	await withTempHome(async () => {
		const h = makeHarness();
		const cwd = makeTempDir("guard-perstep-full-");
		const ctx = harnessCtx(h, cwd);
		await h.handlers.session_start[0]({}, ctx);
		const overlays = installOwnedAutopilot(ctx as { ui: Record<string, unknown> }, [1]); // "Save allow for project"
		const result = await h.registeredTools.get("host_bash")!.execute("id", { command: "echo $GUARD_HARNESS_UNSET" }, undefined, undefined, ctx);
		assert.equal(result.structuredContent.exit_code, 0, "the call executed without a further prompt");
		assert.deepEqual(overlays.map((o) => o.kind), ["selector", "editor", "preview"], "a single prompting step skips the picker and no second dialog opens");
		assert.deepEqual(savedRules(cwd), ["HostBash(/^echo \\$GUARD_HARNESS_UNSET$/)"]);
		const saveNotices = h.notifications.filter((n) => /saved \d+ allow rule/.test(n));
		assert.equal(saveNotices.length, 1);
		assert.doesNotMatch(saveNotices[0], /still prompt/);
		await h.handlers.session_shutdown[0]({}, ctx);
	});
});

test("per-step allow save: picker esc returns to the menu; Allow once then executes and saves nothing", async () => {
	await withTempHome(async () => {
		const h = makeHarness();
		const cwd = makeTempDir("guard-perstep-picker-esc-");
		const ctx = harnessCtx(h, cwd);
		await h.handlers.session_start[0]({}, ctx);
		const overlays = installOwnedAutopilot(ctx as { ui: Record<string, unknown> }, [1, 0], { picker: (c) => c.handleInput("\x1b") });
		const result = await h.registeredTools.get("host_bash")!.execute("id", { command: COMPOUND }, undefined, undefined, ctx);
		assert.equal(result.structuredContent.exit_code, 0, "Allow once executed after returning to the menu");
		assert.deepEqual(overlays.map((o) => o.kind), ["selector", "picker", "selector"], "the menu was reopened after the picker esc");
		assert.equal(fs.existsSync(projectConfigPath(cwd)), false, "nothing was written");
		await h.handlers.session_shutdown[0]({}, ctx);
	});
});

test("per-step allow save: editor cancellation mid-loop allows once and saves nothing", async () => {
	await withTempHome(async () => {
		const h = makeHarness();
		const cwd = makeTempDir("guard-perstep-editor-esc-");
		const ctx = harnessCtx(h, cwd);
		await h.handlers.session_start[0]({}, ctx);
		const overlays = installOwnedAutopilot(ctx as { ui: Record<string, unknown> }, [1], { editor: (c) => c.handleInput("\x1b") });
		const result = await h.registeredTools.get("host_bash")!.execute("id", { command: COMPOUND }, undefined, undefined, ctx);
		assert.equal(result.structuredContent.exit_code, 0, "the documented allow-once fallback still applies");
		assert.deepEqual(overlays.map((o) => o.kind), ["selector", "picker", "editor"]);
		assert.equal(fs.existsSync(projectConfigPath(cwd)), false, "nothing was saved");
		assert.equal(h.notifications.some((n) => /saved \d+/.test(n)), false, "no save notification");
		await h.handlers.session_shutdown[0]({}, ctx);
	});
});

test("per-step allow save: cancellation after the commit keeps the rule but never executes", async () => {
	await withTempHome(async () => {
		const h = makeHarness();
		const cwd = makeTempDir("guard-perstep-abort-after-commit-");
		const ctx = harnessCtx(h, cwd);
		await h.handlers.session_start[0]({}, ctx);
		const abort = new AbortController();
		const overlays = installOwnedAutopilot(ctx as { ui: Record<string, unknown> }, [1], {
			// Answer the first menu, then abort during the fresh dialog's selector:
			// the saved rule persists, but the call never executes and no
			// authorization is carried across.
			selector: (component, index) => {
				if (index === 0) {
					component.handleInput("\u001b[B");
					component.handleInput("\r");
					return;
				}
				abort.abort();
			},
		});
		await assert.rejects(
			h.registeredTools.get("host_bash")!.execute("id", { command: COMPOUND }, abort.signal, undefined, ctx),
			/abort|cancel|expired/,
		);
		assert.ok(overlays.length >= 5, "the fresh dialog opened before the cancellation");
		assert.deepEqual(savedRules(cwd), ["HostBash(/^echo \\$GUARD_SECOND_UNSET$/)"], "the committed rule persists");
		await h.handlers.session_shutdown[0]({}, ctx);
	});
});

test("per-step allow save: an external policy change between iterations expires the fresh dialog", async () => {
	await withTempHome(async () => {
		const h = makeHarness();
		const cwd = makeTempDir("guard-perstep-external-change-");
		const ctx = harnessCtx(h, cwd);
		await h.handlers.session_start[0]({}, ctx);
		let secondSelector = false;
		const overlays = installOwnedAutopilot(ctx as { ui: Record<string, unknown> }, [1], {
			selector: (component, index) => {
				if (index === 0) {
					component.handleInput("\u001b[B");
					component.handleInput("\r");
					return;
				}
				secondSelector = true;
				// Out-of-band policy change while the fresh dialog is open.
				void h.commandHandlers.get("guard")!("profile research", ctx);
			},
		});
		await assert.rejects(
			h.registeredTools.get("host_bash")!.execute("id", { command: COMPOUND }, undefined, undefined, ctx),
			/expired|research/,
		);
		assert.equal(secondSelector, true, "the fresh dialog opened before the external change");
		assert.deepEqual(savedRules(cwd), ["HostBash(/^echo \\$GUARD_SECOND_UNSET$/)"], "the first save persists");
		assert.equal(overlays.filter((o) => o.kind === "preview").length, 1, "no further save was committed");
		await h.handlers.session_shutdown[0]({}, ctx);
	});
});

test("initial selector esc denies without saving or executing; deny saves now announce themselves", async () => {
	await withTempHome(async () => {
		const h = makeHarness();
		const cwd = makeTempDir("guard-perstep-deny-notify-");
		const ctx = harnessCtx(h, cwd);
		await h.handlers.session_start[0]({}, ctx);
		{
			const overlays = installOwnedAutopilot(ctx as { ui: Record<string, unknown> }, [], { selector: (c) => c.handleInput("\x1b") });
			await assert.rejects(h.registeredTools.get("host_bash")!.execute("id", { command: COMPOUND }, undefined, undefined, ctx), /denied/);
			assert.deepEqual(overlays.map((o) => o.kind), ["selector"], "esc on the first selector denies immediately");
			assert.equal(fs.existsSync(projectConfigPath(cwd)), false, "nothing was saved");
			assert.equal(h.notifications.some((n) => /saved \d+/.test(n)), false);
		}
		h.notifications.length = 0;
		{
			// Deny save: menu downs 4 to "Save deny for project", default picker
			// and editor/preview actions, no steering input.
			installOwnedAutopilot(ctx as { ui: Record<string, unknown> }, [4]);
			await assert.rejects(h.registeredTools.get("host_bash")!.execute("id", { command: "echo $GUARD_HARNESS_UNSET" }, undefined, undefined, ctx), /denied/);
			const denyNotices = h.notifications.filter((n) => /saved \d+ deny rule/.test(n));
			assert.equal(denyNotices.length, 1, "the previously silent deny save now announces itself");
			assert.match(denyNotices[0], /saved 1 deny rule\(s\) for project \(/);
			assert.doesNotMatch(denyNotices[0], /still prompt/);
			const cfg = JSON.parse(fs.readFileSync(projectConfigPath(cwd), "utf8")) as { hostBash?: { deny?: string[] } };
			assert.deepEqual(cfg.hostBash?.deny, ["HostBash(/^echo \\$GUARD_HARNESS_UNSET$/)"]);
		}
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
