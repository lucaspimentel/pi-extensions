/**
 * Python Tool Extension
 *
 * Registers a single `python` tool that executes snippets in a persistent,
 * sandboxed interpreter: bubblewrap isolation (user/pid/ipc/uts/net
 * namespaces, no network, read-only project at /workspace, writable scratch
 * at /scratch), a long-lived stdlib-only worker, parent-enforced deadlines
 * and output budgets, and full teardown on timeout/cancel/crash.
 *
 * Threat model (see README.md for the complete version):
 * - Project files, including secrets inside the mounted project, are readable.
 * - Other pi tools remain unrestricted; this does not sandbox pi itself.
 * - The sandbox shares the host kernel.
 * - Resource limits are per-process/per-file and per-execution, not
 *   aggregate quotas.
 *
 * The worker starts lazily on the first execution. Importing this module and
 * registering the extension create no processes, directories, timers, or
 * watchers.
 */

import { Type } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	defineTool,
	type ExtensionAPI,
	formatSize,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { realpathSync } from "node:fs";
import { LIMITS } from "./limits.ts";
import {
	FAILURE_STATUSES,
	PythonSessionController,
	type ExecutionResult,
	type StatusReport,
} from "./session.ts";

const pythonTool = defineTool({
	name: "python",
	label: "Python (sandboxed)",
	executionMode: "sequential",
	description:
		"Execute Python snippets in a persistent, sandboxed interpreter (Linux + bubblewrap). " +
		"Variables, imports, functions, and classes persist across calls within the session. " +
		"The project directory is mounted read-only at /workspace (modifying or deleting project " +
		"files fails); /scratch is a writable scratch directory whose files persist across calls " +
		"and resets, and outputs belong there. Standard library only, no package installs, no " +
		"network, no sockets, no input() (it returns EOF at once), no top-level await. " +
		"Ordinary Python exceptions keep interpreter state (execution is not transactional); " +
		"timeout, cancellation, output overflow, or a crash kill the interpreter and lose its " +
		"state, returning partial output. Use action=reset to discard interpreter state " +
		"(scratch is kept) and action=status to inspect readiness and paths without starting " +
		"a worker. JSON results: print json.dumps(...) yourself; the final expression's repr " +
		"is shown automatically.",
	promptSnippet:
		"Run Python snippets in a persistent bubblewrap-sandboxed interpreter with the project at read-only /workspace and writable /scratch",
	promptGuidelines: [
		"Use the `python` tool for persistent Python snippets, data analysis, and stdlib scripting; state (variables, imports, functions) survives across calls.",
		"In the `python` tool, /workspace is the project (read-only) and /scratch is writable and persistent; write outputs to /scratch, never to /workspace.",
		"An ordinary Python exception keeps interpreter state; a timeout, cancellation, or crash loses it. Use action=reset to clear state deliberately.",
	],
	parameters: Type.Object({
		action: Type.Optional(
			Type.Union(
				[Type.Literal("execute"), Type.Literal("reset"), Type.Literal("status")],
				{ description: "Operation to perform. Default: execute." },
			),
		),
		code: Type.Optional(
			Type.String({
				description: `Python source to execute. Required for action=execute; at most ${Math.floor(LIMITS.maxCodeBytes / 1024)} KiB UTF-8.`,
			}),
		),
		timeoutSeconds: Type.Optional(
			Type.Number({
				description: `Wall-time limit for execute (1 to ${LIMITS.maxTimeoutSeconds} seconds). Default ${LIMITS.defaultTimeoutSeconds}.`,
			}),
		),
	}),

	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		const action = params.action ?? "execute";

		// Validate action-specific combinations before touching the controller.
		if (action === "execute") {
			if (typeof params.code !== "string" || params.code.length === 0) {
				throw new Error("The python tool requires `code` when action is execute (or omitted).");
			}
			if (Buffer.byteLength(params.code, "utf8") > LIMITS.maxCodeBytes) {
				throw new Error(`Code exceeds the ${formatSize(LIMITS.maxCodeBytes)} UTF-8 limit.`);
			}
			if (params.timeoutSeconds !== undefined) {
				const t = params.timeoutSeconds;
				if (!Number.isInteger(t) || t < 1 || t > LIMITS.maxTimeoutSeconds) {
					throw new Error(`timeoutSeconds must be an integer between 1 and ${LIMITS.maxTimeoutSeconds}.`);
				}
			}
		} else if (action === "reset" || action === "status") {
			if (params.code !== undefined || params.timeoutSeconds !== undefined) {
				throw new Error(`The python tool rejects \`code\` and \`timeoutSeconds\` when action is ${action}.`);
			}
		}

		const controller = controllerFor(cwdRoot(ctx.cwd));
		if ("error" in controller) {
			return unavailableResult(controller.error, { action });
		}

		if (action === "execute") {
			const result = await controller.execute(params.code!, params.timeoutSeconds, signal);
			return executionToolResult(result);
		}
		if (action === "reset") {
			await controller.reset();
			const st = await controller.status();
			return {
				content: [
					{
						type: "text" as const,
						text:
							"Interpreter reset: sandbox killed, interpreter state discarded. " +
							`Scratch files are preserved (${st.paths.scratchDir ?? "/scratch on the host"}). ` +
							"A fresh interpreter starts on the next execution.",
					},
				],
				details: { action: "reset", status: "ok", scratchDir: st.paths.scratchDir },
			};
		}
		// action === "status": never starts a worker.
		const st = await controller.status();
		return {
			content: [{ type: "text" as const, text: renderStatus(st) }],
			details: { action: "status", status: "ok", report: st },
		};
	},

	renderCall(args, theme, _context) {
		const action = typeof args?.action === "string" ? args.action : "execute";
		if (action === "status") {
			return new Text(theme.fg("toolTitle", theme.bold("python status")), 0, 0);
		}
		if (action === "reset") {
			return new Text(theme.fg("toolTitle", theme.bold("python reset")), 0, 0);
		}
		const code = typeof args?.code === "string" ? args.code : "";
		const firstLine = code.split("\n", 1)[0] ?? "";
		const more = code.includes("\n") ? theme.fg("muted", " …") : "";
		const timeout = args?.timeoutSeconds ? theme.fg("muted", ` (${args.timeoutSeconds}s)`) : "";
		const display = firstLine ? firstLine : theme.fg("toolOutput", "...");
		return new Text(theme.fg("toolTitle", theme.bold(`python> ${display}`)) + more + timeout, 0, 0);
	},

	renderResult(result, _options, theme, _context) {
		const details = result.details as { status?: string; durationMs?: number } | undefined;
		const status = details?.status ?? "unknown";
		const duration = typeof details?.durationMs === "number" ? ` ${(details.durationMs / 1000).toFixed(1)}s` : "";
		const failed = FAILURE_STATUSES.has(status as never);
		const glyph = failed ? theme.fg("error", "✗") : theme.fg("success", "✓");
		return new Text(`${glyph} python ${status}${duration}`, 0, 0);
	},
});

