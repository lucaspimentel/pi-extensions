/**
 * gh-read API child-process layer.
 *
 * A dedicated runner for tool-authored `gh api` requests, separate from the
 * legacy native-command executor in spawn.ts (which keeps its 15 s / 50 KiB
 * contract unchanged). One runner instance spans one tool invocation and owns
 * a shared monotonic 30-second deadline across resolution requests, all
 * paged children, and external jq, plus a cumulative 8 MiB captured gh
 * response stdout budget (headers included). The budget is a bound on what
 * this tool captures, not on network transfer or gh's internal memory use.
 *
 * Every request is a fixed tool-authored argv: no shell, no caller flags,
 * no field arguments, no --paginate. Endpoint/query strings arrive from
 * api.ts fully encoded. Streams are drained continuously so the child never
 * blocks on backpressure; on deadline, cancellation, or budget overflow the
 * child is killed (SIGTERM, then SIGKILL after TEARDOWN_GRACE_MS) and reaped
 * before the promise resolves. A response whose bytes were dropped mid-body
 * is rejected as interrupted even if the retained prefix would parse.
 *
 * Unlike the native commands, API requests name an explicit github.com
 * repository, so no git worktree gate runs anywhere in this module. Two
 * transports share one runner: `request` issues a REST GET, `graphql` issues
 * a tool-authored GraphQL POST (validated before any spawn, with the same
 * deadline, budget, and teardown).
 *
 * Injectable seams (spawn function, clock) keep the whole module testable
 * network-free.
 */

import { spawn } from "node:child_process";
import { buildGhEnv } from "./spawn.ts";

export const API_DEADLINE_MS = 30_000;
export const API_STDOUT_BUDGET = 8 * 1024 * 1024;
/** Per-response retained header block cap (headers count against the budget). */
export const API_HEADERS_CAP = 64 * 1024;
/** Cumulative retained stderr diagnostics cap across all children. */
export const API_STDERR_CAP = 16 * 1024;
/** SIGTERM -> SIGKILL escalation delay during teardown. */
export const TEARDOWN_GRACE_MS = 5_000;

