// Tests for the git-read child-process layer (extensions/git-read/spawn.ts).
// Unit tests run through the setSpawnOverride seam: no real git, no
// filesystem access beyond path resolution. Integration tests run real git
// in throwaway temp repos to pin end-to-end behavior (worktree gate,
// --no-optional-locks, env stripping, real truncation).
//
// Design: docs/git-read-design.md ("Worktree enforcement", "Trust model for
// config, env, and helpers", "Resource limits and failure contract").
//
// Run: node --test tests/git-read-spawn.test.mts
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, mock, test } from "node:test";

import { GLOBAL_OPTIONS, validateInvocation } from "../extensions/git-read/validate.ts";
import {
	INJECTED_ENV,
	KILL_ESCALATION_MS,
	OUTPUT_CAP,
	STRIPPED_ENV,
	TIMEOUT_MS,
	buildChildEnv,
	cwdInsideToplevel,
	runGit,
	setSpawnOverride,
} from "../extensions/git-read/spawn.ts";

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
 * event emissions via queueMicrotask so execGit's data/close handlers attach
 * first. Spawn 0 is the rev-parse worktree gate; spawn 1 is the read command.
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

/** Script: worktree gate passes with `toplevel`; the command closes with code/stdout/stderr. */
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

/** Waits until the nth spawn (0-based) has been recorded. */
async function untilSpawn(spawns: CapturedSpawn[], count: number): Promise<void> {
	while (spawns.length < count) await new Promise((resolveTick) => setImmediate(resolveTick));
}

const STATUS_ARGV = [...GLOBAL_OPTIONS, "status", "--porcelain"];

function showArgv(rev: string): string[] {
	const checked = validateInvocation("show", [rev]);
	if (!checked.ok) assert.fail(`unexpected validation failure: ${checked.reason}`);
	return checked.argv;
}

afterEach(() => {
	setSpawnOverride(null);
});

// ── Unit: constants and environment ──────────────────────────────────────────

test("constants match the design", () => {
	assert.equal(OUTPUT_CAP, 50 * 1024);
	assert.equal(TIMEOUT_MS, 15_000);
	assert.deepEqual([...STRIPPED_ENV], [
		"GIT_DIR",
		"GIT_WORK_TREE",
		"GIT_INDEX_FILE",
		"GIT_OBJECT_DIRECTORY",
		"GIT_ALTERNATE_OBJECT_DIRECTORIES",
		"GIT_COMMON_DIR",
		"GIT_NAMESPACE",
		"GIT_CONFIG_COUNT",
		"GIT_EXTERNAL_DIFF",
	]);
	assert.deepEqual({ ...INJECTED_ENV }, {
		GIT_PAGER: "cat",
		GIT_TERMINAL_PROMPT: "0",
		GIT_ASKPASS: "echo",
		GIT_CONFIG_SYSTEM: "/dev/null",
		GIT_CONFIG_GLOBAL: "/dev/null",
	});
	assert.equal(KILL_ESCALATION_MS, 5_000);
});

