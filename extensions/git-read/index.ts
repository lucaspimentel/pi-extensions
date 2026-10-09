/**
 * git-read
 *
 * Read-only git access for agents: tool `git_read` runs an allowlisted set of
 * read-only git subcommands (diff, log, show, status) as an argv-array child
 * process, never through a shell.
 *
 * Scaffold (step 1): registration and wiring only. Argument validation
 * (validate.ts) and the bounded spawn layer (spawn.ts) are stubs that return
 * explicit errors; later steps fill them in without touching this file.
 *
 * Design: docs/git-read-design.md
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { validateInvocation, type GitSubcommand } from "./validate.ts";
import { runGit } from "./spawn.ts";

const gitReadParams = Type.Object({
	subcommand: Type.Union(
		[Type.Literal("diff"), Type.Literal("log"), Type.Literal("show"), Type.Literal("status")],
		{ description: "Read-only git subcommand to run." },
	),
	args: Type.Optional(
		Type.Array(Type.String(), {
			description: "Arguments after the subcommand: revs, flags, pathspecs. Validated before spawn.",
		}),
	),
});

interface GitReadDetails {
	subcommand: GitSubcommand;
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
			"Pass revs, flags, and pathspecs in args, e.g. subcommand 'diff' with args ['HEAD~1', '--', 'src/'].",
		],
		parameters: gitReadParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const checked = validateInvocation(params.subcommand, params.args ?? []);
			if (!checked.ok) {
				return {
					content: [{ type: "text", text: `git_read: ${checked.reason}` }],
					details: { subcommand: params.subcommand },
				};
			}
			const result = await runGit(checked.argv, ctx.cwd);
			return {
				content: [{ type: "text", text: result.text }],
				details: { subcommand: params.subcommand },
			};
		},
	});
}
