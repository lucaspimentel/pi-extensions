/**
 * herdr-fork-session
 *
 * `/herdr-fork-session [branch]` plans a piece of work in an isolated git
 * worktree and, when running inside herdr, opens a new unfocused tab whose
 * root pane runs a pi session forked from the current one with
 * `pi --fork <file|id>`.
 *
 * Behavior:
 *   - The worktree is created as a sibling of the main clone, named
 *     `<main-clone>--<branch with slashes replaced by dashes>`, on a new
 *     branch starting at either the current checkout's HEAD or the main
 *     clone's HEAD (chosen in a dialog when they differ).
 *   - The command never installs dependencies in the new worktree, never
 *     passes a project-trust flag to the forked pi, and never sends input
 *     to, or answers dialogs in, the forked session. It only creates and
 *     reports.
 *   - The caller's HERDR_TAB_ID / HERDR_PANE_ID are never touched.
 *   - Outside herdr (HERDR_ENV != "1" or no HERDR_WORKSPACE_ID) the worktree
 *     is created and the user is told how to start the forked session.
 *   - Every child process is an argv-array `execFile` call; nothing ever
 *     goes through a shell.
 *
 * Registration is unconditional; the herdr env is read inside the command
 * handler so the behavior is testable via process.env mutation.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export const COMMAND_NAME = "herdr-fork-session";
export const CUSTOM_TYPE = "herdr-fork-session";

/** herdr agent names must match [a-z][a-z0-9_-]{0,31}. */
export const AGENT_NAME_MAX = 32;

/** Readiness budget for `herdr agent start`; herdr's 30 s default is short for a fork. */
export const AGENT_START_TIMEOUT_MS = 120_000;

/** Hard timeout for any single child process. */
export const EXEC_TIMEOUT_MS = 180_000;

/** Longest slug derived from a session name. */
export const SLUG_MAX = 40;

export const USAGE =
	"/herdr-fork-session [branch] - create a git worktree and open a forked pi session in a new herdr tab";

// ── Exec seam ────────────────────────────────────────────────────────────────

export interface ExecResult {
	/** Exit code, or null when the process could not be spawned. */
	code: number | null;
	stdout: string;
	stderr: string;
	/** Spawn failure text (e.g. ENOENT), when the process never ran. */
	error?: string;
}

export type ExecRunner = (command: string, args: string[], cwd: string) => Promise<ExecResult>;

let runnerOverride: ExecRunner | null = null;

/** Test seam: replace the execFile-based runner with a recorded stub. */
export function setExecOverride(fn: ExecRunner | null): void {
	runnerOverride = fn;
}

/** Cancellable, argument-array subprocess execution without a shell. */
const defaultExec: ExecRunner = (command, args, cwd) =>
	new Promise((resolve) => {
		execFile(
			command,
			args,
			{ cwd, windowsHide: true, timeout: EXEC_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
			(error, stdout, stderr) => {
				const code = error ? (typeof error.code === "number" ? error.code : null) : 0;
				const failure =
					error && typeof error.code !== "number" ? error.message : undefined;
				resolve({
					code,
					stdout: String(stdout ?? ""),
					stderr: String(stderr ?? ""),
					error: failure,
				});
			},
		);
	});

/** First non-empty line of a multi-line command output. */
const firstNonEmptyLine = (text: string): string =>
	text.split(/\r?\n/).find((line) => line.trim() !== "")?.trim() ?? "";

/** Human-readable failure text: stderr, else spawn error, else a fallback. */
const failureText = (result: ExecResult, fallback: string): string =>
	firstNonEmptyLine(result.stderr) || (result.error ?? "").trim() || fallback;

// ── Pure helpers ─────────────────────────────────────────────────────────────

/** Parse the command argument: at most one whitespace-separated branch name. */
export function parseBranchArg(
	args: string,
): { ok: true; branch: string | undefined } | { ok: false; message: string } {
	const trimmed = args.trim();
	if (trimmed === "") return { ok: true, branch: undefined };
	const tokens = trimmed.split(/\s+/);
	if (tokens.length > 1) {
		return { ok: false, message: `expected a single branch name, got ${tokens.length} arguments` };
	}
	const branch = tokens[0];
	if (branch.startsWith("-")) {
		return { ok: false, message: `branch names must not start with "-": ${branch}` };
	}
	return { ok: true, branch };
}

/** Derive a branch slug from a session name; empty when there is no usable name. */
export function slugFromSessionName(name: string | undefined): string {
	if (!name) return "";
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, SLUG_MAX)
		.replace(/-+$/g, "");
}

