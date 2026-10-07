// Tool and lifecycle tests for the update-jira extension: registration,
// transport argument routing for all six actions, error classification,
// config fail-closed and live reload, queue serialization and cancellation,
// pointer lifecycle hooks, and spill behavior through real tool results.
//
// Network-free: every test runs against a stub transport and a stub
// subprocess runner; no test can reach Jira.
//
// Run: node --test tests/update-jira-tools.test.mts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import updateJiraExtension, { createPointerHooks } from "../extensions/update-jira/index.ts";
import { createReadTool, type ReadParams, type ToolExecuteContext } from "../extensions/update-jira/read-tool.ts";
import { createUpdateTool, type UpdateParams } from "../extensions/update-jira/update-tool.ts";
import type { ToolDeps, ToolResultLike } from "../extensions/update-jira/common.ts";
import { WriteQueue } from "../extensions/update-jira/write-queue.ts";
import type { SubprocessRunner } from "../extensions/update-jira/branch.ts";
import { createSpillManager, type ResultEnvelope } from "../extensions/update-jira/results.ts";

// ── Harness ──────────────────────────────────────────────────────────────────

interface RecordedCall {
	tool: string;
	args: Record<string, unknown>;
	signal?: AbortSignal;
}

type OutcomeHandler = (call: RecordedCall) => unknown;

function okOutcome(payload: unknown, truncateContent = false): unknown {
	const text = JSON.stringify(payload);
	const contentText = truncateContent && text.length > 100 ? text.slice(0, 20) + "...[truncated]" : text;
	return {
		isError: false,
		result: {
			content: [{ type: "text", text: contentText }],
			isError: false,
			structuredContent: { content: [{ type: "text", text }], isError: false },
		},
	};
}

function errorOutcome(serverError: { message: string; statusCode: number }): unknown {
	const text = JSON.stringify({ error: true, message: serverError.message, statusCode: serverError.statusCode });
	const outcome = { isError: true, result: { content: [{ type: "text", text }], isError: true, structuredContent: { content: [{ type: "text", text }], isError: true } } };
	return outcome;
}

interface Harness {
	deps: ToolDeps;
	calls: RecordedCall[];
	setHandler(handler: OutcomeHandler): void;
	configPath: string;
	writeConfig(config: unknown): void;
	removeConfig(): void;
	dir: string;
}

function makeHarness(options: { config?: unknown; run?: SubprocessRunner } = {}): Harness {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "update-jira-tools-"));
	const configPath = path.join(dir, "update-jira.json");
	const calls: RecordedCall[] = [];
	let handler: OutcomeHandler = () => {
		throw new Error("no scripted outcome");
	};
	const transport: Transport = {
		call: async (tool, args, signal) => {
			const recorded: RecordedCall = { tool, args, signal };
			calls.push(recorded);
			return handler(recorded);
		},
	};
	const writeConfig = (config: unknown) => fs.writeFileSync(configPath, JSON.stringify(config, null, 1));
	if (options.config !== undefined) writeConfig(options.config);
	const spillCleanup: Array<() => void> = [];
	const deps: ToolDeps = {
		configPath,
		readConfigFile: (p) => fs.readFileSync(p, "utf8"),
		run:
			options.run ??
			(() => {
				throw new Error("subprocess not expected in this test");
			}),
		queue: new WriteQueue(),
		transportFactory: () => transport,
		spillFactory: (sessionKey) => {
			const manager = createSpillManager({ tmpRoot: dir }, sessionKey);
			spillCleanup.push(() => manager.cleanup());
			return manager;
		},
	};
	const harness: Harness = {
		deps,
		calls,
		setHandler(h: OutcomeHandler) {
			handler = h;
		},
		configPath,
		writeConfig,
		removeConfig: () => fs.rmSync(configPath, { force: true }),
		dir,
	};
	(harness as unknown as { spillCleanup: Array<() => void> }).spillCleanup = spillCleanup;
	return harness;
}

function cleanupHarness(harness: Harness): void {
	for (const fn of (harness as unknown as { spillCleanup: Array<() => void> }).spillCleanup ?? []) fn();
	fs.rmSync(harness.dir, { recursive: true, force: true });
}

function fakeCtx(overrides: Partial<ToolExecuteContext> = {}): ToolExecuteContext {
	return {
		cwd: "/repo",
		sessionManager: { getSessionFile: () => "/tmp/sessions/test-session.jsonl" },
		executeTool: () => {
			throw new Error("executeTool must not be called directly");
		},
		...overrides,
	};
}

const VALID_CONFIG = { siteUrl: "https://example.atlassian.net" };

async function runRead(harness: Harness, params: Partial<ReadParams>, ctx = fakeCtx(), signal?: AbortSignal): Promise<ToolResultLike> {
	const tool = createReadTool(harness.deps) as unknown as {
		execute(id: string, params: ReadParams, signal?: AbortSignal, onUpdate?: unknown, ctx?: ToolExecuteContext): Promise<ToolResultLike>;
	};
	return tool.execute("t1", { action: "get", ...params } as ReadParams, signal, undefined, ctx);
}

