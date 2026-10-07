/**
 * Pure bubblewrap argv builder for the guard sandbox.
 *
 * Sandbox paths are 1:1 with host paths: the workspace, read roots,
 * toolchains, and cache dirs all appear at their real absolute paths. Bind
 * order matters because later binds shadow earlier ones; the order here is the
 * settled design:
 *
 *   1. namespace and lifecycle flags, proc/dev/shm/tmp, /usr (+ merged links)
 *   2. minimal /etc (ld.so.cache, localtime, alternatives, ssl,
 *      ca-certificates, gitconfig) plus the generated passwd/group
 *   3. home tmpfs, granted read roots, toolchains, then cache dirs
 *      (overlays in full mode)
 *   4. staged worker files, workspace, and trusted real-path scratch
 *   5. protected paths (top-level whole entries, nested entries, worktree
 *      common dir), then workspace secret masks
 *   6. hard host exclusions, then final cargo/NuGet credential sanitization
 *   7. launcher bind, chdir, --clearenv plus the allowlisted env, argv tail
 *
 * No shell anywhere: only argv arrays, and only controller-chosen paths.
 */

import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { isWithin, pathAliases, sensitiveHostPaths } from "./host-paths.ts";
import {
	CACHE_OVERLAY_DIRS,
	GUARD_LAUNCH_MOUNT,
	LINUXBREW_ROOT,
	protectedTopLevelNames,
	TOOLCHAIN_HOME_DIRS,
	type LaunchSpec,
	type RlimitSet,
	type WorkspaceMode,
} from "./spec.ts";

/** Sandbox mountpoints read-root binds must never shadow. */
export const RESERVED_MOUNTPOINTS = [
	"/usr",
	"/bin",
	"/lib",
	"/lib64",
	"/sbin",
	"/proc",
	"/dev",
	"/tmp",
	"/etc",
	"/run",
	"/.guard",
];

export interface FilteredReadRoots {
	/** Host paths safe to ro-bind 1:1. */
	mountable: string[];
	/** Roots rejected, with the reason (surfaced in the effective launch). */
	skipped: Array<{ root: string; reason: string }>;
}

/**
 * Filter candidate read roots down to what can safely be mounted read-only
 * 1:1. Skips reserved sandbox mountpoints, roots inside the workspace (already
 * covered by the workspace bind), and roots nested under a shallower kept
 * root. Resolves existing aliases before checking reserved and sensitive
 * locations. A root CONTAINING the workspace is kept: the workspace bind
 * that follows stays writable on top of it.
 */
export function filterMountableReadRoots(
	roots: readonly unknown[],
	workspace: string,
	homePath: string = os.homedir(),
): FilteredReadRoots {
	const excluded = sensitiveHostPaths(homePath);
	const mountable: string[] = [];
	const skipped: Array<{ root: string; reason: string }> = [];
	const seen = new Set<string>();
	const candidates: string[] = [];
	for (const raw of roots) {
		if (typeof raw !== "string") continue;
		const root = raw.trim();
		if (!root.startsWith("/")) {
			if (raw.length > 0) skipped.push({ root: raw, reason: "not an absolute path" });
			continue;
		}
		const aliases = pathAliases(root);
		const normalized = aliases[aliases.length - 1];
		if (aliases.some((alias) => excluded.some((p) => isWithin(alias, p)))) {
			skipped.push({ root: raw, reason: "sensitive host location is never mounted" });
			continue;
		}
		if (normalized === "/") {
			skipped.push({ root: raw, reason: "a bare / would shadow everything" });
			continue;
		}
		candidates.push(normalized);
	}
	candidates.sort((a, b) => (a === b ? 0 : a < b ? -1 : 1));
	for (const root of candidates) {
		if (seen.has(root)) continue;
		seen.add(root);
		const reserved = RESERVED_MOUNTPOINTS.find((m) => root === m || root.startsWith(`${m}/`));
		if (reserved !== undefined) {
			skipped.push({ root, reason: `reserved sandbox mount (${reserved})` });
			continue;
		}
		if (root === workspace || root.startsWith(`${workspace}/`)) {
			skipped.push({ root, reason: "covered by the workspace" });
			continue;
		}
		const covering = mountable.find((kept) => root.startsWith(`${kept}/`));
		// Note: a root containing the workspace is KEPT; the covering check
		// only skips roots nested under an already-kept root.
		if (covering !== undefined) {
			skipped.push({ root, reason: `covered by ${covering}` });
			continue;
		}
		mountable.push(root);
	}
	return { mountable, skipped };
}

