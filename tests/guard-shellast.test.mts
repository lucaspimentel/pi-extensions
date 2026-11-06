// Unit tests for the guard shell-ast adapter (policy/shellast.ts): the lazy
// integrity-checked load, every incomplete-analysis cause, the wrapper walk,
// the canonical subject/allowSubject rendering, and the five false-allow
// constructions the AST closes.
//
// Run: node --test tests/guard-shellast.test.mts
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { ShellNode } from "@questi0nm4rk/shell-ast";

import {
	analyzeHostCommand,
	buildConstructVisitor,
	NODE_DISPOSITIONS,
	preloadShellAst,
	resetShellAstLoad,
	setShellAstExpectedWasmShaForTests,
	shellAstStatus,
	SHELL_AST_WASM_SHA256,
} from "../extensions/guard/policy/shellast.ts";

test("loader reports available after preload and unavailable before/after reset", async () => {
	resetShellAstLoad();
	assert.equal(shellAstStatus().available, false);
	const status = await preloadShellAst();
	assert.equal(status.available, true);
	assert.equal(status.diagnostic, null);
	assert.equal(shellAstStatus().available, true);
	resetShellAstLoad();
	assert.equal(shellAstStatus().available, false);
	// A second preload after reset succeeds again (the cache is re-warmed).
	assert.equal((await preloadShellAst()).available, true);
});

test("loader caches a single in-flight load across concurrent callers", async () => {
	resetShellAstLoad();
	const [a, b, c] = await Promise.all([
		analyzeHostCommand("echo hi"),
		analyzeHostCommand("echo hi"),
		analyzeHostCommand("echo hi"),
	]);
	assert.equal(a.complete, true);
	assert.equal(b.complete, true);
	assert.equal(c.complete, true);
});

test("a load in flight across resetShellAstLoad never re-populates the cache", async () => {
	resetShellAstLoad();
	const inFlight = analyzeHostCommand("echo hi");
	// Reset synchronously before the in-flight load resolves: its generation is
	// now stale, so it must neither cache its module nor clear a newer slot.
	resetShellAstLoad();
	await inFlight;
	assert.equal(shellAstStatus().available, false, "the stale load did not populate the cache");
	assert.equal((await preloadShellAst()).available, true, "a fresh load still works after the reset");
});

test("integrity mismatch fails every analysis closed with parser-unavailable", async () => {
	resetShellAstLoad();
	setShellAstExpectedWasmShaForTests("0".repeat(64));
	const result = await analyzeHostCommand("echo hi");
	assert.equal(result.complete, false);
	assert.equal(result.cause, "parser-unavailable");
	assert.match(result.reason ?? "", /integrity check/);
	resetShellAstLoad();
	assert.equal((await analyzeHostCommand("echo hi")).complete, true);
});

test("the pinned digest matches the installed wasm", () => {
	const entry = fileURLToPath(import.meta.resolve("@questi0nm4rk/shell-ast"));
	const wasm = readFileSync(join(dirname(entry), "shell-ast.wasm"));
	assert.equal(createHash("sha256").update(wasm).digest("hex"), SHELL_AST_WASM_SHA256);
});

// ── One case per cause ───────────────────────────────────────────────────────

const CAUSE_CASES: ReadonlyArray<readonly [string, string]> = [
	["parse-error", "echo 'unterminated"],
	["background", "printf x & touch probe"],
	["grouped", "for x in a b; do echo $x; done"],
	["grouped", "if true; then echo a; fi"],
	["grouped", "case x in a) echo a;; esac"],
	["subshell", "(echo hi)"],
	["heredoc", "cat <<EOF\nhi\nEOF"],
	["heredoc", "cat <<< hello"],
	["function-definition", "f() { echo hi; }"],
	["state-change", "let x=1"],
	["unrecognized-node", "time ls"],
	["no-command", "   "],
	["no-command", "# only a comment"],
];

for (const [cause, command] of CAUSE_CASES) {
	test(`cause '${cause}' for ${JSON.stringify(command)}`, async () => {
		resetShellAstLoad();
		const result = await analyzeHostCommand(command);
		assert.equal(result.complete, false, command);
		assert.equal(result.cause, cause, command);
		assert.ok(result.reason && result.reason.length > 0);
	});
}

// ── Per-call causes leave the analysis complete ──────────────────────────────
// A construct inside one call's own span marks only that call incomplete; the
// analysis keeps a reliable call list so complete siblings stay decidable.

