/**
 * Pure/testable logic for the tool-permissions extension: config load/merge,
 * rule parsing and matching, bash command analysis, compound-command
 * decisions, and the auto-mode classifier helpers.
 *
 * This module must never gain a *value* import from
 * `@earendil-works/pi-coding-agent` or `@earendil-works/pi-ai`: keeping it
 * free of pi-runtime imports is what lets the test suites (via
 * `test-helpers.mjs`) import it with `node --experimental-strip-types`
 * without loading the 848-line runtime glue. Type-only imports from `pi-ai`
 * (`Model`, `Api`, `Context`, `AssistantMessage`) are fine. The
 * pi-runtime glue (event handlers, prompts, slash commands) lives in
 * `index.ts`, which imports everything it needs from here.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";
import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import {
	dedupeModels,
	hasPrice,
	modelCostScore,
	modelLabel,
	pickableModels,
	rankModels,
	selectModel,
	type HasAuth,
} from "../shared/model-selection.ts";

export type Action = "allow" | "deny" | "ask" | "auto";

/** The three persistable rule-list actions (auto is not a rule list). */
export type ListAction = "allow" | "deny" | "ask";

/**
 * Persistable `defaultAction` values. `"auto"` is NOT a valid default — auto
 * mode is a session-only layer between `toolDefaults` and `defaultAction`,
 * controlled by the `/permissions auto` toggle. `Action` still includes
 * `"auto"` because `decide()` returns it as a sentinel ("reached the auto
 * layer — handler should classify") when the session toggle is on.
 */
export type DefaultAction = "allow" | "deny" | "ask";

/**
 * Natural-language rules and model selection for the auto-mode layer.
 * When no static rule or `toolDefaults` entry matches and the session toggle
 * is on, a cheap/fast classifier model screens the action against these NL
 * lists and returns a verdict (allow / soft_deny / hard_deny / no-match).
 * See `docs/auto-mode-design.md` for the full design.
 */
export interface AutoModeConfig {
	/** Explicit classifier model pin. If omitted, one is selected from the available pool. */
	classifier?: { provider: string; model: string };
	/** Free-text environment facts shown to the classifier (e.g. "Trusted repo: ..."). */
	environment?: string[];
	/** NL descriptions of actions to silently allow. */
	allow?: string[];
	/** NL descriptions of actions to prompt for (with the classifier's reason). */
	soft_deny?: string[];
	/** NL descriptions of actions to always block. */
	hard_deny?: string[];
	/** When true, route every bash command (incl. read-only auto-allowed ones) through the classifier. For compounds with no static `ask`/`deny` sub, the *whole* compound is classified as one command; otherwise each sub is classified individually. */
	classifyAllShell?: boolean;
}

/** Resolved auto-mode config after merging user + project: arrays are guaranteed present. */
export interface ResolvedAutoModeConfig {
	classifier?: { provider: string; model: string };
	environment: string[];
	allow: string[];
	soft_deny: string[];
	hard_deny: string[];
	classifyAllShell: boolean;
}

export interface PermissionsConfig {
	defaultAction?: DefaultAction;
	allow?: string[];
	deny?: string[];
	ask?: string[];
	autoMode?: AutoModeConfig;
	/** Per-tool fallback actions, evaluated between allow and defaultAction. */
	toolDefaults?: Record<string, string>;
	/** When false, disables the implicit Read(<cwd>/**) allow rule. Default: true. */
	readAllowCwd?: boolean;
	/** When false, disables the implicit Grep(<cwd>/**) allow rule. Default: true. */
	grepAllowCwd?: boolean;
	/** When false, disables the implicit Glob(<cwd>/**) allow rule. Default: true. */
	globAllowCwd?: boolean;
	/** When false, disables the implicit Ls(<cwd>/**) allow rule. Default: true. */
	lsAllowCwd?: boolean;
	/** When false, disables the implicit Read/Ls/Glob/Grep rules covering pi's skill roots. Default: true. */
	readAllowSkills?: boolean;
	/** When false, disables the implicit Read/Ls/Glob/Grep rules covering pi's bundled docs package. Default: true. */
	readAllowPiDocs?: boolean;
	/** When false, disables the implicit exact-path Read rules for AGENTS.md / CLAUDE.md in cwd and ancestor directories. Default: true. */
	readAllowAgentDocs?: boolean;
	/** When false, disables the implicit allow for read-only bash commands in cwd. Default: true. */
	bashReadOnlyAllowCwd?: boolean;
	/** When false, disables the implicit allow for pure shell variable assignments. Default: true. */
	bashAllowPureVarAssign?: boolean;
	/** When false, disables the implicit allow for no-op `cd` commands. Default: true. */
	allowNoopCd?: boolean;
}

export interface ResolvedConfig {
	defaultAction: DefaultAction;
	allow: string[];
	deny: string[];
	ask: string[];
	/** Per-tool fallback actions, checked after allow and before defaultAction. */
	toolDefaults: Record<string, Action>;
	/** The working directory this config was loaded for. */
	cwd: string;
	/** When true, no-op `cd` commands (cd to cwd) are silently allowed. */
	allowNoopCd: boolean;
	/** When true, read-only bash subcommands with paths inside cwd are silently allowed. */
	bashReadOnlyAllowCwd: boolean;
	/** When true, pure shell variable assignments (no command/process/arithmetic substitution) are silently allowed. */
	bashAllowPureVarAssign: boolean;
	/** Resolved auto-mode config (merged user + project). Always present; used when the session auto toggle is on. */
	autoMode: ResolvedAutoModeConfig;
	/** Tracks synthetically injected rules/defaults (never written to disk). */
	implicit: {
		allow: string[];
		toolDefaults: Record<string, Action>;
		readAllowCwd: boolean;
		grepAllowCwd: boolean;
		globAllowCwd: boolean;
		lsAllowCwd: boolean;
		readAllowSkills: boolean;
		readAllowPiDocs: boolean;
		readAllowAgentDocs: boolean;
		bashReadOnlyAllowCwd: boolean;
		bashAllowPureVarAssign: boolean;
		allowNoopCd: boolean;
	};
}

// Project config: prefer the `.local.json` suffix (machine-local, not checked
// into git). Two legacy filenames are still read as fallbacks and auto-migrated
// to the new path on next save.
export const PROJECT_CONFIG_REL = join(".pi", "pi-tool-permissions.local.json");
export const LEGACY_PROJECT_CONFIG_REL = join(".pi", "pi-tool-permissions.json");
export const LEGACY2_PROJECT_CONFIG_REL = join(".pi", "tool-permissions.json");

// User config paths, parameterized by `home` so tests can exercise the
// load/save/migration logic against a temp directory.
export function userConfigPath(home: string = homedir()): string {
	return join(home, ".pi", "agent", "pi-tool-permissions.json");
}
export function legacyUserConfigPath(home: string = homedir()): string {
	return join(home, ".pi", "tool-permissions.json");
}

/**
 * Sane default NL rules for the auto-mode layer, used when the user omits
 * the corresponding field. Always prepended to user/project lists (additive —
 * user config adds on top, never replaces). `classifier` (auto-select) and
 * `environment` (empty) have no defaults — they are inherently user-specific.
 */
export const DEFAULT_AUTO_MODE = {
	allow: [
		"Running tests and linters",
		"Editing files in a source-controlled repository (changes are reversible via git)",
		"Read-only inspection commands (e.g. pwd, ls, cat, head, tail, wc, stat, file, du, df)",
		"Searching the codebase with grep, rg, find, or glob",
		"Running git status, git diff, git log, and other read-only git queries",
		"Staging changes and creating a local git commit (e.g. git add, git commit, git stash) — local-only and easily reversible via git reset/git reflog; pushing is handled separately",
		"Creating or switching local git branches or tags (e.g. git switch -c, git checkout -b, git branch, git tag)",
		"Read-only GitHub API requests (e.g. fetching files, listing issues, reading repos) via gh or the web API",
		"Read-only GitHub API call to fetch a file, not sending data or modifying remote state",
		"Read-only Atlassian API call to fetch a Jira issue",
		"Read-only Atlassian API call to fetch a Confluence page",
		"Read-only Confluence search query using CQL",
		"Assigns a string to a variable, no side effects",
		"Executes a no-op command that does nothing",
		"Read-only HTTP GET request to a public package registry (e.g. crates.io, npm, NuGet, PyPI, Maven Central, pkg.go.dev) to look up published versions or package metadata, not sending data or modifying remote state",
		"Fetching a public URL with curl or wget and parsing the response locally (e.g. with jq), in a loop or pipeline, without submitting data or writing files",
	],
	soft_deny: [
		"Force pushing, deleting remote branches",
		"Pushing commits to a remote (e.g. git push), publishing local work to a shared remote",
		"Rewriting git history or discarding work (e.g. git rebase, git commit --amend, git reset --hard, git filter-branch, git push --force, deleting branches or stashes)",
		"Bulk or recursive file deletions (e.g. rm -rf, rm -r, Remove-Item -Recurse)",
		"Editing a file outside a source-controlled repository",
		"Creating a pull request or pushing a branch on GitHub via gh, modifying remote state",
	],
	hard_deny: [
		"Sending data to third-party APIs or external services for telemetry, analytics, or exfiltration (not normal GitHub dev actions like opening PRs or pushing branches via gh)",
	],
	classifyAllShell: true,
};

function readJsonSafe(path: string): PermissionsConfig | null {
	try {
		if (!existsSync(path)) return null;
		const raw = readFileSync(path, "utf8");
		return JSON.parse(raw) as PermissionsConfig;
	} catch (err) {
		console.warn(`[tool-permissions] Failed to read ${path}: ${(err as Error).message}`);
		return null;
	}
}

function writeJson(path: string, data: PermissionsConfig): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}


export function loadUserConfigRaw(home: string = homedir()): PermissionsConfig {
	return readJsonSafe(userConfigPath(home)) ?? readJsonSafe(legacyUserConfigPath(home)) ?? {};
}

export function saveUserConfig(cfg: PermissionsConfig, home: string = homedir()): void {
	writeJson(userConfigPath(home), cfg);
	// Auto-migrate: drop the legacy user file once the new file is written.
	const legacy = legacyUserConfigPath(home);
	if (existsSync(legacy)) {
		try {
			rmSync(legacy);
		} catch (err) {
			console.warn(`[tool-permissions] Could not remove legacy user config ${legacy}: ${(err as Error).message}`);
		}
	}
}


export function loadConfig(cwd: string): ResolvedConfig {
	const user = loadUserConfigRaw();
	const project = loadProjectConfigRaw(cwd);
	return mergeConfig(user, project, cwd, homedir());
}

/**
 * Pure merge of user + project config objects into a ResolvedConfig. Factored
 * from loadConfig so tests can exercise the merge logic without touching disk.
 * `home` is used to expand the readAllowSkills / readAllowPiDocs globs.
 */