async function runUpdate(harness: Harness, params: Partial<UpdateParams>, ctx = fakeCtx(), signal?: AbortSignal): Promise<ToolResultLike> {
	const tool = createUpdateTool(harness.deps) as unknown as {
		execute(id: string, params: UpdateParams, signal?: AbortSignal, onUpdate?: unknown, ctx?: ToolExecuteContext): Promise<ToolResultLike>;
	};
	return tool.execute("t1", { action: "transition", ...params } as UpdateParams, signal, undefined, ctx);
}

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
	for (let i = 0; i < 200; i++) {
		if (predicate()) return;
		await new Promise((r) => setTimeout(r, 5));
	}
	assert.fail(`timed out waiting for ${what}`);
}

function envelopeOf(result: ToolResultLike): ResultEnvelope {
	return result.structuredContent;
}

// ── Registration ─────────────────────────────────────────────────────────────

test("registration: exactly two tools and lifecycle handlers, no side effects", () => {
	const tools: Array<{ name: string; annotations?: Record<string, unknown> }> = [];
	const handlers: Record<string, unknown> = {};
	const pi = {
		registerTool: (tool: { name: string; annotations?: Record<string, unknown> }) => tools.push(tool),
		on: (event: string, handler: unknown) => {
			handlers[event] = handler;
			return () => {};
		},
	};
	const resourcesBefore = new Set(process.getActiveResourcesInfo());
	updateJiraExtension(pi as never);
	const resourcesAfter = new Set(process.getActiveResourcesInfo());
	assert.deepEqual(tools.map((t) => t.name), ["jira_read", "jira_update"]);
	assert.deepEqual(tools[0].annotations, { readOnlyHint: true, openWorldHint: true, idempotentHint: true });
	assert.deepEqual(tools[1].annotations, { readOnlyHint: false, openWorldHint: true });
	assert.ok(handlers.before_agent_start);
	assert.ok(handlers.session_start);
	assert.ok(handlers.session_tree);
	assert.ok(handlers.session_shutdown);
	for (const resource of resourcesAfter) {
		if (!resourcesBefore.has(resource)) {
			assert.ok(!["ChildProcess", "TCPSocketWrap", "TCPServerWrap", "Timeout", "FSReqPromise"].includes(String(resource)), `registration created a ${resource}`);
		}
	}
});

// ── jira_read: get ───────────────────────────────────────────────────────────

test("read get digest: routes view full with explicit fields and markdown", async () => {
	const harness = makeHarness({ config: VALID_CONFIG });
	try {
		harness.setHandler(() =>
			okOutcome({
				data: {
					key: "EXAMPLE-101",
					fields: { summary: "S", status: { name: "In Progress" }, assignee: { displayName: "U" }, description: "D" },
					appliedContentFormat: "markdown",
				},
			}),
		);
		const result = await runRead(harness, { action: "get", ticketKey: "example-101" });
		assert.equal(harness.calls.length, 1);
		assert.deepEqual(harness.calls[0].args, {
			cloudId: "https://example.atlassian.net/",
			issueIdOrKey: "EXAMPLE-101",
			view: "full",
			fields: ["summary", "status", "assignee", "description"],
			fieldsByKeys: true,
			responseContentFormat: "markdown",
		});
		assert.equal(harness.calls[0].tool, "mcp__atlassian__getJiraIssue");
		const envelope = envelopeOf(result);
		assert.equal(envelope.ok, true);
		assert.equal(envelope.ticket, "EXAMPLE-101");
		assert.equal((envelope.data as { key: string }).key, "EXAMPLE-101");
		assert.equal(result.isError, false);
	} finally {
		cleanupHarness(harness);
	}
});

test("read get raw: requests fields *all and passes the complete payload through", async () => {
	const harness = makeHarness({ config: VALID_CONFIG });
	try {
		const bigField = "z".repeat(30000);
		harness.setHandler(() => okOutcome({ data: { key: "EXAMPLE-101", fields: { customfield_1: bigField }, appliedContentFormat: "html", warning: "w" } }, true));
		const result = await runRead(harness, { action: "get", ticketKey: "EXAMPLE-101", raw: true });
		assert.deepEqual(harness.calls[0].args.fields, ["*all"]);
		assert.equal(harness.calls[0].args.fieldsByKeys, undefined);
		const envelope = envelopeOf(result);
		assert.equal((envelope.data as { fields: { customfield_1: string } }).fields.customfield_1.length, 30000, "raw data is complete, not shaped");
		assert.equal((envelope.data as { warning: string }).warning, "w");
	} finally {
		cleanupHarness(harness);
	}
});

test("read get digest: description truncation marker and oversized spill", async () => {
	const harness = makeHarness({ config: VALID_CONFIG });
	try {
		harness.setHandler(() =>
			okOutcome({ data: { key: "EXAMPLE-101", fields: { summary: "S", description: "y".repeat(30000) }, appliedContentFormat: "markdown" } }),
		);
		const result = await runRead(harness, { action: "get", ticketKey: "EXAMPLE-101" });
		const envelope = envelopeOf(result);
		const digest = envelope.data as { descriptionTruncated: boolean; description: string };
		assert.equal(digest.descriptionTruncated, true);
		assert.equal(digest.description.length, 1500);
		assert.ok(result.content[0].text.length < 4000, "model-facing text stays bounded");
	} finally {
		cleanupHarness(harness);
	}
});

// ── jira_read: comments ──────────────────────────────────────────────────────

