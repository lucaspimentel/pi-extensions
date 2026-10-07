/**
 * Persistent worker ownership for the node tool.
 *
 * NodeSessionController owns exactly one sandboxed worker at a time,
 * serializes execution/reset/status/shutdown through a single lock, enforces
 * parent-side deadlines and output budgets, and performs bounded, idempotent
 * teardown. Process-management complexity stays behind this interface; the
 * extension layer only sees execute/reset/status/dispose.
 *
 * Lifecycle rules implemented here:
 * - Worker starts lazily on the first execute; status never starts one.
 * - Ordinary JavaScript errors keep the interpreter and its state.
 * - Timeout, cancellation, output-limit overflow, worker death, or protocol
 *   violation kill the entire sandbox: interpreter state is lost, partial
 *   output is returned when available, and the next execution starts a fresh
 *   worker. Code is never replayed automatically.
 * - Explicit reset kills the sandbox but preserves scratch files and leaves
 *   the replacement worker unstarted.
 * - dispose() preempts active execution and keeps runtime-owned scratch/logs.
 */

import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { LIMITS, PROTOCOL_VERSION } from "./limits.ts";
import {
	decodeFrame,
	encodeRequest,
	FrameStream,
	type RuntimeErrorInfo,
	type ResultFrame,
	type WorkerFrame,
} from "./protocol.ts";
import { checkDependencies, spawnWorker, type DependencyCheck, type ControllerOptions } from "../worker-launch.ts";
export type { ControllerOptions } from "../worker-launch.ts";

export type ExecutionStatus =
	| "ok"
	| "runtime_error"
	| "permission_needed"
	| "timeout"
	| "cancelled"
	| "output_limit"
	| "worker_error"
	| "unavailable";

/** Statuses whose tool results are marked as errors toward the model. */
export const FAILURE_STATUSES: ReadonlySet<ExecutionStatus> = new Set([
	"runtime_error",
	"permission_needed",
	"timeout",
	"cancelled",
	"output_limit",
	"worker_error",
	"unavailable",
]);

export interface ExecutionResult {
	status: ExecutionStatus;
	durationMs: number;
	generation: number;
	/** Bounded excerpts; full streams are in the log files when present. */
	stdout: string;
	stderr: string;
	excerptTruncated: boolean;
	repr: string | null;
	reprTruncated: boolean;
	exception: RuntimeErrorInfo | null;
	/** True when the interpreter and its namespace were destroyed. */
	stateLost: boolean;
	stateLostReason?: string;
	/** Set only for status "permission_needed": the requested out-of-sandbox path. */
	permissionPath?: string;
	/** True when the hard output budget was hit (sandbox killed). */
	outputLimitExceeded: boolean;
	logPaths?: { stdout: string; stderr: string };
	/** False when the saved log was cut off by the hard output limit. */
	logComplete: boolean;
	diagnostic?: string;
}

export interface StatusReport {
	available: boolean | "unverified";
	depDiagnostic?: string;
	workerRunning: boolean;
	generation: number;
	lastResetReason?: string;
	/** Effective worker workspace, overlays never write through to the host. */
	workspaceMode: "overlay" | "read-only" | "raw";
	/** Host read-root directories mounted read-only 1:1. */
	readRoots: string[];
	limits: Record<string, unknown>;
	paths: {
		projectDir?: string;
		sandboxProject: string;
		scratchDir?: string;
		sandboxScratch: string;
		logDir?: string;
	};
}

/** Shared byte budget across both output streams of one execution. */
interface SharedBudget {
	remaining: number;
}

/**
 * Bounded, streaming capture of one output pipe. Bytes stream into a log file
 * while a bounded head+tail excerpt stays in memory. There is no unbounded
 * buffer: once the shared budget is exhausted push() reports overflow and the
 * caller kills the sandbox.
 */
class StreamCapture {
	headBuf: Buffer = Buffer.alloc(0);
	tailBuf: Buffer = Buffer.alloc(0);
	totalBytes = 0;
	headFull = false;
	readonly label: string;
	private readonly sink: fs.WriteStream | null;
	private readonly budget: SharedBudget;

	constructor(label: string, sink: fs.WriteStream | null, budget: SharedBudget) {
		this.label = label;
		this.sink = sink;
		this.budget = budget;
	}

