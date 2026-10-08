import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { ControllerOptions } from "../extensions/guard/tools/worker-launch.ts";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { GuardRuntime, validateReadGrant, type WorkerController } from "../extensions/guard/runtime.ts";
import { mergeConfig } from "../extensions/guard/policy/config.ts";
import type { PolicyState } from "../extensions/guard/policy/decision.ts";
import type { SandboxDetection } from "../extensions/guard/sandbox/detect.ts";

const detection: SandboxDetection = { mode: "full", bwrapPath: "/usr/bin/bwrap", launcherPath: "/test/launcher", fdPath: null, prlimitPath: null, scanner: null, diagnostics: [] };
function deferred<T = void>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}
function setup(t: TestContext, createWorker?: (kind: "python" | "node", options: ControllerOptions) => WorkerController) {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "guard-runtime-test-")));
	const policy: PolicyState = { cwd, config: mergeConfig({}, {}, cwd), sandboxMode: "full", workspaceLocked: false, profile: "default", interactive: true };
	const root = join(cwd, "runtime");
	const runtime = new GuardRuntime({ policy, detection, runtimeRoot: root, createWorker });
	t.after(async () => { await runtime.dispose().catch(() => {}); rmSync(cwd, { recursive: true, force: true }); });
	return { cwd, policy, runtime };
}
const allow = async () => true;
function fakeWorker(execute = async () => ({ status: "ok" }), dispose = async () => {}): WorkerController {
	return { execute, dispose, status: () => ({ workerRunning: true }), reset: async () => {} } as unknown as WorkerController;
}

test("permission dialogs never hold the execution queue and stale tokens do not run", async (t) => {
	const { runtime, policy } = setup(t);
	const dialog = deferred<boolean>();
	let ran = false;
	const waiting = runtime.run(async () => dialog.promise, async () => { ran = true; });
	await runtime.run(allow, async () => {});
	await runtime.transition({ ...policy, profile: "research" });
	dialog.resolve(true);
	await assert.rejects(waiting, /expired|changed/);
	assert.equal(ran, false);
});

test("queued calls revalidate when policy changes", async (t) => {
	const { runtime, policy } = setup(t);
	const started = deferred();
	const finish = deferred();
	const active = runtime.run(allow, async () => { started.resolve(); await finish.promise; });
	await started.promise;
	let ran = false;
	const waiting = runtime.run(allow, async () => { ran = true; });
	const denial = assert.rejects(waiting, /transition|expired/);
	const transition = runtime.transition({ ...policy, profile: "research" });
	finish.resolve();
	await active;
	await transition;
	await denial;
	assert.equal(ran, false);
});

test("tightening waits for actual teardown before publishing", async (t) => {
	const { runtime, policy } = setup(t);
	const started = deferred();
	const stopped = deferred();
	const exit = deferred();
	let published = false;
	const active = runtime.run(allow, async (ctx) => {
		ctx.setTeardown(async () => { stopped.resolve(); await exit.promise; });
		started.resolve();
		await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve(), { once: true }));
	});
	await started.promise;
	const transition = runtime.transition({ ...policy, profile: "research" }, detection, () => { published = true; });
	await stopped.promise;
	assert.equal(published, false);
	assert.equal(runtime.policy.profile, "default");
	exit.resolve();
	await active;
	await transition;
	assert.equal(published, true);
	assert.equal(runtime.policy.profile, "research");
});

test("persistence waits for teardown and cancels without saving if a later transition supersedes approval", async (t) => {
	const { runtime, policy } = setup(t);
	const started = deferred();
	const stopped = deferred();
	const exited = deferred();
	const active = runtime.run(allow, async (ctx) => {
		ctx.setTeardown(async () => { stopped.resolve(); await exited.promise; });
		started.resolve();
		await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve(), { once: true }));
	});
	await started.promise;
	let saved = false;
	const epoch = runtime.epoch;
	const saving = runtime.transition(policy, detection, undefined, undefined, { preempt: true, expectedEpoch: epoch, beforeCommit: () => { saved = true; } });
	void saving.catch(() => {});
	await stopped.promise;
	assert.equal(saved, false);
	const research = runtime.transition({ ...policy, profile: "research" });
	exited.resolve();
	await active;
	await assert.rejects(saving, /approval expired/);
	await research;
	assert.equal(saved, false);
	assert.equal(runtime.policy.profile, "research");
});

