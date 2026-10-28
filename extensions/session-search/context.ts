/**
 * session-search/context.ts
 *
 * Windowed context extraction: given a session file's content and an anchor
 * (a search match, or nothing at all for the tail), return a compact
 * transcript excerpt of the surrounding conversation. Used by the
 * `session_excerpt` tool and by the /session-search "Load context into
 * session" action, so both share one selection and one set of caps.
 *
 * Pure function: no fs, no pi. The caller reads the file.
 *
 * Rules (settled design):
 *   - +/- WINDOW_MESSAGES user/assistant messages around the anchor
 *   - user + assistant text and summaries only; tool results excluded
 *   - per-message head cap (PER_MESSAGE_CAP) and total cap (TOTAL_CAP)
 *   - all matched (anchor) entries, plus the window center, are always
 *     included; when over the total cap, other entries are dropped from the
 *     end farthest from the anchor
 *   - no anchor at all (no query, or a query that matched nothing): the last
 *     TAIL_MESSAGES entries, trimmed from the oldest side to fit the cap
 *   - the rendered body never exceeds TOTAL_CAP BYTES (UTF-8), not just
 *     characters: a final byte-level trim guards multi-byte text
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
	/** Total cap of the rendered excerpt. Default 16KB. */
	totalCap?: number;
	/** Per-message character cap (head). Default 2KB. */
	perMessageCap?: number;
}

export const WINDOW_MESSAGES = 5;
/** Entries in a tail excerpt (no query, or a query that matched nothing). */
export const TAIL_MESSAGES = 10;
export const TOTAL_CAP = 16 * 1024;
export const PER_MESSAGE_CAP = 2 * 1024;

/** Marker appended when the rendered body had to be cut at the byte cap. */
export const BYTE_TRIM_MARKER = "\n[...excerpt truncated]";

/** How the window was chosen; mirrors the tool result envelope. */
export type ExcerptAnchor = { ts: string } | { tail: true } | { queryMissed: true };

/** One selected excerpt: the rendered body plus its selection metadata. */
export interface ExcerptSelection {
	body: string;
	/** Entries included in the body (not rendered lines: text can be multiline). */
	messageCount: number;
	/** True when a cap dropped entries or clipped message text. */
	truncated: boolean;
	anchored: ExcerptAnchor;
}

export interface TailOptions {
	totalCap?: number;
	perMessageCap?: number;
	/** Entries to keep from the end. Default TAIL_MESSAGES. */
	tail?: number;
	/** Set when a supplied query matched nothing in this session. */
	missed?: boolean;
}

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

/** A selected entry plus what the shrink loop must never drop. */
interface Slot {
	item: ContextItem;
	/** An anchor entry or the window center: kept even under cap pressure. */
	keep: boolean;
	/** The window center, used to pick the far end to drop from. */
	center: boolean;
}

function fitsBudget(items: ContextItem[], perMessageCap: number, totalCap: number): boolean {
	return items.reduce((n, it) => n + capText(it.text, perMessageCap).length + 16, 0) <= totalCap;
}

/**
 * Select the +/- window around `anchorTs`, widened to cover every anchor, then
 * shrunk to the total cap by dropping the outermost non-protected entries
 * (alternating ends, never an anchor and never the center).
 */
