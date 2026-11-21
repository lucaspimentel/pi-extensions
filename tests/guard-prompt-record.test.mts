// Harness tests for guard's prompt-record ledger (extensions/guard/prompt-record.ts
// and its wiring in extensions/guard/index.ts): one custom session entry per
// interactive prompt and per refusal, the refusal classifier, the payload
// rules (capped strings, omitted fields), the once-per-session warning, and the
// guarantee that a record never changes enforcement.
//
// Run: node --test tests/guard-prompt-record.test.mts
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, realpathSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { initTheme } from "@earendil-works/pi-coding-agent";

import guardExtension from "../extensions/guard/index.ts";
import {
	GUARD_PROMPT_CUSTOM_TYPE,
	buildPromptRecord,
	promptActionFor,
	promptCallSubjects,
	promptCallText,
	promptRefusal,
	recordedRefusal,
	refusalOutcomeFor,
	refusalReason,
	writePromptRecord,
	type PromptRecord,
} from "../extensions/guard/prompt-record.ts";
import { DialogCancelledError } from "../extensions/guard/dialogs.ts";
import { RuntimeNotReadyError } from "../extensions/guard/runtime.ts";
import { drainTempDirs, makeTempDir, tempDirs } from "./guard-test-temp.mts";

// Owned-stage components need an initialized host theme.
initTheme("dark", false);

after(() => { drainTempDirs(); });

/** The real home, captured before any HOME override in a test. */
const REAL_HOME = process.env.HOME ?? os.homedir();

/**
 * A grantable external directory: outside the workspace and outside the
 * reserved sandbox mountpoints, under the real home (never /tmp). Created
 * before any HOME override so mount resolution sees the real path. An absolute
 * prefix is the one case the shared helper does not cover (it joins
 * `os.tmpdir()`), so the directory is adopted for the same cleanup.
 */
function externalDir(): string {
	const dir = realpathSync(mkdtempSync(path.join(REAL_HOME, ".guard-record-grant-")));
	tempDirs.push(dir);
	return dir;
}

/** Override HOME for the duration of fn so guard config stays in a temp dir. */
async function withTempHome<T>(fn: () => Promise<T> | T): Promise<T> {
	const realHome = process.env.HOME;
	process.env.HOME = makeTempDir("guard-record-home-");
	try {
		return await fn();
	} finally {
		process.env.HOME = realHome;
	}
}

// ── Pure module: the refusal classifier and the payload rules ────────────────

test("refusalOutcomeFor classifies guard refusals, foreign cancellations, and the rest", () => {
	assert.equal(refusalOutcomeFor(promptRefusal("expired", "guard: approval expired after a policy change")), "expired");
	assert.equal(refusalOutcomeFor(promptRefusal("refused-rules", "guard: the reviewed rules no longer authorize the selected steps")), "refused-rules");
	assert.equal(refusalOutcomeFor(promptRefusal("headless-deny", "guard: headless prompts deny")), "headless-deny");
	assert.equal(refusalOutcomeFor(promptRefusal("cancelled", "guard: call aborted; nothing saved or executed")), "cancelled");
	assert.equal(refusalOutcomeFor(new Error("guard: x")), "error");
	// An already-recorded refusal is skipped by every recording catch.
	assert.equal(refusalOutcomeFor(recordedRefusal("guard: execution denied")), null);
	// Foreign cancellations are typed: the dialog gate and an aborted SDK selector.
	assert.equal(refusalOutcomeFor(new DialogCancelledError("guard: dialog cancelled: approval expired during shutdown")), "cancelled");
	assert.equal(refusalOutcomeFor(Object.assign(new Error("the operation was aborted"), { name: "AbortError" })), "cancelled");
	// The runtime's readiness gate is staleness, not an unexpected failure.
	assert.equal(refusalOutcomeFor(new RuntimeNotReadyError("guard: runtime disposed")), "expired");
	assert.equal(refusalOutcomeFor(new RuntimeNotReadyError("guard: unresolved teardown: worker did not stop")), "expired");
	assert.equal(refusalOutcomeFor(new RuntimeNotReadyError("guard: policy transition in progress; retry the call")), "expired");
	// No message is ever classified: a plain error carrying a gate's wording is an
	// unexpected failure, and only the type makes it staleness or a cancellation.
	assert.equal(refusalOutcomeFor(new Error("guard: dialog cancelled: call aborted")), "error");
	assert.equal(refusalOutcomeFor(new Error("guard: runtime disposed")), "error");
	assert.equal(refusalOutcomeFor(new Error("guard: unresolved teardown: worker did not stop")), "error");
	assert.equal(refusalOutcomeFor("boom"), "error");
	// Only guard's own refusals drop the "Error: " rendering.
	assert.equal(refusalReason(promptRefusal("error", "guard: x")), "guard: x");
	assert.equal(refusalReason(new Error("boom")), "Error: boom");
});

