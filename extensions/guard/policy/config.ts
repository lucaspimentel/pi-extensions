/**
 * guard.json: user scope at ~/.pi/agent/guard.json, project scope at
 * <cwd>/.pi/guard.local.json (machine-local, not committed; mirrors the
 * pi-tool-permissions convention). All keys are optional; everything has a
 * built-in default. Corrupt or partially valid files fail safe: warn and use
 * defaults for the bad keys, never throw.
 *
 * Merge semantics (mirroring pi-tool-permissions): scalar keys project-wins
 * (discoveryMatchCap and discoveryTimeoutMs fall back project-valid, then
 * user-valid, then the built-in default); list keys (protectedPaths,
 * maskPatterns, maskExceptions, discoveryPruneNames, webFetchAllow,
 * classifierEnvironment, classifier NL lists, readRoots, writeRoots) unioned
 * with dedupe; discoveryPruneNames additionally drops built-in duplicates and
 * is sorted so reordering or duplication cannot change policy keys; hostBash
 * rule lists unioned per slot (deny > ask > allow is applied at decision time,
 * not merge time).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_BASH_VALIDATORS, BASH_VALIDATOR_NONE } from "./bashtier.ts";
import { DEFAULT_CLASSIFIER } from "./classifier.ts";
import { isToolClass, OWNED_EXECUTORS, TOOL_CLASSES } from "./classes.ts";
import { compilePattern } from "./rules.ts";
import {
	DEFAULT_MASK_EXCEPTIONS,
	DEFAULT_MASK_PATTERNS,
	SCAN_MATCH_CAP_DEFAULT,
	SCAN_PRUNE_NAMES,
	SCAN_TIMEOUT_MS_DEFAULT,
	isMaskedName,
} from "../sandbox/spec.ts";

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
	/** Extra prune basenames for the discovery scan (added to the built-in list). */
	discoveryPruneNames?: string[];
	/** Discovery scan match cap override (1..200000; default 500). */
	discoveryMatchCap?: number;
	/** Discovery scan timeout override in ms (1..600000; default 5000). */
	discoveryTimeoutMs?: number;
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
	discoveryPruneNames: string[];
	discoveryMatchCap: number;
	discoveryTimeoutMs: number;
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

/**
 * Persist an explicit classifier model pin into the user config, preserving
 * every sibling key. User scope only: guard's /guard model command has no
 * project-scope variant (unlike pi-tool-permissions), so there is no scope
 * argument to get wrong.
 */
export function setUserClassifierPin(provider: string, model: string, home: string = homedir()): void {
	const warnings: string[] = [];
	const cfg = loadUserConfigRaw(home, warnings);
	// A corrupt user config parses to an empty object: surface the parse
	// warning before the write below replaces the raw bytes with the pin.
	for (const w of warnings) console.warn(`[guard] ${w}`);
	cfg.classifier = { provider, model };
	saveUserConfig(cfg, home);
}

/**
 * Remove the classifier pin from the user config, leaving every other key in
 * place. Returns false when there was no pin: nothing is read-modify-written
 * and the file is left byte-for-byte unchanged.
 */
export function clearUserClassifierPin(home: string = homedir()): boolean {
	const warnings: string[] = [];
	const cfg = loadUserConfigRaw(home, warnings);
	for (const w of warnings) console.warn(`[guard] ${w}`);
	if (!cfg.classifier) return false;
	delete cfg.classifier;
	saveUserConfig(cfg, home);
	return true;
}

export function loadProjectConfigRaw(cwd: string, warnings: string[] = []): GuardConfig {
	return readJsonSafe(projectConfigPath(cwd), warnings) ?? {};
}

export function saveProjectConfig(cwd: string, cfg: GuardConfig): void {
	writeJson(projectConfigPath(cwd), cfg);
}

/**
 * The project-scope classifier pin, coerced exactly like mergeConfig (which
 * resolves classifier as project-wins over the user pin). Undefined when the
 * project config has no pin or an invalid one: in both cases the user pin or
 * auto-select stays effective. Diagnostic helper for the /guard model
 * notices; parse warnings are not surfaced here (loadConfig already reports
 * them on the reload that follows any write).
 */
