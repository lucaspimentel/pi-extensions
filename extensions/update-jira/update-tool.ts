/**
 * The jira_update tool: serialized Jira mutations.
 *
 * Actions: transition, comment, link_pr, edit. Every mutation sequence,
 * including its transition enumeration or link dedupe read, runs inside the
 * per-site/ticket write queue. Write responses are reported as-is: no
 * re-fetch, no retry, no automatic verification read. An uncertain outcome
 * after a possible dispatch becomes write_outcome_unknown with separate-read
 * guidance.
 */

import { Type } from "typebox";
import {
	failureResult,
	invalidInput,
	isJsonSafe,
	prepareCall,
	rejectUnexpectedParams,
	successResult,
	type ToolDeps,
	type ToolResultLike,
} from "./common.ts";
import {
	callGranularOperation,
	callPrimaryTool,
	classifyOutcome,
	extractServerData,
	parseNestedOutcome,
	transportFromContext,
	withCloudId,
} from "./mcp.ts";
import { resolvePullRequest, validateRemoteLinkUrl } from "./branch.ts";
import { QueuedCancelledError } from "./write-queue.ts";
import { resultOutputSchema } from "./schema.ts";
import type { ErrorKind } from "./results.ts";
import type { ToolExecuteContext } from "./read-tool.ts";

export const updateParameters = Type.Object({
	action: Type.Union([Type.Literal("transition"), Type.Literal("comment"), Type.Literal("link_pr"), Type.Literal("edit")], {
		description: "Which mutation to perform. One ticket per call; no bulk operations.",
	}),
	ticketKey: Type.Optional(
		Type.String({ description: "Explicit ticket key (e.g. PROJ-123). Defaults to the ticket resolved from the current git branch." }),
	),
	status: Type.Optional(
		Type.String({ description: 'transition only: destination status name, matched case-insensitively against the issue\'s currently available transitions. Exactly one of status / transitionId.' }),
	),
	transitionId: Type.Optional(
		Type.String({ description: "transition only: a transition id from the issue's current transition list; verified against the enumeration before submission. Exactly one of status / transitionId." }),
	),
	body: Type.Optional(
		Type.String({ description: 'comment only: the comment text. Comments are add-only; existing comments are never edited here.' }),
	),
	contentFormat: Type.Optional(
		Type.Union([Type.Literal("markdown"), Type.Literal("html")], {
			description: 'comment: format of body (default markdown). edit: required when description or environment are supplied as string bodies; the complete body must be written in the format the server returned (read with jira_read raw: true first). HTML requires the site\'s HTML feature; a rejection is never retried as markdown.',
		}),
	),
	url: Type.Optional(
		Type.String({ description: "link_pr only: explicit credential-free https URL to link. Defaults to the current PR via gh pr view. The URL is stored exactly as supplied; it is not fetched or verified as a PR." }),
	),
	title: Type.Optional(
		Type.String({ description: "link_pr only: explicit non-empty link title. Otherwise the gh title, then the URL, is used." }),
	),
	fields: Type.Optional(
		Type.Record(Type.String(), Type.Unknown(), {
			description: 'edit only: Jira fields to SET, forwarded unchanged as raw field keys/IDs (e.g. {"priority":{"id":"2"}}). Multi-value fields replace, not append; null clears. Never additional_fields; no local name resolution. description/environment require explicit contentFormat and complete string bodies; raw ADF objects are rejected.',
		}),
	),
});

export type UpdateParams = {
	action: "transition" | "comment" | "link_pr" | "edit";
	ticketKey?: string;
	status?: string;
	transitionId?: string;
	body?: string;
	contentFormat?: "markdown" | "html";
	url?: string;
	title?: string;
	fields?: Record<string, unknown>;
};

