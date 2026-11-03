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
import * as fs from "node:fs";
import { test } from "node:test";

import { setAgentListCwd } from "../extensions/subagent/index.ts";
import {
	cleanupHarness,
	installRecordingSpawn,
	makeHarness,
	runList,
	runSubagent,
	spawnCount,
	toolCtx,
	withIsolatedAgents,
	writeAgent,
} from "./subagent-harness.mts";

const BUNDLED = ["judge", "panelist", "planner", "researcher", "reviewer", "scout", "worker"];
const DISPATCHABLE = BUNDLED.filter((name) => name !== "judge");
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
		for (const name of DISPATCHABLE) assert.ok(description.includes(name), `lists ${name}`);
		assert.equal(description.includes("judge"), false, "internal judge excluded");
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
			for (const name of DISPATCHABLE) assert.ok(text.includes(name), `lists ${name}`);
			assert.equal(text.includes("judge"), false, "internal judge excluded");
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
			for (const name of DISPATCHABLE) assert.ok(text.includes(name), `lists ${name}`);
			assert.equal(text.includes("judge"), false, "internal judge excluded");
			assert.equal(spawnCount, 0, "no spawn");
		},
		{ project: false },
	);
});

function configure(agentDir: string, value: unknown): void {
	fs.writeFileSync(path.join(agentDir, "subagent.json"), JSON.stringify(value));
}

function declaredAgent(dir: string, name: string, tools?: string, extra = ""): void {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, `${name}.md`), `---\nname: ${name}\ndescription: Test ${name}\n${tools === undefined ? "" : `tools: ${tools}\n`}${extra}---\nTest prompt.\n`);
}

const scopedModels = ["p/a", "p/org/b", "p/judge"].map((id) => ({ model: { provider: "p", id: id.slice(2) } }));

test("panel and per-child schemas, listing arrays, and panel guideline are declared", () => {
	const h = makeHarness();
	const subagent = h.tools.get("subagent")!;
	const schema = subagent.parameters as any;
	for (const key of ["panel", "models", "judge", "model"]) assert.ok(schema.properties[key], key);
	for (const key of ["tasks", "chain"]) assert.ok(schema.properties[key].items.properties.model, key);
	assert.ok(schema.properties.judge.anyOf.some((s: any) => s.type === "null"));
	assert.equal("outputSchema" in subagent, false);
	assert.ok(subagent.promptGuidelines?.some((s) => s.includes("panel") && s.includes("tasks[]") && s.includes("model")));
	const output = h.tools.get("subagent_list")!.outputSchema as any;
	for (const key of ["panels", "ignoredPanels"]) assert.ok(output.required.includes(key));
	assert.deepEqual(output.properties.agents.items.properties.role.enum, ["delegate", "internal"]);
});

