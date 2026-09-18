/**
 * LLM Session Name Extension
 *
 * Generates a short session title from the first user prompt using the
 * session's active model, then sets it via pi.setSessionName() so it shows
 * in the session selector and flows to session_info_changed consumers (e.g.
 * the herdr tab renamer). Falls back to a truncated first prompt when the
 * model call fails (no model, no auth, API error, empty response).
 *
 * A manual /name rename always wins: if a name exists before generation
 * starts, or is set while a title is being generated, the generated title is
 * discarded. Each session is titled at most once.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_TITLE_LENGTH = 60;
const FALLBACK_LENGTH = 50;
const PROMPT_SAMPLE_LENGTH = 2000;
const MAX_TOKENS = 64;

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
	// Session ids for which title generation has already started (or is
	// unnecessary). Cleared on session_start; the generation counter covers the
	// in-flight-across-replacement race.
	const attempted = new Set<string>();

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
							content: [{ type: "text", text: buildTitlePrompt(prompt) }],
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
			if (attempted.has(sessionId)) return;
			// Respect a name set manually (or by a resumed session) before the
			// first turn completed: never generate for an already-named session.
			if (pi.getSessionName()) {
				attempted.add(sessionId);
				return;
			}
			const prompt = firstPromptBySession.get(sessionId);
			if (!prompt) return;

			attempted.add(sessionId);
			const runGeneration = generation;
			const title = await generateTitle(ctx, prompt);
			if (generation !== runGeneration) return;
			if (!title) {
				// Titling failed: fall back to a truncated first prompt so the
				// session still gets a stable, short name.
				pi.setSessionName(truncateFallbackName(prompt));
				return;
			}
			// A /name could have arrived during the model await; it wins.
			if (pi.getSessionName()) return;
			try {
				pi.setSessionName(title);
			} catch {
				// Stale runner race between the generation check and the call.
			}
		} catch {
			// Best-effort: a failed title must never break the agent loop.
		}
	});

	pi.on("session_start", () => {
		firstPromptBySession.clear();
		attempted.clear();
	});

	pi.on("session_shutdown", () => {
		// Emitted before the runner is invalidated, so an in-flight title run
		// can observe the bump after its model await and bail.
		generation++;
	});
}
