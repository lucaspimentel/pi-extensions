/**
 * Microsoft Intelligent Terminal (IT) hooks for pi.
 *
 * Reports pi's session lifecycle to Intelligent Terminal so its session list
 * and tab metadata show pi rows with live status (Idle, Working, Waiting for
 * input, Error, Ended), the same way Microsoft's `wt-agent-hooks` bundle does
 * for Claude Code, Copilot, Codex, Gemini, OpenCode, and Antigravity.
 *
 * Transport: `wtcli.exe agent-hook --cli-source pi --event <topic>` with the
 * hook JSON on stdin (see ./wtcli.ts). IT treats an unknown CLI source as a
 * first-class one, so the row shows the session's cwd basename and reports no
 * CLI name.
 *
 * Verified IT semantics this mapping depends on:
 *   - If the pane is bound to a *different* live session, every non-start
 *     event is dropped silently. Only `agent.session.start` is exempt, and it
 *     demotes that owner, so every user prompt re-sends it.
 *   - `agent.error` is keyed by the pane binding and Error persists until a
 *     new session start or tool start; `agent.stop` cannot clear it.
 *   - `agent.tool.completed`/`tool.finished` are no-ops for non-Copilot
 *     sources, so they are never emitted.
 *
 * No-op unless all of: Windows, `WT_COM_CLSID` + `WT_SESSION` set (i.e. a
 * shell pane owned by Intelligent Terminal), TUI or RPC mode, and
 * `PI_INTELLIGENT_TERMINAL` not set to `0`/`false`.
 */