/**
 * Interpreter mount strategy, adapted from the node tool: Homebrew installs
 * bind the whole brew root (a self-contained prefix); binaries outside /usr
 * and /home/linuxbrew bind their resolved directory tree. Never the host root.
 */
export function interpreterBinds(targetPath: string): Array<[string, string]> {
	let real: string;
	try {
		real = realpathSync(targetPath);
	} catch {
		return [];
	}
	if (!existsSync(real)) return [];
	if (real.startsWith(`${LINUXBREW_ROOT}/`)) {
		return [[LINUXBREW_ROOT, LINUXBREW_ROOT]];
	}
	const realDir = path.dirname(real);
	if (realDir !== "/usr/bin" && realDir !== "/bin" && existsSync(realDir)) {
		return [[realDir, realDir]];
	}
	return [];
}

/**
 * Resolve a linked git worktree's common dir (the main clone's .git) without
 * spawning anything: read <ws>/.git (a "gitdir: ..." file), then its commondir
 * file when present. Returns null for a normal repository.
 */
export function resolveWorktreeCommonDir(workspace: string): string | null {
	const dotGit = path.join(workspace, ".git");
	let st;
	try {
		st = lstatSync(dotGit);
	} catch {
		return null;
	}
	if (!st.isFile()) return null;
	let content: string;
	try {
		content = readFileSync(dotGit, "utf8");
	} catch {
		return null;
	}
	const m = content.match(/^gitdir:\s*(.+?)\s*$/m);
	if (!m) return null;
	let gitdir = m[1];
	if (!path.isAbsolute(gitdir)) gitdir = path.resolve(workspace, gitdir);
	let commondir: string;
	try {
		const raw = readFileSync(path.join(gitdir, "commondir"), "utf8").trim();
		commondir = path.isAbsolute(raw) ? raw : path.resolve(gitdir, raw);
	} catch {
		// No commondir file: a worktree gitdir lives at <main>/.git/worktrees/<name>
		// and a submodule gitdir at <super>/.git/modules/<name>; two levels up is
		// the owning .git either way.
		commondir = path.dirname(path.dirname(gitdir));
	}
	try {
		if (!lstatSync(commondir).isDirectory()) return null;
	} catch {
		return null;
	}
	return commondir;
}

/** One overlayfs layer prepared by the outer launcher. */
export interface OverlaySpec {
	name: string;
	lower: string;
	upper: string;
	work: string;
	merged: string;
	/** Host (and sandbox, 1:1) path the merged view is bound over. */
	targetPath: string;
}

export interface BwrapContext {
	/** full: launcher tail with seccomp and rlimits; reduced: prlimit or direct. */
	mode: "full" | "reduced";
	/** Compiled launcher binary (ro-bound to /.guard/launch) in full mode. */
	launcherPath: string;
	prlimitPath: string | null;
	/** Real host home path (tmpfs'd, then toolchains bound on top). */
	homePath: string;
	/** Host dir containing the generated passwd and group. */
	etcDir: string;
	/** Sanitized NuGet.Config copy to bind over the original, when it exists. */
	nugetConfigPath: string | null;
	/** Effective workspace mode after any degradation. */
	workspaceMode: WorkspaceMode;
	/** Overlay layers mounted by the outer launcher (full mode only). */
	overlays: OverlaySpec[];
	/** Filtered read roots. */
	readRoots: string[];
	/** Absolute host paths of workspace files to mask with /dev/null. */
	masks: string[];
	/** Absolute host paths of nested protected entries. */
	nestedProtected: string[];
	/** Worktree common dir to bind read-only 1:1, when the workspace is one. */
	worktreeCommonDir: string | null;
	/** Final allowlisted environment. */
	env: Record<string, string>;
	cwd: string;
}

