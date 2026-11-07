/**
 * Pure gist derivation for compact-tool-view. No runtime imports (type-only
 * imports would be fine too), so plain node test runners can import it via type
 * stripping, matching the ../shared/model-pin.ts convention.
 *
 * `gistFor` returns the gist line plus any extra dimmed lines (content blocks
 * beyond the first, so guard's appended warning blocks stay visible). The
 * renderer styles element 0 as normal tool output and the rest as dim.
 */

/** Minimal shape of the tool result fields the gist reads. */
export interface GistResult {
	content?: unknown;
	details?: unknown;
	structuredContent?: unknown;
	isError?: boolean;
}

const asObject = (value: unknown): Record<string, any> | undefined =>
	value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : undefined;

const firstText = (content: unknown): string | undefined => {
	if (!Array.isArray(content)) return undefined;
	for (const block of content) {
		const obj = asObject(block);
		if (obj?.type === "text" && typeof obj.text === "string") return obj.text;
	}
	return undefined;
};

const hasImageBlock = (content: unknown): boolean =>
	Array.isArray(content) && content.some((block) => asObject(block)?.type === "image");

/** Line count exactly as the settled design specifies: `text.split("\n").length`. */
const lineCount = (text: string | undefined): number => (text ?? "").split("\n").length;

/** Text blocks beyond the first, rendered verbatim as one dimmed line each. */
const extraLines = (content: unknown): string[] => {
	if (!Array.isArray(content)) return [];
	const lines: string[] = [];
	for (let index = 1; index < content.length; index++) {
		const obj = asObject(content[index]);
		if (obj?.type === "text" && typeof obj.text === "string" && obj.text !== "") lines.push(obj.text);
	}
	return lines;
};

/**
 * Failures always surface, ignoring gist/hide: `exit N` for exec tools, else the
 * first error line.
 *
 * pi's `ToolExecutionComponent` forwards only `{ content, details }` to a result
 * renderer (`dist/modes/interactive/components/tool-execution.js`), so
 * `structuredContent` (and with it `exit_code`) is normally absent and the error
 * flag arrives on `ToolRenderContext.isError`; the resolver seeds `isError` from
 * the context before calling here. `structuredContent.exit_code` is still
 * honored when a caller forwards it, and the native shell tools append
 * `Command exited with code N` to `content`, which covers the real exec case.
 */
const failureGist = (result: GistResult): string | undefined => {
	if (!result.isError) return undefined;
	const exitCode = asObject(result.structuredContent)?.exit_code;
	if (typeof exitCode === "number") return `exit ${exitCode}`;
	const text = firstText(result.content) ?? "";
	const exited = text.match(/Command exited with code (\d+)/);
	if (exited) return `exit ${exited[1]}`;
	const firstLine = text.split("\n")[0] ?? "";
	return `error: ${firstLine}`;
};

/** The typed gist for one tool, or undefined when the shape is not the expected one. */
const detailGist = (toolName: string, result: GistResult, args: unknown): string | undefined => {
	const details = asObject(result.details);
	switch (toolName) {
		case "read": {
			if (hasImageBlock(result.content)) return "image";
			const truncation = asObject(details?.truncation);
			const total = typeof truncation?.totalLines === "number" ? truncation.totalLines : lineCount(firstText(result.content));
			return `${total} lines${truncation?.truncated ? ", truncated" : ""}`;
		}
		case "bash":
		case "host_bash":
		case "powershell": {
			// structuredContent is normally not forwarded (see failureGist), so the
			// model-facing first text block is the count source in practice.
			const output = asObject(result.structuredContent)?.output;
			const count = lineCount(typeof output === "string" ? output : firstText(result.content));
			return `done (${count} lines)`;
		}
		case "edit": {
			const diff = details?.diff;
			if (typeof diff !== "string") return undefined;
			let added = 0;
			let removed = 0;
			for (const line of diff.split("\n")) {
				if (line.startsWith("+")) added++;
				else if (line.startsWith("-")) removed++;
			}
			return `+${added} / -${removed}`;
		}
		case "grep": {
			const limit = details?.matchLimitReached;
			const count = typeof limit === "number" ? limit : lineCount(firstText(result.content));
			return `${count}${typeof limit === "number" ? "+" : ""} matches`;
		}
		case "find": {
			const limit = details?.resultLimitReached;
			const count = typeof limit === "number" ? limit : lineCount(firstText(result.content));
			return `${count}${typeof limit === "number" ? "+" : ""} files`;
		}
		case "ls": {
			const limit = details?.entryLimitReached;
			const count = typeof limit === "number" ? limit : lineCount(firstText(result.content));
			return `${count}${typeof limit === "number" ? "+" : ""} entries`;
		}
		case "ffgrep": {
			const matched = details?.totalMatched;
			if (typeof matched !== "number") return undefined;
			const files = details?.totalFiles;
			return `${matched} matches${typeof files === "number" ? ` in ${files} files` : ""}`;
		}
		case "fffind": {
			const matched = details?.totalMatched;
			return typeof matched === "number" ? `${matched} files` : undefined;
		}
		case "python":
		case "node": {
			const status = details?.status;
			return typeof status === "string" ? status : undefined;
		}
		case "write": {
			const content = asObject(args)?.content;
			return typeof content === "string" ? `${lineCount(content)} lines written` : undefined;
		}
		default:
			return undefined;
	}
};

/** Fallback for tools without a typed gist: `image` when an image block is present, else `N lines`. */
const fallbackGist = (content: unknown): string => {
	if (hasImageBlock(content)) return "image";
	return `${lineCount(firstText(content))} lines`;
};

/**
 * The gist for one tool result: element 0 is the primary line, the rest are
 * extra dimmed lines. Order: failure, typed details, then the generic fallback,
 * with content blocks beyond the first always appended as extras.
 */
export function gistFor(toolName: string, result: GistResult, args: unknown): string[] {
	const primary = failureGist(result) ?? detailGist(toolName, result, args) ?? fallbackGist(result.content);
	return [primary, ...extraLines(result.content)];
}
