/**
 * gh-read argument validation.
 *
 * Implements the "Invocation contract" and "Allowlists" sections of
 * docs/gh-read-design.md: a flat native subcommand union, per-subcommand
 * flag allowlists, value validators, and final argv construction, plus
 * structured validation for the narrowly scoped GitHub API operations
 * (repo contents, repo tree, commit checks, advisory view, check annotations,
 * repo metadata).
 *
 * This module is pure (no pi imports) so the argv layout can be unit-tested
 * directly; spawn.ts consumes `ValidInvocation.argv` as a cross-step contract.
 *
 * Unlike git-read there is no `--` separator concept: gh has no
 * rev-vs-path ambiguity and no pathspec notion, so every token is validated
 * against its flag's rule or the positional rule directly.
 *
 * Final argv layout emitted here (spawn.ts is a pure exec layer):
 *   [<noun>, <verb>, ...validatedArgs]
 * e.g. "pr list" with ["--state", "open"] -> ["pr", "list", "--state", "open"]
 *
 * "auth status" is the one exception: validate.ts appends tool-authored
 * ["--json", "hosts"] tokens after the validated args, bypassing the
 * validation loop, so user-supplied --json can never reach the child.
 * User-supplied `--json hosts` is tolerated and dropped as redundant; any
 * other field list is rejected with an explanation.
 */

export const SUBCOMMANDS = [
	"pr view",
	"pr diff",
	"pr list",
	"pr checks",
	"issue view",
	"issue list",
	"auth status",
	"run list",
	"run view",
] as const;

export type GhSubcommand = (typeof SUBCOMMANDS)[number];

/**
 * Tool-authored JSON field list appended to every validated `pr checks` argv,
 * bypassing the validation loop so caller field selection is impossible.
 * Verified against gh 2.102.1: JSON export happens before the failed/pending
 * exit logic, so JSON mode exits 0 even with failed or pending checks.
 */
export const PR_CHECKS_JSON_FIELDS =
	"bucket,completedAt,description,event,link,name,startedAt,state,workflow";

/** Upper bound for `--limit` / `-L <n>` (range 1..LIMIT_MAX). */
export const LIMIT_MAX = 1000;

/** Whitespace and control characters are rejected in filter tokens and jq. */
const CONTROL_RE = /[\s\u0000-\u001F\u007F]/;

/** Control characters only (whitespace allowed; jq expressions need spaces). */
const CONTROL_ONLY_RE = /[\u0000-\u001F\u007F]/;

