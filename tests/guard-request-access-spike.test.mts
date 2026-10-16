// Spike test for the PR 2 groundwork: proves the read-grant primitives
// (GuardRuntime.transition, DialogGate, runReadGrantPrompt, validateReadGrant,
// readGrantSuggestion, validateReadRootSave, addToConfigScope) compose into a
// working read-grant interaction WITHOUT a python/node worker, as
// request_read_access will need. This is a test-local reproduction of the
// handleReadGrant body (extensions/guard/index.ts), not a test of the
// production closure or of a registered tool; that boundary is recorded in
// docs/guard-design.md. No production code is exercised beyond the exported
// primitives, and no bwrap process runs: the runtime gets an injected
// detection and a fake worker controller.
//
// Run: node --test tests/guard-request-access-spike.test.mts
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { GuardRuntime, validateReadGrant, validateReadRootSave, type WorkerController } from "../extensions/guard/runtime.ts";
import { readGrantSuggestion, addToConfigScope } from "../extensions/guard/policy/suggest.ts";
import { loadConfig, projectConfigPath, mergeConfig, type ResolvedGuardConfig } from "../extensions/guard/policy/config.ts";
import { parseReadRootInput } from "../extensions/guard/policy/save.ts";
import { DialogGate } from "../extensions/guard/dialogs.ts";
import { runReadGrantPrompt, type PromptFlowIO, type ReadFlowOutcome } from "../extensions/guard/prompt-flow.ts";
import type { PolicyState } from "../extensions/guard/policy/decision.ts";
import type { SandboxDetection } from "../extensions/guard/sandbox/detect.ts";

// ── Infrastructure ───────────────────────────────────────────────────────────

const detection: SandboxDetection = { mode: "full", bwrapPath: "/usr/bin/bwrap", launcherPath: "/test/launcher", fdPath: null, prlimitPath: null, scanner: null, diagnostics: [] };

function tempDir(prefix: string): string {
	return realpathSync(mkdtempSync(path.join(prefix.startsWith("/") || prefix.includes(os.homedir()) ? prefix : path.join(os.tmpdir(), prefix))));
}

/** External grantable directory: under the real home, never under /tmp
 * (reserved sandbox mount) and never matching a sensitive host path. */
function externalDir(): string {
	return tempDir(path.join(os.homedir(), ".guard-spike-"));
}

interface Spike {
	runtime: GuardRuntime;
	cwd: string;
	external: string;
	sessionRoots: string[];
	gate: DialogGate;
	workerDisposals: string[];
	workerExecuteCalls: number;
	cleanup: () => void;
}

function setup(): Spike {
	const cwd = tempDir("guard-spike-ws-");
	const external = externalDir();
	const root = path.join(cwd, "runtime");
	const disposals: string[] = [];
	let executeCalls = 0;
	const createWorker = (): WorkerController => ({
		execute: async () => { executeCalls++; return { status: "ok" }; },
		dispose: async (reason?: string) => { disposals.push(reason ?? "(none)"); },
		status: () => ({ workerRunning: false }),
		reset: async () => {},
	} as unknown as WorkerController);
	const policy: PolicyState = { cwd, config: mergeConfig({}, {}, cwd), sandboxMode: "full", workspaceLocked: false, profile: "default", interactive: true };
	const runtime = new GuardRuntime({ policy, detection, runtimeRoot: root, createWorker });
	const sessionRoots: string[] = [];
	const gate = new DialogGate();
	return {
		runtime, cwd, external, sessionRoots, gate,
		workerDisposals: disposals,
		get workerExecuteCalls() { return executeCalls; },
		cleanup: () => {
			void runtime.dispose().catch(() => {});
			rmSync(cwd, { recursive: true, force: true });
			rmSync(external, { recursive: true, force: true });
		},
	};
}

/** Scripted PromptFlowIO. Answers are consumed in order; a promise answer
 * blocks until resolved (cancellation tests race it against the signal). */
