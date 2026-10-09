// Unit tests for git-read argument validation (extensions/git-read/validate.ts).
// Pure module tests: no pi imports, no subprocesses, no filesystem access.
// Covers argv construction, the design's valid forms, value-flag ranges,
// rejections, separator/union handling, and error-message contents.
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
	validateRejects("show", ["-p"], "unknown flag '-p' for git show");
	validateRejects("log", ["--cached"], "unknown flag '--cached' for git log");
});

test("rejections: status takes no arguments, including --porcelain", () => {
	for (const args of [["--porcelain"], ["-s"], ["HEAD"], ["--", "src/"]]) {
		validateRejects("status", args, "git status takes no arguments");
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

test("rejections: -n5 attached form is not on the allowlist", () => {
	validateRejects("log", ["-n5"], "unknown flag '-n5' for git log");
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
