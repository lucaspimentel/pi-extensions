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
 *   status:        [...GLOBAL_OPTIONS, "status", "--porcelain", ...statusFlags]
 */

export const SUBCOMMANDS = ["diff", "log", "show", "status"] as const;

export type GitSubcommand = (typeof SUBCOMMANDS)[number];

/**
 * Injected global options, prepended for every subcommand (never
 * user-suppliable). The `-c` overrides neutralize repository config that
 * would otherwise execute helpers (`core.fsmonitor`) or display signatures
 * (`log.showSignature`, `format.pretty`), which runs `gpg.program`.
 */
export const GLOBAL_OPTIONS = [
	"--no-pager",
	"--no-optional-locks",
	"-c",
	"core.fsmonitor=false",
	"-c",
	"core.untrackedCache=false",
	"-c",
	"log.showSignature=false",
	"-c",
	"format.pretty=medium",
] as const;

/** Injected immediately after the subcommand for diff/log/show only. */
export const DIFF_LOG_SHOW_OPTIONS = ["--no-ext-diff", "--no-textconv"] as const;

/** Upper bound for `-U<n>` / `--unified=<n>` (range 0..UNIFIED_MAX). */
export const UNIFIED_MAX = 64;

/**
 * Upper bound for every count form: `-n <n>`, `-n<n>`, `-<n>`, and
 * `--max-count=<n>` (range 1..MAX_COUNT_MAX).
 */
export const MAX_COUNT_MAX = 10000;

/** Hardcoded flag appended to status; --porcelain is never user-suppliable. */
const STATUS_PORCELAIN = "--porcelain";

const BOOLEAN_FLAGS: Record<GitSubcommand, ReadonlySet<string>> = {
	diff: new Set([
		"--stat",
		"--shortstat",
		"--numstat",
		"--name-only",
		"--name-status",
		"--cached",
		"--staged",
		"--check",
		"-w",
		"--ignore-all-space",
	]),
	log: new Set(["-p", "--oneline", "--stat", "--no-merges", "--first-parent", "--decorate"]),
	show: new Set(["--stat", "--no-patch", "-s", "--oneline", "-p", "--patch"]),
	status: new Set(["--short", "--branch"]),
};

/** Human-readable value-flag forms, listed in unknown-flag rejections. */
const VALUE_FLAG_FORMS: Record<GitSubcommand, string> = {
	diff: "-U<n>, --unified=<n>",
	log:
		"-n <n>, -n<n>, -<n>, --max-count=<n>, --format=<format>, --pretty=<format>, " +
		"--date=<date>, --author=<pattern>",
	show:
		"-U<n>, --unified=<n>, -n <n>, -n<n>, -<n>, --max-count=<n>, " +
		"--format=<format>, --pretty=<format>, --date=<date>",
	status: "none",
};

/**
 * Preset names accepted for `--format=`/`--pretty=`; git resolves these
 * before it parses a custom format string.
 */
export const PRETTY_PRESETS = new Set(["oneline", "short", "medium", "full", "fuller", "email", "raw"]);

/**
 * The only `%` sequences a custom format string may contain, written as the
 * exact text of the sequence: two characters for the commit-field codes
 * (`%H`, `%%`), three for the author, committer, and reflog families (`%an`,
 * `%gd`). This set is the source of truth for the format allowlist: git
 * prints an unknown specifier literally instead of failing, so the tool has
 * to reject the unsupported ones itself. `%G?`/`%GG`/`%GS`/`%GK`/`%GF`/`%GP`/
 * `%GT` are absent because each of them runs signature verification, which
 * executes the repository-configurable `gpg.program`, the same path that
 * keeps `--show-signature` off the allowlist; `%x`, `%C`, `%w(`, `%<(` and
 * `%>(` are absent because they emit raw bytes, colors, or padding.
 */
