/**
 * Tool Permissions Extension
 *
 * Adds Claude Code-style configurable allow/deny/ask permissions for tool calls.
 *
 * Rule format:
 *   "ToolName"             - matches any invocation of that tool
 *   "ToolName(pattern)"    - matches when the tool's "match field" matches the glob pattern
 *
 * Match field per tool:
 *   bash             -> command
 *   pwsh             -> command
 *   read/write/edit  -> path
 *   grep/glob/ls     -> path (directory being searched/listed; defaults to cwd when the call omits it)
 *   web_fetch        -> url
 *   web_search       -> (bare rule only — no pattern support)
 *   others           -> JSON.stringify(input)
 *
 * Tool name matching is case-insensitive and underscore-agnostic:
 *   WebSearch, websearch, web_search  →  all equivalent
 *   WebFetch,  webfetch,  web_fetch   →  all equivalent
 *
 * Pattern syntax: simple glob (`*` = any chars, `?` = single char). Case-insensitive.
 * If a rule's pattern starts with `/` and ends with `/`, it is treated as a regex.
 *
 * Config files (merged, project overrides user):
 *   ~/.pi/agent/pi-tool-permissions.json
 *   ~/.pi/tool-permissions.json (legacy fallback when the new user config is absent)
 *   <cwd>/.pi/pi-tool-permissions.local.json
 *   <cwd>/.pi/pi-tool-permissions.json (legacy fallback; auto-migrated on next save)
 *   <cwd>/.pi/tool-permissions.json (older legacy fallback; auto-migrated on next save)
 *
 * Schema:
 *   {
 *     "defaultAction": "allow" | "deny" | "ask",
 *     "allow": ["Bash(npm test)", "Read"],
 *     "deny":  ["Bash(rm -rf*)", "Write(.env*)"],
 *     "ask":   ["Bash(git push*)"],
 *     "toolDefaults": { "write": "ask", "web_fetch": "allow" },
 *     "readAllowCwd": true,
 *     "grepAllowCwd": true,
 *     "globAllowCwd": true,
 *     "lsAllowCwd": true,
 *     "readAllowSkills": true,
 *     "readAllowPiDocs": true,
 *     "bashReadOnlyAllowCwd": true,
 *     "autoMode": {                       // used when the session auto toggle is on
 *       "classifier": { "provider": "anthropic", "model": "claude-haiku-4-5" },
 *       "environment": ["Trusted repo: github.com/lucaspimentel/*"],
 *       "allow":     ["Running tests and linters"],
 *       "soft_deny": ["Force pushing, deleting remote branches"],
 *       "hard_deny": ["Sending data to third-party APIs or external services"],
 *       "classifyAllShell": true
 *     }
 *   }
 *
 * Precedence (first match wins):
 *   deny > ask > allow > toolDefaults > auto (if session toggle on) > defaultAction.
 *
 * Implicit defaults (session-only, never persisted to disk):
 *   readAllowCwd (default: true)
 *     Injects Read(<cwd>/**) into the allow list so every read within the working
 *     directory is silently permitted. Disable with "readAllowCwd": false.
 *   grepAllowCwd (default: true)
 *     Injects Grep(<cwd>/**) so every grep inside the working directory is silently
 *     permitted. Disable with "grepAllowCwd": false.
 *   globAllowCwd (default: true)
 *     Injects Glob(<cwd>/**) so every glob inside the working directory is silently
 *     permitted. Disable with "globAllowCwd": false.
 *   lsAllowCwd (default: true)
 *     Injects Ls(<cwd>/**) so every ls inside the working directory (and ls calls
 *     that omit `path`, which default to cwd) are silently permitted. Disable with
 *     "lsAllowCwd": false.
 *   readAllowSkills (default: true)
 *     Injects Read/Ls/Glob/Grep rules covering pi's known skill roots so reading,
 *     listing, globbing, or grepping SKILL.md and related files outside cwd doesn't
 *     prompt. Covered roots:
 *       <Read|Ls|Glob|Grep>(<home>/.pi/agent/skills/**)
 *       <Read|Ls|Glob|Grep>(<home>/.pi/agent/git/**\/skills/**)
 *       <Read|Ls|Glob|Grep>(<home>/.agents/skills/**)
 *     Only affects read-only tools; Write/Edit to these paths are unaffected.
 *     Disable with "readAllowSkills": false.
 *   readAllowPiDocs (default: true)
 *     Injects Read/Ls/Glob/Grep rules covering pi's bundled docs and README so the
 *     agent can read, list, glob, and grep pi documentation without prompting.
 *     Covered roots (relative to home):
 *       <Read|Ls|Glob|Grep>(<home>/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/**)  (Windows)
 *       <Read|Ls|Glob|Grep>(<home>/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/**)
 *       <Read|Ls|Glob|Grep>(<home>/.nvm/versions/node/{*}/lib/node_modules/@earendil-works/pi-coding-agent/**)
 *       <Read|Ls|Glob|Grep>(<home>/.volta/tools/image/node/{*}/lib/node_modules/@earendil-works/pi-coding-agent/**)
 *       <Read|Ls|Glob|Grep>(<home>/.local/share/npm/lib/node_modules/@earendil-works/pi-coding-agent/**)
 *       <Read|Ls|Glob|Grep>(<home>/Library/Application Support/npm/lib/node_modules/@earendil-works/pi-coding-agent/**)
 *     Only affects read-only tools; Write/Edit to these paths are unaffected.
 *     System-wide installs (/usr/local/lib/...) are not covered. Disable with
 *     "readAllowPiDocs": false.
 *   bashReadOnlyAllowCwd (default: true)
 *     Silently allows a curated set of read-only bash subcommands (pwd, echo, ls,
 *     cat, head, tail, wc, stat, …) when their path arguments resolve inside cwd.
 *     Commands with output redirections (>) are never auto-allowed.
 *     Disable with "bashReadOnlyAllowCwd": false.
 *   write → ask (automatic)
 *     Unless toolDefaults.write is explicitly set, Write always prompts regardless
 *     of defaultAction. Override with "toolDefaults": { "write": "allow" }.
 *     Explicit Write(<path>) allow rules still win because allow > toolDefaults.
 *
 * Compound bash commands (&&, ||, |, ;):
 *   When a Bash command contains top-level shell operators, each subcommand is
 *   evaluated independently against the rules, then aggregated:
 *     - any subcommand → deny  ⟹  whole command denied (notification names culprit)
 *     - no deny, any → ask    ⟹  each ask subcommand is confirmed separately
 *     - all → allow           ⟹  whole command allowed
 *   If the command cannot be parsed unambiguously (e.g. unmatched quotes), the
 *   whole command falls back to ask.
 *   POSIX shell line-continuations (`\<LF>` and `\<CRLF>` outside single
 *   quotes) are stripped before parsing, so commands split across multiple
 *   lines are matched against rules as their canonical single-line form.
 *   Structural control-flow keywords are elided from the per-subcommand breakdown
 *   so only real commands in loop/conditional bodies enter the prompt:
 *
 *   Iteration heads (elided entirely — no command runs):
 *     `for VAR in ...`, C-style `for ((...))`, bare `for VAR`
 *     `select VAR in ...`, bare `select VAR`
 *   Pure structural tokens (elided entirely):
 *     `do`, `done`, `then`, `else`, `fi`
 *   Prefix keywords (stripped — command after keyword is evaluated):
 *     `while CMD`, `until CMD`, `if CMD`, `elif CMD`
 *     `do CMD`, `then CMD`, `else CMD`
 *
 *   Example: `while true; do sleep 1; done` prompts only on `true` and `sleep 1`.
 *   Example: `if grep foo f; then echo found; fi` prompts on `grep foo f` and `echo found`.
 *   `case` statements are not yet supported (require splitter changes; see TODO.md).
 *
 * Allow-all-edits mode:
 *   A session-only toggle that auto-allows all Write and Edit tool calls without
 *   prompting. Never persisted to disk. Always starts disabled. Explicit deny rules
 *   still take priority even when this mode is on.
 *
 *   Toggle via:
 *     - Ctrl+Alt+E hotkey
 *     - "Allow all edits this session" option in the Write/Edit permission dialog
 *     - /permissions allowalledits [on|off|toggle]
 *
 * Auto mode (session toggle, layered between toolDefaults and defaultAction):
 *   A middle ground between Manual (prompt for everything) and bypassPermissions
 *   (prompt for nothing). Before each tool call that falls through the static-rule
 *   layer AND any toolDefaults, a cheap/fast LLM classifier screens the action
 *   against natural-language `allow` / `soft_deny` / `hard_deny` lists and an
 *   `environment` fact list, then either allows silently, prompts (with the
 *   classifier's reason), or blocks.
 *
 *   It is a LAYER in the precedence chain, not a `defaultAction` value:
 *     deny > ask > allow > toolDefaults > auto (if toggle on) > defaultAction
 *   `deny` rules block before the classifier is consulted; `ask` rules always
 *   prompt; `toolDefaults` (e.g. the implicit `write → ask` guard) win over the
 *   classifier. The classifier only decides for actions that fall through all of
 *   those — true unknowns.
 *
 *   Verdict mapping: `allow` → allow; `hard_deny` → block; `soft_deny` → prompt
 *   (deny in non-interactive modes); `no_match` → fall through to `defaultAction`
 *   (the classifier ran and had no opinion, so the user's terminal default
 *   applies). When the toggle is on but no classifier model is available, the
 *   auto layer stubs to `ask` (safe) rather than applying `defaultAction` —
 *   screening was requested but couldn't be performed.
 *
 *   Auto mode is OFF by default and NEVER persisted — it is a session-only toggle
 *   mirroring allow-all-edits. `defaultAction` is never `"auto"` (legacy configs
 *   that set it are coerced to `"ask"` with a warning). Explicit `deny` rules
 *   always win.
 *
 *   Toggle via:
 *     - Ctrl+Alt+A hotkey
 *     - /permissions auto [on|off|toggle]
 *     - "Switch to auto mode (this session)" option in any permission dialog
 *       (just flips the toggle — same as the hotkey, but contextual).
 *
 *   Config (`autoMode` block): `classifier` (optional explicit model pin),
 *   `environment`, `allow`, `soft_deny`, `hard_deny` (NL string lists),
 *   `classifyAllShell` (route every bash subcommand through the classifier).
 *   The `allow`/`soft_deny`/`hard_deny` lists and `classifyAllShell` have sane
 *   defaults baked in (see DEFAULT_AUTO_MODE) — a bare `autoMode` block (or none
 *   at all) works out of the box once the toggle is on. User/project lists are
 *   additive on top of the defaults. `classifier` and `environment` have no
 *   defaults (user-specific). See docs/auto-mode-design.md for the full design.
 *
 * Slash commands:
 *   /permissions                       - show this help
 *   /permissions help                  - show this help
 *   /permissions list                  - show current rules + allow-all-edits / auto state
 *   /permissions allow <rule>          - add an allow rule (project)
 *   /permissions deny  <rule>          - add a deny rule (project)
 *   /permissions ask   <rule>          - add an ask rule (project)
 *   /permissions remove <rule>         - remove a rule from any list
 *   /permissions default <allow|deny|ask>
 *   /permissions reload                - reload config from disk
 *   /permissions allowalledits [on|off|toggle]
 *   /permissions auto [on|off|toggle]  - toggle auto-mode (LLM classifier) for this session
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";

type Action = "allow" | "deny" | "ask" | "auto";

/** The three persistable rule-list actions (auto is not a rule list). */
type ListAction = "allow" | "deny" | "ask";

