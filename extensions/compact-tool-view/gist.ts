/**
 * Pure gist derivation for compact-tool-view. No runtime imports (type-only
 * imports would be fine too), so plain node test runners can import it via type
 * stripping, matching the ../shared/model-pin.ts convention.
 *
 * `gistFor` returns a line set: each line carries its own `dim` flag and the
 * renderer styles it from that flag, never by position. Only `codemode` ever
 * returns more than one line, because its failure is two normal lines. Every
 * other tool returns one normal line, then the content blocks beyond the first
 * as verbatim dimmed lines (so guard's appended warning blocks stay visible).
 */

/** Minimal shape of the tool result fields the gist reads. */
export interface GistResult {
	content?: unknown;
	details?: unknown;
	structuredContent?: unknown;
	isError?: boolean;
}

/** One rendered gist line. `dim` is opt-in; a missing flag means normal output. */
export interface GistLine {
	text: string;
	dim?: boolean;
}

/** A single normal line, the shape almost every branch returns. */
const one = (text: string): GistLine[] => [{ text }];

const asObject = (value: unknown): Record<string, any> | undefined =>
	value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : undefined;

/** The `text` of every text content block, in order. */
const textBlocks = (content: unknown): string[] => {
	if (!Array.isArray(content)) return [];
	const texts: string[] = [];
	for (const block of content) {
		const obj = asObject(block);
		if (obj?.type === "text" && typeof obj.text === "string") texts.push(obj.text);
	}
	return texts;
};

/** The first text content block, or undefined when the result carries none. */
const firstText = (content: unknown): string | undefined => textBlocks(content)[0];

const hasImageBlock = (content: unknown): boolean =>
	Array.isArray(content) && content.some((block) => asObject(block)?.type === "image");

/** Line count exactly as the settled design specifies: `text.split("\n").length`. */
const lineCount = (text: string | undefined): number => (text ?? "").split("\n").length;

/** Text blocks beyond the first, one dimmed line each. `codemode` suppresses these (see `gistFor`). */
const extraLines = (content: unknown): GistLine[] => {
	if (!Array.isArray(content)) return [];
	const lines: GistLine[] = [];
	for (let index = 1; index < content.length; index++) {
		const obj = asObject(content[index]);
		if (obj?.type === "text" && typeof obj.text === "string" && obj.text !== "") lines.push({ text: obj.text, dim: true });
	}
	return lines;
};

/**
 * `codemode`'s result header, copied from pi's own renderer
 * (`dist/extensions/codemode/renderer.js`, `SCRIPT_HEADER`), and the marker pi
 * appends to the output text on a failed script. Both are duplicated pi
 * internals: if pi changes either shape the gist degrades quietly (the header
 * lines would be counted as output, or a failure would fall back to
 * `error: Script failed`), which is why they are named constants.
 */
const CODEMODE_HEADER = /^Script (completed|failed)\nWall time [\d.]+ seconds\nOutput:\n$/;
const SCRIPT_ERROR_MARKER = "Script error:\n";

/** The nested tool calls `codemode` reports, or an empty list when there is none. */
const codemodeCalls = (result: GistResult): any[] => {
	const calls = asObject(result.details)?.calls;
	return Array.isArray(calls) ? calls : [];
};

/**
 * `Script completed, N calls[, M failed]` or `Script failed, N calls[, M failed]`.
 * Nouns are deliberately fixed plural (`1 calls`, `1 failed`), matching the pup
 * convention. `N` counts every nested call including `cancelled` ones; `M` counts
 * only `status === "error"` and its suffix is omitted when there are none.
 */
const codemodeCallLine = (verb: "completed" | "failed", calls: any[]): string => {
	const failed = calls.filter((call) => asObject(call)?.status === "error").length;
	return `Script ${verb}, ${calls.length} calls${failed > 0 ? `, ${failed} failed` : ""}`;
};

/**
 * Line count of the output the model saw: the text blocks after the header
 * block, joined. An empty output is `0`, not the `1` that `lineCount("")` would
 * give. pi's `[Image saved to <path>]` block counts as output, on purpose.
 */
