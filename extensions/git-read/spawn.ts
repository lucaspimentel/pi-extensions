/**
 * git-read child-process layer.
 *
 * Implements the "Worktree enforcement", "Trust model for config, env, and
 * helpers", and "Resource limits and failure contract" sections of
 * docs/git-read-design.md: sanitized environment, worktree toplevel check,
 * async spawn (argv-array, no shell) with continuous drain, byte-capped
 * retention, timeout SIGTERM->SIGKILL escalation, and reaping before return.
 *
 * The bounded-exec mechanics (drain, cap, timeout, reaping, test seam, and
 * the worktree path comparison) live in extensions/shared/bounded-spawn.ts
 * and are shared with gh-read. This module keeps git-specific pieces: the
 * sanitized git environment, the rev-parse gate, and the failure contract.
 *
 * This module never throws: every failure becomes a failed GitRunResult with
 * a `git_read: `-prefixed message (index.ts wraps result.text verbatim and
 * does not add its prefix to spawn errors). argv is consumed verbatim from
 * validate.ts; nothing is appended here.
 */

import { GLOBAL_OPTIONS } from "./validate.ts";
import {
	boundedExec,
	cwdInsideToplevel,
	KILL_ESCALATION_MS,
	OUTPUT_CAP,
	setSpawnOverride,
	TIMEOUT_MS,
} from "../shared/bounded-spawn.ts";

// Re-exported so existing imports from this module (tests) keep resolving.
export { cwdInsideToplevel, KILL_ESCALATION_MS, OUTPUT_CAP, setSpawnOverride, TIMEOUT_MS };

/** Stripped from the inherited environment before spawn. */
export const STRIPPED_ENV = [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_COMMON_DIR",
	"GIT_NAMESPACE",
	"GIT_CONFIG_COUNT",
	"GIT_EXTERNAL_DIFF",
] as const;

/**
 * Environment values injected after stripping, so they win over anything
 * inherited. Per the design's trust model: no pager, no prompts, no askpass
 * helpers, and system/global git configs nulled (repo config still applies;
 * the -c overrides from GLOBAL_OPTIONS win over it).
 */
export const INJECTED_ENV = {
	GIT_PAGER: "cat",
	GIT_TERMINAL_PROMPT: "0",
	GIT_ASKPASS: "echo",
	GIT_CONFIG_SYSTEM: "/dev/null",
	GIT_CONFIG_GLOBAL: "/dev/null",
} as const;

export interface GitRunResult {
	ok: boolean;
	text: string;
}

/**
 * Inherited environment minus STRIPPED_ENV, plus INJECTED_ENV assigned last
 * so the injected values always win. Everything else (PATH, HOME, locale) is
 * inherited untouched.
 */
export function buildChildEnv(): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = { ...process.env };
	for (const key of STRIPPED_ENV) delete env[key];
	Object.assign(env, INJECTED_ENV);
	return env;
}

/** Runs the read command's worktree gate; the design's single failure message. */
async function worktreeCheckPassed(cwd: string): Promise<boolean> {
	const outcome = await boundedExec("git", [...GLOBAL_OPTIONS, "rev-parse", "--show-toplevel"], buildChildEnv(), cwd);
	if (outcome.spawnError !== undefined || outcome.timedOut || outcome.code !== 0) return false;
	const toplevel = outcome.stdout.trim();
	if (toplevel.length === 0) return false;
	return cwdInsideToplevel(cwd, toplevel);
}

/**
 * Runs one validated git argv in `cwd` under the design's sanitized
 * environment and resource limits. Composes the worktree gate, the bounded
 * exec core, and the failure contract into a result that never throws.
 */
export async function runGit(argv: readonly string[], cwd: string): Promise<GitRunResult> {
	const gatePassed = await worktreeCheckPassed(cwd);
	if (!gatePassed) {
		return { ok: false, text: "git_read: not inside a git worktree" };
	}

	const outcome = await boundedExec("git", argv, buildChildEnv(), cwd);

	let text: string;
	if (outcome.spawnError !== undefined) {
		text = `git_read: failed to run git: ${outcome.spawnError}`;
	} else if (outcome.timedOut) {
		const collected = [outcome.stderr, outcome.stdout].filter((part) => part.length > 0).join("\n");
		text = `git_read: git timed out after ${TIMEOUT_MS} ms${collected.length > 0 ? `\n${collected}` : ""}`;
	} else if (outcome.code !== 0) {
		text = `git_read: git exited with code ${outcome.code}\n${outcome.stderr}${outcome.stdout}`;
	} else {
		text = outcome.stdout;
	}
	if (outcome.truncated) {
		text += `\n[git_read: output truncated, showing ${outcome.retainedBytes} of ${outcome.totalBytes} bytes]`;
	}

	return { ok: outcome.code === 0 && outcome.spawnError === undefined && !outcome.timedOut, text };
}
