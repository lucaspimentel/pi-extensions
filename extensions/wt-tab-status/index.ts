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
 *   working   – between agent_start and agent_settled
 *   waiting   – any time a blocking ctx.ui.* call is open
 *               (confirm / select / input / editor / custom — covers permission
 *               prompts from pi-tool-permissions, /commands, custom wizards
 *               like the questionnaire tool, etc.)
 *   error     – last tool_result was an error and we haven't recovered.
 *               Cleared by the next successful tool_result (agent worked
 *               around the failure), agent_start (new turn), or
 *               session_shutdown. Persists through agent_settled — so if a
 *               turn ends on a failing tool, the ❌ stays visible on the
 *               idle tab until you send the next message.
 *   idle      – otherwise (and on session_shutdown)
 *
 * No-op when:
 *   - WT_SESSION env var is not set (i.e. not running in Windows Terminal)
 *   - HERDR_ENV is "1" (pi runs inside a herdr pane): herdr owns the Windows
 *     Terminal tab title and reports its own pane working/blocked state, so
 *     neither the glyph title nor the OSC 9;4 spinner may be written. There is
 *     no override env for this gate.
 *   - ctx.hasUI is false (e.g. -p / JSON mode)
 *
 * Mode note:
 *   The OSC 9;4 progress write goes to raw stdout and only happens in TUI
 *   mode (ctx.mode === "tui"). RPC mode also has hasUI === true, and a raw
 *   write there would corrupt the RPC JSON stream (WT_SESSION is often
 *   inherited); in RPC mode only the tab title is updated, never stdout.
 *
 * Conflict note:
 *   Don't use alongside examples/extensions/titlebar-spinner.ts — both write
 *   to ctx.ui.setTitle on the same lifecycle events, last-writer-wins. This
 *   extension is intended as a superset (the ⚙ glyph already conveys "working").
 *
 * Config: none. Glyphs and OSC codes are constants — edit this file to taste.
 *
 * State model: the lifecycle state machine itself (states, events, reducer)
 * lives in ../shared/agent-lifecycle.ts, shared with the intelligent-terminal
 * extension. This file keeps only the tab-title/OSC presentation and the
 * event wiring, and re-exports the moved names for existing callers.
 */

import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	initialLifecycleState,
	reduceLifecycle,
	type AgentLifecycleState,
	type LifecycleEvent,
} from "../shared/agent-lifecycle.ts";

// ── Shared lifecycle model ──────────────────────────────────────────────────
//
// Re-exported so this module's public surface is unchanged for existing
// callers and tests.
export {
	initialLifecycleState,
	reduceLifecycle,
	resolveLifecycleState,
} from "../shared/agent-lifecycle.ts";
export type { AgentLifecycleState, LifecycleEvent, LifecycleState } from "../shared/agent-lifecycle.ts";

// ── Tab title / spinner presentation ───────────────────────────────────────

export const STATE_GLYPHS: Record<AgentLifecycleState, string> = {
	idle: "✅",
	working: "",
	waiting: "❓",
	error: "❌",
};

// OSC 9;4 progress states (Windows Terminal / ConEmu):
//   0 = hide, 1 = normal, 2 = error, 3 = indeterminate (spinner), 4 = warning
// In practice WT only renders Hide vs. Indeterminate distinctly, so we use the
// spinner only for "working" and hide otherwise.
export const STATE_PROGRESS: Record<AgentLifecycleState, number> = {
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

// ── Pure helpers ───────────────────────────────────────────────────────────
//
// isWindowsTerminal and the formatting helpers are mirrored in
// test-helpers.mjs for the legacy run-all.mjs suite. isHerdrSession is
// deliberately not mirrored: that suite covers formatting and the state
// machine, never this gate.

export function isWindowsTerminal(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env.WT_SESSION);
}

/**
 * True when pi runs inside a herdr pane. herdr owns the Windows Terminal tab
 * title and reports its own per-pane working/blocked state, so the title and
 * OSC 9;4 writes below would fight it. Same marker extensions/herdr-tab-name.ts
 * gates on; other truthy values ("true", "yes") do not count.
 */
export function isHerdrSession(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.HERDR_ENV === "1";
}

export function formatTitle(state: AgentLifecycleState, sessionName: string | null, cwdBase: string): string {
	const glyph = STATE_GLYPHS[state];
	const base = sessionName ? `π - ${sessionName} - ${cwdBase}` : `π - ${cwdBase}`;
	return glyph ? `${glyph} ${base}` : base;
}

export function formatProgressSequence(state: AgentLifecycleState): string {
	return `\x1b]9;4;${STATE_PROGRESS[state]};0\x07`;
}

// ── Runtime: event handlers + ctx.ui wrapping ───────────────────────────────

function getCwdBase(): string {
	return path.basename(process.cwd());
}

export default function (pi: ExtensionAPI) {
	if (!isWindowsTerminal() || isHerdrSession()) return;

	let s = initialLifecycleState();
	let lastApplied: AgentLifecycleState | null = null;
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
		// The OSC 9;4 sequence goes to raw stdout, which would corrupt the RPC
		// JSON stream (RPC mode also has hasUI === true, e.g. when WT_SESSION is
		// inherited). Write it only in TUI mode; the title update above is routed
		// through ctx.ui and safe in both modes.
		if (ctx.mode === "tui") {
			process.stdout.write(formatProgressSequence(s.state));
		}
	}

	function dispatch(ctx: ExtensionContext, ev: LifecycleEvent) {
		s = reduceLifecycle(s, ev);
		apply(ctx);
	}

	// Dispatch using whatever ctx is currently live. Called from the ctx.ui
	// wrappers, which can fire long after the ctx that installed them died.
	function dispatchCurrent(ev: LifecycleEvent) {
		const ctx = currentCtx;
		if (!ctx) {
			// No live ctx (e.g. a dialog resolving after session_shutdown): keep the
			// reducer honest but skip apply(), which would touch a dead ctx.
			s = reduceLifecycle(s, ev);
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

	pi.on("agent_settled", async (_event, ctx) => {
		currentCtx = ctx;
		// Cleared for every settlement; the event's `aborted` flag makes no
		// difference to the visible state (working -> idle either way).
		dispatch(ctx, { type: "agent_settled" });
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
