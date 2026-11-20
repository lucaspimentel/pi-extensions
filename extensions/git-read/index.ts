/**
 * git-read
 *
 * Read-only git access for agents: tool `git_read` runs an allowlisted set of
 * read-only git subcommands (diff, log, show, status) as an argv-array child
 * process, never through a shell.
 *
 * Argument validation lives in validate.ts; the bounded, sanitized spawn
 * layer lives in spawn.ts. This file only registers the tool and forwards
 * validated output to the spawn layer.
 *
 * Design: docs/git-read-design.md
 */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { normalizeInvocation, validateInvocation, type GitSubcommand } from "./validate.ts";
import { runGit } from "./spawn.ts";
import { expandedArgs, joinCallArgs, toolTitle } from "../shared/read-tool-call.ts";

const gitReadParams = Type.Object({
	subcommand: Type.Optional(
		Type.Union(
			[Type.Literal("diff"), Type.Literal("log"), Type.Literal("show"), Type.Literal("status")],
			{ description: "Read-only git subcommand to run. If omitted, args[0] must name the subcommand instead." },
		),
	),
	args: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Arguments after the subcommand: revs, flags, pathspecs. If subcommand is omitted, args[0] must be the subcommand (e.g. ['status', '--branch']). Validated before spawn.",
		}),
	),
});

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
	value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const asText = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

/**
 * The collapsed call line: the tool name, the operation, then its argv as the
 * command you would type. An invocation that omits `subcommand` and names it in
 * `args[0]` renders that command once, without repeating the operation. Nothing
 * is elided or capped: a long command wraps.
 */
function gitReadCallLine(args: unknown, theme: Theme): string {
	const title = toolTitle("git_read", theme);
	const record = asRecord(args);
	const argv = Array.isArray(record?.["args"])
		? (record["args"] as unknown[]).filter((arg): arg is string => typeof arg === "string")
		: [];
	const named = record === undefined ? undefined : asText(record["subcommand"]);
	const subcommand = named ?? argv[0];
	if (subcommand === undefined) return `${title} ${theme.fg("toolOutput", "...")}`;
	const command = joinCallArgs(named === undefined ? argv.slice(1) : argv);
	const operation = theme.fg("accent", subcommand);
	return command === "" ? `${title} ${operation}` : `${title} ${operation} ${theme.fg("toolOutput", command)}`;
}

/** Expanded: pi's fallback shape, listing every argument (Ctrl+O, `app.tools.expand`). */
function gitReadExpandedLine(args: unknown, theme: Theme): string {
	const title = toolTitle("git_read", theme);
	const body = expandedArgs(args, theme, ["subcommand"]);
	return body === undefined ? title : `${title}\n${body}`;
}

interface GitReadDetails {
	subcommand: GitSubcommand;
	/** The child's exit code, or null when no child ran (a rejection) or none exited (a failed gate, a spawn error, or a timeout). */
	exitCode: number | null;
	timedOut: boolean;
	/** True when the retained output hit the shared byte cap. Never a failure. */
	truncated: boolean;
	/** Prefix-free failure reason for compact result rows; absent on success, including a capped success. */
	failureReason?: string;
}

export default function gitReadExtension(pi: ExtensionAPI): void {
	pi.registerTool<typeof gitReadParams, GitReadDetails>({
		name: "git_read",
		label: "Git Read",
		description:
			"Run a read-only git command (diff, log, show, status) in the current repository. Only allowlisted flags are accepted; output is capped and the command never mutates the repo. Use it to inspect diffs, history, and working-tree state instead of asking the user to paste them.",
		promptSnippet: "Run read-only git commands (diff, log, show, status)",
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		promptGuidelines: [
			"Prefer git_read over asking the user to paste diffs or logs; it runs sandboxed read-only git in the session's cwd.",
			"Always pass the subcommand in its dedicated `subcommand` property (diff, log, show, or status); pass revs, flags, and pathspecs in args, e.g. subcommand 'diff' with args ['HEAD~1', '--', 'src/'].",
			"For a full commit SHA, use subcommand 'log' with args [\"-n\", \"1\", \"--format=%H\"] instead of parsing the default log output.",
		],
		parameters: gitReadParams,
		renderCall(args, theme, context) {
			const text = context?.expanded === true ? gitReadExpandedLine(args, theme) : gitReadCallLine(args, theme);
			return new Text(text, 0, 0);
		},
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const normalized = normalizeInvocation(params);
			if (!normalized.ok) {
				return {
					content: [{ type: "text", text: `git_read: ${normalized.reason}` }],
					details: {
						subcommand: (params.subcommand ?? "unknown") as GitSubcommand,
						exitCode: null,
						timedOut: false,
						truncated: false,
						failureReason: normalized.reason,
					},
					isError: true,
				};
			}
			const checked = validateInvocation(normalized.subcommand, normalized.args);
			if (!checked.ok) {
				return {
					content: [{ type: "text", text: `git_read: ${checked.reason}` }],
					details: {
						subcommand: normalized.subcommand,
						exitCode: null,
						timedOut: false,
						truncated: false,
						failureReason: checked.reason,
					},
					isError: true,
				};
			}
			const result = await runGit(checked.argv, ctx.cwd);
			return {
				content: [{ type: "text", text: result.text }],
				details: {
					subcommand: normalized.subcommand,
					exitCode: result.exitCode,
					timedOut: result.timedOut,
					truncated: result.truncated,
					...(result.failureReason !== undefined ? { failureReason: result.failureReason } : {}),
				},
				...(result.ok ? {} : { isError: true }),
			};
		},
	});
}
