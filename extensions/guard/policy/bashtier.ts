/**
 * The read-only bash tier: top-level redirect screening, tokenization, the
 * safe-command lists, per-command validators (duckdb/mlr/find/awk), no-op cd,
 * and pure variable assignment detection. Ported from
 * extensions/pi-tool-permissions/rules.ts (copied and adapted; that file is
 * never modified or imported by guard).
 */

import { type PathNormalizationOptions, isNoopCd, normalizeMatchPath, normalizePathSep } from "./paths.ts";

export { isNoopCd };

/**
 * Bash subcommand names that are read-only and never touch the filesystem
 * meaningfully; safe to auto-allow regardless of arguments. The host tier
 * (host_bash and pwsh) additionally vetoes `env`/`printenv` before consulting
 * these lists; see hostTierVetoReason in decision.ts.
 */
const READONLY_BASH_SAFE_ALWAYS = new Set([
	"test", "[", "[[",
	"pwd", "echo", "printf", "date", "whoami", "id", "hostname",
	"uname", "env", "printenv", "true", "false", "which", "type", "command",
	"where", "sleep",
]);

/**
 * Bash subcommand names that are read-only but access filesystem paths.
 * Auto-allowed only when every non-flag argument resolves inside cwd or a
 * read root.
 */
const READONLY_BASH_WITH_PATHS = new Set([
	"ls", "cat", "head", "tail", "wc", "file", "stat", "tree",
	"du", "realpath", "readlink", "dirname", "basename",
	"cut", "jq", "nl",
	"grep", "rg", "fd", "diff", "cmp", "comm",
	"sort", "uniq", "tr", "od", "base64", "md5sum",
]);

/**
 * Strip POSIX shell line-continuations (`\<LF>` and `\<CRLF>`) from a bash
 * command, returning the canonical single-line form.
 *
 * Semantics:
 *   - Outside single quotes, a backslash immediately followed by a newline
 *     (or `\r\n`) is removed entirely, joining the two lines into one.
 *   - Inside single quotes, backslashes are literal: `\<newline>` is preserved.
 *   - Other escape sequences (e.g. `\&`, `\$`) are left untouched.
 */
export function stripLineContinuations(cmd: string): string {
	let out = "";
	let inSingle = false;
	let i = 0;
	while (i < cmd.length) {
		const ch = cmd[i];
		if (ch === "'") {
			inSingle = !inSingle;
			out += ch;
			i++;
			continue;
		}
		if (ch === "\\" && !inSingle) {
			const next = cmd[i + 1];
			if (next === "\n") { i += 2; continue; }
			if (next === "\r" && cmd[i + 2] === "\n") { i += 3; continue; }
			// Non-continuation escape; preserve as-is
			if (next !== undefined) { out += ch + next; i += 2; continue; }
			out += ch; i++; continue;
		}
		out += ch;
		i++;
	}
	return out;
}

/**
 * Read the target of an output redirection beginning at `start` (after
 * skipping spaces/tabs). Returns the index just past the consumed target plus
 * the target text (quotes stripped), or null when there is no target (end of
 * command; conservatively a write). The target is read up to whitespace or a
 * shell separator (`;`, `|`, `&`, `(`, `)`, `<`, `>`) so idioms like
 * `cmd >/dev/null; echo` and `cmd >/dev/null 2>&1` resolve cleanly.
 */
function redirectTargetAt(cmd: string, start: number): { end: number; target: string } | null {
	let j = start;
	while (j < cmd.length && (cmd[j] === " " || cmd[j] === "\t")) j++;
	if (j >= cmd.length) return null; // no target: conservatively a write
	let target = "";
	if (cmd[j] === '"' || cmd[j] === "'") {
		const q = cmd[j];
		j++;
		while (j < cmd.length && cmd[j] !== q) target += cmd[j++];
		if (j < cmd.length) j++; // skip closing quote
	} else {
		while (j < cmd.length && !/[\s;|&()<>]/.test(cmd[j])) target += cmd[j++];
	}
	return { end: j, target };
}

/**
 * Returns true when a redirect `target` is exempt from the write-risk filter
 * because it resolves under one of the configured allowed roots (the config's
 * writeRoots). Both the target and each root are canonicalized (dot segments
 * removed, trailing slashes trimmed) before a containment comparison, so
 * `/tmp/../etc/passwd` does NOT match `/tmp` and `/tmpfoo` does not match
 * `/tmp` either. Comparison is case-insensitive for Windows-style absolute
 * paths. Targets containing unresolvable shell expansions or globs (`$`,
 * backtick, `*`, `?`, `~`) are never exempt. A root of `/` exempts every
 * absolute target.
 */