export function mergeConfig(
	user: PermissionsConfig,
	project: PermissionsConfig,
	cwd: string,
	home: string,
): ResolvedConfig {
	const allow = dedupe([...(user.allow ?? []), ...(project.allow ?? [])]);
	const deny  = dedupe([...(user.deny  ?? []), ...(project.deny  ?? [])]);
	const ask   = dedupe([...(user.ask   ?? []), ...(project.ask   ?? [])]);

	// Merge explicit toolDefaults — project overrides user, keys normalized
	const explicitToolDefaults: Record<string, Action> = {
		...normalizeToolDefaultsKeys(user.toolDefaults ?? {}),
		...normalizeToolDefaultsKeys(project.toolDefaults ?? {}),
	};

	// ── Implicit defaults (session-only, never persisted) ──────────────────
	const readAllowCwd = project.readAllowCwd ?? user.readAllowCwd ?? true;
	const grepAllowCwd = project.grepAllowCwd ?? user.grepAllowCwd ?? true;
	const globAllowCwd = project.globAllowCwd ?? user.globAllowCwd ?? true;
	const lsAllowCwd = project.lsAllowCwd ?? user.lsAllowCwd ?? true;
	const readAllowSkills = project.readAllowSkills ?? user.readAllowSkills ?? true;
	const readAllowPiDocs = project.readAllowPiDocs ?? user.readAllowPiDocs ?? true;
	const readAllowAgentDocs = project.readAllowAgentDocs ?? user.readAllowAgentDocs ?? true;
	const bashReadOnlyAllowCwd = project.bashReadOnlyAllowCwd ?? user.bashReadOnlyAllowCwd ?? true;
	const bashAllowPureVarAssign = project.bashAllowPureVarAssign ?? user.bashAllowPureVarAssign ?? true;
	const allowNoopCd = project.allowNoopCd ?? user.allowNoopCd ?? true;
	const implicitAllow: string[] = [];
	if (readAllowCwd) {
		implicitAllow.push(`Read(${cwdGlobPattern(cwd)})`);
	}
	if (grepAllowCwd) {
		implicitAllow.push(`Grep(${cwdGlobPattern(cwd)})`);
	}
	if (globAllowCwd) {
		implicitAllow.push(`Glob(${cwdGlobPattern(cwd)})`);
	}
	if (lsAllowCwd) {
		implicitAllow.push(`Ls(${cwdGlobPattern(cwd)})`);
	}
	if (home && readAllowSkills) {
		for (const glob of skillReadGlobs(home)) {
			for (const tool of READONLY_PATH_TOOLS) {
				implicitAllow.push(`${tool}(${glob})`);
			}
		}
	}
	if (home && readAllowPiDocs) {
		for (const glob of piDocsReadGlobs(home)) {
			for (const tool of READONLY_PATH_TOOLS) {
				implicitAllow.push(`${tool}(${glob})`);
			}
		}
	}
	if (readAllowAgentDocs) {
		implicitAllow.push(...agentDocsReadRules(cwd));
	}

	// Inject write→ask unless the user has explicitly set toolDefaults.write
	const implicitToolDefaults: Record<string, Action> = {};
	if (explicitToolDefaults["write"] === undefined) {
		implicitToolDefaults["write"] = "ask";
	}

	// ── Auto-mode config (merged user + project) ──────────────────────────
	// `classifier` is a single pin: project wins. NL lists concatenate like
	// allow/deny/ask. `classifyAllShell` defaults to false; project wins.
	const userAuto = user.autoMode ?? {};
	const projectAuto = project.autoMode ?? {};
	const autoMode: ResolvedAutoModeConfig = {
		classifier: projectAuto.classifier ?? userAuto.classifier,
		environment: dedupe([...(userAuto.environment ?? []), ...(projectAuto.environment ?? [])]),
		allow: dedupe([...DEFAULT_AUTO_MODE.allow, ...(userAuto.allow ?? []), ...(projectAuto.allow ?? [])]),
		soft_deny: dedupe([...DEFAULT_AUTO_MODE.soft_deny, ...(userAuto.soft_deny ?? []), ...(projectAuto.soft_deny ?? [])]),
		hard_deny: dedupe([...DEFAULT_AUTO_MODE.hard_deny, ...(userAuto.hard_deny ?? []), ...(projectAuto.hard_deny ?? [])]),
		classifyAllShell: projectAuto.classifyAllShell ?? userAuto.classifyAllShell ?? DEFAULT_AUTO_MODE.classifyAllShell,
	};

	return {
		defaultAction: coerceDefaultAction(project.defaultAction ?? user.defaultAction ?? "ask"),
		allow: [...implicitAllow, ...allow],
		deny,
		ask,
		toolDefaults: { ...implicitToolDefaults, ...explicitToolDefaults },
		cwd,
		allowNoopCd,
		bashReadOnlyAllowCwd,
		bashAllowPureVarAssign,
		autoMode,
		implicit: { allow: implicitAllow, toolDefaults: implicitToolDefaults, readAllowCwd, grepAllowCwd, globAllowCwd, lsAllowCwd, readAllowSkills, readAllowPiDocs, readAllowAgentDocs, bashReadOnlyAllowCwd, bashAllowPureVarAssign, allowNoopCd },
	};
}

export function dedupe(items: string[]): string[] {
	return Array.from(new Set(items));
}

/**
 * Coerce a raw `defaultAction` value from config into a valid `DefaultAction`.
 * `"auto"` is no longer a persistable default (auto mode is now a session-only
 * layer controlled by the `/permissions auto` toggle); legacy configs that
 * still set it are coerced to `"ask"` (safe) with a warning.
 */
export function coerceDefaultAction(raw: unknown): DefaultAction {
	if (raw === "allow" || raw === "deny" || raw === "ask") return raw;
	if (raw === "auto") {
		console.warn('[tool-permissions] defaultAction: "auto" is no longer a valid default — auto mode is now controlled by the /permissions auto toggle. Coercing to "ask".');
		return "ask";
	}
	return "ask";
}

export function projectConfigPath(cwd: string): string {
	return join(cwd, PROJECT_CONFIG_REL);
}

export function legacyProjectConfigPath(cwd: string): string {
	return join(cwd, LEGACY_PROJECT_CONFIG_REL);
}

export function legacy2ProjectConfigPath(cwd: string): string {
	return join(cwd, LEGACY2_PROJECT_CONFIG_REL);
}

export function loadProjectConfigRaw(cwd: string): PermissionsConfig {
	return readJsonSafe(projectConfigPath(cwd))
		?? readJsonSafe(legacyProjectConfigPath(cwd))
		?? readJsonSafe(legacy2ProjectConfigPath(cwd))
		?? {};
}

export function saveProjectConfig(cwd: string, cfg: PermissionsConfig): void {
	writeJson(projectConfigPath(cwd), cfg);
	// Auto-migrate: remove any legacy files now that the new file is written.
	for (const legacyPath of [legacyProjectConfigPath(cwd), legacy2ProjectConfigPath(cwd)]) {
		if (existsSync(legacyPath)) {
			try {
				rmSync(legacyPath);
			} catch (err) {
				console.warn(`[tool-permissions] Could not remove legacy project config ${legacyPath}: ${(err as Error).message}`);
			}
		}
	}
}

// ── Tool name groupings ──────────────────────────────────────────────────────

/**
 * Read-only path-based tools that benefit from the readAllowSkills / readAllowPiDocs
 * implicit allow rules. When the agent has read-only access to a docs/skills tree
 * it also needs to list, glob, and grep that tree to navigate it, so all four tools
 * receive matching implicit rules. Write/Edit are deliberately excluded.
 */
const READONLY_PATH_TOOLS = ["Read", "Ls", "Glob", "Grep"] as const;

// ── Path helpers ──────────────────────────────────────────────────────────────

export interface PathNormalizationOptions {
	/** Environment used to detect Git Bash, MSYS, or Cygwin. Defaults to process.env. */
	env?: Readonly<Record<string, string | undefined>>;
	/** Home directory used to expand bare `~` and `~/...`. Defaults to HOME or homedir(). */
	home?: string;
}

function isWindowsPosixShell(env: Readonly<Record<string, string | undefined>>): boolean {
	const msystem = (env.MSYSTEM ?? "").toUpperCase();
	const ostype = (env.OSTYPE ?? "").toLowerCase();
	return msystem === "MSYS"
		|| msystem.startsWith("MINGW")
		|| msystem.startsWith("UCRT")
		|| msystem.startsWith("CLANG")
		|| msystem.startsWith("CYGWIN")
		|| ostype.startsWith("msys")
		|| ostype.startsWith("cygwin");
}

function normalizeDrivePrefix(p: string, windowsPosixShell: boolean): string {
	let normalized = p;
	if (windowsPosixShell) {
		const cygwinDrive = normalized.match(/^\/cygdrive\/([A-Za-z])(?:\/(.*))?$/i);
		const msysDrive = normalized.match(/^\/([A-Za-z])(?:\/(.*))?$/);
		const match = cygwinDrive ?? msysDrive;
		if (match) normalized = `${match[1].toUpperCase()}:/${match[2] ?? ""}`;
	}
	return normalized.replace(/^([A-Za-z]):(?=\/|$)/, (_, drive: string) => `${drive.toUpperCase()}:`);
}

function trimTrailingPathSeparators(p: string): string {
	if (p === "/" || /^[A-Za-z]:\/$/.test(p)) return p;
	return p.replace(/\/+$/, "");
}

function isWindowsAbsolutePath(p: string): boolean {
	return /^[A-Za-z]:\//.test(p) || p.startsWith("//");
}

function canonicalizeAbsolutePath(p: string): string {
	if (isWindowsAbsolutePath(p)) return trimTrailingPathSeparators(win32.normalize(p).replace(/\\/g, "/"));
	if (p.startsWith("/")) return trimTrailingPathSeparators(posix.normalize(p));
	return trimTrailingPathSeparators(p);
}

/**
 * Normalize path spelling for permission comparisons and saved rules.
 * In Git Bash, MSYS, or Cygwin, this also expands `~` and converts POSIX drive
 * prefixes such as `/c/...` and `/cygdrive/c/...` to `C:/...` without spawning
 * `cygpath`. Outside those environments, POSIX paths such as `/c/...` are kept.
 */
export function normalizePathSep(p: string, options: PathNormalizationOptions = {}): string {
	const env = options.env ?? process.env;
	const windowsPosixShell = isWindowsPosixShell(env);
	let normalized = p.replace(/\\/g, "/");
	if (windowsPosixShell && (normalized === "~" || normalized.startsWith("~/"))) {
		const rawHome = options.home ?? env.HOME ?? homedir();
		const home = normalizeDrivePrefix(rawHome.replace(/\\/g, "/"), true).replace(/\/+$/, "");
		normalized = home + normalized.slice(1);
	}
	return normalizeDrivePrefix(normalized, windowsPosixShell);
}

/**
 * Normalize a path for permission matching only, never for actual tool execution.
 * Resolves relative paths against cwd with Windows semantics for drive paths and
 * POSIX semantics otherwise, then removes dot segments for safe containment checks.
 */
export function normalizeMatchPath(p: string, cwd: string, options: PathNormalizationOptions = {}): string {
	if (!p) return p;
	const normalized = normalizePathSep(p, options);
	const cwdNormalized = normalizePathSep(cwd, options);
	if (isWindowsAbsolutePath(normalized) || normalized.startsWith("/")) {
		return canonicalizeAbsolutePath(normalized);
	}
	const resolved = isWindowsAbsolutePath(cwdNormalized)
		? win32.resolve(cwdNormalized, normalized).replace(/\\/g, "/")
		: posix.resolve(cwdNormalized, normalized);
	return canonicalizeAbsolutePath(normalizePathSep(resolved, options));
}

/** Returns the glob pattern that matches cwd and all its descendants. */
export function cwdGlobPattern(cwd: string, options: PathNormalizationOptions = {}): string {
	const normalized = canonicalizeAbsolutePath(normalizePathSep(cwd, options));
	const base = normalized === "/" ? "" : normalized.replace(/\/+$/, "");
	return `${base}/**`;
}

/**
 * Returns the exact-path Read rules for AGENTS.md and CLAUDE.md in cwd and every
 * ancestor directory up to the filesystem root. Used by the readAllowAgentDocs
 * implicit default so the agent can read project instruction files that live
 * above cwd without prompting (they fall outside the Read(<cwd>/**) glob).
 * Copies in child directories need no extra rules: Read(<cwd>/**) already covers
 * them. Exact paths only (no globs), so unrelated files in parent directories
 * are unaffected. Rules are Read-only: Write/Edit still go through the normal
 * permission flow.
 *
 * Purely string-based (no node:path resolve/dirname) so it behaves identically
 * on Windows and POSIX and accepts synthetic absolute paths in tests. Handles
 * Windows drive roots ("C:/"), the POSIX root ("/"), trailing-slash inputs, and
 * backslash separators. A relative cwd degrades gracefully: string ancestors
 * are walked until none remain. Drive roots are normalized to the slashed form
 * ("C:" → "C:/") so no bare-drive or malformed entries are emitted.
 */
