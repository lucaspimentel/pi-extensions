// Tests for the session-name-llm extension (manual titling).
//
// Covers the pure helpers (sanitize, prompt build, recent-turns build,
// anchors, skill rewriting) and drives the REAL default export with a mock
// pi/ctx to verify: registration surface (one command, session lifecycle
// handlers only), regeneration of a named session, titling of an unnamed one,
// replacing a manual name, unchanged-title and failure reporting, the
// in-flight refusal, a rename that lands during the model call winning, and
// the stale-run generation guard, and the global title model pin
// (resolution, once-per-session ignored-pin notes, /name-llm model picker and
// clear).
//
// Run: node tests/session-name-llm.test.mts
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate the global pin file: a real ~/.pi/agent/session-name-llm.json must
// never leak into these tests. Set before the import; getAgentDir() reads the
// variable on every call.
const agentDir = mkdtempSync(join(tmpdir(), "session-name-llm-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const pinFile = join(agentDir, "session-name-llm.json");
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));

const mod = await import("../extensions/session-name-llm.ts");
const {
	collapseWhitespace,
	sanitizeTitle,
	buildRegenerationPrompt,
	buildRecentTurnsText,
	extractInitialPrompts,
	deriveTitleSource,
	readDiskSessionName,
} = mod;

const msgEntry = (role: string, text: string) => ({
	type: "message",
	message: { role, content: [{ type: "text", text }] },
});

// ── Pure helpers ─────────────────────────────────────────────────────────────

assert.equal(collapseWhitespace("  a \n\t b  "), "a b");

assert.equal(sanitizeTitle('  "Fix   auth\nbug"  '), "Fix auth bug");
assert.equal(sanitizeTitle("`Add tests`"), "Add tests");
assert.equal(sanitizeTitle("y".repeat(70)).length, 40);
assert.equal(sanitizeTitle("   "), "");

// A named session gets the current title and the keep-or-revise instruction.
const regenPrompt = buildRegenerationPrompt(
	"Old title",
	["please   fix\nthe auth bug"],
	"User: fix auth\nAssistant: done",
);
assert.ok(regenPrompt.includes("<current_title>Old title</current_title>"));
assert.ok(regenPrompt.includes("keep it or revise it"));
assert.ok(regenPrompt.includes("please fix the auth bug"));
assert.ok(regenPrompt.includes("User: fix auth"));
assert.ok(regenPrompt.includes("<recent_conversation>"));

// An unnamed session omits the block and is told it has no title: the model
// must never be asked to keep or revise an empty one.
const unnamedPrompt = buildRegenerationPrompt("", ["first prompt"], "User: first prompt");
assert.ok(!unnamedPrompt.includes("<current_title"), "an unnamed session must omit the current-title block");
assert.ok(unnamedPrompt.includes("does not have a title yet"));
assert.ok(!unnamedPrompt.includes("keep it or revise it"), "the keep-or-revise line must not describe an empty title");
assert.ok(unnamedPrompt.includes("first prompt"));
assert.equal(buildRegenerationPrompt("   ", [], "User: x").includes("<current_title"), false, "a blank title is no title");

// Each initial prompt is normalized and clipped to 1000 characters
// independently; both long anchors survive the combined prompt.
const longAnchorA = "a".repeat(1500);
const longAnchorB = "b".repeat(1500);
const anchorsPrompt = buildRegenerationPrompt("t", [longAnchorA, longAnchorB], "User: recent");
assert.ok(anchorsPrompt.includes("a".repeat(1000)), "first anchor present, clipped to 1000");
assert.ok(anchorsPrompt.includes("b".repeat(1000)), "second anchor present, clipped to 1000");
assert.ok(!anchorsPrompt.includes("a".repeat(1001)), "first anchor clipped at 1000");
assert.ok(!anchorsPrompt.includes("b".repeat(1001)), "second anchor clipped at 1000");
assert.ok(!anchorsPrompt.includes("<original_requests>\n\n"), "empty anchors must not create a blank section");
assert.ok(buildRegenerationPrompt("t", [], "User: x").includes("<recent_conversation>"), "no anchors still builds a prompt");

// extractInitialPrompts: first two nonempty user texts, in branch order.
assert.deepEqual(
	extractInitialPrompts([
		msgEntry("user", "first prompt"),
		msgEntry("assistant", "ack"),
		msgEntry("user", "second prompt"),
		msgEntry("user", "third prompt"),
	]),
	["first prompt", "second prompt"],
);
assert.deepEqual(extractInitialPrompts([msgEntry("assistant", "hi"), { type: "other" }]), []);
assert.deepEqual(extractInitialPrompts([]), []);

// deriveTitleSource: skill invocations are rewritten, not echoed verbatim.
const skillOnly = '<skill name="update-changelog" location="/home/lucas/.pi/agent/skills/update-changelog/SKILL.md">\nskill body text\n</skill>';
assert.equal(deriveTitleSource(skillOnly), "Invoked /update-changelog skill");
assert.equal(
	deriveTitleSource(`${skillOnly}\n${skillOnly.replace("update-changelog", "update-docs")}`),
	"Invoked /update-changelog, /update-docs skills",
);
assert.equal(
	deriveTitleSource(`<skill name="ship">body</skill> then please ship it`),
	"then please ship it",
	"mixed prompt keeps the user-authored text",
);
assert.equal(
	deriveTitleSource("<skill name=\"ship\">truncated, never closed"),
	"Invoked /ship skill",
	"an unterminated skill block is still rewritten",
);
assert.equal(deriveTitleSource("please   fix\nthe login bug"), "please fix the login bug");
assert.equal(deriveTitleSource("   "), "");
assert.equal(deriveTitleSource(""), "");