function validateUpdateInput(params: UpdateParams): { ok: true } | { ok: false; failure: ReturnType<typeof invalidInput> } {
	const action = params.action;
	const allowed: readonly string[] =
		action === "transition"
			? ["action", "ticketKey", "status", "transitionId"]
			: action === "comment"
				? ["action", "ticketKey", "body", "contentFormat"]
				: action === "link_pr"
					? ["action", "ticketKey", "url", "title"]
					: ["action", "ticketKey", "fields", "contentFormat"];
	const unexpected = rejectUnexpectedParams(params as unknown as Record<string, unknown>, allowed, action);
	if (unexpected) return { ok: false, failure: unexpected };

	if (action === "transition") {
		const hasStatus = typeof params.status === "string" && params.status.trim() !== "";
		const hasId = typeof params.transitionId === "string" && params.transitionId.trim() !== "";
		if (hasStatus === hasId) {
			return { ok: false, failure: invalidInput('transition requires exactly one of status or transitionId (both non-empty strings)') };
		}
	}
	if (action === "comment") {
		if (typeof params.body !== "string" || params.body.trim() === "") {
			return { ok: false, failure: invalidInput("comment requires a non-empty body") };
		}
	}
	if (action === "link_pr") {
		if (params.title !== undefined && typeof params.title === "string" && params.title.trim() === "") {
			return { ok: false, failure: invalidInput("title must be a non-empty string when provided") };
		}
	}
	if (action === "edit") {
		const fields = params.fields;
		if (typeof fields !== "object" || fields === null || Array.isArray(fields)) {
			return { ok: false, failure: invalidInput("edit requires a fields object") };
		}
		if (Object.keys(fields).length === 0) {
			return { ok: false, failure: invalidInput("fields must not be empty") };
		}
		if (!isJsonSafe(fields)) {
			return { ok: false, failure: invalidInput("fields contains values that are not valid JSON; non-JSON values are rejected rather than dropped or coerced") };
		}
		for (const key of ["description", "environment"] as const) {
			if (!(key in fields)) continue;
			const value = (fields as Record<string, unknown>)[key];
			if (typeof value === "string" && params.contentFormat === undefined) {
				return { ok: false, failure: invalidInput(`fields.${key} is a string body and requires an explicit contentFormat of "markdown" or "html"`) };
			}
			if (value !== null && typeof value !== "string") {
				return { ok: false, failure: invalidInput(`fields.${key} must be a complete string body or null to clear; raw ADF objects are not accepted`) };
			}
		}
	}
	return { ok: true };
}

function sessionKeyOf(ctx: ToolExecuteContext): string {
	const file = ctx.sessionManager?.getSessionFile?.();
	if (!file) return "session";
	const base = file.split(/[/\\]/).pop() ?? "session";
	return base.replace(/\.[^.]+$/, "") || "session";
}

/** Collect the names of fields a transition requires from the caller. */
export function requiredTransitionFieldNames(fields: unknown): string[] {
	let entries: unknown[];
	if (Array.isArray(fields)) {
		entries = fields;
	} else if (typeof fields === "object" && fields !== null) {
		entries = Object.values(fields as Record<string, unknown>);
	} else {
		return [];
	}
	const names: string[] = [];
	for (const entry of entries) {
		if (typeof entry === "object" && entry !== null && (entry as Record<string, unknown>).required === true) {
			const record = entry as Record<string, unknown>;
			names.push(typeof record.name === "string" ? record.name : typeof record.key === "string" ? record.key : "unknown field");
		}
	}
	return names;
}

/** Best-effort extraction of the landed status from a transition write response. */
export function extractLandedStatus(serverData: unknown): string | undefined {
	if (typeof serverData !== "object" || serverData === null) return undefined;
	const data = serverData as Record<string, unknown>;
	if (typeof data.statusName === "string") return data.statusName;
	const status = data.status;
	if (typeof status === "string") return status;
	if (typeof status === "object" && status !== null) {
		const name = (status as Record<string, unknown>).name;
		if (typeof name === "string") return name;
	}
	const fields = data.fields;
	if (typeof fields === "object" && fields !== null) {
		const fieldStatus = (fields as Record<string, unknown>).status;
		if (typeof fieldStatus === "object" && fieldStatus !== null) {
			const name = (fieldStatus as Record<string, unknown>).name;
			if (typeof name === "string") return name;
		}
	}
	return undefined;
}

