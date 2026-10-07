/** Guard worker launch adapter. No host fallback after a sandbox launch failure. */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { realpathSync } from "node:fs";
import { detectSandboxMode, type SandboxDetection } from "../sandbox/detect.ts";
import { spawnSandboxed } from "../sandbox/run.ts";
import { RLIMITS_NODE, RLIMITS_PYTHON, type LaunchSpec } from "../sandbox/spec.ts";
import { LIMITS as PYTHON_LIMITS } from "./python/limits.ts";
import { LIMITS as NODE_LIMITS } from "./node/limits.ts";

export interface ControllerOptions {
	projectDir: string;
	workspaceMode: "overlay" | "ro" | "none";
	readRoots?: readonly string[];
	runtimeDir: string;
	scratchDir: string;
	detection?: SandboxDetection;
	maskPatterns?: string[];
	maskExceptions?: string[];
	protectedPaths?: string[];
}

export interface DependencyCheck {
	ok: boolean;
	diagnostic?: string;
	interpreterPath: string;
	detection?: SandboxDetection;
}

export type WorkerKind = "python" | "node";
export interface WorkerLaunch {
	child: ChildProcess;
	/** Always settles successfully, including spawn errors. No orphan rejection. */
	done: Promise<{ error?: string }>;
	workspaceMode: "overlay" | "read-only" | "raw";
}

/** Resolve and probe only when execute needs a worker. status/reset stay passive. */
export function checkDependencies(kind: WorkerKind, options: ControllerOptions): DependencyCheck {
	const detection = options.workspaceMode === "none" ? undefined : options.detection ?? detectSandboxMode();
	if (detection?.mode === "degraded") {
		return { ok: false, interpreterPath: "", detection, diagnostic: detection.diagnostics.join(" ") || "Guard sandbox unavailable." };
	}
	try {
		const candidate = kind === "node" ? process.env.PI_NODE_TOOL_INTERPRETER || process.execPath : process.env.PI_PYTHON_TOOL_INTERPRETER || "python3";
		const args = kind === "node" ? ["-p", "process.execPath"] : ["-c", "import sys; print(sys.executable)"];
		const probe = spawnSync(candidate, args, { encoding: "utf8", timeout: 10_000, maxBuffer: 4096 });
		if (probe.status !== 0) throw new Error(String(probe.error?.message || probe.stderr || `exit ${probe.status}`).trim());
		const interpreterPath = realpathSync(probe.stdout.trim());
		return { ok: true, interpreterPath, detection };
	} catch (err) {
		return { ok: false, interpreterPath: "", detection, diagnostic: `Cannot resolve ${kind} interpreter: ${err instanceof Error ? err.message : String(err)}` };
	}
}

export function spawnWorker(kind: WorkerKind, options: ControllerOptions, deps: DependencyCheck, workerPath: string): WorkerLaunch {
	const raw = options.workspaceMode === "none";
	const stagedPath = `/.guard/worker.${kind === "python" ? "py" : "mjs"}`;
	const reprLimit = kind === "python" ? PYTHON_LIMITS.maxReprBytes : NODE_LIMITS.maxReprBytes;
	const workerArgs = [raw ? workerPath : stagedPath, String(reprLimit), raw ? "--guard-raw" : "--guard-sandbox"];
	const target = kind === "python"
		? [deps.interpreterPath, ...(raw ? ["-u"] : ["-I", "-u"]), ...workerArgs]
		: [deps.interpreterPath, ...(raw ? [] : [`--max-old-space-size=${NODE_LIMITS.maxOldSpaceSizeMb}`]), ...workerArgs];
	if (raw) {
		const child = spawn(target[0], target.slice(1), {
			cwd: options.projectDir,
			env: { ...process.env },
			stdio: ["pipe", "pipe", "pipe", "pipe"],
			detached: true,
		});
		const done = new Promise<{ error?: string }>((resolve) => {
			child.once("error", (err) => resolve({ error: err.message }));
			child.once("close", () => resolve({}));
		});
		return { child, done, workspaceMode: "raw" };
	}
	// extraRwBinds/protectedPaths are shared sandbox inputs, never user argv.
	const spec: LaunchSpec = {
		workspace: options.projectDir,
		workspaceMode: options.workspaceMode === "overlay" ? "overlay" : "ro",
		cwd: options.projectDir,
		target,
		readRoots: [...options.readRoots ?? []],
		extraRoBinds: [[workerPath, stagedPath]],
		extraRwBinds: [[options.scratchDir, options.scratchDir]],
		maskPatterns: options.maskPatterns,
		maskExceptions: options.maskExceptions,
		protectedPaths: options.protectedPaths,
		runtimeDir: options.runtimeDir,
		rlimits: kind === "python" ? RLIMITS_PYTHON : RLIMITS_NODE,
		extraFds: 1,
	};
	const launched = spawnSandboxed(spec, { detection: deps.detection });
	// Attach the rejection handler immediately. Controllers await this during
	// teardown, which includes the launcher's overlay cleanup on close.
	const done = launched.done.then(() => ({}), (err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }));
	return { child: launched.child, done, workspaceMode: launched.effective.workspaceMode === "overlay" ? "overlay" : "read-only" };
}