export function agentDocsReadRules(cwd: string): string[] {
	const rules: string[] = [];
	const seen = new Set<string>();
	// Emit both doc rules for a directory given WITHOUT a trailing slash, so
	// the POSIX root is "" (→ Read(/AGENTS.md)) and a drive root is "C:"
	// (→ Read(C:/AGENTS.md)) with no doubled slashes.
	const pushDir = (dir: string) => {
		for (const name of ["AGENTS.md", "CLAUDE.md"]) {
			const rule = `Read(${dir}/${name})`;
			if (!seen.has(rule)) {
				seen.add(rule);
				rules.push(rule);
			}
		}
	};
	let dir = normalizePathSep(cwd);
	while (true) {
		if (dir === "/") {
			pushDir("");
			break;
		}
		if (/^[A-Za-z]:$/.test(dir) || /^[A-Za-z]:\/$/.test(dir)) {
			pushDir(dir.replace(/\/$/, ""));
			break;
		}
		dir = dir.replace(/\/+$/, "");
		pushDir(dir);
		const idx = dir.lastIndexOf("/");
		if (idx < 0) break; // relative path with no further string ancestors
		dir = dir.slice(0, idx) || "/";
	}
	return rules;
}

/**
 * Returns the canonical list of glob patterns covering pi's known skill roots,
 * relative to the given home directory. Used by the readAllowSkills implicit
 * default to silently permit reading SKILL.md and related files outside cwd.
 *
 * Roots covered (per pi docs/skills.md):
 *   ~/.pi/agent/skills/**           — user-global pi skills
 *   ~/.pi/agent/git/**\/skills/**   — skills inside cloned skill repos
 *   ~/.agents/skills/**             — alternate user-global skill location
 */
export function skillReadGlobs(home: string): string[] {
	const h = normalizePathSep(home);
	return [
		`${h}/.pi/agent/skills/**`,
		`${h}/.pi/agent/git/**/skills/**`,
		`${h}/.agents/skills/**`,
	];
}

/**
 * Returns the canonical list of glob patterns covering pi's bundled documentation
 * package, relative to the given home directory. Used by the readAllowPiDocs implicit
 * default to silently permit reading pi's README and docs files outside cwd.
 *
 * Roots covered (common npm install layouts):
 *   <home>/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/**  — Windows global npm
 *   <home>/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/**      — npm prefix ~/.npm-global
 *   <home>/.nvm/versions/node/*\/lib/node_modules/@earendil-works/pi-coding-agent/**  — nvm
 *   <home>/.volta/tools/image/node/*\/lib/node_modules/@earendil-works/pi-coding-agent/**  — volta
 *   <home>/.local/share/npm/lib/node_modules/@earendil-works/pi-coding-agent/**  — XDG-style npm
 *   <home>/Library/Application Support/npm/lib/node_modules/@earendil-works/pi-coding-agent/**  — macOS
 *
 * Note: system-wide install paths (/usr/local/lib/..., /usr/lib/...) are not
 * covered here as they are not relative to the home directory.
 */
export function piDocsReadGlobs(home: string): string[] {
	const h = normalizePathSep(home);
	return [
		`${h}/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/**`,
		`${h}/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/**`,
		`${h}/.nvm/versions/node/*/lib/node_modules/@earendil-works/pi-coding-agent/**`,
		`${h}/.volta/tools/image/node/*/lib/node_modules/@earendil-works/pi-coding-agent/**`,
		`${h}/.local/share/npm/lib/node_modules/@earendil-works/pi-coding-agent/**`,
		`${h}/Library/Application Support/npm/lib/node_modules/@earendil-works/pi-coding-agent/**`,
	];
}

/**
 * Returns true when `cmd` is a `cd` invocation whose destination resolves to
 * the current working directory — i.e. the command is a no-op in terms of
 * changing directory.  Explicit deny rules in decide() are checked before this
 * function is consulted, so deny rules always win.
 *
 * Recognised no-op forms:
 *   cd .          cd ./         cd $PWD        cd ${PWD}
 *   cd ~+         cd <absolute-or-relative path that equals cwd>
 *
 * Bare `cd` (no argument) navigates to $HOME, not cwd, so it is NOT matched.
 * Arguments containing unrecognised shell metacharacters are rejected for safety.
 */