export const FORMAT_SPECIFIERS = new Set([
	"%%",
	"%H",
	"%h",
	"%T",
	"%t",
	"%P",
	"%p",
	"%s",
	"%f",
	"%b",
	"%B",
	"%n",
	"%d",
	"%D",
	"%m",
	"%N",
	"%e",
	"%an",
	"%aN",
	"%ae",
	"%aE",
	"%al",
	"%aL",
	"%ad",
	"%aD",
	"%ar",
	"%at",
	"%ai",
	"%aI",
	"%as",
	"%cn",
	"%cN",
	"%ce",
	"%cE",
	"%cl",
	"%cL",
	"%cd",
	"%cD",
	"%cr",
	"%ct",
	"%ci",
	"%cI",
	"%cs",
	"%gd",
	"%gD",
	"%gs",
	"%gN",
	"%gE",
	"%gn",
	"%ge",
]);

/** `--date=` values git accepts; the free-form `format:` forms are excluded. */
export const DATE_FORMATS = new Set([
	"default",
	"relative",
	"local",
	"iso8601",
	"iso",
	"iso8601-strict",
	"iso-strict",
	"rfc2822",
	"rfc",
	"short",
	"raw",
	"unix",
	"human",
]);

/**
 * Untyped raw tool input, before schema-level narrowing. `subcommand` is
 * optional because some models bundle the subcommand into `args` instead of
 * using the dedicated property.
 */
export interface RawInvocation {
	subcommand?: string;
	args?: string[];
}

/**
 * Normalizes raw tool input into a typed subcommand plus the remaining args.
 * When `subcommand` is absent, args[0] is promoted if it names an allowlisted
 * subcommand (the observed fallback pattern: `{args: ["status", "--short"]}`).
 * Returns a rejection naming the allowed set otherwise; unknown explicit
 * subcommands are also rejected here, before per-flag validation.
 */
export function normalizeInvocation(raw: RawInvocation): { ok: true; subcommand: GitSubcommand; args: string[] } | InvalidInvocation {
	const args = [...(raw.args ?? [])];
	let subcommand = raw.subcommand;
	if (subcommand === undefined || subcommand === "") {
		const first = args[0];
		if (first !== undefined && (SUBCOMMANDS as readonly string[]).includes(first)) {
			subcommand = first;
			args.shift();
		} else {
			return {
				ok: false,
				reason: `missing 'subcommand'; pass subcommand ('${SUBCOMMANDS.join("' | '")}') and put revs, flags, and pathspecs in args`,
			};
		}
	}
	if (!(SUBCOMMANDS as readonly string[]).includes(subcommand)) {
		return { ok: false, reason: `unknown subcommand '${subcommand}'; allowed: ${SUBCOMMANDS.join(", ")}` };
	}
	return { ok: true, subcommand: subcommand as GitSubcommand, args };
}

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
 * True for a range token with an omitted endpoint: `..X`, `...X`, `X..`,
 * `X...`, and the bare `..` / `...` forms. `A..B` / `A...B` with both
 * endpoints spelled out are not dangling. `rev:path` tokens whose path part
 * contains a `..` segment are already rejected by `isSafeUnion`, so a
 * leading/trailing `..` here always means a range, never a path component.
 */
function isDanglingRange(token: string): boolean {
	return token.startsWith("..") || token.endsWith("..");
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

/**
 * C0 control characters and DEL. Unlike CONTROL_RE this does not reject
 * whitespace: spaces are legitimate inside format strings and author patterns.
 */
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F]/;

/**
 * Returns the first `%` sequence in `value` that is not allowlisted, or null
 * when every one of them is. Scanning consumes each accepted code, longest
 * match first, so an escaped percent (`%%G?`) ends at the literal `G?`
 * instead of re-examining it as a specifier.
 */
function unsupportedFormatSpecifier(value: string): string | null {
	let index = 0;
	while (index < value.length) {
		if (value[index] !== "%") {
			index += 1;
			continue;
		}
		// Longest match first: the author/committer/reflog codes are three
		// characters (`%an`, `%gd`), the rest are two (`%H`, `%%`).
		const three = value.slice(index, index + 3);
		if (three.length === 3 && FORMAT_SPECIFIERS.has(three)) {
			index += 3;
			continue;
		}
		const two = value.slice(index, index + 2);
		if (FORMAT_SPECIFIERS.has(two)) {
			index += 2;
			continue;
		}
		return nameFormatSpecifier(value, index);
	}
	return null;
}

