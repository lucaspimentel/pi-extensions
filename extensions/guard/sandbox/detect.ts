/**
 * Runtime-mode detection for the guard sandbox.
 *
 *   full     Linux + bwrap + the compiled launcher (overlays, seccomp, rlimits)
 *   reduced  bwrap works but the launcher is unavailable: no seccomp, no
 *            overlays (overlay requests degrade to read-only), rlimits via
 *            prlimit when present
 *   degraded not Linux, no bwrap, or the bwrap namespace probe fails:
 *            spawnSandboxed refuses and the caller runs host execution
 *
 * Fail closed: every missing requirement reports the lower mode with an
 * actionable diagnostic. The result is cached per process; tests reset it with
 * resetSandboxDetection().
 */

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { realpathSync } from "node:fs";
import { GUARD_LAUNCH_MOUNT } from "./spec.ts";
import { compileLauncher } from "./launcher.ts";

const BWRAP_CANDIDATES = ["/usr/bin/bwrap", "/usr/local/bin/bwrap", "/bin/bwrap", "/snap/bin/bwrap"];
const PRLIMIT_CANDIDATES = ["/usr/bin/prlimit", "/usr/local/bin/prlimit", "/bin/prlimit"];
const FD_KNOWN_PATHS = [
	"/usr/bin/fd",
	"/usr/bin/fdfind",
	"/usr/local/bin/fd",
	"/usr/local/bin/fdfind",
	"/home/linuxbrew/.linuxbrew/bin/fd",
	"/home/linuxbrew/.linuxbrew/bin/fdfind",
];

export type SandboxMode = "full" | "reduced" | "degraded";
export type ScannerKind = "fd" | "find";

export interface SandboxDetection {
	mode: SandboxMode;
	diagnostics: string[];
	bwrapPath: string | null;
	launcherPath: string | null;
	prlimitPath: string | null;
	/** fd binary when available; null means the find fallback (or no scanner). */
	fdPath: string | null;
	scanner: ScannerKind | null;
}

export interface DetectOptions {
	/**
	 * Force the launcher to be treated as unavailable (tests): the value
	 * becomes the reduced-mode diagnostic. Cannot force degraded.
	 */
	forceLauncherFailure?: string;
	/** Cache-root override for the launcher compile (tests). */
	cacheRoot?: string;
}

export interface BinaryLookup {
	path: string | null;
	diagnostic?: string;
}

function findBinary(
	candidates: string[],
	pathFallback: string,
	versionArg: string,
	installHint: string,
): BinaryLookup {
	for (const candidate of candidates) {
		if (existsSync(candidate)) return { path: candidate };
	}
	// Fall back to PATH lookup without a shell.
	const r = spawnSync(pathFallback, [versionArg], { stdio: "ignore", timeout: 5_000 });
	if (r.status === 0) return { path: pathFallback };
	return { path: null, diagnostic: installHint };
}

function findBwrap(): BinaryLookup {
	return findBinary(
		BWRAP_CANDIDATES,
		"bwrap",
		"--version",
		"bubblewrap was not found. Install it with: sudo apt install bubblewrap (Debian/Ubuntu) " +
			"or the equivalent package for your distribution.",
	);
}

function findPrlimit(): BinaryLookup {
	return findBinary(
		PRLIMIT_CANDIDATES,
		"prlimit",
		"--version",
		"prlimit was not found; reduced-mode resource limits are unavailable. It is part of " +
			"util-linux: sudo apt install util-linux.",
	);
}

export interface FdLookup {
	path: string | null;
	scanner: ScannerKind | null;
}

/**
 * Locate the fd binary (known paths, then PATH lookups of fd and fdfind).
 * Falls back to find, which is always present on a normal Linux system.
 */
