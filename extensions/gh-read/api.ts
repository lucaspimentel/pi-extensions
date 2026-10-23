/**
 * gh-read API operations: pinned repository contents and trees, combined
 * commit checks, exact advisory lookup, check-run annotations, repository
 * metadata, and mutable PR comments/reviews. Operation orchestration and
 * result rendering live together in this module.
 *
 * Contract highlights (docs/gh-read-design.md, "GitHub API operations"):
 * - Omitted refs resolve through repository default-branch metadata, then
 *   resolve once to a full commit SHA; every dependent read is pinned to
 *   that SHA and the requested target plus resolved SHA are reported.
 * - All endpoint segments and query values are percent-encoded here; the
 *   requester (api-spawn.ts) receives final, tool-authored paths only.
 * - Combined checks fetch check runs (filter=latest) and latest legacy
 *   statuses per context against one immutable SHA, auto-paging at most
 *   10 pages x 100 items per source per invocation via strictly validated
 *   Link headers. Mutable CI results are not a transactional snapshot.
 * - Continuations are versioned, size-bounded tokens carrying operation,
 *   target/query, pinned SHA, and independent per-source page/done states;
 *   they are matched against the invocation and resumed refs are never
 *   re-resolved.
 * - External jq filtering (jq.ts) is preflighted BEFORE network access and
 *   applied once to the final newly fetched batch, never to tool metadata.
 * - The displayed result is capped at API_DISPLAY_CAP bytes including
 *   metadata, escaping, diagnostics, and notices; overflow produces an
 *   explicitly incomplete UTF-8-safe prefix preview plus narrowing guidance.
 *   No hidden full payload is retained in details or on disk.
 */

import {
	API_HEADERS_CAP,
	API_STDOUT_BUDGET,
	type ApiClock,
	type ApiRequester,
	type ApiRequestOutcome,
	defaultClock,
	GhApiRunner,
	type GhApiResponse,
	isGhApiError,
	isGhApiStop,
} from "./api-spawn.ts";
import { CONTINUATION_MAX_CHARS, type AdvisoryType, type ApiOperation, type ValidApiInvocation } from "./validate.ts";
import { executeJq, prepareJq, type JqOutcome, type JqPrepared } from "./jq.ts";

/** Byte cap for the ENTIRE displayed API result, metadata included. */
export const API_DISPLAY_CAP = 50 * 1024;
/** Decoded file-text cap for contents reads. */
export const CONTENTS_MAX_DECODED_BYTES = 1024 * 1024;
/** Directory entries per GitHub contents page; at this size incompleteness is possible. */
export const DIRECTORY_PAGE_SIZE = 1000;
/** Per-source page ceiling: at most 10 pages x 100 items per invocation. */
export const MAX_PAGES_PER_SOURCE = 10;
export const PAGE_SIZE = 100;
const SHA_RE = /^[0-9a-f]{40}$/;
const FULL_SHA_RE = /^[0-9a-fA-F]{40}$/;

export interface ApiToolResult {
	content: [{ type: "text"; text: string }];
	details: Record<string, unknown>;
	isError?: boolean;
}

export interface ApiOperationDeps {
	/** Test seam: requester override (network-free orchestration tests). */
	requester?: ApiRequester;
	clock?: ApiClock;
	/** Test seam: jq execution override. */
	jqRun?: (expression: string, document: string) => Promise<JqOutcome>;
}

// ── Request construction ─────────────────────────────────────────────────────

/** Percent-encodes one path segment for a GitHub API endpoint. */
function encodeSegment(segment: string): string {
	return encodeURIComponent(segment);
}

/** Serializes query parameters in fixed key order; values percent-encoded. */
function buildQuery(entries: ReadonlyArray<readonly [string, string | number]>): string {
	const parts = entries.map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`);
	return parts.join("&");
}

/** Endpoint for one contents read (path may be empty for the root). */
function contentsEndpoint(repo: string, path: string): string {
	const [owner, name] = splitRepo(repo);
	if (path.length === 0) return `repos/${owner}/${name}/contents`;
	const segments = path.split("/").map(encodeSegment).join("/");
	return `repos/${owner}/${name}/contents/${segments}`;
}

function splitRepo(repo: string): [string, string] {
	const at = repo.indexOf("/");
	return [repo.slice(0, at), repo.slice(at + 1)];
}

function commitEndpoint(repo: string, ref: string): string {
	const [owner, name] = splitRepo(repo);
	return `repos/${owner}/${name}/commits/${encodeSegment(ref)}`;
}

function checkRunsEndpoint(repo: string, sha: string, page: number): string {
	const [owner, name] = splitRepo(repo);
	const query = buildQuery([
		["filter", "latest"],
		["per_page", PAGE_SIZE],
		["page", page],
	]);
	return `repos/${owner}/${name}/commits/${sha}/check-runs?${query}`;
}

function statusEndpoint(repo: string, sha: string, page: number): string {
	const [owner, name] = splitRepo(repo);
	const query = buildQuery([
		["per_page", PAGE_SIZE],
		["page", page],
	]);
	return `repos/${owner}/${name}/commits/${sha}/status?${query}`;
}

function prCommentsEndpoint(repo: string, pr: number, page: number): string {
	const [owner, name] = splitRepo(repo);
	return `repos/${owner}/${name}/pulls/${pr}/comments?${buildQuery([["per_page", PAGE_SIZE], ["page", page]])}`;
}

function prReviewsEndpoint(repo: string, pr: number, page: number): string {
	const [owner, name] = splitRepo(repo);
	return `repos/${owner}/${name}/pulls/${pr}/reviews?${buildQuery([["per_page", PAGE_SIZE], ["page", page]])}`;
}

function issueCommentsEndpoint(repo: string, issue: number, page: number): string {
	const [owner, name] = splitRepo(repo);
	return `repos/${owner}/${name}/issues/${issue}/comments?${buildQuery([["per_page", PAGE_SIZE], ["page", page]])}`;
}

function treeEndpoint(repo: string, treeSha: string, recursive: boolean): string {
	const [owner, name] = splitRepo(repo);
	if (!recursive) return `repos/${owner}/${name}/git/trees/${treeSha}`;
	return `repos/${owner}/${name}/git/trees/${treeSha}?${buildQuery([["recursive", 1]])}`;
}

function cveAdvisoriesEndpoint(id: string, type: string, page: number): string {
	const query = buildQuery([
		["cve_id", id],
		["type", type],
		["per_page", PAGE_SIZE],
		["page", page],
	]);
	return `advisories?${query}`;
}

function advisoryEndpoint(id: string): string {
	return `advisories/${encodeSegment(id)}`;
}

/**
 * Endpoint for one check run's annotations: a single page of at most 100
 * items, no pagination, no Link parsing, exactly ONE request ever. The id
 * is a validated safe integer from validate.ts.
 */
function annotationsEndpoint(repo: string, checkRunId: number): string {
	const [owner, name] = splitRepo(repo);
	return `repos/${owner}/${name}/check-runs/${checkRunId}/annotations?${buildQuery([["per_page", PAGE_SIZE]])}`;
}

// ── Link-header pagination ───────────────────────────────────────────────────

/** Extracts the rel="next" target from a retained header block, or null. */
function nextLinkFromHeaders(headers: string): string | null {
	const match = /<([^>]*)>;\s*rel="next"/i.exec(headers);
	return match !== null ? match[1]! : null;
}

/**
 * Validates a next-link against the current request and extracts ONLY the
 * page number. The origin must be api.github.com on https, the endpoint path
 * must equal the current one, every invariant query parameter must be
 * present and unchanged, no unexpected parameter may appear, and the page
 * must be exactly current + 1 (cycles, foreign URLs, and ambiguous links are
 * rejected). Requests are always reconstructed from tool-owned templates;
 * the URL itself is never fetched.
 */
function validateNextPage(
	nextUrl: string,
	currentEndpoint: string,
	currentQuery: ReadonlyArray<readonly [string, string | number]>,
	currentPage: number,
): { ok: true; page: number } | { ok: false; reason: string } {
	let parsed: URL;
	try {
		parsed = new URL(nextUrl);
	} catch {
		return { ok: false, reason: "next link is not a valid URL" };
	}
	if (parsed.origin !== "https://api.github.com") {
		return { ok: false, reason: `next link origin '${parsed.origin}' is not https://api.github.com` };
	}
	const expectedPath = `/${currentEndpoint.split("?")[0]}`;
	if (parsed.pathname !== expectedPath) {
		return { ok: false, reason: `next link path '${parsed.pathname}' does not match '${expectedPath}'` };
	}
	const invariants = new Map(currentQuery.filter(([key]) => key !== "page").map(([key, value]) => [key, String(value)]));
	const seen = new Set<string>();
	for (const [key, value] of parsed.searchParams) {
		if (key === "page") continue;
		if (!invariants.has(key) || invariants.get(key) !== value) {
			return { ok: false, reason: `next link changed or added query parameter '${key}'` };
		}
		seen.add(key);
	}
	for (const key of invariants.keys()) {
		if (!seen.has(key)) return { ok: false, reason: `next link dropped invariant query parameter '${key}'` };
	}
	const pageRaw = parsed.searchParams.get("page");
	if (pageRaw === null || !/^\d+$/.test(pageRaw)) {
		return { ok: false, reason: "next link is missing a valid page parameter" };
	}
	const page = Number(pageRaw);
	if (!Number.isSafeInteger(page) || page !== currentPage + 1) {
		return { ok: false, reason: `next link page ${pageRaw} is not the expected ${currentPage + 1}` };
	}
	return { ok: true, page };
}

