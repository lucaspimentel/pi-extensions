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
	type ExtensionContext,
	formatSize,
	keyHint,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { realpathSync } from "node:fs";
import { LIMITS } from "./limits.ts";
import { filterMountableReadRoots } from "./sandbox.ts";
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
		"The project directory is mounted at /workspace (read-only, unless the session is in " +
		"allow-edits or yolo permission mode, when it is writable); /scratch is a writable " +
		"scratch directory whose files persist across calls and resets, and outputs belong " +
		"there. Read roots granted via tool-permissions (readAllowPaths and friends) are " +
		"mounted read-only at their host paths, so files outside the project are readable " +
		"once granted to other tools; python status lists them. Reads of paths outside the " +
		"mounted roots prompt the user for permission via tool-permissions; a granted path " +
		"is mounted and the code re-run automatically. Standard library only, no package installs, no " +
		"network, no sockets, no input() (it returns EOF at once), no top-level await. " +
		"Ordinary Python exceptions keep interpreter state (execution is not transactional); " +
		"timeout, cancellation, output overflow, or a crash kill the interpreter and lose its " +
		"state, returning partial output. Use action=reset to discard interpreter state " +
		"(scratch is kept) and action=status to inspect readiness and paths without starting " +
		"a worker. JSON results: print json.dumps(...) yourself; the final expression's repr " +
		"is shown automatically.",
	promptSnippet:
		"Run Python snippets in a persistent bubblewrap-sandboxed interpreter with the project at /workspace (read-only, writable in allow-edits/yolo mode) and writable /scratch",
	promptGuidelines: [
		"Use the `python` tool for persistent Python snippets, data analysis, and stdlib scripting; state (variables, imports, functions) survives across calls.",
		"In the `python` tool, /workspace is the project (read-only, writable in allow-edits/yolo permission mode) and /scratch is writable and persistent; write outputs to /scratch, never to /workspace. Files under tool-permissions read roots are readable at their host paths; run `python status` to list them.",
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
			// Runtime shims may pass code as an empty string; treat that as absent.
			const hasCode = params.code !== undefined && params.code !== "";
			if (hasCode || params.timeoutSeconds !== undefined) {
				throw new Error(`The python tool rejects \`code\` and \`timeoutSeconds\` when action is ${action}.`);
			}
		}

		const controller = controllerFor(cwdRoot(ctx.cwd));
		if ("error" in controller) {
			return unavailableResult(controller.error, { action });
		}

		if (action === "execute") {
			// Replay loop for out-of-sandbox read prompts: each "permission_needed"
			// result offers the user a prompt (routed through pi-tool-permissions);
			// on allow, tool-permissions has already re-broadcast { mode, readRoots
			// }, our event handler disposed the controller, and the next iteration
			// rebuilds it with the new mount and replays the code. Unbounded but
			// user-gated: every cycle needs an explicit grant. Re-fetch the
			// controller each iteration: the event handler swaps it out.
			for (;;) {
				const current = controllerFor(cwdRoot(ctx.cwd));
				if ("error" in current) {
					return unavailableResult(current.error, { action });
				}
				const result = await current.execute(params.code!, params.timeoutSeconds, signal);
				if (result.status !== "permission_needed") return executionToolResult(result);
				const verdict = await promptForRead(result.permissionPath!, signal);
				if (verdict === "deny") {
					return executionToolResult({
						...result,
						diagnostic:
							`Read of ${result.permissionPath} was denied by the user; the path stays unavailable for this session. ` +
							"Choose an alternative source or ask the user to grant reads from that directory.",
					});
				}
				// allow: loop re-fetches the controller (fresh sandbox with the new
				// read root) and replays the code from a clean interpreter.
			}
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

	renderResult(result, { expanded }, theme, _context) {
		const details = result.details as
			| { status?: string; durationMs?: number }
			| undefined;
		const status = details?.status ?? "unknown";
		const duration =
			typeof details?.durationMs === "number" ? ` ${(details.durationMs / 1000).toFixed(1)}s` : "";
		const failed = FAILURE_STATUSES.has(status as never);
		const label = status === "python_error" ? "error" : status;
		const glyph = failed ? theme.fg("error", "✗") : theme.fg("success", "✓");
		const header = `${glyph} python ${label}${theme.fg("muted", duration)}`;

		// Body is the model-facing text minus its first line (the status line,
		// replaced by the glyph header above). Mirrors pi's fallback result
		// rendering: first lines collapsed, everything on expand.
		const content = result.content.find((c) => c.type === "text");
		const bodyLines = content && content.type === "text" ? content.text.split("\n").slice(1) : [];

		if (expanded) {
			return new Text([header, ...bodyLines.map((line) => theme.fg("toolOutput", line))].join("\n"), 0, 0);
		}
		const previewLines = 10;
		const display = bodyLines.slice(0, previewLines);
		const remaining = bodyLines.length - display.length;
		let text = [header, ...display.map((line) => theme.fg("toolOutput", line))].join("\n");
		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines, `)}${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
		}
		return new Text(text, 0, 0);
	},
});

// ── Controller ownership and lifecycle ──────────────────────────────────────

let controller: PythonSessionController | undefined;

/**
 * Whether the sandbox mounts /workspace read-write. Mirrors pi-tool-permissions'
 * `pythonWritableWorkspace` (rules.ts): allow-edits and yolo modes grant it.
 * Updated by the "tool-permissions:mode" event; defaults to read-only so the
 * tool behaves correctly when pi-tool-permissions is not loaded. Deliberately
 * duplicated (not imported) to keep the extensions decoupled.
 */
let writableWorkspace = false;

/**
 * Host read-root directories mounted read-only into the sandbox (granted via
 * pi-tool-permissions: readAllowPaths + session grants + readAllowScratch).
 * Pre-filtered with filterMountableReadRoots; defaults to none.
 */
let readRoots: string[] = [];

// ── Out-of-sandbox read prompts (step 3) ────────────────────────────────────
// Correlated bus round trip with pi-tool-permissions: we emit
// "tool-permissions:prompt" { id, path } and await the matching
// "tool-permissions:promptResult" { id, outcome }. tool-permissions renders
// the dialog and, on allow, persists the covering-dir grant and re-broadcasts
// { mode, readRoots } BEFORE the verdict, so our step-2.5 handler has already
// updated module state and disposed the controller by the time we proceed to
// the replay. Timeout, absent listener, or non-interactive UI = deny.

let promptSeq = 0;
const pendingPrompts = new Map<number, (verdict: "allow" | "deny") => void>();
/** Covering dirs the user denied this session; later attempts auto-deny. */
const deniedRoots = new Set<string>();
const PROMPT_TIMEOUT_MS = 30_000;

/** Covering directory of an absolute path (its parent); falls back to itself. */
function coveringRootOf(path: string): string {
	const trimmed = path.replace(/\/+$/, "");
	const idx = trimmed.lastIndexOf("/");
	if (idx <= 0) return path;
	return trimmed.slice(0, idx) || "/";
}

async function promptForRead(path: string, signal?: AbortSignal): Promise<"allow" | "deny"> {
	if (!lastCtx?.hasUI) return "deny";
	if (signal?.aborted) return "deny";
	const root = coveringRootOf(path);
	if (deniedRoots.has(root)) return "deny";
	const id = ++promptSeq;
	const verdict = await new Promise<"allow" | "deny">((resolve) => {
		let settled = false;
		const settle = (v: "allow" | "deny") => {
			if (settled) return;
			settled = true;
			pendingPrompts.delete(id);
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve(v);
		};
		const timer = setTimeout(() => settle("deny"), PROMPT_TIMEOUT_MS);
		const onAbort = () => settle("deny");
		signal?.addEventListener("abort", onAbort, { once: true });
		pendingPrompts.set(id, settle);
		bus?.emit("tool-permissions:prompt", { id, path });
	});
	if (verdict === "deny") deniedRoots.add(root);
	return verdict;
}

/** Shared event bus, captured at extension init for the correlated prompt round trip. */
let bus: { emit(channel: string, data: unknown): void } | undefined;

/** Captured ExtensionContext, for notifications from bus events that carry none. */
let lastCtx: ExtensionContext | undefined;

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
		controller = new PythonSessionController({ projectDir: root, writableWorkspace, readRoots });
		return controller;
	}
	if (controller.projectDir !== root) {
		// The project context changed: state from the abandoned context must not
		// leak into the new one. Scratch and logs go with the old context.
		const old = controller;
		controller = new PythonSessionController({ projectDir: root, writableWorkspace, readRoots });
		void old.dispose("project_dir_changed");
	}
	return controller;
}

/** Strict element-wise equality for the read-root lists compared on every event. */
function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((v, i) => v === b[i]);
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
			permissionPath: result.permissionPath,
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
			diagnostic: result.diagnostic,
			exceptionType: result.exception?.type,
		},
	};
}

function renderExecution(result: ExecutionResult): string {
	const lines: string[] = [];
	const duration = `${(result.durationMs / 1000).toFixed(1)}s`;
	lines.push(`status: ${result.status} (${duration}, worker generation ${result.generation})`);

	if (result.status === "permission_needed" && result.permissionPath) {
		lines.push(
			"",
			`The code tried to read ${result.permissionPath}, which is outside the sandbox mounts.`,
			result.diagnostic
				? result.diagnostic
				: "A permission prompt was offered; if granted, the read root is mounted and the code re-runs automatically.",
		);
	}

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
		`paths: project ${st.paths.projectDir ?? "?"} -> /workspace (${st.workspaceMode}); scratch ${st.paths.scratchDir ?? "(not allocated yet)"} -> /scratch (writable); logs ${st.paths.logDir ?? "(not allocated yet)"}`,
	);
	lines.push(
		st.readRoots.length > 0
			? `read roots mounted read-only: ${st.readRoots.join(", ")}`
			: "read roots mounted: none",
	);
	lines.push("limits: " + JSON.stringify(st.limits));
	return lines.join("\n");
}

// ── Extension entry point ───────────────────────────────────────────────────

export default function pythonExtension(pi: ExtensionAPI) {
	pi.registerTool(pythonTool);
	bus = pi.events;

	// Correlated verdicts for out-of-sandbox read prompts. See the block comment
	// above promptForRead for the full contract.
	pi.events.on("tool-permissions:promptResult", (data) => {
		const payload = (data ?? {}) as { id?: unknown; outcome?: unknown };
		if (typeof payload.id !== "number" || !Number.isInteger(payload.id)) return;
		if (payload.outcome !== "allow" && payload.outcome !== "deny") return;
		const settle = pendingPrompts.get(payload.id);
		if (!settle) return; // unknown or already-settled id: ignore
		settle(payload.outcome);
	});

	// Track the session permission mode and read roots announced by
	// pi-tool-permissions on the shared event bus (channel
	// "tool-permissions:mode", payload { mode, readRoots }). In allow-edits/yolo
	// modes the sandbox remounts /workspace read-write; the read roots are
	// mounted read-only 1:1 in every mode. Any change kills the running sandbox
	// (state loss, reported by the normal teardown path) and the next execution
	// starts one with the new mounts. One event carries the full state, so each
	// event is a single relaunch decision. Subscription happens at init time,
	// before session_start dispatch, so the initial emission is always received.
	// If pi-tool-permissions is not loaded, no event ever arrives and the sandbox
	// stays read-only with no extra mounts.
	pi.events.on("tool-permissions:mode", (data) => {
		const payload = (data ?? {}) as { mode?: unknown; readRoots?: unknown };
		const raw = payload.mode;
		// Ignore unknown modes: only edits/yolo flip the mount; manual/auto (and
		// anything unrecognized) keep it read-only.
		if (raw !== "edits" && raw !== "yolo" && raw !== "manual" && raw !== "auto") return;
		const desiredWritable = raw === "edits" || raw === "yolo";
		// readRoots absent or malformed (e.g. an older pi-tool-permissions) means
		// "no root mounts", never "keep whatever was mounted".
		const candidateRoots = Array.isArray(payload.readRoots) ? (payload.readRoots as unknown[]) : [];
		const projectDir = typeof lastCtx?.cwd === "string" ? cwdRoot(lastCtx.cwd) : undefined;
		const { mountable, skipped } = filterMountableReadRoots(
			candidateRoots,
			typeof projectDir === "string" ? projectDir : undefined,
		);
		if (desiredWritable === writableWorkspace && arraysEqual(mountable, readRoots)) return;

		const changed: string[] = [];
		if (desiredWritable !== writableWorkspace) {
			changed.push(`/workspace remounted ${desiredWritable ? "read-write" : "read-only"}`);
		}
		if (!arraysEqual(mountable, readRoots)) {
			changed.push(
				mountable.length > 0
					? `read roots mounted read-only: ${mountable.join(", ")}`
					: "read roots cleared",
			);
		}
		writableWorkspace = desiredWritable;
		readRoots = mountable;
		const old = controller;
		controller = undefined;
		void old?.dispose("read_roots_or_mode_changed");
		const skipNote =
			skipped.length > 0
				? `; skipped: ${skipped.map((s) => `${s.root} (${s.reason})`).join(", ")}`
				: "";
		lastCtx?.ui?.notify(`python sandbox: ${changed.join("; ")} (interpreter state discarded)${skipNote}`, "info");
	});

	pi.on("session_start", (_event, ctx) => {
		// Captured for notify() from the mode event above, which carries no context.
		lastCtx = ctx;
	});

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
		writableWorkspace = false;
		readRoots = [];
		deniedRoots.clear();
		for (const settle of pendingPrompts.values()) settle("deny");
		lastCtx = undefined;
		await current?.dispose("session_shutdown");
	});
	pi.on("session_tree", async () => {
		const current = controller;
		controller = undefined;
		writableWorkspace = false;
		readRoots = [];
		deniedRoots.clear();
		for (const settle of pendingPrompts.values()) settle("deny");
		lastCtx = undefined;
		await current?.dispose("session_tree_change");
	});
}