	push(chunk: Buffer): boolean {
		if (chunk.length === 0) return true;
		const allowed = Math.min(chunk.length, this.budget.remaining);
		if (allowed <= 0) return false;
		this.budget.remaining -= allowed;
		const part = chunk.subarray(0, allowed);
		this.sink?.write(part);
		this.totalBytes += part.length;
		const headLimit = LIMITS.captureHeadBytes;
		const tailLimit = LIMITS.captureTailBytes;
		if (!this.headFull) {
			const room = headLimit - this.headBuf.length;
			if (part.length <= room) {
				this.headBuf = Buffer.concat([this.headBuf, part]);
			} else {
				this.headBuf = Buffer.concat([this.headBuf, part.subarray(0, room)]);
				this.headFull = true;
				this.pushTail(part.subarray(room));
			}
		} else {
			this.pushTail(part);
		}
		return allowed === chunk.length;
	}

	private pushTail(part: Buffer) {
		const tailLimit = LIMITS.captureTailBytes;
		let buf = this.tailBuf.length === 0 ? part : Buffer.concat([this.tailBuf, part]);
		if (buf.length > tailLimit) {
			buf = buf.subarray(buf.length - tailLimit);
		}
		this.tailBuf = buf;
	}

	/** In-memory excerpt; an omission marker reports what is not kept. */
	excerpt(): { text: string; truncated: boolean } {
		const keep = LIMITS.captureHeadBytes + LIMITS.captureTailBytes;
		if (this.totalBytes <= keep) {
			const text = Buffer.concat([this.headBuf, this.tailBuf]).toString("utf8");
			return { text, truncated: false };
		}
		const omitted = this.totalBytes - this.headBuf.length - this.tailBuf.length;
		const text =
			this.headBuf.toString("utf8") +
			`\n...[${omitted} bytes omitted; full stream in the log file]...\n` +
			this.tailBuf.toString("utf8");
		return { text, truncated: true };
	}
}

interface ExecutionRun {
	id: number;
	startedAt: bigint;
	stdout: StreamCapture;
	stderr: StreamCapture;
	logName: string | null;
	/** A forced-termination path has been chosen; late hooks are ignored. */
	terminating: boolean;
	/** A result frame arrived; execution completed from the worker's view. */
	gotResult: ResultFrame | null;
}

interface WorkerHandle {
	child: ChildProcess;
	done: Promise<{ error?: string }>;
	teardown: Promise<void> | null;
	teardownFailure: string | null;
	descendants: Set<number>;
	generation: number;
	/** Resolved once with the ready handshake outcome. */
	ready: Promise<{ ok: true } | { ok: false; diagnostic: string }>;
	readyOk: boolean;
	frames: FrameStream;
	/** Current execution, if any; pipe data outside a run is discarded. */
	run: ExecutionRun | null;
	expectedId: number | null;
	violation: string | null;
	/** Bounded stderr seen while idle (bwrap/worker crash messages). */
	idleStderr: string;
	idleStderrBytes: number;
	closed: boolean;
	closeDiagnostic: string;
	/** Hooks owned by the active execution; null while idle. */
	runCompletion: ((frame: ResultFrame) => void) | null;
	overflowAction: (() => void) | null;
	deathAction: ((diagnostic: string, reason: string) => void) | null;
}

/**
 * Walk the host /proc parent chain to find every live descendant of a pid.
 * Best-effort defense in depth: the primary mechanism is the pid namespace,
 * where killing bwrap (the namespace's pid 1) makes the kernel kill every
 * remaining process inside, including ones that called setsid().
 */
function collectDescendantPids(rootPid: number): number[] {
	const ppid = new Map<number, number>();
	try {
		for (const entry of fs.readdirSync("/proc")) {
			if (!/^\d+$/.test(entry)) continue;
			let stat: string;
			try {
				stat = fs.readFileSync(path.join("/proc", entry, "stat"), "utf8");
			} catch {
				continue;
			}
			const close = stat.lastIndexOf(")");
			if (close === -1) continue;
			const fields = stat.slice(close + 2).split(" ");
			const ppidValue = Number(fields[1]);
			if (Number.isFinite(ppidValue)) ppid.set(Number(entry), ppidValue);
		}
	} catch {
		return [];
	}
	const descendants: number[] = [];
	const stack = [rootPid];
	const seen = new Set<number>([rootPid]);
	while (stack.length > 0) {
		const current = stack.pop()!;
		for (const [pid, parent] of ppid) {
			if (parent === current && !seen.has(pid)) {
				seen.add(pid);
				descendants.push(pid);
				stack.push(pid);
			}
		}
	}
	return descendants;
}

