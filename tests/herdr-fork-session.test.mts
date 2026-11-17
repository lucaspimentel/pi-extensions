// Tests for the herdr-fork-session extension.
//
// Covers the pure helpers (branch parsing, session-name slugs, sanitize,
// worktree path, agent names) and drives the REAL default export with a fake
// pi and ctx plus a recorded execFile runner (the module's setExecOverride
// seam). The scenarios pin: refusal paths, collision detection before any
// mutation, the confirm/select base dialog, the exact argv arrays sent to git
// and herdr, the outside-herdr worktree-only path, and the tab/agent failure
// paths.
//
// Run: node tests/herdr-fork-session.test.mts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

const mod = await import("../extensions/herdr-fork-session/index.ts");
const {
	COMMAND_NAME,
	USAGE,
	AGENT_NAME_MAX,
	AGENT_START_TIMEOUT_MS,
	parseBranchArg,
	slugFromSessionName,
	sanitizeBranch,
	worktreePath,
	toAgentName,
	uniqueAgentName,
	resolveMainClone,
	worktreeForBranch,
} = mod;

// ── Pure helpers ─────────────────────────────────────────────────────────────

// Branch argument: verbatim single token, empty means "use the session slug".
assert.deepEqual(parseBranchArg(""), { ok: true, branch: undefined });
assert.deepEqual(parseBranchArg("   "), { ok: true, branch: undefined });
assert.deepEqual(parseBranchArg("feature/foo"), { ok: true, branch: "feature/foo" });
assert.deepEqual(parseBranchArg("  feature/foo  "), { ok: true, branch: "feature/foo" });

// Usage errors: a leading dash and more than one token are both refused.
assert.equal(parseBranchArg("-x").ok, false);
assert.match(parseBranchArg("-x").message, /must not start/);
assert.equal(parseBranchArg("a b").ok, false);
assert.match(parseBranchArg("a b").message, /single branch name/);
assert.equal(parseBranchArg("a\nb").ok, false);

// Session-name slug: case, punctuation runs, trims, cap, empty.
assert.equal(slugFromSessionName(undefined), "");
assert.equal(slugFromSessionName(""), "");
assert.equal(slugFromSessionName("Fix Auth Bug!"), "fix-auth-bug");
assert.equal(slugFromSessionName("  --Hello, World--  "), "hello-world");
assert.equal(slugFromSessionName("a".repeat(50)), "a".repeat(40));
assert.equal(slugFromSessionName("a".repeat(50)).length, 40);
assert.equal(slugFromSessionName("a".repeat(39) + "-trailing"), "a".repeat(39));
assert.equal(slugFromSessionName("__"), "");

// Branch sanitization: the single slash substitution.
assert.equal(sanitizeBranch("feature/foo"), "feature-foo");
assert.equal(sanitizeBranch("a//b"), "a-b");
assert.equal(sanitizeBranch("plain"), "plain");

// Worktree path: a sibling of the main clone.
assert.equal(worktreePath("/src/repo", "feature/foo"), "/src/repo--feature-foo");
assert.equal(basename(worktreePath("/src/repo", "a/b")), "repo--a-b");

// Agent names: lowercase, leading letter, cap, fallback.
assert.equal(toAgentName("Fix Auth Bug"), "fix-auth-bug");
assert.equal(toAgentName("123-abc"), "abc");
assert.equal(toAgentName("123"), "fork");
assert.equal(toAgentName(""), "fork");
assert.equal(toAgentName("a".repeat(40)).length, AGENT_NAME_MAX);
assert.equal(toAgentName("a".repeat(40)), "a".repeat(32));
assert.equal(toAgentName("My_Branch-2"), "my_branch-2");
assert.equal(toAgentName("9-8-7"), "fork");
assert.ok(/^[a-z][a-z0-9_-]{0,31}$/.test(toAgentName("Fix Auth Bug")));

// Unique agent names: suffix escalation inside the length cap.
assert.equal(uniqueAgentName("free", new Set()), "free");
assert.equal(uniqueAgentName("dup", new Set(["dup"])), "dup-2");
assert.equal(uniqueAgentName("dup", new Set(["dup", "dup-2"])), "dup-3");
const longBase = "a".repeat(40);
const longUnique = uniqueAgentName(longBase, new Set([longBase]));
assert.equal(longUnique.length, AGENT_NAME_MAX);
assert.ok(longUnique.endsWith("-2"));
assert.equal(uniqueAgentName("abcd-", new Set(["abcd-"])), "abcd-2");
assert.ok(uniqueAgentName(longBase, new Set([longBase])).length <= AGENT_NAME_MAX);

// ── Integration harness ──────────────────────────────────────────────────────

const MAIN = "/home/u/src/datadog/repo";
const LINKED = "/home/u/src/datadog/repo--existing-worktree";
const SHA = "1".repeat(40);
const MAIN_SHA = "2".repeat(40);
const SHORT = "1111111";
const MAIN_SHORT = "2222222";
const SUBJECT = "Add a thing";
const BRANCH = "feature/thing";
const WT_PATH = worktreePath(MAIN, BRANCH);
const SESSION_FILE = "/sessions/abc.jsonl";

const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
const fail = (stderr = "", code = 1) => ({ code, stdout: "", stderr });

/** Dispatch key for one exact argv array (command + every argument). */
const key = (command, args) => `${command}\u0000${args.join("\u0000")}`;

