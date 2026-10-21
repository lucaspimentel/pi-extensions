// Registered-tool tests for gh_read (extensions/gh-read/index.ts).
// Network-free: the extension is registered against a capture stub, and both
// execution paths run through the existing spawn seams (no real gh, no
// network). Covers schema shape, validation errors, the native path, and the
// API path end to end through the real stack.
//
// Run: node --test tests/gh-read-tool.test.mts
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import ghReadExtension from "../extensions/gh-read/index.ts";
import { PR_CHECKS_JSON_FIELDS } from "../extensions/gh-read/validate.ts";
import { setSpawnOverride } from "../extensions/shared/bounded-spawn.ts";
import { setApiSpawnOverride } from "../extensions/gh-read/api-spawn.ts";
import { setLogSpawnOverride } from "../extensions/gh-read/log-spawn.ts";

// ── Harness ──────────────────────────────────────────────────────────────────

interface RegisteredTool {
	name: string;
	description: string;
	parameters: unknown;
	promptGuidelines: string[];
	annotations: Record<string, unknown>;
	execute: (id: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: unknown, ctx: { cwd: string }) => Promise<ToolResult>;
}

interface ToolResult {
	content: Array<{ type: string; text: string }>;
	details: Record<string, unknown>;
	isError?: boolean;
}

function register(): RegisteredTool {
	let captured: RegisteredTool | undefined;
	const pi = {
		registerTool: (definition: RegisteredTool) => {
			captured = definition;
		},
	};
	ghReadExtension(pi as never);
	assert.ok(captured, "extension must register a tool");
	return captured!;
}

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
	child.kill = () => true;
	return child;
}

function harness(script: (spawn: { args: string[]; child: FakeChild }, index: number) => void): { argsList: string[][] } {
	const argsList: string[][] = [];
	setSpawnOverride(((command: string, args: string[], _options: unknown, ...rest: unknown[]) => {
		void command;
		void rest;
		const child = fakeChild();
		const index = argsList.length;
		argsList.push([...args]);
		queueMicrotask(() => script({ args: [...args], child }, index));
		return child;
	}) as never);
	return { argsList };
}

// ── Schema shape ─────────────────────────────────────────────────────────────

test("gh_read registers with all nine native subcommands and five API operations, no outputSchema", () => {
	const tool = register();
	assert.equal(tool.name, "gh_read");
	assert.ok(tool.annotations.readOnlyHint === true);
	const schema = tool.parameters as { properties: Record<string, unknown> };
	assert.ok(schema.properties, "flat parameter object");
	assert.ok(!("outputSchema" in (tool as unknown as Record<string, unknown>)), "no global outputSchema that changes old calls");
	assert.ok(tool.description.includes("pr checks"));
	assert.ok(tool.description.includes("repo contents"));
	assert.ok(tool.description.includes("advisory view"));
	assert.ok(tool.description.includes("check annotations"));
	assert.ok(tool.description.includes("run list"));
	assert.ok(tool.description.includes("run view"));
	assert.ok(tool.promptGuidelines.some((line) => line.includes("pr checks")));
	// The three new literals and the check_run_id field are in the schema.
	const schemaText = JSON.stringify(schema);
	for (const literal of ["run list", "run view", "check annotations"]) {
		assert.ok(schemaText.includes(`"const":"${literal}"`), `schema literal '${literal}'`);
	}
	assert.ok(schema.properties["check_run_id"], "check_run_id schema field");
});

// ── Validation errors ────────────────────────────────────────────────────────

test("execute: invalid params fail closed as tool errors before any spawn", async () => {
	const tool = register();
	let spawns = 0;
	setSpawnOverride(() => {
		spawns += 1;
		return fakeChild();
	});
	setApiSpawnOverride(() => {
		spawns += 1;
		return fakeChild();
	});
	for (const bad of [
		{ subcommand: "pr merge" },
		{ subcommand: "repo contents", repo: "owner/repo", path: "/abs" },
		{ subcommand: "advisory view", id: "not-an-id" },
		{ subcommand: "pr view", repo: "owner/repo" },
	]) {
		const result = await tool.execute("id", bad, undefined, null, { cwd: "/repo" });
		assert.equal(result.isError, true, JSON.stringify(bad));
		assert.ok(result.content[0].text.startsWith("gh_read: "), JSON.stringify(bad));
	}
	assert.equal(spawns, 0, "no child process for rejected invocations");
	setSpawnOverride(null);
	setApiSpawnOverride(null);
});

