// Tests for the gh-read API child runner (extensions/gh-read/api-spawn.ts).
// Network-free: everything runs through the setApiSpawnOverride seam with a
// fake clock, so no real gh spawns. Spawn 0 is always the `gh api` child
// itself: API operations name an explicit github.com repository and never
// run the git worktree gate.
//
// Design: docs/gh-read-design.md ("GitHub API operations", "API runner").
//
// Run: node --test tests/gh-read-api-spawn.test.mts
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { afterEach, test } from "node:test";

import {
	API_DEADLINE_MS,
	API_HEADERS_CAP,
	API_STDERR_CAP,
	API_STDOUT_BUDGET,
	GhApiRunner,
	TEARDOWN_GRACE_MS,
	defaultClock,
	setApiSpawnOverride,
} from "../extensions/gh-read/api-spawn.ts";
import { INJECTED_ENV, STRIPPED_ENV, buildGhEnv } from "../extensions/gh-read/spawn.ts";

// ── Harness ──────────────────────────────────────────────────────────────────

interface FakeChild extends EventEmitter {
	stdout: EventEmitter;
	stderr: EventEmitter;
	signals: string[];
	kill(signal?: NodeJS.Signals): boolean;
}

function fakeChild(): FakeChild {
	const child = new EventEmitter() as FakeChild;
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.signals = [];
	child.kill = (signal?: NodeJS.Signals) => {
		child.signals.push(signal ?? "SIGTERM");
		return true;
	};
	return child;
}

interface CapturedSpawn {
	command: string;
	args: string[];
	options: Record<string, unknown>;
	child: FakeChild;
}

type SpawnScript = (spawn: CapturedSpawn, index: number) => void;

function harness(script: SpawnScript): CapturedSpawn[] {
	const spawns: CapturedSpawn[] = [];
	setApiSpawnOverride((command, args, options) => {
		const child = fakeChild();
		const index = spawns.length;
		spawns.push({ command, args: [...args], options: options as Record<string, unknown>, child });
		queueMicrotask(() => script(spawns[index]!, index));
		return child;
	});
	return spawns;
}

async function untilSpawn(spawns: CapturedSpawn[], count: number): Promise<void> {
	while (spawns.length < count) await new Promise((resolveTick) => setImmediate(resolveTick));
}

/** Controllable clock implementing ApiClock. */
class FakeClock {
	private current = 1_000_000;
	private nextId = 1;
	private timers = new Map<number, { at: number; fn: () => void }>();

	now(): number {
		return this.current;
	}

	setTimeout(fn: () => void, ms: number): unknown {
		const id = this.nextId++;
		this.timers.set(id, { at: this.current + Math.max(0, ms), fn });
		return id;
	}

	clearTimeout(handle: unknown): void {
		this.timers.delete(handle as number);
	}

	/** Advances time, firing due timers in schedule order. */
	advance(ms: number): void {
		this.current += ms;
		for (const [, timer] of [...this.timers].sort((a, b) => a[1].at - b[1].at)) {
			if (timer.at <= this.current) {
				this.timers.delete([...this.timers].find(([id, t]) => t === timer)![0]);
				timer.fn();
			}
		}
	}
}

/** Emits a complete response: optional extra header blocks, headers, body, close code. */
function emitResponse(child: FakeChild, body: string, code = 0, status = 200, extraHeaderBlocks = 0): void {
	const blocks: string[] = [];
	for (let i = 0; i < extraHeaderBlocks; i++) {
		blocks.push(`HTTP/1.1 302 Found\r\nLocation: https://api.github.com/elsewhere\r\n\r\n`);
	}
	blocks.push(`HTTP/1.1 ${status} ${status === 200 ? "OK" : "Status"}\r\nX-Test: 1\r\n\r\n`);
	child.stdout.emit("data", Buffer.from(blocks.join("") + body));
	child.emit("close", code, null);
}

afterEach(() => {
	setApiSpawnOverride(null);
});

// ── Unit: argv, environment, no git gate ─────────────────────────────────────

