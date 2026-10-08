// Dialog gate tests for the guard extension: the public DialogGate API
// (extensions/guard/dialogs.ts) plus registration-level coverage through the
// real guard factory (extensions/guard/index.ts). Pi's TUI keeps at most one
// extension selector alive; a second concurrent ctx.ui.select orphans the
// first, whose promise never settles. All four guard dialog kinds (execution
// approval, read grant, profile picker, migrate confirmation) must serialize
// through one factory-scoped gate, cancel promptly when their owning
// operation aborts, and invalidate on policy and lifecycle boundaries.
// Run: node --test tests/guard-dialogs.test.mts
import { after, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { DialogGate } from "../extensions/guard/dialogs.ts";
import { GuardRuntime } from "../extensions/guard/runtime.ts";
import { projectConfigPath } from "../extensions/guard/policy/config.ts";
import { detectSandboxMode } from "../extensions/guard/sandbox/detect.ts";
import guardExtension from "../extensions/guard/index.ts";
import { drainTempDirs, makeTempDir, tempDirs } from "./guard-test-temp.mts";

const sandboxMode = detectSandboxMode().mode;

// Suite-wide fixture drain: every tracked directory is deleted once all tests
// have finished, including after a failed test, so a passing run no longer
// hides leaked fixtures behind an outer runner's cleanup.
after(() => drainTempDirs());

// ── Shared harness scaffolding (mirrors tests/guard-harness.test.mts) ────────

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

function makeSelector(log?: string[]): SelectorControl {
	const waiters: Array<{ count: number; resolve: () => void }> = [];
	// Settlement handle for the currently open selector; null once settled.
	let settle: ((value: string | undefined) => void) | null = null;
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
	ctrl.select = (title, _options, opts) => {
		log?.push("open");
		ctrl.opened.push(title);
		ctrl.open++;
		ctrl.max = Math.max(ctrl.max, ctrl.open);
		notifyWaiters();
		const signal = opts?.signal;
		if (signal?.aborted) { ctrl.open--; log?.push("close"); return Promise.resolve(undefined); }
		return new Promise<string | undefined>((resolve) => {
			let settled = false;
			const finish = (value: string | undefined): void => {
				if (settled) return; // abort and answer are idempotent
				settled = true;
				settle = null; // a stale answer callback cannot settle again
				signal?.removeEventListener("abort", onAbort);
				ctrl.open--;
				log?.push("close");
				resolve(value);
			};
			const onAbort = (): void => finish(undefined);
			signal?.addEventListener("abort", onAbort, { once: true });
			settle = finish;
		});
	};
	ctrl.currentlyOpen = () => ctrl.open;
	ctrl.maxConcurrent = () => ctrl.max;
	ctrl.waitFor = (count) => new Promise<void>((resolve) => {
		if (ctrl.opened.length >= count) resolve();
		else waiters.push({ count, resolve });
	});
	ctrl.answer = (choice) => {
		if (!settle) throw new Error("no selector is open");
		settle(choice);
	};
	return ctrl;
}

/** Attach a select recorder and a setWorkingVisible recorder to a context.
 * When `log` is given, visibility toggles and selector open/close events are
 * interleaved in one ordered timeline for spinner-contract assertions. */
function installSelector(ctx: Record<string, any>, log?: string[]): SelectorControl {
	const selector = makeSelector(log);
	(ctx.ui as Record<string, unknown>).select = selector.select;
	(ctx.ui as Record<string, unknown>).setWorkingVisible = (visible: boolean) => { log?.push(visible ? "visible:true" : "visible:false"); };
	// Guard must never touch spinner configuration, only visibility.
	(ctx.ui as Record<string, unknown>).setWorkingMessage = () => { log?.push("working-message"); };
	(ctx.ui as Record<string, unknown>).setWorkingIndicator = () => { log?.push("working-indicator"); };
	return selector;
}

/** Replace the visibility stub with one that records every call and throws
 * for the directions in `fail`, so best-effort handling can be asserted. */
function failVisibility(ctx: Record<string, any>, calls: string[], fail: { hide?: boolean; restore?: boolean }): void {
	(ctx.ui as Record<string, unknown>).setWorkingVisible = (visible: boolean) => {
		calls.push(visible ? "restore" : "hide");
		if (visible ? fail.restore : fail.hide) throw new Error("visibility render failed");
	};
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

// ── Command ownership: cancellation through final commit ─────────────────────
// The profile picker and the migrate confirmation capture the initiating
// command operation's ctx.signal once (a live SDK getter) and honour it
// through the final synchronous commit: a cancelled command must not apply a
// profile or write migration configuration, even when cancellation lands
// while worker teardown is pending. Expected cancellation is a warning notice
// and a normal return, never an unhandled rejection.

/** Settable ctx.signal stand-in mirroring the SDK's live getter: reads can
 * return different values over time, so a command must capture it once. */
function signalSource(ctx: Record<string, any>, initial?: AbortSignal): { current: AbortSignal | undefined } {
	const ref: { current: AbortSignal | undefined } = { current: initial };
	Object.defineProperty(ctx, "signal", {
		configurable: true,
		get: () => ref.current,
		set: (value: AbortSignal | undefined) => { ref.current = value; },
	});
	return ref;
}

/** Legacy project and user configs whose entries would actually be imported.
 * Must run while the temporary HOME override is active. */
function writeLegacyFixtures(cwd: string): void {
	fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
	fs.writeFileSync(path.join(cwd, ".pi", "pi-tool-permissions.local.json"), JSON.stringify({ allow: ["Bash(echo imported)"] }), "utf8");
	fs.mkdirSync(path.join(process.env.HOME!, ".pi", "agent"), { recursive: true });
	fs.writeFileSync(path.join(process.env.HOME!, ".pi", "agent", "pi-tool-permissions.json"), JSON.stringify({ allow: ["Bash(echo home-imported)"] }), "utf8");
}

/** Clean the fixture directories created by one test (including its temporary
 * HOME) as soon as it ends; the suite-wide drainTempDirs after-hook is the
 * final safety net for everything else, such as the read-grant fixture. */
function cleanupNewFixtures(t: TestContext): void {
	const start = tempDirs.length;
	t.after(() => {
		for (const dir of tempDirs.splice(start)) fs.rmSync(dir, { recursive: true, force: true });
	});
}

/** withTempHome plus per-test cleanup of the fixture directories the test
 * body and the temporary HOME itself create. */
function withCleanTempHome(t: TestContext, fn: () => Promise<void>): Promise<void> {
	cleanupNewFixtures(t);
	return withTempHome(fn);
}

/** Byte snapshot of the two guard.json scopes: absent stays absent and
 * existing files must remain byte-for-byte unchanged. */
function snapshotScopes(cwd: string): { user: string | null; project: string | null } {
	const read = (p: string): string | null => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null);
	return {
		user: read(path.join(process.env.HOME!, ".pi", "agent", "guard.json")),
		project: read(projectConfigPath(cwd)),
	};
}

/** One harness with a started session; for migrate, legacy fixtures whose
 * entries would actually be imported in both scopes, plus a scope snapshot
 * taken before the command runs. */
async function commandHarness(kind: "profile" | "migrate", prepare?: (cwd: string) => void): Promise<{ h: Harness; cwd: string; ctx: Record<string, any>; before: { user: string | null; project: string | null } | null }> {
	const h = makeHarness();
	const cwd = makeTempDir(`guard-dialogs-${kind}-owner-`);
	prepare?.(cwd);
	const ctx = harnessCtx(h, cwd);
	if (kind === "migrate") writeLegacyFixtures(cwd);
	await startSession(h, ctx);
	return { h, cwd, ctx, before: kind === "migrate" ? snapshotScopes(cwd) : null };
}

/** No success publication and no mutation of either configuration scope:
 * absent files remain absent, existing files remain byte-for-byte unchanged. */
function assertNoMutation(kind: "profile" | "migrate", h: Harness, cwd: string, before: { user: string | null; project: string | null } | null): void {
	assert.ok(!h.notifications.some((n) => kind === "profile" ? /Profile: /.test(n) : /migrate wrote/.test(n)), "no success publication");
	if (kind === "profile") {
		assert.doesNotMatch(h.status.get("guard") ?? "", /auto/, "the profile did not change");
	} else {
		const after = snapshotScopes(cwd);
		assert.equal(after.project, before!.project, "the project scope is byte-for-byte unchanged");
		assert.equal(after.user, before!.user, "the user scope is byte-for-byte unchanged");
	}
}

/** The requested change was applied and published. */
function assertMutationApplied(kind: "profile" | "migrate", h: Harness, cwd: string): void {
	if (kind === "profile") {
		assert.ok(h.notifications.some((n) => /Profile: auto/.test(n)), "the profile was applied");
	} else {
		const project = JSON.parse(fs.readFileSync(projectConfigPath(cwd), "utf8")) as { hostBash?: { allow?: string[] } };
		assert.deepEqual(project.hostBash?.allow, ["HostBash(echo imported)"], "the project scope was written");
		const user = JSON.parse(fs.readFileSync(path.join(process.env.HOME!, ".pi", "agent", "guard.json"), "utf8")) as { hostBash?: { allow?: string[] } };
		assert.deepEqual(user.hostBash?.allow, ["HostBash(echo home-imported)"], "the user scope was written");
	}
}

/** Test-only injection at guard's own public GuardRuntime.transition
 * boundary: wrap the original method, keep the real transition execution,
 * and restore the wrapper in finally. Never patches SDK internals. */
function wrapTransition(replace: (original: typeof GuardRuntime.prototype.transition) => typeof GuardRuntime.prototype.transition): () => void {
	const original = GuardRuntime.prototype.transition;
	(GuardRuntime.prototype as { transition: typeof original }).transition = replace(original);
	return () => { (GuardRuntime.prototype as { transition: typeof original }).transition = original; };
}

for (const kind of ["profile", "migrate"] as const) {
	const answer = kind === "profile" ? "auto" : "Write";
	const cancelled = kind === "profile" ? /profile selection cancelled/ : /migrate cancelled/;
	const handler = (h: Harness) => h.commandHandlers.get("guard")!;

	test(`a pre-aborted ${kind} command never opens its selector and never applies its change`, (t) => withCleanTempHome(t, async () => {
		const { h, cwd, ctx, before } = await commandHarness(kind);
		const owner = new AbortController();
		signalSource(ctx, owner.signal);
		owner.abort();
		const selector = installSelector(ctx);
		await handler(h)(kind, ctx);
		assert.equal(selector.opened.length, 0, "no selector was displayed");
		assert.ok(h.notifications.some((n) => cancelled.test(n)), "normal return with a cancellation notice");
		assertNoMutation(kind, h, cwd, before);
	}));

	test(`a queued ${kind} command aborts promptly behind an open approval and never displays its selector`, (t) => withCleanTempHome(t, async () => {
		const { h, cwd, ctx, before } = await commandHarness(kind, (c) => writeAskRule(c, "echo asked"));
		const log: string[] = [];
		const selector = installSelector(ctx, log);
		const approval = h.registeredTools.get("host_bash")!.execute("id", { command: "echo asked" }, undefined, undefined, ctx);
		void approval.catch(() => {});
		await selector.waitFor(1);
		const beforeCommand = log.length; // the approval's own hide is already recorded
		const owner = new AbortController();
		signalSource(ctx, owner.signal);
		const command = handler(h)(kind, ctx);
		await tick();
		await tick();
		assert.equal(selector.opened.length, 1, "the command's dialog stayed queued");
		owner.abort();
		await command;
		assert.ok(h.notifications.some((n) => cancelled.test(n)), "normal return with a cancellation notice");
		assert.equal(selector.opened.length, 1, "the queued selector was never displayed");
		assert.equal(selector.currentlyOpen(), 1, "the open approval is unaffected");
		assert.deepEqual(log.slice(beforeCommand), [], "queued cancellation never toggles visibility or opens a selector");
		selector.answer("Allow once");
		await approval;
		assertNoMutation(kind, h, cwd, before);
	}));

	test(`aborting an open ${kind} dialog settles the command normally with a cancellation notice`, (t) => withCleanTempHome(t, async () => {
		const { h, cwd, ctx, before } = await commandHarness(kind);
		const log: string[] = [];
		const selector = installSelector(ctx, log);
		const owner = new AbortController();
		signalSource(ctx, owner.signal);
		const command = handler(h)(kind, ctx);
		await selector.waitFor(1);
		assert.match(selector.opened[0], kind === "profile" ? /Guard profile/ : /migration/, "the dialog opened");
		assert.deepEqual(log, ["visible:false", "open"], "the spinner is hidden while the dialog is open");
		// Allowed executor work stays independent of the pending dialog.
		const allowed = await h.registeredTools.get("bash")!.execute("id", { command: "echo ok" }, undefined, undefined, ctx);
		assert.match(String(allowed.structuredContent.output), /ok/, "allowed executor work does not wait for the command dialog");
		owner.abort();
		await command;
		assert.ok(h.notifications.some((n) => cancelled.test(n)), "normal return with a cancellation notice");
		assert.equal(selector.currentlyOpen(), 0, "the selector closed through its private cancellation signal");
		assert.deepEqual(log, ["visible:false", "open", "close", "visible:true"], "spinner visibility was restored exactly once");
		assertNoMutation(kind, h, cwd, before);
	}));

	test(`a late ${kind} answer that ignores cancellation is never applied`, (t) => withCleanTempHome(t, async () => {
		const { h, cwd, ctx, before } = await commandHarness(kind);
		const log: string[] = [];
		installSelector(ctx, log);
		// A selector that deliberately ignores abort: it settles only when
		// answered, like a remote client that never observes cancellation.
		let lateAnswer!: (value: string | undefined) => void;
		(ctx.ui as Record<string, unknown>).select = (_title: string, _options: string[]) => new Promise<string | undefined>((resolve) => { lateAnswer = resolve; });
		const owner = new AbortController();
		signalSource(ctx, owner.signal);
		const command = handler(h)(kind, ctx);
		await tick();
		await tick();
		owner.abort();
		await tick();
		assert.deepEqual(log.filter((entry) => entry.startsWith("visible")), ["visible:false"], "the lease and hidden spinner are retained while the selector ignores cancellation");
		lateAnswer(answer);
		await command;
		assert.ok(h.notifications.some((n) => cancelled.test(n)), "the obsolete answer is not applied and the command returns normally");
		assert.deepEqual(log.filter((entry) => entry.startsWith("visible")), ["visible:false", "visible:true"], "visibility is restored once the ignoring selector actually settles");
		assertNoMutation(kind, h, cwd, before);
	}));

	test(`changing ctx.signal mid-flight cannot transfer ${kind} ownership`, (t) => withCleanTempHome(t, async () => {
		const { h, cwd, ctx, before } = await commandHarness(kind);
		const selector = installSelector(ctx);
		const first = new AbortController();
		const second = new AbortController();
		const ref = signalSource(ctx, first.signal);
		const command = handler(h)(kind, ctx);
		await selector.waitFor(1);
		ref.current = undefined;
		ref.current = second.signal;
		first.abort();
		await command;
		assert.ok(h.notifications.some((n) => cancelled.test(n)), "cancellation still follows the captured signal");
		assert.equal(second.signal.aborted, false, "the later operation's signal was never adopted or aborted");
		assertNoMutation(kind, h, cwd, before);
	}));

	test(`an initially undefined signal never binds a ${kind} command to a later operation`, (t) => withCleanTempHome(t, async () => {
		const { h, cwd, ctx } = await commandHarness(kind);
		const selector = installSelector(ctx);
		const later = new AbortController();
		const ref = signalSource(ctx, undefined);
		const command = handler(h)(kind, ctx);
		await selector.waitFor(1);
		ref.current = later.signal;
		later.abort();
		await tick();
		assert.equal(selector.currentlyOpen(), 1, "the dialog is not cancelled by a signal it never captured");
		selector.answer(answer);
		await command;
		assert.ok(!h.notifications.some((n) => cancelled.test(n)), "the command was never bound to the later signal");
		assertMutationApplied(kind, h, cwd);
	}));

	test(`cancelling a ${kind} command after its answer prevents the final commit while teardown is pending`, (t) => withCleanTempHome(t, async () => {
		const { h, cwd, ctx, before } = await commandHarness(kind);
		const log: string[] = [];
		const selector = installSelector(ctx, log);
		const owner = new AbortController();
		signalSource(ctx, owner.signal);
		// Abort the captured owner immediately before the original beforeCommit
		// callback runs, simulating cancellation that lands after selection and
		// inside pending teardown.
		const restore = wrapTransition((original) => function (this: GuardRuntime, policy, detection, commit, validate, options) {
			const wrapped = options?.beforeCommit ? { ...options, beforeCommit: () => { owner.abort(); return options.beforeCommit(); } } : options;
			return original.call(this, policy, detection, commit, validate, wrapped);
		});
		try {
			const command = handler(h)(kind, ctx);
			await selector.waitFor(1);
			assert.deepEqual(log, ["visible:false", "open"], "the dialog opened");
			selector.answer(answer);
			await command;
			assert.ok(h.notifications.some((n) => cancelled.test(n)), "expected cancellation is a notice, not an unhandled rejection");
			assert.equal(selector.currentlyOpen(), 0, "the selector closed before the final commit");
			assert.deepEqual(log, ["visible:false", "open", "close", "visible:true"], "spinner visibility was restored when the dialog settled");
			assertNoMutation(kind, h, cwd, before);
		} finally { restore(); }
		// A fresh command with its own fresh operation signal still succeeds.
		signalSource(ctx, new AbortController().signal);
		if (kind === "profile") {
			await handler(h)("profile auto", ctx);
			assert.ok(h.notifications.some((n) => /Profile: auto/.test(n)), "a fresh direct profile command succeeds");
		} else {
			const fresh = handler(h)("migrate", ctx);
			await selector.waitFor(2);
			selector.answer("Write");
			await fresh;
			assert.ok(h.notifications.some((n) => /migrate wrote 2 new entries/.test(n)), "a fresh migration still writes both scopes");
		}
	}));

	test(`aborting a ${kind} command at commit time does not undo the completed commit`, (t) => withCleanTempHome(t, async () => {
		const { h, cwd, ctx } = await commandHarness(kind);
		const selector = installSelector(ctx);
		const owner = new AbortController();
		signalSource(ctx, owner.signal);
		// Abort the owner inside the commit callback: after the writes and the
		// policy assignment, before the command settles.
		const restore = wrapTransition((original) => function (this: GuardRuntime, policy, detection, commit, validate, options) {
			const wrappedCommit = commit ? () => { commit(); owner.abort(); } : undefined;
			return original.call(this, policy, detection, wrappedCommit, validate, options);
		});
		try {
			const command = handler(h)(kind, ctx);
			await selector.waitFor(1);
			selector.answer(answer);
			await command;
			assertMutationApplied(kind, h, cwd);
		} finally { restore(); }
		// Aborting afterwards is inert: no rejection, no state change.
		owner.abort();
		await tick();
		assertMutationApplied(kind, h, cwd);
	}));

	test(`a settled ${kind} owner cannot cancel a fresh dialog`, (t) => withCleanTempHome(t, async () => {
		const { h, cwd, ctx } = await commandHarness(kind);
		const selector = installSelector(ctx);
		const stale = new AbortController();
		signalSource(ctx, stale.signal);
		const first = handler(h)(kind, ctx);
		await selector.waitFor(1);
		selector.answer(answer);
		await first;
		assertMutationApplied(kind, h, cwd);
		// A fresh command with a fresh owner must not be affected when the
		// settled first owner's signal aborts.
		const fresh = new AbortController();
		signalSource(ctx, fresh.signal);
		const second = handler(h)(kind, ctx);
		await selector.waitFor(2);
		stale.abort();
		await tick();
		assert.equal(selector.currentlyOpen(), 1, "the fresh dialog stays open");
		assert.equal(fresh.signal.aborted, false, "the fresh owner is unaffected");
		selector.answer(kind === "profile" ? "default" : "Write");
		await second;
		assert.ok(h.notifications.some((n) => /migrate wrote/.test(n)) || kind === "profile", "the fresh command completes");
		if (kind === "profile") assert.ok(h.notifications.some((n) => /Profile: default/.test(n)), "the fresh profile change applied");
	}));
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

test("an admitted approval hides the working spinner while its selector is open and restores it when it settles", async () => {
	await withTempHome(async () => {
		const h = makeHarness();
		const cwd = makeTempDir("guard-dialogs-spinner-");
		writeAskRule(cwd, "echo asked");
		const ctx = harnessCtx(h, cwd);
		await startSession(h, ctx);
		const log: string[] = [];
		const selector = installSelector(ctx, log);
		const pending = h.registeredTools.get("host_bash")!.execute("id", { command: "echo asked" }, undefined, undefined, ctx);
		void pending.catch(() => {});
		await selector.waitFor(1);
		assert.deepEqual(log, ["visible:false", "open"], "the spinner is hidden before the selector opens and stays hidden while it is pending");
		selector.answer("Allow once");
		const result = await pending;
		assert.equal(result.structuredContent.exit_code, 0, "the approved call executes");
		assert.deepEqual(log, ["visible:false", "open", "close", "visible:true"], "the spinner is restored exactly once when the selector settles");
	});
});

test("profile picker and migration confirmation each hide and restore the spinner in ordered pairs", async () => {
	await withTempHome(async () => {
		const h = makeHarness();
		const cwd = makeTempDir("guard-dialogs-spinner-commands-");
		fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
		fs.writeFileSync(path.join(cwd, ".pi", "pi-tool-permissions.local.json"), JSON.stringify({ allow: ["Bash(echo imported)"] }), "utf8");
		const ctx = harnessCtx(h, cwd);
		await startSession(h, ctx);
		const log: string[] = [];
		const selector = installSelector(ctx, log);
		const picker = h.commandHandlers.get("guard")!("profile", ctx);
		await selector.waitFor(1);
		assert.deepEqual(log, ["visible:false", "open"], "the picker hides the spinner before opening");
		selector.answer("auto");
		await picker;
		assert.deepEqual(log, ["visible:false", "open", "close", "visible:true"], "the picker restores the spinner when it settles");
		const migrate = h.commandHandlers.get("guard")!("migrate", ctx);
		await selector.waitFor(2);
		selector.answer("Write");
		await migrate;
		assert.deepEqual(log, ["visible:false", "open", "close", "visible:true", "visible:false", "open", "close", "visible:true"], "consecutive admitted dialogs produce ordered hide/restore pairs with no late cleanup");
	});
});

test("aborting the execution signal of an open approval restores the spinner", async () => {
	await withTempHome(async () => {
		const h = makeHarness();
		const cwd = makeTempDir("guard-dialogs-spinner-abort-");
		writeAskRule(cwd, "echo asked");
		const ctx = harnessCtx(h, cwd);
		await startSession(h, ctx);
		const log: string[] = [];
		const selector = installSelector(ctx, log);
		const abort = new AbortController();
		const pending = h.registeredTools.get("host_bash")!.execute("id", { command: "echo asked" }, abort.signal, undefined, ctx);
		void pending.catch(() => {});
		await selector.waitFor(1);
		assert.deepEqual(log, ["visible:false", "open"]);
		abort.abort();
		await assert.rejects(pending, /abort|cancel/);
		assert.deepEqual(log, ["visible:false", "open", "close", "visible:true"], "cancellation through the execution signal restores visibility");
		const saved = JSON.parse(fs.readFileSync(projectConfigPath(cwd), "utf8")) as { hostBash?: { allow?: string[] } };
		assert.equal(saved.hostBash?.allow?.length ?? 0, 0, "cancellation saves nothing");
	});
});

test("a policy transition and shutdown restore the spinner when they settle an open approval", async () => {
	await withTempHome(async () => {
		const h = makeHarness();
		const cwd = makeTempDir("guard-dialogs-spinner-invalidate-");
		writeAskRule(cwd, "echo asked");
		const ctx = harnessCtx(h, cwd);
		await startSession(h, ctx);
		const log: string[] = [];
		const selector = installSelector(ctx, log);
		const pending = h.registeredTools.get("host_bash")!.execute("id", { command: "echo asked" }, undefined, undefined, ctx);
		void pending.catch(() => {});
		await selector.waitFor(1);
		await h.commandHandlers.get("guard")!("profile research", ctx);
		await assert.rejects(pending, /expired|cancel/, "the transition settles the dialog without a manual answer");
		assert.deepEqual(log, ["visible:false", "open", "close", "visible:true"], "policy invalidation restores visibility");
		await h.commandHandlers.get("guard")!("profile default", ctx);
		const fresh = h.registeredTools.get("host_bash")!.execute("id", { command: "echo asked" }, undefined, undefined, ctx);
		void fresh.catch(() => {});
		await selector.waitFor(2);
		for (const shutdown of h.handlers.session_shutdown ?? []) await shutdown({}, ctx);
		await assert.rejects(fresh, /expired|cancel/);
		assert.deepEqual(log, ["visible:false", "open", "close", "visible:true", "visible:false", "open", "close", "visible:true"], "shutdown restores visibility");
	});
});

test("stale and queued requests produce no visibility changes; queued cancellation never restores under an open selector", async () => {
	await withTempHome(async () => {
		const h = makeHarness();
		const cwd = makeTempDir("guard-dialogs-spinner-queue-");
		writeAskRule(cwd, "echo asked");
		const ctx = harnessCtx(h, cwd);
		await startSession(h, ctx);
		const log: string[] = [];
		const selector = installSelector(ctx, log);
		const tool = h.registeredTools.get("host_bash")!;
		const stale = new AbortController();
		stale.abort();
		await assert.rejects(tool.execute("id", { command: "echo asked" }, stale.signal, undefined, ctx), /aborted/);
		assert.deepEqual(log, [], "a stale request rejected before display never toggles visibility");
		const first = tool.execute("id", { command: "echo asked" }, undefined, undefined, ctx);
		void first.catch(() => {});
		await selector.waitFor(1);
		assert.deepEqual(log, ["visible:false", "open"]);
		const queuedCtl = new AbortController();
		const second = tool.execute("id", { command: "echo asked" }, queuedCtl.signal, undefined, ctx);
		void second.catch(() => {});
		await tick();
		await tick();
		assert.deepEqual(log, ["visible:false", "open"], "a queued request does not toggle visibility before admission");
		queuedCtl.abort();
		await assert.rejects(second, /abort|cancel/);
		assert.deepEqual(log, ["visible:false", "open"], "queued cancellation must not restore the spinner under the open selector");
		selector.answer("Allow once");
		await first;
		assert.deepEqual(log, ["visible:false", "open", "close", "visible:true"]);
	});
});

test("headless contexts and dry migration never toggle the spinner", async () => {
	await withTempHome(async () => {
		const h = makeHarness();
		const cwd = makeTempDir("guard-dialogs-spinner-headless-");
		writeAskRule(cwd, "echo asked");
		fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
		fs.writeFileSync(path.join(cwd, ".pi", "pi-tool-permissions.local.json"), JSON.stringify({ allow: ["Bash(echo imported)"] }), "utf8");
		const ctx = harnessCtx(h, cwd);
		ctx.hasUI = false;
		await startSession(h, ctx);
		const log: string[] = [];
		installSelector(ctx, log);
		await assert.rejects(h.registeredTools.get("host_bash")!.execute("id", { command: "echo asked" }, undefined, undefined, ctx), /headless|non-interactive/);
		await h.commandHandlers.get("guard")!("migrate", ctx);
		assert.deepEqual(log, [], "headless calls never toggle visibility");
		// A TUI dry run also never enqueues a dialog, so it never toggles.
		const h2 = makeHarness();
		const ctx2 = harnessCtx(h2, cwd);
		await startSession(h2, ctx2);
		const log2: string[] = [];
		installSelector(ctx2, log2);
		await h2.commandHandlers.get("guard")!("migrate dry", ctx2);
		assert.deepEqual(log2, [], "a dry migration never toggles visibility");
	});
});

test("RPC mode still opens the selector but never toggles spinner visibility", async () => {
	await withTempHome(async () => {
		const h = makeHarness();
		const cwd = makeTempDir("guard-dialogs-spinner-rpc-");
		writeAskRule(cwd, "echo asked");
		const ctx = harnessCtx(h, cwd);
		ctx.mode = "rpc";
		await startSession(h, ctx);
		const log: string[] = [];
		const selector = installSelector(ctx, log);
		const pending = h.registeredTools.get("host_bash")!.execute("id", { command: "echo asked" }, undefined, undefined, ctx);
		void pending.catch(() => {});
		await selector.waitFor(1);
		assert.deepEqual(log, ["open"], "RPC opens the selector without visibility toggles");
		selector.answer("Allow once");
		const result = await pending;
		assert.equal(result.structuredContent.exit_code, 0, "RPC approvals still work");
		assert.deepEqual(log, ["open", "close"]);
	});
});

test("a failed hide stays cosmetic: dismissal still denies and the gate stays usable", async () => {
	await withTempHome(async () => {
		const h = makeHarness();
		const cwd = makeTempDir("guard-dialogs-spinner-hide-fail-");
		writeAskRule(cwd, "echo asked");
		const ctx = harnessCtx(h, cwd);
		await startSession(h, ctx);
		const selector = installSelector(ctx);
		const calls: string[] = [];
		failVisibility(ctx, calls, { hide: true });
		const pending = h.registeredTools.get("host_bash")!.execute("id", { command: "echo asked" }, undefined, undefined, ctx);
		void pending.catch(() => {});
		await selector.waitFor(1);
		selector.answer(undefined); // dismissal
		await assert.rejects(pending, /denied/, "a dismissed approval still denies");
		assert.deepEqual(calls, ["hide", "restore"], "restoration is attempted even though hiding threw");
		const saved = JSON.parse(fs.readFileSync(projectConfigPath(cwd), "utf8")) as { hostBash?: { allow?: string[] } };
		assert.equal(saved.hostBash?.allow?.length ?? 0, 0, "denial saves nothing");
		const freshSelector = installSelector(ctx);
		const fresh = h.registeredTools.get("host_bash")!.execute("id", { command: "echo asked" }, undefined, undefined, ctx);
		void fresh.catch(() => {});
		await freshSelector.waitFor(1);
		freshSelector.answer("Allow once");
		const result = await fresh;
		assert.equal(result.structuredContent.exit_code, 0, "the gate remains usable after cosmetic failures");
	});
});

test("a failed restore stays cosmetic: acceptance still executes", async () => {
	await withTempHome(async () => {
		const h = makeHarness();
		const cwd = makeTempDir("guard-dialogs-spinner-restore-fail-");
		writeAskRule(cwd, "echo asked");
		const ctx = harnessCtx(h, cwd);
		await startSession(h, ctx);
		const selector = installSelector(ctx);
		const calls: string[] = [];
		failVisibility(ctx, calls, { restore: true });
		const pending = h.registeredTools.get("host_bash")!.execute("id", { command: "echo asked" }, undefined, undefined, ctx);
		void pending.catch(() => {});
		await selector.waitFor(1);
		selector.answer("Allow once");
		const result = await pending;
		assert.equal(result.structuredContent.exit_code, 0, "a visibility failure on restore never changes the outcome");
		assert.deepEqual(calls, ["hide", "restore"]);
	});
});

test("selector errors stay original when visibility also fails", async () => {
	await withTempHome(async () => {
		const h = makeHarness();
		const cwd = makeTempDir("guard-dialogs-spinner-error-fail-");
		writeAskRule(cwd, "echo asked");
		const ctx = harnessCtx(h, cwd);
		await startSession(h, ctx);
		installSelector(ctx);
		const calls: string[] = [];
		failVisibility(ctx, calls, { hide: true, restore: true });
		const tool = h.registeredTools.get("host_bash")!;
		(ctx.ui as Record<string, unknown>).select = () => Promise.reject(new Error("selector exploded"));
		const async = tool.execute("id", { command: "echo asked" }, undefined, undefined, ctx);
		void async.catch(() => {});
		await assert.rejects(async, /selector exploded/, "the original selector rejection is preserved");
		assert.deepEqual(calls, ["hide", "restore"]);
		calls.length = 0;
		(ctx.ui as Record<string, unknown>).select = () => { throw new Error("selector blew up synchronously"); };
		const sync = tool.execute("id", { command: "echo asked" }, undefined, undefined, ctx);
		void sync.catch(() => {});
		await assert.rejects(sync, /selector blew up synchronously/, "the original selector throw is preserved");
		assert.deepEqual(calls, ["hide", "restore"]);
	});
});

test("a failed visibility toggle around denial saves and executes nothing", async () => {
	await withTempHome(async () => {
		const h = makeHarness();
		const cwd = makeTempDir("guard-dialogs-spinner-deny-fail-");
		writeAskRule(cwd, "echo asked");
		const ctx = harnessCtx(h, cwd);
		await startSession(h, ctx);
		const selector = installSelector(ctx);
		const calls: string[] = [];
		failVisibility(ctx, calls, { hide: true, restore: true });
		const pending = h.registeredTools.get("host_bash")!.execute("id", { command: "echo asked" }, undefined, undefined, ctx);
		void pending.catch(() => {});
		await selector.waitFor(1);
		selector.answer("Deny");
		await assert.rejects(pending, /denied/);
		assert.deepEqual(calls, ["hide", "restore"], "restoration is still attempted around a denial");
		const saved = JSON.parse(fs.readFileSync(projectConfigPath(cwd), "utf8")) as { hostBash?: { allow?: string[] } };
		assert.equal(saved.hostBash?.allow?.length ?? 0, 0, "denial saves nothing");
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
		const log: string[] = [];
		const selector = installSelector(ctx, log);
		const code = `open(${JSON.stringify(target)}).read()`;
		const worker = h.registeredTools.get("python")!.execute("id", { code }, undefined, undefined, ctx);
		void worker.catch(() => {});
		await selector.waitFor(1);
		assert.match(selector.opened[0], /read-only access/, "the read-grant prompt opens");
		assert.deepEqual(log, ["visible:false", "open"], "the read grant hides the spinner before opening");
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
		assert.deepEqual(log, ["visible:false", "open", "close", "visible:true", "visible:false", "open", "close", "visible:true"], "the grant and the fresh approval each restore the spinner when they settle");
	});
});

// ── Fixture cleanup regression ────────────────────────────────────────────
// The suite must delete every directory it created, on success and after a
// failed test: drainTempDirs() removes exactly the tracked fixtures, and the
// root after-hook keeps that promise even when an assertion fails.

test("draining tracked fixtures deletes them and tolerates repeats", () => {
	const tracked = makeTempDir("guard-dialogs-drain-");
	// Adopted external in the style of the read-grant fixture, which is created
	// under a different root before the HOME override and still tracked.
	const adopted = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "guard-dialogs-drain-adopted-")));
	tempDirs.push(adopted);
	fs.writeFileSync(path.join(tracked, "marker"), "x");
	drainTempDirs();
	assert.equal(fs.existsSync(tracked), false, "makeTempDir fixtures are deleted");
	assert.equal(fs.existsSync(adopted), false, "adopted externals are deleted too");
	assert.equal(tempDirs.length, 0, "the registry is emptied");
	drainTempDirs(); // Repeating after an empty registry is a no-op.
});

