// Tests for the git-read child-process layer (extensions/git-read/spawn.ts).
// Unit tests run through the setSpawnOverride seam: no real git, no
// filesystem access beyond path resolution. Integration tests run real git
// in throwaway temp repos to pin end-to-end behavior (worktree gate,
// --no-optional-locks, env stripping, real truncation, and every newly
// allowlisted flag form).
//
// Design: docs/git-read-design.md ("Worktree enforcement", "Trust model for
// config, env, and helpers", "Resource limits and failure contract").
//
// Run: node --test tests/git-read-spawn.test.mts
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, mock, test } from "node:test";

import {
	DATE_FORMATS,
	FORMAT_SPECIFIERS,
	GLOBAL_OPTIONS,
	PRETTY_PRESETS,
	validateInvocation,
	type GitSubcommand,
} from "../extensions/git-read/validate.ts";
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
import gitReadExtension from "../extensions/git-read/index.ts";

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

/** Validates `subcommand`/`args`, failing the test when validation rejects them. */
function validatedArgv(subcommand: GitSubcommand, args: string[]): string[] {
	const checked = validateInvocation(subcommand, args);
	if (!checked.ok) assert.fail(`unexpected validation failure for ${subcommand} ${args.join(" ")}: ${checked.reason}`);
	return checked.argv;
}

function showArgv(rev: string): string[] {
	return validatedArgv("show", [rev]);
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
	assert.equal(result.exitCode, 0);
	assert.equal(result.timedOut, false);
	assert.equal(result.truncated, false);
	assert.equal(result.failureReason, undefined);
	assert.equal(spawns.length, 2);
});

test("non-zero exit: ok false with code, stderr, and any stdout", async () => {
	harness(scriptOk("/repo", "partial\n", 128, "fatal: bad revision 'nope'\n"));
	const result = await runGit(showArgv("nope"), "/repo");
	assert.equal(result.ok, false);
	assert.equal(result.exitCode, 128);
	assert.equal(result.timedOut, false);
	assert.equal(result.truncated, false);
	assert.equal(typeof result.failureReason, "string");
	assert.ok(!result.failureReason!.startsWith("git_read: "), "the structured reason is prefix-free");
	assert.ok(result.failureReason!.includes("128"), result.failureReason);
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
	assert.equal(result.truncated, true);
	assert.equal(result.failureReason, undefined, "a capped success is still a success");
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
		assert.equal(result.timedOut, true);
		assert.equal(result.exitCode, null);
		assert.match(result.failureReason ?? "", /timed out after \d+ ms/);
		assert.ok(!result.failureReason!.startsWith("git_read: "), "the structured reason is prefix-free");
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
	assert.equal(result.exitCode, null);
	assert.equal(result.timedOut, false);
	assert.equal(result.truncated, false);
	assert.match(result.failureReason ?? "", /ENOENT/);
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
	assert.equal(result.exitCode, null);
	assert.equal(result.timedOut, false);
	assert.equal(result.truncated, false);
	assert.equal(result.failureReason, "not inside a git worktree");
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
	assert.equal(result.exitCode, null);
	assert.equal(result.failureReason, "not inside a git worktree");
});

test("worktree gate: cwd outside the returned toplevel fails closed", async () => {
	harness(scriptOk("/repo"));
	const result = await runGit(STATUS_ARGV, "/elsewhere");
	assert.equal(result.ok, false);
	assert.equal(result.text, "git_read: not inside a git worktree");
	assert.equal(result.exitCode, null);
	assert.equal(result.timedOut, false);
	assert.equal(result.truncated, false);
	assert.equal(result.failureReason, "not inside a git worktree");
});

// ── Integration: real git in temp repos ──────────────────────────────────────

/**
 * Environment for the fixture's own git commands: no user or system git config,
 * so a developer's signing setup, hooks path, commit template, or default
 * branch cannot change the repository this fixture builds. Identity is set on
 * the fixture repository itself.
 */
