import * as path from "node:path";
import { DEFAULT_MASK_PATTERNS, DEFAULT_MASK_EXCEPTIONS, isMaskedName } from "./sandbox/spec.ts";

export interface SearchResultEvent<Content extends { type: string; text?: string } = { type: string; text?: string; [key: string]: unknown }> {
	toolName: string;
	input: Record<string, unknown>;
	content: Content[];
	details?: unknown;
	structuredContent?: unknown;
	isError?: boolean;
}

export interface SearchFilterPolicy {
	profile: string;
	cwd: string;
	config: { maskPatterns: readonly string[]; maskExceptions: readonly string[] };
}

export interface SearchResultOverride {
	content: Array<{ type: "text"; text: string }>;
	details: { guard: { suppressed: boolean; omittedMatches?: number } };
	isError: boolean;
	structuredContent?: { matches: SafeSearchMatch[] };
}

export type SafeSearchContext = { line: number; text: string };
export type SafeSearchMatch = {
	path: string;
	line: number;
	text: string;
	context?: SafeSearchContext[];
	before?: SafeSearchContext[];
	after?: SafeSearchContext[];
};

export const SEARCH_FILTER_SUPPRESSED_NOTICE = "Search result suppressed by guard: unable to safely filter masked files.";

function suppressed(): SearchResultOverride {
	return {
		content: [{ type: "text", text: SEARCH_FILTER_SUPPRESSED_NOTICE }],
		details: { guard: { suppressed: true } },
		isError: true,
	};
}

function invalid(): never {
	throw new Error("Unsupported search result");
}