test("read comments: routes the granular read with pagination defaults", async () => {
	const harness = makeHarness({ config: VALID_CONFIG });
	try {
		harness.setHandler(() => okOutcome({ data: { startAt: 0, maxResults: 20, total: 13, isLast: true, comments: [], appliedContentFormat: "html", warning: "w" } }));
		const result = await runRead(harness, { action: "comments", ticketKey: "EXAMPLE-101" });
		assert.equal(harness.calls[0].tool, "mcp__atlassian__executeRead");
		assert.deepEqual(harness.calls[0].args, {
			cloudId: "https://example.atlassian.net/",
			name: "listJiraIssueComments",
			inputs: { issueIdOrKey: "EXAMPLE-101", startAt: 0, maxResults: 20, orderBy: "-created", responseContentFormat: "markdown" },
		});
		const envelope = envelopeOf(result);
		assert.deepEqual(envelope.data, {
			startAt: 0,
			maxResults: 20,
			total: 13,
			isLast: true,
			comments: [],
			appliedContentFormat: "html",
			warning: "w",
		});
		// Nonzero offset passes through.
		await runRead(harness, { action: "comments", ticketKey: "EXAMPLE-101", startAt: 10 });
		assert.deepEqual(harness.calls[1].args.inputs, {
			issueIdOrKey: "EXAMPLE-101",
			startAt: 10,
			maxResults: 20,
			orderBy: "-created",
			responseContentFormat: "markdown",
		});
	} finally {
		cleanupHarness(harness);
	}
});

test("read comments: malformed page is invalid_response", async () => {
	const harness = makeHarness({ config: VALID_CONFIG });
	try {
		harness.setHandler(() => okOutcome({ data: { note: "no comments here" } }));
		const result = await runRead(harness, { action: "comments", ticketKey: "EXAMPLE-101" });
		const envelope = envelopeOf(result);
		assert.equal(envelope.ok, false);
		assert.equal(envelope.error?.kind, "invalid_response");
		assert.equal(result.isError, true);
	} finally {
		cleanupHarness(harness);
	}
});

// ── Error classification through the tools ───────────────────────────────────

test("read: server 404 becomes not_found; unknown nested tool becomes tool_unavailable", async () => {
	const harness = makeHarness({ config: VALID_CONFIG });
	try {
		harness.setHandler(() => errorOutcome({ message: 'Issue "ZZZ-1" not found', statusCode: 404 }));
		const notFound = await runRead(harness, { action: "get", ticketKey: "ZZZ-1" });
		assert.equal(envelopeOf(notFound).error?.kind, "not_found");
		assert.ok(String(envelopeOf(notFound).error?.message).includes("ZZZ-1"));

		harness.setHandler(() => ({ isError: true, result: { content: [{ type: "text", text: "Tool mcp__atlassian__getJiraIssue not found" }] } }));
		const unavailable = await runRead(harness, { action: "get", ticketKey: "ZZZ-1" });
		assert.equal(envelopeOf(unavailable).error?.kind, "tool_unavailable");
	} finally {
		cleanupHarness(harness);
	}
});

test("read: cancellation is reported as cancelled", async () => {
	const harness = makeHarness({ config: VALID_CONFIG });
	try {
		const controller = new AbortController();
		controller.abort();
		const result = await runRead(harness, { action: "get", ticketKey: "EXAMPLE-101" }, fakeCtx(), controller.signal);
		assert.equal(envelopeOf(result).error?.kind, "cancelled");
		assert.equal(harness.calls.length, 0, "no remote call after abort before dispatch");
	} finally {
		cleanupHarness(harness);
	}
});

// ── Configuration fail-closed and live reload ────────────────────────────────

test("config: invalid or missing configuration makes zero remote calls", async () => {
	const harness = makeHarness({ config: { siteUrl: "http://insecure.example" } });
	try {
		harness.setHandler(() => okOutcome({ data: {} }));
		const result = await runRead(harness, { action: "get", ticketKey: "EXAMPLE-101" });
		assert.equal(envelopeOf(result).error?.kind, "config_invalid");
		assert.equal(harness.calls.length, 0);
		harness.removeConfig();
		const missing = await runRead(harness, { action: "get", ticketKey: "EXAMPLE-101" });
		assert.equal(envelopeOf(missing).error?.kind, "config_invalid");
		assert.equal(harness.calls.length, 0);
	} finally {
		cleanupHarness(harness);
	}
});

test("config: fixes apply without reload and queued calls keep their snapshot", async () => {
	const harness = makeHarness({ config: { siteUrl: "https://first.example" } });
	try {
		harness.setHandler(() => okOutcome({ data: { key: "EXAMPLE-101", fields: {} } }));
		await runRead(harness, { action: "get", ticketKey: "EXAMPLE-101" });
		assert.equal(harness.calls[0].args.cloudId, "https://first.example/");
		harness.writeConfig({ siteUrl: "https://second.example" });
		await runRead(harness, { action: "get", ticketKey: "EXAMPLE-101" });
		assert.equal(harness.calls[1].args.cloudId, "https://second.example/");
	} finally {
		cleanupHarness(harness);
	}
});

