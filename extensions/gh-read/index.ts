/**
 * gh-read
 *
 * Read-only GitHub access for agents: tool `gh_read` runs an allowlisted
 * set of read-only gh subcommands (pr view/diff/list/checks, issue
 * view/list, auth status, run list/view) as an argv-array child process,
 * never through a shell, plus narrowly scoped GitHub API operations
 * (repo contents, repo tree, commit checks, advisory view, check
 * annotations, repo metadata, pr comments, pr reviews, issue comments,
 * issue timeline, pr threads, org team, pr batch) with tool-authored, encoded
 * requests against github.com only.
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

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	type ValidApiInvocation,
	validateToolParams,
	type GhSubcommand,
} from "./validate.ts";
import { runGh } from "./spawn.ts";
import { runGhLog } from "./log-spawn.ts";
import { runApiOperation } from "./api.ts";
import { expandedArgs, joinCallArgs, toolTitle } from "../shared/read-tool-call.ts";

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
	Type.Literal("pr comments"),
	Type.Literal("pr reviews"),
	Type.Literal("issue comments"),
	Type.Literal("issue timeline"),
	Type.Literal("pr threads"),
	Type.Literal("org team"),
	Type.Literal("pr batch"),
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
	org: Type.Optional(
		Type.String({ description: "org team: the bare organization login, e.g. 'DataDog'. Never used with native subcommands." }),
	),
	slug: Type.Optional(
		Type.String({ description: "org team: the bare team slug with no leading '@' and no embedded '/', e.g. 'serverless-azure-and-gcp'. Never used with native subcommands." }),
	),
	pr: Type.Optional(
		Type.Number({ description: "pr comments/pr reviews/pr threads: required pull request number, a safe integer >= 1. Never used with native subcommands or 'issue comments'; branches, strings, and URLs are not accepted." }),
	),
	issue: Type.Optional(
		Type.Number({ description: "issue comments/issue timeline: required issue number, a safe integer >= 1. Never used with native subcommands or the PR operations; branches, strings, and URLs are not accepted. For issue comments this is conversation comments only; PR inline review comments/replies need 'pr comments'. For issue timeline a PR number reads that PR's timeline through the same issue field." }),
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
		Type.String({ description: "External jq filter applied once to JSON data (directory listings, trees, combined checks, advisory results, PR comment/review arrays, issue conversation-comment arrays, issue timeline event arrays, GraphQL review-thread nodes, organization team objects). Never applied to file text or tool metadata. Module imports are rejected; jq must be installed." }),
	),
	continuation: Type.Optional(
		Type.String({ description: "Opaque continuation token from a previous incomplete commit-checks, CVE, PR comments/reviews/threads, issue-comments, or issue-timeline result. Pass it back unchanged with the same subcommand and repo/ref, id/type, repo/pr, or repo/issue. PR comments, PR reviews, issue comments, issue timeline, and pr threads each page independently; 'pr threads' is bound to its repo + pr and pages by cursor." }),
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
	targets: Type.Optional(
		Type.Array(Type.String(), { description: "pr batch: 1 to 15 targets, each exactly OWNER/REPO#N. Full repo required; no bare numbers, PR URLs, or host prefixes. Duplicates are rejected." }),
	),
	fields: Type.Optional(
		Type.Array(Type.String(), { description: "pr batch: gh --json field names applied to every target; omitted uses a default scalar set. projectCards, projectItems, and reactionGroups are rejected." }),
	),
	account: Type.Optional(
		Type.String({ description: "pr batch: optional gh account login. Omitted uses the ambient active account with no pre-check; a named account is validated and its token is injected into the child environment, never into output." }),
	),
});

interface GhReadDetails {
	subcommand: string;
	[key: string]: unknown;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
	value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const asText = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

const asNumber = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) ? value : undefined;

function asStringList(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/**
 * `@ref`, `[account]`, then the narrowing markers, in that fixed order, all
 * muted: a one-sided range as `:12-` or `:1-40`, `(narrowed)` for a jq filter,
 * and `(continuation)` for a paged follow-up. Each kind appears at most once
 * and none carries the raw value (a jq expression or continuation token would
 * swamp the row).
 */
