// Guard step-5 tests: subagent profile inheritance.
//
// Covers the inheritance contract (extensions/guard/policy/inheritance.ts),
// the state-level restriction (policy/state.ts), the guard extension's
// snapshot/contract responders and command surface (extensions/guard/index.ts
// via a fake pi API), the subagent dispatch wiring (extensions/subagent/index.ts
// via a spawn seam), the child startup gate (gate-driver subprocess matrix),
// and real pi subprocess startup gating with an offline fake provider.
//
// Run: node tests/guard-subagent.test.mts
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventEmitter } from "node:events";

import { mergeConfig } from "../extensions/guard/policy/config.ts";
import {
	INHERIT_ENV,
	INHERITANCE_VERSION,
	constraintFromParse,
	parseInheritance,
	serializeInheritance,
	type InheritanceContract,
} from "../extensions/guard/policy/inheritance.ts";
import { ALL_PROFILES, nextProfile } from "../extensions/guard/policy/profiles.ts";
import {
	createSessionState,
	cycleProfile,
	footerLabel,
	profileChangeAllowed,
	releaseResearchHold,
	requestResearchHold,
	setProfile,
} from "../extensions/guard/policy/state.ts";
import guardExtension from "../extensions/guard/index.ts";
import subagentExtension, { setBootstrapPathOverride, setSpawnOverride } from "../extensions/subagent/index.ts";
import {
	CHILD_CONTRACT_ACK,
	CHILD_CONTRACT_REQUEST,
	SUBAGENT_SNAPSHOT_ACK,
	SUBAGENT_SNAPSHOT_REQUEST,
	queryGuardSnapshot,
	requestChildContract,
} from "../extensions/subagent/guard-snapshot.ts";

const repoRoot = path.resolve(path.dirname(decodeURI(new URL(import.meta.url).pathname)), "..");
const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
	tempDirs.push(dir);
	return dir;
}

// ── Guard extension harness (mirrors tests/guard-harness.test.mts) ───────────

interface GuardHarness {
	handlers: Record<string, Array<(event: unknown, ctx: unknown) => unknown>>;
	commandHandlers: Map<string, (args: string, ctx: unknown) => Promise<void>>;
	shortcuts: Array<{ shortcut: string; handler: (ctx: unknown) => Promise<void> }>;
	eventListeners: Record<string, Array<(data: unknown) => void>>;
	emitted: Array<[string, unknown]>;
	emit: (channel: string, data: unknown) => void;
	notifications: string[];
	status: Map<string, string | undefined>;
	registeredTools: Map<string, { execute: (...args: any[]) => Promise<any> }>;
	selects: Array<{ title: string; options: string[] }>;
	selectChoice: string | undefined;
}

function makeGuardHarness(): GuardHarness {
	const h: GuardHarness = {
		handlers: {},
		commandHandlers: new Map(),
		shortcuts: [],
		eventListeners: {},
		emitted: [],
		emit: () => {},
		notifications: [],
		status: new Map(),
		registeredTools: new Map(),
		selects: [],
		selectChoice: undefined,
	};
	const api = {
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
			(h.handlers[event] ??= []).push(handler);
			return () => {};
		},
		registerTool: (tool: { name: string; execute: (...args: any[]) => Promise<any> }) => h.registeredTools.set(tool.name, tool),
		registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
			h.commandHandlers.set(name, options.handler);
		},
		registerShortcut(shortcut: string, options: { handler: (ctx: unknown) => Promise<void> }) {
			h.shortcuts.push({ shortcut, handler: options.handler });
		},
		registerFlag: () => {},
		getCommands: () => [],
		getActiveTools: () => [],
		getAllTools: () => [],
		events: {
			on(channel: string, handler: (data: unknown) => void) {
				(h.eventListeners[channel] ??= []).push(handler);
				return () => {
					const list = h.eventListeners[channel];
					if (list) h.eventListeners[channel] = list.filter((f) => f !== handler);
				};
			},
			emit: (channel: string, data: unknown) => {
				h.emitted.push([channel, data]);
				// Mirror the real bus: listeners see emissions on their channel.
				for (const listener of [...(h.eventListeners[channel] ?? [])]) listener(data);
			},
		},
	};
	(guardExtension as unknown as (api: unknown) => void)(api);
	h.emit = (channel: string, data: unknown) => api.events.emit(channel, data);
	return h;
}

function guardCtx(h: GuardHarness, cwd: string) {
	return {
		cwd,
		hasUI: true,
		mode: "tui",
		model: undefined,
		scopedModels: [],
		modelRegistry: {
			getAvailable: () => [],
			hasConfiguredAuth: () => false,
			find: () => undefined,
			streamSimple: () => { throw new Error("no model"); },
		},
		ui: {
			notify: (message: string) => h.notifications.push(message),
			setStatus: (key: string, value: string | undefined) => h.status.set(key, value),
			setWorkingVisible: (_visible: boolean) => {},
			select: async (title: string, options: string[]) => {
				h.selects.push({ title, options });
				return h.selectChoice ?? options[0];
			},
			theme: { fg: (_role: string, s: string) => s },
		},
	};
}

const harnessHomeDirs: string[] = [];
async function withTempHome<T>(fn: () => Promise<T> | T): Promise<T> {
	const realHome = process.env.HOME;
	const home = makeTempDir("guard-subagent-home-");
	harnessHomeDirs.push(home);
	process.env.HOME = home;
	try {
		return await fn();
	} finally {
		process.env.HOME = realHome;
	}
}

/** Set PI_GUARD_INHERIT for the duration of fn (the guard factory parses it once). */
async function withInheritanceEnv<T>(value: string | undefined, fn: () => Promise<T> | T): Promise<T> {
	const previous = process.env[INHERIT_ENV];
	if (value === undefined) delete process.env[INHERIT_ENV];
	else process.env[INHERIT_ENV] = value;
	try {
		return await fn();
	} finally {
		if (previous === undefined) delete process.env[INHERIT_ENV];
		else process.env[INHERIT_ENV] = previous;
	}
}

async function startGuardSession(h: GuardHarness, cwd: string) {
	const ctx = guardCtx(h, cwd);
	for (const handler of h.handlers["session_start"] ?? []) await handler({}, ctx);
	return ctx;
}

function snapshotQuery(h: GuardHarness, cwd: string) {
	const queryBus = {
		on: (channel: string, handler: (data: unknown) => void) => {
			h.eventListeners[channel] = [...(h.eventListeners[channel] ?? []), handler];
			return () => {
				h.eventListeners[channel] = (h.eventListeners[channel] ?? []).filter((f) => f !== handler);
			};
		},
		emit: (channel: string, data: unknown) => {
			h.emitted.push([channel, data]);
			for (const fn of [...(h.eventListeners[channel] ?? [])]) fn(data);
		},
	};
	return queryGuardSnapshot(queryBus, cwd);
}

