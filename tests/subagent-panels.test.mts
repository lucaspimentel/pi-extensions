// Pure panel helpers and serial, hermetic discovery tests. No registered-tool harness or child processes.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	discoverAgents,
	formatPanelCatalog,
	formatPanelList,
	parsePanels,
} from "../extensions/subagent/agents.ts";
import type { AgentScope } from "../extensions/subagent/agents.ts";
import {
	buildPanelJudgeInput,
	buildPanelistBlock,
	buildToolCallSummary,
	PER_TASK_OUTPUT_CAP,
	truncateTaskOutput,
	type PanelReviewInput,
} from "../extensions/subagent/panel.ts";

function fixture(run: (f: {
	cwd: string;
	user: string;
	project: string;
	configPath: string;
	warnings: unknown[][];
	config(value: unknown): void;
	discover(scope?: AgentScope): ReturnType<typeof discoverAgents>;
}) => void): void {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-panels-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	const previousWarn = console.warn;
	const warnings: unknown[][] = [];
	try {
		const agentDir = path.join(root, "user");
		const cwd = path.join(root, "project");
		const user = path.join(agentDir, "agents");
		const project = path.join(cwd, ".pi", "agents");
		fs.mkdirSync(user, { recursive: true });
		fs.mkdirSync(project, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = agentDir;
		console.warn = (...args: unknown[]) => { warnings.push(args); };
		const configPath = path.join(agentDir, "subagent.json");
		run({
			cwd, user, project, configPath, warnings,
			config: (value) => fs.writeFileSync(configPath, JSON.stringify(value)),
			discover: (scope = "both") => discoverAgents(cwd, scope),
		});
	} finally {
		console.warn = previousWarn;
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		fs.rmSync(root, { recursive: true, force: true });
	}
}

function agent(dir: string, name: string, frontmatter = "", body = "Replacement prompt."): void {
	fs.writeFileSync(path.join(dir, `${name}.md`), `---\nname: ${name}\ndescription: Replacement description.\n${frontmatter}---\n${body}\n`);
}

for (const raw of [undefined, {}]) {
	test(`empty panel configuration: ${JSON.stringify(raw)}`, () => {
		assert.deepEqual(parsePanels(raw), { panels: [], ignoredPanels: [] });
	});
}

for (const raw of [null, [], "presets", 4, true]) {
	test(`reject malformed panel map: ${JSON.stringify(raw)}`, () => {
		assert.deepEqual(parsePanels(raw), {
			panels: [],
			ignoredPanels: [{ name: "panels", reason: '[subagent] "panels" should be an object of preset name -> panel' }],
		});
	});
}

const invalidPresets = [
	null, [], "x", 1, false, {}, { models: null }, { models: "x" }, { models: [] },
	{ models: [""] }, { models: [" \t"] }, { models: [1] }, { models: [null] }, { models: [["x"]] },
	{ models: ["x"], agent: "" }, { models: ["x"], agent: " " }, { models: ["x"], agent: null },
	{ models: ["x"], agent: [] }, { models: ["x"], agent: 1 },
	{ models: ["x"], judge: "" }, { models: ["x"], judge: " " }, { models: ["x"], judge: false },
	{ models: ["x"], judge: [] }, { models: ["x"], judge: {} }, { models: ["x"], judge: 1 },
];
for (const [index, value] of invalidPresets.entries()) {
	test(`reject malformed preset independently: ${index}`, () => {
		const result = parsePanels({ invalid: value, valid: { models: ["x"] } });
		assert.deepEqual(result.panels.map((p) => p.name), ["valid"]);
		assert.equal(result.ignoredPanels.length, 1);
		assert.equal(result.ignoredPanels[0].name, "invalid");
		assert.match(result.ignoredPanels[0].reason, /^\[subagent\] panels\."invalid": /);
	});
}

test("defaults retain omission separately from resolved values", () => {
	assert.deepEqual(parsePanels({ ask: { models: ["x"] } }), {
		panels: [{ name: "ask", models: ["x"], agent: "panelist", judge: undefined,
			raw: { models: ["x"], agent: null, judge: null, judgeExplicit: false }, diagnostics: [] }],
		ignoredPanels: [],
	});
});

test("four configured models are accepted", () => {
	assert.deepEqual(parsePanels({ ask: { models: ["a", "b", "c", "d"] } }).panels[0].models, ["a", "b", "c", "d"]);
});
for (const models of [["a", "b", "c", "d", "e"], ["a", "a", "a", "a", "a"]]) {
	test(`configured cap is checked before deduplication: ${models.join(",")}`, () => {
		const result = parsePanels({ ask: { models } });
		assert.equal(result.panels.length, 0);
		assert.equal(result.ignoredPanels[0].reason, '[subagent] panels."ask": "models" exceeds the cap of 4 entries');
	});
}

test("normalization preserves first occurrence order and verbatim raw configuration without mutation", () => {
	const models = Object.freeze([" b ", "a", " b ", "c"]);
	const raw = Object.freeze({ review: Object.freeze({ models, agent: " reviewer ", judge: " model/judge " }) });
	const result = parsePanels(raw);
	const panel = result.panels[0];
	assert.deepEqual(panel.models, ["b", "a", "c"]);
	assert.deepEqual(panel.raw.models, models);
	assert.notEqual(panel.raw.models, models);
	assert.equal(panel.agent, "reviewer");
	assert.equal(panel.raw.agent, " reviewer ");
	assert.equal(panel.judge, "model/judge");
	assert.equal(panel.raw.judge, " model/judge ");
	assert.deepEqual(panel.diagnostics, ['[subagent] panels."review": duplicate model IDs removed; preset retained']);
	assert.deepEqual(result.ignoredPanels, []);
});

for (const judge of ["provider/model", "none", null]) {
	test(`explicit judge: ${JSON.stringify(judge)}`, () => {
		const panel = parsePanels({ ask: { models: ["x"], judge } }).panels[0];
		assert.equal(panel.judge, judge === "none" ? null : judge);
		assert.equal(panel.raw.judge, judge);
		assert.equal(panel.raw.judgeExplicit, true);
	});
}

test("sparse and undefined model entries are invalid", () => {
	for (const models of [new Array(1), [undefined]]) {
		assert.equal(parsePanels({ ask: { models } }).ignoredPanels.length, 1);
	}
});

test("explicit undefined optional fields are invalid, not omitted", () => {
	for (const entry of [{ models: ["x"], agent: undefined }, { models: ["x"], judge: undefined }]) {
		assert.equal(parsePanels({ ask: entry }).ignoredPanels.length, 1);
	}
});

test("discovery without config or panels preserves models and emits no panel metadata or warnings", { concurrency: false }, () => fixture((f) => {
	assert.deepEqual(f.discover().panels, []);
	assert.deepEqual(f.discover().ignoredPanels, []);
	f.config({ models: { scout: " pinned/model " } });
	const result = f.discover();
	assert.equal(result.agents.find((a) => a.name === "scout")?.model, "pinned/model");
	assert.deepEqual(result.panels, []);
	assert.deepEqual(f.warnings, []);
}));

test("unknown agents and duplicates warn but retain usable raw presets", { concurrency: false }, () => fixture((f) => {
	f.config({ panels: { ask: { models: ["a", "a"], agent: "absent" } } });
	const result = f.discover();
	assert.equal(result.panels.length, 1);
	assert.deepEqual(result.ignoredPanels, []);
	assert.deepEqual(result.panels[0].raw.models, ["a", "a"]);
	assert.equal(result.panels[0].raw.agent, "absent");
	assert.deepEqual(result.panels[0].diagnostics, [
		'[subagent] panels."ask": duplicate model IDs removed; preset retained',
		'[subagent] panels."ask": no agent named "absent"; preset retained',
	]);
	assert.deepEqual(f.warnings, result.panels[0].diagnostics.map((d) => [d]));
}));

test("discovery defers model availability, internal-agent suitability, and read-only checks", { concurrency: false }, () => fixture((f) => {
	f.config({ panels: {
		internal: { models: ["unavailable/model"], agent: "judge" },
		writeCapable: { models: ["unavailable/model"], agent: "worker" },
	} });
	const result = f.discover();
	assert.deepEqual(result.panels.map((p) => p.name), ["internal", "writeCapable"]);
	assert.deepEqual(result.ignoredPanels, []);
	assert.deepEqual(f.warnings, []);
}));

test("every rejected reason is exactly the single argument written to stderr", { concurrency: false }, () => fixture((f) => {
	for (const panels of [null, [], 1, ...invalidPresets.map((p) => ({ bad: p })), { bad: { models: ["a", "a", "a", "a", "a"] } }]) {
		f.warnings.length = 0;
		f.config({ panels });
		const result = f.discover();
		assert.ok(result.ignoredPanels.length > 0);
		assert.deepEqual(f.warnings, result.ignoredPanels.map((p) => [p.reason]));
	}
}));

const researcherTools = ["read", "ffgrep", "fffind", "ls", "git_read", "gh_read", "web_fetch", "web_search", "slack_search", "slack_read_channel", "slack_read_thread", "session_search", "session_excerpt", "memory_read", "memory_search", "memory_status"];
test("bundled panel agents have exact tools, resolved roles, and no model pin", { concurrency: false }, () => fixture((f) => {
	const agents = f.discover().agents;
	const panelist = agents.find((a) => a.name === "panelist")!;
	const judge = agents.find((a) => a.name === "judge")!;
	assert.deepEqual(panelist.tools, researcherTools);
	assert.deepEqual(panelist.tools, agents.find((a) => a.name === "researcher")?.tools);
	assert.deepEqual(judge.tools, ["read", "ffgrep", "fffind", "ls", "git_read", "gh_read"]);
	assert.equal(panelist.role, "delegate");
	assert.equal(judge.role, "internal");
	assert.equal(panelist.model, undefined);
	assert.equal(judge.model, undefined);
	assert.doesNotMatch(fs.readFileSync(panelist.filePath, "utf8").split("---")[1], /^role:|^model:/m);
	assert.doesNotMatch(fs.readFileSync(judge.filePath, "utf8").split("---")[1], /^model:/m);
	assert.ok(agents.filter((a) => a.name !== "judge").every((a) => a.role === "delegate"));
}));

for (const role of ["delegate", "internal"]) {
	test(`explicit ${role} overrides bundled judge role`, { concurrency: false }, () => fixture((f) => {
		agent(f.user, "judge", `role: ${role}\n`);
		assert.equal(f.discover().agents.find((a) => a.name === "judge")?.role, role);
		agent(f.project, "judge");
		assert.equal(f.discover().agents.find((a) => a.name === "judge")?.role, role);
		agent(f.project, "judge", `role: ${role === "delegate" ? "internal" : "delegate"}\n`);
		assert.equal(f.discover().agents.find((a) => a.name === "judge")?.role, role === "delegate" ? "internal" : "delegate");
	}));
}

for (const role of ["INTERNAL", "unknown", "null", "42", "true", "[internal]", "{value: internal}", '" internal "']) {
	test(`malformed optional role is undeclared: ${role}`, { concurrency: false }, () => fixture((f) => {
		agent(f.user, "custom", `role: ${role}\n`);
		agent(f.user, "judge", `role: ${role}\n`);
		const result = f.discover();
		assert.equal(result.agents.find((a) => a.name === "custom")?.role, "delegate");
		assert.equal(result.agents.find((a) => a.name === "judge")?.role, "internal");
		assert.deepEqual(f.warnings, []);
	}));
}

test("role inheritance preserves whole-object replacement of all non-role fields", { concurrency: false }, () => fixture((f) => {
	agent(f.user, "custom", "role: internal\ntools: read\nmodel: user/model\n", "User prompt.");
	agent(f.project, "custom");
	const custom = f.discover().agents.find((a) => a.name === "custom")!;
	assert.equal(custom.role, "internal");
	assert.equal(custom.tools, undefined);
	assert.equal(custom.model, undefined);
	assert.equal(custom.systemPrompt.trim(), "Replacement prompt.");
	assert.equal(custom.description, "Replacement description.");
	assert.equal(custom.source, "project");
	assert.equal(custom.filePath, path.join(f.project, "custom.md"));
	agent(f.user, "judge");
	assert.equal(f.discover().agents.find((a) => a.name === "judge")?.role, "internal");
}));

test("scope exclusions cannot contribute roles or resolve panel agents", { concurrency: false }, () => fixture((f) => {
	agent(f.user, "custom", "role: internal\n");
	agent(f.project, "custom");
	agent(f.project, "project-only", "role: internal\n");
	agent(f.user, "judge", "role: delegate\n");
	agent(f.project, "judge");
	assert.equal(f.discover("project").agents.find((a) => a.name === "custom")?.role, "delegate");
	assert.equal(f.discover("both").agents.find((a) => a.name === "custom")?.role, "internal");
	assert.equal(f.discover("project").agents.find((a) => a.name === "judge")?.role, "internal");
	assert.equal(f.discover("user").agents.find((a) => a.name === "judge")?.role, "delegate");
	assert.equal(f.discover("user").agents.some((a) => a.name === "project-only"), false);
	f.config({ panels: { ask: { models: ["x"], agent: "project-only" } } });
	assert.equal(f.discover("user").panels[0].diagnostics.length, 1);
	assert.deepEqual(f.discover("both").panels[0].diagnostics, []);
}));

test("model overrides retain precedence while panels are processed independently", { concurrency: false }, () => fixture((f) => {
	agent(f.user, "scout", "model: user/model\n");
	agent(f.project, "scout", "model: project/model\n");
	assert.equal(f.discover().agents.find((a) => a.name === "scout")?.model, "project/model");
	f.config({ models: { scout: " override/model ", judge: "judge/model", absent: "x", worker: " " }, panels: { ask: { models: ["x"] } } });
	const result = f.discover();
	assert.equal(result.agents.find((a) => a.name === "scout")?.model, "override/model");
	assert.equal(result.agents.find((a) => a.name === "judge")?.model, "judge/model");
	assert.equal(result.panels.length, 1);
	assert.deepEqual(f.warnings, [
		[`[subagent] ${f.configPath}: no agent named "absent"; model override ignored`],
		[`[subagent] ${f.configPath}: models."worker" should be a non-empty model string`],
	]);
	for (const models of [null, "bad", [], ["x"]]) {
		f.warnings.length = 0;
		f.config({ models, panels: { ask: { models: ["x"] } } });
		assert.equal(f.discover().panels.length, 1);
		assert.deepEqual(f.warnings, models === null || models === "bad"
			? [[`[subagent] ${f.configPath}: "models" should be an object of agent name -> model`]]
			: models.length === 0 ? [] : [[`[subagent] ${f.configPath}: no agent named "0"; model override ignored`]]);
	}
	f.config({ models: { scout: "still/model" }, panels: null });
	assert.equal(f.discover().agents.find((a) => a.name === "scout")?.model, "still/model");
}));

test("configuration is reread on every discovery including edits, removal, and malformed JSON", { concurrency: false }, () => fixture((f) => {
	f.config({ models: { scout: "first" }, panels: { first: { models: ["a"] } } });
	assert.equal(f.discover().panels[0].name, "first");
	f.config({ models: { scout: "second" }, panels: { second: { models: ["b"] } } });
	const second = f.discover();
	assert.equal(second.panels[0].name, "second");
	assert.equal(second.agents.find((a) => a.name === "scout")?.model, "second");
	fs.writeFileSync(f.configPath, "{");
	assert.deepEqual(f.discover().panels, []);
	assert.deepEqual(f.warnings, [[`[subagent] could not read ${f.configPath}; configuration ignored`]]);
	fs.unlinkSync(f.configPath);
	f.warnings.length = 0;
	assert.deepEqual(f.discover().panels, []);
	assert.deepEqual(f.warnings, []);
}));

test("empty formatters follow their respective catalog and detailed-list conventions", () => {
	assert.equal(formatPanelCatalog([]), "");
	assert.deepEqual(formatPanelList([]), { text: "none", remaining: 0 });
});

test("catalog annotations and listing lines use readable values while raw fields stay raw", () => {
	const { panels } = parsePanels({
		a: { models: [" x ", "x", "y"] },
		b: { models: ["x"], agent: "reviewer", judge: "judge/model" },
		c: { models: ["x"], agent: "panelist", judge: "none" },
		d: { models: ["x"], judge: null },
	});
	assert.equal(formatPanelCatalog(panels), "a: x + y; b: x (judge: judge/model) (agent: reviewer); c: x (judge: none); d: x (judge: none)");
	assert.deepEqual(formatPanelList(panels), { text: [
		"a: panelist | x + y | judge: session model",
		"b: reviewer | x | judge: judge/model",
		"c: panelist | x | judge: none",
		"d: panelist | x | judge: none",
	].join("\n"), remaining: 0 });
	assert.deepEqual(panels.map((panel) => panel.raw), [
		{ models: [" x ", "x", "y"], agent: null, judge: null, judgeExplicit: false },
		{ models: ["x"], agent: "reviewer", judge: "judge/model", judgeExplicit: true },
		{ models: ["x"], agent: "panelist", judge: "none", judgeExplicit: true },
		{ models: ["x"], agent: null, judge: null, judgeExplicit: true },
	]);
});

test("catalog and detailed caps report exact remaining counts and pure suffix output", () => {
	const { panels } = parsePanels(Object.fromEntries(Array.from({ length: 103 }, (_, i) => [`p${String(i).padStart(3, "0")}`, { models: ["x"] }])));
	assert.equal(formatPanelCatalog(panels), Array.from({ length: 10 }, (_, i) => `p00${i}: x`).join("; ") + " (+93 more)");
	const list = formatPanelList(panels);
	assert.equal(list.remaining, 3);
	assert.equal(list.text.split("\n").length, 100);
	assert.ok(list.text.endsWith("p099: panelist | x | judge: session model"));
	assert.ok(`${list.text}\n(+${list.remaining} more)`.endsWith("\n(+3 more)"));
	assert.equal(formatPanelCatalog(panels, 1), "p000: x (+102 more)");
	assert.equal(formatPanelList(panels, 1).remaining, 102);
	assert.equal(formatPanelList(panels, 103).remaining, 0);
	assert.equal(formatPanelCatalog(panels, 103).includes("more)"), false);
});

test("formatting is byte stable, uses plain name ordering, and never mutates frozen input", () => {
	const { panels } = parsePanels(Object.fromEntries(["z", "a", "ä", "A", "Z"].map((name) => [name, { models: ["b", "a"] }])));
	const before = structuredClone(panels);
	for (const panel of panels) {
		Object.freeze(panel.models);
		Object.freeze(panel.raw.models);
		Object.freeze(panel.raw);
		Object.freeze(panel.diagnostics);
		Object.freeze(panel);
	}
	Object.freeze(panels);
	assert.equal(formatPanelCatalog(panels), "A: b + a; Z: b + a; a: b + a; z: b + a; ä: b + a");
	assert.equal(formatPanelCatalog([...panels].reverse()), formatPanelCatalog(panels));
	assert.deepEqual(formatPanelList([...panels].reverse()), formatPanelList(panels));
	assert.deepEqual(panels, before);
});

// ── Judge input blocks and the per-call tool summary (pure) ───────────────────

function toolCallAssistant(calls: Array<{ id: string; name: string; args?: Record<string, unknown> }>): any {
	return {
		role: "assistant",
		content: calls.map((call) => ({ type: "toolCall", id: call.id, name: call.name, arguments: call.args ?? {} })),
	};
}

function toolResultMessage(id: string, isError = false): any {
	return { role: "toolResult", toolCallId: id, toolName: "t", content: [], isError, timestamp: 0 };
}

test("judge input blocks have the settled structure, repeat the task, and keep configured order", () => {
	const reviews: PanelReviewInput[] = [
		{ model: "p/a", task: "Do the thing", toolCallSummary: "read src/a.ts", status: "completed", output: "Answer A" },
		{ model: "p/b", task: "Do the thing", toolCallSummary: "(none)", status: "failed", output: "Partial B", error: "provider boom" },
		{ model: "p/c", task: "Do the thing", toolCallSummary: "ffgrep BuildSampleRate", status: "completed", output: "Answer C" },
	];
	const input = buildPanelJudgeInput(reviews);
	assert.equal(
		input,
		[
			"### PANELIST p/a",
			"task: Do the thing",
			"tools: read src/a.ts",
			"status: completed",
			"",
			"Answer A",
			"",
			"### PANELIST p/b",
			"task: Do the thing",
			"tools: (none)",
			"status: failed",
			"error: provider boom",
			"[Incomplete partial answer:]",
			"Partial B",
			"",
			"### PANELIST p/c",
			"task: Do the thing",
			"tools: ffgrep BuildSampleRate",
			"status: completed",
			"",
			"Answer C",
		].join("\n"),
	);
	assert.equal(input.split("task: Do the thing").length - 1, 3, "task repeated once per block");
	assert.ok(input.indexOf("PANELIST p/a") < input.indexOf("PANELIST p/b"));
	assert.ok(input.indexOf("PANELIST p/b") < input.indexOf("PANELIST p/c"));
	assert.equal(input.includes("PANELIST"), true);
	assert.equal(buildPanelJudgeInput([reviews[2], reviews[0]]), `${buildPanelistBlock(reviews[2])}\n\n${buildPanelistBlock(reviews[0])}`);
	assert.equal(buildPanelJudgeInput([]), "");
});

test("the block header uses the effective requested label and a failed block labels its partial answer", () => {
	const review: PanelReviewInput = {
		model: "effective/model",
		task: "t",
		toolCallSummary: "(none)",
		status: "failed",
		output: "half an answer",
		error: "timed out after 10 minutes",
	};
	const block = buildPanelistBlock(review);
	assert.ok(block.startsWith("### PANELIST effective/model\ntask: t\ntools: (none)\nstatus: failed\nerror: timed out after 10 minutes\n"));
	assert.ok(block.includes("[Incomplete partial answer:]\nhalf an answer"));
	const empty: PanelReviewInput = { ...review, output: "" };
	assert.ok(buildPanelistBlock(empty).endsWith("[Incomplete partial answer:]\n"));
});

test("answers are capped at the shared 50 KiB budget with the legacy truncation annotation", () => {
	const exact = "A".repeat(PER_TASK_OUTPUT_CAP);
	assert.equal(truncateTaskOutput(exact), exact, "exactly at the cap is unchanged");

	const oversized = `${exact}A`;
	const truncated = truncateTaskOutput(oversized);
	assert.equal(truncated.slice(0, PER_TASK_OUTPUT_CAP), exact);
	assert.ok(truncated.includes("[Output truncated: 1 bytes omitted. Full output preserved in tool details.]"));
	assert.equal(oversized.length, PER_TASK_OUTPUT_CAP + 1, "the input string is untouched");

	const multibyte = "é".repeat(PER_TASK_OUTPUT_CAP);
	const clipped = truncateTaskOutput(multibyte);
	const [kept, annotation] = clipped.split("\n\n[Output truncated: ");
	assert.equal(Buffer.byteLength(kept, "utf8"), PER_TASK_OUTPUT_CAP);
	assert.equal(kept, "é".repeat(PER_TASK_OUTPUT_CAP / 2), "whole code points only");
	assert.ok(annotation.startsWith(`${PER_TASK_OUTPUT_CAP} bytes omitted.`));
	assert.equal(multibyte.length, PER_TASK_OUTPUT_CAP, "the input string is untouched");
});

test("capping preserves the original review strings", () => {
	const output = "A".repeat(PER_TASK_OUTPUT_CAP + 500);
	const review: PanelReviewInput = Object.freeze({ model: "m", task: "t", toolCallSummary: "(none)", status: "completed", output });
	const block = buildPanelistBlock(review);
	assert.equal(review.output, output);
	assert.ok(block.includes(`[Output truncated: 500 bytes omitted.`));
});

test("the judge input has no aggregate ceiling: each answer is capped independently", () => {
	const big = "A".repeat(60 * 1024);
	const input = buildPanelJudgeInput([
		{ model: "p/a", task: "t", toolCallSummary: "(none)", status: "completed", output: big },
		{ model: "p/b", task: "t", toolCallSummary: "(none)", status: "completed", output: big },
	]);
	assert.ok(Buffer.byteLength(input, "utf8") > 100 * 1024, "combined size exceeds the per-answer cap");
	assert.equal(input.split("[Output truncated:").length - 1, 2);
});

test("tool summaries group repetitions with counts in first-use order", () => {
	const messages = [
		toolCallAssistant([
			{ id: "1", name: "ffgrep", args: { pattern: "BuildSampleRate", path: "src" } },
			{ id: "2", name: "read", args: { file_path: "src/a.ts" } },
			{ id: "3", name: "ffgrep", args: { pattern: "BuildSampleRate", path: "src" } },
		]),
		toolResultMessage("1"),
		toolResultMessage("2"),
		toolResultMessage("3"),
	];
	assert.equal(buildToolCallSummary(messages), "ffgrep BuildSampleRate src x2, read src/a.ts");
});

test("differing arguments stay distinct even when display truncation hides the difference", () => {
	const prefix = "x".repeat(200);
	const messages = [
		toolCallAssistant([
			{ id: "1", name: "read", args: { file_path: `${prefix}a.ts` } },
			{ id: "2", name: "read", args: { file_path: `${prefix}b.ts` } },
		]),
	];
	const summary = buildToolCallSummary(messages);
	assert.equal(summary.includes(" x2"), false, "untruncated key arguments keep the calls apart");
	assert.equal(summary.split("read ").length - 1, 2);
});

test("failures are attributed only through a correlated tool result", () => {
	const messages = [
		toolCallAssistant([
			{ id: "1", name: "ffgrep", args: { pattern: "build" } },
			{ id: "2", name: "ffgrep", args: { pattern: "build" } },
			{ id: "3", name: "read", args: { file_path: "src/a.ts" } },
			{ id: "4", name: "ffgrep", args: { pattern: "build" } },
		]),
		toolResultMessage("1", true),
		toolResultMessage("2", false),
		// 3 and 4 have no result at all, so they are not failures.
	];
	assert.equal(buildToolCallSummary(messages), "ffgrep build x3 (1 failed), read src/a.ts");
});

test("the summary renders the first 20 distinct entries and a remainder count", () => {
	const calls = Array.from({ length: 25 }, (_, i) => ({
		id: `call-${i}`,
		name: "read",
		args: { file_path: `src/file-${String(i).padStart(2, "0")}.ts` },
	}));
	const summary = buildToolCallSummary([toolCallAssistant(calls)]);
	assert.equal(summary.split(", ").length, 20, "exactly 20 distinct entries are rendered");
	assert.ok(summary.endsWith(" (+5 more)"), "the 5 remaining distinct entries are counted");
	assert.ok(summary.includes("read src/file-00.ts"));
	assert.equal(summary.includes("read src/file-20.ts"), false);
});

test("displayed arguments are trimmed to the presentation cap", () => {
	const long = "p".repeat(150);
	const summary = buildToolCallSummary([toolCallAssistant([{ id: "1", name: "read", args: { file_path: long } }])]);
	assert.equal(summary, `read ${"p".repeat(80)}...`);
});

test("unknown tools use a deterministic small fallback selection", () => {
	const messages = [
		toolCallAssistant([
			{ id: "1", name: "custom_tool", args: { zeta: "z", alpha: 2, beta: true, gamma: "g", delta: "d", complex: { nested: 1 } } },
		]),
	];
	assert.equal(buildToolCallSummary(messages), "custom_tool alpha=2 beta=true delta=d gamma=g");
});

test("summaries are never built from tool-result bodies or a whole transcript", () => {
	assert.equal(buildToolCallSummary([]), "(none)");
	const messages = [
		toolCallAssistant([{ id: "1", name: "read", args: { file_path: "src/secret.ts" } }]),
		{
			role: "toolResult",
			toolCallId: "1",
			toolName: "read",
			content: [{ type: "text", text: "SECRET BODY" }],
			isError: false,
			timestamp: 0,
		},
	];
	const summary = buildToolCallSummary(messages);
	assert.equal(summary, "read src/secret.ts");
	assert.equal(summary.includes("SECRET"), false);
});

test("configuredModels exposes accepted configuration overrides only, never frontmatter pins", { concurrency: false }, () => fixture((f) => {
	agent(f.user, "judge", "model: frontmatter/judge\n");
	agent(f.user, "scout", "model: frontmatter/scout\n");
	assert.deepEqual(f.discover().configuredModels, {}, "a frontmatter pin is not a configured override");
	f.config({ models: { judge: " configured/judge ", scout: "configured/scout", absent: "x", worker: " " } });
	const result = f.discover();
	assert.deepEqual(result.configuredModels, { judge: "configured/judge", scout: "configured/scout" });
	assert.equal(result.agents.find((a) => a.name === "judge")?.model, "configured/judge");
	assert.equal(result.agents.find((a) => a.name === "worker")?.model, undefined);
}));
