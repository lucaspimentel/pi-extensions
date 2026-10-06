/**
 * Guard's six-profile ladder and the per-profile decision cells.
 *
 * Session-only: every session starts at "default", nothing is persisted.
 * The ladder is the ctrl+alt+g cycle order: research -> default -> auto ->
 * trusted -> yolo -> research. "unrestricted" is NEVER in the cycle: it is
 * reachable only with `/guard profile unrestricted`, so one keypress cannot
 * drop the deny rules; cycling from unrestricted goes to research.
 *
 * Cell semantics (docs/guard-design.md, Profiles):
 *
 |                          | research | default | auto      | trusted | yolo   | unrestricted |
 | sandbox workspace (step 3)| overlay  | rw      | rw        | rw      | none   | none         |
 | host_bash / pwsh          | deny     | rules->tier->prompt | rules->tier->classify | rules->tier->allow | deny/ask rules, else allow | allow |
 | write/edit (non-protected)| deny     | roots*  | classify  | allow   | allow  | allow        |
 | protected-path write      | deny     | prompt  | prompt    | prompt  | allow  | allow        |
 | local reads               | as default | roots** | as default | as default | allow | allow      |
 | secret-mask read          | deny     | deny    | deny      | deny    | allow  | allow        |
 | web_fetch outside allow   | prompt   | prompt  | classify  | allow   | allow  | allow        |
 | other remote reads        | allow    | allow   | allow     | allow   | allow  | allow        |
 | remote writes             | deny     | prompt  | classify  | allow   | allow  | allow        |
 | sandboxed exec            | allow    | allow   | allow     | allow   | allow  | allow        |
 | meta                      | allow    | allow   | allow     | allow   | allow  | allow        |
 *
 *   *  allowed inside cwd and configured write roots, prompt outside.
 *   ** allowed inside cwd and configured read roots, prompt outside.
 *
 * "classify" cells resolve through the LLM classifier (an injected strategy,
 * see decision.ts). The classifier never runs for any other cell.
 */

export type Profile = "research" | "default" | "auto" | "trusted" | "yolo" | "unrestricted";

/** Cycle order for ctrl+alt+g and the /guard picker; unrestricted is excluded. */
export const PROFILE_LADDER: readonly Profile[] = ["research", "default", "auto", "trusted", "yolo"];

/** Every valid profile: the ladder plus the command-only unrestricted. */
export const ALL_PROFILES: readonly Profile[] = [...PROFILE_LADDER, "unrestricted"];

export function isProfile(value: unknown): value is Profile {
	return typeof value === "string" && (ALL_PROFILES as readonly string[]).includes(value);
}

/**
 * The next profile in the cycle, wrapping around. Cycling from unrestricted
 * goes to research (unrestricted itself is never in the cycle).
 */
export function nextProfile(current: Profile): Profile {
	if (current === "unrestricted") return "research";
	const i = PROFILE_LADDER.indexOf(current);
	return PROFILE_LADDER[(i + 1) % PROFILE_LADDER.length];
}

/**
 * Sandbox workspace mode presented to the guard tools for the profile.
 * yolo and unrestricted are "none": the tools run fully raw (no sandbox),
 * wired in step 3.
 */
export type WorkspaceModeForProfile = "overlay" | "rw" | "none";

export function workspaceModeForProfile(profile: Profile): WorkspaceModeForProfile {
	switch (profile) {
		case "research": return "overlay";
		case "yolo":
		case "unrestricted": return "none";
		default: return "rw";
	}
}

/**
 * Static (non-classifier) action for a tool-class cell. "classify" means the
 * auto profile's LLM classifier screens the call; it never appears outside
 * the auto column.
 */
export type CellAction = "allow" | "prompt" | "deny" | "classify";

/** The host_bash / pwsh cell per profile (pwsh is Windows-only, same tier). */
export function hostShellCell(profile: Profile): CellAction {
	switch (profile) {
		case "research": return "deny";
		case "default": return "prompt";
		case "auto": return "classify";
		case "trusted":
		case "yolo":
		case "unrestricted": return "allow";
	}
}

/**
 * The write/edit cell per profile. "roots" means: allowed inside cwd and the
 * configured write roots, prompt outside (default profile only).
 */
export function writeEditCell(profile: Profile): CellAction | "roots" {
	switch (profile) {
		case "research": return "deny";
		case "default": return "roots";
		case "auto": return "classify";
		case "trusted":
		case "yolo":
		case "unrestricted": return "allow";
	}
}

/** The protected-path write cell per profile. */
export function protectedPathCell(profile: Profile): CellAction {
	switch (profile) {
		case "research": return "deny";
		case "default":
		case "auto":
		case "trusted": return "prompt";
		case "yolo":
		case "unrestricted": return "allow";
	}
}

/**
 * The local-read cell per profile. "roots" means: allowed inside cwd and the
 * configured read roots, prompt outside. research/auto/trusted read "as
 * default" per the design table, which is the same roots cell.
 */
export function localReadCell(profile: Profile): "roots" | "allow" {
	switch (profile) {
		case "research":
		case "default":
		case "auto":
		case "trusted": return "roots";
		case "yolo":
		case "unrestricted": return "allow";
	}
}

/** The secret-mask read cell (path-level only in step 2; see decision.ts). */
export function maskReadCell(profile: Profile): CellAction {
	switch (profile) {
		case "research":
		case "default":
		case "auto":
		case "trusted": return "deny";
		case "yolo":
		case "unrestricted": return "allow";
	}
}

/**
 * The exfil-capable remote read cell (web_fetch to a domain outside the
 * allowlist; data rides in the URL) per profile.
 */
export function exfilRemoteReadCell(profile: Profile): CellAction {
	switch (profile) {
		case "research":
		case "default": return "prompt";
		case "auto": return "classify";
		case "trusted":
		case "yolo":
		case "unrestricted": return "allow";
	}
}

/** Other remote reads (web_search, pup, Jira/Slack reads) are always allowed. */
export function otherRemoteReadCell(_profile: Profile): CellAction {
	return "allow";
}

/** The remote write cell (Slack posts, MCP writes, pup writes) per profile. */
export function remoteWriteCell(profile: Profile): CellAction {
	switch (profile) {
		case "research": return "deny";
		case "default": return "prompt";
		case "auto": return "classify";
		case "trusted":
		case "yolo":
		case "unrestricted": return "allow";
	}
}

/**
 * Sandboxed execution is always allowed: the kernel sandbox is the
 * guarantee, and it is never classified or routed to the host. Degraded mode
 * is the exception handled in decision.ts (host execution, host-shell row).
 */
export function sandboxedExecCell(_profile: Profile): CellAction {
	return "allow";
}

/** Meta tools are allowed in every profile; nested calls are gated individually. */
export function metaCell(_profile: Profile): CellAction {
	return "allow";
}

/**
 * Footer label for a profile (without the sandbox suffix; state.ts appends
 * the degraded warning). Default is blank: no footer noise.
 */
export function profileFooterLabel(profile: Profile, classifierModelId: string | undefined): string {
	switch (profile) {
		case "research": return "research";
		case "default": return "";
		case "auto": return classifierModelId ? `auto: ${classifierModelId}` : "auto (no classifier)";
		case "trusted": return "trusted";
		case "yolo": return "yolo";
		case "unrestricted": return "unrestricted";
	}
}
