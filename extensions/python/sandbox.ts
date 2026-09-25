/**
 * Sandboxed worker launcher for the python tool.
 *
 * Builds bubblewrap arguments and spawns the persistent Python worker with no
 * shell anywhere: everything is an argv array. Fail-closed diagnostics are
 * produced when dependencies or kernel features are missing; nothing here ever
 * falls back to running Python outside the sandbox.
 *
 * Sandbox layout (sandbox paths are fixed constants):
 *   /workspace  read-only bind of the canonical project directory
 *   /scratch    writable bind of a private host scratch directory
 *   /worker.py  read-only bind of the worker implementation
 *   /tmp        namespace-private tmpfs, TMPDIR points here
 *   /proc       namespace-local procfs (only sandbox processes visible)
 *
 * The host home directory, agent credentials, SSH agent, Docker socket, and
 * host temporary directory are never mounted.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LIMITS } from "./limits.ts";

const BWRAP_CANDIDATES = ["/usr/bin/bwrap", "/usr/local/bin/bwrap", "/bin/bwrap", "/snap/bin/bwrap"];
const SECCOMP_CANDIDATES = [
	"/usr/lib/x86_64-linux-gnu/libseccomp.so.2",
	"/usr/lib/aarch64-linux-gnu/libseccomp.so.2",
	"/lib/x86_64-linux-gnu/libseccomp.so.2",
	"/lib/aarch64-linux-gnu/libseccomp.so.2",
	"/usr/lib/libseccomp.so.2",
	"/lib/libseccomp.so.2",
];

/** Interpreter override for users; never model-controlled. */
export function resolveInterpreter(): string {
	return process.env.PI_PYTHON_TOOL_INTERPRETER || "/usr/bin/python3";
}

export interface DependencyCheck {
	ok: boolean;
	/** Human-readable, actionable diagnostic when ok is false. */
	diagnostic?: string;
	bwrapPath: string | null;
	interpreterPath: string;
}

function mergedUsrLayout(): boolean {
	try {
		return realpathSync("/bin") === realpathSync("/usr/bin");
	} catch {
		return false;
	}
}

function checkLibseccomp(): string | null {
	for (const candidate of SECCOMP_CANDIDATES) {
		if (existsSync(candidate)) return null;
	}
	return null;
}

function findBwrap(): { path: string | null; diagnostic?: string } {
	for (const candidate of BWRAP_CANDIDATES) {
		if (existsSync(candidate)) return { path: candidate };
	}
	// Fall back to PATH lookup without a shell.
	const r = spawnSync("bwrap", ["--version"], { stdio: "ignore", timeout: 5_000 });
	if (r.status === 0) return { path: "bwrap" };
	return {
		path: null,
		diagnostic:
			"bubblewrap was not found. Install it with: sudo apt install bubblewrap (Debian/Ubuntu) " +
			"or the equivalent package for your distribution. The python tool refuses to run " +
			"Python outside the sandbox.",
	};
}

function checkInterpreter(interpreter: string): string | null {
	if (!existsSync(interpreter)) {
		return (
			`Python interpreter not found at ${interpreter}. Install Python 3.10+ (e.g. ` +
			"sudo apt install python3) or set PI_PYTHON_TOOL_INTERPRETER to a Python 3.10+ binary. " +
			"The python tool refuses to run Python outside the sandbox."
		);
	}
	const r = spawnSync(interpreter, ["-I", "-c", "import sys; print(sys.version_info[:2])"], {
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 10_000,
		encoding: "utf8",
	});
	if (r.status !== 0 || typeof r.stdout !== "string") {
		return `Interpreter ${interpreter} failed to run: ${String(r.stderr || r.error || "unknown error").trim()}`;
	}
	const m = r.stdout.trim().match(/^\((\d+),\s*(\d+)\)$/);
	if (!m) return `Interpreter ${interpreter} reported an unparseable version: ${r.stdout.trim()}`;
	const major = Number(m[1]);
	const minor = Number(m[2]);
	if (major < 3 || (major === 3 && minor < 10)) {
		return `Python ${major}.${minor} is too old; the python tool requires Python 3.10 or newer at ${interpreter}.`;
	}
	return null;
}