/** `-R`/`--repo` value: optional `[HOST/]` prefix, then OWNER/REPO. */
const REPO_RE = /^([A-Za-z0-9.-]+\/)?[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/;

/** `--json` value: field names are validated for shape; gh validates membership. */
const FIELDS_RE = /^[A-Za-z0-9_,]+$/;

const PR_STATES = ["open", "closed", "merged", "all"] as const;
const ISSUE_STATES = ["open", "closed", "all"] as const;
const DIFF_COLORS = ["always", "never", "auto"] as const;

const BOOLEAN_FLAGS: Record<GhSubcommand, ReadonlySet<string>> = {
	"pr view": new Set(["--comments", "-c"]),
	"pr diff": new Set(["--name-only", "--patch"]),
	"pr list": new Set(["--draft"]),
	"pr checks": new Set(["--required"]),
	"issue view": new Set(["--comments", "-c"]),
	"issue list": new Set([]),
	"auth status": new Set(["--active", "-a"]),
	"run list": new Set(["-a", "--all"]),
	"run view": new Set(["--log", "--log-failed", "-v", "--verbose"]),
};

/**
 * Human-readable value-flag forms, appended to unknown-flag rejections.
 * `-R`/`--repo` is valid for the five repo subcommands; `auth status` rejects
 * it (no repo context exists there).
 */
const VALUE_FLAG_FORMS: Record<GhSubcommand, string> = {
	"pr view": "--json <fields>, --jq <expr>, -R <[HOST/]OWNER/REPO>",
	"pr diff": "--color <always|never|auto>, --exclude <glob>, -R <[HOST/]OWNER/REPO>",
	"pr checks": "--jq <expr>, -R <[HOST/]OWNER/REPO>",
	"pr list":
		"--limit <n>, --state <open|closed|merged|all>, --author <v>, --assignee <v>, --label <v>, --head <v>, --base <v>, --search <q>, --json <fields>, --jq <expr>, -R <[HOST/]OWNER/REPO>",
	"issue view": "--json <fields>, --jq <expr>, -R <[HOST/]OWNER/REPO>",
	"issue list":
		"--limit <n>, --state <open|closed|all>, --author <v>, --assignee <v>, --label <v>, --mention <v>, --milestone <v>, --search <q>, --json <fields>, --jq <expr>, -R <[HOST/]OWNER/REPO>",
	"auth status": "--hostname <host>, --jq <expr>",
	"run list":
		"--branch <v>, --commit <v>, --created <v>, --event <v>, --limit <n>, --status <v>, --user <v>, --workflow <v>, --json <fields>, --jq <expr>, -R <[HOST/]OWNER/REPO>",
	"run view": "--attempt <n>, --job <id>, --json <fields>, --jq <expr>, -R <[HOST/]OWNER/REPO>",
};

/** Positional-argument expectations per subcommand. */
const POSITIONAL: Record<GhSubcommand, { min: number; max: number; describe: string }> = {
	"pr view": { min: 0, max: 1, describe: "a PR number or branch name" },
	"pr diff": { min: 0, max: 1, describe: "a PR number or branch name" },
	"pr checks": { min: 0, max: 1, describe: "a PR number or branch name" },
	"pr list": { min: 0, max: 0, describe: "no positional arguments" },
	"issue view": { min: 1, max: 1, describe: "an issue number" },
	"issue list": { min: 0, max: 0, describe: "no positional arguments" },
	"auth status": { min: 0, max: 0, describe: "no positional arguments" },
	"run list": { min: 0, max: 0, describe: "no positional arguments" },
	"run view": { min: 1, max: 1, describe: "a numeric run id (interactive selection is not supported)" },
};

function allowedFlagsText(subcommand: GhSubcommand): string {
	return [...BOOLEAN_FLAGS[subcommand], VALUE_FLAG_FORMS[subcommand]].join(", ");
}

/** Non-empty, not starting with `-`, no whitespace or control characters. */
function isValidFilterToken(value: string): boolean {
	return value.length > 0 && !value.startsWith("-") && !CONTROL_RE.test(value);
}

/** Non-empty, no control characters (spaces allowed: jq expressions need them). */
function isValidJq(value: string): boolean {
	return value.length > 0 && !CONTROL_ONLY_RE.test(value);
}

/**
 * PR number or branch name: a plain integer, or a branch-shaped token
 * (non-empty, no leading `-`, no whitespace/control). Branch tokens go to
 * the GitHub API, never to a filesystem, so `/` and `.` are fine.
 */
function isValidPrArg(value: string): boolean {
	return /^\d+$/.test(value) || isValidFilterToken(value);
}

/**
 * Returns an error message when `raw` is not an integer within [min, max],
 * or null when the value is acceptable.
 */
function checkIntFlag(flag: string, raw: string, min: number, max: number): string | null {
	if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) {
		return `flag ${flag} requires an integer between ${min} and ${max}, got '${raw}'`;
	}
	return null;
}