/**
 * Persistable `defaultAction` values. `"auto"` is NOT a valid default — auto
 * mode is a session-only layer between `toolDefaults` and `defaultAction`,
 * controlled by the `/permissions auto` toggle. `Action` still includes
 * `"auto"` because `decide()` returns it as a sentinel ("reached the auto
 * layer — handler should classify") when the session toggle is on.
 */
type DefaultAction = "allow" | "deny" | "ask";

/**
 * Natural-language rules and model selection for the auto-mode layer.
 * When no static rule or `toolDefaults` entry matches and the session toggle
 * is on, a cheap/fast classifier model screens the action against these NL
 * lists and returns a verdict (allow / soft_deny / hard_deny / no-match).
 * See `docs/auto-mode-design.md` for the full design.
 */
interface AutoModeConfig {
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
	/** When true, route every bash subcommand (incl. read-only auto-allowed ones) through the classifier. */
	classifyAllShell?: boolean;
}

/** Resolved auto-mode config after merging user + project: arrays are guaranteed present. */
interface ResolvedAutoModeConfig {
	classifier?: { provider: string; model: string };
	environment: string[];
	allow: string[];
	soft_deny: string[];
	hard_deny: string[];
	classifyAllShell: boolean;
}

interface PermissionsConfig {
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
	/** When false, disables the implicit allow for read-only bash commands in cwd. Default: true. */
	bashReadOnlyAllowCwd?: boolean;
	/** When false, disables the implicit allow for no-op `cd` commands. Default: true. */
	allowNoopCd?: boolean;
}

interface ResolvedConfig {
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
		bashReadOnlyAllowCwd: boolean;
		allowNoopCd: boolean;
	};
}