test("API request: one gh spawn, tool-authored argv, sanitized gh environment, no git gate", async () => {
	const spawns = harness((spawn) => emitResponse(spawn.child, "{}"));
	const runner = new GhApiRunner({ cwd: "/anywhere", clock: defaultClock });
	const outcome = await runner.request("repos/owner/name/contents?ref=x");
	assert.equal(spawns.length, 1, "no rev-parse gate spawn: explicit API targets skip the worktree gate");
	assert.equal(spawns[0]!.command, "gh");
	assert.deepEqual(spawns[0]!.args, [
		"api",
		"--hostname",
		"github.com",
		"--method",
		"GET",
		"--header",
		"Accept: application/vnd.github+json",
		"--header",
		"X-GitHub-Api-Version: 2022-11-28",
		"--include",
		"repos/owner/name/contents?ref=x",
	]);
	const options = spawns[0]!.options;
	assert.equal(options.shell, false);
	assert.equal(options.windowsHide, true);
	assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
	assert.equal(options.cwd, "/anywhere");
	const env = options.env as Record<string, string | undefined>;
	for (const key of STRIPPED_ENV) assert.equal(env[key], undefined, `${key} must be stripped`);
	for (const [key, value] of Object.entries(INJECTED_ENV)) assert.equal(env[key], value);
	assert.equal(outcome.kind, "response");
});

// ── Unit: response framing ───────────────────────────────────────────────────

test("ok response: status parsed, header block split from body", async () => {
	harness((spawn) => emitResponse(spawn.child, '{"a":1}'));
	const runner = new GhApiRunner({ clock: defaultClock });
	const outcome = await runner.request("repos/o/r");
	assert.equal(outcome.kind, "response");
	if (outcome.kind === "response") {
		assert.equal(outcome.httpStatus, 200);
		assert.ok(outcome.headers.includes("HTTP/1.1 200 OK"));
		assert.ok(outcome.headers.includes("X-Test: 1"));
		assert.equal(outcome.body, '{"a":1}');
	}
});

test("redirect blocks are skipped: final status line and headers win", async () => {
	harness((spawn) => emitResponse(spawn.child, '{"ok":true}', 0, 200, 1));
	const runner = new GhApiRunner({ clock: defaultClock });
	const outcome = await runner.request("repos/o/r");
	assert.equal(outcome.kind, "response");
	if (outcome.kind === "response") {
		assert.equal(outcome.httpStatus, 200);
		assert.ok(!outcome.headers.includes("302"));
		assert.equal(outcome.body, '{"ok":true}');
	}
});

test("nonzero exit with 4xx/5xx status: error carries httpStatus and stderr", async () => {
	harness((spawn, index) => {
		if (index === 0) {
			spawn.child.stdout.emit("data", Buffer.from("HTTP/1.1 404 Not Found\r\n\r\n"));
			spawn.child.stderr.emit("data", Buffer.from("gh: Not Found (HTTP 404)\n"));
			spawn.child.emit("close", 1, null);
		}
	});
	const runner = new GhApiRunner({ clock: defaultClock });
	const outcome = await runner.request("repos/o/r/contents/nope");
	assert.equal(outcome.kind, "error");
	if (outcome.kind === "error") {
		assert.equal(outcome.httpStatus, 404);
		assert.ok(outcome.stderr!.includes("Not Found"));
		assert.equal(outcome.interrupted, undefined);
	}
});

test("malformed UTF-8 body rejects the response instead of substituting replacement characters", async () => {
	harness((spawn) => {
		spawn.child.stdout.emit("data", Buffer.concat([
			Buffer.from("HTTP/1.1 200 OK\r\n\r\n", "utf8"),
			Buffer.from([0xff, 0xfe, 0x7b, 0x7d]),
		]));
		spawn.child.emit("close", 0, null);
	});
	const runner = new GhApiRunner({ clock: defaultClock });
	const outcome = await runner.request("repos/o/r");
	assert.equal(outcome.kind, "error");
	if (outcome.kind === "error") {
		assert.ok(outcome.reason.includes("malformed UTF-8"));
		assert.equal(outcome.interrupted, true);
	}
});

// ── Unit: cumulative captured-output budget ──────────────────────────────────