const codemodeOutputLines = (content: unknown): number => {
	const texts = textBlocks(content);
	const header = texts[0];
	const output = header !== undefined && CODEMODE_HEADER.test(header) ? texts.slice(1) : texts;
	return output.length === 0 ? 0 : lineCount(output.join("\n"));
};

/**
 * The two-line `codemode` failure, or undefined when pi's `Script error:` block
 * is absent (a script rejected before it ran, for example), which lets the
 * generic `error: <first line>` path run instead.
 */
const codemodeFailureGist = (result: GistResult): GistLine[] | undefined => {
	const joined = textBlocks(result.content).join("\n");
	const start = joined.indexOf(SCRIPT_ERROR_MARKER);
	if (start === -1) return undefined;
	const errorLine = joined.slice(start + SCRIPT_ERROR_MARKER.length).split("\n")[0] ?? "";
	if (errorLine.trim() === "") return undefined;
	return [{ text: codemodeCallLine("failed", codemodeCalls(result)) }, { text: errorLine }];
};

/**
 * Failures always surface, ignoring gist/hide: `codemode` gets its own two-line
 * pair when pi's error block is present, then `timed out` for a killed or
 * timed-out exec, `exit N` when an exit code is available, else the first error
 * line.
 *
 * pi's `ToolExecutionComponent` forwards only `{ content, details }` to a result
 * renderer (`dist/modes/interactive/components/tool-execution.js`), so
 * `structuredContent` (and with it `exit_code`) is normally absent and the error
 * flag arrives on `ToolRenderContext.isError`; the resolver seeds `isError` from
 * the context before calling here. Forwarded `details` is the reliable
 * structured source: `details.killed` (`pup_*`) and `details.timedOut`
 * (`gh_read`) win first because such a process can still report `exitCode: 0`,
 * and a non-zero `details.exitCode` is next. `structuredContent.exit_code` is
 * still honored when a caller forwards it, and the native shell tools append
 * `Command exited with code N` to `content`, which covers the real exec case.
 */
const failureGist = (toolName: string, result: GistResult): GistLine[] | undefined => {
	if (!result.isError) return undefined;
	if (toolName === "codemode") {
		const codemode = codemodeFailureGist(result);
		if (codemode !== undefined) return codemode;
	}
	const details = asObject(result.details);
	if (details?.killed === true || details?.timedOut === true) return one("timed out");
	const detailsExitCode = details?.exitCode;
	if (typeof detailsExitCode === "number" && detailsExitCode !== 0) return one(`exit ${detailsExitCode}`);
	const exitCode = asObject(result.structuredContent)?.exit_code;
	if (typeof exitCode === "number") return one(`exit ${exitCode}`);
	const text = firstText(result.content) ?? "";
	const exited = text.match(/Command exited with code (\d+)/);
	if (exited) return one(`exit ${exited[1]}`);
	const firstLine = text.split("\n")[0] ?? "";
	return one(`error: ${firstLine}`);
};

/**
 * pup_* tools, the path inside pup's JSON envelope (`{ data, ... }`) that holds
 * the items to count, and the noun for them. Every pup command wraps its payload
 * in that envelope (verified against the installed CLI on 2026-11-07), so the
 * path is per tool; a payload that does not match a path falls through to the
 * generic line count. Nouns are deliberately fixed plural (`1 buckets`).
 */
const PUP_COUNTS: Record<string, { path: string[]; noun: string }> = {
	pup_monitors_list: { path: ["data"], noun: "monitors" },
	pup_logs_search: { path: ["data"], noun: "logs" },
	pup_traces_search: { path: ["data"], noun: "traces" },
	pup_apm_services: { path: ["data", "attributes", "services"], noun: "services" },
	pup_logs_aggregate: { path: ["data", "buckets"], noun: "buckets" },
	pup_metrics_query: { path: ["data", "series"], noun: "series" },
	pup_run: { path: ["data"], noun: "items" },
};

/** The length of the array at `path` inside `value`, or undefined when it is not one. */
const countAt = (value: unknown, path: readonly string[]): number | undefined => {
	let current: unknown = value;
	for (const key of path) {
		const obj = asObject(current);
		if (obj === undefined) return undefined;
		current = obj[key];
	}
	return Array.isArray(current) ? current.length : undefined;
};

