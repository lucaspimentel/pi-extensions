/**
 * Bridge to `wtcli.exe agent-hook` for Microsoft Intelligent Terminal (IT).
 *
 * `wtcli agent-hook --cli-source pi --event <topic>` reads one hook JSON object
 * on stdin, requires `WT_COM_CLSID` and `WT_SESSION` in its own environment,
 * writes nothing, and always exits 0. Missing environment, malformed JSON, or a
 * non-object body are all dropped silently by the bridge, which is why this
 * module cannot report post-spawn failures: they are indistinguishable from
 * success.
 *
 * Each invocation costs roughly 150-320 ms (MSIX app-execution-alias process
 * creation dominates), so emits are never awaited on the pi event path. They go
 * through a serialized queue that keeps at most one pending event per topic:
 * WTA applies events in receipt order, and two ~200 ms spawns racing each other
 * could deliver a stop before the tool.starting that preceded it.
 *
 * No pi runtime imports: this module is plain Node so a type-stripping test
 * runner can drive it directly.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

type SpawnFunction = typeof spawn;

/** Environment variable IT injects into its shell panes, pointing at wtcli.exe. */
export const WTCLI_PATH_ENV = "WTCLI_PATH";

/** Shown once per process when the bridge cannot be used. */
export const BRIDGE_NOT_FOUND_MESSAGE = "Intelligent Terminal hooks inactive: wtcli.exe not found";

/** Distinct pending topics kept while an emit is in flight. */
export const MAX_PENDING_EVENTS = 8;

/** Fallback bound so a hung child can never wedge the queue. */
export const SPAWN_TIMEOUT_MS = 2_000;

let spawnOverride: SpawnFunction | null = null;
/** `undefined` = not resolved yet; `null` = resolution failed. */
let resolvedPath: string | null | undefined;
let failed = false;
let warned = false;
let sawFirstSpawn = false;

const pending = new Map<string, Record<string, unknown>>();
const order: string[] = [];
let inFlight = false;
let drainPromise: Promise<void> | null = null;

