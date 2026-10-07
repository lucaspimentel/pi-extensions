/**
 * Pure helpers for the step-3 permission dialogs. Step 2 (observe-only) adds
 * no dialogs: suggestRule computes the entry an "always" choice would save,
 * readGrantSuggestion computes the covering directory for an outside-root
 * read, and addToConfigScope unions a patch into a guard.json scope with
 * dedupe (never removes anything). Unit-tested; index.ts wires them into
 * dialogs in step 3.
 */

import { dirname } from "node:path";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import type { GuardConfig, ResolvedGuardConfig } from "./config.ts";
import { dedupe, loadProjectConfigRaw, loadUserConfigRaw, projectConfigPath, saveProjectConfig, saveUserConfig, userConfigPath } from "./config.ts";
import type { GuardCall, PolicyState } from "./decision.ts";
import { classificationName } from "./classes.ts";
import { normalizeMatchPath } from "./paths.ts";
import { decide } from "./decision.ts";

/** A partial guard.json patch an "always allow" choice would save. */
export type SuggestedPatch = Partial<GuardConfig>;

/**
 * Suggest the covering directory for an outside-root read target: the
 * nearest existing directory of the target (walk up until a real directory
 * is found). Purely path + fs probing; no writes.
 */
export function readGrantSuggestion(path: string, cwd: string): string {
	const resolved = normalizeMatchPath(path, cwd);
	try { if (statSync(resolved).isDirectory()) return resolved; } catch { /* missing targets use a covering parent */ }
	let dir = dirname(resolved);
	for (let i = 0; i < 32; i++) {
		try {
			if (existsSync(dir) && statSync(dir).isDirectory()) return dir;
		} catch {
			// Unreadable entry: keep walking up.
		}
		const parent = dirname(dir);
		if (parent === dir) return dir; // filesystem root
		dir = parent;
	}
	return dir;
}

/** The write-root suggestion for an outside-root write target: its directory. */
function writeRootSuggestion(path: string, cwd: string): string {
	return dirname(normalizeMatchPath(path, cwd));
}

/**
 * The config entry an "always" choice would save for this call, or null when
 * there is nothing worth saving (e.g. a prompt on a remote write has no
 * allow-shaped home). Pure: returns data, never writes.
 *
 * - host shell: an anchored regex of the complete escaped command;
 * - web_fetch: `https://<host>/*`, for webFetchAllow;
 * - local read outside the roots: the grant directory, for readRoots;
 * - write outside the roots: the directory, for writeRoots;
 * - remote tools: `{ toolClasses: { <name>: "remote-read" } }` only when the
 *   decision was a prompt on a read-like call; otherwise null.
 */
export function suggestRule(call: GuardCall, policy: PolicyState): SuggestedPatch | null {
	switch (call.kind) {
		case "host-shell": {
			if (!call.command.trim() || /[\r\n]/.test(call.command)) return null;
			const exact = call.command.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
			const shell = call.shell === "pwsh" ? "Pwsh" : "HostBash";
			return { hostBash: { allow: [`${shell}(/^${exact}$/)`] } };
		}
		case "web-fetch": {
			const host = urlHost(call.url);
			if (!host) return null;
			return { webFetchAllow: [`https://${host}/*`] };
		}
		case "local-read": {
			if (call.path === undefined || call.path.trim() === "") return null;
			const dir = readGrantSuggestion(call.path, policy.cwd);
			return { readRoots: [dir] };
		}
		case "local-write": {
			if (call.path === undefined || call.path.trim() === "") return null;
			const dir = writeRootSuggestion(call.path, policy.cwd);
			return { writeRoots: [dir] };
		}
		case "remote-read": {
			// Only a prompt on a read-like remote call has a toolClasses home.
			return null;
		}
		default:
			return null;
	}
}

/**
 * Remote-read variant consulted by the step-3 dialog: a prompt on a
 * read-classified call can be saved as a `toolClasses` entry pinning the
 * tool to remote-read. Returns null for anything else.
 */
export function suggestRemoteReadRule(
	toolName: string,
	input: Record<string, unknown>,
	action: "allow" | "prompt" | "deny",
): SuggestedPatch | null {
	if (action !== "prompt") return null;
	const name = classificationName(toolName, input);
	return { toolClasses: { [name]: "remote-read" } };
}