test("branch resolution: explicit key overrides git, defaults honor the branch per call", async () => {
	const runCalls: Array<{ command: string; args: string[]; cwd: string }> = [];
	let branch = "feature/SLES-3026-fix";
	const run: SubprocessRunner = async (command, args, cwd) => {
		runCalls.push({ command, args, cwd });
		return { code: 0, stdout: `${branch}\n`, stderr: "" };
	};
	const harness = makeHarness({ config: VALID_CONFIG, run });
	try {
		harness.setHandler(() => okOutcome({ data: { key: "SLES-3026", fields: {} } }));
		await runRead(harness, { action: "get" });
		assert.equal(envelopeOf((await runRead(harness, { action: "get" })) as ToolResultLike).ticket, "SLES-3026");
		branch = "release/ABC-9";
		const second = await runRead(harness, { action: "get" });
		assert.equal(envelopeOf(second).ticket, "ABC-9", "branch changes are honored per call");
		assert.equal(runCalls.every((c) => c.command === "git" && !c.args.includes("&&")), true, "git runs as an argument array");
		// Explicit key bypasses git but not config validation.
		const before = runCalls.length;
		await runRead(harness, { action: "get", ticketKey: "OTHER-1" });
		assert.equal(runCalls.length, before, "explicit target does not run git");
	} finally {
		cleanupHarness(harness);
	}
});

// ── jira_update: transition ──────────────────────────────────────────────────

const TRANSITIONS = {
	data: {
		transitions: [
			{ id: "111", name: "T1", to: { name: "Archive" }, hasScreen: false, isAvailable: true, fields: {} },
			{ id: "931", name: "T2", to: { name: "Done" }, hasScreen: false, isAvailable: true, fields: {} },
			{ id: "941", name: "T3", to: { name: "Done" }, hasScreen: false, isAvailable: true, fields: {} },
			{
				id: "951",
				name: "T4",
				to: { name: "Waiting" },
				hasScreen: true,
				isAvailable: true,
				fields: [{ required: true, name: "Resolution" }],
			},
		],
	},
};

test("update transition: status match submits an id and reports the landed status", async () => {
	const harness = makeHarness({ config: VALID_CONFIG });
	try {
		harness.setHandler((call) => (call.tool.includes("executeRead") ? okOutcome(TRANSITIONS) : okOutcome({ data: { status: { name: "Archive" } } })));
		const result = await runUpdate(harness, { action: "transition", ticketKey: "EXAMPLE-101", status: " archive " });
		assert.equal(harness.calls.length, 2);
		assert.equal(harness.calls[0].tool, "mcp__atlassian__executeRead");
		assert.deepEqual(harness.calls[0].args.inputs, { issueIdOrKey: "EXAMPLE-101", expand: "transitions.fields" });
		assert.equal(harness.calls[1].tool, "mcp__atlassian__transitionJiraIssue");
		assert.deepEqual(harness.calls[1].args, { cloudId: "https://example.atlassian.net/", issueIdOrKey: "EXAMPLE-101", transitionId: "111" });
		const envelope = envelopeOf(result);
		assert.equal(envelope.ok, true);
		assert.equal((envelope.data as { landedStatus: string }).landedStatus, "Archive");
	} finally {
		cleanupHarness(harness);
	}
});

test("update transition: zero and multiple status matches are rejected with candidates", async () => {
	const harness = makeHarness({ config: VALID_CONFIG });
	try {
		harness.setHandler(() => okOutcome(TRANSITIONS));
		const zero = await runUpdate(harness, { action: "transition", ticketKey: "EXAMPLE-101", status: "Nope" });
		assert.equal(envelopeOf(zero).error?.kind, "rejected");
		assert.equal(harness.calls.length, 1, "no write dispatched");
		const multi = await runUpdate(harness, { action: "transition", ticketKey: "EXAMPLE-101", status: "Done" });
		const error = envelopeOf(multi).error;
		assert.equal(error?.kind, "rejected");
		const candidates = (error?.evidence as { candidates: Array<{ id: string; to: string }> }).candidates;
		assert.deepEqual(candidates.map((c) => c.id), ["931", "941"]);
		assert.equal(harness.calls.length, 2, "still no write dispatched");
	} finally {
		cleanupHarness(harness);
	}
});

test("update transition: explicit id verified against the enumeration; required fields rejected", async () => {
	const harness = makeHarness({ config: VALID_CONFIG });
	try {
		harness.setHandler((call) => (call.tool.includes("executeRead") ? okOutcome(TRANSITIONS) : okOutcome({ data: { status: "Waiting" } })));
		const bad = await runUpdate(harness, { action: "transition", ticketKey: "EXAMPLE-101", transitionId: "999" });
		assert.equal(envelopeOf(bad).error?.kind, "rejected");
		assert.equal(harness.calls.length, 1);
		const required = await runUpdate(harness, { action: "transition", ticketKey: "EXAMPLE-101", transitionId: "951" });
		assert.equal(envelopeOf(required).error?.kind, "rejected");
		assert.ok(String(envelopeOf(required).error?.message).includes("Resolution"));
		assert.equal(harness.calls.length, 2);
		const good = await runUpdate(harness, { action: "transition", ticketKey: "EXAMPLE-101", transitionId: "111" });
		assert.equal(envelopeOf(good).ok, true);
		assert.equal(harness.calls.length, 4, "enumeration + write for the successful path");
	} finally {
		cleanupHarness(harness);
	}
});

