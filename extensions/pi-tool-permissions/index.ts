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
 *     "bashReadOnlyAllowCwd": true
 *   }
 *
 * Precedence (first match wins): deny > ask > allow > toolDefaults > defaultAction.
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
 *
 * Allow-all-edits mode:
 *   A session-only toggle that auto-allows all Write and Edit tool calls without
 *   prompting. Never persisted to disk. Always starts disabled. Explicit deny rules
 *   still take priority even when this mode is on.
 *
 *   Toggle via:
 *     - Ctrl+Shift+E hotkey
 *     - "Allow all edits this session" option in the Write/Edit permission dialog
 *     - /permissions allowalledits [on|off|toggle]
 *
 * Slash commands:
 *   /permissions                       - show current rules + allow-all-edits state
 *   /permissions list                  - alias for bare /permissions
 *   /permissions allow <rule>          - add an allow rule (project)
 *   /permissions deny  <rule>          - add a deny rule (project)
 *   /permissions ask   <rule>          - add an ask rule (project)
 *   /permissions remove <rule>         - remove a rule from any list
 *   /permissions default <allow|deny|ask>
 *   /permissions reload                - reload config from disk
 *   /permissions allowalledits [on|off|toggle]
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Action = "allow" | "deny" | "ask";

interface PermissionsConfig {
	defaultAction?: Action;
	allow?: string[];
	deny?: string[];
	ask?: string[];
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
	defaultAction: Action;
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

const USER_CONFIG = join(homedir(), ".pi", "agent", "pi-tool-permissions.json");
const LEGACY_USER_CONFIG = join(homedir(), ".pi", "tool-permissions.json");
// Project config: prefer the `.local.json` suffix (machine-local, not checked
// into git). Two legacy filenames are still read as fallbacks and auto-migrated
// to the new path on next save.
const PROJECT_CONFIG_REL = join(".pi", "pi-tool-permissions.local.json");
const LEGACY_PROJECT_CONFIG_REL = join(".pi", "pi-tool-permissions.json");
const LEGACY2_PROJECT_CONFIG_REL = join(".pi", "tool-permissions.json");
const STATUS_KEY = "tool-permissions";

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

function loadUserConfig(): PermissionsConfig {
	return readJsonSafe(USER_CONFIG) ?? readJsonSafe(LEGACY_USER_CONFIG) ?? {};
}

function loadConfig(cwd: string): ResolvedConfig {
	const user = loadUserConfig();
	const project = loadProjectConfigRaw(cwd);

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
	if (readAllowSkills) {
		for (const glob of skillReadGlobs(homedir())) {
			for (const tool of READONLY_PATH_TOOLS) {
				implicitAllow.push(`${tool}(${glob})`);
			}
		}
	}
	if (readAllowPiDocs) {
		for (const glob of piDocsReadGlobs(homedir())) {
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

	return {
		defaultAction: (project.defaultAction ?? user.defaultAction ?? "ask") as Action,
		allow: [...implicitAllow, ...allow],
		deny,
		ask,
		toolDefaults: { ...implicitToolDefaults, ...explicitToolDefaults },
		cwd,
		allowNoopCd,
		bashReadOnlyAllowCwd,
		implicit: { allow: implicitAllow, toolDefaults: implicitToolDefaults, readAllowCwd, grepAllowCwd, globAllowCwd, lsAllowCwd, readAllowSkills, readAllowPiDocs, bashReadOnlyAllowCwd, allowNoopCd },
	};
}

function dedupe(items: string[]): string[] {
	return Array.from(new Set(items));
}

function projectConfigPath(cwd: string): string {
	return join(cwd, PROJECT_CONFIG_REL);
}

function legacyProjectConfigPath(cwd: string): string {
	return join(cwd, LEGACY_PROJECT_CONFIG_REL);
}

function legacy2ProjectConfigPath(cwd: string): string {
	return join(cwd, LEGACY2_PROJECT_CONFIG_REL);
}

function loadProjectConfigRaw(cwd: string): PermissionsConfig {
	return readJsonSafe(projectConfigPath(cwd))
		?? readJsonSafe(legacyProjectConfigPath(cwd))
		?? readJsonSafe(legacy2ProjectConfigPath(cwd))
		?? {};
}

function saveProjectConfig(cwd: string, cfg: PermissionsConfig): void {
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
function normalizePathSep(p: string): string {
	return p.replace(/\\/g, "/");
}

/**
 * Normalize a path for permission matching only — never used for actual tool execution.
 * Replaces backslashes with forward slashes, and resolves relative paths against cwd
 * so they can be compared against absolute patterns like the injected cwd glob.
 */
function normalizeMatchPath(p: string, cwd: string): string {
	if (!p) return p;
	const sep = normalizePathSep(p);
	// Relative: doesn't start with / or a Windows drive letter (e.g. C:)
	if (!sep.startsWith("/") && !/^[A-Za-z]:/.test(sep)) {
		return normalizePathSep(resolve(cwd, p));
	}
	return sep;
}

/** Returns the glob pattern that matches cwd and all its descendants. */
function cwdGlobPattern(cwd: string): string {
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
function skillReadGlobs(home: string): string[] {
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
function piDocsReadGlobs(home: string): string[] {
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
function isNoopCd(cmd: string, cwd: string): boolean {
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
function stripLineContinuations(cmd: string): string {
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
function isReadOnlyBashSubcommand(cmd: string, cwd: string): boolean {
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
function normalizeTool(name: string): string {
	return name.toLowerCase().replace(/_/g, "");
}

// ── toolDefaults helpers ──────────────────────────────────────────────────────

/**
 * Normalize toolDefaults keys (tool names) and validate values.
 * Invalid action strings are silently dropped.
 */
function normalizeToolDefaultsKeys(td: Record<string, string>): Record<string, Action> {
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
 * This mirrors the format produced by suggestRule (which always appends `" *"` to the
 * first token), ensuring every auto-suggested rule also covers the bare command form.
 * A bare `*` without a leading space is unaffected (e.g. `npm*` still requires the
 * matched string to start with `npm`).
 */
function compilePattern(pattern: string): RegExp {
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

function parseRule(raw: string): ParsedRule | null {
	const trimmed = raw.trim();
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

function getMatchField(toolName: string, input: Record<string, unknown>): string {
	const t = normalizeTool(toolName);
	if (t === "bash") return String(input.command ?? "");
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

function ruleMatches(rule: ParsedRule, toolName: string, input: Record<string, unknown>, cwd?: string): boolean {
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
	| { kind: "single" }
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
 *   { kind: "single" }             – no top-level operator found
 *   { kind: "compound", parts }    – trimmed, non-empty subcommands
 */
function splitTopLevelShell(cmd: string): SplitResult {
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
	return nonEmpty.length > 1 ? { kind: "compound", parts: nonEmpty } : { kind: "single" };
}

// ── Compound decision ────────────────────────────────────────────────────────

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

function decideCompound(
	cfg: ResolvedConfig,
	toolName: string,
	input: Record<string, unknown>,
): CompoundDecision {
	if (normalizeTool(toolName) !== "bash") {
		return { action: decide(cfg, toolName, input), isCompound: false, ambiguous: false, breakdown: [] };
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
		return { action: decide(cfg, "bash", normalizedInput), isCompound: false, ambiguous: false, breakdown: [] };
	}

	// compound
	const breakdown: SubcommandDecision[] = split.parts.map((sub) => ({
		sub,
		action: decide(cfg, "bash", { command: sub }),
	}));

	let action: Action = "allow";
	for (const { action: a } of breakdown) {
		if (a === "deny") { action = "deny"; break; }
		if (a === "ask") action = "ask";
	}

	return { action, isCompound: true, ambiguous: false, breakdown };
}

// ── Breakdown rendering ──────────────────────────────────────────────────────

/** Single-character status icon for a per-subcommand action. */
function actionIcon(action: Action): string {
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
function formatBreakdownLine(sub: string, action: Action, isCurrent: boolean): string {
	const gutter = isCurrent ? " » " : "   ";
	return `${gutter}[${actionIcon(action)}] ${sub}`;
}

/**
 * Render the full breakdown block (newline-joined). When `currentSub` is null,
 * no row is marked current (all rows use the blank gutter).
 */
function formatBreakdown(breakdown: SubcommandDecision[], currentSub: string | null): string {
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
function recomputeBreakdown(breakdown: SubcommandDecision[], cfg: ResolvedConfig): SubcommandDecision[] {
	return breakdown.map((b) => ({ sub: b.sub, action: decide(cfg, "bash", { command: b.sub }) }));
}

function decide(cfg: ResolvedConfig, toolName: string, input: Record<string, unknown>): Action {
	const check = (list: string[]): boolean => {
		for (const raw of list) {
			const rule = parseRule(raw);
			if (rule && ruleMatches(rule, toolName, input, cfg.cwd)) return true;
		}
		return false;
	};
	if (check(cfg.deny)) return "deny";
	// Silently allow read-only bash subcommands with paths inside cwd
	if (cfg.bashReadOnlyAllowCwd && normalizeTool(toolName) === "bash" && isReadOnlyBashSubcommand(String(input.command ?? ""), cfg.cwd)) return "allow";
	// Silently allow no-op `cd` (changing to the current directory) — harmless bookkeeping
	if (cfg.allowNoopCd && normalizeTool(toolName) === "bash" && isNoopCd(String(input.command ?? ""), cfg.cwd)) return "allow";
	if (check(cfg.ask)) return "ask";
	if (check(cfg.allow)) return "allow";
	const td = cfg.toolDefaults[normalizeTool(toolName)];
	if (td !== undefined) return td;
	return cfg.defaultAction;
}

/** Suggest a rule string that matches the current call exactly enough to be useful. */
function suggestRule(toolName: string, input: Record<string, unknown>): string {
	const t = normalizeTool(toolName);
	if (t === "bash") {
		const cmd = String(input.command ?? "").trim();
		// Use first token plus * so similar variations match
		const head = cmd.split(/\s+/)[0] ?? "";
		return head ? `${toolName}(${head} *)` : toolName;
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
 * Return a copy of the tool input with the path field normalized for permission matching.
 * The original event.input is never mutated — only this copy enters decide/ruleMatches.
 */
function inputForMatching(
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
		// Always reset allow-all-edits at session start — never persisted
		allowAllEdits = false;
		ctx.ui.setStatus(STATUS_KEY, "");
	});

	// ── Tool call gating ─────────────────────────────────────────────────────

	pi.on("tool_call", async (event, ctx) => {
		const matchInput = inputForMatching(event.toolName, event.input as Record<string, unknown>, ctx.cwd);
		const compound = decideCompound(cfg, event.toolName, matchInput);
		const { action, isCompound, ambiguous, breakdown } = compound;

		if (action === "allow") return undefined;

		// Explicit deny rules always win, even over allow-all-edits
		if (action === "deny") {
			const culprit = isCompound ? breakdown.find((b) => b.action === "deny") : null;
			const message = culprit
				? `Blocked ${event.toolName}: '${culprit.sub}' matched a deny rule`
				: `Blocked ${event.toolName} by tool-permissions deny rule`;
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

			// Iterate over the original `ask` subcommands, but re-decide each one
			// against the current `cfg` right before prompting so newly saved
			// allow/deny rules apply to the rest of *this* compound command.
			const askSubs = breakdown.filter((b) => b.action === "ask").map((b) => b.sub);

			for (const sub of askSubs) {
				// User intent (`Allow ALL steps once`) beats any rule-driven decision:
				// a freshly saved deny must not override an explicit one-shot allow.
				if (allowAllStepsOnce) continue;

				const liveAction = decide(cfg, "bash", { command: sub });
				if (liveAction === "allow") continue;
				if (liveAction === "deny") {
					await promptSteerMessage(ctx);
					return { block: true, reason: `Blocked by tool-permissions deny rule (subcommand: ${sub})` };
				}

				const suggested = suggestRule("Bash", { command: sub });
				const breakdownLines = formatBreakdown(currentBreakdown, sub);

				const title = `Allow Bash subcommand?\n\nFull command:\n  ${truncated}\n\nBreakdown:\n${breakdownLines}\n\nSuggested rule: ${suggested}`;
				const choices = [
					"Allow once",
					"Allow ALL steps once",
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

				if (choice === "Deny once" || !choice) {
					if (choice === "Deny once") await promptSteerMessage(ctx);
					return { block: true, reason: `Denied by user (subcommand: ${sub})` };
				}
				if (choice === "Allow always (save rule)") {
					const edited = await ctx.ui.editor("Edit rule before saving:", suggested);
					if (!edited) continue;
					addRule(ctx.cwd, "allow", edited.trim());
					cfg = loadConfig(ctx.cwd);
					currentBreakdown = recomputeBreakdown(breakdown, cfg);
					const autoCount = currentBreakdown.filter(
						(b) => b.sub !== sub && askSubs.includes(b.sub) && b.action === "allow",
					).length;
					const suffix = autoCount > 0 ? ` (auto-allows ${autoCount} remaining step${autoCount === 1 ? "" : "s"})` : "";
					ctx.ui.notify(`Saved allow rule: ${edited.trim()}${suffix}`, "info");
					continue;
				}
				if (choice === "Deny always (save rule)") {
					const edited = await ctx.ui.editor("Edit rule before saving:", suggested);
					if (!edited) {
						await promptSteerMessage(ctx);
						return { block: true, reason: `Denied by user (subcommand: ${sub})` };
					}
					addRule(ctx.cwd, "deny", edited.trim());
					cfg = loadConfig(ctx.cwd);
					currentBreakdown = recomputeBreakdown(breakdown, cfg);
					ctx.ui.notify(`Saved deny rule: ${edited.trim()}`, "info");
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
		const title = `Allow ${event.toolName}?\n\n  ${preview}${ambiguousNote}\n\nSuggested rule: ${suggested}`;

		// Extra "allow all edits" option only for write/edit dialogs
		const choices = isWriteOrEdit
			? [
					"Allow once",
					"Allow all edits this session",
					"Allow always (save rule)",
					"Deny once",
					"Deny always (save rule)",
			  ]
			: ["Allow once", "Allow always (save rule)", "Deny once", "Deny always (save rule)"];

		const choice = await ctx.ui.select(title, choices);

		if (choice === "Allow once") return undefined;

		if (choice === "Allow all edits this session") {
			applyAllowAllEdits(true, ctx);
			return undefined;
		}

		if (choice === "Deny once" || !choice) {
			if (choice === "Deny once") await promptSteerMessage(ctx);
			return { block: true, reason: "Denied by user" };
		}
		if (choice === "Allow always (save rule)") {
			const edited = await ctx.ui.editor("Edit rule before saving:", suggested);
			if (!edited) return undefined;
			addRule(ctx.cwd, "allow", edited.trim());
			cfg = loadConfig(ctx.cwd);
			ctx.ui.notify(`Saved allow rule: ${edited.trim()}`, "info");
			return undefined;
		}
		if (choice === "Deny always (save rule)") {
			const edited = await ctx.ui.editor("Edit rule before saving:", suggested);
			if (!edited) {
				await promptSteerMessage(ctx);
				return { block: true, reason: "Denied by user" };
			}
			addRule(ctx.cwd, "deny", edited.trim());
			cfg = loadConfig(ctx.cwd);
			ctx.ui.notify(`Saved deny rule: ${edited.trim()}`, "info");
			await promptSteerMessage(ctx);
			return { block: true, reason: `Blocked by tool-permissions deny rule (${edited.trim()})` };
		}
		return { block: true, reason: "Denied by user" };
	});

	// ── Hotkey ───────────────────────────────────────────────────────────────

	pi.registerShortcut("ctrl+shift+e", {
		description: "Toggle allow-all-edits mode (this session only)",
		handler: async (ctx) => {
			applyAllowAllEdits(!allowAllEdits, ctx);
		},
	});

	// ── Rule helpers ─────────────────────────────────────────────────────────

	function addRule(cwd: string, action: Action, rule: string): void {
		const project = loadProjectConfigRaw(cwd);
		const list = project[action] ?? [];
		if (!list.includes(rule)) list.push(rule);
		project[action] = dedupe(list);
		saveProjectConfig(cwd, project);
	}

	function removeRule(cwd: string, rule: string): boolean {
		const project = loadProjectConfigRaw(cwd);
		let removed = false;
		for (const key of ["allow", "deny", "ask"] as const) {
			const list = project[key];
			if (!list) continue;
			const idx = list.indexOf(rule);
			if (idx >= 0) {
				list.splice(idx, 1);
				removed = true;
			}
		}
		if (removed) saveProjectConfig(cwd, project);
		return removed;
	}

	function setDefault(cwd: string, action: Action): void {
		const project = loadProjectConfigRaw(cwd);
		project.defaultAction = action;
		saveProjectConfig(cwd, project);
	}

	// ── Slash command ────────────────────────────────────────────────────────

	pi.registerCommand("permissions", {
		description: "Manage tool permissions (allow/deny/ask) and allow-all-edits mode",
		getArgumentCompletions: (prefix: string) => {
			const subs = ["allow", "deny", "ask", "remove", "default", "reload", "list", "allowalledits"];
			const items = subs.map((s) => ({ value: s, label: s }));
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const trimmed = (args ?? "").trim();
			if (!trimmed || trimmed === "list") {
				const implicitAllowSet = new Set(cfg.implicit.allow);
				const implicitTDKeys = new Set(Object.keys(cfg.implicit.toolDefaults));
				const tdEntries = Object.entries(cfg.toolDefaults);
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
					`allow (${cfg.allow.length}):`,
					...cfg.allow.map((r) => implicitAllowSet.has(r) ? `  [implicit] ${r}` : `  - ${r}`),
					`deny (${cfg.deny.length}):`,
					...cfg.deny.map((r) => `  - ${r}`),
					`ask (${cfg.ask.length}):`,
					...cfg.ask.map((r) => `  - ${r}`),
					`toolDefaults (${tdEntries.length}):`,
					...tdEntries.map(([k, v]) =>
						implicitTDKeys.has(k) ? `  [implicit] ${k} -> ${v}` : `  - ${k} -> ${v}`
					),
				];
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			const [sub, ...rest] = trimmed.split(/\s+/);
			const value = rest.join(" ").trim();

			switch (sub) {
				case "reload":
					reload(ctx.cwd, ctx);
					return;
				case "default": {
					if (!isAction(value)) {
						ctx.ui.notify(`Usage: /permissions default <allow|deny|ask>`, "warning");
						return;
					}
					setDefault(ctx.cwd, value);
					reload(ctx.cwd, ctx);
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
				case "allow":
				case "deny":
				case "ask": {
					if (!value) {
						ctx.ui.notify(`Usage: /permissions ${sub} <rule>`, "warning");
						return;
					}
					if (!parseRule(value)) {
						ctx.ui.notify(`Invalid rule: ${value}. Expected ToolName or ToolName(pattern).`, "warning");
						return;
					}
					addRule(ctx.cwd, sub, value);
					reload(ctx.cwd, ctx);
					ctx.ui.notify(`Added ${sub} rule: ${value}`, "info");
					return;
				}
				case "remove": {
					if (!value) {
						ctx.ui.notify(`Usage: /permissions remove <rule>`, "warning");
						return;
					}
					const removed = removeRule(ctx.cwd, value);
					if (removed) {
						reload(ctx.cwd, ctx);
						ctx.ui.notify(`Removed rule: ${value}`, "info");
					} else {
						ctx.ui.notify(`Rule not found: ${value}`, "warning");
					}
					return;
				}
				default:
					ctx.ui.notify(
						`Unknown subcommand: ${sub}. Use: list | allow | deny | ask | remove | default | reload | allowalledits`,
						"warning",
					);
			}
		},
	});
}

function isAction(s: string): s is Action {
	return s === "allow" || s === "deny" || s === "ask";
}