function contractQuery(h: GuardHarness, contract: InheritanceContract) {
	const queryBus = {
		on: (channel: string, handler: (data: unknown) => void) => {
			h.eventListeners[channel] = [...(h.eventListeners[channel] ?? []), handler];
			return () => {
				h.eventListeners[channel] = (h.eventListeners[channel] ?? []).filter((f) => f !== handler);
			};
		},
		emit: (channel: string, data: unknown) => {
			h.emitted.push([channel, data]);
			for (const fn of [...(h.eventListeners[channel] ?? [])]) fn(data);
		},
	};
	return requestChildContract(queryBus, contract);
}

// ── Subagent extension harness (spawn seam) ───────────────────────────────────

interface CapturedSpawn {
	command: string;
	args: string[];
	options: Record<string, unknown>;
	child: EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; killed: boolean; kill: () => boolean };
}

function fakeChild(): CapturedSpawn["child"] {
	const child = new EventEmitter() as CapturedSpawn["child"];
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.killed = false;
	child.kill = () => {
		child.killed = true;
		return true;
	};
	return child;
}

interface SubagentHarness {
	eventListeners: Record<string, Array<(data: unknown) => void>>;
	emitted: Array<[string, unknown]>;
	emit: (channel: string, data: unknown) => void;
	registeredTools: Map<string, { execute: (...args: any[]) => Promise<any> }>;
	spawns: CapturedSpawn[];
	held: CapturedSpawn["child"][];
	/** Children to hold open before auto-closing resumes. */
	holdRemaining: number;
}

function makeSubagentHarness(): SubagentHarness {
	const h: SubagentHarness = {
		eventListeners: {},
		emitted: [],
		emit: () => {},
		registeredTools: new Map(),
		spawns: [],
		held: [],
		holdRemaining: 0,
	};
	const api = {
		on: () => () => {},
		registerTool: (tool: { name: string; execute: (...args: any[]) => Promise<any> }) => h.registeredTools.set(tool.name, tool),
		registerCommand: () => {},
		registerShortcut: () => {},
		registerFlag: () => {},
		getCommands: () => [],
		getActiveTools: () => [],
		getAllTools: () => [],
		events: {
			on(channel: string, handler: (data: unknown) => void) {
				(h.eventListeners[channel] ??= []).push(handler);
				return () => {
					h.eventListeners[channel] = (h.eventListeners[channel] ?? []).filter((f) => f !== handler);
				};
			},
			emit(channel: string, data: unknown) {
				h.emitted.push([channel, data]);
				for (const fn of [...(h.eventListeners[channel] ?? [])]) fn(data);
			},
		},
	};
	(subagentExtension as unknown as (api: unknown) => void)(api);
	h.emit = (channel: string, data: unknown) => api.events.emit(channel, data);
	setSpawnOverride((command, args, options) => {
		const child = fakeChild();
		h.spawns.push({ command, args, options: options as Record<string, unknown>, child });
		if (h.holdRemaining > 0) {
			h.holdRemaining--;
			h.held.push(child);
		} else {
			// Deferred so the executor has attached its close handler first.
			queueMicrotask(() => child.emit("close", 0));
		}
		return child;
	});
	return h;
}

function subagentCtx(h: SubagentHarness, cwd: string) {
	return {
		cwd,
		hasUI: false,
		mode: "json",
		model: undefined,
		thinkingLevel: undefined,
		isProjectTrusted: () => true,
	};
}

