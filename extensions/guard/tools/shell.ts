/** One argv-spawned shell per call. Sandbox failures never route to the host. */
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { spawnSandboxed } from "../sandbox/run.ts";
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

export function createGuardShellOperations(ctx: ExecutionContext, host: boolean): BashOperations {
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
				protectedPaths: ctx.policy.config.protectedPaths, rlimits: RLIMITS_SHELL,
			};
			ctx.assertCurrent();
			const launched = spawnSandboxed(spec, { detection: ctx.detection });
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

export const SANDBOX_FAILURE_HINT = "Guard sandbox: network is disabled; protected/read-only paths may fail with EROFS and outside paths may not be mounted. Use host_bash if host access is required, or request a read grant. Sandbox launch failures never fall back to host execution.";

/**
 * The failure hint for one sandboxed shell result. Host-bound commands get a
 * targeted directive naming the detected command so the model re-runs it with
 * host_bash instead of retrying in the sandbox; everything else keeps the
 * generic hint.
 */
export function sandboxFailureHint(command: string): string {
	const reason = hostBoundCommandReason(command);
	if (reason !== null) {
		return `Guard sandbox: '${reason}' needs network access or host credentials and cannot succeed here. Re-run this command with host_bash (not bash); do not retry with bash.`;
	}
	return SANDBOX_FAILURE_HINT;
}
