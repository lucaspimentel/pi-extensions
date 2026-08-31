/**
 * plan
 *
 * When the user runs `/plan <task>`, pi narrows the active tools to a read-only
 * allowlist (read/bash/grep/find/ls, with bash gated to safe commands) and sends
 * a planning prompt as a user message. When the planning turn ends, the
 * previous tool set is restored.
 *
 * Bash gating (`isSafeBash`) splits compound commands on top-level `&&`, `||`,
 * `|`, `;`, and newlines (respecting quotes/backticks/parens/heredocs) and
 * requires every resulting segment to independently match a read-only
 * SAFE_BASH prefix pattern, with none matching DESTRUCTIVE_BASH. This is what
 * makes it safe to allow `cd` (e.g. `cd sub && ls`) without also allowing
 * `cd sub && ./evil.sh`. It fails closed — blocking the whole command — on
 * unmatched quotes/parens or top-level command substitution (`$(...)`,
 * `` `...` ``), since those can smuggle an arbitrary command past both lists.
 *
 * The extension no longer switches the model or thinking effort — switch to
 * your preferred planner model (and thinking level) yourself before calling
 * `/plan`, and switch back afterwards. `/plan cancel` restores your tools early;
 * the flat `/plan-cancel` name still works as a deprecated alias.
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
	// sort is otherwise read-only, but -o writes its output to a file.
	/\bsort\b.*\s-o\b/i,
	// `env <cmd>` / `env VAR=x <cmd>` runs an arbitrary program; only bare `env`
	// (print environment) is safe. `printenv` never runs anything, so it's left
	// alone here (its safe forms are enforced positively by SAFE_BASH below).
	/\benv\s+\S/i,
];
const SAFE_BASH = [
	/^\s*ls\b/, /^\s*pwd\b/, /^\s*cat\b/, /^\s*head\b/, /^\s*tail\b/, /^\s*wc\b/,
	/^\s*find\b/, /^\s*grep\b/, /^\s*rg\b/, /^\s*fd\b/, /^\s*sed\s+-n/, /^\s*awk\b/,
	/^\s*git\s+(status|log|diff|show|branch|remote|config\s+(--get|--list)|ls-files|blame|describe|rev-parse|stash\s+list|show-ref|submodule\s+status|diff-tree|shortlog)\b/,
	// git worktree has mutating subcommands (add/remove/prune/move/lock) — only
	// the read-only `list` form is allowed, never the bare `git worktree` prefix.
	/^\s*git\s+worktree\s+list\b/,
	// git tag with no args (or -l/--list) only lists; `git tag <name>` creates one
	// and `git tag -d <name>` deletes one, so both must stay excluded.
	/^\s*git\s+tag(\s*$|\s+(-l|--list)\b)/,
	// git reflog with no args (or `show`) only displays history; expire/delete
	// subcommands are destructive and must stay excluded.
	/^\s*git\s+reflog(\s*$|\s+show\b)/,
	/^\s*tree\b/, /^\s*echo\b/, /^\s*which\b/, /^\s*--version/, /^\s*\S+\s+--version\b/,
	/^\s*node\s+--version/, /^\s*npm\s+(--version|list|ls|view|info|outdated)/,
	/^\s*pnpm\s+(--version|list|ls|why|outdated)/,
	// Never persists across tool calls (fresh subprocess per bash call); useful
	// only as a compound prefix, e.g. `cd sub && ls`, which isSafeBash() below
	// evaluates segment-by-segment.
	/^\s*cd\b/,
	/^\s*stat\b/, /^\s*file\b/, /^\s*du\b/, /^\s*df\b/, /^\s*date\b/,
	/^\s*whoami\b/, /^\s*hostname\b/, /^\s*uname\b/,
	/^\s*sort\b/, /^\s*uniq\b/, /^\s*cut\b/, /^\s*column\b/, /^\s*jq\b/,
	/^\s*type\b/, /^\s*diff\b/, /^\s*basename\b/, /^\s*dirname\b/,
	/^\s*realpath\b/, /^\s*readlink\b/,
	// env/printenv: only the argument-free / single-lookup forms are read-only.
	// `env <cmd>` runs an arbitrary program (blocked above in DESTRUCTIVE_BASH);
	// `printenv <VAR>` only ever reads, so a lone variable-name arg is fine.
	/^\s*env\s*$/, /^\s*printenv(\s+[A-Za-z_][A-Za-z0-9_]*)?\s*$/,
];

// ── Compound command splitting ─────────────────────────────────────────────
//
// isSafeBash() must evaluate each &&/||/|/;-separated segment of a bash
// command independently. Testing the whole string against ^-anchored
// SAFE_BASH patterns only tells you the *first* segment is safe — e.g.
// `cat file | sh` or `cd sub && ./evil.sh` would otherwise slip through.
// Ported (trimmed) from extensions/pi-tool-permissions/index.ts.

type SplitResult =
	| { kind: "single"; effectiveCmd?: string }
	| { kind: "compound"; parts: string[] }
	| { kind: "ambiguous" };

/**
 * When a heredoc operator `<<` (or `<<-`) is found at position `pos` in `cmd`,
 * scans forward past the entire heredoc body and returns the index after the
 * closing delimiter line. Returns null if the heredoc cannot be parsed.
 */
