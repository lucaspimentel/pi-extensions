/**
 * session-search/search.ts
 *
 * Query parsing, matching, ranking and snippet extraction over the index.
 * Pure functions: no fs, no pi.
 *
 * Semantics:
 *   - Query "/pattern" (rest is a valid regex) -> regex mode over entry text.
 *   - Otherwise: whitespace-split terms, AND semantics (every term must match
 *     somewhere in the session), case-insensitive substring.
 *   - Ranking tiers: user (300) > assistant (200) > summary (100). Subagent
 *     sessions are halved within their tier. Then hitCount and recency.
 *   - Filters: cwd substring, since/until on lastActivity, in:<origin>,
 *     limit (default 10).
 *   - Snippets: +-60 chars around the first match, up to 2 per hit, each
 *     labeled with its origin.
 */

import type { IndexedSession } from "./store.ts";

export type OriginFilter = "user" | "assistant" | "summary";

export interface SearchFilters {
	cwd?: string;
	since?: string;
	until?: string;
	in?: OriginFilter;
	limit?: number;
}

export interface Snippet {
	origin: "user" | "assistant" | "summary";
	ts: string;
	text: string;
	source?: string;
}

export interface SearchHit {
	path: string;
	sessionId: string;
	cwd: string;
	name?: string;
	started: string;
	lastActivity: string;
	isSubagent: boolean;
	parentSession?: string;
	score: number;
	tier: "user" | "assistant" | "summary";
	snippets: Snippet[];
}

export interface ParsedQuery {
	kind: "terms" | "regex";
	terms?: string[];
	regex?: RegExp;
	original: string;
}

const TIER_WEIGHT: Record<"user" | "assistant" | "summary", number> = {
	user: 300,
	assistant: 200,
	summary: 100,
};

const SNIPPET_RADIUS = 60;
const MAX_SNIPPETS_PER_HIT = 2;
const RESPONSE_CAP = 4 * 1024;

/** Parse a raw query string. Returns null when the regex form is invalid. */
export function parseQuery(raw: string): ParsedQuery | null {
	const q = raw.trim();
	if (!q) return null;
	if (q.startsWith("/")) {
		const pattern = q.slice(1);
		if (!pattern) return null;
		try {
			return { kind: "regex", regex: new RegExp(pattern, "gi"), original: q };
		} catch {
			return null;
		}
	}
	const terms = q
		.split(/\s+/)
		.map((t) => t.toLowerCase())
		.filter(Boolean);
	if (terms.length === 0) return null;
	return { kind: "terms", terms, original: q };
}

interface EntryMatch {
	entryIndex: number;
	origin: "user" | "assistant" | "summary";
	ts: string;
	text: string;
	source?: string;
	hitCount: number;
	/** All terms (or the regex) matched within this single entry. */
	full: boolean;
}

/** Count matches of one term (case-insensitive substring) in text. */
function countTerm(text: string, lower: string): number {
	let count = 0;
	let pos = text.toLowerCase().indexOf(lower);
	while (pos !== -1) {
		count++;
		pos = text.toLowerCase().indexOf(lower, pos + lower.length);
	}
	return count;
}

function matchEntry(text: string, query: ParsedQuery): { count: number; matched: boolean } {
	if (query.kind === "regex") {
		const re = new RegExp(query.regex!.source, query.regex!.flags.includes("g") ? query.regex!.flags : query.regex!.flags + "g");
		const matches = text.match(re);
		return { count: matches ? matches.length : 0, matched: !!matches };
	}
	const lower = text.toLowerCase();
	let count = 0;
	let matched = true;
	for (const term of query.terms!) {
		const c = countTerm(text, term);
		if (c === 0) matched = false;
		count += c;
	}
	return { count, matched };
}

function recencyBoost(lastActivity: string): number {
	if (!lastActivity) return 0;
	const t = Date.parse(lastActivity);
	if (Number.isNaN(t)) return 0;
	const days = (Date.now() - t) / 86_400_000;
	if (days <= 7) return 50;
	if (days <= 30) return 25;
	if (days <= 365) return 10;
	return 0;
}

function clipSnippet(text: string, pos: number): string {
	const start = Math.max(0, pos - SNIPPET_RADIUS);
	const end = Math.min(text.length, pos + SNIPPET_RADIUS);
	const prefix = start > 0 ? "..." : "";
	const suffix = end < text.length ? "..." : "";
	return prefix + text.slice(start, end).replace(/\s+/g, " ").trim() + suffix;
}

function passesFilters(session: IndexedSession, filters: SearchFilters): boolean {
	if (filters.cwd && !session.cwd.includes(filters.cwd)) return false;
	if (filters.since) {
		const since = Date.parse(filters.since);
		const la = Date.parse(session.lastActivity);
		if (!Number.isNaN(since) && !Number.isNaN(la) && la < since) return false;
	}
	if (filters.until) {
		const until = Date.parse(filters.until);
		const la = Date.parse(session.lastActivity);
		if (!Number.isNaN(until) && !Number.isNaN(la) && la > until) return false;
	}
	return true;
}