test("host-rule tightening preempts active host execution even when mounts are unchanged", async (t) => {
	const { runtime, policy } = setup(t);
	const started = deferred();
	const stopped = deferred();
	const active = runtime.run(allow, async (ctx) => {
		ctx.setTeardown(async () => { stopped.resolve(); });
		started.resolve();
		await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve(), { once: true }));
	});
	await started.promise;
	const tightened = runtime.transition({ ...policy, config: mergeConfig({ hostBash: { deny: ["HostBash(*)"] } }, {}, policy.cwd) });
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([stopped.promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("host execution was not preempted")), 200); })]);
	} finally { if (timer) clearTimeout(timer); }
	await active;
	await tightened;
});

test("known failed teardown is sticky and ack-like transitions cannot override it", async (t) => {
	const { runtime, policy } = setup(t);
	const started = deferred();
	const active = runtime.run(allow, async (ctx) => {
		ctx.setTeardown(async () => { throw new Error("kill failed"); });
		started.resolve();
		await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve(), { once: true }));
	});
	await started.promise;
	const rejectedActive = assert.rejects(active, /unresolved teardown/);
	await assert.rejects(runtime.transition({ ...policy, profile: "research" }), /unresolved teardown/);
	await rejectedActive;
	await assert.rejects(runtime.transition({ ...policy, workspaceLocked: false }), /unresolved teardown/);
	await assert.rejects(runtime.run(allow, async () => {}), /unresolved teardown/);
	assert.equal(existsSync(runtime.scratchDir), true);
});

test("sandboxed workers use overlays and preserve state for default/auto/trusted", async (t) => {
	const mounts: any[] = [];
	let disposals = 0;
	const { runtime, policy } = setup(t, (_kind: string, options: any) => { mounts.push(options); return fakeWorker(undefined, async () => { disposals++; }); });
	const execute = () => runtime.run(allow, (ctx) => runtime.worker("python", { code: "1" }, ctx));
	await execute();
	assert.equal(mounts[0].workspaceMode, "overlay");
	assert.equal(mounts[0].scratchDir, runtime.scratchDir);
	writeFileSync(join(runtime.scratchDir, "kept"), "x");
	await runtime.transition({ ...policy, profile: "auto" });
	await execute();
	await runtime.transition({ ...policy, profile: "trusted" });
	await execute();
	assert.equal(mounts.length, 1);
	assert.equal(disposals, 0);
	await runtime.transition({ ...policy, profile: "research" });
	await execute();
	assert.equal(disposals, 1);
	assert.equal(mounts.length, 2);
	assert.equal(existsSync(join(runtime.scratchDir, "kept")), true);
});

test("every worker execute refreshes mask mounts; reset/remount keep scratch", async (t) => {
	const mounts: any[] = [];
	let disposals = 0;
	const { runtime, cwd } = setup(t, (_kind: string, options: any) => { mounts.push(options); return fakeWorker(undefined, async () => { disposals++; }); });
	const execute = () => runtime.run(allow, (ctx) => runtime.worker("node", { code: "1" }, ctx));
	await execute();
	writeFileSync(join(cwd, ".env"), "masked");
	await execute();
	assert.equal(mounts.length, 2);
	assert.equal(disposals, 1);
	const scratch = runtime.scratchDir;
	await runtime.run(allow, (ctx) => runtime.worker("node", { action: "reset" }, ctx));
	assert.equal(existsSync(scratch), true);
	await execute();
	assert.equal(mounts.length, 3);
});

test("new protected entries between calls remount workers without quarantining authorized host changes", async (t) => {
	let disposals = 0;
	let starts = 0;
	const { runtime, cwd, policy } = setup(t, () => { starts++; return fakeWorker(undefined, async () => { disposals++; }); });
	await runtime.transition({ ...policy, config: mergeConfig({ protectedPaths: ["instructions"] }, {}, cwd) });
	const execute = () => runtime.run(allow, (ctx) => runtime.worker("python", { code: "1" }, ctx));
	await execute();
	writeFileSync(join(cwd, "instructions"), "new protected mount");
	await execute();
	assert.equal(disposals, 1);
	assert.equal(starts, 2);
	assert.equal(runtime.policy.workspaceLocked, false);
	assert.equal(existsSync(join(cwd, "instructions")), true);
});