export class NodeSessionController {
	readonly projectDir: string;
	readonly workspaceMode: ControllerOptions["workspaceMode"];
	readonly readRoots: readonly string[];
	private readonly options: ControllerOptions;
	private readonly scratchDir: string;
	private effectiveWorkspaceMode: StatusReport["workspaceMode"];
	private disposal: Promise<void> | null = null;
	private logDir: string | null = null;
	private dirsCreated = false;
	private worker: WorkerHandle | null = null;
	private generation = 0;
	private lastResetReason: string | null = null;
	private execSeq = 0;
	private lock: Promise<unknown> = Promise.resolve();
	private disposed = false;
	private deps: DependencyCheck | null = null;

	constructor(options: ControllerOptions) {
		this.projectDir = fs.realpathSync(options.projectDir);
		this.workspaceMode = options.workspaceMode;
		this.readRoots = [...options.readRoots ?? []];
		this.scratchDir = path.resolve(options.scratchDir);
		this.options = { ...options, projectDir: this.projectDir, scratchDir: this.scratchDir, runtimeDir: path.resolve(options.runtimeDir) };
		this.effectiveWorkspaceMode = options.workspaceMode === "none" ? "raw" : options.workspaceMode === "ro" || options.detection?.mode === "reduced" ? "read-only" : "overlay";
	}

	/** Serialize execution, reset, status, and shutdown against each other. */
	private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.lock.then(fn, fn);
		this.lock = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	// ── Public interface ────────────────────────────────────────────────────

	/**
	 * Execute code in the persistent interpreter. Never replays code: if the
	 * worker is gone, a fresh one starts with empty state.
	 */
	execute(
		code: string,
		timeoutSeconds: number | undefined,
		signal: AbortSignal | undefined,
	): Promise<ExecutionResult> {
		return this.runExclusive(() => this.executeInner(code, timeoutSeconds, signal));
	}

	/** Kill the sandbox and interpreter state; keep scratch; do not restart. */
	async reset(): Promise<void> {
		await this.runExclusive(async () => {
			if (this.disposed) return;
			if (this.worker) {
				await this.killSandbox(this.worker, "explicit_reset");
				this.worker = null;
			}
			this.lastResetReason = "explicit_reset";
		});
	}

	/** Passive report; never starts a worker or spawns anything. */
	async status(): Promise<StatusReport> {
		await this.lock.then(
			() => undefined,
			() => undefined,
		);
		const limits: Record<string, unknown> = {
			maxCodeBytes: LIMITS.maxCodeBytes,
			defaultTimeoutSeconds: LIMITS.defaultTimeoutSeconds,
			maxTimeoutSeconds: LIMITS.maxTimeoutSeconds,
			outputBudgetBytes: LIMITS.outputBudgetBytes,
			maxReprBytes: LIMITS.maxReprBytes,
			maxFrameBytes: LIMITS.maxFrameBytes,
			rlimitAsBytes: LIMITS.rlimitAsBytes,
			rlimitFsizeBytes: LIMITS.rlimitFsizeBytes,
			rlimitNofile: LIMITS.rlimitNofile,
			coreDumps: "disabled",
			note: "Per-process/per-file limits and per-execution budgets only; no aggregate memory, process, or disk quotas.",
		};
		return {
			available: this.deps ? this.deps.ok : "unverified",
			depDiagnostic: this.deps && !this.deps.ok ? this.deps.diagnostic : undefined,
			workerRunning: this.worker !== null && !this.worker.closed,
			generation: this.generation,
			lastResetReason: this.lastResetReason ?? undefined,
			workspaceMode: this.effectiveWorkspaceMode,
			readRoots: [...this.readRoots],
			limits: this.workspaceMode === "none" ? {
				maxCodeBytes: LIMITS.maxCodeBytes, defaultTimeoutSeconds: LIMITS.defaultTimeoutSeconds,
				maxTimeoutSeconds: LIMITS.maxTimeoutSeconds, outputBudgetBytes: LIMITS.outputBudgetBytes,
				maxReprBytes: LIMITS.maxReprBytes, maxFrameBytes: LIMITS.maxFrameBytes,
				note: "Raw execution: no sandbox resource limits or V8 heap cap.",
			} : limits,
			paths: {
				projectDir: this.projectDir,
				sandboxProject: this.projectDir,
				scratchDir: this.scratchDir,
				sandboxScratch: this.scratchDir,
				logDir: this.logDir ?? undefined,
			},
		};
	}