export function isNoopCd(cmd: string, cwd: string, options: PathNormalizationOptions = {}): boolean {
	const trimmed = cmd.trim();
	if (!/^cd(\s|$)/.test(trimmed)) return false;

	let arg = trimmed.slice(2).trim();

	// Strip a single pair of surrounding single or double quotes
	if (
		arg.length >= 2 &&
		((arg[0] === "'" && arg[arg.length - 1] === "'") ||
			(arg[0] === '"' && arg[arg.length - 1] === '"'))
	) {
		arg = arg.slice(1, -1).trim();
	}

	// Bare `cd` → goes to HOME, not cwd
	if (!arg) return false;

	// Well-known symbolic references to cwd (checked before metachar rejection)
	if (arg === "." || arg === "./" || arg === "$PWD" || arg === "${PWD}" || arg === "~+") return true;

	// Reject if the argument contains shell metacharacters not already handled above
	if (/[`$(){}|&;<>]/.test(arg)) return false;

	// Resolve the destination and cwd through the same canonicalizer so Windows,
	// MSYS, Cygwin, tilde, and mixed-separator spellings compare consistently.
	try {
		const resolved = normalizeMatchPath(arg, cwd, options);
		const cwdNormalized = normalizeMatchPath(".", cwd, options);
		if (isWindowsAbsolutePath(cwdNormalized)) {
			return resolved.toLowerCase() === cwdNormalized.toLowerCase();
		}
		return resolved === cwdNormalized;
	} catch {
		return false;
	}
}

/**
 * Bash subcommand names that are read-only and never touch the filesystem
 * meaningfully — safe to auto-allow regardless of arguments.
 */
const READONLY_BASH_SAFE_ALWAYS = new Set([
	"test", "[", "[[",
	"pwd", "echo", "printf", "date", "whoami", "id", "hostname",
	"uname", "env", "printenv", "true", "false", "which", "type", "command",
]);

/**
 * Bash subcommand names that are read-only but access filesystem paths.
 * Auto-allowed only when every non-flag argument resolves inside cwd.
 */
const READONLY_BASH_WITH_PATHS = new Set([
	"ls", "cat", "head", "tail", "wc", "file", "stat", "tree",
	"du", "realpath", "readlink", "dirname", "basename",
	"cut", "jq", "nl",
]);

/**
 * Strip POSIX shell line-continuations (`\<LF>` and `\<CRLF>`) from a bash
 * command, returning the canonical single-line form.
 *
 * Semantics:
 *   - Outside single quotes, a backslash immediately followed by a newline
 *     (or `\r\n`) is removed entirely, joining the two lines into one.
 *   - Inside single quotes, backslashes are literal — `\<newline>` is preserved.
 *   - Other escape sequences (e.g. `\&`, `\$`) are left untouched.
 *
 * Called once at the bash entry point in `decideCompound` so downstream
 * consumers — rule pattern matching, `tokenizeSimple`, `hasTopLevelFileRedirect`,
 * `isNoopCd` — all see the canonical form even when the command is non-compound.
 */
export function stripLineContinuations(cmd: string): string {
	let out = "";
	let inSingle = false;
	let i = 0;
	while (i < cmd.length) {
		const ch = cmd[i];
		if (ch === "'") {
			inSingle = !inSingle;
			out += ch;
			i++;
			continue;
		}
		if (ch === "\\" && !inSingle) {
			const next = cmd[i + 1];
			if (next === "\n") { i += 2; continue; }
			if (next === "\r" && cmd[i + 2] === "\n") { i += 3; continue; }
			// Non-continuation escape — preserve as-is
			if (next !== undefined) { out += ch + next; i += 2; continue; }
			out += ch; i++; continue;
		}
		out += ch;
		i++;
	}
	return out;
}

/**
 * If the redirect target beginning at `start` (after skipping spaces/tabs)
 * is exactly `/dev/null` — optionally single- or double-quoted — returns the
 * index just past the consumed target so the caller can resume scanning for a
 * later real redirect. Returns -1 otherwise (no target, or a different path).
 *
 * `/dev/null` is the Unix null device: writes are discarded and nothing is
 * persisted, so it is exempted from the write-risk filter just like descriptor
 * dups (`2>&1`). Only an *exact* `/dev/null` match is exempted — subpaths
 * (`/dev/null/x`) or suffixed forms (`/dev/nullx`) are real-ish paths and stay
 * write-risk. The target is read up to whitespace or a shell separator
 * (`;`, `|`, `&`, `(`, `)`, `<`, `>`) so idioms like `cmd >/dev/null; echo`
 * and `cmd >/dev/null 2>&1` resolve cleanly.
 */
function devNullTargetAt(cmd: string, start: number): number {
	let j = start;
	while (j < cmd.length && (cmd[j] === " " || cmd[j] === "\t")) j++;
	if (j >= cmd.length) return -1; // no target — conservatively a write
	let target = "";
	if (cmd[j] === '"' || cmd[j] === "'") {
		const q = cmd[j];
		j++;
		while (j < cmd.length && cmd[j] !== q) target += cmd[j++];
		if (j < cmd.length) j++; // skip closing quote
	} else {
		while (j < cmd.length && !/[\s;|&()<>]/.test(cmd[j])) target += cmd[j++];
	}
	return target === "/dev/null" ? j : -1;
}

/**
 * Returns true when `cmd` contains a top-level *file* output redirection
 * (`>`, `>>`, `2>`, `&>`, `n>>`, …) outside of single/double quotes, backticks,
 * command substitution (parens), and heredoc bodies. Descriptor-to-descriptor
 * redirects (`2>&1`, `1>&2`, `>&2`, `>&-`, `>>&N`) are NOT file writes and
 * return false — they only rearrange existing streams and are commonly used
 * for combined output capture/logging. Redirects whose target is exactly
 * `/dev/null` (the Unix null device — writes are discarded, nothing persisted)
 * are likewise NOT file writes and return false, so common idioms like
 * `cmd 2>/dev/null` or `cmd >/dev/null 2>&1` stay auto-allowable.
 *
 * Used to flag otherwise-safe commands that write to files via redirection
 * so that (a) the read-only bash auto-allow short-circuit rejects them, and
 * (b) broad allow rules (e.g. `Bash(rg *)`) don't silently authorize a
 * redirected form like `rg x > out.txt`. To pre-allow a redirected command,
 * add an explicit redirect-aware rule whose pattern contains `>` (e.g.
 * `Bash(rg * > *)`) — see `rulePatternAllowsRedirect`.
 */
export function hasTopLevelFileRedirect(cmd: string): boolean {
	let inSingle = false;
	let inDouble = false;
	let inBacktick = false;
	let parenDepth = 0;
	// When set, the next top-level newline ends a heredoc opening line and the
	// body (up to the delimiter line) should be skipped so a `>` inside the
	// body is ignored. The opening line itself is scanned normally so a real
	// redirect there (e.g. `cat <<EOF > out.txt`) is still detected.
	let pendingHeredoc: { delimiter: string; stripTabs: boolean } | null = null;
	let i = 0;
	while (i < cmd.length) {
		const ch = cmd[i];
		// Backslash escape — skip next char (not inside single quotes)
		if (ch === "\\" && !inSingle) { i += 2; continue; }
		// Quote / backtick toggles
		if (ch === "'" && !inDouble && !inBacktick) { inSingle = !inSingle; i++; continue; }
		if (ch === '"' && !inSingle && !inBacktick) { inDouble = !inDouble; i++; continue; }
		if (ch === "`" && !inSingle && !inDouble) { inBacktick = !inBacktick; i++; continue; }
		if (!inSingle && !inDouble && !inBacktick) {
			// Parenthesis depth — command substitution / subshell. A `>` inside
			// `$(...)` belongs to the inner command, not a top-level redirect.
			if (ch === "(") { parenDepth++; i++; continue; }
			if (ch === ")") { if (parenDepth > 0) parenDepth--; i++; continue; }
			// Heredoc start (`<<` / `<<-`). Parse the delimiter but keep scanning
			// the rest of the opening line normally — a redirect on the same
			// line (e.g. `cat <<EOF > out.txt`) is real and must be detected.
			// The body is skipped at the next top-level newline. `<<<` here-
			// strings and unparseable delimiters fall through to `i += 2`.
			if (ch === "<" && cmd[i + 1] === "<") {
				const stripTabs = cmd[i + 2] === "-";
				let j = i + (stripTabs ? 3 : 2);
				while (j < cmd.length && (cmd[j] === " " || cmd[j] === "\t")) j++;
				let delimiter = "";
				if (cmd[j] === "'" || cmd[j] === '"') {
					const q = cmd[j++];
					while (j < cmd.length && cmd[j] !== q) delimiter += cmd[j++];
					if (j < cmd.length) j++; // skip closing quote
				} else {
					while (j < cmd.length && /[A-Za-z0-9_]/.test(cmd[j])) delimiter += cmd[j++];
				}
				if (delimiter) {
					pendingHeredoc = { delimiter, stripTabs };
					i = j; // continue scanning the rest of the opening line
				} else {
					i += 2; // `<<<` here-string or unparseable — just skip `<<`
				}
				continue;
			}
			// Newline ending a heredoc opening line — skip the body until the
			// closing delimiter line so a `>` inside the body is ignored.
			if (pendingHeredoc && parenDepth === 0 && (ch === "\n" || (ch === "\r" && cmd[i + 1] === "\n"))) {
				const { delimiter, stripTabs } = pendingHeredoc;
				pendingHeredoc = null;
				let k = i + (ch === "\r" ? 2 : 1); // start of body
				let found = false;
				while (k < cmd.length) {
					const lineStart = k;
					let m = k;
					if (stripTabs) { while (m < cmd.length && cmd[m] === "\t") m++; }
					if (cmd.startsWith(delimiter, m)) {
						const after = m + delimiter.length;
						if (after >= cmd.length || cmd[after] === "\n" || cmd[after] === "\r") {
							// closing delimiter line — resume after it (and its newline)
							i = after;
							if (i < cmd.length && cmd[i] === "\r") i++;
							if (i < cmd.length && cmd[i] === "\n") i++;
							found = true;
							break;
						}
					}
					// not the delimiter — skip to end of this body line
					k = lineStart;
					while (k < cmd.length && cmd[k] !== "\n") k++;
					if (k < cmd.length) k++; // consume newline
				}
				if (!found) i = cmd.length; // unterminated heredoc — consume rest
				continue;
			}
			if (parenDepth === 0 && ch === ">") {
				const prev = cmd[i - 1];
				const next = cmd[i + 1];
				const next2 = cmd[i + 2];
				const next3 = cmd[i + 3];
				// `&>` / `&>>` — redirect both stdout+stderr to a file.
				if (prev === "&") {
					const tgtStart = next === ">" ? i + 2 : i + 1;
					const after = devNullTargetAt(cmd, tgtStart);
					if (after >= 0) { i = after; continue; }
					return true;
				}
				if (next === "&") {
					// `>&N` / `N>&M` — descriptor dup; `>&-` — close. Not a file write.
					if (next2 !== undefined && /[0-9]/.test(next2)) { i += 3; continue; }
					if (next2 === "-") { i += 3; continue; }
					// `>&<other>` — unusual; treat conservatively as a file write.
					return true;
				}
				if (next === ">") {
					// `>>` append. `>>&N` (rare) is a descriptor dup, not a file write.
					if (next2 === "&" && next3 !== undefined && /[0-9]/.test(next3)) { i += 4; continue; }
					const after = devNullTargetAt(cmd, i + 2);
					if (after >= 0) { i = after; continue; }
					return true;
				}
				// `> file` / `N> file` — file write. Process substitution `>(...)`
				// targets a subshell, not a path, so it stays a write. Otherwise
				// check for an exempt `/dev/null` target before flagging a write.
				if (next === "(") return true;
				{
					const after = devNullTargetAt(cmd, i + 1);
					if (after >= 0) { i = after; continue; }
					return true;
				}
			}
		}
		i++;
	}
	return false;
}

/**
 * Simple quote-aware tokenizer for a single shell command (no top-level operators).
 * Strips surrounding single/double quotes from each token; respects backslash escapes.
 */
function tokenizeSimple(cmd: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let inSingle = false;
	let inDouble = false;
	let i = 0;
	while (i < cmd.length) {
		const ch = cmd[i];
		if (ch === "\\" && !inSingle) {
			if (i + 1 < cmd.length) { current += cmd[i + 1]; i += 2; } else i++;
			continue;
		}
		if (ch === "'" && !inDouble) { inSingle = !inSingle; i++; continue; }
		if (ch === '"' && !inSingle) { inDouble = !inDouble; i++; continue; }
		if ((ch === " " || ch === "\t") && !inSingle && !inDouble) {
			if (current) { tokens.push(current); current = ""; }
			i++;
			continue;
		}
		current += ch;
		i++;
	}
	if (current) tokens.push(current);
	return tokens;
}

/**
 * Returns true when `cmd` is a read-only bash subcommand that is safe to
 * auto-allow when `bashReadOnlyAllowCwd` is enabled.
 *
 * Rules:
 *  1. Reject if cmd contains a top-level *file* output redirection (>, >>,
 *     2>, &>, …). Descriptor-to-descriptor dups like `2>&1` are NOT file
 *     writes and stay auto-allowable. Redirects to `/dev/null` (null device,
 *     no persistence) are likewise NOT file writes and stay auto-allowable.
 *  2. If the first token is in READONLY_BASH_SAFE_ALWAYS → allow.
 *  3. If the first token is in READONLY_BASH_WITH_PATHS → allow only when
 *     every non-flag argument resolves to a path inside (or equal to) cwd.
 *  4. Anything else → false.
 */
export function isReadOnlyBashSubcommand(cmd: string, cwd: string, options: PathNormalizationOptions = {}): boolean {
	const trimmed = cmd.trim();
	if (!trimmed) return false;
	if (hasTopLevelFileRedirect(trimmed)) return false;
	const tokens = tokenizeSimple(trimmed);
	if (tokens.length === 0) return false;
	const cmdName = tokens[0].toLowerCase();
	if (READONLY_BASH_SAFE_ALWAYS.has(cmdName)) return true;
	if (READONLY_BASH_WITH_PATHS.has(cmdName)) {
		const pathArgs = tokens.slice(1).filter((t) => t.length > 0 && !t.startsWith("-"));
		// No path args — command implicitly uses cwd, safe
		if (pathArgs.length === 0) return true;
		const cwdNorm = normalizeMatchPath(".", cwd, options);
		const caseInsensitive = isWindowsAbsolutePath(cwdNorm);
		const comparableCwd = caseInsensitive ? cwdNorm.toLowerCase() : cwdNorm;
		const cwdPrefix = comparableCwd.endsWith("/") ? comparableCwd : comparableCwd + "/";
		return pathArgs.every((arg) => {
			const normalized = normalizeMatchPath(arg, cwd, options);
			const comparable = caseInsensitive ? normalized.toLowerCase() : normalized;
			return comparable === comparableCwd || comparable.startsWith(cwdPrefix);
		});
	}
	return false;
}

/**
 * Bash builtin keywords that may prefix a pure variable assignment without
 * introducing side-effects (e.g. `export FOO=bar`, `declare -r X=1`). They are
 * pure bookkeeping when the RHS is a literal/expansion, so they are recognized
 * as optional leading keywords by `isPureVariableAssignment`.
 */
const ASSIGN_PREFIX_BUILTINS = new Set([
	"export", "local", "readonly", "declare", "typeset",
]);

/**
 * Returns true when `cmd` is a *pure* shell variable assignment — one that
 * performs no command, process, or arithmetic substitution and runs no other
 * command. Pure assignments are no-ops from the system's perspective (pi runs
 * each Bash call in a fresh shell, so a bare assignment does nothing
 * observable), so they are safe to auto-allow under `bashAllowPureVarAssign`.
 *
 * Detection (operates on the RAW command string, not `tokenizeSimple` tokens,
 * because quote-stripping would conflate `FOO="a b"` with `FOO=a b`):
 *  1. Reject if `cmd` contains a top-level *file* output redirection.
 *  2. Quote-aware scan splits `cmd` into top-level whitespace-delimited tokens,
 *     preserving each token's original substring (quotes intact) so RHS
 *     screening sees `$(` etc. Unmatched quotes → false (fall through to ask).
 *  3. Strip an optional leading prefix builtin (`export`/`local`/`readonly`/
 *     `declare`/`typeset`) and any of its flags (e.g. `-r`, `-x`, `-i`).
 *  4. Every remaining token must match `^[A-Za-z_][A-Za-z0-9_]*(\+?=)(.*)$`
 *     (covers `=`, `+=`, and empty value `FOO=`). A non-assignment token means
 *     a trailing command runs (e.g. `A=1 echo hi`) → false.
 *  5. For each assignment's raw RHS (before quote-stripping), reject if it
 *     contains an unquoted command separator (`;`, `|`, `&`, newline) —
 *     e.g. `X=1;reboot` hides a trailing command inside the assignment token.
 *  6. For each assignment's RHS (surrounding quotes stripped for screening),
 *     reject if it contains any side-effect vector: backtick command
 *     substitution, `$(...)`, `$((...))`, or process substitution `<(...)` /
 *     `>(...)`. Bare `$VAR` / `${VAR}` expansions are allowed (no command
 *     runs). A literal `)` inside a quoted RHS (e.g. `X="a ) b"`) is fine
 *     because the screen keys on `$(`, not bare `)`. Quoted separators are
 *     fine too (`X="a;b"` is a literal value), so the separator scan runs on
 *     the raw RHS, quote-aware.
 */
export function isPureVariableAssignment(cmd: string): boolean {
	const s = cmd.trim();
	if (!s) return false;
	if (hasTopLevelFileRedirect(s)) return false;

	// Quote-aware top-level tokenization that preserves each token's original
	// substring (quotes included) so RHS screening can detect `$(` etc.
	const tokens: string[] = [];
	let cur = "";
	let inSingle = false;
	let inDouble = false;
	let i = 0;
	while (i < s.length) {
		const ch = s[i];
		if (ch === "\\" && !inSingle) {
			// Preserve the escape and the escaped char in the token.
			cur += ch + (s[i + 1] ?? "");
			i += 2;
			continue;
		}
		if (ch === "'" && !inDouble) { inSingle = !inSingle; cur += ch; i++; continue; }
		if (ch === '"' && !inSingle) { inDouble = !inDouble; cur += ch; i++; continue; }
		if ((ch === " " || ch === "\t") && !inSingle && !inDouble) {
			if (cur) { tokens.push(cur); cur = ""; }
			i++;
			continue;
		}
		cur += ch;
		i++;
	}
	if (inSingle || inDouble) return false; // unmatched quote — don't guess
	if (cur) tokens.push(cur);
	if (tokens.length === 0) return false;

	// Strip an optional leading prefix builtin and its flags.
	let start = 0;
	if (ASSIGN_PREFIX_BUILTINS.has(tokens[0])) {
		start = 1;
		while (start < tokens.length && tokens[start].startsWith("-")) start++;
	}
	if (start >= tokens.length) return false; // e.g. bare `declare -p` — not an assignment

	const assignRe = /^[A-Za-z_][A-Za-z0-9_]*\+?=(.*)$/s;
	for (let j = start; j < tokens.length; j++) {
		const tok = tokens[j];
		const m = tok.match(assignRe);
		if (!m) return false; // a non-assignment token means a command runs
		// Reject unquoted command separators in the raw RHS: a token like
		// `X=1;reboot` hides a trailing command inside the assignment (this
		// function is also unit-tested directly, so don't rely on
		// splitTopLevelShell having split on separators already).
		if (hasUnquotedSeparator(m[1])) return false;
		// Strip surrounding quotes from the RHS for side-effect screening.
		let rhs = m[1];
		if (rhs.length >= 2 && ((rhs[0] === '"' && rhs[rhs.length - 1] === '"') || (rhs[0] === "'" && rhs[rhs.length - 1] === "'"))) {
			rhs = rhs.slice(1, -1);
		}
		// Reject any side-effect vector: backtick command substitution,
		// `$(...)` command substitution (also covers `$((...))` arithmetic),
		// or process substitution `>(...)` / `<(...)`.
		if (/`|\$\(|>\(|<\(/.test(rhs)) return false;
	}
	return true;
}

/**
 * Returns true when `s` contains a shell command separator (`;`, `|`, `&`,
 * or a newline) outside single/double quotes (backslash escapes respected).
 * Quoted separators are literal values (e.g. `X="a;b"`), not commands.
 * Complements `isPureVariableAssignment`, which must not mistake a token
 * like `X=1;reboot` for a single pure assignment.
 */
function hasUnquotedSeparator(s: string): boolean {
	let inSingle = false;
	let inDouble = false;
	let i = 0;
	while (i < s.length) {
		const ch = s[i];
		if (ch === "\\" && !inSingle) { i += 2; continue; }
		if (ch === "'" && !inDouble) { inSingle = !inSingle; i++; continue; }
		if (ch === '"' && !inSingle) { inDouble = !inDouble; i++; continue; }
		if (!inSingle && !inDouble && (ch === ";" || ch === "|" || ch === "&" || ch === "\n" || ch === "\r")) return true;
		i++;
	}
	return false;
}

/**
 * Normalize a tool name for comparison: lowercase and strip underscores.
 * Makes WebSearch, websearch, and web_search all equivalent.
 */
export function normalizeTool(name: string): string {
	return name.toLowerCase().replace(/_/g, "");
}

// ── toolDefaults helpers ──────────────────────────────────────────────────────

/**
 * Normalize toolDefaults keys (tool names) and validate values.
 * Invalid action strings are silently dropped.
 */
export function normalizeToolDefaultsKeys(td: Record<string, string>): Record<string, Action> {
	const out: Record<string, Action> = {};
	for (const [k, v] of Object.entries(td)) {
		if (v === "allow" || v === "deny" || v === "ask") {
			out[normalizeTool(k)] = v;
		}
	}
	return out;
}

/**
 * Compile a glob (or `/regex/`) into a RegExp matching the whole string, case-insensitive.
 *
 * Special glob rule: a space-asterisk pair `" *"` is treated as *optional* — it compiles
 * to `( .*)?` so that `Bash(git status *)` matches both `"git status"` and `"git status -s"`.
 * This lets users write broad rules that also cover the bare command form.
 * A bare `*` without a leading space is unaffected (e.g. `npm*` still requires the
 * matched string to start with `npm`).
 */
export function compilePattern(pattern: string): RegExp {
	if (pattern.length >= 2 && pattern.startsWith("/") && pattern.endsWith("/")) {
		return new RegExp(pattern.slice(1, -1), "i");
	}
	// Use a placeholder (U+0000) to protect " *" sequences before other transforms.
	const PLACEHOLDER = "\u0000";
	const escaped = pattern
		.replace(/ \*/g, PLACEHOLDER)              // 1. mark " *" pairs
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")     // 2. escape regex specials (placeholder is safe)
		.replace(/\*/g, ".*")                      // 3. remaining * → .*
		.replace(/\?/g, ".")                       // 4. ? → .
		.replace(/\u0000/g, "( .*)?");             // 5. placeholder → optional space+anything
	return new RegExp(`^${escaped}$`, "i");
}

export interface ParsedRule {
	tool: string;
	pattern?: string;
	regex?: RegExp;
	raw: string;
}

export function parseRule(raw: string): ParsedRule | null {
	const trimmed = (raw ?? "").trim();
	if (!trimmed) return null;
	const m = trimmed.match(/^([A-Za-z0-9_]+)(?:\((.*)\))?$/);
	if (!m) return null;
	const tool = normalizeTool(m[1]);
	const pattern = m[2];
	return {
		tool,
		pattern,
		regex: pattern ? compilePattern(pattern) : undefined,
		raw: trimmed,
	};
}

export function getMatchField(toolName: string, input: Record<string, unknown>): string {
	const t = normalizeTool(toolName);
	if (t === "bash" || t === "pwsh") return String(input.command ?? "");
	if (t === "read" || t === "write" || t === "edit") return String(input.path ?? "");
	if (t === "grep" || t === "glob" || t === "ls") return String(input.path ?? "");
	if (t === "webfetch") return String(input.url ?? "");
	// MCP: every MCP call arrives as toolName "mcp" with the real tool name in
	// input.tool (conventionally "<server>_<tool>"). Match against that so rules
	// like Mcp(slack_*) or Mcp(slack_slack_search_*) can target individual MCP
	// tools. Args are shown in the prompt preview (see mcpPreview), not matched.
	if (t === "mcp") return String(input.tool ?? "");
	try {
		return JSON.stringify(input);
	} catch {
		return "";
	}
}

function isPathTool(toolName: string): boolean {
	const t = normalizeTool(toolName);
	return t === "read" || t === "write" || t === "edit" || t === "grep" || t === "glob" || t === "ls";
}

export function ruleMatches(rule: ParsedRule, toolName: string, input: Record<string, unknown>, cwd?: string): boolean {
	if (rule.tool !== normalizeTool(toolName)) return false;
	if (!rule.regex) return true;
	const field = getMatchField(toolName, input);
	// For path-based tools, also test the cwd-resolved absolute path so that the
	// implicit Read(<cwd>/**) rule matches relative calls like Read(./TODO.md).
	// The original field is tested first to preserve relative user rules like Write(.env*).
	if (cwd && field && isPathTool(toolName)) {
		const resolved = normalizeMatchPath(field, cwd);
		if (resolved !== field && rule.regex.test(resolved)) return true;
	}
	return rule.regex.test(field);
}

/**
 * Returns true when an allow rule is eligible to authorize a Bash command that
 * contains a top-level *file* output redirection (e.g. `rg x > out.txt`).
 *
 * A broad allow rule whose pattern contains no `>` (e.g. `Bash(rg *)`) is
 * intentionally NOT redirect-aware: it would otherwise silently authorize
 * writing to arbitrary files via redirection. To pre-allow a redirected form,
 * the user must add a rule whose pattern explicitly includes the redirect
 * operator (e.g. `Bash(rg * > *)`). A bare `Bash` rule (no pattern) is treated
 * as non-redirect-aware for the same reason.
 *
 * `deny` and `ask` rules are redirect-agnostic — safety rules must always win
 * over a redirected command — so this filter applies to the `allow` list only.
 */
export function rulePatternAllowsRedirect(rule: ParsedRule): boolean {
	return typeof rule.pattern === "string" && rule.pattern.includes(">");
}

// ── Compound command splitting ─────────────────────────────────────────────

export type SplitResult =
	| { kind: "single"; effectiveCmd?: string }
	| { kind: "compound"; parts: string[] }
	| { kind: "ambiguous" };

/**
 * When a heredoc operator `<<` (or `<<-`) is found at position `pos` in `cmd`,
 * scans forward past the entire heredoc body and returns the index after the
 * closing delimiter line.  Returns null if the heredoc cannot be parsed.
 */
function consumeHeredoc(cmd: string, pos: number): number | null {
	const stripTabs = cmd[pos + 2] === "-";
	let j = pos + (stripTabs ? 3 : 2);

	// Skip horizontal whitespace between << and the delimiter
	while (j < cmd.length && (cmd[j] === " " || cmd[j] === "\t")) j++;

	// Parse the delimiter token — may be quoted ('EOF', "EOF") or bare (EOF)
	let delimiter = "";
	if (cmd[j] === "'" || cmd[j] === '"') {
		const q = cmd[j++];
		while (j < cmd.length && cmd[j] !== q) delimiter += cmd[j++];
		if (j < cmd.length) j++; // skip closing quote
	} else {
		while (j < cmd.length && /[A-Za-z0-9_]/.test(cmd[j])) delimiter += cmd[j++];
	}

	if (!delimiter) return null; // cannot determine delimiter → caller treats as normal

	// Advance past the rest of the opening line (up to and including its newline)
	while (j < cmd.length && cmd[j] !== "\n") j++;
	if (j < cmd.length) j++; // consume the newline

	// Scan body lines until we find a line that is exactly the delimiter
	while (j < cmd.length) {
		const lineStart = j;
		if (stripTabs) {
			while (j < cmd.length && cmd[j] === "\t") j++; // skip leading tabs
		}
		// Check whether this line is exactly the delimiter
		if (cmd.startsWith(delimiter, j)) {
			const after = j + delimiter.length;
			if (after >= cmd.length || cmd[after] === "\n" || cmd[after] === "\r" || cmd[after] === ";" || cmd[after] === " " || cmd[after] === "\t") {
				// Return the index right after the delimiter token but do NOT consume
				// the trailing newline (or ';' etc.).  Leaving it in the main loop
				// lets splitTopLevelShell treat it as a normal separator, so any
				// command that follows the heredoc is detected as a separate part.
				return after;
			}
		}
		// Skip to end of this line
		j = lineStart; // reset in case stripTabs moved j
		while (j < cmd.length && cmd[j] !== "\n") j++;
		if (j < cmd.length) j++;
	}

	// Heredoc body ran to EOF without finding the closing delimiter — ambiguous
	return null;
}

/**
 * Splits a shell command on top-level &&, ||, |, ; operators.
 * Respects single quotes, double quotes, backticks, parentheses, and heredocs.
 *
 * Returns:
 *   { kind: "ambiguous" }          – unmatched quote/paren; caller should fall back to ask
 *   { kind: "single" }             – no top-level operator found (or case block detected)
 *   { kind: "compound", parts }    – trimmed, non-empty subcommands
 */
export function splitTopLevelShell(cmd: string): SplitResult {
	// `case` pattern clauses (`foo)`) look like unmatched parens to the splitter.
	// Rather than attempting to parse the block, treat any command containing a
	// top-level `case` keyword as a single unit so it falls through to decide()
	// for normal rule matching and prompts once for the whole command.
	if (/(?:^|[;&|]\s*|\n\s*)case\s/.test(cmd)) return { kind: "single" };
	const parts: string[] = [];
	let current = "";
	let inSingle = false;
	let inDouble = false;
	let inBacktick = false;
	let parenDepth = 0;
	let foundOperator = false;
	let i = 0;

	while (i < cmd.length) {
		const ch = cmd[i];

		// Backslash escape — skip next char (not inside single quotes)
		// POSIX: \<newline> outside single quotes is a line continuation —
		// both characters are removed, joining the two lines into one logical line.
		if (ch === "\\" && !inSingle) {
			const next = cmd[i + 1];
			if (next === "\n") { i += 2; continue; }
			if (next === "\r" && cmd[i + 2] === "\n") { i += 3; continue; }
			current += ch + (next ?? "");
			i += 2;
			continue;
		}

		// Single-quote toggle (not inside double quotes or backticks)
		if (ch === "'" && !inDouble && !inBacktick) {
			inSingle = !inSingle;
			current += ch;
			i++;
			continue;
		}

		// Double-quote toggle (not inside single quotes or backticks)
		if (ch === '"' && !inSingle && !inBacktick) {
			inDouble = !inDouble;
			current += ch;
			i++;
			continue;
		}

		// Backtick toggle (not inside single or double quotes)
		if (ch === "`" && !inSingle && !inDouble) {
			inBacktick = !inBacktick;
			current += ch;
			i++;
			continue;
		}

		// Parenthesis depth tracking (outside all quotes)
		if (!inSingle && !inDouble && !inBacktick) {
			if (ch === "(") {
				parenDepth++;
				current += ch;
				i++;
				continue;
			}
			if (ch === ")") {
				if (parenDepth <= 0) return { kind: "ambiguous" }; // unmatched )
				parenDepth--;
				current += ch;
				i++;
				continue;
			}
		}

		// Operator detection — only at the top level
		if (!inSingle && !inDouble && !inBacktick && parenDepth === 0) {
			// Heredoc: << or <<-  — consume the entire body so its newlines are not split points
			if (ch === "<" && cmd[i + 1] === "<") {
				const end = consumeHeredoc(cmd, i);
				if (end !== null) {
					current += cmd.slice(i, end);
					i = end;
					continue;
				}
				// If we can't parse the heredoc, fall through to the normal newline handler
				// which will mark it ambiguous when the newline is reached.
			}

			if (ch === "&" && cmd[i + 1] === "&") {
				parts.push(current.trim());
				current = "";
				i += 2;
				foundOperator = true;
				continue;
			}
			if (ch === "|" && cmd[i + 1] === "|") {
				parts.push(current.trim());
				current = "";
				i += 2;
				foundOperator = true;
				continue;
			}
			if (ch === "|" && cmd[i + 1] !== "|") {
				parts.push(current.trim());
				current = "";
				i++;
				foundOperator = true;
				continue;
			}
			if (ch === ";") {
				parts.push(current.trim());
				current = "";
				i++;
				foundOperator = true;
				continue;
			}
			if (ch === "\n" || (ch === "\r" && cmd[i + 1] === "\n")) {
				parts.push(current.trim());
				current = "";
				i += ch === "\r" ? 2 : 1;
				foundOperator = true;
				continue;
			}
		}

		current += ch;
		i++;
	}

	// Unmatched quote or paren → ambiguous
	if (inSingle || inDouble || inBacktick || parenDepth !== 0) {
		return { kind: "ambiguous" };
	}

	if (!foundOperator) return { kind: "single" };

	const last = current.trim();
	if (last) parts.push(last);

	const nonEmpty = parts.filter((p) => p.length > 0 && !p.trimStart().startsWith("#"));
	if (nonEmpty.length > 1) return { kind: "compound", parts: nonEmpty };
	// When comment-stripping collapsed a multi-part split to one real command,
	// carry that effective command forward so callers don't match against the
	// full comment-prefixed original string.
	if (nonEmpty.length === 1) return { kind: "single", effectiveCmd: nonEmpty[0] };
	return { kind: "single" };
}