/** Search the index. Returns hits sorted by score desc, limited to `limit`. */
export function searchSessions(index: Iterable<IndexedSession>, rawQuery: string, filters: SearchFilters = {}): SearchHit[] {
	const query = parseQuery(rawQuery);
	if (!query) return [];
	const limit = Math.max(1, filters.limit ?? 10);
	const hits: SearchHit[] = [];

	for (const session of index) {
		if (!passesFilters(session, filters)) continue;

		const entries = filters.in ? session.entries.filter((e) => e.origin === filters.in) : session.entries;

		let bestTier: SearchHit["tier"] | null = null;
		let totalHits = 0;
		const matchedTerms = new Set<string>();
		const fullMatches: EntryMatch[] = [];
		const partialMatches: EntryMatch[] = [];

		for (let i = 0; i < entries.length; i++) {
			const e = entries[i];
			if (!e.text) continue;
			const m = matchEntry(e.text, query);
			if (m.count === 0) continue;
			totalHits += m.count;
			if (query.kind === "terms") {
				const lower = e.text.toLowerCase();
				for (const term of query.terms!) {
					if (lower.includes(term)) matchedTerms.add(term);
				}
			} else {
				matchedTerms.add("__regex__");
			}
			const rec: EntryMatch = {
				entryIndex: i,
				origin: e.origin,
				ts: e.ts,
				text: e.text,
				source: e.source,
				hitCount: m.count,
				full: m.matched,
			};
			if (m.matched) fullMatches.push(rec);
			else partialMatches.push(rec);
			const w = TIER_WEIGHT[e.origin];
			if (bestTier === null || w > TIER_WEIGHT[bestTier]) bestTier = e.origin;
		}

		// AND semantics: every term must match somewhere in the session
		// (regex mode: the pattern must match somewhere).
		if (bestTier === null) continue;
		if (query.kind === "terms" && matchedTerms.size < query.terms!.length) continue;
		if (query.kind === "regex" && !matchedTerms.has("__regex__")) continue;

		let score = TIER_WEIGHT[bestTier];
		score += Math.min(totalHits, 100);
		score += recencyBoost(session.lastActivity);
		if (session.isSubagent) score = Math.floor(score / 2);

		const ordered = [...fullMatches, ...partialMatches].slice(0, MAX_SNIPPETS_PER_HIT);
		const snippets: Snippet[] = ordered.map((rec) => {
			let pos = 0;
			if (query.kind === "regex") {
				const m = new RegExp(query.regex!.source, query.regex!.flags.replace("g", "")).exec(rec.text);
				pos = m ? m.index : 0;
			} else {
				const lower = rec.text.toLowerCase();
				let earliest = rec.text.length;
				for (const term of query.terms!) {
					const p = lower.indexOf(term);
					if (p !== -1 && p < earliest) earliest = p;
				}
				pos = earliest === rec.text.length ? 0 : earliest;
			}
			return { origin: rec.origin, ts: rec.ts, source: rec.source, text: clipSnippet(rec.text, pos) };
		});

		hits.push({
			path: session.path,
			sessionId: session.sessionId,
			cwd: session.cwd,
			name: session.name,
			started: session.started,
			lastActivity: session.lastActivity,
			isSubagent: session.isSubagent,
			parentSession: session.parentSession,
			score,
			tier: bestTier,
			snippets,
		});
	}

	hits.sort((a, b) => b.score - a.score);
	return hits.slice(0, limit);
}

/** Render hits as compact, model/user-facing text, hard-capped at ~4KB. */
export function formatHits(hits: SearchHit[], query: string): string {
	if (hits.length === 0) return `No sessions matched: ${query}`;
	const lines: string[] = [];
	let size = 0;
	const header = `${hits.length} session(s) matching "${query}" (best first):`;
	lines.push(header);
	size += header.length;

	for (let i = 0; i < hits.length; i++) {
		const h = hits[i];
		const block: string[] = [];
		const title = `${i + 1}. ${h.lastActivity.slice(0, 10)} score=${h.score} tier=${h.tier}${h.isSubagent ? " [subagent]" : ""}`;
		block.push(title);
		if (h.name) block.push(`   name: ${h.name}`);
		block.push(`   cwd: ${h.cwd}`);
		block.push(`   path: ${h.path}`);
		for (const s of h.snippets) {
			block.push(`   ${s.origin}${s.source && s.origin === "summary" ? ` (${s.source})` : ""}: ${s.text}`);
		}
		const text = block.join("\n");
		if (size + text.length > RESPONSE_CAP) {
			lines.push(`[truncated: ${hits.length - i} more hit(s) not shown; narrow the query or lower limit]`);
			break;
		}
		lines.push(text);
		size += text.length;
	}
	return lines.join("\n");
}