test("mode, model, and agent preflight errors are actionable and spawn nothing with a working guard", async () => {
	await withIsolatedAgents(async (cwd, agentDir) => {
		configure(agentDir, { panels: { pair: { models: ["p/a", "p/org/b"] }, internal: { models: ["p/a"], agent: "judge" } } });
		const h = makeHarness({ guard: true, tools: ["read"] });
		const recording = installRecordingSpawn();
		try {
			const cases: Array<[Record<string, unknown>, RegExp, string]> = [
				[{}, /Invalid parameters\. Provide exactly one mode/, "single"],
				[{ panel: "pair" }, /panel requires task/, "panel"],
				[{ panel: "pair", task: "x", tasks: [{ agent: "scout", task: "x" }] }, /panel.*tasks\/chain/, "panel"],
				[{ panel: "pair", task: "x", chain: [{ agent: "scout", task: "x" }] }, /panel.*tasks\/chain/, "panel"],
				[{ agent: "scout", task: "x", tasks: [{ agent: "scout", task: "x" }] }, /exactly one mode/, "parallel"],
				[{ tasks: [{ agent: "scout", task: "x" }], chain: [{ agent: "scout", task: "x" }] }, /exactly one mode/, "chain"],
				[{ agent: "scout", task: "x", models: ["p/a"], judge: null }, /models, judge require panel/, "single"],
				[{ agent: "scout", task: "x", judge: "none" }, /judge require panel/, "single"],
				[{ panel: "pair", task: "x", model: "p/a" }, /use models for panel/, "panel"],
				[{ panel: "missing", task: "x" }, /Unknown panel.*Configured presets: internal, pair/, "panel"],
				[{ panel: "pair", task: "x", models: [] }, /models.*1 to 4/, "panel"],
				[{ panel: "pair", task: "x", models: [" "] }, /models.*nonblank/, "panel"],
				[{ panel: "pair", task: "x", models: ["p/a", "p/a", "p/a", "p/a", "p/a"] }, /models.*1 to 4/, "panel"],
				[{ panel: "pair", task: "x", models: ["p/unknown"] }, /models\[0\].*Usable models: p\/a, p\/judge, p\/org\/b/, "panel"],
				[{ panel: "pair", task: "x", judge: "p/unknown" }, /judge.*Usable models:/, "panel"],
				[{ panel: "pair", task: "x", agent: "missing" }, /Unknown agent: "missing" in panel.agent/, "panel"],
				[{ panel: "internal", task: "x" }, /"judge".*internal.*subagent\(\{panel, task\}\)/, "panel"],
				[{ agent: "judge", task: "x" }, /"judge".*internal.*subagent\(\{panel, task\}\)/, "single"],
				[{ tasks: [{ agent: "scout", task: "x" }, { agent: "judge", task: "x" }] }, /tasks\[1\].agent.*internal/, "parallel"],
				[{ chain: [{ agent: "scout", task: "x" }, { agent: "judge", task: "x" }] }, /chain\[1\].agent.*internal/, "chain"],
				[{ tasks: [{ agent: "scout", task: "x" }, { agent: "missing", task: "x" }] }, /"missing" in tasks\[1\].agent/, "parallel"],
				[{ chain: [{ agent: "scout", task: "x" }, { agent: "missing", task: "x" }] }, /"missing" in chain\[1\].agent/, "chain"],
				[{ agent: "scout", task: "x", model: "p/unknown" }, /single.model.*Usable models:/, "single"],
				[{ tasks: [{ agent: "scout", task: "x" }, { agent: "scout", task: "x", model: "p/unknown" }] }, /tasks\[1\].model.*Usable models:/, "parallel"],
				[{ chain: [{ agent: "scout", task: "x" }, { agent: "scout", task: "x", model: "p/unknown" }] }, /chain\[1\].model.*Usable models:/, "chain"],
				[{ agent: "scout", task: "x", model: " " }, /single.model.*nonblank/, "single"],
			];
			for (const [params, expected, mode] of cases) {
				const result = await runSubagent(h, cwd, params, { scopedModels });
				assert.equal(result.isError, true, JSON.stringify(params));
				assert.match(result.content[0].text, expected);
				assert.match(result.content[0].text, /Available agents:.*panelist.*scout/);
				assert.equal(result.details?.mode, mode);
				assert.deepEqual(result.details?.results, []);
				assert.equal(recording.spawns.length, 0);
			}
			assert.equal(h.emitted.length, 0, "validation precedes guard snapshots");
		} finally { recording.restore(); }
	});
});

test("panelist declarations refuse write, edit, bash, and implicit default tools before confirmation", async () => {
	await withIsolatedAgents(async (cwd, agentDir) => {
		configure(agentDir, { panels: { pair: { models: ["p/a"] } } });
		const h = makeHarness({ guard: true, tools: ["read", "write", "edit", "bash"] });
		const recording = installRecordingSpawn();
		try {
			for (const tools of ["read, write", "read, edit", "read, bash", "write, edit, bash", undefined, "[]"]) {
				declaredAgent(path.join(cwd, ".pi", "agents"), "unsafe", tools);
				const result = await runSubagent(h, cwd, { panel: "pair", task: "x", agent: "unsafe", agentScope: "both" }, {
					hasUI: true, isProjectTrusted: () => false, ui: { confirm: async () => { assert.fail("must validate before confirmation"); } },
				});
				assert.equal(result.isError, true);
				assert.match(result.content[0].text, /Agent "unsafe" panel tools/);
				for (const tool of tools && tools !== "[]" ? tools.split(", ").filter((t) => t !== "read") : ["write", "edit", "bash"]) assert.ok(result.content[0].text.includes(tool));
				assert.equal(recording.spawns.length, 0);
			}
		} finally { recording.restore(); }
	});
});

function flag(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	return index < 0 ? undefined : args[index + 1];
}