// ── Continuations ────────────────────────────────────────────────────────────

interface SourceState {
	page: number;
	done: boolean;
}

interface CommitChecksContinuation {
	v: 1;
	op: "commit checks";
	repo: string;
	ref: string;
	sha: string;
	checks: SourceState;
	statuses: SourceState;
}

interface AdvisoryContinuation {
	v: 1;
	op: "advisory view";
	id: string;
	type: AdvisoryType;
	advisories: SourceState;
}

type PrReadOperation = "pr comments" | "pr reviews";

interface PrReadContinuation {
	v: 1;
	op: PrReadOperation;
	repo: string;
	pr: number;
	perPage: number;
	source: SourceState;
}

function decodePrReadContinuation(record: Record<string, unknown>): PrReadContinuation | null {
	if (record["v"] !== 1 || (record["op"] !== "pr comments" && record["op"] !== "pr reviews")) return null;
	if (typeof record["repo"] !== "string" || typeof record["pr"] !== "number" || !Number.isSafeInteger(record["pr"]) || record["pr"] < 1) return null;
	if (record["perPage"] !== PAGE_SIZE) return null;
	const source = record["source"];
	if (typeof source !== "object" || source === null || Array.isArray(source)) return null;
	const state = source as Record<string, unknown>;
	if (typeof state["page"] !== "number" || !Number.isSafeInteger(state["page"]) || state["page"] < 1 || state["done"] !== false) return null;
	return record as unknown as PrReadContinuation;
}

interface IssueCommentsContinuation {
	v: 1;
	op: "issue comments";
	repo: string;
	issue: number;
	perPage: number;
	source: SourceState;
}

function decodeIssueCommentsContinuation(record: Record<string, unknown>): IssueCommentsContinuation | null {
	if (record["v"] !== 1 || record["op"] !== "issue comments") return null;
	if (typeof record["repo"] !== "string" || typeof record["issue"] !== "number" || !Number.isSafeInteger(record["issue"]) || record["issue"] < 1) return null;
	if (record["perPage"] !== PAGE_SIZE) return null;
	const source = record["source"];
	if (typeof source !== "object" || source === null || Array.isArray(source)) return null;
	const state = source as Record<string, unknown>;
	if (typeof state["page"] !== "number" || !Number.isSafeInteger(state["page"]) || state["page"] < 1 || state["done"] !== false) return null;
	return record as unknown as IssueCommentsContinuation;
}

type ContinuationPayload = CommitChecksContinuation | AdvisoryContinuation | PrReadContinuation | IssueCommentsContinuation;

function encodeContinuation(payload: ContinuationPayload): { ok: true; token: string } | { ok: false; reason: string } {
	const token = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
	if (token.length > CONTINUATION_MAX_CHARS) {
		return { ok: false, reason: `continuation token exceeds ${CONTINUATION_MAX_CHARS} characters` };
	}
	return { ok: true, token };
}

function decodeContinuation(token: string): ContinuationPayload | null {
	try {
		const parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as unknown;
		if (typeof parsed !== "object" || parsed === null) return null;
		const record = parsed as Record<string, unknown>;
		if (record["v"] !== 1) return null;
		if (record["op"] === "commit checks" || record["op"] === "advisory view") return parsed as ContinuationPayload;
		if (record["op"] === "pr comments" || record["op"] === "pr reviews") return decodePrReadContinuation(record);
		if (record["op"] === "issue comments") return decodeIssueCommentsContinuation(record);
		return null;
	} catch {
		return null;
	}
}

// ── Shared helpers ───────────────────────────────────────────────────────────

interface ResolvedRef {
	kind: "resolved";
	sha: string;
	/** Human-readable description of what was requested. */
	target: string;
}

type RefResolution = ResolvedRef | { kind: "error"; reason: string; isError: true };

/**
 * Resolves a branch/tag/SHA ref once to a full commit SHA. An omitted ref
 * resolves through repository default-branch metadata. An already-complete
 * lowercase 40-hex SHA is used directly (it is already immutable; uppercase
 * hex and short SHAs still resolve through the API).
 */