test("worktree common-directory changes refresh protected mounts even without replacing .git", async (t) => {
	let disposals = 0;
	const { runtime, cwd } = setup(t, () => fakeWorker(undefined, async () => { disposals++; }));
	for (const name of ["common-a", "common-b"]) mkdirSync(join(cwd, name, "worktrees/w"), { recursive: true });
	writeFileSync(join(cwd, ".git"), `gitdir: ${join(cwd, "common-a/worktrees/w")}\n`);
	const execute = () => runtime.run(allow, (ctx) => runtime.worker("node", { code: "1" }, ctx));
	await execute();
	writeFileSync(join(cwd, ".git"), `gitdir: ${join(cwd, "common-b/worktrees/w")}\n`);
	await execute();
	assert.equal(disposals, 1);
	assert.equal(runtime.policy.workspaceLocked, false, "an unchanged protected inode is not an escaped host write");
});

test("an audit finding during ack-like remount keeps the lock despite successful teardown", async (t) => {
	let cwdForDispose = "";
	const { runtime, policy, cwd } = setup(t, () => fakeWorker(undefined, async () => { writeFileSync(join(cwdForDispose, "AGENTS.md"), "escaped at teardown"); }));
	cwdForDispose = cwd;
	await runtime.transition({ ...policy, workspaceLocked: true });
	await runtime.run(allow, (ctx) => runtime.worker("node", { code: "1" }, ctx));
	await runtime.transition({ ...policy, workspaceLocked: false });
	assert.equal(runtime.policy.workspaceLocked, true);
	assert.equal(existsSync(join(cwd, "AGENTS.md")), false);
});

test("known kill failure rejects the transition even if execution never settles", async (t) => {
	const { runtime, policy } = setup(t);
	const started = deferred();
	void runtime.run(allow, async (ctx) => {
		ctx.setTeardown(async () => { throw new Error("cannot kill active process"); });
		started.resolve();
		await new Promise<void>(() => {});
	}).catch(() => {});
	await started.promise;
	await assert.rejects(runtime.transition({ ...policy, profile: "research" }), /unresolved teardown/);
	await assert.rejects(runtime.run(allow, async () => {}), /unresolved teardown/);
	assert.equal(runtime.policy.profile, "default");
	assert.equal(existsSync(runtime.scratchDir), true);
});

test("workspace audits warn but preserve successful results and lock raw routes", async (t) => {
	const { runtime, cwd } = setup(t);
	const result = await runtime.run(allow, (ctx) => runtime.sandboxBoundary(async () => {
		mkdirSync(join(cwd, ".pi"));
		writeFileSync(join(cwd, ".pi", "injected"), "x");
		return 42;
	}, ctx.warnings));
	assert.equal(result.result, 42);
	assert.ok(result.warnings.length);
	assert.equal(runtime.policy.workspaceLocked, true);
	assert.equal(existsSync(join(cwd, ".pi")), false);
	assert.equal(existsSync(join(runtime.sessionDir, "quarantine")), true);
});

test("reduced workers are ro even though default bash is rw", async (t) => {
	const mounts: ControllerOptions[] = [];
	const { runtime, policy } = setup(t, (_kind, options) => { mounts.push(options); return fakeWorker(); });
	await runtime.transition({ ...policy, sandboxMode: "reduced" }, { ...detection, mode: "reduced", launcherPath: null });
	await runtime.run(allow, (ctx) => runtime.worker("python", { code: "1" }, ctx));
	assert.equal(mounts[0].workspaceMode, "ro");
});

test("degraded workers never become raw; lock forces ro even for raw profiles", async (t) => {
	const mounts: any[] = [];
	const { runtime, policy } = setup(t, (_kind: string, options: any) => { mounts.push(options); return fakeWorker(); });
	await runtime.transition({ ...policy, profile: "unrestricted", workspaceLocked: true });
	await runtime.run(allow, (ctx) => runtime.worker("node", { code: "1" }, ctx));
	assert.equal(mounts[0].workspaceMode, "ro");
	await runtime.transition({ ...policy, sandboxMode: "degraded" }, { ...detection, mode: "degraded" });
	await assert.rejects(runtime.run(allow, (ctx) => runtime.worker("python", { code: "1" }, ctx)), /unavailable/);
});