function consumeHeredoc(cmd: string, pos: number): number | null {
	const stripTabs = cmd[pos + 2] === "-";
	let j = pos + (stripTabs ? 3 : 2);

	// Skip horizontal whitespace between << and the delimiter
	while (j < cmd.length && (cmd[j] === " " || cmd[j] === "\t")) j++;

	// Parse the delimiter token — may be quoted ('EOF', "EOF") or bare (EOF)
	let delimiter = "";
	if (cmd[j] === "'" || cmd[j] === '"') {
		const q = cmd[j++];
		while (j < cmd.length && cmd[j] !== q) delimiter += cmd[j++];
		if (j < cmd.length) j++; // skip closing quote
	} else {
		while (j < cmd.length && /[A-Za-z0-9_]/.test(cmd[j])) delimiter += cmd[j++];
	}

	if (!delimiter) return null; // cannot determine delimiter → caller treats as normal

	// Advance past the rest of the opening line (up to and including its newline)
	while (j < cmd.length && cmd[j] !== "\n") j++;
	if (j < cmd.length) j++; // consume the newline

	// Scan body lines until we find a line that is exactly the delimiter
	while (j < cmd.length) {
		const lineStart = j;
		if (stripTabs) {
			while (j < cmd.length && cmd[j] === "\t") j++; // skip leading tabs
		}
		if (cmd.startsWith(delimiter, j)) {
			const after = j + delimiter.length;
			if (after >= cmd.length || cmd[after] === "\n" || cmd[after] === "\r" || cmd[after] === ";" || cmd[after] === " " || cmd[after] === "\t") {
				return after;
			}
		}
		j = lineStart; // reset in case stripTabs moved j
		while (j < cmd.length && cmd[j] !== "\n") j++;
		if (j < cmd.length) j++;
	}

	// Heredoc body ran to EOF without finding the closing delimiter — ambiguous
	return null;
}

/**
 * Splits a shell command on top-level &&, ||, |, ; operators (and unescaped
 * newlines). Respects single quotes, double quotes, backticks, parentheses,
 * and heredocs.
 *
 * Returns:
 *   { kind: "ambiguous" }        – unmatched quote/paren; caller should fail closed
 *   { kind: "single" }           – no top-level operator found
 *   { kind: "compound", parts }  – trimmed, non-empty subcommands
 */
export function splitTopLevelShell(cmd: string): SplitResult {
	const parts: string[] = [];
	let current = "";
	let inSingle = false;
	let inDouble = false;
	let inBacktick = false;
	let parenDepth = 0;
	let foundOperator = false;
	let i = 0;

	while (i < cmd.length) {
		const ch = cmd[i];

		if (ch === "\\" && !inSingle) {
			const next = cmd[i + 1];
			if (next === "\n") { i += 2; continue; }
			if (next === "\r" && cmd[i + 2] === "\n") { i += 3; continue; }
			current += ch + (next ?? "");
			i += 2;
			continue;
		}

		if (ch === "'" && !inDouble && !inBacktick) {
			inSingle = !inSingle;
			current += ch;
			i++;
			continue;
		}

		if (ch === '"' && !inSingle && !inBacktick) {
			inDouble = !inDouble;
			current += ch;
			i++;
			continue;
		}

		if (ch === "`" && !inSingle && !inDouble) {
			inBacktick = !inBacktick;
			current += ch;
			i++;
			continue;
		}

		if (!inSingle && !inDouble && !inBacktick) {
			if (ch === "(") {
				parenDepth++;
				current += ch;
				i++;
				continue;
			}
			if (ch === ")") {
				if (parenDepth <= 0) return { kind: "ambiguous" }; // unmatched )
				parenDepth--;
				current += ch;
				i++;
				continue;
			}
		}

		if (!inSingle && !inDouble && !inBacktick && parenDepth === 0) {
			if (ch === "<" && cmd[i + 1] === "<") {
				const end = consumeHeredoc(cmd, i);
				if (end !== null) {
					current += cmd.slice(i, end);
					i = end;
					continue;
				}
			}

			if (ch === "&" && cmd[i + 1] === "&") {
				parts.push(current.trim());
				current = "";
				i += 2;
				foundOperator = true;
				continue;
			}
			if (ch === "|" && cmd[i + 1] === "|") {
				parts.push(current.trim());
				current = "";
				i += 2;
				foundOperator = true;
				continue;
			}
			if (ch === "|" && cmd[i + 1] !== "|") {
				parts.push(current.trim());
				current = "";
				i++;
				foundOperator = true;
				continue;
			}
			if (ch === ";") {
				parts.push(current.trim());
				current = "";
				i++;
				foundOperator = true;
				continue;
			}
			if (ch === "\n" || (ch === "\r" && cmd[i + 1] === "\n")) {
				parts.push(current.trim());
				current = "";
				i += ch === "\r" ? 2 : 1;
				foundOperator = true;
				continue;
			}
		}

		current += ch;
		i++;
	}

	// Unmatched quote or paren → ambiguous
	if (inSingle || inDouble || inBacktick || parenDepth !== 0) {
		return { kind: "ambiguous" };
	}

	if (!foundOperator) return { kind: "single" };

	const last = current.trim();
	if (last) parts.push(last);

	const nonEmpty = parts.filter((p) => p.length > 0 && !p.trimStart().startsWith("#"));
	if (nonEmpty.length > 1) return { kind: "compound", parts: nonEmpty };
	if (nonEmpty.length === 1) return { kind: "single", effectiveCmd: nonEmpty[0] };
	return { kind: "single" };
}

