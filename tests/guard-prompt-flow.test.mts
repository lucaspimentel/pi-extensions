// Transition-table tests for the authority-free prompt flows
// (prompt-flow.ts): every action and cancellation origin, empty submissions,
// invalid edits, preview re-edit, steering collection rules, and the
// option-eligibility boundary for hosts without owned stages. Persistence,
// transitions, and steering delivery are caller responsibilities (covered by
// tests/guard-dialogs.test.mts wiring); prompt flows must perform none.
// Run: node --test tests/guard-prompt-flow.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";

import {
	collectSteering,
	executionPromptTitle,
	runExecutionPrompt,
	runReadGrantPrompt,
	runWriteEditPrompt,
	writeEditPromptTitle,
	type ExecutionFlowOutcome,
	type PromptFlowIO,
	type ReadFlowOutcome,
} from "../extensions/guard/prompt-flow.ts";
import type { AllowSavePlan } from "../extensions/guard/policy/save.ts";
import { mergeConfig, type GuardConfig } from "../extensions/guard/policy/config.ts";
import { decide, explainHostShellCommand, type PolicyState } from "../extensions/guard/policy/decision.ts";
import { parseReadRootInput, parseShellRuleLines, planAllowSave, planDenyRules, validateShellAllowSave, validateShellSave } from "../extensions/guard/policy/save.ts";

function makeConfig(overrides: Partial<GuardConfig> = {}, cwd = "/home/user/proj"): ReturnType<typeof mergeConfig> {
	return mergeConfig(overrides, {}, cwd);
}
function makePolicy(overrides: Partial<PolicyState> = {}): PolicyState {
	const cwd = overrides.config?.cwd ?? "/home/user/proj";
	return { profile: "default", config: makeConfig({}, cwd), sandboxMode: "full", cwd, workspaceLocked: false, interactive: true, ...overrides };
}

/** Scripted IO: select answers and editor texts are consumed in order. */
function makeIO(script: { select?: (string | undefined)[]; editor?: (string | undefined)[]; input?: (string | undefined)[]; picker?: (number[] | undefined)[] } = {}) {
	const calls = { select: [] as string[], editor: [] as string[], input: [] as string[], picker: [] as string[], notify: [] as string[] };
	const io: PromptFlowIO = {
		select: async (title, options) => {
			calls.select.push(`${title}\n@@${options.join("|")}`);
			return script.select?.shift();
		},
		editor: async (title, prefill, _signal, noteFor) => {
			// The note parts come before @@prefill so existing endsWith/includes
			// assertions on the prefill keep working.
			calls.editor.push(`${title}\n@@noteFor:${noteFor ? "present" : "absent"}\n@@note:${noteFor?.(prefill) ?? "none"}\n@@prefill:${prefill}`);
			return script.editor?.shift();
		},
		picker: async (title, steps, _signal, options) => {
			calls.picker.push(`${title}\n@@${steps.map((s) => s.label).join("|")}\n@@options:${options ? JSON.stringify(options) : "none"}\n@@selectable:${steps.map((s) => s.selectable === false ? "no" : "yes").join("|")}`);
			return script.picker?.shift();
		},
		inputText: async (title) => {
			calls.input.push(title);
			return script.input?.shift();
		},
		notify: (message) => calls.notify.push(message),
	};
	return { io, calls };
}

const signal = () => new AbortController().signal;

/** An IO surface without the owned editor/picker stages (RPC/native hosts). */
function ioWithoutStages(script: { select?: (string | undefined)[]; input?: (string | undefined)[] } = {}) {
	const full = makeIO(script);
	const io: PromptFlowIO = {
		select: full.io.select,
		inputText: full.io.inputText,
		notify: full.io.notify,
	};
	return { io, calls: full.calls };
}

const shellCall = (command: string, shell: "host-bash" | "pwsh" = "host-bash"): Parameters<typeof explainHostShellCommand>[0] => ({ kind: "host-shell", shell, command });

function realDeps(command = "echo a && curl https://example.com", configOverrides: Partial<GuardConfig> = {}) {
	const policy = makePolicy({ config: makeConfig(configOverrides) });
	const call = shellCall(command);
	const explanation = explainHostShellCommand(call, policy);
	return {
		policy,
		call,
		explanation,
		allowPlan: planAllowSave(call, policy, explanation) as AllowSavePlan | null,
	};
}

/** The editor-facing rules of an allow plan (either kind). */
function planRules(plan: AllowSavePlan): string[] {
	return plan.kind === "whole-call" ? plan.rules : plan.perStep.map((entry) => entry.rule);
}

function baseExecutionDeps(overrides: Partial<Parameters<typeof runExecutionPrompt>[0]> = {}): Parameters<typeof runExecutionPrompt>[0] {
	// Validators bind to the overridden command so per-step and whole-call
	// validation matches the explanation under test.
	const real = realDeps(overrides.command ?? "echo a && curl https://example.com");
	return {
		io: makeIO().io,
		signal: signal(),
		toolName: "host_bash",
		command: real.call.command,
		decision: real.explanation.decision,
		explanation: real.explanation,
		allowPlan: real.allowPlan,
		denySaveSupported: true,
		shell: "host-bash",
		scopes: ["project", "user"],
		parseRules: (text) => parseShellRuleLines(text, "host-bash"),
		validateRules: (intent, rules) => validateShellSave(real.call, real.policy, intent, rules),
		validateAllowSave: (rules, ids) => validateShellAllowSave(real.call, real.policy, rules, ids),
		denyRulesFor: (ids) => planDenyRules(real.call, real.explanation, ids),
		destination: (scope) => scope === "project" ? "/home/user/proj/.pi/guard.local.json" : "~/.pi/agent/guard.json",
		...overrides,
	};
}

// ── Action menu and initial cancellation ────────────────────────────────────

test("a capable TUI offers the flat action menu with eligible saves", async () => {
	const { io, calls } = makeIO({ select: [undefined] });
	await runExecutionPrompt(baseExecutionDeps({ io, allowPlan: { kind: "per-step", perStep: [{ occurrenceId: 1, rule: "HostBash(/^curl https:\\/\\/example\\.com$/)" }] } }));
	const [title, options] = calls.select[0].split("\n@@");
	assert.ok(options.includes("Allow once"));
	assert.ok(options.includes("Save allow for project"));
	assert.ok(options.includes("Save allow for user"));
	assert.ok(options.includes("Deny once"));
	assert.ok(options.includes("Save deny for project"));
	assert.ok(options.includes("Save deny for user"));
});

