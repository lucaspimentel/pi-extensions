/**
 * Idle Summary Extension
 *
 * After the agent has been idle for ~2 minutes, generates a session summary
 * and displays it inline in the chat history (no modal — no dismiss required).
 * Use the `/summary` command to trigger it immediately; doing so suppresses the
 * pending idle timer for the current idle period. `/summary model` opens a
 * picker for the model used to generate summaries; the flat `/summary-model`
 * still works as a deprecated alias during the migration window.
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
	modelLabel,
	orderedSummaryCandidates,
	pickableModels,
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
// Resolution order: an explicit user override (from `/summary model`), then
// the pure `selectModel` heuristic (cheapest model from the currently
// selected model's provider first, then the rest by ascending cost). Each
// candidate must have configured auth.
const summaryPool = (
	ctx: ExtensionContext,
): Model<Api>[] =>
	ctx.scopedModels.length > 0
		? ctx.scopedModels.map((s) => s.model)
		: ctx.modelRegistry.getAvailable();

// Ordered models to try for a summary run: the explicit `/summary model`
// override first (authoritative), then the remaining ranked, authed models,
// skipping unpriced models in the fallback ordering.
const summaryCandidates = (ctx: ExtensionContext): Model<Api>[] =>
	orderedSummaryCandidates(
		summaryPool(ctx),
		ctx.model?.provider,
		readConfiguredModel(),
		(m: Model<Api>) => ctx.modelRegistry.hasConfiguredAuth(m),
	);

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
	// Bumped by session_shutdown (which fires before the runner is invalidated).
	// An in-flight generateAndShowSummary captures the value at entry and compares
	// it after its model await, so it can bail before touching a now-stale ctx/pi.
	// A counter (not a boolean) because the extension closure is REUSED across
	// session replacement (/new, /resume, /fork, /switchSession): pi's resource
	// loader caches the loaded extension set, so a boolean reset on session_start
	// would clear the flag out from under an old in-flight run and let it touch
	// the new session's stale ctx.
	let generation = 0;

	function clearIdleTimer() {
		if (idleTimer) {
			clearTimeout(idleTimer);
			idleTimer = null;
		}
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

		// Try the preferred model first, then fall back through the ranked
		// candidates. `complete` can also resolve with an error response (empty
		// content + `errorMessage`) instead of throwing, so an empty summary counts
		// as a failure that moves to the next candidate.
		const candidates = summaryCandidates(ctx);
		if (candidates.length === 0) return; // No authed model available — bail silently

		let lastError: string | undefined;
		let summary: string | undefined;
		let usedModel: Model<Api> | undefined;

		for (const candidate of candidates) {
			let response;
			try {
				response = await ctx.modelRegistry.complete(candidate, { messages });
			} catch (e) {
				lastError = e instanceof Error ? e.message : String(e);
				continue;
			}

			summary = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n")
				.trim();

			if (summary) {
				usedModel = candidate;
				break;
			}
			lastError = response.errorMessage ?? lastError;
		}

		// The model awaits above can take several seconds. If a /reload or session
		// replacement (/new, /resume, /fork) happened during that await, session_shutdown
		// fired and bumped `generation` before the runner was invalidated. This summary
		// belongs to a now-dead session, so bail silently before touching the stale
		// ctx/pi (which would throw and, on the /summary command path, propagate as a
		// "command:summary" error after the reload/replacement finishes).
		if (generation !== runGeneration) return;

		if (!summary || !usedModel) {
			// Every candidate failed. Surface it instead of bailing silently so the
			// user knows the summary didn't generate (e.g. a rate-limited model).
			if (ctx.hasUI) {
				ctx.ui.notify(
					`idle-summary: no model produced a summary.${lastError ? ` ${lastError}` : ""}`,
					"warning",
				);
			}
			return;
		}

		const modelLabelUsed = `${usedModel.provider}/${usedModel.id}`;
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

	pi.on("session_start", () => {
		clearIdleTimer();
	});

	pi.on("agent_start", () => {
		clearIdleTimer();
	});

	pi.on("agent_end", async (_event, ctx) => {
		clearIdleTimer();
		// Each agent_end re-arms the timer and agent_start clears it, so the
		// summary only appears after IDLE_DELAY_MS of true idleness (no further
		// agent activity). Intermediate retries/compaction just reset the countdown.
		idleTimer = setTimeout(() => {
			idleTimer = null;
			generateAndShowSummary(ctx).catch(() => {});
		}, IDLE_DELAY_MS);
	});

	// Shared model picker for `/summary model` and the deprecated
	// `/summary-model` alias. Opens a picker; the choice is persisted to the
	// global agent dir and preferred on every future summary.
	async function pickSummaryModel(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) {
			ctx.ui.notify(
				"/summary model needs an interactive UI; run it in the TUI.",
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

		const [current] = summaryCandidates(ctx);
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
	}

	// Trigger a summary immediately, and suppress the pending idle timer.
	// `/summary model` opens the model picker instead, leaving the idle timer
	// armed, exactly like the old flat /summary-model behavior.
	pi.registerCommand("summary", {
		description: "Generate a session summary now; /summary model picks the summary model",
		getArgumentCompletions: (prefix: string) => {
			const items = [
				{ value: "model", label: "model", description: "Choose the model used to generate session summaries" },
			];
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			if ((args ?? "").trim() === "model") {
				await pickSummaryModel(ctx);
				return;
			}
			clearIdleTimer();
			await generateAndShowSummary(ctx);
		},
	});

	// Deprecated alias for the old flat name, kept during the migration window.
	pi.registerCommand("summary-model", {
		description: "(Deprecated: use /summary model) Choose the model used to generate session summaries",
		handler: async (_args, ctx) => {
			await pickSummaryModel(ctx);
		},
	});

	pi.on("session_shutdown", () => {
		// Emitted before the runner is invalidated, so an in-flight
		// generateAndShowSummary can observe the bump after its model await.
		generation++;
		clearIdleTimer();
	});
}
