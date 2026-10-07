/** Serialized ownership of guard executors, mounts, scratch and teardown. */
import { mkdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { PythonSessionController } from "./tools/python/session.ts";
import { NodeSessionController } from "./tools/node/session.ts";
import type { ControllerOptions } from "./tools/worker-launch.ts";
import type { SandboxDetection } from "./sandbox/detect.ts";
import { createSessionDir, disposeSession } from "./sandbox/run.ts";
import { scanWorkspace } from "./sandbox/scan.ts";
import { snapshotProtected, auditProtected, type ProtectedSnapshot } from "./sandbox/audit.ts";
import { filterMountableReadRoots, resolveWorktreeCommonDir } from "./sandbox/bwrap.ts";
import { isWithin, sensitiveHostPaths } from "./sandbox/host-paths.ts";
import { DEFAULT_MASK_PATTERNS, DEFAULT_MASK_EXCEPTIONS } from "./sandbox/spec.ts";
import { normalizeRootList } from "./policy/paths.ts";
import { effectiveWorkspaceMode, type PolicyState } from "./policy/decision.ts";

export type WorkerController = Pick<PythonSessionController, "execute" | "reset" | "status" | "dispose">;
export interface RuntimeOptions {
	policy: PolicyState;
	detection: SandboxDetection;
	runtimeRoot?: string;
	createWorker?: (kind: "python" | "node", options: ControllerOptions) => WorkerController;
	onLock?: (reason: string) => void;
	onLockSettled?: () => void;
	onWarning?: (message: string) => void;
}
export interface TransitionOptions {
	/** Privileged persistence must wait until no execution audit is open. */
	preempt?: boolean;
	invalidateWorkers?: boolean;
	expectedEpoch?: number;
	beforeCommit?: () => PolicyState | void;
}
export interface ExecutionContext {
	policy: PolicyState;
	detection: SandboxDetection;
	runtimeDir: string;
	scratchDir: string;
	signal: AbortSignal;
	warnings: string[];
	/** Installed before spawn; tightening awaits this actual teardown. */
	setTeardown: (stop: () => Promise<void>) => void;
	revalidate: () => Promise<void>;
	/** Synchronous final check, with no await between this and spawn. */
	assertCurrent: () => void;
	teardownFailed: (error: unknown) => never;
}
interface WorkerRecord {
	controller: WorkerController;
	fingerprint: string;
	sandboxed: boolean;
	stopping?: Promise<void>;
}

export class GuardRuntime {
	private revision = 0;
	private tail: Promise<unknown> = Promise.resolve();
	private active?: { abort: AbortController; stop?: () => Promise<void>; stopping?: Promise<void>; sandboxed?: boolean };
	private workers = new Map<"python" | "node", WorkerRecord>();
	private failure: string | null = null;
	private lockVersion = 0;
	private closed = false;
	private transitioning = 0;
	private currentPolicy: PolicyState;
	private detection: SandboxDetection;
	readonly sessionDir: string;
	readonly scratchDir: string;

	private readonly options: RuntimeOptions;
	constructor(options: RuntimeOptions) {
		this.options = options;
		this.currentPolicy = options.policy;
		this.detection = options.detection;
		this.sessionDir = realpathSync(createSessionDir(options.runtimeRoot));
		const scratch = join(this.sessionDir, "scratch");
		mkdirSync(scratch, { mode: 0o700 });
		this.scratchDir = realpathSync(scratch);
	}
	get epoch(): number { return this.revision; }
	get policy(): PolicyState { return this.currentPolicy; }
	get teardownFailure(): string | null { return this.failure; }
	assertAvailable(): void { this.assertReady(); }

	private enqueue<T>(fn: () => Promise<T>): Promise<T> {
		const result = this.tail.then(fn);
		this.tail = result.catch(() => {});
		return result;
	}
	private assertReady(): void {
		if (this.failure) throw new Error(`guard: unresolved teardown: ${this.failure}`);
		if (this.closed) throw new Error("guard: runtime disposed");
		if (this.transitioning) throw new Error("guard: policy transition in progress; retry the call");
	}
	private sticky(err: unknown): Error {
		if (!this.failure) {
			this.failure = err instanceof Error ? err.message : String(err);
			try { this.options.onWarning?.(`guard: unresolved teardown blocks every guarded executor and cannot be acknowledged: ${this.failure}`); } catch { /* best effort */ }
		}
		return new Error(`guard: unresolved teardown: ${this.failure}`);
	}
	private stopActive(): Promise<void> {
		const active = this.active;
		if (!active) return Promise.resolve();
		active.abort.abort();
		if (active.stop && !active.stopping) {
			active.stopping = active.stop().catch((err) => { throw this.sticky(err); });
		}
		return active.stopping ?? Promise.resolve();
	}

	/** Dialogs happen before taking the queue. Tokens belong to one epoch only. */
	async run<T>(authorize: (policy: PolicyState, phase: "prompt" | "check") => Promise<boolean>, execute: (ctx: ExecutionContext) => Promise<T>, signal?: AbortSignal): Promise<{ result: T; warnings: string[] }> {
		this.assertReady();
		const epoch = this.revision;
		if (!await authorize(this.currentPolicy, "prompt")) throw new Error("guard: execution denied");
		return this.enqueue(async () => {
			this.assertReady();
			const assertCurrent = () => {
				this.assertReady();
				if (epoch !== this.revision) throw new Error("guard: approval expired after a policy change; retry the call");
				if (signal?.aborted || abort.signal.aborted) throw new Error("aborted");
			};
			const check = async () => {
				assertCurrent();
				if (!await authorize(this.currentPolicy, "check")) throw new Error("guard: execution no longer authorized");
				assertCurrent();
			};
			const abort = new AbortController();
			const onAbort = () => { abort.abort(); void this.stopActive().catch(() => {}); };
			signal?.addEventListener("abort", onAbort, { once: true });
			this.active = { abort };
			const warnings: string[] = [];
			try {
				await check();
				const result = await execute({ policy: this.currentPolicy, detection: this.detection, runtimeDir: this.sessionDir, scratchDir: this.scratchDir, signal: abort.signal, warnings, setTeardown: (stop) => { if (this.active) this.active.stop = stop; }, revalidate: check, assertCurrent, teardownFailed: (err) => { throw this.sticky(err); } });
				return { result, warnings };
			} finally {
				try { if (this.active?.stopping) await this.active.stopping; }
				finally {
					this.active = undefined;
					signal?.removeEventListener("abort", onAbort);
				}
			}
		});
	}

	/** Invalidate approvals immediately, then preempt, teardown, mutate and publish. */
	transition(policy: PolicyState, detection: SandboxDetection = this.detection, commit?: () => void, validate?: () => void, options: TransitionOptions = {}): Promise<void> {
		if (options.expectedEpoch !== undefined && options.expectedEpoch !== this.revision) return Promise.reject(new Error("guard: approval expired; nothing saved or executed"));
		this.revision++;
		const transactionEpoch = this.revision;
		const checkApproval = () => {
			if (options.expectedEpoch !== undefined && transactionEpoch !== this.revision) throw new Error("guard: approval expired; nothing saved or executed");
		};
		this.transitioning++;
		const lockVersion = this.lockVersion;
		const changedMounts = this.launchPolicyKey(policy, detection) !== this.launchPolicyKey(this.currentPolicy, this.detection);
		const tighter = ["research", "default", "auto", "trusted", "yolo", "unrestricted"].indexOf(policy.profile) < ["research", "default", "auto", "trusted", "yolo", "unrestricted"].indexOf(this.currentPolicy.profile);
		const hostPolicyChanged = this.hostPolicyKey(policy) !== this.hostPolicyKey(this.currentPolicy);
		const stopped = options.preempt || changedMounts || ((tighter || hostPolicyChanged) && !this.active?.sandboxed) ? this.stopActive() : Promise.resolve();
		// Attach now: teardown can reject before the queue becomes available.
		void stopped.catch(() => {});
		const queued = this.enqueue(async () => {
			try {
				await stopped;
				if (this.failure) throw this.sticky(this.failure);
				if (this.closed) throw new Error("guard: runtime disposed");
				checkApproval();
				validate?.();
				if (options.invalidateWorkers || this.launchPolicyKey(policy, detection) !== this.launchPolicyKey(this.currentPolicy, this.detection)) {
					await this.disposeWorkers("policy mounts changed");
				}
				// Auditing teardown may have locked the workspace. Never silently unlock it.
				if (this.lockVersion !== lockVersion) policy = { ...policy, workspaceLocked: true };
				checkApproval();
				const prepared = options.beforeCommit?.();
				if (prepared) policy = prepared;
				if (this.lockVersion !== lockVersion) policy = { ...policy, workspaceLocked: true };
				this.currentPolicy = policy;
				this.detection = detection;
				commit?.();
			} finally { this.transitioning--; }
		});
		// A known failed kill cannot wait behind an execution that never exits.
		const failedStop = stopped.then(() => new Promise<never>(() => {}));
		return Promise.race([queued, failedStop]);
	}

	private hostPolicyKey(policy: PolicyState): string {
		const config = policy.config;
		return JSON.stringify([config.hostBash, config.bashValidators, config.writeRoots, config.classifier, config.classifierEnvironment, config.classifierAllow, config.classifierSoftDeny, config.classifierHardDeny]);
	}
	private launchPolicyKey(policy: PolicyState, detection: SandboxDetection): string {
		return JSON.stringify([realpathSync(policy.cwd), this.workerMode(policy, detection), this.workerMode(policy, detection) === "none" ? null : resolveWorktreeCommonDir(policy.cwd), policy.profile === "research", detection.mode, detection.bwrapPath, detection.launcherPath, this.roots(policy), policy.config.maskPatterns, policy.config.maskExceptions, policy.config.protectedPaths, policy.workspaceLocked]);
	}
	private workerMode(policy: PolicyState, detection = this.detection): "overlay" | "ro" | "none" {
		const mode = effectiveWorkspaceMode(policy);
		return mode === "none" ? "none" : mode === "ro" || detection.mode === "reduced" ? "ro" : "overlay";
	}
	private roots(policy: PolicyState): string[] {
		return filterMountableReadRoots(normalizeRootList(policy.config.readRoots, policy.cwd, homedir()), policy.cwd).mountable;
	}
	private auditOptions() {
		return { fdPath: this.detection.fdPath, patterns: [...DEFAULT_MASK_PATTERNS, ...this.currentPolicy.config.maskPatterns], exceptions: [...DEFAULT_MASK_EXCEPTIONS, ...this.currentPolicy.config.maskExceptions], protectedPaths: this.currentPolicy.config.protectedPaths };
	}
	private snapshot(): ProtectedSnapshot {
		const snapshot = snapshotProtected(this.currentPolicy.cwd, this.auditOptions());
		if (snapshot.complete === false) throw new Error((snapshot.diagnostics ?? ["Incomplete protected-path baseline"]).join("; "));
		return snapshot;
	}
	private markLocked(reason: string, warnings: string[]): void {
		warnings.push(reason);
		this.revision++;
		this.lockVersion++;
		this.currentPolicy = { ...this.currentPolicy, workspaceLocked: true };
		try { this.options.onLock?.(reason); } catch { /* policy remains locked */ }
		try { this.options.onWarning?.(reason); } catch { /* notification is best effort */ }
	}
	private publishLock(): void {
		if (this.transitioning) return;
		try { this.options.onLockSettled?.(); } catch { /* internal enforcement remains locked */ }
	}
	private audit(before: ProtectedSnapshot, warnings: string[]): boolean {
		try {
			const result = auditProtected(before, this.currentPolicy.cwd, { ...this.auditOptions(), quarantineDir: join(this.sessionDir, "quarantine") });
			if (result.lockWrites || result.created.length || result.replaced.length || result.missing.length || result.diagnostics.length) {
				this.markLocked([result.summary, ...result.diagnostics].join("\n"), warnings);
				return true;
			}
		} catch (err) {
			this.markLocked(`guard: protected-path audit failed: ${String(err)}`, warnings);
			return true;
		}
		return false;
	}

	/** Host-view audit only; overlay writes are not escaped workspace writes. */
	async sandboxBoundary<T>(execute: () => Promise<T>, warnings: string[]): Promise<T> {
		if (this.active) this.active.sandboxed = true;
		let before: ProtectedSnapshot;
		try { before = this.snapshot(); }
		catch (err) {
			this.markLocked(`guard: protected-path snapshot failed: ${String(err)}`, warnings);
			try { await this.disposeWorkers("incomplete protected-path snapshot"); }
			catch (failure) { this.sticky(failure); }
			this.publishLock();
			throw err;
		}
		try { return await execute(); }
		finally {
			if (this.audit(before, warnings)) {
				// Inline containment avoids queuing a transition behind this execution.
				try { await this.disposeWorkers("workspace audit lock"); }
				catch (err) { warnings.push(this.sticky(err).message); }
				this.publishLock();
			}
		}
	}

	async worker(kind: "python" | "node", input: { action?: string; code?: string; timeoutSeconds?: number }, ctx: ExecutionContext): Promise<unknown> {
		if (ctx.detection.mode === "degraded") throw new Error(`${kind} unavailable: guard sandbox is degraded`);
		if (input.action === "status") {
			const record = this.workers.get(kind);
			if (record) return record.controller.status();
			const options: ControllerOptions = { projectDir: ctx.policy.cwd, workspaceMode: this.workerMode(ctx.policy), runtimeDir: this.sessionDir, scratchDir: this.scratchDir, detection: ctx.detection, readRoots: this.roots(ctx.policy) };
			const controller = this.options.createWorker?.(kind, options) ?? (kind === "python" ? new PythonSessionController(options) : new NodeSessionController(options));
			return controller.status();
		}
		if (input.action === "reset") {
			const record = this.workers.get(kind);
			if (record) await this.disposeRecord(kind, record, "reset");
			return { status: "reset", scratchDir: this.scratchDir, stateLost: true };
		}
		if (typeof input.code !== "string") throw new Error("code is required for execute");
		const mode = this.workerMode(ctx.policy);
		let baseline: ProtectedSnapshot | undefined;
		let masks: string[] | undefined;
		if (mode !== "none") {
			try {
				baseline = this.snapshot();
				masks = scanWorkspace(ctx.policy.cwd, this.auditOptions()).masks.sort();
			} catch (err) {
				this.markLocked(`guard: worker mount/audit snapshot failed: ${String(err)}`, ctx.warnings);
				try { await this.disposeWorkers("incomplete worker mount scan"); } catch (failure) { this.sticky(failure); }
				this.publishLock();
				throw err;
			}
		}
		// Include top-level existence/inodes, not just the scanner's nested names.
		const protectedMounts = baseline ? [...baseline].filter(([, entry]) => entry.exists).sort(([a], [b]) => a.localeCompare(b)) : undefined;
		const fingerprint = JSON.stringify([this.launchPolicyKey(ctx.policy, ctx.detection), masks, protectedMounts]);
		let record = this.workers.get(kind);
		if (record && record.fingerprint !== fingerprint) {
			await this.disposeRecord(kind, record, "workspace mask/protected mount set changed");
			record = undefined;
			this.options.onWarning?.(`${kind}: mounts changed; interpreter state and overlay discarded. Scratch retained.`);
		}
		await ctx.revalidate();
		if (!record) {
			const options: ControllerOptions = { projectDir: ctx.policy.cwd, workspaceMode: mode, readRoots: this.roots(ctx.policy), runtimeDir: this.sessionDir, scratchDir: this.scratchDir, detection: ctx.detection, maskPatterns: ctx.policy.config.maskPatterns, maskExceptions: ctx.policy.config.maskExceptions, protectedPaths: ctx.policy.config.protectedPaths };
			const controller = this.options.createWorker?.(kind, options) ?? (kind === "python" ? new PythonSessionController(options) : new NodeSessionController(options));
			record = { controller, fingerprint, sandboxed: mode !== "none" };
			this.workers.set(kind, record);
		}
		const current = record;
		ctx.setTeardown(() => this.disposeRecord(kind, current, "execution preempted"));
		const execute = async () => {
			await ctx.revalidate();
			ctx.assertCurrent();
			try { return await current.controller.execute(input.code!, input.timeoutSeconds ?? 30, ctx.signal); }
			catch (err) { throw this.sticky(err); }
		};
		return mode === "none" ? execute() : this.sandboxBoundary(execute, ctx.warnings);
	}

	private disposeRecord(kind: "python" | "node", record: WorkerRecord, reason: string): Promise<void> {
		if (record.stopping) return record.stopping;
		record.stopping = (async () => {
			// Authorized host edits between executions are not escaped sandbox writes.
			// Snapshot the teardown boundary itself, not the worker's launch time.
			let before: ProtectedSnapshot | undefined;
			if (record.sandboxed) {
				try { before = this.snapshot(); }
				catch (err) { this.markLocked(`guard: teardown audit snapshot failed: ${String(err)}`, []); }
			}
			try { await record.controller.dispose(reason); }
			catch (err) { throw this.sticky(err); }
			finally { if (before) this.audit(before, []); }
			if (this.workers.get(kind) === record) this.workers.delete(kind);
		})();
		return record.stopping;
	}
	private async disposeWorkers(reason: string): Promise<void> {
		const results = await Promise.allSettled([...this.workers].map(([kind, record]) => this.disposeRecord(kind, record, reason)));
		const failed = results.find((r) => r.status === "rejected");
		if (failed?.status === "rejected") throw this.sticky(failed.reason);
		if (results.length) {
			try { this.options.onWarning?.("guard: workers stopped; interpreter state and overlays discarded. Scratch retained. Raw descendants may escape tracking; previous host effects cannot be undone."); } catch { /* best effort */ }
		}
	}

	/** Tree/session/cwd replacement deletes scratch only after successful teardown. */
	dispose(reason = "session shutdown"): Promise<void> {
		if (this.closed) return Promise.resolve();
		if (this.failure) return Promise.reject(this.sticky(this.failure));
		this.revision++;
		this.transitioning++;
		const stopped = this.stopActive();
		void stopped.catch(() => {});
		return this.enqueue(async () => {
			try {
				await stopped;
				if (this.failure) throw this.sticky(this.failure);
				await this.disposeWorkers(reason);
				rmSync(this.scratchDir, { recursive: true, force: true });
				disposeSession(this.sessionDir); // quarantine is deliberately retained
				this.closed = true;
			} finally { this.transitioning--; }
		});
	}
}

/** Validate real directory mounts, including ancestors of hard exclusions. */
export function validateReadGrant(candidate: string, workspace: string, home = homedir()): string {
	const root = realpathSync(candidate);
	if (!statSync(root).isDirectory()) throw new Error("Read grants must be directories");
	const overlaps = sensitiveHostPaths(home).some((p) => isWithin(root, p) || isWithin(p, root));
	if (overlaps) throw new Error("Read grant overlaps a hard-excluded credential/runtime path");
	const result = filterMountableReadRoots([root], workspace, home);
	if (!result.mountable.includes(root)) throw new Error(result.skipped[0]?.reason ?? "Read grant cannot be mounted");
	return root;
}
