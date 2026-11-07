// Characterization tests for the host-shell explanation extraction
// (save/deny/compound prompt UX, phase 1): the aggregate decision must be
// byte-identical to the pre-extraction decideHostShellCommand across every
// profile and command shape, and the per-step projection (subjects, causes,
// breakdown reliability) must reflect the analysis the evaluator consumed.
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
import { analyzeSync } from "./shellast-sync.mts";

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
const explain = (call: Extract<GuardCall, { kind: "host-shell" }>, policy: PolicyState) => explainHostShellCommand(call, policy, analyzeSync(call.command));

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
				const analysis = analyzeSync(command);
				const explained = explainHostShellCommand(call, policy, analysis);
				assert.deepEqual(explained.decision, decideHostShellCommand(call, policy, analysis), `${profile}/${shell}: ${command}`);
				assert.deepEqual(explained.decision, decide(policy, call, analysis), `decide parity: ${profile}/${shell}: ${command}`);
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
				const analysis = analyzeSync(command);
				const explained = explainHostShellCommand(call, policy, analysis);
				assert.deepEqual(explained.decision, decideHostShellCommand(call, policy, analysis), `${profile}/locked=${workspaceLocked}: ${command}`);
				const viaDecide = decide(policy, call, analysis);
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
	const explained = explain(shellCall("echo same && echo other && echo same"), policy);
	assert.equal(explained.steps.length, 3);
	assert.deepEqual(explained.steps.map((s) => s.occurrenceId), [0, 1, 2]);
	assert.deepEqual(explained.steps.map((s) => s.subject), ["echo same", "echo other", "echo same"]);
	assert.deepEqual(explained.steps.map((s) => s.display), ["echo same", "echo other", "echo same"]);
});

test("canonical subjects retain wrappers while raw subjects retain legacy normalization", () => {
	const policy = makePolicy();
	const explained = explain(shellCall("timeout 5 \\\n  git status"), policy);
	assert.equal(explained.steps.length, 1);
	assert.equal(explained.steps[0].subject, "timeout 5 git status");
	assert.equal(explained.steps[0].allowSubject, "timeout 5 git status");
	assert.equal(explained.steps[0].rawSubject, "git status");
	assert.equal(explained.steps[0].display, "git status");
});

test("a whole-call ask rule appears as a call-level cause even when every step allows", () => {
	const policy = makePolicy({ config: makeConfig({ hostBash: { ask: ["HostBash(echo a && echo b)"] } }) });
	const explained = explain(shellCall("echo a && echo b"), policy);
	assert.equal(explained.decision.action, "prompt");
	assert.equal(explained.decision.provenance, "explicit-ask");
	assert.equal(explained.rawAskRule, "HostBash(echo a && echo b)");
	assert.equal(explained.steps.length, 2);
	assert.ok(explained.steps.every((s) => s.decision.action === "allow" || s.decision.action === "prompt"), "steps keep their own decisions");
	assert.ok(explained.breakdown.available);
});

test("a whole-command deny rule denies without a step breakdown", () => {
	const policy = makePolicy({ config: makeConfig({ hostBash: { deny: ["HostBash(echo*)"] } }) });
	const explained = explain(shellCall("echo a && echo b"), policy);
	assert.equal(explained.decision.action, "deny");
	assert.equal(explained.rawDenyRule, "HostBash(echo*)");
	assert.equal(explained.steps.length, 0);
	assert.equal(explained.breakdown.available, false);
});

test("a malformed command records the parse cause, has no steps, and stays unavailable", () => {
	const policy = makePolicy();
	const explained = explain(shellCall("echo 'unmatched && echo b"), policy);
	assert.equal(explained.decision.action, "prompt");
	assert.match(explained.splitCause ?? "", /could not be parsed/);
	assert.equal(explained.steps.length, 0);
	assert.equal(explained.breakdown.available, false);
	// A deny rule on the raw command still wins over the parse failure.
	const denied = explain(
		shellCall("echo 'unmatched"),
		makePolicy({ config: makeConfig({ hostBash: { deny: ["HostBash(echo*)"] } }) }),
	);
	assert.equal(denied.decision.action, "deny");
});

test("a step with a top-level file redirect needs a redirect-aware allow rule and matches verbatim", () => {
	const policy = makePolicy();
	const explained = explain(shellCall("echo hi > out.txt"), policy);
	assert.equal(explained.decision.action, "prompt");
	assert.equal(explained.steps[0].requiresRedirectAwareAllow, true);
	assert.equal(explained.steps[0].allowSubject, "echo hi > out.txt");
});

