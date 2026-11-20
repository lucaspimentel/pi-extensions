// Unit tests for git-read argument validation (extensions/git-read/validate.ts).
// Pure module tests: no pi imports, no subprocesses, no filesystem access.
// Covers argv construction, the design's valid forms, every value-flag class
// and bound, rejections, separator/union handling, and error-message contents.
//
// Design: docs/git-read-design.md ("Argument validation", "Allowlists",
// "Command construction").
//
// Run: node --test tests/git-read-validate.test.mts
import assert from "node:assert/strict";
import { test } from "node:test";

import {
	DIFF_LOG_SHOW_OPTIONS,
	GLOBAL_OPTIONS,
	MAX_COUNT_MAX,
	SUBCOMMANDS,
	UNIFIED_MAX,
	normalizeInvocation,
	validateInvocation,
	type GitSubcommand,
} from "../extensions/git-read/validate.ts";

function validateOk(subcommand: GitSubcommand, args: readonly string[]): string[] {
	const result = validateInvocation(subcommand, args);
	if (!result.ok) assert.fail(`expected ok for [${args.join(" ")}], got: ${result.reason}`);
	return result.argv;
}

function validateRejects(subcommand: GitSubcommand, args: readonly string[], reasonIncludes?: string): void {
	const result = validateInvocation(subcommand, args);
	assert.equal(result.ok, false, `expected rejection for [${args.join(" ")}]`);
	if (!result.ok && reasonIncludes !== undefined) {
		assert.ok(
			result.reason.includes(reasonIncludes),
			`reason '${result.reason}' does not include '${reasonIncludes}'`,
		);
	}
}

test("constants match the design bounds", () => {
	assert.deepEqual([...SUBCOMMANDS], ["diff", "log", "show", "status"]);
	assert.equal(UNIFIED_MAX, 64);
	assert.equal(MAX_COUNT_MAX, 10000);
	assert.deepEqual([...GLOBAL_OPTIONS], [
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
	]);
	assert.deepEqual([...DIFF_LOG_SHOW_OPTIONS], ["--no-ext-diff", "--no-textconv"]);
});

test("argv construction: global options first, in order, for every subcommand", () => {
	for (const sub of SUBCOMMANDS) {
		const argv = validateOk(sub, []);
		assert.deepEqual(argv.slice(0, GLOBAL_OPTIONS.length), [...GLOBAL_OPTIONS]);
		assert.equal(argv[GLOBAL_OPTIONS.length], sub);
	}
});

test("argv construction: diff/log/show inject --no-ext-diff/--no-textconv after the subcommand", () => {
	for (const sub of ["diff", "log", "show"] as const) {
		const argv = validateOk(sub, []);
		assert.deepEqual(
			argv.slice(GLOBAL_OPTIONS.length + 1, GLOBAL_OPTIONS.length + 1 + DIFF_LOG_SHOW_OPTIONS.length),
			[...DIFF_LOG_SHOW_OPTIONS],
		);
	}
});

test("argv construction: status argv is exactly globals, status, --porcelain", () => {
	assert.deepEqual(validateOk("status", []), [...GLOBAL_OPTIONS, "status", "--porcelain"]);
});

test("argv construction: user args appended verbatim and in order", () => {
	const argv = validateOk("diff", ["HEAD~1", "--", "src/"]);
	assert.deepEqual(argv, [...GLOBAL_OPTIONS, "diff", ...DIFF_LOG_SHOW_OPTIONS, "HEAD~1", "--", "src/"]);
});

test("valid forms from the design", () => {
	assert.ok(validateOk("diff", ["HEAD~1", "--", "src/"]).length > 0);
	assert.ok(validateOk("log", ["-p", "main...origin/main"]).length > 0);
	assert.ok(validateOk("show", ["HEAD"]).length > 0);
	assert.ok(validateOk("status", []).length > 0);
});

