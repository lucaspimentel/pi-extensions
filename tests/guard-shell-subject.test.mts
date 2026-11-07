import assert from "node:assert/strict";
import { test } from "node:test";
import { renderRuleWord } from "../extensions/guard/policy/shell-subject.ts";
import { analyzeHostCommand } from "../extensions/guard/policy/shellast.ts";
import { mergeConfig } from "../extensions/guard/policy/config.ts";
import { explainHostShellCommand, type PolicyState } from "../extensions/guard/policy/decision.ts";
import { planAllowSave, planDenyRules } from "../extensions/guard/policy/save.ts";
import { suggestRule } from "../extensions/guard/policy/suggest.ts";

function policy(rules: { allow?: string[]; deny?: string[]; ask?: string[] } = {}, profile: PolicyState["profile"] = "default"): PolicyState {
	return { profile, config: mergeConfig({ hostBash: rules }, {}, "/work"), cwd: "/work", sandboxMode: "full", workspaceLocked: false, interactive: true };
}

test("allow rules match canonical subjects only, not literal source quoting", async () => {
	const call = { kind: "host-shell", shell: "host-bash", command: 'custom "arg"' } as const;
	const analysis = await analyzeHostCommand(call.command);
	const canonical = explainHostShellCommand(call, policy({ allow: ["HostBash(custom arg)"] }), analysis);
	assert.equal(canonical.decision.matchedRule, "HostBash(custom arg)");
	const raw = explainHostShellCommand(call, policy({ allow: ['HostBash(custom "arg")'] }), analysis);
	assert.equal(raw.decision.action, "prompt");
	assert.equal(canonical.steps[0].display, 'custom "arg"');
});

test("source projection canonicalizes literal quoting before wrapper unwrapping", async () => {
	const analysis = await analyzeHostCommand('X="two words" command "git" status >"out file" 2>&1');
	assert.equal(analysis.calls[0].subject, "X='two words' command git status > 'out file' 2>& 1");
	assert.equal(analysis.calls[0].rawSubject, 'X="two words" command "git" status >"out file" 2>&1');
	assert.deepEqual(analysis.calls[0].argv, ["git", "status"]);
	assert.deepEqual(analysis.calls[0].chainArgv.map((w) => w.kind === "literal" ? w.value : null), ["command", "git", "status"]);
});

test("harmless canonical redirects are removed from the plain allow subject", async () => {
	const analysis = await analyzeHostCommand('custom "arg" 2>&1');
	assert.equal(analysis.calls[0].subject, "custom arg 2>& 1");
	assert.equal(analysis.calls[0].allowSubject, "custom arg");
});

test("literal decoding and dynamic words follow AST node kinds, not dollar text", async () => {
	for (const [source, expected] of [
		['custom "$x"', 'custom "$x"'], ['custom $x', 'custom $x'],
		['custom $((1+2))', 'custom $((1+2))'],
		["custom '$x'", "custom '$x'"], ["custom ~/x", "custom '~/x'"],
		["custom {a,b}", "custom '{a,b}'"], ["custom @(a|b)", "custom '@(a|b)'"],
		[String.raw`custom a\ b`, "custom 'a b'"],
		[String.raw`custom "a\$b"`, "custom 'a$b'"],
		[String.raw`custom "a\qb"`, String.raw`custom 'a\qb'`],
		["custom ''", "custom ''"], ["X= custom", "X='' custom"],
		['custom "a\nb"', "custom 'a\nb'"],
		["timeout 5 custom 'arg'", "timeout 5 custom arg"],
	] as const) {
		const analysis = await analyzeHostCommand(source);
		assert.equal(analysis.calls[0].subject, expected, source);
	}
	assert.equal((await analyzeHostCommand('custom "$x"')).calls[0].chainArgv[1].kind, "dynamic");
	assert.equal((await analyzeHostCommand("custom '$x'")).calls[0].chainArgv[1].kind, "literal");
});

test("canonical joins retain typed operators and real newlines, but not comments or negation", async () => {
	for (const [source, expected] of [
		['custom "a" && custom \'b\'', "custom a && custom b"],
		['custom "a"\ncustom b', "custom a\ncustom b"],
		['custom \\\n"arg"', "custom arg"],
		['custom a # comment', null], ['# comment\ncustom a', null],
		['custom a\n# tail', null], ['! custom a', null],
		['custom a && ! custom b', null], ['custom $(date)', null],
	] as const) {
		assert.equal((await analyzeHostCommand(source)).canonicalJoin, expected, source);
	}
});

