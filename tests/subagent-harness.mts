// Shared hermetic harness for subagent registered-tool tests.
// Spawn modes, discovery environment, and description cwd are not concurrency-safe.
import assert from "node:assert/strict";
import type { SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import subagentExtension, { setAgentListCwd, setSpawnOverride } from "../extensions/subagent/index.ts";
import { SUBAGENT_SNAPSHOT_ACK, SUBAGENT_SNAPSHOT_REQUEST } from "../extensions/subagent/guard-snapshot.ts";

export interface ToolResult {
	content: Array<{ type: string; text: string }>;
	details?: Record<string, unknown>;
	structuredContent?: {
		agentScope: string;
		projectAgentsDir: string | null;
		agents: Array<{ name: string; role: string; source: string; description: string; model: string | null; tools: string[] }>;
		panels: Array<{ name: string; agent: string | null; models: string[]; judge: string | null }>;
		ignoredPanels: Array<{ name: string; reason: string }>;
	};
	isError?: boolean;
}

export interface TestCtx {
	cwd: string;
	scopedModels?: Array<{ model: { provider: string; id: string } }>;
	ui?: { confirm(title: string, message: string): Promise<boolean> };
	model?: unknown;
	thinkingLevel?: unknown;
	hasUI?: boolean;
	isProjectTrusted?: () => boolean;
}

export interface RegisteredTool {
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

export interface Harness {
	handlers: Record<string, Array<(event: unknown, ctx: TestCtx) => unknown>>;
	tools: Map<string, RegisteredTool>;
	emitted: string[];
	events: { on(channel: string, handler: (data: any) => void): () => void; emit(channel: string, data: unknown): void };
}

export interface SpawnMode {
	restore(): void;
}

export interface CapturedSpawn {
	command: string;
	args: string[];
	options: SpawnOptions;
	child: EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; killed: boolean; kill: () => boolean };
}

export interface RecordingSpawnMode extends SpawnMode {
	spawns: CapturedSpawn[];
}

/** Any spawn in throwing mode is a test failure. Never reset this cumulative counter. */
export let spawnCount = 0;
const throwingSpawn = (() => {
	spawnCount++;
	throw new Error("spawn attempted");
}) as never;

type SpawnOverride = NonNullable<Parameters<typeof setSpawnOverride>[0]>;
let activeOverride: SpawnOverride = throwingSpawn;
const spawnModes: Array<{ override: SpawnOverride }> = [];

/**
 * Modes share global state and must be restored in reverse installation order.
 * Use only these installers while modes are active: an override installed directly
 * through setSpawnOverride cannot be recovered by this helper.
 */
function installSpawn(override: SpawnOverride): SpawnMode {
	const previous = activeOverride;
	const mode = { override };
	spawnModes.push(mode);
	activeOverride = override;
	setSpawnOverride(override);
	let restored = false;
	return {
		restore() {
			if (restored) return;
			if (spawnModes.at(-1) !== mode) throw new Error("Spawn modes must be restored in reverse installation order");
			spawnModes.pop();
			activeOverride = previous;
			setSpawnOverride(previous);
			restored = true;
		},
	};
}

export function installThrowingSpawn(): SpawnMode {
	return installSpawn(throwingSpawn);
}

/** Records dispatches without bypassing the harness's normal guard handshake. */
export function installRecordingSpawn(beforeClose?: (spawn: CapturedSpawn, index: number) => number | void): RecordingSpawnMode {
	const spawns: CapturedSpawn[] = [];
	const mode = installSpawn(((command: string, args: readonly string[], options: SpawnOptions) => {
		const child = new EventEmitter() as CapturedSpawn["child"];
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.killed = false;
		child.kill = () => {
			child.killed = true;
			return true;
		};
		spawns.push({
			command,
			args: [...args],
			options: { ...options, env: options.env === undefined ? undefined : { ...options.env } },
			child,
		});
		// Deferred so the executor has attached its close handler first.
		const index = spawns.length - 1;
		queueMicrotask(() => child.emit("close", beforeClose?.(spawns[index], index) ?? 0));
		return child;
	}) as never);
	return { ...mode, spawns };
}

// Protect importers before any harness is constructed or executed.
installThrowingSpawn();

export function makeHarness(fixtures: {
	tools?: string[];
	settings?: Record<string, unknown>;
	guard?: boolean;
} = {}): Harness {
	const listeners: Record<string, Array<(data: any) => void>> = {};
	const events = {
		on(channel: string, handler: (data: any) => void) {
			(listeners[channel] ??= []).push(handler);
			return () => { listeners[channel] = listeners[channel].filter((fn) => fn !== handler); };
		},
		emit(channel: string, data: unknown) {
			h.emitted.push(channel);
			for (const fn of [...(listeners[channel] ?? [])]) fn(data);
		},
	};
	const h: Harness = { handlers: {}, tools: new Map(), emitted: [], events };
	if (fixtures.guard) events.on(SUBAGENT_SNAPSHOT_REQUEST, (request) => {
		events.emit(SUBAGENT_SNAPSHOT_ACK, { version: 1, id: request.id, ok: true, profile: "research" });
	});
	const api = {
		on(event: string, handler: (event: unknown, ctx: TestCtx) => unknown) {
			(h.handlers[event] ??= []).push(handler);
			return () => { h.handlers[event] = h.handlers[event].filter((fn) => fn !== handler); };
		},
		registerTool: (tool: RegisteredTool) => h.tools.set(tool.name, tool),
		registerCommand: () => {},
		registerShortcut: () => {},
		registerFlag: () => {},
		getCommands: () => [],
		getActiveTools: () => [],
		getAllTools: () => (fixtures.tools ?? []).map((name) => ({ name })),
		getSettings: () => fixtures.settings ?? {},
		events,
	};
	(subagentExtension as unknown as (api: unknown) => void)(api);
	return h;
}

export function toolCtx(cwd: string, overrides: Partial<TestCtx> = {}): TestCtx {
	return { cwd, scopedModels: [], model: undefined, thinkingLevel: undefined, hasUI: false, isProjectTrusted: () => true, ...overrides };
}

export const tempDirs: string[] = [];
export function makeTempDir(prefix: string): string {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
	tempDirs.push(dir);
	return dir;
}

export function writeAgent(dir: string, name: string, description: string): void {
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
export async function withIsolatedAgents<T>(
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

export async function runList(h: Harness, cwd: string, params: Record<string, unknown> = {}): Promise<ToolResult> {
	const tool = h.tools.get("subagent_list");
	assert.ok(tool, "subagent_list must be registered");
	return tool.execute("id", params, undefined, undefined, toolCtx(cwd));
}

export async function runSubagent(h: Harness, cwd: string, params: Record<string, unknown>, context: Partial<TestCtx> = {}): Promise<ToolResult> {
	const tool = h.tools.get("subagent");
	assert.ok(tool, "subagent must be registered");
	return tool.execute("id", params, undefined, undefined, toolCtx(cwd, context));
}

/** Terminal cleanup only; do not construct or execute harnesses afterward. */
export function cleanupHarness(): void {
	setAgentListCwd(null);
	setSpawnOverride(null);
	for (const dir of tempDirs) {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			// Best-effort cleanup.
		}
	}
}
