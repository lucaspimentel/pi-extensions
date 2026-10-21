/**
 * gh-read external jq filtering.
 *
 * Applies a caller-supplied jq expression to JSON data using the system jq
 * binary, fail-closed: jq is only invoked when the caller requested jq, and
 * only after three preflight gates complete BEFORE any network access:
 *
 *   1. Executable resolution: an absolute jq path is resolved from PATH.
 *   2. Expression safety: a lexical security check grounded in jq's grammar
 *      (not substring matching). The checker recognizes comments, strings,
 *      escapes, executable tokens, and nested string interpolation; rejects
 *      module/import/include constructs (including data imports); inspects
 *      executable code inside interpolations; permits benign property names
 *      and quoted keywords such as `.include` and `"include"`; and rejects
 *      malformed or unsupported lexical constructs instead of guessing.
 *   3. Compilation: jq itself compiles the expression against a null input
 *      (`jq -c -n <expr>`), so a syntax error never reaches the network.
 *
 * jq 1.7 loads no modules at startup (verified against the jq 1.7 manual and
 * source: module loading happens only via import/include in the program, and
 * startup reads no config file). Defense in depth is still applied: the jq
 * child gets a minimal environment with HOME overridden to a tool-owned
 * guard FILE (never a directory), so `~/.jq` and `$HOME/.jq` module search
 * locations are unusable. `-L` is never passed and no caller-controlled
 * flags, module paths, filter files, or input files are accepted: the
 * expression arrives as a single argv element and the document through
 * stdin. The jq binary's own directory ($ORIGIN search path) is a residual
 * path, accepted because writing there requires root and module canary tests
 * assert startup loads nothing.
 *
 * Output: compact JSON values separated by newlines (-c). Zero output is an
 * empty filtered result, not a failure. Output and stderr are bounded pipes
 * drained continuously under a shared monotonic deadline; the child is
 * killed, escalated, and reaped on deadline or cancellation.
 */

import { spawn } from "node:child_process";
import { closeSync, openSync, realpathSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEARDOWN_GRACE_MS, type ApiClock, defaultClock } from "./api-spawn.ts";

/** Retained jq stdout cap; bytes past it are counted and dropped. */
export const JQ_OUTPUT_CAP = 1024 * 1024;
/** Retained jq stderr cap (diagnostics only). */
export const JQ_STDERR_CAP = 8 * 1024;

export type JqOutcome =
	| { kind: "result"; output: string; outputTruncated: boolean; outputBytes: number }
	| { kind: "error"; reason: string; compileError?: boolean };

export interface JqRunOptions {
	expression: string;
	jsonDocument: string;
	/** Absolute ms deadline shared with the API children. */
	deadlineAt: number;
	clock?: ApiClock;
	signal?: AbortSignal;
	/** Test seam: absolute jq executable override. */
	jqPath?: string;
}

type SpawnFunction = typeof spawn;
let spawnOverride: SpawnFunction | null = null;

/** Test seam: capture jq child argv/env/options and control spawn timing. */
export function setJqSpawnOverride(fn: SpawnFunction | null): void {
	spawnOverride = fn;
}

// ── Executable resolution ────────────────────────────────────────────────────

/** Resolves jq from PATH to an absolute executable; never runs it. */
export function resolveJqExecutable(): { ok: true; path: string } | { ok: false; reason: string } {
	const pathEnv = process.env.PATH ?? "";
	for (const dir of pathEnv.split(":")) {
		if (dir.length === 0) continue;
		const candidate = join(dir, "jq");
		try {
			return { ok: true, path: realpathSync(candidate) };
		} catch {
			// Not present in this PATH entry; keep looking.
		}
	}
	return { ok: false, reason: "jq executable not found on PATH; install jq to use the jq parameter" };
}

// ── Lexical security check ───────────────────────────────────────────────────

