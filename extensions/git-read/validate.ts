/**
 * git-read argument validation.
 *
 * Implements the "Argument validation", "Allowlists", and "Command
 * construction" sections of docs/git-read-design.md: per-subcommand flag
 * allowlists, `--` splitting into revs/paths, rev and path validators
 * (safe-union rule), and final argv construction.
 *
 * This module is pure (no pi imports) so the argv layout can be unit-tested
 * directly; spawn.ts consumes `ValidInvocation.argv` as a cross-step contract.
 *
 * Final argv layouts emitted here (step 3's spawn.ts is a pure exec layer):
 *   diff/log/show: [...GLOBAL_OPTIONS, <sub>, ...DIFF_LOG_SHOW_OPTIONS, ...args]
 *   status:        [...GLOBAL_OPTIONS, "status", "--porcelain"]
 */

export const SUBCOMMANDS = ["diff", "log", "show", "status"] as const;

export type GitSubcommand = (typeof SUBCOMMANDS)[number];

/** Injected global options, prepended for every subcommand (never user-suppliable). */
export const GLOBAL_OPTIONS = [
	"--no-pager",
	"--no-optional-locks",
	"-c",
	"core.fsmonitor=false",
	"-c",
	"core.untrackedCache=false",
] as const;

/** Injected immediately after the subcommand for diff/log/show only. */
export const DIFF_LOG_SHOW_OPTIONS = ["--no-ext-diff", "--no-textconv"] as const;

/** Upper bound for `-U<n>` / `--unified=<n>` (range 0..UNIFIED_MAX). */
export const UNIFIED_MAX = 64;

/** Upper bound for `-n <n>` / `--max-count=<n>` (range 1..MAX_COUNT_MAX). */
export const MAX_COUNT_MAX = 10000;

/** Hardcoded flag appended to status; status never accepts user args. */
const STATUS_PORCELAIN = "--porcelain";

const BOOLEAN_FLAGS: Record<GitSubcommand, ReadonlySet<string>> = {
	diff: new Set(["--stat", "--shortstat", "--numstat", "--name-only", "--name-status", "--cached", "--staged"]),
	log: new Set(["-p", "--oneline", "--stat"]),
	show: new Set(["--stat"]),
	status: new Set(),
};

/** Human-readable value-flag forms, listed in unknown-flag rejections. */
const VALUE_FLAG_FORMS: Record<GitSubcommand, string> = {
	diff: "-U<n>, --unified=<n>",
	log: "-n <n>, --max-count=<n>",
	show: "-U<n>, --unified=<n>",
	status: "none",
};

function allowedFlagsText(subcommand: GitSubcommand): string {
	return [...BOOLEAN_FLAGS[subcommand], VALUE_FLAG_FORMS[subcommand]].join(", ");
}

/** Whitespace and control characters are rejected in both revs and paths. */
const CONTROL_RE = /[\s\u0000-\u001F\u007F]/;

/**
 * Rev tokens: non-empty, not starting with `-`, no whitespace or control
 * characters. Everything else is allowed: `..`, `...`, `~`, `^`, `rev:path`
 * forms resolve inside the object database, which is repo-scoped.
 */
export function isValidRev(token: string): boolean {
	return token.length > 0 && !token.startsWith("-") && !CONTROL_RE.test(token);
}

/** True if any `/`-separated segment is exactly `..` (parent-directory escape). */
function hasDotDotSegment(token: string): boolean {
	return token.split("/").some((segment) => segment === "..");
}

/**
 * Path tokens: non-empty, not starting with `-`, no backslash separators, not
 * absolute, no `..` path segment, no whitespace or control characters (strict
 * allowlist; whitespace also makes rev/path classification ambiguous).
 * Glob characters (`*`, `?`) are unrestricted; matching is repo-scoped.
 */
export function isValidPath(token: string): boolean {
	if (token.length === 0 || token.startsWith("-") || token.startsWith("/")) return false;
	if (token.includes("\\")) return false;
	if (CONTROL_RE.test(token)) return false;
	return !hasDotDotSegment(token);
}

/**
 * Safe-union rule for tokens before `--`: a token is accepted if it passes
 * either validator. Tokens that pass the rev validator but carry
 * path-dangerous constructs (absolute, backslash, `..` segment) are rejected:
 * git would fall back to treating them as pathspecs, which could escape the
 * worktree. `main..next` has no `..` segment and stays accepted.
 */