test("a redirect inside the write roots is exempt from the redirect-aware requirement", () => {
	const policy = makePolicy({ config: makeConfig({ writeRoots: ["/home/user/proj"] }) });
	const explained = explain(shellCall("echo hi > out.txt"), policy);
	assert.equal(explained.decision.action, "allow", "the exempt redirect plus a read-only command passes the tightened tier");
	assert.equal(explained.steps[0].requiresRedirectAwareAllow, false);
	// Plain allow rules match the redirect-stripped subject, which keeps file
	// redirects intact (only /dev/null and descriptor dups are stripped).
	assert.equal(explained.steps[0].allowSubject, "echo hi > out.txt");
});

test("per-step decisions are exposed for compound prompts and the worst step drives the aggregate reason", () => {
	const policy = makePolicy();
	const explained = explain(shellCall("echo a && curl https://example.com"), policy);
	assert.equal(explained.decision.action, "prompt");
	assert.ok(explained.decision.reason.startsWith("subcommand 'curl https://example.com':"), explained.decision.reason);
	assert.equal(explained.steps[0].decision.action, "allow", "echo a is tier-allowed");
	assert.equal(explained.steps[1].decision.action, "prompt");
});

test("breakdown reliability: a complete analysis is available", () => {
	const policy = makePolicy();
	for (const command of ["echo a && echo b", "git status", "timeout 10 git status", "git add .; git commit -m x"]) {
		const explained = explain(shellCall(command), policy);
		assert.ok(explained.breakdown.available, `${command}: ${explained.breakdown.reason ?? ""}`);
	}
});

test("breakdown reliability: incomplete constructs and Pwsh are unavailable with a machine reason", () => {
	const policy = makePolicy();
	const unavailable: Array<[string, "host-bash" | "pwsh", RegExp]> = [
		["echo $(whoami) && echo b", "host-bash", /command substitution/],
		["echo `whoami` && echo b", "host-bash", /command substitution/],
		["diff <(ls) <(ls -a)", "host-bash", /process substitution/],
		["cat <<EOF\nx\nEOF", "host-bash", /heredoc/],
		["sleep 5 & echo done", "host-bash", /background/],
		["sleep 5 2>&1 &", "host-bash", /background/],
		["(echo a) && echo b", "host-bash", /subshell/],
		["{ echo a; } && echo b", "host-bash", /grouping/],
		["for x in a b; do echo $x; done", "host-bash", /grouping/],
		["if true; then echo yes; fi", "host-bash", /grouping/],
		["echo 'unmatched && echo b", "host-bash", /could not be parsed/],
		["Get-ChildItem && Set-Location ..", "pwsh", /evaluated as one whole command/],
	];
	for (const [command, shell, pattern] of unavailable) {
		const explained = explain(shellCall(command, shell), policy);
		assert.equal(explained.breakdown.available, false, `${shell}: ${command}`);
		assert.ok(pattern.test(explained.breakdown.reason ?? ""), `${shell}: ${command}: ${explained.breakdown.reason ?? ""}`);
	}
});

test("breakdown reliability: parameter expansion, comments, and redirects keep the breakdown available", () => {
	const policy = makePolicy();
	const available = [
		// $VAR expansion vetoes the tier but does not make the command opaque.
		"echo ${HOME} && echo b",
		"echo hi # comment && echo b",
		// Trailing descriptor dups and file redirects are evaluated, not opaque.
		"git rev-parse --abbrev-ref @{upstream} 2>&1",
		"echo a 2>&1 && echo b",
		"git status > /dev/null 2>&1",
		"git status > out.log 2>&1",
		// Punctuation inside quoted text is inert in bash.
		'git commit -m "message with ([?]) inside quotes"',
		"git commit -m 'msg with (parens) & {braces}' && git log -1",
		'echo "a (#b)" && echo b',
	];
	for (const command of available) {
		const explained = explain(shellCall(command), policy);
		assert.ok(explained.breakdown.available, `${command}: ${explained.breakdown.reason ?? ""}`);
	}
});

test("breakdown reliability: a purely structural command has no evaluable steps and prompts", () => {
	const policy = makePolicy();
	const explained = explain(shellCall("for x in 1 2; do :; done"), policy);
	// A grouping construct may expand its word list (`for x in $(touch probe);
	// do done` runs the substitution), so it prompts instead of allowing.
	assert.equal(explained.decision.action, "prompt");
	assert.match(explained.decision.reason, /grouping construct/);
	assert.equal(explained.steps.length, 0);
	assert.equal(explained.breakdown.available, false);
});

