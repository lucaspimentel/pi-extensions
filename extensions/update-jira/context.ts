/**
 * Local run-boundary ticket pointers for the update-jira extension.
 *
 * At before_agent_start the extension emits a visible custom message that
 * points the model at the branch's resolved ticket key (no MCP call, no
 * fetched digest). This module holds the pure state machine: reconstruction
 * from the active transcript branch, change detection, and message building.
 *
 * Rules (from the v2 design):
 * - Track only the last emitted state (site, cwd, branch, outcome).
 * - Emit on a change, including A -> B -> A; never a session-wide set.
 * - An initially unresolved target with no prior pointer emits nothing.
 * - After a pointer, a changed unresolved state emits a visible correction.
 * - Repeated unchanged corrections are suppressed.
 * - Invalid config clears a previously emitted pointer once per unchanged
 *   invalid state.
 *
 * Pure module: no pi-runtime imports.
 */

export const POINTER_CUSTOM_TYPE = "jira-branch-context";

export type PointerOutcome =
	| { status: "resolved"; key: string }
	| { status: "unresolved"; reason: string; message: string }
	| { status: "config_invalid"; message: string; fingerprint: string };

export interface PointerObservation {
	site: string;
	cwd: string;
	branch: string | null;
	outcome: PointerOutcome;
}

export interface EmittedState {
	observation: PointerObservation;
	emitted: "pointer" | "correction";
}

export interface PointerMessage {
	customType: string;
	content: string;
	display: true;
	details: {
		emitted: "pointer" | "correction";
		site: string;
		cwd: string;
		branch: string | null;
		outcome: PointerOutcome;
	};
}

function sameResolvedState(a: PointerObservation, b: PointerObservation): boolean {
	return (
		a.site === b.site &&
		a.cwd === b.cwd &&
		a.branch === b.branch &&
		a.outcome.status === "resolved" &&
		b.outcome.status === "resolved" &&
		a.outcome.key === b.outcome.key
	);
}

function sameUnresolvedState(a: PointerObservation, b: PointerObservation): boolean {
	return (
		a.site === b.site &&
		a.cwd === b.cwd &&
		a.branch === b.branch &&
		a.outcome.status === "unresolved" &&
		b.outcome.status === "unresolved" &&
		a.outcome.reason === b.outcome.reason &&
		a.outcome.message === b.outcome.message
	);
}

function pointerText(observation: PointerObservation): string {
	const outcome = observation.outcome;
	if (outcome.status !== "resolved") return "";
	const branchPart = observation.branch ? ` (branch ${observation.branch})` : "";
	return `Jira context: this branch resolves to ticket ${outcome.key}${branchPart} on ${observation.site}. Use the jira_read tool (action "get") for details before working on it.`;
}

function correctionText(observation: PointerObservation): string {
	const outcome = observation.outcome;
	if (outcome.status === "unresolved") {
		const branchPart = observation.branch ? ` for branch "${observation.branch}"` : "";
		return `Jira context update: there is no resolved default ticket${branchPart} (${outcome.reason}: ${outcome.message}). Use an explicit ticketKey with the jira tools if a ticket is still intended.`;
	}
	if (outcome.status === "config_invalid") {
		return `Jira context update: the update-jira configuration is invalid (${outcome.message}), so the previously suggested ticket is no longer available and Jira calls fail until it is fixed.`;
	}
	return "";
}

/**
 * Decide whether a run boundary emits a message. Returns undefined when the
 * state is unchanged, when suppression applies, or when an initially
 * unresolved state has no prior pointer to clear.
 */
export function decidePointerMessage(
	current: PointerObservation,
	last: EmittedState | undefined,
): PointerMessage | undefined {
	if (current.outcome.status === "config_invalid") {
		if (!last) return undefined;
		if (last.observation.outcome.status === "config_invalid" && last.observation.outcome.fingerprint === current.outcome.fingerprint) {
			return undefined;
		}
		const content = correctionText(current);
		if (!content) return undefined;
		return {
			customType: POINTER_CUSTOM_TYPE,
			content,
			display: true,
			details: { emitted: "correction", site: current.site, cwd: current.cwd, branch: current.branch, outcome: current.outcome },
		};
	}
	if (current.outcome.status === "resolved") {
		if (last && last.observation.outcome.status === "resolved" && sameResolvedState(last.observation, current)) {
			return undefined;
		}
		const content = pointerText(current);
		if (!content) return undefined;
		return {
			customType: POINTER_CUSTOM_TYPE,
			content,
			display: true,
			details: { emitted: "pointer", site: current.site, cwd: current.cwd, branch: current.branch, outcome: current.outcome },
		};
	}
	// Unresolved: emit only when a prior pointer/correction exists and changed.
	if (!last) return undefined;
	if (last.observation.outcome.status === "unresolved" && sameUnresolvedState(last.observation, current)) {
		return undefined;
	}
	const content = correctionText(current);
	if (!content) return undefined;
	return {
		customType: POINTER_CUSTOM_TYPE,
		content,
		display: true,
		details: { emitted: "correction", site: current.site, cwd: current.cwd, branch: current.branch, outcome: current.outcome },
	};
}

interface PointerDetails {
	emitted?: unknown;
	site?: unknown;
	cwd?: unknown;
	branch?: unknown;
	outcome?: unknown;
}

function parseOutcomeDetails(value: unknown): PointerOutcome | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const outcome = value as Record<string, unknown>;
	if (outcome.status === "resolved" && typeof outcome.key === "string") {
		return { status: "resolved", key: outcome.key };
	}
	if (outcome.status === "unresolved" && typeof outcome.reason === "string" && typeof outcome.message === "string") {
		return { status: "unresolved", reason: outcome.reason, message: outcome.message };
	}
	if (outcome.status === "config_invalid" && typeof outcome.message === "string" && typeof outcome.fingerprint === "string") {
		return { status: "config_invalid", message: outcome.message, fingerprint: outcome.fingerprint };
	}
	return undefined;
}

function parseEmittedState(entry: unknown): EmittedState | undefined {
	if (typeof entry !== "object" || entry === null) return undefined;
	const record = entry as Record<string, unknown>;
	if (record.type !== "custom_message" || record.customType !== POINTER_CUSTOM_TYPE) return undefined;
	const details = record.details as PointerDetails | undefined;
	if (!details || typeof details !== "object") return undefined;
	const outcome = parseOutcomeDetails(details.outcome);
	if (!outcome) return undefined;
	const emitted = details.emitted === "pointer" || details.emitted === "correction" ? details.emitted : undefined;
	if (!emitted) return undefined;
	return {
		observation: {
			site: typeof details.site === "string" ? details.site : "",
			cwd: typeof details.cwd === "string" ? details.cwd : "",
			branch: typeof details.branch === "string" ? details.branch : null,
			outcome,
		},
		emitted,
	};
}

/**
 * Reconstruct the last emitted pointer/correction from the active transcript
 * branch (never abandoned branches). Used on session_start and successful
 * session_tree so a restored pointer can be cleared on the next boundary.
 */
export function reconstructLastPointer(entries: unknown): EmittedState | undefined {
	if (!Array.isArray(entries)) return undefined;
	for (let i = entries.length - 1; i >= 0; i--) {
		const parsed = parseEmittedState(entries[i]);
		if (parsed) return parsed;
	}
	return undefined;
}
