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
	registeredTools: Map<string, { execute: (...args: any[]) => Promise<any>; annotations?: Record<string, boolean | undefined>; description?: string; promptSnippet?: string; promptGuidelines?: readonly string[]; prepareLoadout?: () => { descriptions?: Record<string, string> } | undefined }>;
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
		registerTool: (tool: { name: string; execute: (...args: any[]) => Promise<any>; annotations?: Record<string, boolean | undefined>; description?: string; promptSnippet?: string; promptGuidelines?: readonly string[]; prepareLoadout?: () => { descriptions?: Record<string, string> } | undefined }) => h.registeredTools.set(tool.name, tool),
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

		// Sandboxed bash allows and emits a decision; a host with no sandbox
		// denies the same call by name (bash is sandbox-only).
		const result = await observers[0]({ toolName: "bash", input: { command: "ls" }, toolCallId: "call-1" }, ctx) as { block?: boolean } | undefined;
		if (sandboxMode === "degraded") assert.equal(result?.block, true, "degraded bash is denied by name");
		else assert.equal(result, undefined, "the observer must never return a block");
		const decisions = h.emitted.filter(([c]) => c === "guard:decision");
		assert.equal(decisions.length, 1);
		const payload = decisions[0][1] as { action: string; class: string; call: { kind: string }; reason: string; fromCodemode: boolean };
		assert.equal(payload.action, sandboxMode === "degraded" ? "deny" : "allow");
		assert.equal(payload.class, "sandboxed-exec");
		assert.equal(payload.call.kind, "sandboxed-exec");
		assert.equal(payload.fromCodemode, false, "a top-level call is not labeled");
		assert.doesNotMatch(payload.reason, /codemode/, "top-level reasons stay unsuffixed");

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