async function resolveRef(
	requester: ApiRequester,
	repo: string,
	ref: string | undefined,
): Promise<RefResolution> {
	let refName: string;
	let target: string;
	if (ref === undefined) {
		const [owner, name] = splitRepo(repo);
		const outcome = await requester.request(`repos/${owner}/${name}`);
		if (!isResponse(outcome)) {
			return { kind: "error", reason: describeRequestFailure("default-branch lookup", outcome), isError: true };
		}
		const body = parseJsonObject(outcome.body);
		if (typeof body !== "object" || body === null || typeof (body as Record<string, unknown>)["default_branch"] !== "string") {
			return { kind: "error", reason: "repository metadata did not contain a default_branch", isError: true };
		}
		refName = (body as Record<string, unknown>)["default_branch"] as string;
		target = `default branch '${refName}'`;
	} else {
		refName = ref;
		target = `ref '${ref}'`;
	}
	if (SHA_RE.test(refName)) {
		return { kind: "resolved", sha: refName, target: `${target} (complete SHA used directly)` };
	}
	const outcome = await requester.request(commitEndpoint(repo, refName));
	if (!isResponse(outcome)) {
		return { kind: "error", reason: describeRequestFailure(`ref resolution for ${target}`, outcome), isError: true };
	}
	const body = parseJsonObject(outcome.body);
	if (typeof body !== "object" || body === null || typeof (body as Record<string, unknown>)["sha"] !== "string") {
		return { kind: "error", reason: `commit lookup for ${target} did not return a sha`, isError: true };
	}
	const sha = (body as Record<string, unknown>)["sha"] as string;
	if (!SHA_RE.test(sha)) {
		return { kind: "error", reason: `resolved sha '${sha}' is not a full 40-hex commit SHA`, isError: true };
	}
	return { kind: "resolved", sha, target };
}

function isResponse(outcome: ApiRequestOutcome): outcome is GhApiResponse {
	return outcome.kind === "response";
}

function describeRequestFailure(what: string, outcome: ApiRequestOutcome): string {
	if (isGhApiStop(outcome)) return `${what}: ${outcome.reason}`;
	if (isGhApiError(outcome)) {
		return `${what} failed: ${outcome.reason}${outcome.httpStatus !== undefined ? ` (HTTP ${outcome.httpStatus})` : ""}`;
	}
	return `${what}: unexpected response outcome`;
}

/** Strict UTF-8 + JSON parse of a response body; returns an error string on failure. */
function parseJsonObject(body: string): Record<string, unknown> | string {
	try {
		const parsed = JSON.parse(body) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return "response body was not a JSON object";
		}
		return parsed as Record<string, unknown>;
	} catch {
		return "response body was not valid JSON";
	}
}

// ── Rendering ────────────────────────────────────────────────────────────────

interface RenderOptions {
	isError: boolean;
	/** Extra notice lines rendered above the data block. */
	notices?: string[];
}

/**
 * Renders metadata lines plus the data block under API_DISPLAY_CAP. The
 * metadata block is always complete; on overflow the data becomes an
 * explicitly incomplete UTF-8-safe prefix preview with narrowing guidance.
 * Nothing beyond the displayed text is retained anywhere.
 */
function renderResult(summary: string, metadata: ReadonlyArray<[string, string | number | boolean | null]>, dataText: string, options: RenderOptions): ApiToolResult {
	const lines: string[] = [summary];
	for (const [key, value] of metadata) {
		lines.push(`${key}: ${String(value)}`);
	}
	for (const notice of options.notices ?? []) {
		lines.push(`notice: ${notice}`);
	}
	const head = lines.join("\n");
	const dataLabel = "data:";
	const overflowNotice =
		"[gh_read: the API result exceeds 50 KiB. Showing an incomplete UTF-8-safe prefix, NOT complete JSON. Narrow the request (jq filter, line range, subtree path, shallower recursion) and re-run.]";

	const headBytes = Buffer.byteLength(head, "utf8") + Buffer.byteLength(dataLabel, "utf8") + 2 + Buffer.byteLength(overflowNotice, "utf8") + 1;
	let data = dataText;
	let outputTruncated = false;
	if (headBytes + Buffer.byteLength(dataText, "utf8") > API_DISPLAY_CAP) {
		outputTruncated = true;
		const budget = Math.max(0, API_DISPLAY_CAP - headBytes);
		data = utf8SafePrefix(dataText, budget);
	}

	const text = outputTruncated ? `${head}\n${dataLabel}\n${data}\n${overflowNotice}` : `${head}\n${dataLabel}\n${data}`;
	const details: Record<string, unknown> = {
		output_truncated: outputTruncated,
	};
	for (const [key, value] of metadata) details[key] = value;
	return {
		content: [{ type: "text", text }],
		details,
		...(options.isError ? { isError: true } : {}),
	};
}

/** UTF-8-safe prefix: never splits a multibyte sequence or a surrogate pair. */
function utf8SafePrefix(text: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	const buf = Buffer.from(text, "utf8");
	if (buf.length <= maxBytes) return text;
	let cut = maxBytes;
	// Walk back over continuation bytes so a multibyte char is never split.
	while (cut > 0 && (buf[cut]! & 0xc0) === 0x80) cut -= 1;
	// Also drop an incomplete lead byte at the boundary.
	if (cut > 0 && (buf[cut - 1]! & 0xc0) === 0xc0) cut -= 1;
	// Recompute from the JS string so surrogate pairs stay intact.
	let s = buf.subarray(0, cut).toString("utf8");
	while (s.length > 0) {
		const code = s.codePointAt(s.length - 1)!;
		if (code >= 0xd800 && code <= 0xdfff && !/\p{L}|\p{N}/u.test(s.slice(-2))) break;
		s = s.slice(0, -1);
		if (Buffer.byteLength(s, "utf8") <= cut - 3 || s.length === 0) break;
	}
	return s;
}

// ── Operation: repository contents ──────────────────────────────────────────

function splitLines(text: string): string[] {
	const lines: string[] = [];
	let start = 0;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === "\n" || (ch === "\r" && text[i + 1] !== "\n")) {
			lines.push(text.slice(start, i + 1));
			start = i + 1;
		}
	}
	if (start < text.length) lines.push(text.slice(start));
	return lines;
}

function decodeStrictBase64(content: string): { ok: true; bytes: Buffer } | { ok: false; reason: string } {
	const cleaned = content.replace(/\s+/g, "");
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned) || cleaned.length % 4 !== 0) {
		return { ok: false, reason: "content is not strictly base64-encoded" };
	}
	return { ok: true, bytes: Buffer.from(cleaned, "base64") };
}

