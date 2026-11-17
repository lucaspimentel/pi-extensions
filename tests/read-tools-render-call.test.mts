// Call-row tests for gh_read and git_read (extensions/{gh-read,git-read}/index.ts)
// and for the shared helpers in extensions/shared/read-tool-call.ts.
//
// Network-free: the extensions are registered against a capture stub, and the
// renderers are driven with a role-marking theme so every role is assertable.
// Nothing here spawns a child or reads a config file.
//
// Run: node --test tests/read-tools-render-call.test.mts
import assert from "node:assert/strict";
import { test } from "node:test";

import ghReadExtension from "../extensions/gh-read/index.ts";
import gitReadExtension from "../extensions/git-read/index.ts";
import { joinCallArgs, quoteArg } from "../extensions/shared/read-tool-call.ts";

// ── Harness ──────────────────────────────────────────────────────────────────

interface Component {
	render(width: number): string[];
}

interface RegisteredTool {
	name: string;
	renderCall?: (args: unknown, theme: unknown, context: unknown) => Component;
}

function register(extension: (pi: never) => void): RegisteredTool {
	let captured: RegisteredTool | undefined;
	extension({
		registerTool: (definition: RegisteredTool) => {
			captured = definition;
		},
	} as never);
	assert.ok(captured, "extension must register a tool");
	return captured!;
}

const ghRead = register(ghReadExtension as never);
const gitRead = register(gitReadExtension as never);

/** `fg(role, text)` -> `<role>text</role>`, `bold(text)` -> `**text**`. */
const theme = {
	fg: (role: string, text: string): string => `<${role}>${text}</${role}>`,
	bold: (text: string): string => `**${text}**`,
};

const WIDE = 1000;

function line(tool: RegisteredTool, args: unknown, options: { expanded?: boolean; width?: number } = {}): string {
	assert.ok(typeof tool.renderCall === "function", `${tool.name} must define renderCall`);
	const component = tool.renderCall!(args, theme, { expanded: options.expanded === true });
	return component
		.render(options.width ?? WIDE)
		.map((text) => text.trimEnd())
		.join("\n");
}

const title = (name: string): string => `<toolTitle>**${name}**</toolTitle>`;
const accent = (text: string): string => `<accent>${text}</accent>`;
const value = (text: string): string => `<toolOutput>${text}</toolOutput>`;
const muted = (text: string): string => `<muted>${text}</muted>`;

// ── Titles ───────────────────────────────────────────────────────────────────

test("both tools lead with the raw tool name, bold in toolTitle", () => {
	assert.equal(ghRead.name, "gh_read");
	assert.equal(gitRead.name, "git_read");
	assert.equal(line(ghRead, { subcommand: "auth status" }), `${title("gh_read")} ${accent("auth status")}`);
	assert.equal(line(gitRead, { subcommand: "status" }), `${title("git_read")} ${accent("status")}`);
});

// ── gh_read: native subcommands ──────────────────────────────────────────────

test("a native gh call keeps its argv in order, quoting only what needs quoting", () => {
	assert.equal(
		line(ghRead, { subcommand: "pr list", args: ["--limit", "3", "--state", "all"] }),
		`${title("gh_read")} ${accent("pr list")} ${value("--limit 3 --state all")}`,
	);
	assert.equal(
		line(ghRead, { subcommand: "auth status", args: ["--hostname", "github.com"] }),
		`${title("gh_read")} ${accent("auth status")} ${value("--hostname github.com")}`,
	);
	// An argument holding whitespace is quoted, so the row still reads as a command.
	assert.equal(
		line(ghRead, { subcommand: "pr view", args: ["--body", "hello world"] }),
		`${title("gh_read")} ${accent("pr view")} ${value('--body "hello world"')}`,
	);
	// No argv at all: the operation alone.
	assert.equal(line(ghRead, { subcommand: "pr list" }), `${title("gh_read")} ${accent("pr list")}`);
});