export function projectClassifierPin(cwd: string): { provider: string; model: string } | undefined {
	return coerceClassifierPin(loadProjectConfigRaw(cwd).classifier, []);
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

const DISCOVERY_MATCH_CAP_MAX = 200_000;
const DISCOVERY_TIMEOUT_MS_MAX = 600_000;

/**
 * Coerce the extra discovery prune basenames. A prune name matches a basename
 * at any depth, so a path, a NUL, or a glob/negation metacharacter would make
 * the backend matchers (fd --exclude, find -name) behave unpredictably: such
 * entries are warned about and dropped, never passed through.
 */
function coerceDiscoveryPruneNames(value: unknown, warnings: string[], scope: string): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		warnings.push(`guard config: ${scope} discoveryPruneNames must be a list of strings; ignoring it`);
		return [];
	}
	const out: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") {
			warnings.push(`guard config: ${scope} discoveryPruneNames entries must be strings; ignoring ${JSON.stringify(item)}`);
			continue;
		}
		if (item === "" || item === "." || item === ".." || /[/\\\0*?\[\]{}]/.test(item) || item.startsWith("!")) {
			warnings.push(`guard config: ${scope} discoveryPruneNames["${item}"] must be a plain basename (no path separators, NUL, glob or negation metacharacters); ignoring it`);
			continue;
		}
		out.push(item);
	}
	return out;
}

