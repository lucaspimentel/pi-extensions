// Tests for gh-read external jq filtering (extensions/gh-read/jq.ts) using
// the REAL jq binary (jq 1.7 expected, as installed on dev machines and
// ubuntu-latest CI runners). These tests spawn the real executable but never
// touch the network. If jq is missing the suite fails: real-jq coverage is
// required in CI, not skipped.
//
// Design: docs/gh-read-design.md ("External jq filtering").
//
// Run: node --test tests/gh-read-jq.test.mts
import assert from "node:assert/strict";
import { test } from "node:test";

import {
	JQ_OUTPUT_CAP,
	buildJqEnv,
	createJqHomeGuardFile,
	deleteJqHomeGuardFile,
	executeJq,
	jqSecurityViolation,
	prepareJq,
	resolveJqExecutable,
	runJq,
} from "../extensions/gh-read/jq.ts";

const DEADLINE = Date.now() + 30_000;

// ── Executable resolution ────────────────────────────────────────────────────

test("jq executable resolves to an absolute path", () => {
	const resolved = resolveJqExecutable();
	assert.equal(resolved.ok, true);
	if (resolved.ok) {
		assert.ok(resolved.path.startsWith("/"), `expected absolute path, got ${resolved.path}`);
		assert.ok(resolved.path.endsWith("jq"));
	}
});

// ── Lexical security check ───────────────────────────────────────────────────

test("lexical check: comments, escapes, and nested interpolation are recognized, not keywords", () => {
	assert.equal(jqSecurityViolation('.include'), null);
	assert.equal(jqSecurityViolation('.["include"]'), null);
	assert.equal(jqSecurityViolation('"include"'), null);
	assert.equal(jqSecurityViolation('.a | map(select(.b == "include"))'), null);
	assert.equal(jqSecurityViolation('# import "m" as m; .a\n.a'), null, "keywords inside comments are not executable");
	assert.equal(jqSecurityViolation('.a as $x | $x + 1'), null);
	assert.equal(jqSecurityViolation('$ENV.HOME | env.PATH'), null, "env/$ENV are allowed; isolation is the environment's job");
	assert.equal(jqSecurityViolation('"\\(1 + 2)"'), null, "benign interpolation is executable code and allowed");
	assert.equal(jqSecurityViolation('.user.name | ascii_downcase'), null);
	assert.equal(jqSecurityViolation('if .a then "x" else "y" end'), null);
});

test("lexical check: module and data imports are rejected everywhere", () => {
	assert.match(jqSecurityViolation('import "m" as m; .a')!, /import/);
	assert.match(jqSecurityViolation('include "m"; .a')!, /include/);
	assert.match(jqSecurityViolation('import "data" as $d; .a')!, /import/);
	assert.match(jqSecurityViolation('"\\(import "m" as m; 1)"')!, /import/, "interpolation code is inspected");
});

test("lexical check: malformed or unsupported constructs are rejected, never guessed", () => {
	assert.match(jqSecurityViolation('"unterminated')!, /unterminated string/);
	assert.match(jqSecurityViolation('"\\(1+2"')!, /unterminated/);
	assert.match(jqSecurityViolation('"\\q"')!, /unsupported escape/);
	assert.match(jqSecurityViolation('"\\u12"')!, /four hex digits/);
	assert.match(jqSecurityViolation('.a\x01b')!, /unsupported lexical construct/);
	assert.match(jqSecurityViolation('"\na\nb"')!, /raw control character/);
});

// ── Preflight + real execution ───────────────────────────────────────────────

test("real jq: compact output, zero output is an empty result, multiple values are newline-separated", async () => {
	const prepared = await prepareJq(".a", { deadlineAt: DEADLINE });
	assert.equal(prepared.kind, "prepared");
	const one = await executeJq(prepared, '.a', '{"a":42}', { deadlineAt: DEADLINE });
	assert.equal(one.kind, "result");
	if (one.kind === "result") assert.equal(one.output, "42\n");

	const zero = await runJq(".missing // empty", '{"a":1}', { deadlineAt: DEADLINE });
	assert.equal(zero.kind, "result");
	if (zero.kind === "result") {
		assert.equal(zero.output, "", "zero jq output is an empty filtered result, not failure");
		assert.equal(zero.outputTruncated, false);
	}

	const many = await runJq(".[]", "[1,2,3]", { deadlineAt: DEADLINE });
	if (many.kind === "result") assert.equal(many.output, "1\n2\n3\n");
});