// ── Compound decision ────────────────────────────────────────────────────────

/**
 * Strip leading shell structural keywords from a compound-split subcommand.
 * Returns null when the residue is purely structural (an iteration/case head,
 * a bare keyword, or empty) with no user command to evaluate. Returns the
 * stripped residue when a real command follows a prefix keyword.
 *
 * Used by `decideCompound()` on each part produced by `splitTopLevelShell` so
 * that a loop like `for x in a b c; do echo $x; done` only prompts on `echo $x`
 * and a conditional like `if grep foo f; then echo found; fi` only prompts on
 * `grep foo f` and `echo found`.
 *
 * Two classes of keyword:
 *   Pure structural (whole part → null): do, done, then, else, fi
 *     plus iteration heads `for VAR in …` / `for VAR` / `for ((...))` /
 *     `select VAR in …` / `select VAR`.
 *   Prefix-strip (keyword stripped, residue re-evaluated): while, until,
 *     if, elif, and the leading-keyword forms of do/then/else.
 *
 * Loops iteratively so nested forms like `do for y in b` (one split part in
 * nested loops) and `do while true` collapse in a single pass.
 *
 * `case` is not yet handled here — it requires splitter changes (see TODO.md).
 *
 * Risk note: binaries literally named after these keywords would also be elided.
 * That is vanishingly rare in practice and accepted as a trade-off.
 */
