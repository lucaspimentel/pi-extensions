/**
 * /guard migrate: convert pi-tool-permissions configs to guard.json.
 *
 * Scope (docs/guard-design.md, Config): everything that has a home in guard
 * carries over; the rest is LISTED as dropped (never written):
 *   - Bash(...) rules -> HostBash(...) in the same slot; Pwsh(...) rules kept;
 *   - readAllowPaths -> readRoots;
 *   - writeAllowPaths and bashAllowRedirectsTo -> writeRoots;
 *   - WebFetch(...) ALLOW rules -> webFetchAllow verbatim (URL globs or
 *     /regex/ patterns); WebFetch deny/ask rules are dropped with a note;
 *   - MCP allow rules (bare mcp__* names and Mcp(...)) -> toolClasses
 *     entries set to remote-read;
 *   - bashValidators copied as-is;
 *   - autoMode.classifier -> classifier; autoMode.environment/allow/
 *     soft_deny/hard_deny -> classifierEnvironment/classifierAllow/
 *     classifierSoftDeny/classifierHardDeny.
 *
 * Dropped: Read/Write/Edit/Grep/Glob/Ls/Find rules, other tools' rules,
 * toolDefaults, defaultAction, nonInteractiveAsk, and the implicit-allow
 * toggles. Rules that look like project-code runners are copied but LISTED
 * for a manual purge; nothing is dropped automatically.
 *
 * Pure and testable: legacy reads and existing guard.json reads only, the
 * result is data, and writing is left to the caller (index.ts, via
 * addToConfigScope).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { GuardConfig } from "./config.ts";
import { loadProjectConfigRaw, loadUserConfigRaw } from "./config.ts";

/**
 * Command prefixes whose allow rules look like project-code runners: running
 * them executes project code on the host, which is exactly what guard's
 * sandbox removes the need for. Copied to HostBash anyway, but LISTED for a
 * manual purge.
 */
const SUSPECTED_RUNNER_PREFIXES = [
	"cargo", "dotnet", "pytest", "python -m pytest", "make", "npm run", "npm install", "npm ci",
	"yarn", "pnpm", "gradle", "mvn", "go build", "go test", "go run",
];

/** True when a Bash(...) rule's command starts with a suspected runner prefix. */
export function looksLikeProjectCodeRunner(rule: string): boolean {
	const m = rule.match(/^[A-Za-z0-9_]+\((.*)\)$/);
	const command = m ? m[1] : rule;
	const cmd = command.replace(/\\/g, "/").trim().toLowerCase();
	return SUSPECTED_RUNNER_PREFIXES.some((p) => cmd === p || cmd.startsWith(`${p} `));
}

const USER_LEGACY_PATHS = [
	join(".pi", "agent", "pi-tool-permissions.json"),
	join(".pi", "tool-permissions.json"),
];
const PROJECT_LEGACY_PATHS = [
	join(".pi", "pi-tool-permissions.local.json"),
	join(".pi", "pi-tool-permissions.json"),
	join(".pi", "tool-permissions.json"),
];

export interface MigrateScopeReport {
	/** The legacy config file that was read (the first fallback that exists). */
	sourcePath: string;
	sourceFound: boolean;
	/** Full GuardConfig patch derived from the legacy config. */
	patch: GuardConfig;
	/** Entries that would actually be added to the existing guard.json scope. */
	changes: number;
	/** Legacy settings with no guard home (reported, never written). */
	dropped: string[];
	/** Rules copied but flagged as project-code runners. */
	suspectedRunners: string[];
}

export interface MigrateReport {
	user: MigrateScopeReport;
	project: MigrateScopeReport;
	/** Human-readable summary for the command output. */
	summary: string;
}

interface LegacyAutoMode {
	classifier?: { provider?: unknown; model?: unknown };
	environment?: unknown;
	allow?: unknown;
	soft_deny?: unknown;
	hard_deny?: unknown;
	classifyAllShell?: unknown;
}

