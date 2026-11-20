/**
 * Guard prompt records: one custom session entry per interactive prompt and
 * per refusal (design contract: docs/guard-design.md "Prompt records").
 *
 * Ledger only. A record never authorizes, denies, or changes a decision, and
 * a failed write is swallowed so a transcript problem can never become a
 * permission problem. Assembling the payload is as fallible as appending it,
 * so callers hand over a thunk and both steps run inside one try in
 * `writePromptRecord`. Nothing here awaits, and nothing here reads the
 * runtime.
 *
 * The entry type is versioned by name: a schema change ships as
 * `guard-prompt-v2` rather than reinterpreting records already written into
 * existing sessions.
 */
import { truncateCommand } from "./prompt-flow.ts";
import type { DecisionAction, GuardCall, HostShellExplanation } from "./policy/decision.ts";
import type { ShellCommandAnalysis } from "./policy/shellast.ts";

/** Session entry type of one prompt or refusal record. */
export const GUARD_PROMPT_CUSTOM_TYPE = "guard-prompt-v1";

/** The pre-dialog decision action the record was taken from. */
export type PromptAction = "allow" | "prompt" | "deny";

/**
 * What happened. Dialog answers reuse the prompt-flow outcome names
 * (prompt-flow.ts) so the record and the flow cannot drift: `deny-once` is any
 * outcome where the user denied the current call, `save-deny` keeps its own
 * name because it also wrote rules. The refusal kinds cover every way a call
 * is refused without an answer, and `deny` is reserved for a policy deny (a
 * rule, a profile cell, or a header-level block), never a user denial.
 */
export type PromptOutcome =
	| "allow-once"
	| "save-allow"
	| "session-allow"
	| "switch-profile"
	| "save-deny"
	| "deny-once"
	| "grant-session"
	| "save-root"
	| "no-grant"
	| "deny"
	| "headless-deny"
	| "expired"
	| "refused-rules"
	| "cancelled"
	| "error";

/** Config destination named by an outcome that wrote or granted something. */
export type PromptScope = "project" | "user" | "session";

/** The permanent payload of one `guard-prompt-v1` entry. */
export interface PromptRecord {
	tool: string;
	class: string;
	kind: string;
	/** Omitted only when no decision was reached (an abort or a dead runtime). */
	action?: PromptAction;
	outcome: PromptOutcome;
	/** Guard's canonical per-step subjects, capped like `display`. */
	subjects: string[];
	/** The capped text the dialog showed: the command, or the path. */
	display: string;
	reason: string;
	/** Omitted when no dialog opened; the whole lease, never the classifier. */
	dialogMs?: number;
	profile: string;
	fromCodemode: boolean;
	toolCallId: string;
	rules?: string[];
	scope?: PromptScope;
	root?: string;
	switchedTo?: string;
}

/** The per-call fields every record carries; captured before any dialog. */
export interface PromptRecordBase {
	tool: string;
	class: string;
	kind: string;
	action?: PromptAction;
	subjects: string[];
	display: string;
	reason: string;
	profile: string;
	fromCodemode: boolean;
	toolCallId: string;
}

/** Outcome-specific additions, all optional. */
export interface PromptRecordDetails {
	dialogMs?: number;
	rules?: readonly string[];
	scope?: PromptScope;
	root?: string;
	switchedTo?: string;
	/** Replaces the base reason (used by refusals, whose cause is the error). */
	reason?: string;
}

/** Cap one ledger string: the same 200-char rule the dialogs display with. */
export function promptRecordText(text: string): string {
	return truncateCommand(text);
}

/** Normalize a decision action: an unresolved "classify" is a prompt. */
export function promptActionFor(action: DecisionAction): PromptAction {
	if (action === "allow") return "allow";
	if (action === "deny") return "deny";
	return "prompt";
}

/** The capped display text for one call: the command for a shell call, else the path. */
export function promptCallText(call: GuardCall): string {
	if (call.kind === "host-shell" || call.kind === "sandboxed-exec") return promptRecordText(call.command ?? "");
	if (call.kind === "local-read" || call.kind === "local-write") return promptRecordText(call.path ?? "");
	return "";
}

/**
 * Guard's canonical per-step subjects for a host-shell call. The explanation's
 * steps are preferred (they are what the dialog and the rule prefills use); a
 * refusal that never built one falls back to the analysis, whose per-call
 * subjects are the same strings. An unfaithful projection yields none, and the
 * caller still has `display`.
 */
export function hostShellSubjects(explanation: HostShellExplanation | null, analysis: ShellCommandAnalysis | null): string[] {
	const steps = explanation?.steps ?? [];
	if (steps.length) return steps.map((step) => step.subject ?? step.display);
	return analysis?.calls.map((call) => call.subject ?? call.rawSubject) ?? [];
}