test("panel spawns exactly N read-only children with effective models, thinking, cwd, guard, and full results", async () => {
	await withIsolatedAgents(async (cwd, agentDir) => {
		configure(agentDir, { models: { judge: "p/judge" }, panels: { pair: { models: ["p/a", "p/org/b"] } } });
		declaredAgent(path.join(agentDir, "agents"), "panelist", "read, ffgrep, fffind, subagent", "model: legacy/pin\n");
		const h = makeHarness({ guard: true, tools: ["read", "grep", "find", "subagent"], settings: { modelThinkingLevels: { "p/a": "low" } } });
		const longOutput = "A".repeat(60 * 1024);
		const recording = installRecordingSpawn((spawn) => {
			spawn.child.stdout.emit("data", JSON.stringify({ type: "message_end", message: {
				role: "assistant", content: [{ type: "text", text: flag(spawn.args, "--model") === "p/a" ? longOutput : "second" }], stopReason: "stop",
				usage: { input: 12, output: 34, totalTokens: 46, cost: { total: 0.001 } },
			} }) + "\n");
		});
		try {
			const task = "Exact task\n  keep spacing";
			const result = await runSubagent(h, cwd, { panel: "pair", task, cwd: agentDir }, {
				scopedModels, model: { provider: "p", id: "session" }, thinkingLevel: "high",
			});
			assert.equal(result.isError, false);
			assert.equal(recording.spawns.length, 2, "never spawn the configured judge");
			assert.deepEqual(recording.spawns.map((s) => flag(s.args, "--model")).sort(), ["p/a", "p/org/b"]);
			for (const spawn of recording.spawns) {
				assert.equal(flag(spawn.args, "--thinking"), flag(spawn.args, "--model") === "p/a" ? "low" : "high");
				assert.equal(flag(spawn.args, "--tools"), "read,grep,find");
				assert.equal(spawn.args.includes("--no-tools"), false);
				assert.equal(spawn.options.cwd, agentDir);
				assert.ok(spawn.args.includes(`Task: ${task}`));
				assert.ok(flag(spawn.args, "--extension")?.endsWith("guard-bootstrap.ts"));
				assert.ok(spawn.options.env?.PI_GUARD_INHERIT);
			}
			assert.equal(h.emitted.filter((c) => c === "guard:subagent-snapshot-request").length, 2);
			assert.notEqual(recording.spawns[0].options.env?.PI_GUARD_INHERIT, recording.spawns[1].options.env?.PI_GUARD_INHERIT, "fresh inheritance nonce");
			assert.equal(result.details?.mode, "panel");
			assert.deepEqual(result.details?.panel, { name: "pair", agent: "panelist", models: ["p/a", "p/org/b"], judge: { agent: "judge", model: "p/judge" } });
			const results = result.details?.results as any[];
			assert.equal(results.length, 2);
			assert.equal(results[0].messages[0].content[0].text, longOutput);
			assert.equal(results[0].usage.input, 12);
			assert.equal(results[0].model, "p/a");
			const text = result.content[0].text;
			assert.match(text, /Panel pair\nMerge skipped because the merge step is not implemented in this stage/);
			assert.match(text, /\[p\/a\] completed/);
			assert.match(text, /\[p\/org\/b\] completed/);
			assert.equal(text.split("Usage:").length - 1, 2);
			assert.ok(text.includes("↑12 ↓34") && text.includes(longOutput));
		} finally { recording.restore(); }
	});
});

test("inline panel overrides normalize without mutating raw config and zero resolved tools use --no-tools", async () => {
	await withIsolatedAgents(async (cwd, agentDir) => {
		const config = { panels: { pair: { agent: "panelist", models: ["p/a"], judge: "p/judge" } } };
		configure(agentDir, config);
		declaredAgent(path.join(agentDir, "agents"), "empty", "unavailable, subagent");
		const h = makeHarness({ guard: true, tools: ["subagent"] });
		const recording = installRecordingSpawn();
		try {
			for (const judge of [null, "none"]) {
				const result = await runSubagent(h, cwd, { panel: "pair", task: "x", agent: "empty", models: [" custom/org/id ", "custom/org/id", "any/id"], judge });
				assert.equal(result.isError, false, "empty scope accepts any model ID");
				assert.deepEqual(result.details?.panel, { name: "pair", agent: "empty", models: ["custom/org/id", "any/id"], judge: null });
			}
			assert.equal(recording.spawns.length, 4);
			for (const spawn of recording.spawns) {
				assert.ok(spawn.args.includes("--no-tools"));
				assert.equal(spawn.args.includes("--tools"), false);
			}
			assert.deepEqual(JSON.parse(fs.readFileSync(path.join(agentDir, "subagent.json"), "utf8")), config);
			assert.deepEqual((await runList(h, cwd)).structuredContent?.panels, [{ name: "pair", ...config.panels.pair }]);
		} finally { recording.restore(); }
	});
});

