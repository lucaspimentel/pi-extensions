/**
 * Sandboxed worker launcher for the node tool.
 *
 * Builds bubblewrap arguments and spawns the persistent Node.js worker with no
 * shell anywhere: everything is an argv array. Fail-closed diagnostics are
 * produced when dependencies or kernel features are missing; nothing here ever
 * falls back to running JavaScript outside the sandbox.
 *
 * Sandbox layout (sandbox paths are fixed constants):
 *   /workspace   read-only bind of the canonical project directory
 *   /scratch     writable bind of a private host scratch directory
 *   /worker.mjs  read-only bind of the worker implementation
 *   /tmp         namespace-private tmpfs, TMPDIR points here
 *   /proc        namespace-local procfs (only sandbox processes visible)
 *
 * The host home directory, agent credentials, SSH agent, Docker socket, and
 * host temporary directory are never mounted. No host Unix-domain socket is
 * ever mounted either; the worker has no seccomp policy (node has no stdlib
 * FFI to load libseccomp), so socket() calls are not blocked. External
 * network is still impossible via the network namespace, and keeping host
 * sockets out of the mount set is what prevents reaching the host's Unix
 * sockets. A socket inside the mounted project or read roots, however, is
 * connectable; see README.md's threat model for this documented delta vs the
 * python tool.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LIMITS } from "./limits.ts";

const BWRAP_CANDIDATES = ["/usr/bin/bwrap", "/usr/local/bin/bwrap", "/bin/bwrap", "/snap/bin/bwrap"];
const PRLIMIT_CANDIDATES = ["/usr/bin/prlimit", "/usr/local/bin/prlimit", "/bin/prlimit"];

/** Interpreter override for users; never model-controlled. Defaults to the
 * running node binary itself, resolved through any symlink chain. */
export function resolveInterpreter(): string {
	if (process.env.PI_NODE_TOOL_INTERPRETER) {
		try {
			return realpathSync(process.env.PI_NODE_TOOL_INTERPRETER);
		} catch {
			return process.env.PI_NODE_TOOL_INTERPRETER;
		}
	}
	try {
		return realpathSync(process.execPath);
	} catch {
		return process.execPath;
	}
}

export interface DependencyCheck {
	ok: boolean;
	/** Human-readable, actionable diagnostic when ok is false. */
	diagnostic?: string;
	bwrapPath: string | null;
	prlimitPath: string | null;
	interpreterPath: string;
}

function mergedUsrLayout(): boolean {
	try {
		return realpathSync("/bin") === realpathSync("/usr/bin");
	} catch {
		return false;
	}
}

function findBinary(candidates: string[], pathFallback: string, installHint: string): { path: string | null; diagnostic?: string } {
	for (const candidate of candidates) {
		if (existsSync(candidate)) return { path: candidate };
	}
	// Fall back to PATH lookup without a shell.
	const r = spawnSync(pathFallback, ["--version"], { stdio: "ignore", timeout: 5_000 });
	if (r.status === 0) return { path: pathFallback };
	return {
		path: null,
		diagnostic: installHint,
	};
}

function checkInterpreter(interpreter: string): string | null {
	if (!existsSync(interpreter)) {
		return (
			`Node.js interpreter not found at ${interpreter}. Install Node.js 20+ or set ` +
			"PI_NODE_TOOL_INTERPRETER to a Node.js 20+ binary. " +
			"The node tool refuses to run JavaScript outside the sandbox."
		);
	}
	const r = spawnSync(interpreter, ["-e", "console.log(process.versions.node)"], {
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 10_000,
		encoding: "utf8",
	});
	if (r.status !== 0 || typeof r.stdout !== "string") {
		return `Interpreter ${interpreter} failed to run: ${String(r.stderr || r.error || "unknown error").trim()}`;
	}
	const major = Number.parseInt(r.stdout.trim().split(".")[0] ?? "", 10);
	if (!Number.isFinite(major)) {
		return `Interpreter ${interpreter} reported an unparseable version: ${r.stdout.trim()}`;
	}
	if (major < 20) {
		return `Node.js ${major} is too old; the node tool requires Node.js 20 or newer at ${interpreter}.`;
	}
	return null;
}

/**
 * Verify platform and dependencies. This probe runs one short-lived bubblewrap
 * instance that exercises user/mount/pid/ipc/uts/net isolation and the exact
 * flag set used for real launches (including the prlimit wrapper). It never
 * runs user code.
 */
