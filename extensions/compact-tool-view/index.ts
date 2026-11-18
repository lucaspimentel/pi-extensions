/**
 * compact-tool-view: replace the collapsed body of tool result rows with a
 * synthesized gist line set (usually one line; `codemode` failures are two), or,
 * in `hide` mode, no body plus a dimmed expand hint.
 *
 * Exactly one `pi.registerToolRenderer` resolver is registered. It never
 * re-registers a tool (that replaces the definition and loses prompt
 * metadata); it returns a spread copy of the base renderers with only
 * `renderResult` replaced, so `renderShell` and `renderCall` are preserved.
 * Names the mode table does not resolve (or that resolve to `stock`) pass
 * through unchanged. The table is resolved with `resolveMode`, where a file
 * exact entry beats a file prefix pattern and a file pattern beats a code
 * default. The wrap is collapsed-only: expanded and streaming views delegate
 * to the base renderer when one exists, and otherwise synthesize the body pi's
 * own fallback would have drawn (see `fallbackBodyText`), so expanding is never
 * a no-op. Display-only: the model-facing content and `structuredContent` are
 * never changed, and neither guard policy nor the call row is touched.
 *
 * timestamps registers its own resolver for every tool name and both delegate
 * through `next()`, so the two compose in either load order.
 */

import {
	getAgentDir,
	type ExtensionAPI,
	type Theme,
	type ToolRendererResolver,
	type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { replaceControlCharacters, stripTerminalSequences, Text } from "@earendil-works/pi-tui";
import { join } from "node:path";
import { loadModes, resolveMode } from "./config.ts";
import { gistFor, textBlocks, type GistLine } from "./gist.ts";

const CONFIG_FILE = "compact-tool-view.json";
const EXPAND_KEYBINDING = "app.tools.expand";
/** Preview cap for the synthesized streaming body; pi's own fallback previews 10 lines. */
const PREVIEW_LINES = 5;

/** Structural view of the renderer context fields this extension reads. */
interface RenderContextLike {
	args?: unknown;
	/** Present on pi 1.5+; absent from the declared 1.3 types. */
	keyHint?: (keybinding: string, description: string) => string;
	/** The error flag, carried on the context because pi forwards only content/details. */
	isError?: boolean;
}

/** One line per gist line, each styled from its own dim flag. */
const gistText = (lines: GistLine[], theme: Theme): string =>
	lines.map((line) => theme.fg(line.dim ? "muted" : "toolOutput", line.text)).join("\n");

const expandHint = (context: RenderContextLike): string =>
	context.keyHint?.(EXPAND_KEYBINDING, "to expand") ?? "ctrl+o to expand";

const hideText = (theme: Theme, context: RenderContextLike): string => theme.fg("muted", expandHint(context));

/**
 * Sanitized result body as lines: the model-facing text blocks joined by
 * newlines, then terminal sequences removed and control characters blanked.
 * `stripTerminalSequences` and `replaceControlCharacters` are pi-tui's public
 * API; the latter also eats newlines, so it runs line by line, and it would
 * collapse a tab run to a single space, so each line is split on tabs and
 * rejoined with a real tab, which pi-tui's `Text` then expands to three
 * spaces the way pi's fallback body does. An empty result is no lines, not
 * one empty line.
 */
const bodyLines = (content: unknown): string[] => {
	const text = stripTerminalSequences(textBlocks(content).join("\n")).replace(/\r/g, "");
	if (text === "") return [];
	return text.split("\n").map((line) => line.split("\t").map(replaceControlCharacters).join("\t"));
};

/**
 * The body pi would have drawn for a tool whose base renderer has none
 * (`createResultFallback` in `tool-execution.js`), which installing any
 * `renderResult` suppresses: every line when expanded, else the first
 * `PREVIEW_LINES` lines plus the same dimmed `... (N more lines, <key> to
 * expand)` tail pi appends. No lines means no body, and the caller keeps the
 * gist; the design doc covers the image placeholders this does not reproduce.
 */
const fallbackBodyText = (content: unknown, expanded: boolean, theme: Theme, context: RenderContextLike): string => {
	const lines = bodyLines(content);
	if (lines.length === 0) return "";
	const shown = expanded ? lines : lines.slice(0, PREVIEW_LINES);
	let text = shown.map((line) => theme.fg("toolOutput", line)).join("\n");
	const remaining = lines.length - shown.length;
	if (remaining > 0) {
		text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${expandHint(context)}${theme.fg("muted", ")")}`;
	}
	return text;
};

export default function compactToolViewExtension(pi: ExtensionAPI): void {
	const { table, warning } = loadModes(join(getAgentDir(), CONFIG_FILE));
	if (warning) {
		// Notified once per factory run (a /reload re-runs the factory); the
		// first session_start is the earliest point with a UI context.
		let reported = false;
		pi.on("session_start", (_event, ctx) => {
			if (reported) return;
			reported = true;
			ctx.ui.notify(`compact-tool-view: ${warning}`, "warning");
		});
	}

	const resolver: ToolRendererResolver = (toolName, next) => {
		const mode = resolveMode(table, toolName);
		if (mode === undefined) return next();
		const base = next();
		const renderResult: NonNullable<ToolRenderers["renderResult"]> = (result, options, theme, context) => {
			const view = context as RenderContextLike;
			// Expanded and streaming views keep the stock rendering when the base has
			// one; the gist is collapsed-only and lands on the final result.
			if (options.expanded || options.isPartial) {
				if (base?.renderResult) return base.renderResult(result, options, theme, context);
				const body = fallbackBodyText(result.content, options.expanded, theme, view);
				if (body !== "") return new Text(body, 0, 0);
			}
			// pi forwards only { content, details } to a result renderer; the error flag
			// is on the context, so seed it into the result shape the gist reads.
			const isError = Boolean(view.isError || result.isError);
			// Failures always surface, ignoring hide.
			if (mode === "hide" && !isError) return new Text(hideText(theme, view), 0, 0);
			const gistResult = isError === Boolean(result.isError) ? result : { ...result, isError };
			return new Text(gistText(gistFor(toolName, gistResult, view.args), theme), 0, 0);
		};
		return { ...(base ?? {}), renderResult };
	};

	pi.registerToolRenderer(resolver);
}
