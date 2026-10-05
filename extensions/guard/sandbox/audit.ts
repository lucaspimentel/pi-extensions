/**
 * Post-call audit for the guard sandbox.
 *
 * Nested read-only binds are bypassable with a parent rename (mv sub sub2;
 * mkdir sub; echo evil > sub/AGENTS.md), and protected paths that did not
 * exist before a call are not bound at all. The audit closes that gap:
 *
 *   - snapshotProtected() records dev/ino/type for every top-level protected
 *     name plus every nested protected entry the scan found;
 *   - auditProtected() rescans after the process exits and reports created,
 *     replaced (dev/ino changed: the nested parent-rename attack), and
 *     missing (moved away) entries;
 *   - created and replaced entries are moved into the quarantine directory
 *     (never deleted), and lockWrites reports writes that should lock the
 *     workspace (step 2 turns that into "read-only until /guard ack").
 */

import {
	copyFileSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	renameSync,
	rmSync,
} from "node:fs";
import * as path from "node:path";
import { PROTECTED_TOP_LEVEL } from "./spec.ts";
import { scanWorkspace, type ScanOptions } from "./scan.ts";

export interface ProtectedEntry {
	exists: boolean;
	dev?: number;
	ino?: number;
	type?: "file" | "directory" | "symlink" | "other";
}

export type ProtectedSnapshot = Map<string, ProtectedEntry>;

export interface QuarantineMove {
	/** Workspace-relative path that was moved. */
	from: string;
	/** Absolute path it was moved to. */
	to: string;
}

export interface AuditResult {
	/** Protected entries created by the call (relative paths). */
	created: string[];
	/** Protected entries whose dev/ino changed (relative paths). */
	replaced: string[];
	/** Protected entries that existed before and are gone (relative paths). */
	missing: string[];
	/** Moves performed into the quarantine directory. */
	quarantined: QuarantineMove[];
	/**
	 * True when writes touched entries that must lock the workspace (replaced
	 * or missing). Step 2 turns this into "read-only until /guard ack".
	 */
	lockWrites: boolean;
	/** Human-readable summary for tool results and notifications. */
	summary: string;
	/** Scan or quarantine problems that did not block the audit. */
	diagnostics: string[];
}

export interface SnapshotOptions extends ScanOptions {
	/** Scan override (tests). */
	scan?: (workspace: string) => { nestedProtected: string[] };
}

function classifyType(s: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): ProtectedEntry["type"] {
	if (s.isFile()) return "file";
	if (s.isDirectory()) return "directory";
	if (s.isSymbolicLink()) return "symlink";
	return "other";
}

function lstatEntry(p: string): ProtectedEntry {
	try {
		const s = lstatSync(p);
		return { exists: true, dev: s.dev, ino: s.ino, type: classifyType(s) };
	} catch {
		return { exists: false };
	}
}

/** Top-level protected names plus nested entries found by a scan. */
export function snapshotProtected(workspace: string, options: SnapshotOptions = {}): ProtectedSnapshot {
	const snap: ProtectedSnapshot = new Map();
	const rels: string[] = [...PROTECTED_TOP_LEVEL];
	if (options.scan) {
		rels.push(...options.scan(workspace).nestedProtected.map((p) => path.relative(workspace, p)));
	} else {
		try {
			const r = scanWorkspace(workspace, options);
			rels.push(...r.nestedProtected.map((p) => path.relative(workspace, p)));
		} catch {
			// The audit still covers the top-level names; auditProtected
			// reports scan failures and fails closed on lockWrites.
		}
	}
	for (const rel of rels) {
		if (!snap.has(rel)) snap.set(rel, lstatEntry(path.join(workspace, rel)));
	}
	return snap;
}

function quarantineTimestamp(): string {
	return new Date().toISOString().replace(/[:.]/g, "-");
}

/** Move a workspace entry into quarantine; on EXDEV copy recursively then remove. */
function moveToQuarantine(workspace: string, rel: string, quarantineDir: string): QuarantineMove | null {
	const from = path.join(workspace, rel);
	const to = path.join(quarantineDir, rel);
	if (!existsSync(from) && !lstatExists(from)) return null;
	try {
		mkdirSync(path.dirname(to), { recursive: true });
	} catch {
		return null;
	}
	try {
		renameSync(from, to);
		return { from: rel, to };
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code !== "EXDEV") return null;
	}
	// Cross-device: copy then remove.
	try {
		const s = lstatSync(from);
		if (s.isDirectory()) {
			cpSync(from, to, { recursive: true, force: true });
			rmSync(from, { recursive: true, force: true });
		} else {
			copyFileSync(from, to);
			rmSync(from, { force: true });
		}
		return { from: rel, to };
	} catch {
		return null;
	}
}