async function runSubagent(h: SubagentHarness, cwd: string, params: Record<string, unknown>) {
	const tool = h.registeredTools.get("subagent");
	if (!tool) throw new Error("subagent tool not registered");
	return tool.execute("id", params, undefined, undefined, subagentCtx(h, cwd));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

const tests: { name: string; fn: () => void | Promise<void> }[] = [];
function test(name: string, fn: () => void | Promise<void>) {
	tests.push({ name, fn });
}

const AUTO_CONTRACT: InheritanceContract = { version: INHERITANCE_VERSION, profile: "auto", nonce: "nonce-auto-1234" };

// ── A. Inheritance contract ───────────────────────────────────────────────────

test("inheritance contract round-trips every profile", () => {
	for (const profile of ALL_PROFILES) {
		const raw = serializeInheritance(profile, "nonce-1");
		const parsed = parseInheritance(raw);
		assert.equal(parsed.ok, true, `${profile}: ${parsed.ok ? "" : parsed.reason}`);
		if (!parsed.ok) continue;
		assert.deepEqual(parsed.contract, { version: INHERITANCE_VERSION, profile, nonce: "nonce-1" });
	}
});

test("inheritance contract distinguishes an absent variable from an invalid one", () => {
	const absent = parseInheritance(undefined);
	assert.equal(absent.ok, false);
	assert.equal(absent.ok ? null : absent.present, false, "absent is not 'present but invalid'");
	const empty = parseInheritance("");
	assert.equal(empty.ok, false);
	assert.equal(empty.ok ? null : empty.present, true, "an explicitly empty variable is present and invalid");
	assert.equal(constraintFromParse(absent), null);
	assert.ok(constraintFromParse(empty) !== null && "error" in constraintFromParse(empty)!);
});

test("inheritance contract rejects malformed payloads without defaulting", () => {
	const bad = [
		"not json",
		"",
		"[]",
		"null",
		"42",
		'{"version":2,"profile":"auto","nonce":"n"}',
		'{"version":"1","profile":"auto","nonce":"n"}',
		'{"profile":"auto","nonce":"n"}',
		'{"version":1,"nonce":"n"}',
		'{"version":1,"profile":"bogus","nonce":"n"}',
		'{"version":1,"profile":"default"}',
		'{"version":1,"profile":"auto","nonce":""}',
		'{"version":1,"profile":"auto","nonce":"has space"}',
		'{"version":1,"profile":"auto","nonce":"' + "a".repeat(129) + '"}',
		'{"version":1,"profile":"auto","nonce":"n","extra":true}',
		"x".repeat(2000),
	];
	for (const raw of bad) {
		const parsed = parseInheritance(raw);
		assert.equal(parsed.ok, false, `expected rejection: ${raw.slice(0, 60)}`);
		assert.equal(parsed.ok ? null : parsed.present, true, `payload existed: ${raw.slice(0, 60)}`);
		const constraint = constraintFromParse(parsed);
		assert.ok(constraint !== null && "error" in constraint, "invalid payloads never become an ordinary session");
	}
	const okNonce = parseInheritance(serializeInheritance("auto", "a".repeat(128)));
	assert.equal(okNonce.ok, true, "a 128-character nonce is valid");
});

// ── B. State-level restriction ────────────────────────────────────────────────

function makeConfig() {
	return mergeConfig({}, {}, "/home/user/proj");
}

test("every inherited profile initializes the child and restricts changes to itself plus research", () => {
	for (const inherited of ALL_PROFILES) {
		const state = createSessionState({ config: makeConfig(), sandbox: null, cwd: "/w", interactive: true, inherited: { profile: inherited } });
		assert.equal(state.profile, inherited, `child starts in ${inherited}`);
		for (const requested of ALL_PROFILES) {
			const fresh = createSessionState({ config: makeConfig(), sandbox: null, cwd: "/w", interactive: true, inherited: { profile: inherited } });
			const result = setProfile(fresh, requested);
			const expectOk = requested === inherited || requested === "research";
			assert.equal(result.ok, expectOk, `${inherited} -> ${requested}: ${result.ok ? "allowed" : result.notice}`);
			if (result.ok) assert.equal(fresh.profile, requested);
			else assert.equal(fresh.profile, inherited, "a refused change leaves the inherited profile");
			const direct = profileChangeAllowed(state, requested);
			assert.equal(direct.ok, expectOk);
		}
	}
});

test("cycling inside a child only proceeds when the next profile is allowed", () => {
	for (const inherited of ALL_PROFILES) {
		const state = createSessionState({ config: makeConfig(), sandbox: null, cwd: "/w", interactive: true, inherited: { profile: inherited } });
		const next = nextProfile(inherited);
		const result = cycleProfile(state);
		const expectOk = next === inherited || next === "research";
		assert.equal(result.ok, expectOk, `${inherited} cycle -> ${next}`);
		if (result.ok) assert.equal(state.profile, next);
		else {
			assert.equal(state.profile, inherited);
			assert.match((result as { notice: string }).notice, /inherited profile/);
		}
	}
	// yolo is the only inherited profile whose cycle successor is research.
	assert.equal(nextProfile("yolo"), "research");
});

test("an invalid inheritance blocks the session instead of initializing a default runtime", () => {
	const state = createSessionState({ config: makeConfig(), sandbox: null, cwd: "/w", interactive: true, inherited: { error: "invalid JSON" } });
	assert.equal(state.profile, "default", "blocked state keeps an inert profile value");
	for (const requested of ALL_PROFILES) {
		const result = setProfile(state, requested);
		assert.equal(result.ok, false, `${requested} refused in a blocked session`);
		assert.match((result as { notice: string }).notice, /invalid/);
		assert.equal(cycleProfile(state).ok, false);
	}
	const hold = requestResearchHold(state, "plan");
	assert.equal(hold.granted, false, "research is unavailable in a blocked session");
	assert.match(footerLabel(state), /inheritance invalid/);
});

test("research holds restore the inherited profile and cannot widen the restriction", () => {
	const state = createSessionState({ config: makeConfig(), sandbox: null, cwd: "/w", interactive: true, inherited: { profile: "auto" } });
	assert.deepEqual(requestResearchHold(state, "plan"), { granted: true, reason: "research granted", profile: "research" });
	assert.equal(state.profile, "research");
	assert.equal(state.profileBeforeHold, "auto");
	// During the hold only research is settable (pre-existing rule).
	const blocked = setProfile(state, "auto");
	assert.equal(blocked.ok, false);
	assert.match((blocked as { notice: string }).notice, /blocked/);
	assert.deepEqual(releaseResearchHold(state, "plan"), { released: true, reason: "research released; previous profile restored", profile: "auto" });
	assert.equal(state.profile, "auto", "release restores the inherited profile, never a wider one");
	assert.equal(setProfile(state, "default").ok, false, "the restriction survives release");
	assert.equal(setProfile(state, "yolo").ok, false);
});

test("footer and list surface inheritance without changing ordinary sessions", () => {
	const ordinary = createSessionState({ config: makeConfig(), sandbox: null, cwd: "/w", interactive: true });
	assert.equal(footerLabel(ordinary), "", "ordinary default session with no sandbox detection is blank");
	const child = createSessionState({ config: makeConfig(), sandbox: null, cwd: "/w", interactive: true, inherited: { profile: "trusted" } });
	assert.match(footerLabel(child), /inherited trusted/);
});

// ── C. Guard extension: commands, responders, lifecycle ──────────────────────

test("a child initializes in its inherited profile and /guard list surfaces it", async () => {
	await withTempHome(async () => {
		await withInheritanceEnv(serializeInheritance("auto", "n-1"), async () => {
			const h = makeGuardHarness();
			const cwd = makeTempDir("guard-sub-child-");
			const ctx = await startGuardSession(h, cwd);
			assert.match(h.status.get("guard") ?? "", /inherited auto/);
			h.notifications.length = 0;
			await h.commandHandlers.get("guard")!("list", ctx);
			assert.match(h.notifications.join("\n"), /inherited \(subagent\): auto/);
		});
	});
});

test("profile commands, picker, and reload cannot escape the restriction", async () => {
	await withTempHome(async () => {
		await withInheritanceEnv(serializeInheritance("auto", "n-2"), async () => {
			const h = makeGuardHarness();
			const cwd = makeTempDir("guard-sub-commands-");
			const ctx = await startGuardSession(h, cwd);
			h.notifications.length = 0;
			await h.commandHandlers.get("guard")!("profile default", ctx);
			assert.match(h.notifications.at(-1) ?? "", /inherited profile auto/);
			await h.commandHandlers.get("guard")!("profile research", ctx);
			assert.match(h.notifications.at(-1) ?? "", /Profile: research/);
			// A fresh session re-installs the inherited profile.
			await startGuardSession(h, cwd);
			const listCtx = guardCtx(h, cwd);
			await h.commandHandlers.get("guard")!("list", listCtx);
			assert.match(h.notifications.join("\n"), /profile \(this session\): auto/);
			// The picker offers only the inherited profile and research.
			h.selects.length = 0;
			h.selectChoice = "research";
			await h.commandHandlers.get("guard")!("profile", ctx);
			assert.deepEqual(h.selects[0]?.options, ["auto", "research"]);
			assert.match(h.notifications.at(-1) ?? "", /Profile: research/);
		});
	});
});

test("the cycle shortcut refuses disallowed successors and allows research", async () => {
	await withTempHome(async () => {
		// auto -> trusted is refused.
		await withInheritanceEnv(serializeInheritance("auto", "n-3"), async () => {
			const h = makeGuardHarness();
			const cwd = makeTempDir("guard-sub-cycle-");
			const ctx = await startGuardSession(h, cwd);
			h.notifications.length = 0;
			await h.shortcuts[0].handler(ctx);
			assert.match(h.notifications.at(-1) ?? "", /inherited profile auto/);
		});
		// yolo -> research is allowed.
		await withInheritanceEnv(serializeInheritance("yolo", "n-4"), async () => {
			const h = makeGuardHarness();
			const cwd = makeTempDir("guard-sub-cycle2-");
			const ctx = await startGuardSession(h, cwd);
			await h.shortcuts[0].handler(ctx);
			const listCtx = guardCtx(h, cwd);
			await h.commandHandlers.get("guard")!("list", listCtx);
			assert.match(h.notifications.join("\n"), /profile \(this session\): research/);
		});
	});
});

test("the snapshot responder answers synchronously from valid state and refuses otherwise", async () => {
	await withTempHome(async () => {
		await withInheritanceEnv(serializeInheritance("auto", "n-5"), async () => {
			const h = makeGuardHarness();
			const cwd = makeTempDir("guard-sub-snapshot-");
			// Uninitialized: refuse.
			assert.equal(snapshotQuery(h, cwd).ok, false);
			await startGuardSession(h, cwd);
			const ok = snapshotQuery(h, cwd);
			assert.deepEqual(ok.ok ? { ok: true, profile: ok.profile } : ok, { ok: true, profile: "auto" });
			// Wrong cwd: refuse.
			const wrongCwd = snapshotQuery(h, "/somewhere/else");
			assert.equal(wrongCwd.ok, false);
			assert.match(wrongCwd.ok ? "" : wrongCwd.reason, /bound to/);
			// Malformed request: refused with a null id.
			h.eventListeners[SUBAGENT_SNAPSHOT_REQUEST] ??= [];
			const before = h.emitted.length;
			for (const listener of [...(h.eventListeners[SUBAGENT_SNAPSHOT_REQUEST] ?? [])]) listener({ version: 1, cwd });
			const malformedAck = h.emitted.slice(before).find(([channel]) => channel === SUBAGENT_SNAPSHOT_ACK)?.[1] as Record<string, unknown>;
			assert.equal(malformedAck.ok, false);
			assert.equal(malformedAck.id, null);
			// A transition in progress refuses: transitioning increments
			// synchronously inside transition() before the queue runs.
			const transitioning = h.commandHandlers.get("guard")!("profile research", guardCtx(h, cwd));
			const during = snapshotQuery(h, cwd);
			assert.equal(during.ok, false);
			assert.match(during.ok ? "" : during.reason, /transition in progress/);
			await transitioning;
			const after = snapshotQuery(h, cwd);
			assert.deepEqual(after.ok ? { ok: true, profile: after.profile } : after, { ok: true, profile: "research" });
			// Disposed runtime: refuse.
			for (const handler of h.handlers["session_shutdown"] ?? []) await handler({}, {});
			assert.equal(snapshotQuery(h, cwd).ok, false);
		});
	});
});

test("the child contract ack proves the exact contract and refuses everything else", async () => {
	await withTempHome(async () => {
		await withInheritanceEnv(serializeInheritance("auto", "n-6"), async () => {
			const h = makeGuardHarness();
			const cwd = makeTempDir("guard-sub-contract-");
			const contract: InheritanceContract = { version: INHERITANCE_VERSION, profile: "auto", nonce: "n-6" };
			// Uninitialized guard: refuse.
			assert.equal(contractQuery(h, contract).ok, false);
			await startGuardSession(h, cwd);
			assert.deepEqual(contractQuery(h, contract), { ok: true });
			const wrongNonce = contractQuery(h, { ...contract, nonce: "wrong" });
			assert.equal(wrongNonce.ok, false);
			assert.match(wrongNonce.ok ? "" : wrongNonce.reason, /nonce mismatch/);
			assert.equal(contractQuery(h, { ...contract, profile: "default" }).ok, false);
			// Research is a valid current profile; the ack still proves the
			// inherited restriction.
			await h.commandHandlers.get("guard")!("profile research", guardCtx(h, cwd));
			assert.equal(contractQuery(h, contract).ok, true);
			// Listener cleanup: no ack listeners leak between queries.
			assert.equal((h.eventListeners[CHILD_CONTRACT_ACK] ?? []).length, 0, "the query helper unsubscribed in finally");
		});
	});
});

test("an ordinary session answers snapshots but never proves a contract", async () => {
	await withTempHome(async () => {
		await withInheritanceEnv(undefined, async () => {
			const h = makeGuardHarness();
			const cwd = makeTempDir("guard-sub-ordinary-");
			const ctx = await startGuardSession(h, cwd);
			assert.equal((h.status.get("guard") ?? "").includes("inherited"), false);
			assert.deepEqual(snapshotQuery(h, cwd).ok ? { ok: true, profile: (snapshotQuery(h, cwd) as { profile: string }).profile } : snapshotQuery(h, cwd), { ok: true, profile: "default" });
			assert.equal(contractQuery(h, AUTO_CONTRACT).ok, false, "an ordinary guard cannot acknowledge a contract");
			void ctx;
		});
	});
});

test("invalid inheritance blocks the guard instead of initializing a runtime", async () => {
	await withTempHome(async () => {
		await withInheritanceEnv("{ not json", async () => {
			const h = makeGuardHarness();
			const cwd = makeTempDir("guard-sub-invalid-");
			const ctx = await startGuardSession(h, cwd);
			assert.match(h.notifications.join("\n"), /inheritance is invalid/);
			assert.match(h.status.get("guard") ?? "", /inheritance invalid/);
			h.notifications.length = 0;
			await h.commandHandlers.get("guard")!("list", ctx);
			assert.match(h.notifications.join("\n"), /INVALID/);
			// Owned executors fail closed without a runtime.
			await assert.rejects(h.registeredTools.get("host_bash")!.execute("id", { command: "echo hi" }, undefined, undefined, ctx), /failed closed|not initialized/);
			// Reload refuses instead of throwing through the handler.
			h.notifications.length = 0;
			await h.commandHandlers.get("guard")!("reload", ctx);
			assert.match(h.notifications.join("\n"), /nothing to reload/);
			// Dispatch and contract requests are refused.
			assert.equal(snapshotQuery(h, cwd).ok, false);
			assert.equal(contractQuery(h, AUTO_CONTRACT).ok, false);
		});
	});
});

test("a child in research keeps sandboxed work usable and denies host shells headlessly", async () => {
	await withTempHome(async () => {
		await withInheritanceEnv(serializeInheritance("research", "n-7"), async () => {
			const h = makeGuardHarness();
			const cwd = makeTempDir("guard-sub-research-");
			const ctx = await startGuardSession(h, cwd);
			let dialogs = 0;
			(ctx as { ui: { select: (t: string, o: string[]) => Promise<string> } }).ui.select = async (title: string, options: string[]) => {
				dialogs++;
				return options[0];
			};
			// Host shells deny in research without any dialog.
			await assert.rejects(h.registeredTools.get("host_bash")!.execute("id", { command: "echo blocked" }, undefined, undefined, ctx), /denied|research/);
			assert.equal(dialogs, 0, "no dialog is opened in a headless child");
			// Sandboxed bash stays allowed in research (full mode only).
			const detection = await import("../extensions/guard/sandbox/detect.ts");
			if (detection.detectSandboxMode().mode !== "degraded") {
				const result = await h.registeredTools.get("bash")!.execute("id", { command: "echo usable" }, undefined, undefined, ctx);
				assert.match(String(result.content?.[0]?.text ?? ""), /usable/);
			} else {
				console.log("  SKIP sandboxed-bash-in-research: degraded sandbox");
			}
		});
	});
});

// ── C2. Duplicate acknowledgment matrix (scripted bus) ───────────────────────

// Both handshake helpers must refuse every second correlated acknowledgment,
// including identical duplicates: multiple responses indicate an ambiguous or
// duplicated responder configuration. These tests exercise the actual exported
// helpers against a small synchronous bus that supports several independent
// responders for the same request.

type DupStep = "ok" | "ok2" | "refuse" | "malformed" | "wrong-version" | "unrelated";
type ScriptedBus = {
	on(channel: string, handler: (data: unknown) => void): () => void;
	emit(channel: string, data: unknown): void;
};

function makeScriptedBus(requestChannel: string, responders: Array<(bus: ScriptedBus, request: Record<string, unknown>) => void>): { bus: ScriptedBus; listeners: Map<string, Array<(data: unknown) => void>> } {
	const listeners = new Map<string, Array<(data: unknown) => void>>();
	const bus: ScriptedBus = {
		on(channel: string, handler: (data: unknown) => void) {
			const list = listeners.get(channel) ?? [];
			list.push(handler);
			listeners.set(channel, list);
			return () => {
				listeners.set(channel, (listeners.get(channel) ?? []).filter((f) => f !== handler));
			};
		},
		emit(channel: string, data: unknown) {
			for (const handler of [...(listeners.get(channel) ?? [])]) handler(data);
		},
	};
	for (const responder of responders) {
		bus.on(requestChannel, (raw) => responder(bus, raw as Record<string, unknown>));
	}
	return { bus, listeners };
}

function snapshotResponder(step: DupStep): (bus: ScriptedBus, request: Record<string, unknown>) => void {
	return (bus, request) => {
		const correlated = { id: request.id as string };
		switch (step) {
			case "ok": return void bus.emit(SUBAGENT_SNAPSHOT_ACK, { version: 1, ...correlated, ok: true, profile: "auto" });
			case "ok2": return void bus.emit(SUBAGENT_SNAPSHOT_ACK, { version: 1, ...correlated, ok: true, profile: "research" });
			case "refuse": return void bus.emit(SUBAGENT_SNAPSHOT_ACK, { version: 1, ...correlated, ok: false, reason: "responder refusal" });
			// Correlated but missing the required ok/profile fields.
			case "malformed": return void bus.emit(SUBAGENT_SNAPSHOT_ACK, { version: 1, ...correlated });
			case "wrong-version": return void bus.emit(SUBAGENT_SNAPSHOT_ACK, { version: 2, ...correlated, ok: true, profile: "auto" });
			case "unrelated": return void bus.emit(SUBAGENT_SNAPSHOT_ACK, { version: 1, id: "unrelated-id", ok: true, profile: "auto" });
		}
	};
}

function contractResponder(step: DupStep): (bus: ScriptedBus, request: Record<string, unknown>) => void {
	return (bus, request) => {
		const correlated = { nonce: request.nonce as string };
		switch (step) {
			case "ok": return void bus.emit(CHILD_CONTRACT_ACK, { version: 1, ...correlated, ok: true, inherited: "auto", profile: "auto" });
			case "ok2": return void bus.emit(CHILD_CONTRACT_ACK, { version: 1, ...correlated, ok: true, inherited: "research", profile: "research" });
			case "refuse": return void bus.emit(CHILD_CONTRACT_ACK, { version: 1, ...correlated, ok: false, reason: "responder refusal" });
			// Correlated but missing the required ok field.
			case "malformed": return void bus.emit(CHILD_CONTRACT_ACK, { version: 1, ...correlated });
			case "wrong-version": return void bus.emit(CHILD_CONTRACT_ACK, { version: 2, ...correlated, ok: true, inherited: "auto", profile: "auto" });
			case "unrelated": return void bus.emit(CHILD_CONTRACT_ACK, { version: 1, nonce: "unrelated-nonce", ok: true, inherited: "auto", profile: "auto" });
		}
	};
}

const DUPLICATE_SCENARIOS: Array<{ label: string; steps: DupStep[]; expectOk: boolean; duplicate: boolean }> = [
	{ label: "a single success succeeds", steps: ["ok"], expectOk: true, duplicate: false },
	{ label: "a single refusal keeps its diagnostic", steps: ["refuse"], expectOk: false, duplicate: false },
	{ label: "no correlated response keeps the missing-response refusal", steps: [], expectOk: false, duplicate: false },
	{ label: "identical duplicate successes refuse", steps: ["ok", "ok"], expectOk: false, duplicate: true },
	{ label: "success then refusal refuses as a duplicate", steps: ["ok", "refuse"], expectOk: false, duplicate: true },
	{ label: "refusal then success refuses as a duplicate", steps: ["refuse", "ok"], expectOk: false, duplicate: true },
	{ label: "two successes with different profiles refuse", steps: ["ok", "ok2"], expectOk: false, duplicate: true },
	{ label: "success then malformed correlated response refuses", steps: ["ok", "malformed"], expectOk: false, duplicate: true },
	{ label: "malformed correlated response then success refuses", steps: ["malformed", "ok"], expectOk: false, duplicate: true },
	{ label: "success then unsupported version refuses", steps: ["ok", "wrong-version"], expectOk: false, duplicate: true },
	{ label: "three correlated responses refuse", steps: ["ok", "refuse", "malformed"], expectOk: false, duplicate: true },
	{ label: "unrelated acknowledgments around one success succeed", steps: ["unrelated", "ok", "unrelated"], expectOk: true, duplicate: false },
];

for (const scenario of DUPLICATE_SCENARIOS) {
	test(`snapshot handshake: ${scenario.label}`, () => {
		const { bus, listeners } = makeScriptedBus(SUBAGENT_SNAPSHOT_REQUEST, scenario.steps.map(snapshotResponder));
		const result = queryGuardSnapshot(bus, "/w");
		assert.equal(result.ok, scenario.expectOk, JSON.stringify(result));
		if (scenario.duplicate) {
			assert.match(result.ok ? "" : result.reason, /duplicate/i, "diagnostic must identify the duplicate acknowledgment");
			assert.match(result.ok ? "" : result.reason, /exactly one/i, "diagnostic must state the single-responder requirement");
		}
		assert.equal((listeners.get(SUBAGENT_SNAPSHOT_ACK) ?? []).length, 0, "the query helper unsubscribed in finally");
	});
	test(`child contract handshake: ${scenario.label}`, () => {
		const { bus, listeners } = makeScriptedBus(CHILD_CONTRACT_REQUEST, scenario.steps.map(contractResponder));
		const result = requestChildContract(bus, AUTO_CONTRACT);
		assert.equal(result.ok, scenario.expectOk, JSON.stringify(result));
		if (scenario.duplicate) {
			assert.match(result.ok ? "" : result.reason, /duplicate/i, "diagnostic must identify the duplicate acknowledgment");
			assert.match(result.ok ? "" : result.reason, /exactly one/i, "diagnostic must state the single-responder requirement");
		}
		assert.equal((listeners.get(CHILD_CONTRACT_ACK) ?? []).length, 0, "the query helper unsubscribed in finally");
	});
}

function makeThrowingBus(): { bus: ScriptedBus; listeners: Map<string, Array<(data: unknown) => void>> } {
	const listeners = new Map<string, Array<(data: unknown) => void>>();
	return {
		listeners,
		bus: {
			on(channel: string, handler: (data: unknown) => void) {
				const list = listeners.get(channel) ?? [];
				list.push(handler);
				listeners.set(channel, list);
				return () => {
					listeners.set(channel, (listeners.get(channel) ?? []).filter((f) => f !== handler));
				};
			},
			emit() { throw new Error("emitter failure"); },
		},
	};
}

test("an emission failure still unsubscribes both handshake listeners", () => {
	const snapshotBus = makeThrowingBus();
	assert.throws(() => queryGuardSnapshot(snapshotBus.bus, "/w"), /emitter failure/);
	assert.equal((snapshotBus.listeners.get(SUBAGENT_SNAPSHOT_ACK) ?? []).length, 0);
	const contractBus = makeThrowingBus();
	assert.throws(() => requestChildContract(contractBus.bus, AUTO_CONTRACT), /emitter failure/);
	assert.equal((contractBus.listeners.get(CHILD_CONTRACT_ACK) ?? []).length, 0);
});

// ── D. Subagent dispatch wiring (spawn seam) ──────────────────────────────────

async function withGuardAndSubagent(envValue: string, fn: (guard: GuardHarness, sub: SubagentHarness, cwd: string) => Promise<void> | void) {
	await withTempHome(async () => {
		await withInheritanceEnv(envValue, async () => {
			const guard = makeGuardHarness();
			const sub = makeSubagentHarness();
			// Share the bus: the subagent queries answer through the real guard
			// responders, mirroring a real session.
			sub.eventListeners = guard.eventListeners;
			sub.emitted = guard.emitted;
			const cwd = makeTempDir("guard-sub-dispatch-");
			await startGuardSession(guard, cwd);
			try {
				await fn(guard, sub, cwd);
			} finally {
				for (const handler of guard.handlers["session_shutdown"] ?? []) await handler({}, {});
				setSpawnOverride(null);
				setBootstrapPathOverride(null);
			}
		});
	});
}

test("single dispatch snapshots the current profile and passes the gate without touching the parent environment", async () => {
	await withGuardAndSubagent(serializeInheritance("auto", "n-8"), async (_guard, sub, cwd) => {
		const stale = process.env[INHERIT_ENV];
		const tmpBefore = tmpSubagentDirs().length;
		const result = await runSubagent(sub, cwd, { agent: "scout", task: "look around" });
		assert.equal(sub.spawns.length, 1);
		const spawn = sub.spawns[0];
		assert.equal(spawn.command, process.execPath, "children run through the pi entry");
		assert.ok(spawn.args.includes("--mode") && spawn.args.includes("json"));
		assert.ok(spawn.args.includes("--no-session"));
		const extensionIndex = spawn.args.indexOf("--extension");
		assert.ok(extensionIndex >= 0, "the child startup gate is passed explicitly");
		const bootstrapPath = spawn.args[extensionIndex + 1];
		assert.equal(bootstrapPath, path.join(repoRoot, "extensions", "subagent", "guard-bootstrap.ts"));
		assert.equal(fs.existsSync(bootstrapPath), true);
		assert.equal(spawn.options.shell, false);
		assert.equal(spawn.options.cwd, cwd);
		const env = spawn.options.env as Record<string, string | undefined>;
		const parsed = parseInheritance(env[INHERIT_ENV]);
		assert.equal(parsed.ok, true, `child env carries a valid contract: ${env[INHERIT_ENV]}`);
		if (parsed.ok) {
			assert.equal(parsed.contract.profile, "auto");
			assert.notEqual(parsed.contract.nonce, undefined);
		}
		// The parent environment is not mutated, and stale ambient inheritance
		// is overridden, not inherited.
		assert.equal(process.env[INHERIT_ENV], stale);
		const content = (result as { content: Array<{ text?: string }> }).content;
		assert.ok(Array.isArray(content));
		// Snapshot request/ack correlation happened exactly once, and the
		// temporary prompt file is cleaned on ordinary completion.
		const requests = sub.emitted.filter(([channel]) => channel === SUBAGENT_SNAPSHOT_REQUEST);
		assert.equal(requests.length, 1);
		assert.equal(tmpSubagentDirs().length, tmpBefore, "no temporary prompt directories remain");
	});
});

test("nested dispatch replaces stale ambient inheritance with the current profile", async () => {
	await withGuardAndSubagent(serializeInheritance("auto", "stale-nonce"), async (guard, sub, cwd) => {
		await guard.commandHandlers.get("guard")!("profile research", guardCtx(guard, cwd));
		await runSubagent(sub, cwd, { agent: "scout", task: "nested" });
		const env = sub.spawns[0].options.env as Record<string, string | undefined>;
		const parsed = parseInheritance(env[INHERIT_ENV]);
		assert.equal(parsed.ok, true);
		if (parsed.ok) {
			assert.equal(parsed.contract.profile, "research", "the fresh snapshot wins over ambient state");
			assert.notEqual(parsed.contract.nonce, "stale-nonce");
		}
	});
});

test("queued parallel tasks and later chain steps read the latest profile", async () => {
	await withGuardAndSubagent(serializeInheritance("auto", "n-9"), async (guard, sub, cwd) => {
		// Hold the four concurrency-limited spawns until the test releases them.
		sub.holdRemaining = 4;
		const tasks = Array.from({ length: 5 }, (_, i) => ({ agent: "scout", task: `t${i}` }));
		const running = runSubagent(sub, cwd, { tasks });
		// Concurrency limit is 4: wait for four spawns, then tighten.
		for (let i = 0; i < 200 && sub.spawns.length < 4; i++) await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(sub.spawns.length, 4, "four tasks occupy the concurrency limit");
		await guard.commandHandlers.get("guard")!("profile research", guardCtx(guard, cwd));
		for (const child of [...sub.held]) child.emit("close", 0);
		sub.held.length = 0;
		await running;
		assert.equal(sub.spawns.length, 5, "the queued fifth task spawned after release");
		const profiles = sub.spawns.map((s) => {
			const parsed = parseInheritance((s.options.env as Record<string, string | undefined>)[INHERIT_ENV]);
			return parsed.ok ? parsed.contract.profile : `invalid:${parsed.ok ? "" : parsed.reason}`;
		});
		assert.deepEqual(profiles, ["auto", "auto", "auto", "auto", "research"], "queued tasks snapshot the current profile at spawn");
		const nonces = sub.spawns.map((s) => parseInheritance((s.options.env as Record<string, string | undefined>)[INHERIT_ENV]));
		const nonceSet = new Set(nonces.map((n) => (n.ok ? n.contract.nonce : "")));
		assert.equal(nonceSet.size, 5, "every child gets a fresh nonce");
	});
});

test("chain steps snapshot per spawn", async () => {
	await withGuardAndSubagent(serializeInheritance("auto", "n-10"), async (guard, sub, cwd) => {
		sub.holdRemaining = 1;
		const chain = [
			{ agent: "scout", task: "step one" },
			{ agent: "planner", task: "step two {previous}" },
		];
		const running = runSubagent(sub, cwd, { chain });
		for (let i = 0; i < 200 && sub.spawns.length < 1; i++) await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(sub.spawns.length, 1);
		await guard.commandHandlers.get("guard")!("profile research", guardCtx(guard, cwd));
		sub.held[0].emit("close", 0);
		sub.held.length = 0;
		await running;
		assert.equal(sub.spawns.length, 2);
		const profiles = sub.spawns.map((s) => parseInheritance((s.options.env as Record<string, string | undefined>)[INHERIT_ENV]));
		assert.deepEqual(profiles.map((p) => (p.ok ? p.contract.profile : "")), ["auto", "research"]);
	});
});

test("a failing chain step stops the chain and spawns no later step", async () => {
	await withGuardAndSubagent(serializeInheritance("auto", "n-15"), async (_guard, sub, cwd) => {
		setSpawnOverride((command, args, options) => {
			const child = fakeChild();
			sub.spawns.push({ command, args, options: options as Record<string, unknown>, child });
			child.stderr.emit("data", "boom");
			queueMicrotask(() => child.emit("close", 1));
			return child;
		});
		const result = await runSubagent(sub, cwd, {
			chain: [
				{ agent: "scout", task: "step one" },
				{ agent: "planner", task: "step two" },
			],
		}) as { content: Array<{ type: string; text: string }>; isError?: boolean };
		assert.equal(sub.spawns.length, 1, "the chain stopped after the failed step");
		assert.equal(result.isError, true);
		assert.match(result.content.map((c) => c.text ?? "").join("\n"), /Chain stopped at step 1/);
	});
});

test("a workspace-locked guard refuses dispatch", async () => {
	await withTempHome(async () => {
		await withInheritanceEnv(undefined, async () => {
			const sandboxDetection = await import("../extensions/guard/sandbox/detect.ts");
			if (sandboxDetection.detectSandboxMode().mode === "degraded") {
				console.log("  SKIP workspace-lock dispatch refusal: degraded sandbox");
				return;
			}
			const h = makeGuardHarness();
			const cwd = makeTempDir("guard-sub-lock-");
			fs.mkdirSync(path.join(cwd, ".pi"));
			fs.writeFileSync(path.join(cwd, ".pi", "guard.local.json"), JSON.stringify({ protectedPaths: ["../invalid-protection"] }));
			await startGuardSession(h, cwd);
			// The failing protected-path snapshot locks the workspace.
			await assert.rejects(h.registeredTools.get("bash")!.execute("id", { command: "echo safe" }, undefined, undefined, guardCtx(h, cwd)), /protectedPaths/);
			const locked = snapshotQuery(h, cwd);
			assert.equal(locked.ok, false);
			assert.match(locked.ok ? "" : locked.reason, /locked/);
		});
	});
});

test("a refusal from the guard becomes a failed result and cleans temporary prompt files", async () => {
	await withGuardAndSubagent(serializeInheritance("auto", "n-11"), async (guard, sub, cwd) => {
		// Refuse via an uninitialized guard state: dispose the runtime.
		for (const handler of guard.handlers["session_shutdown"] ?? []) await handler({}, {});
		const before = tmpSubagentDirs();
		const result = await runSubagent(sub, cwd, { agent: "scout", task: "refused" }) as { content: Array<{ type: string; text: string }>; isError?: boolean };
		assert.equal(sub.spawns.length, 0, "no child is spawned on refusal");
		const text = result.content.map((c) => c.text ?? "").join("\n");
		assert.match(text, /guard refused subagent dispatch/);
		const after = tmpSubagentDirs();
		assert.equal(after.length, before.length, "temporary prompt directories are cleaned on refusal");
	});
});

test("a missing child startup gate refuses the dispatch", async () => {
	await withGuardAndSubagent(serializeInheritance("auto", "n-12"), async (_guard, sub, cwd) => {
		setBootstrapPathOverride(path.join(cwd, "does-not-exist", "guard-bootstrap.ts"));
		const result = await runSubagent(sub, cwd, { agent: "scout", task: "x" }) as { content: Array<{ type: string; text: string }> };
		assert.equal(sub.spawns.length, 0);
		assert.match(result.content.map((c) => c.text ?? "").join("\n"), /not found/);
	});
});

test("an already-aborted dispatch never spawns or queries", async () => {
	await withGuardAndSubagent(serializeInheritance("auto", "n-13"), async (_guard, sub, cwd) => {
		const controller = new AbortController();
		controller.abort();
		const tool = sub.registeredTools.get("subagent")!;
		await assert.rejects(tool.execute("id", { agent: "scout", task: "x" }, controller.signal, undefined, subagentCtx(sub, cwd)), /aborted/);
		assert.equal(sub.spawns.length, 0);
	});
});

test("query listeners are cleaned up across repeated dispatches", async () => {
	await withGuardAndSubagent(serializeInheritance("auto", "n-14"), async (_guard, sub, cwd) => {
		for (let i = 0; i < 3; i++) await runSubagent(sub, cwd, { agent: "scout", task: `run ${i}` });
		assert.equal(sub.spawns.length, 3);
		assert.equal((sub.eventListeners[SUBAGENT_SNAPSHOT_ACK] ?? []).length, 0, "no ack listener leaks");
	});
});

test("a duplicate snapshot acknowledgment refuses the dispatch without spawning", async () => {
	await withGuardAndSubagent(serializeInheritance("auto", "n-16"), async (_guard, sub, cwd) => {
		// A second responder answers every snapshot request with an identical
		// correlated ack; the query must refuse the duplicate and never spawn.
		(sub.eventListeners[SUBAGENT_SNAPSHOT_REQUEST] ??= []).push((raw) => {
			const request = raw as { id: string };
			sub.emit(SUBAGENT_SNAPSHOT_ACK, { version: 1, id: request.id, ok: true, profile: "auto" });
		});
		const before = tmpSubagentDirs().length;
		const result = await runSubagent(sub, cwd, { agent: "scout", task: "duplicated ack" }) as { content: Array<{ type: string; text: string }>; isError?: boolean };
		assert.equal(sub.spawns.length, 0, "no child is spawned on a duplicate acknowledgment");
		assert.equal(result.isError, true);
		const text = result.content.map((c) => c.text ?? "").join("\n");
		assert.match(text, /guard refused subagent dispatch/);
		assert.match(text, /duplicate/i, "the refusal names the duplicate acknowledgment");
		assert.match(text, /exactly one/i, "the refusal states the single-responder requirement");
		assert.equal(tmpSubagentDirs().length, before, "temporary prompt directories are cleaned on duplicate refusal");
	});
});

function tmpSubagentDirs(): string[] {
	try {
		return fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("pi-subagent-"));
	} catch {
		return [];
	}
}

