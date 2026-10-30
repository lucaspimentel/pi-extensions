/**
 * LLM Session Name Extension (manual)
 *
 * Regenerates a short session title on demand with /name-llm. Nothing is
 * titled automatically: the command is the
 * only trigger, and it replaces whatever name is currently set, including a
 * manual /name, which is the point of asking for it. The title is built from
 * the current title plus the session's context: the branch's original user
 * prompts as theme anchors (taken from branch history so they survive
 * /resume and /fork) and snippets of the last 10 user/assistant messages.
 * Each anchor is clipped to 1000 characters and each recent message to 300
 * characters, independently. All names are set via pi.setSessionName() so they
 * show in the session selector and flow to session_info_changed consumers
 * (e.g. the herdr tab renamer).
 *
 * A rename that lands while the model call is in flight wins: the generated
 * title is discarded. That check reads both the live name (getSessionName) and
 * the last session_info entry in the session file, because the live manager's
 * in-memory entry list is loaded once when the session opens and never
 * refreshed, so a rename written by another SessionManager instance (the
 * session selector's ctrl+r rename, a /name from a second pi process on the
 * same session file) stays invisible to it.
 *
 * Prompts are used as title sources only after skill-invocation serialization
 * is replaced: a <skill name="..." ...>...</skill> block carries the skill's
 * instructions, not the user's words, so it is rewritten to "Invoked /name
 * skill" (skill blocks mixed with user text are stripped, keeping the text;
 * skill-only prompts become the invoked-skill description). The same
 * derivation applies to theme anchors and recent-turn samples.
 *
 * Model: the global pin in `~/.pi/agent/session-name-llm.json`
 * (`"model": "provider/modelId"`, shared helpers in shared/model-pin.ts) when
 * it resolves and has configured auth; otherwise the session's active model.
 * A pin that cannot be used (or a pin file that cannot be read) is named once
 * per session in the run's result message.
 * `/name-llm model` picks the pin, `/name-llm model clear` removes it.
 *
 * A second /name-llm while a run is in flight is refused rather than racing
 * the first one on setSessionName, and a run is aborted via a generation
 * counter when the session is replaced (/new, /resume, /fork): see
 * idle-summary/index.ts for the full rationale.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	clearModelPin,
	createIgnoredPinNotifier,
	type IgnoredPin,
	ignoredPinReasonText,
	readModelPin,
	resolveModel,
	writeModelPin,
} from "./shared/model-pin.ts";
import { modelLabel, pickableModels } from "./shared/model-selection.ts";

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_TITLE_LENGTH = 40;
// Reasoning and the answer share `max_tokens` on openai-completions
// providers, and some reasoning models cannot disable thinking (Baseten GLM
// exposes no "off" effort, so pi sends no reasoning_effort and the provider
// default keeps thinking on). A tight cap therefore returns no text and
// reads as a title-generation failure; sanitizeTitle clips the answer.
const MAX_TOKENS = 2048;
const RECENT_MESSAGE_COUNT = 10;
const RECENT_MESSAGE_SAMPLE_LENGTH = 300;
const INITIAL_PROMPT_COUNT = 2;
const INITIAL_PROMPT_SAMPLE_LENGTH = 1000;
const CONFIG_FILE = "session-name-llm.json";
const USAGE = "Usage: /name-llm (regenerate the title) | /name-llm model (pick the title model) | /name-llm model clear (use the session model)";

/** Global pin file; resolved per call so PI_CODING_AGENT_DIR is honored. */
const configPath = () => join(getAgentDir(), CONFIG_FILE);

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