/**
 * Names a rejected sequence for an error message: the three-character
 * signature forms in full (`%G?`), otherwise the two-character code (a
 * trailing `%` stays a bare `%`).
 */
function nameFormatSpecifier(value: string, index: number): string {
	const signature = value.slice(index, index + 3);
	if (isSignatureSpecifier(signature)) return signature;
	return value.slice(index, index + 2);
}

/** True for the `%G` family, the specifiers that run signature verification. */
function isSignatureSpecifier(sequence: string): boolean {
	return /^%G[?GSKFPT]$/.test(sequence);
}

/**
 * Validates a `--format=`/`--pretty=` value: an exact preset name, or a
 * format string whose every `%` is allowlisted. A `%`-free value that is not
 * a preset is rejected here: git resolves such a value as a format name and
 * then as a `pretty.<name>` config alias, which is prefix-matched and may
 * itself contain any specifier, including the `%G` family.
 */
function checkFormatValue(flag: string, raw: string): string | null {
	const textError = checkTextValue(flag, raw);
	if (textError !== null) return textError;
	if (raw.startsWith("format:") || raw.startsWith("tformat:")) {
		const prefix = raw.startsWith("tformat:") ? "tformat:" : "format:";
		return `flag ${flag} does not accept a '${prefix}' prefix; pass the format string directly, e.g. ${flag}=%H`;
	}
	if (PRETTY_PRESETS.has(raw)) return null;
	if (!raw.includes("%")) {
		return (
			`flag ${flag} requires an exact preset name (${[...PRETTY_PRESETS].join(", ")}) or a format ` +
			`string containing %; '${raw}' is neither`
		);
	}
	const unsupported = unsupportedFormatSpecifier(raw);
	if (unsupported === null) return null;
	const reason = isSignatureSpecifier(unsupported)
		? "signature specifiers run an external program"
		: "it is not on the format allowlist";
	return (
		`unknown format specifier '${unsupported}' in ${flag}: ${reason}; ` +
		`use commit fields like %H %h %s %an %ad %aI`
	);
}

/**
 * Rejects an empty value and one carrying control characters, returning the
 * error or null.
 */
function checkTextValue(flag: string, raw: string): string | null {
	if (raw.length === 0) return `flag ${flag} requires a value`;
	if (CONTROL_CHARS_RE.test(raw)) return `flag ${flag} value contains control characters`;
	return null;
}

