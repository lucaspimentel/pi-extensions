/**
 * Pure panel helpers: judge input assembly, per-call tool summaries, and the
 * shared output truncation used by both the panel judge input and the legacy
 * parallel renderer.
 *
 * No I/O, no console, no Ambient state: every export takes values and returns
 * strings or numbers, so tests import this module directly with no fake pi.
 */

import type { Message } from "@earendil-works/pi-ai";

/** Per-answer byte cap, shared with the legacy parallel output truncation. */
export const PER_TASK_OUTPUT_CAP = 50 * 1024;

/** Distinct tool-call entries rendered in a summary before `(+N more)`. */
export const TOOL_SUMMARY_ENTRY_CAP = 20;

/** Displayed-character cap for one tool-call argument. */
export const TOOL_SUMMARY_ARGUMENT_CAP = 80;

/** One panelist's contribution to the judge input. */
export interface PanelReviewInput {
	model: string;
	task: string;
	toolCallSummary: string;
	status: "completed" | "failed";
	output: string;
	error?: string;
}

/** Fallback count of unknown-tool arguments included in a summary entry. */
const FALLBACK_ARGUMENT_LIMIT = 4;

/**
 * Fields that identify a call for the known tools. Aliases are listed in
 * preference order and only non-empty values are kept, so a call that passes
 * `file_path` and one that passes `path` both render a path.
 */
const KNOWN_TOOL_FIELDS: Record<string, string[]> = {
	read: ["file_path", "path"],
	write: ["file_path", "path"],
	edit: ["file_path", "path"],
	ls: ["path"],
	ffgrep: ["pattern", "path", "glob"],
	grep: ["pattern", "path", "glob"],
	fffind: ["pattern", "path"],
	find: ["pattern", "path"],
	bash: ["command"],
	git_read: ["subcommand", "rev", "ref", "path", "args"],
	gh_read: ["subcommand", "repo", "pr", "issue", "ref", "path", "branch", "slug", "jq", "args"],
};

/** Collapse every whitespace run so summaries stay on one line and byte-stable. */
function canonicalize(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function primitiveArgument(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	// Git and GitHub operation arguments arrive as arrays (`args: ["HEAD~1",
	// "--", "src/"]`), and they carry what the call actually inspected. They have
	// to reach the grouping key, or two calls that differ only in their arguments
	// collapse into one entry and the judge cannot tell them apart.
	if (Array.isArray(value)) {
		const parts = value.map(primitiveArgument).filter((part): part is string => part !== undefined);
		return parts.length > 0 ? parts.join(" ") : undefined;
	}
	return undefined;
}

/**
 * The untruncated values that identify one tool call. Known tools select the
 * fields that carry the read target or operation; unknown tools fall back to a
 * deterministic first-few scalar arguments so two different calls never
 * collapse through presentation truncation.
 */
function describeToolCall(name: string, args: Record<string, unknown>): string[] {
	const fields = KNOWN_TOOL_FIELDS[name];
	if (fields) {
		const values: string[] = [];
		for (const field of fields) {
			const value = primitiveArgument(args[field]);
			if (value !== undefined && value.trim() !== "") values.push(value);
		}
		return values;
	}
	return Object.keys(args)
		.sort()
		.flatMap((key) => {
			const value = primitiveArgument(args[key]);
			return value === undefined ? [] : [`${key}=${value}`];
		})
		.slice(0, FALLBACK_ARGUMENT_LIMIT);
}

function renderToolCallDisplay(name: string, values: string[]): string {
	if (values.length === 0) return name;
	const shown = values.map((value) => {
		const text = canonicalize(value);
		return text.length > TOOL_SUMMARY_ARGUMENT_CAP ? `${text.slice(0, TOOL_SUMMARY_ARGUMENT_CAP)}...` : text;
	});
	return `${name} ${shown.join(" ")}`;
}

/**
 * Bounded, one-line summary of the tools an agent actually called: distinct
 * `name <arguments>` entries in first-use order, repetitions collapsed with a
 * count, failures shown only when a correlated tool result reported `isError`.
 * Never includes tool-result bodies or transcripts.
 */
export function buildToolCallSummary(messages: readonly Message[]): string {
	const failedByCall = new Map<string, boolean>();
	for (const message of messages) {
		if (message.role === "toolResult") failedByCall.set(message.toolCallId, message.isError === true);
	}

	const groups = new Map<string, { display: string; count: number; failed: number }>();
	const order: string[] = [];
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const part of message.content) {
			if (part.type !== "toolCall") continue;
			const args = (part.arguments ?? {}) as Record<string, unknown>;
			const values = describeToolCall(part.name, args);
			const key = JSON.stringify([part.name, values.map(canonicalize)]);
			let group = groups.get(key);
			if (!group) {
				group = { display: renderToolCallDisplay(part.name, values), count: 0, failed: 0 };
				groups.set(key, group);
				order.push(key);
			}
			group.count++;
			if (failedByCall.get(part.id) === true) group.failed++;
		}
	}

	if (order.length === 0) return "(none)";
	const shown = order.slice(0, TOOL_SUMMARY_ENTRY_CAP).map((key) => {
		const group = groups.get(key)!;
		let text = group.count > 1 ? `${group.display} x${group.count}` : group.display;
		if (group.failed > 0) text += ` (${group.failed} failed)`;
		return text;
	});
	const remaining = order.length - shown.length;
	return `${shown.join(", ")}${remaining > 0 ? ` (+${remaining} more)` : ""}`;
}

/**
 * Cap a final answer at `PER_TASK_OUTPUT_CAP` UTF-8 bytes, iterating whole code
 * points so a multi-byte character is never split, and annotate the omission
 * exactly as the legacy parallel renderer does.
 */
export function truncateTaskOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

	let kept = "";
	let keptBytes = 0;
	for (const character of output) {
		const size = Buffer.byteLength(character, "utf8");
		if (keptBytes + size > PER_TASK_OUTPUT_CAP) break;
		kept += character;
		keptBytes += size;
	}
	return `${kept}\n\n[Output truncated: ${byteLength - keptBytes} bytes omitted. Full output preserved in tool details.]`;
}

/**
 * One judge-input block: the settled `PANELIST` header, the repeated task, the
 * tool-call summary, the status, and the capped answer. Failed blocks keep the
 * error and label the (possibly empty) partial text as incomplete.
 */
export function buildPanelistBlock(review: PanelReviewInput): string {
	const lines = [
		`### PANELIST ${review.model}`,
		`task: ${review.task}`,
		`tools: ${review.toolCallSummary}`,
		`status: ${review.status}`,
	];
	if (review.status === "failed") {
		lines.push(`error: ${review.error ?? "(no error reported)"}`);
		lines.push("[Incomplete partial answer:]", truncateTaskOutput(review.output));
	} else {
		lines.push("", truncateTaskOutput(review.output));
	}
	return lines.join("\n");
}

/**
 * The exact judge prompt: the panelist blocks in the supplied (effective
 * configured) order, with no preamble, no re-stated output format, and no
 * aggregate ceiling. Only each answer is capped.
 */
export function buildPanelJudgeInput(reviews: readonly PanelReviewInput[]): string {
	return reviews.map(buildPanelistBlock).join("\n\n");
}