// extractInitialPrompts derives skill invocations and skips nameless ones.
assert.deepEqual(
	extractInitialPrompts([
		msgEntry("user", skillOnly),
		msgEntry("user", "real request"),
	]),
	["Invoked /update-changelog skill", "real request"],
);
assert.deepEqual(
	extractInitialPrompts([msgEntry("user", "<skill>no name attribute</skill>")]),
	[],
);

// Recent turns rewrite skill invocations for user messages only.
const skillTurns = buildRecentTurnsText([
	msgEntry("user", skillOnly),
	msgEntry("assistant", "<skill> tags quoted in prose stay"),
]);
assert.ok(skillTurns.includes("User: Invoked /update-changelog skill"));
assert.ok(skillTurns.includes('Assistant: <skill> tags quoted in prose stay'));

// Eligible messages are selected BEFORE the window, so ignored or empty
// entries do not consume a slot.
const turns = buildRecentTurnsText(
	[
		msgEntry("user", "u1"),
		msgEntry("assistant", "a1"),
		{ type: "message", message: { role: "system", content: "ignored" } },
		{ type: "message", message: { role: "user", content: "" } },
		{ type: "message", message: { role: "user", content: [] } },
		{ type: "other" },
		msgEntry("user", "u2"),
	],
	2,
);
assert.ok(turns.includes("Assistant: a1"));
assert.ok(turns.includes("User: u2"));
assert.ok(!turns.includes("u1"), "eligible messages outside the window must be excluded");
assert.ok(!turns.includes("ignored"), "non user/assistant roles must be excluded");

// The window selects the last 10 ELIGIBLE messages; each is clipped to 300
// characters independently and the joined result is never sliced.
const windowEntries: any[] = [];
for (let i = 0; i < 12; i++) {
	windowEntries.push(msgEntry(i % 2 === 0 ? "user" : "assistant", `m${String(i).padStart(2, "0")} ${"z".repeat(400)}`));
}
const windowTurns = buildRecentTurnsText(windowEntries);
for (const i of [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) {
	assert.ok(windowTurns.includes(`m${String(i).padStart(2, "0")} `), `eligible message ${i} must be in the window`);
}
for (const i of [0, 1]) {
	assert.ok(!windowTurns.includes(`m${String(i).padStart(2, "0")} `), `message ${i} must fall outside the 10-message window`);
}
assert.ok(windowTurns.includes("z".repeat(296)), "each message keeps its full 300-character clip");
assert.ok(!windowTurns.includes("z".repeat(297)), "each message is clipped at 300 characters");
assert.ok(windowTurns.startsWith("User: m02 "), "snippets stay in chronological order with role labels");
assert.ok(windowTurns.split("\n").length === 10, "one labeled line per selected message");

// readDiskSessionName: last session_info wins, names are normalized the way
// SessionManager normalizes them, unreadable files fail open.
{
	const dir = mkdtempSync(join(tmpdir(), "session-name-llm-"));
	const file = join(dir, "session.jsonl");
	assert.equal(readDiskSessionName(undefined), undefined);
	assert.equal(readDiskSessionName(join(dir, "missing.jsonl")), undefined);
	writeFileSync(file, `${JSON.stringify({ type: "session", id: "h" })}\n`);
	assert.equal(readDiskSessionName(file), undefined, "no session_info entry means no name");
	appendFileSync(file, `${JSON.stringify({ type: "session_info", name: "first" })}\n`);
	assert.equal(readDiskSessionName(file), "first");
	appendFileSync(file, `${JSON.stringify({ type: "message", message: { role: "user" } })}\n`);
	appendFileSync(file, `${JSON.stringify({ type: "session_info", name: "second  name" })}\n`);
	assert.equal(readDiskSessionName(file), "second  name", "latest session_info entry wins");
	writeFileSync(
		file,
		`${JSON.stringify({ type: "session_info", name: "multi\nline" })}\n`,
	);
	assert.equal(readDiskSessionName(file), "multi line", "newline runs collapse to spaces");
	writeFileSync(file, `${JSON.stringify({ type: "session_info", name: "" })}\n`);
	assert.equal(readDiskSessionName(file), undefined, "an empty name clears");
	rmSync(dir, { recursive: true, force: true });
}

// ── Mock pi/ctx ──────────────────────────────────────────────────────────────

type MockPi = {
	name: () => string | undefined;
	setCallCount: () => number;
	manualRename: (next: string) => void;
	getSessionName: () => string | undefined;
	setSessionName: (next: string) => void;
};

/**
 * The extension only ever writes through pi.setSessionName; a human /name goes
 * through manualRename, which must not count as an extension write.
 */
function makePi(initialName?: string, sessionFile?: string): MockPi {
	let name = initialName;
	let setCalls = 0;
	return {
		name: () => name,
		setCallCount: () => setCalls,
		manualRename: (next: string) => {
			name = next;
		},
		getSessionName: () => name,
		setSessionName(next: string) {
			setCalls++;
			name = next;
			// Mirror real pi: the live session manager persists every name
			// append synchronously to the session file.
			if (sessionFile) {
				appendFileSync(sessionFile, `${JSON.stringify({ type: "session_info", name: next })}\n`);
			}
		},
	};
}

/** Register the extension against a mock pi and capture its command/handlers. */
function load(pi: MockPi) {
	const commands: Record<string, { description: string; handler: (args: string, ctx: any) => Promise<void> }> = {};
	const handlers: Record<string, (event: any, ctx: any) => unknown> = {};
	mod.default({
		...pi,
		on(event: string, handler: any) {
			handlers[event] = handler;
		},
		registerCommand(command: string, opts: any) {
			commands[command] = opts;
		},
	} as any);
	return { commands, handlers };
}

function makeCtx(opts: {
	complete?: (model: any, context: any, options?: any) => Promise<any>;
	authed?: boolean | ((model: any) => boolean);
	entries?: any[];
	sessionFile?: string;
	sessionId?: string;
	model?: any;
	models?: any[];
	hasUI?: boolean;
	select?: (title: string, items: string[], opts?: any) => Promise<string | undefined>;
} = {}) {
	const authed = opts.authed ?? true;
	const ctx: any = {
		hasUI: opts.hasUI ?? true,
		scopedModels: [],
		signal: new AbortController().signal,
		sessionManager: {
			getSessionId: () => opts.sessionId ?? "s1",
			getBranch: () => opts.entries ?? [],
			getSessionFile: () => opts.sessionFile,
		},
		model: "model" in opts ? opts.model : { provider: "anthropic", id: "claude-x" },
		modelRegistry: {
			hasConfiguredAuth: (m: any) => (typeof authed === "function" ? authed(m) : authed),
			find: (provider: string, id: string) => (opts.models ?? []).find((m) => m.provider === provider && m.id === id),
			getAvailable: () => opts.models ?? [],
			// generateTitle uses streamSimple(...).result(); delegate to the
			// same complete mock so the assertions below stay simple.
			streamSimple: (model: any, context: any, options?: any) => ({
				result: () => (opts.complete ?? (async () => ({ content: [], errorMessage: undefined })))(model, context, options),
			}),
		},
	};
	ctx.notifies = [] as { msg: string; level?: string }[];
	ctx.selects = [] as { title: string; items: string[] }[];
	ctx.ui = {
		notify: (msg: string, level?: string) => ctx.notifies.push({ msg, level }),
		select: async (title: string, items: string[], selectOpts?: any) => {
			ctx.selects.push({ title, items });
			return opts.select ? opts.select(title, items, selectOpts) : undefined;
		},
	};
	return ctx;
}

const textResponse = (text: string) => ({
	content: [{ type: "text", text }],
	errorMessage: undefined,
});

const toastWith = (ctx: any, needle: string) =>
	ctx.notifies.find((n: { msg: string }) => n.msg.includes(needle));

async function waitFor(fn: () => boolean, ms = 2000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!fn()) {
		if (Date.now() > deadline) throw new Error("waitFor: condition not met in time");
		await new Promise((r) => setTimeout(r, 5));
	}
}