	/** Preempt outside the lock. Shared scratch and runtime logs belong to runtime. */
	dispose(reason: string): Promise<void> {
		if (this.disposal) return this.disposal;
		this.disposed = true;
		const pending = (async () => {
			const dying = this.worker;
			if (dying) {
				await this.killSandbox(dying, reason);
				if (this.worker === dying) this.worker = null;
			}
			await this.runExclusive(async () => {
				if (this.worker) {
					await this.killSandbox(this.worker, reason);
					this.worker = null;
				}
				this.lastResetReason = reason;
			});
		})();
		this.disposal = pending;
		void pending.then(() => { this.disposal = null; }, () => { this.disposal = null; });
		return pending;
	}

	// ── Execution ───────────────────────────────────────────────────────────

	private async executeInner(
		code: string,
		timeoutSeconds: number | undefined,
		signal: AbortSignal | undefined,
	): Promise<ExecutionResult> {
		if (this.disposed) {
			return this.staticResult("unavailable", "The node session was disposed; no interpreter is available.", {
				stateLost: false,
			});
		}
		if (signal?.aborted) {
			// Already aborted: do not start or touch a worker.
			return this.staticResult("cancelled", "Aborted before execution; no worker was started.", {
				stateLost: false,
			});
		}
		if (Buffer.byteLength(code, "utf8") > LIMITS.maxCodeBytes) {
			return this.staticResult("unavailable", `Code exceeds the ${LIMITS.maxCodeBytes} byte limit.`, {
				stateLost: false,
			});
		}
		const timeoutSec = Math.min(
			Math.max(1, Number.isFinite(timeoutSeconds) ? timeoutSeconds! : LIMITS.defaultTimeoutSeconds),
			LIMITS.maxTimeoutSeconds,
		);

		const started = await this.ensureWorker();
		if (!started.ok) {
			return this.staticResult(started.status, started.diagnostic, { stateLost: false });
		}
		if (signal?.aborted) {
			// Aborted while the worker was starting: kill it, nothing else ran.
			await this.killSandbox(started.handle, "cancelled");
			this.worker = null;
			return this.staticResult(
				"cancelled",
				"Aborted while the worker was starting; interpreter state was discarded.",
				{ stateLost: true, stateLostReason: "cancelled during startup" },
			);
		}
		return this.runExecution(started.handle, code, timeoutSec, signal);
	}

	private staticResult(
		status: ExecutionStatus,
		diagnostic: string,
		overrides: Partial<ExecutionResult>,
	): ExecutionResult {
		return {
			status,
			durationMs: 0,
			generation: this.generation,
			stdout: "",
			stderr: "",
			excerptTruncated: false,
			repr: null,
			reprTruncated: false,
			exception: null,
			stateLost: true,
			outputLimitExceeded: false,
			logComplete: true,
			diagnostic,
			...overrides,
		};
	}