/** Validates a value-flag's value; returns an error message or null. */
function checkValueFlag(
	subcommand: GhSubcommand,
	flag: string,
	raw: string,
): string | null {
	if (flag === "-R" || flag === "--repo") {
		if (!REPO_RE.test(raw)) {
			return `flag ${flag} requires [HOST/]OWNER/REPO, got '${raw}'`;
		}
		return null;
	}
	if (flag === "--json") {
		if (!FIELDS_RE.test(raw)) {
			return `flag ${flag} requires a comma-separated list of field names, got '${raw}'`;
		}
		return null;
	}
	if (flag === "--jq") {
		if (!isValidJq(raw)) {
			return `flag ${flag} requires a non-empty jq expression without control characters`;
		}
		return null;
	}
	if (flag === "--limit" || flag === "-L") {
		return checkIntFlag("--limit", raw, 1, LIMIT_MAX);
	}
	if (flag === "--state") {
		const allowed = subcommand === "pr list" ? PR_STATES : ISSUE_STATES;
		if (!(allowed as readonly string[]).includes(raw)) {
			return `flag ${flag} requires one of ${allowed.join("|")}, got '${raw}'`;
		}
		return null;
	}
	if (flag === "--color") {
		if (!(DIFF_COLORS as readonly string[]).includes(raw)) {
			return `flag --color requires one of ${DIFF_COLORS.join("|")}, got '${raw}'`;
		}
		return null;
	}
	// "run view" scoped value flags. --attempt is bounded like --limit; --job
	// accepts any digits-only value kept as a STRING in argv (no Number()
	// conversion), so job ids beyond 2^53 pass through verbatim.
	if (subcommand === "run view" && (flag === "-a" || flag === "--attempt")) {
		return checkIntFlag(flag, raw, 1, 1000);
	}
	if (subcommand === "run view" && (flag === "-j" || flag === "--job")) {
		if (!/^\d+$/.test(raw)) {
			return `flag --job requires a numeric job id, got '${raw}'`;
		}
		return null;
	}
	// Remaining value flags (--author, --assignee, --label, --head, --base,
	// --search, --mention, --milestone, and the "run list" filters --branch,
	// --commit, --created, --event, --status, --user, --workflow) share the
	// filter-token rule.
	if (!isValidFilterToken(raw)) {
		return `flag ${flag} requires a non-empty value without leading '-' or control characters`;
	}
	return null;
}

/** True when `flag` takes a value on this subcommand. */
function isValueFlag(subcommand: GhSubcommand, flag: string): boolean {
	// "auth status" is deliberately scoped out of the universal cases:
	// --json is handled specially in validateInvocation (tolerated only as
	// `--json hosts`) and -R/--repo is not allowlisted, so both must fall
	// through to rejection instead of consuming values.
	if (subcommand === "auth status") return flag === "--hostname" || flag === "--jq";
	// "pr checks" mirrors auth status for --json: field selection is
	// tool-authored (appended as PR_CHECKS_JSON_FIELDS), so user-supplied
	// --json must fall through to the special-case rejection below.
	if (subcommand === "pr checks") return flag === "-R" || flag === "--repo" || flag === "--jq";
	switch (flag) {
		case "-R":
		case "--repo":
		case "--json":
		case "--jq":
			return true;
		case "--limit":
		case "-L":
			return subcommand === "pr list" || subcommand === "issue list" || subcommand === "run list";
		case "--state":
			return subcommand === "pr list" || subcommand === "issue list";
		case "--color":
		case "--exclude":
			return subcommand === "pr diff";
		case "--author":
		case "--assignee":
		case "--label":
		case "--search":
			return subcommand === "pr list" || subcommand === "issue list";
		case "--head":
		case "--base":
			return subcommand === "pr list";
		case "--mention":
		case "--milestone":
			return subcommand === "issue list";
		case "--branch":
		case "-b":
		case "--commit":
		case "-c":
		case "--created":
		case "--event":
		case "-e":
		case "--status":
		case "-s":
		case "--user":
		case "-u":
		case "--workflow":
		case "-w":
			// "run list" only: -c stays boolean on pr view/issue view and -w
			// stays an unknown flag on pr view/pr checks; per-subcommand scoping
			// resolves every collision.
			return subcommand === "run list";
		case "--attempt":
		case "-a":
		case "--job":
		case "-j":
			// "run view" only: -a stays boolean on auth status and run list.
			return subcommand === "run view";
		default:
			return false;
	}
}

export interface ValidInvocation {
	ok: true;
	/**
	 * Full argv for the child: the two command words, then validated user
	 * args in input order (flag and value tokens verbatim).
	 */
	argv: string[];
	/**
	 * True only when a validated boolean `--log`/`--log-failed` token was
	 * accepted for "run view": the sole signal that selects the dual-window
	 * log runner (log-spawn.ts). Structured state, never argv matching: a
	 * `--jq` VALUE equal to "--log" is consumed as a value token and never
	 * enters the boolean branch, so it cannot select the runner.
	 */
	logMode: boolean;
}

