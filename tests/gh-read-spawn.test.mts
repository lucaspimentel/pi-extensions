// Tests for the gh-read child-process layer (extensions/gh-read/spawn.ts).
// Unit tests run through the setSpawnOverride seam: no real gh, no network,
// no filesystem access beyond path resolution. The worktree gate runs first
// as spawn 0 (git with git-read's sanitized environment), then the gh command
// runs as spawn 1 (with gh-read's own sanitized environment). One exemption:
// for `auth status` the gate is skipped entirely, so spawn 0 is the gh
// command itself and no git child ever spawns.
//
// Design: docs/gh-read-design.md ("Worktree enforcement", "Trust model for
// env and config", "Resource limits and failure contract").
//
// Run: node --test tests/gh-read-spawn.test.mts
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { afterEach, mock, test } from "node:test";

import { validateInvocation } from "../extensions/gh-read/validate.ts";
import {
	INJECTED_ENV,
	STRIPPED_ENV,
	TIMEOUT_MS,
	buildGhEnv,
	runGh,
} from "../extensions/gh-read/spawn.ts";
import {
	KILL_ESCALATION_MS,
	OUTPUT_CAP,
	setSpawnOverride,
} from "../extensions/shared/bounded-spawn.ts";
import { buildChildEnv, INJECTED_ENV as GIT_INJECTED_ENV, STRIPPED_ENV as GIT_STRIPPED_ENV } from "../extensions/git-read/spawn.ts";

// ── Spawn-seam harness ────────────────────────────────────────────────────────

interface FakeChild extends EventEmitter {
	stdout: EventEmitter;
	stderr: EventEmitter;
	killed: boolean;
	/** Kill signals in arrival order. */
	signals: string[];
	kill(signal?: NodeJS.Signals): boolean;
}

