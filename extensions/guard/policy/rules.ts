/**
 * Rule parsing and matching: glob and /regex/ patterns with the optional
 * " *" pair transform. Ported from extensions/pi-tool-permissions/rules.ts
 * (copied and adapted; that file is never modified or imported by guard).
 * Rule tool names are case-insensitive and underscore-agnostic; guard adds
 * HostBash (and Pwsh) as matchable rule tools.
 */

import { normalizeMatchPath } from "./paths.ts";

/**
 * Normalize a tool name for comparison: lowercase and strip underscores.
 * Makes WebSearch, websearch, and web_search all equivalent.
 */
export function normalizeTool(name: string): string {
	return name.toLowerCase().replace(/_/g, "");
}

/**
 * Compile a glob (or `/regex/`) into a RegExp matching the whole string, case-insensitive.
 *
 * Special glob rule: a space-asterisk pair `" *"` is treated as *optional*; it compiles
 * to `( .*)?` so that `HostBash(git status *)` matches both `"git status"` and
 * `"git status -s"`. A bare `*` without a leading space is unaffected (e.g. `npm*`
 * still requires the matched string to start with `npm`).
 */
export function compilePattern(pattern: string): RegExp {
	if (pattern.length >= 2 && pattern.startsWith("/") && pattern.endsWith("/")) {
		return new RegExp(pattern.slice(1, -1), "i");
	}
	// Use a placeholder (U+0000) to protect " *" sequences before other transforms.
	const PLACEHOLDER = "\u0000";
	const escaped = pattern
		.replace(/ \*/g, PLACEHOLDER)          // 1. mark " *" pairs
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")  // 2. escape regex specials
		.replace(/\*/g, ".*")                   // 3. remaining * → .*
		.replace(/\?/g, ".")                    // 4. ? → .
		.replace(/\u0000/g, "( .*)?");          // 5. placeholder → optional space+anything
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

/**
 * The field of the tool input that a rule pattern matches against. Guard
 * domain names: hostbash and pwsh match the command; write/edit match the
 * path; webfetch matches the URL; mcp matches the MCP tool name.
 */
export function getMatchField(toolName: string, input: Record<string, unknown>): string {
	const t = normalizeTool(toolName);
	if (t === "bash" || t === "hostbash" || t === "pwsh") return String(input.command ?? "");
	if (t === "write" || t === "edit") return String(input.path ?? "");
	if (t === "webfetch") return String(input.url ?? "");
	if (t === "mcp") return String(input.tool ?? "");
	try {
		return JSON.stringify(input);
	} catch {
		return "";
	}
}

function isPathTool(toolName: string): boolean {
	const t = normalizeTool(toolName);
	return t === "write" || t === "edit";
}

export function ruleMatches(rule: ParsedRule, toolName: string, input: Record<string, unknown>, cwd?: string): boolean {
	if (rule.tool !== normalizeTool(toolName)) return false;
	if (!rule.regex) return true;
	const field = getMatchField(toolName, input);
	// For path-based tools, also test the cwd-resolved absolute path so that a
	// rule like Write(/abs/dir/**) matches relative calls. The original field
	// is tested first to preserve relative user rules like Write(.env*).
	if (cwd && field && isPathTool(toolName)) {
		const resolved = normalizeMatchPath(field, cwd);
		if (resolved !== field && rule.regex.test(resolved)) return true;
	}
	return rule.regex.test(field);
}

/**
 * Returns true when an allow rule is eligible to authorize a shell command
 * that contains a top-level *file* output redirection (e.g. `rg x > out.txt`).
 *
 * A broad allow rule whose pattern contains no `>` (e.g. `HostBash(rg *)`) is
 * intentionally NOT redirect-aware: it would otherwise silently authorize
 * writing to arbitrary files via redirection. To pre-allow a redirected form,
 * the user must add a rule whose pattern explicitly includes the redirect
 * operator (e.g. `HostBash(rg * > *)`). A bare rule (no pattern) is treated
 * as non-redirect-aware for the same reason.
 *
 * `deny` and `ask` rules are redirect-agnostic; safety rules must always win
 * over a redirected command, so this filter applies to the `allow` list only.
 */
export function rulePatternAllowsRedirect(rule: ParsedRule): boolean {
	return typeof rule.pattern === "string" && rule.pattern.includes(">");
}