function fakeIO(script: { selects?: Array<Promise<string | undefined> | string | undefined>; editors?: Array<string | undefined>; inputs?: Array<string | undefined> } = {}, omitEditor = false) {
	const calls: Array<{ kind: string; options?: string[] }> = [];
	const notes: string[] = [];
	const io: PromptFlowIO = {
		select: async (_title: string, options: string[], signal: AbortSignal) => {
			calls.push({ kind: "select", options });
			const answer = script.selects?.shift();
			if (answer === undefined) return undefined;
			const aborted = new Promise<never>((_, reject) => {
				if (signal.aborted) reject(signal.reason ?? new Error("aborted"));
				else signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
			});
			return await Promise.race([Promise.resolve(answer), aborted]);
		},
		...(omitEditor ? {} : {
			editor: async (_title: string, prefill: string) => {
				calls.push({ kind: "editor" });
				const next = script.editors?.shift();
				return next === undefined ? prefill : next;
			},
		}),
		inputText: async () => {
			calls.push({ kind: "input" });
			return script.inputs?.shift();
		},
		notify: (message: string) => { notes.push(message); },
	};
	return { io, calls, notes };
}

function signature(cfg: ResolvedGuardConfig): string {
	const { warnings: _warnings, ...rest } = cfg as ResolvedGuardConfig & { warnings?: unknown };
	return JSON.stringify(rest);
}

export interface SpikeGrantResult {
	diagnostic: string;
	outcome?: ReadFlowOutcome;
	steering?: string;
	dialogOpened: boolean;
}

/**
 * Test-local reproduction of the handleReadGrant body (index.ts) with the
 * worker framing removed and the requester relabeled. Deliberately mirrors
 * the production order: epoch capture, suggestion validation, the dialog
 * gate, the prompt flow, typed outcomes, then the transition with
 * expectedEpoch, preempt, invalidateWorkers, and the beforeCommit
 * revalidation (config-race check first, then validation, then persistence).
 */
async function spikeGrantInteraction(deps: {
	spike: Spike;
	requestPath: string;
	hasUI?: boolean;
	io?: PromptFlowIO;
	signal?: AbortSignal;
	afterOutcome?: () => void | Promise<void>;
	afterDiskSnapshot?: () => void | Promise<void>;
}): Promise<SpikeGrantResult> {
	const { spike, requestPath } = deps;
	const { runtime: rt, cwd, gate, sessionRoots } = spike;
	try {
		if (deps.signal?.aborted) return { diagnostic: "No read grant: call aborted.", dialogOpened: false };
		// The worker path returns the payload unchanged without a UI; the tool
		// spec (docs/guard-design.md) requires an actionable diagnostic here.
		if (!deps.hasUI || !deps.io) return { diagnostic: "No read grant: no interactive UI is available to approve it.", dialogOpened: false };
		const epoch = rt.epoch;
		const suggestedRoot = validateReadGrant(readGrantSuggestion(requestPath, cwd), cwd);
		const outcome = await gate.run({ signal: deps.signal }, async (dialogSignal) => {
			return runReadGrantPrompt({
				io: deps.io!, signal: dialogSignal, workerName: "request_read_access",
				requestPath, suggestedRoot,
				scopes: ["project", "user"],
				parseReadRoot: (text) => parseReadRootInput(text, cwd),
				validateRoot: (candidate) => {
					try { validateReadRootSave(candidate, requestPath, cwd); return { ok: true as const }; }
					catch (err) { return { ok: false as const, error: err instanceof Error ? err.message : String(err) }; }
				},
				destination: (scope) => scope === "project" ? "project guard.local.json" : "user guard.json",
			});
		});
		await deps.afterOutcome?.();
		const diskConfig = loadConfig(cwd);
		await deps.afterDiskSnapshot?.();
		if (outcome.kind === "no-grant") return { diagnostic: "No read grant: the request was not approved.", outcome, dialogOpened: true };
		if (outcome.kind === "deny") return { diagnostic: "Read request denied.", outcome, steering: outcome.steering ?? undefined, dialogOpened: true };
		const root = outcome.kind === "save-root" ? validateReadRootSave(outcome.root, requestPath, cwd) : suggestedRoot;
		// Mirror the extension wrapper: invalidate pending dialogs synchronously
		// before the transition (a settled dialog's own grant cannot cancel itself).
		gate.invalidate("approval expired after a policy change");
		const base: PolicyState = { cwd, config: diskConfig, sandboxMode: "full", workspaceLocked: false, profile: "default", interactive: true };
		await rt.transition({ ...base, config: { ...diskConfig, readRoots: [...new Set([...diskConfig.readRoots, root])] } }, undefined, undefined, undefined, {
			preempt: true, invalidateWorkers: true, expectedEpoch: epoch,
			beforeCommit: () => {
				if (signature(loadConfig(cwd)) !== signature(diskConfig)) throw new Error("guard: config changed while waiting; nothing saved or replayed");
				if (outcome.kind === "save-root") validateReadRootSave(root, requestPath, cwd);
				if (outcome.kind === "grant-session") sessionRoots.push(root);
				else addToConfigScope(outcome.scope, { readRoots: [root] }, { cwd });
				const merged = loadConfig(cwd);
				return { ...base, config: { ...merged, readRoots: [...new Set([...merged.readRoots, ...sessionRoots])] } };
			},
		});
		return { diagnostic: `Read-only grant added: ${root}. Re-run the command; it was not replayed.`, outcome, dialogOpened: true };
	} catch (err) {
		return { diagnostic: `Read grant refused: ${err instanceof Error ? err.message : String(err)}`, dialogOpened: true };
	}
}