function redirectTargetAllowed(
	target: string,
	allowTargets: readonly string[],
	cwd: string | undefined,
	options: PathNormalizationOptions = {},
): boolean {
	if (allowTargets.length === 0) return false;
	if (!target || /[$`*?~]/.test(target)) return false;
	const norm = cwd !== undefined && cwd !== ""
		? normalizeMatchPath(target, cwd, options)
		: canonicalizeAbsolutePath(normalizePathSep(target, options));
	const caseInsensitive = isWindowsAbsolutePathNorm(norm);
	const comparable = caseInsensitive ? norm.toLowerCase() : norm;
	for (const root of allowTargets) {
		const rootNorm = canonicalizeAbsolutePath(normalizePathSep(root, options));
		const rootComparable = caseInsensitive ? rootNorm.toLowerCase() : rootNorm;
		if (rootComparable === "/") return true;
		if (comparable === rootComparable) return true;
		if (comparable.startsWith(rootComparable.endsWith("/") ? rootComparable : `${rootComparable}/`)) return true;
	}
	return false;
}

function isWindowsAbsolutePathNorm(p: string): boolean {
	return /^[A-Za-z]:\//.test(p) || p.startsWith("//");
}

/**
 * Returns true when `cmd` contains a top-level *file* output redirection
 * (`>`, `>>`, `2>`, `&>`, `n>>`, ...) outside of single/double quotes,
 * backticks, command substitution (parens), and heredoc bodies.
 * Descriptor-to-descriptor redirects (`2>&1`, `1>&2`, `>&2`, `>&-`, `>>&N`)
 * are NOT file writes and return false. Redirects whose target is exactly
 * `/dev/null` are likewise NOT file writes and return false. Redirects whose
 * target resolves under an allowed root are also non-writes.
 */
export function hasTopLevelFileRedirect(
	cmd: string,
	allowRedirectTargets: readonly string[] = [],
	options: PathNormalizationOptions & { cwd?: string } = {},
): boolean {
	return stripExemptRedirects(cmd, allowRedirectTargets, options) === null;
}

/**
 * Single-pass scanner shared with `hasTopLevelFileRedirect`: walks `cmd` and
 * removes every *exempt* redirect clause (descriptor dups are left in place;
 * `/dev/null` and allowed-target clauses are cut out) from the returned
 * command string. Returns null when a non-exempt top-level *file* redirect
 * exists, i.e. a real write; the caller bails in that case.
 *
 * The stripped return value is what the read-only bash tier tokenizes, so
 * exempt redirect clauses no longer leak into argument checks that resolve
 * paths against cwd.
 */
function stripExemptRedirects(
	cmd: string,
	allowRedirectTargets: readonly string[],
	options: PathNormalizationOptions & { cwd?: string },
): string | null {
	const isExempt = (target: string): boolean =>
		target === "/dev/null" || redirectTargetAllowed(target, allowRedirectTargets, options.cwd, options);
	let out = "";
	let copyStart = 0;
	let inSingle = false;
	let inDouble = false;
	let inBacktick = false;
	let parenDepth = 0;
	// When set, the next top-level newline ends a heredoc opening line and the
	// body (up to the delimiter line) should be skipped so a `>` inside the
	// body is ignored. The opening line itself is scanned normally so a real
	// redirect there (e.g. `cat <<EOF > out.txt`) is still detected.
	let pendingHeredoc: { delimiter: string; stripTabs: boolean } | null = null;
	let i = 0;
	while (i < cmd.length) {
		const ch = cmd[i];
		// Backslash escape: skip next char (not inside single quotes)
		if (ch === "\\" && !inSingle) { i += 2; continue; }
		// Quote / backtick toggles
		if (ch === "'" && !inDouble && !inBacktick) { inSingle = !inSingle; i++; continue; }
		if (ch === '"' && !inSingle && !inDouble) { inDouble = !inDouble; i++; continue; }
		if (ch === "`" && !inSingle && !inDouble) { inBacktick = !inBacktick; i++; continue; }
		if (!inSingle && !inDouble && !inBacktick) {
			// Parenthesis depth: command substitution / subshell. A `>` inside
			// `$(...)` belongs to the inner command, not a top-level redirect.
			if (ch === "(") { parenDepth++; i++; continue; }
			if (ch === ")") { if (parenDepth > 0) parenDepth--; i++; continue; }
			// Heredoc start (`<<` / `<<-`). Parse the delimiter but keep scanning
			// the rest of the opening line normally; the body is skipped at the
			// next top-level newline. `<<<` here-strings and unparseable
			// delimiters fall through to `i += 2`.
			if (ch === "<" && cmd[i + 1] === "<") {
				const stripTabs = cmd[i + 2] === "-";
				let j = i + (stripTabs ? 3 : 2);
				while (j < cmd.length && (cmd[j] === " " || cmd[j] === "\t")) j++;
				let delimiter = "";
				if (cmd[j] === "'" || cmd[j] === '"') {
					const q = cmd[j++];
					while (j < cmd.length && cmd[j] !== q) delimiter += cmd[j++];
					if (j < cmd.length) j++; // skip closing quote
				} else {
					while (j < cmd.length && /[A-Za-z0-9_]/.test(cmd[j])) delimiter += cmd[j++];
				}
				if (delimiter) {
					pendingHeredoc = { delimiter, stripTabs };
					i = j; // continue scanning the rest of the opening line
				} else {
					i += 2; // `<<<` here-string or unparseable: just skip `<<`
				}
				continue;
			}
			// Newline ending a heredoc opening line: skip the body until the
			// closing delimiter line so a `>` inside the body is ignored.
			if (pendingHeredoc && parenDepth === 0 && (ch === "\n" || (ch === "\r" && cmd[i + 1] === "\n"))) {
				const { delimiter, stripTabs } = pendingHeredoc;
				pendingHeredoc = null;
				let k = i + (ch === "\r" ? 2 : 1); // start of body
				let found = false;
				while (k < cmd.length) {
					const lineStart = k;
					let m = k;
					if (stripTabs) { while (m < cmd.length && cmd[m] === "\t") m++; }
					if (cmd.startsWith(delimiter, m)) {
						const after = m + delimiter.length;
						if (after >= cmd.length || cmd[after] === "\n" || cmd[after] === "\r") {
							// closing delimiter line: resume after it (and its newline)
							i = after;
							if (i < cmd.length && cmd[i] === "\r") i++;
							if (i < cmd.length && cmd[i] === "\n") i++;
							found = true;
							break;
						}
					}
					// not the delimiter: skip to end of this body line
					k = lineStart;
					while (k < cmd.length && cmd[k] !== "\n") k++;
					if (k < cmd.length) k++; // consume newline
				}
				if (!found) i = cmd.length; // unterminated heredoc: consume rest
				continue;
			}
			if (parenDepth === 0 && ch === ">") {
				const prev = cmd[i - 1];
				const next = cmd[i + 1];
				const next2 = cmd[i + 2];
				const next3 = cmd[i + 3];
				// `&>` / `&>>`: redirect both stdout+stderr to a file.
				if (prev === "&") {
					const tgtStart = next === ">" ? i + 2 : i + 1;
					const t = redirectTargetAt(cmd, tgtStart);
					if (t && isExempt(t.target)) {
						// Remove the whole clause, including the leading `&` (and any
						// fd digits that cannot follow an `&`-form operator).
						let s = i - 1;
						while (s > 0 && /[0-9]/.test(cmd[s - 1])) s--;
						out += cmd.slice(copyStart, s);
						copyStart = t.end;
						i = t.end;
						continue;
					}
					return null;
				}
				if (next === "&") {
					// `>&N` / `N>&M`: descriptor dup; `>&-`: close. Not a file write.
					if (next2 !== undefined && /[0-9]/.test(next2)) { i += 3; continue; }
					if (next2 === "-") { i += 3; continue; }
					// `>&<other>`: unusual; treat conservatively as a file write.
					return null;
				}
				if (next === ">") {
					// `>>` append. `>>&N` (rare) is a descriptor dup, not a file write.
					if (next2 === "&" && next3 !== undefined && /[0-9]/.test(next3)) { i += 4; continue; }
					const t = redirectTargetAt(cmd, i + 2);
					if (t && isExempt(t.target)) {
						// Remove the whole clause, including any leading fd digits (`2>>`).
						let s = i;
						while (s > 0 && /[0-9]/.test(cmd[s - 1])) s--;
						out += cmd.slice(copyStart, s);
						copyStart = t.end;
						i = t.end;
						continue;
					}
					return null;
				}
				// `> file` / `N> file`: file write. Process substitution `>(...)`
				// targets a subshell, not a path, so it stays a write. Otherwise
				// check for an exempt `/dev/null` target before flagging a write.
				if (next === "(") return null;
				{
					const t = redirectTargetAt(cmd, i + 1);
					if (t && isExempt(t.target)) {
						// Remove the whole clause, including any leading fd digits (`2>`).
						let s = i;
						while (s > 0 && /[0-9]/.test(cmd[s - 1])) s--;
						out += cmd.slice(copyStart, s);
						copyStart = t.end;
						i = t.end;
						continue;
					}
					return null;
				}
			}
		}
		i++;
	}
	return out + cmd.slice(copyStart);
}

/**
 * Simple quote-aware tokenizer for a single shell command (no top-level
 * operators). Strips surrounding single/double quotes from each token;
 * respects backslash escapes.
 */
export function tokenizeSimple(cmd: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let inSingle = false;
	let inDouble = false;
	let i = 0;
	while (i < cmd.length) {
		const ch = cmd[i];
		if (ch === "\\" && !inSingle) {
			if (i + 1 < cmd.length) { current += cmd[i + 1]; i += 2; } else i++;
			continue;
		}
		if (ch === "'" && !inDouble) { inSingle = !inSingle; i++; continue; }
		if (ch === '"' && !inSingle) { inDouble = !inDouble; i++; continue; }
		if ((ch === " " || ch === "\t") && !inSingle && !inDouble) {
			if (current) { tokens.push(current); current = ""; }
			i++;
			continue;
		}
		current += ch;
		i++;
	}
	if (current) tokens.push(current);
	return tokens;
}

/**
 * Returns true when the tokens represent a `set` invocation whose arguments
 * are only shell options: short flags (`-e`), clustered flags (`-euo`), plus
 * forms (`+x`), long options with their values (`-o pipefail`, `+o
 * histexpand`), and an optional trailing `--` end-of-options marker. A bare
 * `set` (no arguments, prints shell variables) is also allowed. Any
 * positional argument (e.g. `set foo`, `set -- foo`, `set $1`) returns false
 * so the command falls through: reject on doubt.
 */
function isSetOptionsOnly(tokens: string[]): boolean {
	const args = tokens.slice(1);
	let prevTakesValue = false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--") {
			// `--` ends option parsing; anything after it is a positional argument
			return i === args.length - 1;
		}
		if (arg.startsWith("-") || arg.startsWith("+")) {
			// Option (or the value of a preceding `-o`/`+o`, also fine either way).
			// An option ending in `o` consumes the next token as its value.
			prevTakesValue = arg.endsWith("o");
			continue;
		}
		// Bare token: only acceptable as the value of a preceding `-o`/`+o`
		if (prevTakesValue) { prevTakesValue = false; continue; }
		return false;
	}
	return true;
}

