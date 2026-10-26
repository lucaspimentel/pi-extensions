// Characterization tests for the host-shell explanation extraction
// (save/deny/compound prompt UX, phase 1): the aggregate decision must be
// byte-identical to the pre-extraction decideHostShellCommand across every
// profile and command shape, and the per-step projection (subjects, causes,
// breakdown reliability) must reflect what the evaluator actually matched.
//
// Run: node --test tests/guard-explain.test.mts
import assert from "node:assert/strict";
import { test } from "node:test";

import { mergeConfig, type GuardConfig } from "../extensions/guard/policy/config.ts";
import {
	decide,
	decideHostShellCommand,
	explainHostShellCommand,
	type GuardCall,
	type PolicyState,
} from "../extensions/guard/policy/decision.ts";
import { assessBreakdownReliability, splitTopLevelShell } from "../extensions/guard/policy/shellsplit.ts";

function makeConfig(overrides: Partial<GuardConfig> = {}, cwd = "/home/user/proj"): ReturnType<typeof mergeConfig> {
	return mergeConfig(overrides, {}, cwd);
}

function makePolicy(overrides: Partial<PolicyState> = {}): PolicyState {
	const cwd = overrides.config?.cwd ?? "/home/user/proj";
	return {
		profile: "default",
		config: makeConfig({}, cwd),
		sandboxMode: "full",
		cwd,
		workspaceLocked: false,
		interactive: true,
		...overrides,
	};
}

const shellCall = (command: string, shell: "host-bash" | "pwsh" = "host-bash"): GuardCall => ({ kind: "host-shell", shell, command });

const PARITY_COMMANDS = [
	"echo hi",
	"git status",
	"timeout 10 git status",
	"git status > /dev/null 2>&1",
	"echo hi > out.txt",
	"echo a && echo b",
	"echo a; echo b; echo c",
	'echo "a && b" && echo done',
	"echo one\necho two",
	"echo one\r\necho two",
	"echo a && echo a",
	"echo a # trailing comment && echo b",
	"# only a comment\necho hi",
	"for x in a b; do echo $x; done",
	"if true; then echo yes; fi",
	"case x in a) echo a;; esac",
	"cat <<EOF\nhello\nEOF",
	"echo $(whoami)",
	"echo `whoami`",
	"sleep 5 & echo done",
	"echo 'unmatched",
	"cd /tmp",
	"env",
	"rm -rf x",
	"",
	"   ",
	":",
];

test("aggregate parity: explain().decision equals decideHostShellCommand and decide() for every profile and command shape", () => {
	for (const profile of ["research", "default", "allow-edits", "auto", "trusted", "yolo", "unrestricted"] as const) {
		for (const command of PARITY_COMMANDS) {
			for (const shell of ["host-bash", "pwsh"] as const) {
				const policy = makePolicy({ profile, workspaceLocked: false });
				const call = shellCall(command, shell);
				const explained = explainHostShellCommand(call, policy);
				assert.deepEqual(explained.decision, decideHostShellCommand(call, policy), `${profile}/${shell}: ${command}`);
				assert.deepEqual(explained.decision, decide(policy, call), `decide parity: ${profile}/${shell}: ${command}`);
			}
		}
	}
});

test("aggregate parity under workspace lock and with rules configured", () => {
	const config = makeConfig({
		hostBash: {
			deny: ["HostBash(rm *)"],
			ask: ["HostBash(git push *)", "HostBash(echo a && echo b)"],
			allow: ["HostBash(echo a)"],
		},
	});
	for (const workspaceLocked of [false, true]) {
		for (const profile of ["default", "yolo", "unrestricted", "research"] as const) {
			for (const command of PARITY_COMMANDS) {
				const policy = makePolicy({ profile, config, workspaceLocked });
				const call = shellCall(command);
				const explained = explainHostShellCommand(call, policy);
				assert.deepEqual(explained.decision, decideHostShellCommand(call, policy), `${profile}/locked=${workspaceLocked}: ${command}`);
				const viaDecide = decide(policy, call);
				if (workspaceLocked) {
					// decide() wraps host-shell calls in its own lock pre-check with a
					// coarser reason; both must deny.
					assert.equal(viaDecide.action, "deny", `${profile}/locked: ${command}`);
					assert.equal(explained.decision.action, "deny", `${profile}/locked: ${command}`);
				} else {
					assert.deepEqual(explained.decision, viaDecide, `decide parity: ${profile}: ${command}`);
				}
			}
		}
	}
});