test("harness: nested tool calls are labeled as codemode origin in decisions and debug notify", async () => {
	await withTempHome(async () => {
		const h = makeHarness();
		const cwd = makeTempDir("guard-harness-nested-obs-");
		const ctx = harnessCtx(h, cwd);
		for (const handler of h.handlers["session_start"] ?? []) await handler({}, ctx);
		h.emitted.length = 0;
		const observers = h.handlers["tool_call"] ?? [];

		// A nested call (parentToolCallId set) emits fromCodemode and a suffixed reason.
		await observers[0]({ toolName: "bash", input: { command: "ls" }, toolCallId: "parent/1", parentToolCallId: "parent" }, ctx);
		const nested = h.emitted.filter(([c]) => c === "guard:decision").at(-1)?.[1] as { action: string; reason: string; fromCodemode: boolean };
		assert.equal(nested.fromCodemode, true);
		assert.match(nested.reason, /\(from codemode script\)$/);

		// A nested id shape alone (no parentToolCallId) is also labeled, matching
		// the execute() path where the parent field is unavailable.
		h.emitted.length = 0;
		await observers[0]({ toolName: "bash", input: { command: "ls" }, toolCallId: "parent/2" }, ctx);
		const byShape = h.emitted.filter(([c]) => c === "guard:decision").at(-1)?.[1] as { reason: string; fromCodemode: boolean };
		assert.equal(byShape.fromCodemode, true);
		assert.match(byShape.reason, /\(from codemode script\)$/);

		// The debug notify carries the same suffix.
		h.notifications.length = 0;
		await h.commandHandlers.get("guard")!("debug on", ctx);
		await observers[0]({ toolName: "bash", input: { command: "ls" }, toolCallId: "parent/3", parentToolCallId: "parent" }, ctx);
		assert.match(h.notifications.at(-1) ?? "", /\(from codemode script\)\)$/);
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
		const result = await observers[0]({ toolName: "bash", input: { command: "ls" } }, ctx) as { block?: boolean } | undefined;
		// Nothing escapes the hook: in degraded mode the call is denied by name,
		// never a thrown notify failure.
		if (sandboxMode === "degraded") assert.equal(result?.block, true);
		else assert.equal(result, undefined);
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
		assert.match(h.notifications[0], new RegExp(`\\[guard enforce\\] bash: ${sandboxMode === "degraded" ? "deny" : "allow"} \\(`));
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
		assert.match(list, /persistent host-shell rules: 0 deny, 0 ask, 0 allow/);
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

test("harness: /guard list reports the discovery scan settings", async () => {
	await withTempHome(async () => {
		const h = makeHarness();
		const cwd = makeTempDir("guard-harness-discovery-list-");
		const ctx = harnessCtx(h, cwd);
		for (const handler of h.handlers["session_start"] ?? []) await handler({}, ctx);
		h.notifications.length = 0;
		await h.commandHandlers.get("guard")!("list", ctx);
		const list = h.notifications.join("\n");
		assert.ok(
			list.includes("discovery scan: cap 500 (default 500), timeout 5000 ms (default 5000), pruned basenames: node_modules, bin, obj, target"),
			list,
		);
	});
});

test("harness: the discovery weakening notice fires once per session and re-fires on a change", async () => {
	await withTempHome(async () => {
		const h = makeHarness();
		const cwd = makeTempDir("guard-harness-discovery-notice-");
		const ctx = harnessCtx(h, cwd);
		const start = async () => { for (const handler of h.handlers["session_start"] ?? []) await handler({}, ctx); };
		const noticeCount = () => h.notifications.filter((n) => /discovery settings differ/.test(n)).length;
		await start();
		assert.equal(noticeCount(), 0, "the defaults stay silent");
		// Weaken the project config and reload.
		fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
		fs.writeFileSync(projectConfigPath(cwd), JSON.stringify({ discoveryPruneNames: ["huge"], discoveryMatchCap: 2000 }), "utf8");
		h.notifications.length = 0;
		await h.commandHandlers.get("guard")!("reload", ctx);
		assert.equal(noticeCount(), 1, "a weakened config warns once");
		// An identical reload is silent.
		h.notifications.length = 0;
		await h.commandHandlers.get("guard")!("reload", ctx);
		assert.equal(noticeCount(), 0, "an identical reload is silent");
		// A changed weakening signature re-fires.
		fs.writeFileSync(projectConfigPath(cwd), JSON.stringify({ discoveryPruneNames: ["huge"], discoveryMatchCap: 3000 }), "utf8");
		h.notifications.length = 0;
		await h.commandHandlers.get("guard")!("reload", ctx);
		assert.equal(noticeCount(), 1, "a changed signature re-fires");
		// A new session warns again even with an unchanged weakened config.
		h.notifications.length = 0;
		await start();
		assert.equal(noticeCount(), 1, "a fresh session resets the notice");
	});
});

test("harness: a non-committing command does not consume the discovery notice", async () => {
	await withTempHome(async () => {
		const h = makeHarness();
		const cwd = makeTempDir("guard-harness-discovery-noconsume-");
		const ctx = harnessCtx(h, cwd);
		const start = async () => { for (const handler of h.handlers["session_start"] ?? []) await handler({}, ctx); };
		const noticeCount = () => h.notifications.filter((n) => /discovery settings differ/.test(n)).length;
		await start();
		fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
		fs.writeFileSync(projectConfigPath(cwd), JSON.stringify({ discoveryPruneNames: ["huge"] }), "utf8");
		// A command that never commits (no runtime) must not consume the notice.
		for (const shutdown of h.handlers["session_shutdown"] ?? []) await shutdown({}, {});
		h.notifications.length = 0;
		await h.commandHandlers.get("guard")!("list", ctx);
		assert.equal(noticeCount(), 0, "list never consumes the discovery notice");
		// The next real session still fires it exactly once.
		h.notifications.length = 0;
		await start();
		assert.equal(noticeCount(), 1);
	});
});

test("registered executors share one loadout hook, distinct snippets, and the routing guidelines", async () => {
	await withTempHome(async () => {
		const h = makeHarness();
		const cwd = makeTempDir("guard-loadout-");
		const ctx = harnessCtx(h, cwd);
		const bash = h.registeredTools.get("bash")!;
		const hostBash = h.registeredTools.get("host_bash")!;
		assert.equal(bash.promptSnippet, "Run a shell command in the guard sandbox (workspace and session scratch only; no network)");
		assert.equal(hostBash.promptSnippet, "Run a shell command on the host (network, credentials, host paths outside the sandbox)");
		for (const name of ["bash", "host_bash"]) {
			const tool = h.registeredTools.get(name)!;
			assert.equal(tool.promptGuidelines?.length, 2, name);
			assert.match(tool.promptGuidelines![0], /Decide the shell tool before writing the command/);
			assert.match(tool.promptGuidelines![1], /use the `read` tool or `host_bash`/);
		}
		// The same hook instance is attached to every executor, so one request
		// cannot see two different boundary statements.
		const hooks = ["bash", "host_bash", "python", "node"].map((name) => h.registeredTools.get(name)!.prepareLoadout);
		for (const hook of hooks) assert.equal(hook, hooks[0], "one loadout hook for all four executors");
		// The registration-time text is a usable, path-free fallback.
		assert.match(bash.description ?? "", /^Sandboxed shell: no network, no host credentials\./);
		assert.match(bash.description ?? "", /the workspace the current workspace/);
		assert.match(hostBash.description ?? "", /^Host shell: runs on the host/);
		assert.match(h.registeredTools.get("python")!.description ?? "", /^Persistent python interpreter managed by guard/);
		// After session_start the hook substitutes the live paths.
		for (const handler of h.handlers["session_start"] ?? []) await handler({}, ctx);
		const live = bash.prepareLoadout!().descriptions!;
		assert.deepEqual(Object.keys(live).sort(), ["bash", "host_bash", "node", "python"]);
		assert.ok(live.bash.includes(cwd), "the live workspace path is substituted");
		assert.match(live.bash, /session-[^/]+\/scratch/, "the live session scratch path is substituted");
		assert.doesNotMatch(live.bash, /the workspace the current workspace/, "no fallback phrase survives initialization");
		assert.match(live.python, /^Persistent python interpreter managed by guard/);
		assert.ok(live.python.includes(cwd), "workers name the workspace too");
		// A read grant cannot churn the payload: read roots stay a category.
		assert.match(live.bash, /read roots you were granted/);
		assert.doesNotMatch(live.bash, /\/secret-read-root/, "no read-root paths appear");
		await h.handlers.session_shutdown[0]({}, ctx);
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

test("registered raw bash is denied by name; host_bash honors rules and fixed identities", async () => {
	await withTempHome(async () => {
		const h = makeHarness();
		const cwd = makeTempDir("guard-raw-rules-");
		fs.mkdirSync(path.join(cwd, ".pi"));
		fs.writeFileSync(projectConfigPath(cwd), JSON.stringify({ hostBash: { deny: ["HostBash(echo blocked)"], ask: ["HostBash(echo asked)"] }, toolClasses: { "*": "meta", bash: "remote-read", host_bash: "meta" } }));
		const ctx = harnessCtx(h, cwd);
		await h.handlers.session_start[0]({}, ctx);
		await h.commandHandlers.get("guard")!("profile yolo", ctx);
		// bash never runs on the host, so both the execute path and the tool_call
		// interception deny it by name, and the misleading toolClasses entry
		// cannot reclassify it.
		const sandboxOnly = sandboxMode === "degraded"
			? "bash is sandbox-only and this host has no sandbox (degraded mode): use host_bash instead"
			: "bash is sandbox-only; in yolo it would run on the host: use host_bash (same permissions here) instead";
		for (const command of ["echo blocked", "echo asked"]) {
			await assert.rejects(
				h.registeredTools.get("bash")!.execute("id", { command }, undefined, undefined, ctx),
				(err: Error) => err.message.includes(sandboxOnly),
				`${command}: the sandbox-only reason is reported`,
			);
		}
		const bashBlock = await h.handlers.tool_call[0]({ toolName: "bash", input: { command: "echo blocked" } }, ctx) as { block: boolean; reason: string };
		assert.equal(bashBlock.block, true);
		assert.equal(bashBlock.reason, sandboxOnly);
		// host_bash keeps the rule semantics.
		await assert.rejects(h.registeredTools.get("host_bash")!.execute("id", { command: "echo blocked" }, undefined, undefined, ctx), /deny rule/);
		const hostBlock = await h.handlers.tool_call[0]({ toolName: "host_bash", input: { command: "echo blocked" } }, ctx) as { block: boolean };
		assert.equal(hostBlock.block, true);
		await assert.rejects(h.registeredTools.get("host_bash")!.execute("id", { command: "echo asked" }, undefined, undefined, ctx), /denied/);
		// unrestricted skips the rules for the host shell.
		await h.commandHandlers.get("guard")!("profile unrestricted", ctx);
		const result = await h.registeredTools.get("host_bash")!.execute("id", { command: "echo blocked" }, undefined, undefined, ctx);
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
		const saveOverlays = installOwnedAutopilot(ctx as { ui: Record<string, unknown> }, [2]); // "Save allow for project"
		const result = await h.registeredTools.get("host_bash")!.execute("id", { command: "echo $GUARD_HARNESS_UNSET" }, undefined, undefined, ctx);
		assert.equal(saveOverlays[0].kind, "selector");
		assert.equal(result.structuredContent.exit_code, 0);
		const saved = JSON.parse(fs.readFileSync(projectConfigPath(cwd), "utf8"));
		assert.deepEqual(saved.hostBash.ask, ["HostBash(echo asked)"]);
		assert.deepEqual(saved.hostBash.allow, ["HostBash(echo $GUARD_HARNESS_UNSET)"]);
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
		installOwnedAutopilot(ctx as { ui: Record<string, unknown> }, [2]); // "Save allow for project"
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
		installOwnedAutopilot(ctx as { ui: Record<string, unknown> }, [2]); // "Save allow for project"
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

test("enforced write/edit: nested calls label the dialog title with the codemode origin", async () => {
	await withTempHome(async () => {
		const h = makeHarness();
		const cwd = makeTempDir("guard-harness-nested-write-");
		const observers = h.handlers["tool_call"] ?? [];
		const ctx = harnessCtx(h, cwd);
		for (const handler of h.handlers["session_start"] ?? []) await handler({}, ctx);
		// Record dialog titles through a wrapper around ui.select.
		const titles: string[] = [];
		(ctx.ui as Record<string, unknown>).select = async (title: string) => { titles.push(title); return undefined; };
		// A top-level write: no suffix in the title.
		await observers[0]({ toolName: "write", input: { path: path.join(cwd, "a.ts"), content: "x" }, toolCallId: "call-1" }, ctx);
		assert.doesNotMatch(titles[0], /codemode/);
		// A nested write: the title's Why line carries the suffix.
		await observers[0]({ toolName: "write", input: { path: path.join(cwd, "b.ts"), content: "y" }, toolCallId: "parent/1", parentToolCallId: "parent" }, ctx);
		assert.equal(titles.length, 2, "exactly one dialog per call; a skipped selector would misindex the titles array");
		assert.match(titles[1], /Why: .*\(from codemode script\)$/);
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
		const overlays = installOwnedAutopilot(ctx as { ui: Record<string, unknown> }, [2, 0]);
		const result = await h.registeredTools.get("host_bash")!.execute("id", { command: COMPOUND }, undefined, undefined, ctx);
		assert.equal(result.structuredContent.exit_code, 0, "the compound command executed after the second dialog");
		assert.deepEqual(overlays.map((o) => o.kind), ["selector", "picker", "editor", "preview", "selector"], "a fresh approval dialog followed the partial save");
		assert.match(overlays[1].text, /Select the steps to allow \(project\)/, "the picker opened over the breakdown steps");
		assert.match(overlays[1].text, /◉ echo \$GUARD_HARNESS_UNSET/, "prompting steps start preselected");
		const saved = savedRules(cwd);
		assert.deepEqual(saved, ["HostBash(echo $GUARD_SECOND_UNSET)"], "exactly the selected step's rule was saved");
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
		const overlays = installOwnedAutopilot(ctx as { ui: Record<string, unknown> }, [2]); // "Save allow for project"
		const result = await h.registeredTools.get("host_bash")!.execute("id", { command: "echo $GUARD_HARNESS_UNSET" }, undefined, undefined, ctx);
		assert.equal(result.structuredContent.exit_code, 0, "the call executed without a further prompt");
		assert.deepEqual(overlays.map((o) => o.kind), ["selector", "editor", "preview"], "a single prompting step skips the picker and no second dialog opens");
		assert.deepEqual(savedRules(cwd), ["HostBash(echo $GUARD_HARNESS_UNSET)"]);
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
		const overlays = installOwnedAutopilot(ctx as { ui: Record<string, unknown> }, [2, 0], { picker: (c) => c.handleInput("\x1b") });
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
		const overlays = installOwnedAutopilot(ctx as { ui: Record<string, unknown> }, [2], { editor: (c) => c.handleInput("\x1b") });
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
		const overlays = installOwnedAutopilot(ctx as { ui: Record<string, unknown> }, [2], {
			// Answer the first menu, then abort during the fresh dialog's selector:
			// the saved rule persists, but the call never executes and no
			// authorization is carried across.
			selector: (component, index) => {
				if (index === 0) {
					// Two downs: "Allow once" -> "Allow for this session" -> "Save allow for project".
					component.handleInput("\u001b[B");
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
		assert.deepEqual(savedRules(cwd), ["HostBash(echo $GUARD_SECOND_UNSET)"], "the committed rule persists");
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
		const overlays = installOwnedAutopilot(ctx as { ui: Record<string, unknown> }, [2], {
			selector: (component, index) => {
				if (index === 0) {
					// Two downs: "Allow once" -> "Allow for this session" -> "Save allow for project".
					component.handleInput("\u001b[B");
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
		assert.deepEqual(savedRules(cwd), ["HostBash(echo $GUARD_SECOND_UNSET)"], "the first save persists");
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
			// Deny save: menu downs 5 to "Save deny for project", default picker
			// and editor/preview actions, no steering input.
			installOwnedAutopilot(ctx as { ui: Record<string, unknown> }, [5]);
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

// ── Session host-shell grants ("Allow for this session") ──────────────────────

test("session allow grants memory-only rules, runs matching commands without a dialog, and writes no config", async () => {
	await withTempHome(async () => {
		const h = makeHarness();
		const cwd = makeTempDir("guard-session-allow-");
		const ctx = harnessCtx(h, cwd);
		await h.handlers.session_start[0]({}, ctx);
		// Owned stages, so the session action is offered; menu downs 1 selects it.
		const overlays = installOwnedAutopilot(ctx as { ui: Record<string, unknown> }, [1]);
		const result = await h.registeredTools.get("host_bash")!.execute("id", { command: "echo $GUARD_HARNESS_UNSET" }, undefined, undefined, ctx);
		assert.equal(result.structuredContent.exit_code, 0, "the granted call still executes");
		assert.deepEqual(overlays.map((o) => o.kind), ["selector", "editor", "preview"], "a single prompting step skips the picker");
		assert.match(overlays[0].text, /Allow for this session/, "the session action is offered");
		assert.match(overlays[2].text, /Confirm allow for this session\?/);
		assert.match(overlays[2].text, /Destination: this session only/);
		assert.equal(fs.existsSync(projectConfigPath(cwd)), false, "no project config was written");
		assert.equal(fs.existsSync(userConfigPath(process.env.HOME!)), false, "no user config was written");
		const notices = h.notifications.filter((n) => /granted for this session/.test(n));
		assert.equal(notices.length, 1, "the grant is announced");
		assert.match(notices[0], /memory only, nothing was written to the config/);
		// The same command now runs with no dialog at all.
		const again = await h.registeredTools.get("host_bash")!.execute("id", { command: "echo $GUARD_HARNESS_UNSET" }, undefined, undefined, ctx);
		assert.equal(again.structuredContent.exit_code, 0);
		assert.equal(overlays.length, 3, "no further dialog opened");
		// /guard list reports the session rules separately from the persistent ones.
		h.notifications.length = 0;
		await h.commandHandlers.get("guard")!("list", ctx);
		const list = h.notifications.join("\n");
		assert.match(list, /persistent host-shell rules: 0 deny, 0 ask, 0 allow/, "persistent rules stay zero");
		assert.match(list, new RegExp(`session host-shell grants \\(this session only, never written to config\\): 1 allow @ ${cwd}`));
		assert.match(list, /session rules in force here: HostBash\(echo \$GUARD_HARNESS_UNSET\)/);
		// Child isolation: the subagent handshake still carries the profile only, never
		// the parent's session grants.
		h.emitted.length = 0;
		h.eventListeners["guard:subagent-snapshot-request"][0]({ id: "sub-1", cwd });
		const ack = h.emitted.find(([name]) => name === "guard:subagent-snapshot-ack")![1] as Record<string, unknown>;
		assert.deepEqual(Object.keys(ack).sort(), ["id", "ok", "profile", "version"], "the snapshot payload has no rule field");
		assert.equal(ack.ok, true);
		await h.handlers.session_shutdown[0]({}, ctx);
	});
});

test("session allow survives tree navigation, reloads, and profile changes, and is discarded by a fresh session", async () => {
	await withTempHome(async () => {
		const h = makeHarness();
		const cwd = makeTempDir("guard-session-lifetime-");
		const ctx = harnessCtx(h, cwd);
		await h.handlers.session_start[0]({}, ctx);
		const overlays = installOwnedAutopilot(ctx as { ui: Record<string, unknown> }, [1]);
		await h.registeredTools.get("host_bash")!.execute("id", { command: "echo $GUARD_SESSION_KEEP" }, undefined, undefined, ctx);
		assert.equal(overlays.length, 3);
		const runSilently = async (label: string) => {
			const before = overlays.length;
			const run = await h.registeredTools.get("host_bash")!.execute("id", { command: "echo $GUARD_SESSION_KEEP" }, undefined, undefined, ctx);
			assert.equal(run.structuredContent.exit_code, 0, label);
			assert.equal(overlays.length, before, `${label}: no dialog`);
		};
		await h.handlers.session_tree[0]({}, ctx);
		await runSilently("after a tree replacement");
		await h.commandHandlers.get("guard")!("reload", ctx);
		await runSilently("after a config reload");
		await h.commandHandlers.get("guard")!("profile auto", ctx);
		await h.commandHandlers.get("guard")!("profile default", ctx);
		await runSilently("after profile changes");
		// A fresh session start clears the grants: the command prompts again and the
		// session action is gone from the menu.
		await h.handlers.session_start[0]({}, ctx);
		const afterFresh = installOwnedAutopilot(ctx as { ui: Record<string, unknown> }, [], { selector: (component: any) => component.handleInput("\x1b") });
		await assert.rejects(h.registeredTools.get("host_bash")!.execute("id", { command: "echo $GUARD_SESSION_KEEP" }, undefined, undefined, ctx), /denied/);
		// The rejected call proves the rules are gone; the action itself stays
		// available, since eligibility is about creating a grant, not about having one.
		assert.match(afterFresh[0].text, /Save allow for project/, "persistent saves are offered again");
		assert.match(afterFresh[0].text, /Allow for this session/, "a new session grant can still be created");
		h.notifications.length = 0;
		await h.commandHandlers.get("guard")!("list", ctx);
		assert.match(h.notifications.join("\n"), /session host-shell grants \(this session only, never written to config\): \(none\)/);
		await h.handlers.session_shutdown[0]({}, ctx);
	});
});

test("session allow is scoped to the granting workspace and its descendants; another workspace stays dormant", async () => {
	await withTempHome(async () => {
		const h = makeHarness();
		const parent = makeTempDir("guard-session-scope-");
		const origin = path.join(parent, "origin");
		const descendant = path.join(origin, "nested");
		const other = path.join(parent, "other");
		for (const dir of [origin, descendant, other]) fs.mkdirSync(dir, { recursive: true });
		const ctx = harnessCtx(h, origin);
		await h.handlers.session_start[0]({}, ctx);
		const overlays = installOwnedAutopilot(ctx as { ui: Record<string, unknown> }, [1]);
		await h.registeredTools.get("host_bash")!.execute("id", { command: "echo $GUARD_SCOPE_PROBE" }, undefined, undefined, ctx);
		assert.equal(overlays.length, 3);
		// A descendant workspace keeps the grant active (session_tree reloads the
		// config for the new cwd and rebuilds the runtime policy).
		ctx.cwd = descendant;
		await h.handlers.session_tree[0]({}, ctx);
		const inDescendant = await h.registeredTools.get("host_bash")!.execute("id", { command: "echo $GUARD_SCOPE_PROBE" }, undefined, undefined, ctx);
		assert.equal(inDescendant.structuredContent.exit_code, 0);
		assert.equal(overlays.length, 3, "a descendant runs silently");
		// A sibling workspace is out of scope: the command prompts again and the
		// session action is no longer eligible there (the current policy allows it,
		// so no allow plan exists).
		ctx.cwd = other;
		await h.handlers.session_tree[0]({}, ctx);
		const sibling = installOwnedAutopilot(ctx as { ui: Record<string, unknown> }, [], { selector: (component: any) => component.handleInput("\x1b") });
		await assert.rejects(h.registeredTools.get("host_bash")!.execute("id", { command: "echo $GUARD_SCOPE_PROBE" }, undefined, undefined, ctx), /denied/);
		assert.match(sibling[0].text, /Why: /, "the sibling command prompts: the origin grant is dormant here");
		h.notifications.length = 0;
		await h.commandHandlers.get("guard")!("list", ctx);
		const list = h.notifications.join("\n");
		assert.match(list, /dormant/, "the out-of-scope record is reported as dormant");
		assert.doesNotMatch(list, /session rules in force here/, "no session rule applies in the sibling workspace");
		// Returning to the granting workspace reactivates the record.
		ctx.cwd = origin;
		await h.handlers.session_tree[0]({}, ctx);
		const back = await h.registeredTools.get("host_bash")!.execute("id", { command: "echo $GUARD_SCOPE_PROBE" }, undefined, undefined, ctx);
		assert.equal(back.structuredContent.exit_code, 0);
		assert.equal(overlays.length, 3, "the origin runs silently again");
		await h.handlers.session_shutdown[0]({}, ctx);
	});
});

test("session rules never leak into a persistent save", async () => {
	await withTempHome(async () => {
		const h = makeHarness();
		const cwd = makeTempDir("guard-session-noleak-");
		const ctx = harnessCtx(h, cwd);
		await h.handlers.session_start[0]({}, ctx);
		const sessionOverlays = installOwnedAutopilot(ctx as { ui: Record<string, unknown> }, [1]); // "Allow for this session"
		await h.registeredTools.get("host_bash")!.execute("id", { command: "echo $GUARD_SESSION_ONE" }, undefined, undefined, ctx);
		assert.equal(sessionOverlays.length, 3);
		// Byte-level isolation: neither scope wrote anything for the session grant.
		assert.equal(fs.existsSync(projectConfigPath(cwd)), false, "the project config is untouched by the session grant");
		assert.equal(fs.existsSync(userConfigPath(process.env.HOME!)), false, "the user config is untouched by the session grant");
		// A later persistent allow save for a different command writes only its own
		// reviewed rules, never the session grant.
		installOwnedAutopilot(ctx as { ui: Record<string, unknown> }, [2]); // "Save allow for project"
		await h.registeredTools.get("host_bash")!.execute("id", { command: "echo $GUARD_PERSIST_TWO" }, undefined, undefined, ctx);
		const saved = savedRules(cwd);
		assert.deepEqual(saved, ["HostBash(echo $GUARD_PERSIST_TWO)"], "only the reviewed persistent rule was written");
		assert.ok(!saved.some((rule) => rule.includes("GUARD_SESSION_ONE")), "the session rule is absent from disk");
		await h.handlers.session_shutdown[0]({}, ctx);
	});
});

test("the session action is hidden when the granting workspace identity cannot be resolved", async () => {
	await withTempHome(async () => {
		const h = makeHarness();
		const cwd = path.join(makeTempDir("guard-session-unresolved-"), "gone");
		fs.mkdirSync(cwd);
		const ctx = harnessCtx(h, cwd);
		await h.handlers.session_start[0]({}, ctx);
		// The workspace no longer resolves, so no session grant could be installed: the
		// action is hidden before the dialog rather than offered and then failed.
		fs.rmdirSync(cwd);
		const overlays = installOwnedAutopilot(ctx as { ui: Record<string, unknown> }, [], { selector: (component: any) => component.handleInput("\x1b") });
		await assert.rejects(h.registeredTools.get("host_bash")!.execute("id", { command: "echo $GUARD_UNRESOLVED" }, undefined, undefined, ctx), /denied/);
		assert.match(overlays[0].text, /Save allow for project/, "persistent allow saves stay offered");
		assert.doesNotMatch(overlays[0].text, /Allow for this session/, "the session action is hidden");
		await h.handlers.session_shutdown[0]({}, ctx);
	});
});

test("session allow fails closed when the workspace identity disappears before the commit", async () => {
	await withTempHome(async () => {
		const h = makeHarness();
		const cwd = makeTempDir("guard-session-vanish-");
		const ctx = harnessCtx(h, cwd);
		await h.handlers.session_start[0]({}, ctx);
		const overlays = installOwnedAutopilot(ctx as { ui: Record<string, unknown> }, [1], {
			// Remove the workspace while the editor is open: the commit-time identity
			// re-resolution must fail closed, granting and executing nothing.
			editor: (component: any) => {
				fs.rmdirSync(cwd);
				component.handleInput("\r");
			},
		});
		await assert.rejects(
			h.registeredTools.get("host_bash")!.execute("id", { command: "echo $GUARD_SESSION_VANISH" }, undefined, undefined, ctx),
			/workspace identity could not be resolved/,
		);
		assert.deepEqual(overlays.map((o) => o.kind), ["selector", "editor", "preview"], "the interaction completed before the commit failed");
		assert.equal(h.notifications.some((n) => /granted for this session/.test(n)), false, "no grant was announced");
		await h.handlers.session_shutdown[0]({}, ctx);
	});
});

test("aborting a session grant after its commit keeps the rules but never executes the stale call", async () => {
	await withTempHome(async () => {
		const h = makeHarness();
		const cwd = makeTempDir("guard-session-abort-");
		const ctx = harnessCtx(h, cwd);
		await h.handlers.session_start[0]({}, ctx);
		const abort = new AbortController();
		const overlays = installOwnedAutopilot(ctx as { ui: Record<string, unknown> }, [1], {
			// The first menu grants the session rules for a compound command with a
			// partial selection (second step only); the fresh dialog that follows is
			// aborted, so the committed grant persists but nothing executes.
			selector: (component: any, index: number) => {
				if (index === 0) {
					component.handleInput("\u001b[B"); // "Allow for this session"
					component.handleInput("\r");
					return;
				}
				abort.abort();
			},
			picker: (component: any) => {
				// Deselect the preselected first step so only the second is granted.
				component.handleInput(" ");
				component.handleInput("\r");
			},
		});
		await assert.rejects(
			h.registeredTools.get("host_bash")!.execute("id", { command: COMPOUND }, abort.signal, undefined, ctx),
			/abort|cancel|expired/,
		);
		assert.deepEqual(overlays.map((o) => o.kind), ["selector", "picker", "editor", "preview", "selector"], "the grant committed, then the fresh dialog opened before the abort");
		assert.equal(fs.existsSync(projectConfigPath(cwd)), false, "nothing was written to disk");
		h.notifications.length = 0;
		await h.commandHandlers.get("guard")!("list", ctx);
		assert.match(h.notifications.join("\n"), /session rules in force here: HostBash\(echo \$GUARD_SECOND_UNSET\)/, "the partial grant persists for the session");
		await h.handlers.session_shutdown[0]({}, ctx);
	});
});

test("session allow: a partial grant re-prompts and the second dialog completes the call", async () => {
	await withTempHome(async () => {
		const h = makeHarness();
		const cwd = makeTempDir("guard-session-partial-");
		const ctx = harnessCtx(h, cwd);
		await h.handlers.session_start[0]({}, ctx);
		// First menu: "Allow for this session". The picker's default action toggles
		// the preselected first step off, so only the second prompting step is
		// granted; the fresh dialog then answers "Allow once" (index 0).
		const overlays = installOwnedAutopilot(ctx as { ui: Record<string, unknown> }, [1, 0]);
		const result = await h.registeredTools.get("host_bash")!.execute("id", { command: COMPOUND }, undefined, undefined, ctx);
		assert.equal(result.structuredContent.exit_code, 0, "the compound command executed after the second dialog");
		assert.deepEqual(overlays.map((o) => o.kind), ["selector", "picker", "editor", "preview", "selector"], "a fresh approval dialog followed the partial grant");
		assert.ok(overlays[4].text.includes("» [?] echo $GUARD_HARNESS_UNSET"), "the unselected step still prompts in the fresh breakdown", overlays[4].text);
		assert.equal(fs.existsSync(projectConfigPath(cwd)), false, "the grant stayed in memory");
		const notices = h.notifications.filter((n) => /granted for this session/.test(n));
		assert.equal(notices.length, 1, "exactly one grant notification");
		assert.match(notices[0], /; 1 step\(s\) still prompt/);
		// Exactly the selected step's rule was granted, and it applies on its own.
		h.notifications.length = 0;
		await h.commandHandlers.get("guard")!("list", ctx);
		assert.match(h.notifications.join("\n"), /session rules in force here: HostBash\(echo \$GUARD_SECOND_UNSET\)/);
		const standalone = await h.registeredTools.get("host_bash")!.execute("id", { command: "echo $GUARD_SECOND_UNSET" }, undefined, undefined, ctx);
		assert.equal(standalone.structuredContent.exit_code, 0, "the granted step runs on its own");
		assert.equal(overlays.length, 5, "the granted rule needs no dialog");
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
