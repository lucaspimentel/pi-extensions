/**
 * Launch-spec types and shared constants for the guard sandbox library.
 *
 * Every guard tool (sandboxed bash, the python and node interpreters) describes
 * what it needs with a LaunchSpec; run.ts turns the spec into a sandboxed
 * process. This module holds the types, the rlimit sets, the default mask and
 * protected-name lists, and the environment allowlist builder.
 *
 * Paths inside the sandbox are 1:1 with host paths: the workspace, read roots,
 * and toolchains all appear at their real absolute paths. There is no
 * /workspace alias.
 */

import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** How the workspace is presented to the sandboxed process. */
export type WorkspaceMode = "rw" | "ro" | "overlay";

/** Resource limits, applied by the launcher (soft = hard). */
export interface RlimitSet {
	as?: number;
	fsize?: number;
	nofile?: number;
	core?: number;
}

/**
 * python: address space 512 MiB, file size 16 MiB, 128 descriptors, no core.
 * Note RLIMIT_AS values are bytes of address space, not RSS.
 */
export const RLIMITS_PYTHON: RlimitSet = {
	as: 512 * 1024 * 1024,
	fsize: 16 * 1024 * 1024,
	nofile: 128,
	core: 0,
};

/**
 * node: V8 reserves large virtual ranges, so it gets 2 GiB of address space.
 */
export const RLIMITS_NODE: RlimitSet = {
	as: 2 * 1024 * 1024 * 1024,
	fsize: 16 * 1024 * 1024,
	nofile: 128,
	core: 0,
};

/**
 * bash/shell targets: no core dumps only. RLIMIT_AS breaks .NET and V8
 * startup (both reserve large virtual address ranges), so there are no
 * address-space, file-size, or descriptor caps; timeouts remain the main
 * runaway guard for shell targets.
 */
export const RLIMITS_SHELL: RlimitSet = {
	core: 0,
};

/** Secret-mask filename patterns (basename globs, `*` wildcard only). */
export const DEFAULT_MASK_PATTERNS: readonly string[] = [
	".env",
	".env.*",
	"*.pem",
	"*.key",
	"*.pfx",
	"*.p12",
	"*.keystore",
	"id_rsa*",
	"id_ecdsa*",
	"id_ed25519*",
	".netrc",
	".npmrc",
	".pypirc",
];

/** Filenames that never match the mask even when a pattern would hit. */
export const DEFAULT_MASK_EXCEPTIONS: readonly string[] = [
	".env.example",
	".env.sample",
	".env.template",
];

/**
 * Top-level workspace entries bound read-only as whole entries (when they
 * exist). The entire .git directory is protected: git writes go through
 * host_bash in later steps.
 */
export const PROTECTED_TOP_LEVEL: readonly string[] = [
	".git",
	".pi",
	".claude",
	".agents",
	".vscode",
	".idea",
	".envrc",
	"AGENTS.md",
	"CLAUDE.md",
	"skills",
];

/**
 * Protected names found anywhere below the workspace top level by the scan
 * (nested repos, submodules, instruction files, direnv scripts).
 */
export const PROTECTED_NESTED_NAMES: readonly string[] = [
	"AGENTS.md",
	"CLAUDE.md",
	".envrc",
	".git",
];

/** Directory names whose contents the discovery scan never descends into. */
export const SCAN_PRUNE_NAMES: readonly string[] = [
	"node_modules",
	"bin",
	"obj",
	"target",
];

/** Sandbox path where the compiled launcher is mounted read-only. */
export const GUARD_LAUNCH_MOUNT = "/.guard/launch";

/**
 * Environment variables that must never be set in the sandbox, not even via
 * extraEnv (WSL interop and the ssh-agent socket are escape hatches).
 */
export const NEVER_ENV_KEYS: readonly string[] = [
	"WSL_INTEROP",
	"WSLENV",
	"SSH_AUTH_SOCK",
];

/**
 * Environment variables the sandbox sets itself; extraEnv must not override
 * any of these.
 */
export const RESERVED_ENV_KEYS: readonly string[] = [
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"TMPDIR",
	"LANG",
	"CARGO_HOME",
	"RUSTUP_HOME",
	"DOTNET_ROOT",
	"DOTNET_CLI_TELEMETRY_OPTOUT",
	"DOTNET_NOLOGO",
	"DOTNET_SKIP_FIRST_TIME_EXPERIENCE",
	"NuGetAudit",
];

/** Toolchain bin dirs that prepended to PATH when they exist under home. */
export const TOOLCHAIN_PATH_DIRS: readonly string[] = [
	".cargo/bin",
	".dotnet",
	".dotnet/tools",
	".local/bin",
];

/** Home-relative cache dirs considered for per-launch cache overlays. */
export const CACHE_OVERLAY_DIRS: readonly string[] = [
	".cargo/registry",
	".cargo/git",
	".nuget/packages",
	".npm",
];

/** Toolchain home dirs bound read-only 1:1 when they exist. */
export const TOOLCHAIN_HOME_DIRS: readonly string[] = [
	".rustup",
	".cargo/bin",
	".dotnet",
	".nvm",
	".local/bin",
];