test("a host without owned stages offers once actions only", async () => {
	const { io, calls } = ioWithoutStages({ select: [undefined] });
	await runExecutionPrompt(baseExecutionDeps({ io, allowPlan: { kind: "whole-call", rules: ["HostBash(x)"], patch: { hostBash: { allow: ["HostBash(x)"] } } } }));
	const options = calls.select[0].split("\n@@")[1];
	assert.deepEqual(options.split("|"), ["Allow once", "Deny once"]);
});

test("initial selector cancellation denies without saving or steering", async () => {
	const { io, calls } = makeIO({ select: [undefined] });
	const outcome: ExecutionFlowOutcome = await runExecutionPrompt(baseExecutionDeps({ io }));
	assert.deepEqual(outcome, { kind: "deny-once", explicit: false, steering: undefined });
	assert.equal(calls.input.length, 0, "no steering input was opened");
});

test("the approval prompt renders the command, decision, and each reliable step", async () => {
	const { io, calls } = makeIO({ select: [undefined] });
	await runExecutionPrompt(baseExecutionDeps({ io }));
	const title = calls.select[0].split("\n@@")[0];
	assert.ok(title.includes("Allow Bash subcommand?"), title);
	assert.ok(title.includes("Full command:\n  echo a && curl https://example.com"), title);
	assert.ok(title.includes("   [✓] echo a"), title);
	assert.ok(title.includes(" » [?] curl https://example.com"), title);
	assert.ok(title.includes("Why: "), title);
});

test("the breakdown cursor marks every prompting step, not one attributed step", async () => {
	const command = "curl https://example.com && echo ok && curl https://example.org";
	const real = realDeps(command);
	const { io, calls } = makeIO({ select: [undefined] });
	await runExecutionPrompt(baseExecutionDeps({ io, command, decision: real.explanation.decision, explanation: real.explanation, allowPlan: real.allowPlan }));
	const title = calls.select[0].split("\n@@")[0];
	assert.ok(title.includes(" » [?] curl https://example.com"), title);
	assert.ok(title.includes(" » [?] curl https://example.org"), title);
	assert.ok(title.includes("   [✓] echo ok"), title);
	assert.equal((title.match(/» /g) ?? []).length, 2, "only prompting steps carry the cursor");
});

test("a multi-line failing subcommand with an unavailable breakdown keeps the labeled failing step", async () => {
	const command = "cat > wl-debug.mts <<'EOF'\nconsole.log(1)\nEOF\nrm wl-debug.mts";
	const real = realDeps(command);
	const { io, calls } = makeIO({ select: [undefined] });
	await runExecutionPrompt(baseExecutionDeps({
		io,
		command,
		decision: real.explanation.decision,
		explanation: real.explanation,
		allowPlan: null,
	}));
	const title = calls.select[0].split("\n@@")[0];
	assert.ok(title.includes("file redirect requires a redirect-aware allow rule"), "the reason prose is present", title);
	assert.ok(!title.includes("subcommand '"), "the reason no longer quotes the subcommand inline", title);
	assert.ok(title.includes("Failing step:"), title);
	assert.ok(title.includes("  cat > wl-debug.mts <<'EOF' (+2 more lines)"), title);
	assert.ok(!title.includes("Failing step:\n  cat > wl-debug.mts <<'EOF'\nconsole.log(1)"), "the failing step renders one line, not the full subcommand", title);
	assert.ok(title.includes("Breakdown unavailable:"), title);
});

test("an unavailable breakdown is explicitly marked in the prompt", async () => {
	const real = realDeps("for x in a b; do curl https://example.com; done");
	const { io, calls } = makeIO({ select: [undefined] });
	await runExecutionPrompt(baseExecutionDeps({
		io,
		command: real.call.command,
		decision: real.explanation.decision,
		explanation: real.explanation,
		allowPlan: null,
	}));
	const title = calls.select[0].split("\n@@")[0];
	assert.ok(title.includes("Breakdown unavailable:"), title);
	// The offending fragment (the per-step mismatch part) renders directly
	// below the reason line with the shared two-space gutter.
	assert.ok(
		title.includes("Breakdown unavailable: structural constructs (loops, conditionals) are not reliably attributed to steps\n  Offending step: do curl https://example.com"),
		title,
	);
	assert.ok(!title.includes("Breakdown:\n"), title);
});

test("an unavailable breakdown renders the offending fragment for a hidden conditional", async () => {
	const command = 'cd bottlecap && cargo fmt --all -- --check && cargo clippy --locked --workspace --all-targets --features default,test-mode --jobs 2 -- -D warnings > /tmp/bottlecap-simplify-clippy.log 2>&1 && cargo nextest run --locked --workspace --features test-mode --build-jobs 2 --test-threads 2 > /tmp/bottlecap-simplify-after.log 2>&1 && cargo test --locked --workspace --doc --features test-mode --jobs 2 > /tmp/bottlecap-simplify-doctests.log 2>&1; result=$?; tail -n 12 /tmp/bottlecap-simplify-clippy.log; tail -n 5 /tmp/bottlecap-simplify-after.log; if test -f /tmp/bottlecap-simplify-doctests.log; then tail -n 14 /tmp/bottlecap-simplify-doctests.log; fi; exit "$result"';
	const real = realDeps(command);
	const { io, calls } = makeIO({ select: [undefined] });
	await runExecutionPrompt(baseExecutionDeps({
		io,
		command: real.call.command,
		decision: real.explanation.decision,
		explanation: real.explanation,
		allowPlan: null,
	}));
	const title = calls.select[0].split("\n@@")[0];
	assert.ok(
		title.includes("Breakdown unavailable: structural constructs (loops, conditionals) are not reliably attributed to steps\n  Offending step: if test -f /tmp/bottlecap-simplify-doctests.log"),
		title,
	);
	assert.ok(!title.includes("Breakdown:\n"), title);
});

// ── Once outcomes and steering ──────────────────────────────────────────────

