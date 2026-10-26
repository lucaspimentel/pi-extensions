/**
 * Authority-free orchestration for the guard save/deny/compound prompt flows
 * (design contract: docs/guard-design.md "Save, deny, and compound prompts").
 *
 * Everything here is UI only: stage sequencing, editor/validation loops,
 * previews, and steering collection over INJECTED stage functions and
 * validators. Prompt flows never write configuration, change policy, send
 * steering, execute tools, create approval epochs, or touch the runtime.
 * Callers (index.ts) own persistence, transitions, and the steering handoff,
 * and revalidate the returned outcomes at the final commit barrier.
 *
 * Typed outcomes distinguish explicit user denial, initial-selector
 * cancellation, ordinary save cancellation, once approval, reviewed
 * persistent saves, reviewed memory-only session grants, root
 * grant/no-grant. Owner invalidation never appears here: it propagates as a
 * thrown error through the dialog signal, never as an ordinary cancellation
 * result.
 */

import type { ConfigScope, SuggestedPatch } from "./policy/suggest.ts";
import { notExactShellRules, type AllowSavePlan } from "./policy/save.ts";
import type { Decision, GuardCall, HostShellExplanation } from "./policy/decision.ts";
import type { GuardPickerStep } from "./ask-components.ts";

/** Injected UI surface. Every method takes the stage's dialog signal. */
export interface PromptFlowIO {
	select(title: string, options: string[], signal: AbortSignal): Promise<string | undefined>;
	/**
	 * Owned editor stage; omitted when the host lacks the capabilities. The
	 * optional noteFor callback supplies a live advisory line for the current
	 * editor text; it is display-only and the stage may drop it.
	 */
	editor?(title: string, prefill: string, signal: AbortSignal, noteFor?: (text: string) => string | undefined): Promise<string | undefined>;
	/** Owned checkbox picker stage; omitted when the host lacks the capabilities. */
	picker?(title: string, steps: readonly GuardPickerStep[], signal: AbortSignal, options?: { preselectedOccurrenceIds?: readonly number[]; requireSelection?: boolean }): Promise<number[] | undefined>;
	/** Signal-aware native text input (steering; capability-limited fallback). */
	inputText(title: string, signal: AbortSignal): Promise<string | undefined>;
	notify(message: string, level?: "info" | "warning"): void;
}

export type SteeringText = string | undefined;

export type ExecutionFlowOutcome =
	| { kind: "allow-once" }
	| { kind: "deny-once"; explicit: boolean; steering: SteeringText }
	| { kind: "save-allow"; scope: ConfigScope; planKind: "whole-call" | "per-step"; rules: string[]; selectedOccurrenceIds: readonly number[]; patch: SuggestedPatch; previewText: string }
	| { kind: "session-allow"; planKind: "whole-call" | "per-step"; rules: string[]; selectedOccurrenceIds: readonly number[]; previewText: string }
	| { kind: "save-deny"; scope: ConfigScope; rules: string[]; patch: SuggestedPatch; steering: SteeringText; previewText: string };

export type ReadFlowOutcome =
	| { kind: "grant-session" }
	| { kind: "save-root"; scope: ConfigScope; root: string; previewText: string }
	| { kind: "deny"; steering: SteeringText }
	| { kind: "no-grant" };

/** The destination description for one scope (exact file path). */
export type DestinationFor = (scope: ConfigScope) => string;

/** Editor/validation loop result: either validated rules or an ordinary cancellation. */
type EditorLoopResult = { kind: "ok"; rules: string[]; text: string } | { kind: "cancelled" };

const ALLOW_EDITOR_CONSEQUENCE = "cancelling or empty submission approves the current call once without saving";
const SESSION_EDITOR_CONSEQUENCE = "cancelling or empty submission approves the current call once without granting";
const DENY_EDITOR_CONSEQUENCE = "cancelling or empty submission denies the current call once without saving";
const ROOT_EDITOR_CONSEQUENCE = "cancelling or empty submission grants nothing";

/**
 * The non-blocking advisory line for a rule set, or undefined when every rule
 * is the exact rendering of one of the reference subjects. Neutral wording on
 * purpose: a hand-edited rule may be narrower or wider than the subject, so
 * the note never claims proven broadening. Display-only.
 */
