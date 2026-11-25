/** One argv-spawned shell per call. Sandbox failures never route to the host. */
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join, normalize } from "node:path";
import { spawnSandboxed } from "../sandbox/run.ts";
import { isPathVisible, type MountEntry } from "../sandbox/bwrap.ts";
import { bashWorkspaceMode } from "../policy/decision.ts";
import { normalizeRootList } from "../policy/paths.ts";
import type { ShellCommandAnalysis } from "../policy/shellast.ts";
import { homedir, constants } from "node:os";
import { RLIMITS_SHELL, type LaunchSpec } from "../sandbox/spec.ts";
import type { ExecutionContext } from "../runtime.ts";

function hostBashPath(): string {
	if (process.platform !== "win32") return existsSync("/bin/bash") ? "/bin/bash" : "bash";
	for (const base of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Programs") : undefined]) {
		if (!base) continue;
		const candidate = join(base, "Git", "bin", "bash.exe");
		if (existsSync(candidate)) return candidate;
	}
	return "bash";
}

export function createGuardShellOperations(
	ctx: ExecutionContext,
	host: boolean,
	onLaunch?: (mountedPaths: MountEntry[]) => void,
): BashOperations {
	return { exec: async (command, cwd, { onData, timeout }) => {
		await ctx.revalidate();
		let child: ChildProcess;
		let done: Promise<{ code: number | null; signal: string | null }>;
		if (host) {
			// No async backend gap between the final policy check and actual spawn.
			ctx.assertCurrent();
			child = spawn(hostBashPath(), ["--noprofile", "--norc", "-c", command], {
				cwd, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"],
				detached: process.platform !== "win32", windowsHide: true,
			});
			done = new Promise((resolve, reject) => {
				child.once("error", reject);
				child.once("close", (code, signal) => resolve({ code, signal }));
			});
		} else {
			const mode = bashWorkspaceMode(ctx.policy);
			if (mode === "none") throw new Error("guard: raw shell must use HostBash authorization");
			const spec: LaunchSpec = {
				workspace: ctx.policy.cwd, cwd: realpathSync(cwd), workspaceMode: mode,
				target: ["/bin/bash", "-c", command], runtimeDir: ctx.runtimeDir,
				readRoots: normalizeRootList(ctx.policy.config.readRoots, ctx.policy.cwd, homedir()),
				extraRwBinds: [[ctx.scratchDir, ctx.scratchDir]],
				maskPatterns: ctx.policy.config.maskPatterns, maskExceptions: ctx.policy.config.maskExceptions,
				pruneNames: ctx.policy.config.discoveryPruneNames, discoveryMatchCap: ctx.policy.config.discoveryMatchCap, discoveryTimeoutMs: ctx.policy.config.discoveryTimeoutMs,
				protectedPaths: ctx.policy.config.protectedPaths, rlimits: RLIMITS_SHELL,
			};
			ctx.assertCurrent();
			const launched = spawnSandboxed(spec, { detection: ctx.detection });
			onLaunch?.(launched.effective.mountedPaths);
			child = launched.child;
			done = launched.done;
			child.stdin?.end();
		}
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		let killPromise: Promise<void> | undefined;
		const kill = (): Promise<void> => {
			if (killPromise) return killPromise;
			killPromise = (async () => {
				if (!child.pid) return;
				if (process.platform === "win32") {
					const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
					await new Promise<void>((resolve, reject) => {
						killer.once("error", reject);
						killer.once("close", (code) => code === 0 || child.exitCode !== null || child.signalCode !== null ? resolve() : reject(new Error(`taskkill failed (${code})`)));
					});
				} else {
					try { process.kill(-child.pid, "SIGKILL"); }
					catch (err) {
						if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
					}
				}
			})();
			return killPromise;
		};
		let rejectTeardown!: (error: unknown) => void;
		const teardownFailure = new Promise<never>((_resolve, reject) => { rejectTeardown = reject; });
		// It is raced below, but attach now for immediately aborted calls.
		void teardownFailure.catch(() => {});
		let stopping: Promise<void> | undefined;
		const stop = (): Promise<void> => {
			if (stopping) return stopping;
			stopping = (async () => {
				let deadline: ReturnType<typeof setTimeout> | undefined;
				try {
					await Promise.race([
						(async () => {
							await kill();
							if (child.pid === undefined) await done.catch(() => {});
							else await done;
						})(),
						new Promise<never>((_resolve, reject) => { deadline = setTimeout(() => reject(new Error("Shell teardown did not finish")), 5_000); }),
					]);
				} catch (err) { ctx.teardownFailed(err); }
				finally { if (deadline) clearTimeout(deadline); }
			})();
			void stopping.catch(rejectTeardown);
			return stopping;
		};
		ctx.setTeardown(stop);
		let timedOut = false;
		const timer = timeout === undefined ? undefined : setTimeout(() => { timedOut = true; void stop(); }, timeout * 1000);
		const onAbort = () => { void stop(); };
		ctx.signal.addEventListener("abort", onAbort, { once: true });
		if (ctx.signal.aborted) onAbort();
		try {
			// A known teardown failure must settle execution even if close never arrives.
			const result = await Promise.race([done, teardownFailure]);
			if (stopping) await stopping;
			if (ctx.signal.aborted) throw new Error("aborted");
			if (timedOut) throw new Error(`timeout:${timeout}`);
			return { exitCode: result.code ?? (result.signal ? 128 + (constants.signals[result.signal as keyof typeof constants.signals] ?? 0) : 1) };
		} finally {
			if (timer) clearTimeout(timer);
			ctx.signal.removeEventListener("abort", onAbort);
		}
	} };
}