function validPath(value: unknown): value is string {
	if (typeof value !== "string" || !value || value !== value.trim()) return false;
	const normalized = value.replace(/\\/g, "/");
	if (/[\x00-\x1f\x7f:*?\[\]{}|]/.test(normalized.replace(/^[A-Za-z]:\//, ""))) return false;
	return !normalized.endsWith("/") && ![".", ".."].includes(path.posix.basename(normalized));
}

function validRoot(value: unknown): value is string {
	return typeof value === "string" && !!value && value === value.trim()
		&& !/[\x00-\x1f\x7f:*?\[\]{}|]/.test(value.replace(/\\/g, "/").replace(/^[A-Za-z]:\//, ""));
}

function maskPredicate(event: Pick<SearchResultEvent, "toolName" | "input">, policy: SearchFilterPolicy): (file: string) => boolean {
	if (!validRoot(policy.cwd)) invalid();
	if (!Array.isArray(policy.config.maskPatterns) || !Array.isArray(policy.config.maskExceptions)) invalid();
	const patterns = [...DEFAULT_MASK_PATTERNS, ...policy.config.maskPatterns];
	const exceptions = [...DEFAULT_MASK_EXCEPTIONS, ...policy.config.maskExceptions];
	if (![...patterns, ...exceptions].every((value) => typeof value === "string")) invalid();
	const query = object(event.input).path;
	if (query !== undefined && typeof query !== "string") invalid();
	const cwd = policy.cwd.replace(/\\/g, "/");
	// ffgrep's path is a constraint and can contain globs, not necessarily a root.
	const root = typeof query === "string" && query && validRoot(query) ? query.replace(/\\/g, "/") : cwd;
	if (event.toolName === "grep" && query && !validRoot(query)) invalid();
	const windows = /^[A-Za-z]:\//.test(root) || root.startsWith("//") || /^[A-Za-z]:\//.test(cwd);
	const resolve = (file: string): string => windows
		? path.win32.resolve(cwd, root, file).replace(/\\/g, "/")
		: path.posix.resolve(cwd, root, file);
	const maskedName = (file: string): boolean => {
		const name = path.posix.basename(file.replace(/\\/g, "/"));
		const insensitive = windows || /^[A-Za-z]:[\\/]/.test(file) || file.startsWith("\\\\") || file.startsWith("//");
		const normalized = insensitive ? name.toLowerCase().replace(/[ .]+$/, "") : name;
		return isMaskedName(normalized, insensitive ? patterns.map((p) => p.toLowerCase()) : patterns, insensitive ? exceptions.map((p) => p.toLowerCase()) : exceptions);
	};
	const maskedRoot = maskedName(root);
	return (file) => {
		if (!validPath(file)) invalid();
		// A direct masked query stays masked even if the display path is unexpected.
		return maskedRoot || maskedName(file) || maskedName(resolve(file));
	};
}

interface ParsedText {
	text: string;
	omitted: number;
}

const NO_MATCH = new Set(["No matches found", "No matches found."]);

function safeNotice(row: string, tool: string): boolean {
	if (tool === "ffgrep") {
		return /^\[(?:Results truncated|Showing first [1-9]\d* matches|Match limit reached)\]$/.test(row);
	}
	if (!row.startsWith("[") || !row.endsWith("]")) return false;
	return row.slice(1, -1).split(/\. (?=\d|Some lines)/).every((notice) =>
		/^[1-9]\d* matches limit reached\. Use limit=[1-9]\d* for more, or refine pattern$/.test(notice)
		|| /^\d+(?:\.\d+)?(?:B|KB|MB) limit reached$/.test(notice)
		|| /^Some lines truncated to [1-9]\d* chars\. Use read tool to see full lines$/.test(notice));
}

function parseText(text: string, tool: string, masked: (file: string) => boolean): ParsedText {
	text = text.replace(/\r\n/g, "\n");
	if (/[\x00-\x08\x0b-\x1f\x7f]/.test(text)) invalid();
	if (NO_MATCH.has(text.trim())) return { text: text.trim(), omitted: 0 };
	const rows = text.split("\n");
	const kept: string[] = [];
	const notices: string[] = [];
	let omitted = 0;
	let block: { file: string; rows: string[]; matches: number; hidden: boolean } | undefined;
	let sawMatch = false;
	let ended = false;
	const flush = (): void => {
		if (!block) return;
		if (!block.matches) invalid();
		sawMatch = true;
		if (block.hidden) omitted += block.matches;
		else {
			if (tool === "ffgrep" && kept.length) kept.push("");
			kept.push(...block.rows);
		}
		block = undefined;
	};
	for (const row of rows) {
		if (!row) continue;
		if (safeNotice(row, tool)) {
			flush();
			ended = true;
			notices.push(row);
			continue;
		}
		if (ended) invalid();
		if (tool === "grep") {
			if (row === "--") { flush(); continue; }
			const candidates: Array<{ file: string; match: boolean }> = [];
			for (const delimiter of row.matchAll(/([:-])([1-9]\d*)\1 /g)) {
				const file = row.slice(0, delimiter.index);
				if (!Number.isSafeInteger(Number(delimiter[2]))) invalid();
				if (validPath(file)) candidates.push({ file, match: delimiter[1] === ":" });
			}
			if (candidates.length !== 1) invalid();
			const record = candidates[0];
			if (!block || block.file !== record.file) {
				flush();
				block = { file: record.file, rows: [], matches: 0, hidden: masked(record.file) };
			}
			block.rows.push(row);
			if (record.match) block.matches++;
		} else {
			const record = /^[ \t]+([1-9]\d*)([:-]) (.*)$/.exec(row);
			if (record) {
				if (!block || !Number.isSafeInteger(Number(record[1]))) invalid();
				block.rows.push(row);
				if (record[2] === ":") block.matches++;
			} else {
				flush();
				if (!validPath(row)) invalid();
				block = { file: row, rows: [row], matches: 0, hidden: masked(row) };
			}
		}
	}
	flush();
	if (!sawMatch) invalid();
	if (notices.length) {
		if (kept.length) kept.push("");
		kept.push(...notices);
	}
	return { text: kept.join("\n"), omitted };
}

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
	return value as Record<string, unknown>;
}

function field(record: Record<string, unknown>, names: string[], optional = false): unknown {
	const present = names.filter((name) => Object.hasOwn(record, name));
	if (!present.length && optional) return undefined;
	if (present.length !== 1) invalid();
	return record[present[0]];
}

function location(record: Record<string, unknown>): SafeSearchContext {
	const line = field(record, ["line", "lineNumber"]);
	const text = field(record, ["text", "lineText"]);
	if (typeof line !== "number" || !Number.isSafeInteger(line) || line < 1 || typeof text !== "string") invalid();
	return { line, text };
}

/**
 * Explicit adapter, not a guessed ffgrep provider schema: { matches: [...] }.
 * Accept path/filePath, line/lineNumber and text/lineText. Context/before/after
 * rows inherit the match's path. An explicit different path is ambiguous.
 * Everything except these fields is discarded, including opaque metadata.
 */
function parseStructured(value: unknown, masked: (file: string) => boolean): { matches: SafeSearchMatch[]; omitted: number; total: number } {
	const root = object(value);
	const source = root.matches;
	if (!Object.hasOwn(root, "matches") || !Array.isArray(source)) invalid();
	const matches: SafeSearchMatch[] = [];
	let omitted = 0;
	for (const entry of source) {
		const record = object(entry);
		const file = field(record, ["path", "filePath"]);
		if (!validPath(file)) invalid();
		const match: SafeSearchMatch = { path: file, ...location(record) };
		for (const key of ["context", "before", "after"] as const) {
			if (!Object.hasOwn(record, key)) continue;
			const context = record[key];
			if (!Array.isArray(context)) invalid();
			const safeContext: SafeSearchContext[] = [];
			for (const entry of context) {
				const row = object(entry);
				const contextPath = field(row, ["path", "filePath"], true);
				if (contextPath !== undefined && contextPath !== file) invalid();
				safeContext.push(location(row));
			}
			match[key] = safeContext;
		}
		if (masked(file)) omitted++;
		else matches.push(match);
	}
	return { matches, omitted, total: source.length };
}

/** Pure result adapter. Never throw: pi can otherwise retain the original result. */
export function filterSearchResult<Content extends { type: string; text?: string }>(event: SearchResultEvent<Content>, policy: SearchFilterPolicy): SearchResultOverride | undefined {
	try {
		if (typeof event.toolName !== "string") return suppressed();
		if (event.toolName !== "grep" && event.toolName !== "ffgrep") return undefined;
		if (policy.profile === "yolo" || policy.profile === "unrestricted") return undefined;
		if (typeof policy.profile !== "string") return suppressed();
		const masked = maskPredicate(event, policy);
		if (!Array.isArray(event.content) || !event.content.length) return suppressed();
		const parts = event.content.map((part) => {
			if (part.type !== "text" || typeof part.text !== "string") invalid();
			return part.text;
		});
		const parsed = parseText(parts.join("\n"), event.toolName, masked);
		const structured = event.structuredContent === undefined ? undefined : parseStructured(event.structuredContent, masked);
		if (NO_MATCH.has(parsed.text) && structured && structured.total) return suppressed();
		if (parsed.omitted && structured?.omitted && parsed.omitted !== structured.omitted) return suppressed();
		// Text and structured data normally mirror the same matches, not two sets.
		const omitted = Math.max(parsed.omitted, structured?.omitted ?? 0);
		const text = [parsed.text, omitted ? `${omitted} matches in masked files omitted` : ""].filter(Boolean).join("\n");
		const result: SearchResultOverride = { content: [{ type: "text", text }], details: { guard: { suppressed: false, omittedMatches: omitted } }, isError: event.isError === true };
		// Returning content without structuredContent tells pi to remove stale data.
		if (structured) result.structuredContent = { matches: structured.matches };
		return result;
	} catch {
		return suppressed();
	}
}
