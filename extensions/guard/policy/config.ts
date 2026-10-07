/**
 * guard.json: user scope at ~/.pi/agent/guard.json, project scope at
 * <cwd>/.pi/guard.local.json (machine-local, not committed; mirrors the
 * pi-tool-permissions convention). All keys are optional; everything has a
 * built-in default. Corrupt or partially valid files fail safe: warn and use
 * defaults for the bad keys, never throw.
 *
 * Merge semantics (mirroring pi-tool-permissions): scalar keys project-wins;
 * list keys (protectedPaths, maskPatterns, maskExceptions, webFetchAllow,
 * classifierEnvironment, classifier NL lists, readRoots, writeRoots) unioned
 * with dedupe; hostBash rule lists unioned per slot (deny > ask > allow is
 * applied at decision time, not merge time).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_BASH_VALIDATORS, BASH_VALIDATOR_NONE } from "./bashtier.ts";
import { DEFAULT_CLASSIFIER } from "./classifier.ts";
import { isToolClass, OWNED_EXECUTORS, TOOL_CLASSES } from "./classes.ts";
import { compilePattern } from "./rules.ts";

export const USER_CONFIG_REL = "guard.json";
export const PROJECT_CONFIG_REL = join(".pi", "guard.local.json");

/** Rule lists for the host shell tier (HostBash(...) rules). */
export interface HostBashRules {
	allow?: string[];
	deny?: string[];
	ask?: string[];
}

export interface GuardConfig {
	/** Cycle hotkey; default "ctrl+alt+g" (pi-tool-permissions owns ctrl+alt+p). */
	cycleShortcut?: string;
	/** Extra top-level protected path names (added to the built-in list). */
	protectedPaths?: string[];
	/** Extra secret-mask filename patterns (added to the built-in list). */
	maskPatterns?: string[];
	/** Mask exceptions (per-project opt-outs, e.g. ".env.local"). */
	maskExceptions?: string[];
	/** web_fetch URL globs that are NOT exfil-capable (matched against the full URL). */
	webFetchAllow?: string[];
	/** HostBash(...) rules for the host shell tier. */
	hostBash?: HostBashRules;
	/** Read roots for the read-only tier's path containment. */
	readRoots?: string[];
	/** Writable roots for write/edit (default profile) and redirect exemptions. */
	writeRoots?: string[];
	/** Optional explicit classifier model pin; auto-select when absent. */
	classifier?: { provider: string; model: string };
	/** Free-text facts shown to the classifier. */
	classifierEnvironment?: string[];
	/** Additive natural-language classifier lists (on top of the defaults). */
	classifierAllow?: string[];
	classifierSoftDeny?: string[];
	classifierHardDeny?: string[];
	/** Per-command validator mapping ({ "duckdb": "readonly-duckdb" }; "none" disables). */
	bashValidators?: Record<string, string>;
	/** Tool-class overrides: exact names or globs to a ToolClass; beats the built-in map. */
	toolClasses?: Record<string, string>;
}

/** Fully merged, ready-to-use policy configuration. */
export interface ResolvedGuardConfig {
	cycleShortcut: string;
	protectedPaths: string[];
	maskPatterns: string[];
	maskExceptions: string[];
	webFetchAllow: string[];
	hostBash: Required<HostBashRules>;
	readRoots: string[];
	writeRoots: string[];
	classifier?: { provider: string; model: string };
	classifierEnvironment: string[];
	classifierAllow: string[];
	classifierSoftDeny: string[];
	classifierHardDeny: string[];
	bashValidators: Record<string, string>;
	toolClasses: Record<string, string>;
	/** The cwd the project scope was loaded against (tier path checks, rules). */
	cwd: string;
}

export function userConfigPath(home: string = homedir()): string {
	return join(home, ".pi", "agent", USER_CONFIG_REL);
}

export function projectConfigPath(cwd: string): string {
	return join(cwd, PROJECT_CONFIG_REL);
}

function readJsonSafe(path: string, warnings: string[]): GuardConfig | null {
	try {
		if (!existsSync(path)) return null;
		const raw = readFileSync(path, "utf8");
		const parsed = JSON.parse(raw);
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
			warnings.push(`${path}: top-level value must be an object; ignoring file`);
			return null;
		}
		return parsed as GuardConfig;
	} catch (err) {
		warnings.push(`${path}: failed to read (${(err as Error).message}); ignoring file`);
		return null;
	}
}

