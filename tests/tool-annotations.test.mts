// Registration metadata tests: invoke the actual web, session-search, and
// slack-via-claude extension factories with a minimal fake pi API and inspect
// the captured tool definitions. No network, no subprocesses, no worker code,
// and no session searches over the real sessions directory: filesystem-touching
// cases point PI_CODING_AGENT_DIR and SESSION_SEARCH_INDEX_FILE at fixtures.
//
// The settled static capability table (author-declared, unverified hints;
// read-only describes the tool's intended operations, not that no local
// cache, index, or log file is ever written):
//   web_fetch, web_search                    read-only, open-world
//   session_search, session_excerpt           read-only, closed domain
//   slack_search / slack_read_channel /
//     slack_read_thread                      read-only, open-world
//   guard-owned python, node                 write-capable, open-world
//   (covered in tests/guard-harness.test.mts)
//
// Run: node --test tests/tool-annotations.test.mts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import webExtension from "../extensions/web/index.ts";
import sessionSearchExtension from "../extensions/session-search/index.ts";
import slackViaClaudeExtension from "../extensions/slack-via-claude.ts";

interface CapturedTool {
	name: string;
	description?: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	annotations?: {
		readOnlyHint?: boolean;
		destructiveHint?: boolean;
		idempotentHint?: boolean;
		openWorldHint?: boolean;
	};
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	execute?: (...args: any[]) => any;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	[key: string]: any;
}

function makePi() {
	const tools: CapturedTool[] = [];
	const commands: string[] = [];
	const handlers = new Map<string, (args: string, ctx: never) => Promise<void>>();
	const sent: Array<{ message: unknown; options: unknown }> = [];
	const pi = {
		registerTool(tool: CapturedTool) {
			tools.push(tool);
		},
		registerCommand(name: string, definition: { handler: (args: string, ctx: never) => Promise<void> }) {
			commands.push(name);
			handlers.set(name, definition.handler);
		},
		sendMessage(message: unknown, options: unknown) {
			sent.push({ message, options });
		},
	};
	return { pi, tools, commands, handlers, sent };
}

const READ_ONLY_OPEN_WORLD = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const READ_ONLY_CLOSED = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

test("web extension declares read-only open-world metadata on both tools", () => {
	const { pi, tools } = makePi();
	webExtension(pi as never);
	assert.deepEqual(
		tools.map((t) => t.name).sort(),
		["web_fetch", "web_search"],
		"the factory must register exactly the two web tools",
	);
	for (const tool of tools) {
		assert.deepEqual(tool.annotations, READ_ONLY_OPEN_WORLD, tool.name);
	}
});

test("session-search declares read-only closed-domain metadata on both tools", () => {
	const { pi, tools, commands } = makePi();
	sessionSearchExtension(pi as never);
	assert.deepEqual(tools.map((t) => t.name), ["session_search", "session_excerpt"]);
	for (const tool of tools) {
		assert.deepEqual(tool.annotations, READ_ONLY_CLOSED, tool.name);
	}
	assert.ok(commands.includes("session-search"), "the /session-search command registration is preserved");
});

test("session-search guidance points at session_excerpt instead of a raw file read", () => {
	const { pi, tools } = makePi();
	sessionSearchExtension(pi as never);
	const search = tools.find((t) => t.name === "session_search")!;
	const excerpt = tools.find((t) => t.name === "session_excerpt")!;
	const searchText = `${search.description}\n${(search.promptGuidelines ?? []).join("\n")}`;
	// The old advice ("read the session file at its `path`") defeated itself:
	// session files open with a ~90KB system message against read's 50KB cap.
	assert.ok(!/read the session file at/.test(searchText), searchText);
	assert.ok(searchText.includes("session_excerpt"), "session_search names the excerpt tool");
	// Exactly one last-resort raw-read sentence per tool surface.
	for (const tool of [search, excerpt]) {
		const text = `${tool.description}\n${(tool.promptGuidelines ?? []).join("\n")}`;
		assert.equal((text.match(/offset past its header lines/g) ?? []).length, 1, tool.name);
	}
	assert.ok(excerpt.promptSnippet, "session_excerpt declares a prompt snippet");
	assert.ok(excerpt.outputSchema, "session_excerpt declares an output schema");
	// Contract: one required path, one optional query, and no tuning knobs.
	const params = excerpt.parameters as { type: string; properties: Record<string, unknown>; required?: string[] };
	assert.equal(params.type, "object");
	assert.deepEqual(Object.keys(params.properties).sort(), ["path", "query"]);
	assert.deepEqual(params.required, ["path"]);
});

