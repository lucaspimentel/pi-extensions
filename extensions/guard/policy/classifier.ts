/**
 * The LLM classifier used by guard's auto profile. Ported from
 * extensions/pi-tool-permissions/rules.ts (copied and adapted; that file is
 * never modified or imported by guard). In guard, the classifier screens only
 * host_bash, pwsh, write/edit, exfil-capable remote reads, and remote writes
 * (see decision.ts); every other tool class skips it entirely.
 *
 * The `complete` call is injected as a seam so this is unit-testable without
 * HTTP.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { modelLabel, selectModel, type HasAuth } from "../../shared/model-selection.ts";

export type ClassifierVerdict = "allow" | "soft_deny" | "hard_deny" | "no_match";

export interface ClassifyResult {
	verdict: ClassifierVerdict;
	reason: string;
}

/** Seam type for the model completion call (mirrors ModelRegistry.streamSimple consumers). */
export type ClassifierComplete = (model: Model<Api>, context: Context) => Promise<AssistantMessage>;

export interface ResolvedClassifierConfig {
	/** Optional explicit model pin; auto-select when absent. */
	classifier?: { provider: string; model: string };
	/** Free-text facts shown to the classifier (e.g. trusted repos/domains). */
	environment: string[];
	allow: string[];
	soft_deny: string[];
	hard_deny: string[];
}

/**
 * Default natural-language lists for the classifier. User/project lists are
 * additive on top of these (concatenated + deduped).
 */