function decodeUtf8Strict(bytes: Buffer): { ok: true; text: string } | { ok: false; reason: string } {
	try {
		return { ok: true, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
	} catch {
		return { ok: false, reason: "content is not valid UTF-8" };
	}
}

interface FileTextResult {
	kind: "text";
	text: string;
	totalLines: number;
	firstLine: number;
	lastLine: number;
}

type FileContentOutcome =
	| FileTextResult
	| { kind: "metadata"; reason: string }
	| { kind: "error"; reason: string };

/** Applies the contents contract to one GitHub file/symlink/submodule object. */
function fileContentOutcome(obj: Record<string, unknown>): FileContentOutcome {
	const type = obj["type"];
	if (type === "commit") {
		return { kind: "metadata", reason: "submodule entry: not ordinary file content; submodules are never traversed" };
	}
	if (type !== "file" && type !== "symlink") {
		return { kind: "metadata", reason: `nonordinary content type '${String(type)}': metadata only` };
	}
	const rawContent = typeof obj["content"] === "string" ? obj["content"] : "";
	const size = typeof obj["size"] === "number" ? obj["size"] : 0;
	if ((rawContent.length === 0 && size > 0) || size > CONTENTS_MAX_DECODED_BYTES) {
		return { kind: "metadata", reason: `oversized file (${size} bytes): GitHub serves inline content only up to about 1 MiB; clone or use the git blobs API outside this tool` };
	}
	const decoded = decodeStrictBase64(rawContent);
	if (!decoded.ok) return { kind: "error", reason: `GitHub returned ${decoded.reason}` };
	if (decoded.bytes.includes(0)) {
		return { kind: "metadata", reason: `binary content (${decoded.bytes.length} bytes, contains NUL bytes): text output unsupported` };
	}
	const utf8 = decodeUtf8Strict(decoded.bytes);
	if (!utf8.ok) {
		return { kind: "metadata", reason: `${utf8.reason} (${decoded.bytes.length} bytes): text output unsupported` };
	}
	if (type === "symlink") {
		// A symlink object's content is its target path, not file text.
		return { kind: "metadata", reason: `symlink targeting '${utf8.text}': metadata only` };
	}
	return { kind: "text", text: utf8.text, totalLines: 0, firstLine: 0, lastLine: 0 };
}

// ── Operation bodies ─────────────────────────────────────────────────────────

async function opRepoContents(invocation: ValidApiInvocation, requester: ApiRequester, deps?: ApiOperationDeps): Promise<ApiToolResult> {
	const repo = invocation.repo!;
	const path = invocation.path!;
	const metadata: Array<[string, string | number | boolean | null]> = [["repo", repo], ["path", path.length === 0 ? "(root)" : path]];

	const resolved = await resolveRef(requester, repo, invocation.ref);
	if (resolved.kind === "error") {
		return renderResult(`gh_read api: repo contents ${repo}`, metadata, "", { isError: true, notices: [resolved.reason] });
	}
	metadata.push(["target", resolved.target], ["resolved_sha", resolved.sha]);

	const outcome = await requester.request(contentsEndpoint(repo, path) + `?${buildQuery([["ref", resolved.sha]])}`);
	if (!isResponse(outcome)) {
		return renderResult(`gh_read api: repo contents ${repo}`, metadata, "", {
			isError: true,
			notices: [describeRequestFailure("contents read", outcome)],
		});
	}
	const parsed = JSON.parse(outcome.body) as unknown;
	if (Array.isArray(parsed)) {
		if (invocation.startLine !== undefined || invocation.endLine !== undefined) {
			return renderResult(`gh_read api: repo contents ${repo}`, metadata, "", {
				isError: true,
				notices: ["line ranges apply only to text files, not directory listings"],
			});
		}
		const possiblyIncomplete = parsed.length >= DIRECTORY_PAGE_SIZE;
		const notices = possiblyIncomplete
			? [`directory listing returned ${parsed.length} entries (GitHub caps a contents page at ${DIRECTORY_PAGE_SIZE}); entries may be incomplete: use a tree read for completeness`]
			: [];
		return await renderData(invocation, `gh_read api: repo contents ${repo} ${path.length === 0 ? "(root)" : path}`, metadata, parsed, notices, false, requester, deps);
	}
	if (typeof parsed !== "object" || parsed === null) {
		return renderResult(`gh_read api: repo contents ${repo}`, metadata, "", { isError: true, notices: ["response body was not a JSON object or array"] });
	}
	const obj = parsed as Record<string, unknown>;
	const entryType = typeof obj["type"] === "string" ? obj["type"] : "unknown";

	if (entryType === "symlink") {
		const followResult = await followSymlink(invocation, requester, obj, metadata, resolved.sha);
		return followResult;
	}

	const contentOutcome = fileContentOutcome(obj);
	if (contentOutcome.kind === "error") {
		return renderResult(`gh_read api: repo contents ${repo}`, metadata, "", { isError: true, notices: [contentOutcome.reason] });
	}
	if (contentOutcome.kind === "metadata") {
		metadata.push(["type", entryType], ["size", typeof obj["size"] === "number" ? obj["size"] : null]);
		return renderResult(`gh_read api: repo contents ${repo} ${path.length === 0 ? "(root)" : path}`, metadata, "", {
			isError: false,
			notices: [contentOutcome.reason],
		});
	}

	// Text file: apply the 1-based inclusive line range.
	if (invocation.jq !== undefined) {
		return renderResult(`gh_read api: repo contents ${repo} ${path}`, metadata, "", {
			isError: true,
			notices: ["jq is supported only for directory JSON, not file text"],
		});
	}
	if (invocation.startLine !== undefined || invocation.endLine !== undefined) {
		const lines = splitLines(contentOutcome.text);
		const start = invocation.startLine ?? 1;
		const end = invocation.endLine ?? lines.length;
		const selected = lines.slice(start - 1, end);
		metadata.push(
			["total_lines", lines.length],
			["line_range", `${start}-${Math.min(end, lines.length)}`],
			["line_endings", "preserved verbatim"],
		);
		return renderResult(`gh_read api: repo contents ${repo} ${path}`, metadata, selected.join(""), { isError: false });
	}
	metadata.push(["total_lines", splitLines(contentOutcome.text).length]);
	return renderResult(`gh_read api: repo contents ${repo} ${path}`, metadata, contentOutcome.text, { isError: false });
}

/**
 * Follows an in-repository ordinary-file symlink target exactly one level:
 * the decoded target is joined to the symlink's directory and a single
 * metadata lookup decides whether it resolves to an ordinary file. External
 * URLs, downloads, and further traversal are never followed.
 */
async function followSymlink(
	invocation: ValidApiInvocation,
	requester: ApiRequester,
	obj: Record<string, unknown>,
	metadata: Array<[string, string | number | boolean | null]>,
	sha: string,
): Promise<ApiToolResult> {
	const repo = invocation.repo!;
	const path = invocation.path!;
	const rawContent = typeof obj["content"] === "string" ? obj["content"] : "";
	const decoded = decodeStrictBase64(rawContent);
	if (!decoded.ok) {
		return renderResult(`gh_read api: repo contents ${repo} ${path}`, metadata, "", { isError: true, notices: [`GitHub returned ${decoded.reason}`] });
	}
	const targetPath = decoded.bytes.toString("utf8");
	metadata.push(["type", "symlink"], ["symlink_target", targetPath]);

	if (invocation.jq !== undefined) {
		return renderResult(`gh_read api: repo contents ${repo} ${path}`, metadata, "", {
			isError: true,
			notices: ["jq is supported only for directory JSON, not symlink or file text"],
		});
	}

	// Join the target relative to the symlink's directory, lexically, never
	// escaping the repository root.
	const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
	const segments: string[] = [];
	for (const part of targetPath.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			if (segments.length === 0) {
				return renderResult(`gh_read api: repo contents ${repo} ${path}`, metadata, "", {
					isError: false,
					notices: [`symlink target '${targetPath}' escapes the repository root; not followed`],
				});
			}
			segments.pop();
			continue;
		}
		segments.push(part);
	}
	const joined = segments.join("/");

	const outcome = await requester.request(contentsEndpoint(repo, joined) + `?${buildQuery([["ref", sha]])}`);
	if (!isResponse(outcome)) {
		return renderResult(`gh_read api: repo contents ${repo} ${path}`, metadata, "", {
			isError: false,
			notices: [`symlink target '${joined}' lookup failed (${describeRequestFailure("target read", outcome)}); not followed`],
		});
	}
	const parsed = JSON.parse(outcome.body) as unknown;
	if (Array.isArray(parsed) || typeof parsed !== "object" || parsed === null) {
		return renderResult(`gh_read api: repo contents ${repo} ${path}`, metadata, "", {
			isError: false,
			notices: [`symlink target '${joined}' is not an ordinary file; not followed`],
		});
	}
	const targetObj = parsed as Record<string, unknown>;
	if (targetObj["type"] !== "file") {
		return renderResult(`gh_read api: repo contents ${repo} ${path}`, metadata, "", {
			isError: false,
			notices: [`symlink target '${joined}' has type '${String(targetObj["type"])}'; only ordinary files are followed`],
		});
	}
	const contentOutcome = fileContentOutcome(targetObj);
	if (contentOutcome.kind !== "text") {
		const reason = contentOutcome.kind === "error" ? contentOutcome.reason : contentOutcome.reason;
		return renderResult(`gh_read api: repo contents ${repo} ${path}`, metadata, "", {
			isError: contentOutcome.kind === "error",
			notices: [`symlink target '${joined}' could not be served as text: ${reason}`],
		});
	}
	metadata.push(["followed_symlink", joined], ["total_lines", splitLines(contentOutcome.text).length]);
	return renderResult(`gh_read api: repo contents ${repo} ${path} (via symlink '${joined}')`, metadata, contentOutcome.text, { isError: false });
}