function stripQuotes(value: string): string {
	return value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

function warnOnce(warn: (message: string) => void): void {
	if (warned) return;
	warned = true;
	warn(BRIDGE_NOT_FOUND_MESSAGE);
}

/**
 * Resolve the `wtcli.exe` to use, in priority order:
 *   1. `WTCLI_PATH` (what IT injects into its panes),
 *   2. the first `wtcli.exe` on `PATH`,
 *   3. `%LOCALAPPDATA%\Microsoft\WindowsApps\wtcli.exe` (the MSIX alias).
 * Returns `null` when nothing is found.
 */
export function resolveWtcliPath(
	options: { env?: NodeJS.ProcessEnv; exists?: (path: string) => boolean } = {},
): string | null {
	const env = options.env ?? process.env;
	const exists = options.exists ?? existsSync;

	const injected = env[WTCLI_PATH_ENV]?.trim();
	if (injected) {
		const candidate = stripQuotes(injected);
		if (candidate) return candidate;
	}

	for (const entry of (env.PATH ?? "").split(delimiter)) {
		const dir = stripQuotes(entry.trim());
		if (!dir) continue;
		const candidate = join(dir, "wtcli.exe");
		if (exists(candidate)) return candidate;
	}

	const localAppData = env.LOCALAPPDATA?.trim();
	if (localAppData) {
		const candidate = join(localAppData, "Microsoft", "WindowsApps", "wtcli.exe");
		if (exists(candidate)) return candidate;
	}

	return null;
}

/**
 * Queue one hook event. Never throws, never blocks, never awaited by callers.
 * `warn` is invoked at most once per process, and only when the bridge turns
 * out to be unusable.
 */
export function sendAgentHook(
	topic: string,
	payload: Record<string, unknown>,
	warn: (message: string) => void,
): void {
	if (failed) return;

	if (resolvedPath === undefined) {
		resolvedPath = resolveWtcliPath();
	}
	if (typeof resolvedPath !== "string" || resolvedPath.length === 0) {
		// Resolution failed: warn once and never retry, so a missing bridge
		// cannot turn every event into a failed ~200 ms spawn attempt.
		failed = true;
		warnOnce(warn);
		return;
	}

	enqueue(topic, payload);
	if (!inFlight) void drain(warn);
}

function enqueue(topic: string, payload: Record<string, unknown>): void {
	if (pending.has(topic)) {
		// Replace in place and keep the queue position: a newer event of the
		// same topic supersedes the pending one without jumping the line.
		pending.set(topic, payload);
		return;
	}

	pending.set(topic, payload);
	order.push(topic);

	if (pending.size > MAX_PENDING_EVENTS) {
		const oldest = order.shift();
		if (oldest !== undefined) pending.delete(oldest);
	}
}

async function drain(warn: (message: string) => void): Promise<void> {
	if (inFlight) return drainPromise ?? Promise.resolve();

	inFlight = true;
	drainPromise = (async () => {
		try {
			// Re-checks `order` after every await, so anything enqueued while a
			// spawn was in flight is picked up by this same loop.
			while (order.length > 0) {
				const topic = order.shift();
				if (topic === undefined) break;
				const payload = pending.get(topic);
				pending.delete(topic);
				if (payload === undefined) continue;
				await spawnOnce(topic, payload, warn);
			}
		} finally {
			inFlight = false;
			drainPromise = null;
		}
	})();

	return drainPromise;
}

/** Resolves when the queue is empty. Used by tests and by the shutdown path. */
export function flushAgentHooks(): Promise<void> {
	return drainPromise ?? Promise.resolve();
}

function spawnOnce(
	topic: string,
	payload: Record<string, unknown>,
	warn: (message: string) => void,
): Promise<void> {
	const executable = resolvedPath;
	if (typeof executable !== "string" || failed) return Promise.resolve();

	const firstSpawn = !sawFirstSpawn;
	sawFirstSpawn = true;

	return new Promise<void>((resolve) => {
		let settled = false;
		let timer: NodeJS.Timeout | undefined;
		const finish = (): void => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			resolve();
		};
		timer = setTimeout(finish, SPAWN_TIMEOUT_MS);

		let child: ReturnType<SpawnFunction>;
		try {
			child = (spawnOverride ?? spawn)(executable, ["agent-hook", "--cli-source", "pi", "--event", topic], {
				stdio: ["pipe", "ignore", "ignore"],
				windowsHide: true,
			});
		} catch {
			// Synchronous spawn failure (e.g. a path that cannot be launched).
			if (firstSpawn) {
				failed = true;
				warnOnce(warn);
			}
			finish();
			return;
		}

		child.on("error", (error: NodeJS.ErrnoException) => {
			if (firstSpawn && error?.code === "ENOENT") {
				failed = true;
				warnOnce(warn);
			}
			finish();
		});
		child.on("close", finish);
		child.on("exit", finish);

		const stdin = child.stdin;
		if (stdin) {
			// The child may exit before or while we write; EPIPE must not throw.
			stdin.on("error", () => {});
			stdin.write(JSON.stringify(payload));
			stdin.end();
		}

		// Fire and forget: pi must never wait on the bridge.
		child.unref();
	});
}

/** Test seam: capture the argv/options and control child lifecycle. */
export function setSpawnOverride(fn: SpawnFunction | null): void {
	spawnOverride = fn;
}

/**
 * Test seam: pin the resolved bridge path. A string skips resolution, `null`
 * simulates "not found", and `undefined` restores "not resolved yet".
 */
export function setResolvedPathForTests(path: string | null | undefined): void {
	resolvedPath = path;
}

/** Test seam: restore every module-level bit of state. */
export function resetForTests(): void {
	spawnOverride = null;
	resolvedPath = undefined;
	failed = false;
	warned = false;
	sawFirstSpawn = false;
	pending.clear();
	order.length = 0;
	inFlight = false;
	drainPromise = null;
}
