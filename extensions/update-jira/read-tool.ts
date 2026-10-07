/**
 * The jira_read tool: read-only Jira operations.
 *
 * Actions:
 * - get: digest (explicit summary/status/assignee/description fields, capped
 *   description) or the complete raw server payload (raw: true).
 * - comments: one newest-first page (20 comments) with pagination metadata.
 *
 * Read calls stay concurrent; they never enter the mutation queue. The
 * transport is built fresh from the current tool context on every call and is
 * never retained.
 */

import { Type } from "typebox";
import { failureResult, finalizeEnvelope, invalidInput, prepareCall, rejectUnexpectedParams, successResult, type ToolDeps, type ToolResultLike } from "./common.ts";
import { callGranularOperation, callPrimaryTool, classifyOutcome, extractServerData, parseNestedOutcome, transportFromContext, withCloudId } from "./mcp.ts";
import { buildIssueDigest } from "./digest.ts";
import { resultOutputSchema } from "./schema.ts";
import type { ErrorKind } from "./results.ts";

const GET_DIGEST_FIELDS = ["summary", "status", "assignee", "description"];

export const readParameters = Type.Object({
	action: Type.Union([Type.Literal("get"), Type.Literal("comments")], {
		description: 'Which read to perform: "get" (issue digest or raw payload) or "comments" (one newest-first page).',
	}),
	ticketKey: Type.Optional(
		Type.String({ description: "Explicit ticket key (e.g. PROJ-123). Defaults to the ticket resolved from the current git branch; an invalid explicit key is an error, not a fallback." }),
	),
	raw: Type.Optional(
		Type.Boolean({ description: 'get only: return the complete server payload (view "full", fields ["*all"]) instead of the capped digest.' }),
	),
	startAt: Type.Optional(
		Type.Integer({ minimum: 0, description: "comments only: zero-based index of the first comment to return. Default 0. Page size is fixed at 20." }),
	),
});

export type ReadParams = {
	action: "get" | "comments";
	ticketKey?: string;
	raw?: boolean;
	startAt?: number;
};

/** Minimal structural view of the live tool context the tool needs. */
export interface ToolExecuteContext {
	cwd: string;
	sessionManager?: { getSessionFile?(): string | undefined };
	executeTool(name: string, args: unknown, options?: { signal?: AbortSignal }): Promise<unknown>;
}

function validateReadInput(params: ReadParams): { ok: true } | { ok: false; failure: ReturnType<typeof invalidInput> } {
	const allowed = params.action === "get" ? (["action", "ticketKey", "raw"] as const) : (["action", "ticketKey", "startAt"] as const);
	const unexpected = rejectUnexpectedParams(params as unknown as Record<string, unknown>, allowed, params.action);
	if (unexpected) return { ok: false, failure: unexpected };
	if (params.action === "comments" && params.startAt !== undefined && (!Number.isInteger(params.startAt) || params.startAt < 0)) {
		return { ok: false, failure: invalidInput("startAt must be a non-negative integer") };
	}
	return { ok: true };
}

function sessionKeyOf(ctx: ToolExecuteContext): string {
	const file = ctx.sessionManager?.getSessionFile?.();
	if (!file) return "session";
	const base = file.split(/[/\\]/).pop() ?? "session";
	return base.replace(/\.[^.]+$/, "") || "session";
}

interface FailureBase {
	tool: "jira_read" | "jira_update";
	action: string;
	site?: string;
	ticket?: string;
	spill?: ReturnType<NonNullable<ToolDeps["spillFactory"]>>;
}

/** Dispatch a classified nested-outcome failure into a failure result. */
function failureFromKind(
	failure: { kind: ErrorKind; message: string; evidence: unknown },
	base: FailureBase,
): ToolResultLike {
	return failureResult({ ...base, failure: { kind: failure.kind, message: failure.message, evidence: failure.evidence } });
}