function selectWindowItems(
	items: ContextItem[],
	anchorTs: string,
	anchorTsList: string[],
	window: number,
	totalCap: number,
	perMessageCap: number,
): { slots: Slot[]; dropped: boolean } {
	const anchors = new Set([anchorTs, ...anchorTsList].filter(Boolean));
	let anchorIdx = items.findIndex((it) => it.ts === anchorTs);
	if (anchorIdx === -1) {
		// Fall back to the nearest item to the anchor time.
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

	let slots: Slot[] = [];
	for (let i = lo; i <= hi; i++) {
		slots.push({ item: items[i], keep: anchors.has(items[i].ts) || i === anchorIdx, center: i === anchorIdx });
	}

	let dropped = false;
	while (slots.length > slots.filter((s) => s.keep).length && !fitsBudget(slots.map((s) => s.item), perMessageCap, totalCap)) {
		const centerPos = Math.max(0, slots.findIndex((s) => s.center));
		const distHead = centerPos;
		const distTail = slots.length - 1 - centerPos;
		const dropHead = distHead >= distTail;
		let target = -1;
		if (dropHead) {
			for (let i = 0; i < slots.length; i++) {
				if (!slots[i].keep) {
					target = i;
					break;
				}
			}
		} else {
			for (let i = slots.length - 1; i >= 0; i--) {
				if (!slots[i].keep) {
					target = i;
					break;
				}
			}
		}
		if (target === -1) break; // only protected entries left
		slots = slots.filter((_, i) => i !== target);
		dropped = true;
	}

	return { slots, dropped };
}

/** Cap the rendered body at `cap` BYTES (UTF-8), leaving room for the marker. */
function capBytes(body: string, cap: number): { body: string; trimmed: boolean } {
	if (Buffer.byteLength(body, "utf8") <= cap) return { body, trimmed: false };
	const markerBytes = Buffer.byteLength(BYTE_TRIM_MARKER, "utf8");
	const budget = Math.max(0, cap - markerBytes);
	const lines = body.split("\n");
	const kept: string[] = [];
	let used = 0;
	for (const line of lines) {
		const size = Buffer.byteLength(line, "utf8") + 1; // + newline
		if (used + size > budget) break;
		kept.push(line);
		used += size;
	}
	return { body: kept.length > 0 ? kept.join("\n") + BYTE_TRIM_MARKER : BYTE_TRIM_MARKER.trimStart(), trimmed: true };
}

/** Render selected entries, applying the per-message and byte caps. */
function renderSlots(slots: Slot[], perMessageCap: number, totalCap: number): { body: string; clipped: boolean } {
	const lines: string[] = [];
	let clipped = false;
	for (const slot of slots) {
		const capped = capText(slot.item.text, perMessageCap);
		if (capped !== slot.item.text) clipped = true;
		const time = slot.item.ts.slice(11, 19);
		const label = slot.item.kind === "summary" ? `summary (${slot.item.source ?? "custom"})` : slot.item.kind;
		lines.push(`[${time}] ${label}: ${capped}`);
	}
	const capped = capBytes(lines.join("\n"), totalCap);
	return { body: capped.body, clipped: clipped || capped.trimmed };
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

	const { slots } = selectWindowItems(items, anchorTs, anchorTsList, window, totalCap, perMessageCap);
	return renderSlots(slots, perMessageCap, totalCap).body;
}

/** Select an anchored excerpt with its metadata (the `session_excerpt` tool). */
export function selectAnchoredExcerpt(sessionContent: string, anchorTs: string, anchorTsList: string[] = [], opts: ContextOptions = {}): ExcerptSelection {
	const window = opts.window ?? WINDOW_MESSAGES;
	const totalCap = opts.totalCap ?? TOTAL_CAP;
	const perMessageCap = opts.perMessageCap ?? PER_MESSAGE_CAP;

	const items = collectItems(sessionContent);
	if (items.length === 0) return { body: "", messageCount: 0, truncated: false, anchored: { ts: anchorTs } };

	const { slots, dropped } = selectWindowItems(items, anchorTs, anchorTsList, window, totalCap, perMessageCap);
	const rendered = renderSlots(slots, perMessageCap, totalCap);
	return {
		body: rendered.body,
		messageCount: slots.length,
		truncated: dropped || rendered.clipped,
		anchored: { ts: anchorTs },
	};
}

/**
 * Select the tail excerpt: the last `tail` entries (newest kept), trimmed from
 * the oldest side to fit the caps. Used when no query was supplied and when a
 * query matched nothing in this session.
 */
export function selectTailExcerpt(sessionContent: string, opts: TailOptions = {}): ExcerptSelection {
	const totalCap = opts.totalCap ?? TOTAL_CAP;
	const perMessageCap = opts.perMessageCap ?? PER_MESSAGE_CAP;
	const tail = Math.max(1, opts.tail ?? TAIL_MESSAGES);
	const anchored: ExcerptAnchor = opts.missed ? { queryMissed: true } : { tail: true };

	const items = collectItems(sessionContent);
	if (items.length === 0) return { body: "", messageCount: 0, truncated: false, anchored };

	let slots: Slot[] = items.slice(-tail).map((item) => ({ item, keep: false, center: false }));
	let dropped = false;
	while (slots.length > 1 && !fitsBudget(slots.map((s) => s.item), perMessageCap, totalCap)) {
		slots = slots.slice(1); // drop the oldest end
		dropped = true;
	}

	const rendered = renderSlots(slots, perMessageCap, totalCap);
	return {
		body: rendered.body,
		messageCount: slots.length,
		truncated: dropped || rendered.clipped,
		anchored,
	};
}