export interface InvalidInvocation {
	ok: false;
	reason: string;
}

export function validateInvocation(
	subcommand: GhSubcommand,
	args: readonly string[],
): ValidInvocation | InvalidInvocation {
	if (!(SUBCOMMANDS as readonly string[]).includes(subcommand)) {
		return {
			ok: false,
			reason: `unknown subcommand '${subcommand}'; allowed: ${SUBCOMMANDS.join(", ")}`,
		};
	}

	const [noun, verb] = subcommand.split(" ") as [string, string];
	const validated: string[] = [];
	let positionals = 0;
	let repoUsed = false;
	let logMode = false;

	for (let i = 0; i < args.length; i++) {
		const token = args[i];
		if (token === undefined) break;

		if (token.startsWith("-")) {
			if (token === "--") {
				return { ok: false, reason: `unexpected argument '--': gh ${subcommand} has no separator concept; ${POSITIONAL[subcommand].describe}` };
			}

			if (BOOLEAN_FLAGS[subcommand].has(token)) {
				validated.push(token);
				// Structured runner-selection state (see ValidInvocation.logMode):
				// only a boolean token accepted HERE can set it.
				if (subcommand === "run view" && (token === "--log" || token === "--log-failed")) {
					logMode = true;
				}
				continue;
			}

			// Exact value-flag match consumes the next token as the value, even
			// when that value is invalid or flag-shaped, so the error names the
			// rejected value instead of misparsing it as the next flag.
			if (isValueFlag(subcommand, token)) {
				const value = args[i + 1];
				if (value === undefined) {
					return { ok: false, reason: `flag ${token} requires a value` };
				}
				const error = checkValueFlag(subcommand, token, value);
				if (error !== null) return { ok: false, reason: error };
				if (subcommand === "pr checks" && (token === "-R" || token === "--repo")) repoUsed = true;
				validated.push(token, value);
				i += 1;
				continue;
			}

			// Attached value form: --flag=value.
			const eq = token.indexOf("=");
			if (eq > 1) {
				const flag = token.slice(0, eq);
				const value = token.slice(eq + 1);
				if (isValueFlag(subcommand, flag) && flag !== "-L" && flag !== "-R") {
					const error = checkValueFlag(subcommand, flag, value);
					if (error !== null) return { ok: false, reason: error };
					validated.push(flag, value);
					continue;
				}
			}

			// auth status: user-supplied `--json hosts` is tolerated and dropped
			// because the tool appends the identical tokens itself (callers that
			// pass what the docs describe should not get a rejection). Any other
			// field list is rejected with the reason. "pr checks" mirrors this for
			// its tool-authored PR_CHECKS_JSON_FIELDS list: caller JSON selection
			// is rejected (watch/web/interval/fail-fast/template modes are unknown
			// flags and fail the same way).
			if ((subcommand === "auth status" || subcommand === "pr checks") && (token === "--json" || token.startsWith("--json="))) {
				const fields = token === "--json" ? args[i + 1] : token.slice("--json=".length);
				const toolFields = subcommand === "auth status" ? "hosts" : PR_CHECKS_JSON_FIELDS;
				if (fields !== toolFields) {
					const why =
						subcommand === "auth status"
							? "flag '--json' for gh auth status only supports fields 'hosts', which the tool appends automatically; pass nothing"
							: `flag '--json' for gh pr checks is tool-authored (fields '${toolFields}' are appended automatically); caller field selection is rejected; pass nothing`;
					return {
						ok: false,
						reason: `${why}${fields === undefined ? "" : ` (got '${fields}')`}`,
					};
				}
				if (token === "--json") i += 1;
				continue;
			}

			// Attached short forms: -L50, -Rowner/repo.
			const short = /^(-L|-R)(.+)$/.exec(token);
			if (short !== null) {
				const flag = short[1]!;
				const value = short[2]!;
				const error = checkValueFlag(subcommand, flag, value);
				if (error !== null) return { ok: false, reason: error };
				if (subcommand === "pr checks") repoUsed = true;
				validated.push(flag, value);
				continue;
			}

			return {
				ok: false,
				reason: `unknown flag '${token}' for gh ${subcommand}; allowed flags: ${allowedFlagsText(subcommand)}`,
			};
		}

		// Positional argument.
		if (subcommand === "issue view") {
			if (!/^\d+$/.test(token)) {
				return { ok: false, reason: `invalid argument '${token}': gh issue view takes an issue number` };
			}
		} else if (subcommand === "run view") {
			if (!/^\d+$/.test(token)) {
				return {
					ok: false,
					reason: `invalid argument '${token}': gh run view takes a numeric run id; interactive selection is not supported`,
				};
			}
		} else if (subcommand === "pr view" || subcommand === "pr diff" || subcommand === "pr checks") {
			if (!isValidPrArg(token)) {
				return { ok: false, reason: `invalid argument '${token}': expected ${POSITIONAL[subcommand].describe}` };
			}
		} else {
			return { ok: false, reason: `unexpected argument '${token}': gh ${subcommand} takes no positional arguments` };
		}
		positionals += 1;
		if (positionals > POSITIONAL[subcommand].max) {
			return {
				ok: false,
				reason: `unexpected argument '${token}': gh ${subcommand} takes at most ${POSITIONAL[subcommand].max} positional argument(s)`,
			};
		}
		validated.push(token);
	}

	if (positionals < POSITIONAL[subcommand].min) {
		return {
			ok: false,
			reason: `missing argument: gh ${subcommand} requires ${POSITIONAL[subcommand].describe}`,
		};
	}

	// gh pr checks with an explicit repository has no current-branch context
	// to infer a PR from, so gh itself requires a selector; reject here with
	// a clear message before spawn.
	if (subcommand === "pr checks" && repoUsed && positionals === 0) {
		return {
			ok: false,
			reason: "gh pr checks with -R/--repo requires a PR number or branch selector",
		};
	}

	return { ok: true, argv: appendToolAuthoredTokens(subcommand, [noun, verb, ...validated]), logMode };
}

