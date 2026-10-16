// Tests for gh-read argument validation (extensions/gh-read/validate.ts).
// Pure unit tests: argv construction for all six subcommands, value-flag
// bounds, the -R regex, --json field shape, --jq and filter token rules,
// positional rules, tool-authored token appending for auth status, and all
// rejections with error-message contents.
//
// Design: docs/gh-read-design.md ("Invocation contract", "Allowlists").
//
// Run: node --test tests/gh-read-validate.test.mts
import assert from "node:assert/strict";
import { test } from "node:test";

import { LIMIT_MAX, SUBCOMMANDS, validateInvocation } from "../extensions/gh-read/validate.ts";

function validateOk(subcommand: (typeof SUBCOMMANDS)[number], args: string[]): string[] {
	const checked = validateInvocation(subcommand, args);
	if (!checked.ok) assert.fail(`unexpected validation failure: ${checked.reason}`);
	return checked.argv;
}

function validateRejects(subcommand: (typeof SUBCOMMANDS)[number], args: string[], includes: string[]): void {
	const checked = validateInvocation(subcommand, args);
	assert.equal(checked.ok, false, `expected rejection for: ${args.join(" ")}`);
	if (!checked.ok) {
		for (const fragment of includes) {
			assert.ok(checked.reason.includes(fragment), `reason '${checked.reason}' must include '${fragment}'`);
		}
	}
}

// ── Subcommand union ─────────────────────────────────────────────────────────

test("subcommand union is the settled six", () => {
	assert.deepEqual([...SUBCOMMANDS], [
		"pr view",
		"pr diff",
		"pr list",
		"issue view",
		"issue list",
		"auth status",
	]);
});

test("unknown subcommands are rejected, naming the allowed set", () => {
	const checked = validateInvocation("pr merge" as never, []);
	assert.equal(checked.ok, false);
	if (!checked.ok) {
		assert.ok(checked.reason.includes("unknown subcommand 'pr merge'"));
		assert.ok(checked.reason.includes("pr view, pr diff, pr list, issue view, issue list, auth status"));
	}
});

// ── Argv construction ────────────────────────────────────────────────────────

test("argv layout: noun, verb, then validated args in input order", () => {
	assert.deepEqual(validateOk("pr list", ["--state", "open", "--limit", "20"]), [
		"pr",
		"list",
		"--state",
		"open",
		"--limit",
		"20",
	]);
	assert.deepEqual(validateOk("issue view", ["123", "--comments"]), ["issue", "view", "123", "--comments"]);
});

test("bare invocations with no args are valid (except issue view)", () => {
	assert.deepEqual(validateOk("pr view", []), ["pr", "view"]);
	assert.deepEqual(validateOk("pr diff", []), ["pr", "diff"]);
	assert.deepEqual(validateOk("pr list", []), ["pr", "list"]);
	assert.deepEqual(validateOk("issue list", []), ["issue", "list"]);
});

test("boolean flags pass through for each subcommand", () => {
	assert.deepEqual(validateOk("pr view", ["-c"]), ["pr", "view", "-c"]);
	assert.deepEqual(validateOk("pr view", ["--comments"]), ["pr", "view", "--comments"]);
	assert.deepEqual(validateOk("pr diff", ["--name-only", "--patch"]), ["pr", "diff", "--name-only", "--patch"]);
	assert.deepEqual(validateOk("pr list", ["--draft"]), ["pr", "list", "--draft"]);
});

test("boolean flags are rejected where not allowlisted", () => {
	validateRejects("pr list", ["--comments"], ["unknown flag '--comments'"]);
	validateRejects("issue list", ["--draft"], ["unknown flag '--draft'"]);
	validateRejects("pr diff", ["-c"], ["unknown flag '-c'"]);
});

// ── Positional rules ─────────────────────────────────────────────────────────

test("pr view/pr diff accept a PR number or branch name", () => {
	assert.deepEqual(validateOk("pr view", ["123"]), ["pr", "view", "123"]);
	assert.deepEqual(validateOk("pr diff", ["lpimentel/feature"]), ["pr", "diff", "lpimentel/feature"]);
});

test("pr view/pr diff reject a second positional and flag-like positionals", () => {
	validateRejects("pr view", ["123", "456"], ["at most 1 positional"]);
	validateRejects("pr diff", ["-x"], ["unknown flag '-x'"]);
	validateRejects("pr view", ["some branch"], ["expected a PR number or branch name"]);
});

test("issue view requires exactly one plain issue number", () => {
	assert.deepEqual(validateOk("issue view", ["42"]), ["issue", "view", "42"]);
	validateRejects("issue view", [], ["requires an issue number"]);
	validateRejects("issue view", ["main"], ["takes an issue number"]);
	validateRejects("issue view", ["https://github.com/o/r/issues/1"], ["takes an issue number"]);
	validateRejects("issue view", ["1", "2"], ["at most 1 positional"]);
});

