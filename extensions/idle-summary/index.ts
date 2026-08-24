/**
 * Idle Summary Extension
 *
 * After the agent has been idle for ~2 minutes, generates a session summary
 * and displays it inline in the chat history (no modal — no dismiss required).
 * Use the `/summary` command to trigger it immediately; doing so suppresses the
 * pending idle timer for the current idle period.
 *
 * Model selection: prefers the cheapest/fastest model from the same provider as
 * the currently selected model, then falls back through the remaining scoped (or
 * available) models in ascending cost order. Falls back gracefully if no model or
 * API key is available.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	findConfiguredModel,
	modelLabel,
	pickableModels,
	selectSummaryModel,
} from "./idle-summary-models.ts";

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

const IDLE_DELAY_MS = 120_000;
const CUSTOM_TYPE = "idle-summary";
const CONFIG_FILE = "idle-summary.json";

// ── Config persistence ──────────────────────────────────────────────────────
// The user's chosen summary model lives in the global agent dir
// (`getAgentDir()`), so it applies across all projects and sessions. Stored as
// `{ "model": "provider/modelId" }`. Missing/corrupt file = no override.
const configPath = () => join(getAgentDir(), CONFIG_FILE);

const readConfiguredModel = (): string | undefined => {
	try {
		const raw = readFileSync(configPath(), "utf8");
		const parsed = JSON.parse(raw) as { model?: unknown } | null;
		return typeof parsed?.model === "string" ? parsed.model : undefined;
	} catch {
		return undefined;
	}
};

const writeConfiguredModel = (ref: string): void => {
	try {
		writeFileSync(configPath(), JSON.stringify({ model: ref }, null, 2));
	} catch {
		// Best-effort: a failed write just means the choice won't persist.
	}
};

// Build the candidate pool from the session's scoped models, or all available
// models when no scoping is configured (scopedModels is empty in that case).
// Resolution order: an explicit user override (from `/summary-model`), then
// the pure `selectSummaryModel` heuristic (cheapest model from the currently
// selected model's provider first, then the rest by ascending cost). Each
// candidate must have configured auth.
const summaryPool = (ctx: ExtensionContext): Model<Api>[] =>
	ctx.scopedModels.length > 0
		? ctx.scopedModels.map((s) => s.model)
		: ctx.modelRegistry.getAvailable();

const pickSummaryModel = (ctx: ExtensionContext): Model<Api> | undefined => {
	const pool = summaryPool(ctx);
	const hasAuth = (m: Model<Api>) => ctx.modelRegistry.hasConfiguredAuth(m);
	return (
		findConfiguredModel(pool, readConfiguredModel(), hasAuth) ??
		selectSummaryModel(pool, ctx.model?.provider, hasAuth)
	);
};

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
	// True once /summary has been invoked during the current idle period.
	// Prevents the idle timer from firing again for the same period.
	let summaryShownSinceLastTurn = false;

	function clearIdleTimer() {
		if (idleTimer) {
			clearTimeout(idleTimer);
			idleTimer = null;
		}
	}

	async function generateAndShowSummary(ctx: ExtensionContext) {
		const branch = ctx.sessionManager.getBranch();
		const conversationText = buildConversationText(branch as SessionEntry[]);
		if (!conversationText.trim()) return;

		// Prefer the cheapest/fastest model from the same provider as the currently
		// selected model, then fall back through the remaining scoped (or available)
		// models. hasConfiguredAuth() gates without an async auth round-trip.
		const selectedModel = pickSummaryModel(ctx);
		if (!selectedModel) return; // No model available — bail silently

		const messages = [
			{
				role: "user" as const,
				content: [{ type: "text" as const, text: buildSummaryPrompt(conversationText) }],
				timestamp: Date.now(),
			},
		];

		let response;
		try {
			response = await ctx.modelRegistry.complete(selectedModel, { messages });
		} catch {
			return; // Network or API error — bail silently
		}

		const summary = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n")
			.trim();

		if (!summary) return;

		const modelLabel = `${selectedModel.provider}/${selectedModel.id}`;
		// The model call above can take several seconds. If a /reload or session
		// replacement (/new, /resume, /fork) happens during that await, the captured
		// `pi` and `ctx` are invalidated and pi.sendMessage throws a stale-ctx error.
		// That means this summary belongs to a now-dead session, so bail silently
		// instead of propagating (e.g. as a `command:summary` error).
		try {
			pi.sendMessage({
				customType: CUSTOM_TYPE,
				content: summary,
				details: { model: modelLabel },
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

	pi.on("agent_start", () => {
		clearIdleTimer();
		summaryShownSinceLastTurn = false;
	});

	pi.on("agent_end", async (_event, ctx) => {
		clearIdleTimer();
		// If /summary was already called since the last turn, don't auto-fire.
		if (summaryShownSinceLastTurn) return;
		// Each agent_end re-arms the timer and agent_start clears it, so the
		// summary only appears after IDLE_DELAY_MS of true idleness (no further
		// agent activity). Intermediate retries/compaction just reset the countdown.
		idleTimer = setTimeout(() => {
			idleTimer = null;
			generateAndShowSummary(ctx).catch(() => {});
		}, IDLE_DELAY_MS);
	});

	// Trigger a summary immediately, and suppress the pending idle timer.
	pi.registerCommand("summary", {
		description: "Generate a session summary now",
		handler: async (_args, ctx) => {
			clearIdleTimer();
			summaryShownSinceLastTurn = true;
			await generateAndShowSummary(ctx);
		},
	});

	// Pick which model generates summaries. Opens a model picker; the choice is
	// persisted to the global agent dir and preferred on every future summary.
	pi.registerCommand("summary-model", {
		description: "Choose the model used to generate session summaries",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify(
					"/summary-model needs an interactive UI; run it in the TUI.",
					"warning",
				);
				return;
			}

			const pool = summaryPool(ctx);
			const hasAuth = (m: Model<Api>) => ctx.modelRegistry.hasConfiguredAuth(m);
			const pickable = pickableModels(pool, hasAuth);
			if (pickable.length === 0) {
				ctx.ui.notify("No models with configured auth are available.", "warning");
				return;
			}

			const saved = readConfiguredModel();
			const current = pickSummaryModel(ctx);
			// Put the effective current model first so it is pre-highlighted.
			const ordered = current
				? [current, ...pickable.filter((m) => modelLabel(m) !== modelLabel(current))]
				: pickable;
			const labels = ordered.map(modelLabel);

			const choice = await ctx.ui.select("Summary model:", labels, {
				signal: ctx.signal,
			});
			if (!choice) return; // cancelled

			writeConfiguredModel(choice);
			ctx.ui.notify(`Summary model set to ${choice}`, "info");
		},
	});

	pi.on("session_shutdown", () => {
		clearIdleTimer();
	});
}