/**
 * Appends tool-authored tokens after validation, bypassing the validation
 * loop so they can never be rejected or influenced by user input.
 */
function appendToolAuthoredTokens(subcommand: GhSubcommand, argv: string[]): string[] {
	if (subcommand === "auth status") return [...argv, "--json", "hosts"];
	if (subcommand === "pr checks") return [...argv, "--json", PR_CHECKS_JSON_FIELDS];
	return argv;
}

// ── Structured GitHub API operations ────────────────────────────────────────
//
// The eight API operations use structured parameters (never the legacy args
// array, never gh api with caller flags). They target github.com only and
// are exempt from the worktree gate; api-spawn.ts owns the transport.

export const API_OPERATIONS = ["repo contents", "repo tree", "commit checks", "advisory view", "check annotations", "repo metadata", "pr comments", "pr reviews"] as const;

export type ApiOperation = (typeof API_OPERATIONS)[number];

/** Exact OWNER/REPO on github.com: no host prefix (that is the legacy -R form). */
const API_REPO_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/;

/** Exact CVE/GHSA advisory identifiers. GHSA alphabet: 23456789cfghjmpqrvwx. */
const CVE_ID_RE = /^CVE-\d{4}-\d{4,19}$/;
const GHSA_ID_RE = /^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/;

const ADVISORY_TYPES = ["reviewed", "unreviewed", "malware"] as const;
export type AdvisoryType = (typeof ADVISORY_TYPES)[number];

/** Continuation tokens are base64url JSON; bounded so they can never dominate a result. */
export const CONTINUATION_MAX_CHARS = 4096;

/** Ref values: branch, tag, or SHA. Whitespace/control chars are rejected. */
const REF_MAX_CHARS = 512;

/** Repository-relative paths: segments encoded individually by api.ts. */
const PATH_MAX_CHARS = 4096;