export function extractCommentId(serverData: unknown): string | undefined {
	if (typeof serverData !== "object" || serverData === null) return undefined;
	const data = serverData as Record<string, unknown>;
	const id = data.id ?? data.commentId;
	return typeof id === "string" ? id : typeof id === "number" ? String(id) : undefined;
}

const WRITE_GUIDANCE =
	"If the outcome is uncertain, verify with a separate read (jira_read action get) before considering a retry; never retry blindly.";

interface FailureBase {
	tool: "jira_read" | "jira_update";
	action: string;
	site?: string;
	ticket?: string;
	spill?: ReturnType<NonNullable<ToolDeps["spillFactory"]>>;
}

function failureFromKind(
	failure: { kind: ErrorKind; message: string; evidence: unknown },
	base: FailureBase,
): ToolResultLike {
	return failureResult({ ...base, failure: { kind: failure.kind, message: failure.message, evidence: failure.evidence } });
}

export function createUpdateTool(deps: ToolDeps) {
	return {
		name: "jira_update",
		label: "Jira Update",
		description: [
			"Update a Jira ticket. Four actions, one ticket per call:",
			"- transition: move the ticket by destination status (matched case-insensitively against the issue's current transitions) or by explicit transitionId (verified against the enumeration). Zero or multiple status matches are rejected with the available candidates. Transitions requiring screen fields you did not supply are rejected with the required field names. Reports the landed status the write response returned.",
			"- comment: adds a comment (add-only; existing comments are never edited). body is markdown by default; pass contentFormat: html for HTML. HTML feature rejection is surfaced, never retried as markdown.",
			"- link_pr: adds a native remote link to the issue's Web links section (not a comment). url defaults to the current PR via gh pr view in the working directory. The URL is stored exactly as supplied, not fetched or verified. Deduped best-effort by exact URL match against existing links inside the queue; an existing link returns an explicit no-op. Dedupe can still race with other sessions and clients, and duplicates are permanent: no available operation removes a remote link.",
			"- edit: sets Jira fields by raw key/ID, forwarded unchanged (never additional_fields, no local name resolution). Multi-value fields replace rather than append; null clears. description/environment must be complete string bodies with an explicit contentFormat matching the format the server returned on read (jira_read raw: true); raw ADF objects are rejected. There is no pre-read, merge, or conversion: omitted content is not preserved by this wrapper, and edited fields may not be echoed in the response.",
			"Mutations for the same site/ticket are serialized in this extension; writes from other sessions and clients are not ordered. Every write reports its response only: there is no automatic re-fetch. If the outcome of a write is uncertain (timeout, cancellation, malformed or ambiguous response), the result says so and you must verify with a separate read before any retry.",
			"The target is ticketKey when given, otherwise the ticket key detected from the current git branch. Requires update-jira.json configuration. Permission enforcement belongs to external guard machinery, not this tool.",
		].join("\n"),
		promptSnippet: "Update a Jira ticket (transition, comment, PR link, field edit)",
		promptGuidelines: [
			'Before editing description or environment, read the current body with jira_read action "get" raw: true and write back the complete body in the format the server returned (HTML bodies must be written as HTML).',
			"Uncertain write outcomes require a separate verification read before any retry; do not retry blindly.",
		],
		parameters: updateParameters,
		annotations: { readOnlyHint: false, openWorldHint: true },
		outputSchema: resultOutputSchema,
		async execute(_id: string, params: UpdateParams, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ToolExecuteContext): Promise<ToolResultLike> {
			const action = params.action ?? "unknown";
			const input = validateUpdateInput(params);
			if (!input.ok) {
				return failureResult({ tool: "jira_update", action, failure: input.failure });
			}
			if (signal?.aborted) {
				return failureResult({ tool: "jira_update", action, failure: { kind: "cancelled", message: "the call was cancelled before it started" } });
			}
			const prepared = await prepareCall(deps, ctx.cwd, params.ticketKey, signal);
			if (!prepared.ok) {
				return failureResult({ tool: "jira_update", action, failure: prepared.failure });
			}
			const { site, target, cwd } = prepared;
			const ticket = target.key;
			const spill = deps.spillFactory ? deps.spillFactory(sessionKeyOf(ctx)) : undefined;
			const base: FailureBase = { tool: "jira_update", action, site, ticket, spill };

			try {
				return await deps.queue.enqueue(site, ticket, async () => {
					if (signal?.aborted) {
						return failureResult({ ...base, failure: { kind: "cancelled", message: "the call was cancelled before any remote dispatch" } });
					}
					const transport = deps.transportFactory
						? deps.transportFactory(ctx)
						: transportFromContext(ctx as unknown as Parameters<typeof transportFromContext>[0]);

					if (action === "transition") {
						return await doTransition({ transport, site, ticket, params, signal, base });
					}
					if (action === "comment") {
						return await doComment({ transport, site, ticket, params, signal, base });
					}
					if (action === "link_pr") {
						return await doLinkPr({ transport, site, ticket, params, signal, base, cwd, deps });
					}
					return await doEdit({ transport, site, ticket, params, signal, base });
				});
			} catch (err) {
				if (err instanceof QueuedCancelledError || signal?.aborted) {
					return failureResult({ ...base, failure: { kind: "cancelled", message: err instanceof QueuedCancelledError ? err.message : `the call was cancelled: ${err instanceof Error ? err.message : String(err)}` } });
				}
				const message = err instanceof Error ? err.message : String(err);
				return failureResult({ ...base, failure: { kind: "write_outcome_unknown", message: `the mutation sequence failed after it may have been dispatched: ${message}. ${WRITE_GUIDANCE}`, evidence: { thrown: message } } });
			}
		},
	};
}