/**
 * Renders a JSON data payload with optional external jq filtering (applied
 * once, to the final fetched batch only).
 */
async function renderData(
	invocation: ValidApiInvocation,
	summary: string,
	metadata: Array<[string, string | number | boolean | null]>,
	data: unknown,
	notices: string[],
	isError: boolean,
	requester: ApiRequester,
	deps?: ApiOperationDeps,
): Promise<ApiToolResult> {
	if (invocation.jq !== undefined) {
		const document = JSON.stringify(data);
		const jqResult = deps?.jqRun
			? await deps.jqRun(invocation.jq, document)
			: await runToolJq(invocation.jq, document, requester, deps);
		if (jqResult.kind === "error") {
			return renderResult(summary, metadata, "", {
				isError: true,
				notices: [...notices, `jq filtering failed: ${jqResult.reason}`],
			});
		}
		const jqNotices = [...notices];
		if (jqResult.outputTruncated) jqNotices.push(`jq output exceeded the ${1024 * 1024}-byte capture cap and was clipped`);
		if (jqResult.output.length === 0) jqNotices.push("jq produced no output values: empty filtered result");
		return renderResult(summary, metadata, jqResult.output, { isError, notices: jqNotices });
	}
	return renderResult(summary, metadata, JSON.stringify(data), { isError, notices });
}

/** Preflight + execute wiring under the requester's shared deadline. */
async function runToolJq(expression: string, document: string, requester: ApiRequester, deps?: ApiOperationDeps): Promise<JqOutcome> {
	const clock = deps?.clock ?? defaultClock;
	const deadlineAt = requester.deadline();
	const prepared: JqPrepared = await prepareJq(expression, { deadlineAt, clock });
	if (prepared.kind === "error") return prepared;
	return await executeJq(prepared, expression, document, { deadlineAt, clock });
}

async function opRepoTree(invocation: ValidApiInvocation, requester: ApiRequester, deps?: ApiOperationDeps): Promise<ApiToolResult> {
	const repo = invocation.repo!;
	const metadata: Array<[string, string | number | boolean | null]> = [["repo", repo]];
	const recursive = invocation.recursive ?? true;
	const summary = `gh_read api: repo tree ${repo}`;

	const resolved = await resolveRef(requester, repo, invocation.ref);
	if (resolved.kind === "error") {
		return renderResult(summary, metadata, "", { isError: true, notices: [resolved.reason] });
	}
	metadata.push(["target", resolved.target], ["resolved_sha", resolved.sha], ["recursive", recursive]);

	// Resolve the commit's tree SHA, then read the tree.
	const commitOutcome = await requester.request(`repos/${splitRepo(repo)[0]}/${splitRepo(repo)[1]}/git/commits/${resolved.sha}`);
	if (!isResponse(commitOutcome)) {
		return renderResult(summary, metadata, "", { isError: true, notices: [describeRequestFailure("tree-sha lookup", commitOutcome)] });
	}
	const commitBody = parseJsonObject(commitOutcome.body);
	if (typeof commitBody === "string") {
		return renderResult(summary, metadata, "", { isError: true, notices: [commitBody] });
	}
	const treeObj = commitBody["tree"];
	if (typeof treeObj !== "object" || treeObj === null || typeof (treeObj as Record<string, unknown>)["sha"] !== "string") {
		return renderResult(summary, metadata, "", { isError: true, notices: ["git commit lookup did not return a tree sha"] });
	}
	const treeSha = (treeObj as Record<string, unknown>)["sha"] as string;
	metadata.push(["tree_sha", treeSha]);

	// Shallow mode omits the recursive query parameter entirely.
	const treeOutcome = await requester.request(treeEndpoint(repo, treeSha, recursive));
	if (!isResponse(treeOutcome)) {
		return renderResult(summary, metadata, "", { isError: true, notices: [describeRequestFailure("tree read", treeOutcome)] });
	}
	const treeBody = parseJsonObject(treeOutcome.body);
	if (typeof treeBody === "string") {
		return renderResult(summary, metadata, "", { isError: true, notices: [treeBody] });
	}

	// Optional subtree filter: entries equal to the path or under it. Truncated
	// upstream responses are preserved as-is; truncation is never repaired by
	// expanding subtrees.
	let data: Record<string, unknown> = treeBody;
	const subtree = invocation.path;
	if (subtree !== undefined && subtree.length > 0) {
		const entries = Array.isArray(treeBody["tree"]) ? (treeBody["tree"] as unknown[]) : [];
		const filtered = entries.filter((entry) => {
			if (typeof entry !== "object" || entry === null) return false;
			const entryPath = (entry as Record<string, unknown>)["path"];
			return entryPath === subtree || (typeof entryPath === "string" && entryPath.startsWith(`${subtree}/`));
		});
		data = { ...treeBody, tree: filtered };
		metadata.push(["subtree_path", subtree], ["subtree_entries", filtered.length]);
		if (filtered.length === 0) {
			metadata.push(["subtree_match", false]);
		}
	}
	if (treeBody["truncated"] === true) {
		metadata.push(["upstream_truncated", true]);
	}
	const notices: string[] = [];
	if (treeBody["truncated"] === true) {
		notices.push("GitHub reported the tree as truncated: the upstream response is incomplete and this tool does not repair truncation; use a shallower or subtree read");
	}
	return await renderData(invocation, summary, metadata, data, notices, false, requester, deps);
}