// ── Extension flow ───────────────────────────────────────────────────────────

// 1. Registration surface: exactly one command and the session lifecycle
// handlers. Nothing titles a session automatically any more.
{
	const pi = makePi();
	const { commands, handlers } = load(pi);
	assert.deepEqual(Object.keys(commands), ["name-llm"]);
	assert.ok(commands["name-llm"].description.length > 0, "the command needs a description");
	assert.deepEqual(Object.keys(handlers).sort(), ["session_shutdown", "session_start"]);
	assert.ok(!handlers.turn_end, "no automatic path may remain");
	assert.ok(!handlers.before_agent_start, "the first-prompt capture is gone");
}

// 2. Fresh, empty session: no conversation, zero model calls, name unset.
{
	const pi = makePi();
	const { commands } = load(pi);
	let calls = 0;
	const ctx = makeCtx({ complete: async () => { calls++; return textResponse("never"); }, entries: [] });
	await commands["name-llm"].handler("", ctx);
	assert.equal(calls, 0, "an empty session must not call the model");
	assert.equal(pi.name(), undefined, "an empty session must stay unnamed");
	assert.equal(pi.setCallCount(), 0);
	const toast = toastWith(ctx, "Nothing to title yet");
	assert.ok(toast, "the empty-session noop must be reported");
	assert.equal(toast.level, "info");
	assert.ok(!toastWith(ctx, "Could not regenerate"), "an empty session is not a failure");
}

// 3. Unnamed session with a conversation: titled from the branch, with the
// prompt told there is no current title.
{
	const pi = makePi();
	const { commands } = load(pi);
	const sent: any[] = [];
	const ctx = makeCtx({
		complete: async (_model, context) => {
			sent.push(context);
			return textResponse("  Add a settings page  ");
		},
		entries: [msgEntry("user", "please add a settings page"), msgEntry("assistant", "on it")],
	});
	await commands["name-llm"].handler("", ctx);
	assert.equal(pi.name(), "Add a settings page");
	assert.equal(pi.setCallCount(), 1);
	assert.ok(toastWith(ctx, "Session title: Add a settings page"), "the new title must be reported");
	const prompt = JSON.stringify(sent[0]);
	assert.ok(!prompt.includes("<current_title"), "the unnamed prompt must omit the current-title block");
	assert.ok(prompt.includes("does not have a title yet"));
	assert.ok(prompt.includes("please add a settings page"), "the branch anchors feed the prompt");
}

// 4. Named session: the prompt carries the current title, the branch's
// original prompts as anchors (chronological, including history from before
// /resume or /fork), and the recent turns.
{
	const pi = makePi("Old title");
	const { commands } = load(pi);
	const sent: any[] = [];
	const ctx = makeCtx({
		complete: async (_model, context) => {
			sent.push(context);
			return textResponse("Bottlecap release gates");
		},
		entries: [
			msgEntry("user", "original theme one"),
			msgEntry("assistant", "ack one"),
			msgEntry("user", "original theme two"),
			msgEntry("user", "now working on the parser"),
			msgEntry("assistant", "ok"),
		],
	});
	await commands["name-llm"].handler("", ctx);
	assert.equal(pi.name(), "Bottlecap release gates");
	const prompt = JSON.stringify(sent[0]);
	assert.ok(prompt.includes("<current_title>Old title</current_title>"));
	assert.ok(prompt.includes("keep it or revise it"));
	assert.ok(prompt.includes("now working on the parser"), "recent turns are sampled");
	assert.ok(prompt.includes("original theme one") && prompt.includes("original theme two"), "both anchors are present");
	const anchorSection = prompt.slice(prompt.indexOf("<original_requests>"), prompt.indexOf("</original_requests>"));
	assert.ok(anchorSection.indexOf("original theme one") < anchorSection.indexOf("original theme two"), "anchors are chronological");
	assert.ok(!anchorSection.includes("ack one"), "assistant messages are sampled, not treated as anchors");
}