// ── Native path ──────────────────────────────────────────────────────────────

test("execute native: worktree gate then gh argv verbatim, details carry the subcommand", async () => {
	const tool = register();
	const { argsList } = harness((spawn, index) => {
		if (index === 0) {
			spawn.child.stdout.emit("data", Buffer.from("/repo\n"));
			spawn.child.emit("close", 0);
			return;
		}
		spawn.child.stdout.emit("data", Buffer.from("#1 open\n"));
		spawn.child.emit("close", 0);
	});
	const result = await tool.execute("id", { subcommand: "pr list", args: ["--state", "open"] }, undefined, null, { cwd: "/repo" });
	assert.equal(result.isError, undefined);
	assert.equal(result.content[0].text, "#1 open\n");
	assert.deepEqual(result.details, { subcommand: "pr list" });
	assert.deepEqual(argsList[1], ["pr", "list", "--state", "open"]);
	setSpawnOverride(null);
});

test("execute native pr checks: tool-authored --json fields reach the child", async () => {
	const tool = register();
	const { argsList } = harness((spawn, index) => {
		if (index === 0) {
			spawn.child.stdout.emit("data", Buffer.from("/repo\n"));
			spawn.child.emit("close", 0);
			return;
		}
		spawn.child.stdout.emit("data", Buffer.from('[{"name":"build","state":"SUCCESS"}]'));
		spawn.child.emit("close", 0);
	});
	const result = await tool.execute("id", { subcommand: "pr checks", args: ["123"] }, undefined, null, { cwd: "/repo" });
	assert.equal(result.isError, undefined);
	assert.deepEqual(argsList[1], ["pr", "checks", "123", "--json", PR_CHECKS_JSON_FIELDS]);
	assert.ok(result.content[0].text.includes('"state":"SUCCESS"'));
	setSpawnOverride(null);
});

// ── API path (full stack through the spawn seam) ─────────────────────────────

test("execute api: repo contents runs gh api directly (no git gate) and pins the resolved SHA", async () => {
	const tool = register();
	const argsList: string[][] = [];
	setApiSpawnOverride(((command: string, args: string[]) => {
		void command;
		const child = fakeChild();
		argsList.push([...args]);
		queueMicrotask(() => {
			// Sequence: default-branch lookup, ref resolution, contents read.
			const call = argsList.length;
			if (call === 1) {
				child.stdout.emit("data", Buffer.from('HTTP/1.1 200 OK\r\n\r\n{"default_branch":"main"}'));
			} else if (call === 2) {
				child.stdout.emit("data", Buffer.from(`HTTP/1.1 200 OK\r\n\r\n{"sha":"${"a".repeat(40)}"}`));
			} else {
				const content = Buffer.from("hello world").toString("base64");
				child.stdout.emit("data", Buffer.from(`HTTP/1.1 200 OK\r\n\r\n{"type":"file","encoding":"base64","size":11,"content":"${content}"}`));
			}
			child.emit("close", 0);
		});
		return child;
	}) as never);
	const result = await tool.execute("id", { subcommand: "repo contents", repo: "owner/repo", path: "README.md" }, undefined, null, { cwd: "/not-a-worktree" });
	assert.equal(result.isError, undefined, result.content[0].text);
	assert.equal(argsList.length, 3);
	assert.equal(argsList[0]![0], "api");
	assert.ok(!argsList.some((argv) => argv[0] === "rev-parse"), "no worktree gate on the API path");
	assert.ok(result.content[0].text.includes("hello world"));
	assert.ok(result.content[0].text.includes(`resolved_sha: ${"a".repeat(40)}`));
	assert.equal(result.details["subcommand"], "repo contents");
	setApiSpawnOverride(null);
});