// ── Operation: combined commit checks ──────────────────────────────────────

interface SourceFetchResult {
	items: unknown[];
	done: boolean;
	/** Next unfetched page when not done. */
	page: number;
	/** Nonerror incompleteness reason (page/budget stop between responses). */
	stopReason?: string;
	/** Error state: the source failed and the position is retained for retry. */
	error?: { reason: string };
	/** Extra metadata describing the fetch. */
	pagesFetched: number;
}

async function fetchPagedSource(
	requester: ApiRequester,
	buildRequest: (page: number) => { endpoint: string; query: ReadonlyArray<readonly [string, string | number]> },
	extractItems: (body: unknown) => unknown[] | string,
	state: SourceState,
): Promise<SourceFetchResult> {
	const items: unknown[] = [];
	let page = state.page;
	let pagesFetched = 0;
	if (state.done) return { items, done: true, page, pagesFetched };

	while (pagesFetched < MAX_PAGES_PER_SOURCE) {
		if (requester.budgetExhausted()) {
			return { items, done: false, page, pagesFetched, stopReason: `captured-output budget of ${API_STDOUT_BUDGET} bytes exhausted between responses` };
		}
		const { endpoint, query } = buildRequest(page);
		const outcome = await requester.request(endpoint);
		if (isGhApiStop(outcome)) {
			return { items, done: false, page, pagesFetched, stopReason: outcome.reason };
		}
		if (isGhApiError(outcome)) {
			// Interrupted/error responses are errors; the position is retained
			// so a continuation retries this exact page.
			return { items, done: false, page, pagesFetched, error: { reason: describeRequestFailure("paged read", outcome) } };
		}
		pagesFetched += 1;
		let parsedBody: unknown;
		try {
			parsedBody = JSON.parse(outcome.body) as unknown;
		} catch {
			return { items, done: false, page, pagesFetched, error: { reason: "response body was not valid JSON" } };
		}
		const extracted = extractItems(parsedBody);
		if (typeof extracted === "string") {
			return { items, done: false, page, pagesFetched, error: { reason: extracted } };
		}
		items.push(...extracted);

		const next = nextLinkFromHeaders(outcome.headers);
		if (next === null) {
			return { items, done: true, page, pagesFetched };
		}
		const validated = validateNextPage(next, endpoint, query, page);
		if (!validated.ok) {
			return { items, done: false, page: page + 1, pagesFetched, error: { reason: `next-link validation failed: ${validated.reason}` } };
		}
		page = validated.page;
	}
	return {
		items,
		done: false,
		page,
		pagesFetched,
		stopReason: `page limit reached (${MAX_PAGES_PER_SOURCE} pages x ${PAGE_SIZE} items per source per invocation)`,
	};
}

async function opCommitChecks(invocation: ValidApiInvocation, requester: ApiRequester, deps?: ApiOperationDeps): Promise<ApiToolResult> {
	const repo = invocation.repo!;
	const ref = invocation.ref!;
	const summary = `gh_read api: commit checks ${repo}`;
	const metadata: Array<[string, string | number | boolean | null]> = [["repo", repo], ["ref", ref]];
	const notices: string[] = [];
	let isError = false;

	// Continuation match: the token must name this exact operation, repo, and
	// ref; a resumed ref is never re-resolved (the pinned SHA is reused).
	let sha: string;
	let checksState: SourceState;
	let statusesState: SourceState;
	if (invocation.continuation !== undefined) {
		const payload = decodeContinuation(invocation.continuation);
		if (payload === null || payload.op !== "commit checks" || payload.repo !== repo || payload.ref !== ref) {
			return renderResult(summary, metadata, "", {
				isError: true,
				notices: ["continuation does not match this invocation (operation, repo, or ref differ)"],
			});
		}
		sha = payload.sha;
		checksState = { ...payload.checks };
		statusesState = { ...payload.statuses };
		metadata.push(["resumed", true], ["resolved_sha", sha]);
		if (payload.checks.done && !payload.statuses.done) {
			notices.push("check-runs source completed in the earlier invocation; only the newly fetched statuses batch is shown");
		} else if (payload.statuses.done && !payload.checks.done) {
			notices.push("statuses source completed in the earlier invocation; only the newly fetched check-runs batch is shown");
		}
	} else {
		const resolved = await resolveRef(requester, repo, ref);
		if (resolved.kind === "error") {
			return renderResult(summary, metadata, "", { isError: true, notices: [resolved.reason] });
		}
		sha = resolved.sha;
		checksState = { page: 1, done: false };
		statusesState = { page: 1, done: false };
		metadata.push(["target", resolved.target], ["resolved_sha", sha]);
	}
	metadata.push(["pinned", "both sources read against the immutable resolved SHA"]);

	const checksQuery: ReadonlyArray<readonly [string, string | number]> = [
		["filter", "latest"],
		["per_page", PAGE_SIZE],
		["page", checksState.page],
	];
	const statusesQuery: ReadonlyArray<readonly [string, string | number]> = [
		["per_page", PAGE_SIZE],
		["page", statusesState.page],
	];

	const checks = await fetchPagedSource(
		requester,
		(page) => ({ endpoint: checkRunsEndpoint(repo, sha, page), query: checksQuery }),
		(body) => {
			if (typeof body !== "object" || body === null) return "check-runs response was not a JSON object";
			const runs = (body as Record<string, unknown>)["check_runs"];
			return Array.isArray(runs) ? (runs as unknown[]) : "check-runs response had no check_runs array";
		},
		checksState,
	);
	const statuses = await fetchPagedSource(
		requester,
		(page) => ({ endpoint: statusEndpoint(repo, sha, page), query: statusesQuery }),
		(body) => {
			if (typeof body !== "object" || body === null) return "combined-status response was not a JSON object";
			const list = (body as Record<string, unknown>)["statuses"];
			return Array.isArray(list) ? (list as unknown[]) : "combined-status response had no statuses array";
		},
		statusesState,
	);

	// Latest legacy status per context: the combined-status endpoint returns
	// statuses newest-first, so the first occurrence of each context wins.
	const seenContexts = new Set<string>();
	const latestStatuses: unknown[] = [];
	for (const status of statuses.items) {
		if (typeof status === "object" && status !== null) {
			const context = (status as Record<string, unknown>)["context"];
			if (typeof context === "string") {
				if (seenContexts.has(context)) continue;
				seenContexts.add(context);
			}
		}
		latestStatuses.push(status);
	}

	if (checks.error !== undefined) {
		isError = true;
		metadata.push(["checks_error", checks.error.reason]);
	}
	if (statuses.error !== undefined) {
		isError = true;
		metadata.push(["statuses_error", statuses.error.reason]);
	}
	if (checks.stopReason !== undefined) {
		metadata.push(["checks_incomplete_reason", checks.stopReason]);
		notices.push(`check-runs source incomplete: ${checks.stopReason}`);
	}
	if (statuses.stopReason !== undefined) {
		metadata.push(["statuses_incomplete_reason", statuses.stopReason]);
		notices.push(`statuses source incomplete: ${statuses.stopReason}`);
	}
	metadata.push(
		["checks_complete", checks.done && checks.error === undefined],
		["check_runs_returned", checks.items.length],
		["statuses_complete", statuses.done && statuses.error === undefined],
		["statuses_returned", latestStatuses.length],
	);
	notices.push(
		"check results are mutable CI state, not a transactional snapshot; this tool does not infer mergeability or claim aggregate green. GitHub also bounds which check suites it returns for old commits (service-side limit), so local completion does not prove historical completeness",
	);

	// A continuation is needed whenever a source has an unfetched position or
	// an error to retry.
	let continuationToken: string | null = null;
	const needsContinuation = !checks.done || !statuses.done;
	if (needsContinuation) {
		const encoded = encodeContinuation({
			v: 1,
			op: "commit checks",
			repo,
			ref,
			sha,
			checks: { page: checks.page, done: checks.done },
			statuses: { page: statuses.page, done: statuses.done },
		});
		if (encoded.ok) {
			continuationToken = encoded.token;
			metadata.push(["continuation", encoded.token]);
		} else {
			isError = true;
			notices.push(`continuation could not be encoded: ${encoded.reason}`);
		}
	}

	const data = { check_runs: checks.items, statuses: latestStatuses };
	const result = await renderData(invocation, summary, metadata, data, notices, isError, requester, deps);
	if (continuationToken !== null && result.details["continuation"] === undefined) {
		result.details["continuation"] = continuationToken;
	}
	return result;
}