// ── gh_read: API operations ──────────────────────────────────────────────────

test("an API operation names its target in the short form the call used", () => {
	const head = (operation: string): string => `${title("gh_read")} ${accent(operation)}`;
	assert.equal(
		line(ghRead, { subcommand: "repo contents", repo: "o/r", path: "data/dogstatsd" }),
		`${head("repo contents")} ${value("o/r")} ${value("data/dogstatsd")}`,
	);
	// An empty path is the root, not a missing argument.
	assert.equal(line(ghRead, { subcommand: "repo contents", repo: "o/r", path: "" }), `${head("repo contents")} ${value("o/r")}`);
	assert.equal(line(ghRead, { subcommand: "repo tree", repo: "o/r", path: "src" }), `${head("repo tree")} ${value("o/r")} ${value("src")}`);
	assert.equal(line(ghRead, { subcommand: "repo metadata", repo: "o/r" }), `${head("repo metadata")} ${value("o/r")}`);
	assert.equal(
		line(ghRead, { subcommand: "commit checks", repo: "o/r", ref: "main" }),
		`${head("commit checks")} ${value("o/r")} ${muted("@main")}`,
	);
	assert.equal(
		line(ghRead, { subcommand: "check annotations", repo: "o/r", check_run_id: 12345678 }),
		`${head("check annotations")} ${value("o/r 12345678")}`,
	);
	assert.equal(line(ghRead, { subcommand: "advisory view", id: "CVE-2026-1234" }), `${head("advisory view")} ${value("CVE-2026-1234")}`);
	assert.equal(line(ghRead, { subcommand: "org team", org: "DataDog", slug: "serverless" }), `${head("org team")} ${value("DataDog serverless")}`);
	assert.equal(line(ghRead, { subcommand: "pr comments", repo: "o/r", pr: 9623 }), `${head("pr comments")} ${value("o/r#9623")}`);
	assert.equal(line(ghRead, { subcommand: "pr reviews", repo: "o/r", pr: 1 }), `${head("pr reviews")} ${value("o/r#1")}`);
	assert.equal(line(ghRead, { subcommand: "pr threads", repo: "o/r", pr: 2 }), `${head("pr threads")} ${value("o/r#2")}`);
	assert.equal(line(ghRead, { subcommand: "issue comments", repo: "o/r", issue: 42 }), `${head("issue comments")} ${value("o/r#42")}`);
	assert.equal(line(ghRead, { subcommand: "issue timeline", repo: "o/r", issue: 7 }), `${head("issue timeline")} ${value("o/r#7")}`);
	// A batch shows how many targets, never the targets, with a fixed plural.
	assert.equal(line(ghRead, { subcommand: "pr batch", targets: ["o/r#1"] }), `${head("pr batch")} ${value("(1 PRs)")}`);
	assert.equal(line(ghRead, { subcommand: "pr batch", targets: ["a/b#1", "a/b#2", "a/b#3"] }), `${head("pr batch")} ${value("(3 PRs)")}`);
});

// ── gh_read: tags ────────────────────────────────────────────────────────────

test("the tags appear in a fixed order and never carry a raw value", () => {
	const rendered = line(ghRead, {
		subcommand: "pr comments",
		repo: "o/r",
		pr: 5,
		ref: "main",
		account: "lucas",
		jq: ".[] | select(.id == 7)",
		continuation: "eyJ2IjoxfQ.abc",
	});
	assert.equal(
		rendered,
		`${title("gh_read")} ${accent("pr comments")} ${value("o/r#5")} ${muted("@main")} ${muted("[lucas]")} ${muted("(narrowed)")} ${muted("(continuation)")}`,
	);
	assert.ok(!rendered.includes("select(.id"), "the jq expression stays expanded-only");
	assert.ok(!rendered.includes("eyJ2IjoxfQ"), "the continuation token stays expanded-only");
});

