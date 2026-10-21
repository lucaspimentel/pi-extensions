/**
 * gh-read child-process layer.
 *
 * Implements the "Worktree enforcement", "Trust model for env and config",
 * and "Resource limits and failure contract" sections of
 * docs/gh-read-design.md: worktree toplevel gate, sanitized environment,
 * bounded exec via the shared core, and a result that never throws.
 *
 * Unlike git, gh has no repo-level config and no helper-execution vectors on
 * the allowlisted read subcommands; the trust surface is the inherited
 * environment plus the user-level gh config. GH_* token variables and the
 * default config dir are inherited untouched: auth is gh's own domain.
 *
 * This module never throws: every failure becomes a failed GhRunResult with
 * a `gh_read: `-prefixed message (index.ts wraps result.text verbatim and
 * does not add its prefix to spawn errors). API and auth errors pass through
 * verbatim; no error-shape matching, no hints. argv is consumed verbatim
 * from validate.ts; nothing is appended here.
 */

import { boundedExec, cwdInsideToplevel, TIMEOUT_MS } from "../shared/bounded-spawn.ts";
import { buildChildEnv } from "../git-read/spawn.ts";

// Re-exported so tests can import the whole child-process contract from here.
export { cwdInsideToplevel, TIMEOUT_MS };

/** Stripped from the inherited environment before spawn (design "Trust model"). */
export const STRIPPED_ENV = [
	"GH_HOST",
	"GH_REPO",
	"GH_CONFIG_DIR",
	"GH_DEBUG",
	"GH_FORCE_TTY",
	"GH_MDWIDTH",
	"GLAMOUR_STYLE",
	"GH_BROWSER",
	"BROWSER",
	"GH_EDITOR",
	"GIT_EDITOR",
	"VISUAL",
	"EDITOR",
	"GH_PATH",
	"GH_EXTENSION",
	"GH_TELEMETRY",
] as const;

/**
 * Environment values injected after stripping, so they win over anything
 * inherited: no interactive prompts (gh fails instead of hanging), no pager,
 * no update/extension-update notifiers, no color.
 */
export const INJECTED_ENV = {
	GH_PROMPT_DISABLED: "1",
	GH_PAGER: "cat",
	GH_NO_UPDATE_NOTIFIER: "1",
	GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
	NO_COLOR: "1",
} as const;

export interface GhRunResult {
	ok: boolean;
	text: string;
}

/**
 * Inherited environment minus STRIPPED_ENV, plus INJECTED_ENV assigned last
 * so the injected values always win. Everything else (PATH, HOME, GH_TOKEN,
 * GITHUB_TOKEN, GH_ENTERPRISE_TOKEN, locale) is inherited untouched.
 */
export function buildGhEnv(): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = { ...process.env };
	for (const key of STRIPPED_ENV) delete env[key];
	Object.assign(env, INJECTED_ENV);
	return env;
}

/**
 * Runs the worktree gate. gh infers the repository from the git remote of
 * the current repo, so the tool is defined only inside a worktree; the gate
 * applies to every invocation, even with explicit -R (settled: one simple
 * contract). The single exemption is "auth status", which needs no repo and
 * is skipped by runGh before this function is called. Uses git-read's
 * sanitized git environment for the rev-parse. Exported so the log runner
 * (log-spawn.ts) can reuse the identical gate.
 */
export async function worktreeCheckPassed(cwd: string): Promise<boolean> {
	const outcome = await boundedExec("git", ["rev-parse", "--show-toplevel"], buildChildEnv(), cwd);
	if (outcome.spawnError !== undefined || outcome.timedOut || outcome.code !== 0) return false;
	const toplevel = outcome.stdout.trim();
	if (toplevel.length === 0) return false;
	return cwdInsideToplevel(cwd, toplevel);
}

/**
 * True for the validated "auth status" argv: the only subcommand exempt from
 * the worktree gate. auth status reports login state for gh's known hosts and
 * needs no repository context, so it works anywhere (including a bare HOME).
 */
function isAuthStatusArgv(argv: readonly string[]): boolean {
	return argv[0] === "auth" && argv[1] === "status";
}

/**
 * Runs one validated gh argv in `cwd` under the design's sanitized
 * environment and resource limits. Composes the worktree gate, the bounded
 * exec core, and the failure contract into a result that never throws.
 * The worktree gate is skipped for "auth status" (see isAuthStatusArgv);
 * every other subcommand is gated.
 */
export async function runGh(argv: readonly string[], cwd: string): Promise<GhRunResult> {
	if (!isAuthStatusArgv(argv)) {
		const gatePassed = await worktreeCheckPassed(cwd);
		if (!gatePassed) {
			return { ok: false, text: "gh_read: not inside a git worktree" };
		}
	}

	const outcome = await boundedExec("gh", argv, buildGhEnv(), cwd);

	let text: string;
	if (outcome.spawnError !== undefined) {
		text = `gh_read: failed to run gh: ${outcome.spawnError}`;
	} else if (outcome.timedOut) {
		const collected = [outcome.stderr, outcome.stdout].filter((part) => part.length > 0).join("\n");
		text = `gh_read: gh timed out after ${TIMEOUT_MS} ms${collected.length > 0 ? `\n${collected}` : ""}`;
	} else if (outcome.code !== 0) {
		text = `gh_read: gh exited with code ${outcome.code}\n${outcome.stderr}${outcome.stdout}`;
	} else {
		text = outcome.stdout;
	}
	if (outcome.truncated) {
		text += `\n[gh_read: output truncated, showing ${outcome.retainedBytes} of ${outcome.totalBytes} bytes]`;
	}

	return { ok: outcome.code === 0 && outcome.spawnError === undefined && !outcome.timedOut, text };
}