/** Validates a `--date=` value against the closed enum. */
function checkDateValue(flag: string, raw: string): string | null {
	if (raw.length === 0) return `flag ${flag} requires a value`;
	if (!DATE_FORMATS.has(raw)) {
		return `flag ${flag} requires one of ${[...DATE_FORMATS].join(", ")}, got '${raw}'`;
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
		// Flags only: status takes no revs or pathspecs here. --porcelain stays
		// hardcoded and is rejected if supplied (it is never user-suppliable).
		const flags: string[] = [];
		for (const token of args) {
			if (token === undefined) break;
			if (!BOOLEAN_FLAGS.status.has(token)) {
				return {
					ok: false,
					reason: `unknown argument '${token}' for git status; allowed flags: ${allowedFlagsText("status")}`,
				};
			}
			flags.push(token);
		}
		return { ok: true, argv: [...GLOBAL_OPTIONS, "status", STATUS_PORCELAIN, ...flags] };
	}

	const validated: string[] = [];
	let pastSeparator = false;
	// diff-only guard state: git diff parses its pre-`--` arguments as range
	// endpoints and cannot accept a dangling range (`main...`, `..main`) next
	// to another rev or pathspec; it exits with a usage error (code 129). git
	// log and show accept the same combination, so the guard applies to diff
	// only.
	let danglingRange: string | null = null;
	let revCount = 0;

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

		if (!pastSeparator && subcommand === "diff") {
			if ((isDanglingRange(token) || danglingRange !== null) && revCount > 0) {
				const offender = isDanglingRange(token) ? token : (danglingRange ?? token);
				return {
					ok: false,
					reason:
						`invalid argument '${offender}': a diff range with an omitted endpoint ` +
						`(like 'main...' or '..main') cannot be combined with another rev or ` +
						`pathspec; spell out both endpoints, e.g. 'main...HEAD'`,
					};
			}
			if (isDanglingRange(token)) danglingRange = token;
			revCount += 1;
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
 * Handles one flag token at `index`. Exact separate-form matches (`-U`, `-n`,
 * `--date`, `--author`) are checked before attached-form matching so the exact
 * forms do not mis-parse, and each subcommand group is applied independently: diff
 * and show share the unified-context forms, log and show share the count,
 * format, and date forms, and author is log-only.
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

	if (subcommand === "diff" || subcommand === "show") {
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

	if (subcommand === "log" || subcommand === "show") {
		if (token === "-n") {
			return consumeIntValue("-n", args, index, 1, MAX_COUNT_MAX);
		}
		const attachedCount = /^-n(\d+)$/.exec(token);
		if (attachedCount !== null) {
			return { tokens: [token], consumed: 0, error: checkIntFlag("-n", attachedCount[1] ?? "", 1, MAX_COUNT_MAX) };
		}
		const shorthand = /^-(\d+)$/.exec(token);
		if (shorthand !== null) {
			return { tokens: [token], consumed: 0, error: checkIntFlag("-<n>", shorthand[1] ?? "", 1, MAX_COUNT_MAX) };
		}
		if (token.startsWith("--max-count=")) {
			const raw = token.slice("--max-count=".length);
			return { tokens: [token], consumed: 0, error: checkIntFlag("--max-count", raw, 1, MAX_COUNT_MAX) };
		}
		if (token === "--format" || token === "--pretty") {
			// git rejects a bare --format outright and treats a bare --pretty as
			// --pretty=medium, which would reinterpret the next token as a rev.
			return { tokens: [], consumed: 0, error: `flag ${token} requires the attached form, e.g. ${token}=%H` };
		}
		const attachedFormat = handleAttachedValue(token, "--format", checkFormatValue);
		if (attachedFormat !== null) return attachedFormat;
		const attachedPretty = handleAttachedValue(token, "--pretty", checkFormatValue);
		if (attachedPretty !== null) return attachedPretty;
		if (token === "--date") {
			return consumeValue("--date", args, index, checkDateValue);
		}
		const attachedDate = handleAttachedValue(token, "--date", checkDateValue);
		if (attachedDate !== null) return attachedDate;
	}

	if (subcommand === "log") {
		// --author is free text that git matches as a regular expression, so only
		// emptiness and control characters are rejected.
		if (token === "--author") {
			return consumeValue("--author", args, index, checkTextValue);
		}
		const attachedAuthor = handleAttachedValue(token, "--author", checkTextValue);
		if (attachedAuthor !== null) return attachedAuthor;
	}

	return {
		tokens: [],
		consumed: 0,
		error: `unknown flag '${token}' for git ${subcommand}; allowed flags: ${allowedFlagsText(subcommand)}`,
	};
}

/**
 * Consumes the token after a separate-form value flag (`--date iso`,
 * `--author Jane`) and validates it with `check`. The next token is consumed
 * even when it is not a valid value (e.g. `--date --stat`), so the error names
 * the rejected value instead of misparsing it as the next flag.
 */
function consumeValue(
	flag: string,
	args: readonly string[],
	index: number,
	check: (flag: string, raw: string) => string | null,
): FlagHandling {
	const value = args[index + 1];
	if (value === undefined) {
		return { tokens: [], consumed: 0, error: `flag ${flag} requires a value` };
	}
	return { tokens: [flag, value], consumed: 1, error: check(flag, value) };
}

/**
 * Handles an attached `--<flag>=<value>` token, returning null when the token
 * is not that flag. `check` validates the value and reports the flag spelling
 * it is given, so a rejection of `--pretty` says `--pretty`.
 */
function handleAttachedValue(
	token: string,
	flag: string,
	check: (flag: string, raw: string) => string | null,
): FlagHandling | null {
	if (!token.startsWith(`${flag}=`)) return null;
	return { tokens: [token], consumed: 0, error: check(flag, token.slice(flag.length + 1)) };
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
