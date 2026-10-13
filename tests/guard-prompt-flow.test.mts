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
	type ExecutionFlowOutcome,
	type PromptFlowIO,
	type ReadFlowOutcome,
} from "../extensions/guard/prompt-flow.ts";
import type { AllowSavePlan } from "../extensions/guard/policy/save.ts";
import { mergeConfig, type GuardConfig } from "../extensions/guard/policy/config.ts";
import { decide, explainHostShellCommand, type PolicyState } from "../extensions/guard/policy/decision.ts";
import { parseReadRootInput, parseShellRuleLines, planAllowSave, planDenyRules, validateShellSave } from "../extensions/guard/policy/save.ts";

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
		editor: async (title, prefill) => {
			calls.editor.push(`${title}\n@@prefill:${prefill}`);
			return script.editor?.shift();
		},
		picker: async (title, steps) => {
			calls.picker.push(`${title}\n@@${steps.map((s) => s.label).join("|")}`);
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

function baseExecutionDeps(overrides: Partial<Parameters<typeof runExecutionPrompt>[0]> = {}): Parameters<typeof runExecutionPrompt>[0] {
	const real = realDeps();
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
		denyRulesFor: (ids) => planDenyRules(real.call, real.explanation, ids),
		destination: (scope) => scope === "project" ? "/home/user/proj/.pi/guard.local.json" : "~/.pi/agent/guard.json",
		...overrides,
	};
}

// ── Action menu and initial cancellation ────────────────────────────────────

test("a capable TUI offers the flat action menu with eligible saves", async () => {
	const { io, calls } = makeIO({ select: [undefined] });
	await runExecutionPrompt(baseExecutionDeps({ io, allowPlan: { kind: "bundle", rules: ["HostBash(/^curl https:\\/\\/example\\.com$/)"], patch: { hostBash: { allow: ["HostBash(/^curl https:\\/\\/example\\.com$/)"] } } } }));
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
	await runExecutionPrompt(baseExecutionDeps({ io, allowPlan: { kind: "bundle", rules: ["HostBash(x)"], patch: { hostBash: { allow: ["HostBash(x)"] } } } }));
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
	assert.ok(title.includes("command:"), title);
	assert.ok(title.includes("│ echo a && curl https://example.com"), "the command block is gutter-marked");
	assert.ok(title.includes("1. echo a -> allow"));
	assert.ok(title.includes("2. curl https://example.com -> prompt"));
});

test("a multi-line failing subcommand renders as a labeled gutter block, not inline prose", async () => {
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
	assert.ok(title.includes("failing step:"), title);
	assert.ok(title.includes("│ cat > wl-debug.mts <<'EOF'"), title);
	assert.ok(title.includes("│ console.log(1)"), title);
	assert.ok(title.includes("│ EOF"), title);
	assert.ok(title.includes("step breakdown unavailable"), title);
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
	assert.ok(title.includes("step breakdown unavailable"), title);
	assert.ok(!title.includes("1. "));
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
	// The editor opened with the exact bundle prefill and the cancellation consequence.
	assert.match(calls.editor[0], /@@prefill:HostBash\(\/\^curl https/);
	assert.match(calls.editor[0], /approves the current call once without saving/);
});

test("save allow: confirm returns the reviewed patch for the chosen scope", async () => {
	const real = realDeps();
	const rules = real.allowPlan!.rules;
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
	const good = real.allowPlan!.rules.join("\n");
	const { io, calls } = makeIO({ select: ["Save allow for project", "Confirm"], editor: ["HostBash(broken", good] });
	const outcome = await runExecutionPrompt(baseExecutionDeps({ io, allowPlan: real.allowPlan }));
	assert.equal(outcome.kind, "save-allow");
	assert.equal(calls.notify.length, 1, "the parse error was surfaced");
	assert.ok(calls.editor[1].includes("@@prefill:HostBash(broken"), calls.editor[1]);
	assert.equal(calls.editor[2], undefined, "the valid edit went straight to preview");
});

test("save allow: an ineffective edit (partial bundle) loops with the validation error", async () => {
	const real = realDeps();
	const { io, calls } = makeIO({ select: ["Save allow for project", "Confirm"], editor: ["HostBash(/^echo a$/)", real.allowPlan!.rules.join("\n")] });
	const outcome = await runExecutionPrompt(baseExecutionDeps({ io, allowPlan: real.allowPlan }));
	assert.equal(outcome.kind, "save-allow");
	assert.equal(calls.notify.length, 1);
	assert.match(calls.notify[0], /would not allow the complete call/);
});

test("save allow: preview cancel saves nothing and approves once; Edit returns to the editor", async () => {
	const real = realDeps();
	const rules = real.allowPlan!.rules;
	{
		const { io } = makeIO({ select: ["Save allow for project", "Cancel save"], editor: [rules.join("\n")] });
		assert.deepEqual(await runExecutionPrompt(baseExecutionDeps({ io, allowPlan: real.allowPlan })), { kind: "allow-once" });
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
	const rules = real.allowPlan!.rules;
	const { io, calls } = makeIO({ select: ["Save allow for project", "Confirm"], editor: [rules.join("\n")] });
	await runExecutionPrompt(baseExecutionDeps({ io, allowPlan: real.allowPlan }));
	const preview = calls.select[1].split("\n@@")[0];
	assert.ok(preview.includes("rules to save:"), preview);
	assert.ok(preview.includes(rules[0]));
	assert.ok(preview.includes("destination: /home/user/proj/.pi/guard.local.json"));
	assert.ok(preview.includes("each rule permits its matching step independently, including outside this sequence"));
});

// ── Deny save flow ──────────────────────────────────────────────────────────

test("save deny: the reliable breakdown opens a picker with nothing preselected", async () => {
	const { io, calls } = makeIO({ select: ["Save deny for project"], picker: [undefined] });
	const outcome = await runExecutionPrompt(baseExecutionDeps({ io }));
	assert.deepEqual(outcome, { kind: "deny-once", explicit: true, steering: undefined }, "picker cancellation denies once and still offers steering");
	assert.equal(calls.input.length, 1, "steering input was offered after the save cancellation");
	assert.ok(calls.picker[0].includes("curl https://example.com"));
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
	const { io } = makeIO({ select: ["Save deny for project", "Cancel save"], picker: [[0]], editor: ["HostBash(/^echo a$/)"], input: [undefined] });
	const outcome = await runExecutionPrompt(baseExecutionDeps({ io }));
	assert.deepEqual(outcome, { kind: "deny-once", explicit: true, steering: undefined });
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
		assert.ok(preview.includes("root: /home/user/shared"));
		assert.ok(preview.includes("destination: /home/user/proj/.pi/guard.local.json"));
		assert.ok(preview.includes("discards worker state"));
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
		const { io } = makeIO({ select: ["Save for project", "Cancel save"], editor: ["/home/user/shared"] });
		assert.deepEqual(await runReadGrantPrompt(readDeps({ io })), { kind: "no-grant" }, "cancelling the root save grants nothing and is not an explicit denial");
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
	const once = validateShellSave(real.call, real.policy, "allow", real.allowPlan!.rules);
	const twice = validateShellSave(real.call, real.policy, "allow", real.allowPlan!.rules);
	assert.deepEqual(once, twice);
	assert.ok(once.ok);
});