/**
 * The subjects for one call: guard's canonical shell subjects, or the bare
 * path of a local read/write (a path has no per-step spelling).
 */
export function promptCallSubjects(call: GuardCall, explanation: HostShellExplanation | null, analysis: ShellCommandAnalysis | null): string[] {
	if (call.kind === "local-read" || call.kind === "local-write") return call.path ? [call.path] : [];
	return hostShellSubjects(explanation, analysis);
}

export function buildPromptRecord(base: PromptRecordBase, outcome: PromptOutcome, details: PromptRecordDetails = {}): PromptRecord {
	const record: PromptRecord = {
		tool: base.tool,
		class: base.class,
		kind: base.kind,
		outcome,
		subjects: base.subjects.map(promptRecordText),
		display: promptRecordText(base.display),
		reason: details.reason ?? base.reason,
		profile: base.profile,
		fromCodemode: base.fromCodemode,
		toolCallId: base.toolCallId,
	};
	if (base.action !== undefined) record.action = base.action;
	if (details.dialogMs !== undefined) record.dialogMs = Math.max(0, Math.round(details.dialogMs));
	if (details.rules && details.rules.length) record.rules = details.rules.map(promptRecordText);
	if (details.scope !== undefined) record.scope = details.scope;
	if (details.root !== undefined) record.root = promptRecordText(details.root);
	if (details.switchedTo !== undefined) record.switchedTo = details.switchedTo;
	return record;
}

/**
 * A refusal that carries its own record outcome, so a recording catch never
 * matches on prose. `outcome === null` means the refusal was already recorded
 * (an answer entry exists for this call), so a catch must not record again.
 *
 * `name` is deliberately left as the inherited "Error": several call sites
 * interpolate `String(err)` into user-visible reasons, and those strings must
 * not change.
 */
export class PromptRefusalError extends Error {
	readonly outcome: PromptOutcome | null;
	/**
	 * The fields the recording catch should use, set by a throw site that had
	 * the decision at hand (so its action and reason survive). Absent for a
	 * refusal raised before any decision; the catch then supplies its own.
	 */
	base?: () => PromptRecordBase;
	constructor(outcome: PromptOutcome | null, message: string) {
		super(message);
		this.outcome = outcome;
	}
}

/** A refusal that still needs a record. */
export function promptRefusal(outcome: PromptOutcome, message: string, base?: () => PromptRecordBase): PromptRefusalError {
	const error = new PromptRefusalError(outcome, message);
	if (base) error.base = base;
	return error;
}

/** A refusal whose entry was already written (the answer entry of this call). */
export function recordedRefusal(message: string): PromptRefusalError {
	return new PromptRefusalError(null, message);
}

/**
 * Foreign cancellations arrive as ordinary errors: the dialog gate rejects
 * with `guard: dialog cancelled: <reason>`, and an SDK selector can reject with
 * an AbortError. Guard's own throws carry their outcome instead.
 */
const CANCELLED_MESSAGES: readonly RegExp[] = [/^guard: dialog cancelled: /, /^guard: call aborted; /];
/**
 * The runtime's readiness gate throws before any dialog: a disposed runtime, an
 * unresolved teardown, or a policy transition in flight are all staleness, so
 * they are recorded as expired rather than as an unexpected error.
 */
const EXPIRED_MESSAGES: readonly RegExp[] = [/^guard: runtime disposed$/, /^guard: unresolved teardown: /, /^guard: policy transition in progress; retry the call$/];

/**
 * The outcome to record for an error thrown out of a prompt surface, or null
 * when the error was already recorded. Guard's own refusals carry the outcome;
 * the two tables cover the errors guard does not throw itself; anything else is
 * an error.
 */
export function refusalOutcomeFor(error: unknown): PromptOutcome | null {
	if (error instanceof PromptRefusalError) return error.outcome;
	if (error instanceof Error) {
		if (error.name === "AbortError" || CANCELLED_MESSAGES.some((pattern) => pattern.test(error.message))) return "cancelled";
		if (EXPIRED_MESSAGES.some((pattern) => pattern.test(error.message))) return "expired";
	}
	return "error";
}

/**
 * The reason text for a failed prompt flow: guard's own refusals read as the
 * message alone (their class is an implementation detail), anything else keeps
 * the full String(err) rendering the rest of guard reports.
 */
export function refusalReason(error: unknown): string {
	return error instanceof PromptRefusalError ? error.message : String(error);
}

/**
 * Best effort: build and append inside one try. Returns false when either step
 * failed, and the caller decides what (if anything) to say about it.
 */
export function writePromptRecord(build: () => PromptRecord, appendEntry: (customType: string, data: PromptRecord) => void): boolean {
	try {
		appendEntry(GUARD_PROMPT_CUSTOM_TYPE, build());
		return true;
	} catch {
		return false;
	}
}
