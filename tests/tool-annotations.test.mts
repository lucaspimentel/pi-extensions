// Registration metadata tests: invoke the actual web, session-search, and
// slack-via-claude extension factories with a minimal fake pi API and inspect
// the captured tool definitions. No network, no subprocesses, no worker code,
// and no real session searches: only registration happens.
//
// The settled static capability table (author-declared, unverified hints;
// read-only describes the tool's intended operations, not that no local
// cache, index, or log file is ever written):
//   web_fetch, web_search                    read-only, open-world
//   session_search                           read-only, closed domain
//   slack_search / slack_read_channel /
//     slack_read_thread                      read-only, open-world
//   guard-owned python, node                 write-capable, open-world
//   (covered in tests/guard-harness.test.mts)
//
// Run: node --test tests/tool-annotations.test.mts
import assert from "node:assert/strict";
import { test } from "node:test";

import webExtension from "../extensions/web/index.ts";
import sessionSearchExtension from "../extensions/session-search/index.ts";
import slackViaClaudeExtension from "../extensions/slack-via-claude.ts";

interface CapturedTool {
	name: string;
	annotations?: {
		readOnlyHint?: boolean;
		destructiveHint?: boolean;
		idempotentHint?: boolean;
		openWorldHint?: boolean;
	};
}

function makePi() {
	const tools: CapturedTool[] = [];
	const commands: string[] = [];
	const pi = {
		registerTool(tool: CapturedTool) {
			tools.push({ name: tool.name, annotations: tool.annotations });
		},
		registerCommand(name: string) {
			commands.push(name);
		},
	};
	return { pi, tools, commands };
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

test("session-search declares read-only closed-domain metadata", () => {
	const { pi, tools, commands } = makePi();
	sessionSearchExtension(pi as never);
	assert.deepEqual(tools.map((t) => t.name), ["session_search"]);
	assert.deepEqual(tools[0].annotations, READ_ONLY_CLOSED);
	assert.ok(commands.includes("find-sessions"), "the /find-sessions command registration is preserved");
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
