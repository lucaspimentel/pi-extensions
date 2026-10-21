/**
 * gh-read dual-window log runner.
 *
 * Used ONLY for log-carrying invocations: a validated `run view` argv that
 * accepted `--log` or `--log-failed` (the structured `logMode` state from
 * validate.ts). Log output can be enormous, so instead of the shared
 * boundedExec core (single 50 KiB cap across both streams) this runner keeps
 * the FIRST 50 KiB and the LAST 50 KiB of stdout and drops the middle, so
 * both the beginning and the end of a run's log survive. The bounds here are
 * a CAPTURED-OUTPUT bound, never a bound on gh's internal zip download or
 * temp storage: gh may still fetch the full archive internally; this tool
 * only ever retains at most 100 KiB of stdout plus a separate 50 KiB stderr
 * head cap for failure diagnostics.
 *
 * `extensions/shared/bounded-spawn.ts` is deliberately UNCHANGED: this
 * runner is gh-read-local because its bounds (30 s timeout, dual windows)
 * differ from the shared 15 s / 50 KiB contract that git-read and the
 * non-log gh-read paths rely on.
 *
 * Timeout is 30 s (gh's zip fetch plus the per-job API fallback described in
 * `gh run view --help` can be slow; this matches the API runner's shared
 * deadline). SIGTERM, then SIGKILL after KILL_ESCALATION_MS. Cancellation
 * kills the child the same way. The promise resolves only after the child
 * is reaped (close/error), matching the reaping parity of the other runners.
 *
 * The spawn function is an injectable seam (its own seam, deliberately
 * independent of the shared setSpawnOverride used by the worktree gate and
 * the native tests), keeping this module testable network-free.
 */

import { spawn } from "node:child_process";
import { buildGhEnv, worktreeCheckPassed, type GhRunResult } from "./spawn.ts";
import { KILL_ESCALATION_MS, OUTPUT_CAP } from "../shared/bounded-spawn.ts";
import { defaultClock, type ApiClock } from "./api-spawn.ts";

/** Log runs may need gh's zip fetch plus the per-job API fallback. */
export const LOG_TIMEOUT_MS = 30_000;

/** Stdout head window: the first 50 KiB of the log. */
export const LOG_HEAD_CAP = OUTPUT_CAP;
/** Stdout tail window: the last 50 KiB of the log. */
export const LOG_TAIL_CAP = OUTPUT_CAP;
/** Separate stderr head cap so failure diagnostics are never starved by log bytes. */
export const LOG_STDERR_CAP = OUTPUT_CAP;

type SpawnFunction = typeof spawn;
let spawnOverride: SpawnFunction | null = null;

/** Test seam: capture child argv/env/options and control spawn timing. */
export function setLogSpawnOverride(fn: SpawnFunction | null): void {
	spawnOverride = fn;
}

/** Removes trailing bytes of an incomplete multibyte UTF-8 sequence. */
function trimTrailingIncomplete(buf: Buffer): Buffer {
	if (buf.length === 0) return buf;
	let start = buf.length - 1;
	const limit = Math.max(0, buf.length - 4);
	while (start > limit && (buf[start]! & 0xc0) === 0x80) start -= 1;
	const lead = buf[start]!;
	if ((lead & 0xc0) === 0xc0) {
		const expected = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : 2;
		if (buf.length - start < expected) return buf.subarray(0, start);
	}
	return buf;
}

/** Removes leading continuation bytes of a character split at the window edge. */
function trimLeadingContinuation(buf: Buffer): Buffer {
	let start = 0;
	while (start < buf.length && start < 3 && (buf[start]! & 0xc0) === 0x80) start += 1;
	return buf.subarray(start);
}

/**
 * Runs one validated log-carrying gh argv under the dual-window capture
 * bounds. Pre-spawn: the abort check (zero spawns when already cancelled)
 * and the worktree gate; the gate applies even though `run view` accepts
 * `-R` (settled one-simple-contract rule). Never throws.
 */
