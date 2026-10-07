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
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	renameSync,
	realpathSync,
	rmSync,
} from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { protectedTopLevelNames } from "./spec.ts";
import { scanWorkspace, type ScanOptions } from "./scan.ts";
import { isWithin } from "./host-paths.ts";

export interface ProtectedEntry {
	exists: boolean;
	dev?: number;
	ino?: number;
	type?: "file" | "directory" | "symlink" | "other";
}

export type ProtectedSnapshot = Map<string, ProtectedEntry> & {
	/** False when the baseline scan or stat was incomplete. Check before launch. */
	complete?: boolean;
	/** Initial scan/stat failures retained for the runtime and subsequent audit. */
	diagnostics?: string[];
};

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
	 * True on any violation, incomplete scan/stat, or quarantine failure.
	 * The runtime locks the workspace until acknowledgment.
	 */
	lockWrites: boolean;
	/** Human-readable summary for tool results and notifications. */
	summary: string;
	/** Scan or quarantine problems that did not block the audit. */
	diagnostics: string[];
}

export interface SnapshotOptions extends ScanOptions {
	/** Additional protected top-level names, merged with built-in protections. */
	protectedPaths?: readonly string[];
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
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return { exists: false };
		throw err;
	}
}

/** Top-level protected names plus nested entries found by a scan. */
export function snapshotProtected(workspace: string, options: SnapshotOptions = {}): ProtectedSnapshot {
	const snap: ProtectedSnapshot = new Map();
	snap.complete = true;
	snap.diagnostics = [];
	const rels = protectedTopLevelNames(options.protectedPaths);
	try {
		const scan = options.scan ? options.scan(workspace) : scanWorkspace(workspace, options);
		rels.push(...scan.nestedProtected.map((p) => path.relative(workspace, p)));
	} catch (err) {
		snap.complete = false;
		snap.diagnostics.push(`The initial protected-path scan failed (${errorText(err)}); the baseline is incomplete.`);
	}
	for (const rel of rels) {
		if (snap.has(rel)) continue;
		try {
			snap.set(rel, lstatEntry(path.join(workspace, rel)));
		} catch (err) {
			snap.complete = false;
			snap.diagnostics.push(`Could not snapshot ${rel}: ${errorText(err)}`);
		}
	}
	return snap;
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function quarantineTimestamp(): string {
	return `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(6).toString("hex")}`;
}

/** Move a workspace entry into quarantine; on EXDEV copy recursively then remove. */
function moveToQuarantine(workspace: string, rel: string, quarantineDir: string): QuarantineMove | null {
	const from = path.join(workspace, rel);
	const to = path.join(quarantineDir, rel);
	if (!existsSync(from) && !lstatExists(from)) return null;
	if (!isWithin(realpathSync(path.dirname(from)), realpathSync(workspace))) {
		throw new Error("protected entry parent resolves outside the workspace; containment refused");
	}
	mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
	try {
		renameSync(from, to);
		return { from: rel, to };
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code !== "EXDEV") throw err;
	}
	// Cross-device: copy the entry itself (including symlinks), then remove
	// only the workspace source. A failed copy is retained in quarantine.
	cpSync(from, to, { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true });
	rmSync(from, { recursive: true, force: true });
	return { from: rel, to };
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
	const diagnostics: string[] = [...(before.diagnostics ?? [])];
	let incomplete = before.complete === false;
	if (incomplete && diagnostics.length === 0) diagnostics.push("The initial protected-path baseline is incomplete.");

	// One post-call scan covers both the nested layout and the dev/ino
	// comparison set.
	const afterRels = new Set<string>([...protectedTopLevelNames(options.protectedPaths), ...before.keys()]);
	try {
		const scan = options.scan ? options.scan(workspace) : scanWorkspace(workspace, options);
		for (const p of scan.nestedProtected) afterRels.add(path.relative(workspace, p));
	} catch (err) {
		incomplete = true;
		diagnostics.push(
			`The post-call protected-path scan failed (${err instanceof Error ? err.message : String(err)}); ` +
				"treating the call as potentially lock-writing (fail closed).",
		);
	}
	const after: ProtectedSnapshot = new Map();
	for (const rel of afterRels) {
		try {
			after.set(rel, lstatEntry(path.join(workspace, rel)));
		} catch (err) {
			incomplete = true;
			diagnostics.push(`Could not audit ${rel}: ${errorText(err)}`);
		}
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
		try {
			const moved = moveToQuarantine(workspace, rel, quarantineDir);
			if (moved) {
				quarantined.push(moved);
			} else if (quarantined.some((q) => rel.startsWith(`${q.from}${path.sep}`))) {
				diagnostics.push(`${rel} was removed together with its quarantined parent`);
			} else {
				incomplete = true;
				diagnostics.push(`could not quarantine ${rel}: entry disappeared before containment`);
			}
		} catch (err) {
			incomplete = true;
			diagnostics.push(`could not quarantine ${rel}: ${errorText(err)}`);
		}
	}

	const lockWrites = incomplete || created.length + replaced.length + missing.length > 0;
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
	if (parts.length === 0) {
		return result.lockWrites
			? "Protected-path audit incomplete; the workspace must be locked (read-only until acknowledged)."
			: "Protected-path audit clean.";
	}
	let text = `Protected-path audit flagged: ${parts.join("; ")}.`;
	if (result.lockWrites) {
		text += " Writes touched protected entries; the workspace should be locked (read-only until acknowledged).";
	}
	if (result.quarantined.length > 0) text += " Flagged entries were moved to quarantine, not deleted.";
	return text;
}
