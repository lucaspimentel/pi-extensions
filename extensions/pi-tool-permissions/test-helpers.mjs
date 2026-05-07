// Shared helpers for all test files.
// These are plain-JS mirrors of the pure functions in index.ts.
// When index.ts changes, update this file to match.

import { resolve } from "node:path";

// ── Tool name helpers ─────────────────────────────────────────────────────

export const normalizeTool = (name) => name.toLowerCase().replace(/_/g, "");

// ── Path helpers ──────────────────────────────────────────────────────────

export const normalizePathSep = (p) => p.replace(/\\/g, "/");

export function normalizeMatchPath(p, cwd) {
	if (!p) return p;
	const sep = normalizePathSep(p);
	if (!sep.startsWith("/") && !/^[A-Za-z]:/.test(sep))
		return normalizePathSep(resolve(cwd, p));
	return sep;
}

export function cwdGlobPattern(cwd) {
	return normalizePathSep(cwd) + "/**";
}

/**
 * Returns true when `cmd` is a `cd` invocation whose destination resolves to
 * the current working directory.  Mirrors isNoopCd() in index.ts.
 */
export function isNoopCd(cmd, cwd) {
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

// ── Read-only bash helpers ────────────────────────────────────────

export const READONLY_BASH_SAFE_ALWAYS = new Set([
	"pwd", "echo", "printf", "date", "whoami", "id", "hostname",
	"uname", "env", "printenv", "true", "false", "which", "type", "command",
]);

export const READONLY_BASH_WITH_PATHS = new Set([
	"ls", "cat", "head", "tail", "wc", "file", "stat", "tree",
	"du", "realpath", "readlink", "dirname", "basename",
]);

export function hasTopLevelOutputRedirect(cmd) {
	let inSingle = false, inDouble = false;
	for (let i = 0; i < cmd.length; i++) {
		const ch = cmd[i];
		if (ch === "\\" && !inSingle) { i++; continue; }
		if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
		if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
		if (!inSingle && !inDouble && ch === ">") return true;
	}
	return false;
}

export function tokenizeSimple(cmd) {
	const tokens = [];
	let current = "", inSingle = false, inDouble = false, i = 0;
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
			i++; continue;
		}
		current += ch; i++;
	}
	if (current) tokens.push(current);
	return tokens;
}

export function isReadOnlyBashSubcommand(cmd, cwd) {
	const trimmed = cmd.trim();
	if (!trimmed) return false;
	if (hasTopLevelOutputRedirect(trimmed)) return false;
	const tokens = tokenizeSimple(trimmed);
	if (tokens.length === 0) return false;
	const cmdName = tokens[0].toLowerCase();
	if (READONLY_BASH_SAFE_ALWAYS.has(cmdName)) return true;
	if (READONLY_BASH_WITH_PATHS.has(cmdName)) {
		const pathArgs = tokens.slice(1).filter((t) => t.length > 0 && !t.startsWith("-"));
		if (pathArgs.length === 0) return true;
		const cwdNorm = normalizePathSep(cwd).toLowerCase();
		return pathArgs.every((arg) => {
			const norm = normalizeMatchPath(arg, cwd).toLowerCase();
			return norm === cwdNorm || norm.startsWith(cwdNorm + "/");
		});
	}
	return false;
}

// ── toolDefaults helpers ──────────────────────────────────────────────────

export function normalizeToolDefaultsKeys(td) {
	const out = {};
	for (const [k, v] of Object.entries(td)) {
		if (v === "allow" || v === "deny" || v === "ask")
			out[normalizeTool(k)] = v;
	}
	return out;
}

// ── Pattern / rule helpers ────────────────────────────────────────────────

export function compilePattern(pattern) {
	if (pattern.length >= 2 && pattern.startsWith("/") && pattern.endsWith("/"))
		return new RegExp(pattern.slice(1, -1), "i");
	// " *" → "( .*)?" so a rule like Bash(git status *) matches the bare "git status" too.
	const PLACEHOLDER = "\u0000";
	const escaped = pattern
		.replace(/ \*/g, PLACEHOLDER)
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*")
		.replace(/\?/g, ".")
		.replace(/\u0000/g, "( .*)?");
	return new RegExp(`^${escaped}$`, "i");
}

export function parseRule(raw) {
	const trimmed = (raw ?? "").trim();
	if (!trimmed) return null;
	const m = trimmed.match(/^([A-Za-z0-9_]+)(?:\((.*)\))?$/);
	if (!m) return null;
	const tool = normalizeTool(m[1]);
	const pattern = m[2];
	return { tool, pattern, regex: pattern ? compilePattern(pattern) : undefined, raw: trimmed };
}

export function getMatchField(toolName, input) {
	const t = normalizeTool(toolName);
	if (t === "bash") return String(input.command ?? "");
	if (t === "read" || t === "write" || t === "edit") return String(input.path ?? "");
	if (t === "grep" || t === "glob") return String(input.path ?? "");
	if (t === "webfetch") return String(input.url ?? "");
	try { return JSON.stringify(input); } catch { return ""; }
}