/** Well-known host prefix bound read-only (Homebrew on this machine). */
export const LINUXBREW_ROOT = "/home/linuxbrew";

/**
 * A launch request. Step 3 builds concrete tools on top of this; the library
 * itself is generic.
 */
export interface LaunchSpec {
	/** Canonical (realpath) host path of the workspace. */
	workspace: string;
	workspaceMode: WorkspaceMode;
	/**
	 * Target argv, e.g. ["bash", "-c", cmd] or an interpreter plus worker
	 * path. Resolved through PATH inside the sandbox.
	 */
	target: string[];
	/** Working directory inside the sandbox (host path, 1:1). Defaults to the workspace. */
	cwd?: string;
	/** Host paths mounted read-only 1:1 (filtered before mounting). */
	readRoots?: string[];
	/** Extra [host, sandbox] bind pairs, e.g. a worker implementation file. */
	extraRoBinds?: Array<[string, string]>;
	/** Added after the allowlisted env; reserved keys are dropped. */
	extraEnv?: Record<string, string>;
	/** Resource limits; use the exported RLIMITS_* constants. */
	rlimits?: RlimitSet;
	/** Extra pipe fds beyond stdio (the python/node protocol uses fd 3). */
	extraFds?: number;
	/**
	 * Per-session runtime directory holding overlays/, quarantine/, etc/,
	 * and nuget/. Defaults to a fresh directory under the runtime root.
	 */
	runtimeDir?: string;
	/** Override the host home path (tests use a fake home). */
	homePath?: string;
	/** Mask filename patterns; defaults to DEFAULT_MASK_PATTERNS. */
	maskPatterns?: string[];
	/** Mask exceptions; defaults to DEFAULT_MASK_EXCEPTIONS. */
	maskExceptions?: string[];
	/** Per-launch cache overlays (full mode only). Default: true. */
	cacheOverlays?: boolean;
}

/** Match a filename against a mask pattern: `*` is a wildcard, everything else literal. */
export function nameMatchesPattern(pattern: string, name: string): boolean {
	const re = `^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")}$`;
	return new RegExp(re).test(name);
}

/** True when the filename must be masked (/dev/null over the file). */
export function isMaskedName(
	name: string,
	patterns: readonly string[] = DEFAULT_MASK_PATTERNS,
	exceptions: readonly string[] = DEFAULT_MASK_EXCEPTIONS,
): boolean {
	if (exceptions.includes(name)) return false;
	return patterns.some((p) => nameMatchesPattern(p, name));
}

export interface BuildEnvOptions {
	/** Real host home path (1:1 inside the sandbox). */
	homePath: string;
	/** Values added last; reserved keys are silently dropped. */
	extraEnv?: Record<string, string>;
	/** Existence probe, injectable for tests. Defaults to existsSync. */
	exists?: (p: string) => boolean;
	/** Username for USER/LOGNAME; defaults to the current user. */
	username?: string;
}

/**
 * Build the sandbox environment allowlist. No inherited variable reaches the
 * sandbox: only the keys below, in this order, then extraEnv. In particular
 * WSL_INTEROP, WSLENV, and SSH_AUTH_SOCK are never set.
 */
export function buildEnv(options: BuildEnvOptions): Record<string, string> {
	const exists = options.exists ?? existsSync;
	const home = options.homePath;
	const username =
		options.username ??
		process.env.USER ??
		process.env.LOGNAME ??
		safeUsername() ??
		"user";
	const pathDirs = TOOLCHAIN_PATH_DIRS.map((d) => path.join(home, d)).filter((d) => exists(d));
	pathDirs.push(LINUXBREW_ROOT + "/.linuxbrew/bin");
	const env: Record<string, string> = {};
	env.PATH = [...pathDirs, "/usr/local/bin:/usr/bin:/bin"].join(":");
	env.HOME = home;
	env.USER = username;
	env.LOGNAME = username;
	env.TMPDIR = "/tmp";
	env.LANG = "C.UTF-8";
	if (exists(path.join(home, ".cargo"))) env.CARGO_HOME = path.join(home, ".cargo");
	if (exists(path.join(home, ".rustup"))) env.RUSTUP_HOME = path.join(home, ".rustup");
	if (exists(path.join(home, ".dotnet"))) {
		env.DOTNET_ROOT = path.join(home, ".dotnet");
	}
	// NuGet vulnerability auditing is off inside the sandbox: offline restores
	// would otherwise stall on the audit fetch and emit NU1900 warnings.
	env.DOTNET_CLI_TELEMETRY_OPTOUT = "1";
	env.DOTNET_NOLOGO = "1";
	env.DOTNET_SKIP_FIRST_TIME_EXPERIENCE = "1";
	env.NuGetAudit = "false";
	if (options.extraEnv) {
		for (const [key, value] of Object.entries(options.extraEnv)) {
			if (RESERVED_ENV_KEYS.includes(key)) continue;
			if (NEVER_ENV_KEYS.includes(key)) continue;
			env[key] = value;
		}
	}
	return env;
}

function safeUsername(): string | null {
	try {
		return os.userInfo().username;
	} catch {
		return null;
	}
}