test("buildPromptRecord caps every ledger string and omits absent fields", () => {
	const long = "x".repeat(500);
	const record = buildPromptRecord({
		tool: "host_bash", class: "host-shell", kind: "host-shell", action: "prompt",
		subjects: [long], display: long, reason: "widened by the default profile cell",
		profile: "default", fromCodemode: false, toolCallId: "call_1",
	}, "allow-once", { dialogMs: -5, rules: [long] });
	assert.equal(record.display.length, 200);
	assert.equal(record.subjects[0]?.length, 200);
	assert.equal(record.rules?.[0]?.length, 200);
	assert.equal(record.reason, "widened by the default profile cell");
	assert.equal(record.dialogMs, 0, "a negative measurement is clamped, never dropped");
	assert.equal("scope" in record, false);
	assert.equal("root" in record, false);
	assert.equal("switchedTo" in record, false);

	// No decision was reached, so there is no action to name.
	const aborted = buildPromptRecord({
		tool: "host_bash", class: "host-shell", kind: "host-shell",
		subjects: [], display: "", reason: "guard: call aborted; nothing saved or executed",
		profile: "default", fromCodemode: true, toolCallId: "call_2",
	}, "cancelled");
	assert.equal("action" in aborted, false);
	assert.equal(aborted.fromCodemode, true);
	assert.equal("dialogMs" in aborted, false, "no dialog opened");
});

test("promptActionFor, promptCallText, and promptCallSubjects project one call", () => {
	assert.equal(promptActionFor("allow"), "allow");
	assert.equal(promptActionFor("deny"), "deny");
	assert.equal(promptActionFor("classify"), "prompt");
	const shell = { kind: "host-shell", shell: "host-bash", command: "git push origin main" } as const;
	assert.equal(promptCallText(shell), "git push origin main");
	assert.deepEqual(promptCallSubjects(shell, null), []);
	const write = { kind: "local-write", tool: "write", path: "/tmp/x.txt" } as const;
	assert.equal(promptCallText(write), "/tmp/x.txt");
	assert.deepEqual(promptCallSubjects(write, null), ["/tmp/x.txt"]);
	assert.equal(promptCallText({ kind: "web-fetch", tool: "web_fetch", url: "https://example.com" }), "");
});

test("writePromptRecord reports failure instead of throwing", () => {
	const ok = writePromptRecord(() => ({ tool: "bash" } as unknown as PromptRecord), () => {});
	assert.equal(ok, true);
	assert.equal(writePromptRecord(() => { throw new Error("payload"); }, () => {}), false);
	assert.equal(writePromptRecord(() => ({ tool: "bash" } as unknown as PromptRecord), () => { throw new Error("no session file"); }), false);
});

// ── Harness: the five prompt and refusal surfaces ────────────────────────────

interface Harness {
	handlers: Record<string, Array<(event: unknown, ctx: unknown) => unknown>>;
	commandHandlers: Map<string, (args: string, ctx: unknown) => Promise<void>>;
	registeredTools: Map<string, { execute: (...args: any[]) => Promise<any> }>;
	entries: Array<{ customType: string; data: PromptRecord }>;
	notifications: string[];
	appendEntryThrows: boolean;
}

