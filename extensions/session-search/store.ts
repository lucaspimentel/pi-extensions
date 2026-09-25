/**
 * session-search/store.ts
 *
 * Index persistence + lazy incremental refresh.
 *
 * The index is a JSONL file at ~/.pi/agent/session-search-index.jsonl, one
 * line per session: {path, mtime, size, summary}. On refresh we stat every
 * *.jsonl under the sessions dir (~678 files, ~ms) and re-parse only files
 * whose (mtime, size) changed. Entries whose file no longer exists are pruned.
 */

import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseSession, type SessionSummary } from "./parse.ts";

export interface IndexedSession extends SessionSummary {
	/** File mtime (ms) at parse time. */
	mtime: number;
	/** File size (bytes) at parse time. */
	size: number;
}

export type SessionIndex = Map<string, IndexedSession>;

export function sessionsDir(home: string = homedir()): string {
	return join(home, ".pi", "agent", "sessions");
}

export function indexPath(home: string = homedir()): string {
	if (process.env.SESSION_SEARCH_INDEX_FILE) return process.env.SESSION_SEARCH_INDEX_FILE;
	return join(home, ".pi", "agent", "session-search-index.jsonl");
}

/** Recursively list *.jsonl files under dir (project dirs are one level down). */
export function listSessionFiles(dir: string): string[] {
	const out: string[] = [];
	let stack: string[] = [dir];
	while (stack.length > 0) {
		const d = stack.pop()!;
		let entries;
		try {
			entries = readdirSync(d, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const e of entries) {
			const full = join(d, e.name);
			if (e.isDirectory()) stack.push(full);
			else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(full);
		}
	}
	return out;
}

export function loadIndex(file: string = indexPath()): SessionIndex {
	const index: SessionIndex = new Map();
	let content: string;
	try {
		content = readFileSync(file, "utf8");
	} catch {
		return index;
	}
	for (const line of content.split("\n")) {
		if (!line) continue;
		try {
			const rec = JSON.parse(line);
			if (rec && typeof rec.path === "string" && rec.mtime != null && rec.size != null) {
				index.set(rec.path, rec as IndexedSession);
			}
		} catch {
			// tolerate corrupt lines
		}
	}
	return index;
}

export function saveIndex(index: SessionIndex, file: string = indexPath()): void {
	const dir = join(file, "..");
	try {
		mkdirSync(dir, { recursive: true });
	} catch {
		// directory may already exist
	}
	const lines: string[] = [];
	for (const rec of index.values()) lines.push(JSON.stringify(rec));
	writeFileSync(file, lines.length > 0 ? lines.join("\n") + "\n" : "");
}

export interface RefreshResult {
	index: SessionIndex;
	/** Sessions re-parsed during this refresh. */
	parsed: number;
	/** Stale entries pruned (files deleted). */
	pruned: number;
	/** Total *.jsonl files under the sessions dir. */
	total: number;
}

/**
 * Bring the index up to date with the sessions dir.
 * Parses only files whose (mtime, size) differ from the index (or that are
 * missing from it), prunes deleted files, and returns stats. Caller decides
 * whether to persist (we avoid rewriting the file when nothing changed).
 */
export function refreshIndex(index: SessionIndex, dir: string = sessionsDir()): RefreshResult {
	const files = listSessionFiles(dir);
	const seen = new Set<string>();
	let parsed = 0;

	for (const file of files) {
		seen.add(file);
		let st;
		try {
			st = statSync(file);
		} catch {
			continue;
		}
		const mtime = Math.floor(st.mtimeMs);
		const size = st.size;
		const cached = index.get(file);
		if (cached && cached.mtime === mtime && cached.size === size) continue;
		let content: string;
		try {
			content = readFileSync(file, "utf8");
		} catch {
			continue;
		}
		index.set(file, { ...parseSession(content, file), mtime, size });
		parsed++;
	}

	let pruned = 0;
	for (const path of [...index.keys()]) {
		if (!seen.has(path)) {
			index.delete(path);
			pruned++;
		}
	}

	return { index, parsed, pruned, total: files.length };
}