export function createReadTool(deps: ToolDeps) {
	return {
		name: "jira_read",
		label: "Jira Read",
		description: [
			"Read a Jira ticket. Two actions:",
			'- get: returns a digest (key, summary, status, assignee, description capped at 1500 characters). Pass raw: true for the complete server payload (view "full", fields ["*all"]) with no local shaping. The server may return bodies as HTML when markdown would lose rich content; the applied format and any server warning are preserved. A digest, especially a truncated HTML one, is not a safe write-back source: before editing description or environment, read with raw: true and write the body back in the format the server actually returned.',
			"- comments: returns one page of the issue's comments, newest-first (maxResults 20, orderBy -created), with pagination metadata (startAt, maxResults, total, isLast). Page by passing startAt; additional pages are not fetched automatically.",
			"The target is ticketKey when given, otherwise the ticket key detected from the current git branch (requires update-jira.json configuration). Read-only.",
		].join("\n"),
		promptSnippet: "Read a Jira ticket (digest, raw payload, or comment page)",
		promptGuidelines: [
			'Use jira_read with action "get" and raw: true before editing rich-text fields, and write bodies back in the appliedContentFormat the server returned.',
		],
		parameters: readParameters,
		annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
		outputSchema: resultOutputSchema,
		async execute(_id: string, params: ReadParams, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ToolExecuteContext): Promise<ToolResultLike> {
			const action = params.action ?? "unknown";
			const input = validateReadInput(params);
			if (!input.ok) {
				return failureResult({ tool: "jira_read", action, failure: input.failure });
			}
			if (signal?.aborted) {
				return failureResult({ tool: "jira_read", action, failure: { kind: "cancelled", message: "the call was cancelled before it started" } });
			}
			const prepared = await prepareCall(deps, ctx.cwd, params.ticketKey, signal);
			if (!prepared.ok) {
				return failureResult({ tool: "jira_read", action, failure: prepared.failure });
			}
			const { site, target } = prepared;
			const ticket = target.key;
			const spill = deps.spillFactory ? deps.spillFactory(sessionKeyOf(ctx)) : undefined;
			const transport = deps.transportFactory
				? deps.transportFactory(ctx)
				: transportFromContext(ctx as unknown as Parameters<typeof transportFromContext>[0]);

			try {
				if (params.action === "get") {
					const args = params.raw
						? withCloudId(site, { issueIdOrKey: ticket, view: "full", fields: ["*all"], responseContentFormat: "markdown" })
						: withCloudId(site, {
								issueIdOrKey: ticket,
								view: "full",
								fields: GET_DIGEST_FIELDS,
								fieldsByKeys: true,
								responseContentFormat: "markdown",
							});
					const outcome = await callPrimaryTool(transport, "mcp__atlassian__getJiraIssue", args, signal);
					const parsed = parseNestedOutcome(outcome as never);
					const failure = classifyOutcome(parsed, { isWrite: false, signal });
					if (failure) return failureFromKind(failure, { tool: "jira_read", action: "get", site, ticket, spill });
					const data = extractServerData(parsed.payload);
					if (params.raw) {
						return successResult({ tool: "jira_read", action: "get", site, ticket, data, spill });
					}
					const digest = buildIssueDigest(data);
					if (!digest.ok) {
						return failureResult({
							tool: "jira_read",
							action: "get",
							site,
							ticket,
							failure: { kind: "invalid_response", message: digest.message, evidence: parsed.payload },
							spill,
						});
					}
					return successResult({ tool: "jira_read", action: "get", site, ticket, data: digest.digest, spill });
				}
				// comments
				const startAt = params.startAt ?? 0;
				const outcome = await callGranularOperation(
					transport,
					"read",
					"listJiraIssueComments",
					{ issueIdOrKey: ticket, startAt, maxResults: 20, orderBy: "-created", responseContentFormat: "markdown" },
					site,
					signal,
				);
				const parsed = parseNestedOutcome(outcome as never);
				const failure = classifyOutcome(parsed, { isWrite: false, signal });
				if (failure) return failureFromKind(failure, { tool: "jira_read", action: "comments", site, ticket, spill });
				const data = extractServerData(parsed.payload);
				if (typeof data !== "object" || data === null || !Array.isArray((data as Record<string, unknown>).comments)) {
					return failureResult({
						tool: "jira_read",
						action: "comments",
						site,
						ticket,
						failure: { kind: "invalid_response", message: "the comments response did not contain a comments array", evidence: parsed.payload },
						spill,
					});
				}
				return successResult({ tool: "jira_read", action: "comments", site, ticket, data, spill });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				const kind: ErrorKind = signal?.aborted ? "cancelled" : "transport_error";
				return failureResult({ tool: "jira_read", action, site, ticket, failure: { kind, message, evidence: { thrown: message } }, spill });
			}
		},
	};
}

export { finalizeEnvelope };