test("buildChildEnv: stripped keys removed, injected values win, rest inherited", () => {
	const poisonKeys = [...STRIPPED_ENV, "GIT_PAGER", "GIT_TERMINAL_PROMPT", "GIT_ASKPASS", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_GLOBAL"];
	const saved: Record<string, string | undefined> = {};
	for (const key of poisonKeys) {
		saved[key] = process.env[key];
		process.env[key] = "poison";
	}
	const pathValue = process.env.PATH;
	const homeValue = process.env.HOME;
	try {
		const env = buildChildEnv();
		for (const key of STRIPPED_ENV) assert.equal(env[key], undefined, `${key} should be stripped`);
		for (const [key, value] of Object.entries(INJECTED_ENV)) {
			assert.equal(env[key], value, `${key} should be the injected value`);
		}
		assert.equal(env.PATH, pathValue);
		assert.equal(env.HOME, homeValue);
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});

// ── Unit: spawn ordering, options, env ───────────────────────────────────────

test("rev-parse gate runs first, then the validated argv verbatim; options sanitized for both", async () => {
	const spawns = harness(scriptOk("/repo", "## main\n"));
	const result = await runGit(STATUS_ARGV, "/repo");
	assert.equal(result.ok, true);
	assert.equal(spawns.length, 2);
	assert.deepEqual(spawns[0]!.args, [...GLOBAL_OPTIONS, "rev-parse", "--show-toplevel"]);
	assert.deepEqual(spawns[1]!.args, STATUS_ARGV);
	for (const spawn of spawns) {
		assert.equal(spawn.command, "git");
		assert.equal(spawn.options.shell, false);
		assert.equal(spawn.options.windowsHide, true);
		assert.deepEqual(spawn.options.stdio, ["ignore", "pipe", "pipe"]);
		assert.equal(spawn.options.cwd, "/repo");
		const env = spawn.options.env as Record<string, string | undefined>;
		for (const key of STRIPPED_ENV) assert.equal(env[key], undefined, `${key} should be stripped`);
		for (const [key, value] of Object.entries(INJECTED_ENV)) assert.equal(env[key], value);
	}
});

test("diff argv carries --no-ext-diff/--no-textconv; status argv does not", async () => {
	const diffChecked = validateInvocation("diff", ["--stat"]);
	if (!diffChecked.ok) assert.fail(`unexpected validation failure: ${diffChecked.reason}`);
	const spawns = harness(scriptOk("/repo"));
	const result = await runGit(diffChecked.argv, "/repo");
	assert.equal(result.ok, true);
	assert.deepEqual(spawns[1]!.args, [...GLOBAL_OPTIONS, "diff", "--no-ext-diff", "--no-textconv", "--stat"]);
	assert.ok(spawns[1]!.args.includes("--no-ext-diff"));
	assert.ok(spawns[1]!.args.includes("--no-textconv"));
	// The command-specific injections are limited to diff/log/show; status is bare.
	assert.ok(!STATUS_ARGV.includes("--no-ext-diff"));
	assert.ok(!STATUS_ARGV.includes("--no-textconv"));
});

// ── Unit: exit codes and text assembly ───────────────────────────────────────

test("exit 0: ok true with decoded stdout", async () => {
	const spawns = harness(scriptOk("/repo", " M file.txt\n"));
	const result = await runGit(STATUS_ARGV, "/repo");
	assert.equal(result.ok, true);
	assert.equal(result.text, " M file.txt\n");
	assert.equal(spawns.length, 2);
});

test("non-zero exit: ok false with code, stderr, and any stdout", async () => {
	harness(scriptOk("/repo", "partial\n", 128, "fatal: bad revision 'nope'\n"));
	const result = await runGit(showArgv("nope"), "/repo");
	assert.equal(result.ok, false);
	assert.ok(result.text.startsWith("git_read: git exited with code 128\n"), result.text);
	assert.ok(result.text.includes("fatal: bad revision 'nope'\n"));
	assert.ok(result.text.includes("partial\n"));
});

// ── Unit: truncation ─────────────────────────────────────────────────────────

test("truncation: bytes past the shared cap are dropped, notice shows shown/total", async () => {
	const chunkA = Buffer.alloc(30 * 1024, 0x61); // 'a'
	const chunkB = Buffer.alloc(30 * 1024, 0x62); // 'b'
	const spawns = harness((spawn, index) => {
		if (index === 0) {
			spawn.child.stdout.emit("data", Buffer.from("/repo\n"));
			spawn.child.emit("close", 0);
			return;
		}
		spawn.child.stdout.emit("data", chunkA);
		spawn.child.stderr.emit("data", chunkB);
		spawn.child.emit("close", 0);
	});
	const result = await runGit(STATUS_ARGV, "/repo");
	// Truncation is not an error.
	assert.equal(result.ok, true);
	// stdout arrived before the cap was exceeded, so all of it is retained.
	assert.equal(result.text, `${chunkA.toString("utf8")}\n[git_read: output truncated, showing ${OUTPUT_CAP} of ${30 * 1024 * 2} bytes]`);
	assert.ok(Buffer.byteLength(result.text) <= OUTPUT_CAP + 200);
	// Both streams were drained: total counts everything, retention is capped.
	assert.ok(spawns[1]!.child.stdout.listenerCount("data") > 0);
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
	const result = await runGit(STATUS_ARGV, "/repo");
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
		// Read command held open; the test escalates and closes it below.
	});
	mock.timers.enable({ apis: ["setTimeout"] });
	try {
		const promise = runGit(STATUS_ARGV, "/repo");
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
		assert.ok(result.text.startsWith(`git_read: git timed out after ${TIMEOUT_MS} ms`), result.text);
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
		spawn.child.emit("error", Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" }));
	});
	const result = await runGit(STATUS_ARGV, "/repo");
	assert.equal(result.ok, false);
	assert.ok(result.text.startsWith("git_read: failed to run git: "), result.text);
	assert.ok(result.text.includes("ENOENT"));
});

// ── Unit: cwdInsideToplevel ──────────────────────────────────────────────────

test("cwdInsideToplevel table", () => {
	assert.equal(cwdInsideToplevel("/repo", "/repo"), true);
	assert.equal(cwdInsideToplevel("/repo/sub", "/repo"), true);
	assert.equal(cwdInsideToplevel("/repo", "/repo/sub"), false);
	assert.equal(cwdInsideToplevel("/other", "/repo"), false);
	assert.equal(cwdInsideToplevel("/repo/sub/", "/repo/"), true);
	// Shared-prefix-but-not-inside must not pass.
	assert.equal(cwdInsideToplevel("/repository", "/repo"), false);
	// Windows-style separators normalize via path resolution on both platforms.
	assert.equal(cwdInsideToplevel("C:/x/sub", "C:/x"), true);
	assert.equal(cwdInsideToplevel("C:/x", "C:/x/other"), false);
});

