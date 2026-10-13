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
	for (const profile of ["research", "default", "auto", "trusted", "yolo", "unrestricted"] as const) {
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
		["(echo a) && echo b", "host-bash", /subshell/],
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

test("breakdown reliability: a purely structural command has no evaluable steps", () => {
	const policy = makePolicy();
	const explained = explainHostShellCommand(shellCall("for x in 1 2; do done"), policy);
	assert.equal(explained.decision.action, "allow");
	assert.equal(explained.decision.reason, "no commands after structural stripping");
	assert.equal(explained.steps.length, 0);
	assert.equal(explained.breakdown.available, false);
});

test("assessBreakdownReliability pairs raw fragments with evaluated steps one-to-one", () => {
	assert.ok(assessBreakdownReliability("host-bash", ["echo a", "echo b"], ["echo a", "echo b"]).available);
	// A pure timeout wrapper keeps the pair reliable.
	assert.ok(assessBreakdownReliability("host-bash", ["timeout 5 echo a", "echo b"], ["echo a", "echo b"]).available);
	// Any other difference means a structural keyword collapsed.
	const structural = assessBreakdownReliability("host-bash", ["do echo a", "echo b"], ["echo a", "echo b"]);
	assert.equal(structural.available, false);
	assert.ok(/structural/.test(structural.reason ?? ""));
	// Length mismatch (a purely structural fragment was dropped).
	const dropped = assessBreakdownReliability("host-bash", ["for x in a b", "echo $x", "done"], ["echo $x"]);
	assert.equal(dropped.available, false);
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
