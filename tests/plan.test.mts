// Test harness that runs the ACTUAL plan extension code.
//
// Exercises the /plan command surface: tool narrowing (write/edit disabled,
// everything else kept), snapshot/restore on cancel and agent_end, /plan
// cancel, and the deprecated /plan-cancel alias.
//
// Run: node tests/plan.test.mts
import assert from "node:assert/strict";
import planExtension from "../extensions/plan.ts";

async function main() {
	// ── Slash-command surface: /plan <task> + /plan cancel ─────────────────────
	{
		const commands: Record<string, any> = {};
		const sent: string[] = [];
		const events: Record<string, any> = {};
		let activeTools: string[] = [];
		const notifications: { msg: string; level: string }[] = [];
		const originalTools = ["read", "write", "edit", "bash"];
		const allToolNames = ["read", "write", "edit", "bash", "grep", "find", "ls", "web_fetch", "mcp__slack"];
		const pi: any = {
			registerCommand(name: string, opts: any) { commands[name] = opts; },
			registerShortcut() {},
			on(event: string, handler: any) { events[event] = handler; },
			getActiveTools: () => originalTools.slice(),
			getAllTools: () => allToolNames.map((name) => ({ name })),
			setActiveTools(tools: string[]) { activeTools = tools.slice(); },
			sendUserMessage(msg: string) { sent.push(msg); },
		};
		const ctx: any = {
			ui: {
				notify(msg: string, level: string) { notifications.push({ msg, level }); },
				setStatus() {},
				theme: { fg: (_: string, s: string) => s },
			},
		};

		planExtension(pi);
		assert.ok(commands["plan"], "expected /plan to be registered");
		assert.ok(commands["plan-cancel"], "expected the deprecated /plan-cancel alias to be registered");

		// Argument completion offers the cancel subcommand only.
		assert.deepEqual(commands["plan"].getArgumentCompletions("c"), [{ value: "cancel", label: "cancel" }]);
		assert.deepEqual(commands["plan"].getArgumentCompletions(""), [{ value: "cancel", label: "cancel" }]);
		assert.equal(commands["plan"].getArgumentCompletions("x"), null);

		// /plan <task> disables write/edit and keeps every other tool active.
		await commands["plan"].handler("do a thing", ctx);
		assert.deepEqual(activeTools, allToolNames.filter((n) => n !== "write" && n !== "edit"));
		assert.equal(sent.length, 1);
		assert.ok(sent[0].includes("Produce a clear, numbered implementation plan."));
		assert.ok(sent[0].includes("do a thing"));

		// /plan cancel restores the previous tool set without sending a new prompt.
		await commands["plan"].handler("cancel", ctx);
		assert.deepEqual(activeTools, originalTools);
		assert.equal(sent.length, 1, "cancel must not send a new planning prompt");

		// Cancelling while not planning is a no-op notification.
		notifications.length = 0;
		await commands["plan"].handler("cancel", ctx);
		assert.equal(notifications.length, 1);
		assert.equal(notifications[0].msg, "Not in planning mode.");
		assert.deepEqual(activeTools, originalTools);

		// The deprecated flat alias still routes to the same cancellation.
		await commands["plan"].handler("another task", ctx);
		assert.equal(sent.length, 2);
		await commands["plan-cancel"].handler("", ctx);
		assert.deepEqual(activeTools, originalTools);

		// A task that merely starts with the word cancel is still a task.
		await commands["plan"].handler("cancel the migration plan in two phases", ctx);
		assert.equal(sent.length, 3);
		assert.ok(sent[2].includes("cancel the migration plan in two phases"));
		assert.deepEqual(activeTools, allToolNames.filter((n) => n !== "write" && n !== "edit"));

		// agent_end restores the original tools after the planning turn.
		await events["agent_end"](undefined, ctx);
		assert.deepEqual(activeTools, originalTools);
		assert.equal(sent.length, 3, "agent_end must not send a new planning prompt");

		// session_start resets transient state (no restore, no notification).
		await commands["plan"].handler("yet another task", ctx);
		notifications.length = 0;
		await events["session_start"](undefined, ctx);
		assert.equal(notifications.length, 0, "session_start must not notify");
		assert.equal(activeTools.length, allToolNames.length - 2, "session_start must not restore tools");
	}

	console.log("All plan tests passed.");
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
