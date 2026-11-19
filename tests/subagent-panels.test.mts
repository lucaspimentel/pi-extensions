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
	setDiagnosticSink,
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

/** The flat pre-2026-11-18 preset form, refused with a single migration reason. */
const legacyPresets = [
	{ models: ["x"] },
	{ models: ["x"], agent: "reviewer" },
	{ agent: "reviewer" },
	{ judge: "model/judge" },
	{ panelists: [{ model: "x" }], judge: "none" },
];
const MIGRATION_REASON =
	'"agent"/"models"/judge string form is no longer accepted; use "panelists": [{"agent": ..., "model": ...}] and "judge": {"agent": ..., "model": ...}';

const invalidPresets = [
	null, [], "x", 1, false, {},
	{ panelists: null }, { panelists: "x" }, { panelists: [] }, { panelists: {} },
	{ panelists: [{}] }, { panelists: [{ model: "" }] }, { panelists: [{ model: " \t" }] },
	{ panelists: [{ model: 1 }] }, { panelists: [{ model: null }] }, { panelists: [{ model: ["x"] }] },
	{ panelists: [null] }, { panelists: ["x"] },
	{ panelists: [{ model: "x" }, "y"] },
	{ panelists: [{ model: "x", agent: "" }] }, { panelists: [{ model: "x", agent: " " }] },
	{ panelists: [{ model: "x", agent: null }] }, { panelists: [{ model: "x", agent: [] }] },
	{ panelists: [{ model: "x", agent: 1 }] },
	{ panelists: [{ model: "x" }], judge: "" }, { panelists: [{ model: "x" }], judge: " " },
	{ panelists: [{ model: "x" }], judge: false }, { panelists: [{ model: "x" }], judge: [] },
	{ panelists: [{ model: "x" }], judge: 1 },
	{ panelists: [{ model: "x" }], judge: { agent: "" } },
	{ panelists: [{ model: "x" }], judge: { agent: 1 } }, { panelists: [{ model: "x" }], judge: { model: " " } },
];
for (const [index, value] of invalidPresets.entries()) {
	test(`reject malformed preset independently: ${index}`, () => {
		const result = parsePanels({ invalid: value, valid: { panelists: [{ model: "x" }] } });
		assert.deepEqual(result.panels.map((p) => p.name), ["valid"]);
		assert.equal(result.ignoredPanels.length, 1);
		assert.equal(result.ignoredPanels[0].name, "invalid");
		assert.match(result.ignoredPanels[0].reason, /^\[subagent\] panels\."invalid": /);
	});
}

for (const value of legacyPresets) {
	test(`reject the flat preset form: ${JSON.stringify(value)}`, () => {
		const result = parsePanels({ invalid: value, valid: { panelists: [{ model: "x" }] } });
		assert.deepEqual(result.panels.map((p) => p.name), ["valid"]);
		assert.deepEqual(result.ignoredPanels, [{ name: "invalid", reason: `[subagent] panels."invalid": ${MIGRATION_REASON}` }]);
	});
}

test("defaults retain omission separately from resolved values", () => {
	assert.deepEqual(parsePanels({ ask: { panelists: [{ model: "x" }] } }), {
		panels: [{ name: "ask", panelists: [{ agent: "panelist", model: "x" }], judge: undefined, diagnostics: [] }],
		ignoredPanels: [],
	});
});

test("four configured panelists are accepted", () => {
	const panelists = ["a", "b", "c", "d"].map((model) => ({ model }));
	assert.deepEqual(parsePanels({ ask: { panelists } }).panels[0].panelists.map((p) => p.model), ["a", "b", "c", "d"]);
});
for (const models of [["a", "b", "c", "d", "e"], ["a", "a", "a", "a", "a"]]) {
	test(`configured cap is checked before deduplication: ${models.join(",")}`, () => {
		const result = parsePanels({ ask: { panelists: models.map((model) => ({ model })) } });
		assert.equal(result.panels.length, 0);
		assert.equal(result.ignoredPanels[0].reason, '[subagent] panels."ask": "panelists" exceeds the cap of 4 entries');
	});
}

