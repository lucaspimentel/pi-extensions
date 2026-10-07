/**
 * update-jira: validated Jira read/update tools plus a local run-boundary
 * ticket pointer.
 *
 * Surfaces:
 *   - Tool `jira_read` (readOnlyHint): get (digest or raw payload) and
 *     comments (one newest-first page).
 *   - Tool `jira_update`: transition, comment, link_pr, edit. Mutations are
 *     serialized per normalized site/ticket; every write reports its response
 *     only, never an automatic re-fetch.
 *   - `before_agent_start`: emits a one-line custom message pointing at the
 *     ticket key resolved from the current git branch (no MCP call, no extra
 *     turn), with visible clearing corrections after the pointer state
 *     changes or the configuration breaks.
 *
 * Transport: the Atlassian remote MCP v2 server through ctx.executeTool()
 * inside tool execute handlers only. Configuration: <agentDir>/update-jira.json
 * ({"siteUrl": "https://<site>.atlassian.net", "branchKeyRegex"?, "branchMappings"?}),
 * read fresh at every tool-call and run boundary; the file is never created or
 * written by this extension, and a missing or invalid file fails closed.
 *
 * Permission enforcement belongs to external guard machinery; the tools only
 * declare annotations (jira_read is read-only/idempotent, jira_update is a
 * remote write). The factory creates no processes, directories, watchers, or
 * timers: subprocesses and spill directories appear only when a tool call or
 * hook needs them.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfigSnapshot, type ToolDeps } from "./common.ts";
import { configWarningId } from "./config.ts";
import { createReadTool, type ReadParams, type ToolExecuteContext } from "./read-tool.ts";
import { createUpdateTool, type UpdateParams } from "./update-tool.ts";
import { detectGitBranch, resolveBranchTarget, type SubprocessRunner } from "./branch.ts";
import { createTransport } from "./mcp.ts";
import { WriteQueue } from "./write-queue.ts";
import { createSpillManager, type SpillManager } from "./results.ts";
import {
	decidePointerMessage,
	reconstructLastPointer,
	type EmittedState,
	type PointerMessage,
	type PointerObservation,
} from "./context.ts";

/** Cancellable, argument-array subprocess execution without a shell. */
const defaultRun: SubprocessRunner = (command, args, cwd, signal) =>
	new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(command, args, { cwd, signal, shell: false, windowsHide: true });
		} catch (err) {
			resolve({ code: null, stdout, stderr, error: err instanceof Error ? err.message : String(err) });
			return;
		}
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", (err: Error) => {
			resolve({ code: null, stdout, stderr, error: err.message });
		});
		child.on("close", (code) => {
			resolve({ code, stdout, stderr });
		});
	});

export default function updateJiraExtension(pi: ExtensionAPI): void {
	const configPath = join(getAgentDir(), "update-jira.json");
	const deps: ToolDeps = {
		configPath,
		readConfigFile: (path) => readFileSync(path, "utf8"),
		run: defaultRun,
		queue: new WriteQueue(),
		// Built fresh around the live tool context on every call; never retained.
		transportFactory: (ctx) => {
			const toolCtx = ctx as ToolExecuteContext;
			return createTransport((toolName, args, signal) => toolCtx.executeTool(toolName, args, { signal }) as never);
		},
		spillFactory: (sessionKey) => spillFor(sessionKey),
	};

	const spillManagers = new Map<string, SpillManager>();
	function spillFor(sessionKey: string): SpillManager {
		let manager = spillManagers.get(sessionKey);
		if (!manager) {
			manager = createSpillManager({}, sessionKey);
			spillManagers.set(sessionKey, manager);
		}
		return manager;
	}

	pi.registerTool(createReadTool(deps) as never);
	pi.registerTool(createUpdateTool(deps) as never);

	const hooks = createPointerHooks(deps, () => {
		for (const manager of spillManagers.values()) {
			manager.cleanup();
		}
		spillManagers.clear();
	});
	pi.on("before_agent_start", async (event, ctx) => hooks.beforeAgentStart(event, ctx));
	pi.on("session_start", async (event, ctx) => hooks.onSessionStart(event, ctx));
	pi.on("session_tree", async (event, ctx) => hooks.onSessionTree(event, ctx));
	pi.on("session_shutdown", async () => hooks.onShutdown());
}

export interface PointerHookContext {
	cwd: string;
	sessionManager: { getBranch(): unknown[] };
}

export interface PointerHooks {
	beforeAgentStart(event: unknown, ctx: PointerHookContext): Promise<{ message: PointerMessage } | undefined>;
	onSessionStart(event: unknown, ctx: PointerHookContext): Promise<void>;
	onSessionTree(event: unknown, ctx: PointerHookContext): Promise<void>;
	onShutdown(): void;
}

/**
 * Run-boundary pointer handlers, injectable for offline lifecycle tests. The
 * handlers make no MCP calls: they read configuration, run local git
 * detection, and emit messages through the before_agent_start result.
 * onShutdown releases spill resources registered by tool calls.
 */
export function createPointerHooks(deps: ToolDeps, onShutdown?: () => void): PointerHooks {
	// lastEmitted is rebuilt from the active transcript branch on
	// session_start / session_tree so restored pointers can be cleared instead
	// of suppressing forever.
	let lastEmitted: EmittedState | undefined;
	return {
		async beforeAgentStart(_event, ctx) {
			const config = loadConfigSnapshot(deps);
			if (!config.ok) {
				const observation: PointerObservation = {
					site: "",
					cwd: ctx.cwd,
					branch: null,
					outcome: { status: "config_invalid", message: config.reason, fingerprint: configWarningId(config) ?? config.reason },
				};
				const message = decidePointerMessage(observation, lastEmitted);
				if (message) lastEmitted = { observation, emitted: "correction" };
				return message ? { message } : undefined;
			}
			const detected = await detectGitBranch(deps.run, ctx.cwd);
			const branch = detected.ok ? detected.branch : null;
			const resolution = detected.ok
				? resolveBranchTarget(config.config, detected.branch)
				: ({ ok: false, kind: "subprocess_failed" as const, message: detected.message } as const);
			const outcome = resolution.ok
				? { status: "resolved" as const, key: resolution.key }
				: { status: "unresolved" as const, reason: resolution.kind, message: resolution.message };
			const observation: PointerObservation = { site: config.config.site, cwd: ctx.cwd, branch, outcome };
			const message = decidePointerMessage(observation, lastEmitted);
			if (message) lastEmitted = { observation, emitted: message.details.emitted };
			return message ? { message } : undefined;
		},
		async onSessionStart(_event, ctx) {
			lastEmitted = reconstructLastPointer(ctx.sessionManager.getBranch());
		},
		async onSessionTree(_event, ctx) {
			lastEmitted = reconstructLastPointer(ctx.sessionManager.getBranch());
		},
		onShutdown() {
			onShutdown?.();
		},
	};
}

// Type-only re-exports keep the parameter shapes importable by tests.
export type { ReadParams, UpdateParams, PointerMessage };
