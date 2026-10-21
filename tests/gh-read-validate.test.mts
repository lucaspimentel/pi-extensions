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

import {
	LIMIT_MAX,
	PR_CHECKS_JSON_FIELDS,
	SUBCOMMANDS,
	validateInvocation,
	validateToolParams,
} from "../extensions/gh-read/validate.ts";

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

test("subcommand union is the settled native seven", () => {
	assert.deepEqual([...SUBCOMMANDS], [
		"pr view",
		"pr diff",
		"pr list",
		"pr checks",
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
		assert.ok(
			checked.reason.includes("pr view, pr diff, pr list, pr checks, issue view, issue list, auth status"),
		);
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

test("auth status: user-supplied --json hosts is tolerated and dropped", () => {
	assert.deepEqual(validateOk("auth status", ["--json", "hosts"]), ["auth", "status", "--json", "hosts"]);
	assert.deepEqual(validateOk("auth status", ["--json=hosts"]), ["auth", "status", "--json", "hosts"]);
	assert.deepEqual(validateOk("auth status", ["-a", "--json", "hosts"]), [
		"auth",
		"status",
		"-a",
		"--json",
		"hosts",
	]);
});

test("auth status: user-supplied --json with other fields is rejected with the reason", () => {
	validateRejects("auth status", ["--json", "hostname"], ["only supports fields 'hosts'", "got 'hostname'"]);
	validateRejects("auth status", ["--json"], ["only supports fields 'hosts'", "pass nothing"]);
	validateRejects("auth status", ["--json="], ["only supports fields 'hosts'", "got ''"]);
	validateRejects("auth status", ["--json=hostname"], ["only supports fields 'hosts'", "got 'hostname'"]);
});

test("auth status: other tool-authored flags are rejected as user input", () => {
	validateRejects("auth status", ["--show-token"], ["unknown flag '--show-token'"]);
	validateRejects("auth status", ["--template", "x"], ["unknown flag '--template'"]);
	validateRejects("auth status", ["-R", "owner/repo"], ["unknown flag '-R'"]);
	validateRejects("auth status", ["--repo", "owner/repo"], ["unknown flag '--repo'"]);
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

// ── pr checks (native) ───────────────────────────────────────────────────────

test("pr checks: selector, --required, and --jq pass through and tool-authored --json is appended last", () => {
	assert.deepEqual(validateOk("pr checks", []), [
		"pr",
		"checks",
		"--json",
		PR_CHECKS_JSON_FIELDS,
	]);
	assert.deepEqual(validateOk("pr checks", ["123", "--required"]), [
		"pr",
		"checks",
		"123",
		"--required",
		"--json",
		PR_CHECKS_JSON_FIELDS,
	]);
	assert.deepEqual(validateOk("pr checks", ["-R", "owner/repo", "feature-branch"]), [
		"pr",
		"checks",
		"-R",
		"owner/repo",
		"feature-branch",
		"--json",
		PR_CHECKS_JSON_FIELDS,
	]);
	assert.deepEqual(validateOk("pr checks", ["--jq", ".state"]), [
		"pr",
		"checks",
		"--jq",
		".state",
		"--json",
		PR_CHECKS_JSON_FIELDS,
	]);
	assert.deepEqual(validateOk("pr checks", ["-Rowner/repo", "42"]), [
		"pr",
		"checks",
		"-R",
		"owner/repo",
		"42",
		"--json",
		PR_CHECKS_JSON_FIELDS,
	]);
});

test("pr checks: -R/--repo without a selector is rejected before spawn", () => {
	validateRejects("pr checks", ["-R", "owner/repo"], ["-R/--repo requires a PR number or branch selector"]);
	validateRejects("pr checks", ["--repo", "owner/repo"], ["-R/--repo requires a PR number or branch selector"]);
	validateRejects("pr checks", ["-Rowner/repo"], ["-R/--repo requires a PR number or branch selector"]);
});

test("pr checks: watch/web/interval/fail-fast/template flags and attached forms are unknown", () => {
	validateRejects("pr checks", ["--watch"], ["unknown flag '--watch'"]);
	validateRejects("pr checks", ["-w"], ["unknown flag '-w'"]);
	validateRejects("pr checks", ["--interval", "3"], ["unknown flag '--interval'"]);
	validateRejects("pr checks", ["--fail-fast"], ["unknown flag '--fail-fast'"]);
	validateRejects("pr checks", ["--web"], ["unknown flag '--web'"]);
	validateRejects("pr checks", ["--template", "x"], ["unknown flag '--template'"]);
	validateRejects("pr checks", ["--required=true"], ["unknown flag '--required=true'"]);
});

test("pr checks: caller JSON selection is rejected; exact tool field list tolerated and dropped", () => {
	validateRejects("pr checks", ["--json", "name,state"], ["tool-authored", "caller field selection is rejected"]);
	validateRejects("pr checks", ["--json"], ["tool-authored", "pass nothing"]);
	validateRejects("pr checks", ["--json=name,state"], ["got 'name,state'"]);
	assert.deepEqual(validateOk("pr checks", ["--json", PR_CHECKS_JSON_FIELDS]), [
		"pr",
		"checks",
		"--json",
		PR_CHECKS_JSON_FIELDS,
	]);
	assert.deepEqual(validateOk("pr checks", [`--json=${PR_CHECKS_JSON_FIELDS}`]), [
		"pr",
		"checks",
		"--json",
		PR_CHECKS_JSON_FIELDS,
	]);
});

test("pr checks: positionals follow the PR-number/branch rule", () => {
	validateRejects("pr checks", ["123", "456"], ["at most 1 positional"]);
	validateRejects("pr checks", ["some branch"], ["expected a PR number or branch name"]);
	validateRejects("pr checks", ["--limit", "5"], ["unknown flag '--limit'"]);
});

// ── validateToolParams: discrimination and mixed-shape rejection ─────────────

test("validateToolParams routes native subcommands through the legacy argv contract", () => {
	const checked = validateToolParams({ subcommand: "pr list", args: ["--state", "open"] });
	assert.equal(checked.ok, true);
	if (checked.ok && checked.kind === "native") {
		assert.deepEqual(checked.argv, ["pr", "list", "--state", "open"]);
	} else {
		assert.fail("expected native");
	}
});

test("validateToolParams rejects mixed shapes in both directions", () => {
	for (const bad of [
		{ subcommand: "pr view", repo: "owner/repo" },
		{ subcommand: "auth status", jq: ".x" },
	]) {
		const checked = validateToolParams(bad);
		assert.equal(checked.ok, false, JSON.stringify(bad));
		if (!checked.ok) assert.ok(checked.reason.includes("unknown field"));
	}
	const apiWithArgs = validateToolParams({ subcommand: "repo contents", repo: "o/r", path: "", args: ["-x"] });
	assert.equal(apiWithArgs.ok, false);
	if (!apiWithArgs.ok) assert.ok(apiWithArgs.reason.includes("structured parameters, not an args array"));
});

test("validateToolParams rejects non-object params and unknown subcommands for both families", () => {
	assert.equal(validateToolParams(null).ok, false);
	assert.equal(validateToolParams("pr view").ok, false);
	assert.equal(validateToolParams([]).ok, false);
	const unknown = validateToolParams({ subcommand: "pr merge" });
	assert.equal(unknown.ok, false);
	if (!unknown.ok) {
		assert.ok(unknown.reason.includes("pr view, pr diff, pr list, pr checks, issue view, issue list, auth status"));
		assert.ok(unknown.reason.includes("repo contents, repo tree, commit checks, advisory view"));
	}
});

// ── validateApiInvocation: contract validation ───────────────────────────────

function apiOk(params: Record<string, unknown>): Record<string, unknown> {
	const checked = validateToolParams(params);
	if (!checked.ok) assert.fail(`unexpected rejection: ${checked.reason}`);
	if (checked.kind !== "api") assert.fail("expected api");
	return checked.api as unknown as Record<string, unknown>;
}

function apiRejects(params: Record<string, unknown>, includes: string[]): void {
	const checked = validateToolParams(params);
	assert.equal(checked.ok, false, `expected rejection for: ${JSON.stringify(params)}`);
	if (!checked.ok) {
		for (const fragment of includes) {
			assert.ok(checked.reason.includes(fragment), `reason '${checked.reason}' must include '${fragment}'`);
		}
	}
}

test("repo contents: required repo and path, optional ref/lines/jq accepted", () => {
	assert.deepEqual(apiOk({ subcommand: "repo contents", repo: "owner/repo", path: "" }), {
		ok: true,
		op: "repo contents",
		repo: "owner/repo",
		path: "",
	});
	const withExtras = apiOk({
		subcommand: "repo contents",
		repo: "owner/repo",
		path: "src/main.rs",
		ref: "v1.2.3",
		start_line: 2,
		end_line: 10,
		jq: ".[] | .name",
	});
	assert.deepEqual(withExtras, {
		ok: true,
		op: "repo contents",
		repo: "owner/repo",
		path: "src/main.rs",
		ref: "v1.2.3",
		startLine: 2,
		endLine: 10,
		jq: ".[] | .name",
	});
});

test("repo contents: missing repo/path, host-prefixed repo, and unsafe lines are rejected", () => {
	apiRejects({ subcommand: "repo contents", repo: "owner/repo" }, ["path is required"]);
	apiRejects({ subcommand: "repo contents", path: "a.txt" }, ["repo is required"]);
	apiRejects({ subcommand: "repo contents", repo: "github.com/owner/repo", path: "" }, ["exactly OWNER/REPO on github.com"]);
	apiRejects({ subcommand: "repo contents", repo: "owner", path: "" }, ["exactly OWNER/REPO"]);
	apiRejects({ subcommand: "repo contents", repo: "owner/repo", path: "", start_line: 0 }, ["safe integer >= 1"]);
	apiRejects({ subcommand: "repo contents", repo: "owner/repo", path: "", end_line: 1.5 }, ["safe integer >= 1"]);
	apiRejects({ subcommand: "repo contents", repo: "owner/repo", path: "", start_line: 10, end_line: 2 }, ["start_line (10) must be <= end_line (2)"]);
	apiRejects({ subcommand: "repo contents", repo: "owner/repo", path: "", start_line: Number.MAX_SAFE_INTEGER + 1 }, ["safe integer >= 1"]);
});

test("repo contents/tree: path injection-test inputs are validated", () => {
	// Transportable-literal inputs are accepted (each segment is encoded).
	assert.equal(apiOk({ subcommand: "repo contents", repo: "o/r", path: "a{b}/c%d/e?f/g#h/-i/@j" }).path, "a{b}/c%d/e?f/g#h/-i/@j");
	// Structural rejections.
	apiRejects({ subcommand: "repo contents", repo: "o/r", path: "/abs" }, ["must not start or end with '/'"]);
	apiRejects({ subcommand: "repo contents", repo: "o/r", path: "a/" }, ["must not start or end with '/'"]);
	apiRejects({ subcommand: "repo contents", repo: "o/r", path: "a//b" }, ["empty segments"]);
	apiRejects({ subcommand: "repo contents", repo: "o/r", path: "." }, ["'.' or '..' segments"]);
	apiRejects({ subcommand: "repo contents", repo: "o/r", path: "a/../b" }, ["'.' or '..' segments"]);
	apiRejects({ subcommand: "repo contents", repo: "o/r", path: "a\u0000b" }, ["control characters"]);
	apiRejects({ subcommand: "repo contents", repo: "o/r", path: "a\nb" }, ["control characters"]);
	// Lone surrogates cannot be transported literally.
	const withLoneSurrogate = { subcommand: "repo contents", repo: "o/r", path: "a\uD800b" };
	apiRejects(withLoneSurrogate, ["cannot be transported literally"]);
	// No newline smuggling via percent escapes: '%2F' stays a literal segment
	// (it encodes to '%252F'), so it cannot escape the segment structure.
	assert.equal(apiOk({ subcommand: "repo contents", repo: "o/r", path: "a%2Fb" }).path, "a%2Fb");
});

test("repo tree: recursive must be boolean; ref optional; jq accepted", () => {
	assert.deepEqual(apiOk({ subcommand: "repo tree", repo: "o/r" }), { ok: true, op: "repo tree", repo: "o/r" });
	assert.deepEqual(apiOk({ subcommand: "repo tree", repo: "o/r", recursive: false, path: "src", ref: "main" }), {
		ok: true,
		op: "repo tree",
		repo: "o/r",
		recursive: false,
		path: "src",
		ref: "main",
	});
	apiRejects({ subcommand: "repo tree", repo: "o/r", recursive: "yes" }, ["recursive must be a boolean"]);
});

test("commit checks: ref required; continuation shape validated", () => {
	assert.deepEqual(apiOk({ subcommand: "commit checks", repo: "o/r", ref: "main" }), {
		ok: true,
		op: "commit checks",
		repo: "o/r",
		ref: "main",
	});
	apiRejects({ subcommand: "commit checks", repo: "o/r" }, ["ref"]);
	apiRejects({ subcommand: "commit checks", repo: "o/r", ref: "" }, ["non-empty"]);
	apiRejects({ subcommand: "commit checks", repo: "o/r", ref: "a\u0000b" }, ["control characters"]);
	apiRejects({ subcommand: "commit checks", repo: "o/r", ref: "main", continuation: "!!!" }, ["not base64url"]);
	apiRejects({ subcommand: "commit checks", repo: "o/r", ref: "main", continuation: Buffer.from('{"v":2}').toString("base64url") }, ["unsupported version"]);
	apiRejects({ subcommand: "commit checks", repo: "o/r", ref: "main", continuation: Buffer.from("not json").toString("base64url") }, ["not decodable JSON"]);
	// A structurally valid v1 token is accepted here; semantic matching is api.ts's job.
	const good = apiOk({
		subcommand: "commit checks",
		repo: "o/r",
		ref: "main",
		continuation: Buffer.from(JSON.stringify({ v: 1, op: "commit checks", repo: "o/r", ref: "main", sha: "a".repeat(40), checks: { page: 1, done: true }, statuses: { page: 2, done: false } })).toString("base64url"),
	});
	assert.ok(typeof good.continuation === "string");
});

test("advisory view: exact identifiers only; GHSA rejects type and continuation; CVE types validated", () => {
	assert.deepEqual(apiOk({ subcommand: "advisory view", id: "CVE-2026-111943" }), {
		ok: true,
		op: "advisory view",
		id: "CVE-2026-111943",
	});
	assert.deepEqual(apiOk({ subcommand: "advisory view", id: "GHSA-2345-6789-cfgh" }), {
		ok: true,
		op: "advisory view",
		id: "GHSA-2345-6789-cfgh",
	});
	apiRejects({ subcommand: "advisory view", id: "cve-2026-111943" }, ["exact advisory identifier"]);
	apiRejects({ subcommand: "advisory view", id: "CVE-2026-abc" }, ["exact advisory identifier"]);
	apiRejects({ subcommand: "advisory view", id: "GHSA-0111-2222-3333" }, ["exact advisory identifier"]); // 0/1 not in GHSA alphabet
	apiRejects({ subcommand: "advisory view", id: "GHSA-2345-6789-cfgh", type: "reviewed" }, ["only valid for CVE lookups"]);
	apiRejects({ subcommand: "advisory view", id: "GHSA-2345-6789-cfgh", continuation: "abc" }, ["only valid for CVE searches"]);
	apiRejects({ subcommand: "advisory view", id: "CVE-2026-111943", type: "everything" }, ["reviewed|unreviewed|malware"]);
	assert.equal(apiOk({ subcommand: "advisory view", id: "CVE-2026-111943", type: "malware" }).type, "malware");
});

test("API operations: jq follows the legacy jq rule; unknown fields rejected per operation", () => {
	apiRejects({ subcommand: "repo tree", repo: "o/r", jq: "" }, ["non-empty expression"]);
	apiRejects({ subcommand: "repo tree", repo: "o/r", jq: ".a\u0000b" }, ["control characters"]);
	assert.equal(apiOk({ subcommand: "repo tree", repo: "o/r", jq: '.["include"]' }).jq, '.["include"]');
	apiRejects({ subcommand: "repo contents", repo: "o/r", path: "", recursive: true }, ["unknown field 'recursive'"]);
	apiRejects({ subcommand: "commit checks", repo: "o/r", ref: "main", path: "x" }, ["unknown field 'path'"]);
	apiRejects({ subcommand: "advisory view", id: "CVE-2026-1", repo: "o/r" }, ["unknown field 'repo'"]);
});

test("API operations: full runtime validation applies to schema-bypassing calls", () => {
	// Numbers as strings, nulls, arrays in structured fields all reject.
	apiRejects({ subcommand: "repo contents", repo: 42, path: "" }, ["repo"]);
	apiRejects({ subcommand: "repo contents", repo: "o/r", path: null }, ["must be a string"]);
	apiRejects({ subcommand: "repo tree", repo: "o/r", ref: ["main"] }, ["must be a string"]);
	apiRejects({ subcommand: "advisory view", id: ["CVE-2026-1"] }, ["exact advisory identifier"]);
});