	private runExecution(
		handle: WorkerHandle,
		code: string,
		timeoutSec: number,
		signal: AbortSignal | undefined,
	): Promise<ExecutionResult> {
		const id = ++this.execSeq;
		const startedAt = process.hrtime.bigint();
		const budget: SharedBudget = { remaining: LIMITS.outputBudgetBytes };
		const logName = `${String(id).padStart(4, "0")}-${Date.now()}`;
		const logStdout = this.openLog(logName, "out");
		const logStderr = this.openLog(logName, "err");

		const run: ExecutionRun = {
			id,
			startedAt,
			stdout: new StreamCapture("stdout", logStdout, budget),
			stderr: new StreamCapture("stderr", logStderr, budget),
			logName: logStdout && logStderr ? logName : null,
			terminating: false,
			gotResult: null,
		};

		return new Promise<ExecutionResult>((resolvePromise) => {
			let finished = false;
			let deadlineTimer: NodeJS.Timeout | null = setTimeout(() => {
				forceKill("timeout", `Execution exceeded the ${timeoutSec}s deadline and was killed.`, "timeout");
			}, timeoutSec * 1000);

			const closeLogs = () => {
				logStdout?.end();
				logStderr?.end();
			};

			const resolve = (result: ExecutionResult) => {
				if (finished) return;
				finished = true;
				if (deadlineTimer) {
					clearTimeout(deadlineTimer);
					deadlineTimer = null;
				}
				signal?.removeEventListener("abort", onAbort);
				handle.run = null;
				handle.expectedId = null;
				handle.runCompletion = null;
				handle.overflowAction = null;
				handle.deathAction = null;
				closeLogs();
				resolvePromise(result);
			};

			const assemble = (partial: Partial<ExecutionResult>): ExecutionResult => {
				const out = run.stdout.excerpt();
				const err = run.stderr.excerpt();
				const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
				return {
					status: "worker_error",
					durationMs,
					generation: handle.generation,
					stdout: out.text,
					stderr: err.text,
					excerptTruncated: out.truncated || err.truncated,
					repr: null,
					reprTruncated: false,
					exception: null,
					stateLost: true,
					outputLimitExceeded: false,
					logPaths: run.logName
						? {
								stdout: path.join(this.logDir!, `${run.logName}-out.log`),
								stderr: path.join(this.logDir!, `${run.logName}-err.log`),
							}
						: undefined,
					logComplete: true,
					...partial,
				};
			};

			const forceKill = (status: ExecutionStatus, diagnostic: string, reason: string, extra?: Partial<ExecutionResult>) => {
				if (finished || run.terminating) return;
				run.terminating = true;
				void this.killSandbox(handle, reason).then(() => {
					resolve(assemble({ status, stateLost: true, stateLostReason: reason, diagnostic, ...extra }));
				}, (err: unknown) => {
					resolve(assemble({ status: "worker_error", stateLost: false, diagnostic: `Teardown failed: ${err instanceof Error ? err.message : String(err)}`, ...extra }));
				});
			};

			const onAbort = () => {
				forceKill(
					"cancelled",
					"Execution was cancelled; the sandbox was killed and interpreter state was lost.",
					"cancelled",
				);
			};
			signal?.addEventListener("abort", onAbort, { once: true });

			// Worker died or protocol broke. If a result frame already arrived,
			// keep its outcome but report the state loss honestly.
			handle.deathAction = (diagnostic: string, reason: string) => {
				if (finished || run.terminating) return;
				if (run.gotResult && !handle.violation) {
					const frame = run.gotResult;
					run.terminating = true;
					void (async () => {
						await this.killSandbox(handle, "worker_error");
						resolve(
							assemble({
								status: frame.status,
								permissionPath: frame.path,
								repr: frame.repr,
								reprTruncated: frame.reprTruncated,
								exception: frame.exception,
								stateLost: true,
								stateLostReason: `worker died after completing the execution: ${reason}`,
								diagnostic,
							}),
						);
					})().catch((err: unknown) => resolve(assemble({ status: "worker_error", stateLost: false, diagnostic: `Teardown failed: ${err instanceof Error ? err.message : String(err)}` })));
					return;
				}
				forceKill(
					"worker_error",
					`${diagnostic} Interpreter state was lost; a fresh interpreter starts on the next execution. Code is never replayed automatically.`,
					"worker_error",
				);
			};

			handle.overflowAction = () => {
				forceKill(
					"output_limit",
					"Output exceeded the per-execution capture budget; the sandbox was killed. The saved log is partial.",
					"output_limit",
					{ outputLimitExceeded: true, logComplete: false },
				);
			};

			handle.runCompletion = (frame: ResultFrame) => {
				if (finished || run.terminating) return;
				run.gotResult = frame;
				const finalize = () => {
					if (finished || run.terminating) return;
					resolve(
						assemble({
							status: frame.status,
							permissionPath: frame.path,
							repr: frame.repr,
							reprTruncated: frame.reprTruncated,
							exception: frame.exception,
							stateLost: false,
						}),
					);
				};
				if (frame.sandboxProcesses > 0) {
					// Something in the sandbox (a spawned subprocess, a re-parented
					// grandchild) may still write to the output pipes for a while.
					void drainQuiet(handle, frame.sandboxProcesses).then(finalize);
				} else {
					// No live processes, but the protocol pipe can still be
					// processed before pending stdout/stderr data events fire.
					// Drain briefly so trailing output stays with this execution.
					void drainQuiet(handle, 0).then(finalize);
				}
			};

			handle.run = run;
			handle.expectedId = id;

			// Send the request.
			try {
				handle.child.stdin!.write(encodeRequest({ type: "exec", protocol: PROTOCOL_VERSION, id, code }));
			} catch (err) {
				handle.deathAction?.(
					`Failed to write the request to the worker: ${err instanceof Error ? err.message : String(err)}`,
					"request delivery failed",
				);
			}
		});
	}