// ── E. Child startup gate: subprocess ack matrix ─────────────────────────────

const gateDriver = path.join(repoRoot, "tests", "fixtures", "guard-subagent", "gate-driver.mts");

function runGateDriver(scenario: string): { status: number | null; stdout: string; stderr: string } {
	const env = { ...process.env };
	// The driver sets the contract itself for the scenarios that need one.
	delete env[INHERIT_ENV];
	const r = spawnSync(process.execPath, [gateDriver, scenario], { encoding: "utf8", timeout: 60000, env });
	return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

test("the startup gate passes with a matching synchronous ack", () => {
	const r = runGateDriver("ok");
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /GATE_OK/);
});

test("the startup gate fails closed on absent, stale, or refused proofs", () => {
	for (const scenario of ["absent-listener", "wrong-nonce", "wrong-profile", "wrong-version", "refuse", "malformed-ack", "bad-env"]) {
		const r = runGateDriver(scenario);
		assert.equal(r.status, 1, `${scenario}: expected a nonzero exit, got stdout=${r.stdout}`);
		assert.match(r.stderr, /guard subagent startup gate/, `${scenario}: stderr diagnostic`);
		assert.doesNotMatch(r.stdout, /GATE_OK/, `${scenario}: no success marker`);
	}
});

test("the startup gate fails closed on duplicate contract acknowledgments", () => {
	for (const scenario of ["duplicate-success", "success-then-refusal"]) {
		const r = runGateDriver(scenario);
		assert.equal(r.status, 1, `${scenario}: expected exit 1, got stdout=${r.stdout}`);
		assert.match(r.stderr, /guard subagent startup gate/, `${scenario}: stderr diagnostic`);
		assert.match(r.stderr, /duplicate/i, `${scenario}: the diagnostic names the duplicate acknowledgment`);
		assert.match(r.stderr, /exactly one/i, `${scenario}: the diagnostic states the single-responder requirement`);
		assert.doesNotMatch(r.stdout, /GATE_OK/, `${scenario}: no success marker`);
	}
});