test("budget: exact cumulative boundary succeeds", async () => {
	const headers = "HTTP/1.1 200 OK\r\n\r\n";
	const headerBytes = Buffer.byteLength(headers, "utf8");
	const bodyBytes = API_STDOUT_BUDGET - headerBytes;
	harness((spawn) => {
		spawn.child.stdout.emit("data", Buffer.from(headers));
		spawn.child.stdout.emit("data", Buffer.alloc(bodyBytes, 0x61));
		spawn.child.emit("close", 0, null);
	});
	const runner = new GhApiRunner({ clock: defaultClock });
	const outcome = await runner.request("repos/o/r");
	assert.equal(outcome.kind, "response", JSON.stringify(outcome).slice(0, 200));
	if (outcome.kind === "response") {
		assert.equal(outcome.bodyBytes, bodyBytes);
	}
	assert.equal(runner.capturedBytes(), API_STDOUT_BUDGET);
});

test("budget: overflow mid-response interrupts, kills, poisons the runner, and refuses later requests", async () => {
	const spawns = harness((spawn, index) => {
		if (index === 0) {
			spawn.child.stdout.emit("data", Buffer.from("HTTP/1.1 200 OK\r\n\r\n"));
			spawn.child.stdout.emit("data", Buffer.alloc(API_STDOUT_BUDGET, 0x61));
			spawn.child.stdout.emit("data", Buffer.from("tail"));
			spawn.child.emit("close", 0, null);
		}
	});
	const runner = new GhApiRunner({ clock: defaultClock });
	const outcome = await runner.request("repos/o/r");
	assert.equal(outcome.kind, "error");
	if (outcome.kind === "error") {
		assert.ok(outcome.reason.includes("budget"));
		assert.equal(outcome.interrupted, true);
	}
	assert.ok(spawns[0]!.child.signals.includes("SIGTERM"));
	assert.equal(runner.budgetExhausted(), true);
	// A later request on the same runner is refused before spawn.
	const spawnsBefore = spawns.length;
	const refused = await runner.request("repos/o/r");
	assert.equal(refused.kind, "stop");
	assert.equal(spawns.length, spawnsBefore, "no child spawned for the refused request");
});

test("budget: a first request refused up front yields a stop, not an error", async () => {
	const spawns = harness(() => {
		throw new Error("no child may spawn when the budget is already exhausted");
	});
	const runner = new GhApiRunner({ clock: defaultClock });
	// Simulate an exhausted budget without a mid-response truncation.
	(runner as unknown as { bytes: number }).bytes = API_STDOUT_BUDGET;
	const outcome = await runner.request("repos/o/r");
	assert.equal(outcome.kind, "stop");
	if (outcome.kind === "stop") assert.ok(outcome.reason.includes("budget"));
	assert.equal(spawns.length, 0);
});

// ── Unit: headers and stderr caps ────────────────────────────────────────────

test("headers larger than the cap are treated as interrupted", async () => {
	harness((spawn) => {
		spawn.child.stdout.emit("data", Buffer.from(`HTTP/1.1 200 OK\r\nX-Big: ${"x".repeat(API_HEADERS_CAP)}\r\n\r\nbody`));
		spawn.child.emit("close", 0, null);
	});
	const runner = new GhApiRunner({ clock: defaultClock });
	const outcome = await runner.request("repos/o/r");
	assert.equal(outcome.kind, "error");
	if (outcome.kind === "error") {
		assert.equal(outcome.interrupted, true);
	}
});

test("stderr diagnostics are capped cumulatively across requests", async () => {
	harness((spawn, index) => {
		spawn.child.stdout.emit("data", Buffer.from("HTTP/1.1 404 Not Found\r\n\r\n"));
		spawn.child.stderr.emit("data", Buffer.alloc(API_STDERR_CAP, 0x78));
		spawn.child.stderr.emit("data", Buffer.alloc(API_STDERR_CAP, 0x79));
		spawn.child.emit("close", 1, null);
		void index;
	});
	const runner = new GhApiRunner({ clock: defaultClock });
	const first = await runner.request("repos/o/r/a");
	const second = await runner.request("repos/o/r/b");
	for (const outcome of [first, second]) {
		assert.equal(outcome.kind, "error");
		if (outcome.kind === "error") {
			assert.ok((outcome.stderr ?? "").length <= API_STDERR_CAP, "retained stderr must respect the cumulative cap");
		}
	}
});

// ── Unit: deadline and cancellation ──────────────────────────────────────────