/**
 * Returns true when `cmd` is a read-only bash subcommand that is safe to
 * auto-allow.
 *
 * Rules:
 *  1. Reject if cmd contains a top-level *file* output redirect. Descriptor
 *     dups like `2>&1` and `/dev/null`/write-root targets stay auto-allowable.
 *  2. If the first token is in READONLY_BASH_SAFE_ALWAYS: allow.
 *  2b. If the first token is `set` and every remaining token is a shell
 *      option: allow. Any positional argument: false.
 *  3. If the first token is in READONLY_BASH_WITH_PATHS: allow only when
 *     every non-flag argument resolves to a path inside (or equal to) cwd or
 *     one of the allowed read roots.
 *  4. Anything else: false.
 */
export function isReadOnlyBashSubcommand(
	cmd: string,
	cwd: string,
	options: PathNormalizationOptions = {},
	allowRedirectTargets: readonly string[] = [],
	readRoots: readonly string[] = [],
): boolean {
	const trimmed = cmd.trim();
	if (!trimmed) return false;
	// Exempt redirect clauses (allowed targets, /dev/null) are stripped from the
	// command before tokenizing so their tokens cannot leak into the path-args
	// check below. A non-exempt top-level file redirect returns null: not read-only.
	const stripped = stripExemptRedirects(trimmed, allowRedirectTargets, { ...options, cwd });
	if (stripped === null) return false;
	const tokens = tokenizeSimple(stripped);
	if (tokens.length === 0) return false;
	const cmdName = tokens[0].toLowerCase();
	if (cmdName === "set") return isSetOptionsOnly(tokens);
	if (READONLY_BASH_SAFE_ALWAYS.has(cmdName)) return true;
	if (READONLY_BASH_WITH_PATHS.has(cmdName)) {
		const pathArgs = tokens.slice(1).filter((t) => t.length > 0 && !t.startsWith("-"));
		// No path args: command implicitly uses cwd, safe
		if (pathArgs.length === 0) return true;
		return pathArgs.every((arg) => pathInsideAllowedRoots(arg, cwd, readRoots, options));
	}
	return false;
}