export function checkDependencies(): DependencyCheck {
	const interpreterPath = resolveInterpreter();
	if (process.platform !== "linux") {
		return {
			ok: false,
			diagnostic: `The node tool requires Linux for its bubblewrap sandbox; this platform is ${process.platform}. It refuses to run JavaScript unsandboxed.`,
			bwrapPath: null,
			prlimitPath: null,
			interpreterPath,
		};
	}
	const bwrap = findBinary(
		BWRAP_CANDIDATES,
		"bwrap",
		"bubblewrap was not found. Install it with: sudo apt install bubblewrap (Debian/Ubuntu) " +
			"or the equivalent package for your distribution. The node tool refuses to run " +
			"JavaScript outside the sandbox.",
	);
	if (!bwrap.path) {
		return { ok: false, diagnostic: bwrap.diagnostic, bwrapPath: null, prlimitPath: null, interpreterPath };
	}
	const prlimit = findBinary(
		PRLIMIT_CANDIDATES,
		"prlimit",
		"prlimit was not found. It is part of util-linux; install it with: sudo apt install util-linux. " +
			"The node tool refuses to run without its resource limits.",
	);
	if (!prlimit.path) {
		return { ok: false, diagnostic: prlimit.diagnostic, bwrapPath: bwrap.path, prlimitPath: null, interpreterPath };
	}
	const interpDiag = checkInterpreter(interpreterPath);
	if (interpDiag) {
		return { ok: false, diagnostic: interpDiag, bwrapPath: bwrap.path, prlimitPath: prlimit.path, interpreterPath };
	}
	// Kernel probe: namespaces + flags must actually work, through the same
	// prlimit wrapper the real launch uses.
	const probeArgs = [
		"--unshare-user",
		"--disable-userns",
		"--unshare-pid",
		"--unshare-ipc",
		"--unshare-uts",
		"--unshare-net",
		"--die-with-parent",
		"--new-session",
		"--cap-drop",
		"ALL",
		"--proc",
		"/proc",
		"--dev",
		"/dev",
		"--ro-bind",
		"/usr",
		"/usr",
	];
	if (mergedUsrLayout()) {
		probeArgs.push(
			"--symlink", "usr/bin", "/bin",
			"--symlink", "usr/lib", "/lib",
			"--symlink", "usr/lib64", "/lib64",
			"--symlink", "usr/sbin", "/sbin",
		);
	} else {
		probeArgs.push(
			"--ro-bind-try", "/bin", "/bin",
			"--ro-bind-try", "/sbin", "/sbin",
			"--ro-bind-try", "/lib", "/lib",
			"--ro-bind-try", "/lib64", "/lib64",
		);
	}
	// Same interpreter binds as a real launch (e.g. the brew root).
	for (const [hostPath, sandboxPath] of interpreterBinds(interpreterPath)) {
		probeArgs.push("--ro-bind-try", hostPath, sandboxPath);
	}
	probeArgs.push("--", prlimit.path, ...prlimitArgv());
	probeArgs.push(interpreterPath, `--max-old-space-size=${LIMITS.maxOldSpaceSizeMb}`, "-e", "process.exit(0)");
	const probe = spawnSync(bwrap.path, probeArgs, {
		stdio: ["ignore", "ignore", "pipe"],
		timeout: 15_000,
		encoding: "utf8",
	});
	if (probe.error || probe.status !== 0) {
		const detail = String(probe.stderr || probe.error?.message || `exit code ${probe.status}`).trim();
		return {
			ok: false,
			diagnostic:
				`Bubblewrap isolation probe failed: ${detail}. Common causes: unprivileged user namespaces ` +
				"disabled by the kernel or container runtime (sysctl kernel.unprivileged_userns_clone / " +
				"user.max_user_namespaces), or an incompatible bubblewrap build. The node tool refuses " +
				"to run JavaScript outside the sandbox.",
			bwrapPath: bwrap.path,
			prlimitPath: prlimit.path,
			interpreterPath,
		};
	}
	return { ok: true, bwrapPath: bwrap.path, prlimitPath: prlimit.path, interpreterPath };
}

/** prlimit arguments applying the OS-level limits, one value for soft and hard. */
function prlimitArgv(): string[] {
	return [
		`--as=${LIMITS.rlimitAsBytes}`,
		`--fsize=${LIMITS.rlimitFsizeBytes}`,
		`--nofile=${LIMITS.rlimitNofile}`,
		"--core=0",
	];
}

export interface WorkerLaunchSpec {
	projectDir: string;
	scratchDir: string;
	workerPath: string;
	bwrapPath: string;
	prlimitPath: string;
	interpreterPath: string;
	/** Mount the project read-write (allow-edits/yolo permission modes). Default: read-only. */
	writableWorkspace?: boolean;
	/** Host read-root directories to mount read-only 1:1 (pre-filtered by filterMountableReadRoots). */
	readRoots?: readonly string[];
}