function fakeChild(): FakeChild {
	const child = new EventEmitter() as FakeChild;
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.killed = false;
	child.signals = [];
	child.kill = (signal?: NodeJS.Signals) => {
		child.killed = true;
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

/**
 * Installs a spawn override that records every spawn and defers the script's
 * event emissions via queueMicrotask so boundedExec's data/close handlers
 * attach first. For gated subcommands, spawn 0 is the rev-parse worktree
 * gate and spawn 1 is the gh command; for `auth status` the gate is
 * skipped, so spawn 0 is the gh command itself.
 */
function harness(script: SpawnScript): CapturedSpawn[] {
	const spawns: CapturedSpawn[] = [];
	setSpawnOverride((command, args, options) => {
		const child = fakeChild();
		const index = spawns.length;
		spawns.push({ command, args: [...args], options: options as Record<string, unknown>, child });
		queueMicrotask(() => script(spawns[index]!, index));
		return child;
	});
	return spawns;
}

/** Script: worktree gate passes with `toplevel`; the gh command closes with code/stdout/stderr. */
function scriptOk(toplevel: string, commandStdout = "", commandCode = 0, commandStderr = ""): SpawnScript {
	return (spawn, index) => {
		if (index === 0) {
			spawn.child.stdout.emit("data", Buffer.from(`${toplevel}\n`));
			spawn.child.emit("close", 0);
			return;
		}
		if (commandStderr.length > 0) spawn.child.stderr.emit("data", Buffer.from(commandStderr));
		if (commandStdout.length > 0) spawn.child.stdout.emit("data", Buffer.from(commandStdout));
		spawn.child.emit("close", commandCode);
	};
}

/** Script: the worktree gate fails (code/stdout/toplevel variants). */
function scriptGateFailure(gateCode: number, gateStdout = ""): SpawnScript {
	return (spawn, index) => {
		if (index === 0) {
			if (gateStdout.length > 0) spawn.child.stdout.emit("data", Buffer.from(gateStdout));
			spawn.child.emit("close", gateCode);
			return;
		}
		throw new Error("the gh command must not spawn when the gate fails");
	};
}

/** Waits until the nth spawn (0-based) has been recorded. */
async function untilSpawn(spawns: CapturedSpawn[], count: number): Promise<void> {
	while (spawns.length < count) await new Promise((resolveTick) => setImmediate(resolveTick));
}

function prListArgv(...flags: string[]): string[] {
	return validatedArgv("pr list", flags);
}

function authStatusArgv(...flags: string[]): string[] {
	return validatedArgv("auth status", flags);
}

function validatedArgv(subcommand: "pr list" | "auth status", flags: string[]): string[] {
	const checked = validateInvocation(subcommand, flags);
	if (!checked.ok) throw new Error(`unexpected validation failure: ${checked.reason}`);
	return checked.argv;
}

afterEach(() => {
	setSpawnOverride(null);
});

// ── Unit: environment ────────────────────────────────────────────────────────

test("gh env tables match the design", () => {
	assert.deepEqual([...STRIPPED_ENV], [
		"GH_HOST",
		"GH_REPO",
		"GH_CONFIG_DIR",
		"GH_DEBUG",
		"GH_FORCE_TTY",
		"GH_MDWIDTH",
		"GLAMOUR_STYLE",
		"GH_BROWSER",
		"BROWSER",
		"GH_EDITOR",
		"GIT_EDITOR",
		"VISUAL",
		"EDITOR",
		"GH_PATH",
		"GH_EXTENSION",
		"GH_TELEMETRY",
	]);
	assert.deepEqual({ ...INJECTED_ENV }, {
		GH_PROMPT_DISABLED: "1",
		GH_PAGER: "cat",
		GH_NO_UPDATE_NOTIFIER: "1",
		GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
		NO_COLOR: "1",
	});
	assert.equal(KILL_ESCALATION_MS, 5_000);
	assert.equal(OUTPUT_CAP, 50 * 1024);
});

test("buildGhEnv: stripped keys removed, injected values win, tokens and PATH inherited", () => {
	const saved: Record<string, string | undefined> = {};
	const poisonKeys = [
		...STRIPPED_ENV,
		"GH_PROMPT_DISABLED",
		"GH_PAGER",
		"GH_NO_UPDATE_NOTIFIER",
		"GH_NO_EXTENSION_UPDATE_NOTIFIER",
		"NO_COLOR",
	];
	for (const key of poisonKeys) {
		saved[key] = process.env[key];
		process.env[key] = "poison";
	}
	process.env.GH_TOKEN = "token-value";
	process.env.PATH = "/bin";
	try {
		const env = buildGhEnv();
		for (const key of STRIPPED_ENV) assert.equal(env[key], undefined, `${key} should be stripped`);
		for (const [key, value] of Object.entries(INJECTED_ENV)) {
			assert.equal(env[key], value, `${key} should be the injected value`);
		}
		assert.equal(env.GH_TOKEN, "token-value");
		assert.equal(env.PATH, "/bin");
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		delete process.env.GH_TOKEN;
	}
});

// ── Unit: spawn ordering, options, env ───────────────────────────────────────

test("rev-parse gate runs first, then the validated argv verbatim; both spawns sanitized", async () => {
	const spawns = harness(scriptOk("/repo", "open PRs\n"));
	const result = await runGh(prListArgv("--state", "open"), "/repo");
	assert.equal(result.ok, true);
	assert.equal(spawns.length, 2);
	assert.deepEqual(spawns[0]!.args, ["rev-parse", "--show-toplevel"]);
	assert.deepEqual(spawns[1]!.args, ["pr", "list", "--state", "open"]);
	assert.equal(spawns[0]!.command, "git");
	assert.equal(spawns[1]!.command, "gh");
	for (const spawn of spawns) {
		assert.equal(spawn.options.shell, false);
		assert.equal(spawn.options.windowsHide, true);
		assert.deepEqual(spawn.options.stdio, ["ignore", "pipe", "pipe"]);
		assert.equal(spawn.options.cwd, "/repo");
	}
	// Gate spawn uses git-read's sanitized git environment.
	const gateEnv = spawns[0]!.options.env as Record<string, string | undefined>;
	for (const key of GIT_STRIPPED_ENV) assert.equal(gateEnv[key], undefined, `${key} should be stripped`);
	for (const [key, value] of Object.entries(GIT_INJECTED_ENV)) assert.equal(gateEnv[key], value);
	// Command spawn uses gh-read's sanitized gh environment.
	const ghEnv = spawns[1]!.options.env as Record<string, string | undefined>;
	for (const key of STRIPPED_ENV) assert.equal(ghEnv[key], undefined, `${key} should be stripped`);
	for (const [key, value] of Object.entries(INJECTED_ENV)) assert.equal(ghEnv[key], value);
});

// ── Unit: worktree gate ──────────────────────────────────────────────────────

test("gate failure, empty toplevel, and outside-cwd all fail closed with one message", async () => {
	// Gate command fails.
	harness(scriptGateFailure(128));
	const failed = await runGh(prListArgv(), "/repo");
	assert.equal(failed.ok, false);
	assert.equal(failed.text, "gh_read: not inside a git worktree");

	// Gate prints an empty toplevel.
	harness(scriptGateFailure(0));
	const empty = await runGh(prListArgv(), "/repo");
	assert.equal(empty.ok, false);
	assert.equal(empty.text, "gh_read: not inside a git worktree");

	// Gate passes but cwd is outside the toplevel.
	harness(scriptOk("/other/repo"));
	const outside = await runGh(prListArgv(), "/repo");
	assert.equal(outside.ok, false);
	assert.equal(outside.text, "gh_read: not inside a git worktree");
});

test("auth status skips the worktree gate entirely: no git spawn, gh runs anywhere", async () => {
	// Index 0 is the gh child itself; if the rev-parse gate ever spawned, the
	// command/count assertions below would catch it.
	const spawns = harness((spawn) => {
		spawn.child.stdout.emit("data", Buffer.from('{"hosts":{}}'));
		spawn.child.emit("close", 0);
	});
	const result = await runGh(authStatusArgv("--hostname", "github.com"), "/repo");
	assert.equal(result.ok, true);
	assert.equal(spawns.length, 1, "only the gh child must spawn; the rev-parse gate is skipped");
	assert.equal(spawns[0]!.command, "gh");
	assert.deepEqual(spawns[0]!.args, ["auth", "status", "--hostname", "github.com", "--json", "hosts"]);
	assert.equal(spawns[0]!.options.cwd, "/repo");
});

test("other subcommands still gate: pr list fails closed outside a worktree", async () => {
	harness(scriptGateFailure(128));
	const result = await runGh(prListArgv(), "/repo");
	assert.equal(result.ok, false);
	assert.equal(result.text, "gh_read: not inside a git worktree");
});

// ── Unit: exit codes, API errors passthrough, and text assembly ─────────────

test("exit 0: ok true with decoded stdout", async () => {
	harness(scriptOk("/repo", "#123 fixing things\n"));
	const result = await runGh(prListArgv(), "/repo");
	assert.equal(result.ok, true);
	assert.equal(result.text, "#123 fixing things\n");
});

test("API/auth errors pass through verbatim with the exit-code prefix and no hints", async () => {
	harness(
		scriptOk("/repo", "", 1, "gh: Could not resolve to a PullRequest with the number of 123. (403)\ngh: * hint: see docs\n"),
	);
	const result = await runGh(prListArgv(), "/repo");
	assert.equal(result.ok, false);
	assert.ok(result.text.startsWith("gh_read: gh exited with code 1\n"), result.text);
	assert.ok(result.text.includes("Could not resolve to a PullRequest"));
	assert.ok(result.text.includes("hint: see docs"));
});

// ── Unit: truncation ─────────────────────────────────────────────────────────

test("truncation: bytes past the shared cap are dropped, notice shows shown/total", async () => {
	const chunkA = Buffer.alloc(30 * 1024, 0x61); // 'a'
	const chunkB = Buffer.alloc(30 * 1024, 0x62); // 'b'
	harness((spawn, index) => {
		if (index === 0) {
			spawn.child.stdout.emit("data", Buffer.from("/repo\n"));
			spawn.child.emit("close", 0);
			return;
		}
		spawn.child.stdout.emit("data", chunkA);
		spawn.child.stderr.emit("data", chunkB);
		spawn.child.emit("close", 0);
	});
	const result = await runGh(prListArgv(), "/repo");
	// Truncation is not an error.
	assert.equal(result.ok, true);
	assert.equal(
		result.text,
		`${chunkA.toString("utf8")}\n[gh_read: output truncated, showing ${OUTPUT_CAP} of ${30 * 1024 * 2} bytes]`,
	);
});

test("truncation: multibyte UTF-8 split across chunks decodes intact", async () => {
	harness((spawn, index) => {
		if (index === 0) {
			spawn.child.stdout.emit("data", Buffer.from("/repo\n"));
			spawn.child.emit("close", 0);
			return;
		}
		// 'a' + first two bytes of '€' (E2 82 AC), then the last byte + 'b'.
		spawn.child.stdout.emit("data", Buffer.from([0x61, 0xe2, 0x82]));
		spawn.child.stdout.emit("data", Buffer.from([0xac, 0x62]));
		spawn.child.emit("close", 0);
	});
	const result = await runGh(prListArgv(), "/repo");
	assert.equal(result.ok, true);
	assert.equal(result.text, "a€b");
});

// ── Unit: timeout ────────────────────────────────────────────────────────────

test("timeout: SIGTERM then SIGKILL escalation, reaped on close, error result", async () => {
	const spawns = harness((spawn, index) => {
		if (index === 0) {
			spawn.child.stdout.emit("data", Buffer.from("/repo\n"));
			spawn.child.emit("close", 0);
			return;
		}
		// gh command held open; the test escalates and closes it below.
	});
	mock.timers.enable({ apis: ["setTimeout"] });
	try {
		const promise = runGh(prListArgv(), "/repo");
		await untilSpawn(spawns, 2);
		assert.deepEqual(spawns[1]!.child.signals, []);
		mock.timers.tick(TIMEOUT_MS);
		assert.deepEqual(spawns[1]!.child.signals, ["SIGTERM"]);
		mock.timers.tick(KILL_ESCALATION_MS);
		assert.deepEqual(spawns[1]!.child.signals, ["SIGTERM", "SIGKILL"]);
		// Reap: the result only resolves once the child reports close.
		spawns[1]!.child.emit("close", null, "SIGKILL");
		const result = await promise;
		assert.equal(result.ok, false);
		assert.ok(result.text.startsWith(`gh_read: gh timed out after ${TIMEOUT_MS} ms`), result.text);
	} finally {
		mock.timers.reset();
	}
});

// ── Unit: spawn failure ──────────────────────────────────────────────────────

test("spawn failure: error event resolves with a failed-to-run message", async () => {
	harness((spawn, index) => {
		if (index === 0) {
			spawn.child.stdout.emit("data", Buffer.from("/repo\n"));
			spawn.child.emit("close", 0);
			return;
		}
		spawn.child.emit("error", Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }));
	});
	const result = await runGh(prListArgv(), "/repo");
	assert.equal(result.ok, false);
	assert.ok(result.text.startsWith("gh_read: failed to run gh: "), result.text);
	assert.ok(result.text.includes("ENOENT"));
});