test("the analysis carries per-call causes and completeness", () => {
	const substitution = analyzeSync("echo $(whoami) && echo b");
	assert.equal(substitution.complete, true, "a per-call construct leaves the analysis complete");
	assert.equal(substitution.cause, null);
	assert.equal(substitution.reason, null);
	assert.equal(substitution.calls[0].complete, false);
	assert.equal(substitution.calls[0].cause, "command-substitution");
	assert.equal(substitution.calls[1].complete, true);
	const grouped = analyzeSync("for x in a b; do echo $x; done");
	assert.equal(grouped.complete, false);
	assert.equal(grouped.cause, "grouped");
	const complete = analyzeSync("echo a 2>&1 && echo b");
	assert.equal(complete.complete, true);
	assert.equal(complete.cause, null);
	assert.equal(complete.calls.length, 2);
});

test("early-return profiles and workspace lock record an unavailable breakdown with a reason", () => {
	const locked = explain(shellCall("echo hi"), makePolicy({ workspaceLocked: true }));
	assert.equal(locked.breakdown.available, false);
	assert.equal(locked.steps.length, 0);
	const research = explain(shellCall("echo hi"), makePolicy({ profile: "research" }));
	assert.equal(research.breakdown.available, false);
	const unrestricted = explain(shellCall("echo hi"), makePolicy({ profile: "unrestricted" }));
	assert.equal(unrestricted.breakdown.available, false);
});

test("degraded research host_bash takes the read-only tier, with parity and no pwsh tier", () => {
	const policy = makePolicy({ profile: "research", sandboxMode: "degraded" });
	for (const [command, action] of [["ls -la", "allow"], ["ls -la && pwd", "deny"], ["curl example.com", "deny"], ["", "deny"], ["   ", "deny"]] as const) {
		const call = shellCall(command, "host-bash");
		const analysis = analyzeSync(command);
		const explained = explainHostShellCommand(call, policy, analysis);
		assert.equal(explained.decision.action, action, `${command}: ${explained.decision.reason}`);
		assert.deepEqual(explained.decision, decideHostShellCommand(call, policy, analysis), `decideHostShellCommand parity: ${command}`);
		assert.deepEqual(explained.decision, decide(policy, call, analysis), `decide parity: ${command}`);
		// The tier judges the whole command, so no per-step approvals are fabricated.
		assert.equal(explained.steps.length, 0, `${command}: no fabricated steps`);
		assert.equal(explained.breakdown.available, false, `${command}: breakdown unavailable`);
		assert.match(explained.breakdown.reason ?? "", /whole-command read-only-tier check/, `${command}: breakdown explains the tier`);
	}
	assert.match(explain(shellCall("ls -la", "host-bash"), policy).decision.reason, / \(degraded research\)$/, "the tier reason is preserved verbatim");
	// pwsh never acquires the tier, in degraded mode or out of it.
	assert.equal(explain(shellCall("ls -la", "pwsh"), policy).decision.action, "deny");
	// A real sandbox keeps research absolute.
	for (const sandboxMode of ["full", "reduced"] as const) {
		const strict = makePolicy({ profile: "research", sandboxMode });
		assert.equal(decide(strict, shellCall("ls -la", "host-bash"), analyzeSync("ls -la")).action, "deny", sandboxMode);
		assert.equal(explain(shellCall("ls -la", "host-bash"), strict).steps.length, 0, sandboxMode);
	}
});

test("single commands with comment collapsing project the effective command", () => {
	const policy = makePolicy();
	const explained = explain(shellCall("# just a comment\necho hi"), policy);
	assert.equal(explained.decision.action, "allow", "the effective command is the tier-allowed echo, not the comment");
	assert.equal(explained.steps.length, 1);
	assert.equal(explained.steps[0].subject, "echo hi");
});

test("case blocks are projected as a single grouped construct, never split", () => {
	const analysis = analyzeSync("case x in a) echo a;; esac");
	assert.equal(analysis.complete, false);
	assert.equal(analysis.cause, "grouped");
	const explained = explain(shellCall("case x in a) echo a;; esac"), makePolicy());
	assert.equal(explained.steps.length, 0);
	assert.equal(explained.decision.action, "prompt");
});