function notExactNoteFor(text: string, references: readonly string[]): string | undefined {
	const count = notExactShellRules(text, references).length;
	if (count === 0) return undefined;
	return count === 1
		? "Note: this rule is not limited to the exact command shown; it may match other commands and combinations."
		: `Note: ${count} of these rules are not limited to the exact command shown; they may match other commands and combinations.`;
}

/** Display names for the tools guard prompts for (OwnedExecutors plus pwsh routing). */
const TOOL_LABELS: Record<string, string> = { bash: "Bash", host_bash: "Bash", pwsh: "Pwsh", python: "Python", node: "Node" };

/** Match pi-tool-permissions' old prompt: full command truncated at 200 chars. */
function truncateCommand(text: string): string {
	return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}

/** Step action icon: allow ✓, deny ✗, ask/classify ? (matches the old breakdown icons). */
function actionIcon(action: string): string {
	if (action === "allow") return "✓";
	if (action === "deny") return "✗";
	return "?";
}

/**
 * One row per parsed step: two-space gutter, bracketed action icon, step text.
 * Every prompting (ask) step gets a `»` cursor instead of the blank gutter:
 * these are the steps a save would add rules for. Approval always runs the
 * complete command, so the cursor highlights steps; it never implies
 * per-step selection (old formatBreakdownLine).
 */
function breakdownRows(explanation: HostShellExplanation): string[] {
	return explanation.steps.map((step) => {
		const icon = actionIcon(step.decision.action);
		const gutter = icon === "?" ? " » " : "   ";
		return `${gutter}[${icon}] ${step.display}`;
	});
}

/** One-line failing-step display: first line, capped like the full command,
 *  plus a line-count note when the subcommand spans more lines (commit
 *  messages, heredocs); the full text stays in the Full command block. */
function failingStepLine(sub: string): string {
	const lines = sub.split("\n");
	const line = truncateCommand(lines[0]);
	return lines.length > 1 ? `${line} (+${lines.length - 1} more lines)` : line;
}

/**
 * One approval prompt in the pi-tool-permissions prompt format: a friendly
 * header, the full command, the per-step icon breakdown, and a trailing
 * "Why:" line with the aggregate decision reason. An unavailable breakdown is
 * explicitly marked (and the attributed failing step labeled); the original
 * execution is unchanged.
 */
export function executionPromptTitle(input: {
	toolName: string;
	command: string;
	decision: Decision;
	explanation: HostShellExplanation | null;
	shell: "host-bash" | "pwsh";
}): string {
	const explanation = input.explanation;
	let failingSub: string | undefined;
	let why = input.decision.reason;
	if (explanation?.failingSub) {
		const prefix = `subcommand '${explanation.failingSub}': `;
		if (input.decision.reason.startsWith(prefix)) {
			why = input.decision.reason.slice(prefix.length);
			failingSub = explanation.failingSub;
		}
	}
	const stepsAvailable = explanation !== null && explanation.breakdown.available && explanation.steps.length > 0;
	const shellLabel = input.shell === "pwsh" ? "Pwsh" : "Bash";
	const header = explanation === null
		? `Allow ${TOOL_LABELS[input.toolName] ?? input.toolName}?`
		: stepsAvailable && explanation.steps.length > 1 ? `Allow ${shellLabel} subcommand?` : `Allow ${shellLabel}?`;

	const lines: string[] = [header, ""];
	lines.push(explanation === null ? "Code:" : "Full command:", `  ${truncateCommand(input.command)}`);
	if (explanation) {
		if (stepsAvailable) {
			lines.push("", "Breakdown:", ...breakdownRows(explanation));
		} else {
			lines.push("", `Breakdown unavailable: ${explanation.breakdown.reason ?? "unreliable parsing"}`);
			if (explanation.breakdown.offending) lines.push(`  Offending step: ${truncateCommand(explanation.breakdown.offending)}`);
			if (failingSub) lines.push("", "Failing step:", `  ${failingStepLine(failingSub)}`);
		}
	}
	lines.push("", `Why: ${why}`);
	return lines.join("\n");
}