test("judge metadata precedence is inline, preset, discovered pin, session and scoped validation includes the judge", async () => {
	await withIsolatedAgents(async (cwd, agentDir) => {
		const h = makeHarness({ guard: true });
		const recording = installRecordingSpawn();
		try {
			for (const [models, presetJudge, inline, expected] of [
				[{ judge: "pin/id" }, "preset/id", "inline/id", "inline/id"],
				[{ judge: "pin/id" }, "preset/id", undefined, "preset/id"],
				[{ judge: "pin/id" }, undefined, undefined, "pin/id"],
				[{}, undefined, undefined, "session/id"],
			] as const) {
				configure(agentDir, { models, panels: { pair: { models: ["p/a"], judge: presetJudge } } });
				const result = await runSubagent(h, cwd, { panel: "pair", task: "x", judge: inline }, { model: { provider: "session", id: "id" } });
				assert.equal(result.isError, false);
				assert.deepEqual((result.details?.panel as any).judge, { agent: "judge", model: expected });
			}
			assert.equal(recording.spawns.length, 4);
			configure(agentDir, { panels: { pair: { models: ["p/a"] } } });
			const rejected = await runSubagent(h, cwd, { panel: "pair", task: "x" }, { scopedModels, model: { provider: "unknown", id: "id" } });
			assert.equal(rejected.isError, true);
			assert.match(rejected.content[0].text, /judge.*Usable models/);
			assert.equal(recording.spawns.length, 4);
		} finally { recording.restore(); }
	});
});

test("partial panel failures preserve successful output and all-failed panels are errors; absent guard refuses meaningfully", async () => {
	await withIsolatedAgents(async (cwd, agentDir) => {
		configure(agentDir, { panels: { pair: { models: ["p/a", "p/org/b"], judge: null } } });
		let failAll = false;
		const recording = installRecordingSpawn((spawn) => {
			if (failAll || flag(spawn.args, "--model") === "p/org/b") { spawn.child.stderr.emit("data", "failed panelist"); return 1; }
			spawn.child.stdout.emit("data", JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "survivor" }] } }) + "\n");
		});
		try {
			const h = makeHarness({ guard: true });
			const mixed = await runSubagent(h, cwd, { panel: "pair", task: "x" });
			assert.equal(mixed.isError, false);
			assert.match(mixed.content[0].text, /\[p\/a\] completed\n\nsurvivor/);
			assert.match(mixed.content[0].text, /\[p\/org\/b\] failed\n\nfailed panelist/);
			assert.equal((mixed.details?.results as any[]).length, 2);
			failAll = true;
			assert.equal((await runSubagent(h, cwd, { panel: "pair", task: "x" })).isError, true);
			const refused = await runSubagent(makeHarness(), cwd, { panel: "pair", task: "x" });
			assert.equal(refused.isError, true);
			assert.match(refused.content[0].text, /no synchronous guard snapshot response/);
			assert.equal(recording.spawns.length, 4);
		} finally { recording.restore(); }
	});
});

test("project panel participants respect scope, trust, UI, opt-out, and confirmation including judge metadata", async () => {
	await withIsolatedAgents(async (cwd, agentDir) => {
		configure(agentDir, { panels: { pair: { agent: "local", models: ["p/a"] } } });
		declaredAgent(path.join(cwd, ".pi", "agents"), "local", "read");
		declaredAgent(path.join(cwd, ".pi", "agents"), "judge", "read");
		const h = makeHarness({ guard: true });
		const recording = installRecordingSpawn();
		let confirmations = 0;
		const ui = { confirm: async (_title: string, message: string) => { confirmations++; assert.match(message, /local, judge/); return false; } };
		try {
			const unavailable = await runSubagent(h, cwd, { panel: "pair", task: "x" });
			assert.equal(unavailable.isError, true);
			assert.match(unavailable.content[0].text, /Unknown agent: "local"/);
			const params = { panel: "pair", task: "x", agentScope: "both" };
			const denied = await runSubagent(h, cwd, params, { hasUI: true, isProjectTrusted: () => false, ui });
			assert.equal(denied.details?.mode, "panel");
			assert.match(denied.content[0].text, /not approved/);
			assert.equal(recording.spawns.length, 0);
			const accepted = await runSubagent(h, cwd, params, { hasUI: true, isProjectTrusted: () => false, ui: { confirm: async () => { confirmations++; return true; } } });
			assert.equal(accepted.isError, false);
			for (const [extraParams, ctx] of [
				[{}, { hasUI: false, isProjectTrusted: () => false, ui }],
				[{}, { hasUI: true, isProjectTrusted: () => true, ui }],
				[{ confirmProjectAgents: false }, { hasUI: true, isProjectTrusted: () => false, ui }],
				[{ agentScope: "project" }, { hasUI: false }],
			] as const) assert.equal((await runSubagent(h, cwd, { ...params, ...extraParams }, ctx)).isError, false);
			assert.equal(confirmations, 2);
			assert.equal(recording.spawns.length, 5);
		} finally { recording.restore(); }
	});
});

