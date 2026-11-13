// Shared hermetic harness for subagent registered-tool tests.
// Spawn modes, discovery environment, and description cwd are not concurrency-safe.
import assert from "node:assert/strict";
import type { SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import subagentExtension, { setAgentListCwd, setSpawnOverride } from "../extensions/subagent/index.ts";
import {
	EXTENSION_PRESENT_ACK,
	EXTENSION_PRESENT_REQUEST,
	SUBAGENT_SNAPSHOT_ACK,
	SUBAGENT_SNAPSHOT_REQUEST,
} from "../extensions/guard/policy/handshake.ts";

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
	renderCall?: (args: unknown, theme: unknown, context: unknown) => { render(width: number): string[] };
	renderResult?: (
		result: { content: Array<{ type: string; text?: string }>; details?: unknown },
		options: { expanded: boolean; isPartial: boolean },
		theme: unknown,
		context: unknown,
	) => { render(width: number): string[] };
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

export interface CapturedChild extends EventEmitter {
	stdout: EventEmitter;
	stderr: EventEmitter;
	/** Set on the first kill call, SIGTERM included, so escalation cannot use it. */
	killed: boolean;
	/** Every signal passed to `kill`, in order. */
	killedWith: string[];
	kill(signal?: string): boolean;
}

export interface CapturedSpawn {
	command: string;
	args: string[];
	options: SpawnOptions;
	child: CapturedChild;
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

function makeCapturedChild(): CapturedChild {
	const child = new EventEmitter() as CapturedChild;
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.killed = false;
	child.killedWith = [];
	child.kill = (signal?: string) => {
		child.killed = true;
		if (signal) child.killedWith.push(signal);
		return true;
	};
	return child;
}

function captureSpawn(command: string, args: readonly string[], options: SpawnOptions): CapturedSpawn {
	return {
		command,
		args: [...args],
		options: { ...options, env: options.env === undefined ? undefined : { ...options.env } },
		child: makeCapturedChild(),
	};
}

/** Records dispatches without bypassing the harness's normal guard handshake. */
export function installRecordingSpawn(beforeClose?: (spawn: CapturedSpawn, index: number) => number | void): RecordingSpawnMode {
	const spawns: CapturedSpawn[] = [];
	const mode = installSpawn(((command: string, args: readonly string[], options: SpawnOptions) => {
		const spawn = captureSpawn(command, args, options);
		spawns.push(spawn);
		// Deferred so the executor has attached its close handler first.
		const index = spawns.length - 1;
		queueMicrotask(() => spawn.child.emit("close", beforeClose?.(spawns[index], index) ?? 0));
		return spawn.child;
	}) as never);
	return { ...mode, spawns };
}

/**
 * Recording mode whose children stay alive until a test explicitly emits
 * stdout, stderr, `error`, `exit`, or `close`. Used by the panel lifecycle
 * tests together with node:test mock timers, so no real clock is involved.
 *
 * Unlike `installRecordingSpawn`, `onSpawn` runs synchronously inside the spawn
 * override, before the executor attaches its stdout/close listeners, and may
 * throw to simulate a spawn failure. Emit output from the test after awaiting
 * `waitFor(() => mode.spawns.length === n)`, which lets those listeners attach.
 */
export function installControlledSpawn(onSpawn?: (spawn: CapturedSpawn, index: number) => void): RecordingSpawnMode {
	const spawns: CapturedSpawn[] = [];
	const mode = installSpawn(((command: string, args: readonly string[], options: SpawnOptions) => {
		const spawn = captureSpawn(command, args, options);
		spawns.push(spawn);
		onSpawn?.(spawn, spawns.length - 1);
		return spawn.child;
	}) as never);
	return { ...mode, spawns };
}

/**
 * Yield the event loop until `predicate` holds or `deadlineMs` of real time has
 * passed. Yields with `setImmediate`, never `setTimeout`, so node:test mock
 * timers for `setTimeout` cannot deadlock it. The budget is wall clock rather
 * than a fixed iteration count: a few thousand immediate ticks can drain in
 * milliseconds while a spawn is still waiting on its temp prompt file or a
 * guard snapshot, which made these waits fail only under full-suite load.
 */
export async function waitFor(
	predicate: () => boolean,
	message = "condition never became true",
	deadlineMs = 10_000,
): Promise<void> {
	const deadline = Date.now() + deadlineMs;
	for (;;) {
		if (predicate()) return;
		if (Date.now() > deadline) throw new Error(message);
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}

// Protect importers before any harness is constructed or executed.
installThrowingSpawn();

export function makeHarness(fixtures: {
	tools?: string[];
	settings?: Record<string, unknown>;
	guard?: boolean;
	/** Ack the load-time presence ping without answering the snapshot query. */
	guardPresence?: boolean;
	/** Register a guard-layout command, as a loaded guard extension does. */
	guardCommand?: "cli" | "package" | "package-root" | "windows";
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
	if (fixtures.guardPresence) events.on(EXTENSION_PRESENT_REQUEST, (request) => {
		events.emit(EXTENSION_PRESENT_ACK, { version: 1, id: request.id, ok: true });
	});
	// A guard extension's command carries the extension file as its provenance,
	// so the layout itself (an extensions/guard directory) is the signal. The
	// shapes cover every provenance pi reports: a package extension whose
	// baseDir is the extension directory, one whose baseDir is the package
	// root (the file path still proves the layout), one added with --extension
	// (no baseDir at all), and a backslash, mixed-case path.
	const guardBaseDir = path.join(path.sep, "fake-package", "extensions", "guard");
	const guardCommand = fixtures.guardCommand
		? {
			name: "guard",
			description: "guard",
			source: "extension",
			sourceInfo: fixtures.guardCommand === "package"
				? { path: path.join(guardBaseDir, "index.ts"), source: "fake-package", scope: "user", origin: "package", baseDir: guardBaseDir }
				: fixtures.guardCommand === "package-root"
					? { path: path.join(guardBaseDir, "index.ts"), source: "fake-package", scope: "user", origin: "package", baseDir: path.dirname(guardBaseDir) }
					: fixtures.guardCommand === "windows"
						? { path: "C:\\verify\\Extensions\\Guard\\index.ts", source: "cli", scope: "temporary", origin: "top-level" }
						: { path: path.join(guardBaseDir, "index.ts"), source: "cli", scope: "temporary", origin: "top-level" },
		}
		: null;
	const commands = guardCommand ? [guardCommand] : [];
	const api = {
		on(event: string, handler: (event: unknown, ctx: TestCtx) => unknown) {
			(h.handlers[event] ??= []).push(handler);
			return () => { h.handlers[event] = h.handlers[event].filter((fn) => fn !== handler); };
		},
		registerTool: (tool: RegisteredTool) => h.tools.set(tool.name, tool),
		registerCommand: () => {},
		registerShortcut: () => {},
		registerFlag: () => {},
		getCommands: () => commands,
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
