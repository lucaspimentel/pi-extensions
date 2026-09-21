/**
 * LLM Session Name Extension
 *
 * Generates a short session title from the first user prompt using the
 * session's active model, then keeps it fresh: the title regenerates from the
 * current title plus recent conversation turns every `turnInterval` turns
 * (default 10). The interval is configurable via
 * <agentDir>/llm-session-name.json: {"turnInterval": N}. All names are set
 * via pi.setSessionName() so they show in the session selector and flow to
 * session_info_changed consumers (e.g. the herdr tab renamer). The very first
 * generation falls back to a truncated first prompt when the model call fails
 * (no model, no auth, API error, empty response); later regenerations keep
 * the existing name on failure.
 *
 * A manual /name rename always wins: the extension remembers the last title
 * it generated per session (lastGeneratedTitle). At a regeneration point, a
 * name that is set but does not match what we last generated is manual or
 * unattributable (restart, /resume, /fork), which locks the session against
 * regeneration. Clearing the name also locks. `/name-auto` forces one
 * regeneration that bypasses the lock; the new title is adopted as
 * extension-owned, so periodic regeneration resumes from it.
 *
 * In-flight runs are aborted via a generation counter when the session is
 * replaced (/new, /resume, /fork): see idle-summary/index.ts for the full
 * rationale.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_TITLE_LENGTH = 60;
const FALLBACK_LENGTH = 50;
const PROMPT_SAMPLE_LENGTH = 2000;
const MAX_TOKENS = 64;
const DEFAULT_TURN_INTERVAL = 10;
const CONFIG_FILE = "llm-session-name.json";
const RECENT_MESSAGE_COUNT = 8;

// ── Pure helpers (exported for tests) ────────────────────────────────────────

/** Collapse all whitespace runs (including newlines) to single spaces. */
export const collapseWhitespace = (text: string): string => text.replace(/\s+/g, " ").trim();

/** Build the fallback name: first prompt truncated to FALLBACK_LENGTH chars. */
export const truncateFallbackName = (prompt: string): string => {
	const text = collapseWhitespace(prompt);
	if (text.length <= FALLBACK_LENGTH) return text;
	return `${text.slice(0, FALLBACK_LENGTH).trimEnd()}...`;
};