// ── Session grant ────────────────────────────────────────────────────────────

test("spike: session grant adds the root to session roots and the published policy", async () => {
	const spike = setup();
	try {
		const { io } = fakeIO({ selects: ["Grant for session"] });
		const requestPath = path.join(spike.external, "data.txt");
		writeFileSync(requestPath, "granted-read");
		const result = await spikeGrantInteraction({ spike, requestPath, hasUI: true, io });
		assert.match(result.diagnostic, /Read-only grant added/);
		assert.equal(result.outcome?.kind, "grant-session");
		assert.deepEqual(spike.sessionRoots, [spike.external]);
		assert.ok(spike.runtime.policy.config.readRoots.includes(spike.external), "the published policy carries the granted root");
		assert.equal(spike.workerExecuteCalls, 0, "nothing was executed or replayed");
	} finally { spike.cleanup(); }
});

// ── Persistent save ──────────────────────────────────────────────────────────

test("spike: persistent project save writes guard.local.json and merges into the policy", async () => {
	const spike = setup();
	try {
		const { io } = fakeIO({ selects: ["Save for project", "Confirm"], editors: [spike.external] });
		const requestPath = path.join(spike.external, "data.txt");
		writeFileSync(requestPath, "allowed");
		const result = await spikeGrantInteraction({ spike, requestPath, hasUI: true, io });
		assert.equal(result.outcome?.kind, "save-root");
		assert.equal(spike.sessionRoots.length, 0, "persistent saves do not touch session roots");
		const saved = JSON.parse(readFileSync(projectConfigPath(spike.cwd), "utf8")) as { readRoots?: string[] };
		assert.ok(saved.readRoots?.includes(spike.external));
		assert.ok(spike.runtime.policy.config.readRoots.includes(spike.external));
	} finally { spike.cleanup(); }
});

test("spike: an edited root that does not cover the request path is rejected by the loop", async () => {
	const spike = setup();
	try {
		const unrelated = externalDir();
		const { io } = fakeIO({ selects: ["Save for project", "Confirm"], editors: [unrelated, spike.external] });
		const requestPath = path.join(spike.external, "data.txt");
		writeFileSync(requestPath, "allowed");
		const result = await spikeGrantInteraction({ spike, requestPath, hasUI: true, io });
		assert.equal(result.outcome?.kind, "save-root");
		// The unrelated editor entry was rejected; the retried root won.
		const saved = JSON.parse(readFileSync(projectConfigPath(spike.cwd), "utf8")) as { readRoots?: string[] };
		assert.ok(saved.readRoots?.includes(spike.external));
		assert.ok(!saved.readRoots?.includes(unrelated));
		rmSync(unrelated, { recursive: true, force: true });
	} finally { spike.cleanup(); }
});

// ── Denial, cancellation, and no-UI outcomes ─────────────────────────────────

test("spike: explicit denial delivers steering and persists nothing", async () => {
	const spike = setup();
	try {
		const { io } = fakeIO({ selects: ["Deny"], inputs: ["stop reading there"] });
		const requestPath = path.join(spike.external, "data.txt");
		const result = await spikeGrantInteraction({ spike, requestPath, hasUI: true, io });
		assert.equal(result.diagnostic, "Read request denied.");
		assert.equal(result.steering, "stop reading there");
		assert.deepEqual(spike.sessionRoots, []);
		assert.equal(spike.runtime.policy.config.readRoots.length, 0);
		assert.equal(spike.workerExecuteCalls, 0);
	} finally { spike.cleanup(); }
});