test("read grants reject hard exclusions and their covering directories", (t) => {
	const { cwd } = setup(t);
	const home = join(cwd, "home");
	mkdirSync(join(home, ".ssh"), { recursive: true });
	const readable = join(cwd, "readable");
	mkdirSync(readable);
	assert.throws(() => validateReadGrant(home, "/different-workspace", home), /hard-excluded/);
	assert.throws(() => validateReadGrant(join(home, ".ssh"), "/different-workspace", home), /hard-excluded/);
	assert.throws(() => validateReadGrant(readable, "/different-workspace", home), /reserved sandbox mount/);
	const external = realpathSync(mkdtempSync(join(homedir(), ".guard-grant-test-")));
	t.after(() => rmSync(external, { recursive: true, force: true }));
	assert.equal(validateReadGrant(external, "/different-workspace", home), external);
});

// ── Command cancellation through final commit ────────────────────────────────
// The profile picker and migrate confirmation capture the initiating command
// operation's signal and recheck it inside the runtime queue through a
// command-only beforeCommit guard: cancellation that lands while teardown is
// pending must prevent the commit, without touching genuine failure paths.

test("a command cancellation guard runs after teardown and before policy assignment", async (t) => {
	const { runtime, policy } = setup(t);
	const started = deferred();
	const stopped = deferred();
	const exited = deferred();
	const active = runtime.run(allow, async (ctx) => {
		ctx.setTeardown(async () => { stopped.resolve(); await exited.promise; });
		started.resolve();
		await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve(), { once: true }));
	});
	await started.promise;
	const owner = new AbortController();
	const cancelled = new Error("guard: command cancelled; nothing was changed.");
	let published = false;
	// Same shape guard's picker passes for picker-originated transitions:
	// expectedEpoch plus a command-only beforeCommit guard.
	const saving = runtime.transition({ ...policy, profile: "research" }, detection, () => { published = true; }, undefined, {
		expectedEpoch: runtime.epoch,
		beforeCommit: () => { if (owner.signal.aborted) throw cancelled; },
	});
	void saving.catch(() => {});
	await stopped.promise;
	owner.abort();
	exited.resolve();
	await active;
	const failure = await saving.catch((err: unknown) => err);
	assert.equal(failure, cancelled, "the owner's cancellation marker surfaces only after teardown finished");
	assert.equal(published, false, "the commit callback never ran");
	assert.equal(runtime.policy.profile, "default", "policy was never assigned");
	// Started teardown finished; the runtime is usable and nothing was resurrected.
	await runtime.run(allow, async () => {});
	assert.equal(runtime.policy.profile, "default");
});

test("a teardown failure stays sticky even when the command owner is cancelled", async (t) => {
	const { runtime, policy } = setup(t);
	const started = deferred();
	const active = runtime.run(allow, async (ctx) => {
		ctx.setTeardown(async () => { throw new Error("kill failed"); });
		started.resolve();
		await new Promise<void>(() => {});
	}).catch(() => {});
	await started.promise;
	const owner = new AbortController();
	const cancelled = new Error("guard: command cancelled; nothing was changed.");
	const saving = runtime.transition({ ...policy, profile: "research" }, detection, undefined, undefined, {
		expectedEpoch: runtime.epoch,
		beforeCommit: () => { if (owner.signal.aborted) throw cancelled; },
	});
	owner.abort();
	const failure = await saving.catch((err: unknown) => err);
	assert.notEqual(failure, cancelled, "cancellation must not swallow a genuine teardown failure");
	assert.match(String(failure), /unresolved teardown/, "the sticky teardown diagnostic is preserved");
	assert.equal(runtime.policy.profile, "default");
	assert.equal(existsSync(runtime.scratchDir), true);
	void active;
});

test("aborting the owner after a completed commit leaves the committed policy in place", async (t) => {
	const { runtime, policy } = setup(t);
	const owner = new AbortController();
	await runtime.transition({ ...policy, profile: "research" });
	owner.abort();
	assert.equal(runtime.policy.profile, "research", "the completed synchronous commit is not rolled back");
	// The runtime stays usable; no workers were resurrected.
	await runtime.run(allow, async () => {});
});