interface ActionArgs {
	transport: ReturnType<typeof transportFromContext>;
	site: string;
	ticket: string;
	params: UpdateParams;
	signal: AbortSignal | undefined;
	base: FailureBase;
}

async function doTransition(args: ActionArgs): Promise<ToolResultLike> {
	const { transport, site, ticket, params, signal, base } = args;
	// Enumeration read inside the queue, before any dispatch.
	const listOutcome = await callGranularOperation(
		transport,
		"read",
		"listJiraIssueTransitions",
		{ issueIdOrKey: ticket, expand: "transitions.fields" },
		site,
		signal,
	);
	const listParsed = parseNestedOutcome(listOutcome as never);
	const listFailure = classifyOutcome(listParsed, { isWrite: false, signal });
	if (listFailure) return failureFromKind(listFailure, base);
	const listData = extractServerData(listParsed.payload);
	const transitions =
		typeof listData === "object" && listData !== null && Array.isArray((listData as Record<string, unknown>).transitions)
			? ((listData as Record<string, unknown>).transitions as Array<Record<string, unknown>>)
			: undefined;
	if (!transitions) {
		return failureResult({
			...base,
			failure: { kind: "invalid_response", message: "the transitions response did not contain a transitions array", evidence: listParsed.payload },
		});
	}

	let chosen: Record<string, unknown> | undefined;
	if (params.status !== undefined) {
		const wanted = params.status.trim().toLowerCase();
		const matches = transitions.filter((t) => {
			const to = t.to as Record<string, unknown> | undefined;
			return typeof to?.name === "string" && to.name.toLowerCase() === wanted;
		});
		if (matches.length === 0) {
			return failureResult({
				...base,
				failure: {
					kind: "rejected",
					message: `no available transition leads to status "${params.status}"`,
					evidence: { candidates: transitions.map(candidateSummary) },
				},
			});
		}
		if (matches.length > 1) {
			return failureResult({
				...base,
				failure: {
					kind: "rejected",
					message: `status "${params.status}" matches ${matches.length} transitions; pass an explicit transitionId instead`,
					evidence: { candidates: matches.map(candidateSummary) },
				},
			});
		}
		chosen = matches[0];
	} else {
		const wanted = (params.transitionId ?? "").trim();
		const matches = transitions.filter((t) => t.id === wanted);
		if (matches.length === 0) {
			return failureResult({
				...base,
				failure: {
					kind: "rejected",
					message: `transitionId "${wanted}" is not among the currently available transitions`,
					evidence: { candidates: transitions.map(candidateSummary) },
				},
			});
		}
		chosen = matches[0];
	}

	const required = requiredTransitionFieldNames(chosen.fields);
	if (required.length > 0) {
		return failureResult({
			...base,
			failure: {
				kind: "rejected",
				message: `transition ${String(chosen.id)} requires fields this action does not supply: ${required.join(", ")}`,
				evidence: { transitionId: chosen.id, requiredFields: required },
			},
		});
	}

	const writeOutcome = await callPrimaryTool(
		transport,
		"mcp__atlassian__transitionJiraIssue",
		withCloudId(site, { issueIdOrKey: ticket, transitionId: String(chosen.id) }),
		signal,
	);
	const writeParsed = parseNestedOutcome(writeOutcome as never);
	const writeFailure = classifyOutcome(writeParsed, { isWrite: true, signal });
	if (writeFailure) {
		return failureResult({
			...base,
			failure: {
				kind: writeFailure.kind,
				message: writeFailure.kind === "write_outcome_unknown" ? `${writeFailure.message} ${WRITE_GUIDANCE}` : writeFailure.message,
				evidence: writeFailure.evidence,
			},
		});
	}
	const serverData = extractServerData(writeParsed.payload);
	const landedStatus = extractLandedStatus(serverData);
	return successResult({
		tool: "jira_update",
		action: "transition",
		site,
		ticket,
		data: { server: serverData, ...(landedStatus !== undefined ? { landedStatus } : {}) },
		spill: base.spill,
	});
}

