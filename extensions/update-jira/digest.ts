/**
 * Digest extraction for jira_read action "get".
 *
 * The digest is a shaped summary (key, summary, status, assignee, capped
 * description, issue links) built from the explicit-field full view. It preserves the
 * actual content format and server warnings: a digest, especially a
 * truncated HTML one, is never a safe write-back source.
 *
 * Pure module.
 */

import { DIGEST_DESCRIPTION_CAP } from "./results.ts";

export interface IssueDigest {
	key: string;
	summary: string;
	status: string;
	assignee: string;
	description: string;
	descriptionTruncated: boolean;
	/** Issue links (fields.issuelinks), one entry per linked issue. */
	links: IssueLink[];
	appliedContentFormat?: string;
	warning?: string;
}

export interface IssueLink {
	/** Relationship as seen from this issue, e.g. "blocks" or "is blocked by". */
	relation: string;
	key: string;
	summary?: string;
	status?: string;
}

export type DigestResult = { ok: true; digest: IssueDigest } | { ok: false; message: string };

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/** Truncate a description to the digest cap, reporting whether it was cut. */
export function truncateDescription(text: string): { text: string; truncated: boolean } {
	if (text.length <= DIGEST_DESCRIPTION_CAP) {
		return { text, truncated: false };
	}
	return { text: text.slice(0, DIGEST_DESCRIPTION_CAP), truncated: true };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** Extract issue links from fields.issuelinks; malformed entries are skipped. */
export function extractIssueLinks(raw: unknown): IssueLink[] {
	if (!Array.isArray(raw)) return [];
	const links: IssueLink[] = [];
	for (const entry of raw) {
		const link = asRecord(entry);
		if (!link) continue;
		const type = asRecord(link.type);
		const outward = asRecord(link.outwardIssue);
		const inward = asRecord(link.inwardIssue);
		const other = outward ?? inward;
		const key = asString(other?.key);
		if (!other || !key) continue;
		const relation = (outward ? asString(type?.outward) : asString(type?.inward)) ?? asString(type?.name) ?? "relates to";
		const otherFields = asRecord(other.fields);
		links.push({
			relation,
			key,
			summary: asString(otherFields?.summary),
			status: asString(asRecord(otherFields?.status)?.name),
		});
	}
	return links;
}

export function buildIssueDigest(serverData: unknown): DigestResult {
	if (typeof serverData !== "object" || serverData === null) {
		return { ok: false, message: "the server response did not contain an issue data object" };
	}
	const data = serverData as Record<string, unknown>;
	const key = asString(data.key);
	if (!key) {
		return { ok: false, message: "the server response did not contain the issue key" };
	}
	const fields = (typeof data.fields === "object" && data.fields !== null ? data.fields : {}) as Record<string, unknown>;
	const summary = asString(fields.summary) ?? "(no summary)";
	const status = asString((fields.status as Record<string, unknown> | undefined)?.name) ?? "(unknown status)";
	const assigneeField = fields.assignee;
	let assignee: string;
	if (assigneeField === null || assigneeField === undefined) {
		assignee = "Unassigned";
	} else if (typeof assigneeField === "object") {
		const record = assigneeField as Record<string, unknown>;
		assignee = asString(record.displayName) ?? asString(record.name) ?? "(assignee without a display name)";
	} else {
		assignee = "(unexpected assignee shape)";
	}
	const rawDescription = asString(fields.description) ?? "";
	const truncated = truncateDescription(rawDescription);
	const digest: IssueDigest = {
		key,
		summary,
		status,
		assignee,
		description: truncated.text,
		descriptionTruncated: truncated.truncated,
		links: extractIssueLinks(fields.issuelinks),
		appliedContentFormat: asString(data.appliedContentFormat),
		warning: asString(data.warning),
	};
	return { ok: true, digest };
}

/**
 * Render the digest as bounded model-facing text. A truncated description and
 * an HTML applied format both carry explicit guidance; a digest is never
 * described as a safe write-back source.
 */
export function renderDigestText(digest: IssueDigest): string {
	const lines = [
		`${digest.key} (content format: ${digest.appliedContentFormat ?? "unknown"})`,
		`Summary: ${digest.summary}`,
		`Status: ${digest.status}`,
		`Assignee: ${digest.assignee}`,
	];
	if (digest.description === "") {
		lines.push("Description: (empty)");
	} else {
		lines.push(`Description: ${digest.description}`);
	}
	if (digest.links.length > 0) {
		lines.push("Links:");
		for (const link of digest.links) {
			const detail = [link.summary, link.status ? `[${link.status}]` : undefined].filter(Boolean).join(" ");
			lines.push(`- ${link.relation} ${link.key}${detail ? `: ${detail}` : ""}`);
		}
	}
	if (digest.descriptionTruncated) {
		lines.push(`[description truncated at ${DIGEST_DESCRIPTION_CAP} characters; call jira_read with action "get" and raw: true for the complete description]`);
	}
	if (digest.appliedContentFormat === "html") {
		lines.push('[the server returned this body as HTML; do not write a digest back verbatim: a digest, especially truncated HTML, is not a safe write-back source. Read with raw: true and preserve the actual format.]');
	}
	if (digest.warning) {
		lines.push(`Server warning: ${digest.warning}`);
	}
	return lines.join("\n");
}