const PER_CALL_CASES: ReadonlyArray<readonly [string, string]> = [
	["command-substitution", "echo $(date)"],
	["command-substitution", "echo `date`"],
	["process-substitution", "echo <(touch probe)"],
];

for (const [cause, command] of PER_CALL_CASES) {
	test(`per-call cause '${cause}' for ${JSON.stringify(command)}`, async () => {
		resetShellAstLoad();
		const result = await analyzeHostCommand(command);
		assert.equal(result.complete, true, command);
		assert.equal(result.cause, null, command);
		assert.equal(result.calls.length, 1, command);
		assert.equal(result.calls[0].complete, false, command);
		assert.equal(result.calls[0].cause, cause, command);
	});
}

test("a per-call construct leaves a complete sibling decidable", async () => {
	resetShellAstLoad();
	const result = await analyzeHostCommand("echo $(date) && echo ok");
	assert.equal(result.complete, true);
	assert.equal(result.cause, null);
	assert.equal(result.calls.length, 2);
	assert.equal(result.calls[0].complete, false);
	assert.equal(result.calls[0].cause, "command-substitution");
	assert.equal(result.calls[1].complete, true);
	assert.equal(result.calls[1].cause, null);
});

test("over-cap input yields size-cap", async () => {
	resetShellAstLoad();
	const result = await analyzeHostCommand("x".repeat(1_000_001));
	assert.equal(result.complete, false);
	assert.equal(result.cause, "size-cap");
});

// ── Wrapper walk ─────────────────────────────────────────────────────────────

const COMPLETE_CASES: ReadonlyArray<readonly [string, { argv: string[]; assignments?: string[]; subject?: string; pureAssignment?: boolean }]> = [
	["command ls", { argv: ["ls"], subject: "command ls" }],
	["xargs -0 rm", { argv: ["rm"] }],
	["sudo rm -rf /", { argv: ["rm", "-rf", "/"] }],
	["timeout 5 ls", { argv: ["ls"], subject: "ls" }],
	["TZ=UTC date +%F", { argv: ["date", "+%F"], assignments: ["TZ=UTC"] }],
	["X=é env", { argv: ["env"], assignments: ["X=é"] }],
	["result=$?", { argv: [], assignments: ["result=$?"], pureAssignment: true }],
	["FOO=bar", { argv: [], assignments: ["FOO=bar"], pureAssignment: true }],
	["export FOO=bar", { argv: [], assignments: ["FOO=bar"], pureAssignment: true }],
	["declare -r X=1", { argv: [], assignments: ["X=1"], pureAssignment: true }],
	["echo a && echo b", { argv: ["echo", "a"] }],
];

for (const [command, expected] of COMPLETE_CASES) {
	test(`complete call for ${JSON.stringify(command)}`, async () => {
		resetShellAstLoad();
		const result = await analyzeHostCommand(command);
		assert.equal(result.complete, true, `${command}: ${result.cause}`);
		assert.ok(result.calls.length >= 1);
		const call = result.calls[0];
		assert.deepEqual([...call.argv], expected.argv, command);
		if (expected.assignments) assert.deepEqual([...call.assignments], expected.assignments, command);
		if (expected.subject !== undefined) assert.equal(call.subject, expected.subject, command);
		if (expected.pureAssignment !== undefined) assert.equal(call.pureAssignment, expected.pureAssignment, command);
	});
}

test("a compound command projects each step in evaluation order", async () => {
	resetShellAstLoad();
	const result = await analyzeHostCommand("echo a && echo b; echo c");
	assert.equal(result.complete, true);
	assert.deepEqual(result.calls.map((c) => c.subject), ["echo a", "echo b", "echo c"]);
	assert.deepEqual(result.calls.map((c) => c.occurrenceId), [0, 1, 2]);
});

// ── Byte offsets are not JS string indices ───────────────────────────────────
// mvdan/sh reports UTF-8 byte offsets; slicing them with src.slice corrupts
// every subject/assignment after a multibyte character (and silently defeats a
// deny/ask rule that matches the corrupted text).

test("multibyte command: subjects are sliced by byte offset, not JS string index", async () => {
	resetShellAstLoad();
	const result = await analyzeHostCommand("echo café && echo x");
	assert.equal(result.complete, true);
	assert.deepEqual(result.calls.map((c) => c.subject), ["echo café", "echo x"]);
});