/** Monotonic-enough clock seam: tests inject a controllable implementation. */
export interface ApiClock {
	now(): number;
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

export const defaultClock: ApiClock = {
	now: () => Date.now(),
	setTimeout,
	clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

type SpawnFunction = typeof spawn;
let spawnOverride: SpawnFunction | null = null;

/** Test seam: capture child argv/env/options and control spawn timing. */
export function setApiSpawnOverride(fn: SpawnFunction | null): void {
	spawnOverride = fn;
}

/** A successfully captured response. Headers are the retained header block. */
export interface GhApiResponse {
	kind: "response";
	/** HTTP status parsed from the final status line (redirect blocks skipped). */
	httpStatus: number;
	headers: string;
	body: string;
	bodyBytes: number;
}

/** A failed request. `interrupted` marks bytes dropped mid-response. */
export interface GhApiError {
	kind: "error";
	reason: string;
	httpStatus?: number;
	stderr?: string;
	/** True when the response was cut off (budget, deadline, or cancel). */
	interrupted?: boolean;
}

export type GhApiOutcome = GhApiResponse | GhApiError;

export function isGhApiError(outcome: GhApiOutcome): outcome is GhApiError {
	return (outcome as GhApiError).kind === "error";
}

/** Budget state refused before a spawn: a stop between complete responses. */
export interface GhApiStop {
	kind: "stop";
	reason: string;
}

export type ApiRequestOutcome = GhApiOutcome | GhApiStop;

export function isGhApiStop(outcome: ApiRequestOutcome): outcome is GhApiStop {
	return (outcome as GhApiStop).kind === "stop";
}

export interface ApiRequester {
	/**
	 * Issues one REST GET against github.com; pathAndQuery is already encoded.
	 * `graphql` issues a tool-authored GraphQL POST instead; both share the
	 * same deadline, captured-output budget, and teardown behavior.
	 */
	request(pathAndQuery: string): Promise<ApiRequestOutcome>;
	/**
	 * Issues a tool-authored GraphQL POST. The query and variables are
	 * validated before any spawn; variables are transported as `-f`
	 * (string) or `-F` (number) pairs in caller order.
	 */
	graphql(query: string, variables: ReadonlyArray<readonly [string, string | number]>): Promise<ApiRequestOutcome>;
	/** Cumulative captured response bytes (headers included) so far. */
	capturedBytes(): number;
	/** True once the budget has been exhausted mid-response or up front. */
	budgetExhausted(): boolean;
	/** Absolute shared deadline (ms since the clock epoch). */
	deadline(): number;
}

const COMMON_ARGV = [
	"api",
	"--hostname",
	"github.com",
	"--method",
	"GET",
	"--header",
	"Accept: application/vnd.github+json",
	"--header",
	"X-GitHub-Api-Version: 2022-11-28",
	// Headers land in stdout so Link pagination can be parsed from the same
	// captured stream; they count against the cumulative budget.
	"--include",
] as const;

export interface ApiRunnerOptions {
	cwd?: string;
	clock?: ApiClock;
	signal?: AbortSignal;
	/** Deadline override (ms since clock epoch); tests only. */
	deadlineAt?: number;
}

/**
 * One runner per tool invocation. Implements ApiRequester. After a
 * mid-response truncation the runner is poisoned: further requests are
 * refused as stops because no later response could be parsed reliably.
 */
/** GraphQL variable names: the GraphQL name production. */
const GRAPHQL_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Control characters rejected in the query and in string variable values. */
const GRAPHQL_CONTROL_RE = /[\u0000-\u001F\u007F]/;
/** Caller string values ride `-f`, so they are bounded to keep argv sane. */
const GRAPHQL_VALUE_MAX_CHARS = 512;

/**
 * Validates a tool-authored GraphQL request before any spawn: the query must
 * be a non-empty string without control characters, every variable name must
 * be a GraphQL name other than `query`, and every value must be either a
 * string without control characters of at most 512 characters or a safe
 * integer. Returns a rejection reason, or null when the request is valid.
 */
function graphqlArgError(query: string, variables: ReadonlyArray<readonly [string, string | number]>): string | null {
	if (typeof query !== "string" || query.length === 0) return "graphql query must be a non-empty string";
	if (GRAPHQL_CONTROL_RE.test(query)) return "graphql query must not contain control characters";
	for (const [name, value] of variables) {
		if (!GRAPHQL_NAME_RE.test(name)) return `graphql variable name '${name}' is not a valid GraphQL name`;
		if (name === "query") return "graphql variable name must not be 'query'";
		if (typeof value === "number") {
			if (!Number.isSafeInteger(value)) return `graphql variable '${name}' must be a safe integer`;
			continue;
		}
		if (typeof value !== "string") return `graphql variable '${name}' must be a string or a safe integer`;
		if (value.length > GRAPHQL_VALUE_MAX_CHARS) return `graphql variable '${name}' must be at most ${GRAPHQL_VALUE_MAX_CHARS} characters`;
		if (GRAPHQL_CONTROL_RE.test(value)) return `graphql variable '${name}' must not contain control characters`;
	}
	return null;
}

/** True when a decoded body is a JSON object (arrays and null are not). */
function isJsonObject(text: string): boolean {
	try {
		const parsed = JSON.parse(text) as unknown;
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
	} catch {
		return false;
	}
}

export class GhApiRunner implements ApiRequester {
	readonly deadlineAt: number;
	private bytes = 0;
	private stderrRetained: string[] = [];
	private stderrBytes = 0;
	private poisoned = false;
	private readonly clock: ApiClock;
	private readonly signal: AbortSignal | undefined;
	private readonly cwd: string;

	constructor(options: ApiRunnerOptions = {}) {
		this.clock = options.clock ?? defaultClock;
		this.deadlineAt = options.deadlineAt ?? this.clock.now() + API_DEADLINE_MS;
		this.signal = options.signal;
		this.cwd = options.cwd ?? process.cwd();
	}

	capturedBytes(): number {
		return this.bytes;
	}

	deadline(): number {
		return this.deadlineAt;
	}

	budgetExhausted(): boolean {
		return this.poisoned || this.bytes >= API_STDOUT_BUDGET;
	}

	/** Milliseconds left on the shared deadline; never negative. */
	remainingMs(): number {
		return Math.max(0, this.deadlineAt - this.clock.now());
	}

	/**
	 * Refusals shared by every transport before a spawn: a poisoned runner, an
	 * exhausted up-front budget, an aborted signal, and an already-expired
	 * deadline. Returns null when a request may proceed.
	 */
	private preflightOutcome(): ApiRequestOutcome | null {
		if (this.poisoned) {
			return { kind: "stop", reason: "captured-output budget exceeded on an earlier response; later requests refused" };
		}
		if (this.bytes >= API_STDOUT_BUDGET) {
			return { kind: "stop", reason: `captured-output budget of ${API_STDOUT_BUDGET} bytes exhausted` };
		}
		if (this.signal?.aborted) {
			return { kind: "error", reason: "cancelled before request", interrupted: true };
		}
		if (this.remainingMs() <= 0) {
			return { kind: "error", reason: `shared ${API_DEADLINE_MS} ms deadline exceeded before request`, interrupted: true };
		}
		return null;
	}

	async request(pathAndQuery: string): Promise<ApiRequestOutcome> {
		return await this.executeArgv([...COMMON_ARGV, pathAndQuery], "rest");
	}

	/**
	 * Tool-authored GraphQL POST. GitHub's `-f` does NOT expand `{placeholder}`
	 * values while `-F` does, so every caller-derived string rides `-f` and
	 * only the validated integer uses `-F`; a `{` or `%` in a repo name can
	 * never be expanded or reinterpreted.
	 */
	async graphql(query: string, variables: ReadonlyArray<readonly [string, string | number]>): Promise<ApiRequestOutcome> {
		const argumentError = graphqlArgError(query, variables);
		if (argumentError !== null) return { kind: "error", reason: argumentError };
		const preflight = this.preflightOutcome();
		if (preflight !== null) return preflight;
		const argv: string[] = [
			"api",
			"graphql",
			"--hostname",
			"github.com",
			"--method",
			"POST",
			"--header",
			"Accept: application/vnd.github+json",
			"--header",
			"X-GitHub-Api-Version: 2022-11-28",
			"--include",
			"-f",
			`query=${query}`,
		];
		for (const [name, value] of variables) {
			argv.push(typeof value === "number" ? "-F" : "-f", `${name}=${value}`);
		}
		return await this.executeArgv(argv, "graphql");
	}

	private async executeArgv(argv: string[], mode: "rest" | "graphql"): Promise<ApiRequestOutcome> {
		const preflight = this.preflightOutcome();
		if (preflight !== null) return preflight;
		const spawnFn = spawnOverride ?? spawn;
		let child: ReturnType<typeof spawn>;
		try {
			child = spawnFn("gh", argv, {
				cwd: this.cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: buildGhEnv(),
				windowsHide: true,
			});
		} catch (err) {
			this.poisoned = true;
			return { kind: "error", reason: `failed to run gh api: ${err instanceof Error ? err.message : String(err)}` };
		}

		return await new Promise<ApiRequestOutcome>((resolvePromise) => {
			const headerChunks: Buffer[] = [];
			const bodyChunks: Buffer[] = [];
			let headerBytes = 0;
			let headersDone = false;
			let overflow = false;
			let timedOut = false;
			let cancelled = false;
			let settled = false;

			const teardown = (hard: boolean): void => {
				try {
					child.kill(hard ? "SIGKILL" : "SIGTERM");
				} catch {
					// ESRCH: already exited.
				}
			};

			let escalation: unknown;
			let deadlineHandle: unknown;
			const schedule = (fn: () => void, ms: number): unknown => {
				return this.clock.setTimeout(fn, Math.max(0, ms));
			};

			deadlineHandle = schedule(() => {
				timedOut = true;
				teardown(false);
				escalation = schedule(() => teardown(true), TEARDOWN_GRACE_MS);
			}, this.remainingMs());

			const onAbort = (): void => {
				cancelled = true;
				teardown(false);
				escalation = schedule(() => teardown(true), TEARDOWN_GRACE_MS);
			};
			this.signal?.addEventListener("abort", onAbort, { once: true });

			const retainStderr = (chunk: Buffer): void => {
				if (this.stderrBytes >= API_STDERR_CAP) return;
				const keep = chunk.subarray(0, API_STDERR_CAP - this.stderrBytes);
				this.stderrBytes += keep.length;
				this.stderrRetained.push(keep.toString("utf8"));
			};

			child.stdout?.on("data", (chunk: Buffer) => {
				// Count every byte against the cumulative budget, then retain
				// only what fits. Bytes past the budget are dropped, never
				// buffered, and mark the response interrupted.
				this.bytes += chunk.length;
				if (this.bytes > API_STDOUT_BUDGET) {
					overflow = true;
					teardown(false);
					escalation = schedule(() => teardown(true), TEARDOWN_GRACE_MS);
					return;
				}
				if (!headersDone) {
					// Split header block from body on the first blank line once
					// both halves are visible; headers capped independently.
					headerChunks.push(chunk);
					headerBytes += chunk.length;
					const joined = Buffer.concat(headerChunks);
					const sep = joined.indexOf("\r\n\r\n");
					const alt = sep === -1 ? joined.indexOf("\n\n") : -1;
					const at = sep !== -1 ? sep + 4 : alt !== -1 ? alt + 2 : -1;
					if (at !== -1) {
						if (headerBytes > API_HEADERS_CAP) {
							// Header block larger than its cap cannot carry a
							// trustworthy Link header; treat as interrupted.
							overflow = true;
							teardown(false);
							escalation = schedule(() => teardown(true), TEARDOWN_GRACE_MS);
							return;
						}
						headersDone = true;
						const headerPart = joined.subarray(0, at);
						const bodyPart = joined.subarray(at);
						headerChunks.length = 0;
						headerChunks.push(headerPart);
						if (bodyPart.length > 0) bodyChunks.push(bodyPart);
					}
					return;
				}
				bodyChunks.push(chunk);
			});
			child.stderr?.on("data", retainStderr);

			const finish = (code: number | null, signal: NodeJS.Signals | null, spawnError?: string): void => {
				if (settled) return;
				settled = true;
				if (deadlineHandle !== undefined) this.clock.clearTimeout(deadlineHandle);
				if (escalation !== undefined) this.clock.clearTimeout(escalation);
				this.signal?.removeEventListener("abort", onAbort);

				const stderr = this.stderrRetained.join("").trim();
				if (spawnError !== undefined) {
					this.poisoned = true;
					resolvePromise({ kind: "error", reason: `failed to run gh api: ${spawnError}`, stderr });
					return;
				}
				if (cancelled) {
					resolvePromise({ kind: "error", reason: "cancelled mid-request", stderr, interrupted: true });
					return;
				}
				if (timedOut) {
					resolvePromise({
						kind: "error",
						reason: `shared ${API_DEADLINE_MS} ms deadline exceeded mid-request`,
						stderr,
						interrupted: true,
					});
					return;
				}
				if (overflow) {
					this.poisoned = true;
					resolvePromise({
						kind: "error",
						reason: `cumulative captured-output budget of ${API_STDOUT_BUDGET} bytes exceeded mid-response`,
						stderr,
						interrupted: true,
					});
					return;
				}

				// Split the (possibly multi-block, redirect) header stream from
				// the body: skip leading HTTP blocks until the body does not
				// start with another status line.
				const raw = Buffer.concat([...headerChunks, ...bodyChunks]);
				let headers = "";
				let bodyBuf = raw;
				for (;;) {
					const sep = bodyBuf.indexOf("\r\n\r\n");
					const alt = sep === -1 ? bodyBuf.indexOf("\n\n") : -1;
					const at = sep !== -1 ? sep + 4 : alt !== -1 ? alt + 2 : -1;
					if (at === -1) break;
					const blockStart = bodyBuf.subarray(0, at).toString("utf8");
					const rest = bodyBuf.subarray(at);
					const nextIsStatus = /^HTTP\/[\d.]+ \d{3}/.test(rest.subarray(0, 32).toString("utf8").trimStart());
					headers = blockStart;
					bodyBuf = rest;
					if (!nextIsStatus) break;
				}
				const statusMatch = /HTTP\/[\d.]+ (\d{3})/.exec(headers);
				const httpStatus = statusMatch !== null ? Number(statusMatch[1]) : 0;

				// A body is only trustworthy if the child exited cleanly and
				// the full stream arrived; interrupted responses are rejected
				// even when the retained bytes would parse.
				if (signal !== null && signal !== undefined) {
					resolvePromise({ kind: "error", reason: `gh api terminated by signal ${signal}`, stderr, interrupted: true });
					return;
				}
				let bodyText: string;
				try {
					// Strict decode: malformed UTF-8 in the body rejects the
					// response rather than silently substituting replacement
					// characters into JSON.
					bodyText = new TextDecoder("utf-8", { fatal: true }).decode(bodyBuf);
				} catch {
					resolvePromise({ kind: "error", reason: "response body contained malformed UTF-8", stderr, interrupted: true });
					return;
				}
				// GraphQL tolerance: GitHub's `api graphql` exits 1 even when the
				// response carries usable data beside an `errors` array. Accept that
				// exit only with a 2xx status AND a JSON object body; every other
				// nonzero code (REST always) keeps the error path below.
				const graphqlAccepted =
					mode === "graphql" && code === 1 && httpStatus >= 200 && httpStatus < 300 && isJsonObject(bodyText);
				if (code !== 0 && !graphqlAccepted) {
					if (httpStatus >= 400) {
						resolvePromise({
							kind: "error",
							reason: `gh api exited with code ${code}`,
							httpStatus,
							stderr: stderr.length > 0 ? stderr : bodyText.slice(0, 512),
						});
					} else {
						resolvePromise({ kind: "error", reason: `gh api exited with code ${code}`, stderr: stderr || bodyText.slice(0, 512) });
					}
					return;
				}
				if (httpStatus < 200 || httpStatus >= 300) {
					resolvePromise({ kind: "error", reason: `unexpected HTTP status ${httpStatus}`, httpStatus, stderr });
					return;
				}
				resolvePromise({
					kind: "response",
					httpStatus,
					headers,
					body: bodyText,
					bodyBytes: bodyBuf.length,
				});
			};

			child.on("error", (err: Error) => {
				finish(null, null, err.message);
			});
			child.on("close", (code, sig) => {
				finish(code, sig);
			});
		});
	}
}