function writeJson(path: string, data: GuardConfig): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

export function loadUserConfigRaw(home: string = homedir(), warnings: string[] = []): GuardConfig {
	return readJsonSafe(userConfigPath(home), warnings) ?? {};
}

export function saveUserConfig(cfg: GuardConfig, home: string = homedir()): void {
	writeJson(userConfigPath(home), cfg);
}

export function loadProjectConfigRaw(cwd: string, warnings: string[] = []): GuardConfig {
	return readJsonSafe(projectConfigPath(cwd), warnings) ?? {};
}

export function saveProjectConfig(cwd: string, cfg: GuardConfig): void {
	writeJson(projectConfigPath(cwd), cfg);
}

/** Load both scopes (raw, unmerged); warnings go to console.warn. */
export function loadConfigRaws(cwd: string, home: string = homedir()): { user: GuardConfig; project: GuardConfig; warnings: string[] } {
	const warnings: string[] = [];
	const user = loadUserConfigRaw(home, warnings);
	const project = loadProjectConfigRaw(cwd, warnings);
	for (const w of warnings) console.warn(`[guard] ${w}`);
	return { user, project, warnings };
}

function stringList(value: unknown, warnings: string[], label: string): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
		warnings.push(`guard config: ${label} must be a list of strings; ignoring it`);
		return [];
	}
	return value as string[];
}

function coerceHostBash(raw: unknown, warnings: string[]): Required<HostBashRules> {
	if (raw === undefined) return { allow: [], deny: [], ask: [] };
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		warnings.push("guard config: hostBash must be an object; ignoring it");
		return { allow: [], deny: [], ask: [] };
	}
	const o = raw as HostBashRules;
	return {
		allow: stringList(o.allow, warnings, "hostBash.allow"),
		deny: stringList(o.deny, warnings, "hostBash.deny"),
		ask: stringList(o.ask, warnings, "hostBash.ask"),
	};
}

function coerceClassifierPin(raw: unknown, warnings: string[]): { provider: string; model: string } | undefined {
	if (raw === undefined) return undefined;
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		warnings.push("guard config: classifier must be an object { provider, model }; ignoring it");
		return undefined;
	}
	const o = raw as { provider?: unknown; model?: unknown };
	if (typeof o.provider !== "string" || typeof o.model !== "string" || !o.provider || !o.model) {
		warnings.push("guard config: classifier pin needs string provider and model; ignoring it");
		return undefined;
	}
	return { provider: o.provider, model: o.model };
}

function coerceValidators(raw: unknown, warnings: string[]): Record<string, string> | undefined {
	if (raw === undefined) return undefined;
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		warnings.push("guard config: bashValidators must be an object; ignoring it");
		return undefined;
	}
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
		if (typeof v !== "string") {
			warnings.push(`guard config: bashValidators.${k} must be a string; ignoring it`);
			continue;
		}
		out[k] = v;
	}
	return out;
}

function coerceToolClasses(raw: unknown, warnings: string[]): Record<string, string> | undefined {
	if (raw === undefined) return undefined;
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		warnings.push("guard config: toolClasses must be an object; ignoring it");
		return undefined;
	}
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
		if (!isToolClass(v)) {
			warnings.push(`guard config: toolClasses["${k}"] must be one of ${TOOL_CLASSES.join(", ")}; ignoring it`);
			continue;
		}
		const owned = OWNED_EXECUTORS.filter((name) => {
			try { return compilePattern(k).test(name); } catch { return false; }
		});
		if (owned.length) {
			warnings.push(`guard config: toolClasses["${k}"] cannot reclassify owned executors (${owned.join(", ")}); ignored for those names`);
			if (!k.includes("*") && !k.includes("?")) continue;
		}
		out[k] = v;
	}
	return out;
}

export function dedupe(items: string[]): string[] {
	return Array.from(new Set(items));
}

/**
 * Pure merge of user + project config into a ResolvedGuardConfig. Factored
 * from loadConfig so tests can exercise the merge without touching disk.
 */