/**
 * Top-level command names that always need network access or host resources
 * (credentials, daemon sockets) and can never succeed inside the sandbox.
 */
const HOST_BOUND_ROOTS = new Set([
	"gh", "curl", "wget", "ssh", "scp", "sftp", "rsync",
	"aws", "gcloud", "az", "gsutil", "kubectl", "helm", "terraform",
	"docker", "podman",
]);

/** `git` subcommands that contact a remote. */
const GIT_NETWORK_SUBCOMMANDS = new Set(["push", "pull", "fetch", "clone", "ls-remote"]);

/** Package-manager roots whose install-family subcommands hit the network. */
const PKG_NETWORK_ROOTS = new Set(["npm", "pnpm", "yarn", "bun", "pip", "pip3", "uv", "uvx", "cargo", "gem", "composer", "dotnet", "nuget", "go"]);

/** Network-reaching subcommands for the package-manager roots above. */
const PKG_NETWORK_SUBCOMMANDS = new Set(["install", "add", "ci", "update", "upgrade", "publish", "push", "restore", "download", "get", "mod"]);

/** Leading commands that only wrap the real command (checked case-insensitively). */
const WRAPPER_PREFIXES = new Set(["sudo", "nohup", "env", "exec", "command", "nice", "stdbuf"]);

/**
 * Advisory detection of network- or credential-dependent commands: returns the
 * first matching command's display name, or null when none is detected. Used
 * only to make the sandboxed-failure hint specific; it never blocks or
 * reroutes execution, and misses (aliases, functions, unlisted tools) fail
 * open to the generic hint.
 */
