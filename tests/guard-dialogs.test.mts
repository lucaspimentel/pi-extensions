// Dialog gate tests for the guard extension: the public DialogGate API
// (extensions/guard/dialogs.ts) plus registration-level coverage through the
// real guard factory (extensions/guard/index.ts). Pi's TUI keeps at most one
// extension selector alive; a second concurrent ctx.ui.select orphans the
// first, whose promise never settles. All four guard dialog kinds (execution
// approval, read grant, profile picker, migrate confirmation) must serialize
// through one factory-scoped gate, cancel promptly when their owning
// operation aborts, and invalidate on policy and lifecycle boundaries.
// Run: node --test tests/guard-dialogs.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { DialogGate } from "../extensions/guard/dialogs.ts";
import { projectConfigPath } from "../extensions/guard/policy/config.ts";
import { detectSandboxMode } from "../extensions/guard/sandbox/detect.ts";
import guardExtension from "../extensions/guard/index.ts";

const sandboxMode = detectSandboxMode().mode;

// ── Shared harness scaffolding (mirrors tests/guard-harness.test.mts) ────────

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
	tools: Array<{ name: string }>;
	registeredTools: Map<string, { execute: (...args: any[]) => Promise<any> }>;
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
		registerTool: (tool: { name: string; execute: (...args: any[]) => Promise<any> }) => h.registeredTools.set(tool.name, tool),
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
				for (const listener of h.eventListeners[channel] ?? []) listener(data);
			},
		},
	};
	(guardExtension as (api: unknown) => void)(api);
	harnesses.push(h);
	return h;
}

/** A selector boundary that records open/close, supports { signal }, and
 * detects overlapping selectors (the TUI keeps only one alive). */
interface SelectorControl {
	select: (title: string, options: string[], opts?: { signal?: AbortSignal }) => Promise<string | undefined>;
	opened: string[];
	currentlyOpen(): number;
	maxConcurrent(): number;
	/** Resolves once at least `count` selectors have opened (immediately if already past). */
	waitFor(count: number): Promise<void>;
	answer(choice: string | undefined): void;
}

function makeSelector(): SelectorControl {
	const waiters: Array<{ count: number; resolve: () => void }> = [];
	const ctrl = {
		select: undefined as unknown as SelectorControl["select"],
		opened: [] as string[],
		open: 0,
		max: 0,
		currentlyOpen: () => 0,
		maxConcurrent: () => 0,
		waitFor: (_count: number) => Promise.resolve(),
		answer: (_choice: string | undefined) => {},
	};
	const notifyWaiters = (): void => {
		for (const waiter of [...waiters]) {
			if (ctrl.opened.length < waiter.count) continue;
			waiters.splice(waiters.indexOf(waiter), 1);
			waiter.resolve();
		}
	};
	let settle!: (value: string | undefined) => void;
	let settlePromise: Promise<string | undefined> | null = null;
	ctrl.select = (title, _options, opts) => {
		ctrl.opened.push(title);
		ctrl.open++;
		ctrl.max = Math.max(ctrl.max, ctrl.open);
		notifyWaiters();
		const signal = opts?.signal;
		if (signal?.aborted) { ctrl.open--; return Promise.resolve(undefined); }
		settlePromise = new Promise<string | undefined>((resolve) => {
			settle = (value) => { ctrl.open--; resolve(value); };
			signal?.addEventListener("abort", () => { ctrl.open--; resolve(undefined); }, { once: true });
		});
		return settlePromise;
	};
	ctrl.currentlyOpen = () => ctrl.open;
	ctrl.maxConcurrent = () => ctrl.max;
	ctrl.waitFor = (count) => new Promise<void>((resolve) => {
		if (ctrl.opened.length >= count) resolve();
		else waiters.push({ count, resolve });
	});
	ctrl.answer = (choice) => {
		if (!settlePromise) throw new Error("no selector is open");
		settlePromise = null;
		settle(choice);
	};
	return ctrl;
}

/** Attach a select recorder to a context and return its control handle. */
function installSelector(ctx: Record<string, any>): SelectorControl {
	const selector = makeSelector();
	(ctx.ui as Record<string, unknown>).select = selector.select;
	return selector;
}

function harnessCtx(h: Harness, cwd: string): Record<string, any> {
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
			select: async () => undefined,
			theme: { fg: (_role: string, s: string) => s },
		},
	};
}