/** Only substitution applied to a branch for paths, labels, and agent names. */
export const sanitizeBranch = (branch: string): string => branch.replace(/\/+/g, "-");

/** Sibling worktree path for a branch under the main clone. */
export const worktreePath = (mainCloneDir: string, branch: string): string =>
	join(dirname(mainCloneDir), `${basename(mainCloneDir)}--${sanitizeBranch(branch)}`);

/** herdr agent name derived from a branch: lowercase, leading letter, max 32 chars. */
export function toAgentName(branch: string): string {
	let name = branch
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/-{2,}/g, "-");
	const firstLetter = name.search(/[a-z]/);
	if (firstLetter === -1) return "fork";
	name = name.slice(firstLetter).slice(0, AGENT_NAME_MAX).replace(/-+$/g, "");
	return name === "" ? "fork" : name;
}

/** First free agent name: the base, else base-2, base-3, ... within the length cap. */
export function uniqueAgentName(base: string, taken: ReadonlySet<string>): string {
	if (!taken.has(base)) return base;
	for (let index = 2; ; index++) {
		const suffix = `-${index}`;
		const head = base
			.slice(0, Math.max(0, AGENT_NAME_MAX - suffix.length))
			.replace(/-+$/g, "");
		const candidate = `${head}${suffix}`;
		if (!taken.has(candidate)) return candidate;
	}
}

// ── Runner-taking helpers ────────────────────────────────────────────────────

type Fail = { ok: false; message: string };

export interface Head {
	sha: string;
	ref: string;
	shortSha: string;
	subject: string;
}

/** Resolve the main clone directory from the git common dir in cwd. */
export async function resolveMainClone(
	run: ExecRunner,
	cwd: string,
): Promise<{ ok: true; mainDir: string } | Fail> {
	const result = await run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd);
	if (result.code !== 0) {
		return { ok: false, message: failureText(result, "git rev-parse --git-common-dir failed") };
	}
	const commonDir = result.stdout.trim();
	if (commonDir === "") return { ok: false, message: "git rev-parse returned no common directory" };
	// A normal clone and a linked worktree both report <root>/.git, so the
	// common dir's parent is the main clone. A bare repository reports the
	// repository itself and a submodule reports <superproject>/.git/modules/<name>,
	// so dirname would name something that is not a clone.
	if (basename(commonDir) === ".git") return { ok: true, mainDir: dirname(commonDir) };
	const top = await run("git", ["rev-parse", "--show-toplevel"], cwd);
	if (top.code !== 0) {
		return {
			ok: false,
			message: `the git common dir ${commonDir} is a bare repository with no working tree`,
		};
	}
	const topLevel = top.stdout.trim();
	if (topLevel === "") return { ok: false, message: "git rev-parse --show-toplevel returned no directory" };
	return { ok: true, mainDir: topLevel };
}