/** Reject overlay option paths that cannot be encoded in the option string. */
function assertOverlayPaths(spec: OverlaySpec): void {
	for (const p of [spec.lower, spec.upper, spec.work, spec.merged]) {
		if (!p.startsWith("/") || p.includes(":") || p.includes(",")) {
			throw new Error(
				`overlay ${spec.name} path ${p} is not usable: overlay paths must be absolute and must not contain ':' or ','`,
			);
		}
	}
}

/** rlimit flags for the inner launcher: --rlimit NAME=VALUE. */
export function innerRlimitArgs(rlimits?: RlimitSet): string[] {
	if (!rlimits) return [];
	const args: string[] = [];
	if (rlimits.as !== undefined) args.push("--rlimit", `as=${rlimits.as}`);
	if (rlimits.fsize !== undefined) args.push("--rlimit", `fsize=${rlimits.fsize}`);
	if (rlimits.nofile !== undefined) args.push("--rlimit", `nofile=${rlimits.nofile}`);
	if (rlimits.core !== undefined) args.push("--rlimit", `core=${rlimits.core}`);
	return args;
}

/** prlimit flags applying the same limits: --as=VALUE etc. */
export function prlimitArgs(rlimits?: RlimitSet): string[] {
	if (!rlimits) return [];
	const args: string[] = [];
	if (rlimits.as !== undefined) args.push(`--as=${rlimits.as}`);
	if (rlimits.fsize !== undefined) args.push(`--fsize=${rlimits.fsize}`);
	if (rlimits.nofile !== undefined) args.push(`--nofile=${rlimits.nofile}`);
	if (rlimits.core !== undefined) args.push(`--core=${rlimits.core}`);
	return args;
}

function mergedUsrLayout(): boolean {
	try {
		return realpathSync("/bin") === realpathSync("/usr/bin");
	} catch {
		return false;
	}
}

/**
 * Build the complete bwrap argv. Throws when an overlay path cannot be
 * encoded (':' or ','), so the launch fails before anything runs.
 */