const OPERATION_FIELDS: Record<ApiOperation, ReadonlySet<string>> = {
	"repo contents": new Set(["repo", "path", "ref", "start_line", "end_line", "jq"]),
	"repo tree": new Set(["repo", "ref", "path", "recursive", "jq"]),
	"commit checks": new Set(["repo", "ref", "jq", "continuation"]),
	"advisory view": new Set(["id", "type", "jq", "continuation"]),
	"check annotations": new Set(["repo", "check_run_id", "jq"]),
	"repo metadata": new Set(["repo", "jq"]),
	"pr comments": new Set(["repo", "pr", "continuation", "jq"]),
	"pr reviews": new Set(["repo", "pr", "continuation", "jq"]),
};

export interface ValidApiInvocation {
	ok: true;
	op: ApiOperation;
	/** Exact OWNER/REPO on github.com for repository-scoped operations. */
	repo?: string;
	/** Repository-relative path; empty string is the repository root. */
	path?: string;
	/** Branch, tag, or SHA; omitted means the repository default branch. */
	ref?: string;
	/** Tree recursion; defaults to true. */
	recursive?: boolean;
	/** Positive 1-based inclusive line range for text file contents. */
	startLine?: number;
	endLine?: number;
	/** External jq filter applied to JSON data (never to file text or metadata). */
	jq?: string;
	/** CVE or GHSA identifier (advisory view). */
	id?: string;
	/** Advisory classification filter; defaults to reviewed for CVE searches. */
	type?: AdvisoryType;
	/** Opaque versioned continuation token from a previous incomplete result. */
	continuation?: string;
	/** Check annotations: the check run id whose annotations are fetched. */
	checkRunId?: number;
	/** PR comments/reviews: positive safe integer pull request number. */
	pr?: number;
}

function apiInvalid(reason: string): { ok: false; reason: string } {
	return { ok: false, reason: `gh_read: ${reason}` };
}

/**
 * Non-empty string without control characters; returns null when valid,
 * else a rejection reason fragment.
 */
function checkPlainString(value: unknown, field: string, maxChars: number): string | null {
	if (typeof value !== "string") return `${field} must be a string`;
	if (value.length === 0) return `${field} must be non-empty`;
	if (value.length > maxChars) return `${field} must be at most ${maxChars} characters`;
	if (CONTROL_ONLY_RE.test(value)) return `${field} must not contain control characters`;
	return null;
}

/**
 * Validates a repository-relative path for literal transport. Segments are
 * percent-encoded individually by api.ts, so any character except a lone
 * surrogate survives literally; dots-only segments, empty inner segments,
 * and leading/trailing slashes are rejected outright.
 */
function checkApiPath(value: unknown): string | null {
	if (typeof value !== "string") return "path must be a string";
	if (value.length > PATH_MAX_CHARS) return `path must be at most ${PATH_MAX_CHARS} characters`;
	if (CONTROL_ONLY_RE.test(value)) return "path must not contain control characters";
	if (value.length === 0) return null; // repository root
	if (value.startsWith("/") || value.endsWith("/")) return "path must not start or end with '/'";
	const segments = value.split("/");
	for (const segment of segments) {
		if (segment.length === 0) return "path must not contain empty segments ('//')";
		if (segment === "." || segment === "..") return "path must not contain '.' or '..' segments";
		try {
			// Rejects lone surrogates: the string cannot be transported as a
			// well-formed URL path segment, so it is not transportable literally.
			encodeURIComponent(segment);
		} catch {
			return `path segment '${segment}' cannot be transported literally`;
		}
	}
	return null;
}

/** Positive safe integers for the 1-based line range. */
function checkLineNumber(value: unknown, field: string): string | null {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
		return `${field} must be a safe integer >= 1`;
	}
	return null;
}

/**
 * Validates a continuation token's transport shape: base64url JSON object
 * with version 1. Semantic matching against the invocation happens in
 * api.ts (which owns the payload fields).
 */
function checkContinuationShape(value: unknown): string | null {
	if (typeof value !== "string") return "continuation must be a string";
	if (value.length === 0) return "continuation must be non-empty";
	if (value.length > CONTINUATION_MAX_CHARS) {
		return `continuation must be at most ${CONTINUATION_MAX_CHARS} characters`;
	}
	if (!/^[A-Za-z0-9_-]+$/.test(value)) return "continuation is malformed (not base64url)";
	let decoded: unknown;
	try {
		const json = Buffer.from(value, "base64url").toString("utf8");
		decoded = JSON.parse(json);
	} catch {
		return "continuation is malformed (not decodable JSON)";
	}
	if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
		return "continuation is malformed (not a JSON object)";
	}
	const record = decoded as Record<string, unknown>;
	if (record["v"] !== 1) return "continuation is malformed (unsupported version)";
	return null;
}