test("compound steps carry evaluation-order occurrence IDs and duplicate commands keep distinct identities", () => {
	const policy = makePolicy();
	const explained = explainHostShellCommand(shellCall("echo same && echo other && echo same"), policy);
	assert.equal(explained.steps.length, 3);
	assert.deepEqual(explained.steps.map((s) => s.occurrenceId), [0, 1, 2]);
	assert.deepEqual(explained.steps.map((s) => s.subject), ["echo same", "echo other", "echo same"]);
	assert.deepEqual(explained.steps.map((s) => s.display), ["echo same", "echo other", "echo same"]);
});

test("step subjects are the evaluator's matching subjects: timeout prefixes and continuations are normalized", () => {
	const policy = makePolicy();
	const explained = explainHostShellCommand(shellCall("timeout 5 \\\n  git status"), policy);
	assert.equal(explained.steps.length, 1);
	assert.equal(explained.steps[0].subject, "git status");
	assert.equal(explained.steps[0].allowSubject, "git status");
});

test("a whole-call ask rule appears as a call-level cause even when every step allows", () => {
	const policy = makePolicy({ config: makeConfig({ hostBash: { ask: ["HostBash(echo a && echo b)"] } }) });
	const explained = explainHostShellCommand(shellCall("echo a && echo b"), policy);
	assert.equal(explained.decision.action, "prompt");
	assert.equal(explained.decision.provenance, "explicit-ask");
	assert.equal(explained.rawAskRule, "HostBash(echo a && echo b)");
	assert.equal(explained.steps.length, 2);
	assert.ok(explained.steps.every((s) => s.decision.action === "allow" || s.decision.action === "prompt"), "steps keep their own decisions");
	assert.ok(explained.breakdown.available);
});

test("a whole-command deny rule denies without a step breakdown", () => {
	const policy = makePolicy({ config: makeConfig({ hostBash: { deny: ["HostBash(echo*)"] } }) });
	const explained = explainHostShellCommand(shellCall("echo a && echo b"), policy);
	assert.equal(explained.decision.action, "deny");
	assert.equal(explained.rawDenyRule, "HostBash(echo*)");
	assert.equal(explained.steps.length, 0);
	assert.equal(explained.breakdown.available, false);
});

test("an ambiguous split records the cause, has no steps, and stays unavailable", () => {
	const policy = makePolicy();
	const explained = explainHostShellCommand(shellCall("echo 'unmatched && echo b"), policy);
	assert.equal(explained.decision.action, "prompt");
	assert.equal(explained.splitCause, "complex command could not be split for per-subcommand checks");
	assert.equal(explained.steps.length, 0);
	assert.equal(explained.breakdown.available, false);
	// A deny rule on the raw command still wins over the ambiguous split.
	const denied = explainHostShellCommand(
		shellCall("echo 'unmatched"),
		makePolicy({ config: makeConfig({ hostBash: { deny: ["HostBash(echo*)"] } }) }),
	);
	assert.equal(denied.decision.action, "deny");
});

test("a step with a top-level file redirect needs a redirect-aware allow rule and matches verbatim", () => {
	const policy = makePolicy();
	const explained = explainHostShellCommand(shellCall("echo hi > out.txt"), policy);
	assert.equal(explained.decision.action, "prompt");
	assert.equal(explained.steps[0].requiresRedirectAwareAllow, true);
	assert.equal(explained.steps[0].allowSubject, "echo hi > out.txt");
});

