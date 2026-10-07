// Test harness that runs the ACTUAL plan extension code.
//
// Exercises the /plan command surface (tool narrowing, snapshot/restore,
// cancel, deprecated alias) and the post-plan flow: clipboard copy, the
// 4-option select, implement-here / clear-context / revise / stop paths,
// revise loop, and empty-plan handling.
//
// Run: node tests/plan.test.mts
import assert from "node:assert/strict";
import planExtension from "../extensions/plan.ts";

process.env.PI_PLAN_CLIPBOARD = "off";
// The guard handshake timeout is read per call; shorten it so the "guard
// absent" and "guard wedged" tests do not wait the real 5 s.
process.env.PI_PLAN_GUARD_ACK_TIMEOUT_MS = "50";

const PLAN_TEXT = "HANDOFF PLAN: do the thing, then verify with tests.";
const CHOICE_IMPLEMENT_HERE = "Accept: implement in this session";
const CHOICE_CLEAR_AND_IMPLEMENT = "Accept: clear context, then implement";
const CHOICE_REVISE = "Decline: write feedback, try again";
const CHOICE_STOP = "Decline: stop";

// How the fake guard event bus answers the research handshake:
//   granted     - acks research requests and releases (the real guard)
//   refused     - acks requests with granted:false
//   absent      - no guard listeners at all (requests time out)
//   wedged      - listeners exist but never ack
//   releaseFail - requests grant, but releases fail (transition error)
type GuardMode = "granted" | "refused" | "absent" | "wedged" | "releaseFail";

// Registered-tool descriptors for getAllTools(): name plus optional MCP-style
// annotations. Existing callers pass name-only lists via allToolNames.
interface RegisteredToolDescriptor {
	name: string;
	annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
}

function makeHarness(
	selectChoice?: string,
	editorText?: string,
	allToolNames?: string[],
	initialActiveTools?: string[],
	guardMode: GuardMode = "granted",
	registeredDescriptors?: RegisteredToolDescriptor[],
) {
	const commands: Record<string, any> = {};
	const events: Record<string, any> = {};
	const sent: string[] = [];
	const notifications: { msg: string; level: string }[] = [];
	const selects: { title: string; options: string[] }[] = [];
	const editors: { title: string; prefill: string }[] = [];
	const newSessions: { parentSession?: string; kickoff?: string }[] = [];
	const entries: { customType: string; data: unknown }[] = [];
	const busListeners: Record<string, Array<(data: any) => void>> = {};
	const emitted: Array<[string, any]> = [];
	// null = pi's initial active set (never narrowed); [] = an intentionally
	// empty active set. Conflating the two would make getActiveTools() fall back
	// to the baseline after a narrowing that removes every tool.
	let activeTools: string[] | null = null;

	const originalTools = ["read", "write", "edit", "bash"];
	const baselineTools = initialActiveTools ?? originalTools;
	const allToolNamesFinal = allToolNames ?? ["read", "write", "edit", "bash", "grep", "find", "ls", "web_fetch", "mcp__slack"];

	const pi: any = {
		registerCommand(name: string, opts: any) { commands[name] = opts; },
		registerShortcut() {},
		on(event: string, handler: any) { events[event] = handler; },
		getActiveTools: () => (activeTools === null ? baselineTools.slice() : activeTools.slice()),
		getAllTools: () => registeredDescriptors ?? allToolNamesFinal.map((name) => ({ name })),
		setActiveTools(tools: string[]) { activeTools = tools.slice(); },
		appendEntry(customType: string, data?: unknown) { entries.push({ customType, data }); },
		sendUserMessage(msg: string) { sent.push(msg); },
		events: {
			on(channel: string, fn: (data: any) => void) {
				(busListeners[channel] ??= []).push(fn);
				return () => {
					const list = busListeners[channel];
					if (list) busListeners[channel] = list.filter((f) => f !== fn);
				};
			},
			emit(channel: string, data: unknown) {
				emitted.push([channel, data]);
				for (const fn of [...(busListeners[channel] ?? [])]) fn(data);
			},
		},
	};

	if (guardMode === "granted" || guardMode === "releaseFail") {
		pi.events.on("guard:research-request", () => {
			pi.events.emit("guard:research-ack", { granted: true, reason: "research granted", profile: "research" });
		});
		pi.events.on("guard:research-release", () => {
			if (guardMode === "releaseFail") {
				pi.events.emit("guard:research-release-ack", { released: false, reason: "teardown wedged" });
				return;
			}
			pi.events.emit("guard:research-release-ack", { released: true, reason: "released", profile: "default" });
		});
	} else if (guardMode === "refused") {
		pi.events.on("guard:research-request", () => {
			pi.events.emit("guard:research-ack", { granted: false, reason: "research is already held by someone else" });
		});
	} else if (guardMode === "wedged") {
		pi.events.on("guard:research-request", () => {});
		pi.events.on("guard:research-release", () => {});
	}
	// "absent" registers nothing: every handshake times out.

	const branch: any[] = [];
	const ctx: any = {
		ui: {
			notify(msg: string, level: string) { notifications.push({ msg, level }); },
			setStatus() {},
			theme: { fg: (_: string, s: string) => s },
			async select(title: string, options: string[]) {
				selects.push({ title, options });
				return selectChoice === "ALWAYS_UNDEFINED" ? undefined : selectChoice;
			},
			async editor(title: string, prefill: string) {
				editors.push({ title, prefill });
				return editorText;
			},
		},
		sessionManager: {
			getBranch: () => branch,
			getSessionFile: () => "/tmp/session.jsonl",
		},
		async newSession(options: any) {
			newSessions.push({ parentSession: options.parentSession });
			if (options.withSession) {
				await options.withSession({
					async sendUserMessage(msg: string) {
						newSessions[newSessions.length - 1].kickoff = msg;
					},
				});
			}
			return { cancelled: false };
		},
	};

	planExtension(pi);

	const narrowed = () => (activeTools?.length ?? 0) > 0 && activeTools!.every((t) => t !== "write" && t !== "edit");
	const restored = () => (activeTools?.length ?? 0) > 0 && activeTools!.includes("write") && activeTools!.includes("edit");
	const tools = () => (activeTools ?? []).slice();

	return { commands, events, sent, notifications, selects, editors, newSessions, entries, emitted, ctx, branch, narrowed, restored, tools };
}