/** Sandbox mountpoints that read-root binds must never shadow. */
const RESERVED_MOUNTPOINTS = [
	"/workspace",
	"/scratch",
	"/tmp",
	"/usr",
	"/bin",
	"/lib",
	"/lib64",
	"/sbin",
	"/proc",
	"/dev",
	"/worker.mjs",
];

export interface FilteredReadRoots {
	/** Host paths safe to ro-bind 1:1. */
	mountable: string[];
	/** Roots rejected, with the reason (for the user-facing notification). */
	skipped: Array<{ root: string; reason: string }>;
}

/**
 * Filter candidate read roots down to what can safely be mounted read-only
 * into the sandbox. Skips: non-absolute paths, reserved sandbox mountpoints
 * and anything at/under them, the project directory itself and anything under
 * it (already readable at /workspace), and roots nested under a shallower kept
 * root (already covered). Keeps the shallowest root of each overlapping chain.
 * Pure: exported for tests and called by the extension before constructing the
 * controller, so skipped roots can be surfaced in the UI notification.
 */
export function filterMountableReadRoots(
	roots: readonly unknown[],
	projectDir: string | undefined,
): FilteredReadRoots {
	const mountable: string[] = [];
	const skipped: Array<{ root: string; reason: string }> = [];
	const seen = new Set<string>();
	const candidates: string[] = [];
	for (const raw of roots) {
		if (typeof raw !== "string") continue;
		const root = raw.trim();
		// Only absolute paths; trim trailing slashes (but keep "/" itself out:
		// a bare "/" would shadow everything).
		if (!root.startsWith("/") || root === "/") {
			if (raw.length > 0) skipped.push({ root: raw, reason: "not an absolute path" });
			continue;
		}
		const normalized = root.replace(/\/+$/, "") || "/";
		if (normalized === "/") {
			skipped.push({ root: raw, reason: "not an absolute path" });
			continue;
		}
		candidates.push(normalized);
	}
	// Shallowest first so nested dedupe keeps the covering root.
	candidates.sort((a, b) => (a === b ? 0 : a < b ? -1 : 1));
	for (const root of candidates) {
		if (seen.has(root)) continue;
		seen.add(root);
		const reserved = RESERVED_MOUNTPOINTS.find((m) => root === m || root.startsWith(`${m}/`));
		if (reserved !== undefined) {
			skipped.push({ root, reason: `reserved sandbox mount (${reserved})` });
			continue;
		}
		if (projectDir !== undefined && (root === projectDir || root.startsWith(`${projectDir}/`))) {
			skipped.push({ root, reason: "covered by /workspace" });
			continue;
		}
		const covering = mountable.find((kept) => root.startsWith(`${kept}/`));
		if (covering !== undefined) {
			skipped.push({ root, reason: `covered by ${covering}` });
			continue;
		}
		mountable.push(root);
	}
	return { mountable, skipped };
}

function realpathOrSelf(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
}

/**
 * Interpreter mount strategy. The interpreter binary must exist inside the
 * sandbox at its host path:
 * - Homebrew installs (this machine): process.execPath resolves through
 *   symlink chains into /home/linuxbrew/Cellar/node/<ver>/bin/node, and the
 *   binary links shared libraries from /home/linuxbrew/opt/*. Bind the whole
 *   brew root read-only; it is a self-contained prefix.
 * - System installs (/usr/bin/node) are covered by the /usr bind.
 * - Other locations (e.g. nvm under the home directory, /opt/...): bind the
 *   resolved binary's directory tree read-only. Never the host root.
 */
export function interpreterBinds(interpreterPath: string): Array<[string, string]> {
	let realInterpreter: string;
	try {
		realInterpreter = realpathSync(interpreterPath);
	} catch {
		realInterpreter = interpreterPath;
	}
	if (realInterpreter.startsWith("/home/linuxbrew/")) {
		return [["/home/linuxbrew", "/home/linuxbrew"]];
	}
	const realDir = path.dirname(realInterpreter);
	if (realDir !== "/usr/bin" && realDir !== "/bin" && existsSync(realDir)) {
		return [[realDir, realDir]];
	}
	return [];
}

/**
 * Build the complete bubblewrap argv for one worker. No shell, no string
 * interpolation of user content: only controller-chosen paths appear here.
 */
