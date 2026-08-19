/**
 * plan
 *
 * When the user runs `/plan <task>`, pi narrows the active tools to a read-only
 * allowlist (read/bash/grep/find/ls, with bash gated to safe commands) and sends
 * a planning prompt as a user message. When the planning turn ends, the
 * previous tool set is restored.
 *
 * The extension no longer switches the model or thinking effort — switch to
 * your preferred planner model (and thinking level) yourself before calling
 * `/plan`, and switch back afterwards. `/plan-cancel` restores your tools early.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

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
	// find/fd are on SAFE_BASH for read-only metadata predicates (-mtime, -size, -type, ...),
	// but their exec/delete flags run arbitrary commands, so block those regardless of
	// what the inner command is.
	/\bfind\b.*\s-(fprintf|fprint0|fprint|execdir|exec|okdir|ok|delete|fls)\b/i,
	/\bfd\b.*(\s-x\b|\s-X\b|\s--exec-batch\b|\s--exec\b)/,
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

const PLAN_SYSTEM_NUDGE = `
The user has asked for a plan. Produce a clear, numbered implementation plan.
Do NOT modify files yet. Do NOT call write/edit tools. You may use read/grep/bash
(read-only) to gather context. End with: "Plan ready — reply to implement."
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
			ctx.ui.notify("Usage: /plan <what you want planned>", "warning");
			return;
		}

		// Snapshot the active tool set so it can be restored after the turn.
		savedTools = pi.getActiveTools();

		const allTools = pi.getAllTools().map((t) => t.name);
		pi.setActiveTools(PLAN_TOOLS.filter((t) => allTools.includes(t)));

		planning = true;
		updateStatus(ctx);
		ctx.ui.notify(`Planning (tools: ${PLAN_TOOLS.join(",")}). Will restore after.`, "info");

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
		description: "Plan with the current model using a read-only tool allowlist",
		handler: async (args, ctx) => {
			await startPlanning(args ?? "", ctx);
		},
	});

	pi.registerCommand("plan-cancel", {
		description: "Cancel planning mode and restore your previous tools immediately",
		handler: async (_args, ctx) => {
			if (!planning) {
				ctx.ui.notify("Not in planning mode.", "info");
				return;
			}
			await restoreTools(ctx);
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