/** Coerce a bounded integer; any non-integer, non-number, or out-of-range value is warned about and ignored. */
function coerceIntInRange(value: unknown, min: number, max: number, warnings: string[], label: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
		warnings.push(`guard config: ${label} must be an integer between ${min} and ${max}; ignoring it`);
		return undefined;
	}
	return value;
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
	// Discovery prune names: union across scopes, drop built-in duplicates (so a
	// built-in repeated in a config is not a deviation), and sort so reordering
	// or duplication cannot change policy keys or the weakening signature.
	const builtinPrune = new Set<string>(SCAN_PRUNE_NAMES);
	const discoveryPruneNames = dedupe([
		...coerceDiscoveryPruneNames(user.discoveryPruneNames, warnings, "user"),
		...coerceDiscoveryPruneNames(project.discoveryPruneNames, warnings, "project"),
	])
		.filter((name) => !builtinPrune.has(name))
		.sort();
	// Scalars: project-valid, then user-valid, then the built-in default; every
	// rejected value warns once and falls through to the next scope.
	const discoveryMatchCap =
		coerceIntInRange(project.discoveryMatchCap, 1, DISCOVERY_MATCH_CAP_MAX, warnings, "discoveryMatchCap") ??
		coerceIntInRange(user.discoveryMatchCap, 1, DISCOVERY_MATCH_CAP_MAX, warnings, "discoveryMatchCap") ??
		SCAN_MATCH_CAP_DEFAULT;
	const discoveryTimeoutMs =
		coerceIntInRange(project.discoveryTimeoutMs, 1, DISCOVERY_TIMEOUT_MS_MAX, warnings, "discoveryTimeoutMs") ??
		coerceIntInRange(user.discoveryTimeoutMs, 1, DISCOVERY_TIMEOUT_MS_MAX, warnings, "discoveryTimeoutMs") ??
		SCAN_TIMEOUT_MS_DEFAULT;
	return {
		cycleShortcut,
		protectedPaths: dedupe([...stringList(user.protectedPaths, warnings, "protectedPaths"), ...stringList(project.protectedPaths, warnings, "protectedPaths")]),
		maskPatterns: dedupe([...stringList(user.maskPatterns, warnings, "maskPatterns"), ...stringList(project.maskPatterns, warnings, "maskPatterns")]),
		maskExceptions: dedupe([...stringList(user.maskExceptions, warnings, "maskExceptions"), ...stringList(project.maskExceptions, warnings, "maskExceptions")]),
		discoveryPruneNames,
		discoveryMatchCap,
		discoveryTimeoutMs,
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

/** Names whose nested-protection discovery a prune name would silently drop. */
const DISCOVERY_PROTECTED_COLLISIONS: readonly string[] = ["AGENTS.md", "CLAUDE.md", ".envrc", ".git"];

/**
 * Warnings for prune names that collide with protection discovery: a protected
 * nested name, or a name the effective mask patterns would otherwise mask.
 * Worded in basename terms because pruning matches basenames. Surfaced through
 * the one-time weakening notice and /guard list, never through mergeConfig's
 * warnings.
 */
export function discoveryCollisionWarnings(
	pruneNames: readonly string[],
	patterns: readonly string[],
	exceptions: readonly string[],
): string[] {
	const warnings: string[] = [];
	for (const name of pruneNames) {
		if (DISCOVERY_PROTECTED_COLLISIONS.includes(name)) {
			warnings.push(`discoveryPruneNames["${name}"] drops nested-protection discovery for every entry whose basename is "${name}" (basename matching); the prune name still applies`);
			continue;
		}
		if (isMaskedName(name, patterns, exceptions)) {
			warnings.push(`discoveryPruneNames["${name}"] matches the secret-mask patterns (basename matching); files with this basename are not discovered, so they are not masked`);
		}
	}
	return warnings;
}

/** The effective pattern/exception sets a discovery collision check must use. */
function effectiveMaskSets(cfg: ResolvedGuardConfig): { patterns: string[]; exceptions: string[] } {
	return {
		patterns: [...DEFAULT_MASK_PATTERNS, ...cfg.maskPatterns],
		exceptions: [...DEFAULT_MASK_EXCEPTIONS, ...cfg.maskExceptions],
	};
}

/** Collision warnings for a resolved config, using its effective mask sets. */
export function discoveryCollisionWarningsFor(cfg: ResolvedGuardConfig): string[] {
	const { patterns, exceptions } = effectiveMaskSets(cfg);
	return discoveryCollisionWarnings([...cfg.discoveryPruneNames].sort(), patterns, exceptions);
}

/**
 * A stable signature of the discovery settings that weaken the fail-closed
 * defaults, or null when nothing is weakened (no extras, and cap and timeout at
 * or below their defaults). Drives the one-time notice; never read by
 * enforcement.
 */
export function discoveryWeakeningSignature(cfg: ResolvedGuardConfig): string | null {
	const extras = [...cfg.discoveryPruneNames].sort();
	const capDelta = Math.max(0, cfg.discoveryMatchCap - SCAN_MATCH_CAP_DEFAULT);
	const timeoutDelta = Math.max(0, cfg.discoveryTimeoutMs - SCAN_TIMEOUT_MS_DEFAULT);
	if (extras.length === 0 && capDelta === 0 && timeoutDelta === 0) return null;
	return JSON.stringify([extras, capDelta, timeoutDelta]);
}

/**
 * The one-time warning text for weakened discovery settings, or null when the
 * settings are the built-in defaults. Names the extra prune basenames, the
 * raised cap and timeout with their defaults, and any collision.
 */
export function discoveryNoticeText(cfg: ResolvedGuardConfig): string | null {
	const extras = [...cfg.discoveryPruneNames].sort();
	const capRaised = cfg.discoveryMatchCap > SCAN_MATCH_CAP_DEFAULT;
	const timeoutRaised = cfg.discoveryTimeoutMs > SCAN_TIMEOUT_MS_DEFAULT;
	if (extras.length === 0 && !capRaised && !timeoutRaised) return null;
	const lines = ["guard: workspace discovery settings differ from the fail-closed defaults."];
	if (extras.length) {
		lines.push(`  extra prune basenames: ${extras.join(", ")} (entries with these basenames, files and directories, are not discovered at any depth; secrets under them are not masked)`);
	}
	if (capRaised) lines.push(`  discoveryMatchCap: ${cfg.discoveryMatchCap} (default ${SCAN_MATCH_CAP_DEFAULT})`);
	if (timeoutRaised) lines.push(`  discoveryTimeoutMs: ${cfg.discoveryTimeoutMs} ms (default ${SCAN_TIMEOUT_MS_DEFAULT})`);
	for (const warning of discoveryCollisionWarningsFor(cfg)) lines.push(`  warning: ${warning}`);
	return lines.join("\n");
}

/** Load and merge both scopes; warnings go to console.warn. */
export function loadConfig(cwd: string, home: string = homedir()): ResolvedGuardConfig {
	const { user, project } = loadConfigRaws(cwd, home);
	return mergeConfig(user, project, cwd, home);
}
