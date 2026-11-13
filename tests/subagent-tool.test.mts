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

import { setAgentListCwd, setBootstrapPathOverride } from "../extensions/subagent/index.ts";
import { INHERIT_ENV } from "../extensions/guard/policy/inheritance.ts";
import {
	cleanupHarness,
	installControlledSpawn,
	installRecordingSpawn,
	makeHarness,
	runList,
	runSubagent,
	spawnCount,
	toolCtx,
	waitFor,
	withIsolatedAgents,
	writeAgent,
	type CapturedSpawn,
	type Harness,
	type TestCtx,
} from "./subagent-harness.mts";

// The fixed panel child timeout and the SIGTERM-to-SIGKILL grace period, spelled
// out so these tests assert the settled values rather than importing them.
const TEN_MINUTES_MS = 10 * 60 * 1000;
const KILL_GRACE_MS = 5 * 1000;

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

/**
 * The judge receives the panelist blocks verbatim as one argv entry, pushed
 * before `--extension`, so it is not the final entry.
 */
function isJudgeSpawn(spawn: CapturedSpawn): boolean {
	return judgePromptOf(spawn) !== undefined;
}

function judgePromptOf(spawn: CapturedSpawn): string | undefined {
	return spawn.args.find((arg) => arg.startsWith("### PANELIST "));
}

/**
 * One `message_end` line. The reported model is deliberately different from the
 * requested one so tests can prove the effective configured label wins.
 */
function assistantLine(text: string, usage: Record<string, unknown> = { input: 1, output: 1, totalTokens: 2, cost: { total: 0.0001 } }): string {
	return `${JSON.stringify({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			model: "reported/other",
			stopReason: "stop",
			usage,
		},
	})}\n`;
}

function emitAnswer(spawn: CapturedSpawn, text: string, usage?: Record<string, unknown>): void {
	spawn.child.stdout.emit("data", assistantLine(text, usage));
	spawn.child.emit("close", 0);
}

function failAnswer(spawn: CapturedSpawn, message = "panelist boom"): void {
	spawn.child.stderr.emit("data", message);
	spawn.child.emit("close", 1);
}

/** A one- or two-model preset, optionally with an explicit judge. */
function panelConfig(agentDir: string, options: { models?: string[]; judge?: string | null } = {}): void {
	configure(agentDir, {
		panels: { pair: { models: options.models ?? ["p/a"], ...(options.judge === undefined ? {} : { judge: options.judge }) } },
	});
}

interface PanelResultDetails {
	details: {
		mode: string;
		panel?: { name: string; agent: string; models: string[]; judge: { agent: string; model?: string } | null };
		results: any[];
		judge: any;
		notices: Array<{ kind: string; reason: string }>;
		mergedOutput: string | null;
	};
	content: Array<{ type: string; text: string }>;
	isError?: boolean;
}

/** Run a one-panelist panel with a judge and answer both children. */
async function runAnsweredPanel(
	h: Harness,
	cwd: string,
	context: Partial<TestCtx> = {},
	answers: { panelist?: string; judge?: string } = {},
): Promise<{ result: PanelResultDetails; recording: ReturnType<typeof installControlledSpawn> }> {
	const recording = installControlledSpawn();
	const promise = runSubagent(h, cwd, { panel: "pair", task: "shared task" }, context);
	await waitFor(() => recording.spawns.length === 1, "panelist never spawned");
	emitAnswer(recording.spawns[0], answers.panelist ?? "panelist answer");
	await waitFor(() => recording.spawns.length === 2, "judge never spawned");
	emitAnswer(recording.spawns[1], answers.judge ?? "merged review");
	const result = (await promise) as unknown as PanelResultDetails;
	return { result, recording };
}