interface LegacyConfig {
	allow?: unknown;
	deny?: unknown;
	ask?: unknown;
	defaultAction?: unknown;
	toolDefaults?: unknown;
	nonInteractiveAsk?: unknown;
	readAllowPaths?: unknown;
	writeAllowPaths?: unknown;
	bashAllowRedirectsTo?: unknown;
	bashValidators?: unknown;
	readAllowCwd?: unknown;
	grepAllowCwd?: unknown;
	globAllowCwd?: unknown;
	lsAllowCwd?: unknown;
	findAllowCwd?: unknown;
	readAllowSkills?: unknown;
	readAllowPiDocs?: unknown;
	readAllowAgentDocs?: unknown;
	bashReadOnlyAllowCwd?: unknown;
	bashAllowPureVarAssign?: unknown;
	allowNoopCd?: unknown;
	readAllowScratch?: unknown;
	autoMode?: unknown;
}

const IMPLICIT_TOGGLE_KEYS: readonly (keyof LegacyConfig)[] = [
	"readAllowCwd",
	"grepAllowCwd",
	"globAllowCwd",
	"lsAllowCwd",
	"findAllowCwd",
	"readAllowSkills",
	"readAllowPiDocs",
	"readAllowAgentDocs",
	"bashReadOnlyAllowCwd",
	"bashAllowPureVarAssign",
	"allowNoopCd",
	"readAllowScratch",
];

function readLegacy(home: string, cwd: string, isUser: boolean): { path: string; found: boolean; cfg: LegacyConfig } {
	const base = isUser ? home : cwd;
	const candidates = isUser ? USER_LEGACY_PATHS : PROJECT_LEGACY_PATHS;
	for (const rel of candidates) {
		const p = join(base, rel);
		try {
			if (!existsSync(p)) continue;
			const parsed = JSON.parse(readFileSync(p, "utf8")) as LegacyConfig;
			return { path: p, found: true, cfg: parsed ?? {} };
		} catch {
			continue;
		}
	}
	return { path: join(base, candidates[0]), found: false, cfg: {} };
}

function stringList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((v): v is string => typeof v === "string");
}

/** True when a rule targets the MCP proxy or a bare mcp__ tool name. */
function isMcpRule(raw: string): boolean {
	const trimmed = raw.trim();
	if (/^mcp__/i.test(trimmed)) return true;
	const m = trimmed.match(/^([A-Za-z0-9_]+)(?:\((.*)\))?$/);
	return m !== null && m[1].toLowerCase().replace(/_/g, "") === "mcp" && m[2] !== undefined;
}

/** The toolClasses key an MCP allow rule maps to. */
function mcpClassKey(raw: string): string {
	const trimmed = raw.trim();
	if (/^mcp__/i.test(trimmed)) return trimmed;
	const m = trimmed.match(/^([A-Za-z0-9_]+)\((.*)\)$/);
	return m ? m[2] : trimmed;
}

/**
 * Convert one legacy rule slot. Returns the HostBash/Pwsh rules for the same
 * slot, the WebFetch allow globs, the MCP toolClasses keys, and dropped
 * notes for everything without a guard home.
 */
function convertSlot(
	rules: readonly string[],
	dropped: string[],
	suspected: string[],
	slotLabel: string,
): { hostShell: string[]; webFetchAllow: string[]; mcpKeys: string[] } {
	const hostShell: string[] = [];
	const webFetchAllow: string[] = [];
	const mcpKeys: string[] = [];
	for (const raw of rules) {
		const m = raw.match(/^([A-Za-z0-9_]+)(?:\((.*)\))?$/);
		if (!m) {
			dropped.push(`${slotLabel}: '${raw}' (unrecognized rule shape)`);
			continue;
		}
		const tool = m[1].toLowerCase().replace(/_/g, "");
		if (tool === "bash") {
			const newRule = `HostBash(${m[2] ?? ""})`;
			hostShell.push(newRule);
			if (looksLikeProjectCodeRunner(newRule)) suspected.push(newRule);
		} else if (tool === "pwsh") {
			const newRule = `Pwsh(${m[2] ?? ""})`;
			hostShell.push(newRule);
		} else if (tool === "webfetch") {
			if (slotLabel === "allow") {
				// URL globs and /regex/ patterns carry over verbatim.
				webFetchAllow.push(m[2] ?? "");
			} else {
				dropped.push(`${slotLabel}: '${raw}' (webFetchAllow is allow-only; re-add as an allow glob if intended)`);
			}
		} else if (isMcpRule(raw)) {
			if (slotLabel === "allow") {
				mcpKeys.push(mcpClassKey(raw));
			} else {
				dropped.push(`${slotLabel}: '${raw}' (toolClasses only records reads; writes fall through the classifier)`);
			}
		} else {
			dropped.push(`${slotLabel}: '${raw}' (no guard home; guard classifies these tools instead)`);
		}
	}
	return { hostShell, webFetchAllow, mcpKeys };
}