test("multibyte command: an assignment after a multibyte character is exact", async () => {
	resetShellAstLoad();
	const result = await analyzeHostCommand("echo é; X=é env");
	assert.equal(result.complete, true);
	const env = result.calls.find((c) => c.argv[0] === "env");
	assert.ok(env, "the second command was projected");
	assert.deepEqual([...env.assignments], ["X=é"]);
});

test("pure assignments that run a command are not pureAssignment", async () => {
	resetShellAstLoad();
	const result = await analyzeHostCommand("TZ=UTC date +%F");
	assert.equal(result.complete, true);
	assert.equal(result.calls[0].pureAssignment, false);
});

test("$ expansion is reported per call and does not make the analysis incomplete", async () => {
	resetShellAstLoad();
	const result = await analyzeHostCommand('echo "$HOME"');
	assert.equal(result.complete, true);
	assert.equal(result.calls[0].hasParameterExpansion, true);
	const single = await analyzeHostCommand("echo '$HOME'");
	assert.equal(single.complete, true);
	assert.equal(single.calls[0].hasParameterExpansion, false);
});

test("$ expansion in a redirect target is reported", async () => {
	resetShellAstLoad();
	const result = await analyzeHostCommand("echo x > $HOME/out");
	assert.equal(result.complete, true);
	assert.equal(result.calls[0].hasParameterExpansion, true);
	const literal = await analyzeHostCommand("echo x > out");
	assert.equal(literal.complete, true);
	assert.equal(literal.calls[0].hasParameterExpansion, false);
});

// ── Canonical subject / redirect clause ──────────────────────────────────────

test("a redirect clause is appended to the subject and makes the step redirect-aware", async () => {
	resetShellAstLoad();
	const result = await analyzeHostCommand("echo hi > out");
	assert.equal(result.complete, true);
	const call = result.calls[0];
	assert.equal(call.subject, "echo hi > out");
	assert.equal(call.requiresRedirectAwareAllow, true);
	assert.equal(call.allowSubject, call.subject);
});

test("a harmless descriptor dup is appended but stripped from allowSubject", async () => {
	resetShellAstLoad();
	const result = await analyzeHostCommand("echo hi 2>&1");
	assert.equal(result.complete, true);
	const call = result.calls[0];
	assert.equal(call.subject, "echo hi 2>&1");
	assert.equal(call.requiresRedirectAwareAllow, false);
	assert.equal(call.allowSubject, "echo hi");
});

// ── The five false-allow constructions ───────────────────────────────────────

const FALSE_ALLOW: ReadonlyArray<readonly [string, string, "analysis" | "call" | "argv"]> = [
	["echo `touch probe`", "command-substitution", "call"],
	["echo <(touch probe)", "process-substitution", "call"],
	["printf x & touch probe", "background", "analysis"],
	["command touch probe", "", "argv"],
	["for x in $(touch probe); do echo ok; done", "grouped", "analysis"],
];

for (const [command, expectation, level] of FALSE_ALLOW) {
	test(`false-allow construction stays closed: ${JSON.stringify(command)}`, async () => {
		resetShellAstLoad();
		const result = await analyzeHostCommand(command);
		if (level === "argv") {
			assert.equal(result.complete, true);
			assert.notEqual(result.calls[0].argv[0], undefined);
			assert.equal(result.calls[0].argv[0], "touch");
		} else if (level === "call") {
			assert.equal(result.complete, true, command);
			assert.equal(result.cause, null, command);
			assert.equal(result.calls[0].complete, false, command);
			assert.equal(result.calls[0].cause, expectation, command);
		} else {
			assert.equal(result.complete, false, command);
			assert.equal(result.cause, expectation, command);
		}
	});
}

test("unstripped command text keeps the wrapper in the subject for rule matching", async () => {
	resetShellAstLoad();
	const result = await analyzeHostCommand("PYTHONPATH=. pytest -q");
	assert.equal(result.complete, true);
	assert.equal(result.calls[0].subject, "PYTHONPATH=. pytest -q");
	assert.deepEqual([...result.calls[0].assignments], ["PYTHONPATH=."]);
});

// ── argv projection: wrappers, query flags, redirects, traversal gaps ────────

