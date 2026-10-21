/**
 * gh-read
 *
 * Read-only GitHub access for agents: tool `gh_read` runs an allowlisted
 * set of read-only gh subcommands (pr view/diff/list/checks, issue
 * view/list, auth status, run list/view) as an argv-array child process,
 * never through a shell, plus five narrowly scoped GitHub API operations
 * (repo contents, repo tree, commit checks, advisory view, check
 * annotations, repo metadata) with tool-authored, encoded requests against
 * github.com only.
 *
 * Argument validation lives in validate.ts; the bounded, sanitized spawn
 * layer for native commands lives in spawn.ts; log-carrying invocations
 * (run view --log/--log-failed) are routed by the structured logMode state
 * to the dual-window runner in log-spawn.ts; the dedicated API runner,
 * jq filtering, and operation orchestration live in api-spawn.ts, jq.ts,
 * and api.ts. This file only registers the tool and forwards validated
 * input to the right layer.
 *
 * Design: docs/gh-read-design.md
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	type ValidApiInvocation,
	validateToolParams,
	type GhSubcommand,
} from "./validate.ts";
import { runGh } from "./spawn.ts";
import { runGhLog } from "./log-spawn.ts";
import { runApiOperation } from "./api.ts";

const SUBCOMMAND_SCHEMAS = [
	Type.Literal("pr view"),
	Type.Literal("pr diff"),
	Type.Literal("pr list"),
	Type.Literal("pr checks"),
	Type.Literal("issue view"),
	Type.Literal("issue list"),
	Type.Literal("auth status"),
	Type.Literal("run list"),
	Type.Literal("run view"),
	Type.Literal("repo contents"),
	Type.Literal("repo tree"),
	Type.Literal("commit checks"),
	Type.Literal("advisory view"),
	Type.Literal("check annotations"),
	Type.Literal("repo metadata"),
] as const;

const ghReadParams = Type.Object({
	subcommand: Type.Union([...SUBCOMMAND_SCHEMAS], {
		description: "Read-only gh subcommand or narrowly scoped GitHub API operation.",
	}),
	args: Type.Optional(
		Type.Array(Type.String(), {
			description: "Arguments after a native subcommand: flags, values, a PR number or branch, or a hostname/jq expression for auth status. Validated before spawn. Never used with API operations.",
		}),
	),
	repo: Type.Optional(
		Type.String({ description: "API operations: exact OWNER/REPO on github.com, e.g. 'DataDog/dd-trace-dotnet'. No host prefix." }),
	),
	path: Type.Optional(
		Type.String({ description: "repo contents/tree: repository-relative path. Empty string selects the repository root." }),
	),
	ref: Type.Optional(
		Type.String({ description: "Branch, tag, or SHA. Omitted resolves the repository default branch, which is then pinned to a full commit SHA." }),
	),
	start_line: Type.Optional(
		Type.Number({ description: "repo contents text files: first 1-based line of the inclusive range." }),
	),
	end_line: Type.Optional(
		Type.Number({ description: "repo contents text files: last 1-based line of the inclusive range; omitted means end of file; end alone means 1..end." }),
	),
	recursive: Type.Optional(
		Type.Boolean({ description: "repo tree: recurse (default true). False performs a shallow read without the recursive query parameter." }),
	),
	jq: Type.Optional(
		Type.String({ description: "External jq filter applied once to JSON data (directory listings, trees, combined checks, advisory results). Never applied to file text or tool metadata. Module imports are rejected; jq must be installed." }),
	),
	continuation: Type.Optional(
		Type.String({ description: "Opaque continuation token from a previous incomplete commit-checks or CVE result. Pass it back unchanged with the same repo/ref or id." }),
	),
	id: Type.Optional(
		Type.String({ description: "advisory view: exact advisory identifier, CVE-YYYY-NNNN or GHSA-xxxx-xxxx-xxxx." }),
	),
	type: Type.Optional(
		Type.String({ description: "advisory view (CVE only): reviewed (default), unreviewed, or malware." }),
	),
	check_run_id: Type.Optional(
		Type.Number({ description: "check annotations: the check run id whose annotations are fetched; a safe integer >= 1. Never used with native subcommands." }),
	),
});

interface GhReadDetails {
	subcommand: string;
	[key: string]: unknown;
}

const NATIVE_DESCRIPTION =
	"Run a read-only gh command (pr view, pr diff, pr list, pr checks, issue view, issue list, auth status, run list, run view) for the current repository (or anywhere, for `auth status`), or a narrowly scoped GitHub API operation: 'repo contents' (decoded file text or directory entries at a pinned ref), 'repo tree' (recursive or shallow tree), 'commit checks' (check runs plus legacy statuses for a commit), 'advisory view' (exact CVE/GHSA lookup), or 'check annotations' (annotations of one check run), or 'repo metadata' (default branch, description, visibility, URLs, and other flat repository facts). Native commands take flags in args; API operations take structured fields (repo, path, ref, jq, ...) and work outside a git worktree. Only allowlisted flags and fields are accepted; output is capped and nothing mutates.";

export default function ghReadExtension(pi: ExtensionAPI): void {
	pi.registerTool<typeof ghReadParams, GhReadDetails>({
		name: "gh_read",
		label: "GitHub Read",
		description: NATIVE_DESCRIPTION,
		promptSnippet:
			"Run read-only gh commands (pr/issue view, list, pr diff, pr checks, auth status, GitHub Actions run list/view with bounded log output) and pinned GitHub API reads (repo contents/tree, commit checks, advisories, check annotations, repo metadata)",
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		promptGuidelines: [
			"Prefer gh_read over asking the user to paste PR descriptions, review comments, or issue bodies; it runs allowlisted read-only gh in the session's repository.",
			"Pass flags and values in args, e.g. subcommand 'pr view' with args ['--comments'] or subcommand 'pr list' with args ['--state', 'open', '--limit', '20'].",
			"Use subcommand 'pr checks' for PR check status: it always returns JSON (fields like name, state, bucket are appended automatically), so failed/pending checks still come back as data. 'pr checks' with -R/--repo also needs a PR number or branch selector.",
			"Use subcommand 'auth status' to check login state and which account is active per host, e.g. args ['--hostname', 'github.com'] or args ['--active']; it works outside a git worktree and its JSON output is fetched for you (--json hosts is appended automatically, and --show-token/--template are rejected).",
			"Use API operations for pinned, cross-repository reads outside a worktree: 'repo contents' needs repo + path (empty path = root; optional ref, line range, jq); 'repo tree' needs repo (optional ref, subtree path, recursive); 'commit checks' needs repo + ref and returns check runs plus legacy statuses with bounded continuation for more pages; 'advisory view' needs an exact id (CVE-... or GHSA-...).",
			"Run triage: use 'run list' with -b/--branch, -c/--commit, -s/--status, or --limit to find runs; 'run view' requires a numeric run id (interactive selection is unsupported); use --log-failed for failed-step logs or -j <job id> --log for one job's logs. Log output is bounded to the first and last 50 KiB; the middle is omitted and noted.",
			"Annotations: 'check annotations' needs repo + check_run_id; a single page of at most 100 annotations is fetched, and results may be incomplete at exactly 100 items.",
			"Repository facts: 'repo metadata' needs only repo and returns the flat REST repository object (default branch, description, visibility, dates, URLs, license, language, archived/fork/template flags, topics, counts, and the authenticated token's permissions) as one unpaged request; narrow with jq, e.g. .default_branch.",
			"API operations report a resolved commit SHA and source completeness; pass the returned continuation token back with the same repo/ref (or id) to fetch remaining pages.",
		],
		parameters: ghReadParams,
		async execute(_id, params, signal, _onUpdate, ctx) {
			const checked = validateToolParams(params);
			if (!checked.ok) {
				return {
					content: [{ type: "text", text: checked.reason }],
					details: { subcommand: typeof params.subcommand === "string" ? params.subcommand : "unknown" },
					isError: true,
				};
			}
			if (checked.kind === "api") {
				const api = checked.api as ValidApiInvocation;
				const result = await runApiOperation(api, ctx.cwd, signal);
				return { ...result, details: { subcommand: api.op, ...result.details } };
			}
			const result = checked.logMode
				? await runGhLog(checked.argv, ctx.cwd, signal)
				: await runGh(checked.argv, ctx.cwd);
			return {
				content: [{ type: "text", text: result.text }],
				details: { subcommand: checked.subcommand },
			};
		},
	});
}