/** Read HEAD's sha, display ref, short sha, and subject in a directory. */
export async function readHead(run: ExecRunner, dir: string): Promise<({ ok: true } & Head) | Fail> {
	const shaResult = await run("git", ["rev-parse", "HEAD"], dir);
	if (shaResult.code !== 0) {
		return { ok: false, message: failureText(shaResult, `git rev-parse HEAD failed in ${dir}`) };
	}
	const refResult = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], dir);
	if (refResult.code !== 0) {
		return { ok: false, message: failureText(refResult, `git rev-parse --abbrev-ref HEAD failed in ${dir}`) };
	}
	const shortResult = await run("git", ["rev-parse", "--short", "HEAD"], dir);
	if (shortResult.code !== 0) {
		return { ok: false, message: failureText(shortResult, `git rev-parse --short HEAD failed in ${dir}`) };
	}
	const logResult = await run("git", ["log", "-1", "--format=%s"], dir);
	if (logResult.code !== 0) {
		return { ok: false, message: failureText(logResult, `git log failed in ${dir}`) };
	}
	const rawRef = refResult.stdout.trim();
	return {
		ok: true,
		sha: shaResult.stdout.trim(),
		ref: rawRef === "" || rawRef === "HEAD" ? "(detached)" : rawRef,
		shortSha: shortResult.stdout.trim(),
		subject: logResult.stdout.trim(),
	};
}

/** Validate a branch name with git's own rules. */
export async function checkBranch(
	run: ExecRunner,
	cwd: string,
	branch: string,
): Promise<{ ok: true } | Fail> {
	const result = await run("git", ["check-ref-format", "--branch", branch], cwd);
	if (result.code !== 0) {
		return { ok: false, message: failureText(result, `invalid branch name: ${branch}`) };
	}
	return { ok: true };
}