/**
 * Verify platform and dependencies. This probe runs one short-lived bubblewrap
 * instance that exercises user/mount/pid/ipc/uts/net isolation and the exact
 * flag set used for real launches. It never runs user code.
 */
export function checkDependencies(): DependencyCheck {
	const interpreterPath = resolveInterpreter();
	if (process.platform !== "linux") {
		return {
			ok: false,
			diagnostic: `The python tool requires Linux for its bubblewrap sandbox; this platform is ${process.platform}. It refuses to run Python unsandboxed.`,
			bwrapPath: null,
			interpreterPath,
		};
	}
	const bwrap = findBwrap();
	if (!bwrap.path) {
		return { ok: false, diagnostic: bwrap.diagnostic, bwrapPath: null, interpreterPath };
	}
	const interpDiag = checkInterpreter(interpreterPath);
	if (interpDiag) {
		return { ok: false, diagnostic: interpDiag, bwrapPath: bwrap.path, interpreterPath };
	}
	const seccompDiag = checkLibseccomp();
	if (seccompDiag !== null) {
		return {
			ok: false,
			diagnostic:
				"libseccomp2 was not found; the worker needs it to block network and Unix-socket syscalls. " +
				"Install it with: sudo apt install libseccomp2. The python tool refuses to run without this restriction.",
			bwrapPath: bwrap.path,
			interpreterPath,
		};
	}
	// Kernel probe: namespaces + flags must actually work.
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
	probeArgs.push("--", interpreterPath, "-I", "-S", "-c", "pass");
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
				"user.max_user_namespaces), or an incompatible bubblewrap build. The python tool refuses " +
				"to run Python outside the sandbox.",
			bwrapPath: bwrap.path,
			interpreterPath,
		};
	}
	return { ok: true, bwrapPath: bwrap.path, interpreterPath };
}

export interface WorkerLaunchSpec {
	projectDir: string;
	scratchDir: string;
	workerPath: string;
	bwrapPath: string;
	interpreterPath: string;
	/** Mount the project read-write (allow-edits/yolo permission modes). Default: read-only. */
	writableWorkspace?: boolean;
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

	// Support interpreters outside /usr (e.g. /opt/...) by binding their real
	// directory tree read-only. Never the host root.
	const realInterpreter = (() => {
		try {
			return realpathSync(spec.interpreterPath);
		} catch {
			return spec.interpreterPath;
		}
	})();
	const realDir = path.dirname(realInterpreter);
	if (realDir !== "/usr/bin" && realDir !== "/bin" && existsSync(realDir)) {
		args.push("--ro-bind-try", realDir, realDir);
	}

	// Project (read-only by default; read-write in allow-edits/yolo permission
	// modes, where the user explicitly granted unprompted edits), scratch
	// (writable), worker code (read-only).
	args.push(
		spec.writableWorkspace === true ? "--bind" : "--ro-bind",
		spec.projectDir,
		"/workspace",
		"--bind", spec.scratchDir, "/scratch",
		"--ro-bind", spec.workerPath, "/worker.py",
	);

	// Working directory: relative project writes fail while the mount is
	// read-only; outputs belong under /scratch either way.
	args.push("--chdir", "/workspace");

	// Environment: clear everything inherited, supply only explicit runtime
	// values. No host env vars, secrets, or credentials reach the worker.
	args.push(
		"--clearenv",
		"--setenv", "PATH", "/usr/bin:/bin",
		"--setenv", "HOME", "/scratch",
		"--setenv", "TMPDIR", "/tmp",
		"--setenv", "LANG", "C.UTF-8",
	);

	args.push(
		"--",
		realInterpreter,
		"-I", // isolated mode: ignores PYTHON* env vars and user site dirs
		"-S", // no site: faster startup, no site-packages
		"-B", // no bytecode files written
		"-u", // unbuffered stdout/stderr for streaming capture
		"-X", "utf8",
		"/worker.py",
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
	return path.join(os.tmpdir(), "pi-python-tool");
}