/**
 * Compute the migration for one scope. `existing` is the scope's current
 * guard.json (for the changes count); pass {} when absent.
 */
function migrateScope(
	src: { path: string; found: boolean; cfg: LegacyConfig },
	existing: GuardConfig,
): MigrateScopeReport {
	const patch: GuardConfig = {};
	const dropped: string[] = [];
	const suspected: string[] = [];

	if (!src.found) {
		return { sourcePath: src.path, sourceFound: false, patch: {}, changes: 0, dropped, suspectedRunners: [] };
	}
	const cfg = src.cfg;

	// Rule lists: Bash -> HostBash (same slot), Pwsh kept, WebFetch allow ->
	// webFetchAllow, MCP allow -> toolClasses remote-read.
	let anyRule = false;
	const hostBash: { allow?: string[]; deny?: string[]; ask?: string[] } = {};
	for (const slot of ["allow", "deny", "ask"] as const) {
		const converted = convertSlot(stringList(cfg[slot]), dropped, suspected, slot);
		if (converted.hostShell.length > 0) {
			hostBash[slot] = converted.hostShell;
			anyRule = true;
		}
		if (converted.webFetchAllow.length > 0) {
			patch.webFetchAllow = [...(patch.webFetchAllow ?? []), ...converted.webFetchAllow];
			anyRule = true;
		}
		if (converted.mcpKeys.length > 0) {
			const classes = { ...(patch.toolClasses ?? {}) };
			for (const key of converted.mcpKeys) classes[key] = "remote-read";
			patch.toolClasses = classes;
			anyRule = true;
		}
	}
	if (anyRule && Object.keys(hostBash).length > 0) patch.hostBash = hostBash;

	// Path roots.
	const readRoots = stringList(cfg.readAllowPaths);
	if (readRoots.length > 0) patch.readRoots = readRoots;
	const writeRoots = stringList(cfg.writeAllowPaths).length > 0
		? stringList(cfg.writeAllowPaths)
		: stringList(cfg.bashAllowRedirectsTo);
	if (writeRoots.length > 0) patch.writeRoots = writeRoots;

	// Validators.
	const validators: Record<string, string> = {};
	if (cfg.bashValidators && typeof cfg.bashValidators === "object" && !Array.isArray(cfg.bashValidators)) {
		for (const [k, v] of Object.entries(cfg.bashValidators as Record<string, unknown>)) {
			if (typeof v === "string") validators[k] = v;
		}
	}
	if (Object.keys(validators).length > 0) patch.bashValidators = validators;

	// autoMode -> classifier pin and NL lists.
	if (cfg.autoMode && typeof cfg.autoMode === "object") {
		const auto = cfg.autoMode as LegacyAutoMode;
		if (auto.classifier && typeof auto.classifier === "object") {
			const provider = auto.classifier.provider;
			const model = auto.classifier.model;
			if (typeof provider === "string" && typeof model === "string" && provider && model) {
				patch.classifier = { provider, model };
			}
		}
		const environment = stringList(auto.environment);
		if (environment.length > 0) patch.classifierEnvironment = environment;
		const allow = stringList(auto.allow);
		if (allow.length > 0) patch.classifierAllow = allow;
		const soft = stringList(auto.soft_deny);
		if (soft.length > 0) patch.classifierSoftDeny = soft;
		const hard = stringList(auto.hard_deny);
		if (hard.length > 0) patch.classifierHardDeny = hard;
	}

	// Dropped scalar settings.
	if (cfg.defaultAction !== undefined) dropped.push(`defaultAction: ${JSON.stringify(cfg.defaultAction)} (guard has no global default; cells decide)`);
	if (cfg.toolDefaults !== undefined) dropped.push("toolDefaults (guard classifies tools and uses profile cells instead)");
	if (cfg.nonInteractiveAsk !== undefined) dropped.push(`nonInteractiveAsk: ${JSON.stringify(cfg.nonInteractiveAsk)} (guard always denies headless prompts)`);
	for (const key of IMPLICIT_TOGGLE_KEYS) {
		if (cfg[key] !== undefined) dropped.push(`${key}: ${JSON.stringify(cfg[key])} (implicit-allow toggles have no guard home; cwd and roots are always readable)`);
	}
	if (cfg.autoMode && typeof cfg.autoMode === "object" && (cfg.autoMode as LegacyAutoMode).classifyAllShell !== undefined) {
		dropped.push("autoMode.classifyAllShell (guard's auto profile screens exactly the classify cells)");
	}

	const changes = countChanges(existing, patch);
	return { sourcePath: src.path, sourceFound: true, patch, changes, dropped, suspectedRunners: suspected };
}