// ── Controller ownership and lifecycle ──────────────────────────────────────

let controller: PythonSessionController | undefined;

function cwdRoot(cwd: string): string | { error: string } {
	try {
		return realpathSync(cwd);
	} catch (err) {
		return { error: `Working directory is not accessible: ${err instanceof Error ? err.message : String(err)}` };
	}
}

function controllerFor(root: string | { error: string }): PythonSessionController | { error: string } {
	if (typeof root !== "string") return root;
	if (!controller) {
		controller = new PythonSessionController({ projectDir: root });
		return controller;
	}
	if (controller.projectDir !== root) {
		// The project context changed: state from the abandoned context must not
		// leak into the new one. Scratch and logs go with the old context.
		const old = controller;
		controller = new PythonSessionController({ projectDir: root });
		void old.dispose("project_dir_changed");
	}
	return controller;
}

// ── Result assembly ─────────────────────────────────────────────────────────

function unavailableResult(diagnostic: string, extras: Record<string, unknown>) {
	return {
		content: [{ type: "text" as const, text: `python tool unavailable: ${diagnostic}` }],
		details: { status: "unavailable", diagnostic, ...extras },
	};
}

function executionToolResult(result: ExecutionResult) {
	const text = renderExecution(result);
	const truncation = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	const content = truncation.truncated
		? `${truncation.content}\n\n[Result truncated to ${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}]`
		: text;
	return {
		content: [{ type: "text" as const, text: content }],
		details: {
			action: "execute" as const,
			status: result.status,
			durationMs: Math.round(result.durationMs),
			generation: result.generation,
			stateLost: result.stateLost,
			stateLostReason: result.stateLostReason,
			reprTruncated: result.reprTruncated,
			stdoutBytes: Buffer.byteLength(result.stdout, "utf8"),
			stderrBytes: Buffer.byteLength(result.stderr, "utf8"),
			excerptTruncated: result.excerptTruncated,
			outputLimitExceeded: result.outputLimitExceeded,
			logPaths: result.logPaths,
			logComplete: result.logComplete,
			exceptionType: result.exception?.type,
		},
	};
}