function isSafeUnion(token: string): boolean {
	if (!isValidRev(token) && !isValidPath(token)) return false;
	if (token.includes("\\") || token.startsWith("/") || hasDotDotSegment(token)) return false;
	return true;
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

export interface ValidInvocation {
	ok: true;
	/**
	 * Full argv for the child: global options, subcommand, injected
	 * post-subcommand flags (--no-ext-diff/--no-textconv for diff/log/show,
	 * --porcelain for status), then validated user args in input order
	 * (including a literal `--` separator when the caller supplied one).
	 */
	argv: string[];
}

export interface InvalidInvocation {
	ok: false;
	reason: string;
}

export function validateInvocation(
	subcommand: GitSubcommand,
	args: readonly string[],
): ValidInvocation | InvalidInvocation {
	if (!(SUBCOMMANDS as readonly string[]).includes(subcommand)) {
		return {
			ok: false,
			reason: `unknown subcommand '${subcommand}'; allowed: ${SUBCOMMANDS.join(", ")}`,
		};
	}

	if (subcommand === "status") {
		if (args.length > 0) {
			return {
				ok: false,
				reason: "git status takes no arguments; --porcelain is applied automatically",
			};
		}
		return { ok: true, argv: [...GLOBAL_OPTIONS, "status", STATUS_PORCELAIN] };
	}

	const validated: string[] = [];
	let pastSeparator = false;

	for (let i = 0; i < args.length; i++) {
		const token = args[i];
		if (token === undefined) break;

		if (!pastSeparator && token === "--") {
			pastSeparator = true;
			validated.push(token);
			continue;
		}

		if (!pastSeparator && token.startsWith("-")) {
			const handled = handleFlag(subcommand, token, args, i);
			if (handled.error !== null) return { ok: false, reason: handled.error };
			validated.push(...handled.tokens);
			i += handled.consumed;
			continue;
		}

		if (pastSeparator) {
			if (!isValidPath(token)) {
				return { ok: false, reason: `invalid argument '${token}': not a valid pathspec` };
			}
		} else if (!isSafeUnion(token)) {
			return { ok: false, reason: `invalid argument '${token}': not a valid rev or pathspec` };
		}
		validated.push(token);
	}

	return {
		ok: true,
		argv: [...GLOBAL_OPTIONS, subcommand, ...DIFF_LOG_SHOW_OPTIONS, ...validated],
	};
}

/**
 * Result of handling one flag token: the tokens to copy into the validated
 * argv (flag plus value token, verbatim), how many extra input tokens were
 * consumed, and a rejection reason or null.
 */
interface FlagHandling {
	tokens: string[];
	consumed: number;
	error: string | null;
}

/**
 * Handles one flag token at `index`. Exact `-U`/`-n` matches are checked
 * before attached `-U\d+` prefix matching so the exact forms do not mis-parse.
 */
function handleFlag(
	subcommand: GitSubcommand,
	token: string,
	args: readonly string[],
	index: number,
): FlagHandling {
	const flags = BOOLEAN_FLAGS[subcommand];

	if (flags.has(token)) {
		return { tokens: [token], consumed: 0, error: null };
	}

	if (subcommand === "log") {
		if (token === "-n") {
			return consumeIntValue("-n", args, index, 1, MAX_COUNT_MAX);
		}
		if (token.startsWith("--max-count=")) {
			const raw = token.slice("--max-count=".length);
			return { tokens: [token], consumed: 0, error: checkIntFlag("--max-count", raw, 1, MAX_COUNT_MAX) };
		}
	} else {
		// diff and show share the -U/--unified value flags.
		if (token === "-U") {
			return consumeIntValue("-U", args, index, 0, UNIFIED_MAX);
		}
		const attached = /^-U(\d+)$/.exec(token);
		if (attached !== null) {
			return { tokens: [token], consumed: 0, error: checkIntFlag("-U", attached[1] ?? "", 0, UNIFIED_MAX) };
		}
		if (token.startsWith("--unified=")) {
			const raw = token.slice("--unified=".length);
			return { tokens: [token], consumed: 0, error: checkIntFlag("--unified", raw, 0, UNIFIED_MAX) };
		}
	}

	return {
		tokens: [],
		consumed: 0,
		error: `unknown flag '${token}' for git ${subcommand}; allowed flags: ${allowedFlagsText(subcommand)}`,
	};
}

/**
 * Consumes the token after a separate-form value flag (`-U 5`, `-n 10`) and
 * validates it. The next token is consumed even when it is not a plain
 * integer (e.g. `-U -1`), so the error names the rejected value instead of
 * misparsing it as the next flag.
 */
function consumeIntValue(
	flag: string,
	args: readonly string[],
	index: number,
	min: number,
	max: number,
): FlagHandling {
	const value = args[index + 1];
	if (value === undefined) {
		return { tokens: [], consumed: 0, error: `flag ${flag} requires an integer value` };
	}
	return { tokens: [flag, value], consumed: 1, error: checkIntFlag(flag, value, min, max) };
}