/**
 * Validates a full API operation parameter object. Takes unknown so calls
 * that bypass schema validation still get complete runtime validation:
 * unknown or mixed fields, wrong types, missing required fields, unsafe
 * integers, and malformed continuations are all rejected here, before any
 * child process runs.
 */
export function validateApiInvocation(params: unknown): ValidApiInvocation | { ok: false; reason: string } {
	if (typeof params !== "object" || params === null || Array.isArray(params)) {
		return apiInvalid("parameters must be an object");
	}
	const record = params as Record<string, unknown>;
	const subcommand = record["subcommand"];
	if (typeof subcommand !== "string" || !(API_OPERATIONS as readonly string[]).includes(subcommand)) {
		return apiInvalid(`unknown API operation '${String(subcommand)}'; allowed: ${API_OPERATIONS.join(", ")}`);
	}
	const op = subcommand as ApiOperation;

	for (const key of Object.keys(record)) {
		if (key !== "subcommand" && !OPERATION_FIELDS[op].has(key)) {
			return apiInvalid(`unknown field '${key}' for operation '${op}'; allowed: ${[...OPERATION_FIELDS[op]].join(", ")}`);
		}
	}

	const result: ValidApiInvocation = { ok: true, op };

	if (OPERATION_FIELDS[op].has("repo")) {
		const repo = record["repo"];
		if (typeof repo !== "string" || repo.length === 0) {
			return apiInvalid("repo is required and must be OWNER/REPO");
		}
		if (!API_REPO_RE.test(repo)) {
			return apiInvalid(`repo must be exactly OWNER/REPO on github.com, got '${repo}'`);
		}
		result.repo = repo;
	}

	if (OPERATION_FIELDS[op].has("path")) {
		const rawPath = record["path"];
		if (rawPath === undefined) {
			if (op === "repo contents") return apiInvalid("path is required (empty string selects the repository root)");
		} else {
			const pathError = checkApiPath(rawPath);
			if (pathError !== null) return apiInvalid(pathError);
			result.path = rawPath as string;
		}
	}

	if (OPERATION_FIELDS[op].has("ref") || op === "commit checks") {
		const rawRef = record["ref"];
		if (op === "commit checks") {
			const refError = checkPlainString(rawRef, "ref", REF_MAX_CHARS);
			if (refError !== null) return apiInvalid(refError);
			result.ref = rawRef as string;
		} else if (rawRef !== undefined) {
			const refError = checkPlainString(rawRef, "ref", REF_MAX_CHARS);
			if (refError !== null) return apiInvalid(refError);
			result.ref = rawRef as string;
		}
	}

	if (record["recursive"] !== undefined) {
		if (typeof record["recursive"] !== "boolean") {
			return apiInvalid("recursive must be a boolean");
		}
		result.recursive = record["recursive"];
	}

	if (record["start_line"] !== undefined) {
		const lineError = checkLineNumber(record["start_line"], "start_line");
		if (lineError !== null) return apiInvalid(lineError);
		result.startLine = record["start_line"] as number;
	}
	if (record["end_line"] !== undefined) {
		const lineError = checkLineNumber(record["end_line"], "end_line");
		if (lineError !== null) return apiInvalid(lineError);
		result.endLine = record["end_line"] as number;
	}
	if (result.startLine !== undefined && result.endLine !== undefined && result.startLine > result.endLine) {
		return apiInvalid(`start_line (${result.startLine}) must be <= end_line (${result.endLine})`);
	}

	if (record["jq"] !== undefined) {
		if (typeof record["jq"] !== "string" || !isValidJq(record["jq"])) {
			return apiInvalid("jq must be a non-empty expression without control characters");
		}
		result.jq = record["jq"];
	}

	if (op === "advisory view") {
		const id = record["id"];
		if (typeof id !== "string" || !(CVE_ID_RE.test(id) || GHSA_ID_RE.test(id))) {
			return apiInvalid(
				"id must be an exact advisory identifier: CVE-YYYY-NNNN or GHSA-xxxx-xxxx-xxxx",
			);
		}
		result.id = id;
		const isCve = CVE_ID_RE.test(id);
		if (record["type"] !== undefined) {
			if (!isCve) {
				return apiInvalid("type is only valid for CVE lookups; a GHSA identifier is fetched directly as one object");
			}
			const type = record["type"];
			if (typeof type !== "string" || !(ADVISORY_TYPES as readonly string[]).includes(type)) {
				return apiInvalid(`type must be one of ${ADVISORY_TYPES.join("|")}, got '${String(type)}'`);
			}
			result.type = type as AdvisoryType;
		}
		if (record["continuation"] !== undefined && !isCve) {
			return apiInvalid("continuation is only valid for CVE searches; a GHSA identifier is fetched directly as one object");
		}
	}

	if (op === "pr comments" || op === "pr reviews") {
		const rawPr = record["pr"];
		if (rawPr === undefined) return apiInvalid("pr is required");
		const prError = checkLineNumber(rawPr, "pr");
		if (prError !== null) return apiInvalid(prError);
		result.pr = rawPr as number;
	}

	if (op === "check annotations") {
		const rawId = record["check_run_id"];
		if (rawId === undefined) return apiInvalid("check_run_id is required");
		const idError = checkLineNumber(rawId, "check_run_id");
		if (idError !== null) return apiInvalid(idError);
		result.checkRunId = rawId as number;
	}

	if (record["continuation"] !== undefined) {
		const contError = checkContinuationShape(record["continuation"]);
		if (contError !== null) return apiInvalid(contError);
		result.continuation = record["continuation"] as string;
	}

	return result;
}

