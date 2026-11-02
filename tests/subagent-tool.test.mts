// Registered-tool tests for the subagent extension (extensions/subagent/index.ts):
// agent discovery surfaced to the model (the per-request `subagent` description)
// and the no-spawn `subagent_list` tool.
//
// Fully hermetic: the fake pi API, the discovery isolation, and the spawn modes
// all come from ./subagent-harness.mts, which installs a throwing spawn override
// at import so any accidental child dispatch fails the test loudly. The
// recording mode there is what future panel tests use to assert child argv.
//
// Run: node --test tests/subagent-tool.test.mts
import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";

import { setAgentListCwd } from "../extensions/subagent/index.ts";
import {
	cleanupHarness,
	makeHarness,
	runList,
	runSubagent,
	spawnCount,
	toolCtx,
	withIsolatedAgents,
	writeAgent,
} from "./subagent-harness.mts";

const BUNDLED = ["planner", "researcher", "reviewer", "scout", "worker"];
const BASE_OPENING = "Delegate tasks to specialized subagents with isolated context.";

function assertSortedAppearance(text: string, names: string[]): void {
	let last = -1;
	for (const name of names) {
		const idx = text.indexOf(name);
		assert.ok(idx > last, `${name} must appear after the previous name in sorted order`);
		last = idx;
	}
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test("both tools are registered with the intended declarations", () => {
	const h = makeHarness();
	const subagent = h.tools.get("subagent");
	const list = h.tools.get("subagent_list");
	assert.ok(subagent, "subagent registered");
	assert.ok(list, "subagent_list registered");
	assert.equal(list.outputSchema === undefined, false, "subagent_list declares an outputSchema");
	// The spawn tool must not declare outputSchema: codemode would then resolve
	// nested single/parallel/chain calls to structuredContent (which they never
	// return), changing their return contract.
	assert.equal("outputSchema" in subagent, false, "subagent declares no outputSchema");
	assert.equal(list.annotations?.readOnlyHint, true, "subagent_list is read-only");
	assert.equal(typeof list.prepareLoadout, "undefined", "subagent_list rewrites no loadout");
});

test("subagent_list lists the bundled agents sorted, with schema-shaped structuredContent", async () => {
	await withIsolatedAgents(
		async (cwd) => {
			const h = makeHarness();
			const result = await runList(h, cwd);
			const text = result.content.map((c) => c.text).join("\n");
			assertSortedAppearance(text, BUNDLED);
			for (const name of BUNDLED) assert.ok(text.includes(name), `text lists ${name}`);

			const sc = result.structuredContent;
			assert.ok(sc, "structuredContent present");
			assert.equal(sc.agentScope, "user");
			assert.equal(sc.projectAgentsDir, null, "no project agents dir");
			assert.equal(sc.agents.length, BUNDLED.length, "all bundled agents");
			for (const agent of sc.agents) {
				assert.equal(typeof agent.name, "string");
				assert.equal(agent.source, "bundled");
				assert.equal(typeof agent.description, "string");
				assert.ok(agent.model === null || typeof agent.model === "string");
				assert.ok(Array.isArray(agent.tools));
			}
			assert.equal(spawnCount, 0, "no spawn");
			assert.equal(h.emitted.includes("guard:subagent-snapshot-request"), false, "no guard snapshot request");
		},
		{ project: false },
	);
});

test("user agents override bundled agents by name and are reported as user", async () => {
	await withIsolatedAgents(
		async (cwd, agentDir) => {
			const agentsDir = path.join(agentDir, "agents");
			writeAgent(agentsDir, "userbot", "A user-provided agent.");
			writeAgent(agentsDir, "scout", "A user override of scout.");
			const h = makeHarness();
			const result = await runList(h, cwd);
			const sc = result.structuredContent;
			assert.ok(sc, "structuredContent present");
			const userbot = sc.agents.find((a) => a.name === "userbot");
			assert.ok(userbot, "userbot discovered");
			assert.equal(userbot.source, "user");
			const scouts = sc.agents.filter((a) => a.name === "scout");
			assert.equal(scouts.length, 1, "exactly one scout");
			assert.equal(scouts[0].source, "user", "user scout overrides the bundled one");
		},
		{ project: false },
	);
});

test("project agents appear only when the scope includes them", async () => {
	await withIsolatedAgents(async (cwd) => {
		writeAgent(path.join(cwd, ".pi", "agents"), "localbot", "A project-local agent.");
		const h = makeHarness();

		const userResult = await runList(h, cwd, { agentScope: "user" });
		assert.ok(userResult.structuredContent, "structuredContent present");
		assert.equal(
			userResult.structuredContent.agents.some((a) => a.name === "localbot"),
			false,
			"user scope omits project agents",
		);

		const bothResult = await runList(h, cwd, { agentScope: "both" });
		assert.ok(bothResult.structuredContent, "structuredContent present");
		assert.notEqual(bothResult.structuredContent.projectAgentsDir, null, "project dir resolved");
		const localbot = bothResult.structuredContent.agents.find((a) => a.name === "localbot");
		assert.ok(localbot, "both scope includes the project agent");
		assert.equal(localbot.source, "project");
	});
});

test("the subagent description is rewritten per request and is byte-stable", async () => {
	await withIsolatedAgents(async (cwd) => {
		writeAgent(path.join(cwd, ".pi", "agents"), "localbot", "A project-local agent.");
		const h = makeHarness();
		const subagent = h.tools.get("subagent");
		assert.ok(subagent?.prepareLoadout, "subagent declares prepareLoadout");

		for (const handler of h.handlers["session_start"] ?? []) await handler({ reason: "startup" }, toolCtx(cwd));

		const first = subagent.prepareLoadout({});
		assert.ok(first, "prepareLoadout returns changes");
		const description = first.descriptions?.subagent;
		assert.ok(description, "rewrites the subagent description");
		assert.ok(description.includes(BASE_OPENING), "keeps the static base text");
		for (const name of BUNDLED) assert.ok(description.includes(name), `lists ${name}`);
		assert.ok(
			description.includes('agentScope: "both" to subagent or subagent_list'),
			"adds the project agents notice",
		);
		assert.equal(description.includes("localbot"), false, "does not name project agents");

		const second = subagent.prepareLoadout({});
		assert.equal(second?.descriptions?.subagent, description, "byte-identical across calls");
	});
});

test("prepareLoadout fails open without a cwd and with no project agents dir", async () => {
	const h = makeHarness();
	const subagent = h.tools.get("subagent");
	assert.ok(subagent?.prepareLoadout, "subagent declares prepareLoadout");

	setAgentListCwd(null);
	assert.equal(subagent.prepareLoadout({}), undefined, "no cwd -> undefined, no throw");

	await withIsolatedAgents(
		(cwd) => {
			setAgentListCwd(cwd);
			const changes = subagent.prepareLoadout({});
			assert.ok(changes?.descriptions?.subagent, "still describes agents without a project dir");
		},
		{ project: false },
	);
	setAgentListCwd(null);
});

test("an unknown agent reports the available agents without spawning", async () => {
	await withIsolatedAgents(
		async (cwd) => {
			const h = makeHarness();
			const result = await runSubagent(h, cwd, { agent: "nope", task: "x" });
			const text = result.content.map((c) => c.text).join("\n");
			assert.ok(text.includes("Available agents:"), "reports available agents");
			for (const name of BUNDLED) assert.ok(text.includes(name), `lists ${name}`);
			assert.equal(spawnCount, 0, "no spawn");
		},
		{ project: false },
	);
});

test("invalid parameters report the available agents without spawning", async () => {
	await withIsolatedAgents(
		async (cwd) => {
			const h = makeHarness();
			const result = await runSubagent(h, cwd, {});
			const text = result.content.map((c) => c.text).join("\n");
			assert.ok(text.includes("Invalid parameters. Provide exactly one mode."), "invalid-parameters text");
			for (const name of BUNDLED) assert.ok(text.includes(name), `lists ${name}`);
			assert.equal(spawnCount, 0, "no spawn");
		},
		{ project: false },
	);
});

// ── Cleanup ───────────────────────────────────────────────────────────────────

test("cleanup", () => {
	cleanupHarness();
});
