/**
 * gh-read
 *
 * Read-only GitHub CLI access for agents: tool `gh_read` runs an allowlisted
 * set of read-only gh subcommands (pr view/diff/list, issue view/list) as an
 * argv-array child process, never through a shell.
 *
 * Argument validation lives in validate.ts; the bounded, sanitized spawn
 * layer lives in spawn.ts. This file only registers the tool and forwards
 * validated output to the spawn layer.
 *
 * Design: docs/gh-read-design.md
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { validateInvocation, type GhSubcommand } from "./validate.ts";
import { runGh } from "./spawn.ts";

const ghReadParams = Type.Object({
	subcommand: Type.Union(
		[
			Type.Literal("pr view"),
			Type.Literal("pr diff"),
			Type.Literal("pr list"),
			Type.Literal("issue view"),
			Type.Literal("issue list"),
		],
		{ description: "Read-only gh subcommand to run." },
	),
	args: Type.Optional(
		Type.Array(Type.String(), {
			description: "Arguments after the subcommand: flags, values, and a PR number or branch. Validated before spawn.",
		}),
	),
});

interface GhReadDetails {
	subcommand: GhSubcommand;
}

export default function ghReadExtension(pi: ExtensionAPI): void {
	pi.registerTool<typeof ghReadParams, GhReadDetails>({
		name: "gh_read",
		label: "GitHub Read",
		description:
			"Run a read-only gh command (pr view, pr diff, pr list, issue view, issue list) for the current repository. Only allowlisted flags are accepted; output is capped and the command never mutates anything. Use it to inspect PRs, review comments, and issues instead of asking the user to paste them.",
		promptSnippet: "Run read-only gh commands (pr/issue view, list, pr diff)",
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		promptGuidelines: [
			"Prefer gh_read over asking the user to paste PR descriptions, review comments, or issue bodies; it runs allowlisted read-only gh in the session's repository.",
			"Pass flags and values in args, e.g. subcommand 'pr view' with args ['--comments'] or subcommand 'pr list' with args ['--state', 'open', '--limit', '20'].",
		],
		parameters: ghReadParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const checked = validateInvocation(params.subcommand, params.args ?? []);
			if (!checked.ok) {
				return {
					content: [{ type: "text", text: `gh_read: ${checked.reason}` }],
					details: { subcommand: params.subcommand },
				};
			}
			const result = await runGh(checked.argv, ctx.cwd);
			return {
				content: [{ type: "text", text: result.text }],
				details: { subcommand: params.subcommand },
			};
		},
	});
}
