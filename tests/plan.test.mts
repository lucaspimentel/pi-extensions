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

const PLAN_TEXT = "HANDOFF PLAN: do the thing, then verify with tests.";
const CHOICE_IMPLEMENT_HERE = "Accept: implement in this session";
const CHOICE_CLEAR_AND_IMPLEMENT = "Accept: clear context, then implement";
const CHOICE_REVISE = "Decline: write feedback, try again";
const CHOICE_STOP = "Decline: stop";

function makeHarness(selectChoice?: string, editorText?: string) {
	const commands: Record<string, any> = {};
	const events: Record<string, any> = {};
	const sent: string[] = [];
	const notifications: { msg: string; level: string }[] = [];
	const selects: { title: string; options: string[] }[] = [];
	const editors: { title: string; prefill: string }[] = [];
	const newSessions: { parentSession?: string; kickoff?: string }[] = [];
	let activeTools: string[] = [];

	const originalTools = ["read", "write", "edit", "bash"];
	const allToolNames = ["read", "write", "edit", "bash", "grep", "find", "ls", "web_fetch", "mcp__slack"];

	const pi: any = {
		registerCommand(name: string, opts: any) { commands[name] = opts; },
		registerShortcut() {},
		on(event: string, handler: any) { events[event] = handler; },
		getActiveTools: () => activeTools.length ? activeTools.slice() : originalTools.slice(),
		getAllTools: () => allToolNames.map((name) => ({ name })),
		setActiveTools(tools: string[]) { activeTools = tools.slice(); },
		sendUserMessage(msg: string) { sent.push(msg); },
	};

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

	const narrowed = () => activeTools.length > 0 && activeTools.every((t) => t !== "write" && t !== "edit");
	const restored = () => activeTools.length > 0 && activeTools.includes("write") && activeTools.includes("edit");

	return { commands, events, sent, notifications, selects, editors, newSessions, ctx, branch, narrowed, restored };
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

	// ── Accept: implement in this session ──────────────────────────────────────
	{
		const h = makeHarness(CHOICE_IMPLEMENT_HERE);
		await h.commands["plan"].handler("add a feature", h.ctx);
		addAssistantTurn(h, PLAN_TEXT);
		await h.events["agent_settled"](undefined, h.ctx);

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
		await h.events["agent_settled"](undefined, h.ctx);

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
		await h.events["agent_settled"](undefined, h.ctx);

		assert.equal(h.editors.length, 1, "must open the editor for feedback");
		assert.equal(h.editors[0].prefill, "", "editor must open blank");
		assert.equal(h.sent.length, 2);
		assert.ok(h.sent[1].includes("make step 2 use xUnit instead"));
		assert.ok(h.sent[1].includes("revised handoff plan"));
		assert.ok(h.narrowed(), "planning mode must stay active after feedback");

		// The revise turn settles: re-capture the revised plan and re-ask.
		h.branch.push({ message: { role: "assistant", content: [{ type: "text", text: "REVISED PLAN" }] } });
		await h.events["agent_settled"](undefined, h.ctx);
		assert.equal(h.selects.length, 2, "must re-ask after a revision");
		assert.ok(h.narrowed(), "still planning after the second decline");
	}

	// ── Decline with empty feedback cancels planning ───────────────────────────
	{
		const h = makeHarness(CHOICE_REVISE, "   ");
		await h.commands["plan"].handler("add a feature", h.ctx);
		addAssistantTurn(h, PLAN_TEXT);
		await h.events["agent_settled"](undefined, h.ctx);

		assert.equal(h.sent.length, 1, "empty feedback must not be sent");
		assert.ok(h.restored(), "empty feedback must cancel planning and restore tools");
	}

	// ── Decline: stop, and dismissed dialog ────────────────────────────────────
	{
		const h = makeHarness(CHOICE_STOP);
		await h.commands["plan"].handler("add a feature", h.ctx);
		addAssistantTurn(h, PLAN_TEXT);
		await h.events["agent_settled"](undefined, h.ctx);
		assert.ok(h.restored(), "decline-stop must restore tools");
		assert.equal(h.sent.length, 1, "decline-stop must not send a prompt");

		const h2 = makeHarness("ALWAYS_UNDEFINED");
		await h2.commands["plan"].handler("add a feature", h2.ctx);
		addAssistantTurn(h2, PLAN_TEXT);
		await h2.events["agent_settled"](undefined, h2.ctx);
		assert.ok(h2.restored(), "a dismissed dialog must fall back to stop + restore");
		assert.equal(h2.sent.length, 1);
	}

	// ── Planning turn produced no plan ─────────────────────────────────────────
	{
		const h = makeHarness(CHOICE_IMPLEMENT_HERE);
		await h.commands["plan"].handler("add a feature", h.ctx);
		await h.events["agent_settled"](undefined, h.ctx);

		assert.equal(h.selects.length, 0, "must not ask when there is no plan");
		assert.ok(h.restored(), "must restore tools when the turn produced no plan");
	}

	// ── agent_settled outside planning mode is ignored ─────────────────────────
	{
		const h = makeHarness(CHOICE_IMPLEMENT_HERE);
		addAssistantTurn(h, PLAN_TEXT);
		await h.events["agent_settled"](undefined, h.ctx);
		assert.equal(h.selects.length, 0);
		assert.equal(h.sent.length, 0);
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
		await h.events["agent_settled"](undefined, h.ctx);
		assert.equal(h.selects.length, 0, "session_start must clear the planning flag");
	}

	console.log("All plan tests passed.");
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
