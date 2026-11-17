/**
 * Shared herdr surface.
 *
 * Three extensions talk to herdr (herdr-tab-name, herdr-fork-session, and
 * wt-tab-status) and each repeated the same marker test and JSON unwrap. This
 * module owns the binary name, the "am I inside herdr" gate, the workspace
 * selector, and the `{ result: … }` unwrap.
 *
 * The run seam deliberately stays with each caller: every extension has its
 * own test override (a `run` dependency or a module setter) and its own
 * failure convention, so only what they share lives here.
 *
 * Imports are node builtins only, so a plain test runner can type-strip it.
 */

/** The herdr executable; callers resolve it through PATH in their own runner. */
export const HERDR_BINARY = "herdr";

/** True when pi runs inside a herdr pane: HERDR_ENV is exactly "1". */
export function isHerdrSession(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.HERDR_ENV === "1";
}

/**
 * The workspace a new tab belongs in, or undefined when pi is not running
 * inside herdr (or herdr reported no workspace).
 */
export function herdrWorkspaceId(env: NodeJS.ProcessEnv = process.env): string | undefined {
	if (!isHerdrSession(env)) return undefined;
	return env.HERDR_WORKSPACE_ID || undefined;
}

/** The `result` object of a herdr JSON response, or undefined when unreadable. */
export function parseHerdrResult<T>(stdout: string): T | undefined {
	try {
		const parsed = JSON.parse(stdout) as { result?: unknown };
		const result = parsed?.result;
		return typeof result === "object" && result !== null ? (result as T) : undefined;
	} catch {
		return undefined;
	}
}
