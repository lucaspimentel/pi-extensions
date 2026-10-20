// Unit tests for the save helpers (save/deny/compound prompt UX, phase 2):
// shell-rule parsing, complete-call hypothetical validation, allow plans
// (whole-call vs reliable bundle), deny plans, and read-root input parsing.
// Root save filesystem validation is covered in tests/guard-runtime.test.mts.
//
// Run: node --test tests/guard-save.test.mts
import assert from "node:assert/strict";
import { test } from "node:test";

import { mergeConfig, type GuardConfig } from "../extensions/guard/policy/config.ts";
import {
	explainHostShellCommand,
	type GuardCall,
	type PolicyState,
} from "../extensions/guard/policy/decision.ts";
import {
	exactAllowRule,
	exactDenyRule,
	parseReadRootInput,
	parseShellRuleLine,
	parseShellRuleLines,
	planAllowSave,
	planDenyRules,
	validateShellAllowSave,
	validateShellSave,
} from "../extensions/guard/policy/save.ts";

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

const shellCall = (command: string, shell: "host-bash" | "pwsh" = "host-bash"): Extract<GuardCall, { kind: "host-shell" }> => ({ kind: "host-shell", shell, command });

// ── Rule line parsing ───────────────────────────────────────────────────────

test("rule lines parse with the existing grammar and dedupe", () => {
	const parsed = parseShellRuleLines("HostBash(/^echo hi$/)\n  HostBash(/^echo hi$/)  \nHostBash(git *)", "host-bash");
	assert.ok(parsed.ok);
	assert.deepEqual(parsed.rules, ["HostBash(/^echo hi$/)", "HostBash(git *)"]);
});

test("empty editor text is a validation error, not a cancellation", () => {
	const parsed = parseShellRuleLines("  \n\t\n", "host-bash");
	assert.equal(parsed.ok, false);
	assert.match(parsed.error, /no rules entered/);
});

test("wrong shell namespace is rejected", () => {
	const pwsh = parseShellRuleLine("Pwsh(/^Get-ChildItem$/)", "host-bash");
	assert.equal(pwsh.ok, false);
	assert.match(pwsh.error, /must be HostBash/);
	const bash = parseShellRuleLine("HostBash(/^ls$/)", "pwsh");
	assert.equal(bash.ok, false);
	assert.match(bash.error, /must be Pwsh/);
});

test("uncompilable regex and non-rule text are rejected with line numbers", () => {
	const bad = parseShellRuleLines("HostBash(/([)/)\nnot a rule\nBash(/^ls$/)", "host-bash");
	assert.equal(bad.ok, false);
	assert.match(bad.error, /line 1/);
	assert.match(bad.error, /line 2/);
	assert.match(bad.error, /line 3/);
});

test("tool-wide broadening (bare tool rule) parses and is reviewed via preview", () => {
	const parsed = parseShellRuleLines("HostBash", "host-bash");
	assert.ok(parsed.ok);
	assert.deepEqual(parsed.rules, ["HostBash"]);
});

// ── Complete-call hypothetical validation ───────────────────────────────────

test("allow validation requires the whole call to become deterministically allowed", () => {
	const policy = makePolicy();
	const call = shellCall("echo a && curl https://example.com");
	const bundle = [exactAllowRule("host-bash", "curl https://example.com")];
	assert.deepEqual(validateShellSave(call, policy, "allow", bundle), { ok: true });
	// A partial bundle (missing the curl step) must fail.
	assert.equal(validateShellSave(call, policy, "allow", []).ok, false);
	// A rule that matches only part of the step text fails.
	const tooNarrow = validateShellSave(call, policy, "allow", ["HostBash(/^curl https$/)"]);
	assert.equal(tooNarrow.ok, false);
});

test("explicit ask rules still prohibit allow-saving through validation", () => {
	const policy = makePolicy({ config: makeConfig({ hostBash: { ask: ["HostBash(curl*)"] } }) });
	const call = shellCall("echo a && curl https://example.com");
	const result = validateShellSave(call, policy, "allow", [exactAllowRule("host-bash", "curl https://example.com")]);
	assert.equal(result.ok, false, "the ask rule still matches first, so the merge does not allow");
});