export function hostBoundCommandReason(analysis: ShellCommandAnalysis | null): string | null {
	if (!analysis?.complete) return null;
	for (const call of analysis.calls) {
		let argv = [...call.argv];
		// Skip leading VAR=value assignments and wrapper commands (the adapter
		// already unwrapped registry wrappers; this keeps the remaining manual
		// prefixes honest).
		while (argv.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0])) argv = argv.slice(1);
		while (argv.length > 0 && WRAPPER_PREFIXES.has(argv[0].toLowerCase())) argv = argv.slice(1);
		if (argv.length === 0) continue;
		const root = argv[0].toLowerCase();
		if (HOST_BOUND_ROOTS.has(root)) return root;
		if (root !== "git" && !PKG_NETWORK_ROOTS.has(root)) continue;
		const subs = root === "git" ? GIT_NETWORK_SUBCOMMANDS : PKG_NETWORK_SUBCOMMANDS;
		const sub = argv.slice(1).map((t) => t.toLowerCase()).find((t) => subs.has(t));
		if (sub !== undefined) return `${root} ${sub}`;
	}
	return null;
}

/** The invariant tail every sandbox failure hint ends with. */
const NO_HOST_FALLBACK_TAIL = "Sandbox launch failures never fall back to host execution.";

export const SANDBOX_FAILURE_HINT = `Guard sandbox: network is disabled; protected/read-only paths may fail with EROFS and outside paths may not be mounted. Use host_bash if host access is required, or request a grant with the request_read_access tool. ${NO_HOST_FALLBACK_TAIL}`;

/**
 * The generic failure hint for sandboxed bash only. It states the filesystem
 * boundary and points at host_bash, and names the request_read_access tool
 * for persistent read access (the tool opens the guard read-grant dialog for
 * an absolute path; sandboxed bash has no way to trigger one itself).
 */
export const SHELL_SANDBOX_FAILURE_HINT = `Guard sandbox: network is disabled; only the workspace, the shared scratch directory, configured read roots, and standard toolchain directories are mounted (protected paths are read-only, and the sandbox /tmp is a private tmpfs, not the host /tmp). Use host_bash if host access is required. For persistent sandbox read access, request a grant with the request_read_access tool. ${NO_HOST_FALLBACK_TAIL}`;

/**
 * The failure hint for a child whose workspace is read-only because its
 * write/edit gate collapses to deny (see bashWorkspaceMode). It names the escape
 * (the parent session switching rungs) so the model does not retry with bash.
 */
export const SHELL_WORKSPACE_READ_ONLY_HINT = `Guard sandbox: this session's workspace is mounted read-only because its write/edit gate denies without a UI, so a write here cannot succeed. Ask the parent session to switch to allow-edits or auto and re-dispatch; do not retry with bash. ${NO_HOST_FALLBACK_TAIL}`;

/** Live session locations substituted into the boundary prose. */
export interface SandboxPaths {
	/** The workspace root (the sandbox's writable project mount). */
	workspace: string;
	/** This session's scratch directory: the one shared temp location. */
	scratch: string;
	/** The host home directory (used to name `~/.pi`). */
	home: string;
	/**
	 * True when this session's bash workspace is read-only because the write/edit
	 * gate collapses to deny (a subagent child). Read only by
	 * bashToolDescription; the workers keep their overlay semantics.
	 */
	bashWorkspaceReadOnly?: boolean;
}

/**
 * The sandbox filesystem boundary as prose, naming the real workspace and
 * scratch paths when a runtime exists and generic phrases before it does.
 * Shared by every sandboxed tool description, so the boundary is described
 * in exactly one place. Read roots are deliberately described as a category
 * rather than enumerated: their list changes when a grant lands, and the
 * description must not churn the request's tools payload for it.
 */
export function sandboxBoundaryText(paths?: SandboxPaths): string {
	const workspace = paths === undefined ? "the current workspace" : paths.workspace;
	const scratch = paths === undefined ? "the per-session scratch directory" : paths.scratch;
	const homePi = paths === undefined ? "~/.pi" : `${paths.home}/.pi`;
	return `Visible: the workspace ${workspace}, the session scratch directory ${scratch}, read roots you were granted, and standard toolchain directories (protected paths are read-only; the sandbox /tmp is a private tmpfs, not the host /tmp). Everything else on the host is absent, including ${homePi} and other repositories.`;
}