const GIT_COMMON = (mainDir) => key("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"]);

const makeHarness = (options = {}) => {
	const state = {
		hasUI: options.hasUI ?? true,
		cwd: options.cwd ?? MAIN,
		sessionName: options.sessionName,
		sessionFile: options.sessionFile,
		sessionId: options.sessionId ?? "session-1",
		confirm: options.confirm ?? true,
		select: options.select,
	};
	const commands = new Map();
	const sentMessages = [];
	const entries = [];
	const uiCalls = { confirm: [], select: [], notify: [] };
	const pi = {
		registerCommand: (name, config) => commands.set(name, config),
		sendMessage: (message, sendOptions) => sentMessages.push({ message, options: sendOptions }),
		appendEntry: (customType, data) => entries.push({ customType, data }),
	};
	const ctx = {
		get hasUI() {
			return state.hasUI;
		},
		sessionManager: {
			getCwd: () => state.cwd,
			getSessionName: () => state.sessionName,
			getSessionFile: () => state.sessionFile,
			getSessionId: () => state.sessionId,
		},
		ui: {
			confirm: async (title, message, opts) => {
				uiCalls.confirm.push({ title, message, opts });
				return state.confirm;
			},
			select: async (title, options2, opts) => {
				uiCalls.select.push({ title, options: options2, opts });
				return state.select;
			},
			notify: (message, type) => {
				uiCalls.notify.push({ message, type });
			},
		},
	};
	(mod.default)(pi);
	const command = commands.get(COMMAND_NAME);
	assert.ok(command, "the command was registered");
	const calls = [];
	return {
		state,
		calls,
		sentMessages,
		entries,
		uiCalls,
		run: (args) => command.handler(args, ctx),
	};
};

/**
 * Run one scenario with the exec runner stubbed by the exact-argv response
 * map. An unexpected argv array is a test failure (it proves the extension
 * sent something the test did not pin). process.env and the override are
 * always restored, even when an assertion fails.
 */
