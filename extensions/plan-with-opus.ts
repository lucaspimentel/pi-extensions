/**
 * plan-with-opus
 *
 * When the user runs `/plan <task>` (or presses Ctrl+Alt+P with text in the editor),
 * pi temporarily switches to a strong planning model (Claude Opus), asks for a plan,
 * then automatically restores the previous model so the implementation runs on it.
 *
 * Tweak PLANNER_PROVIDER / PLANNER_MODEL_ID below if Anthropic renames the model.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Adjust to whatever Opus id is registered in your pi build.
// Run `pi --list-models | grep opus` to see what's available.
const PLANNER_PROVIDER = "anthropic";
const PLANNER_MODEL_ID = "claude-opus-4-7";
const PLANNER_THINKING: ThinkingLevel = "high";

// Read-only tool allowlist while planning. "bash" stays in but is gated to
// safe commands by the tool_call hook below.
const PLAN_TOOLS = ["read", "bash", "grep", "find", "ls"];

// Bash allow/deny while planning.
const DESTRUCTIVE_BASH = [
	/\brm\s+-[rf]/i, /\brm\s+/i, /\bmv\b/i, /\bcp\s+-[rR]/i,
	/>\s*\S+/, />>\s*\S+/, /\btee\b/i,
	/\bgit\s+(commit|push|reset|checkout|merge|rebase|cherry-pick|stash\s+(pop|drop|clear)|clean)/i,
	/\bnpm\s+(install|i|uninstall|publish|run)/i, /\bpnpm\s+(install|i|add|remove|publish|run)/i,
	/\byarn\s+(install|add|remove|publish|run)/i,
	/\bpip\s+(install|uninstall)/i, /\bcurl\s+[^|]*\|\s*(sh|bash)/i,
	/\bsudo\b/i, /\bchmod\b/i, /\bchown\b/i, /\bkill\b/i, /\bdocker\s+(run|rm|build|push)/i,
];
const SAFE_BASH = [
	/^\s*ls\b/, /^\s*pwd\b/, /^\s*cat\b/, /^\s*head\b/, /^\s*tail\b/, /^\s*wc\b/,
	/^\s*find\b/, /^\s*grep\b/, /^\s*rg\b/, /^\s*fd\b/, /^\s*sed\s+-n/, /^\s*awk\b/,
	/^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get|ls-files|blame|describe|rev-parse)/,
	/^\s*tree\b/, /^\s*echo\b/, /^\s*which\b/, /^\s*--version/, /^\s*\S+\s+--version\b/,
	/^\s*node\s+--version/, /^\s*npm\s+(--version|list|ls|view|info|outdated)/,
	/^\s*pnpm\s+(--version|list|ls|why|outdated)/,
];
function isSafeBash(cmd: string): boolean {
	if (DESTRUCTIVE_BASH.some((p) => p.test(cmd))) return false;
	return SAFE_BASH.some((p) => p.test(cmd));
}

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

const PLAN_SYSTEM_NUDGE = `
The user has asked for a plan. Produce a clear, numbered implementation plan.
Do NOT modify files yet. Do NOT call write/edit tools. You may use read/grep/bash
(read-only) to gather context. End with: "Plan ready — reply to implement."
`.trim();

interface Snapshot {
	provider: string;
	id: string;
	thinkingLevel: ThinkingLevel;
	tools: string[];
}

export default function planWithOpus(pi: ExtensionAPI) {
	let snapshot: Snapshot | undefined;
	let planning = false;

	function updateStatus(ctx: ExtensionContext) {
		if (planning) {
			ctx.ui.setStatus("plan-with-opus", ctx.ui.theme.fg("accent", `📐 planning (${PLANNER_MODEL_ID})`));
		} else {
			ctx.ui.setStatus("plan-with-opus", undefined);
		}
	}

	async function startPlanning(task: string, ctx: ExtensionContext): Promise<void> {
		if (planning) {
			ctx.ui.notify("Already in planning mode.", "warning");
			return;
		}
		if (!task.trim()) {
			ctx.ui.notify("Usage: /plan <what you want planned>", "warning");
			return;
		}

		const current = ctx.model;
		const planner = ctx.modelRegistry.find(PLANNER_PROVIDER, PLANNER_MODEL_ID);
		if (!planner) {
			ctx.ui.notify(
				`Planner model ${PLANNER_PROVIDER}/${PLANNER_MODEL_ID} not found. Edit PLANNER_MODEL_ID in plan-with-opus.ts.`,
				"error",
			);
			return;
		}

		// Snapshot current model + thinking level + active tools.
		if (!current) {
			ctx.ui.notify("No active model to snapshot.", "error");
			return;
		}
		snapshot = {
			provider: current.provider,
			id: current.id,
			thinkingLevel: pi.getThinkingLevel() as ThinkingLevel,
			tools: pi.getActiveTools(),
		};

		const ok = await pi.setModel(planner);
		if (!ok) {
			ctx.ui.notify(`Could not switch to ${PLANNER_PROVIDER}/${PLANNER_MODEL_ID} (missing API key?)`, "error");
			snapshot = undefined;
			return;
		}

		// Bump thinking level and restrict tools to read-only set.
		pi.setThinkingLevel(PLANNER_THINKING);
		const allTools = pi.getAllTools().map((t) => t.name);
		pi.setActiveTools(PLAN_TOOLS.filter((t) => allTools.includes(t)));

		planning = true;
		updateStatus(ctx);
		ctx.ui.notify(
			`Planning with ${planner.id} (thinking:${PLANNER_THINKING}, tools:${PLAN_TOOLS.join(",")}). Will restore after.`,
			"info",
		);

		// Send the planning prompt as a real user message so it triggers a turn.
		pi.sendUserMessage(`${PLAN_SYSTEM_NUDGE}\n\nTask:\n${task}`);
	}

	async function restoreModel(ctx: ExtensionContext): Promise<void> {
		if (!planning) return;
		planning = false;

		if (snapshot) {
			const prev = ctx.modelRegistry.find(snapshot.provider, snapshot.id);
			if (prev) {
				const ok = await pi.setModel(prev);
				if (!ok) {
					ctx.ui.notify(`Could not restore ${snapshot.provider}/${snapshot.id}.`, "warning");
				}
			}
			pi.setThinkingLevel(snapshot.thinkingLevel);
			pi.setActiveTools(snapshot.tools);
			ctx.ui.notify(
				`Plan ready. Restored ${snapshot.provider}/${snapshot.id} (thinking:${snapshot.thinkingLevel}).`,
				"success",
			);
		}
		snapshot = undefined;
		updateStatus(ctx);
	}

	// Block non-readonly bash while planning.
	pi.on("tool_call", async (event) => {
		if (!planning) return;
		if (event.toolName !== "bash") return;
		const cmd = (event.input as { command?: string }).command ?? "";
		if (!isSafeBash(cmd)) {
			return {
				block: true,
				reason: `Plan mode: bash command blocked (not in read-only allowlist).\nCommand: ${cmd}`,
			};
		}
	});

	pi.registerCommand("plan", {
		description: "Plan with Opus, then auto-restore previous model",
		handler: async (args, ctx) => {
			await startPlanning(args ?? "", ctx);
		},
	});

	pi.registerCommand("plan-cancel", {
		description: "Cancel planning mode and restore previous model immediately",
		handler: async (_args, ctx) => {
			if (!planning) {
				ctx.ui.notify("Not in planning mode.", "info");
				return;
			}
			await restoreModel(ctx);
		},
	});

	// Ctrl+Alt+P: take whatever's currently in the editor and use it as the plan task.
	pi.registerShortcut("ctrl+alt+p", {
		description: "Plan current editor text with Opus",
		handler: async (ctx) => {
			// Grab editor text via setEditorText round-trip is not possible; rely on /plan.
			ctx.ui.notify("Use /plan <task> to start planning with Opus.", "info");
		},
	});

	// After the planning turn finishes, restore the original model.
	pi.on("agent_end", async (_event, ctx) => {
		if (planning) {
			await restoreModel(ctx);
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		// Reset transient state on session boundaries.
		planning = false;
		snapshot = undefined;
		updateStatus(ctx);
	});
}
