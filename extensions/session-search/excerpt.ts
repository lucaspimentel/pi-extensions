/**
 * session-search/excerpt.ts
 *
 * Single-session excerpt orchestration behind the `session_excerpt` tool and
 * the /session-search "Load context into session" action: validate a session
 * path, read that one file, select the window (query anchors, or the tail),
 * and build the flat result envelope.
 *
 * Rules (settled design):
 *   - The path must resolve inside the sessions directory, must be an existing
 *     regular *.jsonl file, and must carry a session header. The tool never
 *     becomes a general-purpose file reader.
 *   - Canonical (symlink-resolved) containment is checked too, so a symlink
 *     inside the tree cannot escape it. The sessions root itself may be a
 *     symlink.
 *   - Every invalid input and every filesystem failure becomes an envelope
 *     with one of the four error kinds; this module does not throw.
 *   - Reading the session that is making the call is allowed and flagged
 *     `selfSession`, matching the TUI action's existing behavior.
 *   - A query that matches nothing in this session falls back to the labeled
 *     tail window rather than failing.
 *
 * Only the file read is injected (tests); everything else is the real
 * filesystem, so symlink and permission behavior is exercised as shipped.
 */

import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { parseSession } from "./parse.ts";
import { selectAnchoredExcerpt, selectTailExcerpt, type ExcerptSelection } from "./context.ts";
import { searchSessions } from "./search.ts";
import { sessionsDir } from "./store.ts";
import type { ExcerptEnvelope, ExcerptErrorKind, ExcerptToolResult } from "./schema.ts";

/** Session headers are the first JSONL entry; scan a little further to be safe. */
const HEADER_SCAN_LINES = 20;

export interface ExcerptRequest {
	/** Session file path, as supplied by the caller. */
	path: string;
	/** Query used to locate the window; same syntax as session_search. */
	query?: string;
	/** Absolute path of the session making the call (flagged as selfSession). */
	activeSessionPath?: string;
	signal?: AbortSignal;
	/** Sessions root; defaults to the resolved sessions directory. */
	sessionsRoot?: string;
	/** Test seam: replaces the synchronous file read. */
	readFile?: (path: string) => string;
}

