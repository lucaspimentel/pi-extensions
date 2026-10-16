/**
 * gh-read
 *
 * Read-only GitHub CLI access for agents: tool `gh_read` runs an allowlisted
 * set of read-only gh subcommands (pr view/diff/list, issue view/list,
 * auth status) as an argv-array child process, never through a shell.
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
			Type.Literal("auth status"),
		],
		{ description: "Read-only gh subcommand to run." },
	),
	args: Type.Optional(
		Type.Array(Type.String(), {
			description: "Arguments after the subcommand: flags, values, a PR number or branch, or a hostname/jq expression for auth status. Validated before spawn.",
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
			"Run a read-only gh command (pr view, pr diff, pr list, issue view, issue list, auth status) for the current repository (or anywhere, for `auth status`). Only allowlisted flags are accepted; output is capped and the command never mutates anything. Use it to inspect PRs, review comments, and issues instead of asking the user to paste them, and auth status to check which GitHub account is active when API calls 403.",
		promptSnippet: "Run read-only gh commands (pr/issue view, list, pr diff, auth status)",
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		promptGuidelines: [
			"Prefer gh_read over asking the user to paste PR descriptions, review comments, or issue bodies; it runs allowlisted read-only gh in the session's repository.",
			"Pass flags and values in args, e.g. subcommand 'pr view' with args ['--comments'] or subcommand 'pr list' with args ['--state', 'open', '--limit', '20'].",
			"Use subcommand 'auth status' to check login state and which account is active per host, e.g. args ['--hostname', 'github.com'] or args ['--active']; it works outside a git worktree and its JSON output is fetched for you (--json hosts is appended automatically, and --show-token/--template are rejected).",
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
