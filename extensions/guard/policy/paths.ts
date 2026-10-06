/**
 * Path normalization helpers shared by the rule engine, the read-only bash
 * tier, and the validators. Ported from extensions/pi-tool-permissions/rules.ts
 * (copied and adapted; that file is never modified or imported by guard).
 * Pure string logic; no filesystem access.
 */

import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export interface PathNormalizationOptions {
	/** Environment used to detect Git Bash, MSYS, or Cygwin. Defaults to process.env. */
	env?: Readonly<Record<string, string | undefined>>;
	/** Home directory used to expand bare `~` and `~/...`. Defaults to HOME or homedir(). */
	home?: string;
}

function isWindowsPosixShell(env: Readonly<Record<string, string | undefined>>): boolean {
	const msystem = (env.MSYSTEM ?? "").toUpperCase();
	const ostype = (env.OSTYPE ?? "").toLowerCase();
	return msystem === "MSYS"
		|| msystem.startsWith("MINGW")
		|| msystem.startsWith("UCRT")
		|| msystem.startsWith("CLANG")
		|| msystem.startsWith("CYGWIN")
		|| ostype.startsWith("msys")
		|| ostype.startsWith("cygwin");
}

function normalizeDrivePrefix(p: string, windowsPosixShell: boolean): string {
	let normalized = p;
	if (windowsPosixShell) {
		const cygwinDrive = normalized.match(/^\/cygdrive\/([A-Za-z])(?:\/(.*))?$/i);
		const msysDrive = normalized.match(/^\/([A-Za-z])(?:\/(.*))?$/);
		const match = cygwinDrive ?? msysDrive;
		if (match) normalized = `${match[1].toUpperCase()}:/${match[2] ?? ""}`;
	}
	return normalized.replace(/^([A-Za-z]):(?=\/|$)/, (_, drive: string) => `${drive.toUpperCase()}:`);
}

function trimTrailingPathSeparators(p: string): string {
	if (p === "/" || /^[A-Za-z]:\/$/.test(p)) return p;
	return p.replace(/\/+$/, "");
}

function isWindowsAbsolutePath(p: string): boolean {
	return /^[A-Za-z]:\//.test(p) || p.startsWith("//");
}

function canonicalizeAbsolutePath(p: string): string {
	if (isWindowsAbsolutePath(p)) return trimTrailingPathSeparators(win32.normalize(p).replace(/\\/g, "/"));
	if (p.startsWith("/")) return trimTrailingPathSeparators(posix.normalize(p));
	return trimTrailingPathSeparators(p);
}

/**
 * Normalize path spelling for permission comparisons and saved rules.
 * In Git Bash, MSYS, or Cygwin, this also expands `~` and converts POSIX drive
 * prefixes such as `/c/...` and `/cygdrive/c/...` to `C:/...` without spawning
 * `cygpath`. Outside those environments, POSIX paths such as `/c/...` are kept.
 */
export function normalizePathSep(p: string, options: PathNormalizationOptions = {}): string {
	const env = options.env ?? process.env;
	const windowsPosixShell = isWindowsPosixShell(env);
	let normalized = p.replace(/\\/g, "/");
	if (windowsPosixShell && (normalized === "~" || normalized.startsWith("~/"))) {
		const rawHome = options.home ?? env.HOME ?? homedir();
		const home = normalizeDrivePrefix(rawHome.replace(/\\/g, "/"), true).replace(/\/+$/, "");
		normalized = home + normalized.slice(1);
	}
	return normalizeDrivePrefix(normalized, windowsPosixShell);
}

/**
 * Normalize a path for permission matching only, never for actual tool execution.
 * Resolves relative paths against cwd with Windows semantics for drive paths and
 * POSIX semantics otherwise, then removes dot segments for safe containment checks.
 */
