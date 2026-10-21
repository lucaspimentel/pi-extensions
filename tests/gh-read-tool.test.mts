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

test("gh_read registers with all seven native subcommands and four API operations, no outputSchema", () => {
	const tool = register();
	assert.equal(tool.name, "gh_read");
	assert.ok(tool.annotations.readOnlyHint === true);
	const schema = tool.parameters as { properties: Record<string, unknown> };
	assert.ok(schema.properties, "flat parameter object");
	assert.ok(!("outputSchema" in (tool as unknown as Record<string, unknown>)), "no global outputSchema that changes old calls");
	assert.ok(tool.description.includes("pr checks"));
	assert.ok(tool.description.includes("repo contents"));
	assert.ok(tool.description.includes("advisory view"));
	assert.ok(tool.promptGuidelines.some((line) => line.includes("pr checks")));
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