export function mergeConfig(
	user: GuardConfig,
	project: GuardConfig,
	cwd: string,
	home: string = homedir(),
): ResolvedGuardConfig & { warnings: string[] } {
	const warnings: string[] = [];
	const cycleShortcut =
		typeof project.cycleShortcut === "string" && project.cycleShortcut
			? project.cycleShortcut
			: typeof user.cycleShortcut === "string" && user.cycleShortcut
				? user.cycleShortcut
				: "ctrl+alt+g";
	const validatorsRaw = { ...coerceValidators(user.bashValidators, warnings), ...coerceValidators(project.bashValidators, warnings) };
	// toolClasses: project wins per key; invalid classes are warned and ignored.
	const userClasses = coerceToolClasses(user.toolClasses, warnings) ?? {};
	const projectClasses = coerceToolClasses(project.toolClasses, warnings) ?? {};
	const toolClasses = { ...userClasses, ...projectClasses };
	// Built-in defaults sit at the bottom of the merge; entries set to the
	// "none" sentinel are stripped so any scope can disable a validator.
	const bashValidators = { ...DEFAULT_BASH_VALIDATORS, ...validatorsRaw };
	for (const [cmd, name] of Object.entries(bashValidators)) {
		if (name === BASH_VALIDATOR_NONE) delete bashValidators[cmd];
	}
	return {
		cycleShortcut,
		protectedPaths: dedupe([...stringList(user.protectedPaths, warnings, "protectedPaths"), ...stringList(project.protectedPaths, warnings, "protectedPaths")]),
		maskPatterns: dedupe([...stringList(user.maskPatterns, warnings, "maskPatterns"), ...stringList(project.maskPatterns, warnings, "maskPatterns")]),
		maskExceptions: dedupe([...stringList(user.maskExceptions, warnings, "maskExceptions"), ...stringList(project.maskExceptions, warnings, "maskExceptions")]),
		webFetchAllow: dedupe([...stringList(user.webFetchAllow, warnings, "webFetchAllow"), ...stringList(project.webFetchAllow, warnings, "webFetchAllow")]),
		hostBash: {
			allow: dedupe([...coerceHostBash(user.hostBash, warnings).allow, ...coerceHostBash(project.hostBash, warnings).allow]),
			deny: dedupe([...coerceHostBash(user.hostBash, warnings).deny, ...coerceHostBash(project.hostBash, warnings).deny]),
			ask: dedupe([...coerceHostBash(user.hostBash, warnings).ask, ...coerceHostBash(project.hostBash, warnings).ask]),
		},
		readRoots: dedupe([...stringList(user.readRoots, warnings, "readRoots"), ...stringList(project.readRoots, warnings, "readRoots")]),
		writeRoots: dedupe([...stringList(user.writeRoots, warnings, "writeRoots"), ...stringList(project.writeRoots, warnings, "writeRoots")]),
		classifier: coerceClassifierPin(project.classifier ?? user.classifier, warnings),
		classifierEnvironment: dedupe([...stringList(user.classifierEnvironment, warnings, "classifierEnvironment"), ...stringList(project.classifierEnvironment, warnings, "classifierEnvironment")]),
		classifierAllow: dedupe([...stringList(user.classifierAllow, warnings, "classifierAllow"), ...stringList(project.classifierAllow, warnings, "classifierAllow")]),
		classifierSoftDeny: dedupe([...stringList(user.classifierSoftDeny, warnings, "classifierSoftDeny"), ...stringList(project.classifierSoftDeny, warnings, "classifierSoftDeny")]),
		classifierHardDeny: dedupe([...stringList(user.classifierHardDeny, warnings, "classifierHardDeny"), ...stringList(project.classifierHardDeny, warnings, "classifierHardDeny")]),
		bashValidators,
		toolClasses,
		cwd,
		warnings,
	};
}

/** Resolved classifier config (defaults at the bottom, additive lists). */
export function resolvedClassifierConfig(cfg: ResolvedGuardConfig) {
	return {
		classifier: cfg.classifier,
		environment: cfg.classifierEnvironment,
		allow: dedupe([...DEFAULT_CLASSIFIER.allow, ...cfg.classifierAllow]),
		soft_deny: dedupe([...DEFAULT_CLASSIFIER.soft_deny, ...cfg.classifierSoftDeny]),
		hard_deny: dedupe([...DEFAULT_CLASSIFIER.hard_deny, ...cfg.classifierHardDeny]),
	};
}

/** Load and merge both scopes; warnings go to console.warn. */
export function loadConfig(cwd: string, home: string = homedir()): ResolvedGuardConfig {
	const { user, project } = loadConfigRaws(cwd, home);
	return mergeConfig(user, project, cwd, home);
}