test("diff: dangling range endpoints rejected when combined with another rev or pathspec", () => {
	// git diff exits 129 for all of these; validation rejects them up front.
	for (const args of [
		["--stat", "master...", "HEAD"],
		["--stat", "HEAD", "master..."],
		["master..", "HEAD"],
		["..main", "HEAD"],
		["HEAD...", "docs/"],
		["main...", "main..."] ,
	]) {
		validateRejects("diff", args, "omitted endpoint");
	}
	// A dangling range alone, or followed by the separator and pathspecs, is
	// valid git (empty side defaults to HEAD).
	validateOk("diff", ["--stat", "HEAD..."]);
	validateOk("diff", ["HEAD...", "--", "docs/"]);
	// git log and show accept a dangling range next to another rev.
	validateOk("log", ["--oneline", "HEAD...", "HEAD"]);
	validateOk("show", ["--stat", "HEAD...", "HEAD"]);
});

test("value flags: -U accepted in attached, separate, and --unified= forms within bounds", () => {
	for (const args of [["-U5"], ["-U", "5"], ["--unified=5"], ["-U", "0"], ["-U", "64"], ["--unified=0"], ["--unified=64"]]) {
		validateOk("diff", args);
		validateOk("show", args);
	}
	// Separate form keeps both tokens verbatim.
	const argv = validateOk("diff", ["-U", "5"]);
	assert.ok(argv.includes("-U") && argv.includes("5"));
	// Attached form kept verbatim.
	assert.ok(validateOk("diff", ["-U5"]).includes("-U5"));
});

test("value flags: -n/--max-count accepted within bounds", () => {
	for (const args of [["-n", "1"], ["-n", "10000"], ["--max-count=1"], ["--max-count=100"], ["--max-count=10000"]]) {
		validateOk("log", args);
	}
	assert.ok(validateOk("log", ["-n", "10"]).includes("10"));
});

test("rejections: unknown subcommand names the allowed set", () => {
	validateRejects("push" as GitSubcommand, [], "diff, log, show, status");
	validateRejects("push" as GitSubcommand, [], "unknown subcommand 'push'");
});

test("rejections: unknown flags name the subcommand and its allowed list", () => {
	for (const flag of ["--graph", "-s", "--ext-diff", "--textconv", "--show-signature"]) {
		const result = validateInvocation("diff", [flag]);
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.ok(result.reason.includes("git diff"), flag);
			assert.ok(result.reason.includes("--stat"), flag);
			assert.ok(result.reason.includes("-U<n>"), flag);
		}
	}
	// Cross-subcommand flags are unknown flags for the subcommand.
	validateRejects("diff", ["-p"], "unknown flag '-p' for git diff");
	validateRejects("log", ["--cached"], "unknown flag '--cached' for git log");
	validateRejects("status", ["--no-patch"], "unknown argument '--no-patch' for git status");
	// --show-signature stays off every allowlist even though the format family
	// is now reachable.
	for (const sub of ["log", "show"] as const) {
		validateRejects(sub, ["--show-signature"], "unknown flag '--show-signature'");
	}
});

test("rejections: status accepts only its allowlisted flags", () => {
	for (const args of [["--porcelain"], ["-s"], ["HEAD"], ["--", "src/"]]) {
		const result = validateInvocation("status", args);
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.ok(result.reason.includes("git status"), args.join(" "));
			assert.ok(result.reason.includes("--short"), args.join(" "));
		}
	}
});

test("status allowlisted flags pass through verbatim after hardcoded --porcelain", () => {
	assert.deepEqual(validateOk("status", ["--short"]), [...GLOBAL_OPTIONS, "status", "--porcelain", "--short"]);
	assert.deepEqual(validateOk("status", ["--branch"]), [...GLOBAL_OPTIONS, "status", "--porcelain", "--branch"]);
	assert.deepEqual(validateOk("status", ["--short", "--branch"]), [
		...GLOBAL_OPTIONS,
		"status",
		"--porcelain",
		"--short",
		"--branch",
	]);
});

test("normalizeInvocation: explicit subcommand passes args through unchanged", () => {
	const result = normalizeInvocation({ subcommand: "diff", args: ["HEAD~1", "--", "src/"] });
	assert.ok(result.ok);
	if (result.ok) {
		assert.equal(result.subcommand, "diff");
		assert.deepEqual(result.args, ["HEAD~1", "--", "src/"]);
	}
});

