/**
 * session-search
 *
 * Search past pi sessions by keyword, across all projects.
 *
 * Surfaces:
 *   - Tool `session_search`: ranked session hits (path, date, cwd, name,
 *     snippets with origin labels, score). The agent can then read a hit's
 *     session file directly for the deep dive.
 *   - Command `/find-sessions <query>`: same search interactively; with a UI,
 *     arrow-select a session to copy its path.
 *   - `/find-sessions rebuild`: force a full re-parse (normally refresh is
 *     lazy and incremental).
 *
 * Index: ~/.pi/agent/session-search-index.jsonl, one line per session.
 * Refresh on every use: stat all session files (~ms), re-parse only files
 * whose (mtime, size) changed. First-ever search blocks a few seconds for the
 * one-time full parse; later calls are stat-only. Deleted sessions are pruned.
 */

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { parseSession } from "./parse.ts";
import { indexPath, loadIndex, refreshIndex, saveIndex, sessionsDir, type SessionIndex } from "./store.ts";
import { formatHits, formatHit, searchSessions, type SearchFilters, type SearchHit } from "./search.ts";
import { extractWindowContext } from "./context.ts";

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

function runSearch(rawQuery: string, filters: SearchFilters): { text: string; hits: ReturnType<typeof searchSessions> } {
	const index = ensureIndex();
	const hits = searchSessions(index.values(), rawQuery, filters);
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

export default function sessionSearchExtension(pi: ExtensionAPI): void {
	pi.registerTool<typeof searchParams, SearchDetails>({
		name: "session_search",
		label: "Session Search",
		description:
			"Search the user's past pi coding sessions across all projects by keyword. Returns ranked hits with session path, date, project cwd, name, and labeled snippets (user message / assistant text / summary). Use it to recall past work: the user often half-remembers a session by keywords from what was said or built, not by project or date. After finding a hit, read the session file at `path` directly for the full transcript.",
		promptSnippet: "Search past pi sessions by keyword across all projects",
		promptGuidelines: [
			"Use session_search when the user references past work ('that time we...', 'the session where...') without naming the project or date.",
			"Searches globally across all projects by default; pass cwd to narrow to a project, since/until to bound dates, in to restrict to user/assistant/summary text.",
			"To dig into a hit, read the session file at its `path`; it is JSONL (one JSON object per line).",
		],
		parameters: searchParams,
		async execute(_id, params, _signal) {
			const filters: SearchFilters = {
				cwd: params.cwd,
				since: params.since,
				until: params.until,
				in: params.in,
				limit: params.limit,
			};
			const { text, hits } = runSearch(params.query, filters);
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

	pi.registerCommand("find-sessions", {
		description: "Search past pi sessions (/find-sessions <query>; /find-sessions rebuild forces a full re-index)",
		getArgumentCompletions: (prefix: string) => {
			if (!prefix.includes(" ")) {
				const items = [{ value: "rebuild", label: "rebuild", description: "Force a full re-parse of all sessions" }];
				const filtered = items.filter((i) => i.value.startsWith(prefix));
				return filtered.length > 0 ? filtered : null;
			}
			return null;
		},
		handler: async (args, ctx) => {
			const input = args.trim();
			if (!input || input === "help") {
				ctx.ui.notify("Usage: /find-sessions <query>\n       /find-sessions rebuild", "info");
				return;
			}
			if (input === "rebuild") {
				ctx.ui.notify("Rebuilding session index (full re-parse)...", "info");
				ensureIndex(true);
				ctx.ui.notify(`Session index rebuilt: ${cachedIndex?.size ?? 0} sessions.`, "info");
				return;
			}

			const { hits } = runSearch(input, {});
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

				const action = await ctx.ui.select(
					"Next:",
					["Copy path", "Load context into session", "Back to list"],
					{ signal: ctx.signal },
				);
				if (action === "Copy path") {
					if (copyToClipboard(hit.path)) {
						ctx.ui.notify(`Copied: ${hit.path}`, "info");
					} else {
						ctx.ui.notify(`Path (clipboard unavailable): ${hit.path}`, "info");
					}
					return;
				}
				if (action === "Load context into session") {
					let content: string;
					try {
						content = readFileSync(hit.path, "utf8");
					} catch (err) {
						ctx.ui.notify(`Could not read session file: ${err instanceof Error ? err.message : String(err)}`, "warning");
						continue;
					}
					const anchorTs = hit.snippets[0]?.ts ?? hit.started;
					const excerpt = extractWindowContext(content, anchorTs, hit.snippets.map((s) => s.ts));
					if (!excerpt) {
						ctx.ui.notify("No indexable content found around the match in that session.", "warning");
						continue;
					}
					const header = `Context from session "${hit.name ?? hit.sessionId}" (${hit.cwd}, ${hit.lastActivity.slice(0, 10)}), loaded by /find-sessions. Transcript excerpt around the matched entry:`;
					try {
						pi.sendMessage(
							{
								customType: "session-search-context",
								content: `${header}\n\n${excerpt}`,
								display: true,
								details: { path: hit.path, anchorTs },
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
