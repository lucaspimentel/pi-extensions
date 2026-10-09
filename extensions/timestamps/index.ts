/** Timestamps extension for pi
 *
 * Adds a dim timestamp line to every tool call row and tool result block in
 * the interactive transcript and HTML session exports:
 *
 *   ● bash
 *     └ rg -n "registerToolRenderer" docs/
 *     14:32:05  +0:03
 *
 *     ⎿ docs/extensions.md:190 ...
 *     ...
 *     ran 2.1s  ended 14:32:07
 *
 * The call line shows the absolute start time (local timezone, MM-DD prefix on
 * entries from previous days) and the delta since the previous transcript event
 * of any kind (user message, tool result; the first call of a turn measures
 * from the user prompt). While the tool is still running, the call line also
 * shows a live-ticking `ran 2.1s…` (omitted until 100ms have elapsed); once the
 * result arrives the duration moves
 * down to the result line, which shows `ran 2.1s  ended 14:32:07`. Shell tools
 * (bash, powershell) never show the extension's own duration: their renderer
 * already displays Elapsed/Took, so their call line stays start + delta and
 * their result line shows only the completion time.
 *
 * Display-only: nothing is written to the session file. Live rows are
 * timestamped from tool_execution_start/tool_execution_end events; rows from
 * resumed sessions are backfilled from session history (assistant message
 * timestamp as the start proxy for its tool calls, toolResult timestamp as
 * the end), so historical elapsed values are approximate. Rows with no
 * timestamp data render only the segments that are known; the line is omitted
 * entirely when nothing is known.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	SessionStartEvent,
	SessionTreeEvent,
	Theme,
	ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import { durationIsDisplayable, formatAbsolute, formatDelta, formatDuration, formatResultLine } from "./format.ts";

// ── Timestamp state ───────────────────────────────────────────────────────────

interface CallTimes {
	start: number;
	end?: number;
	/** Monotonic execute() duration reported by tool_execution_end, when present. */
	durationMs?: number;
	/** True when start was captured from a live tool_execution_start in this session. */
	live: boolean;
}

/** The minimal message shape the extension reads from session entries and message_end events. */
interface AnyMessage {
	role: string;
	timestamp?: number;
	content?: unknown;
	toolCallId?: string;
}

/** Live rows only: a call is running until tool_execution_end arrives. */
const calls = new Map<string, CallTimes>();
/**
 * Delta anchors: timestamps of user messages and tool results, in transcript
 * order. Assistant messages are excluded on purpose: their timestamp is the
 * request start, which is nearly identical to the preceding event and would
 * collapse historical deltas to zero (the backfilled call start proxies the
 * assistant timestamp exactly).
 */
const anchors: number[] = [];
/** Per-tool-call tick intervals that keep running rows' elapsed values fresh. */
const tickers = new Map<string, ReturnType<typeof setInterval>>();
const TICK_INTERVAL_MS = 100;

function deltaFor(startMs: number): number | undefined {
	for (let i = anchors.length - 1; i >= 0; i--) {
		const anchor = anchors[i];
		if (anchor <= startMs) return Math.max(0, startMs - anchor);
	}
	return undefined;
}

function clearTickers(): void {
	for (const ticker of tickers.values()) clearInterval(ticker);
	tickers.clear();
}

/** Rebuild call times and delta anchors from the active session branch. */
function rebuildFromBranch(branch: readonly unknown[]): void {
	clearTickers();
	calls.clear();
	anchors.length = 0;
	for (const entry of branch) {
		const message = (entry as { message?: AnyMessage } | undefined)?.message;
		if (!message || typeof message.timestamp !== "number") continue;
		if (message.role === "assistant") {
			const blocks = Array.isArray(message.content) ? message.content : [];
			for (const block of blocks as Array<{ type?: string; id?: string }>) {
				if (block?.type === "toolCall" && typeof block.id === "string" && !calls.has(block.id)) {
					calls.set(block.id, { start: message.timestamp, live: false });
				}
			}
		} else if (message.role === "toolResult") {
			anchors.push(message.timestamp);
			const call = calls.get(message.toolCallId ?? "");
			if (call) {
				call.end = message.timestamp;
			} else {
				// Result without a visible call block (branch truncation, older format):
				// start is unknown, so only the ended line renders.
				calls.set(message.toolCallId ?? "", { start: message.timestamp, end: message.timestamp, live: false });
			}
		} else if (message.role === "user") {
			anchors.push(message.timestamp);
		}
	}
}