/** Normalize a raw model response into a usable title, or "" if unusable. */
export const sanitizeTitle = (raw: string): string => {
	let title = collapseWhitespace(raw);
	title = title.replace(/^["'`]+|["'`]+$/g, "").trim();
	if (title.length > MAX_TITLE_LENGTH) {
		title = title.slice(0, MAX_TITLE_LENGTH).trimEnd();
	}
	return title;
};

/**
 * Build the title prompt: current title, the session's original first two
 * user prompts as theme anchors (already normalized and clipped per prompt by
 * the caller), and a sample of recent conversation turns (already normalized
 * and clipped per message by buildRecentTurnsText), asking for a title that
 * reflects the session's overall theme. An unnamed session omits the
 * <current_title> block and is told it has no title yet, rather than being
 * described as keeping an empty one.
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
		"Generate a short title (3-6 words) for the coding session described below.",
		title
			? "The session currently has the noted title; keep it or revise it based on the context below."
			: "The session does not have a title yet.",
		"Title the session's overall theme, not just the latest subtask, but do change the title when the session has genuinely moved to different work.",
		"Reply with only the title text: no quotes, no markdown, no trailing period.",
		"",
	];
	if (title) lines.push(`<current_title>${title}</current_title>`);
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
 * can fail open. Reads the whole file; called to snapshot the name before the
 * title model call and to re-read it after, so a rename that never reached
 * the live session manager is not overwritten.
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

/**
 * Pin diagnostics for one run: a pin that could not be used (and the model
 * used instead), or a pin file that could not be read.
 */
type PinInfo = { ignored?: IgnoredPin; used?: Model<Api>; warning?: string };

/** Result of one title-generation model call. */
type TitleGeneration = ({ ok: true; title: string } | { ok: false; reason: string }) & { pin?: PinInfo };

/**
 * Result of applying a title: "applied" sets a new name, "unchanged" skips
 * the redundant setSessionName, "noop" covers nothing to work from and
 * internal skips (a rename during generation, a stale runner), and "failed"
 * carries a user-facing cause. Every outcome is surfaced by /name-llm.
 */
type TitleOutcome =
	| { status: "applied"; title: string; pin?: PinInfo }
	| { status: "unchanged"; title: string; pin?: PinInfo }
	| { status: "noop"; reason: string }
	| { status: "failed"; reason: string; pin?: PinInfo };

/**
 * Suffix for a run message when the pin could not be used, e.g.
 * ` (pinned model "x/y" ignored: not found; used anthropic/claude-x)`.
 */
export const pinNote = (pin: PinInfo | undefined): string => {
	if (!pin) return "";
	const parts: string[] = [];
	if (pin.warning) parts.push(pin.warning);
	if (pin.ignored) {
		const used = pin.used ? `; used ${modelLabel(pin.used)}` : "";
		parts.push(`pinned model "${pin.ignored.ref}" ignored: ${ignoredPinReasonText(pin.ignored.reason)}${used}`);
	}
	return parts.length > 0 ? ` (${parts.join("; ")})` : "";
};

// Noop reason that means "no input yet" (as opposed to an internal skip like a
// rename during generation); /name-llm phrases it differently.
const NOOP_NO_CONVERSATION = "no conversation to summarize yet";

/** Collapse whitespace and cap a failure reason for a user-facing toast. */
const clampReason = (reason: string): string => {
	const collapsed = collapseWhitespace(reason);
	if (collapsed.length <= 120) return collapsed;
	return `${collapsed.slice(0, 120)}...`;
};

/** The session name as the live manager sees it, plus the file's last entry. */
type NameSnapshot = { live: string; disk: string | undefined };

// ── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// Bumped by session_shutdown before the runner is invalidated. An in-flight
	// title run captures the value at entry and compares it after its model
	// await, so it can bail before touching a stale pi/ctx. A counter (not a
	// boolean) because the extension closure is REUSED across session
	// replacement (/new, /resume, /fork): see idle-summary/index.ts for the
	// full rationale.
	let generation = 0;
	// Sessions with a /name-llm run in flight: a second invocation is refused
	// rather than racing the first one on setSessionName. Cleared on
	// session_start so a replacement session cannot inherit the entry.
	const titleRunsInFlight = new Set<string>();
	// Once-per-session dedupe for the pin diagnostics (an unusable pin, or a
	// pin file that cannot be read); reset on every session_start.
	const pinNotifier = createIgnoredPinNotifier();

	/**
	 * Pin diagnostics for one run, at most once per session: an unusable pin
	 * (or a corrupt pin file) is named in the first result that reports it and
	 * never again until the next session replaces this one, so a permanently
	 * broken pin does not repeat the same sentence on every /name-llm.
	 */
	function pinNoteOnce(pin: PinInfo | undefined): string {
		if (!pin) return "";
		const key = pin.ignored ? pin.ignored.ref : pin.warning;
		// No standalone emit: the note is appended to the run's own message, so
		// only the first sighting per session (per pin/warning) is kept.
		if (!key || !pinNotifier.notifyOnce(key, () => {})) return "";
		return pinNote(pin);
	}

	/** Name from both the live manager and the session file (see header). */
	const snapshotName = (ctx: ExtensionContext): NameSnapshot => ({
		live: pi.getSessionName() ?? "",
		disk: readDiskSessionName(
			(ctx.sessionManager as { getSessionFile?: () => string | undefined }).getSessionFile?.(),
		),
	});

	async function generateTitle(ctx: ExtensionContext, prompt: string): Promise<TitleGeneration> {
		const read = readModelPin(configPath());
		const resolved = resolveModel(read.ref, ctx.model, ctx.modelRegistry);
		const model = resolved.model;
		const pin: PinInfo | undefined =
			read.warning || resolved.ignoredPin
				? { warning: read.warning, ignored: resolved.ignoredPin, used: model }
				: undefined;
		if (!model) return { ok: false, reason: "no model selected", pin };
		if (!resolved.pinned && !ctx.modelRegistry.hasConfiguredAuth(model)) {
			return { ok: false, reason: "model has no configured auth", pin };
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
			return { ok: false, reason: clampReason(err instanceof Error ? err.message : String(err)), pin };
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
			return { ok: false, reason: clampReason(detail), pin };
		}
		return { ok: true, title: sanitizeTitle(text), pin };
	}

	/**
	 * Generate and apply a session title from the current title plus the
	 * session's context. Returns the outcome: "applied" (a new name was set),
	 * "unchanged" (the generated title matches the current one), "noop"
	 * (nothing to work from, or an internal skip: renamed during generation,
	 * stale runner), or "failed" (model or setSessionName failure, with a
	 * user-facing cause).
	 */
	async function applyTitle(ctx: ExtensionContext): Promise<TitleOutcome> {
		// getSessionName() is undefined for an unset name; normalize to "".
		const current = pi.getSessionName() ?? "";
		const branch = ctx.sessionManager.getBranch() as unknown[];
		const recent = buildRecentTurnsText(branch);
		if (!recent.trim()) return { status: "noop", reason: NOOP_NO_CONVERSATION };
		// Theme anchors come from the branch's original user messages, so they
		// survive /resume and /fork; a branch without user messages simply has
		// no anchor section.
		const anchors = extractInitialPrompts(branch);
		const prompt = buildRegenerationPrompt(current, anchors, recent);

		const runGeneration = generation;
		const before = snapshotName(ctx);
		const generated = await generateTitle(ctx, prompt);
		if (generation !== runGeneration) return { status: "noop", reason: "session replaced during generation" };
		// A rename that landed while the model call was in flight wins over the
		// generated title, whether it came through the live manager (a /name in
		// this process) or only through the session file (session selector, a
		// second pi process).
		const after = snapshotName(ctx);
		if (after.live !== before.live || after.disk !== before.disk) {
			return { status: "noop", reason: "session was renamed during generation" };
		}

		const pin = generated.pin;
		if (!generated.ok) return { status: "failed", reason: generated.reason, pin };
		const title = generated.title;

		// No thrash: never fire a redundant session_info_changed (and tab
		// rename) when the generated title matches the current name.
		if (title === current) return { status: "unchanged", title, pin };
		try {
			pi.setSessionName(title);
		} catch {
			// Stale runner race between the generation check and the call.
			return { status: "failed", reason: "could not set the session name", pin };
		}
		return { status: "applied", title, pin };
	}

	/**
	 * `/name-llm model`: pick the title model pin. Mirrors idle-summary's
	 * picker: the resolved model is pre-highlighted, the choice is written to
	 * the global pin file with sibling keys preserved.
	 */
	async function pickTitleModel(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) {
			ctx.ui.notify("/name-llm model needs an interactive UI; run it in the TUI.", "warning");
			return;
		}
		const hasAuth = (m: Model<Api>) => ctx.modelRegistry.hasConfiguredAuth(m);
		const pool = ctx.scopedModels.length > 0 ? ctx.scopedModels.map((s) => s.model) : ctx.modelRegistry.getAvailable();
		const pickable = pickableModels(pool, hasAuth);
		if (pickable.length === 0) {
			ctx.ui.notify("No models with configured auth are available.", "warning");
			return;
		}
		// The effective model first so it is pre-highlighted; an unpinned
		// session model without auth is not offered.
		const resolved = resolveModel(readModelPin(configPath()).ref, ctx.model, ctx.modelRegistry).model;
		const current = resolved && hasAuth(resolved) ? resolved : undefined;
		const ordered = current
			? [current, ...pickable.filter((m) => modelLabel(m) !== modelLabel(current))]
			: pickable;
		const choice = await ctx.ui.select("Title model:", ordered.map(modelLabel), { signal: ctx.signal });
		if (!choice) return; // cancelled
		let warnings: string[];
		try {
			({ warnings } = writeModelPin(configPath(), choice));
		} catch (err) {
			ctx.ui.notify(
				`Could not save the title model: ${err instanceof Error ? err.message : String(err)}`,
				"warning",
			);
			return;
		}
		for (const warning of warnings) ctx.ui.notify(`name-llm: ${warning}`, "warning");
		ctx.ui.notify(`Title model set to ${choice}`, "info");
	}

	/** `/name-llm model clear`: drop the pin, keep every other key. */
	function clearTitleModel(ctx: ExtensionContext): void {
		let cleared: boolean;
		try {
			cleared = clearModelPin(configPath());
		} catch (err) {
			ctx.ui.notify(
				`Could not clear the title model: ${err instanceof Error ? err.message : String(err)}`,
				"warning",
			);
			return;
		}
		ctx.ui.notify(cleared ? "Title model pin cleared; using the session model." : "No title model pin set.", "info");
	}

	pi.registerCommand("name-llm", {
		description:
			"Regenerate the session title now (pinned title model, else the session model); /name-llm model picks the pin, /name-llm model clear removes it",
		getArgumentCompletions: (prefix: string) => {
			const items = [
				{ value: "model", label: "model", description: "Choose the model used to generate session titles" },
				{ value: "model clear", label: "model clear", description: "Remove the title model pin and use the session model" },
			];
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const command = (args ?? "").trim();
			if (/^model(\s|$)/i.test(command)) {
				const sub = command.slice(5).trim().toLowerCase();
				if (!sub) await pickTitleModel(ctx);
				else if (sub === "clear") clearTitleModel(ctx);
				else ctx.ui.notify(USAGE, "warning");
				return;
			}
			const sessionId = ctx.sessionManager.getSessionId() ?? "ephemeral";
			// Mark the run in flight before the first await so a second
			// invocation cannot start a parallel model call.
			if (titleRunsInFlight.has(sessionId)) {
				ctx.ui.notify("A title run is already in progress.", "info");
				return;
			}
			titleRunsInFlight.add(sessionId);
			try {
				const outcome = await applyTitle(ctx);
				// "noop" carries no pin: nothing was generated and nothing is reported.
				const note = pinNoteOnce("pin" in outcome ? outcome.pin : undefined);
				switch (outcome.status) {
					case "applied":
						ctx.ui.notify(`Session title: ${outcome.title}${note}`, "info");
						break;
					case "unchanged":
						ctx.ui.notify(`Title unchanged: ${outcome.title}${note}`, "info");
						break;
					case "noop": {
						// "Nothing to title yet" only fits missing input; internal
						// skips (a rename during generation, a stale runner) get a
						// neutral prefix.
						const waiting = outcome.reason === NOOP_NO_CONVERSATION;
						ctx.ui.notify(
							`${waiting ? "Nothing to title yet" : "No title change"}: ${outcome.reason}.`,
							"info",
						);
						break;
					}
					case "failed":
						ctx.ui.notify(`Could not regenerate the session title: ${outcome.reason}.${note}`, "warning");
						break;
				}
			} catch {
				ctx.ui.notify("Could not regenerate the session title.", "error");
			} finally {
				titleRunsInFlight.delete(sessionId);
			}
		},
	});

	pi.on("session_start", () => {
		titleRunsInFlight.clear();
		pinNotifier.reset();
	});

	pi.on("session_shutdown", () => {
		// Emitted before the runner is invalidated, so an in-flight title run
		// can observe the bump after its model await and bail.
		generation++;
	});
}