function narrowedTags(record: Record<string, unknown> | undefined, theme: Theme): string[] {
	if (record === undefined) return [];
	const muted = (text: string): string => theme.fg("muted", text);
	const tags: string[] = [];
	const ref = asText(record["ref"]);
	if (ref !== undefined) tags.push(muted(`@${ref}`));
	const account = asText(record["account"]);
	if (account !== undefined) tags.push(muted(`[${account}]`));
	const start = asNumber(record["start_line"]);
	const end = asNumber(record["end_line"]);
	if (start !== undefined && end !== undefined) tags.push(muted(`:${start}-${end}`));
	else if (start !== undefined) tags.push(muted(`:${start}-`));
	else if (end !== undefined) tags.push(muted(`:1-${end}`));
	if (asText(record["jq"]) !== undefined) tags.push(muted("(narrowed)"));
	if (asText(record["continuation"]) !== undefined) tags.push(muted("(continuation)"));
	return tags;
}

/**
 * The collapsed call line: the operation, the arguments that identify the call
 * in the short form the call itself used, then the tags that say how it was
 * narrowed. Only identifying values appear; the switches that do not change
 * what you are looking at (`recursive`, `fields`, `type`) and the values that
 * would swamp the row (a jq expression, a continuation token) stay
 * expanded-only. Nothing is elided or capped: a long row wraps, and a primary
 * piece that has not streamed in yet shows `...`.
 */
function ghReadCallLine(args: unknown, theme: Theme): string {
	const title = toolTitle("gh_read", theme);
	const record = asRecord(args);
	const subcommand = record === undefined ? undefined : asText(record["subcommand"]);
	if (subcommand === undefined) return `${title} ${theme.fg("toolOutput", "...")}`;
	const value = (text: string): string => theme.fg("toolOutput", text);
	const parts: string[] = [];
	let missingTarget = false;
	switch (subcommand) {
		case "repo contents":
		case "repo tree": {
			const repo = asText(record?.["repo"]);
			if (repo === undefined) missingTarget = true;
			else parts.push(value(repo));
			const subpath = asText(record?.["path"]);
			if (subpath !== undefined) parts.push(value(subpath));
			break;
		}
		case "commit checks":
		case "repo metadata": {
			const repo = asText(record?.["repo"]);
			if (repo === undefined) missingTarget = true;
			else parts.push(value(repo));
			break;
		}
		case "check annotations": {
			const repo = asText(record?.["repo"]);
			const runId = asNumber(record?.["check_run_id"]);
			if (repo !== undefined && runId !== undefined) parts.push(value(`${repo} ${runId}`));
			else {
				if (repo !== undefined) parts.push(value(repo));
				missingTarget = true;
			}
			break;
		}
		case "advisory view": {
			const id = asText(record?.["id"]);
			if (id === undefined) missingTarget = true;
			else parts.push(value(id));
			break;
		}
		case "org team": {
			const org = asText(record?.["org"]);
			const slug = asText(record?.["slug"]);
			if (org !== undefined && slug !== undefined) parts.push(value(`${org} ${slug}`));
			else {
				if (org !== undefined) parts.push(value(org));
				missingTarget = true;
			}
			break;
		}
		case "pr comments":
		case "pr reviews":
		case "pr threads": {
			const repo = asText(record?.["repo"]);
			const pr = asNumber(record?.["pr"]);
			if (repo !== undefined && pr !== undefined) parts.push(value(`${repo}#${pr}`));
			else {
				if (repo !== undefined) parts.push(value(repo));
				missingTarget = true;
			}
			break;
		}
		case "issue comments":
		case "issue timeline": {
			const repo = asText(record?.["repo"]);
			const issue = asNumber(record?.["issue"]);
			if (repo !== undefined && issue !== undefined) parts.push(value(`${repo}#${issue}`));
			else {
				if (repo !== undefined) parts.push(value(repo));
				missingTarget = true;
			}
			break;
		}
		case "pr batch": {
			const targets = asStringList(record?.["targets"]);
			if (targets.length === 0) missingTarget = true;
			else parts.push(value(`(${targets.length} PRs)`));
			break;
		}
		default: {
			// A native subcommand carries its argv, as the command you would type.
			const command = joinCallArgs(asStringList(record?.["args"]));
			if (command !== "") parts.push(value(command));
		}
	}
	if (missingTarget) parts.push(value("..."));
	const body = [...parts, ...narrowedTags(record, theme)].join(" ");
	const operation = theme.fg("accent", subcommand);
	return body === "" ? `${title} ${operation}` : `${title} ${operation} ${body}`;
}