test("execute api: partial-source failure reports isError while preserving the completed source", async () => {
	const tool = register();
	setApiSpawnOverride(((command: string, args: string[]) => {
		void command;
		const child = fakeChild();
		queueMicrotask(() => {
			const target = args[args.length - 1] ?? "";
			if (target.includes("/status?")) {
				child.stderr.emit("data", Buffer.from("gh: boom (HTTP 500)\n"));
				child.stdout.emit("data", Buffer.from("HTTP/1.1 500 Internal Server Error\r\n\r\n"));
				child.emit("close", 1, null);
			} else if (target.includes("/check-runs?")) {
				child.stdout.emit("data", Buffer.from('HTTP/1.1 200 OK\r\n\r\n{"check_runs":[{"name":"build"}]}'));
				child.emit("close", 0, null);
			} else {
				child.stdout.emit("data", Buffer.from(`HTTP/1.1 200 OK\r\n\r\n{"sha":"${"a".repeat(40)}"}`));
				child.emit("close", 0, null);
			}
		});
		return child;
	}) as never);
	const result = await tool.execute("id", { subcommand: "commit checks", repo: "owner/repo", ref: "main" }, undefined, null, { cwd: "/anywhere" });
	assert.equal(result.isError, true, "partial-source failure is an error");
	assert.ok(result.content[0].text.includes("statuses_error"));
	assert.ok(result.content[0].text.includes('"build"'), "completed check-runs data preserved");
	assert.ok(typeof result.details["continuation"] === "string", "retry position retained");
	setApiSpawnOverride(null);
});

// ── GitHub Actions inspection (run list / run view / check annotations) ─────

test("execute native run list: gate then gh argv verbatim, details carry the subcommand", async () => {
	const tool = register();
	const { argsList } = harness((spawn, index) => {
		if (index === 0) {
			spawn.child.stdout.emit("data", Buffer.from("/repo\n"));
			spawn.child.emit("close", 0);
			return;
		}
		spawn.child.stdout.emit("data", Buffer.from('[{"name":"ci","conclusion":"success"}]'));
		spawn.child.emit("close", 0);
	});
	const result = await tool.execute(
		"id",
		{ subcommand: "run list", args: ["--limit", "5", "--json", "name,conclusion"] },
		undefined,
		null,
		{ cwd: "/repo" },
	);
	assert.equal(result.isError, undefined, result.content[0].text);
	assert.equal(result.details["subcommand"], "run list");
	assert.deepEqual(argsList[0], ["rev-parse", "--show-toplevel"]);
	assert.deepEqual(argsList[1], ["run", "list", "--limit", "5", "--json", "name,conclusion"]);
	setSpawnOverride(null);
});

test("execute native run view --log is routed to the dual-window log runner via the structured logMode state", async () => {
	const tool = register();
	const sharedArgs: string[][] = [];
	const logArgs: string[][] = [];
	setSpawnOverride(((command: string, args: string[]) => {
		void command;
		const child = fakeChild();
		sharedArgs.push([...args]);
		queueMicrotask(() => {
			// Only the rev-parse gate is expected on the shared seam.
			child.stdout.emit("data", Buffer.from("/repo\n"));
			child.emit("close", 0);
		});
		return child;
	}) as never);
	setLogSpawnOverride(((_command: string, args: string[]) => {
		const child = fakeChild();
		logArgs.push([...args]);
		queueMicrotask(() => {
			child.stdout.emit("data", Buffer.from("step log line\n"));
			child.emit("close", 0);
		});
		return child;
	}) as never);
	const result = await tool.execute("id", { subcommand: "run view", args: ["123", "--log"] }, undefined, null, { cwd: "/repo" });
	assert.equal(result.isError, undefined, result.content[0].text);
	assert.equal(result.details["subcommand"], "run view");
	assert.equal(sharedArgs.length, 1, "the shared seam captured only the rev-parse gate");
	assert.deepEqual(sharedArgs[0], ["rev-parse", "--show-toplevel"]);
	assert.deepEqual(logArgs[0], ["run", "view", "123", "--log"]);
	assert.ok(result.content[0].text.includes("step log line"));
	setSpawnOverride(null);
	setLogSpawnOverride(null);
});

test("execute native run view without log flags keeps the shared runner (not logMode)", async () => {
	const tool = register();
	const sharedArgs: string[][] = [];
	const logArgs: string[][] = [];
	setSpawnOverride(((command: string, args: string[]) => {
		void command;
		const child = fakeChild();
		sharedArgs.push([...args]);
		queueMicrotask(() => {
			if (sharedArgs.length === 1) {
				child.stdout.emit("data", Buffer.from("/repo\n"));
				child.emit("close", 0);
			} else {
				child.stdout.emit("data", Buffer.from("run summary\n"));
				child.emit("close", 0);
			}
		});
		return child;
	}) as never);
	setLogSpawnOverride(() => {
		throw new Error("the log runner must not be selected without --log/--log-failed");
	});
	const result = await tool.execute("id", { subcommand: "run view", args: ["123"] }, undefined, null, { cwd: "/repo" });
	assert.equal(result.isError, undefined, result.content[0].text);
	assert.deepEqual(sharedArgs[1], ["run", "view", "123"]);
	assert.equal(logArgs.length, 0);
	setSpawnOverride(null);
	setLogSpawnOverride(null);
});