test("a one-sided line range is tagged with an explicit trail", () => {
	const head = `${title("gh_read")} ${accent("repo contents")} ${value("o/r")} ${value("a")}`;
	assert.equal(line(ghRead, { subcommand: "repo contents", repo: "o/r", path: "a", start_line: 12, end_line: 40 }), `${head} ${muted(":12-40")}`);
	assert.equal(line(ghRead, { subcommand: "repo contents", repo: "o/r", path: "a", start_line: 12 }), `${head} ${muted(":12-")}`);
	assert.equal(line(ghRead, { subcommand: "repo contents", repo: "o/r", path: "a", end_line: 40 }), `${head} ${muted(":1-40")}`);
});

test("switches that do not change what you are looking at stay off the row", () => {
	const rendered = line(ghRead, {
		subcommand: "pr batch",
		targets: ["a/b#1"],
		fields: ["number", "title"],
		account: "lucas",
	});
	assert.equal(rendered, `${title("gh_read")} ${accent("pr batch")} ${value("(1 PRs)")} ${muted("[lucas]")}`);
	assert.equal(line(ghRead, { subcommand: "repo tree", repo: "o/r", recursive: false }), `${title("gh_read")} ${accent("repo tree")} ${value("o/r")}`);
	assert.equal(line(ghRead, { subcommand: "advisory view", id: "GHSA-1", type: "malware" }), `${title("gh_read")} ${accent("advisory view")} ${value("GHSA-1")}`);
});

// ── git_read ─────────────────────────────────────────────────────────────────

test("git_read renders the command you would type", () => {
	assert.equal(
		line(gitRead, { subcommand: "diff", args: ["HEAD~1", "--", "src/"] }),
		`${title("git_read")} ${accent("diff")} ${value("HEAD~1 -- src/")}`,
	);
	assert.equal(line(gitRead, { subcommand: "log", args: ["--oneline", "-5"] }), `${title("git_read")} ${accent("log")} ${value("--oneline -5")}`);
	// The args-only form names the operation in args[0] and renders it once.
	assert.equal(line(gitRead, { args: ["status", "--branch"] }), `${title("git_read")} ${accent("status")} ${value("--branch")}`);
	// Nothing execution-specific is injected into the display.
	assert.equal(line(gitRead, { subcommand: "show", args: ["HEAD", "--stat"] }), `${title("git_read")} ${accent("show")} ${value("HEAD --stat")}`);
});

// ── Streaming ────────────────────────────────────────────────────────────────

test("a missing primary piece shows an ellipsis, and later values appear as they arrive", () => {
	assert.equal(line(ghRead, {}), `${title("gh_read")} ${value("...")}`);
	assert.equal(line(gitRead, {}), `${title("git_read")} ${value("...")}`);
	// A native call is complete once its operation is known.
	assert.equal(line(ghRead, { subcommand: "pr view" }), `${title("gh_read")} ${accent("pr view")}`);
	assert.equal(line(gitRead, { subcommand: "diff" }), `${title("git_read")} ${accent("diff")}`);
	// An API operation whose target has not arrived marks that slot.
	assert.equal(
		line(ghRead, { subcommand: "pr comments", repo: "o/r" }),
		`${title("gh_read")} ${accent("pr comments")} ${value("o/r")} ${value("...")}`,
	);
	assert.equal(line(ghRead, { subcommand: "advisory view" }), `${title("gh_read")} ${accent("advisory view")} ${value("...")}`);
	assert.equal(line(ghRead, { subcommand: "pr batch" }), `${title("gh_read")} ${accent("pr batch")} ${value("...")}`);
});

test("malformed partial arguments never throw", () => {
	for (const args of [{ subcommand: 42 }, { subcommand: null, args: "nope" }, { subcommand: "pr comments", repo: null }, { args: [1, 2] }, [], "x", null]) {
		assert.equal(typeof line(ghRead, args), "string", `gh_read must render ${JSON.stringify(args)}`);
		assert.equal(typeof line(gitRead, args), "string", `git_read must render ${JSON.stringify(args)}`);
	}
});