function renderExecution(result: ExecutionResult): string {
	const lines: string[] = [];
	const duration = `${(result.durationMs / 1000).toFixed(1)}s`;
	lines.push(`status: ${result.status} (${duration}, worker generation ${result.generation})`);

	if (result.repr !== null) {
		const marker = result.reprTruncated ? " (truncated)" : "";
		lines.push("", `result${marker}: ${result.repr}`);
	}
	if (result.stdout.trim().length > 0) {
		lines.push("", "--- stdout ---", result.stdout.replace(/\s+$/, ""));
	}
	if (result.stderr.trim().length > 0) {
		lines.push("", "--- stderr ---", result.stderr.replace(/\s+$/, ""));
	}
	if (result.exception) {
		lines.push("", `--- exception: ${result.exception.type} ---`);
		if (result.exception.message) lines.push(result.exception.message);
		if (result.exception.traceback) lines.push("", result.exception.traceback.replace(/\s+$/, ""));
	}
	if (!result.stateLost) {
		lines.push("", "Interpreter state preserved (execution is not transactional: mutations before an error remain).");
	} else if (result.status !== "unavailable") {
		lines.push("", `Interpreter state was LOST (${result.stateLostReason ?? "sandbox killed"}). A fresh interpreter starts on the next execution.`);
	}
	if (result.outputLimitExceeded) {
		lines.push(`Output budget of ${formatSize(LIMITS.outputBudgetBytes)} was exceeded.`);
	}
	if (result.logPaths) {
		lines.push(
			result.logComplete
				? `Full output saved to: ${result.logPaths.stdout} (stdout), ${result.logPaths.stderr} (stderr)`
				: `Partial output saved to: ${result.logPaths.stdout} (stdout), ${result.logPaths.stderr} (stderr); the log was cut off by the output limit.`,
		);
	}
	if (result.diagnostic) {
		lines.push("", result.diagnostic);
	}
	return lines.join("\n");
}

function renderStatus(st: StatusReport): string {
	const lines: string[] = [];
	const avail = st.available === "unverified" ? "unverified (no execution yet)" : st.available ? "available" : "unavailable";
	lines.push(`python tool: ${avail}`);
	if (st.depDiagnostic) lines.push(`diagnostic: ${st.depDiagnostic}`);
	lines.push(`worker running: ${st.workerRunning ? "yes" : "no"} (generation ${st.generation})`);
	if (st.lastResetReason) lines.push(`last reset reason: ${st.lastResetReason}`);
	lines.push(
		`paths: project ${st.paths.projectDir ?? "?"} -> /workspace (read-only); scratch ${st.paths.scratchDir ?? "(not allocated yet)"} -> /scratch (writable); logs ${st.paths.logDir ?? "(not allocated yet)"}`,
	);
	lines.push("limits: " + JSON.stringify(st.limits));
	return lines.join("\n");
}

// ── Extension entry point ───────────────────────────────────────────────────

export default function pythonExtension(pi: ExtensionAPI) {
	pi.registerTool(pythonTool);

	// Mark this tool's failed results as Pi tool errors while keeping the
	// structured details. (Returning an isError field from execute() does not
	// mark a result failed; this handler is the documented mechanism.)
	pi.on("tool_result", (event) => {
		if (event.toolName !== "python") return undefined;
		const details = event.details as { status?: string } | undefined;
		if (details && typeof details.status === "string" && FAILURE_STATUSES.has(details.status as never)) {
			return { isError: true };
		}
		return undefined;
	});

	// Lifecycle: dispose on every shutdown reason (quit, reload, new, resume,
	// fork) and on branch navigation, so interpreter state and scratch from an
	// abandoned context never leak into another. Ordinary conversation turns
	// and compaction keep state untouched.
	pi.on("session_shutdown", async () => {
		const current = controller;
		controller = undefined;
		await current?.dispose("session_shutdown");
	});
	pi.on("session_tree", async () => {
		const current = controller;
		controller = undefined;
		await current?.dispose("session_tree_change");
	});
}