// Project config: prefer the `.local.json` suffix (machine-local, not checked
// into git). Two legacy filenames are still read as fallbacks and auto-migrated
// to the new path on next save.
export const PROJECT_CONFIG_REL = join(".pi", "pi-tool-permissions.local.json");
export const LEGACY_PROJECT_CONFIG_REL = join(".pi", "pi-tool-permissions.json");
export const LEGACY2_PROJECT_CONFIG_REL = join(".pi", "tool-permissions.json");
const STATUS_KEY = "tool-permissions";
const STATUS_KEY_AUTO = "tool-permissions-auto";

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
		"Read-only GitHub API requests (e.g. fetching files, listing issues, reading repos) via gh or the web API",
		"Read-only GitHub API call to fetch a file, not sending data or modifying remote state",
		"Read-only Atlassian API call to fetch a Jira issue",
		"Read-only Atlassian API call to fetch a Confluence page",
		"Read-only Confluence search query using CQL",
	],
	soft_deny: [
		"Force pushing, deleting remote branches",
		"Bulk or recursive file deletions (e.g. rm -rf, rm -r, Remove-Item -Recurse)",
	],
	hard_deny: ["Sending data to third-party APIs or external services"],
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

type Scope = "project" | "user";

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

function tildify(p: string): string {
	const home = homedir();
	return p === home || p.startsWith(`${home}/`) || p.startsWith(`${home}\\`)
		? `~${p.slice(home.length)}`
		: p;
}

function loadConfig(cwd: string): ResolvedConfig {
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
	const bashReadOnlyAllowCwd = project.bashReadOnlyAllowCwd ?? user.bashReadOnlyAllowCwd ?? true;
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
		autoMode,
		implicit: { allow: implicitAllow, toolDefaults: implicitToolDefaults, readAllowCwd, grepAllowCwd, globAllowCwd, lsAllowCwd, readAllowSkills, readAllowPiDocs, bashReadOnlyAllowCwd, allowNoopCd },
	};
}