function candidateSummary(t: Record<string, unknown>): Record<string, unknown> {
	const to = t.to as Record<string, unknown> | undefined;
	return { id: t.id, name: t.name, to: to?.name };
}

async function doComment(args: ActionArgs): Promise<ToolResultLike> {
	const { transport, site, ticket, params, signal, base } = args;
	const writeArgs: Record<string, unknown> = withCloudId(site, { issueIdOrKey: ticket, commentBody: params.body });
	if (params.contentFormat !== undefined) writeArgs.contentFormat = params.contentFormat;
	const writeOutcome = await callPrimaryTool(transport, "mcp__atlassian__addOrEditJiraIssueComment", writeArgs, signal);
	const writeParsed = parseNestedOutcome(writeOutcome as never);
	const writeFailure = classifyOutcome(writeParsed, { isWrite: true, signal });
	if (writeFailure) {
		return failureResult({
			...base,
			failure: {
				kind: writeFailure.kind,
				message: writeFailure.kind === "write_outcome_unknown" ? `${writeFailure.message} ${WRITE_GUIDANCE}` : writeFailure.message,
				evidence: writeFailure.evidence,
			},
		});
	}
	const serverData = extractServerData(writeParsed.payload);
	const commentId = extractCommentId(serverData);
	return successResult({
		tool: "jira_update",
		action: "comment",
		site,
		ticket,
		data: { server: serverData, ...(commentId !== undefined ? { commentId } : {}) },
		spill: base.spill,
	});
}

