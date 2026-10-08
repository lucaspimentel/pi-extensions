/**
 * Tool classification: every pi tool call maps to exactly one guard tool
 * class, which selects the profile-table row the decision function applies.
 *
 * Resolution order (docs/guard-design.md, Tool classification):
 *   1. guard.json `toolClasses` (exact names or globs; overrides everything),
 *   2. guard's built-in map (pi built-ins and this repo's tools),
 *   3. the tool's self-declared annotations (readOnlyHint -> remote read,
 *      destructiveHint -> remote write),
 *   4. a name heuristic (post/send/create/update/... -> remote write),
 *   5. anything still unknown is a remote write (fail closed).
 *
 * Pure module: no fs, no pi imports. The annotation lookup is injected (the
 * caller caches `pi.getAllTools()` results per session) so tests need no
 * runtime. MCP calls in both naming styles are normalized to a classification
 * name of `mcp__<server>__<tool>` (built-in style) or `mcp__<server>__<tool>`
 * / `mcp:<tool>` (proxy style), so `toolClasses` globs like
 * `mcp__slack__*read*` match either style.
 */

import { compilePattern } from "./rules.ts";

/** The classes of guard's profile table. */
export type ToolClass =
	| "host-shell"
	| "sandboxed-exec"
	| "local-read"
	| "local-write"
	| "exfil-remote-read"
	| "remote-read"
	| "remote-write"
	| "meta";

export const TOOL_CLASSES: readonly ToolClass[] = [
	"host-shell",
	"sandboxed-exec",
	"local-read",
	"local-write",
	"exfil-remote-read",
	"remote-read",
	"remote-write",
	"meta",
];

export function isToolClass(value: unknown): value is ToolClass {
	return typeof value === "string" && (TOOL_CLASSES as readonly string[]).includes(value);
}

/** Case-insensitive exact key compare; keys keep their underscores. */
function sameKey(a: string, b: string): boolean {
	return a.toLowerCase() === b.toLowerCase();
}

/**
 * The classification name a `toolClasses` key matches against. Built-in MCP
 * calls arrive as `mcp__<server>__<tool>` and pass through unchanged. The
 * `mcp` proxy (pi-mcp-adapter) carries the target in `input.tool` (and
 * optionally a server field); its classification name is
 * `mcp__<server>__<input.tool>`, or `mcp:<input.tool>` when no server is
 * present, so globs can target both server and tool.
 */
export function classificationName(toolName: string, input: Record<string, unknown> = {}): string {
	if (toolName.toLowerCase() !== "mcp") return toolName;
	// `mcp` proxy: build the classification name from the input.
	const inner = typeof input.tool === "string" ? input.tool : "";
	if (!inner) return toolName;
	const server = typeof input.server === "string" && input.server ? input.server : undefined;
	return server ? `mcp__${server}__${inner}` : `mcp:${inner}`;
}

/** Guard's built-in map: pi built-ins, this repo's tools, and common packages. */
const BUILTIN_CLASSES: Readonly<Record<string, ToolClass>> = Object.freeze({
	// Local reads (no path argument for session_search and the memory reads:
	// treated as inside the roots).
	read: "local-read",
	grep: "local-read",
	find: "local-read",
	ls: "local-read",
	fffind: "local-read",
	ffgrep: "local-read",
	session_search: "local-read",
	memory_read: "local-read",
	memory_search: "local-read",
	memory_status: "local-read",
	// Local writes. Only write/edit carry a path; the others are allowed in
	// every profile except research (no path to contain).
	write: "local-write",
	edit: "local-write",
	memory_write: "local-write",
	memory_forget: "local-write",
	memory_restore: "local-write",
	scratchpad: "local-write",
	// Host shells.
	host_bash: "host-shell",
	pwsh: "host-shell",
	// pi's built-in opt-in PowerShell tool. It shares the pwsh shell tier:
	// Pwsh(...) rules and the pwsh host-shell cells govern it.
	powershell: "host-shell",
	// Sandboxed execution (the kernel sandbox is the guarantee; never
	// classified). python/node reset/status actions count too.
	bash: "sandboxed-exec",
	python: "sandboxed-exec",
	node: "sandboxed-exec",
	// Remote reads (not attacker-readable sinks).
	web_search: "remote-read",
	pup_logs_search: "remote-read",
	pup_logs_aggregate: "remote-read",
	pup_metrics_query: "remote-read",
	pup_traces_search: "remote-read",
	pup_monitors_list: "remote-read",
	pup_apm_services: "remote-read",
	pup_auth_status: "remote-read",
	slack_read_channel: "remote-read",
	slack_read_thread: "remote-read",
	slack_search: "remote-read",
	// Meta tools: nested calls are gated individually.
	codemode: "meta",
	tool_search: "meta",
	subagent: "meta",
	ask_user_question: "meta",
});