/** The tool-choice rule, stated once and reused by every sandboxed tool. */
export const SANDBOX_TOOL_ROUTING = "Decide the tool before writing the command: network or credentials (gh writes and auth, curl, ssh, git push/fetch, package installs), or any host path outside those mounts (for example a /tmp handoff file), needs host_bash, or the read tool when you only need to read it.";

/** The loadout facts the read-tool clause needs, structurally, so this module needs no pi types. */
export interface ReadToolLoadout {
	declared: readonly { name: string }[];
	callable: readonly { name: string }[];
}

/**
 * Whether one loadout list carries a tool. pi always passes arrays; a missing or
 * malformed field (absent, null, or not an array) carries nothing, which keeps
 * the clause builder total instead of letting a throw cost every description in
 * the request.
 */
function hasTool(list: readonly { name: string }[] | null | undefined, name: string): boolean {
	return Array.isArray(list) && list.some((tool) => tool?.name === name);
}

/** Where this request can reach a tool: directly, from codemode only, or nowhere. */
function toolRoute(loadout: ReadToolLoadout | null | undefined, name: string): "declared" | "codemode" | null {
	if (loadout == null) return null;
	if (hasTool(loadout.declared, name)) return "declared";
	if (hasTool(loadout.callable, name)) return "codemode";
	return null;
}

/**
 * The read-tool routing clause appended to both shell descriptions. It names a
 * tool only when this request's loadout makes it reachable, and never invites a
 * direct call for a tool reachable only from codemode. Total: an absent, null,
 * or malformed loadout (a missing list, or a field that is not an array) yields
 * the empty string rather than a throw, so a clause failure can never cost the
 * live path substitution.
 */
export function readToolRoutingClause(loadout: ReadToolLoadout | null | undefined): string {
	const parts: string[] = [];
	const gh = toolRoute(loadout, "gh_read");
	if (gh === "declared") parts.push(toolRoute(loadout, "codemode") === null
		? "GitHub reads are gh_read, not a shell."
		: "GitHub reads are gh_read, not a shell: fan several reads out from one codemode script.");
	else if (gh === "codemode") parts.push("GitHub reads are gh_read from one codemode script, not a shell.");
	const git = toolRoute(loadout, "git_read");
	if (git === "declared") parts.push("Local git reads are git_read.");
	else if (git === "codemode") parts.push("Local git reads are git_read from one codemode script.");
	return parts.join(" ");
}

/** Why bash cannot be the host escape, and what always can. */
export const BASH_SANDBOX_NOTE = "bash runs in the sandbox only and is unavailable on a host without one (degraded mode): use host_bash there, limited to read-only-tier commands in the research profile.";

/** The host-side temp file a truncated bash result points at. */
export const TRUNCATED_OUTPUT_NOTE = "When a result is truncated, full_output_path is a host temp file: read it with read or host_bash.";

/** How to make a host path visible to sandboxed commands persistently. */
export const READ_GRANT_NOTE = "For persistent sandbox read access outside the mounts, request a grant with the request_read_access tool.";

/** The routing bullets appended to the system prompt while a shell tool is active. */
export const SANDBOX_TOOL_GUIDELINES: readonly string[] = [
	"Decide the shell tool before writing the command: `bash` is sandboxed (workspace, session scratch, granted read roots, and toolchain dirs only; no network, no host credentials; the sandbox `/tmp` is not the host `/tmp`); use `host_bash` for network, credentials, or any host path outside those mounts, including the host `/tmp`.",
	"To read a host file outside the sandbox mounts (for example a handoff file in `/tmp`), use the `read` tool or `host_bash`; `bash` cannot see it. Use `request_read_access` only when the path must become visible to sandboxed commands.",
	"Read GitHub and local git state with the dedicated read tools, not the shell: the GitHub read tool is allowed as a read, while a raw `gh api` read may prompt, and a `gh api ... | jq` pipeline or a `gh pr view` loop in a script should be one codemode pass instead.",
];