// ── Unit: auth status env and failure contract ────────────────────────────────

test("auth status uses the sanitized gh environment (no gate spawn)", async () => {
	const spawns = harness((spawn) => {
		spawn.child.stdout.emit("data", Buffer.from('{"hosts":{}}'));
		spawn.child.emit("close", 0);
	});
	await runGh(authStatusArgv(), "/repo");
	assert.equal(spawns.length, 1);
	const ghEnv = spawns[0]!.options.env as Record<string, string | undefined>;
	for (const key of STRIPPED_ENV) assert.equal(ghEnv[key], undefined, `${key} should be stripped`);
	for (const [key, value] of Object.entries(INJECTED_ENV)) assert.equal(ghEnv[key], value);
});

test("auth status: nonzero gh exit (not logged in) keeps the gh_read failure contract", async () => {
	harness((spawn) => {
		spawn.child.stderr.emit("data", Buffer.from("gh: not logged in to any hosts\n"));
		spawn.child.emit("close", 1);
	});
	const result = await runGh(authStatusArgv(), "/repo");
	assert.equal(result.ok, false);
	assert.ok(result.text.startsWith("gh_read: gh exited with code 1\n"), result.text);
	assert.ok(result.text.includes("not logged in"));
});

test("auth status: exit 0 passes the --json hosts payload through verbatim", async () => {
	harness((spawn) => {
		spawn.child.stdout.emit("data", Buffer.from('{"hosts":{}}'));
		spawn.child.emit("close", 0);
	});
	const result = await runGh(authStatusArgv(), "/repo");
	assert.equal(result.ok, true);
	assert.equal(result.text, '{"hosts":{}}');
});
