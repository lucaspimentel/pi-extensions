/**
 * Shared execution plumbing for the update-jira tools: per-call snapshots
 * (config, cwd, target), result envelope finalization with the text budget
 * and spill handling, and per-action input validation helpers.
 *
 * Pure module: no pi-runtime imports. Filesystem, subprocess, transport, and
 * spill dependencies are injected.
 */

import { parseConfigText, type JiraConfig } from "./config.ts";
import { resolveTarget, type TargetResolution, type SubprocessRunner } from "./branch.ts";
import type { Transport } from "./mcp.ts";
import type { WriteQueue } from "./write-queue.ts";
import type { SpillManager } from "./results.ts";
import {
	byteLength,
	buildFullText,
	buildSpillFailureText,
	buildSpillText,
	TEXT_BUDGET_BYTES,
	type ErrorInfo,
	type ErrorKind,
	type ResultEnvelope,
} from "./results.ts";

export interface ToolDeps {
	/** Path to <agentDir>/update-jira.json. */
	configPath: string;
	/** Reads the configuration file; injected for tests. */
	readConfigFile(path: string): string;
	/** Local subprocess runner (git, gh); injected for tests. */
	run: SubprocessRunner;
	/** Shared per-site/ticket mutation queue. */
	queue: WriteQueue;
	/** Builds a transport around the live tool context; injected for tests. */
	transportFactory?(ctx: {
		executeTool(name: string, args: unknown, options?: { signal?: AbortSignal }): Promise<unknown>;
	}): Transport;
	/** Builds a spill manager for a session key; injected for tests. */
	spillFactory?(sessionKey: string): SpillManager;
}

export type ConfigSnapshot = { ok: true; config: JiraConfig } | { ok: false; reason: string };

/** Read and parse the configuration file. Missing files fail closed. */
export function loadConfigSnapshot(deps: ToolDeps): ConfigSnapshot {
	let text: string;
	try {
		text = deps.readConfigFile(deps.configPath);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { ok: false, reason: `configuration file could not be read from ${deps.configPath} (${message}); create it manually with {"siteUrl": "https://<your-site>.atlassian.net"}` };
	}
	return parseConfigText(text);
}

export interface PreparedCall {
	ok: true;
	site: string;
	config: JiraConfig;
	cwd: string;
	target: TargetResolution & { ok: true };
}

export type PrepareFailure = { ok: false; failure: ErrorInfo };

/**
 * Snapshot config, cwd, and target once per tool call, before any queueing.
 * A later config or cwd change cannot retarget a queued call.
 */
export async function prepareCall(
	deps: ToolDeps,
	cwd: string,
	ticketKey: string | undefined,
	signal?: AbortSignal,
): Promise<PreparedCall | PrepareFailure> {
	const snapshot = loadConfigSnapshot(deps);
	if (!snapshot.ok) {
		return { ok: false, failure: { kind: "config_invalid", message: snapshot.reason } };
	}
	const target = await resolveTarget({ config: snapshot.config, ticketKey, cwd, run: deps.run, signal });
	if (!target.ok) {
		const evidence: Record<string, unknown> = { kind: target.kind };
		if (target.candidates) evidence.candidates = target.candidates;
		return { ok: false, failure: { kind: target.kind, message: target.message, evidence } };
	}
	return { ok: true as const, site: snapshot.config.site, config: snapshot.config, cwd, target };
}

export interface ToolResultLike {
	content: Array<{ type: "text"; text: string }>;
	details: { result: ResultEnvelope };
	structuredContent: ResultEnvelope;
	isError: boolean;
}

/**
 * Finalize an envelope into a tool result: enforce the 16 KiB UTF-8 budget on
 * the complete model-facing text, spilling the complete envelope as JSON when
 * it does not fit. A spill failure never converts a successful mutation into
 * an error; complete data always stays in structuredContent.
 */
export function finalizeEnvelope(envelope: ResultEnvelope, spill: SpillManager | undefined): ToolResultLike {
	const full = buildFullText(envelope);
	let text = full;
	if (byteLength(full) > TEXT_BUDGET_BYTES) {
		if (spill) {
			const written = spill.write(envelope);
			if ("path" in written) {
				envelope = { ...envelope, spillPath: written.path };
				text = buildSpillText(envelope, written.path);
			} else {
				text = buildSpillFailureText(envelope, written.error);
			}
		} else {
			text = buildSpillFailureText(envelope, "no spill location was available");
		}
	}
	return {
		content: [{ type: "text", text }],
		details: { result: envelope },
		structuredContent: envelope,
		isError: !envelope.ok,
	};
}

/** Build a failure envelope + result for one action. */
export function failureResult(options: {
	tool: "jira_read" | "jira_update";
	action: string;
	site?: string;
	ticket?: string;
	failure: ErrorInfo;
	spill?: SpillManager;
}): ToolResultLike {
	const envelope: ResultEnvelope = {
		tool: options.tool,
		action: options.action,
		// Empty marker when the failure happened before configuration could be read.
		site: options.site ?? "",
		...(options.ticket ? { ticket: options.ticket } : {}),
		ok: false,
		error: options.failure,
	};
	return finalizeEnvelope(envelope, options.spill);
}

/** Build a success envelope + result for one action. */
export function successResult(options: {
	tool: "jira_read" | "jira_update";
	action: string;
	site: string;
	ticket?: string;
	data: unknown;
	spill?: SpillManager;
}): ToolResultLike {
	const envelope: ResultEnvelope = {
		tool: options.tool,
		action: options.action,
		site: options.site,
		...(options.ticket ? { ticket: options.ticket } : {}),
		ok: true,
		data: options.data,
	};
	return finalizeEnvelope(envelope, options.spill);
}

/**
 * Per-action parameter validation: params not relevant to the selected action
 * are rejected instead of silently ignored.
 */
export function rejectUnexpectedParams(
	params: Record<string, unknown>,
	allowed: readonly string[],
	action: string,
): ErrorInfo | undefined {
	const unexpected = Object.keys(params).filter((k) => !allowed.includes(k) && params[k] !== undefined);
	if (unexpected.length === 0) return undefined;
	return {
		kind: "invalid_input",
		message: `parameter(s) ${unexpected.join(", ")} are not valid for action "${action}"`,
	};
}

export function invalidInput(message: string): ErrorInfo {
	return { kind: "invalid_input", message };
}

/** Recursively validate that a value is JSON-safe (finite numbers only). */
export function isJsonSafe(value: unknown): boolean {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isJsonSafe);
	if (typeof value === "object") {
		const proto = Object.getPrototypeOf(value);
		if (proto !== Object.prototype && proto !== null) return false;
		return Object.values(value as Record<string, unknown>).every(isJsonSafe);
	}
	return false;
}

export function kindMessage(kind: ErrorKind, message: string): ErrorInfo {
	return { kind, message };
}