function makeHarness(): Harness {
	const h: Harness = {
		handlers: {},
		commandHandlers: new Map(),
		registeredTools: new Map(),
		entries: [],
		notifications: [],
		appendEntryThrows: false,
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
		registerShortcut: () => {},
		registerFlag: () => {},
		appendEntry: (customType: string, data: unknown) => {
			if (h.appendEntryThrows) throw new Error("the session file is unavailable");
			h.entries.push({ customType, data: data as PromptRecord });
		},
		sendUserMessage: () => {},
		getCommands: () => [],
		getActiveTools: () => [],
		getAllTools: () => [],
		events: { on: () => () => {}, emit: () => {} },
	};
	(guardExtension as (api: unknown) => void)(api);
	return h;
}

/** The prompt I/O surface: scripted selector answers, consumed in order. */
function harnessCtx(h: Harness, cwd: string, options: { hasUI?: boolean; select?: Array<string | undefined> } = {}): Record<string, any> {
	const script = [...(options.select ?? [])];
	return {
		cwd,
		hasUI: options.hasUI ?? true,
		// rpc keeps the plain native selector (no owned editor stages), which is
		// all the once/deny paths of these tests need.
		mode: "rpc",
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
			setStatus: () => {},
			setWorkingVisible: () => {},
			select: async () => script.shift(),
			input: async () => undefined,
			theme: { fg: (_role: string, s: string) => s },
		},
	};
}

async function startSession(h: Harness, ctx: Record<string, any>): Promise<void> {
	for (const handler of h.handlers.session_start ?? []) await handler({}, ctx);
}

async function setProfile(h: Harness, ctx: Record<string, any>, profile: string): Promise<void> {
	await h.commandHandlers.get("guard")!(`profile ${profile}`, ctx);
}

function toolCall(h: Harness, event: Record<string, unknown>, ctx: Record<string, any>): Promise<{ block?: boolean; reason?: string } | undefined> {
	return Promise.resolve(h.handlers.tool_call![0]!(event, ctx) as { block?: boolean; reason?: string } | undefined);
}

test("a hook-level policy deny records one refusal with the decision fields", () => withTempHome(async () => {
	const h = makeHarness();
	const ctx = harnessCtx(h, makeTempDir("guard-record-cwd-"));
	await startSession(h, ctx);
	// The research profile denies host shell execution outright.
	await setProfile(h, ctx, "research");
	const blocked = await toolCall(h, { toolName: "host_bash", toolCallId: "call_deny_1", input: { command: "touch /var/tmp/guard-record-probe" } }, ctx);
	assert.equal(blocked?.block, true);
	assert.equal(typeof blocked?.reason, "string");
	assert.equal(h.entries.length, 1);
	const { customType, data } = h.entries[0]!;
	assert.equal(customType, GUARD_PROMPT_CUSTOM_TYPE);
	assert.equal(data.tool, "host_bash");
	assert.equal(data.class, "host-shell");
	assert.equal(data.kind, "host-shell");
	assert.equal(data.action, "deny");
	assert.equal(data.outcome, "deny");
	assert.equal(data.profile, "research");
	assert.equal(data.fromCodemode, false);
	assert.equal(data.toolCallId, "call_deny_1");
	assert.equal(data.reason, blocked?.reason, "the recorded reason is the block the model saw");
	assert.deepEqual(data.subjects, ["touch /var/tmp/guard-record-probe"]);
	assert.equal(data.display, "touch /var/tmp/guard-record-probe");
	assert.equal(data.dialogMs, undefined, "no dialog opened");
	// The entry timestamp comes from the session entry itself.
	assert.equal("ts" in data, false);
	assert.equal("rules" in data, false);
}));

test("a nested call records fromCodemode, still exactly once", () => withTempHome(async () => {
	const h = makeHarness();
	const ctx = harnessCtx(h, makeTempDir("guard-record-cwd-"));
	await startSession(h, ctx);
	await setProfile(h, ctx, "research");
	const blocked = await toolCall(h, {
		toolName: "host_bash", toolCallId: "call_nested_2/1", parentToolCallId: "call_nested_2",
		input: { command: "touch /var/tmp/guard-record-probe" },
	}, ctx);
	assert.equal(blocked?.block, true);
	assert.match(String(blocked?.reason), /from codemode script/);
	assert.equal(h.entries.length, 1);
	assert.equal(h.entries[0]!.data.fromCodemode, true);
	assert.equal(h.entries[0]!.data.toolCallId, "call_nested_2/1");
}));