function dedupe(items: string[]): string[] {
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

/** Replace all backslashes with forward slashes. */
export function normalizePathSep(p: string): string {
	return p.replace(/\\/g, "/");
}

/**
 * Normalize a path for permission matching only — never used for actual tool execution.
 * Replaces backslashes with forward slashes, and resolves relative paths against cwd
 * so they can be compared against absolute patterns like the injected cwd glob.
 */
export function normalizeMatchPath(p: string, cwd: string): string {
	if (!p) return p;
	const sep = normalizePathSep(p);
	// Relative: doesn't start with / or a Windows drive letter (e.g. C:)
	if (!sep.startsWith("/") && !/^[A-Za-z]:/.test(sep)) {
		return normalizePathSep(resolve(cwd, p));
	}
	return sep;
}

/** Returns the glob pattern that matches cwd and all its descendants. */
export function cwdGlobPattern(cwd: string): string {
	return normalizePathSep(cwd) + "/**";
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
export function isNoopCd(cmd: string, cwd: string): boolean {
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

	// Check whether the path (absolute or relative) resolves to cwd.
	// For absolute paths we compare directly to avoid OS-specific resolve() quirks
	// (e.g. on Windows, resolve('/unix/path') prepends the current drive).
	try {
		const stripped = arg.replace(/\/+$/, "");
		const argNorm = normalizePathSep(stripped);
		const isAbsolute = argNorm.startsWith("/") || /^[A-Za-z]:/.test(argNorm);
		const resolved = isAbsolute ? argNorm : normalizePathSep(resolve(cwd, stripped));
		return resolved.toLowerCase() === normalizePathSep(cwd).toLowerCase();
	} catch {
		return false;
	}
}

/**
 * Bash subcommand names that are read-only and never touch the filesystem
 * meaningfully — safe to auto-allow regardless of arguments.
 */
const READONLY_BASH_SAFE_ALWAYS = new Set([
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
 * consumers — rule pattern matching, `tokenizeSimple`, `hasTopLevelOutputRedirect`,
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
 * Returns true when `cmd` contains a top-level output redirection operator
 * (`>`, `>>`, `2>`, `&>`, etc.) outside of single or double quotes.
 * Used to reject otherwise-safe commands that write to files via redirection.
 */
function hasTopLevelOutputRedirect(cmd: string): boolean {
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < cmd.length; i++) {
		const ch = cmd[i];
		if (ch === "\\" && !inSingle) { i++; continue; }
		if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
		if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
		if (!inSingle && !inDouble && ch === ">") return true;
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
 *  1. Reject if cmd contains a top-level output redirection (>).
 *  2. If the first token is in READONLY_BASH_SAFE_ALWAYS → allow.
 *  3. If the first token is in READONLY_BASH_WITH_PATHS → allow only when
 *     every non-flag argument resolves to a path inside (or equal to) cwd.
 *  4. Anything else → false.
 */
export function isReadOnlyBashSubcommand(cmd: string, cwd: string): boolean {
	const trimmed = cmd.trim();
	if (!trimmed) return false;
	if (hasTopLevelOutputRedirect(trimmed)) return false;
	const tokens = tokenizeSimple(trimmed);
	if (tokens.length === 0) return false;
	const cmdName = tokens[0].toLowerCase();
	if (READONLY_BASH_SAFE_ALWAYS.has(cmdName)) return true;
	if (READONLY_BASH_WITH_PATHS.has(cmdName)) {
		const pathArgs = tokens.slice(1).filter((t) => t.length > 0 && !t.startsWith("-"));
		// No path args — command implicitly uses cwd, safe
		if (pathArgs.length === 0) return true;
		const cwdNorm = normalizePathSep(cwd).toLowerCase();
		return pathArgs.every((arg) => {
			const norm = normalizeMatchPath(arg, cwd).toLowerCase();
			return norm === cwdNorm || norm.startsWith(cwdNorm + "/");
		});
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

interface ParsedRule {
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

// ── Compound command splitting ─────────────────────────────────────────────

type SplitResult =
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
export function stripStructuralKeywords(part: string): string | null {
	let s = part.trim();
	while (s.length > 0) {
		// Pure structural keyword tokens — bare, no arguments
		if (s === "do" || s === "done" || s === "then" || s === "else" || s === "fi") return null;
		// Iteration / case heads — the head itself runs no user command.
		// `for` and `select` share the same `VAR in ARGS` / `VAR` / `((...))` shapes.
		// \S+ greedily eats the C-style `((i=0;i<10;i++))` (no whitespace inside).
		if (/^(for|select)\s+\S+(\s+in\b[^\n]*)?$/.test(s)) return null;
		// Prefix keywords — a command follows; strip the keyword and re-test the
		// residue. Covers: do, then, else (when followed by a command), and the
		// control-condition keywords while, until, if, elif.
		const prefixMatch = s.match(/^(do|then|else|while|until|if|elif)\s+/);
		if (prefixMatch) { s = s.slice(prefixMatch[0].length); continue; }
		break;
	}
	return s.length > 0 ? s : null;
}

interface SubcommandDecision {
	sub: string;
	action: Action;
}

interface CompoundDecision {
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

type ClassifierVerdict = "allow" | "soft_deny" | "hard_deny" | "no_match";

interface ClassifyResult {
	verdict: ClassifierVerdict;
	reason: string;
}

/** Seam type for the model completion call (mirrors ModelRegistry.complete). */
type ClassifierComplete = (model: Model<Api>, context: Context) => Promise<AssistantMessage>;

/** Auth-gate seam for model selection (mirrors ModelRegistry.hasConfiguredAuth). */
type HasAuth = (model: Model<Api>) => boolean;

/** Cost proxy: cheaper/faster models first. Lower score = preferred. */
export function modelCostScore(model: Model<Api>): number {
	return (model.cost.input ?? 0) + (model.cost.output ?? 0);
}

export function dedupeModels(pool: Model<Api>[]): Model<Api>[] {
	const seen = new Set<string>();
	const out: Model<Api>[] = [];
	for (const m of pool) {
		const key = `${m.provider}/${m.id}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(m);
	}
	return out;
}

/**
 * Rank a model pool for the classifier, mirroring idle-summary's rankSummaryModels:
 * models from `currentProvider` come first (cheapest within that provider first),
 * then all other providers in ascending cost order. Ties keep insertion order.
 */
export function rankClassifierModels(pool: Model<Api>[], currentProvider: string | undefined): Model<Api>[] {
	const unique = dedupeModels(pool);
	return [...unique].sort((a, b) => {
		const aSame = currentProvider !== undefined && a.provider === currentProvider;
		const bSame = currentProvider !== undefined && b.provider === currentProvider;
		if (aSame !== bSame) return aSame ? -1 : 1;
		return modelCostScore(a) - modelCostScore(b);
	});
}

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
	for (const m of rankClassifierModels(pool, currentProvider)) {
		if (hasAuth(m)) return m;
	}
	return undefined;
}

/** Build a short human-readable description of the action for the classifier. */
export function describeAction(toolName: string, input: Record<string, unknown>): string {
	const t = normalizeTool(toolName);
	if (t === "bash" || t === "pwsh") return `Tool: ${toolName}\nCommand: ${String(input.command ?? "")}`;
	if (t === "read" || t === "write" || t === "edit" || t === "grep" || t === "glob" || t === "ls")
		return `Tool: ${toolName}\nPath: ${String(input.path ?? "")}`;
	if (t === "webfetch") return `Tool: ${toolName}\nURL: ${String(input.url ?? "")}`;
	try { return `Tool: ${toolName}\nInput: ${JSON.stringify(input)}`; } catch { return `Tool: ${toolName}`; }
}

export function buildClassifierPrompt(toolName: string, input: Record<string, unknown>, autoMode: ResolvedAutoModeConfig): string {
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
		"VERDICT: <allow|soft_deny|hard_deny|no_match>",
		"REASON: <one short sentence>",
		"If the action matches an Allow rule, verdict is allow. If it matches a Hard deny rule, verdict is hard_deny. If it matches a Soft deny rule, verdict is soft_deny. Otherwise, verdict is no_match.",
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
export function classifierCacheKey(toolName: string, input: Record<string, unknown>, autoMode: ResolvedAutoModeConfig): string {
	const ruleset = JSON.stringify({
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
): Promise<ClassifyResult> {
	const key = classifierCacheKey(toolName, input, autoMode);
	const cached = cache.get(key);
	if (cached) return cached;
	const prompt = buildClassifierPrompt(toolName, input, autoMode);
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
	if (check(cfg.deny)) return "deny";
	// Read-only bash auto-allow short-circuit. When the auto layer is engaged
	// (session toggle on) AND classifyAllShell is set, route read-only bash
	// subcommands through the classifier instead of silently allowing them.
	// (No-op `cd` is pure bookkeeping with zero side-effects/data access, so
	// allowNoopCd stays active regardless of the toggle.)
	const skipReadOnlyBash = autoActive && cfg.autoMode.classifyAllShell;
	if (!skipReadOnlyBash && cfg.bashReadOnlyAllowCwd && normalizeTool(toolName) === "bash" && isReadOnlyBashSubcommand(String(input.command ?? ""), cfg.cwd)) return "allow";
	if (cfg.allowNoopCd && normalizeTool(toolName) === "bash" && isNoopCd(String(input.command ?? ""), cfg.cwd)) return "allow";
	if (check(cfg.ask)) return "ask";
	if (check(cfg.allow)) return "allow";
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
 * Build an optional extra-info line for the pwsh permission prompt showing the
 * working directory and/or timeout when the call provided them. Returns an empty
 * string for non-pwsh tools or when neither field is present, so the generic
 * single-command prompt title is unaffected.
 */
function pwshExtraInfo(toolName: string, input: Record<string, unknown>): string {
	if (normalizeTool(toolName) !== "pwsh") return "";
	const parts: string[] = [];
	const cwd = input.cwd;
	if (typeof cwd === "string" && cwd) parts.push(`cwd: ${cwd}`);
	const timeout = input.timeout;
	if (typeof timeout === "number") parts.push(`timeout: ${timeout}s`);
	return parts.length ? `\n  ${parts.join(", ")}` : "";
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

export default function (pi: ExtensionAPI) {
	let cfg: ResolvedConfig = loadConfig(process.cwd());
	let allowAllEdits = false;
	// Auto-mode session toggle (off by default, never persisted). When on,
	// fallthroughs that reach the auto layer (between `toolDefaults` and
	// `defaultAction`) are screened by the classifier; if no classifier model
	// is available they fall back to `ask` (safe stub). Mirrors `allowAllEdits`.
	let autoModeEnabled = false;
	// Per-session classifier verdict cache (keyed by toolName+input+ruleset). Bounds
	// token cost when the same action repeats in a loop. See classifierCacheKey().
	const verdictCache = new Map<string, ClassifyResult>();

	// ── Deny-with-message helper ─────────────────────────────────────────────

	/**
	 * After a tool is denied, optionally prompt the user to send a steering
	 * message to the AI (e.g. "please use a different approach").
	 * If the user leaves the field empty, nothing is sent.
	 */
	async function promptSteerMessage(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) return;
		const text = await ctx.ui.input(
			"Send a message to the AI? (leave empty to skip)",
			"e.g. please do this differently...",
		);
		if (text && text.trim()) {
			pi.sendUserMessage(text.trim(), { deliverAs: "steer" });
		}
	}

	// ── Allow-all-edits helpers ──────────────────────────────────────────────

	function applyAllowAllEdits(value: boolean, ctx: ExtensionContext, notify = true): void {
		allowAllEdits = value;
		if (value) {
			ctx.ui.setStatus(STATUS_KEY, "✏️ all edits allowed");
			if (notify) ctx.ui.notify("Allow all edits: ON (this session only)", "info");
		} else {
			ctx.ui.setStatus(STATUS_KEY, "");
			if (notify) ctx.ui.notify("Allow all edits: OFF", "info");
		}
	}

	// ── Auto-mode helpers ─────────────────────────────────────────────────────

	function applyAutoMode(value: boolean, ctx: ExtensionContext, notify = true): void {
		autoModeEnabled = value;
		if (value) {
			ctx.ui.setStatus(STATUS_KEY_AUTO, "🤖 auto mode on");
			if (notify) ctx.ui.notify("Auto mode: ON (this session only)", "info");
		} else {
			ctx.ui.setStatus(STATUS_KEY_AUTO, "");
			if (notify) ctx.ui.notify("Auto mode: OFF", "info");
		}
	}

	// ── Session lifecycle ────────────────────────────────────────────────────

	const reload = (cwd: string, ctx?: ExtensionContext) => {
		cfg = loadConfig(cwd);
		ctx?.ui.notify(
			`Tool permissions reloaded (default=${cfg.defaultAction}, allow=${cfg.allow.length}, deny=${cfg.deny.length}, ask=${cfg.ask.length}, toolDefaults=${Object.keys(cfg.toolDefaults).length})`,  
			"info",
		);
	};

	pi.on("session_start", async (_event, ctx) => {
		cfg = loadConfig(ctx.cwd);
		// Always reset allow-all-edits and auto-mode at session start — never persisted.
		allowAllEdits = false;
		autoModeEnabled = false;
		ctx.ui.setStatus(STATUS_KEY, "");
		ctx.ui.setStatus(STATUS_KEY_AUTO, "");
	});

	// ── Tool call gating ─────────────────────────────────────────────────────

	pi.on("tool_call", async (event, ctx) => {
		const matchInput = inputForMatching(event.toolName, event.input as Record<string, unknown>, ctx.cwd);
		const nonInteractive = ctx.mode === "print" || ctx.mode === "json";
		const autoActive = autoModeEnabled;
		// Pick the classifier model (explicit pin, or auto-select from the pool
		// preferring the currently selected model's provider). Mirrors idle-summary.
		const classifierModel = autoActive
			? pickClassifierModel(
				ctx.scopedModels.length > 0 ? ctx.scopedModels.map((s) => s.model) : ctx.modelRegistry.getAvailable(),
				ctx.model?.provider,
				(m) => ctx.modelRegistry.hasConfiguredAuth(m),
				cfg.autoMode.classifier,
				(provider, modelId) => ctx.modelRegistry.find(provider, modelId),
			)
			: undefined;
		const autoEngaged = autoActive && classifierModel !== undefined;
		// Pass `autoActive` (session toggle), not `autoEngaged`: the "auto" sentinel
		// should surface whenever the toggle is on so the loop below can stub it to
		// `ask` when no classifier model is available (rather than silently applying
		// `defaultAction`).
		const compound = decideCompound(cfg, event.toolName, matchInput, autoActive);
		let { action, isCompound, ambiguous, breakdown } = compound;
		let classifierReason = "";

		// Resolve a fallthrough "auto" sentinel. For single/ambiguous commands we
		// classify up front; for compound commands the prompt loop classifies each
		// auto sub. When the toggle is on but no classifier model is available
		// (`!autoEngaged`), stub to `ask` (safe) rather than applying `defaultAction`.
		if (action === "auto") {
			if (autoEngaged && classifierModel && !isCompound) {
				const result = await classifyAction(
					(m, c) => ctx.modelRegistry.complete(m, c),
					classifierModel,
				event.toolName,
				matchInput,
				cfg.autoMode,
				verdictCache,
			);
				classifierReason = result.reason;
				action = verdictToAction(result.verdict, nonInteractive, cfg.defaultAction);
			} else if (!autoEngaged || isCompound) {
				// Stub (no model) or compound (loop handles per-sub).
				action = "ask";
			}
		}

		if (action === "allow") return undefined;

		// Explicit deny rules always win, even over allow-all-edits
		if (action === "deny") {
			const culprit = isCompound ? breakdown.find((b) => b.action === "deny") : null;
			const base = culprit
				? `Blocked ${event.toolName}: '${culprit.sub}' matched a deny rule`
				: `Blocked ${event.toolName} by tool-permissions deny rule`;
			const message = classifierReason ? `${base} (classifier: ${classifierReason})` : base;
			if (ctx.hasUI) {
				ctx.ui.notify(message, "warning");
			}
			return { block: true, reason: message };
		}

		// action === "ask" from here on

		const toolNorm = normalizeTool(event.toolName);
		const isWriteOrEdit = toolNorm === "write" || toolNorm === "edit";

		// Allow-all-edits short-circuits the ask for write/edit tools only
		if (allowAllEdits && isWriteOrEdit) {
			return undefined;
		}

		if (!ctx.hasUI) {
			return {
				block: true,
				reason: `tool-permissions: '${event.toolName}' requires confirmation but no UI is available`,
			};
		}

		// ── Compound bash command: confirm each ask subcommand separately ──────
		// Note: decideCompound() short-circuits any compound containing a `deny`
		// subcommand before we reach this loop (see the `culprit` block above),
		// so the loop below only iterates over `ask` items.
		if (isCompound) {
			const fullCmd = String((event.input as Record<string, unknown>).command ?? "");
			const truncated = fullCmd.length > 200 ? `${fullCmd.slice(0, 197)}...` : fullCmd;

			// Loop-scoped (this Bash invocation only — not session-wide): when set,
			// every remaining `ask` step is silently allowed without re-prompting
			// and without saving any rule. Resets when this handler returns.
			let allowAllStepsOnce = false;

			// Snapshot of the per-subcommand decisions that the dialog renders.
			// Mutated after each rule-save so downstream icons reflect the new cfg.
			let currentBreakdown = breakdown;

			// Iterate over the original `ask`/`auto` subcommands, but re-decide each one
			// against the current `cfg` right before prompting so newly saved
			// allow/deny rules apply to the rest of *this* compound command.
			const askSubs = breakdown.filter((b) => b.action === "ask" || b.action === "auto").map((b) => b.sub);

			for (const sub of askSubs) {
				// User intent (`Allow ALL steps once`) beats any rule-driven decision:
				// a freshly saved deny must not override an explicit one-shot allow.
				if (allowAllStepsOnce) continue;

				let liveAction = decide(cfg, "bash", { command: sub }, autoActive);
				let subReason = "";
				// Auto fallthrough: run the classifier for this subcommand.
				if (liveAction === "auto") {
					if (autoEngaged && classifierModel) {
						const result = await classifyAction(
							(m, c) => ctx.modelRegistry.complete(m, c),
							classifierModel,
							"bash",
							{ command: sub },
							cfg.autoMode,
							verdictCache,
						);
						subReason = result.reason;
						liveAction = verdictToAction(result.verdict, nonInteractive, cfg.defaultAction);
					} else {
						liveAction = "ask";
					}
				}
				if (liveAction === "allow") continue;
				if (liveAction === "deny") {
					// No steer prompt here — this branch is only reached for static deny rules
					// and classifier hard_deny verdicts (neither is user-initiated). The
					// classifier's reason is already in the block message; user denies
					// steer via the Deny-once / Deny-always choice branches below.
					const reason = subReason
						? `Blocked by classifier (subcommand: ${sub}): ${subReason}`
						: `Blocked by tool-permissions deny rule (subcommand: ${sub})`;
					return { block: true, reason };
				}

				const suggested = suggestRule("Bash", { command: sub });
				const breakdownLines = formatBreakdown(currentBreakdown, sub);

				const reasonNote = subReason ? `\n\n  classifier: ${subReason}` : "";
				const title = `Allow Bash subcommand?\n\nFull command:\n  ${truncated}\n\nBreakdown:\n${breakdownLines}${reasonNote}`;
				const choices = [
					"Allow once",
					"Allow ALL steps once",
					...(!autoActive ? ["Switch to auto mode (this session)"] : []),
					"Allow always (save rule)",
					"Deny once",
					"Deny always (save rule)",
				];
				const choice = await ctx.ui.select(title, choices);

				if (choice === "Allow once") continue;

				if (choice === "Allow ALL steps once") {
					allowAllStepsOnce = true;
					continue;
				}

				if (choice === "Switch to auto mode (this session)") {
					applyAutoMode(true, ctx);
					// Let the rest of this compound finish without re-prompting; future
					// tool calls go through the classifier. (Any `deny` sub was already
					// blocked by decideCompound before this loop runs.)
					allowAllStepsOnce = true;
					continue;
				}

				if (choice === "Deny once" || !choice) {
					if (choice === "Deny once") await promptSteerMessage(ctx);
					return { block: true, reason: `Denied by user (subcommand: ${sub})` };
				}
				if (choice === "Allow always (save rule)") {
					const edited = await ctx.ui.editor("Edit rule before saving:", suggested);
					if (!edited) continue;
					const scope = await promptScope(ctx);
					// Cancelling scope == cancelling the save (matches editor-cancel above).
					if (!scope) continue;
					addRule(scope, ctx.cwd, "allow", edited.trim());
					cfg = loadConfig(ctx.cwd);
					currentBreakdown = recomputeBreakdown(breakdown, cfg, autoActive);
					const autoCount = currentBreakdown.filter(
						(b) => b.sub !== sub && askSubs.includes(b.sub) && b.action === "allow",
					).length;
					const suffix = autoCount > 0 ? ` (auto-allows ${autoCount} remaining step${autoCount === 1 ? "" : "s"})` : "";
					ctx.ui.notify(`Saved allow rule (${scope}): ${edited.trim()}${suffix}`, "info");
					continue;
				}
				if (choice === "Deny always (save rule)") {
					const edited = await ctx.ui.editor("Edit rule before saving:", suggested);
					if (!edited) {
						await promptSteerMessage(ctx);
						return { block: true, reason: `Denied by user (subcommand: ${sub})` };
					}
					const scope = await promptScope(ctx);
					// Cancelling scope == treating as deny-once (no rule saved, but command still blocked).
					if (!scope) {
						await promptSteerMessage(ctx);
						return { block: true, reason: `Denied by user (subcommand: ${sub})` };
					}
					addRule(scope, ctx.cwd, "deny", edited.trim());
					cfg = loadConfig(ctx.cwd);
					currentBreakdown = recomputeBreakdown(breakdown, cfg, autoActive);
					ctx.ui.notify(`Saved deny rule (${scope}): ${edited.trim()}`, "info");
					await promptSteerMessage(ctx);
					return { block: true, reason: `Blocked by tool-permissions deny rule (${edited.trim()})` };
				}
			}
			return undefined;
		}

		// ── Single or ambiguous command ask ────────────────────────────────────
		const suggested = suggestRule(event.toolName, event.input as Record<string, unknown>);
		const matchField = getMatchField(event.toolName, event.input as Record<string, unknown>);
		const preview = matchField.length > 200 ? `${matchField.slice(0, 197)}...` : matchField;
		const ambiguousNote = ambiguous ? "\n\n(complex command — could not be split for per-subcommand checks)" : "";
		const extraInfo = pwshExtraInfo(event.toolName, event.input as Record<string, unknown>);
		const reasonNote = classifierReason ? `\n\n  classifier: ${classifierReason}` : "";
		const title = `Allow ${event.toolName}?\n\n  ${preview}${extraInfo}${ambiguousNote}${reasonNote}`;

		// Extra "allow all edits" option only for write/edit dialogs; "Switch to
		// auto mode" appears for every dialog when auto mode isn't already active.
		const autoSwitch = !autoActive ? ["Switch to auto mode (this session)"] : [];
		const choices = isWriteOrEdit
			? [
					"Allow once",
					"Allow all edits this session",
					...autoSwitch,
					"Allow always (save rule)",
					"Deny once",
					"Deny always (save rule)",
			  ]
			: ["Allow once", ...autoSwitch, "Allow always (save rule)", "Deny once", "Deny always (save rule)"];

		const choice = await ctx.ui.select(title, choices);

		if (choice === "Allow once") return undefined;

		if (choice === "Allow all edits this session") {
			applyAllowAllEdits(true, ctx);
			return undefined;
		}

		if (choice === "Switch to auto mode (this session)") {
			applyAutoMode(true, ctx);
			return undefined;
		}

		if (choice === "Deny once" || !choice) {
			if (choice === "Deny once") await promptSteerMessage(ctx);
			return { block: true, reason: "Denied by user" };
		}
		if (choice === "Allow always (save rule)") {
			const edited = await ctx.ui.editor("Edit rule before saving:", suggested);
			if (!edited) return undefined;
			const scope = await promptScope(ctx);
			// Cancelling scope == cancelling the save (matches editor-cancel above).
			if (!scope) return undefined;
			addRule(scope, ctx.cwd, "allow", edited.trim());
			cfg = loadConfig(ctx.cwd);
			ctx.ui.notify(`Saved allow rule (${scope}): ${edited.trim()}`, "info");
			return undefined;
		}
		if (choice === "Deny always (save rule)") {
			const edited = await ctx.ui.editor("Edit rule before saving:", suggested);
			if (!edited) {
				await promptSteerMessage(ctx);
				return { block: true, reason: "Denied by user" };
			}
			const scope = await promptScope(ctx);
			// Cancelling scope == treating as deny-once (no rule saved, but command still blocked).
			if (!scope) {
				await promptSteerMessage(ctx);
				return { block: true, reason: "Denied by user" };
			}
			addRule(scope, ctx.cwd, "deny", edited.trim());
			cfg = loadConfig(ctx.cwd);
			ctx.ui.notify(`Saved deny rule (${scope}): ${edited.trim()}`, "info");
			await promptSteerMessage(ctx);
			return { block: true, reason: `Blocked by tool-permissions deny rule (${edited.trim()})` };
		}
		return { block: true, reason: "Denied by user" };
	});

	// ── Hotkey ───────────────────────────────────────────────────────────────

	// Note: ctrl+alt+e (not ctrl+shift+e) because most terminals can't distinguish
	// ctrl+shift+<letter> from ctrl+<letter> — both emit the same control byte
	// unless the terminal supports the Kitty keyboard protocol. Alt is sent as an
	// ESC prefix, so ctrl+alt+e is reliably distinguishable from ctrl+e.
	pi.registerShortcut("ctrl+alt+e", {
		description: "Toggle allow-all-edits mode (this session only)",
		handler: async (ctx) => {
			applyAllowAllEdits(!allowAllEdits, ctx);
		},
	});

	pi.registerShortcut("ctrl+alt+a", {
		description: "Toggle auto permissions mode (this session only)",
		handler: async (ctx) => {
			applyAutoMode(!autoModeEnabled, ctx);
		},
	});

	// ── Rule helpers ─────────────────────────────────────────────────────────

	function addRule(scope: Scope, cwd: string, action: ListAction, rule: string): void {
		const cfg = scope === "user" ? loadUserConfigRaw() : loadProjectConfigRaw(cwd);
		const list = cfg[action] ?? [];
		if (!list.includes(rule)) list.push(rule);
		cfg[action] = dedupe(list);
		if (scope === "user") saveUserConfig(cfg);
		else saveProjectConfig(cwd, cfg);
	}

	function removeRule(scope: Scope, cwd: string, rule: string): boolean {
		const cfg = scope === "user" ? loadUserConfigRaw() : loadProjectConfigRaw(cwd);
		let removed = false;
		for (const key of ["allow", "deny", "ask"] as const) {
			const list = cfg[key];
			if (!list) continue;
			const idx = list.indexOf(rule);
			if (idx >= 0) {
				list.splice(idx, 1);
				removed = true;
			}
		}
		if (removed) {
			if (scope === "user") saveUserConfig(cfg);
			else saveProjectConfig(cwd, cfg);
		}
		return removed;
	}

	function setDefault(scope: Scope, cwd: string, action: DefaultAction): void {
		const cfg = scope === "user" ? loadUserConfigRaw() : loadProjectConfigRaw(cwd);
		cfg.defaultAction = action;
		if (scope === "user") saveUserConfig(cfg);
		else saveProjectConfig(cwd, cfg);
	}

	// Interactive scope picker used by Allow/Deny-always prompts. Returns null on Esc.
	async function promptScope(ctx: ExtensionContext): Promise<Scope | null> {
		const projectPath = tildify(join(ctx.cwd, PROJECT_CONFIG_REL));
		const userPath = tildify(userConfigPath());
		const projectLabel = `Project (${projectPath})`;
		const userLabel = `User (${userPath})`;
		const choice = await ctx.ui.select("Save rule where?", [projectLabel, userLabel]);
		if (!choice) return null;
		return choice === userLabel ? "user" : "project";
	}

	// ── Slash command ────────────────────────────────────────────────────────

	pi.registerCommand("permissions", {
		description: "Manage tool permissions (allow/deny/ask/auto) and allow-all-edits / auto modes",
		getArgumentCompletions: (prefix: string) => {
			const subs = ["help", "list", "allow", "deny", "ask", "remove", "default", "reload", "allowalledits", "auto"];
			const items = subs.map((s) => ({ value: s, label: s }));
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const trimmed = (args ?? "").trim();
			if (!trimmed || trimmed === "help") {
				const helpLines = [
					"pi-tool-permissions — usage",
					"",
					"Subcommands:",
					"  /permissions                  Show this help",
					"  /permissions help             Show this help",
					"  /permissions list             Show current rules + allow-all-edits / auto state",
					"  /permissions allow <rule> [--user]   Add an allow rule (default: project)",
					"  /permissions deny  <rule> [--user]   Add a deny rule",
					"  /permissions ask   <rule> [--user]   Add an ask rule",
					"  /permissions remove <rule> [--user]  Remove a rule from any list",
					"  /permissions default <allow|deny|ask> [--user]",
					"  /permissions reload           Reload config from disk",
					"  /permissions allowalledits [on|off|toggle]",
					"  /permissions auto [on|off|toggle]   Toggle auto-mode (LLM classifier) for this session",
					"",
					"Rule syntax:  ToolName  or  ToolName(pattern)",
					"  Patterns are case-insensitive globs (* = any chars, ? = one char).",
					"  A ' *' pair is optional, so Bash(git status *) matches 'git status' too.",
					"  Wrap in slashes for regex: Bash(/^git (push|tag) /)",
					"",
					"Precedence (first match wins):  deny > ask > allow > toolDefaults > defaultAction",
					"",
					"Session toggles (off by default, never persisted):",
					"  allow-all-edits  — auto-approve every Write/Edit  (Ctrl+Alt+E)",
					"  auto mode       — classifier screens fallthroughs   (Ctrl+Alt+A)",
					"    Only active when defaultAction === \"auto\". See docs/auto-mode-design.md.",
					"",
					"Config files (project overrides user for defaultAction; lists concat):",
					"  ~/.pi/agent/pi-tool-permissions.json          (user)",
					"  <cwd>/.pi/pi-tool-permissions.local.json      (project, machine-local)",
				];
				ctx.ui.notify(helpLines.join("\n"), "info");
				return;
			}

			if (trimmed === "list") {
				const implicitAllowSet = new Set(cfg.implicit.allow);
				const implicitTDKeys = new Set(Object.keys(cfg.implicit.toolDefaults));
				const tdEntries = Object.entries(cfg.toolDefaults);
				// Re-read both raw files so we can tag each merged rule with its source.
				const userRaw = loadUserConfigRaw();
				const projectRaw = loadProjectConfigRaw(ctx.cwd);
				const sourceTag = (action: "allow" | "deny" | "ask", rule: string): string => {
					const inUser = userRaw[action]?.includes(rule) ?? false;
					const inProject = projectRaw[action]?.includes(rule) ?? false;
					if (inUser && inProject) return "[user+project]";
					if (inUser) return "[user]";
					if (inProject) return "[project]";
					return "";
				};
				const formatRule = (action: "allow" | "deny" | "ask", r: string, implicitSet?: Set<string>): string => {
					if (implicitSet?.has(r)) return `  [implicit] ${r}`;
					const tag = sourceTag(action, r);
					return tag ? `  ${tag} ${r}` : `  - ${r}`;
				};
				const lines = [
					`default: ${cfg.defaultAction}`,
					`readAllowCwd: ${cfg.implicit.readAllowCwd}`,
					`grepAllowCwd: ${cfg.implicit.grepAllowCwd}`,
					`globAllowCwd: ${cfg.implicit.globAllowCwd}`,
					`lsAllowCwd: ${cfg.implicit.lsAllowCwd}`,
					`readAllowSkills: ${cfg.implicit.readAllowSkills}`,
					`readAllowPiDocs: ${cfg.implicit.readAllowPiDocs}`,
					`bashReadOnlyAllowCwd: ${cfg.implicit.bashReadOnlyAllowCwd}`,
					`allowNoopCd: ${cfg.implicit.allowNoopCd}`,
					`allow all edits (this session): ${allowAllEdits ? "ON" : "OFF"}`,
				`auto mode (this session): ${autoModeEnabled ? "ON" : "OFF"}`,
				`autoMode.classifier: ${cfg.autoMode.classifier ? `${cfg.autoMode.classifier.provider}/${cfg.autoMode.classifier.model}` : "(auto-select)"}`,
				`autoMode.classifyAllShell: ${cfg.autoMode.classifyAllShell}`,
				`autoMode.environment (${cfg.autoMode.environment.length}):`,
				...cfg.autoMode.environment.map((r) => `  - ${r}`),
				`autoMode.allow (${cfg.autoMode.allow.length}):`,
				...cfg.autoMode.allow.map((r) => `  - ${r}`),
				`autoMode.soft_deny (${cfg.autoMode.soft_deny.length}):`,
				...cfg.autoMode.soft_deny.map((r) => `  - ${r}`),
				`autoMode.hard_deny (${cfg.autoMode.hard_deny.length}):`,
				...cfg.autoMode.hard_deny.map((r) => `  - ${r}`),
					`allow (${cfg.allow.length}):`,
					...cfg.allow.map((r) => formatRule("allow", r, implicitAllowSet)),
					`deny (${cfg.deny.length}):`,
					...cfg.deny.map((r) => formatRule("deny", r)),
					`ask (${cfg.ask.length}):`,
					...cfg.ask.map((r) => formatRule("ask", r)),
					`toolDefaults (${tdEntries.length}):`,
					...tdEntries.map(([k, v]) =>
						implicitTDKeys.has(k) ? `  [implicit] ${k} -> ${v}` : `  - ${k} -> ${v}`
					),
				];
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			const [sub, ...restAll] = trimmed.split(/\s+/);
			// Allow `--user` anywhere after the subcommand to target the user-global config.
			let scope: Scope = "project";
			const rest = restAll.filter((tok) => {
				if (tok === "--user") { scope = "user"; return false; }
				if (tok === "--project") { scope = "project"; return false; }
				return true;
			});
			const value = rest.join(" ").trim();

			switch (sub) {
				case "help":
					// Bare /permissions and /permissions help are handled above; this covers
					// `/permissions help <anything>` by just re-showing help.
					ctx.ui.notify("Use /permissions to see help, or /permissions help.", "info");
					return;
				case "reload":
					reload(ctx.cwd, ctx);
					return;
				case "default": {
					if (!isDefaultAction(value)) {
						ctx.ui.notify(`Usage: /permissions default <allow|deny|ask> [--user] (use \`/permissions auto on\` for auto mode)`, "warning");
						return;
					}
					setDefault(scope, ctx.cwd, value);
					reload(ctx.cwd, ctx);
					ctx.ui.notify(`Set default (${scope}): ${value}`, "info");
					return;
				}
				case "allowalledits": {
					const normalized = value.toLowerCase();
					if (!normalized || normalized === "toggle") {
						applyAllowAllEdits(!allowAllEdits, ctx);
					} else if (normalized === "on") {
						applyAllowAllEdits(true, ctx);
					} else if (normalized === "off") {
						applyAllowAllEdits(false, ctx);
					} else {
						ctx.ui.notify(`Usage: /permissions allowalledits [on|off|toggle]`, "warning");
					}
					return;
				}
				case "auto": {
				const normalized = value.toLowerCase();
				if (!normalized || normalized === "toggle") {
					applyAutoMode(!autoModeEnabled, ctx);
				} else if (normalized === "on") {
					applyAutoMode(true, ctx);
				} else if (normalized === "off") {
					applyAutoMode(false, ctx);
				} else {
					ctx.ui.notify(`Usage: /permissions auto [on|off|toggle]`, "warning");
				}
				return;
			}
			case "allow":
				case "deny":
				case "ask": {
					if (!value) {
						ctx.ui.notify(`Usage: /permissions ${sub} <rule> [--user]`, "warning");
						return;
					}
					if (!parseRule(value)) {
						ctx.ui.notify(`Invalid rule: ${value}. Expected ToolName or ToolName(pattern).`, "warning");
						return;
					}
					addRule(scope, ctx.cwd, sub, value);
					reload(ctx.cwd, ctx);
					ctx.ui.notify(`Added ${sub} rule (${scope}): ${value}`, "info");
					return;
				}
				case "remove": {
					if (!value) {
						ctx.ui.notify(`Usage: /permissions remove <rule> [--user]`, "warning");
						return;
					}
					const removed = removeRule(scope, ctx.cwd, value);
					if (removed) {
						reload(ctx.cwd, ctx);
						ctx.ui.notify(`Removed rule (${scope}): ${value}`, "info");
					} else {
						ctx.ui.notify(`Rule not found in ${scope} config: ${value}`, "warning");
					}
					return;
				}
				default:
					ctx.ui.notify(
						`Unknown subcommand: ${sub}. Use: help | list | allow | deny | ask | remove | default | reload | allowalledits | auto`,
						"warning",
					);
			}
		},
	});
}

function isDefaultAction(s: string): s is DefaultAction {
	return s === "allow" || s === "deny" || s === "ask";
}
