/**
 * Launcher build and cache for the guard sandbox.
 *
 * The two-mode C launcher (launcher.c) is compiled on demand with cc/gcc/clang
 * against the runtime libseccomp.so.2 (no dev package: the ABI is declared by
 * hand in the C source; passing the .so.2 path records the soname, so
 * libseccomp upgrades need no rebuild). The binary is cached across sessions
 * at ${XDG_CACHE_HOME:-~/.cache}/pi-guard/<arch>-<sha256(source + flags)[0:16]>/.
 *
 * Fail closed: a cache directory that is foreign-owned or group/world-writable
 * is refused (reduced mode, with a diagnostic naming the offending path), never
 * executed. Compilation is atomic (temp file + rename) so concurrent sessions
 * cannot observe a partial binary. After a successful compile, sibling
 * <arch>-<hash> dirs older than 7 days are pruned; the current dir and younger
 * siblings are never touched.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	type Stats,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const LAUNCHER_SOURCE_NAME = "launcher.c";
const LIBSECCOMP_CANDIDATES = [
	"/usr/lib/x86_64-linux-gnu/libseccomp.so.2",
	"/lib/x86_64-linux-gnu/libseccomp.so.2",
	"/usr/lib/aarch64-linux-gnu/libseccomp.so.2",
	"/lib/aarch64-linux-gnu/libseccomp.so.2",
	"/usr/lib64/libseccomp.so.2",
	"/usr/local/lib/libseccomp.so.2",
];
const COMPILER_CANDIDATES = ["cc", "gcc", "clang"];
const COMPILE_FLAGS = ["-O2", "-Wall"];
const CACHE_DIR_NAME = "pi-guard";
const PRUNE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Directory of this module (works under ts strip-types and node). */
function moduleDir(): string {
	return path.dirname(fileURLToPath(import.meta.url));
}

/** The launcher C source's absolute path, or null when the file is missing. */
export function launcherSourcePath(): string | null {
	const p = path.join(moduleDir(), LAUNCHER_SOURCE_NAME);
	return existsSync(p) ? p : null;
}

/** Persistent compile cache root, honoring XDG_CACHE_HOME. */
export function defaultCacheRoot(): string {
	const xdg = process.env.XDG_CACHE_HOME;
	const base = xdg && xdg.trim() !== "" ? xdg : path.join(os.homedir(), ".cache");
	return path.join(base, CACHE_DIR_NAME);
}

export interface LauncherCacheKeyOptions {
	cacheRoot?: string;
	arch?: string;
	/** Extra strings (compile flags, ABI constants) mixed into the hash. */
	flags?: string;
}

/** Cache dir for a source text: <root>/<arch>-<sha256(source + flags)[0:16]>. */
export function launcherCachePath(source: string, options: LauncherCacheKeyOptions = {}): string {
	const root = options.cacheRoot ?? defaultCacheRoot();
	const arch = options.arch ?? process.arch;
	const hash = createHash("sha256")
		.update(source)
		.update(options.flags ?? COMPILE_FLAGS.join(" "))
		.digest("hex")
		.slice(0, 16);
	return path.join(root, `${arch}-${hash}`);
}

/** Locate the runtime libseccomp shared object; null when absent. */
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

export interface CompilerProbeOptions {
	probe?: (name: string) => boolean;
	candidates?: readonly string[];
}

/** First compiler candidate whose probe succeeds, tried in order. */
export function resolveCompiler(options: CompilerProbeOptions = {}): string | null {
	const candidates = options.candidates ?? COMPILER_CANDIDATES;
	for (const candidate of candidates) {
		if (options.probe) {
			if (options.probe(candidate)) return candidate;
			continue;
		}
		const r = spawnSync(candidate, ["--version"], { stdio: "ignore", timeout: 5_000 });
		if (r.status === 0) return candidate;
	}
	return null;
}

export interface VerifyOptions {
	/** Stat function, injectable for tests (defaults to statSync). */
	stat?: (p: string) => Stats;
	/** Owner uid the paths must have; defaults to the current uid. */
	uid?: number;
}

/**
 * Verify that a cache path is owned by the current uid and not group or
 * world writable (mode & 0o022 === 0). Returns a diagnostic naming the
 * offending path, or null when fine.
 */
export function verifyCachePathPermissions(p: string, options: VerifyOptions = {}): string | null {
	const stat = options.stat ?? statSync;
	const uid = options.uid ?? process.getuid?.() ?? -1;
	let s: Stats;
	try {
		s = stat(p);
	} catch {
		return `cache path ${p} is not accessible`;
	}
	if (uid >= 0 && s.uid !== uid) {
		return `cache path ${p} is owned by uid ${s.uid}, not the current uid ${uid}; refusing to use it`;
	}
	if ((s.mode & 0o022) !== 0) {
		return `cache path ${p} is group or world writable (mode ${s.mode.toString(8)}); refusing to use it`;
	}
	return null;
}

export interface CompileLauncherOptions extends LauncherCacheKeyOptions {
	/** Source text override (tests); defaults to launcherSourcePath(). */
	source?: string;
	/** Skip compilation and probe; used to force reduced mode in tests. */
	compiler?: string | null;
	/** Stat override for the permission checks. */
	stat?: (p: string) => Stats;
	/** Owner uid override for the permission checks. */
	uid?: number;
}

export interface CompileLauncherResult {
	ok: boolean;
	/** Path to the compiled launcher when ok. */
	launcherPath?: string;
	diagnostic?: string;
}

const BINARY_NAME = "pi-guard-launch";