test("deny validation requires an effective deny and deny-over-ask precedence applies", () => {
	const policy = makePolicy();
	const call = shellCall("echo a && curl https://example.com");
	assert.deepEqual(validateShellSave(call, policy, "deny", [exactDenyRule("host-bash", "curl https://example.com")]), { ok: true });
	assert.equal(validateShellSave(call, policy, "deny", []).ok, false);
	// Deny over ask: an ask rule plus a deny rule denies.
	const asked = makePolicy({ config: makeConfig({ hostBash: { ask: ["HostBash(curl*)"] } }) });
	assert.deepEqual(validateShellSave(call, asked, "deny", [exactDenyRule("host-bash", "curl https://example.com")]), { ok: true });
});

test("existing entries are preserved: validation merges additively", () => {
	const policy = makePolicy({ config: makeConfig({ hostBash: { allow: ["HostBash(echo a)"] } }) });
	const call = shellCall("echo a && curl https://example.com");
	// With the pre-existing allow rule, only the curl step needs a rule.
	assert.deepEqual(validateShellSave(call, policy, "allow", [exactAllowRule("host-bash", "curl https://example.com")]), { ok: true });
});

// ── Allow plans ─────────────────────────────────────────────────────────────

test("a reliable breakdown plans per-step rules, even for a single-command prompt", () => {
	const policy = makePolicy();
	const call = shellCall("curl https://example.com");
	const explanation = explainHostShellCommand(call, policy);
	const plan = planAllowSave(call, policy, explanation);
	assert.ok(plan);
	assert.equal(plan.kind, "per-step");
	assert.ok(plan.kind === "per-step");
	assert.deepEqual(plan.perStep, [{ occurrenceId: 0, rule: "HostBash(/^curl https:\\/\\/example\\.com$/)" }]);
});

test("an unreliable breakdown keeps the whole-call exact suggestion when it provably works", () => {
	const policy = makePolicy();
	const call = shellCall("echo $(compute)");
	const explanation = explainHostShellCommand(call, policy);
	assert.equal(explanation.breakdown.available, false, "command substitution makes the breakdown unavailable");
	const plan = planAllowSave(call, policy, explanation);
	assert.ok(plan);
	assert.equal(plan.kind, "whole-call");
	assert.ok(plan.kind === "whole-call");
	assert.deepEqual(plan.rules, ["HostBash(/^echo \\$\\(compute\\)$/)"]);
});

test("a whole-call suggestion for a compound command is retired on a reliable breakdown", () => {
	const policy = makePolicy();
	const call = shellCall("echo a && curl https://example.com");
	const explanation = explainHostShellCommand(call, policy);
	const plan = planAllowSave(call, policy, explanation);
	assert.ok(plan);
	assert.equal(plan.kind, "per-step");
	if (plan.kind !== "per-step") return;
	// Only the step lacking effective permission gets a rule; echo a is tier-allowed.
	assert.deepEqual(plan.perStep, [{ occurrenceId: 1, rule: "HostBash(/^curl https:\\/\\/example\\.com$/)" }]);
	// The full prefill validates per-step over all prompting occurrence IDs.
	assert.deepEqual(validateShellAllowSave(call, policy, plan.perStep.map((entry) => entry.rule), plan.perStep.map((entry) => entry.occurrenceId)), { ok: true });
});

test("an unreliable breakdown plans no guessed allow bundle", () => {
	const policy = makePolicy();
	const call = shellCall("for x in a b; do curl https://example.com; done");
	const explanation = explainHostShellCommand(call, policy);
	assert.equal(explanation.breakdown.available, false);
	assert.equal(planAllowSave(call, policy, explanation), null);
});

test("explicit ask plans no allow save", () => {
	const policy = makePolicy({ config: makeConfig({ hostBash: { ask: ["HostBash(curl*)"] } }) });
	const call = shellCall("curl https://example.com");
	assert.equal(planAllowSave(call, policy, explainHostShellCommand(call, policy)), null);
});

