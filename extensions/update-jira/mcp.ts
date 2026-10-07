/**
 * Transport and nested-envelope handling for the update-jira extension.
 *
 * The Atlassian remote MCP v2 server is reached exclusively through
 * ctx.executeTool() inside a tool execute() handler. The transport is
 * injected here so tests can stub it; the production wiring lives in
 * index.ts / the tool factories.
 *
 * Verified envelope facts (read-only probe through installed pi 1.0.4):
 * - The nested outcome is { isError, result }, where result.structuredContent
 *   holds the complete MCP CallToolResult ({ content, isError }) and
 *   result.content is the same text truncated at 20 KiB.
 * - The server answers with a JSON text block shaped { data: ... } on success
 *   and { error: true, message, statusCode } on server-side failure.
 * - Unknown tools come back as outcome.isError with "Tool <name> not found"
 *   and no structuredContent.
 *
 * Pure module: no pi-runtime imports.
 */

import type { ErrorKind } from "./results.ts";

export const MCP_TOOL_PREFIX = "mcp__atlassian__";

export interface McpContentBlock {
	type?: string;
	text?: string;
}

/** The complete MCP CallToolResult, as found in nested structuredContent. */
export interface McpCallToolResult {
	content?: McpContentBlock[];
	isError?: boolean;
}

export interface NestedToolOutcome {
	isError?: boolean;
	result?: {
		content?: McpContentBlock[];
		isError?: boolean;
		structuredContent?: unknown;
	};
}

export type TransportCall = (
	toolName: string,
	args: Record<string, unknown>,
	signal?: AbortSignal,
) => Promise<NestedToolOutcome>;

export interface Transport {
	call: TransportCall;
}

export function createTransport(call: TransportCall): Transport {
	return { call };
}

/** Build a transport around a live extension tool context. Never retained. */
export function transportFromContext(ctx: {
	executeTool(name: string, args: unknown, options?: { signal?: AbortSignal }): Promise<NestedToolOutcome>;
}): Transport {
	return createTransport((toolName, args, signal) => ctx.executeTool(toolName, args, { signal }));
}

export type GranularMode = "read" | "write";

