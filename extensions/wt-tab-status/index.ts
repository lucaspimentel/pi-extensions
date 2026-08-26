/**
 * Windows Terminal Tab Status Extension
 *
 * Updates the Windows Terminal tab title (with a status glyph prefix) and
 * taskbar/tab spinner (via OSC 9;4) based on agent lifecycle state.
 *
 * States:
 *   idle     →  "✅ π - <session> - <cwd>"     OSC 9;4 state=0 (hide)
 *   working  →  "π - <session> - <cwd>"        OSC 9;4 state=3 (indeterminate spinner)
 *   waiting  →  "❓ π - <session> - <cwd>"     OSC 9;4 state=0 (hide)
 *   error    →  "❌ π - <session> - <cwd>"    OSC 9;4 state=0 (hide)
 *
 * Note: Windows Terminal effectively only renders "Indeterminate" (spinner) and
 * "Hide" usefully for our purposes — "Normal" shows no indicator and "Error" /
 * "Warning" weren't visually distinct in testing — so we only spin while working.
 * That spinner is enough to signal "working", so the working tab title carries
 * no extra glyph; idle/waiting/error are still distinguished by glyph.
 *
 * Detection:
 *   working   – between agent_start and agent_end
 *   waiting   – any time a blocking ctx.ui.* call is open
 *               (confirm / select / input / editor / custom — covers permission
 *               prompts from pi-tool-permissions, /commands, custom wizards
 *               like the questionnaire tool, etc.)
 *   error     – last tool_result was an error and we haven't recovered.
 *               Cleared by the next successful tool_result (agent worked
 *               around the failure), agent_start (new turn), or
 *               session_shutdown. Persists through agent_end — so if a
 *               turn ends on a failing tool, the ❌ stays visible on the
 *               idle tab until you send the next message.
 *   idle      – otherwise (and on session_shutdown)
 *
 * No-op when:
 *   - WT_SESSION env var is not set (i.e. not running in Windows Terminal)
 *   - ctx.hasUI is false (e.g. -p / JSON mode)
 *
 * Conflict note:
 *   Don't use alongside examples/extensions/titlebar-spinner.ts — both write
 *   to ctx.ui.setTitle on the same lifecycle events, last-writer-wins. This
 *   extension is intended as a superset (the ⚙ glyph already conveys "working").
 *
 * Config: none. Glyphs and OSC codes are constants — edit this file to taste.
 */

import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ── State model ─────────────────────────────────────────────────────────────

export type State = "idle" | "working" | "waiting" | "error";

export const STATE_GLYPHS: Record<State, string> = {
	idle: "✅",
	working: "",
	waiting: "❓",
	error: "❌",
};

// OSC 9;4 progress states (Windows Terminal / ConEmu):
//   0 = hide, 1 = normal, 2 = error, 3 = indeterminate (spinner), 4 = warning
// In practice WT only renders Hide vs. Indeterminate distinctly, so we use the
// spinner only for "working" and hide otherwise.
export const STATE_PROGRESS: Record<State, number> = {
	idle: 0,
	working: 3,
	waiting: 0,
	error: 0,
};

// ── Wrapped UI methods (mirrored in test-helpers.mjs) ───────────────────────
//
// Any blocking dialog-shaped method on ctx.ui that we want to count as the
// agent "waiting on the user" must be listed here. wrapUiDialogs() intercepts
// each one to dispatch dialog_open / dialog_close around the call.
export const WRAPPED_UI_METHODS = ["confirm", "select", "input", "editor", "custom"] as const;

// ── Pure helpers (mirrored in test-helpers.mjs) ─────────────────────────────

export function isWindowsTerminal(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env.WT_SESSION);
}

export function formatTitle(state: State, sessionName: string | null, cwdBase: string): string {
	const glyph = STATE_GLYPHS[state];
	const base = sessionName ? `π - ${sessionName} - ${cwdBase}` : `π - ${cwdBase}`;
	return glyph ? `${glyph} ${base}` : base;
}

export function formatProgressSequence(state: State): string {
	return `\x1b]9;4;${STATE_PROGRESS[state]};0\x07`;
}

/**
 * Pure state reducer. Used by both the runtime and the state-machine test.
 *
 *   ctx contains:
 *     state            – current visible state
 *     dialogDepth      – number of nested dialogs open (>0 forces "waiting")
 *     lastToolErrored  – set by tool_error; cleared by tool_success,
 *                        agent_start, session_shutdown (NOT agent_end)
 *     agentRunning     – between agent_start and agent_end
 */
export interface ReducerState {
	state: State;
	dialogDepth: number;
	/** True iff the *most recent* tool_result was an error and we haven't
	 *  recovered. Cleared by tool_success, agent_start, or session_shutdown.
	 *  Deliberately NOT cleared by agent_end — a turn that ends on a failing
	 *  tool leaves ❌ visible until the next agent_start. */
	lastToolErrored: boolean;
	agentRunning: boolean;
}

export type ReducerEvent =
	| { type: "agent_start" }
	| { type: "agent_end" }
	| { type: "tool_error" }
	| { type: "tool_success" }
	| { type: "dialog_open" }
	| { type: "dialog_close" }
	| { type: "session_shutdown" };

export function initialState(): ReducerState {
	return { state: "idle", dialogDepth: 0, lastToolErrored: false, agentRunning: false };
}