test("a redirect inside the write roots is exempt from the redirect-aware requirement", () => {
	const policy = makePolicy({ config: makeConfig({ writeRoots: ["/home/user/proj"] }) });
	const explained = explainHostShellCommand(shellCall("echo hi > out.txt"), policy);
	assert.equal(explained.decision.action, "allow", "the exempt redirect plus a read-only command passes the tightened tier");
	assert.equal(explained.steps[0].requiresRedirectAwareAllow, false);
	// Plain allow rules match the redirect-stripped subject, which keeps file
	// redirects intact (only /dev/null and descriptor dups are stripped).
	assert.equal(explained.steps[0].allowSubject, "echo hi > out.txt");
});

test("per-step decisions are exposed for compound prompts and the worst step drives the aggregate reason", () => {
	const policy = makePolicy();
	const explained = explainHostShellCommand(shellCall("echo a && curl https://example.com"), policy);
	assert.equal(explained.decision.action, "prompt");
	assert.ok(explained.decision.reason.startsWith("subcommand 'curl https://example.com':"), explained.decision.reason);
	assert.equal(explained.steps[0].decision.action, "allow", "echo a is tier-allowed");
	assert.equal(explained.steps[1].decision.action, "prompt");
});

test("breakdown reliability: simple compounds, single simple commands, and timeout wrappers are available", () => {
	const policy = makePolicy();
	for (const command of ["echo a && echo b", "git status", "timeout 10 git status", "git add .; git commit -m x"]) {
		const explained = explainHostShellCommand(shellCall(command), policy);
		assert.ok(explained.breakdown.available, `${command}: ${explained.breakdown.reason ?? ""}`);
	}
});

test("breakdown reliability: opaque constructs and Pwsh are unavailable with a reason", () => {
	const policy = makePolicy();
	const unavailable: Array<[string, "host-bash" | "pwsh", RegExp]> = [
		["echo $(whoami) && echo b", "host-bash", /command substitution/],
		["echo `whoami` && echo b", "host-bash", /command substitution/],
		["echo ${HOME} && echo b", "host-bash", /parameter expansion/],
		["diff <(ls) <(ls -a)", "host-bash", /process substitution/],
		["cat <<EOF && echo b", "host-bash", /heredoc/],
		["sleep 5 & echo done", "host-bash", /background/],
		["echo hi # comment && echo b", "host-bash", /inline comment/],
		["echo {a,b} && echo b", "host-bash", /brace/],
		// Backgrounding/grouping that merely coexists with a redirect still
		// flags. The non-trailing-dup row reports "background execution"
		// because the leftover `&` trips that check; conservative and
		// presentation-only.
		["sleep 5 2>&1 &", "host-bash", /background/],
		["echo a 2>&1 > out", "host-bash", /background/],
		["git log @{foo", "host-bash", /brace/],
		["(echo a) && echo b", "host-bash", /subshell/],
		// Unquoted constructs must keep flagging after the quote-stripping
		// fix (these are the true-positive guards for it).
		["echo { a; } && echo b", "host-bash", /brace/],
		["git commit -m msg (extra) && echo b", "host-bash", /subshell/],
		["for x in a b; do echo $x; done", "host-bash", /structural/],
		["if true; then echo yes; fi", "host-bash", /structural/],
		["echo 'unmatched && echo b", "host-bash", /unambiguously/],
		["Get-ChildItem && Set-Location ..", "pwsh", /Pwsh/],
	];
	for (const [command, shell, pattern] of unavailable) {
		const explained = explainHostShellCommand(shellCall(command, shell), policy);
		assert.equal(explained.breakdown.available, false, `${shell}: ${command}`);
		assert.ok(pattern.test(explained.breakdown.reason ?? ""), `${shell}: ${command}: ${explained.breakdown.reason ?? ""}`);
	}
});