/** One timestamp text line plus the cached components for a single tool row. */
interface TimestampsState {
	container?: Container;
	resultContainer?: Container;
	callLine?: Text;
	resultLine?: Text;
	baseCall?: Component;
	baseResult?: Component;
	ticker?: ReturnType<typeof setInterval>;
}

/** Structural subset of the SDK's tool renderer context (not exported from the package index). */
interface RenderContext {
	toolCallId: string;
	state: Record<string, unknown>;
	lastComponent: Component | undefined;
	invalidate: () => void;
}

/**
 * Renderer shapes for registerToolRenderer and the tool_execution_end duration,
 * both added in pi 1.x. The repo typechecks against the published 0.99.x types
 * while the runtime is 1.x, so these are accessed through structural casts.
 */
interface ToolRenderersLike {
	renderShell?: unknown;
	renderCall?: BaseRenderCall;
	renderResult?: BaseRenderResult;
}

interface ToolExecutionEndLike {
	toolCallId: string;
	durationMs?: number;
}

const STATE_KEY = "__timestamps__";

function ensureState(state: Record<string, unknown>): TimestampsState {
	const existing = state[STATE_KEY] as TimestampsState | undefined;
	if (existing) return existing;
	const created: TimestampsState = {};
	state[STATE_KEY] = created;
	return created;
}

/**
 * Compose the call row's dim line, showing only the segments that are known:
 * start and delta always (when known), plus a live-ticking `ran Xs…` while the
 * tool is still executing (once at least 100ms have elapsed; before that the
 * duration would read as 0.0s). Shell tools never get the ticking duration
 * because their own renderer shows Elapsed while running.
 */
function callLineText(call: CallTimes, nowMs: number, isShellTool: boolean): string {
	const segments: string[] = [formatAbsolute(call.start, nowMs)];
	const delta = deltaFor(call.start);
	if (delta !== undefined) segments.push(formatDelta(delta));
	if (call.end === undefined && call.live && !isShellTool) {
		const elapsed = Math.max(0, nowMs - call.start);
		if (durationIsDisplayable(elapsed)) segments.push(`ran ${formatDuration(elapsed)}\u2026`);
	}
	return segments.join("  ");
}

/** Start the per-row tick interval for a live running call, or stop it once finished. */
function updateTicker(context: RenderContext, call: CallTimes | undefined, st: TimestampsState): void {
	const running = call !== undefined && call.live && call.end === undefined;
	if (running && !st.ticker) {
		st.ticker = setInterval(() => {
			try {
				context.invalidate();
			} catch {
				// Stale context after session replacement: stop ticking.
				stopTicker(context.toolCallId, st);
			}
		}, TICK_INTERVAL_MS);
		// Never hold the process open on the tick interval alone.
		st.ticker.unref?.();
		tickers.set(context.toolCallId, st.ticker);
	} else if (!running && st.ticker) {
		stopTicker(context.toolCallId, st);
	}
}

function stopTicker(toolCallId: string, st: TimestampsState): void {
	if (st.ticker) {
		clearInterval(st.ticker);
		st.ticker = undefined;
	}
	const registered = tickers.get(toolCallId);
	if (registered) {
		clearInterval(registered);
		tickers.delete(toolCallId);
	}
}

// ── Renderer wrappers ─────────────────────────────────────────────────────────

type BaseRenderCall = (args: any, theme: Theme, context: any) => Component;
type BaseRenderResult = (
	result: any,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: any,
) => Component;

function wrapCall(
	baseRenderCall: BaseRenderCall,
	args: any,
	theme: Theme,
	context: RenderContext,
	isShellTool: boolean,
): Component {
	const st = ensureState(context.state);
	const inner = baseRenderCall(args, theme, { ...context, lastComponent: st.baseCall });
	st.baseCall = inner;

	const call = calls.get(context.toolCallId);
	const line = st.callLine ?? new Text("", 2, 0);
	const container = st.container ?? new Container();
	st.callLine = line;
	st.container = container;

	container.clear();
	container.addChild(inner);
	if (call) {
		line.setText(theme.fg("dim", callLineText(call, Date.now(), isShellTool)));
		container.addChild(line);
	}

	updateTicker(context, call, st);
	return container;
}

