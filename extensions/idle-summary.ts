/**
 * Idle Summary Extension
 *
 * After the agent has been idle for ~30 seconds, generates a session summary
 * and displays it inline in the chat history (no modal — no dismiss required).
 *
 * Model priority: anthropic/claude-haiku-4-5 → anthropic/claude-sonnet-4-5 → openai/gpt-4.1-mini
 * Falls back gracefully if no model or API key is available.
 */

import { complete, getModel } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text } from "@earendil-works/pi-tui";

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

const IDLE_DELAY_MS = 30_000;
const CUSTOM_TYPE = "idle-summary";

const MODEL_CANDIDATES = [
	{ provider: "anthropic", id: "claude-haiku-4-5" },
	{ provider: "anthropic", id: "claude-sonnet-4-6" },
	{ provider: "openai", id: "gpt-5.4-mini" },
] as const;

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
		"Summarize this coding session so I can resume it later.",
		"Include goals, key decisions, progress, open questions, and next steps.",
		"Keep it concise and structured with headings.",
		"",
		"<conversation>",
		conversationText,
		"</conversation>",
	].join("\n");

// ── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let idleTimer: ReturnType<typeof setTimeout> | null = null;

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

		// Find first model with a working API key
		let selectedModel: ReturnType<typeof getModel> = undefined;
		let selectedAuth: { apiKey: string; headers?: Record<string, string> } | undefined;

		for (const candidate of MODEL_CANDIDATES) {
			const model = getModel(candidate.provider, candidate.id);
			if (!model) continue;

			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (auth?.ok && auth.apiKey) {
				selectedModel = model;
				selectedAuth = { apiKey: auth.apiKey, headers: auth.headers };
				break;
			}
		}

		if (!selectedModel || !selectedAuth) return; // No model available — bail silently

		const messages = [
			{
				role: "user" as const,
				content: [{ type: "text" as const, text: buildSummaryPrompt(conversationText) }],
				timestamp: Date.now(),
			},
		];

		let response;
		try {
			response = await complete(selectedModel, { messages }, selectedAuth);
		} catch {
			return; // Network or API error — bail silently
		}

		const summary = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n")
			.trim();

		if (!summary) return;

		pi.sendMessage({
			customType: CUSTOM_TYPE,
			content: summary,
			display: true,
		});
	}

	// Render summary inline in chat history
	pi.registerMessageRenderer(CUSTOM_TYPE, (message, _options, theme) => {
		const mdTheme = getMarkdownTheme();
		const box = new Box(1, 1, (t: string) => theme.bg("customMessageBg", t));
		box.addChild(new Text(theme.fg("accent", theme.bold("📋 Session Summary")), 0, 0));
		box.addChild(new Markdown(message.content as string, 0, 1, mdTheme));
		return box;
	});

	pi.on("agent_start", () => {
		clearIdleTimer();
	});

	pi.on("agent_end", async (_event, ctx) => {
		clearIdleTimer();
		idleTimer = setTimeout(() => {
			idleTimer = null;
			generateAndShowSummary(ctx).catch(() => {});
		}, IDLE_DELAY_MS);
	});

	pi.on("session_shutdown", () => {
		clearIdleTimer();
	});
}
