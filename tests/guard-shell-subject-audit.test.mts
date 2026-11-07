import assert from "node:assert/strict";
import { test } from "node:test";
import * as rules from "../extensions/guard/policy/rules.ts";
import * as tier from "../extensions/guard/policy/bashtier.ts";
import * as text from "../extensions/guard/policy/shell-text.ts";
import { mergeConfig } from "../extensions/guard/policy/config.ts";
import { analyzeHostCommand } from "../extensions/guard/policy/shellast.ts";
import { explainHostShellCommand } from "../extensions/guard/policy/decision.ts";
import { compileRules, coverageDelta, ruleCoverage, ruleProbes } from "../tools/shell-subject-audit/coverage.mts";

const api = { rules, tier, text };

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
	const raw = { ...analysis, calls: analysis.calls.map((call) => ({ ...call, subject: call.rawSubject })) };
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
