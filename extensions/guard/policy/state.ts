/**
 * Pure session-state helpers for profiles, research holds and workspace locks.
 * Runtime teardown precedes every mutation and publication in index.ts.
 * The footer, profile event and observation hook consume the derived views.
 *
 * Session-only: every session starts at "default"; nothing is persisted.
 * While a research hold is active, every profile change is blocked except
 * staying in research; releasing the hold restores the profile that was
 * active before it. Runtime failure checks precede /guard ack. Step 5 adds
 * the subagent inheritance constraint: a child session starts in its
 * inherited profile and may only keep it or move to research; an invalid
 * ambient contract blocks the session entirely.
 */

import type { SandboxDetection } from "../sandbox/detect.ts";
import type { WorkspaceMode } from "../sandbox/spec.ts";
import type { ResolvedGuardConfig } from "./config.ts";
import { classifyToolCall, type ToolClass } from "./classes.ts";
import { effectiveWorkspaceMode, type GuardCall, type PolicyState } from "./decision.ts";
import { makeIsProtectedPath } from "./protected.ts";
import { nextProfile, profileFooterLabel, type Profile } from "./profiles.ts";
import type { InheritanceConstraint } from "./inheritance.ts";

export type SandboxMode = SandboxDetection["mode"];

export interface GuardSessionState {
	profile: Profile;
	/** Set while plan holds research (step 4); blocks profile changes. */
	researchHolder: string | null;
	/** Profile that was active before the research hold; restored on release. */
	profileBeforeHold: Profile | null;
	/** Audit violations/incomplete containment lock the workspace until safe acknowledgment. */
	workspaceLocked: boolean;
	workspaceLockReason: string | null;
	/** Detection result from session start; refreshed on demand. */
	sandbox: SandboxDetection | null;
	/** Resolved classifier model id for the auto footer label, when known. */
	classifierLabel: string | null;
	/**
	 * Step-5 subagent inheritance. null in ordinary sessions. A valid
	 * constraint pins the profile the child starts in; the child may only keep
	 * it or switch to research. An error constraint blocks the session: no
	 * executable runtime, every owned executor fails closed. Never persisted;
	 * the extension entry point re-derives it from the process environment.
	 */
	inherited: InheritanceConstraint | null;
}

export interface CreateStateOptions {
	config: ResolvedGuardConfig;
	sandbox: SandboxDetection | null;
	cwd: string;
	interactive: boolean;
	/** Step-5 inheritance constraint captured once by the extension factory. */
	inherited?: InheritanceConstraint | null;
}

export function createSessionState(options: CreateStateOptions): GuardSessionState {
	void options.config;
	void options.cwd;
	void options.interactive;
	return {
		profile: options.inherited && "profile" in options.inherited ? options.inherited.profile : "default",
		researchHolder: null,
		profileBeforeHold: null,
		workspaceLocked: false,
		workspaceLockReason: null,
		sandbox: options.sandbox,
		classifierLabel: null,
		inherited: options.inherited ?? null,
	};
}

/**
 * Central profile-change validation: research holds (step 4) and the step-5
 * inherited restriction. Every mutation path (set, cycle, commands, picker,
 * reload, recovery) must route through setProfile or cycleProfile, which both
 * call this; nothing may assign state.profile directly from a handler.
 */
export function profileChangeAllowed(
	state: GuardSessionState,
	profile: Profile,
): { ok: true } | { ok: false; notice: string } {
	if (state.inherited && "error" in state.inherited) {
		return { ok: false, notice: `guard inheritance is invalid (${state.inherited.error}); profile changes are disabled` };
	}
	if (state.researchHolder !== null && profile !== "research") {
		return { ok: false, notice: HOLD_NOTICE(state.researchHolder) };
	}
	if (state.inherited && profile !== state.inherited.profile && profile !== "research") {
		return {
			ok: false,
			// The ladder is not a permission ordering: default can allow what
			// auto denies through classification, so there is no ceiling to
			// clamp to. Refuse instead of silently choosing another profile.
			notice: `inherited profile ${state.inherited.profile}: only "${state.inherited.profile}" and "research" are allowed in this subagent`,
		};
	}
	return { ok: true };
}

