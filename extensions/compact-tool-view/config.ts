/**
 * Mode table for compact-tool-view.
 *
 * Pure loader: the code defaults plus sparse overrides from a JSON file (the
 * caller passes the path, so tests can use temp files; this module never
 * resolves the agent directory itself, matching ../shared/model-pin.ts).
 */

import { existsSync, readFileSync } from "node:fs";

export type Mode = "gist" | "hide" | "stock";

/** An effective mode. `stock` never resolves: it means "leave pi's rendering". */
export type ActiveMode = Exclude<Mode, "stock">;

/**
 * Code defaults. Every entry gists; nothing hides by default. Presence of a
 * name in the effective table is the opt-in, even for a tool that defines its
 * own renderer. `subagent` is deliberately absent: it renders itself and is
 * left stock. `codemode` and `tool_search` do define their own renderers but
 * are included on purpose: compact-tool-view replaces only their collapsed
 * result body, while expanded and streaming views delegate to the stock
 * renderer. The three MCP resource tools have no renderer of their own, so
 * their gist is the generic line count. Defaults are exact names only: prefix
 * patterns are a file-only feature, and the `mcp__*` family is a user-config
 * pattern.
 */
export const DEFAULT_MODES: Record<string, Mode> = {
	read: "gist",
	bash: "gist",
	host_bash: "gist",
	powershell: "gist",
	edit: "gist",
	grep: "gist",
	find: "gist",
	ls: "gist",
	ffgrep: "gist",
	fffind: "gist",
	python: "gist",
	node: "gist",
	gh_read: "gist",
	git_read: "gist",
	web_fetch: "gist",
	web_search: "gist",
	session_search: "gist",
	session_excerpt: "gist",
	jira_read: "gist",
	jira_update: "gist",
	subagent_list: "gist",
	request_read_access: "gist",
	write: "gist",
	codemode: "gist",
	tool_search: "gist",
	list_mcp_resources: "gist",
	list_mcp_resource_templates: "gist",
	read_mcp_resource: "gist",
};

/**
 * A parsed mode configuration. Code defaults and file entries stay apart
 * because they have different precedence: a file exact entry beats any file
 * pattern, a file pattern beats a code default, and a code default is the last
 * resort. `stocked` remembers file entries that said `stock` so they suppress
 * a matching pattern (rather than only being dropped from the map).
 */
export interface ModeTable {
	/** Code defaults (exact names only; patterns are a file-only feature). Lowest precedence. */
	defaults: Record<string, Mode>;
	/** File exact entries (`"gist"` | `"hide"`). Highest precedence. */
	exact: Record<string, ActiveMode>;
	/** File names explicitly marked `"stock"`: no gist, even over a matching pattern. */
	stocked: Set<string>;
	/** File prefix patterns (`"<prefix>*"`), longest prefix first. */
	patterns: Array<{ prefix: string; mode: Mode }>;
}

/** A key that is a prefix pattern: a trailing `*` and no other `*`. */
const isPatternKey = (key: string): boolean => key.endsWith("*") && !key.slice(0, -1).includes("*");

/**
 * Effective modes for `path` over the code defaults. A missing file is pure
 * defaults with no warning. A non-object top level or unparseable JSON is
 * defaults plus one warning. In the object a key is an exact tool name or a
 * prefix pattern (a trailing `*`, the only `*` allowed; `"*"` matches every
 * name), values are `"gist"`, `"hide"`, or `"stock"`, unknown exact names are
 * kept (they enable the mode), and anything else (an invalid value, or a `*`
 * anywhere but the end of the key) is skipped and folded into one warning.
 */
export function loadModes(path: string): { table: ModeTable; warning?: string } {
	const table: ModeTable = { defaults: { ...DEFAULT_MODES }, exact: {}, stocked: new Set(), patterns: [] };
	if (!existsSync(path)) return { table };

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (err) {
		return { table, warning: `${path}: failed to read (${(err as Error).message})` };
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { table, warning: `${path}: top-level value must be an object` };
	}

	const invalid: string[] = [];
	for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
		if (key.includes("*") && !isPatternKey(key)) {
			invalid.push(`invalid key ${JSON.stringify(key)}`);
			continue;
		}
		if (value !== "gist" && value !== "hide" && value !== "stock") {
			invalid.push(`${key}=${JSON.stringify(value)}`);
			continue;
		}
		if (isPatternKey(key)) table.patterns.push({ prefix: key.slice(0, -1), mode: value });
		else if (value === "stock") table.stocked.add(key);
		else table.exact[key] = value;
	}
	table.patterns.sort((a, b) => b.prefix.length - a.prefix.length);
	if (invalid.length === 0) return { table };
	return {
		table,
		warning: `${path}: ignored invalid entries (${invalid.join(", ")}); expected "gist", "hide", or "stock" on a tool name or a prefix pattern ending in "*"`,
	};
}

/**
 * The effective mode for `toolName`, or `undefined` to leave pi's rendering
 * untouched (no match, a file exact `stock`, or a matching `stock` pattern).
 * Precedence: file exact entry, file `stock` name, longest matching file
 * pattern, then the code default.
 */
export function resolveMode(table: ModeTable, toolName: string): ActiveMode | undefined {
	const exact: ActiveMode | undefined = table.exact[toolName];
	if (exact !== undefined) return exact;
	if (table.stocked.has(toolName)) return undefined;
	for (const { prefix, mode } of table.patterns) {
		if (toolName.startsWith(prefix)) return mode === "stock" ? undefined : mode;
	}
	const fallback: Mode | undefined = table.defaults[toolName];
	return fallback === "stock" ? undefined : fallback;
}