function wrapResult(
	baseRenderResult: BaseRenderResult,
	result: any,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: RenderContext,
	isShellTool: boolean,
): Component {
	const st = ensureState(context.state);
	const inner = baseRenderResult(result, options, theme, { ...context, lastComponent: st.baseResult });
	st.baseResult = inner;

	const call = calls.get(context.toolCallId);
	updateTicker(context, call, st);

	// Partial/streaming results have no completion time yet.
	if (!call || call.end === undefined || options.isPartial) return inner;

	const line = st.resultLine ?? new Text("", 2, 0);
	st.resultLine = line;
	const durationMs = call.durationMs ?? Math.max(0, call.end - call.start);
	line.setText(theme.fg("dim", formatResultLine(durationMs, call.end, Date.now(), !isShellTool)));

	// Preferred placement: the very bottom of the result block, after the body
	// (and after the shell renderer's Took line). When the base result renders
	// as a Container the line is appended to it; otherwise wrap and append below
	// the whole block.
	if (inner instanceof Container) {
		if (inner.children.includes(line)) inner.removeChild(line);
		inner.addChild(line);
		return inner;
	}
	const container = st.resultContainer ?? new Container();
	st.resultContainer = container;
	container.clear();
	container.addChild(inner);
	container.addChild(line);
	return container;
}

// ── Extension factory ─────────────────────────────────────────────────────────

export default function timestampsExtension(pi: ExtensionAPI): void {
	pi.on("session_start", (_event: SessionStartEvent, ctx: ExtensionContext) => {
		rebuildFromBranch(ctx.sessionManager.getBranch());
	});
	pi.on("session_tree", (_event: SessionTreeEvent, ctx: ExtensionContext) => {
		rebuildFromBranch(ctx.sessionManager.getBranch());
	});
	pi.on("session_shutdown", () => {
		clearTickers();
	});
	pi.on("message_end", (event) => {
		const message = event.message as AnyMessage;
		if (!message || typeof message.timestamp !== "number") return;
		// Assistant messages are not delta anchors; see the anchors comment above.
		if (message.role === "user" || message.role === "toolResult") {
			anchors.push(message.timestamp);
		}
	});
	pi.on("tool_execution_start", (event) => {
		const existing = calls.get(event.toolCallId);
		// A backfilled start for the same id is history, not this live run.
		calls.set(event.toolCallId, {
			start: existing?.live ? existing.start : Date.now(),
			live: true,
		});
	});
	pi.on("tool_execution_end", (event) => {
		const end = Date.now();
		const { durationMs } = event as ToolExecutionEndLike;
		const call = calls.get(event.toolCallId);
		if (!call) {
			// Start was never observed (extension loaded mid-run): reconstruct it
			// from the reported duration so the absolute time stays meaningful.
			calls.set(event.toolCallId, {
				start: end - (durationMs ?? 0),
				end,
				durationMs,
				live: false,
			});
			return;
		}
		call.end = end;
		if (typeof durationMs === "number") call.durationMs = durationMs;
		const ticker = tickers.get(event.toolCallId);
		if (ticker) {
			clearInterval(ticker);
			tickers.delete(event.toolCallId);
		}
	});

	const rendererApi = pi as unknown as {
		registerToolRenderer(
			resolver: (toolName: string, next: () => ToolRenderersLike | undefined) => ToolRenderersLike | undefined,
		): void;
	};
	rendererApi.registerToolRenderer((toolName, next) => {
		const base = next();
		if (!base) return undefined;
		// Shell renderers display the duration themselves (Elapsed while partial,
		// Took on the final result), so the extension suppresses its own `ran`.
		const isShellTool = toolName === "bash" || toolName === "powershell";
		const renderers: ToolRenderersLike = { ...base };
		if (base.renderCall) {
			const baseRenderCall = base.renderCall;
			renderers.renderCall = (args: any, theme: Theme, context: RenderContext) =>
				wrapCall(baseRenderCall, args, theme, context, isShellTool);
		}
		if (base.renderResult) {
			const baseRenderResult = base.renderResult;
			renderers.renderResult = (
				result: any,
				options: ToolRenderResultOptions,
				theme: Theme,
				context: RenderContext,
			) => wrapResult(baseRenderResult, result, options, theme, context, isShellTool);
		}
		return renderers;
	});
}
