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
import { REVIEW_THREADS_QUERY } from "../extensions/gh-read/api.ts";
import { setSpawnOverride } from "../extensions/shared/bounded-spawn.ts";
import { setApiSpawnOverride } from "../extensions/gh-read/api-spawn.ts";
import { setLogSpawnOverride } from "../extensions/gh-read/log-spawn.ts";

// ── Harness ──────────────────────────────────────────────────────────────────

interface RegisteredTool {
	name: string;
	description: string;
	promptSnippet: string;
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

/** Emits one complete successful HTTP response on the fake child. */
function httpOk(child: FakeChild, body: string, link?: string): void {
	const headers = link === undefined ? "" : `Link: ${link}\r\n`;
	child.stdout.emit("data", Buffer.from(`HTTP/1.1 200 OK\r\n${headers}\r\n${body}`));
	child.emit("close", 0, null);
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

test("gh_read registers native subcommands and API operations without outputSchema", () => {
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

// ── pr comments / pr reviews ───────────────────────────────────────

test("gh_read registers the pr comments and pr reviews literals, the numeric pr field, and PR guidance", () => {
	const tool = register();
	const schema = tool.parameters as { properties: Record<string, unknown> };
	const schemaText = JSON.stringify(schema);
	for (const literal of ["pr comments", "pr reviews"]) {
		assert.ok(schemaText.includes(`"const":"${literal}"`), `schema literal '${literal}'`);
	}
	assert.equal((schema.properties["pr"] as { type?: string } | undefined)?.type, "number", "pr is a numeric schema field");
	assert.ok(tool.description.includes("pr comments"));
	assert.ok(tool.description.includes("pr reviews"));
	// Read-only/idempotent/open-world annotations are unchanged by the PR ops.
	assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
	// Guidance distinguishes inline review comments (with replies), review
	// bodies/verdicts, and native conversation comments.
	assert.ok(tool.promptGuidelines.some((line) => line.includes("in_reply_to_id")), "inline comments guidance");
	assert.ok(tool.promptGuidelines.some((line) => line.includes("pr reviews")), "reviews guidance");
	assert.ok(tool.promptGuidelines.some((line) => line.includes("pr view --comments")), "conversation-comment distinction");
});

test("execute: rejected pr comments/reviews params fail closed with zero spawns", async () => {
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
		{ subcommand: "pr comments", repo: "owner/repo" }, // missing pr
		{ subcommand: "pr reviews", repo: "owner/repo", pr: "9" }, // string pr never coerced
		{ subcommand: "pr comments", repo: "owner/repo", pr: 0 }, // below the positive range
		{ subcommand: "pr reviews", pr: 9 }, // missing repo
		{ subcommand: "pr comments", repo: "owner/repo", pr: 9, args: [] }, // structured ops reject args
		{ subcommand: "pr reviews", repo: "owner/repo", pr: 9, ref: "main" }, // unrelated structured field
	]) {
		const result = await tool.execute("id", bad, undefined, null, { cwd: "/repo" });
		assert.equal(result.isError, true, JSON.stringify(bad));
		assert.ok(result.content[0].text.startsWith("gh_read: "), JSON.stringify(bad));
	}
	assert.equal(spawns, 0, "no child process for rejected invocations");
	setSpawnOverride(null);
	setApiSpawnOverride(null);
});

test("execute api pr comments: tool-authored pulls comments GET, no git gate, verbatim array outside a worktree", async () => {
	const tool = register();
	const argsList: string[][] = [];
	setSpawnOverride(() => {
		throw new Error("no git gate or ref resolution may spawn on the API path");
	});
	setApiSpawnOverride(((command: string, args: string[]) => {
		void command;
		const child = fakeChild();
		argsList.push([...args]);
		queueMicrotask(() => {
			httpOk(child, JSON.stringify([
				{ id: 1, body: "inline question", path: "src/x.ts", line: 42, in_reply_to_id: 5 },
			]));
		});
		return child;
	}) as never);
	const result = await tool.execute("id", { subcommand: "pr comments", repo: "owner/repo", pr: 9 }, undefined, null, { cwd: "/not-a-worktree" });
	assert.equal(result.isError, undefined, result.content[0].text);
	assert.equal(argsList.length, 1, "exactly one gh api child; no ref resolution");
	const argv = argsList[0]!;
	assert.equal(argv[0], "api");
	assert.deepEqual(argv, ["api", "--hostname", "github.com", "--method", "GET", "--header", "Accept: application/vnd.github+json", "--header", "X-GitHub-Api-Version: 2022-11-28", "--include", "repos/owner/repo/pulls/9/comments?per_page=100&page=1"]);
	assert.ok(result.content[0].text.includes("inline question"), "comment bodies pass through");
	assert.ok(result.content[0].text.includes('"in_reply_to_id":5'), "replies pass through without thread reconstruction");
	assert.equal(result.details["subcommand"], "pr comments");
	setSpawnOverride(null);
	setApiSpawnOverride(null);
});

test("execute api pr reviews: tool-authored pulls reviews GET, no git gate, verbatim verdicts outside a worktree", async () => {
	const tool = register();
	const argsList: string[][] = [];
	setSpawnOverride(() => {
		throw new Error("no git gate or ref resolution may spawn on the API path");
	});
	setApiSpawnOverride(((command: string, args: string[]) => {
		void command;
		const child = fakeChild();
		argsList.push([...args]);
		queueMicrotask(() => {
			httpOk(child, JSON.stringify([
				{ id: 7, user: { login: "reviewer" }, state: "CHANGES_REQUESTED", body: "please fix", commit_id: "c".repeat(40) },
			]));
		});
		return child;
	}) as never);
	const result = await tool.execute("id", { subcommand: "pr reviews", repo: "owner/repo", pr: 4 }, undefined, null, { cwd: "/not-a-worktree" });
	assert.equal(result.isError, undefined, result.content[0].text);
	assert.equal(argsList.length, 1, "exactly one gh api child; no ref resolution");
	const argv = argsList[0]!;
	assert.equal(argv[0], "api");
	assert.deepEqual(argv, ["api", "--hostname", "github.com", "--method", "GET", "--header", "Accept: application/vnd.github+json", "--header", "X-GitHub-Api-Version: 2022-11-28", "--include", "repos/owner/repo/pulls/4/reviews?per_page=100&page=1"]);
	assert.ok(result.content[0].text.includes('"state":"CHANGES_REQUESTED"'), "review verdicts pass through without reduction");
	assert.ok(result.content[0].text.includes('"login":"reviewer"'));
	assert.equal(result.details["subcommand"], "pr reviews");
	setSpawnOverride(null);
	setApiSpawnOverride(null);
});

test("execute api pr comments: non-array and invalid JSON bodies are errors", async () => {
	const tool = register();
	const bodies = [JSON.stringify({ message: "not an array" }), "not json at all"];
	for (const body of bodies) {
		setApiSpawnOverride(((command: string, args: string[]) => {
			void command;
			void args;
			const child = fakeChild();
			queueMicrotask(() => httpOk(child, body));
			return child;
		}) as never);
		const result = await tool.execute("id", { subcommand: "pr comments", repo: "owner/repo", pr: 9 }, undefined, null, { cwd: "/w" });
		assert.equal(result.isError, true, body);
	}
	setApiSpawnOverride(null);
});

test("execute api pr comments: independent paging resumes at the next batch via the continuation token", async () => {
	const tool = register();
	const argsList: string[][] = [];
	setApiSpawnOverride(((command: string, args: string[]) => {
		void command;
		const child = fakeChild();
		argsList.push([...args]);
		queueMicrotask(() => {
			if (argsList.length <= 10) {
				httpOk(
					child,
					JSON.stringify([{ id: argsList.length, body: "page one comment" }]),
					`<https://api.github.com/repos/owner/repo/pulls/9/comments?per_page=100&page=${argsList.length + 1}>; rel="next"`,
				);
			} else {
				httpOk(child, JSON.stringify([{ id: 2, body: "page two comment", in_reply_to_id: 1 }]));
			}
		});
		return child;
	}) as never);
	const first = await tool.execute("id", { subcommand: "pr comments", repo: "owner/repo", pr: 9 }, undefined, null, { cwd: "/w" });
	assert.equal(first.isError, undefined, first.content[0].text);
	const token = first.details["continuation"];
	assert.ok(typeof token === "string", "an unfetched page yields a continuation token");
	assert.ok(first.content[0].text.includes("page one comment"));
	assert.ok(!first.content[0].text.includes("page two comment"), "each call returns only its newly fetched batch");

	const second = await tool.execute(
		"id",
		{ subcommand: "pr comments", repo: "owner/repo", pr: 9, continuation: token as string },
		undefined,
		null,
		{ cwd: "/w" },
	);
	assert.equal(second.isError, undefined, second.content[0].text);
	assert.equal(argsList.length, 11, "the resume fetched exactly one more batch");
	assert.equal(argsList[10]![argsList[10]!.length - 1], "repos/owner/repo/pulls/9/comments?per_page=100&page=11");
	assert.ok(second.content[0].text.includes("page two comment"));
	assert.ok(!second.content[0].text.includes("page one comment"), "resumes fetch only the next batch, not earlier batches");
	assert.equal(second.details["continuation"], undefined, "exhausted listing carries no further token");
	setApiSpawnOverride(null);
});

test("execute api: continuation tokens cannot cross operations or targets", async () => {
	const tool = register();
	const argsList: string[][] = [];
	setApiSpawnOverride(((command: string, args: string[]) => {
		void command;
		const child = fakeChild();
		argsList.push([...args]);
		queueMicrotask(() => {
			httpOk(
					child,
					JSON.stringify([{ id: 1, body: "first page" }]),
					'<https://api.github.com/repos/owner/repo/pulls/9/comments?per_page=100&page=2>; rel="next"',
				);
			});
		return child;
	}) as never);
	const token = Buffer.from(JSON.stringify({ v: 1, op: "pr comments", repo: "owner/repo", pr: 9, perPage: 100, source: { page: 2, done: false } })).toString("base64url");

	for (const bad of [
		{ subcommand: "pr reviews", repo: "owner/repo", pr: 9, continuation: token as string }, // op differs
		{ subcommand: "pr comments", repo: "owner/repo", pr: 10, continuation: token as string }, // pr differs
	]) {
		const result = await tool.execute("id", bad, undefined, null, { cwd: "/w" });
		assert.equal(result.isError, true, JSON.stringify(bad));
		assert.ok(result.content[0].text.includes("continuation does not match"), JSON.stringify(bad));
	}
	assert.equal(argsList.length, 0, "mismatched continuations are detected before any request");
	setApiSpawnOverride(null);
});

test("gh_read registers the issue comments literal, the numeric issue field, and conversation-vs-inline guidance", () => {
	const tool = register();
	const schemaText = JSON.stringify(tool.parameters);
	assert.ok(schemaText.includes('"const":"issue comments"'), "schema literal 'issue comments'");
	const schema = tool.parameters as { properties: Record<string, unknown> };
	assert.equal((schema.properties["issue"] as { type?: string } | undefined)?.type, "number", "issue is a numeric schema field");
	assert.ok(tool.description.includes("issue comments"));
	assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
	assert.ok(tool.promptGuidelines.some((line) => line.includes("issue comments") && line.includes("conversation")), "conversation-comment guidance");
	assert.ok(tool.promptGuidelines.some((line) => line.includes("issue comments") && line.includes("'pr comments'")), "inline-review distinction guidance");
	assert.ok(tool.promptGuidelines.some((line) => line.includes("repos/{owner}/{repo}/issues/{issue}/comments")), "endpoint guidance");
});

test("gh_read guidance steers away from raw gh api and states the write boundary", () => {
	const tool = register();
	const has = (...parts: string[]): boolean => tool.promptGuidelines.some((line) => parts.every((p) => line.includes(p)));
	assert.ok(has("auth status", "gh api user --jq .login"), "auth status instead of gh api user");
	assert.ok(has("raw `gh api`", "pulls/{n}/reviews", "'pr reviews'", "git/trees/HEAD", "'repo tree'"), "operation-name mapping");
	assert.ok(has("'pr diff'", "--name-only"), "changed-file list via pr diff --name-only");
	assert.ok(has("files,changedFiles"), "pr view files/changedFiles truncation check");
	assert.ok(has("pull_request_review_id"), "one review's comments via jq");
	assert.ok(has("source_complete"), "per-batch jq caveat");
	assert.ok(has("html_url", "select(.id =="), "comment by id via html_url and jq");
	assert.ok(has("do not derive it"), "thread-state unavailability");
	assert.ok(has("never writes", "host_bash"), "write boundary");
	assert.equal(tool.promptGuidelines.length, 14, "guideline count");
});

test("execute: rejected issue comments params fail closed with zero spawns", async () => {
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
		{ subcommand: "issue comments", repo: "owner/repo" }, // missing issue
		{ subcommand: "issue comments", repo: "owner/repo", issue: "9" }, // string issue never coerced
		{ subcommand: "issue comments", repo: "owner/repo", issue: "https://github.com/owner/repo/issues/9" }, // URL never coerced
		{ subcommand: "issue comments", repo: "owner/repo", issue: "main" }, // branch never coerced
		{ subcommand: "issue comments", repo: "owner/repo", issue: 0 }, // below the positive range
		{ subcommand: "issue comments", repo: "owner/repo", issue: 1.5 }, // fraction
		{ subcommand: "issue comments", issue: 9 }, // missing repo
		{ subcommand: "issue comments", repo: "owner/repo", issue: 9, pr: 9 }, // pr is not the issue target
		{ subcommand: "issue comments", repo: "owner/repo", issue: 9, args: [] }, // structured ops reject args
		{ subcommand: "issue comments", repo: "owner/repo", issue: 9, ref: "main" }, // unrelated structured field
		{ subcommand: "issue comments", repo: "owner/repo", issue: 9, "2>&1": true }, // redirection-shaped field
	]) {
		const result = await tool.execute("id", bad, undefined, null, { cwd: "/repo" });
		assert.equal(result.isError, true, JSON.stringify(bad));
		assert.ok(result.content[0].text.startsWith("gh_read: "), JSON.stringify(bad));
	}
	assert.equal(spawns, 0, "no child process for rejected invocations");
	setSpawnOverride(null);
	setApiSpawnOverride(null);
});