const HOLD_NOTICE = (holder: string) =>
	`Profile changes are blocked while ${holder} holds research; the holder must release it first.`;

/** Cycle to the next profile (unrestricted cycles to research); blocked during a research hold. */
export function cycleProfile(
	state: GuardSessionState,
): { ok: true; profile: Profile } | { ok: false; notice: string } {
	const next = nextProfile(state.profile);
	const allowed = profileChangeAllowed(state, next);
	if (!allowed.ok) return allowed;
	state.profile = next;
	return { ok: true, profile: state.profile };
}

/**
 * Set a profile directly; blocked during a research hold except staying in
 * research. unrestricted is command-only (never in the cycle).
 */
export function setProfile(
	state: GuardSessionState,
	profile: Profile,
): { ok: true } | { ok: false; notice: string } {
	const allowed = profileChangeAllowed(state, profile);
	if (!allowed.ok) return allowed;
	state.profile = profile;
	return { ok: true };
}

/**
 * The plan.ts handshake (guard side; plan.ts wiring lands in step 4): a
 * research request is granted, the current profile is remembered, and every
 * profile change is blocked until release. The holder is recorded.
 */
export function requestResearchHold(state: GuardSessionState, holder: string): { granted: boolean; reason: string; profile: Profile } {
	if (state.inherited && "error" in state.inherited) {
		return { granted: false, reason: `guard inheritance is invalid (${state.inherited.error}); research is unavailable`, profile: state.profile };
	}
	if (state.researchHolder !== null && state.researchHolder !== holder) {
		return { granted: false, reason: `research is already held by ${state.researchHolder}`, profile: state.profile };
	}
	if (state.profile !== "research") {
		state.profileBeforeHold = state.profile;
		state.profile = "research";
	}
	state.researchHolder = holder;
	return { granted: true, reason: "research granted", profile: state.profile };
}

/** Release the research hold and restore the pre-hold profile. */
export function releaseResearchHold(state: GuardSessionState, holder: string): { released: boolean; reason: string; profile: Profile } {
	if (state.researchHolder !== holder) {
		return {
			released: false,
			reason: state.researchHolder === null ? "no research hold" : `research is held by ${state.researchHolder}`,
			profile: state.profile,
		};
	}
	state.researchHolder = null;
	if (state.profileBeforeHold !== null) {
		state.profile = state.profileBeforeHold;
		state.profileBeforeHold = null;
	}
	return { released: true, reason: "research released; previous profile restored", profile: state.profile };
}

/** Lock the workspace (step 3 calls this on audit lockWrites). */
export function lockWorkspace(state: GuardSessionState, reason: string): void {
	state.workspaceLocked = true;
	state.workspaceLockReason = reason;
}

/** Pure ack mutation. The caller must first pass the runtime teardown barrier. */
export function ackWorkspaceLock(state: GuardSessionState): { cleared: boolean; notice: string } {
	if (!state.workspaceLocked) return { cleared: false, notice: "Workspace is not locked." };
	state.workspaceLocked = false;
	const notice = `Workspace lock cleared (${state.workspaceLockReason ?? "no reason recorded"}).`;
	state.workspaceLockReason = null;
	return { cleared: true, notice };
}

/** Build the PolicyState the decision function consumes (predicate included). */
export function toPolicyState(
	state: GuardSessionState,
	config: ResolvedGuardConfig,
	cwd: string,
	interactive: boolean,
): PolicyState {
	return {
		profile: state.profile,
		config,
		sandboxMode: state.sandbox?.mode ?? "degraded",
		cwd,
		workspaceLocked: state.workspaceLocked,
		interactive,
	};
}

