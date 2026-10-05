/**
 * Mask and protected-path discovery for the guard sandbox.
 *
 * One scan per launch returns both secret-mask matches and nested protected
 * entries (nested .git repos and submodules, AGENTS.md, CLAUDE.md, .envrc).
 * The scan uses fd when available (hidden files included, ignore rules off
 * because secrets are usually gitignored, build dirs pruned, contents of any
 * .git directory pruned while the .git entries themselves are still reported)
 * with a find fallback of identical semantics. Absolute paths, NUL-separated.
 *
 * A 5 s timeout or more than 500 classified matches fails the launch with an
 * actionable diagnostic: it never launches unmasked.
 */

import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import * as path from "node:path";
import {
	DEFAULT_MASK_EXCEPTIONS,
	DEFAULT_MASK_PATTERNS,
	PROTECTED_NESTED_NAMES,
	SCAN_PRUNE_NAMES,
	isMaskedName,
} from "./spec.ts";

const SCAN_TIMEOUT_MS = 5_000;
const MATCH_CAP = 500;

export interface ScanResult {
	/** Absolute host paths of files to mask with /dev/null (workspace only). */
	masks: string[];
	/** Absolute host paths of nested protected entries (depth > 0). */
	nestedProtected: string[];
	scanner: ScannerKind;
}

export class ScanFailure extends Error {
	/** Actionable diagnostic for the tool result. */
	diagnostic: string;
	constructor(diagnostic: string) {
		super(diagnostic);
		this.name = "ScanFailure";
		this.diagnostic = diagnostic;
	}
}

export type ScannerKind = "fd" | "find";

export interface ScanOptions {
	/** fd binary path or scanner kind override; from detectSandboxMode(). */
	fdPath?: string | null;
	/** Force a scanner kind (tests compare fd vs find). */
	scanner?: ScannerKind;
	/** Directory listing timeout. */
	timeoutMs?: number;
	/** Maximum number of classified matches. */
	cap?: number;
	patterns?: readonly string[];
	exceptions?: readonly string[];
}

/** Build the fd argv: hidden, no ignore, prune build dirs and .git contents. */
export function fdScanArgs(workspace: string): string[] {
	const args = ["--hidden", "--no-ignore", "--print0", "--absolute-path"];
	for (const name of SCAN_PRUNE_NAMES) args.push("--exclude", name);
	// Prune the CONTENTS of every .git directory at any depth; the .git
	// entries themselves are still listed and reported as protected.
	args.push("--exclude", "**/.git/**");
	args.push(".", workspace);
	return args;
}

/** Build the find argv with identical semantics to the fd scan. */
export function findScanArgs(workspace: string): string[] {
	const pruneNames = [...SCAN_PRUNE_NAMES, ".git"];
	const clauses: string[] = ["("];
	pruneNames.forEach((n, i) => {
		if (i > 0) clauses.push("-o");
		clauses.push("-name", n);
	});
	clauses.push(")");
	// Print pruned entries themselves (including .git at any depth) but never
	// descend into them; print everything else.
	return [workspace, ...clauses, "-prune", "-print0", "-o", "-print0"];
}

