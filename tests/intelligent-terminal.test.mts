// Tests for the Intelligent Terminal hooks extension.
//
// The extension never blocks on the bridge: it enqueues a `wtcli agent-hook`
// event and returns. These tests drive the REAL extension factory with a fake
// pi event registry, a fake ctx, and a spawn override that captures the argv
// and stdin payload, so the mapping table, the gate, and the queue are all
// asserted against the shipped code paths.
//
// Run: node --test tests/intelligent-terminal.test.mts
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

const extensionModule = await import("../extensions/intelligent-terminal/index.ts");
const wtcli = await import("../extensions/intelligent-terminal/wtcli.ts");

const intelligentTerminal = extensionModule.default;
const { isIntelligentTerminalEnabled, ERROR_MESSAGE_MAX, WAIT_MESSAGE_FALLBACK } = extensionModule;

type Handler = (event: any, ctx: any) => unknown;
type Spawn = { command: string; args: string[]; options: any; child: any };

let spawns: Spawn[];
let waiting: any[];
let releaseMode: "close" | "manual";

const savedEnv = {
	WT_COM_CLSID: process.env.WT_COM_CLSID,
	WT_SESSION: process.env.WT_SESSION,
	PI_INTELLIGENT_TERMINAL: process.env.PI_INTELLIGENT_TERMINAL,
};

beforeEach(() => {
	process.env.WT_COM_CLSID = "{test-clsid}";
	process.env.WT_SESSION = "test-pane-guid";
	delete process.env.PI_INTELLIGENT_TERMINAL;

	wtcli.resetForTests();
	wtcli.setResolvedPathForTests("C:\\fake\\wtcli.exe");
	spawns = [];
	waiting = [];
	releaseMode = "close";
	installSpawnOverride();
});

afterEach(() => {
	restoreEnv("WT_COM_CLSID", savedEnv.WT_COM_CLSID);
	restoreEnv("WT_SESSION", savedEnv.WT_SESSION);
	restoreEnv("PI_INTELLIGENT_TERMINAL", savedEnv.PI_INTELLIGENT_TERMINAL);
	wtcli.resetForTests();
});

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

function fakeChild(): any {
	const child: any = new EventEmitter();
	child.stdin = {
		written: [] as string[],
		ended: false,
		on() {
			return this;
		},
		write(chunk: string) {
			this.written.push(String(chunk));
			return true;
		},
		end() {
			this.ended = true;
		},
	};
	child.unref = () => {};
	return child;
}

function installSpawnOverride(): void {
	wtcli.setSpawnOverride(((command: string, args: readonly string[], options: any) => {
		const child = fakeChild();
		spawns.push({ command, args: [...args], options, child });
		if (releaseMode === "close") queueMicrotask(() => child.emit("close", 0));
		else waiting.push(child);
		return child;
	}) as any);
}

function releaseWaiting(): void {
	const children = waiting;
	waiting = [];
	for (const child of children) child.emit("close", 0);
}

function clearSpawns(): void {
	spawns = [];
}

/** Release every pending child (manual mode) until the queue is empty. */
async function settleQueue(): Promise<void> {
	for (let i = 0; i < 50 && waiting.length > 0; i++) {
		releaseWaiting();
		await new Promise((resolve) => setImmediate(resolve));
	}
	await wtcli.flushAgentHooks();
}

function topics(): string[] {
	return spawns.map((spawn) => spawn.args[spawn.args.length - 1]);
}

function payloadAt(index: number): Record<string, unknown> {
	return JSON.parse(spawns[index].child.stdin.written[0]);
}

function loadInstance(): Record<string, Handler> {
	const handlers: Record<string, Handler> = {};
	const pi = {
		on(event: string, handler: Handler) {
			handlers[event] = handler;
		},
	};
	(intelligentTerminal as any)(pi);
	return handlers;
}