/**
 * True when `cmd` contains a top-level command substitution — `$(...)` or
 * `` `...` `` — outside single quotes (bash still expands inside double
 * quotes, so those are not excluded).
 *
 * Command substitution can smuggle an arbitrary command past both
 * DESTRUCTIVE_BASH and SAFE_BASH (e.g. `echo $(./evil.sh)`), so isSafeBash()
 * rejects it outright rather than trying to recurse into it.
 */
function containsCommandSubstitution(cmd: string): boolean {
	let inSingle = false;
	let i = 0;
	while (i < cmd.length) {
		const ch = cmd[i];
		if (ch === "\\" && !inSingle) {
			i += 2;
			continue;
		}
		if (ch === "'") {
			inSingle = !inSingle;
			i++;
			continue;
		}
		if (!inSingle) {
			if (ch === "`") return true;
			if (ch === "$" && cmd[i + 1] === "(") return true;
		}
		i++;
	}
	return false;
}

/**
 * Returns a human-readable reason `cmd` is unsafe while planning, or `null`
 * when it's allowed. Splits on top-level shell operators and requires every
 * resulting segment to independently match a SAFE_BASH prefix pattern, with
 * none matching DESTRUCTIVE_BASH anywhere in the original string. Fails
 * closed (blocks) on command substitution or unmatched quotes/parens.
 */
function unsafeBashReason(cmd: string): string | null {
	if (containsCommandSubstitution(cmd)) {
		return "command substitution ($(...) or `...`) is not allowed in plan mode";
	}
	// Unanchored patterns match anywhere in the string, so checking the whole
	// command up front catches a destructive pattern regardless of which
	// segment it ends up in after splitting.
	if (DESTRUCTIVE_BASH.some((p) => p.test(cmd))) {
		return "matches a destructive-command pattern";
	}

	const split = splitTopLevelShell(cmd);
	if (split.kind === "ambiguous") {
		return "could not be safely parsed (unmatched quote or parenthesis)";
	}
	const parts = split.kind === "compound" ? split.parts : [split.effectiveCmd ?? cmd];
	if (parts.length === 0) {
		return "produced no command to evaluate";
	}

	const badPart = parts.find((part) => !SAFE_BASH.some((p) => p.test(part)));
	if (badPart !== undefined) {
		return `segment not in the read-only allowlist: ${badPart}`;
	}
	return null;
}

export function isSafeBash(cmd: string): boolean {
	return unsafeBashReason(cmd) === null;
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
			ctx.ui.notify("Usage: /plan <what you want planned>, or /plan cancel to exit planning early", "warning");
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

	// Shared cancellation for /plan cancel and the deprecated /plan-cancel alias.
	async function cancelPlanning(ctx: ExtensionContext): Promise<void> {
		if (!planning) {
			ctx.ui.notify("Not in planning mode.", "info");
			return;
		}
		await restoreTools(ctx);
	}

	// Block non-readonly bash while planning.
	pi.on("tool_call", async (event) => {
		if (!planning) return;
		if (event.toolName !== "bash") return;
		const cmd = (event.input as { command?: string }).command ?? "";
		const reason = unsafeBashReason(cmd);
		if (reason) {
			return {
				block: true,
				reason: `Plan mode: bash command blocked (${reason}).\nCommand: ${cmd}`,
			};
		}
	});

	pi.registerCommand("plan", {
		description: "Plan with the current model using a read-only tool allowlist; /plan cancel exits early",
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