test("session_excerpt executes against a fixture session and returns the envelope", async () => {
	const { pi, tools } = makePi();
	sessionSearchExtension(pi as never);
	const excerpt = tools.find((t) => t.name === "session_excerpt")!;

	const tmp = mkdtempSync(join(tmpdir(), "tool-annotations-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		// The tool reads the real sessions root, so point that root at the fixture.
		const agentDir = join(tmp, "agent");
		const proj = join(agentDir, "sessions", "--proj--");
		mkdirSync(proj, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const file = join(proj, "2026-10-28T00-00-00-000Z_ex.jsonl");
		writeFileSync(
			file,
			[
				JSON.stringify({ type: "session", version: 3, id: "sess-1", timestamp: "2026-10-28T00:00:00.000Z", cwd: "/proj" }),
				JSON.stringify({ type: "message", id: "m1", timestamp: "2026-10-28T00:01:00.000Z", message: { role: "user", content: "needle in the transcript" } }),
			].join("\n"),
		);

		const ctx = { sessionManager: { getSessionFile: () => file } };
		const result = await excerpt.execute("call-1", { path: file, query: "needle" }, undefined, undefined, ctx);
		assert.equal(result.isError, false);
		assert.equal(result.structuredContent.ok, true);
		assert.equal(result.structuredContent.sessionId, "sess-1");
		assert.equal(result.structuredContent.selfSession, true);
		assert.deepEqual(result.structuredContent.anchored, { ts: "2026-10-28T00:01:00.000Z" });
		assert.equal(result.details.result, result.structuredContent, "details and structuredContent are one envelope");
		assert.match(result.content[0].text, /needle in the transcript/);

		const failed = await excerpt.execute("call-2", { path: join(tmp, "elsewhere.jsonl") }, undefined, undefined, ctx);
		assert.equal(failed.isError, true);
		assert.equal(failed.structuredContent.ok, false);
		assert.equal(failed.structuredContent.error.kind, "outside_sessions");
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("the /session-search load-context action reuses the shared excerpt flow", async () => {
	const { pi, tools, handlers, sent } = makePi();
	sessionSearchExtension(pi as never);
	const handler = handlers.get("session-search")!;

	const tmp = mkdtempSync(join(tmpdir(), "tool-annotations-cmd-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousIndex = process.env.SESSION_SEARCH_INDEX_FILE;
	try {
		// Point the extension at a fixture session tree and a throwaway index.
		const agentDir = join(tmp, "agent");
		const proj = join(agentDir, "sessions", "--proj--");
		mkdirSync(proj, { recursive: true });
		const file = join(proj, "2026-10-28T00-00-00-000Z_ex.jsonl");
		writeFileSync(
			file,
			[
				JSON.stringify({ type: "session", version: 3, id: "sess-1", timestamp: "2026-10-28T00:00:00.000Z", cwd: "/proj" }),
				JSON.stringify({ type: "message", id: "m1", timestamp: "2026-10-28T00:01:00.000Z", message: { role: "user", content: "needle in the transcript" } }),
			].join("\n"),
		);
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.SESSION_SEARCH_INDEX_FILE = join(tmp, "index.jsonl");

		const selectCalls: string[][] = [];
		const ctx = {
			hasUI: true,
			signal: undefined,
			sessionManager: { getSessionFile: () => undefined },
			ui: {
				notify: () => {},
				select: async (_title: string, options: string[]) => {
					selectCalls.push(options);
					return selectCalls.length === 1 ? options[0] : "Load context into session";
				},
			},
		};
		await handler("needle", ctx as never);

		assert.equal(sent.length, 1, "one context message was injected");
		const message = sent[0].message as { customType: string; content: string; display: boolean; details: { anchored: unknown } };
		assert.equal(message.customType, "session-search-context");
		assert.equal(message.display, true);
		assert.match(message.content, /loaded by \/session-search/);
		assert.match(message.content, /needle in the transcript/);
		assert.deepEqual(message.details.anchored, { ts: "2026-10-28T00:01:00.000Z" });
		assert.deepEqual(sent[0].options, { triggerTurn: true });
		// No new menu action: the second picker is the settled four.
		assert.deepEqual(selectCalls[1], ["Resume session", "Load context into session", "Copy path", "Back to list"]);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousIndex === undefined) delete process.env.SESSION_SEARCH_INDEX_FILE;
		else process.env.SESSION_SEARCH_INDEX_FILE = previousIndex;
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("slack-via-claude declares read-only open-world metadata on all three tools", () => {
	const { pi, tools } = makePi();
	slackViaClaudeExtension(pi as never);
	assert.deepEqual(
		tools.map((t) => t.name).sort(),
		["slack_read_channel", "slack_read_thread", "slack_search"],
	);
	for (const tool of tools) {
		assert.deepEqual(tool.annotations, READ_ONLY_OPEN_WORLD, tool.name);
	}
});

test("metadata is adequate for guard's planning eligibility rules", () => {
	// Mirror the settled planning rule (extensions/guard/policy/classes.ts) so a
	// regression in either side is caught here too.
	const allowed = (a: CapturedTool["annotations"]) => a?.readOnlyHint === true && a?.destructiveHint !== true;
	for (const annotations of [READ_ONLY_OPEN_WORLD, READ_ONLY_CLOSED]) {
		assert.equal(allowed(annotations), true);
	}
	// Guard's python/node metadata (asserted in guard-harness) must NOT qualify:
	// write-capable workers stay out of planning via their declared hints.
	assert.equal(
		allowed({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }),
		false,
	);
});