test("normalizeInvocation: args[0] promoted when subcommand is omitted", () => {
	const result = normalizeInvocation({ args: ["status", "--short", "--branch"] });
	assert.ok(result.ok);
	if (result.ok) {
		assert.equal(result.subcommand, "status");
		assert.deepEqual(result.args, ["--short", "--branch"]);
	}
	const bare = normalizeInvocation({ args: ["log"] });
	assert.ok(bare.ok);
	if (bare.ok) {
		assert.equal(bare.subcommand, "log");
		assert.deepEqual(bare.args, []);
	}
});

test("normalizeInvocation: rejects missing subcommand when args[0] is not allowlisted", () => {
	for (const raw of [{}, { args: [] }, { args: ["push"] }, { args: ["--stat"] }]) {
		const result = normalizeInvocation(raw);
		assert.equal(result.ok, false);
		if (!result.ok) assert.ok(result.reason.includes("missing 'subcommand'"));
	}
});

test("normalizeInvocation: rejects explicit unknown subcommand", () => {
	const result = normalizeInvocation({ subcommand: "push", args: [] });
	assert.equal(result.ok, false);
	if (!result.ok) {
		assert.ok(result.reason.includes("unknown subcommand 'push'"));
		assert.ok(result.reason.includes("diff, log, show, status"));
	}
});

test("rejections: absolute paths before and after the separator", () => {
	validateRejects("diff", ["/etc/passwd"], "not a valid rev or pathspec");
	validateRejects("diff", ["HEAD", "--", "/etc/passwd"], "not a valid pathspec");
	validateRejects("log", ["/etc/passwd"]);
});

test("rejections: .. path segments, including bare ..", () => {
	validateRejects("diff", ["../x"]);
	validateRejects("diff", ["a/../b"]);
	validateRejects("diff", [".."]);
	validateRejects("diff", ["HEAD", "--", "../x"], "not a valid pathspec");
	validateRejects("diff", ["HEAD", "--", "a/../b"], "not a valid pathspec");
	validateRejects("diff", ["HEAD", "--", ".."], "not a valid pathspec");
});

test("rejections: backslash separators", () => {
	validateRejects("diff", ["src\\foo.ts"]);
	validateRejects("diff", ["HEAD", "--", "src\\foo.ts"]);
});

test("rejections: leading-dash and empty and whitespace tokens", () => {
	validateRejects("diff", ["-foo"]);
	validateRejects("diff", [""]);
	validateRejects("log", ["HEAD ~1"], "not a valid rev or pathspec");
	validateRejects("diff", ["HEAD", "--", "my file.txt"]);
});

test("rejections: -U/--unified range and format failures", () => {
	validateRejects("diff", ["-U", "65"], "between 0 and 64, got '65'");
	validateRejects("diff", ["--unified=-1"], "between 0 and 64, got '-1'");
	validateRejects("diff", ["--unified=abc"], "between 0 and 64, got 'abc'");
	validateRejects("show", ["-U", "65"]);
});

test("rejections: -n/--max-count range and format failures", () => {
	validateRejects("log", ["-n", "0"], "between 1 and 10000, got '0'");
	validateRejects("log", ["-n", "10001"], "between 1 and 10000, got '10001'");
	validateRejects("log", ["--max-count=abc"], "between 1 and 10000, got 'abc'");
	validateRejects("log", ["-n", "abc"]);
});

test("rejections: missing value for separate-form value flags", () => {
	validateRejects("diff", ["-U"], "flag -U requires an integer value");
	validateRejects("show", ["-U"], "flag -U requires an integer value");
	validateRejects("log", ["-n"], "flag -n requires an integer value");
	// The token after -n is consumed as its value even when it is a flag,
	// so the error names the value instead of misparsing it.
	validateRejects("log", ["-n", "--stat"], "got '--stat'");
});

test("count forms: -n, attached -n<n>, and shorthand -<n> accepted on log and show", () => {
	for (const sub of ["log", "show"] as const) {
		for (const args of [
			["-n", "1"],
			["-n", "10"],
			["-n", "10000"],
			["-n1"],
			["-n10"],
			["-n10000"],
			["-1"],
			["-10"],
			["-10000"],
			["--max-count=1"],
			["--max-count=10000"],
		]) {
			validateOk(sub, args);
		}
		// Every spelling reaches the argv exactly as the caller wrote it.
		assert.ok(validateOk(sub, ["-1"]).includes("-1"));
		assert.ok(validateOk(sub, ["-n5"]).includes("-n5"));
		const separate = validateOk(sub, ["-n", "5"]);
		assert.ok(separate.includes("-n") && separate.includes("5"));
	}
});