	// ── Worker lifecycle ────────────────────────────────────────────────────

	private async ensureWorker(): Promise<
		{ ok: true; handle: WorkerHandle } | { ok: false; status: ExecutionStatus; diagnostic: string }
	> {
		if (this.worker?.teardownFailure) {
			return { ok: false, status: "worker_error", diagnostic: `Unresolved worker teardown: ${this.worker.teardownFailure}` };
		}
		if (this.worker && !this.worker.closed && !this.worker.violation) return { ok: true, handle: this.worker };
		if (this.worker) {
			await this.killSandbox(this.worker, "worker_refresh");
			this.worker = null;
		}
		if (this.disposed) return { ok: false, status: "unavailable", diagnostic: "The node session was disposed." };
		if (!this.deps) this.deps = checkDependencies("node", this.options);
		if (!this.deps.ok) return { ok: false, status: "unavailable", diagnostic: this.deps.diagnostic ?? "dependencies unavailable" };
		await this.ensureDirs();
		if (this.disposed) return { ok: false, status: "unavailable", diagnostic: "Session disposed during startup." };
		const generation = ++this.generation;
		this.logDir = path.join(this.options.runtimeDir, "logs", "node-" + generation);
		await fsp.mkdir(this.logDir, { recursive: true, mode: 0o700 });
		if (this.disposed) return { ok: false, status: "unavailable", diagnostic: "Session disposed during startup." };
		let handle: WorkerHandle;
		try {
			handle = this.launchWorker(generation);
		} catch (err) {
			return { ok: false, status: "worker_error", diagnostic: `Worker launch failed: ${err instanceof Error ? err.message : String(err)}` };
		}
		this.worker = handle;
		let timer: NodeJS.Timeout | undefined;
		const ready = await Promise.race([
			handle.ready,
			new Promise<{ ok: false; diagnostic: string }>((resolve) => {
				timer = setTimeout(() => resolve({ ok: false, diagnostic: "Worker ready handshake timed out." }), LIMITS.startupTimeoutMs);
			}),
		]);
		clearTimeout(timer);
		if (!ready.ok || this.disposed || handle.closed || handle.violation) {
			await this.killSandbox(handle, "startup_failure");
			if (this.worker === handle) this.worker = null;
			return { ok: false, status: "worker_error", diagnostic: ready.ok ? "Worker stopped during startup." : ready.diagnostic };
		}
		return { ok: true, handle };
	}

	private launchWorker(generation: number): WorkerHandle {
		const deps = this.deps!;
		const workerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "worker.mjs");
		const launched = spawnWorker("node", this.options, deps, workerPath);
		this.effectiveWorkspaceMode = launched.workspaceMode;
		const child = launched.child;
		// Never let stdin EPIPE crash the process; execution paths handle it.
		child.stdin?.on("error", () => {});

		const handle: WorkerHandle = {
			child,
			done: launched.done,
			teardown: null,
			teardownFailure: null,
			descendants: new Set(),
			generation,
			ready: null as unknown as WorkerHandle["ready"],
			readyOk: false,
			frames: null as unknown as WorkerHandle["frames"],
			run: null,
			expectedId: null,
			violation: null,
			idleStderr: "",
			idleStderrBytes: 0,
			closed: false,
			closeDiagnostic: "",
			runCompletion: null,
			overflowAction: null,
			deathAction: null,
		};

		let readyResolve: ((r: { ok: true } | { ok: false; diagnostic: string }) => void) | null = null;
		handle.ready = new Promise((resolve) => {
			readyResolve = resolve;
		});
		const failReady = (diagnostic: string) => {
			if (!handle.readyOk) readyResolve?.({ ok: false, diagnostic });
		};

		handle.frames = new FrameStream((line) => {
			const decoded = decodeFrame(line);
			if (!decoded.ok) {
				this.noteViolation(handle, `invalid frame from worker: ${decoded.error}`);
				return;
			}
			this.dispatchFrame(handle, decoded.frame, readyResolve);
		});

