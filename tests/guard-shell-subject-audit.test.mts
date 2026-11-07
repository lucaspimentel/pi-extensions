import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as rules from "../extensions/guard/policy/rules.ts";
import * as tier from "../extensions/guard/policy/bashtier.ts";
import * as text from "../extensions/guard/policy/shell-text.ts";
import { mergeConfig } from "../extensions/guard/policy/config.ts";
import { analyzeHostCommand } from "../extensions/guard/policy/shellast.ts";
import { explainHostShellCommand } from "../extensions/guard/policy/decision.ts";
import { compileRules, coverageDelta, markerMatchingRules, ruleCoverage, ruleProbes } from "../tools/shell-subject-audit/coverage.mts";

const api = { rules, tier, text };

test("freeze pins an explicit baseline commit independently of the candidate", () => {
	const dir = mkdtempSync(join(tmpdir(), "guard-audit-freeze-"));
	const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	const freeze = fileURLToPath(new URL("../tools/shell-subject-audit/freeze.mts", import.meta.url));
	const run = (...args: string[]) => spawnSync(process.execPath, [freeze, "--config", "config.json", ...args], { cwd: dir, encoding: "utf8" });
	try {
		git("init");
		git("config", "user.name", "Test");
		git("config", "user.email", "test@example.invalid");
		writeFileSync(join(dir, ".gitignore"), "build/\nconfig.json\n");
		writeFileSync(join(dir, "config.json"), "{}");
		writeFileSync(join(dir, "example.txt"), "baseline");
		git("add", ".gitignore", "example.txt");
		git("commit", "-m", "baseline");
		const baseline = git("rev-parse", "HEAD");
		writeFileSync(join(dir, "example.txt"), "committed candidate");
		git("commit", "-am", "candidate");
		writeFileSync(join(dir, "example.txt"), "working candidate");
		const result = run("--out", "build/explicit", "--baseline", baseline.slice(0, 12));
		assert.equal(result.status, 0, result.stderr);
		const manifest = JSON.parse(readFileSync(join(dir, "build/explicit/source-manifest.json"), "utf8"));
		assert.equal(manifest.baselineSha, baseline);
		assert.equal(manifest.baselineRef, baseline.slice(0, 12));
		assert.equal(readFileSync(join(dir, "build/explicit/baseline/example.txt"), "utf8"), "baseline");
		assert.equal(readFileSync(join(dir, "build/explicit/candidate/example.txt"), "utf8"), "working candidate");
		const defaultResult = run("--out", "build/default");
		assert.equal(defaultResult.status, 0, defaultResult.stderr);
		assert.equal(JSON.parse(readFileSync(join(dir, "build/default/source-manifest.json"), "utf8")).baselineSha, git("rev-parse", "HEAD"));
		assert.notEqual(run("--out", "build/invalid", "--baseline", "missing-ref").status, 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("rule probes preserve source spelling and label exact frozen rule origins", () => {
	const probes = ruleProbes({ hostBash: { allow: [
		'HostBash(source "$HOME/init.sh")', 'HostBash(source ~/init.sh)',
		'HostBash(~/tools/check.sh *)', 'HostBash(TZ=* date *)', 'HostBash(/.*~.*/)',
		'HostBash(custom *)', 'HostBash(result=$?)',
	] } }, rules.parseRule);
	assert.deepEqual(probes.map((p) => p.command), ['source "$HOME/init.sh"', 'source ~/init.sh', '~/tools/check.sh', 'result=$?']);
	assert.deepEqual(probes[2].probes, [{ slot: "allow", index: 2, text: 'HostBash(~/tools/check.sh *)' }]);
	assert.ok(probes.every((p) => p.tool === "rule-probe"));
});

test("audit exposes per-rule losses hidden by tier authorization", async () => {
	const command = 'echo "arg"';
	const config = mergeConfig({ hostBash: { allow: ['HostBash(echo "arg")', 'HostBash(echo arg)'] } }, {}, "/work");
	const analysis = await analyzeHostCommand(command);
	const raw = { cause: analysis.cause, calls: analysis.calls.map((call) => ({ ...call, subject: call.rawSubject })) };
	const compiled = compileRules(config, api);
	const before = ruleCoverage(command, raw, config, compiled, api, false);
	const after = ruleCoverage(command, analysis, config, compiled, api, true);
	assert.deepEqual(coverageDelta(before, after), { lost: ["allow:0"], gained: ["allow:1"] });
	assert.deepEqual(before, [{ key: "allow:0", subjects: ['echo "arg"'] }]);
	assert.deepEqual(after, [{ key: "allow:1", subjects: ["echo arg"] }]);
	const policy = { profile: "default", config, cwd: "/work", sandboxMode: "full", workspaceLocked: false, interactive: true } as const;
	assert.equal(explainHostShellCommand({ kind: "host-shell", shell: "host-bash", command }, policy, analysis).decision.action, "allow");
	assert.equal(explainHostShellCommand({ kind: "host-shell", shell: "host-bash", command }, policy, analysis).decision.matchedRule, undefined);
});

test("audit counts shadowed safety matches across raw and canonical spellings", async () => {
	const command = 'custom "arg"';
	const config = mergeConfig({ hostBash: { deny: ["HostBash(*)", 'HostBash(custom "arg")', "HostBash(custom arg)"], ask: ["HostBash(custom arg)"] } }, {}, "/work");
	const analysis = await analyzeHostCommand(command);
	const matches = ruleCoverage(command, analysis, config, compileRules(config, api), api, true);
	assert.deepEqual(matches.map((r) => r.key), ["deny:0", "deny:1", "deny:2", "ask:0"]);
});

test("canonical baseline is detected independently of its side label", async () => {
	const command = 'custom "arg"';
	const config = mergeConfig({ hostBash: { allow: ['HostBash(custom "arg")', 'HostBash(custom arg)'] } }, {}, "/work");
	const analysis = await analyzeHostCommand(command);
	const compiled = compileRules(config, api);
	assert.deepEqual(ruleCoverage(command, analysis, config, compiled, api, false), ruleCoverage(command, analysis, config, compiled, api, true));
	assert.deepEqual(ruleCoverage(command, analysis, config, compiled, api, false).map((r) => r.key), ["allow:1"]);
});

test("previous safety spellings are counted without authorizing allows", () => {
	const command = "raw whole";
	const config = mergeConfig({ hostBash: {
		deny: ["HostBash(raw whole)", "HostBash(new whole)", "HostBash(old whole)", "HostBash(raw step)", "HostBash(new step)", "HostBash(old step)"],
		allow: ["HostBash(old step)", "HostBash(raw step)", "HostBash(new step)"],
	} }, {}, "/work");
	const analysis = { cause: null, canonicalJoin: "new whole", previousCanonicalJoin: "old whole", calls: [
		{ complete: true, subject: "new step", previousSubject: "old step", rawSubject: "raw step", redirects: [] },
	] };
	const matches = ruleCoverage(command, analysis, config, compileRules(config, api), api, true);
	assert.deepEqual(matches.map((r) => r.key), ["deny:0", "deny:1", "deny:2", "deny:3", "deny:4", "deny:5", "allow:2"]);
	const failed = { ...analysis, cause: "grouped" };
	assert.deepEqual(ruleCoverage(command, failed, config, compileRules(config, api), api, true).map((r) => r.key), ["deny:0", "deny:1", "deny:2"]);
});

test("expanding path no longer shares literal allow coverage but keeps prior safety coverage", async () => {
	const rule = "HostBash(custom '/tmp/*')";
	const config = mergeConfig({ hostBash: { allow: [rule], deny: [rule], ask: [rule] } }, {}, "/work");
	for (const [command, allowed] of [["custom '/tmp/*'", true], ["custom /tmp/*", false]] as const) {
		const analysis = await analyzeHostCommand(command);
		const matches = ruleCoverage(command, analysis, config, compileRules(config, api), api, true);
		assert.deepEqual(matches.map((item) => item.key), allowed ? ["deny:0", "ask:0", "allow:0"] : ["deny:0", "ask:0"]);
		assert.equal(analysis.calls[0].previousSubject, "custom '/tmp/*'");
	}
});

test("marker-matching allow rules are reported and exclude non-allow slots", async () => {
	const command = "custom /tmp/*";
	const analysis = await analyzeHostCommand(command);
	const config = mergeConfig({ hostBash: {
		allow: ["HostBash(custom @*)", `HostBash(/^custom ${analysis.calls[0].subject!.split(" ")[1].replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$/)`, "HostBash(custom arg)"],
		deny: ["HostBash(custom @*)"],
	} }, {}, "/work");
	const compiled = compileRules(config, api);
	const matches = markerMatchingRules(analysis, config, compiled, api, true);
	assert.deepEqual(matches.map((r) => r.key), ["allow:0", "allow:1"]);
	assert.ok(matches[0].subjects[0].includes("@guard:exp:"));
	// Legacy candidacy keeps the baseline measurable: with the flag absent the
	// broad rule still counts as allow coverage (the paired comparison then
	// reports the eligibility loss).
	const legacy = { cause: null, calls: [{ complete: true, subject: analysis.calls[0].subject, redirects: [] }] };
	assert.deepEqual(ruleCoverage(command, legacy, config, compiled, api, true).filter((r) => r.key.startsWith("allow")).map((r) => r.key), ["allow:0", "allow:1"]);
	// Non-canonical analyses and non-marker subjects report nothing.
	assert.deepEqual(markerMatchingRules(analysis, config, compiled, api, false), []);
	const literal = await analyzeHostCommand("custom arg");
	assert.deepEqual(markerMatchingRules(literal, config, compiled, api, true), []);
});

test("per-rule coverage agrees with isolated evaluator across redirects and safety spellings", async () => {
	const commands = [
		'custom "arg"', "custom '/tmp/*'", "custom /tmp/*", "custom $value",
		"custom arg > /outside/out", "custom arg > /work/out", "custom arg > /dev/null",
		"custom $(date)", 'custom "arg" && other arg', "for x in a; do custom arg; done",
	];
	const patterns = [
		"HostBash(*)", "HostBash(custom *)", 'HostBash(custom "arg")', "HostBash(custom arg)",
		"HostBash(custom '/tmp/*')", "HostBash(custom * > *)", "HostBash(custom arg > /dev/null)",
		"HostBash(custom $(date))", "HostBash(other arg)",
	];
	for (const command of commands) {
		const analysis = await analyzeHostCommand(command);
		const dynamicPatterns = [analysis.canonicalJoin, analysis.previousCanonicalJoin, analysis.calls[0]?.subject, analysis.calls[0]?.previousSubject]
			.filter((s): s is string => s != null)
			.map((s) => `HostBash(/^${s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$/)`);
		for (const slot of ["deny", "ask", "allow"] as const) for (const rule of [...patterns, ...dynamicPatterns]) {
			const config = mergeConfig({ hostBash: { [slot]: [rule] }, writeRoots: ["/work"] }, {}, "/work");
			const coverage = ruleCoverage(command, analysis, config, compileRules(config, api), api, true);
			const policy = { profile: "default", config, cwd: "/work", sandboxMode: "full", workspaceLocked: false, interactive: true } as const;
			const explanation = explainHostShellCommand({ kind: "host-shell", shell: "host-bash", command }, policy, analysis);
			// A multi-step allow can be shadowed by an earlier prompting step in
			// the aggregate. Inspect each evaluated step as well as the aggregate.
			const matched = explanation.decision.matchedRule === rule || explanation.steps.some((step) => step.decision.matchedRule === rule);
			assert.equal(coverage.some((item) => item.key === `${slot}:0`), matched, `${slot}: ${rule}, command: ${command}`);
		}
	}
});

test("audit does not count incomplete or non-redirect-aware allows", async () => {
	const config = mergeConfig({ hostBash: { allow: ["HostBash(*)", "HostBash(custom * > *)"], deny: ["HostBash(custom *)"] } }, {}, "/work");
	for (const [command, expected] of [
		["custom $(date)", ["deny:0"]],
		["custom arg > /outside/out", ["deny:0", "allow:1"]],
		["for x in a; do custom arg; done", []],
	] as const) {
		const analysis = await analyzeHostCommand(command);
		assert.deepEqual(ruleCoverage(command, analysis, config, compileRules(config, api), api, true).map((r) => r.key), expected, command);
	}
});
