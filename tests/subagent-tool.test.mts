// Registered-tool tests for the subagent extension (extensions/subagent/index.ts):
// agent discovery surfaced to the model (the per-request `subagent` description)
// and the no-spawn `subagent_list` tool.
//
// Fully hermetic: a fake pi API captures on-handlers and registered tools, agent
// discovery is isolated from the machine via PI_CODING_AGENT_DIR plus a temp cwd,
// and a spawn override trips loudly if any test accidentally spawns a child.
//
// Run: node --test tests/subagent-tool.test.mts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import subagentExtension, { setAgentListCwd, setSpawnOverride } from "../extensions/subagent/index.ts";

const BUNDLED = ["planner", "researcher", "reviewer", "scout", "worker"];
const BASE_OPENING = "Delegate tasks to specialized subagents with isolated context.";

// ── Harness ──────────────────────────────────────────────────────────────────

interface ToolResult {
	content: Array<{ type: string; text: string }>;
	details?: Record<string, unknown>;
	structuredContent?: {
		agentScope: string;
		projectAgentsDir: string | null;
		agents: Array<{ name: string; source: string; description: string; model: string | null; tools: string[] }>;
	};
	isError?: boolean;
}

interface TestCtx {
	cwd: string;
	model?: unknown;
	thinkingLevel?: unknown;
	hasUI?: boolean;
	isProjectTrusted?: () => boolean;
}

interface RegisteredTool {
	name: string;
	label?: string;
	description: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	parameters: unknown;
	outputSchema?: unknown;
	annotations?: Record<string, unknown>;
	prepareLoadout?: (
		loadout: unknown,
	) => { descriptions?: Record<string, string>; hiddenDeclarations?: readonly string[] } | undefined;
	execute: (
		id: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: TestCtx,
	) => Promise<ToolResult>;
}

interface Harness {
	handlers: Record<string, Array<(event: unknown, ctx: TestCtx) => unknown>>;
	tools: Map<string, RegisteredTool>;
	emitted: string[];
}

/** Any spawn is a test failure: discovery and listing must never dispatch. */
let spawnCount = 0;
setSpawnOverride((() => {
	spawnCount++;
	throw new Error("spawn attempted");
}) as never);

function makeHarness(): Harness {
	const h: Harness = { handlers: {}, tools: new Map(), emitted: [] };
	const listeners: Record<string, Array<(data: unknown) => void>> = {};
	const api = {
		on(event: string, handler: (event: unknown, ctx: TestCtx) => unknown) {
			(h.handlers[event] ??= []).push(handler);
			return () => {};
		},
		registerTool: (tool: RegisteredTool) => h.tools.set(tool.name, tool),
		registerCommand: () => {},
		registerShortcut: () => {},
		registerFlag: () => {},
		getCommands: () => [],
		getActiveTools: () => [],
		getAllTools: () => [],
		events: {
			on(channel: string, handler: (data: unknown) => void) {
				(listeners[channel] ??= []).push(handler);
				return () => {};
			},
			emit(channel: string, data: unknown) {
				h.emitted.push(channel);
				for (const fn of [...(listeners[channel] ?? [])]) fn(data);
			},
		},
	};
	(subagentExtension as unknown as (api: unknown) => void)(api);
	return h;
}

function toolCtx(cwd: string): TestCtx {
	return { cwd, model: undefined, thinkingLevel: undefined, hasUI: false, isProjectTrusted: () => true };
}

const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
	tempDirs.push(dir);
	return dir;
}

function writeAgent(dir: string, name: string, description: string): void {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, `${name}.md`),
		`---\nname: ${name}\ndescription: ${description}\n---\nPrompt for ${name}.\n`,
	);
}

/**
 * Isolate discovery from the machine: empty temp PI_CODING_AGENT_DIR, temp cwd.
 * `project: false` leaves the cwd without `.pi/agents` so no project agents dir
 * is found anywhere up the tree. The variable is restored even on failure.
 */
async function withIsolatedAgents<T>(
	fn: (cwd: string, agentDir: string) => Promise<T> | T,
	options: { project?: boolean } = {},
): Promise<T> {
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const agentDir = makeTempDir("subagent-tool-agentdir-");
	const cwd = makeTempDir("subagent-tool-cwd-");
	if (options.project !== false) fs.mkdirSync(path.join(cwd, ".pi", "agents"), { recursive: true });
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		return await fn(cwd, agentDir);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
}

function assertSortedAppearance(text: string, names: string[]): void {
	let last = -1;
	for (const name of names) {
		const idx = text.indexOf(name);
		assert.ok(idx > last, `${name} must appear after the previous name in sorted order`);
		last = idx;
	}
}

async function runList(h: Harness, cwd: string, params: Record<string, unknown> = {}): Promise<ToolResult> {
	const tool = h.tools.get("subagent_list");
	assert.ok(tool, "subagent_list must be registered");
	return tool.execute("id", params, undefined, undefined, toolCtx(cwd));
}

async function runSubagent(h: Harness, cwd: string, params: Record<string, unknown>): Promise<ToolResult> {
	const tool = h.tools.get("subagent");
	assert.ok(tool, "subagent must be registered");
	return tool.execute("id", params, undefined, undefined, toolCtx(cwd));
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
	setAgentListCwd(null);
	setSpawnOverride(null);
	for (const dir of tempDirs) {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			// Best-effort cleanup.
		}
	}
});