test("already-allowed steps are omitted and duplicate prompting subjects keep per-occurrence entries", () => {
	const policy = makePolicy();
	const call = shellCall("echo a && curl https://example.com && curl https://example.com");
	const plan = planAllowSave(call, policy, explainHostShellCommand(call, policy));
	assert.ok(plan);
	assert.equal(plan.kind, "per-step");
	if (plan.kind !== "per-step") return;
	assert.deepEqual(plan.perStep.map((entry) => entry.occurrenceId), [1, 2], "only the prompting steps get entries");
	assert.equal(plan.perStep[0].rule, plan.perStep[1].rule, "identical command text yields the identical rule; editor parsing dedupes");
});

test("redirect steps produce redirect-aware (verbatim) per-step rules that validate", () => {
	const policy = makePolicy();
	const call = shellCall("echo hi > /tmp/out.txt && echo done");
	const plan = planAllowSave(call, policy, explainHostShellCommand(call, policy));
	assert.ok(plan);
	assert.equal(plan.kind, "per-step");
	if (plan.kind !== "per-step") return;
	assert.deepEqual(plan.perStep, [{ occurrenceId: 0, rule: "HostBash(/^echo hi > \\/tmp\\/out\\.txt$/)" }]);
	assert.ok(plan.perStep[0].rule.includes(">"), "the pattern contains '>' so it is redirect-aware");
	assert.deepEqual(validateShellAllowSave(call, policy, plan.perStep.map((entry) => entry.rule), plan.perStep.map((entry) => entry.occurrenceId)), { ok: true });
});

// ── Per-step allow-save validation ─────────────────────────────────────────────

test("per-step validation accepts the exact prefill for all prompting steps", () => {
	const policy = makePolicy();
	const call = shellCall("echo a && curl https://example.com");
	assert.deepEqual(validateShellAllowSave(call, policy, [exactAllowRule("host-bash", "curl https://example.com")], [1]), { ok: true });
});

test("a selection missing a prompting step still validates; the whole call need not allow", () => {
	const policy = makePolicy();
	const call = shellCall("echo a && curl https://example.com");
	// Only the tier-allowed echo step is selected; the curl step still prompts.
	assert.deepEqual(validateShellAllowSave(call, policy, [exactAllowRule("host-bash", "echo a")], [0]), { ok: true });
});

test("a rule that does not match its selected step fails with the step name", () => {
	const policy = makePolicy();
	const call = shellCall("echo a && curl https://example.com");
	const result = validateShellAllowSave(call, policy, ["HostBash(/^curl https$/)"], [1]);
	assert.equal(result.ok, false);
	assert.ok(!result.ok);
	assert.match(result.error, /step 'curl https:\/\/example\.com' is not allowed/);
});

test("a redirect-requiring step validates only with the verbatim (redirect-aware) subject", () => {
	const policy = makePolicy();
	const call = shellCall("echo x > out.txt");
	const explanation = explainHostShellCommand(call, policy);
	const step = explanation.steps[0];
	assert.equal(step.requiresRedirectAwareAllow, true);
	assert.deepEqual(validateShellAllowSave(call, policy, [exactAllowRule("host-bash", step.allowSubject)], [0]), { ok: true });
	const stripped = validateShellAllowSave(call, policy, [exactAllowRule("host-bash", "echo x")], [0]);
	assert.equal(stripped.ok, false, "the redirect-stripped subject cannot authorize a file redirect");
});

test("defensive preconditions: empty, unknown, and duplicated selections fail closed", () => {
	const policy = makePolicy();
	const call = shellCall("echo a && curl https://example.com");
	const rule = exactAllowRule("host-bash", "curl https://example.com");
	const empty = validateShellAllowSave(call, policy, [rule], []);
	assert.equal(empty.ok, false);
	assert.ok(!empty.ok);
	assert.match(empty.error, /no steps selected/);
	const unknown = validateShellAllowSave(call, policy, [rule], [7]);
	assert.equal(unknown.ok, false);
	assert.ok(!unknown.ok);
	assert.match(unknown.error, /changed the step breakdown/);
	const duplicated = validateShellAllowSave(call, policy, [rule], [1, 1]);
	assert.equal(duplicated.ok, false);
	assert.ok(!duplicated.ok);
	assert.match(duplicated.error, /duplicate/);
});