// 5. A manual name is replaced: that is what asking for a generated title means.
{
	const pi = makePi("my manual name");
	const { commands } = load(pi);
	const ctx = makeCtx({
		complete: async () => textResponse("Generated title"),
		entries: [msgEntry("user", "recent work")],
	});
	await commands["name-llm"].handler("", ctx);
	assert.equal(pi.name(), "Generated title", "an explicit command replaces a manual name");
	assert.equal(pi.setCallCount(), 1);
	assert.ok(toastWith(ctx, "Session title: Generated title"));
}

// 6. Unchanged title: the model runs, but the name is never re-set (no
// redundant session_info_changed, no tab rename).
{
	const pi = makePi("same title");
	const { commands } = load(pi);
	let calls = 0;
	const ctx = makeCtx({
		complete: async () => {
			calls++;
			return textResponse("same title");
		},
		entries: [msgEntry("user", "recent")],
	});
	await commands["name-llm"].handler("", ctx);
	assert.equal(calls, 1, "the model still runs");
	assert.equal(pi.setCallCount(), 0, "an unchanged title must not re-set the name");
	const toast = toastWith(ctx, "Title unchanged: same title");
	assert.ok(toast, "an unchanged title is reported");
	assert.equal(toast.level, "info");
	assert.ok(!toastWith(ctx, "Could not regenerate"), "an unchanged title is not a failure");
}

// 7. Model failure keeps the existing name and reports the cause: there is no
// truncated-prompt fallback any more.
{
	const pi = makePi("existing name");
	const { commands } = load(pi);
	const ctx = makeCtx({
		complete: async () => {
			throw new Error("api down");
		},
		entries: [msgEntry("user", "recent work")],
	});
	await commands["name-llm"].handler("", ctx);
	assert.equal(pi.name(), "existing name", "a failed run must keep the existing name");
	assert.equal(pi.setCallCount(), 0);
	const toast = toastWith(ctx, "Could not regenerate the session title: api down.");
	assert.ok(toast, "the failure cause must be reported");
	assert.equal(toast.level, "warning");
}

// 8. Failure reasons: an error response surfaces its (collapsed) errorMessage,
// a stop reason is surfaced when there is no errorMessage, and an overlong
// cause is truncated to 120 characters plus "...".
{
	const pi = makePi("named");
	const { commands } = load(pi);
	const errCtx = makeCtx({
		complete: async () => ({ content: [], errorMessage: "429  rate\nlimit" }),
		entries: [msgEntry("user", "recent work")],
	});
	await commands["name-llm"].handler("", errCtx);
	assert.equal(pi.name(), "named", "a failed run must keep the existing name");
	assert.ok(
		toastWith(errCtx, "empty response: 429 rate limit"),
		"the error-response cause must be whitespace-collapsed and surfaced",
	);

	const stopCtx = makeCtx({
		complete: async () => ({ content: [], stopReason: "length" }),
		entries: [msgEntry("user", "recent work")],
	});
	await commands["name-llm"].handler("", stopCtx);
	assert.ok(toastWith(stopCtx, "stop reason length"), "a stop reason is surfaced when there is no errorMessage");

	const longCtx = makeCtx({
		complete: async () => {
			throw new Error("z".repeat(200));
		},
		entries: [msgEntry("user", "recent work")],
	});
	await commands["name-llm"].handler("", longCtx);
	assert.ok(
		toastWith(longCtx, `Could not regenerate the session title: ${"z".repeat(120)}...`),
		"an overlong cause must be truncated to 120 chars plus ...",
	);
	assert.ok(!toastWith(longCtx, "z".repeat(121)), "no more than 120 raw characters are surfaced");
}

// 9. The title call requests enough tokens for thinking + answer and passes no
// reasoning option (omitting it is what disables thinking on Anthropic's
// streamSimple).
{
	const pi = makePi();
	const { commands } = load(pi);
	const optionCalls: any[] = [];
	const ctx = makeCtx({
		complete: async (_model: any, _context: any, options: any) => {
			optionCalls.push(options);
			return textResponse("t");
		},
		entries: [msgEntry("user", "recent")],
	});
	await commands["name-llm"].handler("", ctx);
	assert.equal(optionCalls.length, 1, "the command must make exactly one model call");
	assert.equal(optionCalls[0].maxTokens, 2048, "the cap must leave room for reasoning + answer");
	assert.equal(optionCalls[0].reasoning, undefined, "no reasoning option must be passed");
	assert.equal(pi.name(), "t");
}

// 10. A branch whose only user message is a skill invocation is titled from
// the derived "Invoked /x skill", never from the raw <skill ...> XML.
{
	const pi = makePi();
	const { commands } = load(pi);
	const skillPrompt = '<skill name="update-changelog" location="/home/lucas/.pi/agent/skills/update-changelog/SKILL.md">\nskill body\n</skill>';
	const sent: any[] = [];
	const ctx = makeCtx({
		complete: async (_model, context) => {
			sent.push(context);
			return textResponse("Update changelog");
		},
		entries: [msgEntry("user", skillPrompt)],
	});
	await commands["name-llm"].handler("", ctx);
	assert.equal(pi.name(), "Update changelog");
	const prompt = JSON.stringify(sent[0]);
	assert.ok(prompt.includes("Invoked /update-changelog skill"), "the model sees the derived invocation");
	assert.ok(!prompt.includes("<skill"), "the raw skill XML must never reach the model");
}

