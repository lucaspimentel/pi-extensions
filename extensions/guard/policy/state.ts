/**
 * Guard's session state: the current profile, the research hold (plan.ts
 * handshake, wired in step 4), the workspace lock, and the derived views the
 * footer, the profile event, and the observe-only hook consume.
 *
 * Session-only: every session starts at "default"; nothing is persisted.
 * While a research hold is active, every profile change is blocked except
 * staying in research; releasing the hold restores the profile that was
 * active before it. /guard ack clears the workspace lock.
 */

import type { SandboxDetection } from "../sandbox/detect.ts";
import type { WorkspaceMode } from "../sandbox/spec.ts";
import type { ResolvedGuardConfig } from "./config.ts";
import { classifyToolCall, type ToolClass } from "./classes.ts";
import { effectiveWorkspaceMode, type GuardCall, type PolicyState } from "./decision.ts";
import { makeIsProtectedPath } from "./protected.ts";
import { nextProfile, profileFooterLabel, type Profile } from "./profiles.ts";

export type SandboxMode = SandboxDetection["mode"];

export interface GuardSessionState {
	profile: Profile;
	/** Set while plan holds research (step 4); blocks profile changes. */
	researchHolder: string | null;
	/** Profile that was active before the research hold; restored on release. */
	profileBeforeHold: Profile | null;
	/** Set by step 3 when the audit reports lockWrites; cleared by /guard ack. */
	workspaceLocked: boolean;
	workspaceLockReason: string | null;
	/** Detection result from session start; refreshed on demand. */
	sandbox: SandboxDetection | null;
	/** Resolved classifier model id for the auto footer label, when known. */
	classifierLabel: string | null;
}

export interface CreateStateOptions {
	config: ResolvedGuardConfig;
	sandbox: SandboxDetection | null;
	cwd: string;
	interactive: boolean;
}

export function createSessionState(options: CreateStateOptions): GuardSessionState {
	void options.config;
	void options.cwd;
	void options.interactive;
	return {
		profile: "default",
		researchHolder: null,
		profileBeforeHold: null,
		workspaceLocked: false,
		workspaceLockReason: null,
		sandbox: options.sandbox,
		classifierLabel: null,
	};
}

const HOLD_NOTICE = (holder: string) =>
	`Profile changes are blocked while ${holder} holds research; the holder must release it first.`;

/** Cycle to the next profile (unrestricted cycles to research); blocked during a research hold. */
export function cycleProfile(
	state: GuardSessionState,
): { ok: true; profile: Profile } | { ok: false; notice: string } {
	if (state.researchHolder !== null) {
		return { ok: false, notice: HOLD_NOTICE(state.researchHolder) };
	}
	state.profile = nextProfile(state.profile);
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
	if (state.researchHolder !== null && profile !== "research") {
		return { ok: false, notice: HOLD_NOTICE(state.researchHolder) };
	}
	state.profile = profile;
	return { ok: true };
}

/**
 * The plan.ts handshake (guard side; plan.ts wiring lands in step 4): a
 * research request is granted, the current profile is remembered, and every
 * profile change is blocked until release. The holder is recorded.
 */
export function requestResearchHold(state: GuardSessionState, holder: string): { granted: boolean; reason: string; profile: Profile } {
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

/** /guard ack: clear the workspace lock. */
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

/** The guard:profile event payload (step 3 tools subscribe to this). */
export interface ProfileEventPayload {
	profile: Profile;
	sandbox: {
		mode: SandboxMode;
		/** Effective workspace mode for the tools; "none" means fully raw (yolo/unrestricted). */
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
			const shell = toolName.toLowerCase() === "pwsh" ? "pwsh" : "host-bash";
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