		child.stdout?.on("data", (chunk: Buffer) => this.routeOutput(handle, "stdout", chunk));
		child.stderr?.on("data", (chunk: Buffer) => this.routeOutput(handle, "stderr", chunk));
		child.stdio[3]?.on("data", (chunk: Buffer) => {
			const violation = handle.frames.push(chunk);
			if (violation) this.noteViolation(handle, violation);
		});
		child.stdio[3]?.on("error", () => {});

		child.on("error", (err) => {
			handle.closeDiagnostic = `worker spawn failed: ${err.message}`;
			failReady(handle.closeDiagnostic);
			this.noteWorkerExit(handle);
		});
		child.on("close", (exitCode) => {
			handle.closed = true;
			if (!handle.closeDiagnostic) {
				handle.closeDiagnostic = `worker exited unexpectedly (code ${exitCode ?? "signal"})`;
			}
			failReady(handle.closeDiagnostic);
			this.noteWorkerExit(handle);
		});

		return handle;
	}

	private dispatchFrame(
		handle: WorkerHandle,
		frame: WorkerFrame,
		readyResolve: ((r: { ok: true } | { ok: false; diagnostic: string }) => void) | null,
	) {
		switch (frame.type) {
			case "ready": {
				if (handle.readyOk) {
					this.noteViolation(handle, "duplicate ready frame");
					return;
				}
				if (!handle.readyOk) {
					if (!frame.runtimeVersion) {
						readyResolve?.({ ok: false, diagnostic: "worker sent a ready frame without a version" });
						return;
					}
					handle.readyOk = true;
					readyResolve?.({ ok: true });
				}
				return;
			}
			case "result": {
				if (handle.run === null || handle.expectedId === null) {
					this.noteViolation(handle, "worker sent a result while no execution was pending");
					return;
				}
				if (frame.id !== handle.expectedId) {
					this.noteViolation(handle, `mismatched result id ${frame.id}; expected ${handle.expectedId}`);
					return;
				}
				if (handle.run.gotResult) {
					this.noteViolation(handle, `duplicate result frame for id ${frame.id}`);
					return;
				}
				handle.runCompletion?.(frame);
				return;
			}
			case "error": {
				if (!handle.readyOk) {
					// Startup-phase error (e.g. security setup failed): fail closed.
					readyResolve?.({ ok: false, diagnostic: `worker startup failed: ${frame.message}` });
					return;
				}
				this.noteViolation(handle, `worker reported a protocol error: ${frame.message}`);
				return;
			}
		}
	}

	private routeOutput(handle: WorkerHandle, stream: "stdout" | "stderr", chunk: Buffer) {
		const run = handle.run;
		if (run) {
			const capture = stream === "stdout" ? run.stdout : run.stderr;
			const ok = capture.push(chunk);
			if (!ok) {
				const action = handle.overflowAction;
				handle.overflowAction = null; // fire once
				action?.();
			}
			return;
		}
		if (stream === "stderr") {
			// Bounded idle diagnostics (bwrap failures, worker crash messages).
			const room = 4096 - handle.idleStderrBytes;
			if (room > 0) {
				const part = chunk.subarray(0, room);
				handle.idleStderr += part.toString("utf8");
				handle.idleStderrBytes += part.length;
			}
		}
		// stdout with no active run is discarded: it cannot be attributed.
	}

	private noteViolation(handle: WorkerHandle, message: string) {
		if (handle.violation) return;
		handle.violation = message;
		if (!handle.run) {
			void this.killSandbox(handle, "protocol_violation").catch(() => {});
		}
		handle.deathAction?.(
			`Protocol violation: ${message}. The sandbox was killed.`,
			`protocol violation: ${message}`,
		);
	}

	private noteWorkerExit(handle: WorkerHandle) {
		if (handle.violation) return; // a violation already owns the teardown narrative
		const detail = handle.closeDiagnostic + (handle.idleStderr.trim() ? `: ${handle.idleStderr.trim()}` : "");
		handle.deathAction?.(`Worker died: ${detail}.`, "worker died");
	}

	// ── Teardown ────────────────────────────────────────────────────────────

	/**
	 * Kill the whole sandbox and wait (bounded) for it to die. Uses the process
	 * group (the worker is a session leader), a /proc descendant sweep, and the
	 * pid namespace: when bwrap (the namespace's pid 1) dies, the kernel kills
	 * every remaining process inside, including ones that called setsid().
	 */
	private killSandbox(handle: WorkerHandle, reason: string): Promise<void> {
		if (handle.teardown) return handle.teardown;
		const pending = this.stopWorker(handle, reason);
		handle.teardown = pending;
		void pending.then(() => {
			handle.teardownFailure = null;
		}, (err: unknown) => {
			handle.teardownFailure = err instanceof Error ? err.message : String(err);
			handle.teardown = null;
		});
		return pending;
	}

	private async stopWorker(handle: WorkerHandle, reason: string): Promise<void> {
		const pid = handle.child.pid;
		if (pid !== undefined && !handle.closed) {
			for (const descendant of collectDescendantPids(pid)) handle.descendants.add(descendant);
			try { process.kill(-pid, "SIGKILL"); } catch { /* group may already be gone */ }
			try { handle.child.kill("SIGKILL"); } catch { /* already dead */ }
		}
		for (const victim of handle.descendants) {
			try { process.kill(victim, "SIGKILL"); } catch { /* already dead */ }
		}
		const deadline = Date.now() + LIMITS.cleanupTimeoutMs;
		while (!handle.closed || [...handle.descendants].some(isLiveProcess)) {
			if (Date.now() >= deadline) throw new Error("Worker teardown timed out; process handles retained.");
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		let timer: NodeJS.Timeout | undefined;
		try {
			const completion = await Promise.race([
				handle.done,
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error("Worker cleanup timed out; process handles retained.")), Math.max(1, deadline - Date.now()));
				}),
			]);
			if (completion.error && pid !== undefined) throw new Error(completion.error);
		} finally {
			clearTimeout(timer);
		}
		this.lastResetReason = reason;
	}

	// ── Directories and logs ────────────────────────────────────────────────

	private async ensureDirs(): Promise<void> {
		if (this.dirsCreated) return;
		await fsp.mkdir(this.scratchDir, { recursive: true, mode: 0o700 });
		await fsp.mkdir(this.options.runtimeDir, { recursive: true, mode: 0o700 });
		this.dirsCreated = true;
	}

	private openLog(base: string, suffix: "out" | "err"): fs.WriteStream | null {
		if (!this.logDir) return null;
		try {
			const sink = fs.createWriteStream(path.join(this.logDir, `${base}-${suffix}.log`), { flags: "w" });
			sink.on("error", () => {});
			return sink;
		} catch {
			return null;
		}
	}
}

