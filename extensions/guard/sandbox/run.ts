/**
 * spawnSandboxed: prepare runtime dirs, spawn the sandboxed process, and
 * clean up after exit.
 *
 * Pipeline per launch:
 *   1. detect the runtime mode (cached); degraded refuses to spawn
 *   2. prepare the session runtime dir (0700, ownership and mode verified)
 *   3. scan the workspace for masks and nested protected entries (fails the
 *      launch on timeout or cap; never launches unmasked)
 *   4. degrade overlay to read-only in reduced mode (reported)
 *   5. create per-launch overlay dirs (full mode) and generated etc/nuget
 *      files under the session dir
 *   6. build the argv (outer launcher + bwrap + inner tail, or bwrap + prlimit)
 *   7. spawn (no shell, minimal env for bwrap itself, own process group) and
 *      return the child, a completion promise that cleans the overlay dirs,
 *      and an effective-launch record of every degradation
 *
 * The library does not truncate output or enforce timeouts; that belongs to
 * the step 3 tools. Kill-on-abort: --die-with-parent plus the child's own
 * process group mean killing the outer launcher (or bwrap) tears the whole
 * tree down; killing the group with -pid also works.
 */

import { spawn, type ChildProcess } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { GUARD_LAUNCH_MOUNT, buildEnv, type LaunchSpec, type WorkspaceMode } from "./spec.ts";
import { buildBwrapArgs, buildOuterLauncherArgv, filterMountableReadRoots, resolveWorktreeCommonDir, type BwrapContext, type OverlaySpec } from "./bwrap.ts";
import { detectSandboxMode, chmodTree, type SandboxDetection } from "./detect.ts";
import { scanWorkspace } from "./scan.ts";
import { sanitizeNugetConfig } from "./nuget.ts";
import { verifyCachePathPermissions } from "./launcher.ts";

export class SandboxUnavailableError extends Error {
	diagnostics: string[];
	constructor(diagnostics: string[]) {
		super(`The guard sandbox is unavailable (degraded mode): ${diagnostics.join(" ")}`);
		this.name = "SandboxUnavailableError";
		this.diagnostics = diagnostics;
	}
}

/** Default runtime root: a private per-uid directory under the OS temp dir. */
export function defaultRuntimeRoot(): string {
	const uid = process.getuid?.() ?? 0;
	return path.join(os.tmpdir(), `pi-guard-${uid}`);
}

export interface EffectiveLaunch {
	mode: "full" | "reduced";
	/** Workspace mode actually applied (overlay may degrade to ro). */
	workspaceMode: WorkspaceMode;
	/** Human-readable degradations, e.g. overlay degraded to read-only. */
	degradations: string[];
	skippedReadRoots: Array<{ root: string; reason: string }>;
	scanner: "fd" | "find";
	maskedFiles: number;
	nestedProtectedEntries: number;
	launchId: string;
	sessionDir: string;
	/** Mode diagnostics from detection (reduced mode carries the reason). */
	diagnostics: string[];
}

export interface SpawnResult {
	child: ChildProcess;
	/**
	 * Resolves when the process exits and overlay cleanup finished (cleanup is
	 * best effort and never rejects). Rejects only on a spawn error.
	 */
	done: Promise<{ code: number | null; signal: string | null }>;
	effective: EffectiveLaunch;
}

export interface SpawnOptions {
	/** Detection override (tests force reduced mode this way). */
	detection?: SandboxDetection;
	/** Stat override for runtime-dir permission checks (tests). */
	stat?: (p: string) => fs.Stats;
	/** uid override for runtime-dir permission checks (tests). */
	uid?: number;
}

/**
 * Verify a runtime dir: owned by the current uid and not group or
 * world-writable. Returns a diagnostic or null.
 */
export function verifyRuntimeDirPermissions(p: string, options: SpawnOptions = {}): string | null {
	return verifyCachePathPermissions(p, { stat: options.stat, uid: options.uid });
}

function username(): string {
	return process.env.USER ?? process.env.LOGNAME ?? safeUsername() ?? "user";
}

function safeUsername(): string | null {
	try {
		return os.userInfo().username;
	} catch {
		return null;
	}
}