/** Collect the optional steering instruction after an explicit denial. */
export async function collectSteering(io: PromptFlowIO, signal: AbortSignal, contextLine: string): Promise<SteeringText> {
	const text = await io.inputText(
		`Optional instruction for the agent after this denial (empty or esc skips; the call is denied either way)\n${contextLine}`,
		signal,
	);
	const trimmed = text?.trim();
	return trimmed ? trimmed : undefined;
}

/**
 * Run one editor/validation loop. Invalid input preserves the submitted text
 * and loops with an error notice; it is never a cancellation. Ordinary
 * cancellation (esc) or an empty submission returns "cancelled" with the
 * documented fallback effect chosen by the caller.
 */
async function editorSaveLoop(
	io: PromptFlowIO,
	signal: AbortSignal,
	options: {
		title: string;
		consequence: string;
		prefill: string;
		/** Optional live advisory for the current editor text (display-only). */
		noteFor?: (text: string) => string | undefined;
		parse: (text: string) => { ok: true; rules: string[] } | { ok: false; error: string };
		validate: (rules: string[]) => { ok: true } | { ok: false; error: string };
	},
): Promise<EditorLoopResult> {
	if (!io.editor) throw new Error("guard: the editor stage is unavailable; save actions must not be offered");
	let text = options.prefill;
	for (;;) {
		const submitted = await io.editor(`${options.title}\n${options.consequence}`, text, signal, options.noteFor);
		if (submitted === undefined || submitted.trim() === "") return { kind: "cancelled" };
		const parsed = options.parse(submitted);
		if (!parsed.ok) {
			io.notify(`guard: ${parsed.error}`, "warning");
			text = submitted;
			continue;
		}
		const validation = options.validate(parsed.rules);
		if (!validation.ok) {
			io.notify(`guard: ${validation.error}`, "warning");
			text = submitted;
			continue;
		}
		return { kind: "ok", rules: parsed.rules, text: submitted };
	}
}

/** One preview round-trip: Confirm, Edit (re-run the editor loop), or Cancel save. */
async function previewLoop(
	io: PromptFlowIO,
	signal: AbortSignal,
	options: {
		previewText: string;
		runEditor: () => Promise<EditorLoopResult>;
		buildPreview: (rules: string[]) => string;
	},
): Promise<{ kind: "confirm"; rules: string[]; previewText: string } | { kind: "cancelled" }> {
	let loop = await options.runEditor();
	while (loop.kind === "ok") {
		const answer = await io.select(options.buildPreview(loop.rules), ["Confirm", "Edit", "Cancel save"], signal);
		if (answer === "Confirm") return { kind: "confirm", rules: loop.rules, previewText: options.buildPreview(loop.rules) };
		if (answer === "Edit") {
			loop = await options.runEditor();
			continue;
		}
		// "Cancel save" or a cancelled preview dialog: an ordinary cancellation.
		return { kind: "cancelled" };
	}
	return { kind: "cancelled" };
}

/** Dependencies of runExecutionPrompt beyond the IO surface. */
export interface ExecutionPromptDeps {
	io: PromptFlowIO;
	signal: AbortSignal;
	toolName: string;
	command: string;
	decision: Decision;
	explanation: HostShellExplanation | null;
	allowPlan: AllowSavePlan | null;
	denySaveSupported: boolean;
	/**
	 * Offer "Allow for this session" (memory-only rules): eligible allow plan,
	 * owned editor stages, and a workspace whose canonical identity resolved.
	 * Omitted/false hosts never see the action.
	 */
	sessionAllowSupported?: boolean;
	/** Display-only label for the session grant's workspace scope. */
	sessionScopeLabel?: string;
	shell: "host-bash" | "pwsh";
	scopes: readonly ConfigScope[];
	parseRules(text: string): { ok: true; rules: string[] } | { ok: false; error: string };
	validateRules(intent: "allow" | "deny", rules: string[]): { ok: true } | { ok: false; error: string };
	/** Per-step allow-save validation over the selected occurrence IDs. */
	validateAllowSave(rules: string[], selectedOccurrenceIds: readonly number[]): { ok: true } | { ok: false; error: string };
	denyRulesFor(selectedOccurrenceIds: readonly number[]): string[];
	destination: DestinationFor;
}

/**
 * Run the execution-approval flow: flat actions, the per-step allow picker
 * with preselection, optional save editors with separate previews, and
 * post-denial steering. Returns a typed outcome; the caller performs all
 * persistence and the steering handoff. The outer loop exists so the allow
 * step picker can return to the action menu: escaping the picker or
 * confirming zero selections grants nothing, executes nothing, and reopens
 * the menu.
 */