export const DEFAULT_CLASSIFIER = {
	allow: [
		"Running tests and linters",
		"Editing files in a source-controlled repository (changes are reversible via git)",
		"Read-only inspection commands (e.g. pwd, ls, cat, head, tail, wc, stat, file, du, df)",
		"Searching the codebase with grep, rg, find, or glob",
		"Running git status, git diff, git log, and other read-only git queries",
		"Staging changes and creating a local git commit (e.g. git add, git commit, git stash) (local-only and easily reversible via git reset/git reflog; pushing is handled separately)",
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
};

/**
 * Pick the classifier model. If `explicit` is set, `find` it directly;
 * otherwise rank the pool (preferring the current provider) and return the
 * first with configured auth. `find` and `hasAuth` are injected seams.
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
 * Status-bar label for the auto profile. Shows the resolved classifier model
 * id (e.g. `claude-haiku-4-5`); when no model is available, reports
 * `auto (no classifier)` so it is clear that fallthroughs stub to prompt.
 */
export function classifierStatusLabel(model: Model<Api> | undefined): string {
	return model ? `auto: ${modelLabel(model)}` : "auto (no classifier)";
}

/**
 * Attribution for a classifier verdict, embedded in decision reasons:
 * `classifier <modelId>: <reason>`, `classifier <modelId>`, or
 * `classifier: <reason>` depending on what is present. Empty when neither.
 */
export function classifierAttribution(modelId: string | undefined, reason: string): string {
	if (!modelId && !reason) return "";
	if (modelId && reason) return `classifier ${modelId}: ${reason}`;
	if (modelId) return `classifier ${modelId}`;
	return `classifier: ${reason}`;
}

/**
 * Build a short human-readable description of the action for the classifier.
 * Guard domain tool names: bash/hostbash/pwsh match on command; write/edit on
 * path; webfetch on URL; mcp on the MCP tool name plus parsed args.
 */
export function describeAction(toolName: string, input: Record<string, unknown>): string {
	const t = toolName.toLowerCase().replace(/_/g, "");
	if (t === "bash" || t === "hostbash" || t === "pwsh") return `Tool: ${toolName}\nCommand: ${String(input.command ?? "")}`;
	if (t === "write" || t === "edit") return `Tool: ${toolName}\nPath: ${String(input.path ?? "")}`;
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
 * classifier's describeAction summary.
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

/** Safe JSON.stringify that never throws on circular references. */
function safeJson(v: unknown): string {
	try { return JSON.stringify(v); } catch { return String(v); }
}

/**
 * Resolve a possibly-relative path against `cwd` without letting Windows
 * `resolve()` prepend a drive letter to POSIX-absolute paths.
 */
export function resolveAgainstCwd(p: string, cwd: string): string {
	const norm = p.replace(/\\/g, "/");
	const isAbsolute = norm.startsWith("/") || /^[A-Za-z]:/.test(norm);
	if (isAbsolute) return norm;
	const base = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
	return `${base}/${norm.replace(/^\.\//, "")}`;
}

/**
 * Walk up from `start` looking for a `.git` entry and return the repository
 * root, or null when the path is not inside a git working tree. Pure fs
 * probing, no subprocess, so an untracked file inside a repo still counts as
 * "inside a git repository". `exists` is injected so tests need no real disk.
 */
export function findGitRoot(start: string, exists: (p: string) => boolean = existsSync): string | null {
	let dir = start.replace(/\\/g, "/").replace(/\/+$/, "");
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
	const stripped = cmd.replace(/\\\n/g, "").trim();
	const m = stripped.match(/^cd\s+([^\r\n]*?)\s*(?:&&|\|\||;|$)/);
	if (!m) return null;
	let arg = m[1].trim();
	if (
		arg.length >= 2 &&
		((arg[0] === "'" && arg[arg.length - 1] === "'") || (arg[0] === '"' && arg[arg.length - 1] === '"'))
	) {
		arg = arg.slice(1, -1).trim();
	}
	if (!arg) return null;
	// Reject unresolved shell metacharacters / globs: we cannot know the target.
	if (/[`$(){}|&;<>*?]/.test(arg)) return null;
	return arg;
}

/**
 * Build the `Context:` facts handed to the classifier alongside the action:
 * the working directory, the resolved target path, and whether each lives
 * inside a git working tree (fs-only `.git` probe, fast, no subprocess).
 */
export function buildActionContext(
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
	exists: (p: string) => boolean = existsSync,
): string[] {
	const lines: string[] = [];
	const t = toolName.toLowerCase().replace(/_/g, "");
	const inRepo = (label: string, dir: string): void => {
		const root = findGitRoot(dir, exists);
		lines.push(
			root
				? `${label} is inside a git repository (root: ${root}), so file changes there are source-controlled and reversible`
				: `${label} is NOT inside a git repository`,
		);
	};
	if (cwd) {
		const cwdNorm = cwd.replace(/\\/g, "/");
		lines.push(`Working directory: ${cwdNorm}`);
		inRepo("Working directory", cwdNorm);
	}
	if ((t === "write" || t === "edit") && input.path) {
		const resolved = resolveAgainstCwd(String(input.path), cwd);
		lines.push(`Resolved target path: ${resolved}`);
		inRepo("Target path", dirname(resolved));
	}
	if (t === "bash" || t === "hostbash" || t === "pwsh") {
		const raw = t === "pwsh"
			? (typeof input.cwd === "string" && input.cwd ? input.cwd : null)
			: leadingCdTarget(String(input.command ?? ""));
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
	config: ResolvedClassifierConfig,
	context: string[] = [],
): string {
	const env = config.environment.length ? config.environment.map((e) => `  - ${e}`).join("\n") : "  (none)";
	const allow = config.allow.length ? config.allow.map((r) => `  - ${r}`).join("\n") : "  (none)";
	const soft = config.soft_deny.length ? config.soft_deny.map((r) => `  - ${r}`).join("\n") : "  (none)";
	const hard = config.hard_deny.length ? config.hard_deny.map((r) => `  - ${r}`).join("\n") : "  (none)";
	return [
		"You are a permissions safety classifier for a coding agent. Decide whether the agent should be allowed to run the following action.",
		"",
		"Action:",
		describeAction(toolName, input),
		"",
		"Context (facts about this specific call; trust these over guesses from the paths above):",
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
		"The reason should describe what the action does (e.g. 'read-only GitHub API call to fetch a file'). Do not mention whether it matches or fails to match any rules; that is implied by the verdict.",
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
 * Map a classifier verdict to a guard action label.
 * - `allow` to allow (short-circuit)
 * - `hard_deny` to deny (block)
 * - `soft_deny` to prompt; deny in non-interactive contexts (can't prompt)
 * - `no_match` to the profile's fallthrough action (the classifier ran and
 *   had no opinion)
 */
export function verdictToGuardAction(verdict: ClassifierVerdict, nonInteractive: boolean): "allow" | "deny" | "prompt" | "fallthrough" {
	if (verdict === "allow") return "allow";
	if (verdict === "hard_deny") return "deny";
	if (verdict === "soft_deny") return nonInteractive ? "deny" : "prompt";
	return "fallthrough"; // no_match
}

/** Cache key: hash(toolName, input, ruleset). Binds token cost on loops. */
export function classifierCacheKey(
	toolName: string,
	input: Record<string, unknown>,
	config: ResolvedClassifierConfig,
	context: string[] = [],
): string {
	const ruleset = JSON.stringify({
		x: context,
		c: config.classifier,
		e: config.environment,
		a: config.allow,
		s: config.soft_deny,
		h: config.hard_deny,
	});
	const inputJson = JSON.stringify(input);
	return createHash("sha256").update(`${toolName}\u0000${inputJson}\u0000${ruleset}`).digest("hex");
}

/**
 * Run the classifier. `complete` is injected so this is unit-testable without
 * HTTP. Results are cached by (toolName, input, ruleset) for the lifetime of
 * the provided cache Map.
 */
export async function classifyAction(
	complete: ClassifierComplete,
	model: Model<Api>,
	toolName: string,
	input: Record<string, unknown>,
	config: ResolvedClassifierConfig,
	cache: Map<string, ClassifyResult>,
	context: string[] = [],
): Promise<ClassifyResult> {
	const key = classifierCacheKey(toolName, input, config, context);
	const cached = cache.get(key);
	if (cached) return cached;
	const prompt = buildClassifierPrompt(toolName, input, config, context);
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
		// Network/API error: safe fallback (no_match).
		result = { verdict: "no_match", reason: "classifier call failed" };
	}
	cache.set(key, result);
	return result;
}