// ── Expanded ─────────────────────────────────────────────────────────────────

test("expanded lists every argument in pi's fallback shape", () => {
	assert.equal(
		line(ghRead, { subcommand: "repo contents", repo: "o/r", path: "a", ref: "main", jq: "{a}", start_line: 12, end_line: 40 }, { expanded: true }),
		`${title("gh_read")}\n${muted(
			["  subcommand: repo contents", "  repo: o/r", "  path: a", "  ref: main", "  jq: {a}", "  start_line: 12", "  end_line: 40"].join("\n"),
		)}`,
	);
	// A non-string argument is JSON with two-space indent.
	assert.equal(
		line(gitRead, { subcommand: "diff", args: ["HEAD~1", "--", "src/"] }, { expanded: true }),
		`${title("git_read")}\n${muted('  subcommand: diff\n  args: [\n      "HEAD~1",\n      "--",\n      "src/"\n    ]')}`,
	);
	// `subcommand` leads whatever order the arguments streamed in, and the rest
	// keep their arrival order.
	assert.equal(
		line(gitRead, { args: ["-p", "-n", "30"], subcommand: "log" }, { expanded: true }),
		`${title("git_read")}\n${muted('  subcommand: log\n  args: [\n      "-p",\n      "-n",\n      "30"\n    ]')}`,
	);
	assert.equal(
		line(ghRead, { repo: "o/r", jq: "length", subcommand: "repo metadata" }, { expanded: true }),
		`${title("gh_read")}\n${muted("  subcommand: repo metadata\n  repo: o/r\n  jq: length")}`,
	);
	// A string keeps its own layout, with tabs replaced and CRs dropped.
	assert.equal(
		line(ghRead, { subcommand: "pr list", args: ["--limit\t3"] }, { expanded: true }),
		`${title("gh_read")}\n${muted('  subcommand: pr list\n  args: [\n      "--limit\\t3"\n    ]')}`,
	);
	assert.equal(
		line(ghRead, { subcommand: "repo contents", repo: "o/r", path: "a\tb\rc" }, { expanded: true }),
		`${title("gh_read")}\n${muted("  subcommand: repo contents\n  repo: o/r\n  path: a   bc")}`,
	);
	assert.equal(line(gitRead, null, { expanded: true }), title("git_read"));
});

// ── Wrapping ─────────────────────────────────────────────────────────────────

test("a long row wraps and loses nothing", () => {
	const path = `${"deep/".repeat(40)}file.ts`;
	const expected = `${title("gh_read")} ${accent("repo contents")} ${value("o/r")} ${value(path)}`;
	const strip = (text: string): string => text.replace(/\s+/g, "");
	assert.equal(line(ghRead, { subcommand: "repo contents", repo: "o/r", path }), expected, "a wide row is one line, uncut");
	assert.equal(strip(line(ghRead, { subcommand: "repo contents", repo: "o/r", path }, { width: 40 })), strip(expected), "a narrow row wraps rather than eliding");
	assert.ok(!line(ghRead, { subcommand: "repo contents", repo: "o/r", path }, { width: 40 }).includes("…"));
});

// ── Shared helpers ───────────────────────────────────────────────────────────

test("quoting is minimal and joining preserves order", () => {
	assert.equal(quoteArg("plain"), "plain");
	assert.equal(quoteArg("--limit 3"), '"--limit 3"');
	assert.equal(quoteArg('say "hi"'), '"say \\"hi\\""');
	assert.equal(quoteArg("back\\slash"), '"back\\\\slash"');
	assert.equal(joinCallArgs([]), "");
	assert.equal(joinCallArgs(["diff", "HEAD~1", "--", "src/"]), "diff HEAD~1 -- src/");
});