export function normalizeMatchPath(p: string, cwd: string, options: PathNormalizationOptions = {}): string {
	if (!p) return p;
	const normalized = normalizePathSep(p, options);
	const cwdNormalized = normalizePathSep(cwd, options);
	if (isWindowsAbsolutePath(normalized) || normalized.startsWith("/")) {
		return canonicalizeAbsolutePath(normalized);
	}
	const resolved = isWindowsAbsolutePath(cwdNormalized)
		? win32.resolve(cwdNormalized, normalized).replace(/\\/g, "/")
		: posix.resolve(cwdNormalized, normalized);
	return canonicalizeAbsolutePath(normalizePathSep(resolved, options));
}

/**
 * Normalize one configured path-root entry into a canonical absolute directory
 * root: strip a trailing "/**" glob suffix, expand "~" and "$HOME" prefixes,
 * then resolve (relative entries against cwd) and canonicalize. Returns null
 * for empty entries. Purely string-based, matching the redirect-target
 * canonicalization so "/a/../b" never matches and "/tmpfoo" never matches
 * "/tmp".
 */
export function normalizeRootEntry(entry: string, cwd: string, home: string): string | null {
	if (!entry) return null;
	let e = entry.trim();
	if (!e) return null;
	e = e.replace(/\/\*\*$/, "");
	const h = normalizePathSep(home || homedir());
	// normalizePathSep only expands ~ in MSYS-like shells, so expand ~ and
	// $HOME explicitly here for both platforms.
	if (e === "~" || e.startsWith("~/")) e = h + e.slice(1);
	if (e === "$HOME" || e.startsWith("$HOME/")) e = h + e.slice(5);
	return normalizeMatchPath(e, cwd, { home: h });
}

/**
 * Normalize a list of configured path-root entries (see normalizeRootEntry),
 * preserving order and deduping.
 */
export function normalizeRootList(entries: readonly string[], cwd: string, home: string): string[] {
	const out: string[] = [];
	for (const entry of entries ?? []) {
		const normalized = normalizeRootEntry(entry, cwd, home);
		if (normalized !== null && !out.includes(normalized)) out.push(normalized);
	}
	return out;
}

/**
 * Returns true when `cmd` is a `cd` invocation whose destination resolves to
 * the current working directory, i.e. the command is a no-op in terms of
 * changing directory. Explicit deny rules are checked before this function is
 * consulted, so deny rules always win.
 *
 * Recognised no-op forms:
 *   cd .          cd ./         cd $PWD        cd ${PWD}
 *   cd ~+         cd <absolute-or-relative path that equals cwd>
 *
 * Bare `cd` (no argument) navigates to $HOME, not cwd, so it is NOT matched.
 * Arguments containing unrecognised shell metacharacters are rejected for safety.
 */
export function isNoopCd(cmd: string, cwd: string, options: PathNormalizationOptions = {}): boolean {
	const trimmed = cmd.trim();
	if (!/^cd(\s|$)/.test(trimmed)) return false;

	let arg = trimmed.slice(2).trim();

	// Strip a single pair of surrounding single or double quotes
	if (
		arg.length >= 2 &&
		((arg[0] === "'" && arg[arg.length - 1] === "'") ||
			(arg[0] === '"' && arg[arg.length - 1] === '"'))
	) {
		arg = arg.slice(1, -1).trim();
	}

	// Bare `cd` goes to HOME, not cwd
	if (!arg) return false;

	// Well-known symbolic references to cwd (checked before metachar rejection)
	if (arg === "." || arg === "./" || arg === "$PWD" || arg === "${PWD}" || arg === "~+") return true;

	// Reject if the argument contains shell metacharacters not already handled above
	if (/[`$(){}|&;<>]/.test(arg)) return false;

	// Resolve the destination and cwd through the same canonicalizer so Windows,
	// MSYS, Cygwin, tilde, and mixed-separator spellings compare consistently.
	try {
		const resolved = normalizeMatchPath(arg, cwd, options);
		const cwdNormalized = normalizeMatchPath(".", cwd, options);
		if (isWindowsAbsolutePath(cwdNormalized)) {
			return resolved.toLowerCase() === cwdNormalized.toLowerCase();
		}
		return resolved === cwdNormalized;
	} catch {
		return false;
	}
}