/** True when `target` is inside `root`, separator-aware and prefix-safe. */
function insideDir(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** A session file always carries a `type: "session"` header entry. */
function looksLikeSession(content: string): boolean {
	for (const line of content.split("\n", HEADER_SCAN_LINES)) {
		if (!line.startsWith("{")) continue;
		try {
			const entry = JSON.parse(line);
			if (entry && typeof entry === "object" && entry.type === "session") return true;
		} catch {
			// tolerate corrupt lines, like the parser does
		}
	}
	return false;
}

function reason(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function failure(path: string, kind: ExcerptErrorKind, message: string): ExcerptEnvelope {
	return {
		ok: false,
		path,
		sessionId: "",
		cwd: "",
		started: "",
		selfSession: false,
		// No selection ran; `anchored` is only meaningful when ok is true.
		anchored: { tail: true },
		messageCount: 0,
		truncated: false,
		body: "",
		error: { kind, message },
	};
}

/** Same file identity, falling back to the literal path when realpath fails. */
function sameFile(canonical: string, other: string | undefined): boolean {
	if (other === undefined || other.trim() === "") return false;
	const resolved = resolve(other);
	try {
		return realpathSync(resolved) === canonical;
	} catch {
		return resolved === canonical;
	}
}

/**
 * Build the excerpt envelope for one request. Total: every failure mode is
 * mapped to an error envelope, so callers never handle an exception.
 */
export function buildExcerpt(request: ExcerptRequest): ExcerptEnvelope {
	const root = request.sessionsRoot ?? sessionsDir();
	const requested = typeof request.path === "string" ? request.path : "";
	const target = resolve(requested);

	if (request.signal?.aborted) return failure(target, "cancelled", "the call was cancelled before it started");
	if (requested.trim() === "") return failure("", "not_a_session", "no session path was given");
	if (!target.toLowerCase().endsWith(".jsonl")) {
		return failure(target, "not_a_session", `not a session file (expected a *.jsonl path): ${requested}`);
	}
	if (!insideDir(resolve(root), target)) {
		return failure(target, "outside_sessions", `session path is outside the sessions directory (${root}): ${requested}`);
	}

	// Canonical containment: a symlink inside the tree must not escape it.
	let canonical: string;
	try {
		const rootReal = realpathSync(resolve(root));
		canonical = realpathSync(target);
		if (!insideDir(rootReal, canonical)) {
			return failure(target, "outside_sessions", `session path resolves outside the sessions directory (${root}): ${requested}`);
		}
	} catch (err) {
		return failure(target, "unreadable", `could not read session file ${requested}: ${reason(err)}`);
	}

	try {
		if (!statSync(canonical).isFile()) {
			return failure(target, "unreadable", `session path is not a regular file: ${requested}`);
		}
	} catch (err) {
		return failure(target, "unreadable", `could not read session file ${requested}: ${reason(err)}`);
	}

	let content: string;
	try {
		content = request.readFile ? request.readFile(canonical) : readFileSync(canonical, "utf8");
	} catch (err) {
		return failure(target, "unreadable", `could not read session file ${requested}: ${reason(err)}`);
	}
	if (request.signal?.aborted) return failure(target, "cancelled", "the call was cancelled while reading the session file");

	if (!looksLikeSession(content)) {
		return failure(target, "not_a_session", `not a session file (no session header found): ${requested}`);
	}

	const summary = parseSession(content, target);
	const query = (request.query ?? "").trim();

	let selection: ExcerptSelection;
	if (query === "") {
		selection = selectTailExcerpt(content);
	} else {
		// Re-match the query against this one session (never the global index),
		// then use the matched entries as window anchors.
		const hit = searchSessions([summary], query, { limit: 1 })[0];
		const anchors = hit ? hit.snippets.map((s) => s.ts).filter((ts) => ts !== "") : [];
		selection = anchors.length > 0
			? selectAnchoredExcerpt(content, anchors[0], anchors)
			: selectTailExcerpt(content, { missed: true });
	}

	return {
		ok: true,
		path: target,
		sessionId: summary.sessionId,
		...(summary.name === undefined ? {} : { name: summary.name }),
		cwd: summary.cwd,
		started: summary.started,
		selfSession: sameFile(canonical, request.activeSessionPath),
		anchored: selection.anchored,
		messageCount: selection.messageCount,
		truncated: selection.truncated,
		body: selection.body,
	};
}

/** One-line description of how the window was chosen. */
function selectionText(envelope: ExcerptEnvelope): string {
	if (envelope.messageCount === 0) return "no indexable messages";
	const count = `${envelope.messageCount} message(s)`;
	let where: string;
	if ("ts" in envelope.anchored) where = `around ${envelope.anchored.ts.slice(0, 19).replace("T", " ")}: ${count}`;
	else if ("queryMissed" in envelope.anchored) where = `the tail, ${count}: the query matched nothing in this session`;
	else where = `the tail, ${count}: no query was supplied`;
	return envelope.truncated ? `${where} (truncated by the excerpt caps)` : where;
}

/**
 * Render the model-facing text: one header line naming the session and how the
 * window was chosen, then the excerpt body. `source` names the caller in the
 * header (the tool, or the /session-search action).
 */
export function excerptText(envelope: ExcerptEnvelope, opts: { source?: string } = {}): string {
	if (!envelope.ok) {
		const kind = envelope.error?.kind ?? "unreadable";
		return `No session excerpt for ${envelope.path || "the requested path"}: ${envelope.error?.message ?? kind} (${kind})`;
	}
	const source = opts.source ?? "via session_excerpt";
	const label = envelope.name ? `"${envelope.name}"` : envelope.sessionId ? `"${envelope.sessionId}"` : "session";
	const cwd = envelope.cwd || "cwd unknown";
	const date = envelope.started ? envelope.started.slice(0, 10) : "date unknown";
	const self = envelope.selfSession ? ", this session" : "";
	const head = `Excerpt from ${label} (${cwd}, ${date}${self}, ${source}): ${selectionText(envelope)}.`;
	return envelope.body ? `${head}\n\n${envelope.body}` : head;
}

/** Finalize an envelope into the tool result shape (content + structured). */
export function excerptToolResult(envelope: ExcerptEnvelope): ExcerptToolResult {
	return {
		content: [{ type: "text", text: excerptText(envelope) }],
		details: { result: envelope },
		structuredContent: envelope,
		isError: !envelope.ok,
	};
}
