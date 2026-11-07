import assert from "node:assert/strict";
import { test } from "node:test";
import { renderRuleWord } from "../extensions/guard/policy/shell-subject.ts";
import { analyzeHostCommand } from "../extensions/guard/policy/shellast.ts";
import { mergeConfig } from "../extensions/guard/policy/config.ts";
import { explainHostShellCommand, type PolicyState } from "../extensions/guard/policy/decision.ts";
import { planAllowSave, planDenyRules } from "../extensions/guard/policy/save.ts";
import { suggestRule } from "../extensions/guard/policy/suggest.ts";

function marker(source: string): string {
	return `@guard:exp:${Buffer.from(source, "utf8").toString("hex")}`;
}

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

test("literal decoding and expanding words retain their distinct identities", async () => {
	for (const [source, expected] of [
		['custom "$x"', 'custom "$x"'], ['custom $x', 'custom $x'],
		['custom $((1+2))', 'custom $((1+2))'],
		["custom '$x'", "custom '$x'"], ["custom ~/x", `custom ${marker("~/x")}`],
		["custom {a,b}", `custom ${marker("{a,b}")}`], ["custom @(a|b)", `custom ${marker("@(a|b)")}`],
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

test("tilde and quoted parameter-expansion commands are never allow-authorizable; safety spellings keep matching", async () => {
	for (const [command, oldRule, newRule] of [
		['source ~/.nvm/nvm.sh', 'HostBash(source ~/.nvm/nvm.sh)', `HostBash(source ${marker("~/.nvm/nvm.sh")})`],
		['source "$HOME/.nvm/nvm.sh"', 'HostBash(source "$HOME/.nvm/nvm.sh")', 'HostBash(source "$HOME/.nvm/nvm.sh")'],
	] as const) {
		const call = { kind: "host-shell", shell: "host-bash", command } as const;
		const analysis = await analyzeHostCommand(command);
		// Active shell expansion (kind `expanding` or `dynamic`) is ineligible
		// for allow rules, even when a rule textually spells the marker.
		assert.equal(explainHostShellCommand(call, policy({ allow: [oldRule] }), analysis).decision.action, "prompt");
		assert.equal(explainHostShellCommand(call, policy({ allow: [newRule] }), analysis).decision.action, "prompt");
		assert.equal(explainHostShellCommand(call, policy({ deny: [oldRule] }), analysis).decision.action, "deny");
		assert.equal(explainHostShellCommand(call, policy({ deny: [newRule] }), analysis).decision.action, "deny");
	}
});

test("unquoted expansion syntax cannot collide with quoted or escaped literals", async () => {
	for (const [expanding, literals] of [
		["/tmp/*", ["'/tmp/*'", '"/tmp/*"', String.raw`/tmp/\*`]],
		["file?.txt", ["'file?.txt'", String.raw`file\?.txt`]],
		["file[ab]", ["'file[ab]'", String.raw`file\[ab]`]],
		["{a,b}", ["'{a,b}'", String.raw`\{a,b}`]],
		["~/x", ["'~/x'", String.raw`\~/x`]],
		["@(a|b)", ["'@(a|b)'"]],
	] as const) {
		const expanded = await analyzeHostCommand(`custom ${expanding}`);
		assert.equal(expanded.calls[0].chainArgv[1].kind, "expanding", expanding);
		assert.equal(expanded.calls[0].subject, `custom ${marker(expanding)}`);
		for (const literal of literals) {
			const call = { kind: "host-shell", shell: "host-bash", command: `custom ${literal}` } as const;
			const analysis = await analyzeHostCommand(call.command);
			assert.equal(analysis.calls[0].chainArgv[1].kind, "literal", literal);
			assert.notEqual(analysis.calls[0].subject, expanded.calls[0].subject, literal);
			const literalRule = `HostBash(${analysis.calls[0].subject})`;
			assert.equal(explainHostShellCommand(call, policy({ allow: [literalRule] }), analysis).decision.action, "allow", literal);
			const expandedCall = { ...call, command: `custom ${expanding}` };
			assert.equal(explainHostShellCommand(expandedCall, policy({ allow: [literalRule] }), expanded).decision.action, "prompt", expanding);
		}
	}
});

test("tilde is recognized at the start of a word and in assignment values", async () => {
	for (const source of ["~/x", "~user/x"]) {
		assert.equal((await analyzeHostCommand(`custom ${source}`)).calls[0].subject, `custom ${marker(source)}`);
	}
	assert.equal((await analyzeHostCommand("custom v~1")).calls[0].subject, "custom 'v~1'");
	assert.equal((await analyzeHostCommand('custom ""~/x')).calls[0].subject, "custom '~/x'");
	assert.equal((await analyzeHostCommand('X=foo:~/x custom')).calls[0].subject, `X=${marker("foo:~/x")} custom`);
});

test("expansion marker is source-exact, UTF-8 encoded and reserved against forged literal words", async () => {
	for (const source of ["é*", "a\"*\"*", "$HOME/*", "~user/é"]) {
		const analysis = await analyzeHostCommand(`custom ${source}`);
		const encoded = marker(source);
		assert.equal(analysis.calls[0].subject, `custom ${encoded}`, source);
		for (const literalSource of [encoded, `'${encoded}'`, `"${encoded}"`, encoded.toUpperCase()]) {
			const literal = await analyzeHostCommand(`custom ${literalSource}`);
			assert.equal(literal.calls[0].subject, `custom '${literalSource.replace(/^['"]|['"]$/g, "")}'`);
			assert.notEqual(literal.calls[0].subject, analysis.calls[0].subject);
			const call = { kind: "host-shell", shell: "host-bash", command: `custom ${source}` } as const;
			assert.equal(explainHostShellCommand(call, policy({ allow: [`HostBash(${literal.calls[0].subject})`] }), analysis).decision.action, "prompt");
		}
	}
	assert.notEqual(marker("a*"), marker("a'*'*."));
});

test("legacy broad and marker-shaped allow patterns no longer authorize expansion-bearing commands", async () => {
	// The matching grammar is still arbitrary case-insensitive glob/regex, but
	// active-expansion eligibility revokes allow authority for expansion-bearing
	// commands regardless of the pattern; deny and ask keep deciding.
	for (const [command, rule] of [
		["custom *", "HostBash(custom @guard:exp:2a)"],
		["custom ~/localpkg", "HostBash(custom @*)"],
		["custom 'a b' * 'c d'", "HostBash(custom '*')"],
	] as const) {
		const call = { kind: "host-shell", shell: "host-bash", command } as const;
		const analysis = await analyzeHostCommand(command);
		const result = explainHostShellCommand(call, policy({ allow: [rule] }), analysis);
		assert.equal(result.decision.action, "prompt");
		assert.equal(result.decision.matchedRule, undefined);
		assert.match(result.decision.reason, /cannot authorize active shell expansion/);
		assert.equal(explainHostShellCommand(call, policy({ deny: [rule] }), analysis).decision.action, "deny");
		assert.equal(explainHostShellCommand(call, policy({ ask: [rule] }, "yolo"), analysis).decision.provenance, "explicit-ask");
	}
});

test("inert literal spellings stay allow-authorizable while expanding counterparts prompt", async () => {
	// Broad rules keep authorizing literal words; quoted/escaped glob
	// metacharacters and quoted marker-bearing literals are inert.
	for (const [command, rule] of [
		["custom a b", "HostBash(custom *)"],
		["custom 'a b'", "HostBash(custom '*')"],
		["custom '@guard:exp:2a'", "HostBash(custom '@guard:exp:2a')"],
	] as const) {
		const call = { kind: "host-shell", shell: "host-bash", command } as const;
		const analysis = await analyzeHostCommand(command);
		assert.equal(analysis.calls[0].hasActiveExpansion, false, command);
		assert.equal(explainHostShellCommand(call, policy({ allow: [rule] }), analysis).decision.action, "allow", command);
	}
});

test("trusted still allows expansion-bearing commands through the profile cell", async () => {
	const call = { kind: "host-shell", shell: "host-bash", command: "echo $HOME" } as const;
	const analysis = await analyzeHostCommand(call.command);
	assert.equal(explainHostShellCommand(call, policy({ allow: ["HostBash(echo nope)"] }, "trusted"), analysis).decision.action, "allow");
});

test("previous canonical safety subjects survive expansion changes, with rule-first precedence", async () => {
	const command = 'custom "x" /tmp/* && custom "y"';
	const call = { kind: "host-shell", shell: "host-bash", command } as const;
	const analysis = await analyzeHostCommand(command);
	assert.equal(analysis.calls[0].previousSubject, "custom x '/tmp/*'");
	assert.equal(analysis.previousCanonicalJoin, "custom x '/tmp/*' && custom y");
	assert.equal(analysis.canonicalJoin, `custom x ${marker("/tmp/*")} && custom y`);
	for (const slot of ["deny", "ask"] as const) {
		const oldStep = "HostBash(custom x '/tmp/*')";
		const currentStep = `HostBash(custom x ${marker("/tmp/*")})`;
		const oldWhole = "HostBash(custom x '/tmp/*' && custom y)";
		for (const rules of [[oldStep, currentStep], [currentStep, oldStep]]) {
			const result = explainHostShellCommand(call, policy({ [slot]: rules }), analysis);
			assert.equal(result.decision.matchedRule, rules[0]);
			assert.equal(result.decision.action, slot === "deny" ? "deny" : "prompt");
		}
		assert.equal(explainHostShellCommand(call, policy({ [slot]: [oldWhole] }), analysis).decision.matchedRule, oldWhole);
		assert.equal(explainHostShellCommand(call, policy({ [slot]: [oldStep] }, "yolo"), analysis).decision.matchedRule, oldStep);
	}
	assert.equal(explainHostShellCommand(call, policy({ allow: ["HostBash(custom x '/tmp/*')", "HostBash(custom y)"] }), analysis).decision.action, "prompt");
});

test("expansion-aware subjects cover assignments and redirects without weakening redirect gating", async () => {
	const command = 'X=~/x custom > /tmp/* 2>&1';
	const call = { kind: "host-shell", shell: "host-bash", command } as const;
	const analysis = await analyzeHostCommand(command);
	const current = `X=${marker("~/x")} custom > ${marker("/tmp/*")} 2>& 1`;
	const old = "X='~/x' custom > '/tmp/*' 2>& 1";
	assert.equal(analysis.calls[0].subject, current);
	assert.equal(analysis.calls[0].previousSubject, old);
	assert.equal(analysis.calls[0].requiresRedirectAwareAllow, true);
	assert.equal(explainHostShellCommand(call, policy({ allow: ["HostBash(*)"] }), analysis).decision.action, "prompt");
	assert.equal(explainHostShellCommand(call, policy({ allow: [`HostBash(${old})`] }), analysis).decision.action, "prompt");
	// Even a rule textually spelling the current marker subject cannot
	// authorize the step: active expansion is never allow-authorizable.
	assert.equal(explainHostShellCommand(call, policy({ allow: [`HostBash(${current})`] }), analysis).decision.action, "prompt");
	assert.equal(explainHostShellCommand(call, policy({ deny: [`HostBash(${current})`] }), analysis).decision.action, "deny");
	assert.equal(explainHostShellCommand(call, policy({ deny: [`HostBash(${old})`] }), analysis).decision.action, "deny");
	const harmless = await analyzeHostCommand('custom /tmp/* 2>&1');
	assert.equal(harmless.calls[0].allowSubject, `custom ${marker("/tmp/*")}`);
});

test("expanding redirects are unresolved even under a write root", async () => {
	for (const target of ["/allowed/[ab]", "/allowed/{a,b}", "/allowed/*", "/dev/nul[l]"]) {
		const command = `custom > ${target}`;
		const call = { kind: "host-shell", shell: "host-bash", command } as const;
		const analysis = await analyzeHostCommand(command);
		assert.equal(analysis.calls[0].redirects[0].target, null, target);
		const p = policy({ allow: ["HostBash(custom *)"] });
		p.config = { ...p.config, writeRoots: ["/allowed", "/dev"] };
		assert.equal(explainHostShellCommand(call, p, analysis).decision.action, "prompt", target);
		assert.equal(explainHostShellCommand(call, p, analysis).steps[0].requiresRedirectAwareAllow, true, target);
	}
	// Literal bracket names are statically resolved and may be covered by a root.
	const literal = await analyzeHostCommand("custom > '/allowed/[ab]'");
	assert.equal(literal.calls[0].redirects[0].target, "/allowed/[ab]");
});

test("assignment values do not perform pathname or brace expansion", async () => {
	for (const value of ["*", "[ab]", "{a,b}"]) {
		const analysis = await analyzeHostCommand(`X=${value} custom`);
		assert.equal(analysis.calls[0].subject, analysis.calls[0].previousSubject, value);
	}
});

test("encoded source newlines cannot produce allow or deny prefills", async () => {
	const command = 'custom "a\nb"*';
	const call = { kind: "host-shell", shell: "host-bash", command } as const;
	const analysis = await analyzeHostCommand(command);
	assert.ok(!analysis.calls[0].subject!.includes("\n"), "the encoded subject hides the source newline");
	const p = policy();
	const explanation = explainHostShellCommand(call, p, analysis);
	assert.equal(suggestRule(call, p, analysis), null);
	assert.equal(planAllowSave(call, p, explanation, analysis), null);
	assert.deepEqual(planDenyRules(call, explanation, [0]), []);
});

test("source-preserving dynamic words cannot use the reserved prefix", async () => {
	for (const source of ['@guard:exp:$x', '@GUARD:EXP:$"value"']) {
		const analysis = await analyzeHostCommand(`custom ${source}`);
		assert.equal(analysis.calls[0].subject, `custom ''${source}`);
		assert.equal(analysis.calls[0].previousSubject, `custom ${source}`);
	}
});

test("previous safety projection retains old marker literals and incomplete analysis behavior", async () => {
	const call = { kind: "host-shell", shell: "host-bash", command: 'custom "@guard:exp:2a" && custom x' } as const;
	const analysis = await analyzeHostCommand(call.command);
	assert.equal(analysis.calls[0].subject, "custom '@guard:exp:2a'");
	assert.equal(analysis.calls[0].previousSubject, "custom @guard:exp:2a");
	assert.equal(analysis.previousCanonicalJoin, "custom @guard:exp:2a && custom x");
	assert.equal(explainHostShellCommand(call, policy({ deny: ["HostBash(custom @guard:exp:2a)"] }), analysis).decision.action, "deny");
	const incomplete = await analyzeHostCommand('custom $(date) && custom /tmp/*');
	assert.equal(incomplete.calls[0].previousSubject, null);
	assert.equal(incomplete.canonicalJoin, null);
	assert.equal(incomplete.previousCanonicalJoin, null);
	assert.equal(incomplete.calls[1].previousSubject, "custom '/tmp/*'");
});

// Public renderer seam: literal expectations come from the accepted subject contract.
test("literal rule words use one stable shell spelling", () => {
	for (const [value, expected] of [
		["simple", "simple"], ["", "''"], ["two words", "'two words'"],
		["a'b", "'a'\\''b'"], ["~/.pi", "'~/.pi'"], ["$HOME", "'$HOME'"],
		["a\nb", "'a\nb'"], ["{a,b}", "'{a,b}'"], ["*.ts", "'*.ts'"],
		["@guard:exp:2a", "'@guard:exp:2a'"], ["@GUARD:EXP:2A", "'@GUARD:EXP:2A'"],
	] as const) {
		assert.equal(renderRuleWord({ kind: "literal", value, source: value, span: { start: 0, end: 0 } }), expected);
	}
});