/** Normalize a raw model response into a usable title, or "" if unusable. */
export const sanitizeTitle = (raw: string): string => {
	let title = collapseWhitespace(raw);
	title = title.replace(/^["'`]+|["'`]+$/g, "").trim();
	if (title.length > MAX_TITLE_LENGTH) {
		title = title.slice(0, MAX_TITLE_LENGTH).trimEnd();
	}
	return title;
};

export const buildTitlePrompt = (prompt: string): string => {
	const sample = collapseWhitespace(prompt).slice(0, PROMPT_SAMPLE_LENGTH);
	return [
		"Generate a short title (3-6 words) for the coding session started by the request below.",
		"Reply with only the title text: no quotes, no markdown, no trailing period.",
		"",
		"<request>",
		sample,
		"</request>",
	].join("\n");
};

/**
 * Build the regeneration prompt: current title plus a sample of recent
 * conversation turns, asking for an updated title.
 */
export const buildRegenerationPrompt = (currentTitle: string, recentTurns: string): string => {
	const title = collapseWhitespace(currentTitle);
	const turns = collapseWhitespace(recentTurns).slice(0, PROMPT_SAMPLE_LENGTH);
	return [
		"Generate a short updated title (3-6 words) for the coding session described below.",
		"The session currently has the noted title; keep it or revise it based on the recent conversation.",
		"Reply with only the title text: no quotes, no markdown, no trailing period.",
		"",
		`<current_title>${title}</current_title>`,
		"<recent_conversation>",
		turns,
		"</recent_conversation>",
	].join("\n");
};

/**
 * Read the regeneration cadence from <agentDir>/llm-session-name.json
 * ({"turnInterval": N}). Missing, corrupt, or invalid values (non-integers,
 * below 1) fall back to DEFAULT_TURN_INTERVAL.
 */
export const readTurnInterval = (agentDir: string = getAgentDir()): number => {
	try {
		const parsed = JSON.parse(readFileSync(join(agentDir, CONFIG_FILE), "utf8")) as {
			turnInterval?: unknown;
		} | null;
		const value = parsed?.turnInterval;
		if (typeof value === "number" && Number.isInteger(value) && value >= 1) return value;
	} catch {
		// Missing or corrupt config: use the default.
	}
	return DEFAULT_TURN_INTERVAL;
};

// ── Session entry helpers ────────────────────────────────────────────────────

type MessageEntry = {
	type?: string;
	message?: {
		role?: string;
		content?: unknown;
	};
};

const isMessageEntry = (entry: unknown): entry is MessageEntry =>
	!!entry && typeof entry === "object" && (entry as MessageEntry).type === "message";

const extractMessageText = (content: unknown): string => {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const item of content) {
		if (!item || typeof item !== "object") continue;
		const block = item as { type?: unknown; text?: unknown };
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join(" ");
};

/** Flatten the last maxMessages user/assistant entries into "Role: text" lines. */
export const buildRecentTurnsText = (entries: unknown[], maxMessages: number = RECENT_MESSAGE_COUNT): string => {
	const messages = entries.filter(isMessageEntry).slice(-maxMessages);
	const lines: string[] = [];
	for (const entry of messages) {
		const role = entry.message?.role;
		if (role !== "user" && role !== "assistant") continue;
		const text = extractMessageText(entry.message?.content).trim();
		if (!text) continue;
		lines.push(`${role === "user" ? "User" : "Assistant"}: ${text}`);
	}
	return lines.join("\n");
};

// ── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// Bumped by session_shutdown before the runner is invalidated. An in-flight
	// title run captures the value at entry and compares it after its model
	// await, so it can bail before touching a stale pi/ctx. A counter (not a
	// boolean) because the extension closure is REUSED across session
	// replacement (/new, /resume, /fork): see idle-summary/index.ts for the
	// full rationale.
	let generation = 0;
	// First prompt of the current session, keyed by session id. Cleared on
	// session_start so entries cannot accumulate across replacements.
	const firstPromptBySession = new Map<string, string>();
	// Turn counter per session, reset on session_start. Cadence points are the
	// first turn, then every turnInterval turns (1, 1+N, 1+2N, ...).
	const turnCountBySession = new Map<string, number>();
	// The last name this extension set for a session. Absent means we never
	// titled it; present but different from pi.getSessionName() means someone
	// renamed it manually. Cleared on session_start (a name inherited by
	// /resume or /fork is unattributable, so those sessions stay manual).
	const lastGeneratedTitle = new Map<string, string>();
	// Sessions whose name is manual (or unattributable): never regenerate
	// until /name-auto clears the lock. Cleared on session_start.
	const manualLock = new Set<string>();

	async function generateTitle(ctx: ExtensionContext, prompt: string): Promise<string | undefined> {
		const model = ctx.model;
		if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) {
			return undefined;
		}

		let response;
		try {
			response = await ctx.modelRegistry.complete(
				model,
				{
					messages: [
						{
							role: "user",
							content: [{ type: "text", text: prompt }],
							timestamp: Date.now(),
						},
					],
				},
				{ maxTokens: MAX_TOKENS },
			);
		} catch {
			return undefined;
		}

		const text = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join(" ");
		// `complete` can resolve with an error response (empty content plus
		// errorMessage) instead of throwing; an empty title counts as failure.
		if (!text.trim()) return undefined;
		return sanitizeTitle(text);
	}

	/**
	 * Generate and apply a session title. Returns the newly applied name, or
	 * undefined when nothing was applied (locked, no context, model failure,
	 * unchanged title, or a stale runner). force=true bypasses the manual
	 * lock and the provenance checks (/name-auto).
	 */
	async function applyTitle(ctx: ExtensionContext, sessionId: string, force: boolean): Promise<string | undefined> {
		// getSessionName() is undefined for an unset name; normalize to "".
		const current = pi.getSessionName() ?? "";

		if (!force) {
			if (manualLock.has(sessionId)) return undefined;
			const owned = lastGeneratedTitle.get(sessionId);
			if (owned !== undefined) {
				// We authored the name before: a different or cleared name is a
				// manual action. Lock the session and stop regenerating.
				if (current !== owned) {
					manualLock.add(sessionId);
					return undefined;
				}
			} else if (current) {
				// Named but never titled by us: a pre-named session (manual
				// /name, /resume, /fork, restored session). Never generate.
				manualLock.add(sessionId);
				return undefined;
			}
		}

		// A name exists now (or we own one): refresh it from recent context.
		// Otherwise this is the session's first title, built from the first
		// prompt (with a truncated-prompt fallback on failure).
		const owned = lastGeneratedTitle.get(sessionId);
		const isRegen = !!current || owned !== undefined;
		let prompt: string;
		if (isRegen) {
			const branch = ctx.sessionManager.getBranch() as unknown[];
			const recent = buildRecentTurnsText(branch);
			if (!recent.trim()) return undefined;
			prompt = buildRegenerationPrompt(current || owned || "", recent);
		} else {
			const first = firstPromptBySession.get(sessionId);
			if (!first) return undefined;
			prompt = buildTitlePrompt(first);
		}

		const runGeneration = generation;
		const title = await generateTitle(ctx, prompt);
		if (generation !== runGeneration) return undefined;

		if (!title) {
			// First-title failure falls back to a truncated prompt so the
			// session still gets a stable, short name. Regeneration failure
			// keeps the existing name rather than degrading it.
			if (isRegen) return undefined;
			const first = firstPromptBySession.get(sessionId);
			if (!first) return undefined;
			const fallback = truncateFallbackName(first);
			try {
				pi.setSessionName(fallback);
			} catch {
				return undefined;
			}
			lastGeneratedTitle.set(sessionId, fallback);
			return fallback;
		}

		if (!force) {
			// A /name during the model await wins: discard the generated title
			// and lock, unless the name still matches what we own.
			const now = pi.getSessionName() ?? "";
			if (now !== (lastGeneratedTitle.get(sessionId) ?? "")) {
				manualLock.add(sessionId);
				return undefined;
			}
		}

		// No thrash: never fire a redundant session_info_changed (and tab
		// rename) when the generated title matches the current name.
		if (title === current) {
			lastGeneratedTitle.set(sessionId, title);
			return undefined;
		}
		try {
			pi.setSessionName(title);
		} catch {
			// Stale runner race between the generation check and the call.
			return undefined;
		}
		lastGeneratedTitle.set(sessionId, title);
		return title;
	}

	pi.on("before_agent_start", (event, ctx) => {
		if (!event.prompt?.trim()) return;
		const sessionId = ctx.sessionManager.getSessionId() ?? "ephemeral";
		if (!firstPromptBySession.has(sessionId)) {
			firstPromptBySession.set(sessionId, event.prompt);
		}
	});

	pi.on("turn_end", async (_event, ctx) => {
		try {
			const sessionId = ctx.sessionManager.getSessionId() ?? "ephemeral";
			const count = (turnCountBySession.get(sessionId) ?? 0) + 1;
			turnCountBySession.set(sessionId, count);
			if ((count - 1) % readTurnInterval() !== 0) return;
			await applyTitle(ctx, sessionId, false);
		} catch {
			// Best-effort: a failed title must never break the agent loop.
		}
	});

	pi.registerCommand("name-auto", {
		description: "Regenerate the session title now (works even after a manual /name)",
		handler: async (_args, ctx) => {
			try {
				const sessionId = ctx.sessionManager.getSessionId() ?? "ephemeral";
				manualLock.delete(sessionId);
				const title = await applyTitle(ctx, sessionId, true);
				if (title) {
					ctx.ui.notify(`Session title: ${title}`, "info");
				} else {
					ctx.ui.notify("Could not regenerate the session title.", "warning");
				}
			} catch {
				ctx.ui.notify("Could not regenerate the session title.", "error");
			}
		},
	});

	pi.on("session_start", () => {
		firstPromptBySession.clear();
		turnCountBySession.clear();
		lastGeneratedTitle.clear();
		manualLock.clear();
	});

	pi.on("session_shutdown", () => {
		// Emitted before the runner is invalidated, so an in-flight title run
		// can observe the bump after its model await and bail.
		generation++;
	});
}