test("spike: selector cancellation grants nothing", async () => {
	const spike = setup();
	try {
		const { io } = fakeIO({ selects: [undefined] });
		const requestPath = path.join(spike.external, "data.txt");
		const result = await spikeGrantInteraction({ spike, requestPath, hasUI: true, io });
		assert.match(result.diagnostic, /not approved/);
		assert.deepEqual(spike.sessionRoots, []);
	} finally { spike.cleanup(); }
});

test("spike: no UI returns an actionable diagnostic without opening a dialog", async () => {
	const spike = setup();
	const requestPath = path.join(spike.external, "data.txt");
	const result = await spikeGrantInteraction({ spike, requestPath });
	assert.match(result.diagnostic, /[Nn]o interactive UI/);
	assert.equal(result.dialogOpened, false);
	spike.cleanup();
});

test("spike: capability-limited UI offers session grant and deny only", async () => {
	const spike = setup();
	try {
		const { io, calls } = fakeIO({ selects: [undefined] }, true);
		const requestPath = path.join(spike.external, "data.txt");
		await spikeGrantInteraction({ spike, requestPath, hasUI: true, io });
		const select = calls.find((c) => c.kind === "select");
		assert.deepEqual(select?.options, ["Grant for session", "Deny"], "no editor means no persistent save actions");
	} finally { spike.cleanup(); }
});

test("spike: aborting the owning signal mid-dialog cancels without a grant or unhandled rejection", async () => {
	const spike = setup();
	try {
		const blocker = Promise.withResolvers<string | undefined>();
		const { io } = fakeIO({ selects: [blocker.promise] });
		const ac = new AbortController();
		const requestPath = path.join(spike.external, "data.txt");
		const pending = spikeGrantInteraction({ spike, requestPath, hasUI: true, io, signal: ac.signal });
		await new Promise((r) => setTimeout(r, 20));
		ac.abort();
		const result = await pending;
		assert.match(result.diagnostic, /refused|aborted|cancelled/i);
		assert.deepEqual(spike.sessionRoots, []);
		blocker.resolve(undefined);
	} finally { spike.cleanup(); }
});

// ── Epoch and config-race final revalidation ─────────────────────────────────

test("spike: a stale epoch fails closed at commit and persists nothing", async () => {
	const spike = setup();
	try {
		const { io } = fakeIO({ selects: ["Grant for session"] });
		const requestPath = path.join(spike.external, "data.txt");
		const result = await spikeGrantInteraction({
			spike, requestPath, hasUI: true, io,
			afterOutcome: async () => {
				// A concurrent transition between dialog settle and commit.
				await spike.runtime.transition({ cwd: spike.cwd, config: loadConfig(spike.cwd), sandboxMode: "full", workspaceLocked: false, profile: "default", interactive: true });
			},
		});
		assert.match(result.diagnostic, /refused|expired/i);
		assert.deepEqual(spike.sessionRoots, [], "the grant never landed");
	} finally { spike.cleanup(); }
});

test("spike: a config race while the dialog is open fails closed before any write", async () => {
	const spike = setup();
	try {
		const { io } = fakeIO({ selects: ["Save for project", "Confirm"], editors: [spike.external] });
		const requestPath = path.join(spike.external, "data.txt");
		writeFileSync(requestPath, "allowed");
		const racer = externalDir();
		const result = await spikeGrantInteraction({
			spike, requestPath, hasUI: true, io,
			afterDiskSnapshot: () => {
				// Another writer touches guard.local.json after the snapshot.
				addToConfigScope("project", { readRoots: [racer] }, { cwd: spike.cwd });
			},
		});
		assert.match(result.diagnostic, /refused|config changed/i);
		const saved = JSON.parse(readFileSync(projectConfigPath(spike.cwd), "utf8")) as { readRoots?: string[] };
		assert.ok(saved.readRoots?.includes(racer), "the racing write survives");
		assert.ok(!saved.readRoots?.includes(spike.external), "the granted root was never written");
		rmSync(racer, { recursive: true, force: true });
	} finally { spike.cleanup(); }
});

// ── Transition semantics without workers ─────────────────────────────────────