test("normalization trims every field, keeps first occurrence order, and never mutates frozen input", () => {
	const panelists = Object.freeze([
		Object.freeze({ model: " b " }),
		Object.freeze({ agent: " reviewer ", model: "a" }),
		Object.freeze({ model: " b " }),
		Object.freeze({ model: "c" }),
	]);
	const raw = Object.freeze({ review: Object.freeze({ panelists }) });
	const result = parsePanels(raw);
	const panel = result.panels[0];
	assert.deepEqual(panel.panelists, [
		{ agent: "panelist", model: "b" },
		{ agent: "reviewer", model: "a" },
		{ agent: "panelist", model: "c" },
	]);
	assert.deepEqual(panel.diagnostics, ['[subagent] panels."review": duplicate panelists removed; preset retained']);
	assert.deepEqual(result.ignoredPanels, []);
	assert.deepEqual(raw, { review: { panelists } });
});

test("the same model under two different agents is two panelists", () => {
	const panel = parsePanels({ ask: { panelists: [{ agent: "reviewer", model: "x" }, { agent: "researcher", model: "x" }] } }).panels[0];
	assert.deepEqual(panel.panelists, [{ agent: "reviewer", model: "x" }, { agent: "researcher", model: "x" }]);
	assert.deepEqual(panel.diagnostics, []);
});

for (const [judge, expected] of [
	[{}, { agent: "judge" }],
	[{ agent: "judge-review" }, { agent: "judge-review" }],
	[{ model: "p/judge" }, { agent: "judge", model: "p/judge" }],
	[{ agent: " judge-review ", model: " p/judge " }, { agent: "judge-review", model: "p/judge" }],
	[null, null],
] as const) {
	test(`explicit judge: ${JSON.stringify(judge)}`, () => {
		const panel = parsePanels({ ask: { panelists: [{ model: "x" }], judge } }).panels[0];
		assert.deepEqual(panel.judge, expected);
	});
}

test("an omitted judge resolves to undefined, which inherits the judge model chain", () => {
	assert.equal(parsePanels({ ask: { panelists: [{ model: "x" }] } }).panels[0].judge, undefined);
});

test("sparse and explicitly undefined panelist fields are invalid", () => {
	// An explicit `undefined` cannot arrive from the JSON config file, only from the
	// tool's inline panelists, so these cases are parsed directly.
	for (const panelists of [new Array(1), [{ model: "x", agent: undefined }], [{ model: undefined }]]) {
		assert.equal(parsePanels({ ask: { panelists } }).ignoredPanels.length, 1);
	}
});