test("source-preserving declarations, arrays and tests retain their accepted completeness", async () => {
	for (const source of ['export X="two words"', 'A=(one "two words")', '[[ a && b ]]']) {
		const analysis = await analyzeHostCommand(source);
		assert.equal(analysis.complete, true, source);
		assert.equal(analysis.calls[0].complete, true, source);
		assert.equal(analysis.calls[0].subject, source);
	}
});

test("UTF-8 spans index the folded source, including after multibyte words", async () => {
	const analysis = await analyzeHostCommand('custom café && custom "é x"');
	assert.deepEqual(analysis.calls[1].sourceSpan, { start: 16, end: 29 });
	assert.equal(analysis.calls[1].chainArgv[1].source, '"é x"');
	assert.equal(analysis.canonicalJoin, "custom café && custom 'é x'");
	assert.deepEqual(JSON.parse(JSON.stringify(analysis)), analysis);
});

test("deny and ask consider both spellings with rule-first identity", async () => {
	for (const slot of ["deny", "ask"] as const) {
		const call = { kind: "host-shell", shell: "host-bash", command: 'custom "arg" && custom b' } as const;
		const analysis = await analyzeHostCommand(call.command);
		const raw = 'HostBash(custom "arg")';
		const canonical = "HostBash(custom arg)";
		for (const rules of [[raw, canonical], [canonical, raw]]) {
			const explanation = explainHostShellCommand(call, policy({ [slot]: rules }), analysis);
			assert.equal(explanation.decision.matchedRule, rules[0]);
			assert.equal(explanation.failingSub, 'custom "arg"');
			assert.equal(explanation.steps[0].rawSubject, 'custom "arg"');
		}
		const joined = "HostBash(custom arg && custom b)";
		assert.equal(explainHostShellCommand(call, policy({ [slot]: [joined] }), analysis).decision.matchedRule, joined);
	}
});

test("incomplete calls retain raw safety matching and permissive-profile precedence", async () => {
	const call = { kind: "host-shell", shell: "host-bash", command: 'custom "$(date)"' } as const;
	const analysis = await analyzeHostCommand(call.command);
	assert.equal(analysis.calls[0].subject, null);
	assert.equal(analysis.calls[0].allowSubject, null);
	assert.equal(explainHostShellCommand(call, policy({ allow: ["HostBash(*)"] }), analysis).decision.action, "prompt");
	assert.equal(explainHostShellCommand(call, policy({}, "yolo"), analysis).decision.action, "allow");
	assert.equal(explainHostShellCommand(call, policy({ ask: ["HostBash(custom *)"] }, "yolo"), analysis).decision.action, "prompt");
	assert.equal(explainHostShellCommand(call, policy({ deny: ["HostBash(custom *)"] }, "yolo"), analysis).decision.action, "deny");
	assert.equal(explainHostShellCommand(call, policy({ deny: ["HostBash(*)"] }, "unrestricted"), analysis).decision.action, "allow");
});

test("suggestions use canonical per-step subjects and refuse multiline saves", async () => {
	for (const command of ['custom "arg"', 'custom "arg" && custom b', 'custom "a\nb"']) {
		const call = { kind: "host-shell", shell: "host-bash", command } as const;
		const analysis = await analyzeHostCommand(command);
		const p = policy();
		const explanation = explainHostShellCommand(call, p, analysis);
		if (command.includes("\n")) {
			assert.equal(planAllowSave(call, p, explanation, analysis), null);
			assert.equal(suggestRule(call, p, analysis), null);
			assert.deepEqual(planDenyRules(call, explanation, [0]), []);
		} else {
			const expected = command.includes("&&") ? ["HostBash(custom arg)", "HostBash(custom b)"] : ["HostBash(custom arg)"];
			assert.deepEqual(suggestRule(call, p, analysis)?.hostBash?.allow, expected);
			const plan = planAllowSave(call, p, explanation, analysis);
			assert.equal(plan?.kind, "per-step");
			if (plan?.kind === "per-step") assert.deepEqual(plan.perStep.map((s) => s.rule), expected);
		}
	}
	const command = 'custom "a\nb"';
	const call = { kind: "host-shell", shell: "host-bash", command } as const;
	const analysis = await analyzeHostCommand(command);
	assert.equal(explainHostShellCommand(call, policy({ allow: ["HostBash(custom *)"] }), analysis).decision.action, "prompt");
	assert.equal(explainHostShellCommand(call, policy({ allow: ["HostBash(/^custom [\\s\\S]*$/)"] }), analysis).decision.action, "allow");
});