export function ruleMatches(rule, toolName, input) {
	if (rule.tool !== normalizeTool(toolName)) return false;
	if (!rule.regex) return true;
	return rule.regex.test(getMatchField(toolName, input));
}

export function inputForMatching(toolName, input, cwd) {
	const t = normalizeTool(toolName);
	if (t === "read" || t === "write" || t === "edit") {
		// Only normalise separators — do NOT resolve relative paths to absolute.
		// Resolving would break user rules like Write(.env*) when paths are relative.
		// The synthetic cwd rule works when pi provides absolute paths (the common case).
		const p = String(input.path ?? "");
		return p ? { ...input, path: normalizePathSep(p) } : input;
	}
	if (t === "grep" || t === "glob") {
		const p = input.path ? String(input.path) : cwd;
		const normalized = normalizeMatchPath(p, cwd);
		return { ...input, path: normalized.endsWith("/") ? normalized : normalized + "/" };
	}
	return input;
}

export function suggestRule(toolName, input) {
	const t = normalizeTool(toolName);
	if (t === "bash") {
		const cmd = String(input.command ?? "").trim();
		const head = cmd.split(/\s+/)[0] ?? "";
		return head ? `${toolName}(${head} *)` : toolName;
	}
	if (t === "read" || t === "write" || t === "edit") {
		const p = String(input.path ?? "");
		return p ? `${toolName}(${normalizePathSep(p)})` : toolName;
	}
	if (t === "grep" || t === "glob") {
		const p = String(input.path ?? "");
		return p ? `${toolName}(${normalizePathSep(p)})` : toolName;
	}
	if (t === "websearch") return "WebSearch";
	if (t === "webfetch") {
		const url = String(input.url ?? "");
		if (url) {
			try { return `WebFetch(${new URL(url).origin}/*)`; } catch { /* fall through */ }
		}
		return "WebFetch";
	}
	return toolName;
}

// ── Compound bash splitting ───────────────────────────────────────────────

export function splitTopLevelShell(cmd) {
	const parts = [];
	let current = "", inSingle = false, inDouble = false, inBacktick = false;
	let parenDepth = 0, foundOperator = false, i = 0;

	while (i < cmd.length) {
		const ch = cmd[i];
		if (ch === "\\" && !inSingle) {
			const next = cmd[i + 1];
			if (next === "\n") { i += 2; continue; }
			if (next === "\r" && cmd[i + 2] === "\n") { i += 3; continue; }
			current += ch + (next ?? ""); i += 2; continue;
		}
		if (ch === "'" && !inDouble && !inBacktick) { inSingle = !inSingle; current += ch; i++; continue; }
		if (ch === '"' && !inSingle && !inBacktick) { inDouble = !inDouble; current += ch; i++; continue; }
		if (ch === "`" && !inSingle && !inDouble) { inBacktick = !inBacktick; current += ch; i++; continue; }
		if (!inSingle && !inDouble && !inBacktick) {
			if (ch === "(") { parenDepth++; current += ch; i++; continue; }
			if (ch === ")") {
				if (parenDepth <= 0) return { kind: "ambiguous" };
				parenDepth--; current += ch; i++; continue;
			}
		}
		if (!inSingle && !inDouble && !inBacktick && parenDepth === 0) {
			if (ch === "&" && cmd[i + 1] === "&") { parts.push(current.trim()); current = ""; i += 2; foundOperator = true; continue; }
			if (ch === "|" && cmd[i + 1] === "|") { parts.push(current.trim()); current = ""; i += 2; foundOperator = true; continue; }
			if (ch === "|" && cmd[i + 1] !== "|") { parts.push(current.trim()); current = ""; i++; foundOperator = true; continue; }
			if (ch === ";") { parts.push(current.trim()); current = ""; i++; foundOperator = true; continue; }
			if (ch === "\n" || (ch === "\r" && cmd[i + 1] === "\n")) {
				parts.push(current.trim()); current = ""; i += ch === "\r" ? 2 : 1; foundOperator = true; continue;
			}
		}
		current += ch; i++;
	}

	if (inSingle || inDouble || inBacktick || parenDepth !== 0) return { kind: "ambiguous" };
	if (!foundOperator) return { kind: "single" };
	const last = current.trim();
	if (last) parts.push(last);
	const nonEmpty = parts.filter((p) => p.length > 0 && !p.trimStart().startsWith("#"));
	return nonEmpty.length > 1 ? { kind: "compound", parts: nonEmpty } : { kind: "single" };
}

// ── Decision engine ───────────────────────────────────────────────────────

export function decide(cfg, toolName, input) {
	const check = (list) => list.some((raw) => { const r = parseRule(raw); return r && ruleMatches(r, toolName, input); });
	if (check(cfg.deny)) return "deny";
	if (cfg.bashReadOnlyAllowCwd && normalizeTool(toolName) === "bash" && isReadOnlyBashSubcommand(String(input.command ?? ""), cfg.cwd ?? process.cwd())) return "allow";
	if ((cfg.allowNoopCd !== false) && normalizeTool(toolName) === "bash" && isNoopCd(String(input.command ?? ""), cfg.cwd ?? process.cwd())) return "allow";
	if (check(cfg.ask)) return "ask";
	if (check(cfg.allow)) return "allow";
	const td = cfg.toolDefaults?.[normalizeTool(toolName)];
	if (td !== undefined) return td;
	return cfg.defaultAction;
}

