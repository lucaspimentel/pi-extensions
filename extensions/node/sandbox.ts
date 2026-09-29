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
 * ever mounted either.
 *
 * Syscall policy: the worker runs under the same libseccomp policy as the
 * python tool (socket, socketpair, ptrace, bpf, and related syscalls blocked
 * with EPERM), installed by the compiled seccomp-launcher (see
 * seccomp-launch.c) that sits between prlimit and the interpreter in the argv
 * tail. A compiled launcher is required because node has no stdlib FFI and
 * `bwrap --seccomp` fails on some kernels (EINVAL from prctl even with a
 * known-good BPF program, while in-sandbox installs work). External network
 * is impossible via the network namespace; with seccomp, socket() itself is
 * rejected before the network matters, including for Unix-domain sockets
 * inside the mounted project or read roots.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { LIMITS } from "./limits.ts";

const BWRAP_CANDIDATES = ["/usr/bin/bwrap", "/usr/local/bin/bwrap", "/bin/bwrap", "/snap/bin/bwrap"];
const PRLIMIT_CANDIDATES = ["/usr/bin/prlimit", "/usr/local/bin/prlimit", "/bin/prlimit"];
/** Compiled-launcher source, next to this module; never committed as a binary. */
const LAUNCHER_SOURCE_NAME = "seccomp-launch.c";
/** Runtime shared object only: no seccomp dev package is required (the API is
 * declared by hand in the C source), matching the python tool's dependency. */
const LIBSECCOMP_CANDIDATES = [
    "/usr/lib/x86_64-linux-gnu/libseccomp.so.2",
    "/lib/x86_64-linux-gnu/libseccomp.so.2",
    "/usr/lib/aarch64-linux-gnu/libseccomp.so.2",
    "/lib/aarch64-linux-gnu/libseccomp.so.2",
    "/usr/lib64/libseccomp.so.2",
    "/usr/local/lib/libseccomp.so.2",
];
const COMPILER_CANDIDATES = ["cc", "gcc", "clang"];

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
	/** Compiled seccomp launcher path (present when ok; null in early failure returns). */
	seccompLauncherPath: string | null;
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

/**
 * Locate the runtime libseccomp shared object (same runtime dependency as the
 * python tool). Known multiarch paths first, then `ldconfig -p` as a fallback
 * for unusual prefixes. No seccomp dev package is needed: the launcher source
 * declares the small libseccomp ABI it uses by hand.
 */
export function findLibseccomp(): string | null {
	for (const candidate of LIBSECCOMP_CANDIDATES) {
		if (existsSync(candidate)) return candidate;
	}
	const r = spawnSync("ldconfig", ["-p"], { encoding: "utf8", timeout: 5_000 });
	if (typeof r.stdout === "string") {
		for (const line of r.stdout.split("\n")) {
			// Format: "	libseccomp.so.2 (libc6,x86-64) => /path/libseccomp.so.2"
			const m = line.match(/libseccomp\.so\.2 .*=> (\/\S+)/);
			if (m) return m[1];
		}
	}
	return null;
}

/** Directory of this module (works under tsx/ts strip-types and node). */
function moduleDir(): string {
	return path.dirname(fileURLToPath(import.meta.url));
}

/** The launcher C source's absolute path, or null when the file is missing. */
export function launcherSourcePath(): string | null {
	const p = path.join(moduleDir(), LAUNCHER_SOURCE_NAME);
	return existsSync(p) ? p : null;
}

/** Persistent compile cache: keyed by arch + content hash so extension
 * updates recompile while different sessions share one binary. */
export function launcherCachePath(source: string): string {
	const hash = createHash("sha256").update(source).digest("hex").slice(0, 16);
	return path.join(os.tmpdir(), "pi-node-tool-cache", `${process.arch}-${hash}`);
}

/** First compiler whose `--version` exits 0, tried in order. */
export function resolveCompiler(): string | null {
	for (const candidate of COMPILER_CANDIDATES) {
		const r = spawnSync(candidate, ["--version"], { stdio: "ignore", timeout: 5_000 });
		if (r.status === 0) return candidate;
	}
	return null;
}

export interface CompileLauncherResult {
	ok: boolean;
	/** Path to the compiled launcher when ok. */
	launcherPath?: string;
	diagnostic?: string;
}

/**
 * Compile the seccomp launcher once per arch + source hash and cache it
 * across sessions. Fails closed: no compiler, missing libseccomp, or a
 * failing compile all return a diagnostic instead of a launcher path (the
 * node tool then reports it and refuses to run, matching the python tool's
 * required-socket-blocking stance). Compilation is atomic (temp file +
 * rename) so concurrent sessions cannot observe a partial binary.
 */