export function reduce(s: ReducerState, ev: ReducerEvent): ReducerState {
	const next: ReducerState = { ...s };
	switch (ev.type) {
		case "agent_start":
			next.agentRunning = true;
			next.lastToolErrored = false;
			break;
		case "agent_end":
			// Note: leave lastToolErrored alone — if the turn ended on a
			// failing tool, we want ❌ to persist into idle until next turn.
			next.agentRunning = false;
			break;
		case "tool_error":
			next.lastToolErrored = true;
			break;
		case "tool_success":
			next.lastToolErrored = false;
			break;
		case "dialog_open":
			next.dialogDepth = s.dialogDepth + 1;
			break;
		case "dialog_close":
			next.dialogDepth = Math.max(0, s.dialogDepth - 1);
			break;
		case "session_shutdown":
			next.agentRunning = false;
			next.lastToolErrored = false;
			next.dialogDepth = 0;
			break;
	}
	next.state = resolveState(next);
	return next;
}

export function resolveState(s: Pick<ReducerState, "dialogDepth" | "lastToolErrored" | "agentRunning">): State {
	if (s.dialogDepth > 0) return "waiting";
	if (s.lastToolErrored) return "error";
	if (s.agentRunning) return "working";
	return "idle";
}

// ── Runtime: event handlers + ctx.ui wrapping ───────────────────────────────

function getCwdBase(): string {
	return path.basename(process.cwd());
}

export default function (pi: ExtensionAPI) {
	if (!isWindowsTerminal()) return;

	let s = initialState();
	let lastApplied: State | null = null;
	// The ctx most recently handed to us by an event. The ctx.ui dialog wrappers
	// below must NOT capture a ctx: pi reuses the same ExtensionUIContext object
	// across /reload (AgentSession.reload keeps _extensionUIContext), while each
	// reload invalidates the old ctx. A captured ctx would go stale and throw
	// "This extension ctx is stale..." on the next dialog. Read through this ref
	// instead so wrappers always use a live ctx.
	let currentCtx: ExtensionContext | undefined;
	// Restores the original ctx.ui methods we monkey-patched, so session_shutdown
	// can leave the shared ui object exactly as we found it.
	let unwrapUiDialogs: (() => void) | undefined;

	function apply(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		if (s.state === lastApplied) return;
		lastApplied = s.state;

		ctx.ui.setTitle(formatTitle(s.state, pi.getSessionName() ?? null, getCwdBase()));
		process.stdout.write(formatProgressSequence(s.state));
	}

	function dispatch(ctx: ExtensionContext, ev: ReducerEvent) {
		s = reduce(s, ev);
		apply(ctx);
	}

	// Dispatch using whatever ctx is currently live. Called from the ctx.ui
	// wrappers, which can fire long after the ctx that installed them died.
	function dispatchCurrent(ev: ReducerEvent) {
		const ctx = currentCtx;
		if (!ctx) {
			// No live ctx (e.g. a dialog resolving after session_shutdown): keep the
			// reducer honest but skip apply(), which would touch a dead ctx.
			s = reduce(s, ev);
			return;
		}
		dispatch(ctx, ev);
	}

	function wrapUiDialogs(ctx: ExtensionContext) {
		if (unwrapUiDialogs || !ctx.hasUI) return;

		// pi reuses one ExtensionUIContext object across reloads, so without the
		// session_shutdown unwrap below each reload would stack another wrapper on
		// top of the previous one.
		const ui = ctx.ui as unknown as Record<string, unknown>;
		const originals: Array<[string, unknown]> = [];
		for (const method of WRAPPED_UI_METHODS) {
			const orig = ui[method];
			if (typeof orig !== "function") continue;
			const fn = orig as (...args: unknown[]) => unknown;
			originals.push([method, orig]);
			ui[method] = (...args: unknown[]) => {
				dispatchCurrent({ type: "dialog_open" });
				let result: unknown;
				try {
					result = fn.apply(ui, args);
				} catch (err) {
					dispatchCurrent({ type: "dialog_close" });
					throw err;
				}
				if (result && typeof (result as Promise<unknown>).then === "function") {
					return (result as Promise<unknown>).finally(() => {
						dispatchCurrent({ type: "dialog_close" });
					});
				}
				dispatchCurrent({ type: "dialog_close" });
				return result;
			};
		}

		unwrapUiDialogs = () => {
			for (const [method, orig] of originals) ui[method] = orig;
			unwrapUiDialogs = undefined;
		};
	}

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
		wrapUiDialogs(ctx);
		apply(ctx);
	});

	pi.on("agent_start", async (_event, ctx) => {
		currentCtx = ctx;
		wrapUiDialogs(ctx);
		dispatch(ctx, { type: "agent_start" });
	});

	pi.on("agent_end", async (_event, ctx) => {
		currentCtx = ctx;
		dispatch(ctx, { type: "agent_end" });
	});

	pi.on("tool_result", async (event, ctx) => {
		currentCtx = ctx;
		dispatch(ctx, { type: event.isError ? "tool_error" : "tool_success" });
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		currentCtx = ctx;
		dispatch(ctx, { type: "session_shutdown" });
		// Fires before the runner is invalidated, so restore the original ctx.ui
		// methods now. This leaves no stale wrapper on the shared ui object and
		// prevents wrappers from stacking on the next reload.
		unwrapUiDialogs?.();
		currentCtx = undefined;
	});
}