/**
 * Strip trailing redirect clauses that are harmless for permission purposes:
 * redirects to `/dev/null` (any fd: `2>/dev/null`, `>/dev/null`, `&>/dev/null`,
 * with `>>` append variants, target optionally quoted) and descriptor-to-
 * descriptor dups (`2>&1`, `>&2`, `1>&-`). File-target redirects (`>file`,
 * `>>file`) are left intact so write-detection still fires.
 *
 * Used by `stripStructuralKeywords` so a structural keyword carrying a trailing
 * `2>/dev/null` (e.g. `done 2>/dev/null`) is still recognized as structural
 * rather than prompting as if `done` were a command. Also used by `decide()`
 * before allow-list matching, so an exact rule like `Bash(cmd)` covers
 * `cmd 2>&1` and `cmd >/dev/null`. Only `/dev/null` (and pure descriptor dups)
 * are treated as harmless; a `done > out.txt` keeps the redirect and still
 * prompts, preserving file-write screening.
 */
export function stripTrailingHarmlessRedirects(s: string): string {
	let r = s.replace(/\s+$/, "");
	for (;;) {
		// Descriptor dup: [N]>&M  or  [N]>&-   (e.g. 2>&1, >&2, 1>&-)
		let m = r.match(/(\s+\d*>&(?:\d+|-))$/);
		if (m) { r = r.slice(0, r.length - m[1].length).replace(/\s+$/, ""); continue; }
		// Redirect to /dev/null: [N|&]>>? /dev/null  (target optionally quoted)
		m = r.match(/(\s+(?:\d+|&)?>>?\s*(?:"\/dev\/null"|'\/dev\/null'|\/dev\/null))$/);
		if (m) { r = r.slice(0, r.length - m[1].length).replace(/\s+$/, ""); continue; }
		break;
	}
	return r;
}

export function stripStructuralKeywords(part: string): string | null {
	let s = part.trim();
	while (s.length > 0) {
		// Trailing harmless redirects (e.g. `2>/dev/null`, `2>&1`) on a structural
		// keyword must not turn it into a "command". Strip them for the structural
		// checks only; real commands keep their redirects (file writes preserved).
		const core = stripTrailingHarmlessRedirects(s);
		// Pure structural keyword tokens — bare, no arguments
		if (core === "do" || core === "done" || core === "then" || core === "else" || core === "fi") return null;
		// Iteration / case heads — the head itself runs no user command.
		// `for` and `select` share the same `VAR in ARGS` / `VAR` / `((...))` shapes.
		// \S+ greedily eats the C-style `((i=0;i<10;i++))` (no whitespace inside).
		if (/^(for|select)\s+\S+(\s+in\b[^\n]*)?$/.test(core)) return null;
		// Prefix keywords — a command follows; strip the keyword and re-test the
		// residue. Covers: do, then, else (when followed by a command), and the
		// control-condition keywords while, until, if, elif.
		const prefixMatch = s.match(/^(do|then|else|while|until|if|elif)\s+/);
		if (prefixMatch) { s = s.slice(prefixMatch[0].length); continue; }
		break;
	}
	return s.length > 0 ? s : null;
}

export interface SubcommandDecision {
	sub: string;
	action: Action;
}

export interface CompoundDecision {
	action: Action;
	/** True when the command was split into multiple subcommands. */
	isCompound: boolean;
	/** True when the command could not be parsed unambiguously; fell back to ask. */
	ambiguous: boolean;
	/** Per-subcommand results. Empty for single/ambiguous commands. */
	breakdown: SubcommandDecision[];
}

export function decideCompound(
	cfg: ResolvedConfig,
	toolName: string,
	input: Record<string, unknown>,
	autoActive = false,
): CompoundDecision {
	// `autoActive` is the session-toggle state. When on, `decide()` returns an
	// "auto" sentinel for fallthroughs (the handler runs the classifier); when
	// off, `decide()` returns the terminal `defaultAction` directly.
	if (normalizeTool(toolName) !== "bash") {
		return { action: decide(cfg, toolName, input, autoActive), isCompound: false, ambiguous: false, breakdown: [] };
	}

	const rawCmd = String(input.command ?? "");
	// Strip POSIX line-continuations once up front so the single-command path
	// and per-subcommand decisions all see the canonical single-line form.
	const cmd = stripLineContinuations(rawCmd);
	const normalizedInput = cmd === rawCmd ? input : { ...input, command: cmd };
	const split = splitTopLevelShell(cmd);

	if (split.kind === "ambiguous") {
		return { action: "ask", isCompound: false, ambiguous: true, breakdown: [] };
	}

	if (split.kind === "single") {
		const effectiveInput = split.effectiveCmd != null
			? { ...normalizedInput, command: split.effectiveCmd }
			: normalizedInput;
		return { action: decide(cfg, "bash", effectiveInput, autoActive), isCompound: false, ambiguous: false, breakdown: [] };
	}

	// compound — strip structural shell keywords (`for`, `do`, `done`) so
	// loop scaffolding never prompts; only real commands enter the breakdown.
	const breakdown: SubcommandDecision[] = [];
	for (const rawSub of split.parts) {
		const stripped = stripStructuralKeywords(rawSub);
		if (stripped === null) continue;
		breakdown.push({ sub: stripped, action: decide(cfg, "bash", { command: stripped }, autoActive) });
	}

	// Entirely structural (e.g. empty-body `for x in a; do; done`) — no commands
	// to evaluate, treat as a no-op allow. isCompound:false signals to the prompt
	// loop that there is nothing to iterate over.
	if (breakdown.length === 0) {
		return { action: "allow", isCompound: false, ambiguous: false, breakdown: [] };
	}

	// If filtering left a single command, downgrade to non-compound so callers
	// render the simpler single-command prompt rather than a 1-row breakdown.
	if (breakdown.length === 1) {
		return { action: breakdown[0].action, isCompound: false, ambiguous: false, breakdown: [] };
	}

	let action: Action = "allow";
	for (const { action: a } of breakdown) {
		if (a === "deny") { action = "deny"; break; }
		if (a === "auto") action = "auto";
		else if (a === "ask" && action !== "auto") action = "ask";
	}

	return { action, isCompound: true, ambiguous: false, breakdown };
}

/**
 * Whether a compound's per-subcommand breakdown is free of any static `ask`
 * sub. The `tool_call` handler uses this to decide whether to classify the
 * *whole* compound command at once (true) or fall back to the per-sub prompt
 * loop (false, so user-authored "always prompt" rules still fire). Static
 * `deny` already wins inside `decideCompound` before this is consulted.
 *
 * Empty breakdowns (single/ambiguous commands) return true, so the same
 * predicate gates single-command classification.
 */
export function shouldClassifyWholeCompound(breakdown: SubcommandDecision[]): boolean {
	return !breakdown.some((b) => b.action === "ask");
}

// ── Breakdown rendering ──────────────────────────────────────────────────────

/** Single-character status icon for a per-subcommand action. */
export function actionIcon(action: Action): string {
	if (action === "allow") return "✓";
	if (action === "deny") return "✗";
	return "?";
}

/**
 * Format one row of the compound-Bash breakdown.
 *
 * The current step gets a left-side `>` marker; non-current rows get an
 * equal-width blank gutter so the action-icon column stays aligned regardless
 * of which row is current. Keep gutter widths in sync — see the
 * column-alignment test in test-bash.mjs.
 */