test("update transition: exactly one of status or transitionId", async () => {
	const harness = makeHarness({ config: VALID_CONFIG });
	try {
		harness.setHandler(() => okOutcome(TRANSITIONS));
		const neither = await runUpdate(harness, { action: "transition", ticketKey: "EXAMPLE-101" });
		assert.equal(envelopeOf(neither).error?.kind, "invalid_input");
		const both = await runUpdate(harness, { action: "transition", ticketKey: "EXAMPLE-101", status: "Done", transitionId: "931" });
		assert.equal(envelopeOf(both).error?.kind, "invalid_input");
		assert.equal(harness.calls.length, 0);
	} finally {
		cleanupHarness(harness);
	}
});

// ── jira_update: comment ─────────────────────────────────────────────────────

test("update comment: add-only routing with default markdown and explicit html", async () => {
	const harness = makeHarness({ config: VALID_CONFIG });
	try {
		harness.setHandler(() => okOutcome({ data: { id: "10001", body: "b", appliedContentFormat: "markdown" } }));
		const result = await runUpdate(harness, { action: "comment", ticketKey: "EXAMPLE-101", body: "hello" });
		assert.equal(harness.calls[0].tool, "mcp__atlassian__addOrEditJiraIssueComment");
		assert.deepEqual(harness.calls[0].args, {
			cloudId: "https://example.atlassian.net/",
			issueIdOrKey: "EXAMPLE-101",
			commentBody: "hello",
		});
		assert.equal((envelopeOf(result).data as { commentId: string }).commentId, "10001");

		await runUpdate(harness, { action: "comment", ticketKey: "EXAMPLE-101", body: "<p>hi</p>", contentFormat: "html" });
		assert.equal(harness.calls[1].args.contentFormat, "html");

		harness.setHandler(() => errorOutcome({ message: "HTML format feature is disabled", statusCode: 400 }));
		const rejected = await runUpdate(harness, { action: "comment", ticketKey: "EXAMPLE-101", body: "<p>hi</p>", contentFormat: "html" });
		assert.equal(envelopeOf(rejected).error?.kind, "rejected", "HTML rejection is surfaced, never retried as markdown");
		assert.equal(harness.calls.length, 3, "no markdown downgrade retry");

		const empty = await runUpdate(harness, { action: "comment", ticketKey: "EXAMPLE-101", body: "   " });
		assert.equal(envelopeOf(empty).error?.kind, "invalid_input");
	} finally {
		cleanupHarness(harness);
	}
});

// ── jira_update: link_pr ─────────────────────────────────────────────────────

const EXISTING_LINKS = { data: [{ id: "1", relationship: "links to", object: { url: "https://github.com/o/r/pull/7", title: "PR 7" } }] };

test("update link_pr: dedupe no-op before creation; malformed read prevents creation", async () => {
	const harness = makeHarness({ config: VALID_CONFIG });
	try {
		harness.setHandler(() => okOutcome(EXISTING_LINKS));
		const noop = await runUpdate(harness, { action: "link_pr", ticketKey: "EXAMPLE-101", url: "https://github.com/o/r/pull/7" });
		const envelope = envelopeOf(noop);
		assert.equal(envelope.ok, true);
		assert.equal((envelope.data as { created: boolean }).created, false);
		assert.equal(harness.calls.length, 1, "no create call after a dedupe hit");

		harness.setHandler(() => okOutcome({ data: "not-an-array" }));
		const malformed = await runUpdate(harness, { action: "link_pr", ticketKey: "EXAMPLE-101", url: "https://github.com/o/r/pull/8" });
		assert.equal(envelopeOf(malformed).error?.kind, "invalid_response");
		assert.equal(harness.calls.length, 2, "creation prevented after a failed dedupe read");
	} finally {
		cleanupHarness(harness);
	}
});

test("update link_pr: creates a native remote link via executeWrite with title precedence", async () => {
	const harness = makeHarness({ config: VALID_CONFIG });
	try {
		harness.setHandler((call) => (call.tool.includes("executeRead") ? okOutcome({ data: [] }) : okOutcome({ data: { id: "9" } })));
		const explicit = await runUpdate(harness, { action: "link_pr", ticketKey: "EXAMPLE-101", url: "https://github.com/o/r/pull/7", title: "My PR" });
		assert.deepEqual(harness.calls[1].args.inputs, { issueIdOrKey: "EXAMPLE-101", url: "https://github.com/o/r/pull/7", title: "My PR" });
		assert.equal((envelopeOf(explicit).data as { created: boolean }).created, true);

		const noTitle = await runUpdate(harness, { action: "link_pr", ticketKey: "EXAMPLE-101", url: "https://example.com/x" });
		assert.deepEqual(harness.calls[3].args.inputs, { issueIdOrKey: "EXAMPLE-101", url: "https://example.com/x" }, "no title supplied means no title argument");
		assert.equal((envelopeOf(noTitle).data as { title: string }).title, "https://example.com/x", "URL is the title fallback and is preserved exactly");
	} finally {
		cleanupHarness(harness);
	}
});