test("deadline: SIGTERM at the shared deadline, SIGKILL after the grace, reaped before resolve", async () => {
	const clock = new FakeClock();
	const spawns = harness(() => {
		// Child never closes on its own.
	});
	const runner = new GhApiRunner({ clock: clock as unknown as typeof defaultClock });
	const promise = runner.request("repos/o/r");
	await untilSpawn(spawns, 1);
	assert.deepEqual(spawns[0]!.child.signals, []);

	clock.advance(API_DEADLINE_MS);
	assert.deepEqual(spawns[0]!.child.signals, ["SIGTERM"]);
	clock.advance(TEARDOWN_GRACE_MS);
	assert.deepEqual(spawns[0]!.child.signals, ["SIGTERM", "SIGKILL"]);

	spawns[0]!.child.emit("close", null, "SIGKILL");
	const outcome = await promise;
	assert.equal(outcome.kind, "error");
	if (outcome.kind === "error") {
		assert.ok(outcome.reason.includes("deadline"));
		assert.equal(outcome.interrupted, true);
	}
});

test("deadline exhausted up front: error before any spawn", async () => {
	const clock = new FakeClock();
	const spawns = harness(() => {
		throw new Error("no child may spawn past the deadline");
	});
	const runner = new GhApiRunner({ clock: clock as unknown as typeof defaultClock, deadlineAt: clock.now() - 1 });
	const outcome = await runner.request("repos/o/r");
	assert.equal(outcome.kind, "error");
	assert.equal(spawns.length, 0);
});

test("cancellation mid-request tears the child down and resolves with a cancelled error", async () => {
	const controller = new AbortController();
	const spawns = harness(() => {
		// Child held open; the test aborts below.
	});
	const runner = new GhApiRunner({ clock: defaultClock, signal: controller.signal });
	const promise = runner.request("repos/o/r");
	await untilSpawn(spawns, 1);
	controller.abort();
	await untilSpawn(spawns, 1);
	await new Promise((resolveTick) => setImmediate(resolveTick));
	assert.ok(spawns[0]!.child.signals.includes("SIGTERM"));
	spawns[0]!.child.emit("close", null, "SIGTERM");
	const outcome = await promise;
	assert.equal(outcome.kind, "error");
	if (outcome.kind === "error") {
		assert.ok(outcome.reason.includes("cancelled"));
		assert.equal(outcome.interrupted, true);
	}
});

test("cancellation before the request: error without spawning", async () => {
	const controller = new AbortController();
	controller.abort();
	const spawns = harness(() => {
		throw new Error("no child may spawn after cancellation");
	});
	const runner = new GhApiRunner({ clock: defaultClock, signal: controller.signal });
	const outcome = await runner.request("repos/o/r");
	assert.equal(outcome.kind, "error");
	assert.equal(spawns.length, 0);
});

// ── Unit: spawn failure and reaping ──────────────────────────────────────────

test("spawn error: error event resolves with a failed-to-run message and poisons the runner", async () => {
	harness((spawn) => {
		spawn.child.emit("error", Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }));
	});
	const runner = new GhApiRunner({ clock: defaultClock });
	const outcome = await runner.request("repos/o/r");
	assert.equal(outcome.kind, "error");
	if (outcome.kind === "error") {
		assert.ok(outcome.reason.includes("ENOENT"));
	}
	const refused = await runner.request("repos/o/r");
	assert.equal(refused.kind, "stop");
});

test("sync spawn throw resolves as an error result, never throws", async () => {
	setApiSpawnOverride(() => {
		throw new Error("boom");
	});
	const runner = new GhApiRunner({ clock: defaultClock });
	const outcome = await runner.request("repos/o/r");
	assert.equal(outcome.kind, "error");
	if (outcome.kind === "error") assert.ok(outcome.reason.includes("boom"));
});

test("reaping: the promise resolves only after the child reports close", async () => {
	const spawns = harness((spawn) => {
		spawn.child.stdout.emit("data", Buffer.from("HTTP/1.1 200 OK\r\n\r\n{}"));
		// No close yet.
	});
	const runner = new GhApiRunner({ clock: defaultClock });
	let settled = false;
	const promise = runner.request("repos/o/r").then((outcome) => {
		settled = true;
		return outcome;
	});
	await untilSpawn(spawns, 1);
	await new Promise((resolveTick) => setImmediate(resolveTick));
	assert.equal(settled, false, "must not resolve before close");
	spawns[0]!.child.emit("close", 0, null);
	const outcome = await promise;
	assert.equal(outcome.kind, "response");
});