export function formatBreakdownLine(sub: string, action: Action, isCurrent: boolean): string {
	const gutter = isCurrent ? " » " : "   ";
	return `${gutter}[${actionIcon(action)}] ${sub}`;
}

/**
 * Render the full breakdown block (newline-joined). When `currentSub` is null,
 * no row is marked current (all rows use the blank gutter).
 */
export function formatBreakdown(breakdown: SubcommandDecision[], currentSub: string | null): string {
	return breakdown
		.map((b) => formatBreakdownLine(b.sub, b.action, currentSub !== null && b.sub === currentSub))
		.join("\n");
}

/**
 * Re-evaluate every subcommand against the current `cfg` while preserving
 * the original `sub` strings (no re-splitting). Used by the compound-Bash
 * prompt loop after a rule is saved mid-loop so the dialog’s breakdown
 * block and the per-step decisions reflect the freshly loaded config.
 */
export function recomputeBreakdown(breakdown: SubcommandDecision[], cfg: ResolvedConfig, autoActive = false): SubcommandDecision[] {
	return breakdown.map((b) => ({ sub: b.sub, action: decide(cfg, "bash", { command: b.sub }, autoActive) }));
}

// ── Auto-mode classifier (Step 2) ─────────────────────────────────────────
//
// When the session auto toggle is on, fallthroughs are
// screened by a cheap/fast classifier model. The classifier is a pure helper
// with the `complete` call injected as a seam so it is unit-testable without
// HTTP. See docs/auto-mode-design.md.

export type ClassifierVerdict = "allow" | "soft_deny" | "hard_deny" | "no_match";

export interface ClassifyResult {
	verdict: ClassifierVerdict;
	reason: string;
}

/** Seam type for the model completion call (mirrors ModelRegistry.complete). */
export type ClassifierComplete = (model: Model<Api>, context: Context) => Promise<AssistantMessage>;

// The generic ranking/dedupe/auth/pricing logic below used to be duplicated
// verbatim between this file and idle-summary/idle-summary-models.ts; it now
// lives in extensions/shared/model-selection.ts and is re-exported here
// directly. Only `pickClassifierModel`'s explicit-pin resolution (a registry
// `find` seam, unlike idle-summary's pool-based string-ref lookup) is
// classifier-specific and stays local.
export { dedupeModels, hasPrice, modelCostScore, modelLabel, pickableModels, rankModels };

/**
 * Pick the classifier model. If `explicit` is set, `find` it directly; otherwise
 * rank the pool (preferring the current provider) and return the first with
 * configured auth. `find` and `hasAuth` are injected seams.
 */
export function pickClassifierModel(
	pool: Model<Api>[],
	currentProvider: string | undefined,
	hasAuth: HasAuth,
	explicit?: { provider: string; model: string },
	find?: (provider: string, modelId: string) => Model<Api> | undefined,
): Model<Api> | undefined {
	if (explicit && find) {
		const m = find(explicit.provider, explicit.model);
		if (m && hasAuth(m)) return m;
	}
	return selectModel(pool, currentProvider, hasAuth);
}

/**
 * Short status-bar label for auto mode. Shows the resolved classifier model
 * id (e.g. `claude-haiku-4-5`) so the user can see which model is screening
 * fallthroughs. When no model is available (toggle on but none authed),
 * reports `🤖 auto (no classifier)` so it's clear that fallthroughs are
 * stubbing to `ask` rather than being silently classified.
 */
export function autoStatusLabel(model: Pick<Model<Api>, "id"> | undefined): string {
	return model ? `🤖 auto: ${model.id}` : "🤖 auto (no classifier)";
}

/**
 * Attribution core for a classifier verdict, shown in permission prompts so the
 * user can see *which* model screened the action (mirrors the `🤖 auto: <id>`
 * status line). Empty when the classifier didn't run for this verdict — in
 * that case neither a model id nor a reason is set, so the prompt omits the
 * note entirely (as before). Format: `classifier <modelId>: <reason>` when both
 * are present, `classifier <modelId>` when the model ran but gave no reason,
 * `classifier: <reason>` when only a reason is present (defensive — a verdict
 * implies the model ran, so this only happens if a caller passes a reason
 * without the id). Exported for unit testing.
 */
export function classifierAttribution(modelId: string | undefined, reason: string): string {
	if (!modelId && !reason) return "";
	if (modelId && reason) return `classifier ${modelId}: ${reason}`;
	if (modelId) return `classifier ${modelId}`;
	return `classifier: ${reason}`;
}

/** Build a short human-readable description of the action for the classifier. */
export function describeAction(toolName: string, input: Record<string, unknown>): string {
	const t = normalizeTool(toolName);
	if (t === "bash" || t === "pwsh") return `Tool: ${toolName}\nCommand: ${String(input.command ?? "")}`;
	if (t === "read" || t === "write" || t === "edit" || t === "grep" || t === "glob" || t === "ls")
		return `Tool: ${toolName}\nPath: ${String(input.path ?? "")}`;
	if (t === "webfetch") return `Tool: ${toolName}\nURL: ${String(input.url ?? "")}`;
	if (t === "mcp") {
		const tool = String(input.tool ?? "");
		return `Tool: ${toolName}\nMCP tool: ${tool}\nArgs: ${mcpArgsString(input)}`;
	}
	try { return `Tool: ${toolName}\nInput: ${JSON.stringify(input)}`; } catch { return `Tool: ${toolName}`; }
}

/**
 * Parse an MCP call's `args` field into a value. The args arrive as a JSON
 * string (double-encoded), so we parse it once here. Returns the parsed value,
 * or the raw string if it isn't valid JSON, or undefined when absent.
 */
function parseMcpArgs(input: Record<string, unknown>): unknown {
	const raw = input.args;
	if (typeof raw === "string" && raw) {
		try { return JSON.parse(raw); } catch { return raw; }
	}
	return raw;
}

/**
 * Render an MCP call's args as a single-line `k=v, k2=v2` string for the
 * classifier's `describeAction` summary. Falls back to the raw value.
 */
function mcpArgsString(input: Record<string, unknown>): string {
	const args = parseMcpArgs(input);
	if (args && typeof args === "object" && !Array.isArray(args)) {
		return Object.entries(args as Record<string, unknown>)
			.map(([k, v]) => `${k}=${typeof v === "string" ? v : safeJson(v)}`)
			.join(", ");
	}
	return args == null ? "" : String(args);
}

/**
 * Build a human-readable, multi-line preview of an MCP call's arguments for the
 * permission prompt. Each key/value pair gets its own indented line so the user
 * can read what the tool is about to do instead of seeing a wall of escaped
 * JSON. The whole block is truncated to `maxChars` to keep the prompt readable.
 */
export function mcpPreview(input: Record<string, unknown>, maxChars = 800): string {
	const args = parseMcpArgs(input);
	const lines: string[] = [];
	if (args && typeof args === "object" && !Array.isArray(args)) {
		for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
			const val = typeof v === "string" ? v : safeJson(v);
			lines.push(`${k}: ${val}`);
		}
	} else if (args != null) {
		lines.push(String(args));
	}
	if (lines.length === 0) lines.push("(no arguments)");
	let body = lines.join("\n  ");
	if (body.length > maxChars) body = `${body.slice(0, maxChars - 3)}...`;
	return body;
}

/** Safe JSON.stringify that never throws on circular references. */
function safeJson(v: unknown): string {
	try { return JSON.stringify(v); } catch { return String(v); }
}

/**
 * Resolve a possibly-relative path against `cwd` without letting Windows
 * `resolve()` prepend a drive letter to POSIX-absolute paths (paths reaching
 * the classifier can come from either platform).
 */
export function resolveAgainstCwd(p: string, cwd: string): string {
	const norm = normalizePathSep(p);
	const isAbsolute = norm.startsWith("/") || /^[A-Za-z]:/.test(norm);
	if (isAbsolute) return norm;
	const base = normalizePathSep(cwd).replace(/\/+$/, "");
	return `${base}/${norm.replace(/^\.\//, "")}`;
}

/**
 * Walk up from `start` looking for a `.git` entry and return the repository
 * root, or null when the path is not inside a git working tree. Pure fs
 * probing — no subprocess, so an untracked file inside a repo still counts as
 * "inside a git repository". `exists` is injected so tests need no real disk.
 */
export function findGitRoot(start: string, exists: (p: string) => boolean = existsSync): string | null {
	let dir = normalizePathSep(start).replace(/\/+$/, "");
	if (!dir) return null;
	// Iteration cap guards against pathological input; real trees are far shallower.
	for (let i = 0; i < 64; i++) {
		if (exists(`${dir}/.git`)) return dir;
		if (/^[A-Za-z]:$/.test(dir)) return null;
		const slash = dir.lastIndexOf("/");
		if (slash < 0) return null;
		const parent = dir.slice(0, slash);
		if (!parent || parent === dir) return null;
		dir = parent;
	}
	return null;
}

/**
 * Extract the target directory of a leading `cd <dir>` in a bash command
 * (e.g. `cd /repo && git commit ...`) so the classifier learns which
 * repository the rest of the command actually touches. Returns null when the
 * command does not start with a simple, literal `cd`.
 */