test("update link_pr: gh fallback, gh failure prevents mutation, invalid url rejected", async () => {
	const runCalls: Array<{ command: string; args: string[]; cwd: string }> = [];
	let ghResult: { code: number; stdout: string; stderr: string } = { code: 0, stdout: '{"url":"https://github.com/o/r/pull/9","title":"GH Title"}', stderr: "" };
	const run: SubprocessRunner = async (command, args, cwd) => {
		runCalls.push({ command, args, cwd });
		return ghResult;
	};
	const harness = makeHarness({ config: VALID_CONFIG, run });
	try {
		harness.setHandler((call) => (call.tool.includes("executeRead") ? okOutcome({ data: [] }) : okOutcome({ data: { id: "10" } })));
		const result = await runUpdate(harness, { action: "link_pr", ticketKey: "EXAMPLE-101" }, fakeCtx({ cwd: "/work/repo" }));
		assert.deepEqual(runCalls[0], { command: "gh", args: ["pr", "view", "--json", "url,title"], cwd: "/work/repo" });
		assert.equal((envelopeOf(result).data as { title: string }).title, "GH Title", "gh title wins over URL");

		const writesBefore = harness.calls.filter((c) => c.args.name === "createJiraIssueRemoteIssueLink").length;
		ghResult = { code: 1, stdout: "", stderr: "no PR associated" };
		const failed = await runUpdate(harness, { action: "link_pr", ticketKey: "EXAMPLE-101" });
		assert.equal(envelopeOf(failed).error?.kind, "subprocess_failed");
		const writesAfter = harness.calls.filter((c) => c.args.name === "createJiraIssueRemoteIssueLink").length;
		assert.equal(writesAfter, writesBefore, "failed gh prevents mutation");

		const invalid = await runUpdate(harness, { action: "link_pr", ticketKey: "EXAMPLE-101", url: "http://insecure.example/x" });
		assert.equal(envelopeOf(invalid).error?.kind, "invalid_input");
	} finally {
		cleanupHarness(harness);
	}
});

// ── jira_update: edit ────────────────────────────────────────────────────────

test("update edit: forwards fields unchanged, requires explicit body format, rejects ADF", async () => {
	const harness = makeHarness({ config: VALID_CONFIG });
	try {
		harness.setHandler(() => okOutcome({ data: { key: "EXAMPLE-101", fields: { summary: "S" } } }));
		const fields = { priority: { id: "2" }, labels: ["a", "b"], nested: { deep: [1, 2, { x: null }] }, summary: "New" };
		const result = await runUpdate(harness, { action: "edit", ticketKey: "EXAMPLE-101", fields });
		assert.equal(harness.calls[0].tool, "mcp__atlassian__editJiraIssue");
		assert.deepEqual(harness.calls[0].args.fields, fields, "forwarded unchanged");
		assert.equal(harness.calls[0].args.additional_fields, undefined, "never additional_fields");
		assert.equal(harness.calls[0].args.contentFormat, undefined);
		assert.ok(String((envelopeOf(result).data as { note: string }).note).includes("may not echo"));

		await runUpdate(harness, { action: "edit", ticketKey: "EXAMPLE-101", fields: { description: "b" }, contentFormat: "html" });
		assert.equal(harness.calls[1].args.contentFormat, "html");

		const nullClear = await runUpdate(harness, { action: "edit", ticketKey: "EXAMPLE-101", fields: { environment: null } });
		assert.equal(envelopeOf(nullClear).ok, true, "null clears do not require a body format");

		const noFormat = await runUpdate(harness, { action: "edit", ticketKey: "EXAMPLE-101", fields: { description: "b" } });
		assert.equal(envelopeOf(noFormat).error?.kind, "invalid_input");
		const adf = await runUpdate(harness, { action: "edit", ticketKey: "EXAMPLE-101", fields: { description: { type: "doc" } } });
		assert.equal(envelopeOf(adf).error?.kind, "invalid_input");
		const empty = await runUpdate(harness, { action: "edit", ticketKey: "EXAMPLE-101", fields: {} });
		assert.equal(envelopeOf(empty).error?.kind, "invalid_input");
		assert.equal(harness.calls.length, 3, "validation failures make no remote calls");
	} finally {
		cleanupHarness(harness);
	}
});

// ── Queue serialization, cancellation, uncertainty ──────────────────────────

test("update: same ticket serializes across actions; different tickets are independent", async () => {
	const harness = makeHarness({ config: VALID_CONFIG });
	try {
		const writeCalls: RecordedCall[] = [];
		let release: (() => void) | undefined;
		const gate = new Promise<void>((r) => (release = r));
		harness.setHandler((call) => {
			if (call.tool === "mcp__atlassian__addOrEditJiraIssueComment") {
				writeCalls.push(call);
				return gate.then(() => okOutcome({ data: { id: "1" } }));
			}
			return okOutcome(TRANSITIONS);
		});
		const first = runUpdate(harness, { action: "comment", ticketKey: "AB-1", body: "first" });
		await waitFor(() => writeCalls.length === 1, "the first write to be in flight");
		const secondSame = runUpdate(harness, { action: "comment", ticketKey: "ab-1", body: "second" });
		const other = runUpdate(harness, { action: "comment", ticketKey: "CD-2", body: "other" });
		await waitFor(() => writeCalls.length === 2, "the independent ticket's write to dispatch while the first holds A-1");
		await new Promise((r) => setTimeout(r, 20));
		assert.equal(writeCalls.length, 2, "the second same-ticket write is still queued");
		release!();
		await Promise.all([first, secondSame, other]);
		await waitFor(() => writeCalls.length === 3, "the queued same-ticket write to start after release");
		assert.equal(writeCalls[2].args.issueIdOrKey, "AB-1");
	} finally {
		cleanupHarness(harness);
	}
});

