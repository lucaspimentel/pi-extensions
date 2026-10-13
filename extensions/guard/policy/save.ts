/**
 * Pure helpers for the save/deny/compound prompt flows (design contract:
 * docs/guard-design.md "Save, deny, and compound prompts"). Everything here
 * is policy-plane only: no UI, no classifier calls, no persistence, no
 * runtime/queue access. Parsing and validation operate on the exact
 * evaluation subjects from decision.ts so suggestions anchor to what the
 * evaluator matched, and edited patches are validated as complete
 * hypothetical merges against the whole original call.
 */

import type { GuardCall, HostShellExplanation, PolicyState } from "./decision.ts";
import { decide } from "./decision.ts";
import type { SuggestedPatch } from "./suggest.ts";
import { effectiveAllowSuggestion } from "./suggest.ts";
import { normalizeMatchPath } from "./paths.ts";
import { normalizeTool, parseRule } from "./rules.ts";
import { dedupe } from "./config.ts";
import { homedir } from "node:os";

/** The rule tool name for a shell namespace (mirrors decision.ts). */
export function ruleToolForNamespace(shell: "host-bash" | "pwsh"): "HostBash" | "Pwsh" {
	return shell === "pwsh" ? "Pwsh" : "HostBash";
}

/** Escape a subject into an anchored exact pattern (same form as suggestRule). */
export function escapeExactPattern(subject: string): string {
	return subject.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/** The anchored exact allow rule for one step's plain-allow matching subject. */
export function exactAllowRule(shell: "host-bash" | "pwsh", allowSubject: string): string {
	return `${ruleToolForNamespace(shell)}(/^${escapeExactPattern(allowSubject)}$/)`;
}

/** The anchored exact deny rule for one step's deny/ask matching subject. */
export function exactDenyRule(shell: "host-bash" | "pwsh", subject: string): string {
	return `${ruleToolForNamespace(shell)}(/^${escapeExactPattern(subject)}$/)`;
}

export type ParseResult = { ok: true; rules: string[] } | { ok: false; error: string };

/**
 * Parse editor text into host-shell rule expressions: one complete rule per
 * nonempty line, parsed with the existing grammar. Wrong shell namespaces
 * and non-compiling patterns are rejected; glob/regex/tool-wide broadening
 * is accepted here and reviewed through the caller's preview.
 */
/**
 * Parse one editor line into a host-shell rule expression. Wrong shell
 * namespaces and non-compiling patterns are rejected; glob/regex/tool-wide
 * broadening is accepted here and reviewed through the caller's preview.
 */
export function parseShellRuleLine(raw: string, shell: "host-bash" | "pwsh"): { ok: true; rule: string } | { ok: false; error: string } {
	const line = raw.trim();
	if (!line) return { ok: false, error: "empty rule" };
	const expected = ruleToolForNamespace(shell);
	let parsed: ReturnType<typeof parseRule>;
	try {
		parsed = parseRule(line);
	} catch (err) {
		return { ok: false, error: `rule does not compile: ${err instanceof Error ? err.message : String(err)}` };
	}
	if (!parsed) return { ok: false, error: `not a rule expression (expected ${expected}(pattern) or ${expected})` };
	if (parsed.tool !== normalizeTool(expected)) return { ok: false, error: `rule tool must be ${expected} for this command's shell namespace` };
	return { ok: true, rule: parsed.raw };
}

/**
 * Parse editor text into host-shell rule expressions: one complete rule per
 * nonempty line, parsed with the existing grammar.
 */
export function parseShellRuleLines(text: string, shell: "host-bash" | "pwsh"): ParseResult {
	const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
	if (lines.length === 0) return { ok: false, error: "no rules entered" };
	const rules: string[] = [];
	const errors: string[] = [];
	for (const [index, line] of lines.entries()) {
		const parsed = parseShellRuleLine(line, shell);
		if (parsed.ok) rules.push(parsed.rule);
		else errors.push(`line ${index + 1}: ${parsed.error}`);
	}
	if (errors.length > 0) return { ok: false, error: errors.join("\n") };
	return { ok: true, rules: dedupe(rules) };
}

/** Merge rules additively into one hostBash slot of the policy config. */
function policyWithSlot(policy: PolicyState, intent: "allow" | "deny", rules: readonly string[]): PolicyState {
	const slot = policy.config.hostBash[intent];
	return {
		...policy,
		config: {
			...policy.config,
			hostBash: { ...policy.config.hostBash, [intent]: dedupe([...slot, ...rules]) },
		},
	};
}

export type ValidationResult = { ok: true } | { ok: false; error: string };

/**
 * Validate a complete hypothetical merge: with the edited rules added, the
 * ORIGINAL call (never fragments) must resolve to a deterministic allow
 * (explicit ask rules still prohibit allow-saving) or an effective deny.
 * Existing ask/deny entries are preserved and still apply first.
 */
export function validateShellSave(
	call: Extract<GuardCall, { kind: "host-shell" }>,
	policy: PolicyState,
	intent: "allow" | "deny",
	rules: readonly string[],
): ValidationResult {
	const decision = decide(policyWithSlot(policy, intent, rules), call);
	if (intent === "allow") {
		if (decision.action === "allow") return { ok: true };
		return { ok: false, error: `the edited rules would not allow the complete call (still: ${decision.reason})` };
	}
	if (decision.action === "deny") return { ok: true };
	return { ok: false, error: `the edited rules would not deny the complete call (${decision.reason})` };
}

/** An allow-save plan: either the provably effective whole-call exact rule or a per-step bundle. */
export interface AllowSavePlan {
	kind: "whole-call" | "bundle";
	rules: string[];
	patch: SuggestedPatch;
}

/**
 * Plan the allow-save offer for a prompt. Explicit ask prohibitions apply.
 * Preference order: the existing exact whole-call suggestion when it
 * provably authorizes the entire call; otherwise a per-step bundle for a
 * reliable breakdown (rules only for steps lacking effective permission,
 * anchored to each evaluator allow subject). When neither provably works,
 * no allow-save is offered and no guessed rules are generated.
 */
export function planAllowSave(
	call: Extract<GuardCall, { kind: "host-shell" }>,
	policy: PolicyState,
	explanation: HostShellExplanation,
): AllowSavePlan | null {
	if (explanation.decision.provenance === "explicit-ask") return null;
	const whole = effectiveAllowSuggestion(call, policy);
	if (whole?.hostBash?.allow?.length) return { kind: "whole-call", rules: whole.hostBash.allow, patch: whole };
	if (!explanation.breakdown.available) return null;
	const rules = dedupe(explanation.steps
		.filter((step) => step.decision.action !== "allow")
		.map((step) => exactAllowRule(call.shell, step.allowSubject)));
	if (rules.length === 0) return null;
	const validation = validateShellSave(call, policy, "allow", rules);
	if (!validation.ok) return null;
	return { kind: "bundle", rules, patch: { hostBash: { allow: rules } } };
}

/**
 * Exact deny rules for the selected step occurrence IDs (deny rules match
 * the evaluator's normalized subject). Dedupe collapses identical command
 * text; identity is preserved by occurrence ID at the picker level.
 */
export function planDenyRules(
	call: Extract<GuardCall, { kind: "host-shell" }>,
	explanation: HostShellExplanation,
	selectedOccurrenceIds: readonly number[],
): string[] {
	const byId = new Map(explanation.steps.map((step) => [step.occurrenceId, step]));
	const rules = selectedOccurrenceIds
		.map((id) => byId.get(id))
		.filter((step): step is NonNullable<typeof step> => step !== undefined)
		.map((step) => exactDenyRule(call.shell, step.subject));
	return dedupe(rules);
}

export type ReadRootParseResult = { ok: true; root: string } | { ok: false; error: string };

/**
 * Parse read-root editor text: one plain path, resolved against the captured
 * cwd with the existing normalization (including ~ and Git Bash drive forms).
 */
export function parseReadRootInput(text: string, cwd: string): ReadRootParseResult {
	const trimmed = text.trim();
	if (!trimmed || /[\r\n]/.test(trimmed)) return { ok: false, error: "enter exactly one directory path" };
	if (/\s/.test(trimmed)) return { ok: false, error: "the read root must be a single path without whitespace" };
	// Expand a leading ~ (normalizeMatchPath does not expand it).
	const expanded = trimmed === "~" || trimmed.startsWith("~/") ? `${homedir()}${trimmed.slice(1)}` : trimmed;
	return { ok: true, root: normalizeMatchPath(expanded, cwd) };
}
