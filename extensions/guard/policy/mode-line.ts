/**
 * The model-visible guard state line ("guard mode").
 *
 * Advisory only. The line tells the model what guard will do before it acts,
 * so a session stops discovering constraints from denials. It is rendered
 * from the same per-profile cells the decision core uses (profiles.ts), so
 * the text cannot contradict enforcement, and nothing in the policy path
 * reads it: the kernel still enforces, the line only routes.
 *
 * index.ts writes the result into the prompt's `guard_state` section from a
 * `before_agent_start` handler, rebuilt on every run. The user-facing sibling
 * is footerLabel() in state.ts; this one deliberately names the classifier
 * nowhere.
 *
 * Pure and total: no I/O, no pi imports, and every input shape (including a
 * cast-invalid profile or sandbox mode) resolves to a string or to null.
 */

import { hostShellCell, isProfile, writeEditCell, type Profile } from "./profiles.ts";
import type { SandboxMode } from "./state.ts";

/** Prompt-section name carrying the line. Must match pi's section-name pattern. */
export const GUARD_STATE_SECTION = "guard_state";

/** Shown when the session's inheritance contract is invalid (no runtime exists). */
export const GUARD_STATE_BLOCKED_INHERITANCE = "guard: session blocked (inherited contract invalid); tool execution denied";

/** Shown when the runtime recorded an unresolved teardown failure. */
export const GUARD_STATE_BLOCKED_TEARDOWN = "guard: execution blocked (unresolved teardown); tool execution denied";

/** Shown instead of the state line when a clause cannot be resolved. */
export const GUARD_STATE_FALLBACK = "guard: initialized; effective state unavailable";

/** Trailing clause while the workspace lock is in force. */
export const GUARD_STATE_LOCK_TAIL = "/guard ack clears the lock";

export interface GuardStateSectionInput {
	/** False before session_start installed the session state: emits no section. */
	initialized: boolean;
	/** The invalid-inheritance reason, or null for an ordinary session. */
	inheritanceError: string | null;
	/** Runtime teardown failure, or null while the runtime is healthy. */
	teardownFailure: string | null;
	profile: Profile;
	sandboxMode: SandboxMode | null;
	workspaceLocked: boolean;
	/** The inherited profile while the constraint is valid, else null. */
	inheritedProfile: Profile | null;
	/** The bash parser's load diagnostic, or null/undefined while it is available. */
	shellAstDiagnostic?: string | null;
}

/**
 * The section body for this run, or null when guard has no session state yet
 * (an uninitialized session must not claim anything). Callers that see the
 * fallback string should also tell the user: presence of the section is meant
 * to be a reliable signal that guard is up.
 */
export function renderGuardStateSection(input: GuardStateSectionInput): string | null {
	if (!input.initialized) return null;
	if (input.inheritanceError !== null) return GUARD_STATE_BLOCKED_INHERITANCE;
	if (input.teardownFailure !== null) return GUARD_STATE_BLOCKED_TEARDOWN;
	// Resolve every clause before joining: an unresolvable one must not leave a
	// half-truth on screen.
	const profile = profileClause(input);
	const sandbox = sandboxClause(input);
	const hostShell = hostShellClause(input);
	const writes = writesClause(input);
	if (profile === null || sandbox === null || hostShell === null || writes === null) return GUARD_STATE_FALLBACK;
	const clauses = [profile, sandbox, hostShell, writes];
	if (input.shellAstDiagnostic != null) clauses.push(`bash parser unavailable (${input.shellAstDiagnostic}); host shell commands fail closed to a prompt`);
	if (input.workspaceLocked) clauses.push(GUARD_STATE_LOCK_TAIL);
	return `guard: ${clauses.join("; ")}`;
}

function profileClause(input: GuardStateSectionInput): string | null {
	if (!isProfile(input.profile)) return null;
	return input.inheritedProfile === null
		? `profile ${input.profile}`
		// Always shown while a valid constraint exists, including after the
		// child itself moved to research: the restriction stands either way.
		: `profile ${input.profile} (inherited, cannot be loosened)`;
}

/**
 * The sandbox clause. Mirrors effectiveWorkspaceMode() and bashRunsOnHost()
 * (decision.ts): the lock forces a read-only sandbox back on, so a locked raw
 * profile no longer runs raw. Tests assert this against those two functions.
 */
function sandboxClause(input: GuardStateSectionInput): string | null {
	const mode = input.sandboxMode;
	if (mode === "degraded") {
		return input.workspaceLocked
			? "sandbox degraded (no sandbox; bash and interpreters unavailable; workspace locked)"
			: "sandbox degraded (no sandbox; bash and interpreters unavailable)";
	}
	if (mode !== "full" && mode !== "reduced") return null;
	const raw = !input.workspaceLocked && (input.profile === "yolo" || input.profile === "unrestricted");
	if (raw) return "sandbox none (tools run raw)";
	if (input.workspaceLocked) return `sandbox ${mode} (workspace locked: read-only)`;
	return mode === "full" ? "sandbox full" : "sandbox reduced (workspace overlay degrades to read-only)";
}

/**
 * The host-shell clause, following decideHostShellCommand() precedence: the
 * lock denies first, then research (with the degraded read-only tier), then
 * the profile cell behind the deny/ask rules and the tightened read-only
 * tier. Only the clause text is rendered here; the rules themselves are
 * session state and stay out of one line.
 */
function hostShellClause(input: GuardStateSectionInput): string | null {
	if (input.workspaceLocked) return "host shell denied (workspace locked)";
	if (input.profile === "research") {
		return input.sandboxMode === "degraded" ? "host shell read-only tier only (degraded)" : "host shell denied";
	}
	// The raw profiles bypass tier and rules differently from the cell alone:
	// yolo still honors deny/ask rules, unrestricted ignores everything.
	if (input.profile === "yolo") return "host shell deny/ask rules, else allow";
	if (input.profile === "unrestricted") return "host shell allow";
	switch (hostShellCell(input.profile)) {
		case "prompt": return "host shell rules, then read-only tier, then prompt";
		case "classify": return "host shell rules, then read-only tier, then classifier";
		case "allow": return "host shell rules, then read-only tier, then allow";
		case "deny": return "host shell denied";
	}
	return null;
}

/**
 * The writes clause, following decideLocalWrite(): research denies before the
 * lock is consulted, then the lock stops every other profile, then the
 * write/edit cell (auto's classifier is gated by write-root containment).
 */
function writesClause(input: GuardStateSectionInput): string | null {
	if (input.profile === "research") return "writes denied";
	if (input.workspaceLocked) return "writes stopped (workspace locked)";
	switch (writeEditCell(input.profile)) {
		case "prompt": return "writes prompted (in-root or not)";
		case "roots": return "writes in-root allowed, out-of-root prompt";
		case "classify": return "writes in-root classified, out-of-root prompt";
		case "allow": return "writes allowed";
		case "deny": return "writes denied";
	}
	return null;
}