// 11. A second invocation while a run is in flight is refused: no parallel
// model call, one write, an explicit notice.
{
	const pi = makePi();
	const { commands } = load(pi);
	let calls = 0;
	let release!: () => void;
	const gate = new Promise<void>((r) => { release = r; });
	const ctx = makeCtx({
		complete: async () => {
			calls++;
			await gate;
			return textResponse("gated title");
		},
		entries: [msgEntry("user", "recent")],
	});
	const first = commands["name-llm"].handler("", ctx);
	await waitFor(() => calls === 1);
	await commands["name-llm"].handler("", ctx);
	assert.equal(calls, 1, "the second invocation must not start a second model call");
	assert.ok(toastWith(ctx, "A title run is already in progress."), "the refusal must be reported");
	assert.equal(pi.setCallCount(), 0, "the refusal must not write a name");
	release();
	await first;
	assert.equal(pi.name(), "gated title");
	assert.equal(pi.setCallCount(), 1);
}

// 12. A manual /name during the model call wins: the generated title is
// discarded rather than overwriting it.
{
	const pi = makePi();
	const { commands } = load(pi);
	let calls = 0;
	const ctx = makeCtx({
		complete: async () => {
			calls++;
			pi.manualRename("human title");
			return textResponse("generated title");
		},
		entries: [msgEntry("user", "recent")],
	});
	await commands["name-llm"].handler("", ctx);
	assert.equal(calls, 1, "the model still runs");
	assert.equal(pi.name(), "human title", "the rename must survive");
	assert.equal(pi.setCallCount(), 0, "the extension must not write over the rename");
	const toast = toastWith(ctx, "No title change: session was renamed during generation.");
	assert.ok(toast, "the skip must be reported");
	assert.equal(toast.level, "info");
}

// 13. A rename that only reaches the session file (session-selector ctrl+r
// rename, a second pi process on the same file) also wins, because the live
// manager never sees it.
{
	const dir = mkdtempSync(join(tmpdir(), "session-name-llm-"));
	const file = join(dir, "session.jsonl");
	writeFileSync(file, `${JSON.stringify({ type: "session", id: "h" })}\n`);
	const pi = makePi(undefined, file);
	const { commands } = load(pi);
	const ctx = makeCtx({
		complete: async () => {
			// What the session selector does: append the rename to the file,
			// never touching the live manager's in-memory name.
			appendFileSync(file, `${JSON.stringify({ type: "session_info", name: "selector rename" })}\n`);
			return textResponse("late title");
		},
		entries: [msgEntry("user", "recent")],
		sessionFile: file,
	});
	await commands["name-llm"].handler("", ctx);
	assert.equal(pi.name(), undefined, "the generated title must be discarded");
	assert.equal(pi.setCallCount(), 0, "the extension must not write over the rename");
	assert.equal(readDiskSessionName(file), "selector rename");
	assert.ok(toastWith(ctx, "session was renamed during generation."));
	rmSync(dir, { recursive: true, force: true });
}

// 13a. A disk-backed session with no rename in flight is titled normally: the
// extension's own persisted write must not look like an external rename.
{
	const dir = mkdtempSync(join(tmpdir(), "session-name-llm-"));
	const file = join(dir, "session.jsonl");
	writeFileSync(file, `${JSON.stringify({ type: "session", id: "h" })}\n`);
	const pi = makePi(undefined, file);
	const { commands } = load(pi);
	const ctx = makeCtx({
		complete: async () => textResponse("disk title"),
		entries: [msgEntry("user", "recent")],
		sessionFile: file,
	});
	await commands["name-llm"].handler("", ctx);
	assert.equal(pi.name(), "disk title");
	assert.equal(readDiskSessionName(file), "disk title", "the extension's own write lands on disk");
	rmSync(dir, { recursive: true, force: true });
}

// 14. A run that outlives its session is discarded: /new, /resume or /fork
// bumps the generation counter and the title is never written.
{
	const pi = makePi("before shutdown");
	const { commands, handlers } = load(pi);
	let release!: () => void;
	const gate = new Promise<void>((r) => { release = r; });
	const ctx = makeCtx({
		complete: async () => {
			await gate;
			return textResponse("stale title");
		},
		entries: [msgEntry("user", "recent")],
	});
	const run = commands["name-llm"].handler("", ctx);
	await waitFor(() => true);
	await handlers.session_shutdown({}, makeCtx());
	release();
	await run;
	assert.equal(pi.name(), "before shutdown", "a stale run must not write");
	assert.equal(pi.setCallCount(), 0);
	assert.ok(toastWith(ctx, "session replaced during generation."));
}

// 15. An unauthed (or absent) model is a reported failure, not a fallback name.
{
	const pi = makePi("keep me");
	const { commands } = load(pi);
	const ctx = makeCtx({ authed: false, complete: async () => textResponse("never"), entries: [msgEntry("user", "recent")] });
	await commands["name-llm"].handler("", ctx);
	assert.equal(pi.name(), "keep me");
	assert.equal(pi.setCallCount(), 0);
	assert.ok(toastWith(ctx, "Could not regenerate the session title: model has no configured auth."));
}

// 16. session_start clears the in-flight guard, so a replacement session can
// title immediately.
{
	const pi = makePi();
	const { commands, handlers } = load(pi);
	let calls = 0;
	let release!: () => void;
	const gate = new Promise<void>((r) => { release = r; });
	const first = commands["name-llm"].handler("", makeCtx({
		complete: async () => {
			calls++;
			await gate;
			return textResponse("first title");
		},
		entries: [msgEntry("user", "recent")],
	}));
	await waitFor(() => calls === 1);
	await handlers.session_start({ reason: "new" }, makeCtx());
	const secondCtx = makeCtx({
		sessionId: "s2",
		complete: async () => {
			calls++;
			return textResponse("second title");
		},
		entries: [msgEntry("user", "recent")],
	});
	await commands["name-llm"].handler("", secondCtx);
	assert.equal(calls, 2, "the replacement session must not inherit the in-flight guard");
	assert.ok(toastWith(secondCtx, "Session title: second title"));
	release();
	await first;
}