import type { AgentActivityOutcome, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { initialLifecycleState, reduceLifecycle } from "../shared/agent-lifecycle.ts";
import { sendAgentHook } from "./wtcli.ts";

/** Set to `0` or `false` to disable the hooks for this process. */
export const OPT_OUT_ENV = "PI_INTELLIGENT_TERMINAL";

/** Cap on the provider error text forwarded to IT. */
export const ERROR_MESSAGE_MAX = 1024;

/** Shown in IT's session row while pi is blocked on a dialog with no title. */
export const WAIT_MESSAGE_FALLBACK = "waiting for user input";

/**
 * Gate for the whole extension. Pure and injectable so tests can drive the
 * matrix without touching process state.
 */
export function isIntelligentTerminalEnabled(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): boolean {
	if (platform !== "win32") return false;
	const flag = env[OPT_OUT_ENV];
	if (flag === "0" || flag === "false") return false;
	return Boolean(env.WT_COM_CLSID) && Boolean(env.WT_SESSION);
}

export default function (pi: ExtensionAPI) {
	if (!isIntelligentTerminalEnabled()) return;

	let lifecycle = initialLifecycleState();
	let sessionId: string | null = null;
	let cwd: string | null = null;
	let lastTurnOutcome: AgentActivityOutcome | null = null;
	let lastErrorMessage: string | null = null;

	/**
	 * Snapshot the routing fields while ctx is definitely live. Every emission
	 * uses these cached values: session_shutdown in particular must not touch
	 * ctx, which may already be stale during a session replacement.
	 */
	function capture(ctx: ExtensionContext): void {
		try {
			const id = ctx.sessionManager.getSessionId();
			if (id) sessionId = id;
		} catch {
			// Keep the previous id; a stale ctx must not lose the routing key.
		}
		try {
			if (ctx.cwd) cwd = ctx.cwd;
		} catch {
			// Keep the previous cwd.
		}
	}

	function modeOk(ctx: ExtensionContext): boolean {
		return ctx.mode === "tui" || ctx.mode === "rpc";
	}

	function emit(ctx: ExtensionContext, topic: string, extra: Record<string, unknown>): void {
		if (!modeOk(ctx)) return;
		// Without a session id the bridge would drop the event; don't spend a
		// ~200 ms spawn on it.
		if (!sessionId) return;
		sendAgentHook(topic, { session_id: sessionId, timestamp: new Date().toISOString(), ...extra }, (message) => {
			try {
				ctx.ui.notify(message, "warning");
			} catch {
				// Best effort: the ctx may be stale during teardown.
			}
		});
	}

	function cwdField(): Record<string, unknown> {
		return cwd === null ? {} : { cwd };
	}

	pi.on("session_start", async (_event, ctx) => {
		capture(ctx);
		emit(ctx, "agent.session.start", cwdField());
	});

	pi.on("agent_start", async (_event, ctx) => {
		capture(ctx);
		lifecycle = reduceLifecycle(lifecycle, { type: "agent_start" });
	});

	pi.on("before_agent_start", async (event, ctx) => {
		// Only a prompt the user (or RPC) actually submitted counts. A run
		// another extension starts still shows Working through its tools.
		if (event.messageType !== "user") return;
		capture(ctx);
		// Re-bind: idempotent for our own session, and it is the only way to
		// reclaim a pane bound to a stale live session, since IT drops every
		// other event in that case.
		emit(ctx, "agent.session.start", cwdField());
		emit(ctx, "agent.prompt.submit", cwdField());
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		// Nested calls (codemode and friends) would flicker the row with tools
		// the transcript never shows as top-level actions.
		if (event.parentToolCallId) return;
		lifecycle = reduceLifecycle(lifecycle, { type: "tool_start", toolName: event.toolName });
		// ask_user_question lands here too, so the row shows the current tool;
		// IT synthesizes its own waiting-for-input notification for it, and
		// tool arguments (including the question text) are never forwarded.
		emit(ctx, "agent.tool.starting", { tool_name: event.toolName });
	});

	pi.on("ui_prompt_start", async (event, ctx) => {
		const before = lifecycle.state;
		lifecycle = reduceLifecycle(lifecycle, { type: "dialog_open" });
		// Only the outer prompt of a nested group reports Attention.
		if (before !== "waiting" && lifecycle.state === "waiting") {
			emit(ctx, "agent.notification", { message: event.title ?? WAIT_MESSAGE_FALLBACK });
		}
	});

	pi.on("ui_prompt_end", async (_event, ctx) => {
		const before = lifecycle.state;
		lifecycle = reduceLifecycle(lifecycle, { type: "dialog_close" });
		if (before !== "waiting" || lifecycle.state === "waiting") return;
		if (lifecycle.state === "working") {
			emit(ctx, "agent.prompt.submit", cwdField());
		} else if (lifecycle.state === "idle") {
			// A dialog opened and closed while idle did not run the agent.
			emit(ctx, "agent.stop", {});
		}
	});

	pi.on("turn_end", async (event, _ctx) => {
		lastTurnOutcome = event.outcome;
		lastErrorMessage = null;
		if (event.message.role === "assistant") {
			const candidate = (event.message as { errorMessage?: unknown }).errorMessage;
			if (typeof candidate === "string" && candidate) lastErrorMessage = candidate;
		}
	});

	pi.on("agent_settled", async (_event, ctx) => {
		lifecycle = reduceLifecycle(lifecycle, { type: "agent_settled" });
		const outcome = lastTurnOutcome;
		const errorMessage = lastErrorMessage;
		// Consume both: a later settlement without a new turn must not re-report.
		lastTurnOutcome = null;
		lastErrorMessage = null;
		if (outcome === "error") {
			// Only a provider/API failure. An Esc abort settles as a plain stop.
			emit(ctx, "agent.error", { error: (errorMessage ?? "turn failed").slice(0, ERROR_MESSAGE_MAX) });
		} else {
			emit(ctx, "agent.stop", {});
		}
	});

	pi.on("session_shutdown", async (event, ctx) => {
		lifecycle = reduceLifecycle(lifecycle, { type: "session_shutdown" });
		// /reload keeps the same session id, and IT's Ended is not reliably
		// revivable, so a reload must not end the row.
		if (event.reason === "reload") return;
		emit(ctx, "agent.session.end", { reason: event.reason });
	});
}