/**
 * Own-property-only built-in lookup. `BUILTIN_CLASSES` is an ordinary frozen
 * object, so a plain member access would resolve inherited Object.prototype
 * names (`constructor`, `__proto__`, ...) as built-ins. Names without an own
 * entry are ordinary custom tools: they follow the normal
 * annotation/configuration/fallback rules and are never reserved.
 */
function builtinToolClass(name: string): ToolClass | undefined {
	const key = name.toLowerCase();
	return Object.hasOwn(BUILTIN_CLASSES, key) ? BUILTIN_CLASSES[key] : undefined;
}

/** web_fetch's class depends on the URL: allowlisted is a plain remote read, anything else is exfil-capable. */
function webFetchClass(input: Record<string, unknown>, webFetchAllow: readonly string[] | undefined): ToolClass {
	const url = String(input.url ?? "");
	if (webFetchAllow === undefined || webFetchAllow.length === 0) return "exfil-remote-read";
	for (const pattern of webFetchAllow) {
		try {
			if (compilePattern(pattern).test(url)) return "remote-read";
		} catch {
			// Invalid pattern: skip it (config coercion should prevent this).
		}
	}
	return "exfil-remote-read";
}

/** Verbs a `pup_run` subcommand can start with. */
const PUP_READ_VERBS = new Set([
	"list", "get", "search", "query", "show", "status", "aggregate", "describe", "view", "info", "whoami", "help",
]);
const PUP_WRITE_VERBS = new Set([
	"create", "update", "delete", "mute", "unmute", "edit", "post", "send", "cancel", "trigger", "run",
]);

/** Extract pup_run's argv from its input (argv array, or a whitespace-split string). */
function pupRunArgs(input: Record<string, unknown>): string[] {
	const raw = input.args ?? input.argv;
	if (Array.isArray(raw)) return raw.map((a) => String(a));
	if (typeof raw === "string") return raw.trim().length > 0 ? raw.trim().split(/\s+/) : [];
	return [];
}

/**
 * Classify `pup_run` by its subcommand verb: the first recognized non-flag
 * argument decides. Reads (list/get/search/...) and `--help`/`help` are
 * remote reads; writes (create/update/delete/...) and anything unrecognized
 * are remote writes (fail closed).
 */
export function pupRunClass(input: Record<string, unknown>): ToolClass {
	const args = pupRunArgs(input);
	for (const arg of args) {
		if (arg === "--help" || arg === "-h") return "remote-read";
		if (arg.startsWith("-")) continue;
		const verb = arg.toLowerCase();
		if (PUP_READ_VERBS.has(verb)) return "remote-read";
		if (PUP_WRITE_VERBS.has(verb)) return "remote-write";
		// Subcommand-path tokens (e.g. "monitors") are unrecognized here; keep
		// scanning for the verb that follows them.
	}
	return "remote-write";
}

/** Name heuristic: write-ish verbs in the tool name mean remote write. */
const WRITE_NAME_RE = /(post|send|create|update|delete|write|edit|add|remove|put|patch|set|upload|publish|comment|reply|merge|close|resolve|assign|transition)/i;

/** Injected annotation lookup (index.ts caches `pi.getAllTools()` per session). */
export type GetAnnotations = (name: string) => { readOnlyHint?: boolean; destructiveHint?: boolean } | undefined;

export interface ClassifyCallOptions {
	/** guard.json `toolClasses` (exact names or globs); overrides the built-in map. */
	toolClasses?: Record<string, string>;
	/** web_fetch allowlist URL globs; a matching URL is a plain remote read. */
	webFetchAllow?: string[];
	/** Annotation lookup for the fallback steps. */
	getAnnotations?: GetAnnotations;
}