test("execute api issue comments: tool-authored issues comments GET, no git gate, verbatim conversation array", async () => {
	const tool = register();
	const argsList: string[][] = [];
	setSpawnOverride(() => {
		throw new Error("no git gate or ref resolution may spawn on the API path");
	});
	setApiSpawnOverride(((command: string, args: string[]) => {
		void command;
		const child = fakeChild();
		argsList.push([...args]);
		queueMicrotask(() => {
			httpOk(child, JSON.stringify([
				{ id: 101, user: { login: "lucaspimentel" }, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-02T00:00:00Z", body: "conversation", html_url: "https://github.com/owner/repo/issues/9#issuecomment-101", unknown: { nested: true } },
			]));
		});
		return child;
	}) as never);
	const result = await tool.execute("id", { subcommand: "issue comments", repo: "owner/repo", issue: 9 }, undefined, null, { cwd: "/not-a-worktree" });
	assert.equal(result.isError, undefined, result.content[0].text);
	assert.equal(argsList.length, 1, "exactly one gh api child; no ref resolution");
	assert.deepEqual(argsList[0], ["api", "--hostname", "github.com", "--method", "GET", "--header", "Accept: application/vnd.github+json", "--header", "X-GitHub-Api-Version: 2022-11-28", "--include", "repos/owner/repo/issues/9/comments?per_page=100&page=1"]);
	assert.ok(!argsList[0]!.some((arg) => arg.includes("/pulls/")), "issue reads never hit the pulls endpoint");
	assert.ok(result.content[0].text.includes('"login":"lucaspimentel"'), "raw REST fields pass through");
	assert.ok(result.content[0].text.includes('"html_url"'));
	assert.ok(result.content[0].text.includes('"unknown":{"nested":true}'), "unknown nested fields survive");
	assert.equal(result.details["subcommand"], "issue comments");
	assert.equal(result.details["issue"], 9);
	assert.equal(result.details["pr"], undefined, "issue reads never emit pr metadata");
	setSpawnOverride(null);
	setApiSpawnOverride(null);
});

test("execute api issue comments: resume at the next batch and reject cross-operation tokens", async () => {
	const tool = register();
	const argsList: string[][] = [];
	setApiSpawnOverride(((command: string, args: string[]) => {
		void command;
		const child = fakeChild();
		argsList.push([...args]);
		queueMicrotask(() => {
			if (argsList.length <= 10) {
				httpOk(child, JSON.stringify([{ id: argsList.length, body: "page one" }]), `<https://api.github.com/repos/owner/repo/issues/9/comments?per_page=100&page=${argsList.length + 1}>; rel="next"`);
			} else {
				httpOk(child, JSON.stringify([{ id: 2, body: "page two" }]));
			}
		});
		return child;
	}) as never);
	const first = await tool.execute("id", { subcommand: "issue comments", repo: "owner/repo", issue: 9 }, undefined, null, { cwd: "/w" });
	assert.equal(first.isError, undefined, first.content[0].text);
	const token = first.details["continuation"];
	assert.ok(typeof token === "string", "an unfetched page yields a continuation token");
	const second = await tool.execute("id", { subcommand: "issue comments", repo: "owner/repo", issue: 9, continuation: token as string }, undefined, null, { cwd: "/w" });
	assert.equal(second.isError, undefined, second.content[0].text);
	assert.equal(argsList.length, 11, "the resume fetched exactly one more batch");
	assert.equal(argsList[10]![argsList[10]!.length - 1], "repos/owner/repo/issues/9/comments?per_page=100&page=11");
	assert.ok(second.content[0].text.includes("page two"));
	assert.ok(!second.content[0].text.includes("page one"), "resumes fetch only the next batch");
	assert.equal(second.details["continuation"], undefined);

	// Cross-operation and cross-target tokens are rejected before any request.
	const issueToken = Buffer.from(JSON.stringify({ v: 1, op: "issue comments", repo: "owner/repo", issue: 9, perPage: 100, source: { page: 2, done: false } })).toString("base64url");
	const prToken = Buffer.from(JSON.stringify({ v: 1, op: "pr comments", repo: "owner/repo", pr: 9, perPage: 100, source: { page: 2, done: false } })).toString("base64url");
	const before = argsList.length;
	for (const bad of [
		{ subcommand: "pr comments", repo: "owner/repo", pr: 9, continuation: issueToken }, // issue token on a PR op
		{ subcommand: "issue comments", repo: "owner/repo", issue: 10, continuation: issueToken }, // issue differs
		{ subcommand: "issue comments", repo: "owner/repo", issue: 9, continuation: prToken }, // PR token on the issue op
	]) {
		const result = await tool.execute("id", bad, undefined, null, { cwd: "/w" });
		assert.equal(result.isError, true, JSON.stringify(bad));
		assert.ok(result.content[0].text.includes("continuation does not match"), JSON.stringify(bad));
	}
	assert.equal(argsList.length, before, "mismatched continuations are detected before any request");
	setApiSpawnOverride(null);
});

test("execute api pr reviews: a later-page failure is an error that retains completed items and the retry position", async () => {
	const tool = register();
	setApiSpawnOverride(((command: string, args: string[]) => {
		void command;
		const child = fakeChild();
		queueMicrotask(() => {
			if (args[args.length - 1]?.endsWith("page=1")) {
				httpOk(
					child,
					JSON.stringify([{ id: 1, state: "APPROVED", body: "review one" }]),
					'<https://api.github.com/repos/owner/repo/pulls/4/reviews?per_page=100&page=2>; rel="next"',
				);
			} else {
				child.stderr.emit("data", Buffer.from("gh: boom (HTTP 500)\n"));
				child.stdout.emit("data", Buffer.from("HTTP/1.1 500 Internal Server Error\r\n\r\n"));
				child.emit("close", 1, null);
			}
		});
		return child;
	}) as never);
	const result = await tool.execute("id", { subcommand: "pr reviews", repo: "owner/repo", pr: 4 }, undefined, null, { cwd: "/w" });
	assert.equal(result.isError, true, "HTTP errors pass through without automatic retries");
	assert.ok(result.content[0].text.includes("review one"), "completed page data is preserved");
	assert.ok(typeof result.details["continuation"] === "string", "the failed page is kept as the retry position");
	setApiSpawnOverride(null);
});

// ── pr threads (GraphQL review threads) ─────────────────────────────────────

const threadsPayload = (hasNextPage: boolean, endCursor: string | null): string =>
	JSON.stringify({
		data: {
			repository: {
				pullRequest: {
					url: "https://github.com/owner/repo/pull/9",
					reviewThreads: {
						totalCount: 1,
						pageInfo: { hasNextPage, endCursor },
						nodes: [
							{
								id: "PRRT_1",
								isResolved: true,
								isOutdated: false,
								path: "src/x.ts",
								line: 42,
								comments: {
									totalCount: 1,
									pageInfo: { hasNextPage: false, endCursor: null },
									nodes: [{ id: "PRRC_1", databaseId: 7, author: { login: "alice", __typename: "User" }, body: "please fix", createdAt: "2026-01-01T00:00:00Z", url: "https://github.com/owner/repo/pull/9#discussion_r7" }],
								},
							},
						],
					},
				},
			},
		},
	});

test("gh_read registers the pr threads literal and GraphQL review-thread guidance", () => {
	const tool = register();
	assert.ok(JSON.stringify(tool.parameters).includes('"const":"pr threads"'), "schema literal 'pr threads'");
	assert.ok(tool.description.includes("pr threads"), "description names the operation");
	assert.ok(tool.promptSnippet.includes("pr threads"), "promptSnippet names the operation");
	assert.ok(tool.description.includes("reviewThreads"), "description names the GraphQL payload");
	const has = (...parts: string[]): boolean => tool.promptGuidelines.some((line) => parts.every((p) => line.includes(p)));
	assert.ok(has("'pr threads'", "GraphQL review-thread read"), "operation-name mapping for the GraphQL read");
	assert.ok(has("'pr threads'", "resolved/outdated"), "the PR-discussions bullet points at pr threads for resolved/outdated state");
	assert.ok(has("do not derive it"), "the never-derive-it warning survives");
	assert.ok(has("never derive it from comment line fields"), "the shapes bullet names the REST reads as the ones without thread state");
	assert.ok(has("'pr threads'", "page independently"), "the paging bullets enumerate pr threads");
	assert.equal(tool.promptGuidelines.length, 14, "guideline count");
	// No reference to the personal gh extension may leak into the guidance.
	assert.ok(!tool.promptGuidelines.some((line) => line.includes("gh pr-threads")), "no gh-extension reference in the guidance");
});

test("execute: rejected pr threads params fail closed with zero spawns", async () => {
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
		{ subcommand: "pr threads", repo: "owner/repo" }, // missing pr
		{ subcommand: "pr threads", repo: "owner/repo", pr: "9" }, // string pr never coerced
		{ subcommand: "pr threads", repo: "owner/repo", pr: 0 }, // below the positive range
		{ subcommand: "pr threads", pr: 9 }, // missing repo
		{ subcommand: "pr threads", repo: "owner/repo", pr: 9, args: [] }, // structured ops reject args
		{ subcommand: "pr threads", repo: "owner/repo", pr: 9, ref: "main" }, // unrelated structured field
		{ subcommand: "pr threads", repo: "owner/repo", pr: 9, cursor: "CURSOR1" }, // caller cursors are never accepted
		{ subcommand: "pr threads", repo: "owner/repo", pr: 9, first: 100 }, // page size is fixed
		{ subcommand: "pr threads", repo: "owner/repo", pr: 9, "2>&1": true }, // redirection-shaped field
	]) {
		const result = await tool.execute("id", bad, undefined, null, { cwd: "/repo" });
		assert.equal(result.isError, true, JSON.stringify(bad));
		assert.ok(result.content[0].text.startsWith("gh_read: "), JSON.stringify(bad));
	}
	assert.equal(spawns, 0, "no child process for rejected invocations");
	setSpawnOverride(null);
	setApiSpawnOverride(null);
});