/**
 * True when path `p` resolves inside (or equal to) `cwd` or one of the given
 * allowed roots, using the same normalization and Windows case-insensitivity
 * as the read-only bash tier. `cwd` is always an implicit first root. Purely
 * string-based: no filesystem access.
 */
export function pathInsideAllowedRoots(p: string, cwd: string, roots: readonly string[], options: PathNormalizationOptions = {}): boolean {
	if (!p) return false;
	// Scheme-like prefixes (`https://`, `s3://`) are never local paths; only a
	// single letter before the colon (a Windows drive) is allowed through.
	const colon = p.indexOf(":");
	if (colon > 1) return false;
	try {
		// Backslash handling by token shape, not by platform: a backslash is a
		// separator only when the token is unambiguously a Windows path (a drive
		// or UNC prefix). For every other token, convert backslashes to slashes
		// but force a RELATIVE interpretation, so '\n' resolves to cwd/n (what
		// bash actually passes) on POSIX and Windows alike. Tokens containing
		// '..' still resolve outside cwd after the conversion.
		const winish = /^[A-Za-z]:(?=\/|$)/.test(p) || p.startsWith("\\\\");
		let candidate = p;
		if (!winish && p.includes("\\")) {
			const slashed = p.replace(/\\/g, "/");
			candidate = slashed.startsWith("/") ? `.${slashed}` : slashed;
		}
		const normalized = normalizeMatchPath(candidate, cwd, options);
		const cwdNorm = normalizeMatchPath(".", cwd, options);
		const caseInsensitive = isWindowsAbsolutePathNorm(cwdNorm);
		const comparable = caseInsensitive ? normalized.toLowerCase() : normalized;
		for (const root of [cwdNorm, ...roots]) {
			const rootNorm = canonicalizeAbsolutePath(normalizePathSep(root, options));
			const rootComparable = caseInsensitive ? rootNorm.toLowerCase() : rootNorm;
			if (rootComparable === "/") return true;
			if (comparable === rootComparable) return true;
			if (comparable.startsWith(rootComparable.endsWith("/") ? rootComparable : `${rootComparable}/`)) return true;
		}
		return false;
	} catch {
		return false;
	}
}

function canonicalizeAbsolutePath(p: string): string {
	if (isWindowsAbsolutePathNorm(p)) return trimTrailing(p).replace(/\\/g, "/");
	if (p.startsWith("/")) return trimTrailing(p);
	return trimTrailing(p);
}

function trimTrailing(p: string): string {
	if (p === "/" || /^[A-Za-z]:\/$/.test(p)) return p;
	return p.replace(/\/+$/, "");
}

/**
 * True when a string plausibly names a file or URL rather than program text:
 * it contains a path separator, a scheme/Windows-drive colon, or ends with a
 * file-extension-like suffix. Used by the validators so real file arguments
 * get a cwd containment check while quoted DSL/SQL fragments pass untouched.
 */
function looksFileish(s: string): boolean {
	if (s.includes("/") || s.includes(":")) return true;
	return /\.[A-Za-z0-9]+$/.test(s);
}

/**
 * Safe duckdb CLI flags. Value is the flag's arity: 0 = boolean toggle,
 * 1 = the next token is the flag's value. Anything not listed here (notably
 * `-f` / `--init`, which execute a script file) fails validation.
 */
const DUCKDB_SAFE_FLAGS: Record<string, 0 | 1> = {
	"-b": 0, "-batch": 0, "--batch": 0,
	"-box": 0, "--box": 0,
	"-csv": 0, "--csv": 0,
	"-column": 0, "--column": 0,
	"-header": 0, "--header": 0,
	"-noheader": 0, "--noheader": 0,
	"-json": 0, "--json": 0,
	"-list": 0, "--list": 0,
	"-line": 0, "--line": 0,
	"-l": 0,
	"-listing": 0, "--listing": 0,
	"-quote": 0, "--quote": 0,
	"-readonly": 0, "--readonly": 0,
	"-no-stdin": 0, "--no-stdin": 0,
	"-no-monitor": 0, "--no-monitor": 0,
	"-help": 0, "--help": 0,
	"-version": 0, "--version": 0,
	"-c": 1, "--command": 1,
	"-nullvalue": 1, "--nullvalue": 1,
};

