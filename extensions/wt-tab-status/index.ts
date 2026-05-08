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
 *   error     – tool_result with isError/error this turn; sticky until next agent_start
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
 *     state           – current visible state
 *     dialogDepth     – number of nested dialogs open (>0 forces "waiting")
 *     errorThisTurn   – set true by tool errors, cleared on agent_start
 *     agentRunning    – between agent_start and agent_end
 */
export interface ReducerState {
	state: State;
	dialogDepth: number;
	errorThisTurn: boolean;
	agentRunning: boolean;
}

export type ReducerEvent =
	| { type: "agent_start" }
	| { type: "agent_end" }
	| { type: "tool_error" }
	| { type: "dialog_open" }
	| { type: "dialog_close" }
	| { type: "session_shutdown" };

export function initialState(): ReducerState {
	return { state: "idle", dialogDepth: 0, errorThisTurn: false, agentRunning: false };
}

export function reduce(s: ReducerState, ev: ReducerEvent): ReducerState {
	const next: ReducerState = { ...s };
	switch (ev.type) {
		case "agent_start":
			next.agentRunning = true;
			next.errorThisTurn = false;
			break;
		case "agent_end":
			next.agentRunning = false;
			break;
		case "tool_error":
			next.errorThisTurn = true;
			break;
		case "dialog_open":
			next.dialogDepth = s.dialogDepth + 1;
			break;
		case "dialog_close":
			next.dialogDepth = Math.max(0, s.dialogDepth - 1);
			break;
		case "session_shutdown":
			next.agentRunning = false;
			next.errorThisTurn = false;
			next.dialogDepth = 0;
			break;
	}
	next.state = resolveState(next);
	return next;
}

export function resolveState(s: Pick<ReducerState, "dialogDepth" | "errorThisTurn" | "agentRunning">): State {
	if (s.dialogDepth > 0) return "waiting";
	if (s.errorThisTurn) return "error";
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
	let uiWrapped = false;

	function apply(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		if (s.state === lastApplied) return;
		lastApplied = s.state;

		ctx.ui.setTitle(formatTitle(s.state, pi.getSessionName(), getCwdBase()));
		process.stdout.write(formatProgressSequence(s.state));
	}

	function dispatch(ctx: ExtensionContext, ev: ReducerEvent) {
		s = reduce(s, ev);
		apply(ctx);
	}

	function wrapUiDialogs(ctx: ExtensionContext) {
		if (uiWrapped || !ctx.hasUI) return;
		uiWrapped = true;

		const ui = ctx.ui as unknown as Record<string, unknown>;
		for (const method of WRAPPED_UI_METHODS) {
			const orig = ui[method];
			if (typeof orig !== "function") continue;
			const fn = orig as (...args: unknown[]) => unknown;
			ui[method] = (...args: unknown[]) => {
				dispatch(ctx, { type: "dialog_open" });
				let result: unknown;
				try {
					result = fn.apply(ctx.ui, args);
				} catch (err) {
					dispatch(ctx, { type: "dialog_close" });
					throw err;
				}
				if (result && typeof (result as Promise<unknown>).then === "function") {
					return (result as Promise<unknown>).finally(() => {
						dispatch(ctx, { type: "dialog_close" });
					});
				}
				dispatch(ctx, { type: "dialog_close" });
				return result;
			};
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		wrapUiDialogs(ctx);
		apply(ctx);
	});

	pi.on("agent_start", async (_event, ctx) => {
		wrapUiDialogs(ctx);
		dispatch(ctx, { type: "agent_start" });
	});

	pi.on("agent_end", async (_event, ctx) => {
		dispatch(ctx, { type: "agent_end" });
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.isError) {
			dispatch(ctx, { type: "tool_error" });
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		dispatch(ctx, { type: "session_shutdown" });
	});
}
