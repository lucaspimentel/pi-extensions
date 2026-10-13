/**
 * git-read child-process layer.
 *
 * Implements the "Worktree enforcement", "Trust model for config, env, and
 * helpers", and "Resource limits and failure contract" sections of
 * docs/git-read-design.md: sanitized environment, worktree toplevel check,
 * async spawn (argv-array, no shell) with continuous drain, byte-capped
 * retention, timeout SIGTERM->SIGKILL escalation, and reaping before return.
 *
 * This module never throws: every failure becomes a failed GitRunResult with
 * a `git_read: `-prefixed message (index.ts wraps result.text verbatim and
 * does not add its prefix to spawn errors). argv is consumed verbatim from
 * validate.ts; nothing is appended here.
 */

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

import { GLOBAL_OPTIONS } from "./validate.ts";

/** Shared stdout+stderr cap in bytes; matches PER_TASK_OUTPUT_CAP (extensions/subagent/index.ts:42). */
export const OUTPUT_CAP = 50 * 1024;

export const TIMEOUT_MS = 15_000;

/** Delay before escalating SIGTERM to SIGKILL after a timeout. */
export const KILL_ESCALATION_MS = 5_000;

/** Stripped from the inherited environment before spawn. */
export const STRIPPED_ENV = [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_COMMON_DIR",
	"GIT_NAMESPACE",
	"GIT_CONFIG_COUNT",
	"GIT_EXTERNAL_DIFF",
] as const;

/**
 * Environment values injected after stripping, so they win over anything
 * inherited. Per the design's trust model: no pager, no prompts, no askpass
 * helpers, and system/global git configs nulled (repo config still applies;
 * the -c overrides from GLOBAL_OPTIONS win over it).
 */
export const INJECTED_ENV = {
	GIT_PAGER: "cat",
	GIT_TERMINAL_PROMPT: "0",
	GIT_ASKPASS: "echo",
	GIT_CONFIG_SYSTEM: "/dev/null",
	GIT_CONFIG_GLOBAL: "/dev/null",
} as const;

export interface GitRunResult {
	ok: boolean;
	text: string;
}

/**
 * Inherited environment minus STRIPPED_ENV, plus INJECTED_ENV assigned last
 * so the injected values always win. Everything else (PATH, HOME, locale) is
 * inherited untouched.
 */
export function buildChildEnv(): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = { ...process.env };
	for (const key of STRIPPED_ENV) delete env[key];
	Object.assign(env, INJECTED_ENV);
	return env;
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

type SpawnFunction = typeof spawn;
let spawnOverride: SpawnFunction | null = null;

/** Test seam: capture child argv/env/options and control spawn timing. */
export function setSpawnOverride(fn: SpawnFunction | null): void {
	spawnOverride = fn;
}

/** Outcome of one bounded git execution. Never throws; see execGit. */
interface ExecOutcome {
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
 * Bounded, shell-free execution of one git invocation. Both streams are
 * drained continuously (the child never blocks on backpressure) while only
 * the first OUTPUT_CAP bytes across the two streams combined are retained.
 * On timeout the child gets SIGTERM, then SIGKILL after KILL_ESCALATION_MS,
 * and is reaped (close/error) before this promise resolves. git under
 * GIT_PAGER=cat with fsmonitor off and nulled configs does not spawn
 * descendants, so plain child kill suffices; no process-group kill.
 */
function execGit(argv: readonly string[], cwd: string): Promise<ExecOutcome> {
	return new Promise((resolvePromise) => {
		const spawnFn = spawnOverride ?? spawn;
		let child: ReturnType<typeof spawn>;
		try {
			child = spawnFn("git", [...argv], {
				cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: buildChildEnv(),
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

/** Runs the read command's worktree gate; the design's single failure message. */
async function worktreeCheckPassed(cwd: string): Promise<boolean> {
	const outcome = await execGit([...GLOBAL_OPTIONS, "rev-parse", "--show-toplevel"], cwd);
	if (outcome.spawnError !== undefined || outcome.timedOut || outcome.code !== 0) return false;
	const toplevel = outcome.stdout.trim();
	if (toplevel.length === 0) return false;
	return cwdInsideToplevel(cwd, toplevel);
}

/**
 * Runs one validated git argv in `cwd` under the design's sanitized
 * environment and resource limits. Composes the worktree gate, the bounded
 * exec core, and the failure contract into a result that never throws.
 */
export async function runGit(argv: readonly string[], cwd: string): Promise<GitRunResult> {
	const gatePassed = await worktreeCheckPassed(cwd);
	if (!gatePassed) {
		return { ok: false, text: "git_read: not inside a git worktree" };
	}

	const outcome = await execGit(argv, cwd);

	let text: string;
	if (outcome.spawnError !== undefined) {
		text = `git_read: failed to run git: ${outcome.spawnError}`;
	} else if (outcome.timedOut) {
		const collected = [outcome.stderr, outcome.stdout].filter((part) => part.length > 0).join("\n");
		text = `git_read: git timed out after ${TIMEOUT_MS} ms${collected.length > 0 ? `\n${collected}` : ""}`;
	} else if (outcome.code !== 0) {
		text = `git_read: git exited with code ${outcome.code}\n${outcome.stderr}${outcome.stdout}`;
	} else {
		text = outcome.stdout;
	}
	if (outcome.truncated) {
		text += `\n[git_read: output truncated, showing ${outcome.retainedBytes} of ${outcome.totalBytes} bytes]`;
	}

	return { ok: outcome.code === 0 && outcome.spawnError === undefined && !outcome.timedOut, text };
}