test("a preexisting deny rule matched by the merged evaluation fails the aggregate check", () => {
	const policy = makePolicy({ config: makeConfig({ hostBash: { deny: ["HostBash(curl*)"] } }) });
	const call = shellCall("echo a && curl https://example.com");
	const result = validateShellAllowSave(call, policy, [exactAllowRule("host-bash", "curl https://example.com")], [1]);
	assert.equal(result.ok, false, "deny rules take precedence over the merged allow rule");
});

test("occurrence IDs are identical across the original and merged evaluations", () => {
	const policy = makePolicy();
	const call = shellCall("echo a && curl https://example.com && curl https://example.com");
	const original = explainHostShellCommand(call, policy);
	const merged = explainHostShellCommand(call, {
		...policy,
		config: { ...policy.config, hostBash: { ...policy.config.hostBash, allow: [exactAllowRule("host-bash", "curl https://example.com")] } },
	});
	assert.deepEqual(merged.steps.map((step) => step.occurrenceId), original.steps.map((step) => step.occurrenceId));
	assert.deepEqual(original.steps.map((step) => step.occurrenceId), [0, 1, 2], "duplicate command text keeps distinct sequential IDs");
	// A policy change that alters step outcomes without altering syntax keeps IDs stable.
	assert.deepEqual(merged.steps.map((step) => step.decision.action), ["allow", "allow", "allow"]);
	assert.deepEqual(merged.steps.map((step) => step.display), original.steps.map((step) => step.display));
});

// ── Deny plans ──────────────────────────────────────────────────────────────

test("deny plans anchor to the deny subject of the selected occurrence IDs", () => {
	const policy = makePolicy();
	const call = shellCall("echo a && curl https://example.com && curl https://example.com");
	const explanation = explainHostShellCommand(call, policy);
	const rules = planDenyRules(call, explanation, [1, 2]);
	assert.deepEqual(rules, [exactDenyRule("host-bash", "curl https://example.com")], "identical steps dedupe");
	const one = planDenyRules(call, explanation, [0]);
	assert.deepEqual(one, [exactDenyRule("host-bash", "echo a")]);
});

test("selected deny rules make the whole call effectively deny", () => {
	const policy = makePolicy();
	const call = shellCall("echo a && curl https://example.com");
	const rules = planDenyRules(call, explainHostShellCommand(call, policy), [1]);
	assert.deepEqual(validateShellSave(call, policy, "deny", rules), { ok: true });
});

test("deny plan mapping stays pure: gating by reliability happens at the flow level", () => {
	const policy = makePolicy();
	const call = shellCall("echo $(compute) && curl https://example.com", "pwsh");
	const explanation = explainHostShellCommand(call, policy);
	assert.equal(explanation.breakdown.available, false, "the flow opens a blank manual editor for this case");
	// planDenyRules itself is a pure mapper over existing steps; the flow must
	// only call it when the breakdown picker is offered (reliable parsing).
	assert.deepEqual(planDenyRules(call, explanation, [0]), [exactDenyRule("pwsh", "echo $(compute)")]);
});

// ── Read-root input parsing ─────────────────────────────────────────────────

test("read-root input accepts exactly one plain path", () => {
	const relative = parseReadRootInput("  docs  ", "/home/user/proj");
	assert.deepEqual(relative, { ok: true, root: "/home/user/proj/docs" });
	const home = parseReadRootInput("~/docs", "/home/user/proj");
	assert.ok(home.ok);
	assert.match(home.root, /docs$/);
});

test("read-root input rejects multiple lines and multiple tokens", () => {
	const multiline = parseReadRootInput("/a\n/b", "/home/user/proj");
	assert.equal(multiline.ok, false);
	assert.match(multiline.error, /exactly one/);
	const spaced = parseReadRootInput("/a /b", "/home/user/proj");
	assert.equal(spaced.ok, false);
	assert.match(spaced.error, /single path/);
	const empty = parseReadRootInput("", "/home/user/proj");
	assert.equal(empty.ok, false);
});