test("update: cancellation while queued prevents any remote dispatch", async () => {
	const harness = makeHarness({ config: VALID_CONFIG });
	try {
		const writeCalls: RecordedCall[] = [];
		let release: (() => void) | undefined;
		const gate = new Promise<void>((r) => (release = r));
		harness.setHandler((call) => {
			if (call.tool === "mcp__atlassian__addOrEditJiraIssueComment") {
				writeCalls.push(call);
				return gate.then(() => okOutcome({ data: { id: "1" } }));
			}
			return okOutcome(TRANSITIONS);
		});
		const first = runUpdate(harness, { action: "comment", ticketKey: "AB-1", body: "first" });
		await waitFor(() => writeCalls.length === 1, "the first write to be in flight");
		const controller = new AbortController();
		const second = runUpdate(harness, { action: "comment", ticketKey: "AB-1", body: "queued" }, fakeCtx(), controller.signal);
		await new Promise((r) => setTimeout(r, 20));
		assert.equal(writeCalls.length, 1, "the queued call has not dispatched");
		controller.abort();
		release!();
		await first;
		const secondResult = await second;
		assert.equal(envelopeOf(secondResult).error?.kind, "cancelled");
		assert.equal(writeCalls.length, 1, "the cancelled queued call made no remote calls");
	} finally {
		cleanupHarness(harness);
	}
});

test("update: post-dispatch uncertainty becomes write_outcome_unknown with read guidance", async () => {
	const harness = makeHarness({ config: VALID_CONFIG });
	try {
		harness.setHandler((call) => {
			if (call.tool.includes("executeRead")) return okOutcome({ data: [] });
			return { isError: true, result: { content: [{ type: "text", text: "Operation aborted" }] } };
		});
		const result = await runUpdate(harness, { action: "link_pr", ticketKey: "EXAMPLE-101", url: "https://example.com/new" });
		const envelope = envelopeOf(result);
		assert.equal(envelope.error?.kind, "write_outcome_unknown");
		assert.ok(String(envelope.error?.message).includes("separate read"));
	} finally {
		cleanupHarness(harness);
	}
});

test("update: a non-error CallToolResult is definitive success even with an unexpected shape", async () => {
	const harness = makeHarness({ config: VALID_CONFIG });
	try {
		harness.setHandler(() => okOutcome({ unexpected: "shape" }));
		const result = await runUpdate(harness, { action: "comment", ticketKey: "EXAMPLE-101", body: "b" });
		const envelope = envelopeOf(result);
		assert.equal(envelope.ok, true, "the server reported success; no invented re-fetch or reclassification");
		assert.deepEqual(envelope.data, { server: { unexpected: "shape" } }, "no commentId is invented when the response does not carry one");
	} finally {
		cleanupHarness(harness);
	}
});

// ── Pointer lifecycle hooks ──────────────────────────────────────────────────

function pointerEntry(details: Record<string, unknown>): BranchEntry {
	return { type: "custom_message", customType: "jira-branch-context", content: "x", display: true, details };
}

function makeHookHarness(options: { config?: unknown; branch?: string | null; gitFailure?: boolean } = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "update-jira-hooks-"));
	const configPath = path.join(dir, "update-jira.json");
	if (options.config !== undefined) fs.writeFileSync(configPath, JSON.stringify(options.config));
	let branch = options.branch ?? "feature/SLES-1";
	let gitFailure = options.gitFailure ?? false;
	const run: SubprocessRunner = async () => {
		if (gitFailure) return { code: 1, stdout: "", stderr: "git blew up" };
		return { code: 0, stdout: branch === null ? "HEAD\n" : `${branch}\n`, stderr: "" };
	};
	const hooks = createPointerHooks(
		{
			configPath,
			readConfigFile: (p) => fs.readFileSync(p, "utf8"),
			run,
			queue: new WriteQueue(),
		},
		() => {},
	);
	// The transcript mimics pi persisting emitted custom messages; getBranch
	// returns the active branch's entries.
	const transcript: BranchEntry[] = [];
	const ctx = { cwd: "/repo", sessionManager: { getBranch: () => transcript } };
	async function runBoundary(): Promise<{ message: { customType: string; content: string; display: boolean; details: Record<string, unknown> } } | undefined> {
		const result = (await hooks.beforeAgentStart({}, ctx)) as { message: { customType: string; content: string; display: boolean; details: Record<string, unknown> } } | undefined;
		if (result?.message) transcript.push(pointerEntry(result.message.details));
		return result;
	}
	function writeConfig(config: unknown): void {
		fs.writeFileSync(configPath, JSON.stringify(config));
	}
	return { hooks, dir, configPath, setBranch: (b: string | null) => (branch = b), setGitFailure: (f: boolean) => (gitFailure = f), writeConfig, runBoundary, ctx };
}

function cleanupHookHarness(harness: ReturnType<typeof makeHookHarness>): void {
	fs.rmSync(harness.dir, { recursive: true, force: true });
}

test("hooks: fresh pointer, suppression, change, clearing, and A-B-A", async () => {
	const harness = makeHookHarness({ config: VALID_CONFIG });
	try {
		const first = await harness.runBoundary();
		assert.ok(first?.message);
		assert.equal(first.message.customType, "jira-branch-context");
		assert.equal(first.message.display, true);
		assert.ok(first.message.content.includes("SLES-1"));
		assert.ok(first.message.content.includes("jira_read"));
		assert.equal((await harness.runBoundary()), undefined, "unchanged state suppressed");

		harness.setBranch("feature/SLES-2");
		const second = await harness.runBoundary();
		assert.ok(second?.message && second.message.content.includes("SLES-2"), "branch change emits a new pointer");

		harness.setBranch("feature/SLES-1");
		const third = await harness.runBoundary();
		assert.ok(third?.message && third.message.content.includes("SLES-1"), "A-B-A emits on the return");
	} finally {
		cleanupHookHarness(harness);
	}
});