/** The typed gist lines for one tool, or undefined when the shape is not the expected one. */
const detailGist = (toolName: string, result: GistResult, args: unknown): GistLine[] | undefined => {
	const details = asObject(result.details);
	switch (toolName) {
		case "gitlab_read": {
			// gitlab-read never sets isError, so a timeout or non-zero exit is only
			// visible here; details carries both. A success returns undefined and
			// falls through to the generic line count.
			if (details?.timedOut === true) return one("timed out");
			const exitCode = details?.exitCode;
			if (typeof exitCode === "number" && exitCode !== 0) return one(`exit ${exitCode}`);
			return undefined;
		}
		case "read": {
			if (hasImageBlock(result.content)) return one("image");
			const truncation = asObject(details?.truncation);
			const total = typeof truncation?.totalLines === "number" ? truncation.totalLines : lineCount(firstText(result.content));
			return one(`${total} lines${truncation?.truncated ? ", truncated" : ""}`);
		}
		case "bash":
		case "host_bash":
		case "powershell": {
			// structuredContent is normally not forwarded (see failureGist), so the
			// model-facing first text block is the count source in practice.
			const output = asObject(result.structuredContent)?.output;
			const count = lineCount(typeof output === "string" ? output : firstText(result.content));
			return one(`done (${count} lines)`);
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
			return one(`+${added} / -${removed}`);
		}
		case "grep": {
			const limit = details?.matchLimitReached;
			const count = typeof limit === "number" ? limit : lineCount(firstText(result.content));
			return one(`${count}${typeof limit === "number" ? "+" : ""} matches`);
		}
		case "find": {
			const limit = details?.resultLimitReached;
			const count = typeof limit === "number" ? limit : lineCount(firstText(result.content));
			return one(`${count}${typeof limit === "number" ? "+" : ""} files`);
		}
		case "ls": {
			const limit = details?.entryLimitReached;
			const count = typeof limit === "number" ? limit : lineCount(firstText(result.content));
			return one(`${count}${typeof limit === "number" ? "+" : ""} entries`);
		}
		case "ffgrep": {
			const matched = details?.totalMatched;
			if (typeof matched !== "number") return undefined;
			const files = details?.totalFiles;
			return one(`${matched} matches${typeof files === "number" ? ` in ${files} files` : ""}`);
		}
		case "fffind": {
			const matched = details?.totalMatched;
			return typeof matched === "number" ? one(`${matched} files`) : undefined;
		}
		case "python":
		case "node": {
			const status = details?.status;
			return typeof status === "string" ? one(status) : undefined;
		}
		case "write": {
			const content = asObject(args)?.content;
			return typeof content === "string" ? one(`${lineCount(content)} lines written`) : undefined;
		}
		case "codemode": {
			// The gist owns the content blocks for this tool (see gistFor), so the
			// script output is never dumped as a dimmed extra line. Nested calls,
			// their durations, the model-call cost, the output preview, the full
			// output path, and the Elapsed/Took timer all stay on expansion.
			const lines = codemodeOutputLines(result.content);
			const truncated = typeof details?.fullOutputPath === "string" ? ", truncated" : "";
			return one(`${codemodeCallLine("completed", codemodeCalls(result))}, ${lines} lines${truncated}`);
		}
		case "tool_search": {
			const loaded = details?.loaded;
			if (!Array.isArray(loaded)) return undefined;
			return one(loaded.length === 0 ? "no matches" : `${loaded.length} tools loaded`);
		}
		case "memory_write": {
			// pi-memory's result text embeds a preview of the whole target file, so its
			// line count says nothing useful; the target and mode identify the write.
			const target = details?.target;
			if (target === "daily") return one("daily log appended");
			if (target === "long_term") return one(details?.mode === "overwrite" ? "MEMORY.md overwritten" : "MEMORY.md appended");
			return undefined;
		}
		case "scratchpad": {
			// Successful mutations carry `action`; `list` carries only the counts, and
			// every failure path (no `text`, no match) carries neither.
			const action = details?.action;
			if (action === "add") return one("item added");
			if (action === "done") return one("item done");
			if (action === "undo") return one("item reopened");
			if (action === "clear_done") {
				const removed = details?.removed;
				return typeof removed === "number" ? one(`cleared ${removed} done ${removed === 1 ? "item" : "items"}`) : undefined;
			}
			const count = details?.count;
			const open = details?.open;
			if (typeof count === "number" && typeof open === "number") return one(`${open} open / ${count} items`);
			return asObject(args)?.action === "list" ? one("empty") : undefined;
		}
		case "memory_read": {
			const target = asObject(args)?.target;
			if (target === "list") {
				const files = details?.files;
				return Array.isArray(files) ? one(`${files.length} daily logs`) : one("no daily logs");
			}
			// Only `daily` names a file the call row does not show (it defaults to
			// today); `long_term` and `scratchpad` already gist their line count.
			if (target !== "daily") return undefined;
			if (typeof details?.path !== "string") return one("no log");
			const date = details.date;
			return typeof date === "string" ? one(`${date} log, ${lineCount(firstText(result.content))} lines`) : undefined;
		}
		case "memory_forget": {
			const removed = details?.removed;
			if (typeof removed !== "number") return undefined;
			if (removed === 0) return one("nothing removed");
			return one(`removed ${removed} ${removed === 1 ? "entry" : "entries"}`);
		}
		case "memory_restore": {
			const restored = details?.restored;
			if (typeof restored === "number" && restored > 0) return one(`restored ${restored} ${restored === 1 ? "entry" : "entries"}`);
			return typeof details?.restoredAt === "string" || restored === 0 ? one("already restored") : undefined;
		}
		case "memory_search": {
			const count = details?.count;
			const mode = details?.mode;
			if (typeof count !== "number" || typeof mode !== "string") return undefined;
			const embed = details?.embedStarted ? ", embeddings started" : details?.needsEmbed ? ", embeddings missing" : "";
			return one(`${count} results (${mode})${embed}`);
		}
		case "memory_status": {
			if (typeof details?.qmd !== "boolean") return undefined;
			if (!details.qmd) return one("qmd unavailable");
			const collection = details.collection === true ? "collection ok" : "collection missing";
			const embeddings = typeof details.embeddings === "string" ? details.embeddings : "unknown";
			return one(`qmd ok, ${collection}, embeddings ${embeddings}`);
		}
		case "pup_auth_status": {
			// The one flat pup payload: there is nothing to count, so it gets its own
			// line. Deliberately no expiry, countdown, scope count, or status_message
			// text (status_message embeds a live countdown), and no `refreshed` suffix:
			// the line already describes auth state.
			const parsed = asObject(details?.parsed);
			if (typeof parsed?.authenticated !== "boolean") return undefined;
			const site = typeof parsed.site === "string" && parsed.site !== "" ? ` (${parsed.site})` : "";
			return one(`${parsed.authenticated ? "authenticated" : "not authenticated"}${site}`);
		}
		default: {
			// pup_*: the payload is the parsed JSON of `pup ... --output json`, and
			// pup's envelope, not the command, decides where the items sit. Any
			// other shape (an unexpected payload, a non-JSON stdout, a pup tool
			// without an entry here) falls through to the generic line count.
			const spec = PUP_COUNTS[toolName];
			if (spec === undefined) return undefined;
			const count = countAt(details?.parsed, spec.path);
			if (count === undefined) return undefined;
			return one(`${count} ${spec.noun}${details?.refreshed === true ? ", auth refreshed" : ""}`);
		}
	}
};

/** Fallback for tools without a typed gist: `image` when an image block is present, else `N lines`. */
const fallbackGist = (content: unknown): string => {
	if (hasImageBlock(content)) return "image";
	return `${lineCount(firstText(content))} lines`;
};

/**
 * The gist lines for one tool result. Order: failure, typed details, then the
 * generic fallback. Every tool except `codemode` also appends the content blocks
 * beyond the first as dimmed extras; `codemode` consumes its own blocks so a
 * long script output never lands in the collapsed row.
 */
export function gistFor(toolName: string, result: GistResult, args: unknown): GistLine[] {
	const primary = failureGist(toolName, result) ?? detailGist(toolName, result, args) ?? one(fallbackGist(result.content));
	if (toolName === "codemode") return primary;
	return [...primary, ...extraLines(result.content)];
}
