/**
 * Node Tool Extension
 *
 * Registers a single `node` tool that executes snippets in a persistent,
 * sandboxed Node.js vm context: bubblewrap isolation (user/pid/ipc/uts/net
 * namespaces, no network, read-only project at /workspace, writable scratch
 * at /scratch), a long-lived worker launched through prlimit (the node worker
 * cannot set its own rlimits), parent-enforced deadlines and output budgets,
 * and full teardown on timeout/cancel/crash.
 *
 * Deltas vs the python tool (see README.md for the complete version):
 * - No seccomp policy: node has no stdlib FFI to load libseccomp. External
 *   network is still blocked by the network namespace, and no host Unix
 *   socket is ever mounted; a socket inside the mounted project or read
 *   roots is, however, connectable.
 * - No out-of-sandbox read prompts: reads outside the mounts fail closed
 *   with the kernel's own error. (Node's experimental --permission flag is
 *   the candidate for a later prompt flow.)
 * - No top-level await; `require` resolves against /workspace so user code
 *   can load builtins and project modules.
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
	NodeSessionController,
	type ExecutionResult,
	type StatusReport,
} from "./session.ts";

const nodeTool = defineTool({
	name: "node",
	label: "Node.js (sandboxed)",
	executionMode: "sequential",
	description:
		"Execute JavaScript snippets in a persistent, sandboxed Node.js vm context (Linux + bubblewrap). " +
		"Variables, functions, and classes (including let/const declarations) persist across calls " +
		"within the session. The project directory is mounted at /workspace (read-only, unless the " +
		"session is in allow-edits, auto, or yolo permission mode, when it is writable); /scratch is a " +
		"writable scratch directory whose files persist across calls and resets, and outputs belong " +
		"there. Read roots granted via tool-permissions (readAllowPaths and friends) are mounted " +
		"read-only at their host paths, so files outside the project are readable once granted to " +
		"other tools; node status lists them. `require` is available and resolves against /workspace " +
		"(builtins like fs work; reads outside the mounted roots fail). Standard library only, no " +
		"package installs, no network, no top-level await (use .then() or an async IIFE), no " +
		"process.exit (it throws), no dynamic import. Ordinary exceptions keep context state " +
		"(execution is not transactional); timeout, cancellation, output overflow, or a crash kill " +
		"the worker and lose its state, returning partial output. Use action=reset to discard " +
		"context state (scratch is kept) and action=status to inspect readiness and paths without " +
		"starting a worker. For JSON output, print JSON.stringify(...) yourself; the final " +
		"expression's value is inspected automatically.",
	promptSnippet:
		"Run JavaScript snippets in a persistent bubblewrap-sandboxed Node.js context with the project at /workspace (read-only, writable in allow-edits/auto/yolo mode) and writable /scratch",
	promptGuidelines: [
		"Use the `node` tool for persistent JavaScript snippets and quick stdlib scripting; state (variables, functions, classes) survives across calls.",
		"In the `node` tool, /workspace is the project (read-only, writable in allow-edits/auto/yolo permission mode) and /scratch is writable and persistent; write outputs to /scratch, never to /workspace. Files under tool-permissions read roots are readable at their host paths; run `node status` to list them.",
		"An ordinary exception keeps context state; a timeout, cancellation, or crash loses it. Use action=reset to clear state deliberately. There is no top-level await: wrap async work in .then() chains or an async IIFE.",
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
				description: `JavaScript source to execute. Required for action=execute; at most ${Math.floor(LIMITS.maxCodeBytes / 1024)} KiB UTF-8.`,
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
				throw new Error("The node tool requires `code` when action is execute (or omitted).");
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
				throw new Error(`The node tool rejects \`code\` and \`timeoutSeconds\` when action is ${action}.`);
			}
		}

		const controller = controllerFor(cwdRoot(ctx.cwd));
		if ("error" in controller) {
			return unavailableResult(controller.error, { action });
		}

		if (action === "execute") {
			// Unlike the python tool there is no replay loop here: the node worker
			// never returns permission_needed (out-of-sandbox read prompts are cut
			// in v1; reads outside the mounts fail closed inside the sandbox).
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
							"Context reset: sandbox killed, context state discarded. " +
							`Scratch files are preserved (${st.paths.scratchDir ?? "/scratch on the host"}). ` +
							"A fresh worker starts on the next execution.",
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
			return new Text(theme.fg("toolTitle", theme.bold("node status")), 0, 0);
		}
		if (action === "reset") {
			return new Text(theme.fg("toolTitle", theme.bold("node reset")), 0, 0);
		}
		const code = typeof args?.code === "string" ? args.code : "";
		const firstLine = code.split("\n", 1)[0] ?? "";
		const more = code.includes("\n") ? theme.fg("muted", " …") : "";
		const timeout = args?.timeoutSeconds ? theme.fg("muted", ` (${args.timeoutSeconds}s)`) : "";
		const display = firstLine ? firstLine : theme.fg("toolOutput", "...");
		return new Text(theme.fg("toolTitle", theme.bold(`node> ${display}`)) + more + timeout, 0, 0);
	},

	renderResult(result, { expanded }, theme, _context) {
		const details = result.details as
			| { status?: string; durationMs?: number }
			| undefined;
		const status = details?.status ?? "unknown";
		const duration =
			typeof details?.durationMs === "number" ? ` ${(details.durationMs / 1000).toFixed(1)}s` : "";
		const failed = FAILURE_STATUSES.has(status as never);
		const label = status === "runtime_error" ? "error" : status;
		const glyph = failed ? theme.fg("error", "✗") : theme.fg("success", "✓");
		const header = `${glyph} node ${label}${theme.fg("muted", duration)}`;

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

let controller: NodeSessionController | undefined;

/**
 * Whether the sandbox mounts /workspace read-write. Mirrors pi-tool-permissions'
 * `sandboxWritableWorkspace` (rules.ts), shared with the python tool:
 * allow-edits, auto, and yolo modes grant it (in auto mode every execution is
 * classifier-screened). pi-tool-permissions knows the node tool
 * (it is in `SANDBOXED_TOOLS`). Updated by the
 * "tool-permissions:mode" event; defaults to read-only so the tool behaves
 * correctly when pi-tool-permissions is not loaded. Deliberately duplicated
 * (not imported) to keep the extensions decoupled.
 */