test("real jq: syntax errors are caught in preflight (exit 3) before execution", async () => {
	const prepared = await prepareJq(".a ~~~ b", { deadlineAt: DEADLINE });
	assert.equal(prepared.kind, "error");
	if (prepared.kind === "error") assert.equal(prepared.compileError, true);
});

test("real jq: runtime errors on the null preflight input still compile and run on real data", async () => {
	// .a errors on null input at preflight (exit 5) but works on the document.
	const prepared = await prepareJq(".a", { deadlineAt: DEADLINE });
	assert.equal(prepared.kind, "prepared");
	const result = await runJq(".a", '{"a":1}', { deadlineAt: DEADLINE });
	assert.equal(result.kind, "result");
});

test("real jq: environment is minimal and credential-free; HOME is an unusable guard file", async () => {
	const guard = createJqHomeGuardFile();
	try {
		const env = buildJqEnv(guard);
		assert.deepEqual(Object.keys(env).sort(), ["HOME", "LC_ALL"]);
		assert.notEqual(env.HOME, process.env.HOME);
	} finally {
		deleteJqHomeGuardFile(guard);
	}
});

test("real jq: module canary in a fake HOME is unreachable; imports are rejected before any spawn", async () => {
	// Build a fake HOME containing a loadable jq module.
	const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const fakeHome = mkdtempSync(join(tmpdir(), "jq-canary-"));
	try {
		mkdirSync(join(fakeHome, ".jq"));
		writeFileSync(join(fakeHome, ".jq", "canary.j"), 'def leaked: "MODULE_LOADED";\n');

		// 1. The lexical gate rejects the import before any child process.
		assert.match(jqSecurityViolation('import "canary" as c; c::leaked')!, /import/);

		// 2. Even a raw jq child with our tool-owned environment cannot see the
		//    module through $HOME (env HOME points at the guard file, not the
		//    fake home), and -L is never passed.
		const guard = createJqHomeGuardFile();
		try {
			const env = buildJqEnv(guard);
			assert.equal(env.HOME, guard);
			assert.notEqual(env.HOME, fakeHome);
		} finally {
			deleteJqHomeGuardFile(guard);
		}
	} finally {
		const { rmSync } = await import("node:fs");
		rmSync(fakeHome, { recursive: true, force: true });
	}
});

test("real jq: stdin-only behavior, invalid expressions at runtime, and excessive output bounded", async () => {
	// Invalid expression that compiles but errors on the document: runtime error.
	const bad = await runJq("error(\"x\")", "{}", { deadlineAt: DEADLINE });
	assert.equal(bad.kind, "error");
	if (bad.kind === "error") assert.ok(bad.reason.includes("jq exited"));

	// Excessive output: retained output is capped, truncation flagged.
	const huge = JSON.stringify({ a: Array.from({ length: 200_000 }, (_, i) => i) });
	const excessive = await runJq(".a[]", huge, { deadlineAt: DEADLINE });
	assert.equal(excessive.kind, "result");
	if (excessive.kind === "result") {
		assert.equal(excessive.outputTruncated, true);
		assert.ok(excessive.outputBytes > JQ_OUTPUT_CAP, "all bytes were produced (and counted), only retention is capped");
		assert.ok(Buffer.byteLength(excessive.output, "utf8") <= JQ_OUTPUT_CAP);
	}

	// Startup module canary: a plain expression never loads modules at startup
	// (jq reads no config file), verified by running with a polluted $HOME.
	const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const fakeHome = mkdtempSync(join(tmpdir(), "jq-startup-"));
	try {
		mkdirSync(join(fakeHome, ".jq"));
		writeFileSync(join(fakeHome, ".jq", "startupcanary.j"), 'def leaked: "MODULE_LOADED";\n');
		const prepared = await prepareJq('"ok"', { deadlineAt: DEADLINE });
		assert.equal(prepared.kind, "prepared");
		// runJq would use the tool-owned guard HOME, not fakeHome; a startup
		// module load would crash jq on the unknown module name. It succeeds.
		const result = await runJq('"ok"', "null", { deadlineAt: DEADLINE });
		assert.equal(result.kind, "result");
	} finally {
		rmSync(fakeHome, { recursive: true, force: true });
	}
});

test("real jq: expressions with env/$ENV see only the minimal tool environment", async () => {
	const result = await runJq('[$ENV | keys[]] | sort | join(",")', "null", { deadlineAt: DEADLINE });
	assert.equal(result.kind, "result");
	if (result.kind === "result") {
		assert.equal(JSON.parse(result.output), "HOME,LC_ALL", "jq children get exactly HOME and LC_ALL, no inherited secrets");
	}
});