test("a write/edit prompt records its answer and its dialog time", () => withTempHome(async () => {
	const h = makeHarness();
	const workspace = makeTempDir("guard-record-cwd-");
	const target = path.join(makeTempDir("guard-record-out-"), "probe.txt");
	const ctx = harnessCtx(h, workspace, { select: ["Deny once"] });
	await startSession(h, ctx);
	const blocked = await toolCall(h, { toolName: "write", toolCallId: "call_write_1", input: { file_path: target, content: "x" } }, ctx);
	assert.equal(blocked?.block, true);
	assert.equal(blocked?.reason, "guard: write/edit denied");
	assert.equal(h.entries.length, 1);
	const data = h.entries[0]!.data;
	assert.equal(data.tool, "write");
	assert.equal(data.kind, "local-write");
	assert.equal(data.action, "prompt");
	assert.equal(data.outcome, "deny-once");
	assert.deepEqual(data.subjects, [target]);
	assert.equal(data.display, target);
	assert.equal(typeof data.dialogMs, "number");
	assert.ok((data.dialogMs ?? -1) >= 0);
}));

test("a headless write/edit prompt records headless-deny", () => withTempHome(async () => {
	const h = makeHarness();
	const workspace = makeTempDir("guard-record-cwd-");
	const target = path.join(makeTempDir("guard-record-out-"), "probe.txt");
	const ctx = harnessCtx(h, workspace, { hasUI: false });
	await startSession(h, ctx);
	const blocked = await toolCall(h, { toolName: "write", toolCallId: "call_headless_1", input: { file_path: target, content: "x" } }, ctx);
	assert.equal(blocked?.block, true);
	assert.equal(h.entries.length, 1);
	assert.equal(h.entries[0]!.data.outcome, "headless-deny");
	assert.equal(h.entries[0]!.data.action, "deny");
}));

test("an executor prompt records its answer, then the denial throws", () => withTempHome(async () => {
	const h = makeHarness();
	const ctx = harnessCtx(h, makeTempDir("guard-record-cwd-"), { select: ["Deny once"] });
	await startSession(h, ctx);
	const tool = h.registeredTools.get("host_bash")!;
	await assert.rejects(() => tool.execute("call_exec_1", { command: "touch /var/tmp/guard-record-probe" }, undefined, undefined, ctx), /execution denied/);
	assert.equal(h.entries.length, 1);
	const data = h.entries[0]!.data;
	assert.equal(data.tool, "host_bash");
	assert.equal(data.action, "prompt");
	assert.equal(data.outcome, "deny-once");
	assert.equal(data.toolCallId, "call_exec_1");
	assert.equal(typeof data.dialogMs, "number");
	assert.equal("switchedTo" in data, false);
}));

test("an aborted call records a cancellation, with no decision to name", () => withTempHome(async () => {
	const h = makeHarness();
	const ctx = harnessCtx(h, makeTempDir("guard-record-cwd-"));
	await startSession(h, ctx);
	const controller = new AbortController();
	controller.abort();
	const tool = h.registeredTools.get("host_bash")!;
	await assert.rejects(() => tool.execute("call_abort_1", { command: "touch /var/tmp/guard-record-probe" }, controller.signal, undefined, ctx), /aborted/);
	assert.equal(h.entries.length, 1);
	const data = h.entries[0]!.data;
	assert.equal(data.outcome, "cancelled");
	assert.equal(data.toolCallId, "call_abort_1");
	assert.equal("action" in data, false);
	assert.equal(data.dialogMs, undefined);
}));