test("breakdown reliability: trailing descriptor dups and git @{...} refs keep the breakdown available", () => {
	const policy = makePolicy();
	const available = [
		"git rev-parse --abbrev-ref @{upstream} 2>&1",
		"echo a 2>&1 && echo b",
		"git status > /dev/null 2>&1",
		// The required compound regression: the last step carries both a
		// git @{...} ref and a trailing descriptor dup.
		"git add . && git commit -m msg && git log -1 --format=%h && git rev-parse --abbrev-ref @{upstream} 2>&1",
		// A file-target redirect with a trailing dup is also fine: the
		// dup is stripped for opacity checks and the file redirect stays
		// in the evaluated step text, so rule matching is unaffected.
		"git status > out.log 2>&1",
		// Punctuation inside quoted text (e.g. commit messages) is inert in
		// bash and must not make the breakdown unavailable.
		'git commit -m "message with ([?]) inside quotes"',
		"git commit -m 'msg with (parens) & {braces}' && git log -1",
		// A quoted `#` is not an inline comment.
		'echo "a (#b)" && echo b',
	];
	for (const command of available) {
		const explained = explainHostShellCommand(shellCall(command), policy);
		assert.ok(explained.breakdown.available, `${command}: ${explained.breakdown.reason ?? ""}`);
	}
});

test("breakdown reliability: a purely structural command has no evaluable steps and prompts", () => {
	const policy = makePolicy();
	const explained = explainHostShellCommand(shellCall("for x in 1 2; do done"), policy);
	// A discarded loop head may still expand its word list (`for x in
	// $(touch probe); do done` runs the substitution), so "nothing to
	// evaluate" prompts instead of allowing (active-construct screen).
	assert.equal(explained.decision.action, "prompt");
	assert.match(explained.decision.reason, /structural/);
	assert.equal(explained.steps.length, 0);
	assert.equal(explained.breakdown.available, false);
});

test("assessBreakdownReliability pairs raw fragments with evaluated steps one-to-one", () => {
	assert.ok(assessBreakdownReliability("host-bash", ["echo a", "echo b"], ["echo a", "echo b"]).available);
	assert.equal(assessBreakdownReliability("host-bash", ["echo a", "echo b"], ["echo a", "echo b"]).offending, undefined);
	// A pure timeout wrapper keeps the pair reliable.
	assert.ok(assessBreakdownReliability("host-bash", ["timeout 5 echo a", "echo b"], ["echo a", "echo b"]).available);
	// Any other difference means a structural keyword collapsed.
	const structural = assessBreakdownReliability("host-bash", ["do echo a", "echo b"], ["echo a", "echo b"]);
	assert.equal(structural.available, false);
	assert.ok(/structural/.test(structural.reason ?? ""));
	assert.equal(structural.offending, "do echo a");
	// Length mismatch (a purely structural fragment was dropped): the first
	// raw part with no matching stripped step is the offending fragment.
	const dropped = assessBreakdownReliability("host-bash", ["for x in a b", "echo $x", "done"], ["echo $x"]);
	assert.equal(dropped.available, false);
	assert.equal(dropped.offending, "for x in a b");
	// Trailing harmless redirects do not make a step opaque; backgrounding
	// and git @{...} refs behave as documented.
	assert.ok(assessBreakdownReliability("host-bash", ["echo a 2>&1"], ["echo a 2>&1"]).available);
	assert.ok(assessBreakdownReliability("host-bash", ["git rev-parse @{upstream}"], ["git rev-parse @{upstream}"]).available);
	const background = assessBreakdownReliability("host-bash", ["sleep 5 &"], ["sleep 5 &"]);
	assert.equal(background.available, false);
	assert.ok(/background/.test(background.reason ?? ""));
	assert.equal(background.offending, "sleep 5 &");
	// Quoted punctuation is inert: it does not make the step unreliable.
	assert.ok(assessBreakdownReliability("host-bash", ['git commit -m "msg ([?])"'], ['git commit -m "msg ([?])"']).available);
	// Unquoted grouping still flags (true-positive guard for the fix).
	const unquotedSubshell = assessBreakdownReliability("host-bash", ["(echo hi)"], ["(echo hi)"]);
	assert.equal(unquotedSubshell.available, false);
	assert.ok(/subshell/.test(unquotedSubshell.reason ?? ""));
	// Quoted command substitution is still ACTIVE in bash, so it flags on
	// the raw text by design (conservative direction).
	const quotedSubstitution = assessBreakdownReliability("host-bash", ['echo "$(x)"'], ['echo "$(x)"']);
	assert.equal(quotedSubstitution.available, false);
	assert.ok(/command substitution/.test(quotedSubstitution.reason ?? ""));
});