test("rejections: count-form bounds, including the shorthand", () => {
	for (const sub of ["log", "show"] as const) {
		validateRejects(sub, ["-0"], "between 1 and 10000, got '0'");
		validateRejects(sub, ["-00"], "between 1 and 10000, got '00'");
		validateRejects(sub, ["-n0"], "between 1 and 10000, got '0'");
		validateRejects(sub, ["-10001"], "between 1 and 10000, got '10001'");
		validateRejects(sub, ["-n10001"], "between 1 and 10000, got '10001'");
		validateRejects(sub, ["--max-count=0"], "between 1 and 10000, got '0'");
		validateRejects(sub, ["--max-count=-1"], "between 1 and 10000, got '-1'");
		validateRejects(sub, ["-n"], "flag -n requires an integer value");
	}
	// The shorthand is a log/show form only.
	validateRejects("diff", ["-1"], "unknown flag '-1' for git diff");
	validateRejects("status", ["-1"], "unknown argument '-1' for git status");
});

test("new boolean flags: log, show, and diff accept their widened sets", () => {
	for (const flag of ["--no-merges", "--first-parent", "--decorate"]) validateOk("log", [flag]);
	for (const flag of ["--no-patch", "-s", "--oneline", "-p", "--patch", "--stat"]) validateOk("show", [flag]);
	for (const flag of ["--check", "-w", "--ignore-all-space"]) validateOk("diff", [flag]);
	// Each reaches the argv verbatim.
	assert.ok(validateOk("diff", ["--check"]).includes("--check"));
	assert.ok(validateOk("log", ["--first-parent"]).includes("--first-parent"));
	assert.ok(validateOk("show", ["-s"]).includes("-s"));
	// They stay unknown on the subcommands that do not carry them.
	validateRejects("diff", ["--no-patch"], "unknown flag '--no-patch' for git diff");
	validateRejects("show", ["--no-merges"], "unknown flag '--no-merges' for git show");
	validateRejects("log", ["--check"], "unknown flag '--check' for git log");
});

test("show: unified-context and count flags coexist", () => {
	const argv = validateOk("show", ["-U5", "-1", "--format=%H", "--date=iso"]);
	for (const token of ["-U5", "-1", "--format=%H", "--date=iso"]) {
		assert.ok(argv.includes(token), token);
	}
});

test("rejections: flags after the separator are invalid pathspecs", () => {
	validateRejects("diff", ["--", "--stat"], "not a valid pathspec");
	validateRejects("diff", ["--", "src/", "--"], "not a valid pathspec");
});

test("separator handling: both paths survive into the argv", () => {
	const argv = validateOk("diff", ["HEAD", "--", "src/", "lib/"]);
	assert.ok(argv.includes("src/"));
	assert.ok(argv.includes("lib/"));
	// Exactly one -- separator, in position.
	const separatorCount = argv.filter((token) => token === "--").length;
	assert.equal(separatorCount, 1);
	assert.equal(argv.indexOf("--"), argv.indexOf("HEAD") + 1);
});

test("safe union: main..next accepted, HEAD:rev:path form accepted", () => {
	validateOk("log", ["main..next"]);
	validateOk("log", ["main...origin/main"]);
	validateOk("show", ["HEAD:src/foo.ts"]);
});

test("safe union: ../x rejected (neither valid rev-path nor pathspec)", () => {
	validateRejects("log", ["../x"]);
});

// ── Format, date, and author value flags ────────────────────────────────────

/** Preset names git resolves before parsing a custom format string. */
const PRETTY_PRESETS = ["oneline", "short", "medium", "full", "fuller", "email", "raw"];

/** The allowlisted `%` sequences, written out independently of validate.ts. */
const FORMAT_SPECIFIERS = [
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
];

/** Date modes git accepts through --date. */
const DATE_FORMATS = [
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
];