/**
 * Extract single-quoted SQL string literals, handling doubled `''` escapes.
 * An unterminated literal's remainder is pushed too so a malformed string
 * containing a path still reaches the caller's containment check.
 */
function singleQuotedLiterals(sql: string): string[] {
	const literals: string[] = [];
	let i = 0;
	while (i < sql.length) {
		if (sql[i] !== "'") { i++; continue; }
		let j = i + 1;
		let lit = "";
		while (j < sql.length) {
			if (sql[j] === "'") {
				if (sql[j + 1] === "'") { lit += "'"; j += 2; continue; }
				break;
			}
			lit += sql[j++];
		}
		literals.push(lit);
		i = j + 1;
	}
	return literals;
}

/**
 * Validate a `duckdb` invocation as read-only.
 *
 * Rules:
 *  1. Every flag must be in DUCKDB_SAFE_FLAGS; an unknown flag fails (this
 *     rejects `-f`, `-init`, and anything unvetted).
 *  2. Any non-flag token that is not a flag value fails: a positional
 *     argument to the CLI is a database file opened in read-write mode (a
 *     potential write). This also declines unquoted SQL (`duckdb -c SELECT 1`
 *     leaves a stray positional `1`), which is acceptable: agents quote SQL.
 *  3. The collected SQL must not contain write statements (COPY, EXPORT),
 *     database attach (ATTACH), extension install/load (INSTALL, LOAD, which
 *     are network access), or dot-commands (.output, .open, .import, .read).
 *  4. Every single-quoted string literal must either not look like a path or
 *     resolve inside cwd or one of the allowed read roots (so `FROM 'data.csv'`
 *     passes but `FROM 'https://...'` and `FROM '/etc/passwd'` do not).
 *     Double-quoted identifiers are not paths and are ignored.
 */
function validateReadOnlyDuckdb(tokens: string[], cwd: string, readRoots: readonly string[]): boolean {
	const sqlChunks: string[] = [];
	let valueFor: string | null = null; // flag currently consuming a value token
	for (let i = 1; i < tokens.length; i++) {
		const tok = tokens[i];
		if (valueFor !== null) {
			// `-c`/`--command` values are SQL to scan; `-nullvalue` values are not.
			if (valueFor === "-c" || valueFor === "--command") sqlChunks.push(tok);
			valueFor = null;
			continue;
		}
		if (tok.startsWith("-") && tok.length > 1) {
			const flag = tok.toLowerCase();
			const arity = DUCKDB_SAFE_FLAGS[flag];
			if (arity === undefined) return false; // unknown/unvetted flag
			if (arity === 1) valueFor = flag;
			continue;
		}
		// Positional argument; see rule 2 above.
		return false;
	}
	if (valueFor !== null) return false; // dangling flag value
	if (sqlChunks.length === 0) return false;
	const sql = sqlChunks.join("; ");
	// Writes, database attach, and extension install/load (= network access).
	if (/\b(copy|export|attach|install|load)\b/i.test(sql)) return false;
	// Dot-commands (.output, .open, .import, .read, ...) can redirect I/O.
	if (/(?:^|;|\n)\s*\.[a-z]/i.test(sql)) return false;
	for (const literal of singleQuotedLiterals(sql)) {
		if (looksFileish(literal) && !pathInsideAllowedRoots(literal, cwd, readRoots)) return false;
	}
	return true;
}

/**
 * Validate an `mlr` (Miller) invocation as read-only.
 *
 * Rules:
 *  1. `-f` on the `put`/`filter` verbs loads unscannable DSL from a file and
 *     fails. `-f` on other verbs (`stats1`, `cut`, `sort`, ...) is a field-
 *     name list and is fine. Unknown flags pass; mlr itself errors harmlessly
 *     on them at runtime.
 *  2. `--from` / `--mfrom` name an input file; the value must resolve inside
 *     cwd or one of the allowed read roots.
 *  3. Any other non-flag token (a verb, quoted DSL, or an input file) must
 *     either not look like a path or resolve inside cwd or one of the allowed
 *     read roots. Verbs and typical DSL strings (`'$x > 3'`, `'sum(bytes)'`)
 *     never look file-ish; input files like `data.csv` do and get checked.
 *  4. In-DSL file writes are rejected: `tee`, and `print`/`emit`/`dump` with a
 *     `>` target. Shell-level redirects were already screened before
 *     tokenization.
 *
 * Known false positive: a literal argument containing the word "tee"
 * (e.g. a file named `tee.csv`) declines to ask, which is safe.
 */
