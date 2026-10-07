/**
 * Git branch detection, ticket-key normalization, and regex/mapping target
 * resolution for the update-jira extension. Also hosts the local subprocess
 * helpers (git, gh) shared by the tools.
 *
 * Pure module: no pi-runtime imports. The subprocess runner is injected so
 * tests stay offline and deterministic.
 */

import { isValidKey, normalizeKey, type JiraConfig } from "./config.ts";

export interface SubprocessResult {
	/** Exit code, or null when the process could not be spawned. */
	code: number | null;
	stdout: string;
	stderr: string;
	/** Spawn failure text (e.g. ENOENT), when the process never ran. */
	error?: string;
}

export type SubprocessRunner = (
	command: string,
	args: string[],
	cwd: string,
	signal?: AbortSignal,
) => Promise<SubprocessResult>;

export type TargetResolution =
	| { ok: true; key: string; source: "explicit" | "regex" | "mapping"; branch?: string }
	| {
			ok: false;
			kind: "invalid_key" | "ambiguous_key" | "no_ticket" | "config_invalid" | "subprocess_failed";
			message: string;
			candidates?: string[];
	  };

/** Detect the git branch in cwd. branch === null means detached HEAD / no branch. */
export async function detectGitBranch(
	run: SubprocessRunner,
	cwd: string,
	signal?: AbortSignal,
): Promise<{ ok: true; branch: string | null } | { ok: false; message: string; stderr?: string }> {
	const result = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], cwd, signal);
	if (result.code !== 0) {
		const detail = (result.error ?? result.stderr ?? "").trim();
		return { ok: false, message: `git rev-parse failed in ${cwd}${detail ? `: ${detail}` : ""}`, stderr: detail };
	}
	const branch = result.stdout.trim();
	if (branch === "" || branch === "HEAD") {
		return { ok: true, branch: null };
	}
	return { ok: true, branch };
}

export interface ExtractResult {
	ok: true;
	keys: string[];
}

/**
 * Extract ticket keys from a branch with the configured regex. Whole matches
 * only (capture groups ignored), case-insensitive, deduplicated after
 * normalization. A zero-length match is a configuration failure, not a key.
 */
export function extractBranchKeys(
	branch: string,
	regexSource: string,
): ExtractResult | { ok: false; kind: "config_invalid"; message: string } {
	let re: RegExp;
	try {
		re = new RegExp(regexSource, "gi");
	} catch (err) {
		return { ok: false, kind: "config_invalid", message: `branchKeyRegex is not a valid regular expression: ${err instanceof Error ? err.message : String(err)}` };
	}
	const keys: string[] = [];
	for (const match of branch.matchAll(re)) {
		if (match[0].length === 0) {
			return { ok: false, kind: "config_invalid", message: `branchKeyRegex produced a zero-length match while scanning "${branch}"` };
		}
		const key = normalizeKey(match[0]);
		if (!isValidKey(key)) continue;
		if (!keys.includes(key)) keys.push(key);
	}
	return { ok: true, keys };
}

/**
 * Resolve the target from an already-detected branch (pure). branch === null
 * means detached HEAD / no branch. Explicit keys bypass this entirely.
 */
export function resolveBranchTarget(config: JiraConfig, branch: string | null): TargetResolution {
	if (branch === null) {
		return { ok: false, kind: "no_ticket", message: "no git branch is checked out (detached HEAD), so no default ticket can be detected" };
	}
	const extracted = extractBranchKeys(branch, config.branchKeyRegex);
	if (!extracted.ok) {
		return { ok: false, kind: extracted.kind, message: extracted.message };
	}
	if (extracted.keys.length > 1) {
		return { ok: false, kind: "ambiguous_key", message: `branch "${branch}" contains multiple distinct ticket keys`, candidates: extracted.keys };
	}
	if (extracted.keys.length === 1) {
		return { ok: true, key: extracted.keys[0], source: "regex", branch };
	}
	const mapped = config.branchMappings[branch];
	if (mapped === undefined) {
		return { ok: false, kind: "no_ticket", message: `no ticket key was found in branch "${branch}" and no exact branch mapping matches it` };
	}
	// Mapping targets are validated when config loads; normalize defensively.
	const key = normalizeKey(mapped);
	if (!isValidKey(key)) {
		return { ok: false, kind: "config_invalid", message: `branchMappings.${branch} is not a valid ticket key: ${mapped}` };
	}
	return { ok: true, key, source: "mapping", branch };
}

/**
 * Resolve the ticket target for one call. An explicit key bypasses Git but
 * nothing bypasses config validation (the caller validates config first).
 */
export async function resolveTarget(options: {
	config: JiraConfig;
	ticketKey?: string;
	cwd: string;
	run: SubprocessRunner;
	signal?: AbortSignal;
}): Promise<TargetResolution> {
	const { config, ticketKey, cwd, run, signal } = options;
	if (ticketKey !== undefined) {
		const key = normalizeKey(ticketKey);
		if (!isValidKey(key)) {
			return { ok: false, kind: "invalid_key", message: `ticketKey "${ticketKey}" does not match the expected ticket key shape (e.g. PROJ-123)` };
		}
		return { ok: true, key, source: "explicit" };
	}
	const detected = await detectGitBranch(run, cwd, signal);
	if (!detected.ok) {
		return { ok: false, kind: "subprocess_failed", message: detected.message };
	}
	return resolveBranchTarget(config, detected.branch);
}

export interface PullRequestInfo {
	url: string;
	title?: string;
}

/**
 * Resolve the current PR through `gh pr view --json url,title` in cwd.
 * Failures and malformed results are rejected before any mutation.
 */
export async function resolvePullRequest(
	run: SubprocessRunner,
	cwd: string,
	signal?: AbortSignal,
): Promise<{ ok: true; pr: PullRequestInfo } | { ok: false; kind: "subprocess_failed" | "invalid_response"; message: string }> {
	const result = await run("gh", ["pr", "view", "--json", "url,title"], cwd, signal);
	if (result.code !== 0) {
		const detail = (result.error ?? result.stderr ?? "").trim();
		return { ok: false, kind: "subprocess_failed", message: `gh pr view failed in ${cwd}${detail ? `: ${detail}` : ""}` };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(result.stdout);
	} catch (err) {
		return { ok: false, kind: "invalid_response", message: `gh pr view returned unparseable output: ${err instanceof Error ? err.message : String(err)}` };
	}
	if (typeof parsed !== "object" || parsed === null) {
		return { ok: false, kind: "invalid_response", message: "gh pr view output is not a JSON object" };
	}
	const url = (parsed as { url?: unknown }).url;
	if (typeof url !== "string" || !url.startsWith("https://")) {
		return { ok: false, kind: "invalid_response", message: "gh pr view output does not contain an https url" };
	}
	const title = (parsed as { title?: unknown }).title;
	return { ok: true, pr: { url, title: typeof title === "string" && title !== "" ? title : undefined } };
}

/** Validate a caller-supplied remote-link URL: credential-free HTTPS web URL. */
export function validateRemoteLinkUrl(raw: string): { ok: true } | { ok: false; reason: string } {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return { ok: false, reason: `not a valid URL: ${raw}` };
	}
	if (url.protocol !== "https:") {
		return { ok: false, reason: "only https:// URLs are accepted" };
	}
	if (url.username !== "" || url.password !== "") {
		return { ok: false, reason: "URLs with embedded credentials are not accepted" };
	}
	if (url.hostname === "") {
		return { ok: false, reason: "URL has no host" };
	}
	return { ok: true };
}