async function withTempHome<T>(fn: () => Promise<T> | T): Promise<T> {
	const realHome = process.env.HOME;
	const home = makeTempDir("guard-dialogs-home-");
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

async function startSession(h: Harness, ctx: Record<string, any>): Promise<void> {
	for (const handler of h.handlers.session_start ?? []) await handler({}, ctx);
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** An ask rule keeps host_bash prompting on every call with this command. */
function writeAskRule(cwd: string, command: string): void {
	fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
	fs.writeFileSync(projectConfigPath(cwd), JSON.stringify({ hostBash: { ask: [`HostBash(${command})`] } }), "utf8");
}

// ── Public gate tests ────────────────────────────────────────────────────────

test("gate: FIFO serialization preserves order and propagates values and errors without poisoning", async () => {
	const gate = new DialogGate();
	const order: string[] = [];
	let release1!: () => void;
	const block1 = new Promise<void>((resolve) => { release1 = resolve; });
	const p1 = gate.run({}, async () => { order.push("start1"); await block1; order.push("end1"); return "one"; });
	const p2 = gate.run({}, async () => { order.push("start2"); return "two"; });
	const p3 = gate.run({}, async () => { throw new Error("boom"); });
	const p4 = gate.run({}, async () => { order.push("start4"); return "four"; });
	await tick();
	assert.deepEqual(order, ["start1"], "only the first body runs while the first is pending");
	release1();
	assert.equal(await p1, "one");
	assert.equal(await p2, "two");
	await assert.rejects(p3, /boom/, "body rejection propagates to its caller");
	assert.equal(await p4, "four", "a rejected body must not poison later requests");
	assert.deepEqual(order, ["start1", "end1", "start2", "start4"]);

	// A synchronous throw from the body cannot wedge the chain either.
	await assert.rejects(gate.run({}, async () => { throw new Error("sync"); }), /sync/);
	assert.equal(await gate.run({}, async () => "after"), "after");
});

test("gate: an already-aborted signal rejects without running the body", async () => {
	const gate = new DialogGate();
	const controller = new AbortController();
	controller.abort();
	let ran = false;
	await assert.rejects(gate.run({ signal: controller.signal }, async () => { ran = true; return "x"; }), /abort|cancel/);
	assert.equal(ran, false, "the body never runs for a pre-aborted request");
	assert.equal(await gate.run({}, async () => "next"), "next", "the gate stays usable");
});

test("gate: an aborted queued request settles promptly and never runs", async () => {
	const gate = new DialogGate();
	let release1!: () => void;
	const block1 = new Promise<void>((resolve) => { release1 = resolve; });
	let started = false;
	const p1 = gate.run({}, async () => { await block1; });
	const controller = new AbortController();
	const p2 = gate.run({ signal: controller.signal }, async () => { started = true; return "two"; });
	await tick();
	assert.equal(started, false);
	controller.abort();
	await assert.rejects(p2, /abort|cancel/, "the queued caller settles without waiting for the open dialog");
	assert.equal(started, false, "the aborted queued body never runs");
	release1();
	await p1;
	assert.equal(await gate.run({}, async () => "later"), "later", "later requests still run in order");
});

test("gate: aborting an open dialog signals the body but the lease holds until the body settles", async () => {
	const gate = new DialogGate();
	let release1!: () => void;
	const block1 = new Promise<void>((resolve) => { release1 = resolve; });
	const controller = new AbortController();
	let seen: AbortSignal | undefined;
	const p1 = gate.run({ signal: controller.signal }, async (signal) => {
		seen = signal;
		await block1; // a body that ignores cancellation keeps the lease
		return "one";
	});
	await tick();
	controller.abort();
	assert.equal(seen?.aborted, true, "the private dialog signal is aborted");
	const p2 = gate.run({}, async () => "two");
	await tick();
	let secondStarted = false;
	void p2.then(() => { secondStarted = true; });
	await tick();
	assert.equal(secondStarted, false, "a cancellation-ignoring body must not let a second selector open");
	release1();
	await assert.rejects(p1, /abort|cancel/, "the answer arrived after cancellation: the caller gets the cancellation error");
	assert.equal(await p2, "two", "the next request starts only after the body actually settles");
});

test("gate: invalidation cancels queued requests promptly and aborts the open dialog", async () => {
	const gate = new DialogGate();
	let release1!: () => void;
	const block1 = new Promise<void>((resolve) => { release1 = resolve; });
	const controller = new AbortController();
	let seen: AbortSignal | undefined;
	const p1 = gate.run({ signal: controller.signal }, async (signal) => { seen = signal; await block1; return "one"; });
	const p2 = gate.run({}, async () => "two");
	await tick();
	gate.invalidate("policy transition");
	await assert.rejects(p2, /cancel.*policy transition/, "the queued request settles promptly");
	assert.equal(seen?.aborted, true, "the open dialog signal is aborted synchronously");
	assert.equal(controller.signal.aborted, false, "a caller-owned controller is never aborted");
	gate.invalidate("policy transition"); // repeated invalidation is safe
	release1();
	await assert.rejects(p1, /cancel.*policy transition/, "the obsolete open answer is rejected, not resolved");
	assert.equal(await gate.run({}, async () => "fresh"), "fresh", "fresh requests are accepted after invalidation");
});

test("gate: a body that resolves after cancellation hands its caller a cancellation error", async () => {
	const gate = new DialogGate();
	const controller = new AbortController();
	const p1 = gate.run({ signal: controller.signal }, async (signal) => {
		await tick();
		if (signal.aborted) return "stale answer";
		return "live answer";
	});
	controller.abort();
	await assert.rejects(p1, /abort|cancel/);
});

test("gate: a late caller abort cannot affect a newer dialog", async () => {
	const gate = new DialogGate();
	const first = new AbortController();
	let release1!: () => void;
	const block1 = new Promise<void>((resolve) => { release1 = resolve; });
	const p1 = gate.run({ signal: first.signal }, async () => { await block1; return "one"; });
	await tick();
	release1();
	await p1;
	// The first request settled; its listener must be gone.
	let release2!: () => void;
	const block2 = new Promise<void>((resolve) => { release2 = resolve; });
	let secondSignal: AbortSignal | undefined;
	const p2 = gate.run({}, async (signal) => { secondSignal = signal; await block2; return "two"; });
	await tick();
	first.abort();
	assert.equal(secondSignal?.aborted, false, "an old signal must not abort a newer dialog");
	release2();
	assert.equal(await p2, "two");
});

test("gate: invalidation never touches the caller-owned controller", async () => {
	const gate = new DialogGate();
	const listeners: Array<() => void> = [];
	const fake = {
		aborted: false,
		reason: undefined,
		addEventListener: (_name: string, listener: () => void) => { listeners.push(listener); },
		removeEventListener: (_name: string, listener: () => void) => { listeners.splice(listeners.indexOf(listener), 1); },
	} as unknown as AbortSignal;
	const p1 = gate.run({ signal: fake }, async () => "one");
	gate.invalidate("session replacement");
	await assert.rejects(p1, /cancel.*session replacement/);
	assert.equal(listeners.length, 0, "listeners are cleaned up");
	assert.equal((fake as { aborted?: boolean }).aborted, false, "the caller-owned controller was never aborted");
});

// ── Registration-level tests through the real guard factory ─────────────────

test("two approval prompts serialize: the second selector never replaces the first", async () => {
	await withTempHome(async () => {
		const h = makeHarness();
		const cwd = makeTempDir("guard-dialogs-approval-");
		writeAskRule(cwd, "echo asked");
		const ctx = harnessCtx(h, cwd);
		await startSession(h, ctx);
		const selector = installSelector(ctx);
		const tool = h.registeredTools.get("host_bash")!;
		const first = tool.execute("id", { command: "echo asked" }, undefined, undefined, ctx);
		void first.catch(() => {});
		await selector.waitFor(1);
		assert.match(selector.opened[0], /guard: host_bash/);
		const second = tool.execute("id", { command: "echo asked" }, undefined, undefined, ctx);
		void second.catch(() => {});
		await tick();
		await tick();
		assert.equal(selector.maxConcurrent(), 1, "a second selector must never open while the first is unresolved");
		assert.equal(selector.opened.length, 1, "the queued approval waits behind the open one");
		selector.answer("Allow once");
		const firstResult = await first;
		assert.equal(firstResult.structuredContent.exit_code, 0, "the approved call executes");
		await selector.waitFor(2);
		assert.equal(selector.opened.length, 2, "the queued approval opens only after the first settled");
		selector.answer("Deny");
		await assert.rejects(second, /denied/);
		const saved = JSON.parse(fs.readFileSync(projectConfigPath(cwd), "utf8")) as { hostBash?: { allow?: string[] } };
		assert.equal(saved.hostBash?.allow?.length ?? 0, 0, "approvals never save rules");
	});
});

test("aborting a queued approval settles it promptly while the open dialog continues", async () => {
	await withTempHome(async () => {
		const h = makeHarness();
		const cwd = makeTempDir("guard-dialogs-queued-abort-");
		writeAskRule(cwd, "echo asked");
		const ctx = harnessCtx(h, cwd);
		await startSession(h, ctx);
		const selector = installSelector(ctx);
		const tool = h.registeredTools.get("host_bash")!;
		const first = tool.execute("id", { command: "echo asked" }, undefined, undefined, ctx);
		void first.catch(() => {});
		await selector.waitFor(1);
		const abort = new AbortController();
		const second = tool.execute("id", { command: "echo asked" }, abort.signal, undefined, ctx);
		void second.catch(() => {});
		await tick();
		assert.equal(selector.opened.length, 1);
		abort.abort();
		await assert.rejects(second, /abort|cancel/, "the queued caller settles without user interaction");
		assert.equal(selector.opened.length, 1, "the aborted request never opened a selector");
		assert.equal(selector.currentlyOpen(), 1, "the open dialog is unaffected");
		selector.answer("Allow once");
		const result = await first;
		assert.equal(result.structuredContent.exit_code, 0, "the open approval still completes");
	});
});

test("a policy transition cancels the open approval automatically; a fresh approval still works", async () => {
	await withTempHome(async () => {
		const h = makeHarness();
		const cwd = makeTempDir("guard-dialogs-transition-");
		writeAskRule(cwd, "echo asked");
		const ctx = harnessCtx(h, cwd);
		await startSession(h, ctx);
		const selector = installSelector(ctx);
		const tool = h.registeredTools.get("host_bash")!;
		const pending = tool.execute("id", { command: "echo asked" }, undefined, undefined, ctx);
		void pending.catch(() => {});
		await selector.waitFor(1);
		await h.commandHandlers.get("guard")!("profile research", ctx);
		await assert.rejects(pending, /expired|cancel/, "cancellation settles without a manual answer");
		assert.equal(selector.currentlyOpen(), 0, "the selector closed through its abort signal");
		const afterCancel = JSON.parse(fs.readFileSync(projectConfigPath(cwd), "utf8")) as { hostBash?: { allow?: string[] } };
		assert.equal(afterCancel.hostBash?.allow?.length ?? 0, 0, "nothing was saved");
		await h.commandHandlers.get("guard")!("profile default", ctx);
		const fresh = tool.execute("id", { command: "echo asked" }, undefined, undefined, ctx);
		void fresh.catch(() => {});
		await selector.waitFor(2);
		selector.answer("Allow once");
		const result = await fresh;
		assert.equal(result.structuredContent.exit_code, 0, "a fresh request is accepted after the transition");
	});
});

test("command dialogs queue behind a permission prompt and never replace it", async () => {
	await withTempHome(async () => {
		const h = makeHarness();
		const cwd = makeTempDir("guard-dialogs-cross-kind-");
		writeAskRule(cwd, "echo asked");
		const ctx = harnessCtx(h, cwd);
		await startSession(h, ctx);
		const selector = installSelector(ctx);
		const approval = h.registeredTools.get("host_bash")!.execute("id", { command: "echo asked" }, undefined, undefined, ctx);
		void approval.catch(() => {});
		await selector.waitFor(1);
		const picker = h.commandHandlers.get("guard")!("profile", ctx);
		const migrate = h.commandHandlers.get("guard")!("migrate", ctx);
		await tick();
		await tick();
		assert.equal(selector.maxConcurrent(), 1, "the profile picker and migration confirmation must not replace the permission prompt");
		assert.equal(selector.opened.length, 1);
		selector.answer("Allow once");
		await approval;
		await selector.waitFor(2);
		assert.match(selector.opened[1], /Guard profile/, "the picker opens only after the approval settled");
		selector.answer("auto");
		await picker;
		await migrate;
		assert.ok(h.notifications.some((n) => /migration expired/.test(n)), "the queued migration was invalidated by the profile transition");
		assert.equal(selector.opened.length, 2, "the migration confirmation never opened");
	});
});

test("session replacement cancels the migration confirmation; a fresh confirmation writes", async () => {
	await withTempHome(async () => {
		const h = makeHarness();
		const cwd = makeTempDir("guard-dialogs-migrate-session-");
		fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
		fs.writeFileSync(path.join(cwd, ".pi", "pi-tool-permissions.local.json"), JSON.stringify({ allow: ["Bash(echo imported)"] }), "utf8");
		const ctx = harnessCtx(h, cwd);
		await startSession(h, ctx);
		const selector = installSelector(ctx);
		const migrate = h.commandHandlers.get("guard")!("migrate", ctx);
		await selector.waitFor(1);
		await h.handlers.session_tree[0]({}, ctx);
		await migrate;
		assert.ok(h.notifications.some((n) => /migration expired|cancelled/.test(n)));
		assert.equal(fs.existsSync(projectConfigPath(cwd)), false, "stale confirmation writes nothing");
		assert.equal(selector.currentlyOpen(), 0);
		// A fresh confirmation after the replacement is accepted.
		const fresh = h.commandHandlers.get("guard")!("migrate", ctx);
		await selector.waitFor(2);
		selector.answer("Write");
		await fresh;
		assert.equal(fs.existsSync(projectConfigPath(cwd)), true, "the fresh confirmation writes");
		const saved = JSON.parse(fs.readFileSync(projectConfigPath(cwd), "utf8")) as { hostBash?: { allow?: string[] } };
		assert.deepEqual(saved.hostBash?.allow, ["HostBash(echo imported)"]);
		// Re-running adds nothing (union with dedupe).
		h.notifications.length = 0;
		const again = h.commandHandlers.get("guard")!("migrate", ctx);
		await selector.waitFor(3);
		selector.answer("Write");
		await again;
		assert.ok(h.notifications.some((n) => /wrote 0 new entries/.test(n)), "migration stays idempotent");
	});
});

test("shutdown cancels an open approval; nothing is saved", async () => {
	await withTempHome(async () => {
		const h = makeHarness();
		const cwd = makeTempDir("guard-dialogs-shutdown-");
		writeAskRule(cwd, "echo asked");
		const ctx = harnessCtx(h, cwd);
		await startSession(h, ctx);
		const selector = installSelector(ctx);
		const pending = h.registeredTools.get("host_bash")!.execute("id", { command: "echo asked" }, undefined, undefined, ctx);
		void pending.catch(() => {});
		await selector.waitFor(1);
		for (const shutdown of h.handlers.session_shutdown ?? []) await shutdown({}, ctx);
		await assert.rejects(pending, /expired|cancel/, "shutdown invalidation settles the dialog");
		assert.equal(selector.currentlyOpen(), 0);
		const afterShutdown = JSON.parse(fs.readFileSync(projectConfigPath(cwd), "utf8")) as { hostBash?: { allow?: string[] } };
		assert.equal(afterShutdown.hostBash?.allow?.length ?? 0, 0, "nothing was saved");
	});
});

test("a successful save completes and cancels other pending dialogs instead of itself", async () => {
	await withTempHome(async () => {
		const h = makeHarness();
		const cwd = makeTempDir("guard-dialogs-save-");
		const ctx = harnessCtx(h, cwd);
		await startSession(h, ctx);
		const selector = installSelector(ctx);
		const tool = h.registeredTools.get("host_bash")!;
		const saving = tool.execute("id", { command: "echo $GUARD_DIALOGS_UNSET" }, undefined, undefined, ctx);
		void saving.catch(() => {});
		await selector.waitFor(1);
		const other = tool.execute("id", { command: "echo $GUARD_DIALOGS_UNSET" }, undefined, undefined, ctx);
		void other.catch(() => {});
		await tick();
		selector.answer("Save for project");
		const result = await saving;
		assert.equal(result.structuredContent.exit_code, 0, "the saving call executes; its own transition did not cancel it");
		const saved = JSON.parse(fs.readFileSync(projectConfigPath(cwd), "utf8")) as { hostBash?: { allow?: string[] } };
		assert.equal(saved.hostBash?.allow?.length, 1, "the exact rule was saved");
		await assert.rejects(other, /expired|cancel/, "the resulting transition invalidated the other pending dialog");
		assert.equal(saved.hostBash?.allow?.length, 1, "the cancelled dialog added no rule of its own");
	});
});

test("allowed executor work proceeds while another call awaits a dialog", async () => {
	await withTempHome(async () => {
		const h = makeHarness();
		const cwd = makeTempDir("guard-dialogs-independent-");
		writeAskRule(cwd, "echo asked");
		const ctx = harnessCtx(h, cwd);
		await startSession(h, ctx);
		const selector = installSelector(ctx);
		const pending = h.registeredTools.get("host_bash")!.execute("id", { command: "echo asked" }, undefined, undefined, ctx);
		void pending.catch(() => {});
		await selector.waitFor(1);
		const allowed = await h.registeredTools.get("bash")!.execute("id", { command: "echo ok" }, undefined, undefined, ctx);
		assert.match(String(allowed.structuredContent.output), /ok/, "allowed work does not wait for the pending dialog");
		selector.answer("Deny");
		await assert.rejects(pending, /denied/);
	});
});

test("headless contexts never open selectors", async () => {
	await withTempHome(async () => {
		const h = makeHarness();
		const cwd = makeTempDir("guard-dialogs-headless-");
		writeAskRule(cwd, "echo asked");
		const ctx = harnessCtx(h, cwd);
		ctx.hasUI = false;
		await startSession(h, ctx);
		const selector = installSelector(ctx);
		await assert.rejects(h.registeredTools.get("host_bash")!.execute("id", { command: "echo asked" }, undefined, undefined, ctx), /headless|non-interactive/);
		fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
		fs.writeFileSync(path.join(cwd, ".pi", "pi-tool-permissions.local.json"), JSON.stringify({ allow: ["Bash(echo imported)"] }), "utf8");
		await h.commandHandlers.get("guard")!("migrate", ctx);
		assert.equal(selector.opened.length, 0, "no selector was opened in a headless context");
		assert.ok(h.notifications.some((n) => /no UI: behaving like dry/.test(n)));
	});
});

test("a real worker read grant serializes with approval prompts and never replays code", { skip: sandboxMode === "degraded" ? "sandbox is degraded; workers are unavailable" : false }, async () => {
	// Created under the real home before the HOME override: the worker sandbox
	// resolves mounts from the real home, and a /tmp fixture would be invisible.
	const external = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), ".guard-dialogs-read-grant-")));
	tempDirs.push(external);
	const target = path.join(external, "data.txt");
	fs.writeFileSync(target, "granted-read");
	await withTempHome(async () => {
		const h = makeHarness();
		const cwd = makeTempDir("guard-dialogs-grant-");
		writeAskRule(cwd, "echo asked");
		const ctx = harnessCtx(h, cwd);
		await startSession(h, ctx);
		const selector = installSelector(ctx);
		const code = `open(${JSON.stringify(target)}).read()`;
		const worker = h.registeredTools.get("python")!.execute("id", { code }, undefined, undefined, ctx);
		void worker.catch(() => {});
		await selector.waitFor(1);
		assert.match(selector.opened[0], /read-only access/, "the read-grant prompt opens");
		const approval = h.registeredTools.get("host_bash")!.execute("id", { command: "echo asked" }, undefined, undefined, ctx);
		void approval.catch(() => {});
		await tick();
		await tick();
		assert.equal(selector.maxConcurrent(), 1, "the approval prompt must not replace the read-grant prompt");
		selector.answer("Grant for session");
		const result = await worker;
		assert.equal(result.structuredContent.status, "permission_needed");
		assert.equal(result.structuredContent.stateLost, true, "the grant reports worker state loss");
		assert.match(result.structuredContent.diagnostic, /not replayed/, "code is never replayed");
		await assert.rejects(approval, /expired|cancel/, "the grant transition invalidated the queued approval");
		// A fresh approval after the grant is accepted.
		const fresh = h.registeredTools.get("host_bash")!.execute("id", { command: "echo asked" }, undefined, undefined, ctx);
		void fresh.catch(() => {});
		await selector.waitFor(2);
		assert.match(selector.opened[1], /guard: host_bash/, "a fresh approval opens after the grant settled");
		selector.answer("Allow once");
		const approvalResult = await fresh;
		assert.equal(approvalResult.structuredContent.exit_code, 0);
	});
});