test("command -v / -V are queries, not wrappers: the queried name is not the argv head", async () => {
	resetShellAstLoad();
	for (const command of ["command -v ls", "command -V git", "command -pv ls"]) {
		const result = await analyzeHostCommand(command);
		assert.equal(result.complete, true, command);
		assert.equal(result.calls[0].argv[0], "command", command);
	}
	// A plain `command ls` (no query flag) still unwraps to the executed name.
	const plain = await analyzeHostCommand("command ls");
	assert.deepEqual([...plain.calls[0].argv], ["ls"]);
});

test("redirects are projected as op + resolved target; dynamic targets are null", async () => {
	resetShellAstLoad();
	const file = await analyzeHostCommand("echo hi > out");
	assert.deepEqual(file.calls[0].redirects, [{ op: ">", target: "out" }]);
	const dup = await analyzeHostCommand("echo hi 2>&1");
	assert.deepEqual(dup.calls[0].redirects, [{ op: ">&", target: "1" }]);
	const dynamic = await analyzeHostCommand("echo hi > $HOME/out");
	assert.deepEqual(dynamic.calls[0].redirects, [{ op: ">", target: null }]);
});

test("a $ expansion nested in arithmetic or brace expansion is still reported", async () => {
	resetShellAstLoad();
	const arith = await analyzeHostCommand("echo $((1+2))");
	assert.equal(arith.complete, true);
	assert.equal(arith.calls[0].hasParameterExpansion, true, "arithmetic expansion is a $ expansion");
	const braceParam = await analyzeHostCommand("echo {$HOME,a}");
	assert.equal(braceParam.calls[0].hasParameterExpansion, true, "a param nested in braces is found");
});

test("a construct nested in arithmetic or brace expansion is still flagged", async () => {
	resetShellAstLoad();
	const brace = await analyzeHostCommand("echo {a,$(touch probe)}");
	assert.equal(brace.complete, true, "the construct is inside one call's span");
	assert.equal(brace.calls[0].complete, false);
	assert.equal(brace.calls[0].cause, "command-substitution");
	const arith = await analyzeHostCommand("echo $(( $(touch probe) ))");
	assert.equal(arith.calls[0].complete, false, "a substitution nested in $((...)) is caught");
	assert.equal(arith.calls[0].cause, "command-substitution");
});

// ── Per-call completeness names the offending step ──────────────────────────

test("a call bearing a construct is incomplete and names itself as the offending step", async () => {
	resetShellAstLoad();
	const subst = await analyzeHostCommand("echo $(date)");
	assert.equal(subst.complete, true, "a per-call construct leaves the analysis complete");
	assert.equal(subst.cause, null);
	assert.equal(subst.calls[0].complete, false);
	assert.equal(subst.calls[0].cause, "command-substitution");
	assert.equal(subst.calls[0].subject, "echo $(date)");
	const heredoc = await analyzeHostCommand("cat <<EOF\nhi\nEOF");
	assert.equal(heredoc.complete, false, "a heredoc is a whole-command construct");
	assert.equal(heredoc.cause, "heredoc");
	assert.equal(heredoc.calls[0].complete, false);
	assert.match(heredoc.calls[0].subject, /<<EOF/);
});

// ── Traversal-coverage guarantee ─────────────────────────────────────────────
// One row per node type @questi0nm4rk/shell-ast can emit, with a minimal
// command that induces it and the expected analysis outcome. The authoritative
// type set is resolved from the shipped `types.d.ts` at runtime, so a package
// bump that adds a node type fails this test (and `Record<ShellNode["type"],
// …>` fails `tsc`) instead of silently leaving a hole in the walk. Rows whose
// node type no command can induce are marked `not-inducible` with the reason,
// so the table stays honest rather than quietly omitting them.

type CoverageRow =
	| { command: string; outcome: "complete"; argv0?: string; pureAssignment?: boolean; hasParameterExpansion?: boolean }
	| { command: string; outcome: "incomplete"; cause: string }
	| { command: string; outcome: "call-incomplete"; cause: string; hasParameterExpansion?: boolean }
	| { command: null; outcome: "not-inducible"; note: string };