function makeCtx(
	options: { mode?: string; sessionId?: string; cwd?: string | null } = {},
): { ctx: any; notifications: Array<[string, string]> } {
	const notifications: Array<[string, string]> = [];
	const ctx = {
		mode: options.mode ?? "tui",
		cwd: options.cwd === undefined ? "C:\\work" : options.cwd,
		sessionManager: { getSessionId: () => options.sessionId ?? "sess-1" },
		ui: {
			notify: (message: string, type: string) => {
				notifications.push([message, type]);
			},
		},
	};
	return { ctx, notifications };
}

/** A ctx whose session/cwd accessors throw, as a stale ctx does. */
function staleCtx(): { ctx: any; notifications: Array<[string, string]> } {
	const notifications: Array<[string, string]> = [];
	const ctx: any = {
		mode: "tui",
		get cwd(): string {
			throw new Error("This extension ctx is stale");
		},
		sessionManager: {
			getSessionId(): string {
				throw new Error("This extension ctx is stale");
			},
		},
		ui: {
			notify: (message: string, type: string) => {
				notifications.push([message, type]);
			},
		},
	};
	return { ctx, notifications };
}

/** Drive one handler and wait for the (serialized) emit queue to drain. */
async function drive(handlers: Record<string, Handler>, name: string, event: any, ctx: any): Promise<void> {
	const handler = handlers[name];
	assert.ok(handler, `expected the extension to register a ${name} handler`);
	await handler(event, ctx);
	await wtcli.flushAgentHooks();
}

/** Register a session so later emissions have a routing key, then forget the spawn. */
async function startSession(
	handlers: Record<string, Handler>,
	ctx: any,
	reason = "startup",
): Promise<void> {
	await drive(handlers, "session_start", { type: "session_start", reason }, ctx);
	clearSpawns();
}

test("gate matrix: platform, opt-out, and pane environment", () => {
	const win = { WT_COM_CLSID: "{c}", WT_SESSION: "s" };
	assert.equal(isIntelligentTerminalEnabled(win, "win32"), true);

	assert.equal(isIntelligentTerminalEnabled(win, "linux"), false);
	assert.equal(isIntelligentTerminalEnabled(win, "darwin"), false);

	assert.equal(isIntelligentTerminalEnabled({ WT_SESSION: "s" }, "win32"), false);
	assert.equal(isIntelligentTerminalEnabled({ WT_COM_CLSID: "{c}" }, "win32"), false);
	assert.equal(isIntelligentTerminalEnabled({ WT_COM_CLSID: "", WT_SESSION: "" }, "win32"), false);

	assert.equal(isIntelligentTerminalEnabled({ ...win, PI_INTELLIGENT_TERMINAL: "1" }, "win32"), true);
	assert.equal(isIntelligentTerminalEnabled({ ...win, PI_INTELLIGENT_TERMINAL: "0" }, "win32"), false);
	assert.equal(isIntelligentTerminalEnabled({ ...win, PI_INTELLIGENT_TERMINAL: "false" }, "win32"), false);
});

test("gate failure registers no handlers at all", () => {
	delete process.env.WT_SESSION;
	const handlers = loadInstance();
	assert.deepEqual(Object.keys(handlers), []);
	assert.deepEqual(spawns, []);
});

