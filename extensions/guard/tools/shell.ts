/** One argv-spawned shell per call. Sandbox failures never route to the host. */
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join, normalize } from "node:path";
import { spawnSandboxed } from "../sandbox/run.ts";
import { isPathVisible, type MountEntry } from "../sandbox/bwrap.ts";
import { effectiveWorkspaceMode } from "../policy/decision.ts";
import { normalizeRootList } from "../policy/paths.ts";
import { splitTopLevelShell, stripTimeoutPrefix } from "../policy/shellsplit.ts";
import { tokenizeSimple } from "../policy/bashtier.ts";
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
			const mode = effectiveWorkspaceMode(ctx.policy);
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
export function hostBoundCommandReason(cmd: string): string | null {
	const split = splitTopLevelShell(cmd);
	const parts = split.kind === "compound" ? split.parts : [split.kind === "single" ? (split.effectiveCmd ?? cmd) : cmd];
	for (const part of parts) {
		let tokens = tokenizeSimple(stripTimeoutPrefix(part.trim()));
		// Skip leading VAR=value assignments and wrapper commands.
		while (tokens.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens = tokens.slice(1);
		while (tokens.length > 0 && WRAPPER_PREFIXES.has(tokens[0].toLowerCase())) tokens = tokens.slice(1);
		if (tokens.length === 0) continue;
		const root = tokens[0].toLowerCase();
		if (HOST_BOUND_ROOTS.has(root)) return root;
		if (root !== "git" && !PKG_NETWORK_ROOTS.has(root)) continue;
		const subs = root === "git" ? GIT_NETWORK_SUBCOMMANDS : PKG_NETWORK_SUBCOMMANDS;
		const sub = tokens.slice(1).map((t) => t.toLowerCase()).find((t) => subs.has(t));
		if (sub !== undefined) return `${root} ${sub}`;
	}
	return null;
}

export const SANDBOX_FAILURE_HINT = "Guard sandbox: network is disabled; protected/read-only paths may fail with EROFS and outside paths may not be mounted. Use host_bash if host access is required, or request a grant with the request_read_access tool. Sandbox launch failures never fall back to host execution.";

/**
 * The generic failure hint for sandboxed bash only. It states the filesystem
 * boundary and points at host_bash, and names the request_read_access tool
 * for persistent read access (the tool opens the guard read-grant dialog for
 * an absolute path; sandboxed bash has no way to trigger one itself).
 */
export const SHELL_SANDBOX_FAILURE_HINT = "Guard sandbox: network is disabled; only the workspace, the shared scratch directory, configured read roots, and standard toolchain directories are mounted (protected paths are read-only, and the sandbox /tmp is a private tmpfs, not the host /tmp). Use host_bash if host access is required. For persistent sandbox read access, request a grant with the request_read_access tool. Sandbox launch failures never fall back to host execution.";

/** Live session locations substituted into the boundary prose. */
export interface SandboxPaths {
	/** The workspace root (the sandbox's writable project mount). */
	workspace: string;
	/** This session's scratch directory: the one shared temp location. */
	scratch: string;
	/** The host home directory (used to name `~/.pi`). */
	home: string;
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
export const SANDBOX_TOOL_ROUTING = "Decide the tool before writing the command: network or credentials (gh, curl, ssh, git push/fetch, package installs), or any host path outside those mounts (for example a /tmp handoff file), needs host_bash, or the read tool when you only need to read it.";

/** Why bash cannot be the host escape, and what always can. */
export const BASH_SANDBOX_NOTE = "bash runs in the sandbox only and is unavailable on a host without one (degraded mode): use host_bash there, limited to read-only-tier commands in the research profile.";

/** The host-side temp file a truncated bash result points at. */
export const TRUNCATED_OUTPUT_NOTE = "When a result is truncated, full_output_path is a host temp file: read it with read or host_bash.";

/** How to make a host path visible to sandboxed commands persistently. */
export const READ_GRANT_NOTE = "For persistent sandbox read access outside the mounts, request a grant with the request_read_access tool.";

/** Two routing bullets appended to the system prompt while a shell tool is active. */
export const SANDBOX_TOOL_GUIDELINES: readonly string[] = [
	"Decide the shell tool before writing the command: `bash` is sandboxed (workspace, session scratch, granted read roots, and toolchain dirs only; no network, no host credentials; the sandbox `/tmp` is not the host `/tmp`); use `host_bash` for network, credentials, or any host path outside those mounts, including the host `/tmp`.",
	"To read a host file outside the sandbox mounts (for example a handoff file in `/tmp`), use the `read` tool or `host_bash`; `bash` cannot see it. Use `request_read_access` only when the path must become visible to sandboxed commands.",
];

export const BASH_PROMPT_SNIPPET = "Run a shell command in the guard sandbox (workspace and session scratch only; no network)";
export const HOST_BASH_PROMPT_SNIPPET = "Run a shell command on the host (network, credentials, host paths outside the sandbox)";

/** The model-facing description of the sandboxed shell tool. */
export function bashToolDescription(native: string, paths?: SandboxPaths): string {
	return `Sandboxed shell: no network, no host credentials. ${sandboxBoundaryText(paths)} ${SANDBOX_TOOL_ROUTING} ${BASH_SANDBOX_NOTE} ${TRUNCATED_OUTPUT_NOTE} ${native} ${READ_GRANT_NOTE}`;
}

/** The model-facing description of the host shell tool. */
export function hostBashToolDescription(native: string, paths?: SandboxPaths): string {
	const hostTmp = "the host /tmp";
	const homePi = paths === undefined ? "~/.pi" : `${paths.home}/.pi`;
	return `Host shell: runs on the host with full network access and host credentials. ${native} Use it for network or auth commands (gh, curl, ssh, git push/fetch, package installs), for host paths outside the sandbox mounts (${hostTmp}, ${homePi}, other repositories), and as the only shell in yolo, unrestricted, and degraded mode (in degraded research only read-only-tier commands run). Subject to HostBash rules and guard profile.`;
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
	cmd: string,
	mountedPaths: readonly MountEntry[] | undefined,
	home: string = homedir(),
): string[] {
	if (mountedPaths === undefined || mountedPaths.length === 0) return [];
	const split = splitTopLevelShell(cmd);
	const parts = split.kind === "compound" ? split.parts : [split.kind === "single" ? (split.effectiveCmd ?? cmd) : cmd];
	const found: string[] = [];
	for (const part of parts) {
		let tokens = tokenizeSimple(stripTimeoutPrefix(part.trim()));
		// Skip leading VAR=value assignments and wrapper commands, as hostBoundCommandReason does.
		while (tokens.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens = tokens.slice(1);
		while (tokens.length > 0 && WRAPPER_PREFIXES.has(tokens[0].toLowerCase())) tokens = tokens.slice(1);
		for (const token of tokens) {
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
export function sandboxFailureHint(command: string, mountedPaths?: readonly MountEntry[], home?: string): string {
	const reason = hostBoundCommandReason(command);
	if (reason !== null) {
		return `Guard sandbox: '${reason}' needs network access or host credentials and cannot succeed here. Re-run this command with host_bash (not bash); do not retry with bash.`;
	}
	const paths = mountedPaths === undefined ? [] : unmountedPathCandidates(command, mountedPaths, home);
	if (paths.length > 0) {
		return `Guard sandbox: this command mentions path(s) that are not visible in this sandbox: ${paths.join(", ")}. If the command needs them, use host_bash (or the read tool to read them); do not retry with bash. Other causes are possible. ${SHELL_SANDBOX_FAILURE_HINT}`;
	}
	return SHELL_SANDBOX_FAILURE_HINT;
}
