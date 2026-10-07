/**
 * Configuration loading and validation for the update-jira extension.
 *
 * Config lives at <agentDir>/update-jira.json. The extension never creates or
 * writes the file. A missing file, malformed JSON, or any invalid field fails
 * closed: no remote calls happen until the configuration is fixed. Optional
 * fields get defaults only in memory.
 *
 * Pure module: no pi-runtime or filesystem imports. The caller reads the file
 * and hands the raw text to parseConfig().
 */

export const DEFAULT_BRANCH_KEY_REGEX = "\\b[A-Z][A-Z0-9]+-\\d+\\b";

/** Explicit ticket keys must match this exactly after trim + uppercase. */
export const TICKET_KEY_PATTERN = /^[A-Z][A-Z0-9]+-\d+$/;

export function normalizeKey(raw: string): string {
	return raw.trim().toUpperCase();
}

export function isValidKey(raw: string): boolean {
	return TICKET_KEY_PATTERN.test(raw);
}

export interface JiraConfig {
	/** Normalized site origin with a trailing slash, used as the MCP cloudId. */
	site: string;
	/** The siteUrl exactly as configured (before normalization). */
	siteUrl: string;
	branchKeyRegex: string;
	branchMappings: Record<string, string>;
}

export type ConfigResult =
	| { ok: true; config: JiraConfig }
	| { ok: false; reason: string };

const ALLOWED_KEYS = new Set(["siteUrl", "branchKeyRegex", "branchMappings"]);

/** Validate a site URL: explicit HTTPS origin, no credentials, path/query/fragment rejected. */
export function validateSiteUrl(raw: unknown): { ok: true; site: string } | { ok: false; reason: string } {
	if (typeof raw !== "string" || raw.trim() === "") {
		return { ok: false, reason: "siteUrl is required and must be a non-empty string" };
	}
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		return { ok: false, reason: `siteUrl is not a valid URL: ${raw.trim()}` };
	}
	if (url.protocol !== "https:") {
		return { ok: false, reason: "siteUrl must use https://" };
	}
	if (url.username !== "" || url.password !== "") {
		return { ok: false, reason: "siteUrl must not contain credentials" };
	}
	if (url.hostname === "") {
		return { ok: false, reason: "siteUrl must include a host" };
	}
	if (url.pathname !== "/" && url.pathname !== "") {
		return { ok: false, reason: `siteUrl must be a bare origin; paths are not supported (got pathname "${url.pathname}")` };
	}
	if (url.search !== "") {
		return { ok: false, reason: "siteUrl must not include a query string" };
	}
	if (url.hash !== "") {
		return { ok: false, reason: "siteUrl must not include a fragment" };
	}
	return { ok: true, site: `${url.origin}/` };
}

/** A regex pattern is rejected when it is invalid or matches empty input. */
export function validateRegexSource(raw: unknown): { ok: true; source: string } | { ok: false; reason: string } {
	if (raw === undefined || raw === null) {
		return { ok: true, source: DEFAULT_BRANCH_KEY_REGEX };
	}
	if (typeof raw !== "string" || raw === "") {
		return { ok: false, reason: "branchKeyRegex must be a non-empty string when provided" };
	}
	let re: RegExp;
	try {
		re = new RegExp(raw);
	} catch (err) {
		return { ok: false, reason: `branchKeyRegex is not a valid regular expression: ${err instanceof Error ? err.message : String(err)}` };
	}
	if (re.test("")) {
		return { ok: false, reason: "branchKeyRegex must not match empty input" };
	}
	return { ok: true, source: raw };
}

function validateMappingValue(branch: string, value: unknown): string | undefined {
	if (typeof value !== "string") {
		return `branchMappings.${branch} must be a string`;
	}
	const key = normalizeKey(value);
	if (!isValidKey(key)) {
		return `branchMappings.${branch} is not a valid ticket key: ${value}`;
	}
	return undefined;
}

export function parseConfig(raw: unknown): ConfigResult {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { ok: false, reason: "configuration must be a JSON object" };
	}
	const obj = raw as Record<string, unknown>;
	const unknownKeys = Object.keys(obj).filter((k) => !ALLOWED_KEYS.has(k));
	if (unknownKeys.length > 0) {
		return { ok: false, reason: `unknown configuration keys: ${unknownKeys.join(", ")}` };
	}
	const site = validateSiteUrl(obj.siteUrl);
	if (!site.ok) {
		return { ok: false, reason: site.reason };
	}
	const regex = validateRegexSource(obj.branchKeyRegex);
	if (!regex.ok) {
		return { ok: false, reason: regex.reason };
	}
	const mappings: Record<string, string> = {};
	const rawMappings = obj.branchMappings;
	if (rawMappings !== undefined && rawMappings !== null) {
		if (typeof rawMappings !== "object" || Array.isArray(rawMappings)) {
			return { ok: false, reason: "branchMappings must be an object mapping exact branch names to ticket keys" };
		}
		for (const [branch, value] of Object.entries(rawMappings as Record<string, unknown>)) {
			if (branch.trim() === "") {
				return { ok: false, reason: "branchMappings keys must be non-empty branch names" };
			}
			const problem = validateMappingValue(branch, value);
			if (problem) {
				return { ok: false, reason: problem };
			}
			mappings[branch] = normalizeKey(value as string);
		}
	}
	return {
		ok: true,
		config: {
			site: site.site,
			siteUrl: String(obj.siteUrl),
			branchKeyRegex: regex.source,
			branchMappings: mappings,
		},
	};
}

/** Parse the raw configuration file contents. */
export function parseConfigText(text: string): ConfigResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		return { ok: false, reason: `configuration is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
	}
	return parseConfig(parsed);
}

/**
 * Identity of an invalid configuration state, used to warn once per unchanged
 * state. Valid configurations have no identity (the caller resets suppression).
 */
export function configWarningId(result: ConfigResult): string | undefined {
	if (result.ok) return undefined;
	return result.reason;
}