/** Expanded: pi's fallback shape, listing every argument (Ctrl+O, `app.tools.expand`). */
function ghReadExpandedLine(args: unknown, theme: Theme): string {
	const title = toolTitle("gh_read", theme);
	const body = expandedArgs(args, theme);
	return body === undefined ? title : `${title}\n${body}`;
}

const NATIVE_DESCRIPTION =
	"Run a read-only gh command (pr view, pr diff, pr list, pr checks, issue view, issue list, auth status, run list, run view) for the current repository (or anywhere, for `auth status`), or a narrowly scoped GitHub API operation: 'repo contents' (decoded file text or directory entries at a pinned ref), 'repo tree' (recursive or shallow tree), 'commit checks' (check runs plus legacy statuses for a commit), 'advisory view' (exact CVE/GHSA lookup), or 'check annotations' (annotations of one check run), or 'repo metadata' (default branch, description, visibility, URLs, and other flat repository facts), or 'pr comments' (inline review comments and replies), or 'pr reviews' (review bodies and verdicts), or 'issue comments' (conversation comments on an issue or PR), or 'issue timeline' (conversation-adjacent events for an issue or PR; a PR number reads that PR's timeline through the same issue field), or 'pr threads' (GraphQL review threads, resolved and outdated included), or 'org team' (one organization team object by bare org login and team slug, a single unpaged object). 'pr comments', 'pr reviews', and 'issue comments' require repo plus a positive safe-integer pr (or issue) number and return verbatim REST arrays with independent bounded continuation paging but no resolved/outdated thread state; 'issue timeline' requires repo plus a positive safe-integer issue number (a PR number reads that PR's timeline) and returns the verbatim event array with bounded continuation paging, narrowable with jq, e.g. [.[] | select(.event == \"reviewed\" or .event == \"commented\") | {event, actor: (.actor.login // .user.login), at: .created_at, body}]; 'pr threads' requires repo plus a positive safe-integer pr number and returns the GraphQL reviewThreads nodes with that state and bounded cursor continuation; 'org team' requires a bare org login plus a team slug and returns one organization team object, or 'pr batch' (up to 15 pull requests across repositories named as OWNER/REPO#N targets in one call, one envelope per target, with optional fields, account, and jq). All accept optional jq. Native commands take flags in args; API operations take structured fields (repo, path, ref, jq, ...) and work outside a git worktree. Only allowlisted flags and fields are accepted; output is capped and nothing mutates.";

