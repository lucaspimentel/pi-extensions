/**
 * plan
 *
 * When the user runs `/plan <task>`, pi disables the `write` and `edit` tools
 * (everything else stays active, including unrestricted bash and MCP tools)
 * and sends a planning prompt as a user message. The planner is asked to
 * produce a self-contained "handoff" prompt: written in imperative voice and
 * addressed to a fresh agent session with no memory of this conversation, so
 * it can be pasted verbatim elsewhere.
 *
 * When the planning turn settles, the final assistant message is captured as
 * the plan, copied to the clipboard (platform-detected; override or disable
 * with PI_PLAN_CLIPBOARD), and the user is asked what to do next:
 *
 *   1. Accept: implement in this session
 *   2. Accept: clear context (fresh replacement session), then implement
 *   3. Decline: write feedback, planner tries again
 *   4. Decline: stop
 *
 * Option 3 keeps planning mode active (write/edit stay disabled) and sends the
 * feedback back to the planner; the flow re-captures and re-asks after each
 * revised attempt until the plan is accepted or declined for good.
 *
 * The extension does not switch the model or thinking effort — switch to your
 * preferred planner model (and thinking level) yourself before calling
 * `/plan`, and switch back afterwards. `/plan cancel` restores your tools
 * early; the flat `/plan-cancel` name still works as a deprecated alias.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

const PLAN_SYSTEM_NUDGE = `
The user has asked for a plan. Produce a complete, self-contained handoff prompt
that a fresh agent session (with no memory of this conversation) could be given
directly and implement from scratch.

Requirements:
- Written in imperative voice, addressed to the implementing agent.
- Self-contained: include the task, relevant file paths discovered during
  research, constraints, a numbered step-by-step implementation plan, and
  concrete verification criteria. Never refer to "the discussion above" or to
  anything outside this message.
- Do NOT modify files yet. Do NOT call write/edit tools. You may use
  read/grep/bash to gather context, but do not change anything (no writes,
  no git mutations).
- Your entire final message will be copied verbatim and used as the handoff,
  so it must contain the handoff prompt and nothing else: no meta commentary,
  no "here is the plan" preamble.
`.trim();

const IMPLEMENT_MESSAGE = "Implement the plan.";

const CHOICE_IMPLEMENT_HERE = "Accept: implement in this session";
const CHOICE_CLEAR_AND_IMPLEMENT = "Accept: clear context, then implement";
const CHOICE_REVISE = "Decline: write feedback, try again";
const CHOICE_STOP = "Decline: stop";

// Set PI_PLAN_CLIPBOARD=off to skip the clipboard copy (useful in tests and
// environments without a clipboard binary).
const CLIPBOARD_DISABLED = process.env.PI_PLAN_CLIPBOARD === "off";

function extractLastAssistantText(ctx: ExtensionContext): string {
	const entries = ctx.sessionManager.getBranch();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as { message?: { role?: string; content?: unknown } };
		const message = entry?.message;
		if (!message || message.role !== "assistant") continue;

		const content = message.content;
		const parts: string[] =
			typeof content === "string"
				? [content]
				: Array.isArray(content)
					? content
							.filter(
								(block): block is { type: "text"; text: string } =>
									!!block &&
									typeof block === "object" &&
									(block as { type?: string }).type === "text" &&
									typeof (block as { text?: unknown }).text === "string",
							)
							.map((block) => block.text)
					: [];
		return parts.join("\n").trim();
	}
	return "";
}

function copyToClipboard(text: string): boolean {
	if (CLIPBOARD_DISABLED) return false;

	try {
		if (process.platform === "darwin") {
			return spawnSync("pbcopy", [], { input: text, timeout: 3000 }).status === 0;
		}
		if (process.platform === "win32") {
			return spawnSync("clip", [], { input: text, timeout: 3000 }).status === 0;
		}
		// Linux and friends: WSL uses clip.exe, Wayland wl-copy, X11 xclip.
		let isWsl = !!process.env.WSL_DISTRO_NAME;
		if (!isWsl) {
			try {
				isWsl = fs.readFileSync("/proc/version", "utf8").toLowerCase().includes("microsoft");
			} catch {
				isWsl = false;
			}
		}
		if (isWsl) {
			return spawnSync("clip.exe", [], { input: text, timeout: 3000 }).status === 0;
		}
		if (process.env.WAYLAND_DISPLAY) {
			return spawnSync("wl-copy", [], { input: text, timeout: 3000 }).status === 0;
		}
		const result = spawnSync("xclip", ["-selection", "clipboard"], { input: text, timeout: 3000 });
		return result.status === 0;
	} catch {
		return false;
	}
}

export default function plan(pi: ExtensionAPI) {
	let planning = false;
	let savedTools: string[] | undefined;
	// Only command contexts expose newSession at runtime, so the /plan handler
	// context is kept for the post-plan "clear context" flow. It is only used
	// while the same session is still active; session boundaries clear it.
	let planCommandCtx: ExtensionCommandContext | undefined;

	function updateStatus(ctx: ExtensionContext) {
		if (planning) {
			ctx.ui.setStatus("plan", ctx.ui.theme.fg("accent", `📐 planning`));
		} else {
			ctx.ui.setStatus("plan", undefined);
		}
	}

	function narrowTools(): void {
		// Disable write/edit; everything else (bash, MCP tools, web, ...) stays
		// active so the planner can gather context however it needs to.
		const allTools = pi
			.getAllTools()
			.map((t) => t.name)
			.filter((name) => name !== "write" && name !== "edit");
		pi.setActiveTools(allTools);
	}

	async function startPlanning(task: string, ctx: ExtensionCommandContext): Promise<void> {
		if (planning) {
			ctx.ui.notify("Already in planning mode.", "warning");
			return;
		}
		if (!task.trim()) {
			ctx.ui.notify("Usage: /plan <what you want planned>, or /plan cancel to exit planning early", "warning");
			return;
		}

		// Snapshot the active tool set so it can be restored later.
		savedTools = pi.getActiveTools();
		narrowTools();
		planCommandCtx = ctx;

		planning = true;
		updateStatus(ctx);
		ctx.ui.notify("Planning (write/edit disabled).", "info");

		// Send the planning prompt as a real user message so it triggers a turn.
		pi.sendUserMessage(`${PLAN_SYSTEM_NUDGE}\n\nTask:\n${task}`);
	}

	async function restoreTools(ctx: ExtensionContext): Promise<void> {
		if (!planning) return;
		planning = false;

		if (savedTools) {
			pi.setActiveTools(savedTools);
		}
		savedTools = undefined;
		planCommandCtx = undefined;
		updateStatus(ctx);
	}

	// Shared cancellation for /plan cancel and the deprecated /plan-cancel alias.
	async function cancelPlanning(ctx: ExtensionContext): Promise<void> {
		if (!planning) {
			ctx.ui.notify("Not in planning mode.", "info");
			return;
		}
		await restoreTools(ctx);
		ctx.ui.notify("Planning cancelled. Restored your previous tool set.", "info");
	}

	async function handlePlanReady(ctx: ExtensionContext): Promise<void> {
		const plan = extractLastAssistantText(ctx);
		if (!plan) {
			ctx.ui.notify("Planning turn produced no plan; restoring tools.", "warning");
			await restoreTools(ctx);
			return;
		}

		ctx.ui.notify(
			copyToClipboard(plan) ? "Plan copied to clipboard." : "Clipboard unavailable; plan is in the transcript.",
			"info",
		);

		const choice = await ctx.ui.select("Plan ready. What next?", [
			CHOICE_IMPLEMENT_HERE,
			CHOICE_CLEAR_AND_IMPLEMENT,
			CHOICE_REVISE,
			CHOICE_STOP,
		]);

		if (choice === CHOICE_IMPLEMENT_HERE) {
			await restoreTools(ctx);
			pi.sendUserMessage(IMPLEMENT_MESSAGE);
			return;
		}

		if (choice === CHOICE_CLEAR_AND_IMPLEMENT) {
			// Detach this instance's state before replacing the session; the
			// replacement session starts with default tools and fires
			// session_start, which resets everything anyway.
			planning = false;
			savedTools = undefined;
			updateStatus(ctx);

			const commandCtx = planCommandCtx;
			planCommandCtx = undefined;
			if (!commandCtx) {
				ctx.ui.notify("No command context available for a new session; restoring tools.", "warning");
				await restoreTools(ctx);
				return;
			}

			const parentSession = ctx.sessionManager.getSessionFile() ?? undefined;
			const result = await commandCtx.newSession({
				parentSession,
				withSession: async (newCtx) => {
					// The plan is self-contained, so it alone becomes the fresh
					// session's first user message and triggers implementation.
					await newCtx.sendUserMessage(plan);
				},
			});
			if (result.cancelled) {
				ctx.ui.notify("New session was cancelled; restoring tools.", "warning");
				planning = true;
				await restoreTools(ctx);
			}
			return;
		}

		if (choice === CHOICE_REVISE) {
			const feedback = await ctx.ui.editor("Plan declined. What should change?", "");
			const text = (feedback ?? "").trim();
			if (!text) {
				ctx.ui.notify("No feedback provided; planning cancelled. Restored your previous tool set.", "info");
				await restoreTools(ctx);
				return;
			}
			// Stay in planning mode: tools remain narrowed and the next settled
			// turn re-captures the revised plan and re-asks.
			pi.sendUserMessage(
				`The user declined the plan above with this feedback:\n\n<feedback>\n${text}\n</feedback>\n\n` +
					`Produce a revised handoff plan following all the original requirements.`,
			);
			return;
		}

		// CHOICE_STOP, or the dialog was dismissed.
		await restoreTools(ctx);
		ctx.ui.notify("Planning stopped. Restored your previous tool set.", "info");
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

	// After the planning turn settles (retries/continuations included), capture
	// the plan and ask the user what to do next.
	pi.on("agent_settled", async (_event, ctx) => {
		if (planning) {
			await handlePlanReady(ctx);
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		// Reset transient state on session boundaries.
		planning = false;
		savedTools = undefined;
		planCommandCtx = undefined;
		updateStatus(ctx);
	});
}
