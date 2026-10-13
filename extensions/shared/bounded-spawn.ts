/**
 * Shared bounded-exec core.
 *
 * Both `git-read` and `gh-read` spawn one allowlisted, shell-free child
 * command under the same resource limits: continuous drain of both streams
 * (the child never blocks on backpressure), byte-capped retention, timeout
 * with SIGTERM->SIGKILL escalation, and reaping before the promise resolves.
 * This module holds that core, parameterized on the binary, argv, and a
 * caller-prepared environment; each tool's own spawn layer builds its env
 * from its own strip/inject tables and composes this core with its gate and
 * failure contract.
 *
 * Imports are child_process/fs/path only (no pi runtime), so this module is
 * safe to import from a plain JS test runner via type-stripping.
 */

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

/** Shared stdout+stderr cap in bytes; matches PER_TASK_OUTPUT_CAP (extensions/subagent/index.ts:42). */
export const OUTPUT_CAP = 50 * 1024;

export const TIMEOUT_MS = 15_000;

/** Delay before escalating SIGTERM to SIGKILL after a timeout. */
export const KILL_ESCALATION_MS = 5_000;

type SpawnFunction = typeof spawn;
let spawnOverride: SpawnFunction | null = null;

/** Test seam: capture child argv/env/options and control spawn timing. */
export function setSpawnOverride(fn: SpawnFunction | null): void {
	spawnOverride = fn;
}

/** Outcome of one bounded execution. Never throws; see boundedExec. */
export interface ExecOutcome {
	code: number | null;
	signal: NodeJS.Signals | null;
	/** Set when spawn() itself threw or the child emitted `error`. */
	spawnError?: string;
	timedOut: boolean;
	stdout: string;
	stderr: string;
	truncated: boolean;
	totalBytes: number;
	retainedBytes: number;
}

/**
 * Bounded, shell-free execution of one command. Both streams are drained
 * continuously while only the first OUTPUT_CAP bytes across the two streams
 * combined are retained. On timeout the child gets SIGTERM, then SIGKILL
 * after KILL_ESCALATION_MS, and is reaped (close/error) before this promise
 * resolves. Callers must guarantee via their sanitized environment that the
 * child spawns no descendants, so plain child kill suffices; no
 * process-group kill.
 */
export function boundedExec(
	binary: string,
	argv: readonly string[],
	env: Record<string, string | undefined>,
	cwd: string,
): Promise<ExecOutcome> {
	return new Promise((resolvePromise) => {
		const spawnFn = spawnOverride ?? spawn;
		let child: ReturnType<typeof spawn>;
		try {
			child = spawnFn(binary, [...argv], {
				cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env,
				windowsHide: true,
			});
		} catch (err) {
			resolvePromise({
				code: null,
				signal: null,
				spawnError: err instanceof Error ? err.message : String(err),
				timedOut: false,
				stdout: "",
				stderr: "",
				truncated: false,
				totalBytes: 0,
				retainedBytes: 0,
			});
			return;
		}

		// Shared cap across both streams: bytes past the cap are counted and
		// dropped, never buffered. Each stream's retained slices are tracked
		// separately so stdout/stderr can be reported individually; their total
		// still respects OUTPUT_CAP. Chunks are decoded once at the end so a
		// multibyte UTF-8 character split across chunks survives intact.
		const retainedStdout: Buffer[] = [];
		const retainedStderr: Buffer[] = [];
		let totalBytes = 0;
		let retainedBytes = 0;
		let truncated = false;
		const drainInto = (target: Buffer[]) => (chunk: Buffer): void => {
			totalBytes += chunk.length;
			if (retainedBytes >= OUTPUT_CAP) {
				truncated = true;
				return;
			}
			const keep = chunk.subarray(0, OUTPUT_CAP - retainedBytes);
			target.push(keep);
			retainedBytes += keep.length;
			if (keep.length < chunk.length) truncated = true;
		};
		child.stdout?.on("data", drainInto(retainedStdout));
		child.stderr?.on("data", drainInto(retainedStderr));

		let timedOut = false;
		let escalationTimer: NodeJS.Timeout | undefined;
		const timeoutTimer = setTimeout(() => {
			timedOut = true;
			try {
				child.kill("SIGTERM");
			} catch {
				// ESRCH if the child already exited; nothing to do.
			}
			escalationTimer = setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} catch {
					// ESRCH tolerated for the same reason.
				}
			}, KILL_ESCALATION_MS);
		}, TIMEOUT_MS);

		// `error` and `close` can both fire (e.g. after a kill); resolve once.
		let settled = false;
		const finish = (code: number | null, signal: NodeJS.Signals | null, spawnError?: string): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timeoutTimer);
			if (escalationTimer !== undefined) clearTimeout(escalationTimer);
			resolvePromise({
				code,
				signal,
				...(spawnError !== undefined ? { spawnError } : {}),
				timedOut,
				stdout: Buffer.concat(retainedStdout).toString("utf8"),
				stderr: Buffer.concat(retainedStderr).toString("utf8"),
				truncated,
				totalBytes,
				retainedBytes,
			});
		};

		child.on("error", (err: Error) => {
			finish(null, null, err.message);
		});
		child.on("close", (code, signal) => {
			finish(code, signal);
		});
	});
}

/**
 * True when `cwd` is the toplevel itself or a path inside it. Both paths are
 * resolved (normalizing git's forward-slash output on Windows) and then
 * realpathed when possible, so a symlinked session cwd still matches the
 * toplevel git resolved; unresolved paths fall back to their resolved form.
 */
export function cwdInsideToplevel(cwd: string, toplevel: string): boolean {
	const cwdResolved = resolve(cwd);
	const topResolved = resolve(toplevel);
	let cwdReal = cwdResolved;
	let topReal = topResolved;
	try {
		cwdReal = realpathSync(cwdResolved);
	} catch {
		// Nonexistent or unreadable cwd: keep the resolved path as fallback.
	}
	try {
		topReal = realpathSync(topResolved);
	} catch {
		// Same for the toplevel; the comparison below still applies lexically.
	}
	return cwdReal === topReal || cwdReal.startsWith(topReal + sep);
}