/** Count patch entries that would actually be added to `existing`. */
function countChanges(existing: GuardConfig, patch: GuardConfig): number {
	let changes = 0;
	const listKeys: readonly (keyof GuardConfig)[] = [
		"protectedPaths", "maskPatterns", "maskExceptions", "webFetchAllow",
		"readRoots", "writeRoots",
		"classifierEnvironment", "classifierAllow", "classifierSoftDeny", "classifierHardDeny",
	];
	for (const key of listKeys) {
		const patchList = patch[key];
		if (!Array.isArray(patchList)) continue;
		const base = Array.isArray(existing[key]) ? (existing[key] as string[]) : [];
		for (const item of patchList) {
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
	if (patch.classifier && JSON.stringify(existing.classifier) !== JSON.stringify(patch.classifier)) changes++;
	return changes;
}

/**
 * Compute the migration for both scopes. Pure: no writes; legacy reads and
 * existing guard.json reads only. The caller merges the returned patches
 * into guard.json via addToConfigScope.
 */
export function computeMigration(home: string = homedir(), cwd: string = process.cwd()): MigrateReport {
	const userSrc = readLegacy(home, cwd, true);
	const projectSrc = readLegacy(home, cwd, false);
	const user = migrateScope(userSrc, loadUserConfigRaw(home));
	const project = migrateScope(projectSrc, loadProjectConfigRaw(cwd));

	const lines: string[] = [];
	for (const [label, scope, target] of [
		["user", user, "~/.pi/agent/guard.json"],
		["project", project, ".pi/guard.local.json"],
	] as const) {
		if (!scope.sourceFound) {
			lines.push(`${label}: no legacy pi-tool-permissions config found (looked near ${scope.sourcePath})`);
			continue;
		}
		const converted = countConverted(scope);
		lines.push(`${label}: ${scope.sourcePath} -> ${target}`);
		lines.push(`  ${converted} rule(s)/setting(s) converted; ${scope.changes} would be added to the existing guard.json`);
		if (scope.suspectedRunners.length > 0) {
			lines.push("  suspected project-code runners (copied, but purge manually; sandboxed bash removes the need for them):");
			for (const r of scope.suspectedRunners) lines.push(`    - ${r}`);
		}
		if (scope.dropped.length > 0) {
			lines.push("  dropped (no guard home):");
			for (const d of scope.dropped) lines.push(`    - ${d}`);
		}
	}
	return { user, project, summary: lines.join("\n") };
}

function countConverted(scope: MigrateScopeReport): number {
	let n = 0;
	const patch = scope.patch as Record<string, unknown>;
	for (const value of Object.values(patch)) {
		if (Array.isArray(value)) n += value.length;
		else if (value && typeof value === "object") {
			for (const v of Object.values(value as Record<string, unknown>)) {
				if (Array.isArray(v)) n += v.length;
				else n += 1;
			}
		} else n += 1;
	}
	return n;
}