/** Write generated /etc/passwd and /etc/group containing only the current user. */
export function writeGeneratedEtc(etcDir: string, homePath: string): void {
	const uid = process.getuid?.() ?? 1000;
	const gid = process.getgid?.() ?? uid;
	const user = username();
	mkdirSync(etcDir, { recursive: true, mode: 0o700 });
	// Real home path and /bin/bash: tools that resolve ~ or $HOME tools see a
	// coherent identity with no other accounts.
	writeFileSync(path.join(etcDir, "passwd"), `${user}:x:${uid}:${gid}::${homePath}:/bin/bash\n`, { mode: 0o600 });
	writeFileSync(path.join(etcDir, "group"), `${user}:x:${gid}:\n`, { mode: 0o600 });
}

/**
 * Write a sanitized copy of ~/.nuget/NuGet/NuGet.Config (credentials and api
 * keys removed) into the runtime dir with mode 0600. Returns the copy's path,
 * or null when the original does not exist.
 */
export function prepareNugetConfig(runtimeDir: string, homePath: string): string | null {
	const orig = path.join(homePath, ".nuget", "NuGet", "NuGet.Config");
	if (!existsSync(orig)) return null;
	let xml: string;
	try {
		xml = readFileSync(orig, "utf8");
	} catch {
		xml = "";
	}
	const { sanitized } = sanitizeNugetConfig(xml);
	const dir = path.join(runtimeDir, "nuget");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const copyPath = path.join(dir, "NuGet.Config");
	// Keep everything else, and never write an empty file (empty breaks restore).
	writeFileSync(copyPath, sanitized ?? xml, { mode: 0o600 });
	return copyPath;
}

/** Create the session runtime dir under root, 0700 and verified. */
export function createSessionDir(root?: string, options: SpawnOptions = {}): string {
	const base = root ?? defaultRuntimeRoot();
	mkdirSync(base, { recursive: true, mode: 0o700 });
	chmodSync(base, 0o700);
	const diag = verifyRuntimeDirPermissions(base, options);
	if (diag) throw new SandboxUnavailableError([diag]);
	const sessionDir = mkdtempSync(path.join(base, "session-"));
	chmodSync(sessionDir, 0o700);
	return sessionDir;
}