test("locale and ANSI-C quoting retain source identity rather than claiming static decoding", async () => {
	for (const source of ['custom $"arg"', String.raw`custom $'\cA'`, String.raw`custom $'\xc3\xa9'`, String.raw`custom prefix$'\n'`]) {
		const analysis = await analyzeHostCommand(source);
		assert.equal(analysis.calls[0].complete, true);
		assert.equal(analysis.calls[0].subject, source);
	}
	const call = { kind: "host-shell", shell: "host-bash", command: 'custom $"arg"' } as const;
	const analysis = await analyzeHostCommand(call.command);
	assert.equal(explainHostShellCommand(call, policy({ allow: ["HostBash(custom arg)"] }), analysis).decision.action, "prompt");
	assert.equal(explainHostShellCommand(call, policy({ allow: ['HostBash(custom $"arg")'] }), analysis).decision.action, "allow");
	const escaped = await analyzeHostCommand(String.raw`custom $'\cA'`);
	const inert = await analyzeHostCommand(String.raw`custom '\cA'`);
	assert.notEqual(escaped.calls[0].subject, inert.calls[0].subject);
});

test("write-root exemptions still strip harmless trailing redirects before plain allows", async () => {
	const call = { kind: "host-shell", shell: "host-bash", command: 'custom >/allowed/out 2>&1' } as const;
	const analysis = await analyzeHostCommand(call.command);
	const p = policy({ allow: ["HostBash(custom > /allowed/out)"] });
	p.config = { ...p.config, writeRoots: ["/allowed"] };
	const explanation = explainHostShellCommand(call, p, analysis);
	assert.equal(explanation.steps[0].requiresRedirectAwareAllow, false);
	assert.equal(explanation.steps[0].allowSubject, "custom > /allowed/out");
	assert.equal(explanation.decision.matchedRule, "HostBash(custom > /allowed/out)");
	assert.deepEqual(suggestRule(call, p, analysis)?.hostBash?.allow, ["HostBash(custom > /allowed/out)"]);
});

test("tilde allow rules migrate while quoted parameter-expansion rules keep matching", async () => {
	for (const [command, oldRule, newRule, expected] of [
		['source ~/.nvm/nvm.sh', 'HostBash(source ~/.nvm/nvm.sh)', "HostBash(source '~/.nvm/nvm.sh')", "prompt"],
		['source "$HOME/.nvm/nvm.sh"', 'HostBash(source "$HOME/.nvm/nvm.sh")', 'HostBash(source "$HOME/.nvm/nvm.sh")', "allow"],
	] as const) {
		const call = { kind: "host-shell", shell: "host-bash", command } as const;
		const analysis = await analyzeHostCommand(command);
		assert.equal(explainHostShellCommand(call, policy({ allow: [oldRule] }), analysis).decision.action, expected);
		assert.equal(explainHostShellCommand(call, policy({ allow: [newRule] }), analysis).decision.matchedRule, newRule);
		assert.equal(explainHostShellCommand(call, policy({ deny: [oldRule] }), analysis).decision.action, "deny");
	}
});

// Public renderer seam: literal expectations come from the accepted subject contract.
test("literal rule words use one stable shell spelling", () => {
	for (const [value, expected] of [
		["simple", "simple"], ["", "''"], ["two words", "'two words'"],
		["a'b", "'a'\\''b'"], ["~/.pi", "'~/.pi'"], ["$HOME", "'$HOME'"],
		["a\nb", "'a\nb'"], ["{a,b}", "'{a,b}'"], ["*.ts", "'*.ts'"],
	] as const) {
		assert.equal(renderRuleWord({ kind: "literal", value, source: value, span: { start: 0, end: 0 } }), expected);
	}
});