const IDENT_START = /[A-Za-z_]/;
const IDENT_CHAR = /[A-Za-z0-9_]/;
const PUNCT = new Set([
	"+", "-", "*", "/", "%", "<", ">", "=", "!", "&", "|", ".", ",", ";", ":",
	"(", ")", "[", "]", "{", "}", "?", "\t", "\n", " ", "\r", "$", "@", "#",
	"0", "1", "2", "3", "4", "5", "6", "7", "8", "9",
]);
const STRING_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t"]);

interface Frame {
	/** "code" is executable; "string" is a literal (interpolations push code). */
	type: "code" | "string";
	/** Open paren depth within this code frame (interpolation frames close at 0). */
	parenDepth: number;
	/** Next identifier is a property name (preceded by "."), not a keyword. */
	fieldNext: boolean;
}

/**
 * Returns null when the expression is lexically safe to hand to jq, else a
 * rejection reason. Fail-closed: anything the checker does not recognize
 * (unsupported punctuation, malformed escapes, unterminated strings or
 * interpolations, raw control characters) is rejected, never guessed about.
 */
export function jqSecurityViolation(expression: string): string | null {
	const frames: Frame[] = [{ type: "code", parenDepth: 0, fieldNext: false }];
	let i = 0;
	while (i < expression.length) {
		const frame = frames[frames.length - 1]!;
		const ch = expression[i]!;

		if (frame.type === "string") {
			if (ch === "\\") {
				const next = expression[i + 1];
				if (next === undefined) return "malformed escape: backslash at end of expression";
				if (next === "(") {
					// String interpolation: executable code until the matching ")".
					frames.push({ type: "code", parenDepth: 0, fieldNext: false });
					i += 2;
					continue;
				}
				if (next === "u") {
					const hex = expression.slice(i + 2, i + 6);
					if (!/^[0-9a-fA-F]{4}$/.test(hex)) return "malformed escape: \\u requires four hex digits";
					i += 6;
					continue;
				}
				if (!STRING_ESCAPES.has(next)) return `malformed escape: unsupported escape '\\${next}'`;
				i += 2;
				continue;
			}
			if (ch === '"') {
				frames.pop();
				i += 1;
				continue;
			}
			if (ch < " " || ch === "\x7f") return "raw control character inside a string literal";
			i += 1;
			continue;
		}

		// Code frame.
		if (ch === "#") {
			// Comment to end of line; contents are not executable.
			while (i < expression.length && expression[i] !== "\n") i += 1;
			continue;
		}
		if (ch === '"') {
			frames.push({ type: "string", parenDepth: 0, fieldNext: false });
			i += 1;
			continue;
		}
		if (IDENT_START.test(ch)) {
			let end = i + 1;
			while (end < expression.length && IDENT_CHAR.test(expression[end]!)) end += 1;
			const ident = expression.slice(i, end);
			if (!frame.fieldNext && (ident === "import" || ident === "include")) {
				return `module loading construct '${ident}' is not allowed`;
			}
			frame.fieldNext = false;
			i = end;
			continue;
		}
		if (ch === "$") {
			// Variable reference ($name, $ENV, $__loc__) or format string ($"").
			const next = expression[i + 1];
			if (next === '"') {
				frames.push({ type: "string", parenDepth: 0, fieldNext: false });
				i += 2;
				continue;
			}
			frame.fieldNext = false;
			i += 1;
			continue;
		}
		if (ch === "@") {
			// Format string token (@base64, @sh, ...): never executable output.
			let end = i + 1;
			while (end < expression.length && IDENT_CHAR.test(expression[end]!)) end += 1;
			i = end;
			continue;
		}
		if (ch === ".") {
			// Property access (or recursive descent ".."): the next identifier
			// or quoted string is a field name, so ".include" stays benign.
			frame.fieldNext = true;
			i += 1;
			continue;
		}
		if (ch === "(") {
			frame.parenDepth += 1;
			frame.fieldNext = false;
			i += 1;
			continue;
		}
		if (ch === ")") {
			if (frames.length > 1 && frame.parenDepth === 0) {
				// Closes an interpolation; return to the enclosing string.
				frames.pop();
			} else {
				frame.parenDepth = Math.max(0, frame.parenDepth - 1);
			}
			frame.fieldNext = false;
			i += 1;
			continue;
		}
		if (PUNCT.has(ch)) {
			frame.fieldNext = false;
			i += 1;
			continue;
		}
		return `unsupported lexical construct at '${expression.slice(i, i + 8)}'`;
	}
	if (frames.length > 1) {
		return frames[frames.length - 1]!.type === "string"
			? "unterminated string literal"
			: "unterminated string interpolation";
	}
	return null;
}