export function compileLauncher(sourceOverride?: string): CompileLauncherResult {
	const srcPath = launcherSourcePath();
	if (srcPath === null) {
		return {
			ok: false,
			diagnostic: `The seccomp launcher source (${LAUNCHER_SOURCE_NAME}) was not found next to the node extension. Reinstall the extension; the node tool refuses to run without its syscall policy.`,
		};
	}
	const source = sourceOverride ?? readFileSync(srcPath, "utf8");
	const cache = launcherCachePath(source);
	const binaryPath = path.join(cache, "seccomp-launch");
	try {
		statSync(binaryPath);
		return { ok: true, launcherPath: binaryPath };
	} catch {
		// Not compiled yet (or the source changed): fall through to compile.
	}
	const lib = findLibseccomp();
	if (lib === null) {
		return {
			ok: false,
			diagnostic:
				"libseccomp.so.2 was not found (it provides the syscall policy for the node sandbox). " +
				"Install it with: sudo apt install libseccomp2 (Debian/Ubuntu) or the equivalent package. " +
				"The node tool refuses to run without its syscall policy, like the python tool.",
		};
	}
	const compiler = resolveCompiler();
	if (compiler === null) {
		return {
			ok: false,
			diagnostic:
				"No C compiler was found (tried cc, gcc, clang). The node worker's seccomp launcher is " +
				"compiled on demand; install one with: sudo apt install gcc. The node tool refuses to " +
				"run without its syscall policy, like the python tool.",
		};
	}
	try {
		mkdirSync(cache, { recursive: true });
	} catch (err) {
		return { ok: false, diagnostic: `Could not create the launcher cache directory ${cache}: ${String(err)}` };
	}
	const tmpBinary = path.join(cache, `.seccomp-launch.tmp-${process.pid}`);
	const compile = spawnSync(compiler, ["-O2", "-o", tmpBinary, srcPath, lib], {
		stdio: ["ignore", "ignore", "pipe"],
		timeout: 30_000,
		encoding: "utf8",
	});
	if (compile.error || compile.status !== 0) {
		const detail = String(compile.stderr || compile.error?.message || `exit code ${compile.status}`).trim();
		return {
			ok: false,
			diagnostic: `Compiling the seccomp launcher failed: ${detail}. The node tool refuses to run without its syscall policy, like the python tool.`,
		};
	}
	try {
		renameSync(tmpBinary, binaryPath);
	} catch (err) {
		return { ok: false, diagnostic: `Could not finalize the compiled launcher in ${cache}: ${String(err)}` };
	}
	return { ok: true, launcherPath: binaryPath };
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
			seccompLauncherPath: null,
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
		return { ok: false, diagnostic: bwrap.diagnostic, bwrapPath: null, prlimitPath: null, seccompLauncherPath: null, interpreterPath };
	}
	const prlimit = findBinary(
		PRLIMIT_CANDIDATES,
		"prlimit",
		"prlimit was not found. It is part of util-linux; install it with: sudo apt install util-linux. " +
			"The node tool refuses to run without its resource limits.",
	);
	if (!prlimit.path) {
		return { ok: false, diagnostic: prlimit.diagnostic, bwrapPath: bwrap.path, prlimitPath: null, seccompLauncherPath: null, interpreterPath };
	}
	const interpDiag = checkInterpreter(interpreterPath);
	if (interpDiag) {
		return { ok: false, diagnostic: interpDiag, bwrapPath: bwrap.path, prlimitPath: prlimit.path, seccompLauncherPath: null, interpreterPath };
	}
	// Syscall policy: compile (or reuse) the seccomp launcher. Fail closed:
	// like the python tool, socket blocking is a required restriction.
	const launcher = compileLauncher();
	if (!launcher.ok) {
		return {
			ok: false,
			diagnostic: launcher.diagnostic,
			bwrapPath: bwrap.path,
			prlimitPath: prlimit.path,
			seccompLauncherPath: null,
			interpreterPath,
		};
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
	// The launcher cache lives under the host temp dir, which the sandbox's
	// private /tmp tmpfs shadows: bind it 1:1 exactly like a real launch.
	probeArgs.push("--ro-bind", launcher.launcherPath!, "/seccomp-launch");
	probeArgs.push("--", prlimit.path, ...prlimitArgv());
	probeArgs.push("--", "/seccomp-launch");
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
				"user.max_user_namespaces), an incompatible bubblewrap build, or a failing seccomp " +
				"launcher. The node tool refuses to run JavaScript outside the sandbox.",
			bwrapPath: bwrap.path,
			prlimitPath: prlimit.path,
			seccompLauncherPath: null,
			interpreterPath,
		};
	}
	return { ok: true, bwrapPath: bwrap.path, prlimitPath: prlimit.path, seccompLauncherPath: launcher.launcherPath!, interpreterPath };
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
	/** Compiled seccomp launcher: installs the syscall policy, then execs the interpreter. */
	seccompLauncherPath: string;
	interpreterPath: string;
	/** Mount the project read-write (allow-edits/auto/yolo permission modes). Default: read-only. */
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
	"/seccomp-launch",
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

	// Project (read-only by default; read-write in allow-edits/auto/yolo permission
	// modes, where the user explicitly granted unprompted edits), scratch
	// (writable), worker code (read-only).
	args.push(
		spec.writableWorkspace === true ? "--bind" : "--ro-bind",
		spec.projectDir,
		"/workspace",
		"--bind", spec.scratchDir, "/scratch",
		"--ro-bind", spec.workerPath, "/worker.mjs",
		// The seccomp launcher lives under the host temp dir (a compile cache),
		// which the sandbox's private /tmp tmpfs shadows: bind it 1:1 instead.
		"--ro-bind", spec.seccompLauncherPath, "/seccomp-launch",
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

	// Launch through prlimit (the node worker cannot set its own rlimits; no
	// setrlimit API, unlike worker.py's resource module) and then the seccomp
	// launcher, which installs the syscall policy (socket/socketpair/ptrace/...
	// blocked with EPERM) before exec'ing the interpreter. Both survive execve.
	args.push(
		"--",
		spec.prlimitPath,
		...prlimitArgv(),
		"--",
		"/seccomp-launch",
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
