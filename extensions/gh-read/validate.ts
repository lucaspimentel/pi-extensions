/**
 * gh-read argument validation.
 *
 * Implements the "Invocation contract" and "Allowlists" sections of
 * docs/gh-read-design.md: a five-value flat subcommand union, per-subcommand
 * flag allowlists, value validators, and final argv construction.
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
 */

export const SUBCOMMANDS = ["pr view", "pr diff", "pr list", "issue view", "issue list"] as const;

export type GhSubcommand = (typeof SUBCOMMANDS)[number];

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
	"issue view": new Set(["--comments", "-c"]),
	"issue list": new Set([]),
};

/**
 * Human-readable value-flag forms, appended to unknown-flag rejections.
 * `-R`/`--repo` is valid for every subcommand.
 */
const VALUE_FLAG_FORMS: Record<GhSubcommand, string> = {
	"pr view": "--json <fields>, --jq <expr>, -R <[HOST/]OWNER/REPO>",
	"pr diff": "--color <always|never|auto>, --exclude <glob>, -R <[HOST/]OWNER/REPO>",
	"pr list":
		"--limit <n>, --state <open|closed|merged|all>, --author <v>, --assignee <v>, --label <v>, --head <v>, --base <v>, --search <q>, --json <fields>, --jq <expr>, -R <[HOST/]OWNER/REPO>",
	"issue view": "--json <fields>, --jq <expr>, -R <[HOST/]OWNER/REPO>",
	"issue list":
		"--limit <n>, --state <open|closed|all>, --author <v>, --assignee <v>, --label <v>, --mention <v>, --milestone <v>, --search <q>, --json <fields>, --jq <expr>, -R <[HOST/]OWNER/REPO>",
};

/** Positional-argument expectations per subcommand. */
const POSITIONAL: Record<GhSubcommand, { min: number; max: number; describe: string }> = {
	"pr view": { min: 0, max: 1, describe: "a PR number or branch name" },
	"pr diff": { min: 0, max: 1, describe: "a PR number or branch name" },
	"pr list": { min: 0, max: 0, describe: "no positional arguments" },
	"issue view": { min: 1, max: 1, describe: "an issue number" },
	"issue list": { min: 0, max: 0, describe: "no positional arguments" },
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
	// Remaining value flags (--author, --assignee, --label, --head, --base,
	// --search, --mention, --milestone) share the filter-token rule.
	if (!isValidFilterToken(raw)) {
		return `flag ${flag} requires a non-empty value without leading '-' or control characters`;
	}
	return null;
}

/** True when `flag` takes a value on this subcommand. */
function isValueFlag(subcommand: GhSubcommand, flag: string): boolean {
	switch (flag) {
		case "-R":
		case "--repo":
		case "--json":
		case "--jq":
			return true;
		case "--limit":
		case "-L":
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

	for (let i = 0; i < args.length; i++) {
		const token = args[i];
		if (token === undefined) break;

		if (token.startsWith("-")) {
			if (token === "--") {
				return { ok: false, reason: `unexpected argument '--': gh ${subcommand} has no separator concept; ${POSITIONAL[subcommand].describe}` };
			}

			if (BOOLEAN_FLAGS[subcommand].has(token)) {
				validated.push(token);
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

			// Attached short forms: -L50, -Rowner/repo.
			const short = /^(-L|-R)(.+)$/.exec(token);
			if (short !== null) {
				const flag = short[1]!;
				const value = short[2]!;
				const error = checkValueFlag(subcommand, flag, value);
				if (error !== null) return { ok: false, reason: error };
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
		} else if (subcommand === "pr view" || subcommand === "pr diff") {
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

	return { ok: true, argv: [noun, verb, ...validated] };
}