function lstatExists(p: string): boolean {
	try {
		lstatSync(p);
		return true;
	} catch {
		return false;
	}
}

export interface AuditOptions extends SnapshotOptions {
	/** Directory to move created/replaced entries into. */
	quarantineDir: string;
}

/**
 * Compare a pre-call snapshot against a post-call rescan and quarantine
 * created or replaced entries. Created entries are moved parents-first; an
 * entry already gone because its parent was quarantined is not reported as a
 * separate move.
 */
export function auditProtected(
	before: ProtectedSnapshot,
	workspace: string,
	options: AuditOptions,
): AuditResult {
	const diagnostics: string[] = [];

	// One post-call scan covers both the nested layout and the dev/ino
	// comparison set.
	const afterRels = new Set<string>([...PROTECTED_TOP_LEVEL]);
	try {
		const scan = options.scan ? options.scan(workspace) : scanWorkspace(workspace, options);
		for (const p of scan.nestedProtected) afterRels.add(path.relative(workspace, p));
	} catch (err) {
		diagnostics.push(
			`The post-call protected-path scan failed (${err instanceof Error ? err.message : String(err)}); ` +
				"treating the call as potentially lock-writing (fail closed).",
		);
	}
	const after: ProtectedSnapshot = new Map();
	for (const rel of afterRels) {
		after.set(rel, lstatEntry(path.join(workspace, rel)));
	}

	const created: string[] = [];
	const replaced: string[] = [];
	const missing: string[] = [];
	for (const [rel, afterEntry] of after) {
		const beforeEntry = before.get(rel);
		if (!afterEntry.exists) {
			if (beforeEntry?.exists) missing.push(rel);
			continue;
		}
		if (!beforeEntry || !beforeEntry.exists) {
			created.push(rel);
		} else if (beforeEntry.dev !== afterEntry.dev || beforeEntry.ino !== afterEntry.ino) {
			replaced.push(rel);
		}
	}

	// Quarantine created and replaced entries, shallowest first so parents
	// move before their children.
	const quarantineDir = path.join(options.quarantineDir, quarantineTimestamp());
	const toMove = [...created, ...replaced].sort(
		(a, b) => a.split(path.sep).length - b.split(path.sep).length,
	);
	const quarantined: QuarantineMove[] = [];
	for (const rel of toMove) {
		const moved = moveToQuarantine(workspace, rel, quarantineDir);
		if (moved) {
			quarantined.push(moved);
		} else if (!existsSync(path.join(workspace, rel))) {
			// Already removed together with a quarantined parent.
			diagnostics.push(`${rel} was removed together with its quarantined parent`);
		} else {
			diagnostics.push(`could not quarantine ${rel}`);
		}
	}

	const lockWrites = replaced.length + missing.length > 0;
	const summary = formatAuditSummary({ created, replaced, missing, quarantined, lockWrites });
	return { created, replaced, missing, quarantined, lockWrites, summary, diagnostics };
}

/** Human-readable audit summary for tool results and notifications. */
export function formatAuditSummary(result: {
	created: string[];
	replaced: string[];
	missing: string[];
	quarantined: QuarantineMove[];
	lockWrites: boolean;
}): string {
	const parts: string[] = [];
	if (result.created.length > 0) parts.push(`created protected entries: ${result.created.join(", ")}`);
	if (result.replaced.length > 0) parts.push(`replaced protected entries: ${result.replaced.join(", ")}`);
	if (result.missing.length > 0) parts.push(`missing protected entries: ${result.missing.join(", ")}`);
	if (result.quarantined.length > 0) {
		parts.push(`quarantined: ${result.quarantined.map((q) => q.from).join(", ")}`);
	}
	if (parts.length === 0) return "Protected-path audit clean.";
	let text = `Protected-path audit flagged: ${parts.join("; ")}.`;
	if (result.lockWrites) {
		text += " Writes touched protected entries; the workspace should be locked (read-only until acknowledged).";
	}
	if (result.quarantined.length > 0) text += " Flagged entries were moved to quarantine, not deleted.";
	return text;
}