const HERMETIC_GIT_ENV = { ...process.env, GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

function gitSync(args: string[], cwd: string): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", env: HERMETIC_GIT_ENV });
	assert.equal(result.status, 0, `setup git ${args.join(" ")} failed: ${result.stderr}`);
	return result.stdout;
}

/** Runs a setup git command that reads its input from stdin. */
function gitInput(args: string[], cwd: string, input: string): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", env: HERMETIC_GIT_ENV, input });
	assert.equal(result.status, 0, `setup git ${args.join(" ")} failed: ${result.stderr}`);
	return result.stdout;
}

/**
 * Runs git outside the tool, with the fixture's hermetic environment: the
 * reference point for what plain git does with the same repository.
 */
function rawGit(args: string[], cwd: string): void {
	spawnSync("git", args, { cwd, encoding: "utf8", env: HERMETIC_GIT_ENV });
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

/** Two commits with distinct subjects and identities, for filter and format flags. */
function makeHistoryRepo(): string {
	const repo = mkdtempSync(path.join(tmpdir(), "git-read-flags-"));
	gitSync(["init"], repo);
	gitSync(["config", "user.email", "first@example.com"], repo);
	gitSync(["config", "user.name", "First Author"], repo);
	writeFileSync(path.join(repo, "file.txt"), "hello\n");
	gitSync(["add", "."], repo);
	gitSync(["commit", "-m", "first subject"], repo);
	gitSync(["config", "user.email", "second@example.com"], repo);
	gitSync(["config", "user.name", "Second Author"], repo);
	writeFileSync(path.join(repo, "second.txt"), "second\n");
	gitSync(["add", "."], repo);
	gitSync(["commit", "-m", "second subject"], repo);
	return repo;
}

/** Validates `args` for `subcommand`, then runs the emitted argv through real git. */
async function runValidated(subcommand: GitSubcommand, args: string[], cwd: string) {
	return runGit(validatedArgv(subcommand, args), cwd);
}

/**
 * A repo whose HEAD is a commit carrying a (bogus) `gpgsig` header, so any
 * signature display runs the configured gpg program. `gpg.program` points at a
 * script that records its own invocation, which `gpgRan` reads back.
 */
function makeSignatureRepo(): string {
	const repo = mkdtempSync(path.join(tmpdir(), "git-read-gpg-"));
	gitSync(["init"], repo);
	gitSync(["config", "user.email", "test@example.com"], repo);
	gitSync(["config", "user.name", "Test"], repo);
	writeFileSync(path.join(repo, "file.txt"), "hello\n");
	gitSync(["add", "."], repo);
	gitSync(["commit", "-m", "init"], repo);
	const raw = [
		`tree ${gitSync(["rev-parse", "HEAD^{tree}"], repo).trim()}`,
		`parent ${gitSync(["rev-parse", "HEAD"], repo).trim()}`,
		"author Test <test@example.com> 1000000000 +0000",
		"committer Test <test@example.com> 1000000000 +0000",
		"gpgsig -----BEGIN PGP SIGNATURE-----",
		" ",
		" iQEcBAABCgAGBQJ",
		" =abcd",
		" -----END PGP SIGNATURE-----",
		"",
		"signed",
		"",
	].join("\n");
	const sha = gitInput(["hash-object", "-t", "commit", "-w", "--stdin"], repo, raw).trim();
	gitSync(["update-ref", "HEAD", sha], repo);
	const program = path.join(repo, "gpg.sh");
	writeFileSync(program, '#!/bin/sh\necho invoked >> "$(dirname "$0")/gpg.log"\n');
	chmodSync(program, 0o755);
	gitSync(["config", "gpg.program", program], repo);
	return repo;
}

/** True when the fixture's gpg program has run since the last reset. */
function gpgRan(repo: string): boolean {
	return existsSync(path.join(repo, "gpg.log"));
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
		assert.equal(result.truncated, true);
		assert.equal(result.failureReason, undefined);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

// ── Integration: newly allowlisted flag forms against real git ────────────────

test("integration: log count forms and the new log flags run real git", async () => {
	const repo = makeHistoryRepo();
	try {
		for (const args of [
			["-1", "--format=%s"],
			["-n1", "--format=%s"],
			["-n", "1", "--format=%s"],
			["--max-count=1", "--format=%s"],
		]) {
			const result = await runValidated("log", args, repo);
			assert.equal(result.ok, true, `${args.join(" ")}: ${result.text}`);
			assert.equal(result.text.trim(), "second subject", args.join(" "));
		}
		const bounded = await runValidated("log", ["-2", "--format=%s"], repo);
		assert.equal(bounded.ok, true, bounded.text);
		assert.deepEqual(bounded.text.trim().split("\n"), ["second subject", "first subject"]);
		const noMerges = await runValidated("log", ["--no-merges", "-1", "--format=%s"], repo);
		assert.equal(noMerges.ok, true, noMerges.text);
		assert.equal(noMerges.text.trim(), "second subject");
		const firstParent = await runValidated("log", ["--first-parent", "-1", "--format=%s"], repo);
		assert.equal(firstParent.ok, true, firstParent.text);
		assert.equal(firstParent.text.trim(), "second subject");
		const decorated = await runValidated("log", ["--decorate", "-1"], repo);
		assert.equal(decorated.ok, true, decorated.text);
		assert.ok(decorated.text.includes("HEAD"), decorated.text);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("integration: show boolean and count forms run real git", async () => {
	const repo = makeHistoryRepo();
	try {
		const noPatch = await runValidated("show", ["--no-patch", "-1", "--format=%s"], repo);
		assert.equal(noPatch.ok, true, noPatch.text);
		assert.equal(noPatch.text.trim(), "second subject");
		assert.ok(!noPatch.text.includes("+second"), "no patch body under --no-patch");
		const shortNoPatch = await runValidated("show", ["-s", "-1", "--format=%s"], repo);
		assert.equal(shortNoPatch.ok, true, shortNoPatch.text);
		assert.equal(shortNoPatch.text.trim(), "second subject");
		const oneline = await runValidated("show", ["--oneline", "-1"], repo);
		assert.equal(oneline.ok, true, oneline.text);
		assert.ok(oneline.text.includes("second subject"), oneline.text);
		const patched = await runValidated("show", ["-p", "-1"], repo);
		assert.equal(patched.ok, true, patched.text);
		assert.ok(patched.text.includes("+second"), patched.text);
		const longPatch = await runValidated("show", ["--patch", "-1"], repo);
		assert.equal(longPatch.ok, true, longPatch.text);
		assert.ok(longPatch.text.includes("+second"), longPatch.text);
		const twoCommits = await runValidated("show", ["-2", "--no-patch", "--format=%s"], repo);
		assert.equal(twoCommits.ok, true, twoCommits.text);
		assert.equal(twoCommits.text.trim().split("\n").length, 2);
		const dated = await runValidated("show", ["-1", "--no-patch", "--date=iso", "--format=%ad"], repo);
		assert.equal(dated.ok, true, dated.text);
		assert.match(dated.text.trim(), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} /);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("integration: diff --check reports whitespace while -w and --ignore-all-space ignore it", async () => {
	const repo = makeRepo();
	try {
		// A whitespace-only change: the ignore flags suppress it, --check reports it.
		writeFileSync(path.join(repo, "file.txt"), "hello   \n");
		const plain = await runValidated("diff", [], repo);
		assert.equal(plain.ok, true, plain.text);
		assert.ok(plain.text.includes("+hello   "), plain.text);
		const ignored = await runValidated("diff", ["-w"], repo);
		assert.equal(ignored.ok, true, ignored.text);
		assert.equal(ignored.text.trim(), "", "a whitespace-only change disappears under -w");
		const ignoredLong = await runValidated("diff", ["--ignore-all-space"], repo);
		assert.equal(ignoredLong.text.trim(), "");
		const checked = await runValidated("diff", ["--check"], repo);
		assert.equal(checked.ok, false);
		assert.equal(checked.exitCode, 2);
		assert.equal(checked.failureReason, "git exited with code 2");
		assert.ok(checked.text.includes("trailing whitespace"), checked.text);
		// The ignoring flag silences --check too when the whitespace difference
		// is the whole change.
		const checkedIgnored = await runValidated("diff", ["--check", "-w"], repo);
		assert.equal(checkedIgnored.ok, true, checkedIgnored.text);
		// An added line with trailing whitespace is a real change, so --check
		// still exits 2 alongside -w.
		writeFileSync(path.join(repo, "file.txt"), "hello world\nbad   \n");
		const added = await runValidated("diff", ["--check", "-w"], repo);
		assert.equal(added.ok, false, added.text);
		assert.equal(added.exitCode, 2);
		assert.ok(added.text.includes("trailing whitespace"), added.text);
		// A whitespace-free change passes --check.
		writeFileSync(path.join(repo, "file.txt"), "hello world\n");
		const clean = await runValidated("diff", ["--check"], repo);
		assert.equal(clean.ok, true, clean.text);
		assert.equal(clean.text.trim(), "");
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("integration: repo config cannot drive gpg through log or show", async () => {
	const repo = makeSignatureRepo();
	try {
		gitSync(["config", "log.showSignature", "true"], repo);
		gitSync(["config", "format.pretty", "%G? %h"], repo);
		const head = gitSync(["rev-parse", "HEAD"], repo).trim();
		const gpgLog = path.join(repo, "gpg.log");
		const resetGpgLog = () => rmSync(gpgLog, { force: true });
		// Premise for each override: plain git honours the repository setting and
		// runs the program, so a later "gpg did not run" cannot be vacuous.
		rawGit(["--no-pager", "log", "-1", "--format=%H", head], repo);
		assert.equal(gpgRan(repo), true, "premise: log.showSignature runs the configured program");
		resetGpgLog();
		rawGit(["--no-pager", "-c", "log.showSignature=false", "log", "-1", head], repo);
		assert.equal(gpgRan(repo), true, "premise: a %G in format.pretty runs the configured program");
		resetGpgLog();
		// The injected -c overrides win over both repository settings.
		const formatted = await runValidated("log", ["-1", "--format=%H", head], repo);
		assert.equal(formatted.ok, true, formatted.text);
		assert.equal(formatted.text.trim(), head);
		assert.equal(gpgRan(repo), false, "log.showSignature must be overridden");
		const plain = await runValidated("log", ["-1", head], repo);
		assert.equal(plain.ok, true, plain.text);
		assert.ok(plain.text.includes(head), plain.text);
		assert.equal(gpgRan(repo), false, "format.pretty must be overridden");
		const shown = await runValidated("show", ["-1", "--format=%H", head], repo);
		assert.equal(shown.ok, true, shown.text);
		assert.equal(shown.text.trim(), head);
		assert.equal(gpgRan(repo), false);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("integration: format presets and every allowlisted specifier expand in real git", async () => {
	const repo = makeHistoryRepo();
	const head = gitSync(["rev-parse", "HEAD"], repo).trim();
	try {
		for (const preset of PRETTY_PRESETS) {
			const result = await runValidated("log", ["-1", `--format=${preset}`], repo);
			assert.equal(result.ok, true, `${preset}: ${result.text}`);
		}
		// git prints an unknown code literally and still exits 0, so exit status
		// alone would not catch a wrong entry in the allowlist: every specifier must
		// differ from its own literal text. Fields that are legitimately empty in
		// this fixture (no notes, no reflog, no --left-right) still satisfy that.
		for (const specifier of FORMAT_SPECIFIERS) {
			const result = await runValidated("log", ["-1", `--format=${specifier}`], repo);
			assert.equal(result.ok, true, `${specifier}: ${result.text}`);
			assert.notEqual(result.text.trim(), specifier, `${specifier} was echoed literally, not expanded`);
		}
		// Deterministic expansions, compared exactly.
		for (const [specifier, expected] of [
			["%H", head],
			["%s", "second subject"],
			["%f", "second-subject"],
			["%B", "second subject"],
			["%an", "Second Author"],
			["%aN", "Second Author"],
			["%ae", "second@example.com"],
			["%al", "second"],
			["%cn", "Second Author"],
			["%ce", "second@example.com"],
			["%%", "%"],
		] as Array<[string, string]>) {
			const result = await runValidated("log", ["-1", `--format=${specifier}`], repo);
			assert.equal(result.text.trim(), expected, `${specifier}: ${result.text}`);
		}
		// Hashes and dates vary per run, so those check their shape.
		for (const [specifier, pattern] of [
			["%h", /^[0-9a-f]{7,40}$/],
			["%T", /^[0-9a-f]{40}$/],
			["%t", /^[0-9a-f]+$/],
			["%P", /^[0-9a-f]{40}$/],
			["%at", /^\d+$/],
			["%ct", /^\d+$/],
			["%as", /^\d{4}-\d{2}-\d{2}$/],
			["%cs", /^\d{4}-\d{2}-\d{2}$/],
		] as Array<[string, RegExp]>) {
			const result = await runValidated("log", ["-1", `--format=${specifier}`], repo);
			assert.match(result.text.trim(), pattern, `${specifier}: ${result.text}`);
		}
		const composed = await runValidated("log", ["-1", "--format=%H%n%an%n%ad%n%s"], repo);
		assert.equal(composed.ok, true, composed.text);
		const lines = composed.text.trim().split("\n");
		assert.equal(lines.length, 4);
		assert.equal(lines[0], head);
		assert.equal(lines[1], "Second Author");
		assert.equal(lines[3], "second subject");
		// %% ends the scan, so the G? after it is literal text.
		const escaped = await runValidated("log", ["-1", "--format=%%G?"], repo);
		assert.equal(escaped.ok, true, escaped.text);
		assert.equal(escaped.text.trim(), "%G?");
		const doubleEscaped = await runValidated("log", ["-1", "--format=%%%%G?"], repo);
		assert.equal(doubleEscaped.ok, true, doubleEscaped.text);
		assert.equal(doubleEscaped.text.trim(), "%%G?");
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("integration: config pretty aliases cannot smuggle a signature specifier", async () => {
	const repo = makeHistoryRepo();
	// A prefix-matched alias that expands to a %G specifier: reachable through
	// --format=<name> unless the validator demands an exact preset name.
	gitSync(["config", "pretty.xsig", "%G? %s"], repo);
	gitSync(["config", "pretty.oneline", "%G? %s"], repo);
	const head = gitSync(["rev-parse", "HEAD"], repo).trim();
	try {
		for (const value of ["xsig", "xs", "ful"]) {
			const checked = validateInvocation("log", ["-1", `--format=${value}`]);
			assert.equal(checked.ok, false, value);
			if (!checked.ok) assert.ok(checked.reason.includes("requires an exact preset name"), checked.reason);
		}
		// A %-containing value is parsed as a format string, so the alias cannot
		// hijack it, and an exact preset name beats a same-named alias.
		const sha = await runValidated("log", ["-1", "--format=%H"], repo);
		assert.equal(sha.ok, true, sha.text);
		assert.equal(sha.text.trim(), head);
		const oneline = await runValidated("log", ["-1", "--format=oneline"], repo);
		assert.equal(oneline.ok, true, oneline.text);
		assert.match(oneline.text.trim(), /^[0-9a-f]+ second subject$/);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("integration: date and author values are honoured by real git", async () => {
	const repo = makeHistoryRepo();
	try {
		// Every allowlisted date form must be accepted by git; a value git does
		// not know exits non-zero, so this loop is what catches a bad enum entry.
		for (const value of DATE_FORMATS) {
			const accepted = await runValidated("log", ["-1", `--date=${value}`, "--format=%ad"], repo);
			assert.equal(accepted.ok, true, `${value}: ${accepted.text}`);
			assert.notEqual(accepted.text.trim(), "", `${value} produced no date`);
		}
		const iso = await runValidated("log", ["-1", "--date=iso", "--format=%ad"], repo);
		assert.equal(iso.ok, true, iso.text);
		assert.match(iso.text.trim(), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} /);
		const short = await runValidated("log", ["-1", "--date=short", "--format=%ad"], repo);
		assert.match(short.text.trim(), /^\d{4}-\d{2}-\d{2}$/);
		const separateDate = await runValidated("log", ["-1", "--date", "short", "--format=%ad"], repo);
		assert.equal(separateDate.text.trim(), short.text.trim());
		const match = await runValidated("log", ["-1", "--author=Second", "--format=%s"], repo);
		assert.equal(match.ok, true, match.text);
		assert.equal(match.text.trim(), "second subject");
		const separateAuthor = await runValidated("log", ["-1", "--author", "Second Author", "--format=%s"], repo);
		assert.equal(separateAuthor.ok, true, separateAuthor.text);
		assert.equal(separateAuthor.text.trim(), "second subject");
		const noMatch = await runValidated("log", ["-1", "--author=Nobody", "--format=%s"], repo);
		assert.equal(noMatch.ok, true, noMatch.text);
		assert.equal(noMatch.text.trim(), "");
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

// ── Registered tool: details shape and error signalling ───────────────────────

interface RegisteredTool {
	name: string;
	promptGuidelines?: string[];
	execute: (
		id: string,
		params: Record<string, unknown>,
		signal: undefined,
		onUpdate: undefined,
		ctx: { cwd: string },
	) => Promise<ToolResult>;
}

interface ToolResult {
	content: Array<{ type: string; text: string }>;
	details: Record<string, unknown>;
	isError?: boolean;
}

function register(): RegisteredTool {
	let captured: RegisteredTool | undefined;
	gitReadExtension({
		registerTool: (definition: RegisteredTool) => {
			captured = definition;
		},
	} as never);
	assert.ok(captured, "extension must register a tool");
	return captured!;
}

const callTool = (params: Record<string, unknown>, cwd = "/repo") =>
	register().execute("id", params, undefined, undefined, { cwd });

test("registered tool: a successful run omits isError and reports a zero exit code", async () => {
	harness(scriptOk("/repo", " M file.txt\n"));
	const result = await callTool({ subcommand: "status", args: ["--short", "--branch"] });
	assert.equal(result.isError, undefined);
	assert.equal(result.details.subcommand, "status");
	assert.equal(result.details.exitCode, 0);
	assert.equal(result.details.timedOut, false);
	assert.equal(result.details.truncated, false);
	assert.equal("failureReason" in result.details, false);
});

test("registered tool: a capped success stays a success but reports truncated", async () => {
	const chunkA = Buffer.alloc(30 * 1024, 0x61);
	const chunkB = Buffer.alloc(30 * 1024, 0x62);
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
	const result = await callTool({ subcommand: "status", args: ["--short", "--branch"] });
	assert.equal(result.isError, undefined);
	assert.equal(result.details.truncated, true);
	assert.equal("failureReason" in result.details, false);
});

test("registered tool: a non-zero exit is an error with the code and a bare reason", async () => {
	harness(scriptOk("/repo", "partial\n", 128, "fatal: bad revision 'nope'\n"));
	const result = await callTool({ subcommand: "show", args: ["nope"] });
	assert.equal(result.isError, true);
	assert.equal(result.details.subcommand, "show");
	assert.equal(result.details.exitCode, 128);
	assert.equal(result.details.timedOut, false);
	assert.equal(typeof result.details.failureReason, "string");
	assert.ok(!(result.details.failureReason as string).startsWith("git_read: "), "prefix-free reason");
	assert.ok(result.content[0]!.text.startsWith("git_read: git exited with code 128\n"), result.content[0]!.text);
});

test("registered tool: rejections are errors that spawn nothing", async () => {
	const spawns = harness(scriptOk("/repo"));
	const missing = await callTool({});
	assert.equal(missing.isError, true);
	assert.equal(missing.details.subcommand, "unknown");
	assert.equal(missing.details.exitCode, null);
	assert.equal(missing.details.timedOut, false);
	assert.equal(missing.details.truncated, false);
	assert.equal(typeof missing.details.failureReason, "string");
	assert.ok(missing.content[0]!.text.startsWith("git_read: "), "the model-facing text keeps its prefix");

	const badFlag = await callTool({ subcommand: "log", args: ["--bogus"] });
	assert.equal(badFlag.isError, true);
	assert.equal(badFlag.details.subcommand, "log");
	assert.equal(typeof badFlag.details.failureReason, "string");
	assert.ok((badFlag.details.failureReason as string).includes("--bogus"), String(badFlag.details.failureReason));
	assert.equal(spawns.length, 0, "rejected params must not spawn");
});

test("registered tool: the worktree gate failure is an error with a bare reason", async () => {
	harness(scriptOk("/repo"));
	const result = await callTool({ subcommand: "status", args: ["--short", "--branch"] }, "/elsewhere");
	assert.equal(result.isError, true);
	assert.equal(result.details.failureReason, "not inside a git worktree");
	assert.equal(result.details.exitCode, null);
});

test("registered tool: unsupported format, date, and author values are rejected before spawn", async () => {
	const spawns = harness(scriptOk("/repo"));
	for (const params of [
		{ subcommand: "log", args: ["--format=%G?"] },
		{ subcommand: "log", args: ["--pretty=%h %GG %s"] },
		{ subcommand: "show", args: ["--format=%GT"] },
		{ subcommand: "log", args: ["--format=%x41"] },
		{ subcommand: "log", args: ["--format=%+G?"] },
		{ subcommand: "show", args: ["--format=%-G?"] },
		{ subcommand: "log", args: ["--format=xsig"] },
		{ subcommand: "log", args: ["--format=plain text only"] },
		{ subcommand: "show", args: ["--format=%(trailers)"] },
		{ subcommand: "log", args: ["--date=bogus"] },
		{ subcommand: "show", args: ["--author=Alice"] },
	]) {
		const result = await callTool(params);
		assert.equal(result.isError, true, JSON.stringify(params));
		assert.equal(result.details.subcommand, params.subcommand, JSON.stringify(params));
		assert.equal(result.details.exitCode, null, JSON.stringify(params));
		assert.equal(typeof result.details.failureReason, "string", JSON.stringify(params));
	}
	assert.equal(spawns.length, 0, "rejected values must not spawn, not even the worktree gate");
});

test("registered tool: a diff --check finding keeps the standard non-zero-exit error shape", async () => {
	const repo = makeRepo();
	try {
		writeFileSync(path.join(repo, "file.txt"), "hello   \n");
		const result = await callTool({ subcommand: "diff", args: ["--check"] }, repo);
		assert.equal(result.isError, true);
		assert.equal(result.details.subcommand, "diff");
		assert.equal(result.details.exitCode, 2);
		assert.equal(result.details.failureReason, "git exited with code 2");
		assert.ok(result.content[0]!.text.includes("trailing whitespace"), result.content[0]!.text);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("registered tool: the guidelines name the full-SHA format", () => {
	const guidelines = register().promptGuidelines ?? [];
	assert.ok(guidelines.length > 0, "the tool publishes prompt guidelines");
	assert.ok(
		guidelines.some((line) => line.includes("--format=%H")),
		`a guideline names --format=%H: ${guidelines.join(" | ")}`,
	);
	assert.ok(
		guidelines.some((line) => line.includes('["-n", "1", "--format=%H"]')),
		`a guideline shows the concrete invocation: ${guidelines.join(" | ")}`,
	);
});