// ── Child execution ──────────────────────────────────────────────────────────

/**
 * Creates a tool-owned guard FILE used as the jq child's HOME: a path that
 * exists but is provably not a directory, so every $HOME-based module search
 * location (~/.jq, $HOME/.jq) is unusable. Callers must deleteGuardFile in a
 * finally block.
 */
export function createJqHomeGuardFile(): string {
	const guard = join(tmpdir(), `gh-read-jq-home-${process.pid}-${Math.random().toString(36).slice(2)}`);
	const fd = openSync(guard, "w");
	closeSync(fd);
	return guard;
}

export function deleteJqHomeGuardFile(guard: string): void {
	try {
		unlinkSync(guard);
	} catch {
		// Already gone; nothing to do.
	}
}

/** Minimal environment for jq: no inherited credentials or loader-injection variables. */
export function buildJqEnv(homeGuard: string): Record<string, string> {
	return {
		HOME: homeGuard,
		LC_ALL: "C.UTF-8",
	};
}

interface SpawnedChild {
	stdout: { on(event: "data", fn: (chunk: Buffer) => void): void } | null;
	stderr: { on(event: "data", fn: (chunk: Buffer) => void): void } | null;
	stdin: { write(chunk: Buffer): void; end(): void } | null;
	kill(signal?: NodeJS.Signals): boolean;
	on(event: "error", fn: (err: Error) => void): void;
	on(event: "close", fn: (code: number | null, signal: NodeJS.Signals | null) => void): void;
}

function doSpawn(jqPath: string, argv: string[], env: Record<string, string>): SpawnedChild {
	const fn = spawnOverride ?? spawn;
	return fn(jqPath, argv, {
		shell: false,
		stdio: ["pipe", "pipe", "pipe"],
		env,
		windowsHide: true,
	}) as unknown as SpawnedChild;
}

/**
 * Compilation preflight: jq compiles the expression against a null input.
 * Exit 3 (compile error) rejects before any network access. Runtime errors
 * (exit 5) still prove the expression compiled, so they pass preflight.
 */