test("execute api check annotations: tool-authored gh api argv, no git gate anywhere", async () => {
	const tool = register();
	const argsList: string[][] = [];
	setSpawnOverride(() => {
		throw new Error("no git gate may spawn on the API path");
	});
	setApiSpawnOverride(((command: string, args: string[]) => {
		void command;
		const child = fakeChild();
		argsList.push([...args]);
		queueMicrotask(() => {
			const body = JSON.stringify([{ id: 1, message: "annotation one" }]);
			child.stdout.emit("data", Buffer.from(`HTTP/1.1 200 OK\r\n\r\n${body}`));
			child.emit("close", 0, null);
		});
		return child;
	}) as never);
	const result = await tool.execute("id", { subcommand: "check annotations", repo: "owner/repo", check_run_id: 7 }, undefined, null, { cwd: "/not-a-worktree" });
	assert.equal(result.isError, undefined, result.content[0].text);
	assert.equal(argsList.length, 1, "exactly one gh api child");
	const argv = argsList[0]!;
	assert.equal(argv[0], "api");
	assert.equal(argv[argv.length - 1], "repos/owner/repo/check-runs/7/annotations?per_page=100");
	assert.ok(argv.includes("--include"));
	assert.ok(result.content[0].text.includes("annotation one"));
	assert.equal(result.details["subcommand"], "check annotations");
	setSpawnOverride(null);
	setApiSpawnOverride(null);
});

test("execute: rejected run-family params fail closed with zero spawns", async () => {
	const tool = register();
	let spawns = 0;
	setSpawnOverride(() => {
		spawns += 1;
		return fakeChild();
	});
	setLogSpawnOverride(() => {
		spawns += 1;
		return fakeChild();
	});
	setApiSpawnOverride(() => {
		spawns += 1;
		return fakeChild();
	});
	for (const bad of [
		{ subcommand: "check annotations", repo: "o/r" }, // missing check_run_id
		{ subcommand: "check annotations", repo: "o/r", check_run_id: "5" }, // string id
		{ subcommand: "run ls", args: [] }, // gh alias not allowlisted
		{ subcommand: "run view", args: ["--bogus"] }, // unknown flag
		{ subcommand: "run list", args: ["--limit", "1001"] }, // out of bounds
	]) {
		const result = await tool.execute("id", bad, undefined, null, { cwd: "/repo" });
		assert.equal(result.isError, true, JSON.stringify(bad));
		assert.ok(result.content[0].text.startsWith("gh_read: "), JSON.stringify(bad));
	}
	assert.equal(spawns, 0, "no child process for rejected invocations");
	setSpawnOverride(null);
	setLogSpawnOverride(null);
	setApiSpawnOverride(null);
});

test("execute api repo metadata: tool-authored repos GET, no git gate, full object as data", async () => {
	const tool = register();
	const argsList: string[][] = [];
	setSpawnOverride(() => {
		throw new Error("no git gate may spawn on the API path");
	});
	setApiSpawnOverride(((command: string, args: string[]) => {
		void command;
		const child = fakeChild();
		argsList.push([...args]);
		queueMicrotask(() => {
			const body = JSON.stringify({ default_branch: "main", visibility: "public", permissions: { push: true } });
			child.stdout.emit("data", Buffer.from(`HTTP/1.1 200 OK\r\n\r\n${body}`));
			child.emit("close", 0, null);
		});
		return child;
	}) as never);
	const result = await tool.execute("id", { subcommand: "repo metadata", repo: "owner/repo" }, undefined, null, { cwd: "/not-a-worktree" });
	assert.equal(result.isError, undefined, result.content[0].text);
	assert.equal(argsList.length, 1);
	const argv = argsList[0]!;
	assert.equal(argv[0], "api");
	assert.equal(argv[argv.length - 1], "repos/owner/repo");
	assert.equal(result.details["subcommand"], "repo metadata");
	assert.ok(result.content[0].text.includes('"default_branch":"main"'));
	assert.ok(result.content[0].text.includes('"permissions":{"push":true}'), "viewer permissions pass through");
	setSpawnOverride(null);
	setApiSpawnOverride(null);
});