test("list subcommands take no positional arguments", () => {
	validateRejects("pr list", ["123"], ["takes no positional arguments"]);
	validateRejects("issue list", ["bug"], ["takes no positional arguments"]);
});

// ── -R/--repo ────────────────────────────────────────────────────────────────

test("-R accepts [HOST/]OWNER/REPO on every subcommand", () => {
	assert.deepEqual(validateOk("pr view", ["-R", "owner/repo"]), ["pr", "view", "-R", "owner/repo"]);
	assert.deepEqual(validateOk("issue list", ["--repo", "github.com/owner/repo"]), [
		"issue",
		"list",
		"--repo",
		"github.com/owner/repo",
	]);
	assert.deepEqual(validateOk("pr list", ["-Rowner/repo"]), ["pr", "list", "-R", "owner/repo"]);
});

test("-R rejects flag-shaped, spaced, and malformed values", () => {
	validateRejects("pr view", ["-R", "-x"], ["requires [HOST/]OWNER/REPO"]);
	validateRejects("pr view", ["-R", "owner repo"], ["requires [HOST/]OWNER/REPO"]);
	validateRejects("pr view", ["-R", "owner"], ["requires [HOST/]OWNER/REPO"]);
	validateRejects("pr view", ["-R", "owner/repo/extra/deep"], ["requires [HOST/]OWNER/REPO"]);
});

test("missing -R value is rejected distinctly from an invalid value", () => {
	validateRejects("pr view", ["-R"], ["flag -R requires a value"]);
});

// ── --limit ──────────────────────────────────────────────────────────────────

test("--limit bounds are 1..1000, separate and attached forms", () => {
	assert.deepEqual(validateOk("pr list", ["--limit", "1"]), ["pr", "list", "--limit", "1"]);
	assert.deepEqual(validateOk("pr list", ["-L", "1000"]), ["pr", "list", "-L", "1000"]);
	assert.deepEqual(validateOk("issue list", ["-L50"]), ["issue", "list", "-L", "50"]);
	validateRejects("pr list", ["--limit", "0"], [`between 1 and ${LIMIT_MAX}`]);
	validateRejects("pr list", ["--limit", "1001"], [`between 1 and ${LIMIT_MAX}`]);
	validateRejects("pr list", ["--limit", "abc"], [`between 1 and ${LIMIT_MAX}`]);
	validateRejects("pr list", ["--limit"], ["flag --limit requires a value"]);
});

test("--limit is not a valid flag on view subcommands", () => {
	validateRejects("pr view", ["--limit", "5"], ["unknown flag '--limit'"]);
});

// ── --state and --color value validation ─────────────────────────────────────

test("--state accepts the per-subcommand value sets", () => {
	assert.deepEqual(validateOk("pr list", ["--state", "merged"]), ["pr", "list", "--state", "merged"]);
	assert.deepEqual(validateOk("issue list", ["--state", "closed"]), ["issue", "list", "--state", "closed"]);
});

test("--state rejects invalid and issue-list-only values", () => {
	validateRejects("pr list", ["--state", "bogus"], ["one of open|closed|merged|all"]);
	validateRejects("issue list", ["--state", "merged"], ["one of open|closed|all"]);
	validateRejects("pr list", ["--state"], ["flag --state requires a value"]);
});

test("--color accepts always/never/auto on pr diff only", () => {
	assert.deepEqual(validateOk("pr diff", ["--color", "never"]), ["pr", "diff", "--color", "never"]);
	validateRejects("pr diff", ["--color", "bogus"], ["one of always|never|auto"]);
	validateRejects("pr list", ["--color", "never"], ["unknown flag '--color'"]);
});

// ── --json and --jq ──────────────────────────────────────────────────────────

test("--json accepts comma-separated field names; shape only", () => {
	assert.deepEqual(validateOk("pr view", ["--json", "number,title,state"]), [
		"pr",
		"view",
		"--json",
		"number,title,state",
	]);
	validateRejects("pr view", ["--json", "not a field list"], ["comma-separated list of field names"]);
	validateRejects("pr view", ["--json", ""], ["comma-separated list of field names"]);
});

test("--jq accepts expressions with spaces but rejects control characters and empties", () => {
	assert.deepEqual(validateOk("pr list", ["--jq", ".[] | .title"]), ["pr", "list", "--jq", ".[] | .title"]);
	validateRejects("pr list", ["--jq", ""], ["non-empty jq expression"]);
	validateRejects("pr list", ["--jq", ".a\u0000b"], ["non-empty jq expression"]);
});

// ── Filter tokens ────────────────────────────────────────────────────────────