const runScenario = async (options, fn) => {
	const harness = makeHarness(options);
	const responses = options.responses ?? {};
	// Recording only: the pinned responses and the loud unexpected-argv failure
	// are shared with the direct helper tests through stubRunner.
	const runner = async (command, args, cwd) => {
		harness.calls.push({ command, args: [...args], cwd });
		return stubRunner(responses)(command, args, cwd);
	};
	mod.setExecOverride(runner);
	const savedEnv = {
		HERDR_ENV: process.env.HERDR_ENV,
		HERDR_WORKSPACE_ID: process.env.HERDR_WORKSPACE_ID,
	};
	try {
		const env = {
			HERDR_ENV: undefined,
			HERDR_WORKSPACE_ID: undefined,
			...(options.env ?? {}),
		};
		for (const [name, value] of Object.entries(env)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		await fn(harness);
	} finally {
		mod.setExecOverride(null);
		for (const [name, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
};

const lastNotify = (h) => h.uiCalls.notify.at(-1);

/** Every dispatch is a shell-free argv array on exactly `git` or `herdr`. */
const assertShellFree = (h) => {
	assert.ok(h.calls.length > 0, "expected at least one exec call");
	for (const call of h.calls) {
		assert.ok(call.command === "git" || call.command === "herdr", `unexpected command: ${call.command}`);
		assert.ok(Array.isArray(call.args));
		for (const arg of call.args) {
			assert.ok(!/[;&|]/.test(arg), `argument looks like a shell string: ${arg}`);
			assert.ok(!/trust/i.test(arg), `unexpected project-trust argument: ${arg}`);
		}
	}
};

/**
 * Every herdr call in an inside-herdr scenario must be one of the pinned
 * subcommands. The narrower "no pane / no get" checks would have missed a
 * `herdr agent prompt`, `herdr agent send-keys`, or `herdr agent rename` call,
 * which are exactly the calls that would talk to the forked session.
 */
const HERDR_SUBCOMMANDS = new Set(["agent list", "agent start", "tab create"]);
const assertHerdrAllowlist = (h) => {
	for (const call of h.calls.filter((c) => c.command === "herdr")) {
		const subcommand = `${call.args[0]} ${call.args[1]}`;
		assert.ok(HERDR_SUBCOMMANDS.has(subcommand), `unexpected herdr call: herdr ${call.args.join(" ")}`);
	}
};

/** The happy-path response map: a clean repo with no branch collision. */
const standard = ({ mainDir = MAIN, branch = BRANCH, sha = SHA, shortSha = SHORT } = {}) => ({
	[GIT_COMMON(mainDir)]: ok(`${mainDir}/.git\n`),
	[key("git", ["check-ref-format", "--branch", branch])]: ok(""),
	[key("git", ["rev-parse", "HEAD"])]: ok(`${sha}\n`),
	[key("git", ["rev-parse", "--abbrev-ref", "HEAD"])]: ok("main\n"),
	[key("git", ["rev-parse", "--short", "HEAD"])]: ok(`${shortSha}\n`),
	[key("git", ["log", "-1", "--format=%s"])]: ok(`${SUBJECT}\n`),
	[key("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])]: fail("", 1),
	[key("git", ["worktree", "add", "-b", branch, worktreePath(mainDir, branch), sha])]: ok(""),
});

// ── Main-clone and worktree resolution ───────────────────────────────────────

/** Pinned responses for an exact argv array; an unexpected one is a loud failure. */
const stubRunner =
	(responses) =>
	async (command, args, cwd) => {
		const entry = responses[key(command, args)];
		if (entry === undefined) {
			throw new Error(`unexpected exec call: ${command} ${args.join(" ")} (cwd ${cwd})`);
		}
		return typeof entry === "function" ? entry(cwd) : entry;
	};

// A normal clone and a linked worktree both report <root>/.git, so the parent
// of the common dir is the main clone and --show-toplevel is never consulted.
assert.deepEqual(await resolveMainClone(stubRunner({ [GIT_COMMON(MAIN)]: ok(`${MAIN}/.git\n`) }), MAIN), {
	ok: true,
	mainDir: MAIN,
});

// A submodule's common dir lives under the superproject's .git/modules, so the
// main clone comes from --show-toplevel instead of dirname.
const SUBMODULE_WT = "/home/u/src/super/sub";
assert.deepEqual(
	await resolveMainClone(
		stubRunner({
			[GIT_COMMON(SUBMODULE_WT)]: ok("/home/u/src/super/.git/modules/sub\n"),
			[key("git", ["rev-parse", "--show-toplevel"])]: ok(`${SUBMODULE_WT}\n`),
		}),
		SUBMODULE_WT,
	),
	{ ok: true, mainDir: SUBMODULE_WT },
);

// A bare repository has no working tree: its common dir is not a .git directory
// and --show-toplevel fails, so the command refuses.
const bare = await resolveMainClone(
	stubRunner({
		[GIT_COMMON("/srv/git/repo.git")]: ok("/srv/git/repo.git\n"),
		[key("git", ["rev-parse", "--show-toplevel"])]: fail(
			"fatal: this operation must be run in a work tree\n",
			128,
		),
	}),
	"/srv/git/repo.git",
);
assert.equal(bare.ok, false);
assert.match(bare.message, /bare repository/);
assert.match(bare.message, /working tree/);

// worktreeForBranch exposes the recorded path and git's prunable marker.
const wtList = (body) => stubRunner({ [key("git", ["worktree", "list", "--porcelain"])]: ok(body) });
assert.deepEqual(
	await worktreeForBranch(wtList(`worktree /live/wt\nHEAD ${SHA}\nbranch refs/heads/b\n\n`), MAIN, "b"),
	{ path: "/live/wt", prunable: false },
);
assert.deepEqual(
	await worktreeForBranch(
		wtList(
			`worktree /tmp/pi-ext-pr1\nHEAD ${SHA}\nbranch refs/heads/b\nprunable gitdir file points to non-existent location\n\n`,
		),
		MAIN,
		"b",
	),
	{ path: "/tmp/pi-ext-pr1", prunable: true },
);
assert.equal(
	await worktreeForBranch(wtList(`worktree /other\nHEAD ${SHA}\nbranch refs/heads/other\n\n`), MAIN, "b"),
	undefined,
);

// ── Refusals ─────────────────────────────────────────────────────────────────

// Unnamed session with no argument is refused before any git mutation.
await runScenario({ sessionName: undefined, responses: { [GIT_COMMON(MAIN)]: ok(`${MAIN}/.git\n`) } }, async (h) => {
	await h.run("");
	assert.equal(h.entries.length, 1);
	assert.equal(h.entries[0].customType, "herdr-fork-session");
	assert.equal(h.entries[0].data.outcome, "refused");
	assert.ok(lastNotify(h).message.includes(USAGE));
	assert.ok(lastNotify(h).message.includes("left untouched"));
	assert.equal(h.sentMessages.length, 0);
	assert.ok(!h.calls.some((c) => c.args[0] === "worktree" && c.args[1] === "add"));
});

// A non-interactive session is refused before any child process runs.
await runScenario({ hasUI: false, responses: {} }, async (h) => {
	await h.run("feature/x");
	assert.equal(h.calls.length, 0);
	assert.equal(h.entries.length, 1);
	assert.equal(h.entries[0].data.outcome, "refused");
	assert.equal(h.entries[0].data.error, "no interactive UI");
	assert.equal(h.sentMessages.length, 0);
});

// A usage error (leading dash) is refused with the usage line.
await runScenario({ responses: {} }, async (h) => {
	await h.run("-oops");
	assert.equal(h.calls.length, 0);
	assert.equal(h.entries.length, 1);
	assert.equal(h.entries[0].data.outcome, "refused");
	assert.ok(lastNotify(h).message.includes(USAGE));
	assert.equal(h.sentMessages.length, 0);
});

// An invalid branch name is refused with git's own reason; nothing is added.
await runScenario(
	{
		responses: {
			[GIT_COMMON(MAIN)]: ok(`${MAIN}/.git\n`),
			[key("git", ["check-ref-format", "--branch", "bad..name"])]: fail(
				"fatal: 'bad..name' is not a valid branch name\n",
				128,
			),
		},
	},
	async (h) => {
		await h.run("bad..name");
		assert.equal(h.entries[0].data.outcome, "refused");
		assert.ok(lastNotify(h).message.includes("fatal: 'bad..name' is not a valid branch name"));
		assert.equal(h.sentMessages.length, 0);
		assert.equal(h.calls.length, 2);
	},
);

// Not a git repository: refused after the single probe.
await runScenario(
	{
		responses: {
			[GIT_COMMON(MAIN)]: fail("fatal: not a git repository (or any of the parent directories)\n", 128),
		},
	},
	async (h) => {
		await h.run(BRANCH);
		assert.equal(h.entries[0].data.outcome, "refused");
		assert.ok(lastNotify(h).message.includes("Not a git repository"));
		assert.equal(h.sentMessages.length, 0);
		assert.equal(h.calls.length, 1);
	},
);

// A bare repository has no working tree: the common dir is not a .git
// directory and --show-toplevel fails, so the command refuses.
await runScenario(
	{
		cwd: "/srv/git/repo.git",
		responses: {
			[GIT_COMMON("/srv/git/repo.git")]: ok("/srv/git/repo.git\n"),
			[key("git", ["rev-parse", "--show-toplevel"])]: fail(
				"fatal: this operation must be run in a work tree\n",
				128,
			),
		},
	},
	async (h) => {
		await h.run(BRANCH);
		assert.equal(h.entries[0].data.outcome, "refused");
		assert.ok(lastNotify(h).message.includes("bare repository"));
		assert.ok(lastNotify(h).message.includes("working tree"));
		assert.equal(h.sentMessages.length, 0);
		assert.equal(h.calls.length, 2);
		assert.ok(!h.calls.some((c) => c.args[0] === "worktree" && c.args[1] === "add"));
	},
);

// ── Collisions ───────────────────────────────────────────────────────────────

// An existing branch whose worktree still exists is refused before the dialog
// and before git worktree add, with a cd hint for the live checkout.
{
	const tmp = mkdtempSync(join(tmpdir(), "herdr-fork-live-"));
	const livePath = join(tmp, "repo--fix-auth-bug");
	mkdirSync(livePath);
	try {
		await runScenario(
			{
				sessionName: "Fix Auth Bug",
				responses: {
					...standard({ branch: "fix-auth-bug" }),
					[key("git", ["show-ref", "--verify", "--quiet", "refs/heads/fix-auth-bug"])]: ok(""),
					[key("git", ["worktree", "list", "--porcelain"])]: ok(
						`worktree ${livePath}\nHEAD ${SHA}\nbranch refs/heads/fix-auth-bug\n\n`,
					),
				},
			},
			async (h) => {
				await h.run("");
				assert.equal(h.entries[0].data.outcome, "refused-collision");
				assert.ok(lastNotify(h).message.startsWith("refused-collision: "));
				assert.ok(lastNotify(h).message.includes("fix-auth-bug"));
				assert.ok(lastNotify(h).message.includes(livePath));
				assert.ok(lastNotify(h).message.includes(`Reuse it with: cd ${livePath}`));
				assert.ok(!lastNotify(h).message.includes("git worktree prune"));
				assert.ok(!lastNotify(h).message.includes("Nothing was sent to the forked session"));
				assert.equal(h.uiCalls.confirm.length, 0);
				assert.equal(h.uiCalls.select.length, 0);
				assert.equal(h.sentMessages.length, 1);
				assert.equal(h.sentMessages[0].message.content, lastNotify(h).message);
				assert.ok(!h.calls.some((c) => c.args[0] === "worktree" && c.args[1] === "add"));
			},
		);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

// A branch whose worktree registration is stale gets the prune hint instead of
// a cd: the recorded directory is gone, with or without git's prunable marker.
for (const [why, body] of [
	["missing path", `worktree ${LINKED}\nHEAD ${SHA}\nbranch refs/heads/fix-auth-bug\n\n`],
	[
		"prunable",
		`worktree ${LINKED}\nHEAD ${SHA}\nbranch refs/heads/fix-auth-bug\nprunable gitdir file points to non-existent location\n\n`,
	],
]) {
	await runScenario(
		{
			sessionName: "Fix Auth Bug",
			responses: {
				...standard({ branch: "fix-auth-bug" }),
				[key("git", ["show-ref", "--verify", "--quiet", "refs/heads/fix-auth-bug"])]: ok(""),
				[key("git", ["worktree", "list", "--porcelain"])]: ok(body),
			},
		},
		async (h) => {
			await h.run("");
			assert.equal(h.entries[0].data.outcome, "refused-collision", why);
			assert.ok(lastNotify(h).message.startsWith("refused-collision: "), why);
			assert.ok(lastNotify(h).message.includes("git worktree prune"), why);
			assert.ok(!lastNotify(h).message.includes("Reuse it with: cd "), why);
			assert.ok(!lastNotify(h).message.includes("Nothing was sent to the forked session"), why);
			assert.equal(h.uiCalls.confirm.length, 0, why);
			assert.equal(h.sentMessages.length, 1, why);
			assert.ok(!h.calls.some((c) => c.args[0] === "worktree" && c.args[1] === "add"), why);
		},
	);
}

// An existing worktree path stops before show-ref and before git worktree add.
{
	const tmp = mkdtempSync(join(tmpdir(), "herdr-fork-"));
	const mainDir = join(tmp, "repo");
	const branch = "feature";
	const clashPath = worktreePath(mainDir, branch);
	mkdirSync(mainDir);
	mkdirSync(clashPath);
	try {
		await runScenario(
			{
				cwd: mainDir,
				responses: {
					[GIT_COMMON(mainDir)]: ok(`${mainDir}/.git\n`),
					[key("git", ["check-ref-format", "--branch", branch])]: ok(""),
					[key("git", ["rev-parse", "HEAD"])]: ok(`${SHA}\n`),
					[key("git", ["rev-parse", "--abbrev-ref", "HEAD"])]: ok("main\n"),
					[key("git", ["rev-parse", "--short", "HEAD"])]: ok(`${SHORT}\n`),
					[key("git", ["log", "-1", "--format=%s"])]: ok(`${SUBJECT}\n`),
				},
			},
			async (h) => {
				await h.run(branch);
				assert.equal(h.entries[0].data.outcome, "refused-collision");
				assert.ok(lastNotify(h).message.includes(clashPath));
				assert.equal(h.sentMessages.length, 1);
				assert.ok(!h.calls.some((c) => c.args[0] === "show-ref"));
				assert.ok(!h.calls.some((c) => c.args[0] === "worktree" && c.args[1] === "add"));
			},
		);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

// ── Base dialog ──────────────────────────────────────────────────────────────

// From a linked worktree with the same HEAD: one confirm, no select, the
// add runs in the session cwd, and the path is the main clone's sibling.
await runScenario(
	{ cwd: LINKED, sessionFile: SESSION_FILE, responses: standard({ mainDir: MAIN, branch: BRANCH }) },
	async (h) => {
		await h.run(BRANCH);
		assert.equal(h.uiCalls.confirm.length, 1);
		assert.equal(h.uiCalls.confirm[0].title, "/herdr-fork-session");
		assert.ok(h.uiCalls.confirm[0].message.includes(WT_PATH));
		assert.equal(h.uiCalls.select.length, 0);
		const add = h.calls.find((c) => c.args[0] === "worktree" && c.args[1] === "add");
		assert.deepEqual(add.args, ["worktree", "add", "-b", BRANCH, WT_PATH, SHA]);
		assert.equal(add.cwd, LINKED);
		assert.equal(dirname(WT_PATH), dirname(MAIN));
		assert.equal(basename(WT_PATH), `${basename(MAIN)}--feature-thing`);
		assert.equal(h.entries[0].data.outcome, "worktree-only");
		assert.equal(h.entries[0].data.path, WT_PATH);
		assertShellFree(h);
	},
);

// Divergent HEADs: a select with exactly the two option strings in
// [session checkout, main clone] order; the chosen base is the add's commit.
for (const [choiceIndex, expectedSha] of [
	[0, SHA],
	[1, MAIN_SHA],
]) {
	await runScenario(
		{
			cwd: LINKED,
			sessionFile: SESSION_FILE,
			select: undefined,
			responses: {
				[GIT_COMMON(MAIN)]: ok(`${MAIN}/.git\n`),
				[key("git", ["check-ref-format", "--branch", BRANCH])]: ok(""),
				[key("git", ["rev-parse", "HEAD"])]: (cwd) => ok(`${cwd === MAIN ? MAIN_SHA : SHA}\n`),
				[key("git", ["rev-parse", "--abbrev-ref", "HEAD"])]: (cwd) =>
					ok(`${cwd === MAIN ? "main" : "feature/existing"}\n`),
				[key("git", ["rev-parse", "--short", "HEAD"])]: (cwd) =>
					ok(`${cwd === MAIN ? MAIN_SHORT : SHORT}\n`),
				[key("git", ["log", "-1", "--format=%s"])]: ok(`${SUBJECT}\n`),
				[key("git", ["show-ref", "--verify", "--quiet", `refs/heads/${BRANCH}`])]: fail("", 1),
				[key("git", ["worktree", "add", "-b", BRANCH, WT_PATH, SHA])]: ok(""),
				[key("git", ["worktree", "add", "-b", BRANCH, WT_PATH, MAIN_SHA])]: ok(""),
			},
		},
		async (h) => {
			const options = [
				`feature/existing ${SHORT} ${SUBJECT}`,
				`main ${MAIN_SHORT} ${SUBJECT}`,
			];
			h.state.select = options[choiceIndex];
			await h.run(BRANCH);
			assert.equal(h.uiCalls.confirm.length, 0);
			assert.equal(h.uiCalls.select.length, 1);
			assert.deepEqual(h.uiCalls.select[0].options, options);
			const add = h.calls.find((c) => c.args[0] === "worktree" && c.args[1] === "add");
			assert.deepEqual(add.args, ["worktree", "add", "-b", BRANCH, WT_PATH, expectedSha]);
			assert.equal(h.entries[0].data.baseSha, expectedSha);
		},
	);
}

// Decline via confirm: only a notify, no entry, no message, no spawn.
await runScenario({ confirm: false, responses: standard() }, async (h) => {
	await h.run(BRANCH);
	assert.deepEqual(h.uiCalls.notify, [
		{ message: "herdr-fork-session cancelled; nothing was created.", type: "info" },
	]);
	assert.equal(h.entries.length, 0);
	assert.equal(h.sentMessages.length, 0);
	assert.ok(!h.calls.some((c) => c.args[0] === "worktree" && c.args[1] === "add"));
});

// Decline via select: same silence as a declined confirm.
await runScenario(
	{
		cwd: LINKED,
		select: undefined,
		responses: {
			[GIT_COMMON(MAIN)]: ok(`${MAIN}/.git\n`),
			[key("git", ["check-ref-format", "--branch", BRANCH])]: ok(""),
			[key("git", ["rev-parse", "HEAD"])]: (cwd) => ok(`${cwd === MAIN ? MAIN_SHA : SHA}\n`),
			[key("git", ["rev-parse", "--abbrev-ref", "HEAD"])]: ok("main\n"),
			[key("git", ["rev-parse", "--short", "HEAD"])]: (cwd) =>
				ok(`${cwd === MAIN ? MAIN_SHORT : SHORT}\n`),
			[key("git", ["log", "-1", "--format=%s"])]: ok(`${SUBJECT}\n`),
			[key("git", ["show-ref", "--verify", "--quiet", `refs/heads/${BRANCH}`])]: fail("", 1),
		},
	},
	async (h) => {
		await h.run(BRANCH);
		assert.equal(h.uiCalls.select.length, 1);
		assert.deepEqual(h.uiCalls.notify, [
			{ message: "herdr-fork-session cancelled; nothing was created.", type: "info" },
		]);
		assert.equal(h.entries.length, 0);
		assert.equal(h.sentMessages.length, 0);
		assert.ok(!h.calls.some((c) => c.args[0] === "worktree" && c.args[1] === "add"));
	},
);

// ── Outside herdr: worktree-only ─────────────────────────────────────────────

// With a session file the ready-to-run line names it; no herdr call at all.
await runScenario(
	{ sessionName: "Fix Auth Bug", sessionFile: SESSION_FILE, responses: standard({ branch: "fix-auth-bug" }) },
	async (h) => {
		await h.run("");
		const path = worktreePath(MAIN, "fix-auth-bug");
		assert.equal(h.entries[0].data.outcome, "worktree-only");
		assert.equal(h.entries[0].data.branch, "fix-auth-bug");
		assert.equal(h.entries[0].data.path, path);
		assert.equal(h.entries[0].data.sessionFile, SESSION_FILE);
		assert.ok(lastNotify(h).message.startsWith("worktree-only: "));
		assert.ok(lastNotify(h).message.includes("Nothing was sent to the forked session"));
		assert.ok(lastNotify(h).message.includes(`cd ${path} && pi --fork ${SESSION_FILE}`));
		assert.ok(lastNotify(h).message.includes("left untouched"));
		assert.equal(h.sentMessages.length, 1);
		assert.equal(h.sentMessages[0].message.content, lastNotify(h).message);
		assert.equal(h.sentMessages[0].options.deliverAs, "nextTurn");
		assert.equal(h.sentMessages[0].options.triggerTurn, false);
		assert.ok(h.calls.every((c) => c.command === "git"));
		assertShellFree(h);
	},
);

// Without a session file the user is pointed at /session instead.
await runScenario(
	{
		sessionName: "Fix Auth Bug",
		sessionFile: undefined,
		responses: standard({ branch: "fix-auth-bug" }),
	},
	async (h) => {
		await h.run("");
		const path = worktreePath(MAIN, "fix-auth-bug");
		assert.equal(h.entries[0].data.outcome, "worktree-only");
		assert.equal(h.entries[0].data.sessionFile, undefined);
		assert.ok(lastNotify(h).message.startsWith("worktree-only: "));
		assert.ok(lastNotify(h).message.includes("Nothing was sent to the forked session"));
		assert.ok(lastNotify(h).message.includes("/session"));
		assert.ok(lastNotify(h).message.includes(`cd ${path} && pi --fork <file-or-id>`));
		assert.ok(h.calls.every((c) => c.command === "git"));
		assert.equal(h.sentMessages.length, 1);
		assert.equal(h.sentMessages[0].message.content, lastNotify(h).message);
	},
);

// A submodule checkout: its common dir lives under the superproject, so the
// main clone comes from --show-toplevel and the worktree is its sibling.
await runScenario(
	{
		cwd: SUBMODULE_WT,
		sessionFile: SESSION_FILE,
		responses: {
			[GIT_COMMON(SUBMODULE_WT)]: ok("/home/u/src/super/.git/modules/sub\n"),
			[key("git", ["rev-parse", "--show-toplevel"])]: ok(`${SUBMODULE_WT}\n`),
			[key("git", ["check-ref-format", "--branch", BRANCH])]: ok(""),
			[key("git", ["rev-parse", "HEAD"])]: ok(`${SHA}\n`),
			[key("git", ["rev-parse", "--abbrev-ref", "HEAD"])]: ok("main\n"),
			[key("git", ["rev-parse", "--short", "HEAD"])]: ok(`${SHORT}\n`),
			[key("git", ["log", "-1", "--format=%s"])]: ok(`${SUBJECT}\n`),
			[key("git", ["show-ref", "--verify", "--quiet", `refs/heads/${BRANCH}`])]: fail("", 1),
			[key("git", ["worktree", "add", "-b", BRANCH, worktreePath(SUBMODULE_WT, BRANCH), SHA])]: ok(""),
		},
	},
	async (h) => {
		await h.run(BRANCH);
		const path = worktreePath(SUBMODULE_WT, BRANCH);
		assert.equal(h.entries[0].data.outcome, "worktree-only");
		assert.equal(h.entries[0].data.path, path);
		assert.equal(dirname(path), dirname(SUBMODULE_WT));
		const add = h.calls.find((c) => c.args[0] === "worktree" && c.args[1] === "add");
		assert.deepEqual(add.args, ["worktree", "add", "-b", BRANCH, path, SHA]);
		assertShellFree(h);
	},
);

// ── git worktree add failure ─────────────────────────────────────────────────

await runScenario(
	{
		responses: {
			...standard(),
			[key("git", ["worktree", "add", "-b", BRANCH, WT_PATH, SHA])]: fail(
				"fatal: could not create work tree dir\n",
				128,
			),
		},
	},
	async (h) => {
		await h.run(BRANCH);
		assert.equal(h.entries[0].data.outcome, "failed");
		assert.equal(h.entries[0].data.error, "fatal: could not create work tree dir");
		assert.ok(lastNotify(h).message.includes("fatal: could not create work tree dir"));
		assert.ok(lastNotify(h).message.includes("left untouched"));
		assert.equal(h.sentMessages.length, 0);
		assert.ok(h.calls.every((c) => c.command === "git"));
		assert.ok(!h.calls.some((c) => c.args[0] === "worktree" && c.args[1] === "list"));
	},
);

// ── Inside herdr ─────────────────────────────────────────────────────────────

// Success: exact argv arrays, ids read from the JSON, no input sent anywhere.
await runScenario(
	{
		sessionName: "Fix Auth Bug",
		sessionFile: SESSION_FILE,
		env: { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w1" },
		responses: {
			...standard({ branch: "fix-auth-bug" }),
			[key("herdr", ["agent", "list"])]: ok(JSON.stringify({ result: { agents: [{ name: "other-agent" }] } })),
			[key("herdr", [
				"tab",
				"create",
				"--workspace",
				"w1",
				"--cwd",
				worktreePath(MAIN, "fix-auth-bug"),
				"--label",
				"fix-auth-bug",
				"--no-focus",
			])]: ok(JSON.stringify({ result: { tab: { tab_id: "w1:t9" }, root_pane: { pane_id: "w1:p9" } } })),
			[key("herdr", [
				"agent",
				"start",
				"fix-auth-bug",
				"--kind",
				"pi",
				"--pane",
				"w1:p9",
				"--timeout",
				String(AGENT_START_TIMEOUT_MS),
				"--",
				"--fork",
				SESSION_FILE,
			])]: ok(JSON.stringify({ result: { agent: { agent_id: "a1" } } })),
		},
	},
	async (h) => {
		await h.run("");
		const path = worktreePath(MAIN, "fix-auth-bug");
		assert.equal(h.entries[0].data.outcome, "ok");
		assert.equal(h.entries[0].data.tabId, "w1:t9");
		assert.equal(h.entries[0].data.paneId, "w1:p9");
		assert.equal(h.entries[0].data.agentName, "fix-auth-bug");
		assert.ok(lastNotify(h).message.startsWith("ok: "));
		assert.ok(lastNotify(h).message.includes("Nothing was sent to the forked session"));
		assert.ok(lastNotify(h).message.includes("herdr tab focus w1:t9"));
		assert.equal(lastNotify(h).type, "info");
		assert.equal(h.sentMessages.length, 1);
		assert.equal(h.sentMessages[0].message.content, lastNotify(h).message);

		const add = h.calls.find((c) => c.args[0] === "worktree" && c.args[1] === "add");
		assert.deepEqual(add.args, ["worktree", "add", "-b", "fix-auth-bug", path, SHA]);
		assert.equal(add.cwd, MAIN);

		const tab = h.calls.find((c) => c.command === "herdr" && c.args[0] === "tab");
		assert.deepEqual(tab.args, [
			"tab",
			"create",
			"--workspace",
			"w1",
			"--cwd",
			path,
			"--label",
			"fix-auth-bug",
			"--no-focus",
		]);
		assert.equal(tab.cwd, MAIN);

		const start = h.calls.find((c) => c.command === "herdr" && c.args[0] === "agent" && c.args[1] === "start");
		assert.deepEqual(start.args, [
			"agent",
			"start",
			"fix-auth-bug",
			"--kind",
			"pi",
			"--pane",
			"w1:p9",
			"--timeout",
			String(AGENT_START_TIMEOUT_MS),
			"--",
			"--fork",
			SESSION_FILE,
		]);
		assert.equal(start.cwd, MAIN);

		assertShellFree(h);
		// No follow-up inspection, and nothing sent into the new session: every
		// herdr call is one of the three pinned subcommands.
		assertHerdrAllowlist(h);
		assert.ok(!h.calls.some((c) => c.command === "herdr" && c.args[0] === "pane"));
		assert.ok(!h.calls.some((c) => c.command === "herdr" && c.args[1] === "get"));
	},
);

// A taken agent name escalates to -2, and the fork falls back to the id.
await runScenario(
	{
		sessionName: "Fix Auth Bug",
		sessionFile: undefined,
		env: { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w1" },
		responses: {
			...standard({ branch: "fix-auth-bug" }),
			[key("herdr", ["agent", "list"])]: ok(
				JSON.stringify({ result: { agents: [{ name: "fix-auth-bug" }, { pane_id: "x" }] } }),
			),
			[key("herdr", [
				"tab",
				"create",
				"--workspace",
				"w1",
				"--cwd",
				worktreePath(MAIN, "fix-auth-bug"),
				"--label",
				"fix-auth-bug",
				"--no-focus",
			])]: ok(JSON.stringify({ result: { tab: { tab_id: "w1:t9" }, root_pane: { pane_id: "w1:p9" } } })),
			[key("herdr", [
				"agent",
				"start",
				"fix-auth-bug-2",
				"--kind",
				"pi",
				"--pane",
				"w1:p9",
				"--timeout",
				String(AGENT_START_TIMEOUT_MS),
				"--",
				"--fork",
				"session-1",
			])]: ok(""),
		},
	},
	async (h) => {
		await h.run("");
		assert.equal(h.entries[0].data.outcome, "ok");
		assert.equal(h.entries[0].data.agentName, "fix-auth-bug-2");
		const start = h.calls.find((c) => c.command === "herdr" && c.args[1] === "start");
		assert.equal(start.args[2], "fix-auth-bug-2");
		assert.equal(start.args.at(-1), "session-1");
		assertHerdrAllowlist(h);
	},
);

// Agent-start failure keeps the tab and the worktree and stops there.
await runScenario(
	{
		sessionFile: SESSION_FILE,
		env: { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w1" },
		responses: {
			...standard(),
			[key("herdr", ["agent", "list"])]: ok(JSON.stringify({ result: { agents: [] } })),
			[key("herdr", ["tab", "create", "--workspace", "w1", "--cwd", WT_PATH, "--label", BRANCH.replace(/\//g, "-"), "--no-focus"])]:
				ok(JSON.stringify({ result: { tab: { tab_id: "w1:t9" }, root_pane: { pane_id: "w1:p9" } } })),
			[key("herdr", [
				"agent",
				"start",
				"feature-thing",
				"--kind",
				"pi",
				"--pane",
				"w1:p9",
				"--timeout",
				String(AGENT_START_TIMEOUT_MS),
				"--",
				"--fork",
				SESSION_FILE,
			])]: fail("agent_not_ready\n", 1),
		},
	},
	async (h) => {
		await h.run(BRANCH);
		assert.equal(h.entries[0].data.outcome, "tab-failed");
		assert.equal(h.entries[0].data.tabId, "w1:t9");
		assert.equal(h.entries[0].data.paneId, "w1:p9");
		assert.ok(lastNotify(h).message.startsWith("tab-failed: "));
		assert.ok(lastNotify(h).message.includes("Nothing was sent to the forked session"));
		assert.ok(lastNotify(h).message.includes("agent_not_ready"));
		assert.ok(lastNotify(h).message.includes(`herdr agent start feature-thing --kind pi --pane w1:p9 --timeout ${AGENT_START_TIMEOUT_MS} -- --fork ${SESSION_FILE}`));
		assert.ok(lastNotify(h).message.includes("herdr tab focus w1:t9"));
		assert.ok(lastNotify(h).message.includes("left untouched"));
		assert.equal(h.sentMessages.length, 1);
		assert.equal(h.sentMessages[0].message.content, lastNotify(h).message);
		// The worktree and tab exist; the tab is never closed and nothing follows.
		assert.ok(h.calls.some((c) => c.args[0] === "worktree" && c.args[1] === "add"));
		assert.equal(h.calls.filter((c) => c.command === "herdr").length, 3);
		assert.ok(!h.calls.some((c) => c.command === "herdr" && c.args[0] === "tab" && c.args[1] === "close"));
		assert.ok(!h.calls.some((c) => c.command === "herdr" && c.args[0] === "pane"));
		assert.ok(!h.calls.some((c) => c.command === "herdr" && c.args[0] === "agent" && c.args[1] === "get"));
		assertHerdrAllowlist(h);
	},
);

// Tab-create failure keeps the worktree, skips agent start, and reports a retry.
await runScenario(
	{
		sessionFile: SESSION_FILE,
		env: { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w1" },
		responses: {
			...standard(),
			[key("herdr", ["agent", "list"])]: ok(""),
			[key("herdr", ["tab", "create", "--workspace", "w1", "--cwd", WT_PATH, "--label", BRANCH.replace(/\//g, "-"), "--no-focus"])]:
				fail("herdr: no server\n", 1),
		},
	},
	async (h) => {
		await h.run(BRANCH);
		assert.equal(h.entries[0].data.outcome, "tab-failed");
		assert.equal(h.entries[0].data.tabId, undefined);
		assert.ok(lastNotify(h).message.startsWith("tab-failed: "));
		assert.ok(lastNotify(h).message.includes("Nothing was sent to the forked session"));
		assert.ok(lastNotify(h).message.includes("no server"));
		assert.ok(lastNotify(h).message.includes(`cd ${WT_PATH} && pi --fork ${SESSION_FILE}`));
		assert.ok(lastNotify(h).message.includes("left untouched"));
		assert.equal(h.sentMessages.length, 1);
		assert.equal(h.sentMessages[0].message.content, lastNotify(h).message);
		assert.ok(h.calls.some((c) => c.args[0] === "worktree" && c.args[1] === "add"));
		assert.ok(!h.calls.some((c) => c.command === "herdr" && c.args[0] === "agent" && c.args[1] === "start"));
		assertShellFree(h);
		assertHerdrAllowlist(h);
	},
);

// ── Shape checks ─────────────────────────────────────────────────────────────

// The command's identity, usage line, and the two limits the tests pin by value.
assert.equal(AGENT_NAME_MAX, 32);
assert.equal(AGENT_START_TIMEOUT_MS, 120_000);
assert.equal(COMMAND_NAME, "herdr-fork-session");
assert.ok(USAGE.startsWith("/herdr-fork-session"));

console.log("herdr-fork-session tests passed");