export function decideCompound(cfg, toolName, input) {
	if (normalizeTool(toolName) !== "bash")
		return { action: decide(cfg, toolName, input), isCompound: false, ambiguous: false, breakdown: [] };

	const cmd = String(input.command ?? "");
	const split = splitTopLevelShell(cmd);

	if (split.kind === "ambiguous") return { action: "ask", isCompound: false, ambiguous: true, breakdown: [] };
	if (split.kind === "single") return { action: decide(cfg, "bash", input), isCompound: false, ambiguous: false, breakdown: [] };

	const breakdown = split.parts.map((sub) => ({ sub, action: decide(cfg, "bash", { command: sub }) }));
	let action = "allow";
	for (const { action: a } of breakdown) {
		if (a === "deny") { action = "deny"; break; }
		if (a === "ask") action = "ask";
	}
	return { action, isCompound: true, ambiguous: false, breakdown };
}

// ── Config helpers ────────────────────────────────────────────────────────

const dedupe = (items) => [...new Set(items)];

/**
 * Drives loadConfig without touching the filesystem.
 * Pass raw config objects (as they would appear in tool-permissions.json).
 */
export function loadConfigFromObjects(user = {}, project = {}, cwd) {
	const allow = dedupe([...(user.allow ?? []), ...(project.allow ?? [])]);
	const deny  = dedupe([...(user.deny  ?? []), ...(project.deny  ?? [])]);
	const ask   = dedupe([...(user.ask   ?? []), ...(project.ask   ?? [])]);

	const explicitToolDefaults = {
		...normalizeToolDefaultsKeys(user.toolDefaults ?? {}),
		...normalizeToolDefaultsKeys(project.toolDefaults ?? {}),
	};

	const readAllowCwd = project.readAllowCwd ?? user.readAllowCwd ?? true;
	const grepAllowCwd = project.grepAllowCwd ?? user.grepAllowCwd ?? true;
	const globAllowCwd = project.globAllowCwd ?? user.globAllowCwd ?? true;
	const bashReadOnlyAllowCwd = project.bashReadOnlyAllowCwd ?? user.bashReadOnlyAllowCwd ?? true;
	const allowNoopCd = project.allowNoopCd ?? user.allowNoopCd ?? true;
	const implicitAllow = [
		...(readAllowCwd ? [`Read(${cwdGlobPattern(cwd)})`] : []),
		...(grepAllowCwd ? [`Grep(${cwdGlobPattern(cwd)})`] : []),
		...(globAllowCwd ? [`Glob(${cwdGlobPattern(cwd)})`] : []),
	];

	const implicitToolDefaults = {};
	if (explicitToolDefaults["write"] === undefined) implicitToolDefaults["write"] = "ask";

	return {
		defaultAction: project.defaultAction ?? user.defaultAction ?? "ask",
		allow: [...implicitAllow, ...allow],
		deny, ask,
		toolDefaults: { ...implicitToolDefaults, ...explicitToolDefaults },
		cwd,
		allowNoopCd,
		bashReadOnlyAllowCwd,
		implicit: { allow: implicitAllow, toolDefaults: implicitToolDefaults, readAllowCwd, grepAllowCwd, globAllowCwd, bashReadOnlyAllowCwd, allowNoopCd },
	};
}

/** Build a minimal ResolvedConfig for decide/decideCompound tests.
 * Note: bashReadOnlyAllowCwd defaults to false here to preserve existing test
 * semantics. Pass bashReadOnlyAllowCwd: true explicitly when testing that feature.
 */
export function makeCfg({ allow = [], deny = [], ask = [], toolDefaults = {}, defaultAction = "ask", allowNoopCd = true, bashReadOnlyAllowCwd = false, cwd = process.cwd() } = {}) {
	// Normalize toolDefault keys so decide() can look them up via normalizeTool()
	return { allow, deny, ask, toolDefaults: normalizeToolDefaultsKeys(toolDefaults), defaultAction, allowNoopCd, bashReadOnlyAllowCwd, cwd, implicit: { allow: [], toolDefaults: {}, readAllowCwd: true, grepAllowCwd: true, globAllowCwd: true, bashReadOnlyAllowCwd, allowNoopCd } };
}

// ── Test runner ───────────────────────────────────────────────────────────

export function makeTestRunner() {
	let pass = 0, fail = 0;

	function test(desc, actual, expected) {
		const ok = actual === expected;
		console.log((ok ? "  ✓" : "  ✗") + " " + desc);
		if (!ok) {
			console.log(`      got:      ${JSON.stringify(actual)}`);
			console.log(`      expected:  ${JSON.stringify(expected)}`);
		}
		ok ? pass++ : fail++;
	}

	function section(name) {
		console.log(`\n── ${name} ${"─".repeat(Math.max(0, 50 - name.length))}`);
	}

	function summary() {
		console.log(`\n  ${pass} passed, ${fail} failed`);
		return fail;
	}

	return { test, section, summary };
}