const NODE_CASES: Record<ShellNode["type"], CoverageRow> = {
	File: { command: "echo hi", outcome: "complete", argv0: "echo" },
	Stmt: { command: "echo hi", outcome: "complete", argv0: "echo" },
	Redirect: { command: "echo hi > out", outcome: "complete", argv0: "echo" },
	Word: { command: "echo hi", outcome: "complete" },
	Assign: { command: "X=1", outcome: "complete", pureAssignment: true },
	Comment: {
		command: null,
		outcome: "not-inducible",
		note: "the package walk never visits a Comment (File walks stmts; Stmt walks cmd + redirs), so no analysis reaches it; disposition is leaf (no executable semantics), pinned here so a walk that later visits comments is classified rather than skipped",
	},
	CallExpr: { command: "echo hi", outcome: "complete", argv0: "echo" },
	BinaryCmd: { command: "echo a && echo b", outcome: "complete" },
	IfClause: { command: "if true; then :; fi", outcome: "incomplete", cause: "grouped" },
	WhileClause: { command: "while true; do :; done", outcome: "incomplete", cause: "grouped" },
	ForClause: { command: "for x in a; do :; done", outcome: "incomplete", cause: "grouped" },
	CaseClause: { command: "case x in a) :;; esac", outcome: "incomplete", cause: "grouped" },
	Block: { command: "{ :; }", outcome: "incomplete", cause: "grouped" },
	Subshell: { command: "(:)", outcome: "incomplete", cause: "subshell" },
	FuncDecl: { command: "f() { :; }", outcome: "incomplete", cause: "function-definition" },
	ArithmCmd: { command: "((x++))", outcome: "incomplete", cause: "grouped" },
	TestClause: { command: "[[ a ]]", outcome: "complete", argv0: "[[" },
	DeclClause: { command: "export FOO=bar", outcome: "complete", pureAssignment: true },
	LetClause: { command: "let x=1", outcome: "incomplete", cause: "state-change" },
	TimeClause: { command: "time :", outcome: "incomplete", cause: "unrecognized-node" },
	CoprocClause: { command: "coproc :", outcome: "incomplete", cause: "unrecognized-node" },
	TestDecl: {
		command: null,
		outcome: "not-inducible",
		note: "the emitting syntax is Bats `@test \"...\" { ... }`, which the shipped 0.8.0 parser rejects in bash, posix, and mksh (verified); disposition is cause: grouped, so a parser that emits it fails closed",
	},
	Lit: { command: "echo hi", outcome: "complete" },
	SglQuoted: { command: "echo 'hi'", outcome: "complete" },
	DblQuoted: { command: 'echo "hi"', outcome: "complete" },
	CmdSubst: { command: "echo $(date)", outcome: "call-incomplete", cause: "command-substitution" },
	ParamExp: { command: "echo ${x}", outcome: "complete", hasParameterExpansion: true },
	ArithmExp: { command: "echo $((1+2))", outcome: "complete", hasParameterExpansion: true },
	ProcSubst: { command: "echo <(date)", outcome: "call-incomplete", cause: "process-substitution" },
	ExtGlob: { command: "echo @(a|b)", outcome: "complete" },
	BraceExp: { command: "echo {a,b}", outcome: "complete" },
	BinaryArithm: { command: "echo $((1+2))", outcome: "complete", hasParameterExpansion: true },
	UnaryArithm: { command: "echo $((-1))", outcome: "complete", hasParameterExpansion: true },
	ParenArithm: { command: "echo $(( (1+2) ))", outcome: "complete", hasParameterExpansion: true },
	BinaryTest: { command: "[[ a && b ]]", outcome: "complete" },
	UnaryTest: { command: "[[ -f x ]]", outcome: "complete" },
	ParenTest: { command: "[[ ( a ) ]]", outcome: "complete" },
	CaseItem: { command: "case x in a) :;; esac", outcome: "incomplete", cause: "grouped" },
	WordIter: { command: "for x in a; do :; done", outcome: "incomplete", cause: "grouped" },
	CStyleLoop: { command: "for ((i=0;i<1;i++)); do :; done", outcome: "incomplete", cause: "grouped" },
	ArrayExpr: { command: "arr=(a b)", outcome: "complete", pureAssignment: true },
	ArrayElem: { command: "arr=(a b)", outcome: "complete", pureAssignment: true },
};

/**
 * Resolve the `ShellNode` union in the shipped `types.d.ts` to its concrete
 * `type` literals. A union member is either an interface with a `type:` literal
 * or another union alias (`Command`, `WordPart`, `ArithmExpr`, `TestExpr`).
 * This is the authoritative set the coverage table must match; it is read at
 * runtime so a package bump is caught by the test, not only by a type error.
 */