/*
 * After a result frame, the output pipes may still hold undelivered data:
 * the protocol pipe and the output pipes are separate, and the result frame
 * can be processed before pending stdout/stderr data events fire. Always
 * drain briefly so trailing output stays with its own execution; when live
 * sandbox processes exist, give them the full window to start writing.
 * Output that arrives after the window ends is discarded.
 */
async function drainQuiet(handle: WorkerHandle, sandboxProcesses: number): Promise<void> {
	const deadline = Date.now() + LIMITS.drainMaxMs;
	if (sandboxProcesses > 0) {
		await waitForPipeActivity(handle, Math.max(0, deadline - Date.now()));
	}
	const quietMs = sandboxProcesses > 0 ? LIMITS.drainQuietMs : LIMITS.drainQuietIdleMs;
	for (;;) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) return;
		const sawData = await waitForPipeActivity(handle, Math.min(quietMs, remaining));
		if (!sawData) return;
	}
}

/** Resolve true if any output byte arrives within timeoutMs, false on quiet timeout. */
function waitForPipeActivity(handle: WorkerHandle, timeoutMs: number): Promise<boolean> {
	if (timeoutMs <= 0) return Promise.resolve(false);
	return new Promise((resolve) => {
		let done = false;
		const finish = (value: boolean) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			handle.child.stdout?.off("data", onStdout);
			handle.child.stderr?.off("data", onStderr);
			resolve(value);
		};
		const onStdout = () => finish(true);
		const onStderr = () => finish(true);
		const timer = setTimeout(() => finish(false), timeoutMs);
		handle.child.stdout?.once("data", onStdout);
		handle.child.stderr?.once("data", onStderr);
	});
}

/** Zombies no longer hold pipes or execute code. Descendant checks are best effort. */
function isLiveProcess(pid: number): boolean {
	try {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
	} catch {
		return false;
	}
}
