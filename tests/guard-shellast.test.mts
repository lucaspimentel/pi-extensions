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

import {
	analyzeHostCommand,
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