/** True when a local branch with this exact name exists. */
export async function branchExists(run: ExecRunner, dir: string, branch: string): Promise<boolean> {
	const result = await run("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], dir);
	return result.code === 0;
}

/** Best-effort: the worktree path currently checked out on a local branch. */
export interface WorktreeMatch {
	/** Path git recorded for the matching block, when it has a "worktree" line. */
	path: string | undefined;
	/** True when git marked the entry "prunable": the checkout is gone. */
	prunable: boolean;
}

export async function worktreeForBranch(
	run: ExecRunner,
	dir: string,
	branch: string,
): Promise<WorktreeMatch | undefined> {
	const result = await run("git", ["worktree", "list", "--porcelain"], dir);
	if (result.code !== 0) return undefined;
	const blocks = result.stdout.replace(/\r\n/g, "\n").split(/\n\s*\n/);
	for (const block of blocks) {
		let path: string | undefined;
		let prunable = false;
		let matches = false;
		for (const line of block.split("\n")) {
			if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
			else if (line === `branch refs/heads/${branch}`) matches = true;
			else if (line === "prunable" || line.startsWith("prunable ")) prunable = true;
		}
		if (matches) return { path, prunable };
	}
	return undefined;
}

/** Existing herdr agent names from "herdr agent list"; unnamed agents carry no name. */
export async function herdrAgentNames(run: ExecRunner, cwd: string): Promise<string[]> {
	const result = await run("herdr", ["agent", "list"], cwd);
	if (result.code !== 0) return [];
	try {
		const parsed = JSON.parse(result.stdout) as { result?: { agents?: unknown } };
		const agents = parsed.result?.agents;
		if (!Array.isArray(agents)) return [];
		const names: string[] = [];
		for (const agent of agents) {
			const name = (agent as { name?: unknown } | null)?.name;
			if (typeof name === "string" && name !== "") names.push(name);
		}
		return names;
	} catch {
		return [];
	}
}

/** Create an unfocused herdr tab rooted at the worktree. */
export async function herdrTabCreate(
	run: ExecRunner,
	cwd: string,
	workspaceId: string,
	worktree: string,
	label: string,
): Promise<{ ok: true; tabId: string; paneId: string } | Fail> {
	const result = await run(
		"herdr",
		["tab", "create", "--workspace", workspaceId, "--cwd", worktree, "--label", label, "--no-focus"],
		cwd,
	);
	if (result.code !== 0) {
		return { ok: false, message: failureText(result, "herdr tab create failed") };
	}
	try {
		const parsed = JSON.parse(result.stdout) as {
			result?: { tab?: { tab_id?: unknown }; root_pane?: { pane_id?: unknown } };
		};
		const tabId = parsed.result?.tab?.tab_id;
		const paneId = parsed.result?.root_pane?.pane_id;
		if (typeof tabId !== "string" || typeof paneId !== "string") {
			return { ok: false, message: "herdr tab create returned an unexpected response" };
		}
		return { ok: true, tabId, paneId };
	} catch {
		return { ok: false, message: "herdr tab create returned an unexpected response" };
	}
}

/** Start a pi agent in the tab's root pane, forked from the current session. */
export async function herdrAgentStart(
	run: ExecRunner,
	cwd: string,
	agentName: string,
	paneId: string,
	forkRef: string,
): Promise<{ ok: true } | Fail> {
	const result = await run(
		"herdr",
		[
			"agent",
			"start",
			agentName,
			"--kind",
			"pi",
			"--pane",
			paneId,
			"--timeout",
			String(AGENT_START_TIMEOUT_MS),
			"--",
			"--fork",
			forkRef,
		],
		cwd,
	);
	if (result.code !== 0) {
		return { ok: false, message: failureText(result, "herdr agent start failed") };
	}
	return { ok: true };
}

// ── Reporting ────────────────────────────────────────────────────────────────

export type Outcome =
	| "ok"
	| "worktree-only"
	| "tab-failed"
	| "refused-collision"
	| "refused"
	| "failed";

interface ReportFields {
	branch?: string;
	path?: string;
	base?: string;
	baseSha?: string;
	label?: string;
	agentName?: string;
	tabId?: string;
	paneId?: string;
	sessionFile?: string;
	error?: string;
}

/** Outcomes whose line is also delivered to the model as a next-turn message. */
const MESSAGED_OUTCOMES: ReadonlySet<Outcome> = new Set([
	"ok",
	"worktree-only",
	"tab-failed",
	"refused-collision",
]);

/** Notify the user, record a session entry, and message the model when applicable. */
function report(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	outcome: Outcome,
	line: string,
	fields: ReportFields,
	notifyType: "info" | "warning" | "error",
): void {
	ctx.ui.notify(line, notifyType);
	pi.appendEntry(CUSTOM_TYPE, {
		outcome,
		branch: fields.branch,
		path: fields.path,
		base: fields.base,
		baseSha: fields.baseSha,
		label: fields.label,
		agentName: fields.agentName,
		tabId: fields.tabId,
		paneId: fields.paneId,
		sessionFile: fields.sessionFile,
		error: fields.error,
	});
	if (MESSAGED_OUTCOMES.has(outcome)) {
		pi.sendMessage(
			{ customType: CUSTOM_TYPE, content: line, display: true },
			{ deliverAs: "nextTurn", triggerTurn: false },
		);
	}
}

// ── Command ──────────────────────────────────────────────────────────────────

export default function herdrForkSessionExtension(pi: ExtensionAPI): void {
	pi.registerCommand(COMMAND_NAME, {
		description: USAGE,
		handler: async (args, ctx) => {
			const run = runnerOverride ?? defaultExec;

			if (!ctx.hasUI) {
				report(
					pi,
					ctx,
					"refused",
					`${USAGE}. This command needs an interactive confirmation; nothing was created and the existing checkouts are left untouched.`,
					{ error: "no interactive UI" },
					"warning",
				);
				return;
			}

			const parsed = parseBranchArg(args);
			if (!parsed.ok) {
				report(
					pi,
					ctx,
					"refused",
					`${USAGE}. ${parsed.message}. Nothing was created; existing checkouts are left untouched.`,
					{ error: parsed.message },
					"warning",
				);
				return;
			}

			const cwd = ctx.sessionManager.getCwd();

			const main = await resolveMainClone(run, cwd);
			if (!main.ok) {
				report(
					pi,
					ctx,
					"refused",
					`Not a git repository: ${main.message}. Nothing was created; existing checkouts are left untouched.`,
					{ error: main.message },
					"warning",
				);
				return;
			}
			const mainDir = main.mainDir;

			const branch = parsed.branch ?? slugFromSessionName(ctx.sessionManager.getSessionName());
			if (branch === "") {
				report(
					pi,
					ctx,
					"refused",
					`${USAGE}. This session has no name; pass a branch. Nothing was created; existing checkouts are left untouched.`,
					{ error: "no branch" },
					"warning",
				);
				return;
			}

			const checked = await checkBranch(run, cwd, branch);
			if (!checked.ok) {
				report(
					pi,
					ctx,
					"refused",
					`Cannot use "${branch}" as a branch name: ${checked.message}. Nothing was created; existing checkouts are left untouched.`,
					{ branch, error: checked.message },
					"warning",
				);
				return;
			}

			const sessionHead = await readHead(run, cwd);
			if (!sessionHead.ok) {
				report(
					pi,
					ctx,
					"refused",
					`Cannot read HEAD in ${cwd}: ${sessionHead.message}. Nothing was created; existing checkouts are left untouched.`,
					{ branch, error: sessionHead.message },
					"warning",
				);
				return;
			}
			let mainHead: Head = sessionHead;
			if (cwd !== mainDir) {
				const fetched = await readHead(run, mainDir);
				if (!fetched.ok) {
					report(
						pi,
						ctx,
						"refused",
						`Cannot read HEAD in ${mainDir}: ${fetched.message}. Nothing was created; existing checkouts are left untouched.`,
						{ branch, error: fetched.message },
						"warning",
					);
					return;
				}
				mainHead = fetched;
			}

			const path = worktreePath(mainDir, branch);
			const label = sanitizeBranch(branch);
			const inHerdr = process.env.HERDR_ENV === "1" && !!process.env.HERDR_WORKSPACE_ID;
			const taken = new Set<string>(inHerdr ? await herdrAgentNames(run, cwd) : []);
			const agentName = uniqueAgentName(toAgentName(branch), taken);
			const sessionFile = ctx.sessionManager.getSessionFile();

			const pathExists = existsSync(path);
			let branchPresent = false;
			let existingPath: string | undefined;
			let staleWorktree = false;
			if (!pathExists) {
				branchPresent = await branchExists(run, mainDir, branch);
				if (branchPresent) {
					const match = await worktreeForBranch(run, mainDir, branch);
					if (match?.path && !match.prunable && existsSync(match.path)) existingPath = match.path;
					else if (match) staleWorktree = true;
				}
			}
			if (pathExists || branchPresent) {
				const parts: string[] = [];
				if (pathExists) parts.push(`the worktree path ${path} already exists`);
				if (branchPresent) {
					parts.push(
						existingPath
							? `branch ${branch} is already checked out at ${existingPath}`
							: `branch ${branch} already exists`,
					);
				}
				let line = `refused-collision: Nothing was created: ${parts.join("; ")}. The existing checkout is left untouched.`;
				if (existingPath) {
					line += ` Reuse it with: cd ${existingPath}`;
				} else if (staleWorktree) {
					line += ` Its worktree is gone or prunable; clear the stale registration with: git worktree prune, then retry.`;
				}
				report(
					pi,
					ctx,
					"refused-collision",
					line,
					{ branch, path, label, agentName, sessionFile },
					"warning",
				);
				return;
			}

			const formatHead = (head: Head): string => `${head.ref} ${head.shortSha} ${head.subject}`.trim();
			const planSummary = `Create worktree ${path} on branch ${branch} based on ${formatHead(sessionHead)} (label ${label}, agent ${agentName}); the current checkout is left untouched.`;

			let base: Head;
			if (sessionHead.sha === mainHead.sha) {
				const confirmed = await ctx.ui.confirm("/herdr-fork-session", planSummary);
				if (!confirmed) {
					ctx.ui.notify("herdr-fork-session cancelled; nothing was created.", "info");
					return;
				}
				base = sessionHead;
			} else {
				const options = [formatHead(sessionHead), formatHead(mainHead)];
				const choice = await ctx.ui.select(planSummary, options);
				if (choice === undefined) {
					ctx.ui.notify("herdr-fork-session cancelled; nothing was created.", "info");
					return;
				}
				base = choice === options[0] ? sessionHead : mainHead;
			}
			const baseLabel = formatHead(base);

			const added = await run("git", ["worktree", "add", "-b", branch, path, base.sha], cwd);
			if (added.code !== 0) {
				const detail = failureText(added, "git worktree add failed");
				report(
					pi,
					ctx,
					"failed",
					`git worktree add failed: ${detail}. Nothing was created; existing checkouts are left untouched.`,
					{ branch, path, base: baseLabel, baseSha: base.sha, label, agentName, sessionFile, error: detail },
					"error",
				);
				return;
			}

			if (!inHerdr) {
				let line = `worktree-only: Created worktree ${path} on branch ${branch} based on ${baseLabel}. Nothing was sent to the forked session. The current checkout is left untouched.`;
				if (sessionFile) {
					line += ` Start the forked pi session with: cd ${path} && pi --fork ${sessionFile}`;
				} else {
					line += ` Run /session in this session to get its file or id, then start the forked pi session with: cd ${path} && pi --fork <file-or-id>`;
				}
				report(
					pi,
					ctx,
					"worktree-only",
					line,
					{ branch, path, base: baseLabel, baseSha: base.sha, label, agentName, sessionFile },
					"info",
				);
				return;
			}

			const workspaceId = process.env.HERDR_WORKSPACE_ID as string;
			const forkRef = sessionFile ?? ctx.sessionManager.getSessionId();

			const tab = await herdrTabCreate(run, cwd, workspaceId, path, label);
			if (!tab.ok) {
				report(
					pi,
					ctx,
					"tab-failed",
					`tab-failed: Created worktree ${path} on branch ${branch} based on ${baseLabel}, but herdr could not open a tab: ${tab.message}. Nothing was sent to the forked session. The worktree is left untouched; retry with: cd ${path} && pi --fork ${forkRef}`,
					{ branch, path, base: baseLabel, baseSha: base.sha, label, agentName, sessionFile },
					"error",
				);
				return;
			}

			const started = await herdrAgentStart(run, cwd, agentName, tab.paneId, forkRef);
			if (!started.ok) {
				report(
					pi,
					ctx,
					"tab-failed",
					`tab-failed: Created worktree ${path} on branch ${branch} based on ${baseLabel} and opened herdr tab ${tab.tabId} (pane ${tab.paneId}), but pi did not start: ${started.message}. Nothing was sent to the forked session. The worktree and tab are left untouched; retry with: herdr agent start ${agentName} --kind pi --pane ${tab.paneId} --timeout ${AGENT_START_TIMEOUT_MS} -- --fork ${forkRef}; open the tab with: herdr tab focus ${tab.tabId}`,
					{
						branch,
						path,
						base: baseLabel,
						baseSha: base.sha,
						label,
						agentName,
						tabId: tab.tabId,
						paneId: tab.paneId,
						sessionFile,
					},
					"error",
				);
				return;
			}

			report(
				pi,
				ctx,
				"ok",
				`ok: Created worktree ${path} on branch ${branch} based on ${baseLabel} and started pi in herdr tab ${tab.tabId} (pane ${tab.paneId}). Nothing was sent to the forked session. The current checkout is left untouched. Open it with: herdr tab focus ${tab.tabId}`,
				{
					branch,
					path,
					base: baseLabel,
					baseSha: base.sha,
					label,
					agentName,
					tabId: tab.tabId,
					paneId: tab.paneId,
					sessionFile,
				},
				"info",
			);
		},
	});
}