test("execute api pr threads: tool-authored GraphQL POST, no git gate, verbatim nodes outside a worktree", async () => {
	const tool = register();
	const argsList: string[][] = [];
	setSpawnOverride(() => {
		throw new Error("no git gate or ref resolution may spawn on the GraphQL path");
	});
	setApiSpawnOverride(((command: string, args: string[]) => {
		void command;
		const child = fakeChild();
		argsList.push([...args]);
		queueMicrotask(() => httpOk(child, threadsPayload(false, null)));
		return child;
	}) as never);
	const result = await tool.execute("id", { subcommand: "pr threads", repo: "owner/repo", pr: 9 }, undefined, null, { cwd: "/not-a-worktree" });
	assert.equal(result.isError, undefined, result.content[0].text);
	assert.equal(argsList.length, 1, "exactly one gh api child; no ref resolution or git gate");
	assert.deepEqual(argsList[0], [
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
		`query=${REVIEW_THREADS_QUERY}`,
		"-f",
		"owner=owner",
		"-f",
		"repo=repo",
		"-F",
		"pr=9",
	]);
	assert.ok(result.content[0].text.includes('"isResolved":true'), "resolved state passes through verbatim");
	assert.ok(result.content[0].text.includes('"isOutdated":false'));
	assert.ok(result.content[0].text.includes('"__typename":"User"'));
	assert.ok(result.content[0].text.includes("pr_url: https://github.com/owner/repo/pull/9"));
	assert.match(result.content[0].text, /resolved and outdated threads are included/);
	assert.equal(result.details["subcommand"], "pr threads");
	assert.equal(result.details["source_complete"], true);
	setSpawnOverride(null);
	setApiSpawnOverride(null);
});