async function doLinkPr(
	args: ActionArgs & { cwd: string; deps: ToolDeps },
): Promise<ToolResultLike> {
	const { transport, site, ticket, params, signal, base, cwd, deps } = args;
	// URL resolution happens before the queue-internal dedupe read; a failed or
	// malformed gh result prevents mutation.
	let url: string;
	let ghTitle: string | undefined;
	if (params.url !== undefined) {
		const valid = validateRemoteLinkUrl(params.url);
		if (!valid.ok) {
			return failureResult({ ...base, failure: { kind: "invalid_input", message: `invalid url: ${valid.reason}` } });
		}
		url = params.url;
	} else {
		const pr = await resolvePullRequest(deps.run, cwd, signal);
		if (!pr.ok) {
			return failureResult({ ...base, failure: { kind: pr.kind, message: pr.message } });
		}
		url = pr.pr.url;
		ghTitle = pr.pr.title;
	}
	const explicitTitle = params.title !== undefined && params.title.trim() !== "" ? params.title : undefined;
	const title = explicitTitle ?? ghTitle ?? url;

	// Dedupe read inside the queue; a failed or malformed read prevents creation.
	const listOutcome = await callGranularOperation(transport, "read", "listJiraIssueRemoteIssueLinks", { issueIdOrKey: ticket }, site, signal);
	const listParsed = parseNestedOutcome(listOutcome as never);
	const listFailure = classifyOutcome(listParsed, { isWrite: false, signal });
	if (listFailure) return failureFromKind(listFailure, base);
	const listData = extractServerData(listParsed.payload);
	if (!Array.isArray(listData)) {
		return failureResult({
			...base,
			failure: { kind: "invalid_response", message: "the remote links response did not contain an array", evidence: listParsed.payload },
		});
	}
	const existing = listData.find((link) => {
		if (typeof link !== "object" || link === null) return false;
		const object = (link as Record<string, unknown>).object;
		return typeof object === "object" && object !== null && (object as Record<string, unknown>).url === url;
	});
	if (existing) {
		return successResult({
			tool: "jira_update",
			action: "link_pr",
			site,
			ticket,
			data: { created: false, existingLink: existing, note: "a remote link with this exact URL already exists; nothing was created" },
			spill: base.spill,
		});
	}
	const linkInputs: Record<string, unknown> = { issueIdOrKey: ticket, url };
	const suppliedTitle = explicitTitle ?? ghTitle;
	if (suppliedTitle !== undefined) linkInputs.title = suppliedTitle;
	const writeOutcome = await callGranularOperation(transport, "write", "createJiraIssueRemoteIssueLink", linkInputs, site, signal);
	const writeParsed = parseNestedOutcome(writeOutcome as never);
	const writeFailure = classifyOutcome(writeParsed, { isWrite: true, signal });
	if (writeFailure) {
		return failureResult({
			...base,
			failure: {
				kind: writeFailure.kind,
				message: writeFailure.kind === "write_outcome_unknown" ? `${writeFailure.message} ${WRITE_GUIDANCE}` : writeFailure.message,
				evidence: writeFailure.evidence,
			},
		});
	}
	return successResult({
		tool: "jira_update",
		action: "link_pr",
		site,
		ticket,
		data: { created: true, url, title, server: extractServerData(writeParsed.payload) },
		spill: base.spill,
	});
}

async function doEdit(args: ActionArgs): Promise<ToolResultLike> {
	const { transport, site, ticket, params, signal, base } = args;
	const writeArgs: Record<string, unknown> = withCloudId(site, { issueIdOrKey: ticket, fields: params.fields });
	if (params.contentFormat !== undefined) writeArgs.contentFormat = params.contentFormat;
	const writeOutcome = await callPrimaryTool(transport, "mcp__atlassian__editJiraIssue", writeArgs, signal);
	const writeParsed = parseNestedOutcome(writeOutcome as never);
	const writeFailure = classifyOutcome(writeParsed, { isWrite: true, signal });
	if (writeFailure) {
		return failureResult({
			...base,
			failure: {
				kind: writeFailure.kind,
				message: writeFailure.kind === "write_outcome_unknown" ? `${writeFailure.message} ${WRITE_GUIDANCE}` : writeFailure.message,
				evidence: writeFailure.evidence,
			},
		});
	}
	return successResult({
		tool: "jira_update",
		action: "edit",
		site,
		ticket,
		data: { server: extractServerData(writeParsed.payload), note: "the response may not echo every edited field; a successful edit does not prove each field was echoed" },
		spill: base.spill,
	});
}