test("panel spawns N panelists then the judge with effective models, fixed tools, cwd, guard snapshots, and full results", async () => {
	await withIsolatedAgents(async (cwd, agentDir) => {
		configure(agentDir, { models: { judge: "p/judge" }, panels: { pair: { models: ["p/a", "p/org/b"] } } });
		declaredAgent(path.join(agentDir, "agents"), "panelist", "read, ffgrep, fffind, subagent", "model: legacy/pin\n");
		const h = makeHarness({ guard: true, tools: ["read", "grep", "find", "subagent"], settings: { modelThinkingLevels: { "p/a": "low" } } });
		const longOutput = "A".repeat(60 * 1024);
		const recording = installRecordingSpawn((spawn) => {
			spawn.child.stdout.emit("data", assistantLine(flag(spawn.args, "--model") === "p/a" ? longOutput : "judge merge"));
		});
		try {
			const task = "Exact task\n  keep spacing";
			const result = await runSubagent(h, cwd, { panel: "pair", task, cwd: agentDir }, {
				scopedModels, model: { provider: "p", id: "session" }, thinkingLevel: "high",
			});
			assert.equal(result.isError, false);
			assert.equal(recording.spawns.length, 3, "two panelists plus one judge attempt");
			const panelistSpawns = recording.spawns.filter((spawn) => !isJudgeSpawn(spawn));
			const judgeSpawns = recording.spawns.filter(isJudgeSpawn);
			assert.equal(panelistSpawns.length, 2);
			assert.deepEqual(panelistSpawns.map((s) => flag(s.args, "--model")).sort(), ["p/a", "p/org/b"]);
			for (const spawn of panelistSpawns) {
				assert.equal(flag(spawn.args, "--thinking"), flag(spawn.args, "--model") === "p/a" ? "low" : "high");
				assert.equal(flag(spawn.args, "--tools"), "read,grep,find");
				assert.equal(spawn.args.includes("--no-tools"), false);
				assert.ok(spawn.args.includes(`Task: ${task}`), "panelists keep the Task: prefix");
				assert.equal(spawn.options.cwd, agentDir);
				assert.ok(flag(spawn.args, "--extension")?.endsWith("guard-bootstrap.ts"));
				assert.ok(spawn.options.env?.PI_GUARD_INHERIT);
			}
			assert.equal(judgeSpawns.length, 1);
			assert.equal(flag(judgeSpawns[0].args, "--model"), "p/judge", "models.judge supplies the judge model");
			assert.equal(flag(judgeSpawns[0].args, "--thinking"), "high");
			assert.equal(flag(judgeSpawns[0].args, "--tools"), "read,grep,find");
			assert.equal(judgeSpawns[0].options.cwd, agentDir);
			assert.ok(judgePromptOf(judgeSpawns[0])!.startsWith("### PANELIST p/a"), "verbatim blocks, never a Task: prefix");
			assert.equal(judgeSpawns[0].args.includes("Task: "), false);
			assert.equal(new Set(recording.spawns.map((s) => s.options.env?.PI_GUARD_INHERIT)).size, 3, "fresh inheritance nonce per spawn");
			assert.equal(h.emitted.filter((c) => c === "guard:subagent-snapshot-request").length, 3);

			assert.equal(result.details?.mode, "panel");
			const details = result.details as any;
			assert.deepEqual(details.panel, { name: "pair", agent: "panelist", models: ["p/a", "p/org/b"], judge: { agent: "judge", model: "p/judge" } });
			assert.equal(details.results.length, 2);
			assert.equal(details.results[0].model, "p/a", "effective requested label wins over the reported model");
			assert.equal(details.results[0].output, longOutput);
			assert.equal(details.results[0].messages[0].content[0].text, longOutput, "full output kept in details");
			assert.equal(details.results[0].usage.input, 1);
			assert.equal("step" in details.results[0], false, "panelist records carry no step");
			assert.equal(details.mergedOutput, "judge merge");
			assert.equal(details.judge.attempts.length, 1);
			assert.equal(details.judge.model, "p/judge");
			assert.deepEqual(details.notices, []);
			const text = result.content[0].text;
			assert.ok(text.startsWith("Panel pair (2 models; judge: p/judge)\n"), text);
			assert.ok(text.includes("judge merge"));
			assert.ok(text.includes("- p/a: 1 turn ↑1 ↓1 $0.0001"));
			assert.ok(text.includes("- p/org/b: 1 turn ↑1 ↓1 $0.0001"));
			assert.ok(text.includes("- judge p/judge: 1 turn ↑1 ↓1 $0.0001"));
			assert.ok(text.includes("Total: 3 turns ↑3 ↓3 $0.0003"));
			const totalLine = text.split("\n").find((line) => line.startsWith("Total: "))!;
			assert.equal(/ctx:\d/.test(totalLine), false, "context tokens are never summed into the total");
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

test("judge metadata precedence is inline, preset, configured override, session and scoped validation includes the judge", async () => {
	await withIsolatedAgents(async (cwd, agentDir) => {
		const h = makeHarness({ guard: true });
		const recording = installRecordingSpawn((spawn) => {
			if (isJudgeSpawn(spawn)) spawn.child.stdout.emit("data", assistantLine("judge answer"));
		});
		try {
			for (const [models, presetJudge, inline, expected] of [
				[{ judge: "pin/id" }, "preset/id", "inline/id", "inline/id"],
				[{ judge: "pin/id" }, "preset/id", undefined, "preset/id"],
				[{ judge: "pin/id" }, undefined, undefined, "pin/id"],
				[{}, undefined, undefined, "session/id"],
			] as const) {
				configure(agentDir, { models, panels: { pair: { models: ["p/a"], judge: presetJudge } } });
				const before = recording.spawns.length;
				const result = await runSubagent(h, cwd, { panel: "pair", task: "x", judge: inline }, { model: { provider: "session", id: "id" } });
				assert.equal(result.isError, false);
				assert.deepEqual((result.details?.panel as any).judge, { agent: "judge", model: expected });
				const judgeSpawn = recording.spawns.slice(before).find(isJudgeSpawn);
				assert.ok(judgeSpawn, `judge spawned for ${expected}`);
				assert.equal(flag(judgeSpawn.args, "--model"), expected);
			}
			assert.equal(recording.spawns.length, 8, "one panelist plus one judge attempt per case");
			configure(agentDir, { panels: { pair: { models: ["p/a"] } } });
			const rejected = await runSubagent(h, cwd, { panel: "pair", task: "x" }, { scopedModels, model: { provider: "unknown", id: "id" } });
			assert.equal(rejected.isError, true);
			assert.match(rejected.content[0].text, /judge.*Usable models/);
			assert.equal(recording.spawns.length, 8);
		} finally { recording.restore(); }
	});
});

test("partial panel failures preserve successful output and all-failed panels are errors; guard presence decides absent versus unresponsive", async () => {
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
			assert.equal(recording.spawns.length, 4);

			// A provably absent guard (no snapshot answer, no presence answer, no
			// guard-layout command) dispatches ungated rather than refusing.
			failAll = false;
			const ungated = await runSubagent(makeHarness(), cwd, { panel: "pair", task: "x" });
			assert.notEqual(ungated.isError, true, "an absent guard dispatches ungated");
			assert.equal(recording.spawns.length, 6);
			const ungatedSpawn = recording.spawns[4]!;
			assert.equal(flag(ungatedSpawn.args, "--extension"), undefined, "the ungated child carries no startup gate");
			assert.equal(ungatedSpawn.options.env?.[INHERIT_ENV], process.env[INHERIT_ENV], "the ambient contract passes through untouched");

			// A guard that is loaded but never answers the snapshot still refuses.
			const silent = await runSubagent(makeHarness({ guardPresence: true }), cwd, { panel: "pair", task: "x" });
			assert.equal(silent.isError, true);
			assert.match(silent.content[0].text, /guard refused subagent dispatch: a guard extension is loaded but did not answer the snapshot handshake/);
			assert.equal(recording.spawns.length, 6, "no child is spawned for the unresponsive guard");

			// A guard too old to answer the presence ping is caught by its command,
			// in both provenance shapes pi reports.
			for (const shape of ["cli", "package", "package-root", "windows"] as const) {
				const registered = await runSubagent(makeHarness({ guardCommand: shape }), cwd, { panel: "pair", task: "x" });
				assert.equal(registered.isError, true, shape);
				assert.match(registered.content[0].text, /guard refused subagent dispatch: a guard extension is loaded but did not answer the snapshot handshake/);
				assert.equal(recording.spawns.length, 6, "no child is spawned for a registered guard");
			}
		} finally { recording.restore(); }
	});
});

test("project panel participants respect scope, trust, UI, opt-out, and confirmation including judge metadata", async () => {
	await withIsolatedAgents(async (cwd, agentDir) => {
		configure(agentDir, { panels: { pair: { agent: "local", models: ["p/a"] } } });
		declaredAgent(path.join(cwd, ".pi", "agents"), "local", "read");
		declaredAgent(path.join(cwd, ".pi", "agents"), "judge", "read");
		const h = makeHarness({ guard: true });
		const recording = installRecordingSpawn((spawn) => {
			if (isJudgeSpawn(spawn)) spawn.child.stdout.emit("data", assistantLine("merge"));
		});
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
			assert.equal(recording.spawns.length, 10, "five runs, each one panelist plus one judge attempt");
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

// ── Judge dispatch, retry/fallback, salvage, usage, and child lifecycle ───────

test("the judge prompt is the verbatim panelist blocks, inspected during spawn before cleanup", async () => {
	await withIsolatedAgents(async (cwd, agentDir) => {
		configure(agentDir, { panels: { pair: { models: ["p/a", "p/org/b"], judge: "p/judge" } } });
		const h = makeHarness({ guard: true, tools: ["read"] });
		const inspected: string[][] = [];
		const recording = installControlledSpawn((spawn) => {
			if (isJudgeSpawn(spawn)) inspected.push([...spawn.args]);
		});
		try {
			const promise = runSubagent(h, cwd, { panel: "pair", task: "Shared task" });
			await waitFor(() => recording.spawns.length === 2);
			for (const spawn of recording.spawns.slice(0, 2)) {
				emitAnswer(spawn, flag(spawn.args, "--model") === "p/a" ? "answer A" : "answer B");
			}
			await waitFor(() => recording.spawns.length === 3);
			assert.equal(inspected.length, 1, "the judge spawn was inspected while it was live");
			const args = inspected[0];
			const prompt = args.find((arg) => arg.startsWith("### PANELIST "))!;
			assert.equal(
				prompt,
				[
					"### PANELIST p/a",
					"task: Shared task",
					"tools: (none)",
					"status: completed",
					"",
					"answer A",
					"",
					"### PANELIST p/org/b",
					"task: Shared task",
					"tools: (none)",
					"status: completed",
					"",
					"answer B",
				].join("\n"),
			);
			assert.equal(prompt.includes("Task: "), false, "no Task: prefix");
			assert.equal(prompt.includes("Return these sections"), false, "no format restatement in the call");
			assert.ok(args.includes("--append-system-prompt"), "the judge agent body is the system prompt");
			const modeIndex = args.indexOf("--mode");
			assert.deepEqual(args.slice(modeIndex, modeIndex + 4), ["--mode", "json", "-p", "--no-session"]);
			assert.equal(args.includes("--extension"), true);
			emitAnswer(recording.spawns[2], "merged");
			assert.equal((await promise).isError, false);
		} finally { recording.restore(); }
	});
});

test("judge tools come from the panel path despite the override declaration, including --no-tools", async () => {
	await withIsolatedAgents(async (cwd, agentDir) => {
		for (const [declared, available, expected, noTools] of [
			["bash, write, web_search", ["read", "grep", "find", "ls", "git_read", "gh_read", "web_search", "subagent"], "read,grep,find,ls,git_read,gh_read", false],
			["", ["read"], "read", false],
			["read", [], undefined, true],
		] as const) {
			declaredAgent(path.join(agentDir, "agents"), "judge", declared === "" ? undefined : declared);
			panelConfig(agentDir, { judge: "p/judge" });
			const h = makeHarness({ guard: true, tools: [...available] });
			const recording = installControlledSpawn();
			try {
				const promise = runSubagent(h, cwd, { panel: "pair", task: "t" });
				await waitFor(() => recording.spawns.length === 1);
				emitAnswer(recording.spawns[0], "panelist answer");
				await waitFor(() => recording.spawns.length === 2);
				const judgeSpawn = recording.spawns[1];
				emitAnswer(judgeSpawn, "merged");
				const result = (await promise) as any;
				assert.equal(result.isError, false);
				if (noTools) {
					assert.equal(judgeSpawn.args.includes("--no-tools"), true);
					assert.equal(judgeSpawn.args.includes("--tools"), false);
				} else {
					assert.equal(flag(judgeSpawn.args, "--tools"), expected);
					assert.equal(judgeSpawn.args.includes("--no-tools"), false);
				}
				const tools = flag(judgeSpawn.args, "--tools") ?? "";
				assert.equal(tools.includes("subagent"), false);
				assert.equal(tools.includes("web_search"), false);
				assert.equal(tools.includes("bash"), false);
			} finally { recording.restore(); }
		}
	});
});

test("a judge frontmatter pin is not an extra precedence level", async () => {
	await withIsolatedAgents(async (cwd, agentDir) => {
		declaredAgent(path.join(agentDir, "agents"), "judge", "read", "model: frontmatter/judge\n");
		panelConfig(agentDir, { judge: "p/judge" });
		const h = makeHarness({ guard: true, tools: ["read"] });
		const { recording } = await runAnsweredPanel(h, cwd, { model: { provider: "session", id: "id" } });
		try {
			assert.equal(flag(recording.spawns.find(isJudgeSpawn)!.args, "--model"), "p/judge");
		} finally { recording.restore(); }
	});
	await withIsolatedAgents(async (cwd, agentDir) => {
		declaredAgent(path.join(agentDir, "agents"), "judge", "read", "model: frontmatter/judge\n");
		panelConfig(agentDir);
		const h = makeHarness({ guard: true, tools: ["read"] });
		const { recording } = await runAnsweredPanel(h, cwd, { model: { provider: "session", id: "id" } });
		try {
			assert.equal(flag(recording.spawns.find(isJudgeSpawn)!.args, "--model"), "session/id", "the frontmatter pin does not outrank the session fallback");
		} finally { recording.restore(); }
	});
});

test("failures are labeled as a partial merge and a one-answer merge as single-model", async () => {
	await withIsolatedAgents(async (cwd, agentDir) => {
		configure(agentDir, { panels: { pair: { models: ["p/a", "p/org/b"], judge: "p/judge" } } });
		const h = makeHarness({ guard: true, tools: ["read"] });
		const recording = installControlledSpawn();
		try {
			const promise = runSubagent(h, cwd, { panel: "pair", task: "shared" });
			await waitFor(() => recording.spawns.length === 2);
			const panelistA = recording.spawns.find((s) => flag(s.args, "--model") === "p/a")!;
			const panelistB = recording.spawns.find((s) => flag(s.args, "--model") === "p/org/b")!;
			emitAnswer(panelistA, "answer A");
			failAnswer(panelistB, "provider exploded");
			await waitFor(() => recording.spawns.length === 3);
			const judgeSpawn = recording.spawns[2];
			const judgePrompt = judgePromptOf(judgeSpawn)!;
			assert.ok(judgePrompt.includes("status: failed"), "the failed block is in the judge input");
			assert.ok(judgePrompt.includes("error: provider exploded"));
			assert.ok(judgePrompt.includes("[Incomplete partial answer:]"));
			emitAnswer(judgeSpawn, "merged review");
			const result = (await promise) as any;
			assert.equal(result.isError, false);
			assert.equal(result.details.mergedOutput, "merged review");
			assert.deepEqual(result.details.notices.map((n: any) => n.kind).sort(), ["partial-merge", "single-model-merge"]);
			const partial = result.details.notices.find((n: any) => n.kind === "partial-merge");
			assert.match(partial.reason, /1 of 2 panelists failed: p\/org\/b \(provider exploded\)/);
			const text = result.content[0].text;
			assert.ok(text.includes("merged review"));
			assert.ok(text.includes("- p/org/b failed: provider exploded"));
			assert.equal((text.match(/### \[/g) ?? []).length, 0, "no fallback sections when the merge succeeded");
			assert.equal(result.details.results.length, 2, "both panelists stay in configured order");
			assert.equal(result.details.results[1].model, "p/org/b");
			assert.equal(result.details.results[1].output, "");
		} finally { recording.restore(); }
	});
});

test("zero survivors skip the judge and return an error with every failure kept", async () => {
	await withIsolatedAgents(async (cwd, agentDir) => {
		configure(agentDir, { panels: { pair: { models: ["p/a", "p/org/b"], judge: "p/judge" } } });
		const h = makeHarness({ guard: true, tools: ["read"] });
		const recording = installControlledSpawn();
		try {
			const promise = runSubagent(h, cwd, { panel: "pair", task: "shared" });
			await waitFor(() => recording.spawns.length === 2);
			for (const spawn of recording.spawns) failAnswer(spawn, `${flag(spawn.args, "--model")} failed`);
			const result = (await promise) as any;
			assert.equal(result.isError, true);
			assert.equal(recording.spawns.length, 2, "no judge call");
			assert.equal(result.details.judge, null);
			assert.deepEqual(result.details.notices.map((n: any) => n.kind), ["no-survivors"]);
			const text = result.content[0].text;
			assert.ok(text.includes("### [p/a] failed"));
			assert.ok(text.includes("### [p/org/b] failed"));
			assert.equal(text.includes("- judge"), false);
		} finally { recording.restore(); }
	});
});

test("judge none and null skip the merge with no judge spawn and no judge usage line", async () => {
	await withIsolatedAgents(async (cwd, agentDir) => {
		for (const judge of [null, "none"]) {
			configure(agentDir, { panels: { pair: { models: ["p/a"], judge: "p/judge" } } });
			const h = makeHarness({ guard: true, tools: ["read"] });
			const recording = installControlledSpawn();
			try {
				const promise = runSubagent(h, cwd, { panel: "pair", task: "t", judge });
				await waitFor(() => recording.spawns.length === 1);
				emitAnswer(recording.spawns[0], "answer");
				const result = (await promise) as any;
				assert.equal(result.isError, false);
				assert.equal(recording.spawns.length, 1, "no judge spawn");
				assert.equal(result.details.judge, null);
				assert.deepEqual(result.details.notices.map((n: any) => n.kind), ["merge-skipped"]);
				const text = result.content[0].text;
				assert.ok(text.includes("### [p/a] completed\n\nanswer"));
				assert.equal(text.includes("- judge"), false);
			} finally { recording.restore(); }
		}
	});
});

test("the judge retries exactly once with identical input and a fresh snapshot", async () => {
	await withIsolatedAgents(async (cwd, agentDir) => {
		panelConfig(agentDir, { judge: "p/judge" });
		const h = makeHarness({ guard: true, tools: ["read"] });
		const recording = installControlledSpawn();
		try {
			const promise = runSubagent(h, cwd, { panel: "pair", task: "t" });
			await waitFor(() => recording.spawns.length === 1);
			emitAnswer(recording.spawns[0], "panelist answer");
			await waitFor(() => recording.spawns.length === 2);
			const first = recording.spawns[1];
			failAnswer(first, "judge exploded");
			await waitFor(() => recording.spawns.length === 3);
			const second = recording.spawns[2];
			assert.equal(judgePromptOf(second), judgePromptOf(first), "identical prompt");
			assert.equal(flag(second.args, "--model"), flag(first.args, "--model"));
			assert.equal(flag(second.args, "--thinking"), flag(first.args, "--thinking"));
			assert.equal(flag(second.args, "--tools"), flag(first.args, "--tools"));
			assert.notEqual(second.options.env?.PI_GUARD_INHERIT, first.options.env?.PI_GUARD_INHERIT, "fresh snapshot per attempt");
			emitAnswer(second, "merged on retry");
			const result = (await promise) as any;
			assert.equal(result.isError, false);
			assert.equal(result.details.mergedOutput, "merged on retry");
			assert.equal(result.details.judge.attempts.length, 2);
			assert.equal(result.details.judge.attempts[0].stderr, "judge exploded");
			assert.equal(result.details.judge.attempts[0].output, "");
			assert.equal(result.details.judge.attempts[1].output, "merged on retry");
			const text = result.content[0].text;
			assert.ok(text.includes("(2 attempts)"));
			assert.ok(text.includes("Total: 2 turns"));
			assert.equal(h.emitted.filter((c) => c === "guard:subagent-snapshot-request").length, 3, "fresh snapshot per attempt");
		} finally { recording.restore(); }
	});
});

test("two failed judge attempts fall back to labeled sections and count both attempts", async () => {
	await withIsolatedAgents(async (cwd, agentDir) => {
		panelConfig(agentDir, { judge: "p/judge" });
		const h = makeHarness({ guard: true, tools: ["read"] });
		const recording = installControlledSpawn();
		try {
			const promise = runSubagent(h, cwd, { panel: "pair", task: "t" });
			await waitFor(() => recording.spawns.length === 1);
			emitAnswer(recording.spawns[0], "panelist answer");
			await waitFor(() => recording.spawns.length === 2);
			failAnswer(recording.spawns[1], "first failure");
			await waitFor(() => recording.spawns.length === 3);
			failAnswer(recording.spawns[2], "second failure");
			const result = (await promise) as any;
			assert.equal(result.isError, false, "a survivor keeps the panel out of the error path");
			assert.equal(result.details.mergedOutput, null);
			assert.equal(result.details.judge.attempts.length, 2);
			assert.deepEqual(result.details.notices.map((n: any) => n.kind), ["merge-failed"]);
			assert.equal(result.details.notices[0].reason, "second failure", "the notice carries the judge's failure reason");
			const text = result.content[0].text;
			assert.ok(text.includes("### [p/a] completed\n\npanelist answer"));
			assert.ok(text.includes("- judge p/judge: no usage (2 attempts) failed: second failure"));
			assert.ok(text.includes("Total: 1 turn"));
		} finally { recording.restore(); }
	});
});

test("empty and whitespace-only exit-zero judge answers are failures that retry", async () => {
	await withIsolatedAgents(async (cwd, agentDir) => {
		for (const empty of ["", "   \n  "]) {
			panelConfig(agentDir, { judge: "p/judge" });
			const h = makeHarness({ guard: true, tools: ["read"] });
			const recording = installControlledSpawn();
			try {
				const promise = runSubagent(h, cwd, { panel: "pair", task: "t" });
				await waitFor(() => recording.spawns.length === 1);
				emitAnswer(recording.spawns[0], "panelist answer");
				await waitFor(() => recording.spawns.length === 2);
				emitAnswer(recording.spawns[1], empty);
				await waitFor(() => recording.spawns.length === 3);
				emitAnswer(recording.spawns[2], "real answer");
				const result = (await promise) as any;
				assert.equal(result.details.judge.attempts.length, 2);
				assert.equal(result.details.judge.attempts[0].output, empty, "raw attempt text is kept");
				assert.equal(result.details.mergedOutput, "real answer");
				assert.equal(result.content[0].text.includes("(no output)"), false, "empty is a failure, not a placeholder");
			} finally { recording.restore(); }
		}
	});
});

test("an emitted spawn error is a failed attempt and retries", async () => {
	await withIsolatedAgents(async (cwd, agentDir) => {
		panelConfig(agentDir, { judge: "p/judge" });
		const h = makeHarness({ guard: true, tools: ["read"] });
		const recording = installControlledSpawn();
		try {
			const promise = runSubagent(h, cwd, { panel: "pair", task: "t" });
			await waitFor(() => recording.spawns.length === 1);
			emitAnswer(recording.spawns[0], "panelist answer");
			await waitFor(() => recording.spawns.length === 2);
			recording.spawns[1].child.emit("error", new Error("spawn ENOENT"));
			await waitFor(() => recording.spawns.length === 3);
			emitAnswer(recording.spawns[2], "merged after spawn error");
			const result = (await promise) as any;
			assert.equal(result.details.judge.attempts.length, 2);
			assert.equal(result.details.judge.attempts[0].errorMessage, "spawn ENOENT");
			assert.equal(result.details.mergedOutput, "merged after spawn error");
		} finally { recording.restore(); }
	});
});

test("a synchronous spawn throw is a failed attempt and retries", async () => {
	await withIsolatedAgents(async (cwd, agentDir) => {
		panelConfig(agentDir, { judge: "p/judge" });
		const h = makeHarness({ guard: true, tools: ["read"] });
		let thrown = false;
		const recording = installControlledSpawn((spawn) => {
			if (!thrown && isJudgeSpawn(spawn)) {
				thrown = true;
				throw new Error("spawn threw synchronously");
			}
		});
		try {
			const promise = runSubagent(h, cwd, { panel: "pair", task: "t" });
			await waitFor(() => recording.spawns.length === 1);
			emitAnswer(recording.spawns[0], "panelist answer");
			await waitFor(() => recording.spawns.length === 3, "the failed spawn plus the retry");
			emitAnswer(recording.spawns[2], "merged after throw");
			const result = (await promise) as any;
			assert.equal(result.details.judge.attempts.length, 2);
			assert.equal(result.details.judge.attempts[0].errorMessage, "spawn threw synchronously");
			assert.equal(result.details.mergedOutput, "merged after throw");
		} finally { recording.restore(); }
	});
});

test("a guard refusal is a failed attempt that retries and then falls back", async () => {
	await withIsolatedAgents(async (cwd, agentDir) => {
		panelConfig(agentDir, { judge: "p/judge" });
		const h = makeHarness({ guard: true, tools: ["read"] });
		const recording = installControlledSpawn();
		try {
			const promise = runSubagent(h, cwd, { panel: "pair", task: "t" });
			await waitFor(() => recording.spawns.length === 1);
			emitAnswer(recording.spawns[0], "panelist answer");
			setBootstrapPathOverride(path.join(agentDir, "missing-guard-bootstrap.ts"));
			const result = (await promise) as any;
			assert.equal(recording.spawns.length, 1, "a refused dispatch never spawns");
			assert.equal(result.details.judge.attempts.length, 2, "the refusal retries once");
			for (const attempt of result.details.judge.attempts) {
				assert.match(attempt.errorMessage, /^guard refused subagent dispatch: child startup gate not found/);
			}
			assert.equal(result.details.mergedOutput, null);
			assert.deepEqual(result.details.notices.map((n: any) => n.kind), ["merge-failed"]);
			assert.ok(result.content[0].text.includes("### [p/a] completed"));
		} finally {
			setBootstrapPathOverride(null);
			recording.restore();
		}
	});
});

test("a judge timeout is terminal, keeps partial output, and never retries", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	await withIsolatedAgents(async (cwd, agentDir) => {
		panelConfig(agentDir, { judge: "p/judge" });
		const h = makeHarness({ guard: true, tools: ["read"] });
		const recording = installControlledSpawn();
		try {
			const promise = runSubagent(h, cwd, { panel: "pair", task: "t" });
			await waitFor(() => recording.spawns.length === 1);
			emitAnswer(recording.spawns[0], "panelist answer", { input: 7, output: 3, totalTokens: 10, cost: { total: 0.0002 } });
			await waitFor(() => recording.spawns.length === 2);
			const judgeChild = recording.spawns[1].child;
			judgeChild.stdout.emit("data", assistantLine("partial judge text", { input: 5, output: 1, totalTokens: 6, cost: { total: 0.0003 } }));
			t.mock.timers.tick(TEN_MINUTES_MS);
			assert.deepEqual(judgeChild.killedWith, ["SIGTERM"]);
			t.mock.timers.tick(KILL_GRACE_MS);
			assert.deepEqual(judgeChild.killedWith, ["SIGTERM", "SIGKILL"]);
			judgeChild.emit("close", null, "SIGKILL");
			const result = (await promise) as any;
			assert.equal(recording.spawns.length, 2, "a timeout never retries");
			assert.equal(result.details.judge.attempts.length, 1);
			assert.equal(result.details.judge.attempts[0].terminationReason, "timeout");
			assert.equal(result.details.judge.attempts[0].exitCode, 1);
			assert.equal(result.details.judge.attempts[0].errorMessage, "timed out after 10 minutes");
			assert.equal(result.details.judge.attempts[0].output, "partial judge text", "partial output is kept");
			assert.equal(result.details.judge.attempts[0].usage.input, 5);
			assert.equal(result.details.results[0].output, "panelist answer");
			assert.equal(result.details.mergedOutput, null);
			const text = result.content[0].text;
			assert.ok(text.includes("timed out after 10 minutes"));
			assert.ok(text.includes("### [p/a] completed"));
			assert.ok(text.includes("- p/a: 1 turn ↑7 ↓3 $0.0002"));
			assert.equal(text.includes("(2 attempts)"), false);
		} finally { recording.restore(); }
	});
});

test("abort during the judge keeps panelists and the judge's partial output with a merge-aborted notice", async () => {
	await withIsolatedAgents(async (cwd, agentDir) => {
		panelConfig(agentDir, { judge: "p/judge" });
		const h = makeHarness({ guard: true, tools: ["read"] });
		const recording = installControlledSpawn();
		try {
			const controller = new AbortController();
			const promise = h.tools.get("subagent")!.execute("id", { panel: "pair", task: "t" }, controller.signal, undefined, toolCtx(cwd));
			await waitFor(() => recording.spawns.length === 1);
			emitAnswer(recording.spawns[0], "panelist answer");
			await waitFor(() => recording.spawns.length === 2);
			recording.spawns[1].child.stdout.emit("data", assistantLine("partial judge text"));
			controller.abort();
			assert.deepEqual(recording.spawns[1].child.killedWith, ["SIGTERM"]);
			recording.spawns[1].child.emit("close", null, "SIGTERM");
			const result = (await promise) as any;
			assert.equal(result.isError, false);
			assert.equal(result.details.results[0].output, "panelist answer");
			assert.equal(result.details.judge.attempts.length, 1);
			assert.equal(result.details.judge.attempts[0].terminationReason, "aborted");
			assert.equal(result.details.judge.attempts[0].output, "partial judge text");
			assert.equal(result.details.mergedOutput, null);
			assert.deepEqual(result.details.notices.map((n: any) => n.kind), ["merge-aborted"]);
			assert.ok(result.content[0].text.includes("### [p/a] completed\n\npanelist answer"));
		} finally { recording.restore(); }
	});
});

test("an abort before the judge spawns preserves the answers", async () => {
	await withIsolatedAgents(async (cwd, agentDir) => {
		panelConfig(agentDir, { judge: "p/judge" });
		const h = makeHarness({ guard: true, tools: ["read"] });
		const recording = installControlledSpawn();
		try {
			const controller = new AbortController();
			const promise = h.tools.get("subagent")!.execute("id", { panel: "pair", task: "t" }, controller.signal, undefined, toolCtx(cwd));
			await waitFor(() => recording.spawns.length === 1);
			recording.spawns[0].child.stdout.emit("data", assistantLine("panelist answer"));
			recording.spawns[0].child.emit("close", 0);
			controller.abort();
			const result = (await promise) as any;
			assert.equal(recording.spawns.length, 1, "no judge spawn after the pre-spawn abort");
			assert.equal(result.details.results[0].output, "panelist answer");
			assert.equal(result.details.judge.attempts.length, 1);
			assert.equal(result.details.judge.attempts[0].terminationReason, "aborted");
			assert.equal(result.details.judge.attempts[0].errorMessage, "Subagent was aborted");
			assert.equal(result.details.mergedOutput, null);
			assert.deepEqual(result.details.notices.map((n: any) => n.kind), ["merge-aborted"]);
		} finally { recording.restore(); }
	});
});

test("an abort after a failed judge attempt skips the retry and preserves the answers", async () => {
	await withIsolatedAgents(async (cwd, agentDir) => {
		panelConfig(agentDir, { judge: "p/judge" });
		const h = makeHarness({ guard: true, tools: ["read"] });
		const recording = installControlledSpawn();
		try {
			const controller = new AbortController();
			const promise = h.tools.get("subagent")!.execute("id", { panel: "pair", task: "t" }, controller.signal, undefined, toolCtx(cwd));
			await waitFor(() => recording.spawns.length === 1);
			emitAnswer(recording.spawns[0], "panelist answer");
			await waitFor(() => recording.spawns.length === 2);
			recording.spawns[1].child.stderr.emit("data", "judge failed");
			recording.spawns[1].child.emit("close", 1);
			controller.abort();
			const result = (await promise) as any;
			assert.equal(recording.spawns.length, 2, "no retry after the abort");
			assert.equal(result.details.judge.attempts.length, 1);
			assert.equal(result.details.mergedOutput, null);
			assert.deepEqual(result.details.notices.map((n: any) => n.kind), ["merge-aborted"]);
		} finally { recording.restore(); }
	});
});

test("totals include failed panelists and every attempt exactly once and never sum context tokens", async () => {
	await withIsolatedAgents(async (cwd, agentDir) => {
		configure(agentDir, { panels: { pair: { models: ["p/a", "p/org/b"], judge: "p/judge" } } });
		const h = makeHarness({ guard: true, tools: ["read"] });
		const recording = installControlledSpawn();
		try {
			const promise = runSubagent(h, cwd, { panel: "pair", task: "t" });
			await waitFor(() => recording.spawns.length === 2);
			const a = recording.spawns.find((s) => flag(s.args, "--model") === "p/a")!;
			const b = recording.spawns.find((s) => flag(s.args, "--model") === "p/org/b")!;
			emitAnswer(a, "answer A", { input: 10, output: 1, totalTokens: 100, cost: { total: 0.001 } });
			b.child.stdout.emit("data", assistantLine("partial", { input: 5, output: 1, totalTokens: 50, cost: { total: 0.0005 } }));
			b.child.stderr.emit("data", "boom");
			b.child.emit("close", 1);
			await waitFor(() => recording.spawns.length === 3);
			failAnswer(recording.spawns[2], "judge first");
			await waitFor(() => recording.spawns.length === 4);
			emitAnswer(recording.spawns[3], "merged", { input: 2, output: 1, totalTokens: 20, cost: { total: 0.0002 } });
			const result = (await promise) as any;
			const text = result.content[0].text;
			assert.ok(text.includes("- p/a: 1 turn ↑10 ↓1 $0.0010"));
			assert.ok(text.includes("- p/org/b failed: boom"));
			assert.ok(text.includes("usage: 1 turn ↑5 ↓1 $0.0005"));
			assert.ok(text.includes("- judge p/judge: 1 turn ↑2 ↓1 $0.0002 (2 attempts)"));
			assert.ok(text.includes("Total: 3 turns ↑17 ↓3 $0.0017"));
			const totalLine = text.split("\n").find((line) => line.startsWith("Total: "))!;
			assert.equal(/ctx:\d/.test(totalLine), false, "context tokens are never summed into the total");
		} finally { recording.restore(); }
	});
});

test("content caps the merged review while details keep it whole", async () => {
	await withIsolatedAgents(async (cwd, agentDir) => {
		panelConfig(agentDir, { judge: "p/judge" });
		const h = makeHarness({ guard: true, tools: ["read"] });
		const big = "M".repeat(60 * 1024);
		const { result, recording } = await runAnsweredPanel(h, cwd, {}, { judge: big });
		try {
			assert.equal(result.details.mergedOutput, big, "details keep the full merged text");
			const text = result.content[0].text;
			assert.ok(text.includes("[Output truncated: 10240 bytes omitted."));
			assert.equal(text.includes(big), false);
		} finally { recording.restore(); }
	});
});

test("nonconforming but nonempty judge prose remains the merged content", async () => {
	await withIsolatedAgents(async (cwd, agentDir) => {
		panelConfig(agentDir, { judge: "p/judge" });
		const h = makeHarness({ guard: true, tools: ["read"] });
		const { result, recording } = await runAnsweredPanel(h, cwd, {}, { judge: "Here is a plain prose merge with no section headings." });
		try {
			assert.equal(result.details.mergedOutput, "Here is a plain prose merge with no section headings.");
			assert.ok(result.content[0].text.includes("Here is a plain prose merge"));
		} finally { recording.restore(); }
	});
});

test("streaming updates keep panelists in results and put the judge at the top level", async () => {
	await withIsolatedAgents(async (cwd, agentDir) => {
		panelConfig(agentDir, { judge: "p/judge" });
		const h = makeHarness({ guard: true, tools: ["read"] });
		const recording = installControlledSpawn();
		try {
			const updates: any[] = [];
			const promise = h.tools.get("subagent")!.execute(
				"id",
				{ panel: "pair", task: "t" },
				undefined,
				(partial: any) => updates.push(partial),
				toolCtx(cwd),
			);
			await waitFor(() => recording.spawns.length === 1);
			emitAnswer(recording.spawns[0], "panelist answer");
			await waitFor(() => recording.spawns.length === 2);
			recording.spawns[1].child.stdout.emit("data", assistantLine("judge streaming"));
			emitAnswer(recording.spawns[1], "final merge");
			const result = (await promise) as any;
			assert.ok(updates.length > 0);
			for (const update of updates) {
				for (const panelist of update.details.results) assert.equal(panelist.model, "p/a", "results stay panelists");
				if (update.details.judge) assert.equal(update.details.judge.agent, "judge");
			}
			assert.ok(updates.some((update) => update.details.judge !== null), "judge updates reach the top-level judge");
			assert.equal(result.details.judge.output, "final merge");
			assert.equal(result.details.results.length, 1);
		} finally { recording.restore(); }
	});
});

// ── Panel renderer (display of the finished and running result) ────────────
// The theme stub makes every role visible in the rendered text, so an exact
// assertion pins both the content and which lines are dimmed.
const renderTheme = {
	fg: (role: string, value: string) => `[${role}]${value}`,
	bold: (value: string) => `[bold]${value}`,
} as any;

function stripAnsi(text: string): string {
	return text.replace(/\u001b\[[0-9;]*m/g, "");
}

function renderPanel(h: Harness, result: unknown, options: { expanded: boolean; isPartial?: boolean }, width = 160): string[] {
	const tool = h.tools.get("subagent");
	assert.ok(tool?.renderResult, "subagent renderResult is registered");
	const component = tool.renderResult!(
		result as any,
		{ expanded: options.expanded, isPartial: options.isPartial ?? false },
		renderTheme,
		{},
	);
	return (component.render(width) as string[]).map((line) => stripAnsi(line).trimEnd());
}

/** Start a controlled panel run, optionally capturing its streaming emits. */
function startPanelRun(
	h: Harness,
	cwd: string,
	updates?: any[],
): { recording: ReturnType<typeof installControlledSpawn>; promise: Promise<any> } {
	const recording = installControlledSpawn();
	const promise = h.tools.get("subagent")!.execute(
		"id",
		{ panel: "pair", task: "shared task" },
		undefined,
		updates ? (partial: any) => updates.push(partial) : undefined,
		toolCtx(cwd),
	) as Promise<any>;
	return { recording, promise };
}

test("the collapsed panel row reproduces the merged content with only metadata lines dimmed", async () => {
	await withIsolatedAgents(async (cwd, agentDir) => {
		panelConfig(agentDir, { judge: "p/judge" });
		const h = makeHarness({ guard: true, tools: ["read"] });
		const { result, recording } = await runAnsweredPanel(h, cwd);
		try {
			assert.equal(result.content[0].text.includes("\u001b"), false, "model-facing content stays ANSI-free");
			assert.deepEqual(renderPanel(h, result, { expanded: false }), [
				"[success]✓ [dim]Panel pair (1 model; judge: p/judge)",
				"[dim]single-model-merge: only p/a answered",
				"",
				"merged review",
				"",
				"[dim]- p/a: 1 turn ↑1 ↓1 $0.0001 ctx:2",
				"[dim]- judge p/judge: 1 turn ↑1 ↓1 $0.0001",
				"",
				"[dim]Total: 2 turns ↑2 ↓2 $0.0002",
				"[muted](Ctrl+O to expand)",
			]);
		} finally { recording.restore(); }
	});
});

test("the expanded panel row shows the merged review, one section per panelist, the judge, and the total", async () => {
	await withIsolatedAgents(async (cwd, agentDir) => {
		panelConfig(agentDir, { judge: "p/judge" });
		const h = makeHarness({ guard: true, tools: ["read"] });
		const { result, recording } = await runAnsweredPanel(h, cwd);
		try {
			assert.deepEqual(renderPanel(h, result, { expanded: true }), [
				"[success]✓ [toolTitle][bold]Panel pair[muted] (1 model; judge: p/judge)",
				"[dim]single-model-merge: only p/a answered",
				"",
				"[dim]Task: shared task",
				"",
				"[muted]─── merged review ───",
				"merged review",
				"",
				"[muted]─── [accent]p/a [success]✓",
				"",
				"panelist answer",
				"[dim]1 turn ↑1 ↓1 $0.0001 ctx:2",
				"",
				"[muted]─── [accent]judge p/judge [success]✓",
				"",
				"merged review",
				"[dim]1 turn ↑1 ↓1 $0.0001",
				"",
				"[dim]Total: 2 turns ↑2 ↓2 $0.0002",
			]);
		} finally { recording.restore(); }
	});
});

test("a running panel derives progress from details, marking pending models and the judge", async () => {
	await withIsolatedAgents(async (cwd, agentDir) => {
		configure(agentDir, { panels: { pair: { models: ["p/a", "p/org/b"], judge: "p/judge" } } });
		const h = makeHarness({ guard: true, tools: ["read"] });
		const updates: any[] = [];
		const { recording, promise } = startPanelRun(h, cwd, updates);
		try {
			await waitFor(() => recording.spawns.length === 2, "both panelists spawn");
			const a = recording.spawns.find((spawn) => flag(spawn.args, "--model") === "p/a")!;
			a.child.stdout.emit("data", assistantLine("partial a"));
			await waitFor(() => updates.length > 0, "no streamed update");
			const update = updates[updates.length - 1];
			assert.deepEqual(renderPanel(h, update, { expanded: false, isPartial: true }), [
				"[warning]⏳ [toolTitle][bold]Panel pair[muted] (2 models; judge: p/judge)[accent] 0/2 done, 2 running",
				"[warning]⏳ [accent]p/a",
				"[warning]⏳ [accent]p/org/b",
			]);
			assert.deepEqual(renderPanel(h, update, { expanded: true, isPartial: true }), [
				"[warning]⏳ [toolTitle][bold]Panel pair[muted] (2 models; judge: p/judge)",
				"",
				"[dim]Task: shared task",
				"",
				"[muted]─── [accent]p/a [warning]⏳",
				"",
				"partial a",
				"",
				"[muted]─── [accent]p/org/b [warning]⏳",
				"",
				"[dim]Total: 1 turn ↑1 ↓1 $0.0001",
			]);
			for (const spawn of recording.spawns) emitAnswer(spawn, `${flag(spawn.args, "--model")} answer`);
			await waitFor(() => recording.spawns.length === 3, "judge never spawned");
			emitAnswer(recording.spawns[2], "merged review");
			await promise;
		} finally { recording.restore(); }
	});
});

test("an unmerged panel skips the merge slot and marks the judge failed with each attempt", async () => {
	await withIsolatedAgents(async (cwd, agentDir) => {
		configure(agentDir, { panels: { pair: { models: ["p/a", "p/org/b"], judge: "p/judge" } } });
		const h = makeHarness({ guard: true, tools: ["read"] });
		const { recording, promise } = startPanelRun(h, cwd);
		try {
			await waitFor(() => recording.spawns.length === 2, "both panelists spawn");
			for (const spawn of recording.spawns) emitAnswer(spawn, `${flag(spawn.args, "--model")} answer`);
			await waitFor(() => recording.spawns.length === 3, "judge never spawned");
			failAnswer(recording.spawns[2], "judge exploded");
			await waitFor(() => recording.spawns.length === 4, "judge retry never spawned");
			failAnswer(recording.spawns[3], "judge exploded again");
			const lines = renderPanel(h, await promise, { expanded: true });
			assert.deepEqual(lines, [
				"[warning]◐ [toolTitle][bold]Panel pair[muted] (2 models; judge: p/judge)",
				"[dim]merge-failed: judge exploded again",
				"",
				"[dim]Task: shared task",
				"",
				"[muted]─── [accent]p/a [success]✓",
				"",
				"p/a answer",
				"[dim]1 turn ↑1 ↓1 $0.0001 ctx:2",
				"",
				"[muted]─── [accent]p/org/b [success]✓",
				"",
				"p/org/b answer",
				"[dim]1 turn ↑1 ↓1 $0.0001 ctx:2",
				"",
				"[muted]─── [accent]judge p/judge [error]✗[muted] (2 attempts)",
				"[muted]attempt 1",
				"[dim]Error: judge exploded",
				"[muted]attempt 2",
				"[dim]Error: judge exploded again",
				"[dim]no usage",
				"",
				"[dim]Total: 2 turns ↑2 ↓2 $0.0002",
			]);
			assert.equal(lines.some((line) => line.includes("merged review")), false, "the merge slot is skipped");
		} finally { recording.restore(); }
	});
});

test("the judge retry is labeled and each attempt keeps its error", async () => {
	await withIsolatedAgents(async (cwd, agentDir) => {
		panelConfig(agentDir, { judge: "p/judge" });
		const h = makeHarness({ guard: true, tools: ["read"] });
		const { recording, promise } = startPanelRun(h, cwd);
		try {
			await waitFor(() => recording.spawns.length === 1, "panelist never spawned");
			emitAnswer(recording.spawns[0], "panelist answer");
			await waitFor(() => recording.spawns.length === 2, "judge never spawned");
			failAnswer(recording.spawns[1], "judge exploded");
			await waitFor(() => recording.spawns.length === 3, "judge retry never spawned");
			emitAnswer(recording.spawns[2], "merged review attempt");
			assert.deepEqual(renderPanel(h, await promise, { expanded: true }), [
				"[success]✓ [toolTitle][bold]Panel pair[muted] (1 model; judge: p/judge)",
				"[dim]single-model-merge: only p/a answered",
				"",
				"[dim]Task: shared task",
				"",
				"[muted]─── merged review ───",
				"merged review attempt",
				"",
				"[muted]─── [accent]p/a [success]✓",
				"",
				"panelist answer",
				"[dim]1 turn ↑1 ↓1 $0.0001 ctx:2",
				"",
				"[muted]─── [accent]judge p/judge [success]✓[muted] (2 attempts)",
				"[muted]attempt 1",
				"[dim]Error: judge exploded",
				"[muted]attempt 2",
				"",
				"merged review attempt",
				"[dim]1 turn ↑1 ↓1 $0.0001",
				"",
				"[dim]Total: 2 turns ↑2 ↓2 $0.0002",
			]);
		} finally { recording.restore(); }
	});
});

test("a panel with no panelist results falls back to the model-facing content", () => {
	const h = makeHarness();
	const result = {
		content: [{ type: "text", text: "Panel (unknown): preflight failure" }],
		details: {
			mode: "panel",
			agentScope: "user",
			projectAgentsDir: null,
			panel: undefined,
			results: [],
			judge: null,
			notices: [],
			mergedOutput: null,
		},
	};
	assert.deepEqual(renderPanel(h, result, { expanded: false }), ["Panel (unknown): preflight failure"]);
	assert.deepEqual(renderPanel(h, result, { expanded: true }), ["Panel (unknown): preflight failure"]);
});

test("streaming panel emits carry no notices; the finished result carries the real ones", async () => {
	await withIsolatedAgents(async (cwd, agentDir) => {
		configure(agentDir, { panels: { pair: { models: ["p/a", "p/org/b"], judge: "p/judge" } } });
		const h = makeHarness({ guard: true, tools: ["read"] });

		// One survivor then a failed merge: merge-failed must not appear mid-run.
		{
			const updates: any[] = [];
			const { recording, promise } = startPanelRun(h, cwd, updates);
			try {
				await waitFor(() => recording.spawns.length === 2, "both panelists spawn");
				const panelistA = recording.spawns.find((spawn) => flag(spawn.args, "--model") === "p/a")!;
				// A streamed child reports exit code 0 of its own, so the slot must stay
				// pending until its final result; otherwise a mid-run row counts it done.
				panelistA.child.stdout.emit("data", assistantLine("partial a"));
				await waitFor(() => updates.length > 0, "no streamed update");
				assert.equal(
					updates[updates.length - 1].details.results[0].exitCode,
					-1,
					"a panelist that has only streamed stays pending",
				);
				emitAnswer(panelistA, "answer A");
				failAnswer(recording.spawns.find((spawn) => flag(spawn.args, "--model") === "p/org/b")!, "b exploded");
				await waitFor(() => recording.spawns.length === 3, "judge never spawned");
				failAnswer(recording.spawns[2], "judge exploded");
				await waitFor(() => recording.spawns.length === 4, "judge retry never spawned");
				failAnswer(recording.spawns[3], "judge exploded");
				const result = await promise;
				assert.ok(updates.length > 0, "at least one streaming emit");
				for (const update of updates) assert.deepEqual(update.details.notices, [], "mid-run notices stay empty");
				assert.deepEqual(result.details.notices.map((notice: any) => notice.kind), ["merge-failed"]);
			} finally { recording.restore(); }
		}

		// Every panelist fails: no-survivors must not appear before the run ends.
		{
			const updates: any[] = [];
			const { recording, promise } = startPanelRun(h, cwd, updates);
			try {
				await waitFor(() => recording.spawns.length === 2, "both panelists spawn");
				for (const spawn of recording.spawns) failAnswer(spawn, "panelist exploded");
				const result = await promise;
				assert.ok(updates.length > 0, "at least one streaming emit");
				for (const update of updates) assert.deepEqual(update.details.notices, [], "mid-run notices stay empty");
				assert.deepEqual(result.details.notices.map((notice: any) => notice.kind), ["no-survivors"]);
			} finally { recording.restore(); }
		}
	});
});

// ── Child lifecycle: timeout, escalation, signal exits, and abort ─────────────

test("the ten-minute timeout sends SIGTERM then SIGKILL five seconds later while killed is true", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	await withIsolatedAgents(async (cwd, agentDir) => {
		panelConfig(agentDir, { judge: null });
		const h = makeHarness({ guard: true, tools: ["read"] });
		const recording = installControlledSpawn();
		try {
			const promise = runSubagent(h, cwd, { panel: "pair", task: "t" });
			await waitFor(() => recording.spawns.length === 1);
			const child = recording.spawns[0].child;
			t.mock.timers.tick(TEN_MINUTES_MS);
			assert.deepEqual(child.killedWith, ["SIGTERM"]);
			assert.equal(child.killed, true, "SIGTERM already set killed, so escalation must not rely on it");
			t.mock.timers.tick(KILL_GRACE_MS);
			assert.deepEqual(child.killedWith, ["SIGTERM", "SIGKILL"]);
			child.emit("close", null, "SIGKILL");
			const result = (await promise) as any;
			assert.equal(result.isError, true);
			assert.equal(result.details.results[0].terminationReason, "timeout");
			assert.equal(result.details.results[0].exitCode, 1);
			assert.equal(result.details.results[0].errorMessage, "timed out after 10 minutes");
			assert.equal(result.details.results[0].exitSignal, "SIGKILL");
			assert.deepEqual(result.details.notices.map((n: any) => n.kind), ["no-survivors"]);
			assert.ok(result.content[0].text.includes("timed out after 10 minutes"));
		} finally { recording.restore(); }
	});
});

test("a real exit during the grace period prevents SIGKILL", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	await withIsolatedAgents(async (cwd, agentDir) => {
		panelConfig(agentDir, { judge: null });
		const h = makeHarness({ guard: true, tools: ["read"] });
		const recording = installControlledSpawn();
		try {
			const promise = runSubagent(h, cwd, { panel: "pair", task: "t" });
			await waitFor(() => recording.spawns.length === 1);
			const child = recording.spawns[0].child;
			t.mock.timers.tick(TEN_MINUTES_MS);
			assert.deepEqual(child.killedWith, ["SIGTERM"]);
			child.emit("exit", null, "SIGTERM");
			t.mock.timers.tick(KILL_GRACE_MS);
			assert.deepEqual(child.killedWith, ["SIGTERM"], "an actual exit cancels the escalation");
			child.emit("close", null, "SIGTERM");
			const result = (await promise) as any;
			assert.equal(result.details.results[0].terminationReason, "timeout");
			assert.equal(result.details.results[0].exitCode, 1);
		} finally { recording.restore(); }
	});
});

test("a null-code signal close is a nonzero failure, never a success", async () => {
	await withIsolatedAgents(async (cwd, agentDir) => {
		panelConfig(agentDir, { judge: null });
		const h = makeHarness({ guard: true, tools: ["read"] });
		const recording = installControlledSpawn();
		try {
			const promise = runSubagent(h, cwd, { panel: "pair", task: "t" });
			await waitFor(() => recording.spawns.length === 1);
			recording.spawns[0].child.emit("close", null, "SIGKILL");
			const result = (await promise) as any;
			assert.equal(result.isError, true);
			assert.equal(result.details.results[0].exitCode, 1);
			assert.equal(result.details.results[0].exitSignal, "SIGKILL");
			assert.equal(result.details.results[0].terminationReason, undefined);
		} finally { recording.restore(); }
	});
});

test("normal completion clears the timeout timer and the kill listeners", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	await withIsolatedAgents(async (cwd, agentDir) => {
		panelConfig(agentDir, { judge: null });
		const h = makeHarness({ guard: true, tools: ["read"] });
		const recording = installControlledSpawn();
		try {
			const promise = runSubagent(h, cwd, { panel: "pair", task: "t" });
			await waitFor(() => recording.spawns.length === 1);
			const child = recording.spawns[0].child;
			emitAnswer(recording.spawns[0], "done");
			const result = (await promise) as any;
			assert.equal(result.isError, false);
			assert.equal(child.listenerCount("exit"), 0, "the kill controller removed its exit listener");
			t.mock.timers.tick(TEN_MINUTES_MS + KILL_GRACE_MS);
			assert.deepEqual(child.killedWith, []);
		} finally { recording.restore(); }
	});
});

test("legacy single, tasks, and chain modes never acquire the ten-minute timer", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	await withIsolatedAgents(async (cwd, agentDir) => {
		declaredAgent(path.join(agentDir, "agents"), "plain", "read");
		const h = makeHarness({ guard: true, tools: ["read"] });
		for (const params of [
			{ agent: "plain", task: "x" },
			{ tasks: [{ agent: "plain", task: "x" }] },
			{ chain: [{ agent: "plain", task: "x" }] },
		]) {
			const recording = installControlledSpawn();
			try {
				const promise = runSubagent(h, cwd, params);
				await waitFor(() => recording.spawns.length === 1);
				emitAnswer(recording.spawns[0], "done");
				const result = await promise;
				assert.notEqual(result.isError, true);
				t.mock.timers.tick(TEN_MINUTES_MS + KILL_GRACE_MS);
				assert.deepEqual(recording.spawns[0].child.killedWith, []);
			} finally { recording.restore(); }
		}
	});
});

test("abort uses the same functioning escalation path", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	await withIsolatedAgents(async (cwd, agentDir) => {
		panelConfig(agentDir, { judge: null });
		const h = makeHarness({ guard: true, tools: ["read"] });
		const recording = installControlledSpawn();
		try {
			const controller = new AbortController();
			const promise = h.tools.get("subagent")!.execute("id", { panel: "pair", task: "t" }, controller.signal, undefined, toolCtx(cwd));
			await waitFor(() => recording.spawns.length === 1);
			const child = recording.spawns[0].child;
			controller.abort();
			assert.deepEqual(child.killedWith, ["SIGTERM"]);
			t.mock.timers.tick(KILL_GRACE_MS);
			assert.deepEqual(child.killedWith, ["SIGTERM", "SIGKILL"]);
			child.emit("close", null, "SIGTERM");
			await assert.rejects(promise, /aborted/);
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

test("panel validation names the config file when no preset is usable", async () => {
	await withIsolatedAgents(async (cwd, agentDir) => {
		const h = makeHarness({ guard: true, tools: ["read"] });
		const recording = installRecordingSpawn();
		const configPath = path.join(agentDir, "subagent.json");
		try {
			// No config at all: the error has to say where a preset would go.
			const missing = await runSubagent(h, cwd, { panel: "review", task: "x" }, { scopedModels });
			assert.equal(missing.isError, true);
			assert.match(missing.content[0].text, /No panel presets are configured\./);
			assert.ok(missing.content[0].text.includes(configPath), "names the config file to create");
			assert.match(missing.content[0].text, /"panels" object/);
			assert.match(missing.content[0].text, /1 to 4 model ids/);

			// Presets configured but all rejected: name the file and the reasons.
			configure(agentDir, { panels: { broken: { models: [] } } });
			const ignored = await runSubagent(h, cwd, { panel: "broken", task: "x" }, { scopedModels });
			assert.equal(ignored.isError, true);
			assert.match(ignored.content[0].text, /No usable panel preset "broken"/);
			assert.ok(ignored.content[0].text.includes(configPath), "names the config file that holds the ignored preset");
			assert.match(ignored.content[0].text, /"models" should contain 1 to 4 non-empty model strings/);

			// A configured preset still reports its name and the file it came from.
			configure(agentDir, { panels: { pair: { models: ["p/a"] } } });
			const unknown = await runSubagent(h, cwd, { panel: "missing", task: "x" }, { scopedModels });
			assert.match(unknown.content[0].text, /Unknown panel "missing"\. Configured presets: pair/);
			assert.ok(unknown.content[0].text.includes(`(from ${configPath})`), "names where the presets come from");

			assert.equal(recording.spawns.length, 0, "no validation failure spawns a child");
		} finally { recording.restore(); }
	});
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
	assert.ok(template.includes("subagent.json"), "the no-preset path says where presets are configured");
});

// ── Cleanup ───────────────────────────────────────────────────────────────────

test("cleanup", () => {
	cleanupHarness();
});
