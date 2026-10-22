/**
 * LLM Session Name Extension
 *
 * Generates a short session title from the first user prompt using the
 * session's active model, then keeps it fresh: the title regenerates from the
 * current title plus the session's original first two user prompts (theme
 * anchors, taken from branch history so they survive /resume and /fork) and
 * snippets of the last 10 user/assistant messages every `turnInterval` turns
 * (default 10). Each anchor is clipped to 1000 characters and each recent
 * message to 300 characters, independently. The interval is configurable via
 * <agentDir>/llm-session-name.json: {"turnInterval": N}. All names are set
 * via pi.setSessionName() so they show in the session selector and flow to
 * session_info_changed consumers (e.g. the herdr tab renamer). The very first
 * generation falls back to a truncated first prompt when the model call fails
 * (no model, no auth, API error, empty response); later regenerations keep
 * the existing name on failure.
 *
 * Title generation is fire-and-forget: turn_end is an actionable boundary
 * (pi awaits extension handlers before the next provider request), so the
 * title model call is never awaited there and never delays the agent loop.
 * A per-session in-flight guard skips cadence points that land while a run
 * is still pending; the generation counter discards runs that outlive their
 * session.
 *
 * Prompts are used as title sources only after skill-invocation serialization
 * is replaced: a <skill name="..." ...>...</skill> block carries the skill's
 * instructions, not the user's words, so it is rewritten to "Invoked /name
 * skill" (skill blocks mixed with user text are stripped, keeping the text;
 * skill-only prompts become the invoked-skill description). The same
 * derivation applies to theme anchors and recent-turn samples.
 *
 * A manual /name rename always wins: the extension remembers the last title
 * it generated per session (lastGeneratedTitle). At a regeneration point, a
 * name that is set but does not match what we last generated is manual or
 * unattributable (restart, /resume, /fork), which locks the session against
 * regeneration. Clearing the name also locks. `/name-auto` forces one
 * regeneration that bypasses the lock; the new title is adopted as
 * extension-owned, so periodic regeneration resumes from it. The command
 * reports the outcome: applied, unchanged, nothing to title from, or a
 * failure with its cause.
 *
 * Renames that bypass the live session manager are also honored. The live
 * getSessionName() reads an in-memory entry list that is loaded once when
 * the session opens and never refreshed, so a rename written by another
 * SessionManager instance (the session selector's ctrl+r rename, /name from
 * a second pi process on the same session file) stays invisible until the
 * session is resumed. To catch those, each cadence point also reads the
 * last session_info entry from the session file on disk: the live manager
 * persists every append synchronously, so disk and live only diverge when
 * someone else renamed the session. A divergence locks the session, and is
 * also checked after every model await so a rename that lands mid-flight is
 * never overwritten (including by the first-title fallback).
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

const MAX_TITLE_LENGTH = 40;
const FALLBACK_LENGTH = 36;
const PROMPT_SAMPLE_LENGTH = 2000;
// Reasoning and the answer share `max_tokens` on openai-completions
// providers, and some reasoning models cannot disable thinking (Baseten GLM
// exposes no "off" effort, so pi sends no reasoning_effort and the provider
// default keeps thinking on). A tight cap therefore returns no text and
// reads as a title-generation failure; sanitizeTitle clips the answer.
const MAX_TOKENS = 2048;
const DEFAULT_TURN_INTERVAL = 10;
const CONFIG_FILE = "llm-session-name.json";
const RECENT_MESSAGE_COUNT = 10;
const RECENT_MESSAGE_SAMPLE_LENGTH = 300;
const INITIAL_PROMPT_COUNT = 2;
const INITIAL_PROMPT_SAMPLE_LENGTH = 1000;

// ── Pure helpers (exported for tests) ────────────────────────────────────────

/** Collapse all whitespace runs (including newlines) to single spaces. */
export const collapseWhitespace = (text: string): string => text.replace(/\s+/g, " ").trim();