test("Deny once collects optional steering; empty input denies without steering", async () => {
	const { io, calls } = makeIO({ select: ["Deny once"], input: ["   "] });
	const outcome = await runExecutionPrompt(baseExecutionDeps({ io }));
	assert.deepEqual(outcome, { kind: "deny-once", explicit: true, steering: undefined });
	assert.equal(calls.input.length, 1);
});

test("Deny once with a nonempty instruction carries the steering text", async () => {
	const { io } = makeIO({ select: ["Deny once"], input: ["use the cache next time"] });
	const outcome = await runExecutionPrompt(baseExecutionDeps({ io }));
	assert.deepEqual(outcome, { kind: "deny-once", explicit: true, steering: "use the cache next time" });
});

test("Allow once skips steering entirely", async () => {
	const { io, calls } = makeIO({ select: ["Allow once"] });
	const outcome = await runExecutionPrompt(baseExecutionDeps({ io }));
	assert.deepEqual(outcome, { kind: "allow-once" });
	assert.equal(calls.input.length, 0);
});

// ── Allow save flow ─────────────────────────────────────────────────────────

test("save allow: editor with the bundle prefill, preview, confirm", async () => {
	const real = realDeps();
	const { io, calls } = makeIO({ select: ["Save allow for project", "Confirm"], editor: [undefined] });
	const outcome = await runExecutionPrompt(baseExecutionDeps({ io, allowPlan: real.allowPlan }));
	assert.equal(outcome.kind, "allow-once", "ordinary editor cancellation approves once without saving");
	// The editor opened with the glob bundle prefill and the cancellation consequence.
	assert.match(calls.editor[0], /@@prefill:HostBash\(curl https/);
	assert.match(calls.editor[0], /approves the current call once without saving/);
	// A faithful exact glob shows no advisory, and the callback is wired through.
	assert.match(calls.editor[0], /@@noteFor:present/);
	assert.match(calls.editor[0], /@@note:none/);
});

test("save allow: confirm returns the reviewed patch for the chosen scope", async () => {
	const real = realDeps();
	const rules = planRules(real.allowPlan!);
	const { io } = makeIO({ select: ["Save allow for user", "Confirm"], editor: [rules.join("\n")] });
	const outcome = await runExecutionPrompt(baseExecutionDeps({ io, allowPlan: real.allowPlan }));
	assert.equal(outcome.kind, "save-allow");
	assert.equal(outcome.scope, "user");
	assert.deepEqual(outcome.rules, rules);
	assert.deepEqual(outcome.patch, { hostBash: { allow: rules } });
});

test("save allow: an empty editor submission approves once without saving", async () => {
	const real = realDeps();
	const { io } = makeIO({ select: ["Save allow for project"], editor: ["  "] });
	const outcome = await runExecutionPrompt(baseExecutionDeps({ io, allowPlan: real.allowPlan }));
	assert.deepEqual(outcome, { kind: "allow-once" });
});

test("save allow: invalid edits preserve text and loop without saving", async () => {
	const real = realDeps();
	const good = planRules(real.allowPlan!).join("\n");
	const { io, calls } = makeIO({ select: ["Save allow for project", "Confirm"], editor: ["HostBash(broken", good] });
	const outcome = await runExecutionPrompt(baseExecutionDeps({ io, allowPlan: real.allowPlan }));
	assert.equal(outcome.kind, "save-allow");
	assert.equal(calls.notify.length, 1, "the parse error was surfaced");
	assert.ok(calls.editor[1].includes("@@prefill:HostBash(broken"), calls.editor[1]);
	assert.equal(calls.editor[2], undefined, "the valid edit went straight to preview");
});

test("save allow: an ineffective edit (partial bundle) loops with the validation error", async () => {
	const real = realDeps();
	const { io, calls } = makeIO({ select: ["Save allow for project", "Confirm"], editor: ["HostBash(/^echo a$/)", planRules(real.allowPlan!).join("\n")] });
	const outcome = await runExecutionPrompt(baseExecutionDeps({ io, allowPlan: real.allowPlan }));
	assert.equal(outcome.kind, "save-allow");
	assert.equal(calls.notify.length, 1);
	assert.match(calls.notify[0], /is not allowed by the edited rules/);
});

test("save allow: preview cancel saves nothing and approves once; Edit returns to the editor", async () => {
	const real = realDeps();
	const rules = planRules(real.allowPlan!);
	{
		const { io, calls } = makeIO({ select: ["Save allow for project", "Cancel save"], editor: [rules.join("\n")] });
		assert.deepEqual(await runExecutionPrompt(baseExecutionDeps({ io, allowPlan: real.allowPlan })), { kind: "allow-once" });
		assert.equal(calls.select[1].split("\n@@")[1], "Confirm|Edit|Cancel save", "a persistent allow save keeps the default cancelling label");
	}
	{
		const { io, calls } = makeIO({ select: ["Save allow for project", "Edit", "Confirm"], editor: [rules.join("\n"), rules.join("\n")] });
		const outcome = await runExecutionPrompt(baseExecutionDeps({ io, allowPlan: real.allowPlan }));
		assert.equal(outcome.kind, "save-allow");
		assert.equal(calls.editor.length, 2, "Edit re-opened the editor without mutating anything");
	}
});

test("the preview always renders the final entries, destination, and effect", async () => {
	const real = realDeps();
	const rules = planRules(real.allowPlan!);
	const { io, calls } = makeIO({ select: ["Save allow for project", "Confirm"], editor: [rules.join("\n")] });
	await runExecutionPrompt(baseExecutionDeps({ io, allowPlan: real.allowPlan }));
	const preview = calls.select[1].split("\n@@")[0];
	assert.ok(preview.includes("Rules to save:"), preview);
	assert.ok(preview.includes(rules[0]));
	assert.ok(preview.includes("Destination: /home/user/proj/.pi/guard.local.json"));
	assert.ok(preview.includes("each rule permits its matching step independently, including outside this sequence"));
});

// ── Per-step allow picker flow ───────────────────────────────────────────────

const compoundCommand = "curl https://example.com && echo ok && curl https://example.org";

test("per-step plan with multiple prompting steps opens the picker with prompting steps preselected and allowed steps unselectable", async () => {
	const real = realDeps(compoundCommand);
	assert.ok(real.allowPlan && real.allowPlan.kind === "per-step");
	const rules = planRules(real.allowPlan);
	const { io, calls } = makeIO({ select: ["Save allow for project", "Confirm"], picker: [[0, 1, 2]], editor: [rules.join("\n")] });
	const outcome = await runExecutionPrompt(baseExecutionDeps({ io, command: compoundCommand, decision: real.explanation.decision, explanation: real.explanation, allowPlan: real.allowPlan }));
	assert.equal(outcome.kind, "save-allow");
	assert.ok(outcome.kind === "save-allow");
	assert.equal(outcome.planKind, "per-step");
	assert.deepEqual(outcome.selectedOccurrenceIds, [0, 2], "the allowed context row is filtered from the confirmed selection");
	assert.deepEqual(outcome.rules, rules);
	const [pickerTitle, labels, options, selectable] = calls.picker[0].split("\n@@");
	assert.match(pickerTitle, /Select the steps to allow \(project\)/);
	assert.match(pickerTitle, /curl https:\/\/example\.com && echo ok/);
	assert.deepEqual(labels.replace("labels:", "").split("|"), ["curl https://example.com", "echo ok", "curl https://example.org"]);
	const parsed = JSON.parse(options.replace("options:", ""));
	assert.deepEqual(parsed, { preselectedOccurrenceIds: [0, 2], requireSelection: false });
	assert.deepEqual(selectable.replace("selectable:", "").split("|"), ["yes", "no", "yes"], "the tier-allowed step is unselectable context");
	// The editor prefill carries only the prompting steps' glob rules.
	assert.ok(calls.editor[0].includes("@@prefill:HostBash(curl https:"), calls.editor[0]);
	assert.ok(!calls.editor[0].includes("prefill:HostBash(echo ok)"), "no rule is prefilled for the already-allowed step");
});

test("picker esc returns to the action menu with nothing granted or edited", async () => {
	const real = realDeps(compoundCommand);
	const { io, calls } = makeIO({ select: ["Save allow for project", "Allow once"], picker: [undefined] });
	const outcome = await runExecutionPrompt(baseExecutionDeps({ io, command: compoundCommand, decision: real.explanation.decision, explanation: real.explanation, allowPlan: real.allowPlan }));
	assert.deepEqual(outcome, { kind: "allow-once" });
	assert.equal(calls.select.length, 2, "the action menu was consumed twice");
	assert.equal(calls.editor.length, 0, "no editor was opened");
	assert.equal(calls.input.length, 0, "no steering was collected");
});

test("picker confirmed with zero selections returns to the action menu", async () => {
	const real = realDeps(compoundCommand);
	const { io, calls } = makeIO({ select: ["Save allow for project", "Deny once"], picker: [[]], input: [undefined] });
	const outcome = await runExecutionPrompt(baseExecutionDeps({ io, command: compoundCommand, decision: real.explanation.decision, explanation: real.explanation, allowPlan: real.allowPlan }));
	assert.deepEqual(outcome, { kind: "deny-once", explicit: true, steering: undefined });
	assert.equal(calls.select.length, 2, "the action menu was consumed twice");
	assert.equal(calls.editor.length, 0, "no editor was opened");
});

test("a picker result containing only unselectable rows is narrowed to nothing and returns to the menu", async () => {
	const real = realDeps(compoundCommand);
	const { io, calls } = makeIO({ select: ["Save allow for project", "Allow once"], picker: [[1]] });
	const outcome = await runExecutionPrompt(baseExecutionDeps({ io, command: compoundCommand, decision: real.explanation.decision, explanation: real.explanation, allowPlan: real.allowPlan }));
	assert.deepEqual(outcome, { kind: "allow-once" }, "selection hygiene drops unselectable rows; empty falls through to the menu");
	assert.equal(calls.select.length, 2, "the action menu was consumed twice");
	assert.equal(calls.editor.length, 0, "no editor was opened");
});

test("a single prompting step skips the picker and validates the single selection", async () => {
	const real = realDeps();
	const { io, calls } = makeIO({ select: ["Save allow for project", "Confirm"], editor: [planRules(real.allowPlan!).join("\n")] });
	const outcome = await runExecutionPrompt(baseExecutionDeps({ io, allowPlan: real.allowPlan }));
	assert.ok(outcome.kind === "save-allow");
	assert.equal(calls.picker.length, 0, "no picker for a single prompting step");
	assert.deepEqual(outcome.selectedOccurrenceIds, [1]);
	assert.equal(outcome.planKind, "per-step");
});

test("the per-step preview discloses partial saves and full coverage distinctly", async () => {
	const real = realDeps(compoundCommand);
	const rules = planRules(real.allowPlan!);
	// Partial selection: only the first prompting step.
	{
		const { io, calls } = makeIO({ select: ["Save allow for project", "Confirm"], picker: [[0]], editor: [rules[0]] });
		await runExecutionPrompt(baseExecutionDeps({ io, command: compoundCommand, decision: real.explanation.decision, explanation: real.explanation, allowPlan: real.allowPlan }));
		const preview = calls.select[1].split("\n@@")[0];
		assert.match(preview, /still prompts for the unselected steps/);
		assert.match(preview, /fresh approval dialog follows the commit/);
	}
	// Full selection: every prompting step.
	{
		const { io, calls } = makeIO({ select: ["Save allow for project", "Confirm"], picker: [[0, 2]], editor: [rules.join("\n")] });
		await runExecutionPrompt(baseExecutionDeps({ io, command: compoundCommand, decision: real.explanation.decision, explanation: real.explanation, allowPlan: real.allowPlan }));
		const preview = calls.select[1].split("\n@@")[0];
		assert.match(preview, /executes without a further prompt/);
		assert.doesNotMatch(preview, /still prompts/);
	}
});

test("a whole-call plan (unreliable breakdown) never opens the picker and keeps the whole-call rule editor", async () => {
	const real = realDeps("echo $(compute)");
	assert.ok(real.allowPlan && real.allowPlan.kind === "whole-call");
	const { io, calls } = makeIO({ select: ["Save allow for project", "Confirm"], editor: [real.allowPlan.rules.join("\n")] });
	const outcome = await runExecutionPrompt(baseExecutionDeps({ io, command: real.call.command, decision: real.explanation.decision, explanation: real.explanation, allowPlan: real.allowPlan }));
	assert.ok(outcome.kind === "save-allow");
	assert.equal(outcome.planKind, "whole-call");
	assert.deepEqual(outcome.selectedOccurrenceIds, []);
	assert.equal(calls.picker.length, 0, "no picker on the whole-call path");
	assert.match(calls.editor[0], /@@prefill:HostBash\(echo/);
	const preview = calls.select[1].split("\n@@")[0];
	assert.match(preview, /Effect: the rule permits the exact current command/);
});

test("save allow: a whole-call pwsh suggestion keeps the Pwsh namespace", async () => {
	const command = "Get-Thing *.txt";
	const policy = makePolicy();
	const call = shellCall(command, "pwsh");
	const explanation = explainHostShellCommand(call, policy);
	const allowPlan = planAllowSave(call, policy, explanation);
	assert.ok(allowPlan);
	assert.equal(allowPlan.kind, "whole-call", "pwsh breakdowns are unavailable, so the whole-call path is used");
	assert.deepEqual(planRules(allowPlan), ["Pwsh(Get-Thing *.txt)"]);
	const rules = planRules(allowPlan);
	const { io, calls } = makeIO({ select: ["Save allow for project", "Confirm"], editor: [rules.join("\n")] });
	const outcome = await runExecutionPrompt(baseExecutionDeps({
		io,
		command,
		shell: "pwsh",
		decision: explanation.decision,
		explanation,
		allowPlan,
		parseRules: (text) => parseShellRuleLines(text, "pwsh"),
		validateRules: (intent, list) => validateShellSave(call, policy, intent, list),
		validateAllowSave: (list, ids) => validateShellAllowSave(call, policy, list, ids),
		denyRulesFor: (ids) => planDenyRules(call, explanation, ids),
	}));
	assert.equal(outcome.kind, "save-allow");
	assert.ok(calls.editor[0].includes("@@prefill:Pwsh(Get-Thing *.txt)"), calls.editor[0]);
	assert.ok(!calls.editor[0].includes("HostBash("), calls.editor[0]);
	// The wildcard makes the prefilled rule wider than the command, so the
	// advisory appears (it never blocks the save).
	assert.match(calls.editor[0], /@@note:Note: this rule is not limited to the exact command shown/);
});

test("save allow: a broadened glob shows the advisory in the editor and the preview", async () => {
	const { io, calls } = makeIO({ select: ["Save allow for project", "Confirm"], editor: ["HostBash(curl https://example.com/*)"] });
	const outcome = await runExecutionPrompt(baseExecutionDeps({ io, command: "curl https://example.com/*" }));
	assert.equal(outcome.kind, "save-allow");
	assert.match(calls.editor[0], /@@noteFor:present/);
	assert.match(calls.editor[0], /@@note:Note: this rule is not limited to the exact command shown/);
	const preview = calls.select[1].split("\n@@")[0];
	assert.match(preview, /Note: this rule is not limited to the exact command shown/);
	assert.ok(preview.includes("Rules to save:"), preview);
	assert.equal(calls.notify.length, 0, "the advisory never notifies and never blocks");
});

test("save allow: the preview advisory follows the final edited rules, not the prefill", async () => {
	const real = realDeps();
	const { io, calls } = makeIO({ select: ["Save allow for project", "Confirm"], editor: ["HostBash(curl *)"] });
	const outcome = await runExecutionPrompt(baseExecutionDeps({ io, allowPlan: real.allowPlan }));
	assert.equal(outcome.kind, "save-allow");
	assert.deepEqual(outcome.rules, ["HostBash(curl *)"]);
	assert.match(calls.editor[0], /@@note:none/, "the exact prefill itself is not flagged");
	const preview = calls.select[1].split("\n@@")[0];
	assert.match(preview, /Note: this rule is not limited to the exact command shown/);
	assert.ok(!preview.includes("HostBash(curl https"), "the preview shows the edited rule, not the prefill");
});

test("the preview advisory is order-independent and counts every non-exact rule", async () => {
	for (const order of [["HostBash(curl *)", "HostBash(echo *)"], ["HostBash(echo *)", "HostBash(curl *)"]]) {
		const { io, calls } = makeIO({ select: ["Save allow for project", "Confirm"], picker: [[0, 1, 2]], editor: [order.join("\n")] });
		const outcome = await runExecutionPrompt(baseExecutionDeps({ io, command: compoundCommand }));
		assert.equal(outcome.kind, "save-allow");
		const preview = calls.select[1].split("\n@@")[0];
		assert.match(preview, /Note: 2 of these rules are not limited to the exact command shown/);
	}
});

// ── Session allow flow ──────────────────────────────────────────────────────

test("the session allow action follows Allow once when supported and is hidden otherwise", async () => {
	const real = realDeps();
	{
		const { io, calls } = makeIO({ select: [undefined] });
		await runExecutionPrompt(baseExecutionDeps({ io, allowPlan: real.allowPlan, sessionAllowSupported: true, sessionScopeLabel: "/home/user/proj" }));
		const options = calls.select[0].split("\n@@")[1].split("|");
		assert.deepEqual(options, ["Allow once", "Allow for this session", "Save allow for project", "Save allow for user", "Deny once", "Save deny for project", "Save deny for user"]);
	}
	{
		// Unsupported (no owned stages, or no resolvable workspace scope): hidden.
		const { io, calls } = makeIO({ select: [undefined] });
		await runExecutionPrompt(baseExecutionDeps({ io, allowPlan: real.allowPlan }));
		assert.doesNotMatch(calls.select[0], /Allow for this session/);
	}
	{
		// No eligible allow plan (for example an explicit ask rule): hidden.
		const { io, calls } = makeIO({ select: [undefined] });
		await runExecutionPrompt(baseExecutionDeps({ io, allowPlan: null, sessionAllowSupported: true }));
		assert.doesNotMatch(calls.select[0], /Allow for this session/);
	}
	{
		// A capability-limited host without the editor never sees it either.
		const { io, calls } = ioWithoutStages({ select: [undefined] });
		await runExecutionPrompt(baseExecutionDeps({ io, allowPlan: real.allowPlan, sessionAllowSupported: true }));
		assert.deepEqual(calls.select[0].split("\n@@")[1].split("|"), ["Allow once", "Deny once"]);
	}
});

test("session allow reuses the per-step picker/editor/preview and returns reviewed rules without a scope", async () => {
	const real = realDeps(compoundCommand);
	const rules = planRules(real.allowPlan!);
	const { io, calls } = makeIO({ select: ["Allow for this session", "Confirm"], picker: [[0, 2]], editor: [rules.join("\n")] });
	const outcome = await runExecutionPrompt(baseExecutionDeps({
		io,
		command: compoundCommand,
		decision: real.explanation.decision,
		explanation: real.explanation,
		allowPlan: real.allowPlan,
		sessionAllowSupported: true,
		sessionScopeLabel: "/home/user/proj",
	}));
	assert.equal(outcome.kind, "session-allow");
	assert.ok(outcome.kind === "session-allow");
	assert.equal(outcome.planKind, "per-step");
	assert.deepEqual(outcome.selectedOccurrenceIds, [0, 2]);
	assert.deepEqual(outcome.rules, rules);
	assert.ok(!("scope" in outcome), "a session outcome never carries a config scope");
	assert.ok(!("patch" in outcome), "a session outcome never carries a config patch");
	assert.match(calls.picker[0], /Select the steps to allow \(this session\)/);
	assert.match(calls.editor[0], /Edit the allow rules to grant \(this session\)/);
	assert.match(calls.editor[0], /approves the current call once without granting/);
	const preview = calls.select[1].split("\n@@")[0];
	assert.match(preview, /Confirm allow for this session\?/);
	assert.match(preview, /Destination: this session only/);
	assert.match(preview, /Lifetime: this session only/);
	assert.match(preview, /\/home\/user\/proj and its subdirectories/);
	assert.match(preview, /each rule permits its matching step independently/);
	assert.match(preview, /Cancelling here approves the current call once without granting/);
	assert.doesNotMatch(preview, /guard\.local\.json/, "no config destination is ever named");
	assert.equal(calls.select[1].split("\n@@")[1], "Confirm|Edit|Cancel grant", "the session preview never offers Cancel save");
});

test("session allow cancels like a persistent save: picker esc returns to the menu, editor/preview cancellation approves once", async () => {
	const real = realDeps(compoundCommand);
	{
		const { io, calls } = makeIO({ select: ["Allow for this session", "Allow once"], picker: [undefined] });
		const outcome = await runExecutionPrompt(baseExecutionDeps({ io, command: compoundCommand, decision: real.explanation.decision, explanation: real.explanation, allowPlan: real.allowPlan, sessionAllowSupported: true }));
		assert.deepEqual(outcome, { kind: "allow-once" });
		assert.equal(calls.select.length, 2, "the menu was reopened after the picker esc");
	}
	{
		const { io, calls } = makeIO({ select: ["Allow for this session", "Allow once"], picker: [[]] });
		const outcome = await runExecutionPrompt(baseExecutionDeps({ io, command: compoundCommand, decision: real.explanation.decision, explanation: real.explanation, allowPlan: real.allowPlan, sessionAllowSupported: true }));
		assert.deepEqual(outcome, { kind: "allow-once" });
		assert.equal(calls.select.length, 2, "an empty selection returns to the menu");
		assert.equal(calls.editor.length, 0, "an empty selection opens no editor");
	}
	{
		const { io } = makeIO({ select: ["Allow for this session"], editor: [undefined] });
		assert.deepEqual(await runExecutionPrompt(baseExecutionDeps({ io, allowPlan: real.allowPlan, sessionAllowSupported: true })), { kind: "allow-once" });
	}
	{
		const { io, calls } = makeIO({ select: ["Allow for this session", "Cancel grant"], editor: [planRules(real.allowPlan!).join("\n")] });
		assert.deepEqual(await runExecutionPrompt(baseExecutionDeps({ io, allowPlan: real.allowPlan, sessionAllowSupported: true })), { kind: "allow-once" });
		assert.equal(calls.select[1].split("\n@@")[1], "Confirm|Edit|Cancel grant", "the session preview's cancelling action is named for what it does");
	}
});

test("a whole-call session allow keeps the whole-call rule and preview", async () => {
	const real = realDeps("echo $(compute)");
	assert.ok(real.allowPlan && real.allowPlan.kind === "whole-call");
	const rules = real.allowPlan.rules;
	const { io, calls } = makeIO({ select: ["Allow for this session", "Confirm"], editor: [rules.join("\n")] });
	const outcome = await runExecutionPrompt(baseExecutionDeps({ io, command: real.call.command, decision: real.explanation.decision, explanation: real.explanation, allowPlan: real.allowPlan, sessionAllowSupported: true }));
	assert.ok(outcome.kind === "session-allow");
	assert.equal(outcome.planKind, "whole-call");
	assert.deepEqual(outcome.selectedOccurrenceIds, []);
	assert.equal(calls.picker.length, 0);
	const preview = calls.select[1].split("\n@@")[0];
	assert.match(preview, /Effect: the rule permits the exact current command/);
	assert.match(preview, /Destination: this session only/);
});

test("a forged session allow answer without support is rejected, never approved", async () => {
	const real = realDeps();
	const { io } = makeIO({ select: ["Allow for this session"] });
	await assert.rejects(
		runExecutionPrompt(baseExecutionDeps({ io, allowPlan: real.allowPlan, sessionAllowSupported: false })),
		/session allow was not offered/,
	);
});

// ── Deny save flow ──────────────────────────────────────────────────────────

test("save deny: the reliable breakdown opens a picker with nothing preselected", async () => {
	const { io, calls } = makeIO({ select: ["Save deny for project"], picker: [undefined] });
	const outcome = await runExecutionPrompt(baseExecutionDeps({ io }));
	assert.deepEqual(outcome, { kind: "deny-once", explicit: true, steering: undefined }, "picker cancellation denies once and still offers steering");
	assert.equal(calls.input.length, 1, "steering input was offered after the save cancellation");
	assert.ok(calls.picker[0].includes("curl https://example.com"));
});

test("save deny: a faithful deny prefill is silent; a hand-edited broad deny gets the advisory", async () => {
	{
		const { io, calls } = makeIO({ select: ["Save deny for project", "Confirm"], picker: [[1]], editor: [undefined] });
		const outcome = await runExecutionPrompt(baseExecutionDeps({ io }));
		assert.deepEqual(outcome, { kind: "deny-once", explicit: true, steering: undefined });
		assert.match(calls.editor[0], /@@note:none/, "the anchored exact deny prefill is never flagged");
	}
	{
		const { io, calls } = makeIO({ select: ["Save deny for project", "Confirm"], picker: [[1]], editor: ["HostBash(curl*)"] });
		const outcome = await runExecutionPrompt(baseExecutionDeps({ io }));
		assert.equal(outcome.kind, "save-deny");
		const preview = calls.select[1].split("\n@@")[0];
		assert.match(preview, /Note: this rule is not limited to the exact command shown/);
	}
});

test("save deny: picker selection prefills exact deny rules for the selected steps", async () => {
	const { io, calls } = makeIO({ select: ["Save deny for project", "Confirm"], picker: [[1]], editor: [undefined] });
	const outcome = await runExecutionPrompt(baseExecutionDeps({ io }));
	// The editor opened with the exact rule for step 1, then was cancelled.
	assert.match(calls.editor[0], /@@prefill:HostBash\(\/\^curl https/);
	assert.ok(calls.editor[0].includes("example"), calls.editor[0]);
	assert.match(calls.editor[0], /denies the current call once without saving/);
	assert.deepEqual(outcome, { kind: "deny-once", explicit: true, steering: undefined });
});

test("save deny: confirm returns the reviewed patch with steering collected before it", async () => {
	const { io, calls } = makeIO({ select: ["Save deny for user", "Confirm"], picker: [[0, 1]], editor: ["HostBash(/^echo a$/)\nHostBash(/^curl https:\\/\\/example\\.com$/)"], input: ["stop using curl"] });
	const outcome = await runExecutionPrompt(baseExecutionDeps({ io }));
	assert.equal(outcome.kind, "save-deny");
	assert.equal(outcome.scope, "user");
	assert.deepEqual(outcome.rules, ["HostBash(/^echo a$/)", "HostBash(/^curl https:\\/\\/example\\.com$/)"]);
	assert.deepEqual(outcome.patch, { hostBash: { deny: outcome.rules } });
	assert.equal(outcome.steering, "stop using curl");
	assert.ok(calls.input.length >= 1);
});

test("save deny: an unreliable breakdown opens a blank manual editor", async () => {
	const real = realDeps("for x in a b; do curl https://example.com; done");
	const { io, calls } = makeIO({ select: ["Save deny for project"], editor: [undefined] });
	await runExecutionPrompt(baseExecutionDeps({
		io,
		command: real.call.command,
		decision: real.explanation.decision,
		explanation: real.explanation,
		allowPlan: null,
	}));
	assert.equal(calls.picker.length, 0, "no picker for an unreliable breakdown");
	assert.ok(calls.editor[0].endsWith("@@prefill:"), calls.editor[0]);
});

test("save deny: manually entered whole-call rules must deny the complete call", async () => {
	const real = realDeps("echo a && curl https://example.com");
	const both = "HostBash(/^echo a$/)\nHostBash(/^curl https:\\/\\/example\\.com$/)";
	const { io, calls } = makeIO({ select: ["Save deny for project", "Confirm"], picker: [[1]], editor: ["HostBash(/^does-not-match$/)", both] });
	const outcome = await runExecutionPrompt(baseExecutionDeps({
		io,
		command: real.call.command,
		decision: real.explanation.decision,
		explanation: real.explanation,
		allowPlan: null,
	}));
	assert.equal(outcome.kind, "save-deny");
	assert.equal(calls.notify.length, 1, "the ineffective first edit was rejected with an error");
});

test("save deny: preview cancel denies once with steering offered", async () => {
	const { io, calls } = makeIO({ select: ["Save deny for project", "Cancel save"], picker: [[0]], editor: ["HostBash(/^echo a$/)"], input: [undefined] });
	const outcome = await runExecutionPrompt(baseExecutionDeps({ io }));
	assert.deepEqual(outcome, { kind: "deny-once", explicit: true, steering: undefined });
	assert.equal(calls.select[1].split("\n@@")[1], "Confirm|Edit|Cancel save", "a deny save keeps the default cancelling label");
});

// ── Read grant flow ─────────────────────────────────────────────────────────

function readDeps(overrides: Partial<Parameters<typeof runReadGrantPrompt>[0]> = {}): Parameters<typeof runReadGrantPrompt>[0] {
	return {
		io: makeIO().io,
		signal: signal(),
		workerName: "python",
		requestPath: "/home/user/shared/data.csv",
		suggestedRoot: "/home/user/shared",
		scopes: ["project", "user"],
		parseReadRoot: (text) => parseReadRootInput(text, "/home/user/proj"),
		validateRoot: (root) => root === "/home/user/shared" || root === "/home/user/shared/sub" ? { ok: true } : { ok: false, error: "The edited read root does not cover the requested path" },
		destination: (scope) => scope === "project" ? "/home/user/proj/.pi/guard.local.json" : "~/.pi/agent/guard.json",
		...overrides,
	};
}

test("read grant: session grant, explicit denial with steering, selector cancellation", async () => {
	{
		const { io } = makeIO({ select: ["Grant for session"] });
		assert.deepEqual(await runReadGrantPrompt(readDeps({ io })), { kind: "grant-session" });
	}
	{
		const { io, calls } = makeIO({ select: ["Deny"], input: ["use the dataset loader"] });
		assert.deepEqual(await runReadGrantPrompt(readDeps({ io })), { kind: "deny", steering: "use the dataset loader" });
		assert.equal(calls.input.length, 1);
	}
	{
		const { io, calls } = makeIO({ select: [undefined] });
		assert.deepEqual(await runReadGrantPrompt(readDeps({ io })), { kind: "no-grant" });
		assert.equal(calls.input.length, 0, "selector cancellation skips steering");
	}
});

test("read grant: a host without owned stages offers session grant and deny only", async () => {
	const { io, calls } = ioWithoutStages({ select: [undefined] });
	await runReadGrantPrompt(readDeps({ io }));
	const options = calls.select[0].split("\n@@")[1];
	assert.deepEqual(options.split("|"), ["Grant for session", "Deny"]);
});

test("read grant: root save confirm, unrelated-root loop, empty submission, and cancel", async () => {
	{
		const { io, calls } = makeIO({ select: ["Save for project", "Confirm"], editor: ["/home/user/shared"] });
		const outcome: ReadFlowOutcome = await runReadGrantPrompt(readDeps({ io }));
		assert.equal(outcome.kind, "save-root");
		assert.equal(outcome.root, "/home/user/shared");
		const preview = calls.select[1].split("\n@@")[0];
		assert.ok(preview.includes("Root: /home/user/shared"));
		assert.ok(preview.includes("Destination: /home/user/proj/.pi/guard.local.json"));
		assert.ok(preview.includes("discards worker state"));
		assert.match(calls.editor[0], /@@noteFor:absent/, "read-root saves never carry the shell advisory");
	}
	{
		const { io, calls } = makeIO({ select: ["Save for user", "Confirm"], editor: ["/somewhere/else", "/home/user/shared/sub"] });
		const outcome = await runReadGrantPrompt(readDeps({ io }));
		assert.equal(outcome.kind, "save-root");
		assert.equal(calls.notify.length, 1, "the unrelated root was rejected with an error");
		assert.ok(calls.editor[1].includes("@@prefill:/somewhere/else"), "invalid input preserved the submitted text");
		assert.equal(outcome.root, "/home/user/shared/sub");
	}
	{
		const { io } = makeIO({ select: ["Save for project"], editor: [""] });
		assert.deepEqual(await runReadGrantPrompt(readDeps({ io })), { kind: "no-grant" }, "an empty root submission grants nothing");
	}
	{
		const { io, calls } = makeIO({ select: ["Save for project", "Cancel save"], editor: ["/home/user/shared"] });
		assert.deepEqual(await runReadGrantPrompt(readDeps({ io })), { kind: "no-grant" }, "cancelling the root save grants nothing and is not an explicit denial");
		assert.equal(calls.select[1].split("\n@@")[1], "Confirm|Edit|Cancel save", "the read-root preview is untouched by the session label");
	}
});

// ── Pure helpers ────────────────────────────────────────────────────────────

test("collectSteering trims and drops empty instructions", async () => {
	const { io } = makeIO({ input: ["  " ] });
	assert.equal(await collectSteering(io, signal(), "ctx"), undefined);
	const { io: io2 } = makeIO({ input: ["  do x  "] });
	assert.equal(await collectSteering(io2, signal(), "ctx"), "do x");
});

test("validation helpers never call the classifier and stay deterministic", () => {
	const real = realDeps();
	// Running validation twice produces the identical result.
	const rules = planRules(real.allowPlan!);
	const once = validateShellAllowSave(real.call, real.policy, rules, [1]);
	const twice = validateShellAllowSave(real.call, real.policy, rules, [1]);
	assert.deepEqual(once, twice);
	assert.ok(once.ok);
});

// ── Write/edit approval flow ──────────────────────────────────────────────────

function writeEditDeps(overrides: Partial<Parameters<typeof runWriteEditPrompt>[0]> = {}) {
	return {
		io: makeIO().io,
		signal: signal(),
		toolName: "edit",
		path: "/home/user/proj/src/a.ts",
		decision: { action: "prompt" as const, reason: "write/edit requires approval in the default profile" },
		offerSwitch: false,
		...overrides,
	};
}

test("write/edit flow: allow once, deny once with steering, esc denies non-explicitly", async () => {
	{
		const { io, calls } = makeIO({ select: ["Allow once"] });
		const outcome = await runWriteEditPrompt(writeEditDeps({ io }));
		assert.deepEqual(outcome, { kind: "allow-once" });
		assert.equal(calls.input.length, 0, "allow never collects steering");
	}
	{
		const { io, calls } = makeIO({ select: ["Deny once"], input: ["try the test-first approach instead"] });
		const outcome = await runWriteEditPrompt(writeEditDeps({ io }));
		assert.deepEqual(outcome, { kind: "deny-once", explicit: true, steering: "try the test-first approach instead" });
		assert.equal(calls.input.length, 1, "explicit denial collects steering");
	}
	{
		// Empty steering input is dropped; the call is denied either way.
		const { io } = makeIO({ select: ["Deny once"], input: ["   "] });
		const outcome = await runWriteEditPrompt(writeEditDeps({ io }));
		assert.deepEqual(outcome, { kind: "deny-once", explicit: true, steering: undefined });
	}
	{
		// esc / selector cancellation: non-explicit deny, no steering.
		const { io, calls } = makeIO({ select: [undefined] });
		const outcome = await runWriteEditPrompt(writeEditDeps({ io }));
		assert.deepEqual(outcome, { kind: "deny-once", explicit: false, steering: undefined });
		assert.equal(calls.input.length, 0, "selector cancellation skips steering");
	}
});

test("write/edit flow: the switch option appears only when offered and returns the switch outcome", async () => {
	{
		const { io, calls } = makeIO({ select: ["Switch to allow-edits"] });
		const outcome = await runWriteEditPrompt(writeEditDeps({ io, offerSwitch: true }));
		assert.deepEqual(outcome, { kind: "switch-to-allow-edits" });
		assert.match(calls.select[0], /Switch to allow-edits/, "the option is in the selector when offered");
	}
	{
		const { io, calls } = makeIO({ select: ["Allow once"] });
		await runWriteEditPrompt(writeEditDeps({ io, offerSwitch: false }));
		assert.doesNotMatch(calls.select[0], /Switch to allow-edits/, "out-of-root and protected targets never see the switch");
	}
	{
		// A switch option in the script without the flag is an unexpected answer.
		const { io } = makeIO({ select: ["Switch to allow-edits"] });
		await assert.rejects(runWriteEditPrompt(writeEditDeps({ io, offerSwitch: false })), /unexpected write\/edit approval answer/);
	}
});

test("write/edit flow: the title names the tool, the path, and the reason", async () => {
	const title = writeEditPromptTitle({
		toolName: "write",
		path: "/home/user/proj/src/new.ts",
		decision: { action: "prompt", reason: "write outside cwd and every write root" },
	});
	assert.match(title, /Allow Write\?/);
	assert.match(title, /\/home\/user\/proj\/src\/new\.ts/);
	assert.match(title, /write outside cwd and every write root/);
});