/** Signature specifiers: each one runs signature verification. */
const SIGNATURE_SPECIFIERS = ["%G?", "%GG", "%GS", "%GK", "%GF", "%GP", "%GT"];

test("--format/--pretty: presets accepted for both spellings on log and show", () => {
	for (const sub of ["log", "show"] as const) {
		for (const preset of PRETTY_PRESETS) {
			for (const flag of ["--format", "--pretty"]) {
				const token = `${flag}=${preset}`;
				assert.ok(validateOk(sub, [token]).includes(token), `${sub} ${token}`);
			}
		}
	}
});

test("--format: every allowlisted specifier accepted, alone and composed", () => {
	for (const sub of ["log", "show"] as const) {
		for (const specifier of FORMAT_SPECIFIERS) {
			validateOk(sub, [`--format=${specifier}`]);
		}
		validateOk(sub, ["--format=%H%n%an%n%ad%n%s"]);
		validateOk(sub, ["--format=%h %cs %s"]);
		validateOk(sub, ["--format=%H %d %s"]);
		validateOk(sub, ["--format=%H%n%B"]);
		// The scan consumes %% as a unit, so the G? after it is literal text.
		validateOk(sub, ["--format=%%G?"]);
		validateOk(sub, ["--format=%%%%G?"]);
	}
});

test("rejections: a %-free value must be an exact preset name", () => {
	// git resolves a %-free value as a format name and then as a pretty.<name>
	// config alias (prefix-matched, and able to hold any specifier), so only the
	// exact preset names are safe to pass through.
	for (const sub of ["log", "show"] as const) {
		for (const value of ["plain text only", "xsig", "ful", "on", "FuLLer", "oneline "]) {
			validateRejects(sub, [`--format=${value}`], "requires an exact preset name");
			validateRejects(sub, [`--pretty=${value}`], "requires an exact preset name");
		}
		// A value containing % stays a format string, aliases cannot hijack it.
		validateOk(sub, ["--format=%%"]);
	}
});

test("rejections: signature specifiers, alone or embedded", () => {
	for (const sub of ["log", "show"] as const) {
		for (const specifier of SIGNATURE_SPECIFIERS) {
			const result = validateInvocation(sub, [`--format=${specifier}`]);
			assert.equal(result.ok, false, `${sub} ${specifier}`);
			if (!result.ok) {
				assert.ok(result.reason.includes(`'${specifier}'`), result.reason);
				assert.ok(result.reason.includes("signature specifiers run an external program"), result.reason);
				assert.ok(result.reason.includes("use commit fields like %H"), result.reason);
			}
			// Embedded after a valid specifier it must still be found.
			validateRejects(sub, [`--format=%h ${specifier} %s`], `'${specifier}'`);
		}
		// The caller's spelling is preserved in the message.
		validateRejects(sub, ["--pretty=%GG"], "in --pretty:");
	}
});

test("rejections: unsupported format strings name the offending sequence", () => {
	const rejected: Array<[string, string]> = [
		["%(trailers)", "'%('"],
		["%x41", "'%x'"],
		["%Cred%s%Creset", "'%C'"],
		["%w(10)%s", "'%w'"],
		["%<(10)%s", "'%<'"],
		["%>(10)%s", "'%>'"],
		["%Z", "'%Z'"],
		["%a", "'%a'"],
		["%h %", "'%'"],
		["%%%G?", "'%G?'"],
		["%n%G?", "'%G?'"],
		// git's placeholder modifiers reach the signature family too: each of
		// these runs gpg, and `%+G?` prints nothing, so only a rejection keeps
		// them out.
		["%+G?", "'%+'"],
		["%-G?", "'%-'"],
		["% G?", "'% '"],
		["%-GS", "'%-'"],
	];
	for (const [value, expected] of rejected) {
		validateRejects("log", [`--format=${value}`], expected);
		validateRejects("show", [`--format=${value}`], expected);
	}
	// The non-signature offenders get the generic reason, not the gpg one.
	validateRejects("log", ["--format=%x41"], "it is not on the format allowlist");
	validateRejects("log", ["--format=format:%H"], "does not accept a 'format:' prefix");
	validateRejects("show", ["--format=tformat:%H"], "does not accept a 'tformat:' prefix");
});