// ── Global title model pin ───────────────────────────────────────────────────

const setPin = (value: Record<string, unknown> | undefined) => {
	rmSync(pinFile, { recursive: true, force: true });
	if (value) writeFileSync(pinFile, JSON.stringify(value));
};
const pinned = { provider: "baseten", id: "zai-org/GLM-5.2", cost: { input: 1, output: 1 } };
const sessionModel = { provider: "anthropic", id: "claude-x", cost: { input: 3, output: 15 } };

// 17. A usable pin is the model the title call uses; no note is appended.
{
	setPin({ model: "baseten/zai-org/GLM-5.2" });
	const pi = makePi();
	const { commands } = load(pi);
	const used: any[] = [];
	const ctx = makeCtx({
		model: sessionModel,
		models: [pinned, sessionModel],
		complete: async (model) => { used.push(model); return textResponse("Pinned title"); },
		entries: [msgEntry("user", "recent")],
	});
	await commands["name-llm"].handler("", ctx);
	assert.equal(used.length, 1);
	assert.equal(used[0], pinned, "the pinned model is used");
	assert.ok(ctx.notifies.some((n: any) => n.msg === "Session title: Pinned title"), "no pin note when the pin is used");
}

// 18. An unusable pin falls back to the session model and the run says so,
// on applied, unchanged and failed outcomes. The same note is shown at most
// once per session: an extra run stays quiet, a fresh session_start re-arms it.
{
	setPin({ model: "x/y" });
	const pi = makePi("Same");
	const { commands, handlers } = load(pi);
	const freshSession = () => handlers.session_start({}, undefined);
	const used: any[] = [];
	const note = ' (pinned model "x/y" ignored: not found; used anthropic/claude-x)';
	const ctx = makeCtx({
		model: sessionModel,
		models: [pinned, sessionModel],
		complete: async (model) => { used.push(model); return textResponse("New title"); },
		entries: [msgEntry("user", "recent")],
	});
	await commands["name-llm"].handler("", ctx);
	assert.equal(used[0], sessionModel, "the session model is used");
	assert.ok(toastWith(ctx, `Session title: New title${note}`), JSON.stringify(ctx.notifies));

	// A second run in the same session still falls back but stays quiet: the
	// note is once per session, not once per run.
	const repeatCtx = makeCtx({ model: sessionModel, models: [sessionModel], complete: async () => textResponse("New title"), entries: [msgEntry("user", "recent")] });
	await commands["name-llm"].handler("", repeatCtx);
	assert.ok(toastWith(repeatCtx, "Title unchanged: New title"), "the title is still reported");
	assert.ok(!toastWith(repeatCtx, "ignored:"), "the pin note is not repeated within one session");

	// session_start re-arms it: the same unchanged outcome now names the pin.
	freshSession();
	const rearmedCtx = makeCtx({ model: sessionModel, models: [sessionModel], complete: async () => textResponse("New title"), entries: [msgEntry("user", "recent")] });
	await commands["name-llm"].handler("", rearmedCtx);
	assert.ok(toastWith(rearmedCtx, `Title unchanged: New title${note}`), JSON.stringify(rearmedCtx.notifies));

	freshSession();
	setPin({ model: "baseten/zai-org/GLM-5.2" });
	const noAuthCtx = makeCtx({
		model: sessionModel,
		models: [pinned, sessionModel],
		authed: (m: any) => m !== pinned,
		complete: async () => { throw new Error("api down"); },
		entries: [msgEntry("user", "recent")],
	});
	await commands["name-llm"].handler("", noAuthCtx);
	assert.ok(
		toastWith(noAuthCtx, 'Could not regenerate the session title: api down. (pinned model "baseten/zai-org/GLM-5.2" ignored: no configured auth; used anthropic/claude-x)'),
		JSON.stringify(noAuthCtx.notifies),
	);

	// No session model to fall back to: "no model selected" plus the note. A
	// new session re-arms the note even for the same "x/y" pin reported above.
	freshSession();
	setPin({ model: "x/y" });
	const noModelCtx = makeCtx({ model: undefined, models: [], entries: [msgEntry("user", "recent")] });
	await commands["name-llm"].handler("", noModelCtx);
	assert.ok(toastWith(noModelCtx, 'Could not regenerate the session title: no model selected. (pinned model "x/y" ignored: not found)'));

	// A corrupt pin file is reported in the note and the session model runs.
	freshSession();
	writeFileSync(pinFile, "{ nope");
	const corruptCtx = makeCtx({ model: sessionModel, models: [sessionModel], complete: async () => textResponse("Corrupt ok"), entries: [msgEntry("user", "recent")] });
	await commands["name-llm"].handler("", corruptCtx);
	const corruptToast = toastWith(corruptCtx, "Session title: Corrupt ok (");
	assert.ok(corruptToast && /failed to read .*ignoring the model pin\)$/.test(corruptToast.msg), JSON.stringify(corruptCtx.notifies));
}

// 19. An unpinned, unpriced session model still produces a title.
{
	setPin(undefined);
	const pi = makePi();
	const { commands } = load(pi);
	const unpriced = { provider: "openrouter", id: "z-ai/glm-5.2:free" };
	const ctx = makeCtx({ model: unpriced, models: [unpriced], complete: async () => textResponse("Free model title"), entries: [msgEntry("user", "recent")] });
	await commands["name-llm"].handler("", ctx);
	assert.equal(pi.name(), "Free model title");
}

