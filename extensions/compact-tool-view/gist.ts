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
 * Failures always surface, ignoring gist/hide: `timed out` for a killed or
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
const failureGist = (result: GistResult): string | undefined => {
	if (!result.isError) return undefined;
	const details = asObject(result.details);
	if (details?.killed === true || details?.timedOut === true) return "timed out";
	const detailsExitCode = details?.exitCode;
	if (typeof detailsExitCode === "number" && detailsExitCode !== 0) return `exit ${detailsExitCode}`;
	const exitCode = asObject(result.structuredContent)?.exit_code;
	if (typeof exitCode === "number") return `exit ${exitCode}`;
	const text = firstText(result.content) ?? "";
	const exited = text.match(/Command exited with code (\d+)/);
	if (exited) return `exit ${exited[1]}`;
	const firstLine = text.split("\n")[0] ?? "";
	return `error: ${firstLine}`;
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

/** The typed gist for one tool, or undefined when the shape is not the expected one. */
const detailGist = (toolName: string, result: GistResult, args: unknown): string | undefined => {
	const details = asObject(result.details);
	switch (toolName) {
		case "gitlab_read": {
			// gitlab-read never sets isError, so a timeout or non-zero exit is only
			// visible here; details carries both. A success returns undefined and
			// falls through to the generic line count.
			if (details?.timedOut === true) return "timed out";
			const exitCode = details?.exitCode;
			if (typeof exitCode === "number" && exitCode !== 0) return `exit ${exitCode}`;
			return undefined;
		}
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
		case "memory_write": {
			// pi-memory's result text embeds a preview of the whole target file, so its
			// line count says nothing useful; the target and mode identify the write.
			const target = details?.target;
			if (target === "daily") return "daily log appended";
			if (target === "long_term") return details?.mode === "overwrite" ? "MEMORY.md overwritten" : "MEMORY.md appended";
			return undefined;
		}
		case "scratchpad": {
			// Successful mutations carry `action`; `list` carries only the counts, and
			// every failure path (no `text`, no match) carries neither.
			const action = details?.action;
			if (action === "add") return "item added";
			if (action === "done") return "item done";
			if (action === "undo") return "item reopened";
			if (action === "clear_done") {
				const removed = details?.removed;
				return typeof removed === "number" ? `cleared ${removed} done ${removed === 1 ? "item" : "items"}` : undefined;
			}
			const count = details?.count;
			const open = details?.open;
			if (typeof count === "number" && typeof open === "number") return `${open} open / ${count} items`;
			return asObject(args)?.action === "list" ? "empty" : undefined;
		}
		case "memory_read": {
			const target = asObject(args)?.target;
			if (target === "list") {
				const files = details?.files;
				return Array.isArray(files) ? `${files.length} daily logs` : "no daily logs";
			}
			// Only `daily` names a file the call row does not show (it defaults to
			// today); `long_term` and `scratchpad` already gist their line count.
			if (target !== "daily") return undefined;
			if (typeof details?.path !== "string") return "no log";
			const date = details.date;
			return typeof date === "string" ? `${date} log, ${lineCount(firstText(result.content))} lines` : undefined;
		}
		case "memory_forget": {
			const removed = details?.removed;
			if (typeof removed !== "number") return undefined;
			if (removed === 0) return "nothing removed";
			return `removed ${removed} ${removed === 1 ? "entry" : "entries"}`;
		}
		case "memory_restore": {
			const restored = details?.restored;
			if (typeof restored === "number" && restored > 0) return `restored ${restored} ${restored === 1 ? "entry" : "entries"}`;
			return typeof details?.restoredAt === "string" || restored === 0 ? "already restored" : undefined;
		}
		case "memory_search": {
			const count = details?.count;
			const mode = details?.mode;
			if (typeof count !== "number" || typeof mode !== "string") return undefined;
			const embed = details?.embedStarted ? ", embeddings started" : details?.needsEmbed ? ", embeddings missing" : "";
			return `${count} results (${mode})${embed}`;
		}
		case "memory_status": {
			if (typeof details?.qmd !== "boolean") return undefined;
			if (!details.qmd) return "qmd unavailable";
			const collection = details.collection === true ? "collection ok" : "collection missing";
			const embeddings = typeof details.embeddings === "string" ? details.embeddings : "unknown";
			return `qmd ok, ${collection}, embeddings ${embeddings}`;
		}
		case "pup_auth_status": {
			// The one flat pup payload: there is nothing to count, so it gets its own
			// line. Deliberately no expiry, countdown, scope count, or status_message
			// text (status_message embeds a live countdown), and no `refreshed` suffix:
			// the line already describes auth state.
			const parsed = asObject(details?.parsed);
			if (typeof parsed?.authenticated !== "boolean") return undefined;
			const site = typeof parsed.site === "string" && parsed.site !== "" ? ` (${parsed.site})` : "";
			return `${parsed.authenticated ? "authenticated" : "not authenticated"}${site}`;
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
			return `${count} ${spec.noun}${details?.refreshed === true ? ", auth refreshed" : ""}`;
		}
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