function addAssistantTurn(h: ReturnType<typeof makeHarness>, text: string) {
	h.branch.push({ message: { role: "user", content: [{ type: "text", text: "plan please" }] } });
	h.branch.push({ message: { role: "assistant", content: [{ type: "text", text }] } });
}

async function main() {
	// ── Slash-command surface: /plan <task> + /plan cancel ─────────────────────
	{
		const h = makeHarness(CHOICE_STOP);
		assert.ok(h.commands["plan"], "expected /plan to be registered");
		assert.ok(h.commands["plan-cancel"], "expected the deprecated /plan-cancel alias to be registered");

		// Argument completion offers the cancel subcommand only.
		assert.deepEqual(h.commands["plan"].getArgumentCompletions("c"), [{ value: "cancel", label: "cancel" }]);
		assert.deepEqual(h.commands["plan"].getArgumentCompletions(""), [{ value: "cancel", label: "cancel" }]);
		assert.equal(h.commands["plan"].getArgumentCompletions("x"), null);

		// /plan <task> disables write/edit and keeps every other tool active.
		await h.commands["plan"].handler("do a thing", h.ctx);
		assert.ok(h.narrowed(), "write/edit must be disabled during planning");
		assert.equal(h.sent.length, 1);
		assert.ok(h.sent[0].includes("handoff prompt"));
		assert.ok(h.sent[0].includes("do a thing"));
		assert.ok(
			h.sent[0].includes("no surrounding code fence"),
			"handoff requirements must forbid a wrapping code fence",
		);

		// /plan cancel restores the previous tool set without sending a new prompt.
		await h.commands["plan"].handler("cancel", h.ctx);
		assert.ok(h.restored(), "cancel must restore the original tools");
		assert.equal(h.sent.length, 1, "cancel must not send a new planning prompt");

		// Cancelling while not planning is a no-op notification.
		h.notifications.length = 0;
		await h.commands["plan"].handler("cancel", h.ctx);
		assert.equal(h.notifications.length, 1);
		assert.equal(h.notifications[0].msg, "Not in planning mode.");
		assert.ok(h.restored());

		// The deprecated flat alias still routes to the same cancellation.
		await h.commands["plan"].handler("another task", h.ctx);
		assert.equal(h.sent.length, 2);
		await h.commands["plan-cancel"].handler("", h.ctx);
		assert.ok(h.restored());

		// A task that merely starts with the word cancel is still a task.
		await h.commands["plan"].handler("cancel the migration plan in two phases", h.ctx);
		assert.equal(h.sent.length, 3);
		assert.ok(h.sent[2].includes("cancel the migration plan in two phases"));
		assert.ok(h.narrowed());
	}

	// ── Narrowing derives from the ACTIVE tools, not getAllTools ───────────────
	{
		// Pre-plan state: the user deactivated bash. mcp__slack is registered
		// (getAllTools) but not active, emulating hidden/deferred/MCP tools on
		// pi 0.99.x that narrowing must not flood into the declarations.
		const h = makeHarness(CHOICE_STOP, undefined, undefined, ["read", "write", "edit", "grep"]);
		await h.commands["plan"].handler("do a thing", h.ctx);

		let tools = h.tools();
		assert.ok(h.narrowed(), "write/edit must be disabled during planning");
		assert.ok(tools.includes("grep"), "previously active tools stay active during planning");
		assert.ok(!tools.includes("bash"), "previously deactivated tools stay deactivated during planning");
		assert.ok(!tools.includes("mcp__slack"), "registered-but-inactive tools must not be activated by narrowing");

		await h.commands["plan"].handler("cancel", h.ctx);
		assert.ok(h.restored(), "cancel must restore the exact pre-plan active set");
		tools = h.tools();
		assert.ok(tools.includes("grep"), "restored set includes the pre-plan active tools");
		assert.ok(!tools.includes("bash"), "restored set does not re-activate pre-plan deactivated tools");
		assert.ok(!tools.includes("mcp__slack"), "restored set does not activate registered-but-inactive tools");
	}

	// ── Annotation-aware narrowing: descriptors and eligibility rules ──────
	{
		// A realistic registered-tool surface: annotated MCP/custom tools, write-
		// capable and unknown tools, built-in reads, the guard sandboxed
		// interpreters, meta tools, and known host-shell/local-write tools.
		const descriptors: RegisteredToolDescriptor[] = [
			{ name: "read" },
			{ name: "grep" },
			{ name: "write" },
			{ name: "edit" },
			{ name: "bash" },
			{ name: "python", annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } },
			{ name: "node", annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } },
			{ name: "host_bash" },
			{ name: "pwsh" },
			{ name: "powershell", annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
			{ name: "memory_write", annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
			{ name: "scratchpad" },
			{ name: "web_fetch", annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } },
			{ name: "web_search", annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } },
			{ name: "pup_run" },
			{ name: "mcp__notes__search", annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
			{ name: "mcp__notes__create_page", annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } },
			{ name: "mcp__fs__delete", annotations: { readOnlyHint: true, destructiveHint: true, idempotentHint: false, openWorldHint: false } },
			{ name: "custom_deploy" },
			{ name: "custom_lookup", annotations: { destructiveHint: false } },
			{ name: "jira_read", annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true } },
			{ name: "jira_update", annotations: { readOnlyHint: false, openWorldHint: true } },
			{ name: "codemode" },
			{ name: "tool_search" },
			{ name: "subagent" },
			{ name: "ask_user_question" },
		];
		const initial = ["read", "grep", "write", "edit", "bash", "python", "node", "host_bash", "pwsh", "powershell", "memory_write", "scratchpad", "web_fetch", "web_search", "pup_run", "mcp__notes__search", "mcp__notes__create_page", "mcp__fs__delete", "custom_deploy", "custom_lookup", "jira_read", "jira_update", "codemode", "tool_search", "subagent", "ask_user_question"];
		const h = makeHarness(CHOICE_STOP, undefined, undefined, initial, "granted", descriptors);
		await h.commands["plan"].handler("do a thing", h.ctx);

		// Order is preserved; only ineligible tools are dropped.
		assert.deepEqual(h.tools(), [
			"read", "grep", "bash", "python", "node", "web_fetch", "web_search",
			"mcp__notes__search", "jira_read", "codemode", "tool_search", "subagent", "ask_user_question",
		]);
		// Annotated read-only MCP and custom tools stay active.
		assert.ok(h.tools().includes("mcp__notes__search"));
		// Write-capable and unknown MCP/custom tools are removed.
		assert.ok(!h.tools().includes("mcp__notes__create_page"));
		assert.ok(!h.tools().includes("custom_deploy"));
		// destructiveHint: false alone is insufficient.
		assert.ok(!h.tools().includes("custom_lookup"));
		// readOnlyHint: true plus destructiveHint: true is rejected.
		assert.ok(!h.tools().includes("mcp__fs__delete"));
		// Missing or non-true readOnlyHint is insufficient outside the exceptions.
		assert.ok(!h.tools().includes("jira_update"));
		// Safe built-in reads stay available without annotations.
		assert.ok(h.tools().includes("read") && h.tools().includes("grep"));
		// Sandboxed interpreters stay despite write-capable hints.
		assert.ok(h.tools().includes("python") && h.tools().includes("node"));
		// The approved meta tools stay available.
		for (const meta of ["codemode", "tool_search", "subagent", "ask_user_question"]) {
			assert.ok(h.tools().includes(meta), meta);
		}
		// Known host-shell and local-write tools are removed even with misleading
		// read-only hints (powershell, memory_write).
		for (const removed of ["write", "edit", "host_bash", "pwsh", "powershell", "memory_write", "scratchpad"]) {
			assert.ok(!h.tools().includes(removed), removed);
		}
		// Unannotated pup_run is removed: invocation-dependent read combinations
		// never make the whole wrapper planning-safe.
		assert.ok(!h.tools().includes("pup_run"));
		// jira_read is retained (read-only annotations without destructiveHint);
		// jira_update is removed (readOnlyHint: false).
		assert.ok(h.tools().includes("jira_read"));
		assert.ok(!h.tools().includes("jira_update"));

		// The persisted snapshot is the ORIGINAL active set; exact restoration.
		const startEntry = h.entries.find((e: any) => e.customType === "plan-state");
		assert.deepEqual(startEntry.data, { active: true, savedTools: initial });
		await h.commands["plan"].handler("cancel", h.ctx);
		assert.deepEqual(h.tools(), initial, "cancel must restore the exact pre-plan set, in order");
	}

	{
		// An active set that narrows to EMPTY is distinct from an uninitialized
		// set: getActiveTools() must not fall back to the baseline.
		const h = makeHarness(CHOICE_STOP, undefined, undefined, ["write", "edit"]);
		await h.commands["plan"].handler("do a thing", h.ctx);
		assert.deepEqual(h.tools(), [], "a fully narrowed set must stay empty");
		assert.equal(h.sent.length, 1, "planning still starts with an empty tool set");
		await h.commands["plan"].handler("cancel", h.ctx);
		assert.deepEqual(h.tools(), ["write", "edit"], "restore puts the pre-plan set back");
	}

	{
		// Registered-but-inactive tools stay inactive even when read-only
		// annotated; narrowing must never activate them.
		const descriptors: RegisteredToolDescriptor[] = [
			{ name: "read" },
			{ name: "write" },
			{ name: "edit" },
			{ name: "bash" },
			{ name: "mcp__docs__search", annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
		];
		const h = makeHarness(CHOICE_STOP, undefined, undefined, undefined, "granted", descriptors);
		await h.commands["plan"].handler("do a thing", h.ctx);
		assert.ok(!h.tools().includes("mcp__docs__search"), "inactive registered tools are not activated");
		await h.commands["plan"].handler("cancel", h.ctx);
		assert.ok(!h.tools().includes("mcp__docs__search"), "restore does not activate them either");
	}

	// ── Plan-state persistence and mid-plan recovery ───────────────────────────
	{
		// /plan start persists { active: true, savedTools } after narrowing.
		const h = makeHarness(CHOICE_STOP);
		await h.commands["plan"].handler("do a thing", h.ctx);
		const startEntry = h.entries.find((e: any) => e.customType === "plan-state");
		assert.ok(startEntry, "plan start must persist a plan-state entry");
		assert.deepEqual(startEntry.data, { active: true, savedTools: ["read", "write", "edit", "bash"] });

		// /plan cancel appends the end marker after restoring.
		await h.commands["plan"].handler("cancel", h.ctx);
		assert.equal(h.entries.length, 2, "plan end must persist a second plan-state entry");
		assert.deepEqual(h.entries[1].data, { active: false });
	}

	{
		// Resume mid-plan: the branch holds an active plan-state entry; recovery
		// restores the persisted set and stays out of planning mode.
		const h = makeHarness(CHOICE_STOP);
		h.branch.push({
			type: "custom",
			customType: "plan-state",
			data: { active: true, savedTools: ["read", "write", "edit", "bash", "grep"] },
		});
		await h.events["session_start"]({ reason: "resume" }, h.ctx);
		assert.deepEqual(h.tools(), ["read", "write", "edit", "bash", "grep"], "persisted pre-plan set must be restored");
		assert.ok(h.restored(), "write/edit must be active again after mid-plan resume");
		assert.ok(
			h.notifications.some((n: any) => n.msg.includes("Interrupted mid-plan")),
			"recovery must notify the user",
		);
		// Planning is NOT re-entered: /plan cancel says "Not in planning mode".
		h.notifications.length = 0;
		await h.commands["plan"].handler("cancel", h.ctx);
		assert.ok(h.notifications.some((n: any) => n.msg === "Not in planning mode."));
	}

	{
		// Resume after the plan already ended (end marker last): no recovery, no
		// notification, tools untouched.
		const h = makeHarness(CHOICE_STOP);
		h.branch.push({ type: "custom", customType: "plan-state", data: { active: false } });
		await h.events["session_start"]({ reason: "resume" }, h.ctx);
		assert.deepEqual(h.tools(), [], "no setActiveTools call when the last entry says the plan ended");
		assert.equal(h.notifications.filter((n: any) => n.msg.includes("Interrupted mid-plan")).length, 0);
	}

	{
		// Malformed persisted entry (no savedTools): repair by re-activating
		// write/edit alongside whatever pi replayed.
		const h = makeHarness(CHOICE_STOP);
		h.branch.push({ type: "custom", customType: "plan-state", data: { active: true } });
		await h.events["session_start"]({ reason: "resume" }, h.ctx);
		const tools = h.tools();
		assert.ok(tools.includes("write") && tools.includes("edit"), "repair path must re-activate write/edit");
		assert.ok(h.restored());
	}

	{
		// /tree mid-plan: session_start does NOT fire for /tree, so the
		// session_tree handler must run the same recovery.
		const h = makeHarness(CHOICE_STOP);
		h.branch.push({
			type: "custom",
			customType: "plan-state",
			data: { active: true, savedTools: ["read", "write", "edit", "bash"] },
		});
		assert.ok(h.events["session_tree"], "a session_tree handler must be registered");
		await h.events["session_tree"]({ newLeafId: null, oldLeafId: null }, h.ctx);
		assert.deepEqual(h.tools(), ["read", "write", "edit", "bash"], "session_tree recovery restores the persisted set");
		assert.ok(h.restored());
	}

	// ── Accept: implement in this session ──────────────────────────────────────
	{
		const h = makeHarness(CHOICE_IMPLEMENT_HERE);
		await h.commands["plan"].handler("add a feature", h.ctx);
		addAssistantTurn(h, PLAN_TEXT);
		await h.events["agent_before_settle"]({ type: "agent_before_settle", outcome: "completed" }, h.ctx);

		assert.equal(h.selects.length, 1, "must ask the user what to do next");
		assert.deepEqual(h.selects[0].options, [CHOICE_IMPLEMENT_HERE, CHOICE_CLEAR_AND_IMPLEMENT, CHOICE_REVISE, CHOICE_STOP]);
		assert.ok(h.restored(), "tools must be restored before implementing");
		assert.deepEqual(h.sent.slice(1), ["Implement the plan."], "must send the implement trigger");
		assert.equal(h.newSessions.length, 0, "must not replace the session");
	}

	// ── Accept: clear context, then implement ──────────────────────────────────
	{
		const h = makeHarness(CHOICE_CLEAR_AND_IMPLEMENT);
		await h.commands["plan"].handler("add a feature", h.ctx);
		addAssistantTurn(h, PLAN_TEXT);
		await h.events["agent_before_settle"]({ type: "agent_before_settle", outcome: "completed" }, h.ctx);

		assert.equal(h.newSessions.length, 1, "must create a replacement session");
		assert.equal(h.newSessions[0].parentSession, "/tmp/session.jsonl");
		assert.equal(h.newSessions[0].kickoff, PLAN_TEXT, "the plan alone must be the fresh session's kickoff");
		assert.equal(h.sent.length, 1, "must not send an implement trigger through the old session");
	}

	// ── Decline: write feedback, try again (keeps planning mode, loops) ────────
	{
		const h = makeHarness(CHOICE_REVISE, "make step 2 use xUnit instead");
		await h.commands["plan"].handler("add a feature", h.ctx);
		addAssistantTurn(h, PLAN_TEXT);
		await h.events["agent_before_settle"]({ type: "agent_before_settle", outcome: "completed" }, h.ctx);

		assert.equal(h.editors.length, 1, "must open the editor for feedback");
		assert.equal(h.editors[0].prefill, "", "editor must open blank");
		assert.equal(h.sent.length, 2);
		assert.ok(h.sent[1].includes("make step 2 use xUnit instead"));
		assert.ok(h.sent[1].includes("revised handoff plan"));
		assert.ok(h.narrowed(), "planning mode must stay active after feedback");

		// The revise turn settles: re-capture the revised plan and re-ask.
		h.branch.push({ message: { role: "assistant", content: [{ type: "text", text: "REVISED PLAN" }] } });
		await h.events["agent_before_settle"]({ type: "agent_before_settle", outcome: "completed" }, h.ctx);
		assert.equal(h.selects.length, 2, "must re-ask after a revision");
		assert.ok(h.narrowed(), "still planning after the second decline");
	}

	// ── Decline with empty feedback cancels planning ───────────────────────────
	{
		const h = makeHarness(CHOICE_REVISE, "   ");
		await h.commands["plan"].handler("add a feature", h.ctx);
		addAssistantTurn(h, PLAN_TEXT);
		await h.events["agent_before_settle"]({ type: "agent_before_settle", outcome: "completed" }, h.ctx);

		assert.equal(h.sent.length, 1, "empty feedback must not be sent");
		assert.ok(h.restored(), "empty feedback must cancel planning and restore tools");
	}

	// ── Decline: stop, and dismissed dialog ────────────────────────────────────
	{
		const h = makeHarness(CHOICE_STOP);
		await h.commands["plan"].handler("add a feature", h.ctx);
		addAssistantTurn(h, PLAN_TEXT);
		await h.events["agent_before_settle"]({ type: "agent_before_settle", outcome: "completed" }, h.ctx);
		assert.ok(h.restored(), "decline-stop must restore tools");
		assert.equal(h.sent.length, 1, "decline-stop must not send a prompt");

		const h2 = makeHarness("ALWAYS_UNDEFINED");
		await h2.commands["plan"].handler("add a feature", h2.ctx);
		addAssistantTurn(h2, PLAN_TEXT);
		await h2.events["agent_before_settle"]({ type: "agent_before_settle", outcome: "completed" }, h2.ctx);
		assert.ok(h2.restored(), "a dismissed dialog must fall back to stop + restore");
		assert.equal(h2.sent.length, 1);
	}

	// ── Planning turn produced no plan ─────────────────────────────────────────
	{
		const h = makeHarness(CHOICE_IMPLEMENT_HERE);
		await h.commands["plan"].handler("add a feature", h.ctx);
		await h.events["agent_before_settle"]({ type: "agent_before_settle", outcome: "completed" }, h.ctx);

		assert.equal(h.selects.length, 0, "must not ask when there is no plan");
		assert.ok(h.restored(), "must restore tools when the turn produced no plan");
	}

	// ── agent_before_settle outside planning mode is ignored ─────────────────
	{
		const h = makeHarness(CHOICE_IMPLEMENT_HERE);
		addAssistantTurn(h, PLAN_TEXT);
		await h.events["agent_before_settle"]({ type: "agent_before_settle", outcome: "completed" }, h.ctx);
		assert.equal(h.selects.length, 0);
		assert.equal(h.sent.length, 0);
	}

	// ── Clarifying questions: nudge variant depends on tool availability ─────
	{
		// Tool present: the planner is told to call ask_user_question.
		const withTool = makeHarness(
			CHOICE_STOP,
			undefined,
			["read", "write", "edit", "bash", "ask_user_question"],
		);
		await withTool.commands["plan"].handler("design a thing", withTool.ctx);
		assert.equal(withTool.sent.length, 1);
		assert.ok(withTool.sent[0].includes("ask_user_question"), "clarify nudge must mention the tool");
		assert.ok(
			withTool.notifications.some((n) => n.msg.includes("clarifying questions enabled")),
			"must notify that clarifying questions are enabled",
		);
		assert.ok(withTool.narrowed(), "ask_user_question must stay active during planning");

		// Tool absent: the original nudge is used and no enablement notice fires.
		const withoutTool = makeHarness(CHOICE_STOP);
		await withoutTool.commands["plan"].handler("design a thing", withoutTool.ctx);
		assert.equal(withoutTool.sent.length, 1);
		assert.ok(
			!withoutTool.sent[0].includes("ask_user_question"),
			"nudge must not mention the tool when it is unavailable",
		);
		assert.ok(
			!withoutTool.notifications.some((n) => n.msg.includes("clarifying questions enabled")),
			"must not claim clarifying questions are enabled",
		);
	}

	// ── Bare /plan: infer the task from the conversation ───────────────────
	{
		const h = makeHarness(CHOICE_STOP);
		await h.commands["plan"].handler("", h.ctx);
		assert.ok(h.narrowed(), "bare /plan must enter planning mode");
		assert.equal(h.sent.length, 1, "bare /plan must start a planning turn");
		assert.ok(h.sent[0].includes("infer the task from the"), "must instruct the planner to infer the task");
		assert.ok(h.sent[0].includes("Task:\n"), "task section must be present but empty");
		assert.ok(h.sent[0].endsWith("Task:\n"), "no task text may be appended after the empty Task section");
		assert.ok(
			!h.notifications.some((n) => n.msg.startsWith("Usage:")),
			"bare /plan must not show the usage warning",
		);
	}

	// ── session_start resets transient state ───────────────────────────────────
	{
		const h = makeHarness(CHOICE_STOP);
		await h.commands["plan"].handler("yet another task", h.ctx);
		h.notifications.length = 0;
		await h.events["session_start"](undefined, h.ctx);
		assert.equal(h.notifications.length, 0, "session_start must not notify");
		assert.ok(h.narrowed(), "session_start must not restore tools");
		// Planning state is reset: the next settle must not trigger the ask.
		addAssistantTurn(h, PLAN_TEXT);
		await h.events["agent_before_settle"]({ type: "agent_before_settle", outcome: "completed" }, h.ctx);
		assert.equal(h.selects.length, 0, "session_start must clear the planning flag");
	}

	// ── guard handshake: refusal (granted:false) refuses to start ─────────
	{
		const h = makeHarness(CHOICE_STOP, undefined, undefined, undefined, "refused");
		await h.commands["plan"].handler("do a thing", h.ctx);
		assert.deepEqual(h.tools(), [], "refused planning must not narrow tools");
		assert.equal(h.sent.length, 0, "refused planning must not send the nudge");
		assert.equal(h.entries.length, 0, "refused planning must not persist state");
		assert.ok(
			h.notifications.some((n: any) => n.msg.includes("requires the guard research profile")),
			"refusal must notify the user",
		);
		assert.deepEqual(
			h.emitted.filter(([c]) => c === "guard:research-request").length, 1,
			"exactly one request must be emitted",
		);
		// /plan cancel stays a no-op afterwards.
		await h.commands["plan"].handler("cancel", h.ctx);
		assert.ok(h.notifications.some((n: any) => n.msg === "Not in planning mode."));
	}

	// ── guard handshake: guard absent (ack timeout) refuses to start ─────
	{
		const h = makeHarness(CHOICE_STOP, undefined, undefined, undefined, "absent");
		await h.commands["plan"].handler("do a thing", h.ctx);
		assert.deepEqual(h.tools(), [], "absent guard must leave tools untouched");
		assert.equal(h.sent.length, 0);
		assert.ok(
			h.notifications.some((n: any) => n.msg.includes("no acknowledgment within")),
			"the timeout refusal must say why",
		);
	}

	// ── host_bash is narrowed during planning and restored after ─────────
	{
		const h = makeHarness(CHOICE_STOP, undefined, undefined, ["read", "write", "edit", "bash", "host_bash"]);
		await h.commands["plan"].handler("do a thing", h.ctx);
		let tools = h.tools();
		assert.ok(!tools.includes("host_bash"), "the host escape must be hidden during planning");
		assert.ok(!tools.includes("write") && !tools.includes("edit"));
		assert.ok(tools.includes("bash"), "sandboxed bash stays active during planning");
		await h.commands["plan"].handler("cancel", h.ctx);
		tools = h.tools();
		assert.ok(tools.includes("host_bash"), "cancel must restore host_bash");
	}

	// ── every exit path releases the research hold ─────────────────────
	{
		const releases = (h: ReturnType<typeof makeHarness>) =>
			h.emitted.filter(([c]) => c === "guard:research-release").length;

		// Cancel.
		const cancelled = makeHarness(CHOICE_STOP);
		await cancelled.commands["plan"].handler("t", cancelled.ctx);
		assert.equal(releases(cancelled), 0, "no release while planning is active");
		await cancelled.commands["plan"].handler("cancel", cancelled.ctx);
		assert.equal(releases(cancelled), 1, "cancel must release the hold");
		assert.ok(cancelled.restored());

		// Accept: implement here releases before the implement message.
		const accepted = makeHarness(CHOICE_IMPLEMENT_HERE);
		await accepted.commands["plan"].handler("t", accepted.ctx);
		addAssistantTurn(accepted, PLAN_TEXT);
		await accepted.events["agent_before_settle"]({ type: "agent_before_settle", outcome: "completed" }, accepted.ctx);
		assert.equal(releases(accepted), 1);
		assert.deepEqual(accepted.sent.slice(1), ["Implement the plan."]);

		// Revise keeps the hold (the loop stays in research); stop releases.
		const revising = makeHarness(CHOICE_REVISE, "fix it");
		await revising.commands["plan"].handler("t", revising.ctx);
		addAssistantTurn(revising, PLAN_TEXT);
		await revising.events["agent_before_settle"]({ type: "agent_before_settle", outcome: "completed" }, revising.ctx);
		assert.equal(releases(revising), 0, "the revise loop must keep the research hold");
		addAssistantTurn(revising, "REVISED");
		await revising.commands["plan"].handler("cancel", revising.ctx);
		assert.equal(releases(revising), 1);

		// Clear context releases in the background before the session swap.
		const clearing = makeHarness(CHOICE_CLEAR_AND_IMPLEMENT);
		await clearing.commands["plan"].handler("t", clearing.ctx);
		addAssistantTurn(clearing, PLAN_TEXT);
		await clearing.events["agent_before_settle"]({ type: "agent_before_settle", outcome: "completed" }, clearing.ctx);
		assert.equal(releases(clearing), 1, "clear-context must release the hold");
	}

	// ── aborted settle: no menu, no clipboard, planning stays active ─────
	{
		const h = makeHarness(CHOICE_STOP);
		await h.commands["plan"].handler("t", h.ctx);
		addAssistantTurn(h, PLAN_TEXT);
		await h.events["agent_before_settle"]({ type: "agent_before_settle", outcome: "aborted" }, h.ctx);
		assert.equal(h.selects.length, 0, "an aborted settle must not open the menu");
		assert.ok(h.narrowed(), "an aborted settle must keep planning active");
		await h.events["agent_before_settle"]({ type: "agent_before_settle", outcome: "error" }, h.ctx);
		assert.equal(h.selects.length, 0, "an errored settle must not open the menu either");
	}

	// ── recovery and failed releases ───────────────────────────────────
	{
		// Mid-plan recovery emits a stale release in the background.
		const h = makeHarness(CHOICE_STOP);
		h.branch.push({ type: "custom", customType: "plan-state", data: { active: true, savedTools: ["read"] } });
		await h.events["session_start"]({ reason: "resume" }, h.ctx);
		assert.ok(
			h.emitted.some(([c]) => c === "guard:research-release"),
			"recovery must release any stale research hold",
		);

		// A failed release warns instead of dying silently.
		const failing = makeHarness(CHOICE_STOP, undefined, undefined, undefined, "releaseFail");
		await failing.commands["plan"].handler("t", failing.ctx);
		await failing.commands["plan"].handler("cancel", failing.ctx);
		assert.ok(failing.restored(), "tools are restored even when the release fails");
		assert.ok(
			failing.notifications.some((n: any) => n.msg.includes("research release failed")),
			"a failed release must warn the user",
		);
	}

	console.log("All plan tests passed.");
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