test("string filters reject leading dashes, whitespace, and empties", () => {
	assert.deepEqual(validateOk("pr list", ["--author", "@me", "--label", "bug"]), [
		"pr",
		"list",
		"--author",
		"@me",
		"--label",
		"bug",
	]);
	validateRejects("pr list", ["--author", "-x"], ["non-empty value without leading '-'"]);
	validateRejects("pr list", ["--author", "some author"], ["non-empty value without leading '-'"]);
	validateRejects("pr list", ["--search"], ["flag --search requires a value"]);
});

test("pr-list-only and issue-list-only value flags are rejected elsewhere", () => {
	validateRejects("issue list", ["--head", "main"], ["unknown flag '--head'"]);
	validateRejects("issue list", ["--base", "main"], ["unknown flag '--base'"]);
	validateRejects("pr list", ["--mention", "me"], ["unknown flag '--mention'"]);
	validateRejects("pr view", ["--label", "bug"], ["unknown flag '--label'"]);
});

// ── Excluded flags stay excluded ─────────────────────────────────────────────

test("--web, --template, and --allow-escape-sequences are never accepted", () => {
	validateRejects("pr view", ["--web"], ["unknown flag '--web'"]);
	validateRejects("pr view", ["-w"], ["unknown flag '-w'"]);
	validateRejects("pr diff", ["--allow-escape-sequences"], ["unknown flag '--allow-escape-sequences'"]);
	validateRejects("issue view", ["--template", "x"], ["unknown flag '--template'"]);
});

// ── Separator and unknown tokens ─────────────────────────────────────────────

test("a literal -- is rejected: gh has no separator concept", () => {
	validateRejects("pr list", ["--"], ["unexpected argument '--'"]);
});

// ── auth status ───────────────────────────────────────────────────────────────

test("auth status: boolean flags pass through and tool-authored --json hosts is appended last", () => {
	assert.deepEqual(validateOk("auth status", ["--active"]), ["auth", "status", "--active", "--json", "hosts"]);
	assert.deepEqual(validateOk("auth status", ["-a"]), ["auth", "status", "-a", "--json", "hosts"]);
});

test("auth status: bare invocation appends --json hosts", () => {
	assert.deepEqual(validateOk("auth status", []), ["auth", "status", "--json", "hosts"]);
});

test("auth status: --hostname and --jq values are validated and kept in input order", () => {
	assert.deepEqual(validateOk("auth status", ["--hostname", "github.com"]), [
		"auth",
		"status",
		"--hostname",
		"github.com",
		"--json",
		"hosts",
	]);
	assert.deepEqual(validateOk("auth status", ["--jq", ".host"]), ["auth", "status", "--jq", ".host", "--json", "hosts"]);
	assert.deepEqual(validateOk("auth status", ["--jq", ".hosts[0].host"]), [
		"auth",
		"status",
		"--jq",
		".hosts[0].host",
		"--json",
		"hosts",
	]);
	assert.deepEqual(validateOk("auth status", ["-a", "--jq", ".hosts | add"]), [
		"auth",
		"status",
		"-a",
		"--jq",
		".hosts | add",
		"--json",
		"hosts",
	]);
});

test("auth status: attached --hostname=value form is accepted", () => {
	assert.deepEqual(validateOk("auth status", ["--hostname=github.com"]), [
		"auth",
		"status",
		"--hostname",
		"github.com",
		"--json",
		"hosts",
	]);
});

test("auth status: tool-authored flags are rejected as user input", () => {
	validateRejects("auth status", ["--json", "hosts"], ["unknown flag '--json'"]);
	validateRejects("auth status", ["--show-token"], ["unknown flag '--show-token'"]);
	validateRejects("auth status", ["--template", "x"], ["unknown flag '--template'"]);
	validateRejects("auth status", ["-R", "owner/repo"], ["unknown flag '-R'"]);
	validateRejects("auth status", ["--repo", "owner/repo"], ["unknown flag '--repo'"]);
	// Attached form of the rejected flag too.
	validateRejects("auth status", ["--json=hosts"], ["unknown flag '--json=hosts'"]);
});

test("auth status: takes no positional arguments", () => {
	validateRejects("auth status", ["github.com"], ["takes no positional arguments"]);
	validateRejects("auth status", ["--"], ["unexpected argument '--'"]);
});

test("auth status: --hostname follows the filter-token rule", () => {
	validateRejects("auth status", ["--hostname"], ["flag --hostname requires a value"]);
	validateRejects("auth status", ["--hostname", ""], ["non-empty value without leading '-'"]);
	validateRejects("auth status", ["--hostname", "-x"], ["non-empty value without leading '-'"]);
	validateRejects("auth status", ["--hostname", "github example"], ["non-empty value without leading '-'"]);
});

test("auth status: --jq follows the existing jq rule", () => {
	validateRejects("auth status", ["--jq", ""], ["non-empty jq expression"]);
	validateRejects("auth status", ["--jq", ".a\u0000b"], ["non-empty jq expression"]);
});

test("auth status: no attached short form for -a", () => {
	validateRejects("auth status", ["-afoo"], ["unknown flag '-afoo'"]);
});