export const BASH_PROMPT_SNIPPET = "Run a shell command in the guard sandbox (workspace and session scratch only; no network)";
export const HOST_BASH_PROMPT_SNIPPET = "Run a shell command on the host (network, credentials, host paths outside the sandbox)";

/**
 * The rendered read-tool clause, or the empty string when the caller supplied
 * nothing, only whitespace, or a padded sentence. Normalizing here keeps the
 * no-clause text byte-identical and stops a stray clause from introducing a
 * leading or doubled space into the routing rule.
 */
function renderReadToolClause(readToolClause?: string): string {
	const clause = readToolClause?.trim();
	return clause ? ` ${clause}` : "";
}

/**
 * The model-facing description of the sandboxed shell tool. The optional
 * `readToolClause` carries this request's read-tool routing sentence between
 * the routing rule and the sandbox note; absent, the text is unchanged.
 */
export function bashToolDescription(native: string, paths?: SandboxPaths, readToolClause?: string): string {
	const readOnly = paths?.bashWorkspaceReadOnly === true
		? " The workspace is mounted read-only in this session (the write/edit gate denies without a UI), so commands that write it fail: ask the parent session to switch to allow-edits or auto to delegate in-root writes."
		: "";
	const clause = renderReadToolClause(readToolClause);
	return `Sandboxed shell: no network, no host credentials. ${sandboxBoundaryText(paths)}${readOnly} ${SANDBOX_TOOL_ROUTING}${clause} ${BASH_SANDBOX_NOTE} ${TRUNCATED_OUTPUT_NOTE} ${native} ${READ_GRANT_NOTE}`;
}

/**
 * The model-facing description of the host shell tool. The optional
 * `readToolClause` carries this request's read-tool routing sentence before
 * the HostBash rules sentence; absent, the text is unchanged.
 */
export function hostBashToolDescription(native: string, paths?: SandboxPaths, readToolClause?: string): string {
	const hostTmp = "the host /tmp";
	const homePi = paths === undefined ? "~/.pi" : `${paths.home}/.pi`;
	const clause = renderReadToolClause(readToolClause);
	return `Host shell: runs on the host with full network access and host credentials. ${native} Use it for network or auth commands (gh writes and auth, curl, ssh, git push/fetch, package installs), for host paths outside the sandbox mounts (${hostTmp}, ${homePi}, other repositories), and as the only shell in yolo, unrestricted, and degraded mode (in degraded research only read-only-tier commands run).${clause} Subject to HostBash rules and guard profile.`;
}

/** The model-facing description of the persistent interpreter workers. */
export function workerToolDescription(name: "python" | "node", paths?: SandboxPaths): string {
	return `Persistent ${name} interpreter managed by guard: sandboxed workers use throwaway workspace overlays (workspace writes never reach the host), no network, and no host credentials. ${sandboxBoundaryText(paths)} Host files outside those mounts (including the host /tmp) are not visible to workers: use host_bash or the read tool for them. ${READ_GRANT_NOTE} action=reset discards state, not scratch; action=status never starts a worker. Raw profiles expose the host. Unavailable in degraded mode.`;
}

/** Characters that make a path token a glob. */
const GLOB_CHARS = "*?[";

/**
 * Extract an absolute path candidate from one shell token, or null. Handles
 * bare absolute paths, ~ expansion, and `--opt=/abs/path` values. Relative
 * paths, other-user ~name paths, URLs, and redirection fragments (which
 * tokenize as single tokens like `2>/dev/null`) are ignored: misses fail
 * open. Glob paths are truncated to the last complete directory component
 * before the first glob character.
 */