export async function runExecutionPrompt(deps: ExecutionPromptDeps): Promise<ExecutionFlowOutcome> {
	const { io, signal } = deps;
	const editorAvailable = typeof io.editor === "function";
	const title = executionPromptTitle(deps);
	const sessionLabel = deps.sessionScopeLabel ?? "this workspace";
	for (;;) {
		const options = [
			"Allow once",
			...(deps.allowPlan && editorAvailable && deps.sessionAllowSupported ? ["Allow for this session"] : []),
			...(deps.allowPlan && editorAvailable ? deps.scopes.map((scope) => `Save allow for ${scope}`) : []),
			"Deny once",
			...(deps.denySaveSupported && editorAvailable ? deps.scopes.map((scope) => `Save deny for ${scope}`) : []),
		];
		const answer = await io.select(title, options, signal);
		// Initial selector cancellation denies without saving or steering.
		if (answer === undefined) return { kind: "deny-once", explicit: false, steering: undefined };
		if (answer === "Allow once") return { kind: "allow-once" };
		if (answer === "Deny once") {
			return { kind: "deny-once", explicit: true, steering: await collectSteering(io, signal, `denied: ${deps.command || deps.toolName}`) };
		}
		if (answer === "Allow for this session" || answer.startsWith("Save allow for ")) {
			// Hiding an action is not an authorization check: reject an answer the
			// caller never offered (a forged or scripted action string).
			const session = answer === "Allow for this session";
			if (!deps.allowPlan) throw new Error("guard: no validated allow plan; allow saving must not be offered");
			if (!editorAvailable) throw new Error("guard: the editor stage is unavailable; allow saving must not be offered");
			if (session && !deps.sessionAllowSupported) throw new Error("guard: session allow was not offered");
			const scope = session ? undefined : answer.slice("Save allow for ".length) as ConfigScope;
			// One label names the chosen destination in every stage of the flow.
			const target = session ? "this session" : scope!;
			const plan = deps.allowPlan;
			const prompting = (deps.explanation?.steps ?? []).filter((step) => step.decision.action !== "allow");
			// Per-step plans offer step selection (the deny picker component) when
			// more than one prompting step exists and the picker stage is
			// available; a single prompting step skips the picker, and a missing
			// picker stage degrades to the editor with every prompting step
			// preselected. Whole-call plans (unreliable breakdown) never offer
			// selection.
			let selected: readonly number[] = [];
			if (plan.kind === "per-step") {
				if (io.picker && prompting.length > 1) {
					const pickerSteps: GuardPickerStep[] = (deps.explanation?.steps ?? []).map((step) => ({
						occurrenceId: step.occurrenceId,
						label: step.display,
						detail: `${step.decision.action} (${step.decision.reason})`,
						selectable: step.decision.action !== "allow",
					}));
					// Prefills are glob-form (see the not-exact advisory), so the picker
					// deliberately does not call them "exact".
					const picked = await io.picker(
						`Select the steps to allow (${target})\nFull command:\n  ${truncateCommand(deps.command)}\nEach selected step gets a glob allow rule that also authorizes matching commands outside this sequence; deselect steps to narrow the ${session ? "grant" : "save"}`,
						pickerSteps,
						signal,
						{ preselectedOccurrenceIds: prompting.map((step) => step.occurrenceId), requireSelection: false },
					);
					// Picker esc or a confirmed empty selection returns to the action
					// menu: nothing granted, nothing executed, no abandoned editor text.
					if (picked === undefined) continue;
					const selectable = new Set(prompting.map((step) => step.occurrenceId));
					// Selection hygiene: keep only selectable prompting rows.
					const filtered = [...new Set(picked)].filter((id) => selectable.has(id));
					if (filtered.length === 0) continue;
					selected = filtered;
				} else {
					selected = prompting.map((step) => step.occurrenceId);
				}
			}
			const prefill = plan.kind === "per-step"
				? plan.perStep.filter((entry) => selected.includes(entry.occurrenceId)).map((entry) => entry.rule).join("\n")
				: plan.rules.join("\n");
			// The advisory compares each rule with the subjects this save was
			// planned from: the selected steps' evaluator allow subjects (a
			// redirect-requiring step keeps its verbatim subject), or the whole
			// command on the unreliable-breakdown path.
			const stepById = new Map((deps.explanation?.steps ?? []).map((step) => [step.occurrenceId, step]));
			const allowReferences: string[] = plan.kind === "per-step"
				? selected.map((id) => stepById.get(id)?.allowSubject).filter((value): value is string => value !== undefined)
				: [deps.command];
			const noteFor = (text: string): string | undefined => notExactNoteFor(text, allowReferences);
			const baseTitle = `Edit the allow rules to ${session ? "grant" : "save"} (${target})\nFull command:\n  ${truncateCommand(deps.command)}\nWhy: ${deps.decision.reason}`;
			const runEditor = (): Promise<EditorLoopResult> => editorSaveLoop(io, signal, {
				title: baseTitle,
				consequence: session ? SESSION_EDITOR_CONSEQUENCE : ALLOW_EDITOR_CONSEQUENCE,
				prefill,
				noteFor,
				parse: deps.parseRules,
				validate: plan.kind === "per-step"
					? (rules) => deps.validateAllowSave(rules, selected)
					: (rules) => deps.validateRules("allow", rules),
			});
			const coversPrompting = plan.kind === "per-step" && prompting.length > 0
				&& prompting.every((step) => selected.includes(step.occurrenceId));
			const buildPreview = (rules: string[]): string => {
				const note = notExactNoteFor(rules.join("\n"), allowReferences);
				const lines = [
					session ? "Confirm allow for this session?" : `Confirm allow save (${scope})?`,
					session ? "Rules to grant:" : "Rules to save:",
					...rules,
					...(note ? [note] : []),
					session ? "Destination: this session only (memory; nothing is written to the config)" : `Destination: ${deps.destination(scope!)}`,
				];
				if (session) lines.push(`Lifetime: this session only; the rules apply in ${sessionLabel} and its subdirectories, and are discarded when the session ends`);
				if (plan.kind === "per-step") {
					lines.push("Effect: each rule permits its matching step independently, including outside this sequence; together they allow the selected steps");
					if (coversPrompting) lines.push(session ? "The call executes without a further prompt after this grant" : "The call executes without a further prompt after this save");
					else lines.push(session ? "The call still prompts for the unselected steps; a fresh approval dialog follows the grant" : "The call still prompts for the unselected steps; a fresh approval dialog follows the commit");
				} else {
					lines.push("Effect: the rule permits the exact current command");
				}
				lines.push(session ? "Cancelling here approves the current call once without granting" : "Cancelling here approves the current call once without saving");
				return lines.join("\n");
			};
			const preview = await previewLoop(io, signal, {
				previewText: "",
				runEditor,
				buildPreview,
			});
			// Ordinary editor/preview cancellation saves nothing and approves once.
			if (preview.kind === "cancelled") return { kind: "allow-once" };
			if (session) return {
				kind: "session-allow",
				planKind: plan.kind,
				rules: preview.rules,
				selectedOccurrenceIds: plan.kind === "per-step" ? selected : [],
				previewText: preview.previewText,
			};
			return {
				kind: "save-allow",
				scope: scope!,
				planKind: plan.kind,
				rules: preview.rules,
				selectedOccurrenceIds: plan.kind === "per-step" ? selected : [],
				patch: { hostBash: { allow: preview.rules } },
				previewText: preview.previewText,
			};
		}
		if (answer.startsWith("Save deny for ")) {
			const scope = answer.slice("Save deny for ".length) as ConfigScope;
			// Reliable compound breakdown: a multi-select with nothing preselected.
			// Unreliable parsing: a blank manual editor.
			let prefill = "";
			// Deny rules match each step's normalized subject (never the
			// redirect-stripped allow subject); manual entry on an unreliable
			// breakdown compares against the whole command.
			let denyReferences: string[] = [deps.command];
			if (deps.explanation?.breakdown.available && deps.explanation.steps.length > 0 && io.picker) {
				const pickerSteps: GuardPickerStep[] = deps.explanation.steps.map((step) => ({
					occurrenceId: step.occurrenceId,
					label: step.display,
					detail: `${step.decision.action} (${step.decision.reason})`,
				}));
				const selected = await io.picker(
					`Select the steps to deny (${scope})\nFull command:\n  ${truncateCommand(deps.command)}\nMatching a selected step denies the whole call; the rules also deny matching commands outside this sequence`,
					pickerSteps,
					signal,
				);
				// Picker cancellation: an ordinary save cancellation (deny once, steering still offered).
				if (selected === undefined) {
					return { kind: "deny-once", explicit: true, steering: await collectSteering(io, signal, `denied: ${deps.command || deps.toolName}`) };
				}
				prefill = deps.denyRulesFor(selected).join("\n");
				denyReferences = deps.explanation.steps
					.filter((step) => selected.includes(step.occurrenceId))
					.map((step) => step.subject);
			}
			const noteFor = (text: string): string | undefined => notExactNoteFor(text, denyReferences);
			const baseTitle = `Edit the deny rules to save (${scope})\nFull command:\n  ${truncateCommand(deps.command)}\nWhy: ${deps.decision.reason}`;
			const runEditor = (): Promise<EditorLoopResult> => editorSaveLoop(io, signal, {
				title: baseTitle,
				consequence: DENY_EDITOR_CONSEQUENCE,
				prefill,
				noteFor,
				parse: deps.parseRules,
				validate: (rules) => deps.validateRules("deny", rules),
			});
			const buildPreview = (rules: string[]): string => {
				const note = notExactNoteFor(rules.join("\n"), denyReferences);
				return [
					`Confirm deny save (${scope})?`,
					"Rules to save:",
					...rules,
					...(note ? [note] : []),
					`Destination: ${deps.destination(scope)}`,
					"Effect: each rule denies matching commands independently, including outside this sequence; the current call is denied",
					"Cancelling here denies the current call once without saving",
				].join("\n");
			};
			const preview = await previewLoop(io, signal, { previewText: "", runEditor, buildPreview });
			// Ordinary cancellation of a deny save: deny once, steering still offered.
			if (preview.kind === "cancelled") {
				return { kind: "deny-once", explicit: true, steering: await collectSteering(io, signal, `denied: ${deps.command || deps.toolName}`) };
			}
			return {
				kind: "save-deny",
				scope,
				rules: preview.rules,
				patch: { hostBash: { deny: preview.rules } },
				steering: await collectSteering(io, signal, `denied: ${deps.command || deps.toolName}`),
				previewText: preview.previewText,
			};
		}
		throw new Error(`guard: unexpected approval answer: ${answer}`);
	}
}