/** Remove an overlayfs leftover: work/work is mode 000, so chmod first. */
export function cleanupOverlayDir(dir: string): void {
	try {
		chmodTree(dir);
		rmSync(dir, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
}

/**
 * Remove a session runtime dir except quarantine/ (quarantined data is never
 * deleted by the library).
 */
export function disposeSession(runtimeDir: string): void {
	let entries: fs.Dirent[] = [];
	try {
		entries = fs.readdirSync(runtimeDir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const e of entries) {
		if (e.name === "quarantine") continue;
		const full = path.join(runtimeDir, e.name);
		try {
			if (e.name === "overlays") {
				// Overlay leftovers may hold mode-000 work dirs.
				chmodTree(full);
			}
			rmSync(full, { recursive: true, force: true });
		} catch {
			/* best effort */
		}
	}
}

/**
 * Spawn a sandboxed process for the spec. Throws SandboxUnavailableError in
 * degraded mode (the caller runs host execution) and ScanFailure when the
 * workspace scan hits its timeout or cap.
 */
export function spawnSandboxed(spec: LaunchSpec, options: SpawnOptions = {}): SpawnResult {
	const detection = options.detection ?? detectSandboxMode();
	if (detection.mode === "degraded" || detection.bwrapPath === null) {
		throw new SandboxUnavailableError(
			detection.diagnostics.length > 0
				? detection.diagnostics
				: ["no bubblewrap and no launcher are available"],
		);
	}
	const mode = detection.mode === "full" && detection.launcherPath !== null ? "full" : "reduced";

	const workspace = realpathSync(spec.workspace);
	const homePath = spec.homePath ?? realpathOrHome(os.homedir());
	const cwd = spec.cwd ?? workspace;
	const cacheOverlays = spec.cacheOverlays !== false;
	const launchId = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;

	// Session runtime dir: spec-provided, or a fresh one under the root.
	let sessionDir: string;
	if (spec.runtimeDir !== undefined) {
		mkdirSync(spec.runtimeDir, { recursive: true, mode: 0o700 });
		const diag = verifyRuntimeDirPermissions(spec.runtimeDir, options);
		if (diag) throw new SandboxUnavailableError([diag]);
		sessionDir = spec.runtimeDir;
	} else {
		sessionDir = createSessionDir(undefined, options);
	}
	const launchOverlaysRoot = path.join(sessionDir, "overlays", launchId);

	// Discovery scan: fails the launch on timeout or cap; never unmasked.
	const scan = scanWorkspace(workspace, { fdPath: detection.fdPath });

	// Effective workspace mode: overlay degrades to read-only in reduced mode.
	const degradations: string[] = [];
	let workspaceMode: WorkspaceMode = spec.workspaceMode;
	if (workspaceMode === "overlay" && mode === "reduced") {
		workspaceMode = "ro";
		degradations.push("overlay workspace degraded to read-only (reduced mode: no launcher, so no overlays)");
	}

	// Overlay layers (full mode only): workspace + cache dirs that exist.
	const overlays: OverlaySpec[] = [];
	if (mode === "full") {
		if (spec.workspaceMode === "overlay") {
			overlays.push(makeOverlay(launchOverlaysRoot, "workspace", workspace, workspace));
		}
		if (cacheOverlays) {
			for (const [name, rel] of CACHE_OVERLAY_SPECS) {
				const hostDir = path.join(homePath, rel);
				if (existsSync(hostDir)) overlays.push(makeOverlay(launchOverlaysRoot, name, hostDir, hostDir));
			}
		}
	}

	// Generated /etc and sanitized NuGet config.
	const etcDir = path.join(sessionDir, "etc");
	writeGeneratedEtc(etcDir, homePath);
	const nugetConfigPath = prepareNugetConfig(sessionDir, homePath);

	// Read roots: filter and record skips.
	const { mountable, skipped } = filterMountableReadRoots(spec.readRoots ?? [], workspace);

	const env = buildEnv({ homePath, extraEnv: spec.extraEnv });

	const ctx: BwrapContext = {
		mode,
		launcherPath: detection.launcherPath ?? "",
		prlimitPath: detection.prlimitPath,
		homePath,
		etcDir,
		nugetConfigPath,
		workspaceMode,
		overlays,
		readRoots: mountable,
		masks: scan.masks,
		nestedProtected: scan.nestedProtected,
		worktreeCommonDir: resolveWorktreeCommonDir(workspace),
		env,
		cwd,
	};
	const bwrapArgs = buildBwrapArgs(spec, ctx);

	// Full mode: outer launcher mounts the overlays then execs bwrap. Reduced
	// mode: bwrap directly (no overlays to mount).
	const program = mode === "full" ? detection.launcherPath! : detection.bwrapPath;
	const args =
		mode === "full"
			? buildOuterLauncherArgv(overlays, detection.bwrapPath!, bwrapArgs)
			: bwrapArgs;

	// Minimal env for bwrap itself; --clearenv sanitizes the sandbox side.
	// Own process group: killing -pid tears the whole tree down, and
	// --die-with-parent covers parent death.
	const stdio: Array<"pipe"> = ["pipe", "pipe", "pipe"];
	for (let i = 0; i < (spec.extraFds ?? 0); i++) stdio.push("pipe");
	const child = spawn(program, args, {
		env: { LANG: "C.UTF-8" },
		stdio,
		detached: true,
	});

	const overlayDirForLaunch = launchOverlaysRoot;
	const done = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
		child.on("error", (err) => reject(err));
		child.on("close", (code, signal) => {
			// Remove this launch's overlay dirs (best effort, never rejects).
			if (mode === "full" && existsSync(overlayDirForLaunch)) {
				cleanupOverlayDir(overlayDirForLaunch);
			}
			resolve({ code, signal });
		});
	});

	return {
		child,
		done,
		effective: {
			mode,
			workspaceMode,
			degradations,
			skippedReadRoots: skipped,
			scanner: scan.scanner,
			maskedFiles: scan.masks.length,
			nestedProtectedEntries: scan.nestedProtected.length,
			launchId,
			sessionDir,
			diagnostics: [...detection.diagnostics],
		},
	};
}

const CACHE_OVERLAY_SPECS: Array<[string, string]> = [
	["cargo-registry", ".cargo/registry"],
	["cargo-git", ".cargo/git"],
	["nuget-packages", ".nuget/packages"],
	["npm", ".npm"],
];

function makeOverlay(root: string, name: string, lower: string, targetPath: string): OverlaySpec {
	const base = path.join(root, name);
	const upper = path.join(base, "upper");
	const work = path.join(base, "work");
	const merged = path.join(base, "merged");
	mkdirSync(upper, { recursive: true, mode: 0o700 });
	mkdirSync(work, { recursive: true, mode: 0o700 });
	mkdirSync(merged, { recursive: true, mode: 0o700 });
	return { name, lower, upper, work, merged, targetPath };
}

function realpathOrHome(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
}