export async function runGhLog(argv: readonly string[], cwd: string, signal: AbortSignal | undefined, clock: ApiClock = defaultClock): Promise<GhRunResult> {
	if (signal?.aborted) {
		return { ok: false, text: "gh_read: gh run log fetch cancelled before spawn" };
	}
	if (!(await worktreeCheckPassed(cwd))) {
		return { ok: false, text: "gh_read: not inside a git worktree" };
	}

	const spawnFn = spawnOverride ?? spawn;
	let child: ReturnType<typeof spawn>;
	try {
		child = spawnFn("gh", [...argv], {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			env: buildGhEnv(),
			windowsHide: true,
		});
	} catch (err) {
		return { ok: false, text: `gh_read: failed to run gh: ${err instanceof Error ? err.message : String(err)}` };
	}

	return await new Promise<GhRunResult>((resolvePromise) => {
		// Timeout via the clock seam (tests inject a controllable clock; the
		// production default is api-spawn.ts's defaultClock).

		// Head window: immutable first 50 KiB. Tail window: rolling last 50
		// KiB, oldest bytes dropped from the front as new ones arrive. Bytes
		// in neither window are counted (dropped), never buffered.
		const headChunks: Buffer[] = [];
		let headBytes = 0;
		const tailChunks: Buffer[] = [];
		let tailBytes = 0;
		let total = 0;

		const stderrChunks: Buffer[] = [];
		let stderrBytes = 0;

		child.stdout?.on("data", (chunk: Buffer) => {
			total += chunk.length;
			if (headBytes < LOG_HEAD_CAP) {
				const keep = chunk.subarray(0, LOG_HEAD_CAP - headBytes);
				headChunks.push(keep);
				headBytes += keep.length;
			}
			tailChunks.push(chunk);
			tailBytes += chunk.length;
			while (tailBytes > LOG_TAIL_CAP) {
				const first = tailChunks[0]!;
				const excess = tailBytes - LOG_TAIL_CAP;
				if (first.length <= excess) {
					tailChunks.shift();
					tailBytes -= first.length;
				} else {
					tailChunks[0] = first.subarray(excess);
					tailBytes = LOG_TAIL_CAP;
				}
			}
		});

		// Same retain-then-count-and-drop shape as boundedExec's drain.
		child.stderr?.on("data", (chunk: Buffer) => {
			if (stderrBytes >= LOG_STDERR_CAP) return;
			const keep = chunk.subarray(0, LOG_STDERR_CAP - stderrBytes);
			stderrChunks.push(keep);
			stderrBytes += keep.length;
		});

		let timedOut = false;
		let cancelled = false;
		let escalation: unknown;
		const teardown = (hard: boolean): void => {
			try {
				child.kill(hard ? "SIGKILL" : "SIGTERM");
			} catch {
				// ESRCH: already exited.
			}
		};

		const timeoutHandle = clock.setTimeout(() => {
			timedOut = true;
			teardown(false);
			escalation = clock.setTimeout(() => teardown(true), KILL_ESCALATION_MS);
		}, LOG_TIMEOUT_MS);

		const onAbort = (): void => {
			cancelled = true;
			teardown(false);
			escalation = clock.setTimeout(() => teardown(true), KILL_ESCALATION_MS);
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		let settled = false;
		const finish = (code: number | null, spawnError?: string): void => {
			if (settled) return;
			settled = true;
			clock.clearTimeout(timeoutHandle);
			if (escalation !== undefined) clock.clearTimeout(escalation);
			signal?.removeEventListener("abort", onAbort);

			if (spawnError !== undefined) {
				resolvePromise({ ok: false, text: `gh_read: failed to run gh: ${spawnError}` });
				return;
			}

			// Window construction from SOURCE byte counts. When everything
			// fits both windows overlap entirely and the full byte sequence
			// is reconstructed and decoded ONCE (byte-identical to the
			// child's stdout, dropped = 0).
			const headLen = Math.min(total, LOG_HEAD_CAP);
			const tailLen = Math.min(total, LOG_TAIL_CAP);
			const headBuf = Buffer.concat(headChunks);
			const tailBuf = Buffer.concat(tailChunks);
			let stdoutText: string;
			let dropped = 0;
			if (total <= headLen + tailLen) {
				const overlap = headLen + tailLen - total;
				stdoutText = Buffer.concat([headBuf.subarray(0, headLen), tailBuf.subarray(overlap)]).toString("utf8");
			} else {
				dropped = total - headLen - tailLen;
				// UTF-8-safe window edges: trim incomplete sequences at the
				// boundaries so no U+FFFD is introduced by slicing. Edge-trim
				// bytes (at most 3 per edge) are decode hygiene and are not
				// counted in the notice; the count N describes discarded
				// SOURCE bytes only.
				const headText = trimTrailingIncomplete(headBuf.subarray(0, headLen)).toString("utf8");
				const tailWindow = trimTrailingIncomplete(trimLeadingContinuation(tailBuf.subarray(tailBuf.length - tailLen)));
				const tailText = tailWindow.toString("utf8");
				stdoutText = `${headText}\n[gh_read: ${dropped} bytes omitted, showing first and last 50 KiB]\n${tailText}`;
			}

			const stderr = Buffer.concat(stderrChunks).toString("utf8");
			if (cancelled) {
				resolvePromise({ ok: false, text: `gh_read: gh run log fetch cancelled\n${stderr}\n${stdoutText}` });
				return;
			}
			if (timedOut) {
				resolvePromise({ ok: false, text: `gh_read: gh timed out after ${LOG_TIMEOUT_MS} ms\n${stderr}\n${stdoutText}` });
				return;
			}
			if (code !== 0) {
				resolvePromise({ ok: false, text: `gh_read: gh exited with code ${code}\n${stderr}\n${stdoutText}` });
				return;
			}
			resolvePromise({ ok: true, text: stdoutText });
		};

		child.on("error", (err: Error) => {
			finish(null, err.message);
		});
		child.on("close", (code) => {
			finish(code);
		});
	});
}