function validateReadOnlyMlr(tokens: string[], cwd: string, readRoots: readonly string[]): boolean {
	let currentVerb = "";
	let expectingFile = false; // consuming the value of --from / --mfrom
	for (let i = 1; i < tokens.length; i++) {
		const tok = tokens[i];
		if (expectingFile) {
			if (!pathInsideAllowedRoots(tok, cwd, readRoots)) return false;
			expectingFile = false;
			continue;
		}
		if (tok.startsWith("-") && tok.length > 1) {
			const flag = tok.toLowerCase();
			if (flag === "-f" && (currentVerb === "put" || currentVerb === "filter")) return false;
			if (flag === "--from" || flag === "--mfrom") { expectingFile = true; continue; }
			continue;
		}
		// Non-flag token: a verb, quoted DSL, or an input file.
		currentVerb = tok;
		if (looksFileish(tok) && !pathInsideAllowedRoots(tok, cwd, readRoots)) return false;
	}
	if (expectingFile) return false; // dangling --from value
	const rest = tokens.slice(1).join(" ");
	if (/\btee\b/.test(rest)) return false;
	if (/\b(?:print|emit|dump)\s*>>?\s*["'a-z0-9./]/i.test(rest)) return false;
	return true;
}

/**
 * `find` primaries that write, execute, or destroy. Any of these fails the
 * readonly-find validator outright, no matter where they appear.
 */
const FIND_WRITE_PRIMARIES = new Set([
	"-delete", "-exec", "-execdir", "-ok", "-okdir",
	"-fls", "-fprint", "-fprint0", "-fprintf",
]);

/**
 * `find` primaries that reference a file: the flag's value is an input file
 * (mtime/timestamp reference, not a write target) and must resolve inside
 * cwd or one of the allowed read roots. `-newerXY` with `t` as the second
 * letter (`-newermt 2024-01-01`) takes a timestamp literal instead.
 */
const FIND_FILE_ARG_PRIMARIES = new Set(["-newer", "-anewer", "-cnewer", "-samefile"]);

/**
 * Known read-only `find` primaries. Value is the flag's arity: 0 = takes no
 * argument, 1 = the next token is the primary's value (consumed so values
 * like `-mtime -7` or `-perm -444` are not mistaken for primaries).
 * Intentionally an allowlist: a primary not listed here (including every
 * write/execute primary) fails validation, so newly-added GNU find actions
 * fail safe rather than silently passing. `-fstype` is a harmless filter
 * (it tests the filesystem type), not a mount operation.
 */
const FIND_SAFE_PRIMARIES: Record<string, 0 | 1> = {
	// Global options (may appear before or after the paths).
	"-H": 0, "-L": 0, "-P": 0,
	"-daystart": 0, "-depth": 0, "-d": 0, "-follow": 0, "-mount": 0, "-xdev": 0,
	"-maxdepth": 1, "-mindepth": 1, "-regextype": 1,
	"-warn": 0, "-nowarn": 0, "-noleaf": 0,
	"-help": 0, "--help": 0, "-version": 0, "--version": 0,
	// Tests (all read-only predicates).
	"-amin": 1, "-atime": 1, "-cmin": 1, "-ctime": 1, "-mmin": 1, "-mtime": 1,
	"-empty": 0, "-executable": 0, "-false": 0, "-true": 0,
	"-readable": 0, "-writable": 0,
	"-fstype": 1, "-gid": 1, "-uid": 1, "-group": 1, "-user": 1,
	"-ilname": 1, "-iname": 1, "-inum": 1, "-ipath": 1, "-iregex": 1, "-iwholename": 1,
	"-links": 1, "-lname": 1, "-name": 1, "-nogroup": 0, "-nouser": 0,
	"-path": 1, "-perm": 1, "-regex": 1, "-size": 1, "-type": 1, "-xtype": 1,
	"-used": 1, "-wholename": 1,
	// Actions that only write to stdout.
	"-ls": 0, "-print": 0, "-print0": 0, "-printf": 1, "-prune": 0, "-quit": 0,
	// Operators.
	"-a": 0, "-o": 0, "-and": 0, "-or": 0, "-not": 0,
};

/**
 * Validate a `find` invocation as read-only.
 *
 * Rules:
 *  1. Any write/execute primary fails: `-delete`, `-exec`, `-execdir`,
 *     `-ok`, `-okdir`, and the output-writing primaries.
 *  2. Any unknown primary (an argument starting with `-` that is not in
 *     FIND_SAFE_PRIMARIES or the `-newerXY` family) fails, so newly-added or
 *     platform-specific primaries fail safe rather than passing.
 *  3. Every positional starting path must resolve inside cwd or one of the
 *     allowed read roots (`find / -name x` declines; `find . -name x` passes).
 *  4. The file argument of `-newer`/`-anewer`/`-cnewer`/`-samefile` and the
 *     file variants of `-newerXY` (e.g. `-neweram ref.txt`) must resolve
 *     inside cwd or a read root. The timestamp variants (`-newermt 2024-01-01`)
 *     take a literal timestamp and are not containment-checked.
 */
function validateReadOnlyFind(tokens: string[], cwd: string, readRoots: readonly string[]): boolean {
	// Primary currently consuming a value token, and whether that value is a
	// containment-checked file reference (vs a pattern/timestamp literal).
	let valueFor: string | null = null;
	let valueIsFile = false;
	for (let i = 1; i < tokens.length; i++) {
		const tok = tokens[i];
		if (valueFor !== null) {
			if (valueIsFile && !pathInsideAllowedRoots(tok, cwd, readRoots)) return false;
			valueFor = null;
			valueIsFile = false;
			continue;
		}
		if (tok.startsWith("-") && tok.length > 1) {
			if (FIND_WRITE_PRIMARIES.has(tok)) return false; // write/execute primary
			if (FIND_FILE_ARG_PRIMARIES.has(tok) || /^-newer[aAmcB]$/.test(tok)) {
				valueFor = tok;
				valueIsFile = true; // file reference: containment-check the value
				continue;
			}
			if (/^-newer[aAmcB]t$/.test(tok)) {
				valueFor = tok; // timestamp literal: consume, no containment check
				continue;
			}
			const arity = FIND_SAFE_PRIMARIES[tok];
			if (arity === undefined) return false; // unknown primary: fail safe
			if (arity === 1) valueFor = tok;
			continue;
		}
		// Expression operators are not paths.
		if (tok === "(" || tok === ")" || tok === "!" || tok === ",") continue;
		// Any other unconsumed non-flag token is a positional starting path.
		if (!pathInsideAllowedRoots(tok, cwd, readRoots)) return false;
	}
	if (valueFor !== null) return false; // dangling primary value
	return true;
}

/**
 * Unsafe characters/words in an awk `-v` assignment value. POSIX parses the
 * value as a full assignment expression, so it can invoke functions; only
 * simple constants are allowed.
 */
function isUnsafeAwkAssignmentValue(v: string): boolean {
	if (v.includes("(") || v.includes("`")) return true;
	if (v.includes("|") || v.includes(">")) return true;
	return /\bsystem\b/i.test(v);
}

/**
 * Side-effect vectors inside awk program text (from `-e` or the first
 * positional argument): function calls, input redirection, output
 * redirection/coprocesses, and dynamic code loading.
 */
function awkProgramHasSideEffects(program: string): boolean {
	// system() call.
	if (/\bsystem\s*\(/i.test(program)) return true;
	// getline from a file or command.
	if (/\bgetline\b/.test(program)) return true;
	// gawk dynamic code loading.
	if (/@(?:include|load)\b/.test(program)) return true;
	// Output redirection and coprocesses: `> "file"`, `>> "file"`,
	// `| "cmd"`, `|& "cmd"`. `>` and `|` are also comparison/regex
	// characters, so only reject when followed by a quote or `&` (a
	// redirect target or coprocess command) to avoid rejecting `$1 > 5`
	// or `/<|>/`; the rare false positive just declines to ask.
	if (/[>|]\s*(?="|&)/.test(program)) return true;
	return false;
}

/**
 * Validate an `awk` invocation as read-only.
 *
 * Rules:
 *  1. Flags are whitelist-only: `-F` (field-separator regex), `-v`
 *     (assignment), and `-e` (program text). Attached short forms are
 *     accepted for `-F` (`-F:`) and `-v` (`-vx=3`). `-f`/`-i`/`-l` (program
 *     loaded from a file), `-E`/`--exec`, and any unknown flag fail.
 *  2. A `-v` value must be a simple constant: reject `(`, backtick, `|`,
 *     `>`, or the word `system`.
 *  3. The program text (all `-e` values and the first positional argument)
 *     must not contain side-effect vectors. Missing program text fails.
 *  4. `var=value` positional assignments fail outright.
 *  5. Positional arguments after the program are input files and must
 *     resolve inside cwd or one of the allowed read roots.
 *
 * Known false positives (safe: they decline rather than allow): `>` or `|`
 * followed by a quote inside the program, e.g. the string comparison
 * `$1 > "abc"`, is indistinguishable from output redirection at this
 * granularity and declines.
 */
function validateReadOnlyAwk(tokens: string[], cwd: string, readRoots: readonly string[]): boolean {
	const programs: string[] = [];
	let valueFor: string | null = null; // flag currently consuming a value token
	let sawProgram = false;
	for (let i = 1; i < tokens.length; i++) {
		const tok = tokens[i];
		if (valueFor !== null) {
			if (valueFor === "-e") programs.push(tok);
			else if (valueFor === "-v" && isUnsafeAwkAssignmentValue(tok)) return false;
			// `-F` values are field-separator regexes; safe.
			valueFor = null;
			continue;
		}
		if (tok.startsWith("-") && tok.length > 1) {
			if (tok === "-F" || tok === "-v" || tok === "-e") { valueFor = tok; continue; }
			// Attached short forms: `-F:` (separator) and `-vx=3` (assignment).
			if (/^-F./.test(tok)) continue;
			if (/^-v[A-Za-z_]\w*=/.test(tok) && isUnsafeAwkAssignmentValue(tok.slice(2))) return false;
			return false; // unknown or program-loading flag (-f, -i, -l, -E, --exec, ...)
		}
		// Positional argument.
		if (/^[A-Za-z_]\w*=/.test(tok)) return false; // var=value assignment expression
		if (!sawProgram) {
			programs.push(tok); // first positional is the program text
			sawProgram = true;
			continue;
		}
		// Subsequent positionals are input files.
		if (!pathInsideAllowedRoots(tok, cwd, readRoots)) return false;
	}
	if (valueFor !== null) return false; // dangling flag value
	if (programs.length === 0) return false; // no program text: fail safe
	return programs.every((p) => !awkProgramHasSideEffects(p));
}

type BashValidator = (tokens: string[], cwd: string, readRoots: readonly string[]) => boolean;

/**
 * Built-in per-command bash validators. Each proves that a command whose
 * risk lives inside program text (SQL in `duckdb -c "..."`, DSL in `mlr`
 * verbs) is read-only. Registry keys are the validator names accepted by the
 * guard config's `bashValidators` map.
 */
export const BASH_VALIDATORS: Record<string, BashValidator> = {
	"readonly-duckdb": validateReadOnlyDuckdb,
	"readonly-mlr": validateReadOnlyMlr,
	"readonly-find": validateReadOnlyFind,
	"readonly-awk": validateReadOnlyAwk,
};

/**
 * Sentinel value for validator entries that disable the mapping for that
 * command (e.g. `{ "duckdb": "none" }`). Compared case-sensitively.
 */
export const BASH_VALIDATOR_NONE = "none";

/**
 * Default validator mappings, enabled without any user/project config. They
 * sit at the bottom of the merge (user/project entries win per key) and can
 * be disabled per command with the "none" sentinel.
 */
export const DEFAULT_BASH_VALIDATORS: Record<string, string> = {
	duckdb: "readonly-duckdb",
	mlr: "readonly-mlr",
	find: "readonly-find",
	awk: "readonly-awk",
};

/**
 * Returns a reason string when `cmd` is approved read-only by one of the
 * validators, or null when it is not covered. Fail-open: a null return means
 * the caller continues down the normal decision pipeline and never denies.
 */
export function validatorApprovedBashReason(
	cmd: string,
	cwd: string,
	validators: Record<string, string>,
	allowRedirectTargets: readonly string[] = [],
	readRoots: readonly string[] = [],
): string | null {
	const trimmed = cmd.trim();
	if (!trimmed) return null;
	const stripped = stripExemptRedirects(trimmed, allowRedirectTargets, { cwd });
	if (stripped === null) return null;
	const tokens = tokenizeSimple(stripped);
	if (tokens.length === 0) return null;
	const cmdName = tokens[0].toLowerCase();
	const validatorName = validators[cmdName];
	if (validatorName === undefined) return null;
	const validator = BASH_VALIDATORS[validatorName];
	if (validator === undefined) return null; // unknown validator name: fail open
	return validator(tokens, cwd, readRoots) ? `validated read-only ${cmdName} (bashValidators.${validatorName})` : null;
}

/**
 * Bash builtin keywords that may prefix a pure variable assignment without
 * introducing side-effects (e.g. `export FOO=bar`, `declare -r X=1`).
 */
const ASSIGN_PREFIX_BUILTINS = new Set([
	"export", "local", "readonly", "declare", "typeset",
]);

/**
 * Returns true when `cmd` is a *pure* shell variable assignment: one that
 * performs no command, process, or arithmetic substitution and runs no other
 * command. Detection operates on the RAW command string (quote-aware scan,
 * tokens keep their quotes):
 *  1. Reject if `cmd` contains a top-level *file* output redirection.
 *  2. Quote-aware top-level tokenization preserving each token's original
 *     substring; unmatched quotes: false.
 *  3. Strip an optional leading prefix builtin and its flags.
 *  4. Every remaining token must match `^[A-Za-z_][A-Za-z0-9_]*(\+?=)(.*)$`.
 *     A non-assignment token means a trailing command runs: false.
 *  5. Reject unquoted command separators hidden in an assignment token
 *     (e.g. `X=1;reboot`).
 *  6. Reject side-effect vectors in the RHS: backticks, `$(`, `$((`,
 *     process substitution `<(` / `>(`. Bare `$VAR` / `${VAR}` are allowed.
 */
export function isPureVariableAssignment(
	cmd: string,
	allowRedirectTargets: readonly string[] = [],
	options: PathNormalizationOptions & { cwd?: string } = {},
): boolean {
	const s = cmd.trim();
	if (!s) return false;
	if (hasTopLevelFileRedirect(s, allowRedirectTargets, options)) return false;

	// Quote-aware top-level tokenization that preserves each token's original
	// substring (quotes included) so RHS screening can detect `$(` etc.
	const tokens: string[] = [];
	let cur = "";
	let inSingle = false;
	let inDouble = false;
	let i = 0;
	while (i < s.length) {
		const ch = s[i];
		if (ch === "\\" && !inSingle) {
			// Preserve the escape and the escaped char in the token.
			cur += ch + (s[i + 1] ?? "");
			i += 2;
			continue;
		}
		if (ch === "'" && !inDouble) { inSingle = !inSingle; cur += ch; i++; continue; }
		if (ch === '"' && !inSingle) { inDouble = !inDouble; cur += ch; i++; continue; }
		if ((ch === " " || ch === "\t") && !inSingle && !inDouble) {
			if (cur) { tokens.push(cur); cur = ""; }
			i++;
			continue;
		}
		cur += ch;
		i++;
	}
	if (inSingle || inDouble) return false; // unmatched quote: don't guess
	if (cur) tokens.push(cur);
	if (tokens.length === 0) return false;

	// Strip an optional leading prefix builtin and its flags.
	let start = 0;
	if (ASSIGN_PREFIX_BUILTINS.has(tokens[0])) {
		start = 1;
		while (start < tokens.length && tokens[start].startsWith("-")) start++;
	}
	if (start >= tokens.length) return false; // e.g. bare `declare -p`: not an assignment

	const assignRe = /^[A-Za-z_][A-Za-z0-9_]*\+?=(.*)$/s;
	for (let j = start; j < tokens.length; j++) {
		const tok = tokens[j];
		const m = tok.match(assignRe);
		if (!m) return false; // a non-assignment token means a command runs
		// Reject unquoted command separators in the raw RHS.
		if (hasUnquotedSeparator(m[1])) return false;
		// Strip surrounding quotes from the RHS for side-effect screening.
		let rhs = m[1];
		if (rhs.length >= 2 && ((rhs[0] === '"' && rhs[rhs.length - 1] === '"') || (rhs[0] === "'" && rhs[rhs.length - 1] === "'"))) {
			rhs = rhs.slice(1, -1);
		}
		// Reject any side-effect vector: backtick command substitution,
		// `$(...)` command substitution (also covers `$((...))` arithmetic),
		// or process substitution `>(...)` / `<(...)`.
		if (/`|\$\(|>\(|<\(/.test(rhs)) return false;
	}
	return true;
}

/**
 * Returns true when `s` contains a shell command separator (`;`, `|`, `&`,
 * or a newline) outside single/double quotes (backslash escapes respected).
 * Quoted separators are literal values (e.g. `X="a;b"`), not commands.
 */
function hasUnquotedSeparator(s: string): boolean {
	let inSingle = false;
	let inDouble = false;
	let i = 0;
	while (i < s.length) {
		const ch = s[i];
		if (ch === "\\" && !inSingle) { i += 2; continue; }
		if (ch === "'" && !inDouble) { inSingle = !inSingle; i++; continue; }
		if (ch === '"' && !inSingle) { inDouble = !inDouble; i++; continue; }
		if (!inSingle && !inDouble && (ch === ";" || ch === "|" || ch === "&" || ch === "\n" || ch === "\r")) return true;
		i++;
	}
	return false;
}