// ── Operation: exact advisory lookup ──────────────────────────────────────

async function opAdvisoryView(invocation: ValidApiInvocation, requester: ApiRequester, deps?: ApiOperationDeps): Promise<ApiToolResult> {
	const id = invocation.id!;
	const summary = `gh_read api: advisory view ${id}`;
	const metadata: Array<[string, string | number | boolean | null]> = [["id", id]];
	const notices: string[] = [];

	if (id.startsWith("GHSA-")) {
		// GHSAs are fetched directly as one object regardless of any type
		// parameter (type and continuation for GHSAs are rejected at validation).
		const outcome = await requester.request(advisoryEndpoint(id));
		if (!isResponse(outcome)) {
			return renderResult(summary, metadata, "", { isError: true, notices: [describeRequestFailure("advisory lookup", outcome)] });
		}
		const body = parseJsonObject(outcome.body);
		if (typeof body === "string") {
			return renderResult(summary, metadata, "", { isError: true, notices: [body] });
		}
		metadata.push(["lookup", "direct GHSA object"], ["withdrawn", body["withdrawn"] === undefined || body["withdrawn"] === null ? "no" : String(body["withdrawn"])]);
		notices.push("advisory content is mutable and can be withdrawn or amended after this read");
		return await renderData(invocation, summary, metadata, body, notices, false, requester, deps);
	}

	// CVE: query as an array search with an explicit reviewed default.
	const type = invocation.type ?? "reviewed";
	metadata.push(["searched_type", type]);
	let page = 1;
	if (invocation.continuation !== undefined) {
		const payload = decodeContinuation(invocation.continuation);
		if (payload === null || payload.op !== "advisory view" || payload.id !== id || payload.type !== type) {
			return renderResult(summary, metadata, "", {
				isError: true,
				notices: ["continuation does not match this invocation (id or type differ)"],
			});
		}
		page = payload.advisories.page;
		if (payload.advisories.done) {
			return renderResult(summary, metadata, "", {
				isError: false,
				notices: ["this CVE search already completed in the earlier invocation"],
			});
		}
		metadata.push(["resumed", true]);
	}

	const query: ReadonlyArray<readonly [string, string | number]> = [
		["cve_id", id],
		["type", type],
		["per_page", PAGE_SIZE],
		["page", page],
	];
	const result = await fetchPagedSource(
		requester,
		(p) => ({ endpoint: cveAdvisoriesEndpoint(id, type, p), query }),
		(body) => {
			// The advisories search returns a JSON array body.
			return Array.isArray(body) ? (body as unknown[]) : "advisories response was not a JSON array";
		},
		{ page, done: false },
	);
	if (result.error !== undefined) {
		return renderResult(summary, metadata, "", { isError: true, notices: [result.error.reason] });
	}
	if (result.stopReason !== undefined) {
		metadata.push(["incomplete_reason", result.stopReason]);
		notices.push(`CVE search incomplete: ${result.stopReason}`);
	}
	const done = result.done;
	if (!done) {
		const encoded = encodeContinuation({ v: 1, op: "advisory view", id, type, advisories: { page: result.page, done: false } });
		if (encoded.ok) metadata.push(["continuation", encoded.token]);
		else {
			notices.push(`continuation could not be encoded: ${encoded.reason}`);
		}
	}
	if (result.items.length === 0) {
		notices.push(`no advisories found for ${id} with type '${type}': an empty result for this type is not proof of global absence`);
	}
	notices.push("advisory content is mutable and can be withdrawn or amended after this read");
	return await renderData(invocation, summary, metadata, result.items, notices, false, requester, deps);
}

// ── Operations: PR inline comments and reviews, issue conversation comments ─

/**
 * Shared bounded-pagination handler for the three discussion reads. The
 * operation selects its endpoint, numeric target, target metadata field,
 * summary label, notices, and continuation payload explicitly; nothing here
 * infers the target from a shared field, so an issue read can never route to
 * the PR endpoint.
 */
