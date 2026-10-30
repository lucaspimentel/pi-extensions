/**
 * Idle Summary Extension
 *
 * After the agent has been idle for ~3 minutes (configurable via
 * `timeoutMinutes` in the config file), generates a session summary
 * and displays it inline in the chat history (no modal — no dismiss required).
 * Use the `/idle-summary` command to trigger it immediately; doing so
 * suppresses the pending idle timer for the current idle period.
 * `/idle-summary model` opens a picker for the model used to generate
 * summaries; `/idle-summary model clear` removes that pin.
 *
 * Model selection: the global pin in `~/.pi/agent/idle-summary.json`
 * (`"model": "provider/modelId"`, shared helpers in ../shared/model-pin.ts)
 * when it resolves and has configured auth; otherwise the session model,
 * priced or not. One model per run, no fallback chain. Bails silently when
 * there is no model or the session model has no configured auth. A pin that
 * cannot be used is reported once per session at session_start.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	clearModelPin,
	createIgnoredPinNotifier,
	describeIgnoredPin,
	readModelPin,
	resolveModel,
	type ResolvedModel,
	writeModelPin,
} from "../shared/model-pin.ts";
import { modelLabel, pickableModels } from "../shared/model-selection.ts";
import { DEFAULT_IDLE_TIMEOUT_MS, resolveIdleTimeoutMs } from "./idle-summary-models.ts";

// ── Types ────────────────────────────────────────────────────────────────────

type ContentBlock = {
	type?: string;
	text?: string;
	name?: string;
	arguments?: Record<string, unknown>;
};

type SessionEntry = {
	type: string;
	message?: {
		role?: string;
		content?: unknown;
	};
};

// ── Constants ────────────────────────────────────────────────────────────────

const CUSTOM_TYPE = "idle-summary";
const CONFIG_FILE = "idle-summary.json";

// ── Config persistence ──────────────────────────────────────────────────────
// The user's summary model pin and idle timeout live in the global agent dir
// (`getAgentDir()`), so they apply across all projects and sessions. Stored as
// `{ "model": "provider/modelId", "timeoutMinutes": 3 }`. Missing/corrupt file
// = defaults for everything. The pin is read and written through
// ../shared/model-pin.ts, which preserves sibling keys such as timeoutMinutes.
const configPath = () => join(getAgentDir(), CONFIG_FILE);

const readConfig = (): Record<string, unknown> | undefined => {
	try {
		const raw = readFileSync(configPath(), "utf8");
		const parsed = JSON.parse(raw) as Record<string, unknown> | null;
		return parsed ?? undefined;
	} catch {
		return undefined;
	}
};

// The model for a summary run: the pin when it resolves and has auth, else
// the session model unchanged (callers apply their own auth check to it).
const summaryModel = (ctx: ExtensionContext): ResolvedModel =>
	resolveModel(readModelPin(configPath()).ref, ctx.model, ctx.modelRegistry);

// Picker pool: the session's scoped models, or all available models when no
// scoping is configured (scopedModels is empty in that case).
const pickerPool = (ctx: ExtensionContext) =>
	ctx.scopedModels.length > 0
		? ctx.scopedModels.map((s) => s.model)
		: ctx.modelRegistry.getAvailable();

// ── Conversation helpers ─────────────────────────────────────────────────────

const extractTextParts = (content: unknown): string[] => {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];

	const parts: string[] = [];
	for (const item of content) {
		if (item && typeof item === "object") {
			const block = item as ContentBlock;
			if (block.type === "text" && typeof block.text === "string") {
				parts.push(block.text);
			}
		}
	}
	return parts;
};

const extractToolCallLines = (content: unknown): string[] => {
	if (!Array.isArray(content)) return [];

	const calls: string[] = [];
	for (const item of content) {
		if (!item || typeof item !== "object") continue;
		const block = item as ContentBlock;
		if (block.type === "toolCall" && typeof block.name === "string") {
			calls.push(`Tool ${block.name} called with args ${JSON.stringify(block.arguments ?? {})}`);
		}
	}
	return calls;
};

const buildConversationText = (entries: SessionEntry[]): string => {
	const sections: string[] = [];

	for (const entry of entries) {
		if (entry.type !== "message" || !entry.message?.role) continue;

		const { role, content } = entry.message;
		const isUser = role === "user";
		const isAssistant = role === "assistant";
		if (!isUser && !isAssistant) continue;

		const lines: string[] = [];
		const textParts = extractTextParts(content);
		if (textParts.length > 0) {
			const text = textParts.join("\n").trim();
			if (text) lines.push(`${isUser ? "User" : "Assistant"}: ${text}`);
		}
		if (isAssistant) lines.push(...extractToolCallLines(content));
		if (lines.length > 0) sections.push(lines.join("\n"));
	}

	return sections.join("\n\n");
};

const buildSummaryPrompt = (conversationText: string): string =>
	[
		"Summarize this coding session in at most 2 short lines of plain text.",
		"Line 1: what was worked on. Line 2: current status or next step.",
		"No headings, no bullet points, no markdown. Be terse — aim for under 200 characters total.",
		"",
		"<conversation>",
		conversationText,
		"</conversation>",
	].join("\n");

// ── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let idleTimer: ReturnType<typeof setTimeout> | null = null;
	// Set on the first arming that observes an invalid `timeoutMinutes` config
	// value, so the warning shows once instead of on every agent_end.
	let warnedInvalidTimeout = false;
	// Bumped by session_shutdown (which fires before the runner is invalidated).
	// An in-flight generateAndShowSummary captures the value at entry and compares
	// it after its model await, so it can bail before touching a now-stale ctx/pi.
	// A counter (not a boolean) because the extension closure is REUSED across
	// session replacement (/new, /resume, /fork, /switchSession): pi's resource
	// loader caches the loaded extension set, so a boolean reset on session_start
	// would clear the flag out from under an old in-flight run and let it touch
	// the new session's stale ctx.
	let generation = 0;
	// Once-per-session dedupe for the pin read warning and the ignored-pin
	// notice; reset on every session_start.
	const pinNotifier = createIgnoredPinNotifier();

	function clearIdleTimer() {
		if (idleTimer) {
			clearTimeout(idleTimer);
			idleTimer = null;
		}
	}

	function armIdleTimer(ctx: ExtensionContext) {
		const { timeoutMs, invalid } = resolveIdleTimeoutMs(readConfig()?.timeoutMinutes);
		if (invalid && !warnedInvalidTimeout) {
			warnedInvalidTimeout = true;
			try {
				if (ctx.hasUI) {
					ctx.ui.notify(
						`idle-summary: invalid "timeoutMinutes" in ${CONFIG_FILE}; ` +
							`using default (${DEFAULT_IDLE_TIMEOUT_MS / 60_000} minutes).`,
						"warning",
					);
				}
			} catch {
				// Stale ctx: the summary generation guard handles the run path;
				// a warning is best-effort and never worth throwing over.
			}
		}
		idleTimer = setTimeout(() => {
			idleTimer = null;
			generateAndShowSummary(ctx).catch(() => {});
		}, timeoutMs);
	}

	async function generateAndShowSummary(ctx: ExtensionContext) {
		const runGeneration = generation;
		const branch = ctx.sessionManager.getBranch();
		const conversationText = buildConversationText(branch as SessionEntry[]);
		if (!conversationText.trim()) return;

		const messages = [
			{
				role: "user" as const,
				content: [{ type: "text" as const, text: buildSummaryPrompt(conversationText) }],
				timestamp: Date.now(),
			},
		];

		// One model per run: the pin when usable, else the session model.
		// `complete` can resolve with an error response (empty content +
		// `errorMessage`) instead of throwing, so an empty summary is a failure.
		const resolved = summaryModel(ctx);
		const usedModel = resolved.model;
		if (!usedModel) return; // No model selected: bail silently
		if (!resolved.pinned && !ctx.modelRegistry.hasConfiguredAuth(usedModel)) return; // No auth: bail silently

		let lastError: string | undefined;
		let summary: string | undefined;
		try {
			const response = await ctx.modelRegistry.streamSimple(usedModel, { messages }).result();
			summary = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n")
				.trim();
			if (!summary) lastError = response.errorMessage;
		} catch (e) {
			lastError = e instanceof Error ? e.message : String(e);
		}

		// The model await above can take several seconds. If a /reload or session
		// replacement (/new, /resume, /fork) happened during that await, session_shutdown
		// fired and bumped `generation` before the runner was invalidated. This summary
		// belongs to a now-dead session, so bail silently before touching the stale
		// ctx/pi (which would throw and, on the /idle-summary command path, propagate as a
		// "command:idle-summary" error after the reload/replacement finishes).
		if (generation !== runGeneration) return;

		if (!summary) {
			// The model failed. Surface it instead of bailing silently so the
			// user knows the summary didn't generate (e.g. a rate-limited model).
			if (ctx.hasUI) {
				ctx.ui.notify(
					`idle-summary: no model produced a summary.${lastError ? ` ${lastError}` : ""}`,
					"warning",
				);
			}
			return;
		}

		const modelLabelUsed = modelLabel(usedModel);
		// Defense in depth: the generation check above is the primary guard, but keep
		// a try/catch around sendMessage in case of a race where shutdown fires
		// between the check and the call.
		try {
			pi.sendMessage({
				customType: CUSTOM_TYPE,
				content: summary,
				details: { model: modelLabelUsed },
				display: true,
			});
		} catch {
			return;
		}
	}

	// Render summary inline in chat history
	pi.registerMessageRenderer(CUSTOM_TYPE, (message, _options, theme) => {
		const summary = (message.content as string).trim();
		const model = ((message.details as { model?: string } | undefined)?.model) ?? "";
		const box = new Box(1, 0, (t: string) => theme.bg("customMessageBg", t));
		const body = `${theme.fg("accent", "📋")} ${theme.fg("muted", summary)}`;
		const line = model ? `${body}  ${theme.fg("muted", `· ${model}`)}` : body;
		box.addChild(new Text(line, 0, 0));
		return box;
	});

	pi.on("session_start", (_event, ctx) => {
		clearIdleTimer();
		pinNotifier.reset();
		// No pin and nothing wrong with the file: return before touching ctx,
		// which may already be stale (the closure is reused across session
		// replacement).
		const pin = readModelPin(configPath());
		if (!pin.ref && !pin.warning) return;
		try {
			if (!ctx.hasUI) return;
			if (pin.warning) {
				const warning = pin.warning;
				pinNotifier.notifyOnce(warning, () => ctx.ui.notify(`idle-summary: ${warning}`, "warning"));
			}
			if (pin.ref) {
				const ignored = resolveModel(pin.ref, ctx.model, ctx.modelRegistry).ignoredPin;
				if (ignored) {
					pinNotifier.notifyOnce(ignored.ref, () =>
						ctx.ui.notify(describeIgnoredPin("idle-summary", ignored, ctx.model), "warning"),
					);
				}
			}
		} catch {
			// Best effort: a stale ctx never breaks session start.
		}
	});

	pi.on("agent_start", () => {
		clearIdleTimer();
	});

	pi.on("agent_end", async (_event, ctx) => {
		clearIdleTimer();
		// Each agent_end re-arms the timer and agent_start clears it, so the
		// summary only appears after the configured idle timeout of true idleness
		// (no further agent activity). Intermediate retries/compaction just reset
		// the countdown.
		armIdleTimer(ctx);
	});

	// Model picker for `/idle-summary model`. The choice is pinned in the
	// global agent dir and used for every future summary while it resolves.
	async function pickSummaryModel(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) {
			ctx.ui.notify(
				"/idle-summary model needs an interactive UI; run it in the TUI.",
				"warning",
			);
			return;
		}

		const hasAuth = (m: Model<Api>) => ctx.modelRegistry.hasConfiguredAuth(m);
		const pickable = pickableModels(pickerPool(ctx), hasAuth);
		if (pickable.length === 0) {
			ctx.ui.notify("No models with configured auth are available.", "warning");
			return;
		}

		// Put the effective current model first so it is pre-highlighted. An
		// unpinned session model without auth is not offered.
		const resolved = summaryModel(ctx).model;
		const current = resolved && hasAuth(resolved) ? resolved : undefined;
		const ordered = current
			? [current, ...pickable.filter((m) => modelLabel(m) !== modelLabel(current))]
			: pickable;
		const labels = ordered.map(modelLabel);

		const choice = await ctx.ui.select("Summary model:", labels, {
			signal: ctx.signal,
		});
		if (!choice) return; // cancelled

		let warnings: string[];
		try {
			({ warnings } = writeModelPin(configPath(), choice));
		} catch (err) {
			ctx.ui.notify(
				`idle-summary: could not save the summary model: ${err instanceof Error ? err.message : String(err)}`,
				"warning",
			);
			return;
		}
		for (const warning of warnings) ctx.ui.notify(`idle-summary: ${warning}`, "warning");
		ctx.ui.notify(`Summary model set to ${choice}`, "info");
	}

	// `/idle-summary model clear`: drop the pin, keep every other key.
	function clearSummaryModel(ctx: ExtensionContext): void {
		let cleared: boolean;
		try {
			cleared = clearModelPin(configPath());
		} catch (err) {
			ctx.ui.notify(
				`idle-summary: could not clear the summary model: ${err instanceof Error ? err.message : String(err)}`,
				"warning",
			);
			return;
		}
		ctx.ui.notify(
			cleared ? "Summary model pin cleared; using the session model." : "No summary model pin set.",
			"info",
		);
	}

	// Trigger a summary immediately, and suppress the pending idle timer.
	// `/idle-summary model [clear]` manages the model pin instead, leaving the
	// idle timer armed.
	pi.registerCommand("idle-summary", {
		description:
			"Generate a session summary now; /idle-summary model picks the summary model, /idle-summary model clear uses the session model",
		getArgumentCompletions: (prefix: string) => {
			const items = [
				{ value: "model", label: "model", description: "Choose the model used to generate session summaries" },
				{ value: "model clear", label: "model clear", description: "Remove the summary model pin and use the session model" },
			];
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const command = (args ?? "").trim();
			if (/^model(\s|$)/i.test(command)) {
				const sub = command.slice(5).trim().toLowerCase();
				if (!sub) await pickSummaryModel(ctx);
				else if (sub === "clear") clearSummaryModel(ctx);
				else ctx.ui.notify("Usage: /idle-summary model | /idle-summary model clear", "warning");
				return;
			}
			clearIdleTimer();
			await generateAndShowSummary(ctx);
		},
	});

	pi.on("session_shutdown", () => {
		// Emitted before the runner is invalidated, so an in-flight
		// generateAndShowSummary can observe the bump after its model await.
		generation++;
		clearIdleTimer();
	});
}