test("a failed test still drains its tracked fixtures", () => {
	const fixture = makeTempDir("guard-dialogs-drain-child-");
	const marker = path.join(fixture, "leaked-dir.txt");
	const script = path.join(fixture, "leak-child.mts");
	const helper = JSON.stringify(pathToFileURL(path.join(import.meta.dirname, "guard-test-temp.mts")).href);
	fs.writeFileSync(script, [
		`import { after, test } from "node:test";`,
		`import assert from "node:assert/strict";`,
		`import * as fs from "node:fs";`,
		`import { makeTempDir, drainTempDirs } from ${helper};`,
		``,
		`fs.writeFileSync(process.argv[2], makeTempDir("guard-dialogs-child-leak-"));`,
		`after(() => drainTempDirs());`,
		``,
		`test("fails on purpose", () => {`,
		`\tassert.fail("expected failure: proves cleanup runs after a failed test");`,
		`});`,
		"",
	].join("\n"));
	const run = spawnSync(process.execPath, [script, marker], { encoding: "utf8", timeout: 30_000 });
	assert.equal(run.status, 1, "the child exits with the test-failure code");
	const leaked = fs.readFileSync(marker, "utf8").trim();
	assert.match(leaked, /guard-dialogs-child-leak-/);
	assert.equal(fs.existsSync(leaked), false, "the failed child still deleted its tracked fixtures");
});
