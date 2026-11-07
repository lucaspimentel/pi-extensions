/**
 * Mode table for compact-tool-view.
 *
 * Pure loader: the code defaults plus sparse overrides from a JSON file (the
 * caller passes the path, so tests can use temp files; this module never
 * resolves the agent directory itself, matching ../shared/model-pin.ts).
 */

import { existsSync, readFileSync } from "node:fs";

export type Mode = "gist" | "hide" | "stock";

/**
 * Code defaults. Every entry gists; nothing hides by default. Presence of a
 * name in the effective table is the opt-in, even for a tool that defines its
 * own renderer. `subagent` is deliberately absent: it renders itself and is
 * left stock.
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
};

/**
 * Effective modes for `path` over the code defaults. A missing file is pure
 * defaults with no warning. A non-object top level or unparseable JSON is
 * defaults plus one warning. In the object, `"stock"` deletes the name from the
 * effective map, unknown names are kept (they enable the mode), and any other
 * value is skipped and folded into one warning.
 */
export function loadModes(path: string): { modes: Record<string, Mode>; warning?: string } {
	const modes: Record<string, Mode> = { ...DEFAULT_MODES };
	if (!existsSync(path)) return { modes };

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (err) {
		return { modes, warning: `${path}: failed to read (${(err as Error).message})` };
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { modes, warning: `${path}: top-level value must be an object` };
	}

	const invalid: string[] = [];
	for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
		if (value === "gist" || value === "hide") modes[name] = value;
		else if (value === "stock") delete modes[name];
		else invalid.push(`${name}=${JSON.stringify(value)}`);
	}
	if (invalid.length === 0) return { modes };
	return {
		modes,
		warning: `${path}: ignored invalid entries (${invalid.join(", ")}); expected "gist", "hide", or "stock"`,
	};
}