test("the startup gate is idle without an inheritance contract", () => {
	const r = runGateDriver("no-env");
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /GATE_IDLE/);
	assert.equal(r.stderr, "", "an ordinary session registers no gate and prints nothing");
});

// ── F. Real pi subprocess startup gating ─────────────────────────────────────

function piBinaryAvailable(): string | null {
	const check = spawnSync("pi", ["--version"], { encoding: "utf8", timeout: 60000 });
	return check.status === 0 ? "pi" : null;
}

interface PiRun {
	status: number | null;
	stdout: string;
	stderr: string;
}

function runPi(args: string[], env: Record<string, string>, timeout = 180000): PiRun {
	const r = spawnSync("pi", args, { encoding: "utf8", timeout, env: { ...process.env, ...env }, cwd: makeTempDir("guard-sub-pi-cwd-") });
	return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const piSubprocessTests: { name: string; fn: () => Promise<void> }[] = [];

piSubprocessTests.push({
	name: "real pi child: a consumed contract lets the first delegated model request run",
	fn: async () => {
		const agentDir = makeTempDir("guard-sub-pihome-");
		const callLog = path.join(agentDir, "calls.log");
		fs.writeFileSync(callLog, "");
		const run = runPi(
			[
				"--mode", "json", "-p", "--no-session",
				"--extension", path.join(repoRoot, "extensions", "guard"),
				"--extension", path.join(repoRoot, "extensions", "subagent", "guard-bootstrap.ts"),
				"--extension", path.join(repoRoot, "tests", "fixtures", "guard-subagent", "fake-provider.ts"),
				"--model", "guardtest/fake",
				"Say the marker.",
			],
			{
				PI_CODING_AGENT_DIR: agentDir,
				PI_GUARD_INHERIT: serializeInheritance("auto", "subprocess-nonce-1"),
				GUARD_TEST_CALL_LOG: callLog,
				PI_OFFLINE: "1",
				PI_SKIP_VERSION_CHECK: "1",
				PI_TELEMETRY: "0",
			},
		);
		assert.equal(run.status, 0, `stdout=${run.stdout}\nstderr=${run.stderr}`);
		assert.match(run.stdout, /GUARDTEST-OK/, "the fake provider answered");
		const calls = fs.readFileSync(callLog, "utf8").trim().split("\n").filter(Boolean);
		assert.ok(calls.length >= 1, "at least one delegated model call ran after the gate");
	},
});

piSubprocessTests.push({
	name: "real pi child: a missing guard fails the gate before any model call",
	fn: async () => {
		const agentDir = makeTempDir("guard-sub-pihome-");
		const callLog = path.join(agentDir, "calls.log");
		fs.writeFileSync(callLog, "");
		const run = runPi(
			[
				"--mode", "json", "-p", "--no-session",
				"--extension", path.join(repoRoot, "extensions", "subagent", "guard-bootstrap.ts"),
				"--extension", path.join(repoRoot, "tests", "fixtures", "guard-subagent", "fake-provider.ts"),
				"--model", "guardtest/fake",
				"Say the marker.",
			],
			{
				PI_CODING_AGENT_DIR: agentDir,
				PI_GUARD_INHERIT: serializeInheritance("auto", "subprocess-nonce-2"),
				GUARD_TEST_CALL_LOG: callLog,
				PI_OFFLINE: "1",
				PI_SKIP_VERSION_CHECK: "1",
				PI_TELEMETRY: "0",
			},
		);
		assert.notEqual(run.status, 0, "the child must exit nonzero");
		assert.match(run.stderr, /guard subagent startup gate/);
		assert.equal(fs.readFileSync(callLog, "utf8").trim(), "", "no model call before the gate passes");
	},
});

piSubprocessTests.push({
	name: "real pi child: an invalid inheritance payload fails the gate before any model call",
	fn: async () => {
		const agentDir = makeTempDir("guard-sub-pihome-");
		const callLog = path.join(agentDir, "calls.log");
		fs.writeFileSync(callLog, "");
		const run = runPi(
			[
				"--mode", "json", "-p", "--no-session",
				"--extension", path.join(repoRoot, "extensions", "guard"),
				"--extension", path.join(repoRoot, "extensions", "subagent", "guard-bootstrap.ts"),
				"--extension", path.join(repoRoot, "tests", "fixtures", "guard-subagent", "fake-provider.ts"),
				"--model", "guardtest/fake",
				"Say the marker.",
			],
			{
				PI_CODING_AGENT_DIR: agentDir,
				PI_GUARD_INHERIT: "{ not json",
				GUARD_TEST_CALL_LOG: callLog,
				PI_OFFLINE: "1",
				PI_SKIP_VERSION_CHECK: "1",
				PI_TELEMETRY: "0",
			},
		);
		assert.notEqual(run.status, 0);
		assert.match(run.stderr, /guard subagent startup gate/);
		assert.equal(fs.readFileSync(callLog, "utf8").trim(), "");
	},
});

// ── Runner ────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
for (const t of tests) {
	try {
		const r = t.fn();
		if (r instanceof Promise) await r;
		passed++;
		console.log(`  ok ${t.name}`);
	} catch (err) {
		failed++;
		console.error(`  FAIL ${t.name}:`, err);
	}
}

const pi = piBinaryAvailable();
if (pi === null) {
	console.log(`SKIP: real pi subprocess tests: the pi binary is not on PATH`);
} else {
	for (const t of piSubprocessTests) {
		try {
			await t.fn();
			passed++;
			console.log(`  ok ${t.name}`);
		} catch (err) {
			failed++;
			console.error(`  FAIL ${t.name}:`, err);
		}
	}
}

console.log(`\n${passed} passed, ${failed} failed`);
for (const dir of [...tempDirs, ...harnessHomeDirs]) {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		// Best-effort cleanup.
	}
}
if (failed > 0) process.exit(1);
process.exit(0);
