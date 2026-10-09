/**
 * git-read child-process layer (scaffold stub).
 *
 * Step 3 fills this in per docs/git-read-design.md: sanitized environment,
 * worktree toplevel check, async spawn (argv-array, no shell) with continuous
 * drain, byte-capped retention, timeout SIGTERM->SIGKILL escalation.
 */

/** Shared stdout+stderr cap in bytes; matches PER_TASK_OUTPUT_CAP (extensions/subagent/index.ts:42). */
export const OUTPUT_CAP = 50 * 1024;

export const TIMEOUT_MS = 15_000;

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

export interface GitRunResult {
	ok: boolean;
	text: string;
}

export async function runGit(_argv: readonly string[], _cwd: string): Promise<GitRunResult> {
	return { ok: false, text: "git_read spawn layer is not implemented yet (scaffold)" };
}