// 20. /name-llm model clear with and without a pin; unknown sub-commands warn;
// any other argument still runs the title.
{
	const pi = makePi();
	const { commands } = load(pi);
	setPin(undefined);
	const noPinCtx = makeCtx();
	await commands["name-llm"].handler("model clear", noPinCtx);
	assert.ok(toastWith(noPinCtx, "No title model pin set."));
	assert.equal(existsSync(pinFile), false, "clear without a pin writes nothing");

	setPin({ model: "baseten/zai-org/GLM-5.2", other: 1 });
	const clearCtx = makeCtx();
	await commands["name-llm"].handler("Model  CLEAR", clearCtx);
	assert.ok(toastWith(clearCtx, "Title model pin cleared; using the session model."));
	assert.deepEqual(JSON.parse(readFileSync(pinFile, "utf8")), { other: 1 }, "only the model key is removed");

	const usageCtx = makeCtx();
	await commands["name-llm"].handler("model nope", usageCtx);
	const usage = toastWith(usageCtx, "Usage: /name-llm");
	assert.ok(usage);
	assert.equal(usage.level, "warning");

	let calls = 0;
	const otherCtx = makeCtx({ complete: async () => { calls++; return textResponse("Arg title"); }, entries: [msgEntry("user", "recent")] });
	await commands["name-llm"].handler("models please", otherCtx);
	assert.equal(calls, 1, "a non-model argument runs the title as before");
}

// 21. Picker: headless warns; the resolved model is pre-highlighted; a pick
// writes the pin (siblings preserved); cancel writes nothing; a write error
// warns instead of reporting success.
{
	const pi = makePi();
	const { commands } = load(pi);
	setPin(undefined);
	const headless = makeCtx({ hasUI: false, models: [pinned, sessionModel] });
	await commands["name-llm"].handler("model", headless);
	assert.ok(toastWith(headless, "/name-llm model needs an interactive UI"));
	assert.equal(headless.selects.length, 0);

	const cancelCtx = makeCtx({ model: sessionModel, models: [pinned, sessionModel] });
	await commands["name-llm"].handler("model", cancelCtx);
	assert.deepEqual(cancelCtx.selects[0].items, ["anthropic/claude-x", "baseten/zai-org/GLM-5.2"], "the session model is pre-highlighted when unpinned");
	assert.equal(existsSync(pinFile), false, "cancel writes nothing");
	assert.equal(cancelCtx.notifies.length, 0);

	setPin({ keep: true });
	const pickCtx = makeCtx({ model: sessionModel, models: [pinned, sessionModel], select: async () => "baseten/zai-org/GLM-5.2" });
	await commands["name-llm"].handler("model", pickCtx);
	assert.ok(toastWith(pickCtx, "Title model set to baseten/zai-org/GLM-5.2"));
	assert.deepEqual(JSON.parse(readFileSync(pinFile, "utf8")), { keep: true, model: "baseten/zai-org/GLM-5.2" });

	const againCtx = makeCtx({ model: sessionModel, models: [pinned, sessionModel] });
	await commands["name-llm"].handler("model", againCtx);
	assert.equal(againCtx.selects[0].items[0], "baseten/zai-org/GLM-5.2", "the pin is pre-highlighted");

	setPin(undefined);
	mkdirSync(pinFile); // a directory where the file goes: the write fails
	const failCtx = makeCtx({ model: sessionModel, models: [sessionModel], select: async () => "anthropic/claude-x" });
	await commands["name-llm"].handler("model", failCtx);
	assert.ok(toastWith(failCtx, "Could not save the title model"), JSON.stringify(failCtx.notifies));
	assert.ok(!toastWith(failCtx, "Title model set to"), "no success after a failed write");
	setPin(undefined);
}

// 22. Completions offer the model sub-commands.
{
	const { commands } = load(makePi());
	const complete = (commands["name-llm"] as any).getArgumentCompletions;
	assert.deepEqual(complete("").map((i: any) => i.value), ["model", "model clear"]);
	assert.deepEqual(complete("model c").map((i: any) => i.value), ["model clear"]);
	assert.equal(complete("zzz"), null);
}

// ── herdr-tab-name: rename via a fake herdr on PATH ──────────────────────────

const tmp = mkdtempSync(join(tmpdir(), "herdr-tab-test-"));
const binDir = join(tmp, "bin");
mkdirSync(binDir, { recursive: true });
const logFile = join(tmp, "calls.log");
rmSync(logFile, { force: true });
// Logs every invocation and answers `herdr tab get` with a single-pane tab
// (pane_count 1), which is required for the tab-label branch to run.
writeFileSync(
	join(binDir, "herdr"),
	`#!/bin/sh
echo "$@" >> ${JSON.stringify(logFile)}
if [ "$1 $2" = "tab get" ]; then echo '{"result":{"tab":{"pane_count":1}}}'; fi
`,
	{ mode: 0o755 },
);

const tabMod = await import("../extensions/herdr-tab-name.ts");
assert.equal(tabMod.cleanLabel("  a \n b  "), "a b");

const tabHandlers: Record<string, (event: any, ctx: any) => unknown> = {};
function makeTabPi() {
	return {
		on(event: string, handler: any) {
			tabHandlers[event] = handler;
		},
		getSessionName: () => undefined,
	};
}

const prevEnv = process.env.HERDR_ENV;
const prevTab = process.env.HERDR_TAB_ID;
const prevPane = process.env.HERDR_PANE_ID;
const prevPath = process.env.PATH;