export function leadingCdTarget(cmd: string): string | null {
	const m = stripLineContinuations(cmd).trim().match(/^cd\s+([^\r\n]*?)\s*(?:&&|\|\||;|$)/);
	if (!m) return null;
	let arg = m[1].trim();
	if (
		arg.length >= 2 &&
		((arg[0] === "'" && arg[arg.length - 1] === "'") || (arg[0] === '"' && arg[arg.length - 1] === '"'))
	) {
		arg = arg.slice(1, -1).trim();
	}
	if (!arg) return null;
	// Reject unresolved shell metacharacters / globs — we cannot know the real target.
	if (/[`$(){}|&;<>*?]/.test(arg)) return null;
	return arg;
}

/**
 * Build the `Context:` facts handed to the classifier alongside the action.
 *
 * Without these, the classifier only sees e.g. `Path: projects.md` and cannot
 * tell whether the edit is reversible via git — so it soft-denied edits inside
 * source-controlled repos merely because the path looked bare. We now state the
 * working directory, the resolved target path, and whether each lives inside a
 * git working tree (fs-only `.git` probe — fast, no subprocess).
 */
export function buildActionContext(
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
	exists: (p: string) => boolean = existsSync,
): string[] {
	const lines: string[] = [];
	const inRepo = (label: string, dir: string): void => {
		const root = findGitRoot(dir, exists);
		lines.push(
			root
				? `${label} is inside a git repository (root: ${root}), so file changes there are source-controlled and reversible`
				: `${label} is NOT inside a git repository`,
		);
	};
	if (cwd) {
		const cwdNorm = normalizePathSep(cwd);
		lines.push(`Working directory: ${cwdNorm}`);
		inRepo("Working directory", cwdNorm);
	}
	const t = normalizeTool(toolName);
	if ((t === "read" || t === "write" || t === "edit" || t === "grep" || t === "glob" || t === "ls") && input.path) {
		const resolved = resolveAgainstCwd(String(input.path), cwd);
		lines.push(`Resolved target path: ${resolved}`);
		inRepo("Target path", dirname(resolved));
	}
	if (t === "bash" || t === "pwsh") {
		const raw =
			t === "bash"
				? leadingCdTarget(String(input.command ?? ""))
				: typeof input.cwd === "string" && input.cwd
					? input.cwd
					: null;
		if (raw) {
			const resolved = resolveAgainstCwd(raw, cwd);
			lines.push(`Command runs in: ${resolved}`);
			inRepo("That directory", resolved);
		}
	}
	return lines;
}

export function buildClassifierPrompt(
	toolName: string,
	input: Record<string, unknown>,
	autoMode: ResolvedAutoModeConfig,
	context: string[] = [],
): string {
	const env = autoMode.environment.length ? autoMode.environment.map((e) => `  - ${e}`).join("\n") : "  (none)";
	const allow = autoMode.allow.length ? autoMode.allow.map((r) => `  - ${r}`).join("\n") : "  (none)";
	const soft = autoMode.soft_deny.length ? autoMode.soft_deny.map((r) => `  - ${r}`).join("\n") : "  (none)";
	const hard = autoMode.hard_deny.length ? autoMode.hard_deny.map((r) => `  - ${r}`).join("\n") : "  (none)";
	return [
		"You are a permissions safety classifier for a coding agent. Decide whether the agent should be allowed to run the following action.",
		"",
		"Action:",
		describeAction(toolName, input),
		"",
		"Context (facts about this specific call — trust these over guesses from the paths above):",
		context.length ? context.map((c) => `  - ${c}`).join("\n") : "  (none)",
		"",
		"Environment:",
		env,
		"",
		"Rules:",
		"Allow (silently permit):",
		allow,
		"Soft deny (prompt the user, include the reason):",
		soft,
		"Hard deny (always block, include the reason):",
		hard,
		"",
		"Decide which list (if any) the action matches. Respond with exactly two lines:",
		"VERDICT: <hard_deny|soft_deny|allow|no_match>",
		"REASON: <one short sentence>",
		"If the action matches a Hard deny rule, verdict is hard_deny. If it matches a Soft deny rule, verdict is soft_deny. If it matches an Allow rule, verdict is allow. Otherwise, verdict is no_match.",
		"The reason should describe what the action does (e.g. 'read-only GitHub API call to fetch a file'). Do not mention whether it matches or fails to match any rules — that is implied by the verdict.",
	].join("\n");
}

export function parseClassifierResponse(text: string): ClassifyResult {
	const verdictMatch = text.match(/VERDICT:\s*(allow|soft_deny|hard_deny|no_match)\b/i);
	const verdict = verdictMatch ? (verdictMatch[1].toLowerCase() as ClassifierVerdict) : "no_match";
	const reasonMatch = text.match(/REASON:\s*(.+)/i);
	const reason = reasonMatch ? reasonMatch[1].trim() : "";
	return { verdict, reason };
}

/**
 * Map a classifier verdict to a concrete Action.
 * - `allow` → allow (short-circuit)
 * - `hard_deny` → deny (block)
 * - `soft_deny` → ask (prompt with reason); deny in non-interactive modes
 *   (can't prompt)
 * - `no_match` → `defaultAction` (the classifier ran and had no opinion; the
 *   user's terminal fallback applies). This holds in both interactive and
 *   non-interactive modes — the non-interactive `ask`→deny fallback is
 *   handled by the `tool_call` handler's `!ctx.hasUI` branch, not here.
 */
export function verdictToAction(verdict: ClassifierVerdict, nonInteractive: boolean, defaultAction: DefaultAction): DefaultAction {
	if (verdict === "allow") return "allow";
	if (verdict === "hard_deny") return "deny";
	if (verdict === "soft_deny") return nonInteractive ? "deny" : "ask";
	return defaultAction; // no_match
}

/** Cache key: hash(toolName, input, ruleset). Binds token cost on loops. */
export function classifierCacheKey(
	toolName: string,
	input: Record<string, unknown>,
	autoMode: ResolvedAutoModeConfig,
	context: string[] = [],
): string {
	const ruleset = JSON.stringify({
		x: context,
		c: autoMode.classifier,
		e: autoMode.environment,
		a: autoMode.allow,
		s: autoMode.soft_deny,
		h: autoMode.hard_deny,
	});
	const inputJson = JSON.stringify(input);
	return createHash("sha256").update(`${toolName}\u0000${inputJson}\u0000${ruleset}`).digest("hex");
}

/**
 * Run the classifier. `complete` is injected so this is unit-testable without HTTP.
 * Results are cached by (toolName, input, ruleset) for the lifetime of the
 * provided cache Map.
 */
export async function classifyAction(
	complete: ClassifierComplete,
	model: Model<Api>,
	toolName: string,
	input: Record<string, unknown>,
	autoMode: ResolvedAutoModeConfig,
	cache: Map<string, ClassifyResult>,
	context: string[] = [],
): Promise<ClassifyResult> {
	const key = classifierCacheKey(toolName, input, autoMode, context);
	const cached = cache.get(key);
	if (cached) return cached;
	const prompt = buildClassifierPrompt(toolName, input, autoMode, context);
	let result: ClassifyResult;
	try {
		const response = await complete(model, {
			messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
		});
		const text = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n")
			.trim();
		result = parseClassifierResponse(text);
	} catch {
		// Network/API error → safe fallback (no_match → ask / deny in non-interactive).
		result = { verdict: "no_match", reason: "classifier call failed" };
	}
	cache.set(key, result);
	return result;
}

export function decide(cfg: ResolvedConfig, toolName: string, input: Record<string, unknown>, autoActive = false): Action {
	const check = (list: string[]): boolean => {
		for (const raw of list) {
			const rule = parseRule(raw);
			if (rule && ruleMatches(rule, toolName, input, cfg.cwd)) return true;
		}
		return false;
	};
	// Same as `check(cfg.allow)` but against a (possibly redirect-stripped) input.
	const checkAllow = (matchInput: Record<string, unknown>): boolean => {
		for (const raw of cfg.allow) {
			const rule = parseRule(raw);
			if (rule && ruleMatches(rule, toolName, matchInput, cfg.cwd)) return true;
		}
		return false;
	};
	if (check(cfg.deny)) return "deny";
	// Read-only bash auto-allow short-circuit. When the auto layer is engaged
	// (session toggle on) AND classifyAllShell is set, route read-only bash
	// commands through the classifier instead of silently allowing them. For
	// compounds, the whole command is classified as one when no sub matched a
	// static `ask` rule (see the tool_call handler); otherwise each sub is
	// classified individually.
	// (No-op `cd` is pure bookkeeping with zero side-effects/data access, so
	// allowNoopCd stays active regardless of the toggle.)
	const skipReadOnlyBash = autoActive && cfg.autoMode.classifyAllShell;
	if (!skipReadOnlyBash && cfg.bashReadOnlyAllowCwd && normalizeTool(toolName) === "bash" && isReadOnlyBashSubcommand(String(input.command ?? ""), cfg.cwd)) return "allow";
	if (cfg.allowNoopCd && normalizeTool(toolName) === "bash" && isNoopCd(String(input.command ?? ""), cfg.cwd)) return "allow";
	// Pure shell variable assignments (no command/process/arithmetic substitution)
	// are no-ops in pi's fresh-shell model. Exempt from `skipReadOnlyBash` (auto
	// mode's classifyAllShell) so they are statically allowed even in auto mode —
	// matching allowNoopCd, and avoiding a wasteful classifier call that could
	// mis-allow an impure `$(...)` form. Impure assignments still fall through.
	if (cfg.bashAllowPureVarAssign && normalizeTool(toolName) === "bash" && isPureVariableAssignment(String(input.command ?? ""))) return "allow";
	if (check(cfg.ask)) return "ask";
	// Allow rules — redirect-aware for Bash. A Bash command containing a
	// top-level *file* output redirection (e.g. `rg x > out.txt`) is NOT
	// covered by a broad allow rule whose pattern lacks `>` (e.g. `Bash(rg *)`);
	// only an explicit redirect-aware rule (pattern contains `>`, e.g.
	// `Bash(rg * > *)`) may authorize it. `deny`/`ask` above are redirect-
	// agnostic so safety rules always win. pwsh is out of scope (different
	// syntax) and stays redirect-agnostic.
	//
	// Trailing *harmless* redirects (descriptor dups like `2>&1`, `/dev/null`
	// targets) are stripped before allow-rule matching so an exact rule like
	// `Bash(gh auth status)` also covers `gh auth status 2>&1`. The strip runs
	// only for Bash and only on the allow path: deny/ask matching and the
	// file-write screen above still see the raw command string, so
	// `rg x > out 2>&1` still requires a `>`-containing rule and a deny rule
	// naming the redirected form still fires.
	const rawCommand = String(input.command ?? "");
	const isBash = normalizeTool(toolName) === "bash";
	const isBashRedirect = isBash && hasTopLevelFileRedirect(rawCommand);
	const allowInput = isBash ? { ...input, command: stripTrailingHarmlessRedirects(rawCommand) } : input;
	if (isBashRedirect) {
		for (const raw of cfg.allow) {
			const rule = parseRule(raw);
			if (rule && rulePatternAllowsRedirect(rule) && ruleMatches(rule, toolName, allowInput, cfg.cwd)) return "allow";
		}
	} else if (checkAllow(allowInput)) {
		return "allow";
	}
	const td = cfg.toolDefaults[normalizeTool(toolName)];
	if (td !== undefined) return td;
	// Auto layer: when the session toggle is on, return the "auto" sentinel so the
	// `tool_call` handler can run the classifier (or stub to `ask` if no model is
	// available). When the toggle is off, fall through to `defaultAction`.
	if (autoActive) return "auto";
	return cfg.defaultAction;
}

/** Suggest a rule string that matches the current call exactly enough to be useful. */
export function suggestRule(toolName: string, input: Record<string, unknown>): string {
	const t = normalizeTool(toolName);
	if (t === "bash" || t === "pwsh") {
		const cmd = String(input.command ?? "").trim();
		return cmd ? `${toolName}(${cmd})` : toolName;
	}
	if (t === "read" || t === "write" || t === "edit") {
		const p = String(input.path ?? "");
		// Normalize path separators so saved rules work on Windows
		return p ? `${toolName}(${normalizePathSep(p)})` : toolName;
	}
	if (t === "grep" || t === "glob" || t === "ls") {
		const p = String(input.path ?? "");
		return p ? `${toolName}(${normalizePathSep(p)})` : toolName;
	}
	if (t === "websearch") return "WebSearch";
	if (t === "mcp") {
		// Suggest the exact MCP tool. The first underscore separates the server
		// name from the tool name (e.g. slack_slack_search_*), so a broader
		// server-level rule would be Mcp(<server>_*); we leave that to the user.
		const tool = String(input.tool ?? "");
		return tool ? `Mcp(${tool})` : "Mcp";
	}
	if (t === "webfetch") {
		const url = String(input.url ?? "");
		if (url) {
			try {
				const { origin } = new URL(url);
				return `WebFetch(${origin}/*)` ;
			} catch {
				// malformed URL — fall back to bare rule
			}
		}
		return "WebFetch";
	}
	return toolName;
}

/**
 * Return a copy of the tool input with the path field normalized for permission matching.
 * The original event.input is never mutated — only this copy enters decide/ruleMatches.
 */
export function inputForMatching(
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
): Record<string, unknown> {
	const t = normalizeTool(toolName);
	if (t === "read" || t === "write" || t === "edit") {
		// Only normalise separators — do NOT resolve relative paths to absolute.
		// Resolving would break user rules like Write(.env*) for relative-path calls.
		// The synthetic cwd rule works for the common case where pi provides absolute paths.
		const p = String(input.path ?? "");
		return p ? { ...input, path: normalizePathSep(p) } : input;
	}
	if (t === "grep" || t === "glob" || t === "ls") {
		// Default missing path to cwd so rules like Grep(<cwd>/**) / Ls(<cwd>/**) match
		// implicit-cwd calls. Append a trailing "/" so directory paths match patterns
		// like /etc/* (regex ^/etc/.*$ requires something after the slash; "" satisfies
		// .* so /etc/ matches correctly).
		const p = input.path ? String(input.path) : cwd;
		const normalized = normalizeMatchPath(p, cwd);
		return { ...input, path: normalized.endsWith("/") ? normalized : normalized + "/" };
	}
	return input;
}