/** Route a primary (curated) MCP tool call. */
export function callPrimaryTool(
	transport: Transport,
	toolName: string,
	args: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<NestedToolOutcome> {
	return transport.call(toolName, args, signal);
}

/** Route a granular operation through executeRead / executeWrite with flat inputs. */
export function callGranularOperation(
	transport: Transport,
	mode: GranularMode,
	operation: string,
	inputs: Record<string, unknown>,
	cloudId: string,
	signal?: AbortSignal,
): Promise<NestedToolOutcome> {
	return transport.call(MCP_TOOL_PREFIX + (mode === "read" ? "executeRead" : "executeWrite"), { cloudId, name: operation, inputs }, signal);
}

export interface ServerErrorShape {
	message?: string;
	statusCode?: number;
	/** The raw JSON text of the server error block. */
	text: string;
}

export interface ParsedOutcome {
	/** The nested outcome succeeded at the pi layer (no outer error). */
	transportOk: boolean;
	/** The server reported success (CallToolResult without an error flag). Null when unknown. */
	serverOk: boolean | null;
	/** Parsed server payload when the server answered with a JSON object. */
	payload?: unknown;
	serverError?: ServerErrorShape;
	/** Text of the outer failure when there was no parseable server evidence. */
	outerErrorText?: string;
	hasStructuredContent: boolean;
}

/** Collect all text from a CallToolResult's content blocks. */
function callToolResultText(result: McpCallToolResult | undefined): string | undefined {
	if (!result || !Array.isArray(result.content)) return undefined;
	const texts = result.content.map((b) => (typeof b?.text === "string" ? b.text : "")).filter((t) => t !== "");
	return texts.length > 0 ? texts.join("") : undefined;
}

function tryParseJson(text: string | undefined): unknown {
	if (text === undefined) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function asServerError(value: unknown, text: string): ServerErrorShape | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const obj = value as Record<string, unknown>;
	if (obj.error !== true) return undefined;
	return {
		message: typeof obj.message === "string" ? obj.message : undefined,
		statusCode: typeof obj.statusCode === "number" ? obj.statusCode : undefined,
		text,
	};
}

/**
 * Parse a nested outcome into transport/server layers. Reads the complete
 * CallToolResult from result.structuredContent and falls back to the
 * truncated result.content when structuredContent is missing.
 */
export function parseNestedOutcome(outcome: NestedToolOutcome | undefined): ParsedOutcome {
	if (!outcome || typeof outcome !== "object") {
		return { transportOk: false, serverOk: null, outerErrorText: "(missing nested outcome)", hasStructuredContent: false };
	}
	const result = outcome.result;
	const sc = result?.structuredContent;
	const callToolResult: McpCallToolResult | undefined =
		sc && typeof sc === "object" && (Array.isArray((sc as McpCallToolResult).content) || typeof (sc as McpCallToolResult).isError === "boolean")
			? (sc as McpCallToolResult)
			: undefined;

	const text = callToolResultText(callToolResult) ?? callToolResultText(result);
	const parsedJson = tryParseJson(text);

	if (outcome.isError === true || result?.isError === true) {
		// Outer failure. The text may still carry a server error envelope.
		const serverError = typeof parsedJson !== "undefined" ? asServerError(parsedJson, text ?? "") : undefined;
		return {
			transportOk: false,
			serverOk: null,
			serverError,
			outerErrorText: text ?? "(no content in failed nested outcome)",
			hasStructuredContent: !!callToolResult,
		};
	}

	if (!callToolResult) {
		// Outer success but no parseable CallToolResult: the response shape is unusable.
		return { transportOk: true, serverOk: null, outerErrorText: text, hasStructuredContent: false };
	}

	if (callToolResult.isError === true) {
		const serverError = typeof parsedJson !== "undefined" ? asServerError(parsedJson, text ?? "") : undefined;
		return {
			transportOk: true,
			serverOk: false,
			serverError,
			outerErrorText: text ?? "(server error without a JSON envelope)",
			hasStructuredContent: true,
		};
	}

	if (typeof parsedJson === "object" && parsedJson !== null) {
		return { transportOk: true, serverOk: true, payload: parsedJson, hasStructuredContent: true };
	}
	// Server reported success but the body is not a JSON object.
	return { transportOk: true, serverOk: null, outerErrorText: text, hasStructuredContent: true };
}

/**
 * Extract the server data object from a parsed payload. Observed responses
 * nest under a top-level "data" key; "payload.data" is tolerated defensively
 * because it appeared in earlier probe notes, though current live responses
 * do not use it.
 */
export function extractServerData(payload: unknown): unknown {
	if (typeof payload !== "object" || payload === null) return payload;
	const obj = payload as Record<string, unknown>;
	if ("data" in obj) return obj.data;
	if (typeof obj.payload === "object" && obj.payload !== null && "data" in (obj.payload as Record<string, unknown>)) {
		return (obj.payload as Record<string, unknown>).data;
	}
	return payload;
}

/** Text fragments that reliably indicate a pre-dispatch permission block. */
const BLOCK_MARKERS = [
	"Tool execution was blocked",
	"guard: authorization failed closed",
	"guard:",
	"Denied by user",
	"Blocked by tool-permissions deny rule",
	"read-root grant did not authorize",
];

function looksLikeBlock(text: string | undefined): boolean {
	if (!text) return false;
	return BLOCK_MARKERS.some((marker) => text.includes(marker));
}

function looksLikeAbort(text: string | undefined): boolean {
	if (!text) return false;
	const lower = text.toLowerCase();
	return lower.includes("operation aborted") || lower.includes("was aborted") || lower.includes("aborterror");
}

function looksLikeUnknownTool(text: string | undefined): boolean {
	if (!text) return false;
	return /^Tool .+ not found/.test(text.trim());
}

export interface ClassifiedFailure {
	kind: ErrorKind;
	message: string;
	evidence: unknown;
}

/**
 * Classify a parsed nested outcome. Returns null when the outcome represents
 * definitive success (transport and server both succeeded).
 *
 * Classification is conservative: after a mutation could have been dispatched,
 * anything without definitive success or rejection evidence becomes
 * write_outcome_unknown. A block marker is treated as pre-dispatch evidence
 * only when the text matches known block phrasings; arbitrary error text is
 * never proof that no write was submitted.
 */
export function classifyOutcome(
	parsed: ParsedOutcome,
	options: { isWrite: boolean; signal?: AbortSignal; toolName?: string },
): ClassifiedFailure | null {
	const { isWrite, signal } = options;
	const unknownOutcome = isWrite ? "write_outcome_unknown" : "transport_error";
	const cancelledKind = isWrite ? "write_outcome_unknown" : "cancelled";
	const evidence = {
		transportOk: parsed.transportOk,
		serverOk: parsed.serverOk,
		serverError: parsed.serverError,
		outerErrorText: parsed.outerErrorText,
		hasStructuredContent: parsed.hasStructuredContent,
	};

	// Definitive success survives a later cancellation.
	if (parsed.transportOk && parsed.serverOk === true) return null;

	const text = parsed.serverError?.text ?? parsed.outerErrorText;

	// Server-side rejection with a structured envelope.
	if (parsed.serverError) {
		const status = parsed.serverError.statusCode;
		const message = parsed.serverError.message ?? text ?? "server rejected the operation";
		if (status === 404) return { kind: "not_found", message, evidence };
		if (status === 401 || status === 403) return { kind: "not_authenticated", message, evidence };
		return { kind: "rejected", message, evidence };
	}

	// Cancellation: our signal aborted, or pi reported an abort.
	if (signal?.aborted || looksLikeAbort(text)) {
		return { kind: cancelledKind, message: text ?? "the operation was cancelled", evidence };
	}

	if (looksLikeUnknownTool(text)) {
		return { kind: "tool_unavailable", message: text ?? "the nested MCP tool is not available", evidence };
	}

	if (looksLikeBlock(text)) {
		return { kind: "permission_denied", message: text ?? "the nested call was blocked before dispatch", evidence };
	}

	if (parsed.transportOk && parsed.serverOk === null) {
		// Transport succeeded but the response was missing or not parseable JSON.
		if (isWrite) {
			return { kind: "write_outcome_unknown", message: "the write response was missing or malformed; the outcome is unknown", evidence };
		}
		return { kind: "invalid_response", message: text ?? "the server response was missing or not parseable JSON", evidence };
	}

	return { kind: unknownOutcome, message: text ?? "the nested call failed without usable evidence", evidence };
}

/** Build the MCP argument object with cloudId first. */
export function withCloudId(cloudId: string, rest: Record<string, unknown>): Record<string, unknown> {
	return { cloudId, ...rest };
}