/** Dependencies of runReadGrantPrompt beyond the IO surface. */
export interface ReadGrantPromptDeps {
	io: PromptFlowIO;
	signal: AbortSignal;
	workerName: string;
	/** Optional suffix appended to the title's first line, marking the requester as a nested tool call. */
	originSuffix?: string;
	requestPath: string;
	suggestedRoot: string;
	scopes: readonly ConfigScope[];
	parseReadRoot(text: string): { ok: true; root: string } | { ok: false; error: string };
	validateRoot(root: string): { ok: true } | { ok: false; error: string };
	destination: DestinationFor;
}

/**
 * Run the read-grant flow: session grant (unchanged semantics), persistent
 * project/user root saves through an editor and separate preview, and
 * explicit denial with optional steering. Cancellation of a root save grants
 * nothing and is not an explicit denial.
 */
export async function runReadGrantPrompt(deps: ReadGrantPromptDeps): Promise<ReadFlowOutcome> {
	const { io, signal } = deps;
	const editorAvailable = typeof io.editor === "function";
	const title = [
		`${deps.workerName} requests read-only access${deps.originSuffix ?? ""}`,
		"",
		"Path:",
		`  ${deps.requestPath}`,
		"",
		"Suggested root:",
		`  ${deps.suggestedRoot}`,
		"",
		"Granting discards worker state; code is never replayed",
	].join("\n");
	const options = [
		"Grant for session",
		...(editorAvailable ? deps.scopes.map((scope) => `Save for ${scope}`) : []),
		"Deny",
	];
	const answer = await io.select(title, options, signal);
	// Initial selector cancellation grants nothing (and skips steering).
	if (answer === undefined) return { kind: "no-grant" };
	if (answer === "Grant for session") return { kind: "grant-session" };
	if (answer === "Deny") {
		return { kind: "deny", steering: await collectSteering(io, signal, `read request denied: ${deps.requestPath}`) };
	}
	if (answer.startsWith("Save for ")) {
		const scope = answer.slice("Save for ".length) as ConfigScope;
		const baseTitle = `Edit the read root to save (${scope})\nRequest path: ${deps.requestPath}\nOne plain directory path`;
		if (!io.editor) throw new Error("guard: the editor stage is unavailable; root saves must not be offered");
		let current = deps.suggestedRoot;
		for (;;) {
			const submitted = await io.editor(`${baseTitle}\n${ROOT_EDITOR_CONSEQUENCE}`, current, signal);
			// Cancellation or an empty root submission grants nothing.
			if (submitted === undefined || submitted.trim() === "") return { kind: "no-grant" };
			const parsed = deps.parseReadRoot(submitted);
			if (!parsed.ok) {
				io.notify(`guard: ${parsed.error}`, "warning");
				current = submitted;
				continue;
			}
			const validation = deps.validateRoot(parsed.root);
			if (!validation.ok) {
				io.notify(`guard: ${validation.error}`, "warning");
				current = submitted;
				continue;
			}
			const previewText = [
				`Confirm read-root save (${scope})?`,
				`Root: ${parsed.root}`,
				`Destination: ${deps.destination(scope)}`,
				"Effect: read-only access to everything under this root; applying it discards worker state; code is never replayed",
				"Cancelling here grants nothing",
			].join("\n");
			const answer2 = await io.select(previewText, ["Confirm", "Edit", "Cancel save"], signal);
			if (answer2 === "Confirm") return { kind: "save-root", scope, root: parsed.root, previewText };
			if (answer2 === "Edit") continue;
			return { kind: "no-grant" };
		}
	}
	throw new Error(`guard: unexpected read-grant answer: ${answer}`);
}