export default function ghReadExtension(pi: ExtensionAPI): void {
	/**
	 * The model-facing text carries a `gh_read: ` prefix; `details.failureReason`
	 * is shown bare in a compact result row, whose own title already names the
	 * tool. The text itself is untouched.
	 */
	const bareFailureReason = (text: string): string => (text.split("\n")[0] ?? "").replace(/^gh_read: /, "");

	pi.registerTool<typeof ghReadParams, GhReadDetails>({
		name: "gh_read",
		label: "GitHub Read",
		description: NATIVE_DESCRIPTION,
		promptSnippet:
			"Run read-only gh commands (pr/issue view, list, pr diff, pr checks, auth status, GitHub Actions run list/view with bounded log output) and scoped GitHub API reads (repo contents/tree, commit checks, advisories, check annotations, repo metadata, pr comments/reviews, issue comments, issue timeline, pr threads, org team, pr batch)",
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		promptGuidelines: [
			"Prefer gh_read over asking the user to paste PR descriptions, review comments, or issue bodies; native commands run in the session's repository, while scoped API operations name an explicit target and work outside a worktree.",
			"A clipped API result states `output_truncated: true` in its metadata head, and its data block is then an incomplete UTF-8-safe prefix, not the payload: re-run narrowed (jq filter, line range, subtree path, shallower recursion) rather than trusting the block. A complete result states `output_truncated: false`.",
			"Pass flags and values in args, e.g. subcommand 'pr view' with args ['--comments'] or subcommand 'pr list' with args ['--state', 'open', '--limit', '20'].",
			"Use subcommand 'pr checks' for PR check status: it always returns JSON (fields like name, state, bucket are appended automatically), so failed/pending checks still come back as data. 'pr checks' with -R/--repo also needs a PR number or branch selector.",
			"Use subcommand 'auth status' to check login state and which account is active per host, e.g. args ['--hostname', 'github.com'] or args ['--active']; it works outside a git worktree and its JSON output is fetched for you (--json hosts is appended automatically, and --show-token/--template are rejected). To learn the active login, use this instead of shelling out to raw `gh api user --jq .login`; it needs no repo and no worktree.",
			"Use API operations for explicit-target, cross-repository reads outside a worktree: 'repo contents' needs repo + path (empty path = root; optional ref, line range, jq); 'repo tree' needs repo (optional ref, subtree path, recursive); 'commit checks' needs repo + ref and returns check runs plus legacy statuses with bounded continuation for more pages; 'advisory view' needs an exact id (CVE-... or GHSA-...). Do not shell out to raw `gh api` for shapes these operations already cover; name the operation instead: `pulls/{n}/reviews` is 'pr reviews', `pulls/{n}/comments` is 'pr comments', `issues/{n}/comments` is 'issue comments', `issues/{n}/timeline` is 'issue timeline', `git/trees/HEAD` is 'repo tree', `orgs/{org}/teams/{slug}` is 'org team', the default branch is 'repo metadata', and the tool-authored GraphQL review-thread read (resolved/outdated state) is 'pr threads'.",
			"Run triage: use 'run list' with -b/--branch, -c/--commit, -s/--status, or --limit to find runs; 'run view' requires a numeric run id (interactive selection is unsupported); use --log-failed for failed-step logs or -j <job id> --log for one job's logs. Log output is bounded to the first and last 50 KiB; the middle is omitted and noted.",
			"Annotations: 'check annotations' needs repo + check_run_id; a single page of at most 100 annotations is fetched, and results may be incomplete at exactly 100 items.",
			"Repository facts: 'repo metadata' needs only repo and returns the flat REST repository object (default branch, description, visibility, dates, URLs, license, language, archived/fork/template flags, topics, counts, and the authenticated token's permissions) as one unpaged request; narrow with jq, e.g. .default_branch.",
			"PR discussions: 'pr view --comments' is for conversation comments, not inline review discussions. Use API operation 'pr comments' with repo + pr (positive safe-integer PR number, not a branch or URL) for the verbatim inline review-comment array, including replies linked by in_reply_to_id; use 'pr reviews' with the same fields for the verbatim review bodies/verdicts array. Both accept optional jq and continuation. Comment line fields do not imply resolution; do not derive it. Use 'pr threads' for the GraphQL resolved/outdated review-thread state.",
			"PR comments, reviews, and threads page independently ('pr comments', 'pr reviews', 'pr threads'): return each continuation unchanged with the same subcommand + repo + pr. Each call returns only its newly fetched batch; jq applies once to that array. These are mutable, non-transactional listings, not SHA-pinned snapshots; do not infer a complete thread history or current approval verdict from a partial result.",
			"Issue conversation comments: use API operation 'issue comments' with repo + issue (positive safe-integer issue number, not a branch or URL). For both issues and PRs this returns the conversation-comment array from repos/{owner}/{repo}/issues/{issue}/comments, not the inline review comments/replies that 'pr comments' returns. It accepts optional jq and continuation; return the continuation unchanged with the same subcommand + repo + issue. Each call returns only its newly fetched batch; the listing is mutable and offset-paged, so it may miss or duplicate items, and completion describes the observed traversal, not a historical snapshot. Never emits pr or review-thread state. For timeline events on the same issue or PR number, use 'issue timeline', which reads repos/{owner}/{repo}/issues/{issue}/timeline.",
			"PR, issue, and thread reads page independently: return each continuation unchanged with the same subcommand + repo + pr (the PR operations, including 'pr threads') or repo + issue (issue comments, issue timeline); a token from one target or operation is rejected by another. API operations report target and source completeness; repo contents/tree and commit checks also report a resolved commit SHA. Pass continuation back with the same subcommand and repo/ref (commit checks), id/type (CVE), repo/pr (PR comments/reviews/threads), or repo/issue (issue comments, issue timeline) to fetch remaining pages.",
			"Shapes with no dedicated operation; do not fall back to raw `gh api`. Changed-file list: use subcommand 'pr diff' with args ['--name-only', '<pr number>'] (add '-R', 'OWNER/REPO' outside the worktree), or 'pr view' with args ['--json', 'files,changedFiles', '<pr number>'] when you need per-file additions/deletions or change type; compare the length of files with changedFiles to detect a truncated list. One review's own comments: 'pr comments' with jq '.[] | select(.pull_request_review_id == <review id>)'; jq applies to each fetched batch, so an empty filtered batch proves nothing until source_complete is true. Review bodies are separate: use 'pr reviews' for those. A comment by id: take the PR or issue number from the comment's html_url (review comments also expose pull_request_url) and run 'pr comments' (or 'issue comments') on that number with jq '.[] | select(.id == <comment id>)'. The REST comment reads ('pr comments', 'pr reviews', 'issue comments') provide no resolved/outdated thread state; use 'pr threads' for that and never derive it from comment line fields.",
			"gh_read never writes. Posting review replies or comments, resolving threads, and submitting reviews require the host shell (host_bash); the sandboxed bash tool has no network or gh credentials. Guard may prompt before running host_bash commands, so state the exact command and target.",
			"Multi-endpoint GitHub collection or aggregation: fan out over the gh_read API operations from a codemode script, e.g. Promise.allSettled over tools.gh_read(...) calls, instead of building `gh api ... --paginate | jq ...` pipelines in host_bash; each call keeps its own bounded paging, caps, completeness metadata, and continuation.",
			"Reading several pull requests across repositories: use subcommand 'pr batch' with targets such as ['owner/repo#123', 'other/repo#45'] instead of a `for` loop over `gh pr view` in host_bash, because any loop, conditional, or block is treated as one command that always prompts. It returns one envelope per target in input order, defaults to a compact scalar field set, and accepts an optional account for a secondary GitHub login.",
		],
		parameters: ghReadParams,
		renderCall(args, theme, context) {
			const text = context?.expanded === true ? ghReadExpandedLine(args, theme) : ghReadCallLine(args, theme);
			return new Text(text, 0, 0);
		},
		async execute(_id, params, signal, _onUpdate, ctx) {
			const checked = validateToolParams(params);
			if (!checked.ok) {
				return {
					content: [{ type: "text", text: checked.reason }],
					details: {
						subcommand: typeof params.subcommand === "string" ? params.subcommand : "unknown",
						failureReason: bareFailureReason(checked.reason),
					},
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
				details: {
					subcommand: checked.subcommand,
					exitCode: result.exitCode,
					timedOut: result.timedOut,
					...(result.ok ? {} : { failureReason: bareFailureReason(result.text) }),
				},
				...(result.ok ? {} : { isError: true }),
			};
		},
	});
}