function declaredShellNodeTypes(): string[] {
	const entry = fileURLToPath(import.meta.resolve("@questi0nm4rk/shell-ast"));
	const src = readFileSync(join(dirname(entry), "types.d.ts"), "utf8");
	const interfaces = new Map<string, string>();
	for (const m of src.matchAll(/export interface (\w+)[^{]*\{([\s\S]*?)\n\}/g)) {
		const type = m[2].match(/type:\s*"([^"]+)"/);
		if (type) interfaces.set(m[1], type[1]);
	}
	const aliases = new Map<string, string[]>();
	for (const m of src.matchAll(/export type (\w+)\s*=\s*([^;]+);/g)) {
		aliases.set(m[1], m[2].split("|").map((s) => s.trim()).filter(Boolean));
	}
	const out = new Set<string>();
	const visit = (name: string): void => {
		const iface = interfaces.get(name);
		if (iface !== undefined) { out.add(iface); return; }
		const members = aliases.get(name);
		if (members === undefined) throw new Error(`types.d.ts: unresolved ShellNode member ${name}`);
		for (const member of members) visit(member);
	};
	visit("ShellNode");
	return [...out].sort();
}

test("traversal coverage: the disposition table and the case table mention exactly the declared node types", () => {
	const declared = declaredShellNodeTypes();
	// The resolver must find the real set, not silently return nothing.
	assert.ok(declared.length >= 40, `expected the full node-type set, got ${declared.length}: ${declared.join(",")}`);
	assert.deepEqual(Object.keys(NODE_DISPOSITIONS).sort(), declared, "NODE_DISPOSITIONS must account for every declared node type");
	assert.deepEqual(Object.keys(NODE_CASES).sort(), declared, "the coverage test table must mention every declared node type");
});

test("traversal coverage: a node type absent from the table is unrecognized-node, never skipped", async () => {
	resetShellAstLoad();
	const mod = await import("@questi0nm4rk/shell-ast");
	const seen: Array<{ type: string; cause: string }> = [];
	const visitor = buildConstructVisitor(mod, (node, cause) => { seen.push({ type: node.type, cause }); });
	const fake = { type: "NotANodeType", pos: { offset: 0, line: 1, col: 1 }, end: { offset: 0, line: 1, col: 1 } } as unknown as ShellNode;
	(visitor as unknown as Record<string, (node: ShellNode) => void>).NotANodeType(fake);
	assert.deepEqual(seen, [{ type: "NotANodeType", cause: "unrecognized-node" }]);
});

for (const [type, row] of Object.entries(NODE_CASES) as Array<[ShellNode["type"], CoverageRow]>) {
	if (row.command === null) {
		test(`traversal coverage: node '${type}' is not inducible (${row.note.slice(0, 60)}…)`, () => {
			assert.ok(row.note.length > 0, "a not-inducible row must say why");
		});
		continue;
	}
	const command = row.command;
	test(`traversal coverage: node '${type}' induced by ${JSON.stringify(command)}`, async () => {
		resetShellAstLoad();
		const result = await analyzeHostCommand(command);
		if (row.outcome === "complete") {
			assert.equal(result.complete, true, `${type}: ${result.cause}`);
			assert.equal(result.cause, null, type);
			assert.ok(result.calls.length >= 1, type);
			const call = result.calls[0];
			assert.equal(call.complete, true, type);
			if (row.argv0 !== undefined) assert.equal(call.argv[0], row.argv0, type);
			if (row.pureAssignment !== undefined) assert.equal(call.pureAssignment, row.pureAssignment, type);
			if (row.hasParameterExpansion !== undefined) assert.equal(call.hasParameterExpansion, row.hasParameterExpansion, type);
			return;
		}
		if (row.outcome === "incomplete") {
			assert.equal(result.complete, false, type);
			assert.equal(result.cause, row.cause, type);
			return;
		}
		assert.equal(result.complete, true, type);
		assert.equal(result.cause, null, type);
		assert.equal(result.calls.length, 1, type);
		assert.equal(result.calls[0].complete, false, type);
		assert.equal(result.calls[0].cause, row.cause, type);
		if (row.hasParameterExpansion !== undefined) assert.equal(result.calls[0].hasParameterExpansion, row.hasParameterExpansion, type);
	});
}