test("explicit undefined optional fields are invalid, not omitted", () => {
	assert.equal(parsePanels({ ask: { panelists: [{ model: "x" }], judge: undefined } }).ignoredPanels.length, 1);
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

test("an installed diagnostic sink replaces the console for every discovery reason", { concurrency: false }, () => fixture((f) => {
	f.config({ panels: { ask: { panelists: [{ model: "x" }], judge: { agent: "worker" } }, bad: false } });
	const seen: string[] = [];
	setDiagnosticSink((reason) => seen.push(reason));
	let result: ReturnType<typeof discoverAgents>;
	try {
		result = f.discover();
		assert.deepEqual(seen, [
			...result.panels.flatMap((panel) => panel.diagnostics),
			...result.ignoredPanels.map((panel) => panel.reason),
		], "every reason reaches the sink, in discovery order");
		assert.deepEqual(f.warnings, [], "the console stays untouched while a sink is installed");
	} finally {
		setDiagnosticSink(null);
	}
	f.warnings.length = 0;
	assert.deepEqual(f.discover(), result, "discovery is unchanged by the sink");
	assert.equal(f.warnings.length, seen.length, "the console reports the same reasons once no sink is installed");
}));

test("unknown agents and duplicates warn but retain the resolved preset", { concurrency: false }, () => fixture((f) => {
	f.config({ panels: { ask: { panelists: [{ agent: "absent", model: "a" }, { agent: "absent", model: "a" }] } } });
	const result = f.discover();
	assert.equal(result.panels.length, 1);
	assert.deepEqual(result.ignoredPanels, []);
	assert.deepEqual(result.panels[0].panelists, [{ agent: "absent", model: "a" }]);
	assert.deepEqual(result.panels[0].diagnostics, [
		'[subagent] panels."ask": duplicate panelists removed; preset retained',
		'[subagent] panels."ask": no agent named "absent"; preset retained',
	]);
	assert.deepEqual(f.warnings, result.panels[0].diagnostics.map((d) => [d]));
}));

test("one diagnostic per distinct unresolved panelist agent", { concurrency: false }, () => fixture((f) => {
	f.config({ panels: { ask: { panelists: [{ agent: "absent", model: "a" }, { agent: "absent", model: "b" }, { agent: "gone", model: "c" }] } } });
	assert.deepEqual(f.discover().panels[0].diagnostics, [
		'[subagent] panels."ask": no agent named "absent"; preset retained',
		'[subagent] panels."ask": no agent named "gone"; preset retained',
	]);
}));

test("a configured judge agent is checked for existence and an internal role without rejecting the preset", { concurrency: false }, () => fixture((f) => {
	f.config({ panels: {
		missing: { panelists: [{ model: "x" }], judge: { agent: "absent" } },
		delegate: { panelists: [{ model: "x" }], judge: { agent: "worker" } },
		internal: { panelists: [{ model: "x" }], judge: { agent: "judge-review" } },
		inherited: { panelists: [{ model: "x" }] },
		disabled: { panelists: [{ model: "x" }], judge: null },
	} });
	const result = f.discover();
	assert.deepEqual(result.panels.map((p) => p.name), ["missing", "delegate", "internal", "inherited", "disabled"]);
	const diagnostics = Object.fromEntries(result.panels.map((p) => [p.name, p.diagnostics]));
	assert.deepEqual(diagnostics.missing, ['[subagent] panels."missing": no agent named "absent" for "judge.agent"; preset retained']);
	assert.deepEqual(diagnostics.delegate, ['[subagent] panels."delegate": "judge.agent" agent "worker" is not internal; preset retained']);
	assert.deepEqual(diagnostics.internal, []);
	assert.deepEqual(diagnostics.inherited, []);
	assert.deepEqual(diagnostics.disabled, []);
	assert.deepEqual(result.ignoredPanels, []);
	assert.deepEqual(f.warnings, [
		[diagnostics.missing[0]],
		[diagnostics.delegate[0]],
	]);
}));

test("a project agent cannot satisfy a configured judge agent", { concurrency: false }, () => fixture((f) => {
	agent(f.project, "proj-judge", "role: internal\n");
	f.config({ panels: { ask: { panelists: [{ model: "x" }], judge: { agent: "proj-judge" } } } });
	assert.deepEqual(f.discover("both").panels[0].diagnostics, [
		'[subagent] panels."ask": no agent named "proj-judge" for "judge.agent"; preset retained',
	]);
}));

test("discovery defers model availability, internal-agent suitability, and read-only checks", { concurrency: false }, () => fixture((f) => {
	f.config({ panels: {
		internal: { panelists: [{ agent: "judge", model: "unavailable/model" }] },
		writeCapable: { panelists: [{ agent: "worker", model: "unavailable/model" }] },
	} });
	const result = f.discover();
	assert.deepEqual(result.panels.map((p) => p.name), ["internal", "writeCapable"]);
	assert.deepEqual(result.ignoredPanels, []);
	assert.deepEqual(f.warnings, []);
}));

test("every rejected reason is exactly the single argument written to stderr", { concurrency: false }, () => fixture((f) => {
	for (const panels of [null, [], 1, ...invalidPresets.map((p) => ({ bad: p })), { bad: { panelists: ["a", "b", "c", "d", "e"].map((model) => ({ model })) } }]) {
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
	assert.ok(agents.filter((a) => a.name !== "judge" && a.name !== "judge-review").every((a) => a.role === "delegate"));

	// The review merge contract is the whole body of judge-review.md, so a
	// presence check fails when a section is deleted or renamed.
	const judgeReview = agents.find((a) => a.name === "judge-review")!;
	assert.deepEqual(judgeReview.tools, judge.tools);
	assert.equal(judgeReview.role, "internal");
	assert.equal(judgeReview.model, undefined);
	assert.doesNotMatch(fs.readFileSync(judgeReview.filePath, "utf8").split("---")[1], /^model:/m);
	const body = judgeReview.systemPrompt;
	for (const marker of ["## Findings", "## Conflicts", "## Summary", "No issues were found.", "_2 of 2 panelists answered._"]) {
		assert.ok(body.includes(marker), `judge-review body names ${marker}`);
	}
	for (const severity of ["🔴 CRITICAL", "🟠 HIGH", "🟡 MEDIUM", "🟢 LOW"]) {
		assert.ok(body.includes(severity), `judge-review body names ${severity}`);
	}
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
	agent(f.user, "judge-review");
	assert.equal(f.discover().agents.find((a) => a.name === "judge-review")?.role, "internal");
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
	f.config({ panels: { ask: { panelists: [{ agent: "project-only", model: "x" }] } } });
	assert.equal(f.discover("user").panels[0].diagnostics.length, 1);
	assert.deepEqual(f.discover("both").panels[0].diagnostics, []);
}));

test("model overrides retain precedence while panels are processed independently", { concurrency: false }, () => fixture((f) => {
	agent(f.user, "scout", "model: user/model\n");
	agent(f.project, "scout", "model: project/model\n");
	assert.equal(f.discover().agents.find((a) => a.name === "scout")?.model, "project/model");
	f.config({ models: { scout: " override/model ", judge: "judge/model", absent: "x", worker: " " }, panels: { ask: { panelists: [{ model: "x" }] } } });
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
		f.config({ models, panels: { ask: { panelists: [{ model: "x" }] } } });
		assert.equal(f.discover().panels.length, 1);
		assert.deepEqual(f.warnings, models === null || models === "bad"
			? [[`[subagent] ${f.configPath}: "models" should be an object of agent name -> model`]]
			: models.length === 0 ? [] : [[`[subagent] ${f.configPath}: no agent named "0"; model override ignored`]]);
	}
	f.config({ models: { scout: "still/model" }, panels: null });
	assert.equal(f.discover().agents.find((a) => a.name === "scout")?.model, "still/model");
}));

test("configuration is reread on every discovery including edits, removal, and malformed JSON", { concurrency: false }, () => fixture((f) => {
	f.config({ models: { scout: "first" }, panels: { first: { panelists: [{ model: "a" }] } } });
	assert.equal(f.discover().panels[0].name, "first");
	f.config({ models: { scout: "second" }, panels: { second: { panelists: [{ model: "b" }] } } });
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

test("catalog lists preset names only while the detailed list resolves panelists and judge", () => {
	const { panels } = parsePanels({
		a: { panelists: [{ model: " x " }, { model: "y" }] },
		b: { panelists: [{ agent: "reviewer", model: "x" }], judge: { agent: "judge-review", model: "p/judge" } },
		c: { panelists: [{ model: "x" }], judge: null },
		d: { panelists: [{ model: "x" }], judge: {} },
	});
	assert.equal(formatPanelCatalog(panels), "a; b; c; d");
	assert.deepEqual(formatPanelList(panels), { text: [
		"a: panelist (x) + panelist (y) | judge: judge (inherit)",
		"b: reviewer (x) | judge: judge-review (p/judge)",
		"c: panelist (x) | judge: none",
		"d: panelist (x) | judge: judge (inherit)",
	].join("\n"), remaining: 0 });
});

test("catalog and detailed caps report exact remaining counts and pure suffix output", () => {
	const { panels } = parsePanels(Object.fromEntries(Array.from({ length: 103 }, (_, i) => [`p${String(i).padStart(3, "0")}`, { panelists: [{ model: "x" }] }])));
	assert.equal(formatPanelCatalog(panels), Array.from({ length: 10 }, (_, i) => `p00${i}`).join("; ") + " (+93 more)");
	const list = formatPanelList(panels);
	assert.equal(list.remaining, 3);
	assert.equal(list.text.split("\n").length, 100);
	assert.ok(list.text.endsWith("p099: panelist (x) | judge: judge (inherit)"));
	assert.ok(`${list.text}\n(+${list.remaining} more)`.endsWith("\n(+3 more)"));
	assert.equal(formatPanelCatalog(panels, 1), "p000 (+102 more)");
	assert.equal(formatPanelList(panels, 1).remaining, 102);
	assert.equal(formatPanelList(panels, 103).remaining, 0);
	assert.equal(formatPanelCatalog(panels, 103).includes("more)"), false);
});

test("formatting is byte stable, uses plain name ordering, and never mutates frozen input", () => {
	const { panels } = parsePanels(Object.fromEntries(["z", "a", "ä", "A", "Z"].map((name) => [name, { panelists: [{ model: "b" }, { model: "a" }] }])));
	const before = structuredClone(panels);
	for (const panel of panels) {
		Object.freeze(panel.panelists);
		Object.freeze(panel.diagnostics);
		Object.freeze(panel);
	}
	Object.freeze(panels);
	assert.equal(formatPanelCatalog(panels), "A; Z; a; z; ä");
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

test("differing arguments stay distinct and keep the end that names them", () => {
	const prefix = "x".repeat(200);
	const messages = [
		toolCallAssistant([
			{ id: "1", name: "read", args: { file_path: `${prefix}a.ts` } },
			{ id: "2", name: "read", args: { file_path: `${prefix}b.ts` } },
		]),
	];
	const summary = buildToolCallSummary(messages);
	assert.equal(summary.includes(" x2"), false, "untruncated key arguments keep the calls apart");
	const entries = summary.split(", ");
	assert.equal(entries.length, 2);
	assert.notEqual(entries[0], entries[1], "the kept tail tells the two files apart");
	assert.ok(entries[0].endsWith("a.ts") && entries[1].endsWith("b.ts"));
});

test("a long absolute path keeps its file name instead of its directory prefix", () => {
	const dir =
		"/home/lucas/source/datadog/serverless-components--lpimentel-mock-intake-disable-captures/crates/datadog-mock-intake";
	const messages = [
		toolCallAssistant([
			{ id: "1", name: "read", args: { path: `${dir}/src/lib.rs` } },
			{ id: "2", name: "read", args: { path: `${dir}/Cargo.toml` } },
		]),
	];
	assert.equal(
		buildToolCallSummary(messages),
		"read /home/lucas/source/datadog/...ble-captures/crates/datadog-mock-intake/src/lib.rs, read /home/lucas/source/datadog/...ble-captures/crates/datadog-mock-intake/Cargo.toml",
	);
});

test("distinct Git operation arguments stay distinct", () => {
	const messages = [
		toolCallAssistant([
			{ id: "1", name: "git_read", args: { subcommand: "show", args: ["HEAD:a.ts"] } },
			{ id: "2", name: "git_read", args: { subcommand: "show", args: ["HEAD:b.ts"] } },
			{ id: "3", name: "git_read", args: { subcommand: "show", args: ["HEAD:a.ts"] } },
		]),
	];
	assert.equal(buildToolCallSummary(messages), "git_read show HEAD:a.ts x2, git_read show HEAD:b.ts");
});

test("distinct GitHub operation arguments stay distinct", () => {
	const messages = [
		toolCallAssistant([
			{ id: "1", name: "gh_read", args: { subcommand: "pr diff", pr: 123, args: ["--name-only"] } },
			{ id: "2", name: "gh_read", args: { subcommand: "pr diff", pr: 123, args: ["--stat"] } },
		]),
	];
	assert.equal(buildToolCallSummary(messages), "gh_read pr diff 123 --name-only, gh_read pr diff 123 --stat");
});

test("array arguments render their scalar entries and ignore the rest", () => {
	const messages = [
		toolCallAssistant([
			{ id: "1", name: "git_read", args: { subcommand: "diff", args: ["HEAD~1", 2, true, { opaque: 1 }] } },
		]),
	];
	assert.equal(buildToolCallSummary(messages), "git_read diff HEAD~1 2 true");
});

test("an argument array with no scalar entry contributes nothing", () => {
	const messages = [
		toolCallAssistant([
			{ id: "1", name: "git_read", args: { subcommand: "show", args: [{ opaque: 1 }] } },
			{ id: "2", name: "git_read", args: { subcommand: "show", args: [{ opaque: 2 }] } },
		]),
	];
	// Non-scalar entries are deliberately not rendered, so these two calls still
	// share an entry rather than gaining an invented representation.
	assert.equal(buildToolCallSummary(messages), "git_read show x2");
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

test("displayed arguments are elided to the presentation cap without losing the end", () => {
	const long = `${"p".repeat(146)}tail`;
	const summary = buildToolCallSummary([toolCallAssistant([{ id: "1", name: "read", args: { file_path: long } }])]);
	assert.equal(summary, `read ${"p".repeat(27)}...${"p".repeat(46)}tail`);
	assert.equal(summary.length, "read ".length + 80, "the argument still fits the cap, ellipsis included");
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