test("raw listing preserves whitespace, duplicates, nulls, unresolved agents, roles, and discovery ignored reasons", async () => {
	await withIsolatedAgents(async (cwd, agentDir) => {
		configure(agentDir, { panels: { z: { models: [" p/a ", "p/a"], agent: " missing ", judge: " none " }, a: { models: ["p/a"], judge: null }, inherited: { models: ["p/a"] }, bad: false } });
		const h = makeHarness();
		const result = await runList(h, cwd);
		const sc = result.structuredContent!;
		assert.deepEqual(sc.panels, [
			{ name: "z", agent: " missing ", models: [" p/a ", "p/a"], judge: " none " },
			{ name: "a", agent: null, models: ["p/a"], judge: null },
			{ name: "inherited", agent: null, models: ["p/a"], judge: null },
		]);
		assert.deepEqual(sc.ignoredPanels, [{ name: "bad", reason: '[subagent] panels."bad": preset should be an object' }]);
		assert.deepEqual(result.details, sc);
		const text = result.content[0].text;
		assert.match(text, /judge \(bundled\) \[internal\]/);
		assert.match(text, /scout \(bundled\):/);
		assert.equal(sc.agents.find((a) => a.name === "judge")?.role, "internal");
		assert.equal(sc.agents.find((a) => a.name === "scout")?.role, "delegate");
		assertSortedAppearance(text, ['{"name":"a"', '{"name":"inherited"', '{"name":"z"']);
		for (const entry of sc.panels) assert.ok(text.includes(JSON.stringify(entry)));
		assert.ok(text.includes(sc.ignoredPanels[0].reason.replaceAll('"', '\\"')));
		configure(agentDir, {});
		const empty = await runList(h, cwd);
		assert.deepEqual(empty.structuredContent?.panels, []);
		assert.deepEqual(empty.structuredContent?.ignoredPanels, []);
		assert.match(empty.content[0].text, /Panels: \[\]\nIgnored panels: \[\]/);
	});
});

test("each listing has its own deterministic text cap while structured arrays stay complete", async () => {
	await withIsolatedAgents(async (cwd, agentDir) => {
		const panels: Record<string, unknown> = {};
		for (let i = 104; i >= 0; i--) {
			const n = i.toString().padStart(3, "0");
			panels[`valid${n}`] = { models: ["p/a"] };
			panels[`invalid${n}`] = false;
			writeAgent(path.join(agentDir, "agents"), `agent${n}`, "Test");
		}
		configure(agentDir, { panels });
		const result = await runList(makeHarness(), cwd);
		assert.equal(result.structuredContent?.agents.length, 105 + BUNDLED.length);
		assert.equal(result.structuredContent?.panels.length, 105);
		assert.equal(result.structuredContent?.ignoredPanels.length, 105);
		const text = result.content[0].text;
		assert.equal(text.split("(+5 more)").length - 1, 2);
		assert.ok(text.includes(`(+${5 + BUNDLED.length} more)`));
		assert.equal(text.includes('"name":"valid100"'), false);
		assert.equal(text.includes('"name":"invalid100"'), false);
		assertSortedAppearance(text, ["agent000", "agent001", "agent099"]);
	});
});