test("spike: the grant transition disposes the fake worker, preempts the active execution, and invalidates the queued one", async () => {
	const spike = setup();
	try {
		const allow = async () => true;
		const started = Promise.withResolvers<void>();
		let tornDown = false;
		const workerCtx = {
			policy: spike.runtime.policy, detection, runtimeDir: path.join(spike.cwd, "rt"), scratchDir: path.join(spike.cwd, "scratch"),
			signal: new AbortController().signal, warnings: [] as string[],
			setTeardown: () => {},
			revalidate: async () => {}, assertCurrent: () => {},
			teardownFailed: (err: unknown) => { throw err; },
		};
		const active = spike.runtime.run(allow, async (execution) => {
			execution.setTeardown(async () => { tornDown = true; });
			started.resolve();
			await new Promise<void>((resolve) => execution.signal.addEventListener("abort", () => resolve(), { once: true }));
		});
		await started.promise;
		// Register the fake worker so invalidateWorkers has something to dispose.
		await spike.runtime.worker("python", { code: "1" }, workerCtx as never);
		const executeCallsBefore = spike.workerExecuteCalls;
		const queuedEpoch = spike.runtime.epoch;
		const queued = spike.runtime.run(allow, async () => { throw new Error("must not run"); });
		void queued.catch(() => {});
		const { io } = fakeIO({ selects: ["Grant for session"] });
		const requestPath = path.join(spike.external, "data.txt");
		const result = await spikeGrantInteraction({ spike, requestPath, hasUI: true, io });
		assert.match(result.diagnostic, /Read-only grant added/);
		await active; // the preempted active settles normally after abort (the tool layer turns that into "aborted")
		await assert.rejects(queued, /expired|changed|transition/);
		assert.equal(queuedEpoch !== spike.runtime.epoch, true, "the grant transition advanced the epoch");
		assert.ok(spike.workerDisposals.some((r) => r.includes("policy mounts changed")), `worker disposed for the mount change: ${JSON.stringify(spike.workerDisposals)}`);
		assert.equal(tornDown, true, "the active execution's teardown ran before the commit");
		assert.equal(spike.workerExecuteCalls, executeCallsBefore, "no code replay");
	} finally { spike.cleanup(); }
});

test("spike: one dialog gate serializes the grant against a concurrent dialog", async () => {
	const gate = new DialogGate();
	const order: string[] = [];
	const releaseA = Promise.withResolvers<void>();
	const a = gate.run({}, async () => { order.push("a-start"); await releaseA.promise; order.push("a-end"); });
	const b = gate.run({}, async () => { order.push("b-start"); });
	await new Promise((r) => setTimeout(r, 20));
	assert.deepEqual(order, ["a-start"], "the grant body waits for the open dialog");
	releaseA.resolve();
	await Promise.all([a, b]);
	assert.deepEqual(order, ["a-start", "a-end", "b-start"]);
});

// ── Path contracts the tool entry must uphold ────────────────────────────────

test("spike: readGrantSuggestion walks a missing nested target up to the nearest existing directory", () => {
	const spike = setup();
	try {
		const requestPath = path.join(spike.external, "missing", "deep", "file.txt");
		assert.equal(readGrantSuggestion(requestPath, spike.cwd), spike.external);
	} finally { spike.cleanup(); }
});

test("spike: the primitives resolve rather than reject relative input, so the tool entry must enforce isAbsolute", () => {
	const spike = setup();
	try {
		mkdirSync(path.join(spike.cwd, "sub"));
		// readGrantSuggestion resolves a relative input against the workspace
		// instead of rejecting it; whether validateReadGrant then passes depends
		// only on where the resolved path lands (here: /tmp, a reserved mount).
		// The primitives contain no isAbsolute gate, so request_read_access must
		// check path.isAbsolute itself before calling them (PR 2 entry contract).
		const suggested = readGrantSuggestion("sub", spike.cwd);
		assert.equal(path.isAbsolute(suggested), true);
		assert.equal(suggested, path.join(spike.cwd, "sub"));
		assert.throws(() => validateReadGrant(suggested, spike.cwd), /reserved|covered/);
		assert.throws(() => validateReadGrant("no/such/dir/anywhere", spike.cwd));
		// An absolute grant must be a directory covering the request path.
		writeFileSync(path.join(spike.external, "f.txt"), "x");
		assert.throws(() => validateReadRootSave(spike.external, path.join(spike.cwd, "unrelated.txt"), spike.cwd), /does not cover/);
		assert.equal(validateReadRootSave(spike.external, path.join(spike.external, "f.txt"), spike.cwd), spike.external);
	} finally { spike.cleanup(); }
});
