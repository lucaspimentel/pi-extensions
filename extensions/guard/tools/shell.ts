/** One argv-spawned shell per call. Sandbox failures never route to the host. */
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { spawnSandboxed } from "../sandbox/run.ts";
import { effectiveWorkspaceMode } from "../policy/decision.ts";
import { normalizeRootList } from "../policy/paths.ts";
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

export const SANDBOX_FAILURE_HINT = "Guard sandbox: network is disabled; protected/read-only paths may fail with EROFS and outside paths may not be mounted. Use host_bash if host access is required, or request a read grant. Sandbox launch failures never fall back to host execution.";
