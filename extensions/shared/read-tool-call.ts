/**
 * Shared call-row helpers for `gh_read` and `git_read`.
 *
 * Both tools render their own collapsed call line inline (the operation, its
 * identifying arguments, and the tags that say how the call was narrowed) and
 * share two pure pieces here: how one argument is quoted into a command line,
 * and the expanded view, which mirrors pi's own fallback shape
 * (`dist/core/tools/render-utils.js`, `formatToolCallWithArgs`) because that
 * function is not exported from the package root. Nothing is capped or elided:
 * the row wraps, and the expanded view lists every argument pi passed.
 *
 * Type-only pi imports, so a plain node type-stripping runner can import this
 * module the way the tool modules themselves are imported.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";

/** An argument needs quoting when it holds whitespace or a quote of its own. */
const NEEDS_QUOTES = /[\s"\\]/;

/** One argument as it appears on a command line, quoted only when it has to be. */
export function quoteArg(arg: string): string {
	if (!NEEDS_QUOTES.test(arg)) return arg;
	return `"${arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** The command line after a subcommand: arguments in order, quoted as needed. */
export function joinCallArgs(args: readonly string[]): string {
	return args.map(quoteArg).join(" ");
}

/** The row's first token: the raw tool name, bold, in the toolTitle role. */
export function toolTitle(name: string, theme: Theme): string {
	return theme.fg("toolTitle", theme.bold(name));
}

const replaceTabs = (text: string): string => text.replace(/\t/g, "   ");

/**
 * pi's own expanded call-row shape: one `key: value` line per argument, two
 * spaces of indent, strings raw and anything else `JSON.stringify(value, null,
 * 2)`, tab replacement and CR removal, continuation lines indented four
 * spaces, and the whole block muted. Returns undefined when there is nothing to
 * list, which leaves the title alone.
 */
export function expandedArgs(args: unknown, theme: Theme): string | undefined {
	if (args === null || args === undefined) return undefined;
	const entries =
		typeof args === "object" && !Array.isArray(args)
			? Object.entries(args as Record<string, unknown>)
			: ([["args", args]] as Array<[string, unknown]>);
	if (entries.length === 0) return undefined;
	const lines = entries.map(([key, value]) => {
		const text = typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? String(value));
		return `  ${key}: ${replaceTabs(text).replace(/\r/g, "").split("\n").join("\n    ")}`;
	});
	return theme.fg("muted", lines.join("\n"));
}