export function findFdScanner(): FdLookup {
	for (const p of FD_KNOWN_PATHS) {
		if (existsSync(p)) return { path: p, scanner: "fd" };
	}
	for (const name of ["fd", "fdfind"]) {
		const r = spawnSync(name, ["--version"], { stdio: "ignore", timeout: 5_000 });
		if (r.status === 0) return { path: name, scanner: "fd" };
	}
	if (existsSync("/usr/bin/find")) return { path: "/usr/bin/find", scanner: "find" };
	const r = spawnSync("find", ["--version"], { stdio: "ignore", timeout: 5_000 });
	if (r.status === 0 || r.error === undefined) return { path: "find", scanner: "find" };
	return { path: null, scanner: null };
}

function mergedUsrLayout(): boolean {
	try {
		return realpathSync("/bin") === realpathSync("/usr/bin");
	} catch {
		return false;
	}
}

/** Namespace and mount flags shared by every bwrap invocation. */
function baseBwrapArgs(): string[] {
	const args = [
		"--unshare-user",
		// Blocks nested user-namespace creation inside the sandbox (this, not
		// seccomp, is what stops unshare -U escapes).
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
		"--tmpfs",
		"/dev/shm",
		"--tmpfs",
		"/tmp",
		"--ro-bind",
		"/usr",
		"/usr",
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
	return args;
}

function runBwrapProbe(bwrapPath: string, extraArgs: string[]): string | null {
	const probe = spawnSync(bwrapPath, [...baseBwrapArgs(), ...extraArgs, "--", "/bin/true"], {
		stdio: ["ignore", "ignore", "pipe"],
		timeout: 15_000,
		encoding: "utf8",
		env: { LANG: "C.UTF-8" },
	});
	if (probe.error || probe.status !== 0) {
		return String(probe.stderr || probe.error?.message || `exit code ${probe.status}`).trim();
	}
	return null;
}

let cached: SandboxDetection | null = null;

/** Forget the cached detection (tests). */
export function resetSandboxDetection(): void {
	cached = null;
}

/**
 * Detect the runtime mode. Expensive on first call (a full-probe sandbox run
 * with a real overlay mount); cached per process afterwards.
 */
export function detectSandboxMode(options: DetectOptions = {}): SandboxDetection {
	// Options-calling probes (tests) bypass the per-process cache.
	const uncached = options.forceLauncherFailure !== undefined || options.cacheRoot !== undefined;
	if (!uncached && cached !== null) return cached;
	const diagnostics: string[] = [];

	if (process.platform !== "linux") {
		return finish({
			mode: "degraded",
			diagnostics: [
				`The guard sandbox requires Linux; this platform is ${process.platform}. ` +
					"Host execution applies (degraded mode).",
			],
			bwrapPath: null,
			launcherPath: null,
			prlimitPath: null,
			fdPath: null,
			scanner: null,
		}, !uncached);
	}

	const bwrap = findBwrap();
	if (!bwrap.path) {
		return finish({
			mode: "degraded",
			diagnostics: [bwrap.diagnostic ?? "bubblewrap was not found."],
			bwrapPath: null,
			launcherPath: null,
			prlimitPath: null,
			fdPath: null,
			scanner: null,
		}, !uncached);
	}

	// Reduced probe: bwrap namespaces, then /bin/true.
	const basicErr = runBwrapProbe(bwrap.path, []);
	if (basicErr !== null) {
		return finish({
			mode: "degraded",
			diagnostics: [
				`Bubblewrap isolation probe failed: ${basicErr}. Common causes: unprivileged user ` +
					"namespaces disabled by the kernel or container runtime (sysctl " +
					"kernel.unprivileged_userns_clone / user.max_user_namespaces).",
			],
			bwrapPath: bwrap.path,
			launcherPath: null,
			prlimitPath: null,
			fdPath: null,
			scanner: null,
		}, !uncached);
	}

	const prlimit = findPrlimit();
	if (!prlimit.path) diagnostics.push(prlimit.diagnostic ?? "prlimit was not found.");

	// Launcher: compile (or reuse) and run the full probe through it.
	let launcherPath: string | null = null;
	if (options.forceLauncherFailure !== undefined) {
		diagnostics.push(options.forceLauncherFailure);
	} else {
		const compiled = compileLauncher({ cacheRoot: options.cacheRoot });
		if (!compiled.ok || !compiled.launcherPath) {
			diagnostics.push(compiled.diagnostic ?? "the guard launcher is unavailable.");
		} else {
			const fullErr = runFullProbe(bwrap.path, compiled.launcherPath);
			if (fullErr !== null) {
				diagnostics.push(
					`Full sandbox probe failed: ${fullErr}. Falling back to reduced mode ` +
						"(no seccomp, no overlays).",
				);
			} else {
				launcherPath = compiled.launcherPath;
			}
		}
	}

	const fd = findFdScanner();
	if (fd.scanner === null) {
		diagnostics.push(
			"Neither fd nor find is available for the secret-mask discovery scan; launches will fail until one is installed.",
		);
	}

	return finish({
		mode: launcherPath !== null ? "full" : "reduced",
		diagnostics,
		bwrapPath: bwrap.path,
		launcherPath,
		prlimitPath: prlimit.path,
		fdPath: fd.path,
		scanner: fd.scanner,
	}, !uncached);
}

function finish(result: SandboxDetection, cacheable: boolean): SandboxDetection {
	if (cacheable) cached = result;
	return result;
}

/**
 * Full probe: outer launcher mounts a tiny overlay, bwrap binds it 1:1, the
 * inner launcher installs seccomp and rlimits, and /bin/true exits 0.
 */
function runFullProbe(bwrapPath: string, launcherPath: string): string | null {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-guard-probe-"));
	try {
		const lower = path.join(tmp, "lower");
		const upper = path.join(tmp, "upper");
		const work = path.join(tmp, "work");
		const merged = path.join(tmp, "merged");
		for (const d of [lower, upper, work, merged]) {
			mkdirSync(d, { recursive: true, mode: 0o700 });
			chmodSync(d, 0o700);
		}
		// The probe runs the real chain: outer overlay mount, bwrap namespaces,
		// inner seccomp + rlimits, target exit 0.
		const argv = [
			launcherPath,
			"outer",
			"--overlay",
			`${lower}:${upper}:${work}:${merged}`,
			"--",
			bwrapPath,
			...baseBwrapArgs(),
			"--bind",
			merged,
			merged,
			"--ro-bind",
			launcherPath,
			GUARD_LAUNCH_MOUNT,
			"--",
			GUARD_LAUNCH_MOUNT,
			"inner",
			"--rlimit",
			"core=0",
			"--",
			"/bin/true",
		];
		const probe = spawnSync(launcherPath, argv.slice(1), {
			stdio: ["ignore", "ignore", "pipe"],
			timeout: 20_000,
			encoding: "utf8",
			env: { LANG: "C.UTF-8" },
		});
		if (probe.error || probe.status !== 0) {
			return String(probe.stderr || probe.error?.message || `exit code ${probe.status}`).trim();
		}
		return null;
	} finally {
		try {
			// overlayfs leaves work/work mode 000; make it removable.
			chmodTree(tmp);
			rmSync(tmp, { recursive: true, force: true });
		} catch {
			/* best effort */
		}
	}
}

/** Best-effort recursive chmod so overlay work dirs can be removed. */
export function chmodTree(dir: string): void {
	// chmod before readdir: overlayfs leaves work/work mode 000, which cannot
	// even be listed until it is chmod'ed (ownership alone is enough).
	try {
		fs.chmodSync(dir, 0o700);
	} catch {
		/* ignore */
	}
	let entries: fs.Dirent[] = [];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const e of entries) {
		const full = path.join(dir, e.name);
		if (e.isDirectory()) {
			chmodTree(full);
		} else {
			try {
				fs.chmodSync(full, 0o600);
			} catch {
				/* ignore */
			}
		}
	}
}