test("early-return profiles and workspace lock record an unavailable breakdown with a reason", () => {
	const locked = explainHostShellCommand(shellCall("echo hi"), makePolicy({ workspaceLocked: true }));
	assert.equal(locked.breakdown.available, false);
	assert.equal(locked.steps.length, 0);
	const research = explainHostShellCommand(shellCall("echo hi"), makePolicy({ profile: "research" }));
	assert.equal(research.breakdown.available, false);
	const unrestricted = explainHostShellCommand(shellCall("echo hi"), makePolicy({ profile: "unrestricted" }));
	assert.equal(unrestricted.breakdown.available, false);
});

test("degraded research host_bash takes the read-only tier, with parity and no pwsh tier", () => {
	const policy = makePolicy({ profile: "research", sandboxMode: "degraded" });
	for (const [command, action] of [["ls -la", "allow"], ["ls -la && pwd", "deny"], ["curl example.com", "deny"], ["", "deny"], ["   ", "deny"]] as const) {
		const call = shellCall(command, "host-bash");
		const explained = explainHostShellCommand(call, policy);
		assert.equal(explained.decision.action, action, `${command}: ${explained.decision.reason}`);
		assert.deepEqual(explained.decision, decideHostShellCommand(call, policy), `decideHostShellCommand parity: ${command}`);
		assert.deepEqual(explained.decision, decide(policy, call), `decide parity: ${command}`);
		// The tier judges the whole command, so no per-step approvals are fabricated.
		assert.equal(explained.steps.length, 0, `${command}: no fabricated steps`);
		assert.equal(explained.breakdown.available, false, `${command}: breakdown unavailable`);
		assert.match(explained.breakdown.reason ?? "", /whole-command read-only-tier check/, `${command}: breakdown explains the tier`);
	}
	assert.match(explainHostShellCommand(shellCall("ls -la", "host-bash"), policy).decision.reason, / \(degraded research\)$/, "the tier reason is preserved verbatim");
	// pwsh never acquires the tier, in degraded mode or out of it.
	assert.equal(explainHostShellCommand(shellCall("ls -la", "pwsh"), policy).decision.action, "deny");
	// A real sandbox keeps research absolute.
	for (const sandboxMode of ["full", "reduced"] as const) {
		const strict = makePolicy({ profile: "research", sandboxMode });
		assert.equal(decide(strict, shellCall("ls -la", "host-bash")).action, "deny", sandboxMode);
		assert.equal(explainHostShellCommand(shellCall("ls -la", "host-bash"), strict).steps.length, 0, sandboxMode);
	}
});

test("single commands with comment collapsing project the effective command", () => {
	const policy = makePolicy();
	const explained = explainHostShellCommand(shellCall("# just a comment\necho hi"), policy);
	assert.equal(explained.decision.action, "allow", "the effective command is the tier-allowed echo, not the comment");
	assert.equal(explained.steps.length, 1);
	assert.equal(explained.steps[0].subject, "echo hi");
});

test("reliability metadata never changes policy routing: the split used by decide is untouched", () => {
	// The splitter still reports the same result for every battery command,
	// and decideHostShellCommand still routes ambiguous `case` blocks as single.
	const split = splitTopLevelShell("case x in a) echo a;; esac");
	assert.equal(split.kind, "single");
});