let writableWorkspace = false;

/**
 * Host read-root directories mounted read-only into the sandbox (granted via
 * pi-tool-permissions: readAllowPaths + session grants + readAllowScratch).
 * Pre-filtered with filterMountableReadRoots; defaults to none.
 */
let readRoots: string[] = [];

/** Captured ExtensionContext, for notifications from bus events that carry none. */
let lastCtx: ExtensionContext | undefined;

function cwdRoot(cwd: string): string | { error: string } {
	try {
		return realpathSync(cwd);
	} catch (err) {
		return { error: `Working directory is not accessible: ${err instanceof Error ? err.message : String(err)}` };
	}
}

function controllerFor(root: string | { error: string }): NodeSessionController | { error: string } {
	if (typeof root !== "string") return root;
	if (!controller) {
		controller = new NodeSessionController({ projectDir: root, writableWorkspace, readRoots });
		return controller;
	}
	if (controller.projectDir !== root) {
		// The project context changed: state from the abandoned context must not
		// leak into the new one. Scratch and logs go with the old context.
		const old = controller;
		controller = new NodeSessionController({ projectDir: root, writableWorkspace, readRoots });
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
		content: [{ type: "text" as const, text: `node tool unavailable: ${diagnostic}` }],
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
		lines.push("", "Context state preserved (execution is not transactional: mutations before an error remain).");
	} else if (result.status !== "unavailable") {
		lines.push("", `Context state was LOST (${result.stateLostReason ?? "sandbox killed"}). A fresh worker starts on the next execution.`);
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
	lines.push(`node tool: ${avail}`);
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

export default function nodeExtension(pi: ExtensionAPI) {
	pi.registerTool(nodeTool);

	// Track the session permission mode and read roots announced by
	// pi-tool-permissions on the shared event bus (channel
	// "tool-permissions:mode", payload { mode, readRoots }). In allow-edits,
	// auto, and yolo modes the sandbox remounts /workspace read-write; the read roots are
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
		// Ignore unknown modes: only manual (and anything unrecognized) keeps
		// the mount read-only; edits/auto/yolo flip it writable. In auto mode
		// pi-tool-permissions screens every execution with the classifier
		// ("writable + classified").
		if (raw !== "edits" && raw !== "yolo" && raw !== "manual" && raw !== "auto") return;
		const desiredWritable = raw === "edits" || raw === "yolo" || raw === "auto";
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
		lastCtx?.ui?.notify(`node sandbox: ${changed.join("; ")} (context state discarded)${skipNote}`, "info");
	});

	pi.on("session_start", (_event, ctx) => {
		// Captured for notify() from the mode event above, which carries no context.
		lastCtx = ctx;
	});

	// Mark this tool's failed results as Pi tool errors while keeping the
	// structured details. (Returning an isError field from execute() does not
	// mark a result failed; this handler is the documented mechanism.)
	pi.on("tool_result", (event) => {
		if (event.toolName !== "node") return undefined;
		const details = event.details as { status?: string } | undefined;
		if (details && typeof details.status === "string" && FAILURE_STATUSES.has(details.status as never)) {
			return { isError: true };
		}
		return undefined;
	});

	// Lifecycle: dispose on every shutdown reason (quit, reload, new, resume,
	// fork) and on branch navigation, so context state and scratch from an
	// abandoned context never leak into another. Ordinary conversation turns
	// and compaction keep state untouched.
	pi.on("session_shutdown", async () => {
		const current = controller;
		controller = undefined;
		writableWorkspace = false;
		readRoots = [];
		lastCtx = undefined;
		await current?.dispose("session_shutdown");
	});
	pi.on("session_tree", async () => {
		const current = controller;
		controller = undefined;
		writableWorkspace = false;
		readRoots = [];
		lastCtx = undefined;
		await current?.dispose("session_tree_change");
	});
}
