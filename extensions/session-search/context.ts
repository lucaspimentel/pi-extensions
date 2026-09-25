/**
 * session-search/context.ts
 *
 * Windowed context extraction for "Load context into session": given a
 * session file's content and an anchor timestamp (a search hit), return a
 * compact transcript excerpt of the surrounding conversation.
 *
 * Pure function: no fs, no pi. The caller reads the file.
 *
 * Rules (settled design):
 *   - +/- WINDOW_MESSAGES user/assistant messages around the anchor
 *   - user + assistant text and summaries only; tool results excluded
 *   - per-message head cap (PER_MESSAGE_CAP) and total cap (TOTAL_CAP)
 *   - all matched (anchor) entries are always included in full-first order;
 *     when over the total cap, entries farthest from the anchor are dropped
 */

import { isBoilerplate } from "./parse.ts";

export interface ContextItem {
	ts: string;
	kind: "user" | "assistant" | "summary";
	text: string;
	source?: string;
}

export interface ContextOptions {
	/** Messages to include on each side of the anchor. Default 5. */
	window?: number;
	/** Total character cap of the rendered excerpt. Default 16KB. */
	totalCap?: number;
	/** Per-message character cap (head). Default 2KB. */
	perMessageCap?: number;
}

export const WINDOW_MESSAGES = 5;
export const TOTAL_CAP = 16 * 1024;
export const PER_MESSAGE_CAP = 2 * 1024;

function capText(text: string, cap: number): string {
	if (text.length <= cap) return text;
	return text.slice(0, cap) + " [...truncated]";
}

/** Collect user/assistant text and summary items, in file order.
 *  System-injected boilerplate (skill/skill prompts etc.) is excluded so it
 *  does not spend the context budget: same rationale as the index blocklist. */
export function collectItems(sessionContent: string): ContextItem[] {
	const items: ContextItem[] = [];
	for (const line of sessionContent.split("\n")) {
		if (!line) continue;
		let entry: any;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		const ts: string = typeof entry.timestamp === "string" ? entry.timestamp : "";
		if (entry.type === "message") {
			const role = entry.message?.role;
			if (role !== "user" && role !== "assistant") continue;
			const content = entry.message?.content;
			let text = "";
			if (typeof content === "string") text = content;
			else if (Array.isArray(content)) {
				text = content
					.filter((b: any) => b?.type === "text" && typeof b.text === "string")
					.map((b: any) => b.text)
					.join("\n");
			}
			text = text.trim();
			if (!text || isBoilerplate(text)) continue;
			items.push({ ts, kind: role, text });
		} else if (entry.type === "compaction" && typeof entry.summary === "string" && entry.summary.trim()) {
			items.push({ ts, kind: "summary", text: entry.summary.trim(), source: "compaction" });
		} else if (entry.type === "custom_message" && typeof entry.content === "string" && entry.content.trim()) {
			items.push({ ts, kind: "summary", text: entry.content.trim(), source: typeof entry.customType === "string" ? entry.customType : "custom" });
		}
	}
	return items;
}

function timeOf(ts: string): number {
	const t = Date.parse(ts);
	return Number.isNaN(t) ? 0 : t;
}

/**
 * Extract the transcript excerpt around anchorTs. `anchorTsList` (e.g. all
 * snippet timestamps of the hit) marks entries that must be included; the
 * first one anchors the window.
 */
export function extractWindowContext(sessionContent: string, anchorTs: string, anchorTsList: string[] = [], opts: ContextOptions = {}): string {
	const window = opts.window ?? WINDOW_MESSAGES;
	const totalCap = opts.totalCap ?? TOTAL_CAP;
	const perMessageCap = opts.perMessageCap ?? PER_MESSAGE_CAP;

	const items = collectItems(sessionContent);
	if (items.length === 0) return "";

	const anchors = new Set([anchorTs, ...anchorTsList].filter(Boolean));
	let anchorIdx = items.findIndex((it) => it.ts === anchorTs);
	if (anchorIdx === -1) {
		// Fall back to the nearest item to the anchor time, then to the first anchor match.
		const target = timeOf(anchorTs);
		let best = 0;
		let bestDist = Infinity;
		for (let i = 0; i < items.length; i++) {
			const d = Math.abs(timeOf(items[i].ts) - target);
			if (d < bestDist) {
				bestDist = d;
				best = i;
			}
		}
		anchorIdx = best;
	}

	// Symmetric window, then widen to cover every anchor entry.
	let lo = Math.max(0, anchorIdx - window);
	let hi = Math.min(items.length - 1, anchorIdx + window);
	for (let i = 0; i < items.length; i++) {
		if (anchors.has(items[i].ts)) {
			lo = Math.min(lo, i);
			hi = Math.max(hi, i);
		}
	}

	// Total-cap shrink: drop items farthest from the anchor (alternating ends),
	// but never the anchor items themselves.
	let selected: ContextItem[] = items.slice(lo, hi + 1);
	const anchorItems = selected.filter((it) => anchors.has(it.ts));
	const fits = (list: ContextItem[]) => list.reduce((n, it) => n + capText(it.text, perMessageCap).length + 16, 0) <= totalCap;
	while (selected.length > anchorItems.length && !fits(selected)) {
		const anchorPos = selected.findIndex((it) => anchors.has(it.ts));
		const distHead = anchorPos;
		const distTail = selected.length - 1 - anchorPos;
		if (distHead >= distTail) selected = selected.slice(1);
		else selected = selected.slice(0, -1);
	}

	const lines: string[] = [];
	for (const it of selected) {
		const time = it.ts.slice(11, 19);
		const label = it.kind === "summary" ? `summary (${it.source ?? "custom"})` : it.kind;
		lines.push(`[${time}] ${label}: ${capText(it.text, perMessageCap)}`);
	}
	return lines.join("\n");
}