function extractPathToken(token: string, home: string): string | null {
	let candidate: string;
	const eq = token.indexOf("=");
	if (eq > 0) {
		const value = token.slice(eq + 1);
		if (!/^(\/|~(\/|$))/.test(value)) return null;
		candidate = value;
	} else if (/^(\/|~(\/|$))/.test(token)) {
		candidate = token;
	} else {
		return null;
	}
	if (candidate === "~") candidate = home;
	else if (candidate.startsWith("~/")) candidate = join(home, candidate.slice(2));
	if (candidate.includes("://")) return null;
	const globIdx = [...candidate].findIndex((ch) => GLOB_CHARS.includes(ch));
	if (globIdx >= 0) {
		const slash = candidate.lastIndexOf("/", globIdx);
		if (slash <= 0) return null;
		candidate = candidate.slice(0, slash);
	}
	return normalize(candidate).replace(/(.)\/+$/, "$1");
}

/** Most unmounted-path mentions surfaced in one hint. */
const MAX_PATH_CANDIDATES = 3;

/**
 * Advisory detection of path arguments that are not visible in the sandbox:
 * the absolute/~ path tokens of the command that fail the mount table
 * lexically, or whose host realpath falls outside it (workspace symlinks to
 * unmounted targets). Purely descriptive; it never blocks or reroutes
 * execution, a mention does not prove filesystem access, and misses (dynamic
 * paths, variables, quoting) fail open to the generic hint.
 */
export function unmountedPathCandidates(
	analysis: ShellCommandAnalysis | null,
	mountedPaths: readonly MountEntry[] | undefined,
	home: string = homedir(),
): string[] {
	if (mountedPaths === undefined || mountedPaths.length === 0) return [];
	if (!analysis?.complete) return [];
	const found: string[] = [];
	for (const call of analysis.calls) {
		let argv = [...call.argv];
		// Skip leading VAR=value assignments and wrapper commands, as hostBoundCommandReason does.
		while (argv.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0])) argv = argv.slice(1);
		while (argv.length > 0 && WRAPPER_PREFIXES.has(argv[0].toLowerCase())) argv = argv.slice(1);
		for (const token of argv) {
			const candidate = extractPathToken(token, home);
			if (candidate === null || found.includes(candidate)) continue;
			let flagged = !isPathVisible(mountedPaths, candidate);
			if (!flagged) {
				try {
					const real = realpathSync(candidate);
					if (real !== candidate && !isPathVisible(mountedPaths, real)) flagged = true;
				} catch { /* missing on host: lexical visibility stands */ }
			}
			if (flagged) found.push(candidate);
			if (found.length >= MAX_PATH_CANDIDATES) return found;
		}
	}
	return found;
}

/**
 * The failure hint for one sandboxed shell result. Host-bound commands get a
 * targeted directive naming the detected command so the model re-runs it with
 * host_bash instead of retrying in the sandbox; commands that mention
 * unmounted paths get a path hint that states the invisibility, directs the
 * action at host_bash or the read tool, and still hedges causation; everything
 * else keeps the generic shell hint.
 */
export function sandboxFailureHint(analysis: ShellCommandAnalysis | null, mountedPaths?: readonly MountEntry[], workspaceReadOnly = false): string {
	const reason = hostBoundCommandReason(analysis);
	if (reason !== null) {
		return `Guard sandbox: '${reason}' needs network access or host credentials and cannot succeed here. Re-run this command with host_bash (not bash); do not retry with bash.`;
	}
	const paths = mountedPaths === undefined ? [] : unmountedPathCandidates(analysis, mountedPaths);
	if (paths.length > 0) {
		return `Guard sandbox: this command mentions path(s) that are not visible in this sandbox: ${paths.join(", ")}. If the command needs them, use host_bash (or the read tool to read them); do not retry with bash. Other causes are possible. ${SHELL_SANDBOX_FAILURE_HINT}`;
	}
	return workspaceReadOnly ? SHELL_WORKSPACE_READ_ONLY_HINT : SHELL_SANDBOX_FAILURE_HINT;
}
