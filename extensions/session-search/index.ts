/**
 * session-search
 *
 * Search past pi sessions by keyword, across all projects.
 *
 * Surfaces:
 *   - Tool `session_search`: ranked session hits (path, date, cwd, name,
 *     snippets with origin labels, score). To dig into a hit, the agent calls
 *     `session_excerpt` (below) rather than reading the session JSONL: the file
 *     opens with metadata and a ~90KB system-prompt message, and its toolResult
 *     lines can reach hundreds of KB, so a raw read is truncated before it
 *     reaches the conversation.
 *   - Tool `session_excerpt`: one session file, one bounded transcript excerpt,
 *     anchored on a query's matches (or on the tail when there is no query, or
 *     the query matched nothing in that session). Returns the flat envelope in
 *     `structuredContent`/`details.result`.
 *   - Command `/session-search <query>`: same search interactively; with a UI,
 *     arrow-select a session to copy its path.
 *   - `/session-search rebuild`: force a full re-parse (normally refresh is
 *     lazy and incremental).
 *
 * Index: ~/.pi/agent/session-search-index.jsonl, one line per session.
 * Refresh on every use: stat all session files (~ms), re-parse only files
 * whose (mtime, size) changed. First-ever search blocks a few seconds for the
 * one-time full parse; later calls are stat-only. Deleted sessions are pruned.
 */

import { spawnSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { parseSession } from "./parse.ts";
import { indexPath, loadIndex, refreshIndex, saveIndex, sessionsDir, type SessionIndex } from "./store.ts";
import { formatHits, formatHit, searchSessions, type SearchFilters, type SearchHit } from "./search.ts";
import { buildExcerpt, excerptText, excerptToolResult } from "./excerpt.ts";
import { excerptOutputSchema, type ExcerptEnvelope } from "./schema.ts";

// --------------------------- index management ---------------------------

let cachedIndex: SessionIndex | undefined;

function ensureIndex(force: boolean = false): SessionIndex {
	if (cachedIndex && !force) return cachedIndex;
	const index = loadIndex();
	const result = refreshIndex(index);
	// Persist only when something actually changed.
	if (result.parsed > 0 || result.pruned > 0 || index.size === 0) saveIndex(result.index);
	cachedIndex = result.index;
	return cachedIndex;
}

function runSearch(rawQuery: string, filters: SearchFilters, excludePaths?: string[]): { text: string; hits: ReturnType<typeof searchSessions> } {
	const effective: SearchFilters = excludePaths && excludePaths.length > 0 ? { ...filters, excludePaths } : filters;
	const index = ensureIndex();
	const hits = searchSessions(index.values(), rawQuery, effective);
	return { text: formatHits(hits, rawQuery), hits };
}

// --------------------------- clipboard (best effort) ---------------------------

function copyToClipboard(text: string): boolean {
	const attempts: Array<{ cmd: string; args: string[] }> =
		process.platform === "darwin"
			? [{ cmd: "pbcopy", args: [] }]
			: process.platform === "win32"
				? [{ cmd: "clip", args: [] }]
				: [
						{ cmd: "wl-copy", args: [] },
						{ cmd: "xclip", args: ["-selection", "clipboard"] },
					];
	for (const { cmd, args } of attempts) {
		try {
			const r = spawnSync(cmd, args, { input: text, timeout: 2000 });
			if (r.status === 0) return true;
		} catch {
			// not installed; try next
		}
	}
	return false;
}

// --------------------------- tool parameters ---------------------------

const excerptParams = Type.Object({
	path: Type.String({
		description: "Absolute path of the session file, taken from a session_search hit.",
	}),
	query: Type.Optional(
		Type.String({
			description:
				"Query locating the window (same syntax as session_search; the one that produced the hit). Omitted, or matching nothing in this session, returns the tail of the session instead.",
		}),
	),
});

const searchParams = Type.Object({
	query: Type.String({ description: "Search terms (AND, case-insensitive). Prefix with / for regex mode, e.g. '/fake-intake \\d+'." }),
	cwd: Type.Optional(Type.String({ description: "Filter: session cwd must contain this substring (e.g. 'serverless-components')." })),
	since: Type.Optional(Type.String({ description: "Only sessions with last activity on/after this date (ISO, e.g. 2026-09-01)." })),
	until: Type.Optional(Type.String({ description: "Only sessions with last activity on/before this date (ISO)." })),
	in: Type.Optional(
		Type.Union([Type.Literal("user"), Type.Literal("assistant"), Type.Literal("summary")], {
			description: "Restrict matching to one origin: user messages, assistant text, or summaries (compaction/custom recaps).",
		}),
	),
	limit: Type.Optional(Type.Number({ description: "Max hits to return (default 10)." })),
});

interface SearchDetails {
	query: string;
	filters: SearchFilters;
	hitCount: number;
	hits: Array<{ path: string; score: number; tier: string; isSubagent: boolean }>;
}

interface ExcerptDetails {
	result: ExcerptEnvelope;
}

export default function sessionSearchExtension(pi: ExtensionAPI): void {
	pi.registerTool<typeof searchParams, SearchDetails>({
		name: "session_search",
		label: "Session Search",
		description:
			"Search the user's past pi coding sessions across all projects by keyword. Returns ranked hits with session path, date, project cwd, name, and labeled snippets (user message / assistant text / summary). Excludes the current session from results. Use it to recall past work: the user often half-remembers a session by keywords from what was said or built, not by project or date. After finding a hit, call session_excerpt with the hit's `path` (and the same query) to read the transcript around the match.",
		promptSnippet: "Search past pi sessions by keyword across all projects",
		// Conservative capability hints: read-only queries over a closed domain
		// (local session files). The search maintains its own on-disk index; the
		// hint describes the tool's operations, not that nothing is ever written.
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		promptGuidelines: [
			"Use session_search when the user references past work ('that time we...', 'the session where...') without naming the project or date. The current session is always excluded from results.",
			"Searches globally across all projects by default; pass cwd to narrow to a project, since/until to bound dates, in to restrict to user/assistant/summary text.",
			"To dig into a hit, call session_excerpt with its `path` (and the query you searched for) instead of reading the session file: session JSONL opens with a ~90KB role:\"system\" message holding the full system prompt and tool schemas, so a raw read is truncated before the conversation.",
			"If you need more than the excerpt caps give (16KB total, 2KB per message), read the JSONL with an offset past its header lines, keep the limit small, and expect toolResult lines in the hundreds of KB.",
		],
		parameters: searchParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const currentSessionPath = ctx.sessionManager.getSessionFile();
			const filters: SearchFilters = {
				cwd: params.cwd,
				since: params.since,
				until: params.until,
				in: params.in,
				limit: params.limit,
			};
			const { text, hits } = runSearch(params.query, filters, currentSessionPath ? [currentSessionPath] : undefined);
			return {
				content: [{ type: "text", text }],
				details: {
					query: params.query,
					filters,
					hitCount: hits.length,
					hits: hits.map((h) => ({ path: h.path, score: h.score, tier: h.tier, isSubagent: h.isSubagent })),
				},
			};
		},
	});

	pi.registerTool<typeof excerptParams, ExcerptDetails>({
		name: "session_excerpt",
		label: "Session Excerpt",
		description:
			"Load a bounded transcript excerpt from one past session file, given a `path` from a session_search hit. With a `query`, the window is centered on that query's matches inside the session; with no query, or a query that matches nothing in it, the excerpt is the tail (last 10 messages). Entries are capped at 2KB each and 16KB total, tool results and injected boilerplate are excluded, and the result reports how the window was chosen, how many messages it holds, and whether a cap truncated it. Prefer this over reading the session JSONL directly: those files open with a ~90KB system-prompt message and contain toolResult lines of hundreds of KB.",
		promptSnippet: "Load a transcript excerpt around a session hit",
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		promptGuidelines: [
			"Call session_excerpt with a session_search hit's `path` (and the query that found it) to recall what was actually said; the path must be a session file inside the sessions directory, and the active session's own file is allowed.",
			"If you need more than the excerpt caps give, read the JSONL with an offset past its header lines, keep the limit small, and expect toolResult lines in the hundreds of KB.",
		],
		parameters: excerptParams,
		outputSchema: excerptOutputSchema,
		async execute(_id, params, signal, _onUpdate, ctx) {
			const envelope = buildExcerpt({
				path: params.path,
				query: params.query,
				activeSessionPath: ctx.sessionManager.getSessionFile() ?? undefined,
				signal,
			});
			return excerptToolResult(envelope);
		},
	});

	pi.registerCommand("session-search", {
		description: "Search past pi sessions (/session-search <query>; /session-search rebuild forces a full re-index)",
		getArgumentCompletions: (prefix: string) => {
			if (!prefix.includes(" ")) {
				const items = [{ value: "rebuild", label: "rebuild", description: "Force a full re-parse of all sessions" }];
				const filtered = items.filter((i) => i.value.startsWith(prefix));
				return filtered.length > 0 ? filtered : null;
			}
			return null;
		},
		handler: async (args, ctx) => {
			const currentSessionPath = ctx.sessionManager.getSessionFile();
			const input = args.trim();
			if (!input || input === "help") {
				ctx.ui.notify("Usage: /session-search <query>\n       /session-search rebuild", "info");
				return;
			}
			if (input === "rebuild") {
				ctx.ui.notify("Rebuilding session index (full re-parse)...", "info");
				ensureIndex(true);
				ctx.ui.notify(`Session index rebuilt: ${cachedIndex?.size ?? 0} sessions.`, "info");
				return;
			}

			const { hits } = runSearch(input, {}, currentSessionPath ? [currentSessionPath] : undefined);
			if (hits.length === 0) {
				ctx.ui.notify(`No sessions matched: ${input}`, "info");
				return;
			}

			if (!ctx.hasUI) {
				// RPC/print modes: show the same rendering the tool returns.
				ctx.ui.notify(formatHits(hits, input), "info");
				return;
			}

			const labels = hits.map((h, i) => {
				const first = h.snippets[0];
				const snippet = first ? ` ${first.origin}: ${first.text.slice(0, 80)}` : "";
				const flag = h.isSubagent ? " [subagent]" : "";
				return `${i + 1}. ${h.lastActivity.slice(0, 10)}${flag} ${h.cwd.split("/").slice(-2).join("/")}${snippet}`;
			});

			// Preview loop: pick -> full card -> copy or go back to the list.
			// Rows are hard-truncated to terminal width, so the deciding signal
			// (second snippet, exact path) is often not visible until previewed.
			for (;;) {
				const choice = await ctx.ui.select("Sessions (enter to preview):", labels, { signal: ctx.signal });
				if (!choice) return; // cancelled
				const hitIndex = labels.indexOf(choice);
				if (hitIndex < 0) return;
				const hit: SearchHit = hits[hitIndex];

				ctx.ui.notify(formatHit(hit), "info");

				const actions = hit.isSubagent
					? ["Load context into session", "Copy path", "Back to list"]
					: ["Resume session", "Load context into session", "Copy path", "Back to list"];
				const action = await ctx.ui.select("Next:", actions, { signal: ctx.signal });
				if (action === "Resume session") {
					try {
						const result = await ctx.switchSession(hit.path);
						if (!result.cancelled) return;
						ctx.ui.notify("Resume was cancelled.", "info");
					} catch (err) {
						ctx.ui.notify(`Could not resume session: ${err instanceof Error ? err.message : String(err)}`, "warning");
					}
					continue; // back to the list
				}
				if (action === "Copy path") {
					if (copyToClipboard(hit.path)) {
						ctx.ui.notify(`Copied: ${hit.path}`, "info");
					} else {
						ctx.ui.notify(`Path (clipboard unavailable): ${hit.path}`, "info");
					}
					return;
				}
				if (action === "Load context into session") {
					// Same selection, caps, and validation as the session_excerpt tool:
					// re-match the command's query inside this one session and anchor there.
					const envelope = buildExcerpt({
						path: hit.path,
						query: input,
						activeSessionPath: currentSessionPath,
						signal: ctx.signal,
					});
					if (!envelope.ok || envelope.messageCount === 0) {
						ctx.ui.notify(
							envelope.ok
								? "No indexable content found around the match in that session."
								: `Could not load context: ${envelope.error?.message ?? envelope.error?.kind}`,
							"warning",
						);
						continue;
					}
					try {
						pi.sendMessage(
							{
								customType: "session-search-context",
								content: excerptText(envelope, { source: "loaded by /session-search" }),
								display: true,
								details: { path: hit.path, anchored: envelope.anchored },
							},
							{ triggerTurn: true },
						);
						ctx.ui.notify(`Loaded context from "${hit.name ?? hit.lastActivity.slice(0, 10)}"; a turn was triggered.`, "info");
					} catch (err) {
						ctx.ui.notify(`Could not inject context: ${err instanceof Error ? err.message : String(err)}`, "warning");
					}
					return;
				}
				if (action !== "Back to list") return; // cancelled
			}
		},
	});
}