function urlHost(url: string): string | null {
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
		return parsed.host;
	} catch {
		const m = url.match(/^https?:\/\/([^/?#]+)/i);
		return m ? m[1] : null;
	}
}

/** The list keys of GuardConfig (unioned with dedupe by addToConfigScope). */
const LIST_KEYS: readonly (keyof GuardConfig)[] = [
	"protectedPaths",
	"maskPatterns",
	"maskExceptions",
	"webFetchAllow",
	"readRoots",
	"writeRoots",
	"classifierEnvironment",
	"classifierAllow",
	"classifierSoftDeny",
	"classifierHardDeny",
];

export type ConfigScope = "user" | "project";

/** Save only patches whose effective merge authorizes the complete call. */
export function effectiveAllowSuggestion(call: GuardCall, policy: PolicyState): SuggestedPatch | null {
	if (decide(policy, call).provenance === "explicit-ask") return null;
	const patch = suggestRule(call, policy);
	if (!patch?.hostBash?.allow) return null;
	const config: ResolvedGuardConfig = {
		...policy.config,
		hostBash: { ...policy.config.hostBash, allow: dedupe([...policy.config.hostBash.allow, ...patch.hostBash.allow]) },
	};
	return decide({ ...policy, config }, call).action === "allow" ? patch : null;
}

export interface AddToScopeResult {
	/** The file the patch was written to. */
	path: string;
	/** How many entries were actually added (0 when everything was present). */
	added: number;
}

function unionStrings(existing: unknown, patch: unknown): { list: string[]; added: number } {
	const base = Array.isArray(existing) ? existing.filter((v): v is string => typeof v === "string") : [];
	const patchList = Array.isArray(patch) ? patch.filter((v): v is string => typeof v === "string") : [];
	const uniqueBase = dedupe(base);
	const merged = dedupe([...uniqueBase, ...patchList]);
	return { list: merged, added: merged.length - uniqueBase.length };
}

/**
 * Union a patch into one guard.json scope: user (~/.pi/agent/guard.json) or
 * project (<cwd>/.pi/guard.local.json). List keys are unioned with dedupe,
 * hostBash rule slots unioned per slot, toolClasses merged per key, scalar
 * keys set from the patch when present. Existing entries are never removed,
 * so re-running with the same patch adds nothing.
 */
export function addToConfigScope(
	scope: ConfigScope,
	patch: Partial<GuardConfig>,
	opts: { cwd?: string; home?: string } = {},
): AddToScopeResult {
	const home = opts.home ?? homedir();
	const cwd = opts.cwd ?? process.cwd();
	const existing: GuardConfig = scope === "user"
		? loadUserConfigRaw(home)
		: loadProjectConfigRaw(cwd);
	const path = scope === "user" ? userConfigPath(home) : projectConfigPath(cwd);
	let added = 0;
	const next: GuardConfig = { ...existing };

	for (const key of LIST_KEYS) {
		const patchValue = patch[key];
		if (patchValue === undefined) continue;
		const { list, added: n } = unionStrings(existing[key], patchValue);
		if (n > 0 || list.length > 0) {
			(next as Record<string, unknown>)[key] = list;
			added += n;
		}
	}

	// hostBash: union per slot.
	if (patch.hostBash) {
		const base = existing.hostBash ?? {};
		const merged = { ...base };
		for (const slot of ["allow", "deny", "ask"] as const) {
			const patchRules = patch.hostBash[slot];
			if (patchRules === undefined) continue;
			const { list, added: n } = unionStrings(base[slot], patchRules);
			merged[slot] = list;
			added += n;
		}
		next.hostBash = merged;
	}

	// toolClasses: merge per key (existing values win; never removes).
	if (patch.toolClasses) {
		const base = { ...(existing.toolClasses ?? {}) };
		for (const [k, v] of Object.entries(patch.toolClasses)) {
			if (base[k] === undefined) {
				base[k] = v;
				added++;
			}
		}
		next.toolClasses = base;
	}

	// bashValidators: merge per key (existing values win).
	if (patch.bashValidators) {
		const base = { ...(existing.bashValidators ?? {}) };
		for (const [k, v] of Object.entries(patch.bashValidators)) {
			if (base[k] === undefined) {
				base[k] = v;
				added++;
			}
		}
		next.bashValidators = base;
	}

	// Scalars: set when the patch carries them.
	for (const key of ["cycleShortcut", "classifier"] as const) {
		const value = patch[key];
		if (value === undefined) continue;
		(next as Record<string, unknown>)[key] = value;
	}

	if (scope === "user") saveUserConfig(next, home);
	else saveProjectConfig(cwd, next);
	return { path, added };
}

/**
 * Count the entries of `patch` that would actually be added to a scope's
 * existing guard.json (the migrate report's `changes`). Never writes.
 */
export function countPatchChanges(
	scope: ConfigScope,
	patch: Partial<GuardConfig>,
	opts: { cwd?: string; home?: string } = {},
): number {
	const home = opts.home ?? homedir();
	const cwd = opts.cwd ?? process.cwd();
	const existing: GuardConfig = scope === "user"
		? loadUserConfigRaw(home)
		: loadProjectConfigRaw(cwd);
	let changes = 0;

	for (const key of LIST_KEYS) {
		const patchValue = patch[key];
		if (patchValue === undefined || !Array.isArray(patchValue)) continue;
		const base = Array.isArray(existing[key]) ? (existing[key] as string[]) : [];
		for (const item of patchValue) {
			if (typeof item === "string" && !base.includes(item)) changes++;
		}
	}
	if (patch.hostBash) {
		const base = existing.hostBash ?? {};
		for (const slot of ["allow", "deny", "ask"] as const) {
			const baseList = base[slot] ?? [];
			for (const rule of patch.hostBash[slot] ?? []) {
				if (!baseList.includes(rule)) changes++;
			}
		}
	}
	if (patch.toolClasses) {
		const base = existing.toolClasses ?? {};
		for (const [k, v] of Object.entries(patch.toolClasses)) {
			if (base[k] !== v) changes++;
		}
	}
	if (patch.bashValidators) {
		const base = existing.bashValidators ?? {};
		for (const [k, v] of Object.entries(patch.bashValidators)) {
			if (base[k] !== v) changes++;
		}
	}
	for (const key of ["cycleShortcut", "classifier"] as const) {
		const value = patch[key];
		if (value === undefined) continue;
		const current = existing[key];
		if (JSON.stringify(current) !== JSON.stringify(value)) changes++;
	}
	return changes;
}