export function buildBwrapArgs(spec: LaunchSpec, ctx: BwrapContext): string[] {
	for (const o of ctx.overlays) assertOverlayPaths(o);
	const protectedNames = protectedTopLevelNames(spec.protectedPaths);

	const args: string[] = [
		// 1. Namespaces: user (with nested-userns blocking), pid, ipc, uts, net.
		// (bwrap always creates a new mount namespace.)
		"--unshare-user",
		"--disable-userns",
		"--unshare-pid",
		"--unshare-ipc",
		"--unshare-uts",
		"--unshare-net",
		// Lifecycle and privilege hygiene: the pid-1 bwrap process dies with
		// the parent and the whole process group tears down on kill.
		"--die-with-parent",
		"--new-session",
		"--cap-drop",
		"ALL",
		// Minimal device tree and namespace-local procfs (not the host view).
		"--proc",
		"/proc",
		"--dev",
		"/dev",
		"--tmpfs",
		"/dev/shm",
		"--tmpfs",
		"/tmp",
		// Runtime: read-only /usr plus merged-/usr symlinks or classic dirs.
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

	// 2. Minimal /etc: dynamic linker cache, timezone, Debian alternatives
	// (symlink targets such as awk/cc), CA material, system gitconfig, and the
	// generated passwd/group. Nothing else from /etc.
	args.push(
		"--ro-bind-try", "/etc/ld.so.cache", "/etc/ld.so.cache",
		"--ro-bind-try", "/etc/localtime", "/etc/localtime",
		"--ro-bind-try", "/etc/alternatives", "/etc/alternatives",
		"--ro-bind-try", "/etc/ssl", "/etc/ssl",
		"--ro-bind-try", "/etc/ca-certificates", "/etc/ca-certificates",
		"--ro-bind-try", "/etc/gitconfig", "/etc/gitconfig",
		"--ro-bind", path.join(ctx.etcDir, "passwd"), "/etc/passwd",
		"--ro-bind", path.join(ctx.etcDir, "group"), "/etc/group",
	);

	// 3. Home: private and empty first, then granted roots and toolchains.
	// Final hard exclusions cover secrets reintroduced by ancestor grants.
	args.push("--tmpfs", ctx.homePath);
	// Broad roots precede the toolchain/cache mounts and final exclusions.
	for (const root of ctx.readRoots) args.push("--ro-bind-try", root, root);
	for (const dir of TOOLCHAIN_HOME_DIRS) {
		args.push("--ro-bind-try", path.join(ctx.homePath, dir), path.join(ctx.homePath, dir));
	}
	if (existsSync(LINUXBREW_ROOT)) {
		args.push("--ro-bind-try", LINUXBREW_ROOT, LINUXBREW_ROOT);
	}
	// Support a target binary outside /usr and the toolchain dirs above.
	for (const [hostPath, sandboxPath] of interpreterBinds(spec.target[0] ?? "")) {
		args.push("--ro-bind-try", hostPath, sandboxPath);
	}
	// Cache dirs 1:1: per-launch overlays (writes land in the upper layer and
	// are discarded) in full mode, read-only otherwise.
	for (const dir of CACHE_OVERLAY_DIRS) {
		const hostDir = path.join(ctx.homePath, dir);
		const overlay = ctx.overlays.find((o) => o.targetPath === hostDir);
		if (ctx.mode === "full" && overlay) {
			args.push("--bind", overlay.merged, hostDir);
			continue;
		}
		args.push("--ro-bind-try", hostDir, hostDir);
	}
	// extraRoBinds: worker files and similar, read-only.
	for (const [host, sandbox] of spec.extraRoBinds ?? []) {
		args.push("--ro-bind", host, sandbox);
	}

	// 5. Workspace at its real path. In full+overlay mode this is the
	// launcher-mounted merged view; writes land in the upper layer.
	if (ctx.workspaceMode === "rw") {
		args.push("--bind", spec.workspace, spec.workspace);
	} else if (ctx.workspaceMode === "ro") {
		args.push("--ro-bind", spec.workspace, spec.workspace);
	} else {
		const wsOverlay = ctx.overlays.find((o) => o.targetPath === spec.workspace);
		if (ctx.mode === "full" && wsOverlay) {
			args.push("--bind", wsOverlay.merged, spec.workspace);
		} else {
			// Reduced mode degrades overlay to read-only.
			args.push("--ro-bind", spec.workspace, spec.workspace);
		}
	}

	// Trusted runtime scratch: no aliases or caller-selected sandbox destinations.
	for (const [host, sandbox] of spec.extraRwBinds ?? []) {
		if (!path.isAbsolute(host) || host !== sandbox || realpathSync(host) !== host || !statSync(host).isDirectory()) {
			throw new Error("extraRwBinds must bind scratch directories at their real absolute host paths");
		}
		if (sensitiveHostPaths(ctx.homePath).some((p) => isWithin(host, p) || isWithin(p, host))) {
			throw new Error("extraRwBinds must not expose sensitive host locations");
		}
		if (host === "/" || host === ctx.homePath || spec.workspace === host || spec.workspace.startsWith(`${host}/`) ||
			RESERVED_MOUNTPOINTS.some((p) => host === p || p.startsWith(`${host}/`) || (p !== "/tmp" && host.startsWith(`${p}/`)))) {
			throw new Error("extraRwBinds must not shadow workspace, home, or reserved sandbox mounts");
		}
		args.push("--bind", host, sandbox);
	}

	// 6. Protected paths: whole top-level entries (the entire .git included),
	// nested entries from the scan, and the worktree common dir. All
	// read-only; git writes go through host_bash in later steps.
	for (const name of protectedNames) {
		const p = path.join(spec.workspace, name);
		if (existsSync(p)) args.push("--ro-bind", p, p);
	}
	if (ctx.worktreeCommonDir !== null) {
		args.push("--ro-bind", ctx.worktreeCommonDir, ctx.worktreeCommonDir);
	}
	for (const p of ctx.nestedProtected) {
		args.push("--ro-bind", p, p);
	}

	// 7. Secret masks: /dev/null over every matching workspace file.
	// --dev-bind, not --ro-bind: device binds made with ro-bind inside the
	// user namespace are nodev-enforced (reads fail with EACCES); --dev-bind
	// gives real /dev/null semantics (reads empty, writes discarded).
	for (const p of ctx.masks) {
		args.push("--dev-bind", "/dev/null", p);
	}

	// Hard host exclusions run after every broad bind, including workspace
	// and interpreter mounts. Mask both configured locations and real targets.
	const mountedDestinations: string[] = [];
	for (let i = 0; i < args.length; i++) {
		if (["--bind", "--ro-bind", "--ro-bind-try"].includes(args[i])) mountedDestinations.push(args[i + 2]);
	}
	const excludedDirs: string[] = [];
	for (const excluded of sensitiveHostPaths(ctx.homePath).sort((a, b) => a.split(path.sep).length - b.split(path.sep).length)) {
		if (!mountedDestinations.some((root) => isWithin(excluded, root))) continue;
		if (excludedDirs.some((root) => isWithin(excluded, root))) continue;
		if (!existsSync(excluded) || lstatSync(excluded).isSymbolicLink()) continue;
		if (statSync(excluded).isDirectory()) {
			args.push("--tmpfs", excluded, "--remount-ro", excluded);
			excludedDirs.push(excluded);
		} else args.push("--dev-bind", "/dev/null", excluded);
	}
	const canSanitize = (p: string) => !excludedDirs.some((root) => isWithin(p, root)) &&
		!(lstatSync(p).isSymbolicLink() && mountedDestinations.some((root) => isWithin(p, root)));

	// Final credential sanitization cannot be shadowed by a broad read root.
	for (const name of ["credentials", "credentials.toml"]) {
		const cred = path.join(ctx.homePath, ".cargo", name);
		if (existsSync(cred) && statSync(cred).isFile()) {
			for (const alias of pathAliases(cred)) {
				if (canSanitize(alias)) args.push("--dev-bind", "/dev/null", alias);
			}
		}
	}
	if (ctx.nugetConfigPath !== null) {
		const orig = path.join(ctx.homePath, ".nuget", "NuGet", "NuGet.Config");
		for (const alias of pathAliases(orig)) {
			if (canSanitize(alias)) args.push("--ro-bind", ctx.nugetConfigPath, alias);
		}
	}

	// 8. Launcher, working dir, environment, target.
	if (ctx.mode === "full") {
		args.push("--ro-bind", ctx.launcherPath, GUARD_LAUNCH_MOUNT);
	}
	args.push("--chdir", ctx.cwd);
	args.push("--clearenv");
	for (const [key, value] of Object.entries(ctx.env)) {
		args.push("--setenv", key, value);
	}
	args.push("--");
	if (ctx.mode === "full") {
		args.push(GUARD_LAUNCH_MOUNT, "inner", ...innerRlimitArgs(spec.rlimits), "--", ...spec.target);
	} else if (ctx.prlimitPath && spec.rlimits) {
		args.push(ctx.prlimitPath, ...prlimitArgs(spec.rlimits), "--", ...spec.target);
	} else {
		args.push(...spec.target);
	}
	return args;
}

/**
 * Assemble the outer launcher argv (without argv[0]: spawn's program fills
 * that slot): overlay specs, then `--`, then the bwrap path and argv. Used in
 * full mode; reduced mode spawns bwrap directly.
 */
export function buildOuterLauncherArgv(
	overlays: OverlaySpec[],
	bwrapPath: string,
	bwrapArgs: string[],
): string[] {
	for (const o of overlays) assertOverlayPaths(o);
	return [
		"outer",
		...overlays.flatMap((o) => ["--overlay", `${o.lower}:${o.upper}:${o.work}:${o.merged}`]),
		"--",
		bwrapPath,
		...bwrapArgs,
	];
}