async function compilePreflight(
	jqPath: string,
	expression: string,
	env: Record<string, string>,
	deadlineAt: number,
	clock: ApiClock,
	signal: AbortSignal | undefined,
): Promise<JqOutcome> {
	const remaining = deadlineAt - clock.now();
	if (remaining <= 0) return { kind: "error", reason: "shared deadline exceeded before jq preflight" };
	return await new Promise<JqOutcome>((resolvePromise) => {
		let settled = false;
		let timedOut = false;
		let stderr = "";
		let child: SpawnedChild;
		try {
			child = doSpawn(jqPath, ["-c", "-n", expression], env);
		} catch (err) {
			resolvePromise({ kind: "error", reason: `failed to run jq preflight: ${err instanceof Error ? err.message : String(err)}`, compileError: true });
			return;
		}
		child.stderr?.on("data", (chunk: Buffer) => {
			if (stderr.length < 4096) stderr += chunk.toString("utf8");
		});
		const teardown = (hard: boolean): void => {
			try {
				child.kill(hard ? "SIGKILL" : "SIGTERM");
			} catch {
				// ESRCH tolerated.
			}
		};
		let escalation: unknown;
		const deadlineHandle = clock.setTimeout(() => {
			timedOut = true;
			teardown(false);
			escalation = clock.setTimeout(() => teardown(true), TEARDOWN_GRACE_MS);
		}, remaining);
		const onAbort = (): void => {
			teardown(false);
			escalation = clock.setTimeout(() => teardown(true), TEARDOWN_GRACE_MS);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		const finish = (code: number | null): void => {
			if (settled) return;
			settled = true;
			clock.clearTimeout(deadlineHandle);
			if (escalation !== undefined) clock.clearTimeout(escalation);
			signal?.removeEventListener("abort", onAbort);
			if (timedOut) {
				resolvePromise({ kind: "error", reason: "shared deadline exceeded during jq preflight" });
				return;
			}
			if (code === 0) {
				resolvePromise({ kind: "result", output: "", outputTruncated: false, outputBytes: 0 });
				return;
			}
			if (code === 5) {
				// Runtime error on the null input: the expression compiled.
				resolvePromise({ kind: "result", output: "", outputTruncated: false, outputBytes: 0 });
				return;
			}
			const detail = stderr.trim().split("\n")[0] ?? "";
			resolvePromise({
				kind: "error",
				reason: `jq rejected the expression (exit ${code})${detail.length > 0 ? `: ${detail}` : ""}`,
				compileError: true,
			});
		};
		child.on("error", (err: Error) => {
			resolvePromise({ kind: "error", reason: `failed to run jq preflight: ${err.message}`, compileError: true });
		});
		child.on("close", (code) => {
			finish(code);
		});
	});
}

/**
 * Preflight gates: lexical safety, executable resolution, and compilation.
 * Never touches the network. Returns a prepared handle for executeJq.
 */
export type JqPrepared =
	| { kind: "prepared"; jqPath: string }
	| { kind: "error"; reason: string; compileError?: boolean };

export async function prepareJq(
	expression: string,
	opts: { clock?: ApiClock; signal?: AbortSignal; jqPath?: string; deadlineAt: number } = { deadlineAt: 0 },
): Promise<JqPrepared> {
	const clock = opts.clock ?? defaultClock;
	const violation = jqSecurityViolation(expression);
	if (violation !== null) {
		return { kind: "error", reason: `jq expression rejected: ${violation}`, compileError: true };
	}
	const resolved = opts.jqPath !== undefined ? { ok: true as const, path: opts.jqPath } : resolveJqExecutable();
	if (!resolved.ok) {
		return { kind: "error", reason: resolved.reason, compileError: true };
	}
	const homeGuard = createJqHomeGuardFile();
	try {
		const env = buildJqEnv(homeGuard);
		const preflight = await compilePreflight(
			resolved.path,
			expression,
			env,
			opts.deadlineAt,
			clock,
			opts.signal,
		);
		if (preflight.kind === "error") return preflight;
		return { kind: "prepared", jqPath: resolved.path };
	} finally {
		deleteJqHomeGuardFile(homeGuard);
	}
}

/**
 * Runs the real filter with a prepared handle: one JSON document through
 * stdin, compact output on stdout, bounded pipes, shared deadline,
 * cancellation-aware teardown. Never throws; every failure becomes a
 * JqOutcome error.
 */
export async function executeJq(
	prepared: Extract<JqPrepared, { kind: "prepared" }>,
	expression: string,
	jsonDocument: string,
	opts: { deadlineAt: number; clock?: ApiClock; signal?: AbortSignal },
): Promise<JqOutcome> {
	const clock = opts.clock ?? defaultClock;
	const signal = opts.signal;
	const jqPath = prepared.jqPath;

	const homeGuard = createJqHomeGuardFile();
	try {
		const env = buildJqEnv(homeGuard);

		const remaining = opts.deadlineAt - clock.now();
		if (remaining <= 0) return { kind: "error", reason: "shared deadline exceeded before jq run" };
		if (signal?.aborted) return { kind: "error", reason: "cancelled before jq run" };

		return await new Promise<JqOutcome>((resolvePromise) => {
			let settled = false;
			let timedOut = false;
			let cancelled = false;
			let truncated = false;
			let outputBytes = 0;
			const outputChunks: Buffer[] = [];
			let stderr = "";
			let child: SpawnedChild;
			try {
				child = doSpawn(jqPath, ["-c", expression], env);
			} catch (err) {
				resolvePromise({ kind: "error", reason: `failed to run jq: ${err instanceof Error ? err.message : String(err)}` });
				return;
			}
			child.stdout?.on("data", (chunk: Buffer) => {
				outputBytes += chunk.length;
				const retained = outputChunks.reduce((sum, c) => sum + c.length, 0);
				const keep = Math.min(chunk.length, Math.max(0, JQ_OUTPUT_CAP - retained));
				if (keep > 0) outputChunks.push(chunk.subarray(0, keep));
				if (keep < chunk.length) truncated = true;
			});
			child.stderr?.on("data", (chunk: Buffer) => {
				if (stderr.length < JQ_STDERR_CAP) stderr += chunk.toString("utf8");
			});
			const teardown = (hard: boolean): void => {
				try {
					child.kill(hard ? "SIGKILL" : "SIGTERM");
				} catch {
					// ESRCH tolerated.
				}
			};
			let escalation: unknown;
			const deadlineHandle = clock.setTimeout(() => {
				timedOut = true;
				teardown(false);
				escalation = clock.setTimeout(() => teardown(true), TEARDOWN_GRACE_MS);
			}, remaining);
			const onAbort = (): void => {
				cancelled = true;
				teardown(false);
				escalation = clock.setTimeout(() => teardown(true), TEARDOWN_GRACE_MS);
			};
			signal?.addEventListener("abort", onAbort, { once: true });

			const finish = (code: number | null, sig: NodeJS.Signals | null, spawnError?: string): void => {
				if (settled) return;
				settled = true;
				clock.clearTimeout(deadlineHandle);
				if (escalation !== undefined) clock.clearTimeout(escalation);
				signal?.removeEventListener("abort", onAbort);
				if (spawnError !== undefined) {
					resolvePromise({ kind: "error", reason: `failed to run jq: ${spawnError}` });
					return;
				}
				if (cancelled) {
					resolvePromise({ kind: "error", reason: "cancelled during jq run" });
					return;
				}
				if (timedOut) {
					resolvePromise({ kind: "error", reason: "shared deadline exceeded during jq run" });
					return;
				}
				const output = Buffer.concat(outputChunks).toString("utf8");
				if (code !== 0) {
					const detail = stderr.trim().split("\n")[0] ?? "";
					resolvePromise({
						kind: "error",
						reason: `jq exited with code ${code}${detail.length > 0 ? `: ${detail}` : ""}`,
						compileError: code === 3,
					});
					return;
				}
				resolvePromise({ kind: "result", output, outputTruncated: truncated, outputBytes });
			};
			child.on("error", (err: Error) => {
				finish(null, null, err.message);
			});
			child.on("close", (code, sig) => {
				finish(code, sig);
			});
			try {
				child.stdin?.write(Buffer.from(jsonDocument, "utf8"));
				child.stdin?.end();
			} catch {
				// EPIPE if the child died early; close handles resolution.
			}
		});
	} finally {
		deleteJqHomeGuardFile(homeGuard);
	}
}

/** Convenience wrapper: preflight gates then execute. */
export async function runJq(
	expression: string,
	jsonDocument: string,
	opts: { deadlineAt: number; clock?: ApiClock; signal?: AbortSignal; jqPath?: string },
): Promise<JqOutcome> {
	const prepared = await prepareJq(expression, {
		deadlineAt: opts.deadlineAt,
		clock: opts.clock,
		signal: opts.signal,
		jqPath: opts.jqPath,
	});
	if (prepared.kind === "error") return prepared;
	return await executeJq(prepared, expression, jsonDocument, {
		deadlineAt: opts.deadlineAt,
		clock: opts.clock,
		signal: opts.signal,
	});
}