test("hooks: initial unresolved is silent; a stale pointer is cleared on change", async () => {
	const harness = makeHookHarness({ config: VALID_CONFIG, branch: "no-key" });
	try {
		assert.equal(await harness.runBoundary(), undefined, "initial unresolved emits nothing");

		harness.setBranch("feature/SLES-1");
		const pointer = await harness.runBoundary();
		assert.ok(pointer?.message);

		harness.setBranch("other-no-key");
		const correction = await harness.runBoundary();
		assert.ok(correction?.message);
		assert.ok(correction.message.content.includes("no resolved default ticket"));
		assert.equal(await harness.runBoundary(), undefined, "unchanged unresolved correction suppressed");
	} finally {
		cleanupHookHarness(harness);
	}
});

test("hooks: config failure clears a pointer once; recovery re-emits", async () => {
	const harness = makeHookHarness({ config: VALID_CONFIG });
	try {
		const pointer = await harness.runBoundary();
		assert.ok(pointer?.message);
		fs.writeFileSync(harness.configPath, "{ invalid");
		const correction = await harness.runBoundary();
		assert.ok(correction?.message);
		assert.ok(correction.message.content.includes("configuration is invalid"));
		assert.equal(await harness.runBoundary(), undefined, "unchanged invalid config suppressed");
		harness.writeConfig(VALID_CONFIG);
		const recovered = await harness.runBoundary();
		assert.ok(recovered?.message && recovered.message.content.includes("SLES-1"), "valid config allows a fresh pointer");
	} finally {
		cleanupHookHarness(harness);
	}
});

test("hooks: session_start and session_tree reconstruct state from the active branch", async () => {
	const harness = makeHookHarness({ config: VALID_CONFIG });
	try {
		// Simulate a restored transcript that already contains a pointer.
		const restoredEntry = pointerEntry({
			emitted: "pointer",
			site: "https://example.atlassian.net/",
			cwd: "/repo",
			branch: "feature/SLES-1",
			outcome: { status: "resolved", key: "SLES-1" },
		});
		const restoredCtx = { cwd: "/repo", sessionManager: { getBranch: () => [restoredEntry] as BranchEntry[] } };
		await harness.hooks.onSessionStart({}, restoredCtx);
		assert.equal(await harness.hooks.beforeAgentStart({}, restoredCtx), undefined, "restored identical pointer not re-emitted");

		// Resume into an unresolved branch: the restored pointer must be cleared.
		harness.setBranch("no-key");
		const unresolvedCtx = { cwd: "/repo", sessionManager: { getBranch: () => [restoredEntry] as BranchEntry[] } };
		const correction = (await harness.hooks.beforeAgentStart({}, unresolvedCtx)) as { message: { content: string } } | undefined;
		assert.ok(correction?.message && correction.message.content.includes("no resolved default ticket"));

		// session_tree resets suppression from an abandoned branch: an empty
		// restored transcript means the next boundary re-emits the pointer.
		harness.setBranch("feature/SLES-1");
		const emptyCtx = { cwd: "/repo", sessionManager: { getBranch: () => [] as BranchEntry[] } };
		await harness.hooks.onSessionTree({}, emptyCtx);
		const reEmitted = (await harness.hooks.beforeAgentStart({}, emptyCtx)) as { message: { content: string } } | undefined;
		assert.ok(reEmitted?.message && reEmitted.message.content.includes("SLES-1"));
	} finally {
		cleanupHookHarness(harness);
	}
});

test("hooks: git failure and detached HEAD produce unresolved corrections after a pointer", async () => {
	for (const mode of ["failure", "detached"] as const) {
		const harness = makeHookHarness({ config: VALID_CONFIG });
		try {
			const pointer = await harness.runBoundary();
			assert.ok(pointer?.message, `expected a pointer in ${mode} mode`);
			if (mode === "failure") harness.setGitFailure(true);
			else harness.setBranch(null);
			const correction = await harness.runBoundary();
			assert.ok(correction?.message);
			const reason = (correction.message.details as { outcome: { reason: string } }).outcome.reason;
			assert.equal(reason, mode === "failure" ? "subprocess_failed" : "no_ticket");
		} finally {
			cleanupHookHarness(harness);
		}
	}
});

test("hooks: zero MCP transport usage", async () => {
	const { hooks, dir } = makeHookHarness({ config: VALID_CONFIG, branch: "feature/SLES-1" });
	try {
		let executeToolCalls = 0;
		const ctx = {
			cwd: "/repo",
			sessionManager: { getBranch: () => [] as BranchEntry[] },
			executeTool: () => {
				executeToolCalls++;
				throw new Error("hooks must not call tools");
			},
		};
		await hooks.beforeAgentStart({}, ctx);
		await hooks.onSessionStart({}, ctx);
		await hooks.onSessionTree({}, ctx);
		assert.equal(executeToolCalls, 0);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