/** Run the raw directory scan and return absolute entry paths. */
export function scanRawEntries(
	workspace: string,
	options: ScanOptions = {},
): { entries: string[]; scanner: ScannerKind } {
	const kind = options.scanner ?? (options.fdPath ? "fd" : "find");
	const timeoutMs = options.timeoutMs ?? SCAN_TIMEOUT_MS;
	const program = kind === "fd" ? (options.fdPath ?? "fd") : (options.fdPath ?? "/usr/bin/find");	const args = kind === "fd" ? fdScanArgs(workspace) : findScanArgs(workspace);
	const r = spawnSync(program, args, {
		stdio: ["ignore", "pipe", "pipe"],
		timeout: timeoutMs,
		maxBuffer: 256 * 1024 * 1024,
		encoding: "buffer",
	});
	if (r.error) {
		const timedOut = (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
		throw new ScanFailure(
			timedOut
				? `The workspace discovery scan timed out after ${timeoutMs} ms with ${kind}. ` +
					"The launch is refused rather than running with unmasked secrets. Prune large " +
					"generated directories (node_modules, bin, obj, target) or raise the timeout."
				: `The workspace discovery scan failed (${String(r.error)}). The launch is refused ` +
					"rather than running with unmasked secrets.",
		);
	}
	if (r.status !== 0) {
		throw new ScanFailure(
			`The workspace discovery scan (${kind}) exited with code ${r.status}: ` +
				`${String(r.stderr || "no stderr").trim()}. The launch is refused rather than ` +
				"running with unmasked secrets.",
		);
	}
	const out = r.stdout.toString("utf8");
	const entries: string[] = [];
	for (const part of out.split("\0")) {
		if (part === "") continue;
		entries.push(part.endsWith("/") ? part.slice(0, -1) : part);
	}
	return { entries, scanner: kind };
}

/** True when any path component between workspace and entry is pruned. */
function hasPrunedComponent(workspace: string, entry: string): boolean {
	const rel = path.relative(workspace, entry);
	for (const part of rel.split(path.sep)) {
		if (SCAN_PRUNE_NAMES.includes(part)) return true;
	}
	return false;
}

export interface ClassifiedEntries {
	masks: string[];
	nestedProtected: string[];
}

/**
 * Classify raw scan entries into mask files and nested protected entries.
 * Pure relative to the workspace path; exported for tests.
 */
export function classifyEntries(
	workspace: string,
	entries: readonly string[],
	options: { patterns?: readonly string[]; exceptions?: readonly string[] } = {},
): ClassifiedEntries {
	const patterns = options.patterns ?? DEFAULT_MASK_PATTERNS;
	const exceptions = options.exceptions ?? DEFAULT_MASK_EXCEPTIONS;
	const masks: string[] = [];
	const nestedProtected: string[] = [];
	for (const entry of entries) {
		const rel = path.relative(workspace, entry);
		if (rel === "" || rel.startsWith("..")) continue;
		const parts = rel.split(path.sep);
		const depth = parts.length - 1;
		const name = parts[depth];
		// Entries at or under pruned dirs (the prune roots themselves appear in
		// find output) are irrelevant for masks and nested protection.
		if (hasPrunedComponent(workspace, entry)) continue;
		// The top-level .git entry is a whole-entry protected bind, not a
		// nested discovery result.
		if (depth === 0 && name === ".git") continue;
		if (depth > 0 && PROTECTED_NESTED_NAMES.includes(name)) {
			nestedProtected.push(entry);
			continue;
		}
		if (isMaskedName(name, patterns, exceptions)) {
			// Only regular files are masked; a directory named like a secret is
			// left alone (binding /dev/null over a directory breaks traversal).
			try {
				if (lstatSync(entry).isFile()) masks.push(entry);
			} catch {
				/* vanished between scan and classify */
			}
		}
	}
	return { masks, nestedProtected };
}

/**
 * Scan the workspace for mask matches and nested protected entries. Throws
 * ScanFailure on timeout, scanner failure, or more than the match cap.
 */
export function scanWorkspace(workspace: string, options: ScanOptions = {}): ScanResult {
	const cap = options.cap ?? MATCH_CAP;
	const { entries, scanner } = scanRawEntries(workspace, options);
	const classified = classifyEntries(workspace, entries, options);
	const total = classified.masks.length + classified.nestedProtected.length;
	if (total > cap) {
		throw new ScanFailure(
			`The workspace discovery scan found ${total} mask or protected-path matches, above ` +
				`the hard cap of ${cap}. The launch is refused rather than running with an ` +
				"unreviewed mount layout. Check for leaked credential files or an unusually " +
				"deep tree of nested repos and instruction files.",
		);
	}
	return { ...classified, scanner };
}
