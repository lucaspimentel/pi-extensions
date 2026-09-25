/**
 * session-search/parse.ts
 *
 * Pure parser: session JSONL content -> SessionSummary.
 *
 * No pi imports and no filesystem access, so it is trivially testable.
 * Extraction rules (see README.md):
 *   - user + assistant message text (string content or {type:"text"} blocks)
 *   - compaction.summary and custom_message content, both tagged origin:"summary"
 *   - toolResult / thinking / model_change / usage etc. are ignored
 *   - known system-injected boilerplate is dropped via a prefix blocklist
 *   - identical user text appearing on multiple branches is kept once,
 *     with a `branches` count
 *   - per-entry text is capped at TEXT_CAP bytes (head), to keep the index lean
 */

export interface TextEntry {
	/** Where the text came from. Ranking tiers: user > assistant > summary. */
	origin: "user" | "assistant" | "summary";
	/** Entry timestamp (ISO). */
	ts: string;
	/** Extracted text, head-capped at TEXT_CAP characters. */
	text: string;
	/** For summaries: the source tag ("compaction" or the custom_message type). */
	source?: string;
	/** Number of branch occurrences when identical user text appeared more than once. */
	branches?: number;
}

export interface SessionSummary {
	/** Absolute path of the session JSONL file. */
	path: string;
	sessionId: string;
	cwd: string;
	/** session_info name, when present. */
	name?: string;
	/** parentSession path, when the session was spawned from another one. */
	parentSession?: string;
	started: string;
	lastActivity: string;
	/** True when session_info name matches the subagent pattern (agentType#id). */
	isSubagent: boolean;
	entries: TextEntry[];
}

/** Per-entry text cap (characters, head-only). Keeps the index ~10-20MB instead of 100MB+. */
export const TEXT_CAP = 8 * 1024;

/**
 * Messages starting with any of these prefixes are treated as system-injected
 * boilerplate and excluded from the index. Data-driven on purpose: extend the
 * list rather than special-casing call sites. Missed boilerplate is a ranking
 * nuisance, not a correctness bug, so the list can stay short.
 */
export const BLOCKLIST_PREFIXES: readonly string[] = [
	"<skill",
	"<system",
	"<extension",
	"<pip",
	"<environment",
	"<tool_",
	"<idempotent",
	"<permissions",
];

export function isBoilerplate(text: string): boolean {
	const t = text.trimStart();
	return BLOCKLIST_PREFIXES.some((p) => t.startsWith(p));
}

/** Subagent session_info names look like "general-purpose#4d4119cf". */
const SUBAGENT_NAME_RE = /^[a-zA-Z][\w-]*#[0-9a-f]{6,}$/i;

export function isSubagentName(name: string | undefined): boolean {
	return name !== undefined && SUBAGENT_NAME_RE.test(name);
}

/** Extract concatenated text from a message content value (string or block array). */
function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (block && typeof block === "object" && (block as any).type === "text" && typeof (block as any).text === "string") {
			parts.push((block as any).text);
		}
	}
	return parts.join("\n");
}

function cap(text: string): string {
	return text.length <= TEXT_CAP ? text : text.slice(0, TEXT_CAP);
}

/**
 * Parse one session JSONL file's content into a SessionSummary.
 * `path` is attached to the result (the parser itself never touches the disk).
 */
export function parseSession(content: string, path: string): SessionSummary {
	const summary: SessionSummary = {
		path,
		sessionId: "",
		cwd: "",
		started: "",
		lastActivity: "",
		isSubagent: false,
		entries: [],
	};

	const seenUserText = new Map<string, TextEntry>();
	let latest = "";

	for (const line of content.split("\n")) {
		if (!line) continue;
		let entry: any;
		try {
			entry = JSON.parse(line);
		} catch {
			continue; // tolerate corrupt lines
		}
		const ts: string = typeof entry.timestamp === "string" ? entry.timestamp : "";
		if (ts > latest) latest = ts;

		switch (entry.type) {
			case "session": {
				summary.sessionId = entry.id ?? "";
				summary.cwd = entry.cwd ?? "";
				summary.started = entry.timestamp ?? "";
				summary.parentSession = entry.parentSession ?? undefined;
				break;
			}
			case "session_info": {
				if (typeof entry.name === "string") {
					summary.name = entry.name;
					summary.isSubagent = isSubagentName(entry.name);
				}
				break;
			}
			case "message": {
				const role = entry.message?.role;
				if (role !== "user" && role !== "assistant") continue;
				const text = contentText(entry.message?.content).trim();
				if (!text || isBoilerplate(text)) continue;
				const ts2: string = typeof entry.timestamp === "string" ? entry.timestamp : ts;
				if (role === "user") {
					// Branch dedup: identical user text (e.g. replayed on a new branch
					// after compaction/steering) is kept once with a branch count.
					const existing = seenUserText.get(text);
					if (existing) {
						existing.branches = (existing.branches ?? 1) + 1;
						continue;
					}
					const e: TextEntry = { origin: "user", ts: ts2, text: cap(text) };
					seenUserText.set(text, e);
					summary.entries.push(e);
				} else {
					summary.entries.push({ origin: "assistant", ts: ts2, text: cap(text) });
				}
				break;
			}
			case "compaction": {
				if (typeof entry.summary === "string" && entry.summary.trim()) {
					summary.entries.push({
						origin: "summary",
						ts: ts,
						text: cap(entry.summary.trim()),
						source: "compaction",
					});
				}
				break;
			}
			case "custom_message": {
				const text = typeof entry.content === "string" ? entry.content.trim() : "";
				if (text) {
					summary.entries.push({
						origin: "summary",
						ts: ts,
						text: cap(text),
						source: typeof entry.customType === "string" ? entry.customType : "custom",
					});
				}
				break;
			}
			default:
				break; // model_change, thinking_level_change, toolResult, usage, ...
		}
	}

	summary.lastActivity = latest || summary.started;
	return summary;
}