test("pi batch and JSON modes never emit", async () => {
	for (const mode of ["json", "print"]) {
		wtcli.resetForTests();
		wtcli.setResolvedPathForTests("C:\\fake\\wtcli.exe");
		spawns = [];
		installSpawnOverride();

		const handlers = loadInstance();
		const { ctx } = makeCtx({ mode });
		await drive(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);
		await drive(handlers, "agent_start", { type: "agent_start" }, ctx);
		await drive(handlers, "before_agent_start", { type: "before_agent_start", messageType: "user", prompt: "hi" }, ctx);
		await drive(handlers, "tool_execution_start", { type: "tool_execution_start", toolName: "read" }, ctx);
		await drive(handlers, "ui_prompt_start", { type: "ui_prompt_start", kind: "confirm", title: "Allow?" }, ctx);
		await drive(handlers, "agent_settled", { type: "agent_settled", aborted: false }, ctx);
		await drive(handlers, "session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);

		assert.deepEqual(spawns, [], `${mode} mode must not spawn the bridge`);
	}
});

test("RPC mode does emit", async () => {
	const handlers = loadInstance();
	const { ctx } = makeCtx({ mode: "rpc" });
	await drive(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);
	assert.deepEqual(topics(), ["agent.session.start"]);
});

test("session_start emits agent.session.start with the routing fields", async () => {
	for (const reason of ["startup", "reload"]) {
		clearSpawns();
		const handlers = loadInstance();
		const { ctx } = makeCtx({ sessionId: "sess-42", cwd: "C:\\work" });
		await drive(handlers, "session_start", { type: "session_start", reason }, ctx);

		assert.deepEqual(topics(), ["agent.session.start"]);
		assert.equal(spawns[0].command, "C:\\fake\\wtcli.exe");
		assert.deepEqual(spawns[0].args, ["agent-hook", "--cli-source", "pi", "--event", "agent.session.start"]);
		assert.deepEqual(spawns[0].options.stdio, ["pipe", "ignore", "ignore"]);
		assert.equal(spawns[0].options.windowsHide, true);

		const payload = payloadAt(0);
		assert.equal(payload.session_id, "sess-42");
		assert.equal(payload.cwd, "C:\\work");
		assert.equal(typeof payload.timestamp, "string");
		assert.match(String(payload.timestamp), /^\d{4}-\d{2}-\d{2}T/);
	}
});

test("a user prompt re-binds the pane and reports the prompt", async () => {
	const handlers = loadInstance();
	const { ctx } = makeCtx({ cwd: "C:\\work" });
	await startSession(handlers, ctx);

	await drive(handlers, "before_agent_start", { type: "before_agent_start", messageType: "user", prompt: "hi" }, ctx);
	assert.deepEqual(topics(), ["agent.session.start", "agent.prompt.submit"]);
	assert.equal(payloadAt(0).cwd, "C:\\work");
	assert.equal(payloadAt(1).cwd, "C:\\work");
});

test("a run another extension starts is not reported as a prompt", async () => {
	const handlers = loadInstance();
	const { ctx } = makeCtx();
	await startSession(handlers, ctx);

	await drive(handlers, "before_agent_start", { type: "before_agent_start", messageType: "custom", message: {} }, ctx);
	assert.deepEqual(spawns, []);
});

test("timeouts report the tool and never send tool arguments", async () => {
	const handlers = loadInstance();
	const { ctx } = makeCtx();
	await startSession(handlers, ctx);

	await drive(handlers, "tool_execution_start", { type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: { path: "secret.ts" } }, ctx);
	assert.deepEqual(topics(), ["agent.tool.starting"]);
	const payload = payloadAt(0);
	assert.equal(payload.tool_name, "read");
	assert.equal("tool_input" in payload, false);
	assert.equal("args" in payload, false);
});

test("the user-input tool reports the tool without the question text", async () => {
	const handlers = loadInstance();
	const { ctx } = makeCtx();
	await startSession(handlers, ctx);

	await drive(
		handlers,
		"tool_execution_start",
		{ type: "tool_execution_start", toolCallId: "c2", toolName: "ask_user_question", args: { questions: [{ question: "which one?" }] } },
		ctx,
	);
	assert.deepEqual(topics(), ["agent.tool.starting"]);
	const payload = payloadAt(0);
	assert.equal(payload.tool_name, "ask_user_question");
	assert.equal("tool_input" in payload, false);
});

test("nested tool calls are not reported", async () => {
	const handlers = loadInstance();
	const { ctx } = makeCtx();
	await startSession(handlers, ctx);

	await drive(
		handlers,
		"tool_execution_start",
		{ type: "tool_execution_start", toolCallId: "c3", toolName: "read", parentToolCallId: "c0" },
		ctx,
	);
	assert.deepEqual(spawns, []);
});

test("a dialog reports waiting with its title, or a generic message", async () => {
	const handlers = loadInstance();
	const { ctx } = makeCtx();
	await startSession(handlers, ctx);

	await drive(handlers, "ui_prompt_start", { type: "ui_prompt_start", reason: "ui_prompt", kind: "confirm", title: "Allow?" }, ctx);
	assert.deepEqual(topics(), ["agent.notification"]);
	assert.equal(payloadAt(0).message, "Allow?");
	assert.equal("notification_type" in payloadAt(0), false);

	clearSpawns();
	const second = loadInstance();
	const { ctx: secondCtx } = makeCtx();
	await startSession(second, secondCtx);
	await drive(second, "ui_prompt_start", { type: "ui_prompt_start", reason: "ui_prompt", kind: "custom" }, secondCtx);
	assert.deepEqual(topics(), ["agent.notification"]);
	assert.equal(payloadAt(0).message, WAIT_MESSAGE_FALLBACK);
});

test("answering a dialog mid-run resumes working", async () => {
	const handlers = loadInstance();
	const { ctx } = makeCtx({ cwd: "C:\\work" });
	await startSession(handlers, ctx);
	await drive(handlers, "agent_start", { type: "agent_start" }, ctx);
	clearSpawns();

	await drive(handlers, "ui_prompt_start", { type: "ui_prompt_start", kind: "confirm", title: "Allow?" }, ctx);
	await drive(handlers, "ui_prompt_end", { type: "ui_prompt_end", kind: "confirm", title: "Allow?" }, ctx);

	assert.deepEqual(topics(), ["agent.notification", "agent.prompt.submit"]);
	assert.equal(payloadAt(1).cwd, "C:\\work");
});

test("a dialog opened while idle settles as idle, never working", async () => {
	const handlers = loadInstance();
	const { ctx } = makeCtx();
	await startSession(handlers, ctx);

	await drive(handlers, "ui_prompt_start", { type: "ui_prompt_start", kind: "select", title: "Pick" }, ctx);
	await drive(handlers, "ui_prompt_end", { type: "ui_prompt_end", kind: "select", title: "Pick" }, ctx);

	assert.deepEqual(topics(), ["agent.notification", "agent.stop"]);
	assert.equal("cwd" in payloadAt(1), false);
});

test("nested dialogs report attention once and only settle at depth zero", async () => {
	const handlers = loadInstance();
	const { ctx } = makeCtx();
	await startSession(handlers, ctx);
	await drive(handlers, "agent_start", { type: "agent_start" }, ctx);
	clearSpawns();

	await drive(handlers, "ui_prompt_start", { type: "ui_prompt_start", kind: "custom" }, ctx);
	await drive(handlers, "ui_prompt_start", { type: "ui_prompt_start", kind: "confirm", title: "Inner" }, ctx);
	assert.deepEqual(topics(), ["agent.notification"]);

	await drive(handlers, "ui_prompt_end", { type: "ui_prompt_end", kind: "confirm", title: "Inner" }, ctx);
	assert.deepEqual(topics(), ["agent.notification"]);

	await drive(handlers, "ui_prompt_end", { type: "ui_prompt_end", kind: "custom" }, ctx);
	assert.deepEqual(topics(), ["agent.notification", "agent.prompt.submit"]);
});

test("a turn that ends in a provider error reports agent.error with the message", async () => {
	const handlers = loadInstance();
	const { ctx } = makeCtx();
	await startSession(handlers, ctx);

	await drive(
		handlers,
		"turn_end",
		{ type: "turn_end", outcome: "error", message: { role: "assistant", stopReason: "error", errorMessage: "boom" } },
		ctx,
	);
	await drive(handlers, "agent_settled", { type: "agent_settled", aborted: false }, ctx);

	assert.deepEqual(topics(), ["agent.error"]);
	assert.equal(payloadAt(0).error, "boom");
});

test("a long provider error is truncated", async () => {
	const handlers = loadInstance();
	const { ctx } = makeCtx();
	await startSession(handlers, ctx);

	await drive(
		handlers,
		"turn_end",
		{ type: "turn_end", outcome: "error", message: { role: "assistant", errorMessage: "x".repeat(5000) } },
		ctx,
	);
	await drive(handlers, "agent_settled", { type: "agent_settled", aborted: false }, ctx);

	assert.equal(String(payloadAt(0).error).length, ERROR_MESSAGE_MAX);
});

test("aborted turns and tool failures settle as idle, never error", async () => {
	for (const event of [
		{ type: "turn_end", outcome: "aborted", message: { role: "assistant", stopReason: "aborted" } },
		{ type: "turn_end", outcome: "completed", message: { role: "assistant", stopReason: "toolUse" } },
	]) {
		clearSpawns();
		const handlers = loadInstance();
		const { ctx } = makeCtx();
		await startSession(handlers, ctx);

		await drive(handlers, "turn_end", event, ctx);
		await drive(handlers, "agent_settled", { type: "agent_settled", aborted: event.outcome === "aborted" }, ctx);

		assert.deepEqual(topics(), ["agent.stop"], `${event.outcome} must not report an error`);
	}

	// An aborted settlement with no turn_end at all is still a plain stop.
	clearSpawns();
	const handlers = loadInstance();
	const { ctx } = makeCtx();
	await startSession(handlers, ctx);
	await drive(handlers, "agent_settled", { type: "agent_settled", aborted: true }, ctx);
	assert.deepEqual(topics(), ["agent.stop"]);
});

test("an error is not re-reported by a settlement with no new turn", async () => {
	const handlers = loadInstance();
	const { ctx } = makeCtx();
	await startSession(handlers, ctx);

	await drive(handlers, "turn_end", { type: "turn_end", outcome: "error", message: { role: "assistant", errorMessage: "boom" } }, ctx);
	await drive(handlers, "agent_settled", { type: "agent_settled", aborted: false }, ctx);
	assert.deepEqual(topics(), ["agent.error"]);

	await drive(handlers, "agent_settled", { type: "agent_settled", aborted: false }, ctx);
	assert.deepEqual(topics(), ["agent.error", "agent.stop"]);
});

test("session end is reported for quit, new, resume, and fork, but never for reload", async () => {
	for (const reason of ["quit", "new", "resume", "fork"]) {
		clearSpawns();
		const handlers = loadInstance();
		const { ctx } = makeCtx({ sessionId: `sess-${reason}` });
		await startSession(handlers, ctx);

		await drive(handlers, "session_shutdown", { type: "session_shutdown", reason }, ctx);
		assert.deepEqual(topics(), ["agent.session.end"]);
		assert.equal(payloadAt(0).reason, reason);
		assert.equal(payloadAt(0).session_id, `sess-${reason}`);
	}

	clearSpawns();
	const reload = loadInstance();
	const { ctx: reloadCtx } = makeCtx();
	await startSession(reload, reloadCtx);
	await drive(reload, "session_shutdown", { type: "session_shutdown", reason: "reload" }, reloadCtx);
	assert.deepEqual(spawns, []);
});

test("session_shutdown never reads a stale ctx", async () => {
	const handlers = loadInstance();
	const { ctx } = makeCtx();
	await startSession(handlers, ctx);

	const { ctx: stale } = staleCtx();
	await drive(handlers, "session_shutdown", { type: "session_shutdown", reason: "quit" }, stale);
	assert.deepEqual(topics(), ["agent.session.end"]);
	assert.equal(payloadAt(0).session_id, "sess-1");
});

test("a missing bridge warns exactly once and then goes silent", async () => {
	wtcli.resetForTests();
	wtcli.setResolvedPathForTests(null);
	spawns = [];
	installSpawnOverride();

	const handlers = loadInstance();
	const { ctx, notifications } = makeCtx();
	await drive(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);
	await drive(handlers, "agent_start", { type: "agent_start" }, ctx);
	await drive(handlers, "session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);

	assert.deepEqual(spawns, []);
	assert.deepEqual(notifications, [[wtcli.BRIDGE_NOT_FOUND_MESSAGE, "warning"]]);
});

test("the first spawn failing with ENOENT warns once and latches off", async () => {
	wtcli.resetForTests();
	wtcli.setResolvedPathForTests("C:\\fake\\wtcli.exe");
	spawns = [];
	let first = true;
	wtcli.setSpawnOverride(((command: string, _args: readonly string[], options: any) => {
		const child = fakeChild();
		spawns.push({ command, args: [], options, child });
		if (first) {
			first = false;
			queueMicrotask(() => child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" })));
		} else {
			queueMicrotask(() => child.emit("close", 0));
		}
		return child;
	}) as any);

	const handlers = loadInstance();
	const { ctx, notifications } = makeCtx();
	await drive(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);
	await drive(handlers, "agent_start", { type: "agent_start" }, ctx);
	await drive(handlers, "session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);

	assert.equal(spawns.length, 1, "only the first event should reach the bridge");
	assert.deepEqual(notifications, [[wtcli.BRIDGE_NOT_FOUND_MESSAGE, "warning"]]);
});

test("emits are serialized and collapse to one pending event per topic", async () => {
	spawns = [];
	releaseMode = "manual";
	installSpawnOverride();

	const warn = () => {};
	// The first event starts a spawn immediately; the next two collapse into a
	// single pending entry for the same topic, keeping its queue position.
	wtcli.sendAgentHook("agent.tool.starting", { session_id: "s", tool_name: "read" }, warn);
	wtcli.sendAgentHook("agent.tool.starting", { session_id: "s", tool_name: "grep" }, warn);
	wtcli.sendAgentHook("agent.tool.starting", { session_id: "s", tool_name: "bash" }, warn);
	wtcli.sendAgentHook("agent.stop", { session_id: "s" }, warn);

	assert.equal(spawns.length, 1, "only one spawn may be in flight at a time");

	await settleQueue();

	assert.deepEqual(topics(), ["agent.tool.starting", "agent.tool.starting", "agent.stop"]);
	assert.equal(JSON.parse(spawns[0].child.stdin.written[0]).tool_name, "read");
	assert.equal(
		JSON.parse(spawns[1].child.stdin.written[0]).tool_name,
		"bash",
		"the newest payload for a pending topic wins",
	);
});

test("the queue drops the oldest pending topic when it overflows", async () => {
	spawns = [];
	releaseMode = "manual";
	installSpawnOverride();

	const warn = () => {};
	for (let i = 1; i <= wtcli.MAX_PENDING_EVENTS + 2; i++) {
		wtcli.sendAgentHook(`topic.${i}`, { i }, warn);
	}

	await settleQueue();

	const seen = topics();
	assert.equal(seen[0], "topic.1", "the in-flight topic is never dropped");
	assert.equal(seen.includes("topic.2"), false, "the oldest pending topic is the one dropped");
	assert.equal(seen.length, wtcli.MAX_PENDING_EVENTS + 1);
});

test("no unsupported topic is ever emitted", async () => {
	const handlers = loadInstance();
	const { ctx } = makeCtx();
	await startSession(handlers, ctx);

	// Drive every event a supportable mapping could plausibly hang off, but
	// only those the extension actually subscribes to.
	const events: Array<[string, any]> = [
		["agent_start", { type: "agent_start" }],
		["tool_execution_start", { type: "tool_execution_start", toolCallId: "c1", toolName: "bash" }],
		["tool_execution_end", { type: "tool_execution_end", toolCallId: "c1", toolName: "bash", isError: true }],
		["turn_end", { type: "turn_end", outcome: "completed", message: { role: "assistant" } }],
		["agent_settled", { type: "agent_settled", aborted: false }],
	];
	for (const [name, event] of events) {
		if (handlers[name]) await drive(handlers, name, event, ctx);
	}

	assert.equal(
		handlers.tool_result === undefined,
		true,
		"per-tool errors are deliberately not reported, so tool_result must not be subscribed",
	);

	const emitted = topics();
	assert.equal(emitted.length > 0, true);
	for (const topic of emitted) {
		assert.equal(
			["agent.tool.completed", "agent.tool.finished", "agent.cwd.changed"].includes(topic),
			false,
			`${topic} is a no-op for a non-Copilot source and must not be emitted`,
		);
	}
});
