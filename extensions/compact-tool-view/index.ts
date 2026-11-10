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
 * to the base renderer when one exists. Display-only: the model-facing content
 * and `structuredContent` are never changed, and neither guard policy nor the
 * call row is touched.
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
import { Text } from "@earendil-works/pi-tui";
import { join } from "node:path";
import { loadModes, resolveMode } from "./config.ts";
import { gistFor, type GistLine } from "./gist.ts";

const CONFIG_FILE = "compact-tool-view.json";
const EXPAND_KEYBINDING = "app.tools.expand";

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

const hideText = (theme: Theme, context: RenderContextLike): string =>
	theme.fg("muted", context.keyHint?.(EXPAND_KEYBINDING, "to expand") ?? "ctrl+o to expand");

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
			// Expanded and streaming views keep the stock rendering; the gist is
			// collapsed-only and lands on the final result.
			if ((options.expanded || options.isPartial) && base?.renderResult) {
				return base.renderResult(result, options, theme, context);
			}
			const view = context as RenderContextLike;
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