test("description catalog is conditional, dispatchable-only, ordered, and absent/empty/ignored-only byte-identical", async () => {
	await withIsolatedAgents(async (cwd, agentDir) => {
		const h = makeHarness();
		setAgentListCwd(cwd);
		const description = () => h.tools.get("subagent")!.prepareLoadout!({})!.descriptions!.subagent;
		const baseline = description();
		assert.equal(baseline.includes("judge"), false);
		for (const value of [{}, { panels: {} }, { panels: { ignored: false } }]) {
			configure(agentDir, value);
			assert.equal(description(), baseline, "exact dispatchable-only baseline equality");
		}
		writeAgent(path.join(cwd, ".pi", "agents"), "projectOnly", "Project");
		configure(agentDir, { panels: { z: { models: ["p/a"] }, hidden: { agent: "judge", models: ["p/a"] }, missing: { agent: "absent", models: ["p/a"] }, project: { agent: "projectOnly", models: ["p/a"] }, a: { models: ["p/org/b"] } } });
		const catalog = description();
		assert.ok(catalog.startsWith(baseline));
		assert.match(catalog, /Panels: a: p\/org\/b; z: p\/a\./);
		for (const name of ["hidden:", "missing:", "project:", "judge"]) assert.equal(catalog.includes(name), false);
		assert.equal(description(), catalog);
	});
});

test("legacy modes retain model/thinking inheritance and support explicit child model overrides without validating inherited pins", async () => {
	await withIsolatedAgents(async (cwd, agentDir) => {
		declaredAgent(path.join(agentDir, "agents"), "pinned", "read", "model: legacy/pin\n");
		declaredAgent(path.join(agentDir, "agents"), "unpinned", "read");
		const h = makeHarness({ guard: true, tools: ["read"] });
		const recording = installRecordingSpawn();
		try {
			for (const mode of ["single", "tasks", "chain"]) {
				for (const agent of ["pinned", "unpinned"]) {
					for (const model of [undefined, "p/org/b"]) {
						const item = { agent, task: "x", model };
						const params = mode === "single" ? item : { [mode]: [item] };
						const result = await runSubagent(h, cwd, params, { scopedModels, model: { provider: "session", id: "inherited" }, thinkingLevel: "high" });
						assert.notEqual(result.isError, true);
						const spawn = recording.spawns.at(-1)!;
						assert.equal(flag(spawn.args, "--model"), model ?? (agent === "pinned" ? "legacy/pin" : "session/inherited"));
						assert.equal(flag(spawn.args, "--thinking"), agent === "pinned" ? undefined : "high");
						assert.equal(flag(spawn.args, "--tools"), "read");
					}
				}
				const arbitrary = { agent: "unpinned", task: "x", model: "custom/org/arbitrary" };
				const result = await runSubagent(h, cwd, mode === "single" ? arbitrary : { [mode]: [arbitrary] });
				assert.notEqual(result.isError, true, "empty scope accepts arbitrary explicit model IDs in legacy modes");
				assert.equal(flag(recording.spawns.at(-1)!.args, "--model"), arbitrary.model);
			}
			assert.equal(recording.spawns.length, 15);
		} finally { recording.restore(); }
	});
});

test("harness event unsubscription works and snapshot acknowledgements are correlated", () => {
	const h = makeHarness({ guard: true });
	let calls = 0;
	const off = h.events.on("test", () => calls++);
	h.events.emit("test", {});
	off();
	h.events.emit("test", {});
	assert.equal(calls, 1);
	const acks: unknown[] = [];
	h.events.on("guard:subagent-snapshot-ack", (ack) => acks.push(ack));
	h.events.emit("guard:subagent-snapshot-request", { version: 1, id: "correlated" });
	assert.deepEqual(acks, [{ version: 1, id: "correlated", ok: true, profile: "research" }]);
});

test("panel template requires preset and task and uses positional expansion without guessing a default", () => {
	const template = fs.readFileSync(new URL("../extensions/subagent/prompts/panel.md", import.meta.url), "utf8");
	assert.ok(template.includes('argument-hint: "<preset> <text>"'));
	assert.ok(template.includes("Preset: $1"));
	assert.ok(template.includes("Task: ${@:2}"));
	assert.ok(template.includes("subagent({panel, task})"));
	assert.ok(template.includes("Do not rewrite the expanded task"));
	assert.ok(template.includes("tool-description catalog"));
	assert.ok(template.includes("Never guess a default preset"));
});

// ── Cleanup ───────────────────────────────────────────────────────────────────

test("cleanup", () => {
	cleanupHarness();
});