/** Outcome of the write/edit approval flow. The caller performs the steering handoff and the profile transition. */
export type WriteEditFlowOutcome =
	| { kind: "allow-once" }
	| { kind: "deny-once"; explicit: boolean; steering: SteeringText }
	| { kind: "switch-to-allow-edits" };

/** Title for the write/edit approval dialog. */
export function writeEditPromptTitle(input: { toolName: string; path: string; decision: Decision }): string {
	const label = input.toolName.toLowerCase() === "edit" ? "Edit" : "Write";
	return [
		`Allow ${label}?`,
		"",
		"Path:",
		`  ${input.path}`,
		"",
		`Why: ${input.decision.reason}`,
	].join("\n");
}

/** Dependencies of runWriteEditPrompt beyond the IO surface. */
export interface WriteEditPromptDeps {
	io: PromptFlowIO;
	signal: AbortSignal;
	toolName: string;
	path: string;
	decision: Decision;
	/** Offer the Switch to allow-edits action: in-root, non-protected targets only. */
	offerSwitch: boolean;
}

/**
 * Run the write/edit approval flow: flat once actions plus, for in-root
 * non-protected targets, the switch to the allow-edits rung. Returns a typed
 * outcome; the caller performs the steering handoff and the profile
 * transition, and revalidates staleness before acting on either.
 */
export async function runWriteEditPrompt(deps: WriteEditPromptDeps): Promise<WriteEditFlowOutcome> {
	const { io, signal } = deps;
	const title = writeEditPromptTitle(deps);
	const options = ["Allow once", "Deny once", ...(deps.offerSwitch ? ["Switch to allow-edits"] : [])];
	const answer = await io.select(title, options, signal);
	// Initial selector cancellation denies without steering.
	if (answer === undefined) return { kind: "deny-once", explicit: false, steering: undefined };
	if (answer === "Allow once") return { kind: "allow-once" };
	if (answer === "Switch to allow-edits") {
		if (!deps.offerSwitch) throw new Error(`guard: unexpected write/edit approval answer: ${answer}`);
		return { kind: "switch-to-allow-edits" };
	}
	if (answer === "Deny once") {
		return { kind: "deny-once", explicit: true, steering: await collectSteering(io, signal, `denied: ${deps.toolName} ${deps.path}`) };
	}
	throw new Error(`guard: unexpected write/edit approval answer: ${answer}`);
}