/**
 * Top-level parameter validation used by index.ts: discriminates native
 * subcommands (flat args array, legacy contract unchanged) from structured
 * API operations, and rejects mixed parameter shapes in both directions.
 */
export type ValidToolInvocation =
	| { ok: true; kind: "native"; subcommand: GhSubcommand; argv: string[]; logMode: boolean }
	| { ok: true; kind: "api"; api: ValidApiInvocation }
	| { ok: false; reason: string };

export function validateToolParams(params: unknown): ValidToolInvocation {
	if (typeof params !== "object" || params === null || Array.isArray(params)) {
		return { ok: false, reason: "gh_read: parameters must be an object" };
	}
	const record = params as Record<string, unknown>;
	const subcommand = record["subcommand"];
	if (typeof subcommand !== "string") {
		return { ok: false, reason: "gh_read: subcommand must be a string" };
	}
	if ((API_OPERATIONS as readonly string[]).includes(subcommand)) {
		if (record["args"] !== undefined) {
			return {
				ok: false,
				reason: `gh_read: API operation '${subcommand}' takes structured parameters, not an args array`,
			};
		}
		const checked = validateApiInvocation(params);
		if (!checked.ok) return { ok: false, reason: checked.reason };
		return { ok: true, kind: "api", api: checked };
	}
	if (!(SUBCOMMANDS as readonly string[]).includes(subcommand)) {
		return {
			ok: false,
			reason: `gh_read: unknown subcommand '${subcommand}'; allowed: ${SUBCOMMANDS.join(", ")}, ${API_OPERATIONS.join(", ")}`,
		};
	}
	for (const key of Object.keys(record)) {
		if (key !== "subcommand" && key !== "args") {
			return {
				ok: false,
				reason: `gh_read: unknown field '${key}' for native subcommand '${subcommand}'; pass flags via the args array`,
			};
		}
	}
	const checked = validateInvocation(subcommand as GhSubcommand, (record["args"] as string[] | undefined) ?? []);
	if (!checked.ok) return { ok: false, reason: `gh_read: ${checked.reason}` };
	return { ok: true, kind: "native", subcommand: subcommand as GhSubcommand, argv: checked.argv, logMode: checked.logMode };
}