/**
 * Classify one tool call. `toolName` is the pi tool name; `input` is the call
 * input (used for web_fetch URLs, pup_run verbs, and MCP proxy names).
 */
export const OWNED_EXECUTORS = ["bash", "host_bash", "python", "node"] as const;
export type OwnedExecutor = typeof OWNED_EXECUTORS[number];
export function isOwnedExecutor(name: string): name is OwnedExecutor {
	return (OWNED_EXECUTORS as readonly string[]).includes(name);
}

export function classifyToolCall(toolName: string, input: Record<string, unknown> = {}, options: ClassifyCallOptions = {}): ToolClass {
	const name = classificationName(toolName, input);
	// These registrations are authoritative executors, not configurable hints.
	if (isOwnedExecutor(toolName)) return toolName === "host_bash" ? "host-shell" : "sandboxed-exec";

	// 1. guard.json toolClasses: exact key, then glob keys.
	const toolClasses = options.toolClasses;
	if (toolClasses) {
		for (const [key, value] of Object.entries(toolClasses)) {
			if (!isToolClass(value)) continue; // invalid entries are warned about at load time
			if (sameKey(key, name)) return value;
		}
		for (const [key, value] of Object.entries(toolClasses)) {
			if (!isToolClass(value)) continue;
			if (!key.includes("*") && !key.includes("?")) continue;
			try {
				if (compilePattern(key).test(name)) return value;
			} catch {
				// Invalid glob: skip.
			}
		}
	}

	// 2. Built-in map (web_fetch and pup_run classify by input).
	const lower = toolName.toLowerCase();
	if (lower === "web_fetch") return webFetchClass(input, options.webFetchAllow);
	if (lower === "pup_run") return pupRunClass(input);
	const builtin = builtinToolClass(lower);
	if (builtin) return builtin;

	// 3. Annotations (self-declared, unverified). A destructive hint wins over
	// a read-only hint: contradictory hints classify as remote-write (fail
	// closed) instead of trusting the weaker-looking read-only claim.
	const annotations = options.getAnnotations?.(name);
	if (annotations?.readOnlyHint === true && annotations?.destructiveHint !== true) return "remote-read";
	if (annotations?.destructiveHint === true) return "remote-write";

	// 4. Name heuristic.
	if (WRITE_NAME_RE.test(name)) return "remote-write";

	// 5. Unknown: remote write (fail closed).
	return "remote-write";
}

/**
 * Planning eligibility: may an ACTIVE tool stay active during a `/plan`
 * research turn? Pure: reuses the built-in map; no fs, no config, no pi
 * runtime. The caller passes the annotations from a fresh `pi.getAllTools()`
 * lookup at planning entry; there is no long-lived annotation cache.
 *
 * Rules, in order:
 *   1. Built-in host-shell and local-write tools are removed regardless of
 *      annotations (host_bash, pwsh, powershell, write, edit, and the
 *      memory/scratchpad writes). Misleading read-only hints cannot revive
 *      them.
 *   2. Built-in local-read, remote-read, sandboxed-exec, and meta tools stay
 *      (safe reads, the guard-owned sandboxed interpreters, and the approved
 *      orchestration tools).
 *   3. Every other tool needs explicit author annotations:
 *      `readOnlyHint === true && destructiveHint !== true`. Unknown custom
 *      and MCP tools without adequate hints are removed (fail closed).
 *
 * Input-dependent wrappers (web_fetch, pup_run) are deliberately NOT in the
 * built-in map, so they qualify only through explicit annotations: possible
 * read-only argument combinations never make the whole tool planning-safe.
 * This is entry-time declaration filtering, not execution containment:
 * codemode/deferred tools can remain callable, and annotations are unverified
 * author hints.
 */
export function isPlanningToolAllowed(
	name: string,
	annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean },
): boolean {
	const builtin = builtinToolClass(name);
	if (builtin) return builtin !== "host-shell" && builtin !== "local-write";
	return annotations?.readOnlyHint === true && annotations?.destructiveHint !== true;
}