test("exact rule helpers escape regex metacharacters", () => {
	assert.equal(exactAllowRule("host-bash", "echo a.b(c)"), "HostBash(/^echo a\\.b\\(c\\)$/)");
	assert.equal(exactDenyRule("pwsh", "Get-Child*"), "Pwsh(/^Get-Child\\*$/)");
});

// ── Edited read-root validation (runtime.ts, real filesystem) ────────────────

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after } from "node:test";
import { validateReadRootSave } from "../extensions/guard/runtime.ts";

// Roots must live outside the workspace and outside guard's reserved sandbox
// mountpoints (/tmp included), so fixtures live under the real home directory
// and are removed after the suite.
const fixtureBase = fs.mkdtempSync(path.join(os.homedir(), ".pi-guard-root-fixtures-"));
after(() => { fs.rmSync(fixtureBase, { recursive: true, force: true }); });

function makeFixtureDir(...parts: string[]): string {
	const dir = path.join(fixtureBase, ...parts);
	fs.mkdirSync(dir, { recursive: true });
	return fs.realpathSync(dir);
}

test("an edited root that covers the request path validates and canonicalizes", () => {
	const base = makeFixtureDir("cover");
	const workspace = makeFixtureDir("cover", "ws");
	const rootDir = makeFixtureDir("cover", "root");
	const request = path.join(rootDir, "sub", "file.txt");
	fs.mkdirSync(path.join(rootDir, "sub"), { recursive: true });
	assert.equal(validateReadRootSave(rootDir, request, workspace), rootDir, "the canonical (realpath) root is returned");
	// A symlinked spelling canonicalizes to the same root.
	const link = path.join(base, "alias");
	fs.symlinkSync(rootDir, link);
	assert.equal(validateReadRootSave(link, request, workspace), rootDir);
});

test("an unrelated root is rejected even when it is a valid directory", () => {
	const workspace = makeFixtureDir("unrelated", "ws");
	const rootDir = makeFixtureDir("unrelated", "root");
	const other = makeFixtureDir("unrelated", "other");
	assert.throws(() => validateReadRootSave(other, path.join(rootDir, "file.txt"), workspace), /does not cover/);
	void rootDir; void workspace;
});

test("prefix traps respect path boundaries: a sibling prefix root does not cover", () => {
	const parent = makeFixtureDir("prefix");
	const workspace = makeFixtureDir("prefix", "ws");
	const covered = makeFixtureDir("prefix", "data");
	const sibling = makeFixtureDir("prefix", "data-two");
	assert.throws(() => validateReadRootSave(sibling, path.join(covered, "file.txt"), workspace), /does not cover/);
	assert.equal(validateReadRootSave(covered, path.join(covered, "file.txt"), workspace), covered);
});

test("a root inside the workspace is rejected by the existing mountability rule", () => {
	const workspace = makeFixtureDir("inside", "ws");
	assert.throws(() => validateReadRootSave(workspace, path.join(workspace, "file.txt"), workspace), /covered by the workspace/);
});

test("missing and non-directory roots fail with the existing grant errors", () => {
	const workspace = makeFixtureDir("missing", "ws");
	const rootDir = makeFixtureDir("missing", "root");
	assert.throws(() => validateReadRootSave(path.join(rootDir, "nope"), path.join(rootDir, "file.txt"), workspace));
	const filePath = path.join(rootDir, "plain.txt");
	fs.writeFileSync(filePath, "x");
	assert.throws(() => validateReadRootSave(filePath, filePath, workspace), /directories/);
});

test("hard-excluded roots keep failing with the existing reason", () => {
	const workspace = makeFixtureDir("hard", "ws");
	const sshDir = path.join(os.homedir(), ".ssh");
	fs.mkdirSync(sshDir, { recursive: true });
	assert.throws(() => validateReadRootSave(sshDir, path.join(sshDir, "known_hosts"), workspace), /hard-excluded|sensitive|never mounted/);
});
