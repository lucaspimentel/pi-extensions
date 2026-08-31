/**
 * plan
 *
 * When the user runs `/plan <task>`, pi disables the `write` and `edit` tools
 * (everything else stays active, including unrestricted bash and MCP tools)
 * and sends a planning prompt as a user message. When the planning turn ends,
 * the previous tool set is restored.
 *
 * The extension no longer switches the model or thinking effort — switch to
 * your preferred planner model (and thinking level) yourself before calling
 * `/plan`, and switch back afterwards. `/plan cancel` restores your tools
 * early; the flat `/plan-cancel` name still works as a deprecated alias.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const PLAN_SYSTEM_NUDGE = `
The user has asked for a plan. Produce a clear, numbered implementation plan.
Do NOT modify files yet. Do NOT call write/edit tools. You may use read/grep/bash
to gather context, but do not change anything (no writes, no git mutations).
End with: "Plan ready — reply to implement."
`.trim();

export default function plan(pi: ExtensionAPI) {
	let planning = false;
	let savedTools: string[] | undefined;

	function updateStatus(ctx: ExtensionContext) {
		if (planning) {
			ctx.ui.setStatus("plan", ctx.ui.theme.fg("accent", `📐 planning`));
		} else {
			ctx.ui.setStatus("plan", undefined);
		}
	}

	async function startPlanning(task: string, ctx: ExtensionContext): Promise<void> {
		if (planning) {
			ctx.ui.notify("Already in planning mode.", "warning");
			return;
		}
		if (!task.trim()) {
			ctx.ui.notify("Usage: /plan <what you want planned>, or /plan cancel to exit planning early", "warning");
			return;
		}

		// Snapshot the active tool set so it can be restored after the turn.
		savedTools = pi.getActiveTools();

		// Disable write/edit; everything else (bash, MCP tools, web, ...) stays
		// active so the planner can gather context however it needs to.
		const allTools = pi
			.getAllTools()
			.map((t) => t.name)
			.filter((name) => name !== "write" && name !== "edit");
		pi.setActiveTools(allTools);

		planning = true;
		updateStatus(ctx);
		ctx.ui.notify("Planning (write/edit disabled). Will restore after.", "info");

		// Send the planning prompt as a real user message so it triggers a turn.
		pi.sendUserMessage(`${PLAN_SYSTEM_NUDGE}\n\nTask:\n${task}`);
	}

	async function restoreTools(ctx: ExtensionContext): Promise<void> {
		if (!planning) return;
		planning = false;

		if (savedTools) {
			pi.setActiveTools(savedTools);
			ctx.ui.notify("Plan ready. Restored your previous tool set.", "info");
		}
		savedTools = undefined;
		updateStatus(ctx);
	}

	// Shared cancellation for /plan cancel and the deprecated /plan-cancel alias.
	async function cancelPlanning(ctx: ExtensionContext): Promise<void> {
		if (!planning) {
			ctx.ui.notify("Not in planning mode.", "info");
			return;
		}
		await restoreTools(ctx);
	}

	pi.registerCommand("plan", {
		description: "Plan with the current model (write/edit disabled); /plan cancel exits early",
		getArgumentCompletions: (prefix: string) => {
			const items = [{ value: "cancel", label: "cancel" }];
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			if ((args ?? "").trim() === "cancel") {
				await cancelPlanning(ctx);
				return;
			}
			await startPlanning(args ?? "", ctx);
		},
	});

	// Deprecated alias for the old flat name, kept during the migration window.
	pi.registerCommand("plan-cancel", {
		description: "(Deprecated: use /plan cancel) Cancel planning mode and restore your tools immediately",
		handler: async (_args, ctx) => {
			await cancelPlanning(ctx);
		},
	});

	// Ctrl+Alt+P: take whatever's currently in the editor and use it as the plan task.
	pi.registerShortcut("ctrl+alt+p", {
		description: "Plan current editor text",
		handler: async (ctx) => {
			// Grab editor text via setEditorText round-trip is not possible; rely on /plan.
			ctx.ui.notify("Use /plan <task> to start planning.", "info");
		},
	});

	// After the planning turn finishes, restore the original tools.
	pi.on("agent_end", async (_event, ctx) => {
		if (planning) {
			await restoreTools(ctx);
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		// Reset transient state on session boundaries.
		planning = false;
		savedTools = undefined;
		updateStatus(ctx);
	});
}