try {
	// Gating: outside herdr, no handlers are registered.
	delete process.env.HERDR_ENV;
	delete process.env.HERDR_TAB_ID;
	delete process.env.HERDR_PANE_ID;
	assert.equal(tabMod.default(makeTabPi() as any), undefined);
	assert.ok(!tabHandlers.session_info_changed, "must be a no-op outside herdr");

	// Enabled: handlers registered; renames go through the fake herdr.
	process.env.HERDR_ENV = "1";
	process.env.HERDR_TAB_ID = "w1:t9";
	process.env.HERDR_PANE_ID = "p1";
	process.env.PATH = `${binDir}:${process.env.PATH}`;
	assert.equal(tabMod.default(makeTabPi() as any), undefined);
	assert.ok(tabHandlers.session_info_changed && tabHandlers.session_start);

	const readLog = () => {
		// The fake herdr binary creates the log on its first invocation, so an
		// early poll can race the exec: a missing file means no calls yet.
		let content: string;
		try {
			content = readFileSync(logFile, "utf8").trim();
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			return [];
		}
		return content ? content.split("\n") : [];
	};
	const waitForLog = async (pred: (lines: string[]) => boolean, desc: string) => {
		for (let i = 0; i < 100; i++) {
			const lines = readLog();
			if (pred(lines)) return lines;
			await new Promise((r) => setTimeout(r, 20));
		}
		throw new Error(`timed out waiting for: ${desc}`);
	};

	// A named session renames the pane and the single-pane tab.
	await tabHandlers.session_info_changed({ name: "  my   title " }, {});
	const lines = await waitForLog(
		(ls) => ls.includes("tab rename w1:t9 my title"),
		"tab rename to 'my title'",
	);
	assert.ok(lines.includes("pane rename p1 my title"), `unexpected log: ${lines.join(" | ")}`);

	// Cleared/empty names reset both labels: the pane is cleared and the tab
	// gets the placeholder label. One reset per event.
	await tabHandlers.session_info_changed({ name: undefined }, {});
	await tabHandlers.session_info_changed({ name: "" }, {});
	const resets = await waitForLog(
		(ls) => ls.filter((l) => l === "tab rename w1:t9 pi").length === 2,
		"two tab resets to the placeholder",
	);
	assert.equal(
		resets.filter((l) => l === "pane rename p1 --clear").length,
		2,
		"pane labels cleared twice",
	);

	// A second rename queues after the first; last label wins server-side.
	await tabHandlers.session_info_changed({ name: "renamed again" }, {});
	await waitForLog((ls) => ls.includes("tab rename w1:t9 renamed again"), "second rename");

	// ── Subagent child sessions (pi-subagents) must never rename the tab ──────

	const { isSubagentSession } = tabMod;
	assert.equal(isSubagentSession("general#123455AB", undefined), true);
	assert.equal(isSubagentSession("my title", { parentSession: "/x/session.jsonl" }), true);
	assert.equal(isSubagentSession("my title", undefined), false);
	assert.equal(isSubagentSession("my title", {}), false);
	assert.equal(isSubagentSession("my title", null), false);
	assert.equal(isSubagentSession("fix#12", undefined), false, "too short for the id pattern");
	assert.equal(isSubagentSession("", undefined), false);

	// Log has grown; counts below are absolute from this point.
	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
	const logLines = readLog;
	let seen = logLines().length;

	const subHandlers: Record<string, (event: any, ctx: any) => unknown> = {};
	tabMod.default({
		on(event: string, handler: any) {
			subHandlers[event] = handler;
		},
		getSessionName: () => "general#123455AB",
	} as any);

	// Header stamped with parentSession: skipped regardless of the name.
	const stampedCtx = { sessionManager: { getHeader: () => ({ parentSession: "/x/session.jsonl" }) } };
	// Header without parentSession: the name pattern alone must skip these.
	const emptyHeaderCtx = { sessionManager: { getHeader: () => ({}) } };

	await subHandlers.session_start({}, stampedCtx);
	await subHandlers.session_info_changed({ name: "general#123455AB" }, stampedCtx);
	// Nested (in-memory) child: no parentSession in the header, name-only signal.
	await subHandlers.session_info_changed({ name: "general#123455AB" }, emptyHeaderCtx);
	await subHandlers.session_start({}, stampedCtx);
	await sleep(150);
	assert.equal(logLines().length, seen, "subagent sessions must not rename anything");

	// A normal name through a subagent-free context still renames: the guard
	// only skips what it positively identifies as a subagent.
	await subHandlers.session_info_changed({ name: "my title" }, emptyHeaderCtx);
	const lines3 = await waitForLog((ls) => ls.length >= seen + 3, "parent rename after subagent");
	assert.equal(lines3[seen], "pane rename p1 my title");
	assert.equal(lines3[seen + 1], "tab get w1:t9");
	assert.equal(lines3[seen + 2], "tab rename w1:t9 my title");
	seen += 3;

	// Fail-open: a ctx without a usable header must not block the parent.
	await subHandlers.session_info_changed({ name: "renamed third" }, {});
	const lines4 = await waitForLog((ls) => ls.length >= seen + 3, "fail-open rename");
	assert.equal(lines4[seen + 2], "tab rename w1:t9 renamed third");
	seen += 3;

	// Fail-open on session_start too: no ctx at all, normal name from getSessionName.
	const mainHandlers: Record<string, (event: any, ctx: any) => unknown> = {};
	tabMod.default({
		on(event: string, handler: any) {
			mainHandlers[event] = handler;
		},
		getSessionName: () => "fresh session",
	} as any);
	await mainHandlers.session_start({}, undefined);
	const lines5 = await waitForLog((ls) => ls.length >= seen + 3, "session_start rename");
	assert.equal(lines5[seen + 2], "tab rename w1:t9 fresh session");
} finally {
	process.env.HERDR_ENV = prevEnv;
	process.env.HERDR_TAB_ID = prevTab;
	process.env.HERDR_PANE_ID = prevPane;
	process.env.PATH = prevPath;
	rmSync(tmp, { recursive: true, force: true });
}

console.log("session-name-llm + herdr-tab-name: all assertions passed");