export function buildBwrapArgs(spec: WorkerLaunchSpec): string[] {
	const args: string[] = [
		// Namespaces: user, pid, ipc, uts, net. (bwrap always creates a new mount namespace.)
		"--unshare-user",
		// Requires explicit --unshare-user on bwrap 0.9; blocks nested userns creation inside.
		"--disable-userns",
		"--unshare-pid",
		"--unshare-ipc",
		"--unshare-uts",
		"--unshare-net",
		// Lifecycle and privilege hygiene.
		"--die-with-parent",
		"--new-session",
		"--cap-drop",
		"ALL",
		// Minimal device tree and namespace-local procfs (not the host process view).
		"--proc",
		"/proc",
		"--dev",
		"/dev",
		"--tmpfs",
		"/dev/shm",
		"--tmpfs",
		"/tmp",
		// Runtime: read-only /usr plus merged-/usr compatibility links or classic dirs.
		"--ro-bind",
		"/usr",
		"/usr",
		"--ro-bind-try",
		"/etc/ld.so.cache",
		"/etc/ld.so.cache",
		"--ro-bind-try",
		"/etc/localtime",
		"/etc/localtime",
	];

	if (mergedUsrLayout()) {
		args.push(
			"--symlink", "usr/bin", "/bin",
			"--symlink", "usr/lib", "/lib",
			"--symlink", "usr/lib64", "/lib64",
			"--symlink", "usr/sbin", "/sbin",
		);
	} else {
		args.push(
			"--ro-bind-try", "/bin", "/bin",
			"--ro-bind-try", "/sbin", "/sbin",
			"--ro-bind-try", "/lib", "/lib",
			"--ro-bind-try", "/lib64", "/lib64",
		);
	}

	// Support interpreters outside /usr by binding their real directory tree
	// (or the brew root) read-only. Never the host root.
	for (const [hostPath, sandboxPath] of interpreterBinds(spec.interpreterPath)) {
		args.push("--ro-bind-try", hostPath, sandboxPath);
	}

	// Project (read-only by default; read-write in allow-edits/yolo permission
	// modes, where the user explicitly granted unprompted edits), scratch
	// (writable), worker code (read-only).
	args.push(
		spec.writableWorkspace === true ? "--bind" : "--ro-bind",
		spec.projectDir,
		"/workspace",
		"--bind", spec.scratchDir, "/scratch",
		"--ro-bind", spec.workerPath, "/worker.mjs",
	);

	// Granted read roots, mounted read-only 1:1 at their host paths
	// (pre-filtered by filterMountableReadRoots). bind-try: a root that
	// vanished mid-session degrades to a missing mount instead of failing
	// sandbox startup.
	for (const root of spec.readRoots ?? []) {
		args.push("--ro-bind-try", root, root);
	}

	// Working directory: relative project writes fail while the mount is
	// read-only; outputs belong under /scratch either way.
	args.push("--chdir", "/workspace");

	// Environment: clear everything inherited, supply only explicit runtime
	// values. No host env vars, secrets, or credentials reach the worker.
	// NODE_OPTIONS is not set: --clearenv removes it from the inherited
	// environment, and it must never influence the sandboxed node.
	args.push(
		"--clearenv",
		"--setenv", "PATH", "/usr/bin:/bin",
		"--setenv", "HOME", "/scratch",
		"--setenv", "TMPDIR", "/tmp",
		"--setenv", "LANG", "C.UTF-8",
	);

	// Launch through prlimit: the node worker cannot set its own rlimits (no
	// setrlimit API), unlike worker.py which uses the resource module.
	args.push(
		"--",
		spec.prlimitPath,
		...prlimitArgv(),
		"--",
		realpathOrSelf(spec.interpreterPath),
		`--max-old-space-size=${LIMITS.maxOldSpaceSizeMb}`,
		// No --permission flag in v1: the out-of-sandbox read-prompt flow is cut
		// (see DESIGN.md); the kernel mounts are the read boundary and fail
		// closed on their own.
		"/worker.mjs",
		String(LIMITS.maxReprBytes),
	);
	return args;
}

/** Spawn the sandboxed worker. fd 3 is the dedicated protocol channel. */
export function spawnWorker(spec: WorkerLaunchSpec): ChildProcess {
	const args = buildBwrapArgs(spec);
	const child = spawn(spec.bwrapPath, args, {
		// Minimal environment for bwrap itself; --clearenv sanitizes the sandbox side.
		env: { LANG: "C.UTF-8" },
		stdio: ["pipe", "pipe", "pipe", "pipe"],
	});
	return child;
}

/** Default runtime root: a private directory under the OS temp dir. */
export function defaultRuntimeRoot(): string {
	return path.join(os.tmpdir(), "pi-node-tool");
}