const SKILL_BLOCK_RE = /<skill\b[^>]*>[\s\S]*?<\/skill>/g;
const SKILL_OPEN_RE = /<skill\b[^>]*\bname="([^"]*)"[^>]*>/g;
const UNCLOSED_SKILL_RE = /<skill\b[\s\S]*$/;

/**
 * Rewrite a raw prompt into a title source. Skill-invocation serialization
 * (<skill name="..." location="...">...instructions...</skill>) describes the
 * skill, not the user's request, so each block is removed; the skill's name
 * is preserved so a skill-only prompt still titles as an invocation.
 * Returns the collapsed remainder, or "" when nothing user-authored remains
 * and no skill was named.
 */
export const deriveTitleSource = (prompt: string): string => {
	const names: string[] = [];
	for (const match of prompt.matchAll(SKILL_OPEN_RE)) {
		if (match[1]) names.push(match[1]);
	}
	const stripped = prompt.replace(SKILL_BLOCK_RE, " ").replace(UNCLOSED_SKILL_RE, "");
	const text = collapseWhitespace(stripped);
	if (text) return text;
	if (names.length === 0) return "";
	const list = names.map((name) => `/${name}`).join(", ");
	return `Invoked ${list} skill${names.length > 1 ? "s" : ""}`;
};

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
 * Build the regeneration prompt: current title, the session's original first
 * two user prompts as theme anchors, and a sample of recent conversation
 * turns (already normalized and clipped per message by buildRecentTurnsText),
 * asking for an updated title that reflects the overall theme.
 */
export const buildRegenerationPrompt = (
	currentTitle: string,
	initialPrompts: string[],
	recentTurns: string,
): string => {
	const title = collapseWhitespace(currentTitle);
	const anchors = initialPrompts
		.map((prompt) => collapseWhitespace(prompt).slice(0, INITIAL_PROMPT_SAMPLE_LENGTH))
		.filter((prompt) => prompt.length > 0);
	const lines = [
		"Generate a short updated title (3-6 words) for the coding session described below.",
		"The session currently has the noted title; keep it or revise it based on the context below.",
		"Title the session's overall theme, not just the latest subtask, but do change the title when the session has genuinely moved to different work.",
		"Reply with only the title text: no quotes, no markdown, no trailing period.",
		"",
		`<current_title>${title}</current_title>`,
	];
	if (anchors.length > 0) {
		lines.push("<original_requests>", ...anchors, "</original_requests>");
	}
	lines.push("<recent_conversation>", recentTurns.trim(), "</recent_conversation>");
	return lines.join("\n");
};

/**
 * Read the session name from the session file on disk: the last session_info
 * entry, normalized the way SessionManager normalizes names (newline runs
 * collapsed to spaces, trimmed; empty means no name). Returns undefined when
 * the file is missing, unreadable, or has no session_info entry, so callers
 * can fail open. Reads the whole file; called only at cadence points (once
 * per turnInterval turns) and after title model awaits.
 */
export const readDiskSessionName = (sessionFile: string | undefined | null): string | undefined => {
	if (!sessionFile) return undefined;
	let contents: string;
	try {
		contents = readFileSync(sessionFile, "utf8");
	} catch {
		return undefined;
	}
	const lines = contents.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i].trim();
		if (!line) continue;
		let entry: { type?: unknown; name?: unknown };
		try {
			entry = JSON.parse(line) as { type?: unknown; name?: unknown };
		} catch {
			continue;
		}
		if (entry.type !== "session_info" || typeof entry.name !== "string") continue;
		const name = entry.name.replace(/[\r\n]+/g, " ").trim();
		return name || undefined;
	}
	return undefined;
};

/**
 * True when the session file on disk carries a name that differs from the
 * live session manager's view: an external rename (session selector, another
 * pi process) that getSessionName() cannot see. A missing or unreadable
 * session file fails open (no external rename detected).
 */