test("execute api pr threads: a resume token rides -f cursor= and cross-operation tokens are rejected", async () => {
	const tool = register();
	const argsList: string[][] = [];
	setApiSpawnOverride(((command: string, args: string[]) => {
		void command;
		const child = fakeChild();
		argsList.push([...args]);
		queueMicrotask(() => httpOk(child, threadsPayload(false, null)));
		return child;
	}) as never);
	const token = Buffer.from(JSON.stringify({ v: 1, op: "pr threads", repo: "owner/repo", pr: 9, first: 100, cursor: "CURSOR9" })).toString("base64url");
	const resumed = await tool.execute("id", { subcommand: "pr threads", repo: "owner/repo", pr: 9, continuation: token }, undefined, null, { cwd: "/w" });
	assert.equal(resumed.isError, undefined, resumed.content[0].text);
	assert.equal(argsList.length, 1);
	assert.deepEqual(argsList[0]!.slice(-2), ["-f", "cursor=CURSOR9"]);
	assert.match(resumed.content[0].text, /only the newly fetched threads/);

	// Cross-operation tokens reject before any request.
	const commentsToken = Buffer.from(JSON.stringify({ v: 1, op: "pr comments", repo: "owner/repo", pr: 9, perPage: 100, source: { page: 2, done: false } })).toString("base64url");
	const issueToken = Buffer.from(JSON.stringify({ v: 1, op: "issue comments", repo: "owner/repo", issue: 9, perPage: 100, source: { page: 2, done: false } })).toString("base64url");
	const before = argsList.length;
	for (const bad of [
		{ subcommand: "pr threads", repo: "owner/repo", pr: 9, continuation: commentsToken }, // REST token on the GraphQL op
		{ subcommand: "pr comments", repo: "owner/repo", pr: 9, continuation: token }, // GraphQL token on the REST op
		{ subcommand: "pr threads", repo: "owner/repo", pr: 9, continuation: issueToken },
		{ subcommand: "pr threads", repo: "owner/repo", pr: 10, continuation: token }, // pr differs
	]) {
		const result = await tool.execute("id", bad, undefined, null, { cwd: "/w" });
		assert.equal(result.isError, true, JSON.stringify(bad));
		assert.ok(result.content[0].text.includes("continuation does not match"), JSON.stringify(bad));
	}
	assert.equal(argsList.length, before, "mismatched continuations are detected before any request");
	setApiSpawnOverride(null);
});

test("execute api pr threads: a GraphQL exit 1 with usable data beside errors is accepted end to end", async () => {
	const tool = register();
	setApiSpawnOverride(((command: string, args: string[]) => {
		void command;
		void args;
		const child = fakeChild();
		queueMicrotask(() => {
			const body = JSON.stringify({ ...JSON.parse(threadsPayload(false, null)), errors: [{ message: "partial failure" }] });
			child.stdout.emit("data", Buffer.from(`HTTP/1.1 200 OK\r\n\r\n${body}`));
			child.emit("close", 1, null);
		});
		return child;
	}) as never);
	const result = await tool.execute("id", { subcommand: "pr threads", repo: "owner/repo", pr: 9 }, undefined, null, { cwd: "/w" });
	assert.equal(result.isError, undefined, result.content[0].text);
	assert.ok(result.content[0].text.includes("GraphQL error: partial failure"));
	assert.equal(result.details["source_complete"], true);
	setApiSpawnOverride(null);
});