async function opDiscussionRead(invocation: ValidApiInvocation, requester: ApiRequester, deps?: ApiOperationDeps): Promise<ApiToolResult> {
	const op = invocation.op as PrReadOperation | "issue comments";
	const isIssue = op === "issue comments";
	const repo = invocation.repo!;
	const number = isIssue ? invocation.issue! : invocation.pr!;
	const targetField = isIssue ? "issue" : "pr";
	const targetLabel = isIssue ? "issue" : "PR";
	const endpoint = op === "pr comments" ? prCommentsEndpoint : op === "pr reviews" ? prReviewsEndpoint : issueCommentsEndpoint;
	const summary = `gh_read api: ${op} ${repo} ${targetLabel} ${number}`;
	const metadata: Array<[string, string | number | boolean | null]> = [["repo", repo], [targetField, number]];
	// The distinction and mutability notices are initialized before any
	// continuation matching so they survive handler errors, jq-empty/scalar/
	// error output, and display clipping.
	const notices = isIssue
		? [
			"issue comments returns conversation comments for both issues and pull requests; inline PR review comments and replies require the 'pr comments' operation",
			"issue comments are mutable reads, not commit-pinned or transactional snapshots; offset paging may miss or duplicate items, and completion describes the observed traversal, not a historical snapshot",
		]
		: [
			"PR comments/reviews are mutable reads, not commit-pinned or transactional snapshots; completion describes traversal, not historical completeness",
			"REST responses do not provide resolved/outdated review-thread state",
		];
	let page = 1;
	if (invocation.continuation !== undefined) {
		const payload = decodeContinuation(invocation.continuation);
		let matchedPage: number | null = null;
		if (payload !== null && payload.op === op && payload.repo === repo) {
			if (payload.op === "issue comments") {
				if (payload.issue === number) matchedPage = payload.source.page;
			} else if (payload.pr === number) {
				matchedPage = payload.source.page;
			}
		}
		if (matchedPage === null) {
			return renderResult(summary, metadata, "", { isError: true, notices: [...notices, `continuation does not match this invocation (operation, repo, ${targetLabel}, or page invariants differ)`] });
		}
		page = matchedPage;
		metadata.push(["resumed", true]);
		notices.push("a resumed result contains only the newly fetched batch, not items returned by earlier invocations");
	}
	// Check the deadline between responses without changing the runner's
	// interrupted-response errors or the other operations' paging behavior.
	const clock = deps?.clock ?? defaultClock;
	const pagedRequester: ApiRequester = {
		request: async (path) => clock.now() >= requester.deadline()
			? { kind: "stop", reason: "shared deadline exceeded between responses" }
			: await requester.request(path),
		capturedBytes: () => requester.capturedBytes(),
		budgetExhausted: () => requester.budgetExhausted(),
		deadline: () => requester.deadline(),
	};
	const result = await fetchPagedSource(
		pagedRequester,
		(p) => ({ endpoint: endpoint(repo, number, p), query: [["per_page", PAGE_SIZE], ["page", p]] }),
		(body) => Array.isArray(body) ? body : `${op} response was not a JSON array`,
		{ page, done: false },
	);
	let isError = result.error !== undefined;
	metadata.push(["source_complete", result.done], ["items_returned", result.items.length], ["pages_fetched", result.pagesFetched]);
	if (result.error !== undefined) metadata.push(["source_error", result.error.reason]);
	if (result.stopReason !== undefined) metadata.push(["incomplete_reason", result.stopReason]);
	if (!result.done) {
		const encoded = isIssue
			? encodeContinuation({ v: 1, op: "issue comments", repo, issue: number, perPage: PAGE_SIZE, source: { page: result.page, done: false } })
			: encodeContinuation({ v: 1, op: op as PrReadOperation, repo, pr: number, perPage: PAGE_SIZE, source: { page: result.page, done: false } });
		if (encoded.ok) metadata.push(["continuation", encoded.token]);
		else {
			isError = true;
			notices.push(`continuation could not be encoded: ${encoded.reason}`);
		}
	}
	return await renderData(invocation, summary, metadata, result.items, notices, isError, requester, deps);
}

// ── Operation: check-run annotations ──────────────────────────────────────

async function opCheckAnnotations(invocation: ValidApiInvocation, requester: ApiRequester, deps?: ApiOperationDeps): Promise<ApiToolResult> {
	const repo = invocation.repo!;
	const checkRunId = invocation.checkRunId!;
	const summary = `gh_read api: check annotations ${repo}`;
	const metadata: Array<[string, string | number | boolean | null]> = [["repo", repo], ["check_run_id", checkRunId]];

	// Exactly one tool-authored GET; 404/403 outcomes pass through verbatim.
	const outcome = await requester.request(annotationsEndpoint(repo, checkRunId));
	if (!isResponse(outcome)) {
		return renderResult(summary, metadata, "", { isError: true, notices: [describeRequestFailure("annotations read", outcome)] });
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(outcome.body) as unknown;
	} catch {
		return renderResult(summary, metadata, "", { isError: true, notices: ["check annotations response was not valid JSON"] });
	}
	if (!Array.isArray(parsed)) {
		return renderResult(summary, metadata, "", { isError: true, notices: ["check annotations response was not a JSON array"] });
	}
	// Incompleteness is computed from the ORIGINAL response array BEFORE jq,
	// then carried through renderData, whose jq path preserves notices (and
	// renderResult renders them in the metadata head, which is always
	// complete even when the data block is display-truncated).
	const notices: string[] = [];
	if (parsed.length === PAGE_SIZE) {
		notices.push("only the first page was fetched; the listing may be incomplete");
	}
	return await renderData(invocation, summary, metadata, parsed, notices, false, requester, deps);
}

// ── Operation: repository metadata ────────────────────────────────────────

/**
 * One tool-authored GET of the flat REST repository object: no ref
 * resolution, no pagination, no Link parsing, no continuation, exactly ONE
 * request ever. The response passes through verbatim (viewer-specific
 * .permissions included and labeled in metadata, never rewritten).
 */
async function opRepoMetadata(invocation: ValidApiInvocation, requester: ApiRequester, deps?: ApiOperationDeps): Promise<ApiToolResult> {
	const repo = invocation.repo!;
	const summary = `gh_read api: repo metadata ${repo}`;
	const metadata: Array<[string, string | number | boolean | null]> = [
		["repo", repo],
		["endpoint", "repos (single object; no pagination)"],
		["viewer_specific", "permissions reflect the authenticated token"],
	];

	const outcome = await requester.request(`repos/${splitRepo(repo)[0]}/${splitRepo(repo)[1]}`);
	if (!isResponse(outcome)) {
		return renderResult(summary, metadata, "", { isError: true, notices: [describeRequestFailure("metadata read", outcome)] });
	}
	const body = parseJsonObject(outcome.body);
	if (typeof body === "string") {
		return renderResult(summary, metadata, "", { isError: true, notices: [body] });
	}
	return await renderData(invocation, summary, metadata, body, [], false, requester, deps);
}

// ── Entry point ──────────────────────────────────────────────────────────────

export async function runApiOperation(
	invocation: ValidApiInvocation,
	cwd: string,
	signal: AbortSignal | undefined,
	deps?: ApiOperationDeps,
): Promise<ApiToolResult> {
	const clock = deps?.clock ?? defaultClock;
	const requester = deps?.requester ?? new GhApiRunner({ cwd, clock, signal });
	return await dispatchOperation(invocation, requester, deps);
}

async function dispatchOperation(
	invocation: ValidApiInvocation,
	requester: ApiRequester,
	deps?: ApiOperationDeps,
): Promise<ApiToolResult> {
	switch (invocation.op) {
		case "repo contents":
			return await opRepoContents(invocation, requester, deps);
		case "repo tree":
			return await opRepoTree(invocation, requester, deps);
		case "commit checks":
			return await opCommitChecks(invocation, requester, deps);
		case "advisory view":
			return await opAdvisoryView(invocation, requester, deps);
		case "check annotations":
			return await opCheckAnnotations(invocation, requester, deps);
		case "repo metadata":
			return await opRepoMetadata(invocation, requester, deps);
		case "pr comments":
		case "pr reviews":
		case "issue comments":
			return await opDiscussionRead(invocation, requester, deps);
	}
}