const externallyRenamed = (ctx: ExtensionContext, liveName: string): boolean => {
	const sessionFile = (ctx.sessionManager as { getSessionFile?: () => string | undefined }).getSessionFile?.();
	const disk = readDiskSessionName(sessionFile);
	return disk !== undefined && disk !== liveName;
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

/**
 * Extract up to maxPrompts original, nonempty user-message texts from branch
 * entries, in chronological order. Entries are filtered to real user text
 * first, so empty or tool-only user messages do not consume a slot. Used as
 * the theme anchor for regeneration; it sees the full branch, including
 * history from before /resume or /fork.
 */
export const extractInitialPrompts = (entries: unknown[], maxPrompts: number = INITIAL_PROMPT_COUNT): string[] => {
	const prompts: string[] = [];
	for (const entry of entries) {
		if (!isMessageEntry(entry)) continue;
		if (entry.message?.role !== "user") continue;
		const text = deriveTitleSource(extractMessageText(entry.message?.content));
		if (!text) continue;
		prompts.push(text);
		if (prompts.length >= maxPrompts) break;
	}
	return prompts;
};

/**
 * Flatten the last maxMessages eligible user/assistant messages into
 * "Role: text" lines. Entries are filtered to nonempty user/assistant text
 * BEFORE the window is selected, so ignored or empty entries do not consume a
 * slot. Each message is normalized and clipped to
 * RECENT_MESSAGE_SAMPLE_LENGTH characters independently; the joined result is
 * never sliced, so the full window always survives.
 */
export const buildRecentTurnsText = (entries: unknown[], maxMessages: number = RECENT_MESSAGE_COUNT): string => {
	const eligible: { role: string; text: string }[] = [];
	for (const entry of entries) {
		if (!isMessageEntry(entry)) continue;
		const role = entry.message?.role;
		if (role !== "user" && role !== "assistant") continue;
		const text =
			role === "user"
				? deriveTitleSource(extractMessageText(entry.message?.content))
				: extractMessageText(entry.message?.content).trim();
		if (!text) continue;
		eligible.push({ role, text });
	}
	return eligible
		.slice(-maxMessages)
		.map(({ role, text }) => {
			const clipped = collapseWhitespace(text).slice(0, RECENT_MESSAGE_SAMPLE_LENGTH);
			return `${role === "user" ? "User" : "Assistant"}: ${clipped}`;
		})
		.join("\n");
};

// ── Title outcomes ───────────────────────────────────────────────────────────

/** Result of one title-generation model call. */
type TitleGeneration = { ok: true; title: string } | { ok: false; reason: string };

/**
 * Result of applying a title: "applied" and "unchanged" both adopt extension
 * ownership ("unchanged" skips the redundant setSessionName); "noop" covers
 * nothing to work from and internal skips (locked, renamed, stale runner);
 * "failed" carries a user-facing cause. Only user-invoked callers
 * (/name-auto) surface the outcome; the turn_end cadence ignores it.
 */
type TitleOutcome =
	| { status: "applied"; title: string }
	| { status: "unchanged"; title: string }
	| { status: "noop"; reason: string }
	| { status: "failed"; reason: string };

// Noop reasons that mean "no input yet" (as opposed to an internal skip like
// a lock or a rename); /name-auto phrases these differently.
const NOOP_NO_CONVERSATION = "no conversation to summarize yet";
const NOOP_NO_PROMPT = "no prompt to title from yet";

/** Collapse whitespace and cap a failure reason for a user-facing toast. */
const clampReason = (reason: string): string => {
	const collapsed = collapseWhitespace(reason);
	if (collapsed.length <= 120) return collapsed;
	return `${collapsed.slice(0, 120)}...`;
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
	// Sessions with a title run currently in flight. Title runs are
	// fire-and-forget (turn_end is an actionable boundary; awaiting the model
	// call would delay the next provider request), so two cadence points could
	// overlap on very fast turns; skip the later one (the next cadence point
	// picks it up) rather than racing two runs on setSessionName. Cleared on
	// session_start. Staleness across session replacement is already handled
	// by the generation counter inside applyTitle.
	const titleRunsInFlight = new Set<string>();

	async function generateTitle(ctx: ExtensionContext, prompt: string): Promise<TitleGeneration> {
		const model = ctx.model;
		if (!model) return { ok: false, reason: "no model selected" };
		if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
			return { ok: false, reason: "model has no configured auth" };
		}

		let response;
		try {
			// Do not pass `reasoning` here: omitting it disables thinking on
			// Anthropic's streamSimple, while passing "off" would enable
			// high-effort thinking there (its mapThinkingLevelToEffort default).
			response = await ctx.modelRegistry.streamSimple(
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
			).result();
		} catch (err) {
			return { ok: false, reason: clampReason(err instanceof Error ? err.message : String(err)) };
		}

		const text = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join(" ");
		// `complete` can resolve with an error response (empty content plus
		// errorMessage) instead of throwing; an empty title counts as failure.
		if (!text.trim()) {
			const detail = response.errorMessage
				? `empty response: ${response.errorMessage}`
				: response.stopReason
					? `empty response: stop reason ${response.stopReason}`
					: "empty response";
			return { ok: false, reason: clampReason(detail) };
		}
		return { ok: true, title: sanitizeTitle(text) };
	}

	/**
	 * Generate and apply a session title. Returns the outcome: "applied" (a
	 * new name or the first-title fallback was set), "unchanged" (the
	 * regenerated title matches the current one; ownership is still adopted),
	 * "noop" (nothing to work from, or an internal skip: locked, renamed,
	 * stale runner), or "failed" (model or setSessionName failure, with a
	 * user-facing cause). force=true bypasses the manual lock and the
	 * provenance checks (/name-auto).
	 */
	async function applyTitle(ctx: ExtensionContext, sessionId: string, force: boolean): Promise<TitleOutcome> {
		// getSessionName() is undefined for an unset name; normalize to "".
		const current = pi.getSessionName() ?? "";

		if (!force) {
			if (manualLock.has(sessionId)) return { status: "noop", reason: "session name is manual" };
			// An external rename (session selector, another pi process on the
			// same session file) never reaches getSessionName(); detect it by
			// divergence from the file on disk and lock, same as a manual /name.
			if (externallyRenamed(ctx, current)) {
				manualLock.add(sessionId);
				return { status: "noop", reason: "session was renamed externally" };
			}
			const owned = lastGeneratedTitle.get(sessionId);
			if (owned !== undefined) {
				// We authored the name before: a different or cleared name is a
				// manual action. Lock the session and stop regenerating.
				if (current !== owned) {
					manualLock.add(sessionId);
					return { status: "noop", reason: "session name is manual" };
				}
			} else if (current) {
				// Named but never titled by us: a pre-named session (manual
				// /name, /resume, /fork, restored session). Never generate.
				manualLock.add(sessionId);
				return { status: "noop", reason: "session name is manual" };
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
			if (!recent.trim()) return { status: "noop", reason: NOOP_NO_CONVERSATION };
			// Theme anchors come from the branch's original user messages, so
			// they survive /resume and /fork. The first prompt captured via
			// before_agent_start is only a fallback for branches without user
			// messages; regeneration does not require two anchors.
			const anchors = extractInitialPrompts(branch);
			if (anchors.length === 0) {
				const first = firstPromptBySession.get(sessionId);
				if (first) anchors.push(first);
			}
			prompt = buildRegenerationPrompt(current || owned || "", anchors, recent);
		} else {
			const first = firstPromptBySession.get(sessionId);
			if (!first) return { status: "noop", reason: NOOP_NO_PROMPT };
			prompt = buildTitlePrompt(first);
		}

		const runGeneration = generation;
		const generated = await generateTitle(ctx, prompt);
		if (generation !== runGeneration) return { status: "noop", reason: "session replaced during generation" };

		if (!force) {
			// A /name during the model await wins: discard the generated title
			// and lock, unless the name still matches what we own. The disk
			// comparison also catches external renames that landed on the
			// session file while the await was in flight. Running this check
			// before the fallback below keeps a manual rename from being
			// clobbered by a first-title fallback too.
			const now = pi.getSessionName() ?? "";
			if (now !== (lastGeneratedTitle.get(sessionId) ?? "") || externallyRenamed(ctx, now)) {
				manualLock.add(sessionId);
				return { status: "noop", reason: "session was renamed during generation" };
			}
		}

		if (!generated.ok) {
			// First-title failure falls back to a truncated prompt so the
			// session still gets a stable, short name. Regeneration failure
			// keeps the existing name rather than degrading it, and reports
			// the cause to user-invoked callers.
			if (isRegen) return { status: "failed", reason: generated.reason };
			const first = firstPromptBySession.get(sessionId);
			if (!first) return { status: "noop", reason: NOOP_NO_PROMPT };
			const fallback = truncateFallbackName(first);
			try {
				pi.setSessionName(fallback);
			} catch {
				return { status: "failed", reason: "could not set the session name" };
			}
			lastGeneratedTitle.set(sessionId, fallback);
			return { status: "applied", title: fallback };
		}
		const title = generated.title;

		// No thrash: never fire a redundant session_info_changed (and tab
		// rename) when the generated title matches the current name. This is
		// still a success for the caller (reported as "unchanged"), and the
		// ownership bookkeeping below still runs so cadence regeneration
		// resumes from this title.
		if (title === current) {
			lastGeneratedTitle.set(sessionId, title);
			return { status: "unchanged", title };
		}
		try {
			pi.setSessionName(title);
		} catch {
			// Stale runner race between the generation check and the call.
			return { status: "failed", reason: "could not set the session name" };
		}
		lastGeneratedTitle.set(sessionId, title);
		return { status: "applied", title };
	}

	pi.on("before_agent_start", (event, ctx) => {
		// Store the derived title source, not the raw prompt: a skill
		// invocation would otherwise become the title (or fallback) verbatim.
		// Custom-message runs (pi.sendMessage while idle) carry `message`, not `prompt`.
		const source = deriveTitleSource(event.messageType === "user" ? event.prompt : "");
		if (!source) return;
		const sessionId = ctx.sessionManager.getSessionId() ?? "ephemeral";
		if (!firstPromptBySession.has(sessionId)) {
			firstPromptBySession.set(sessionId, source);
		}
	});

	pi.on("turn_end", (_event, ctx) => {
		// Turn counting and the cadence check are synchronous: turn_end is an
		// actionable boundary (pi awaits handlers before the next provider
		// request), so the title model call must never be awaited here. The run
		// is fire-and-forget; the generation guard discards runs that outlive
		// the session, and titleRunsInFlight skips overlapping cadence points.
		try {
			const sessionId = ctx.sessionManager.getSessionId() ?? "ephemeral";
			const count = (turnCountBySession.get(sessionId) ?? 0) + 1;
			turnCountBySession.set(sessionId, count);
			if ((count - 1) % readTurnInterval() !== 0) return;
			if (titleRunsInFlight.has(sessionId)) return;
			titleRunsInFlight.add(sessionId);
			void applyTitle(ctx, sessionId, false)
				.catch(() => {
					// Best-effort: a failed title must never break the agent loop.
				})
				.finally(() => titleRunsInFlight.delete(sessionId));
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
				const outcome = await applyTitle(ctx, sessionId, true);
				switch (outcome.status) {
					case "applied":
						ctx.ui.notify(`Session title: ${outcome.title}`, "info");
						break;
					case "unchanged":
						ctx.ui.notify(`Title unchanged: ${outcome.title}`, "info");
						break;
					case "noop": {
						// "Nothing to title yet" only fits missing input; locks,
						// renames, and stale runners get a neutral prefix.
						const waiting =
							outcome.reason === NOOP_NO_CONVERSATION || outcome.reason === NOOP_NO_PROMPT;
						ctx.ui.notify(
							`${waiting ? "Nothing to title yet" : "No title change"}: ${outcome.reason}.`,
							"info",
						);
						break;
					}
					case "failed":
						ctx.ui.notify(`Could not regenerate the session title: ${outcome.reason}.`, "warning");
						break;
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
		titleRunsInFlight.clear();
	});

	pi.on("session_shutdown", () => {
		// Emitted before the runner is invalidated, so an in-flight title run
		// can observe the bump after its model await and bail.
		generation++;
	});
}