/** Published after the runtime transition has completed. */
export interface ProfileEventPayload {
	profile: Profile;
	sandbox: {
		mode: SandboxMode;
		/** Bash workspace mode; workers independently use overlay/ro. "none" means fully raw. */
		workspaceMode: WorkspaceMode | "none";
		readRoots: string[];
	};
	workspaceLocked: boolean;
}

export function profileEventPayload(state: GuardSessionState, config: ResolvedGuardConfig, cwd: string): ProfileEventPayload {
	const policy = toPolicyState(state, config, cwd, true);
	return {
		profile: state.profile,
		sandbox: {
			mode: policy.sandboxMode,
			workspaceMode: effectiveWorkspaceMode(policy),
			readRoots: config.readRoots,
		},
		workspaceLocked: state.workspaceLocked,
	};
}

/** Footer label for the current state (blank in default + full sandbox). */
export function footerLabel(state: GuardSessionState): string {
	const parts: string[] = [];
	if (state.inherited) {
		if ("error" in state.inherited) parts.push("inheritance invalid");
		else parts.push(`inherited ${state.inherited.profile}`);
	}
	const label = profileFooterLabel(state.profile, state.classifierLabel ?? undefined);
	if (label) parts.push(label);
	if (state.sandbox?.mode === "degraded") parts.push("no sandbox");
	else if (state.sandbox?.mode === "reduced") parts.push("reduced sandbox");
	if (state.workspaceLocked) parts.push("workspace locked (/guard ack)");
	return parts.join(" | ");
}

/** How a mapped pi tool call presents to the decision core and the event. */
export interface MappedToolCall {
	cls: ToolClass;
	call: GuardCall;
}

/** Extract a path argument from a tool input (read/grep/find/ls/write/edit). */
function extractPath(input: Record<string, unknown>): string | undefined {
	for (const key of ["path", "file_path"]) {
		const v = input[key];
		if (typeof v === "string" && v.trim() !== "") return v;
	}
	return undefined;
}

/**
 * Map a pi tool call to guard's call domain, using the classification order
 * (toolClasses, built-in map, annotations, heuristic, fallback). The caller
 * supplies the resolved config and the injected annotation lookup.
 */
export function mapToolCallToGuardCall(
	toolName: string,
	input: Record<string, unknown>,
	config: ResolvedGuardConfig,
	getAnnotations?: (name: string) => { readOnlyHint?: boolean; destructiveHint?: boolean } | undefined,
): MappedToolCall {
	const cls = classifyToolCall(toolName, input, {
		toolClasses: config.toolClasses,
		webFetchAllow: config.webFetchAllow,
		getAnnotations,
	});
	switch (cls) {
		case "host-shell": {
			// pi's built-in "powershell" tool shares the pwsh shell tier, so
			// Pwsh(...) rules and the pwsh host-shell cells govern it too.
			const name = toolName.toLowerCase();
			const shell = name === "pwsh" || name === "powershell" ? "pwsh" : "host-bash";
			return { cls, call: { kind: "host-shell", shell, command: String(input.command ?? "") } };
		}
		case "sandboxed-exec": {
			const command = typeof input.command === "string" && input.command ? input.command : undefined;
			return { cls, call: { kind: "sandboxed-exec", tool: toolName, command } };
		}
		case "local-read":
			return { cls, call: { kind: "local-read", tool: toolName, path: extractPath(input) } };
		case "local-write": {
			const isWriteEdit = toolName.toLowerCase() === "write" || toolName.toLowerCase() === "edit";
			return { cls, call: { kind: "local-write", tool: toolName, path: isWriteEdit ? extractPath(input) : undefined } };
		}
		case "exfil-remote-read":
		case "remote-read": {
			if (toolName.toLowerCase() === "web_fetch") {
				return { cls, call: { kind: "web-fetch", url: String(input.url ?? "") } };
			}
			return { cls: "remote-read", call: { kind: "remote-read", tool: toolName } };
		}
		case "remote-write":
			return { cls, call: { kind: "remote-write", tool: toolName, input } };
		case "meta":
			return { cls, call: { kind: "meta", tool: toolName } };
	}
}