test("a fail-closed block records an error and keeps its reason", () => withTempHome(async () => {
	const h = makeHarness();
	const ctx = harnessCtx(h, makeTempDir("guard-record-cwd-"));
	// No session_start: policyFor throws and the hook fails closed.
	const blocked = await toolCall(h, { toolName: "host_bash", toolCallId: "call_closed_1", input: { command: "ls" } }, ctx);
	assert.equal(blocked?.block, true);
	assert.match(String(blocked?.reason), /failed closed/);
	assert.equal(h.entries.length, 1);
	const data = h.entries[0]!.data;
	assert.equal(data.outcome, "error");
	assert.equal(data.tool, "host_bash");
	// The call cannot be mapped before the session exists, so the classification
	// fields stay unknown; the tool name is still the truth that matters.
	assert.equal(data.class, "unknown");
	assert.equal(data.kind, "unknown");
	assert.equal("action" in data, false);
}));

test("read-grant prompts record their answers, including the refusal paths", () => withTempHome(async () => {
	const h = makeHarness();
	const workspace = makeTempDir("guard-record-cwd-");
	// Outside the workspace, so the request is a real read grant rather than one
	// guard refuses as already covered, and outside /tmp (a reserved mount).
	const requested = path.join(externalDir(), "config.json");
	const ctx = harnessCtx(h, workspace, { select: ["Deny"] });
	await startSession(h, ctx);
	const denied = await h.registeredTools.get("request_read_access")!.execute("call_read_1", { path: requested }, undefined, undefined, ctx);
	assert.equal(denied.isError, true);
	assert.match(String(denied.content[0].text), /Read request denied/);
	assert.equal(h.entries.length, 1);
	const data = h.entries[0]!.data;
	assert.equal(data.tool, "request_read_access");
	// The decision layer's own mapping: guard's request tool declares
	// readOnlyHint false and no destructive hint, so the annotation stage and the
	// name heuristic both pass it through to the fail-closed remote-write class.
	// The record reports that mapping; the grant's subject is the requested path.
	assert.equal(data.class, "remote-write");
	assert.equal(data.kind, "remote-write");
	assert.equal(data.outcome, "deny-once");
	assert.deepEqual(data.subjects, [requested]);
	assert.equal(data.display, requested);
	assert.equal(typeof data.dialogMs, "number");

	// Cancelling the selector grants nothing and records no-grant instead.
	const cancelled = harnessCtx(h, workspace, { select: [undefined] });
	await startSession(h, cancelled);
	await h.registeredTools.get("request_read_access")!.execute("call_read_2", { path: requested }, undefined, undefined, cancelled);
	assert.equal(h.entries.length, 2);
	assert.equal(h.entries[1]!.data.outcome, "no-grant");
	assert.equal(h.entries[1]!.data.toolCallId, "call_read_2");
}));

test("a headless read request records headless-deny", () => withTempHome(async () => {
	const h = makeHarness();
	const workspace = makeTempDir("guard-record-cwd-");
	const requested = path.join(externalDir(), "config.json");
	const ctx = harnessCtx(h, workspace, { hasUI: false });
	await startSession(h, ctx);
	const denied = await h.registeredTools.get("request_read_access")!.execute("call_read_3", { path: requested }, undefined, undefined, ctx);
	assert.equal(denied.isError, true);
	assert.equal(h.entries.length, 1);
	assert.equal(h.entries[0]!.data.outcome, "headless-deny");
	assert.equal(h.entries[0]!.data.action, "deny");
}));

test("a failed write warns once per session and never changes enforcement", () => withTempHome(async () => {
	const h = makeHarness();
	const ctx = harnessCtx(h, makeTempDir("guard-record-cwd-"));
	await startSession(h, ctx);
	await setProfile(h, ctx, "research");
	h.appendEntryThrows = true;
	const first = await toolCall(h, { toolName: "host_bash", toolCallId: "call_warn_1", input: { command: "touch /var/tmp/guard-record-probe" } }, ctx);
	const second = await toolCall(h, { toolName: "host_bash", toolCallId: "call_warn_2", input: { command: "touch /var/tmp/guard-record-probe" } }, ctx);
	assert.equal(first?.block, true, "the block still happens");
	assert.equal(second?.block, true);
	assert.equal(typeof second?.reason, "string", "the block reason is unchanged");
	assert.equal(h.entries.length, 0);
	assert.equal(h.notifications.filter((message) => /could not record a prompt entry/.test(message)).length, 1);
}));