/**
 * Compile the launcher once per arch + source hash and cache it across
 * sessions, verifying cache permissions before every use. Fails closed with a
 * diagnostic instead of a launcher path (the caller reports reduced mode).
 */
export function compileLauncher(options: CompileLauncherOptions = {}): CompileLauncherResult {
	const srcPath = launcherSourcePath();
	const source = options.source ?? (srcPath !== null ? readFileSync(srcPath, "utf8") : null);
	if (source === null) {
		return {
			ok: false,
			diagnostic:
				`The guard launcher source (${LAUNCHER_SOURCE_NAME}) was not found next to the guard ` +
				"sandbox modules. Reinstall the extension; the sandbox runs in reduced mode without it.",
		};
	}
	const cacheDir = launcherCachePath(source, options);
	const binaryPath = path.join(cacheDir, BINARY_NAME);
	const root = options.cacheRoot ?? defaultCacheRoot();
	const verify: VerifyOptions = { stat: options.stat, uid: options.uid };

	// Existing binary: still verify the whole chain before using it.
	if (existsSync(binaryPath)) {
		for (const p of [root, cacheDir, binaryPath]) {
			const diag = verifyCachePathPermissions(p, verify);
			if (diag) return { ok: false, diagnostic: diag };
		}
		return { ok: true, launcherPath: binaryPath };
	}

	const lib = findLibseccomp();
	if (lib === null) {
		return {
			ok: false,
			diagnostic:
				"libseccomp.so.2 was not found (it provides the syscall policy for the sandbox). " +
				"Install it with: sudo apt install libseccomp2 (Debian/Ubuntu) or the equivalent package. " +
				"The sandbox runs in reduced mode (no seccomp, no overlays) without it.",
		};
	}
	const compiler =
		options.compiler !== undefined
			? options.compiler
			: resolveCompiler();
	if (compiler === null) {
		return {
			ok: false,
			diagnostic:
				"No C compiler was found (tried cc, gcc, clang). The guard launcher is compiled on " +
				"demand; install one with: sudo apt install gcc. The sandbox runs in reduced mode " +
				"(no seccomp, no overlays) without it.",
		};
	}
	// Create the root and version dir 0700 before anything lands in them.
	// Existing dirs are left as-is: the permission check below refuses bad
	// modes instead of silently tightening them.
	try {
		if (!existsSync(root)) {
			mkdirSync(root, { recursive: true, mode: 0o700 });
			chmodSync(root, 0o700);
		}
		if (!existsSync(cacheDir)) {
			mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
			chmodSync(cacheDir, 0o700);
		}
	} catch (err) {
		return { ok: false, diagnostic: `Could not create the launcher cache directory ${cacheDir}: ${String(err)}` };
	}
	for (const p of [root, cacheDir]) {
		const diag = verifyCachePathPermissions(p, verify);
		if (diag) return { ok: false, diagnostic: diag };
	}
	const tmpBinary = path.join(cacheDir, `.${BINARY_NAME}.tmp-${process.pid}`);
	const compile = spawnSync(
		compiler,
		[...COMPILE_FLAGS, "-o", tmpBinary, srcPath ?? LAUNCHER_SOURCE_NAME, lib],
		{ stdio: ["ignore", "ignore", "pipe"], timeout: 30_000, encoding: "utf8" },
	);
	if (compile.error || compile.status !== 0) {
		const detail = String(compile.stderr || compile.error?.message || `exit code ${compile.status}`).trim();
		return {
			ok: false,
			diagnostic: `Compiling the guard launcher failed: ${detail}. The sandbox runs in reduced mode (no seccomp, no overlays).`,
		};
	}
	try {
		renameSync(tmpBinary, binaryPath);
	} catch (err) {
		return { ok: false, diagnostic: `Could not finalize the compiled launcher in ${cacheDir}: ${String(err)}` };
	}
	pruneLauncherCacheSiblings(root, cacheDir);
	return { ok: true, launcherPath: binaryPath };
}

export interface PruneOptions {
	now?: number;
	/** Readdir override for tests. */
	readdir?: (p: string) => string[];
	/** Stat override for tests. */
	stat?: (p: string) => Stats;
	/** Removal override for tests. */
	remove?: (p: string) => void;
}

/**
 * Delete sibling <arch>-<hash> dirs whose mtime is older than 7 days. Never
 * touches the current dir or younger siblings. Errors on individual siblings
 * are ignored (a running session of another guard version may hold them).
 */
export function pruneLauncherCacheSiblings(
	cacheRoot: string,
	keepDirName: string,
	options: PruneOptions = {},
): void {
	const readdir = options.readdir ?? ((p: string) => {
		try {
			return readdirSync(p);
		} catch {
			return [];
		}
	});
	const stat = options.stat ?? statSync;
	const remove = options.remove ?? ((p: string) => rmSync(p, { recursive: true, force: true }));
	const now = options.now ?? Date.now();
	let siblings: string[];
	try {
		siblings = readdir(cacheRoot);
	} catch {
		return;
	}
	for (const entry of siblings) {
		if (entry === keepDirName) continue;
		// Only prune version-dir-shaped siblings of the running arch.
		if (!entry.startsWith(`${process.arch}-`)) continue;
		const full = path.join(cacheRoot, entry);
		let s: Stats;
		try {
			s = stat(full);
		} catch {
			continue;
		}
		if (!s.isDirectory()) continue;
		if (now - s.mtimeMs > PRUNE_AGE_MS) {
			try {
				remove(full);
			} catch {
				/* best effort */
			}
		}
	}
}

/** Realpath that falls back to the input when the path does not resolve. */
export function realpathOrSelf(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
}