// ── Unit: worktree gate failure paths ────────────────────────────────────────

test("worktree gate: rev-parse non-zero exit fails closed with the single message", async () => {
	const spawns = harness((spawn, index) => {
		if (index === 0) {
			spawn.child.stderr.emit("data", Buffer.from("fatal: not a git repository\n"));
			spawn.child.emit("close", 128);
			return;
		}
		assert.fail("read command must not spawn after a failed worktree gate");
	});
	const result = await runGit(STATUS_ARGV, "/tmp");
	assert.equal(result.ok, false);
	assert.equal(result.text, "git_read: not inside a git worktree");
	assert.equal(spawns.length, 1);
});

test("worktree gate: empty toplevel fails closed", async () => {
	harness((spawn, index) => {
		if (index === 0) {
			spawn.child.emit("close", 0);
			return;
		}
		assert.fail("read command must not spawn after a failed worktree gate");
	});
	const result = await runGit(STATUS_ARGV, "/tmp");
	assert.equal(result.ok, false);
	assert.equal(result.text, "git_read: not inside a git worktree");
});

test("worktree gate: cwd outside the returned toplevel fails closed", async () => {
	harness(scriptOk("/repo"));
	const result = await runGit(STATUS_ARGV, "/elsewhere");
	assert.equal(result.ok, false);
	assert.equal(result.text, "git_read: not inside a git worktree");
});

// ── Integration: real git in temp repos ──────────────────────────────────────

function gitSync(args: string[], cwd: string): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	assert.equal(result.status, 0, `setup git ${args.join(" ")} failed: ${result.stderr}`);
	return result.stdout;
}

function makeRepo(): string {
	const repo = mkdtempSync(path.join(tmpdir(), "git-read-spawn-"));
	gitSync(["init"], repo);
	gitSync(["config", "user.email", "test@example.com"], repo);
	gitSync(["config", "user.name", "Test"], repo);
	writeFileSync(path.join(repo, "file.txt"), "hello\n");
	gitSync(["add", "."], repo);
	gitSync(["commit", "-m", "init"], repo);
	return repo;
}

function indexHash(repo: string): string {
	return createHash("sha256").update(readFileSync(path.join(repo, ".git", "index"))).digest("hex");
}

test("integration: status succeeds and leaves the index byte-identical (--no-optional-locks)", async () => {
	const repo = makeRepo();
	try {
		// A dirty tracked file makes status want to refresh the index; the
		// no-optional-locks injection must keep it from being rewritten.
		writeFileSync(path.join(repo, "file.txt"), "changed\n");
		const before = indexHash(repo);
		const result = await runGit(STATUS_ARGV, repo);
		assert.equal(result.ok, true, result.text);
		assert.ok(result.text.includes("M file.txt"), result.text);
		assert.equal(indexHash(repo), before);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("integration: runGit from a nested subdir passes the worktree gate", async () => {
	const repo = makeRepo();
	try {
		const sub = path.join(repo, "src", "deep");
		mkdirSync(sub, { recursive: true });
		const result = await runGit(STATUS_ARGV, sub);
		assert.equal(result.ok, true, result.text);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("integration: plain directory outside any repo fails the worktree gate", async () => {
	const plain = mkdtempSync(path.join(tmpdir(), "git-read-plain-"));
	try {
		const result = await runGit(STATUS_ARGV, plain);
		assert.equal(result.ok, false);
		assert.equal(result.text, "git_read: not inside a git worktree");
	} finally {
		rmSync(plain, { recursive: true, force: true });
	}
});

test("integration: inherited GIT_DIR poison is stripped", async () => {
	const repo = makeRepo();
	try {
		const saved = process.env.GIT_DIR;
		process.env.GIT_DIR = "/nonexistent/bogus.git";
		try {
			const result = await runGit(STATUS_ARGV, repo);
			assert.equal(result.ok, true, result.text);
		} finally {
			if (saved === undefined) delete process.env.GIT_DIR;
			else process.env.GIT_DIR = saved;
		}
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("integration: large committed file truncates with a byte-accurate notice", async () => {
	const repo = makeRepo();
	try {
		const big = "x".repeat(999) + "\n";
		writeFileSync(path.join(repo, "big.txt"), big.repeat(200));
		gitSync(["add", "big.txt"], repo);
		gitSync(["commit", "-m", "big"], repo);
		const result = await runGit(showArgv("HEAD"), repo);
		assert.equal(result.ok, true, result.text);
		const notice = `[git_read: output truncated, showing ${OUTPUT_CAP} of `;
		assert.ok(result.text.includes(notice), `missing truncation notice: ${result.text.slice(-120)}`);
		assert.ok(Buffer.byteLength(result.text) <= OUTPUT_CAP + 200, "retained text must stay bounded");
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});