test("rejections: format value shape (empty, control characters, bare flags)", () => {
	for (const sub of ["log", "show"] as const) {
		validateRejects(sub, ["--format="], "flag --format requires a value");
		validateRejects(sub, ["--pretty="], "flag --pretty requires a value");
		validateRejects(sub, [`--format=%h${String.fromCharCode(1)}%s`], "value contains control characters");
		validateRejects(sub, [`--pretty=%h${String.fromCharCode(9)}%s`], "value contains control characters");
		// Attached form only: git rejects a bare --format, and a bare --pretty
		// means medium, which would reinterpret the next token as a rev.
		validateRejects(sub, ["--format"], "flag --format requires the attached form, e.g. --format=%H");
		validateRejects(sub, ["--format", "%H"], "flag --format requires the attached form");
		validateRejects(sub, ["--pretty"], "flag --pretty requires the attached form, e.g. --pretty=%H");
		validateRejects(sub, ["--pretty", "%H"], "flag --pretty requires the attached form");
	}
});

test("--date: the enum is accepted in both forms on log and show", () => {
	for (const sub of ["log", "show"] as const) {
		for (const value of DATE_FORMATS) {
			assert.ok(validateOk(sub, [`--date=${value}`]).includes(`--date=${value}`));
		}
		const separate = validateOk(sub, ["--date", "iso"]);
		assert.ok(separate.includes("--date") && separate.includes("iso"));
	}
});

test("rejections: --date unknown, empty, free-form, missing, and off-subcommand", () => {
	for (const sub of ["log", "show"] as const) {
		validateRejects(sub, ["--date=bogus"], "requires one of default, relative, local");
		validateRejects(sub, ["--date="], "flag --date requires a value");
		validateRejects(sub, ["--date"], "flag --date requires a value");
		validateRejects(sub, ["--date=format:%s"], "got 'format:%s'");
		validateRejects(sub, ["--date=format-local:%H"], "got 'format-local:%H'");
		// The token after --date is consumed as its value even when it is a flag.
		validateRejects(sub, ["--date", "--stat"], "got '--stat'");
	}
	validateRejects("diff", ["--date=iso"], "unknown flag '--date=iso' for git diff");
	validateRejects("status", ["--date=iso"], "unknown argument '--date=iso' for git status");
});

test("--author: free text accepted in both forms on log", () => {
	for (const value of ["Alice", "Jane Doe", "alice@example.com", "alice.*", "^Alice", "x".repeat(300)]) {
		assert.ok(validateOk("log", [`--author=${value}`]).includes(`--author=${value}`));
	}
	const separate = validateOk("log", ["--author", "Jane Doe"]);
	assert.ok(separate.includes("--author") && separate.includes("Jane Doe"));
});

test("rejections: --author empty, control characters, and non-log subcommands", () => {
	validateRejects("log", ["--author="], "flag --author requires a value");
	validateRejects("log", ["--author"], "flag --author requires a value");
	validateRejects("log", [`--author=a${String.fromCharCode(1)}b`], "value contains control characters");
	validateRejects("show", ["--author=Alice"], "unknown flag '--author=Alice' for git show");
	validateRejects("diff", ["--author=Alice"], "unknown flag '--author=Alice' for git diff");
});

test("boundaries: the new value flags stay unavailable on diff and status", () => {
	for (const flag of ["--format=%H", "--pretty=%H", "--date=iso", "--author=Alice"]) {
		validateRejects("diff", [flag], `unknown flag '${flag}' for git diff`);
		validateRejects("status", [flag], `unknown argument '${flag}' for git status`);
	}
	// --date and --format reach show; --author does not.
	validateOk("show", ["--format=%H", "--date=iso"]);
	validateRejects("show", ["--author=Alice"], "unknown flag '--author=Alice' for git show");
});

test("separator: flag-looking tokens after -- are still pathspecs", () => {
	validateRejects("log", ["--", "--format=%H"], "not a valid pathspec");
	validateRejects("diff", ["--", "-w"], "not a valid pathspec");
	validateRejects("log", ["--", "--author=Alice"], "not a valid pathspec");
});
