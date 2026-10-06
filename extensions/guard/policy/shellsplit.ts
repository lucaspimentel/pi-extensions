/**
 * Compound shell command splitting and structural-keyword stripping, used to
 * evaluate each subcommand of a && / || / ; / | chain independently. Ported
 * from extensions/pi-tool-permissions/rules.ts (copied and adapted; that file
 * is never modified or imported by guard).
 */

export type SplitResult =
	| { kind: "single"; effectiveCmd?: string }
	| { kind: "compound"; parts: string[] }
	| { kind: "ambiguous" };

/**
 * When a heredoc operator `<<` (or `<<-`) is found at position `pos` in `cmd`,
 * scans forward past the entire heredoc body and returns the index after the
 * closing delimiter line. Returns null if the heredoc cannot be parsed.
 */
function consumeHeredoc(cmd: string, pos: number): number | null {
	const stripTabs = cmd[pos + 2] === "-";
	let j = pos + (stripTabs ? 3 : 2);

	// Skip horizontal whitespace between << and the delimiter
	while (j < cmd.length && (cmd[j] === " " || cmd[j] === "\t")) j++;

	// Parse the delimiter token: may be quoted ('EOF', "EOF") or bare (EOF)
	let delimiter = "";
	if (cmd[j] === "'" || cmd[j] === '"') {
		const q = cmd[j++];
		while (j < cmd.length && cmd[j] !== q) delimiter += cmd[j++];
		if (j < cmd.length) j++; // skip closing quote
	} else {
		while (j < cmd.length && /[A-Za-z0-9_]/.test(cmd[j])) delimiter += cmd[j++];
	}

	if (!delimiter) return null; // cannot determine delimiter: caller treats as normal

	// Advance past the rest of the opening line (up to and including its newline)
	while (j < cmd.length && cmd[j] !== "\n") j++;
	if (j < cmd.length) j++; // consume the newline

	// Scan body lines until we find a line that is exactly the delimiter
	while (j < cmd.length) {
		const lineStart = j;
		if (stripTabs) {
			while (j < cmd.length && cmd[j] === "\t") j++; // skip leading tabs
		}
		// Check whether this line is exactly the delimiter
		if (cmd.startsWith(delimiter, j)) {
			const after = j + delimiter.length;
			if (after >= cmd.length || cmd[after] === "\n" || cmd[after] === "\r" || cmd[after] === ";" || cmd[after] === " " || cmd[after] === "\t") {
				// Return the index right after the delimiter token but do NOT consume
				// the trailing newline (or ';' etc.). Leaving it in the main loop
				// lets splitTopLevelShell treat it as a normal separator.
				return after;
			}
		}
		// Skip to end of this line
		j = lineStart; // reset in case stripTabs moved j
		while (j < cmd.length && cmd[j] !== "\n") j++;
		if (j < cmd.length) j++;
	}

	// Heredoc body ran to EOF without finding the closing delimiter: ambiguous
	return null;
}

/**
 * Splits a shell command on top-level &&, ||, |, ; operators.
 * Respects single quotes, double quotes, backticks, parentheses, and heredocs.
 *
 * Returns:
 *   { kind: "ambiguous" }        : unmatched quote/paren; caller falls back to ask
 *   { kind: "single" }           : no top-level operator found (or case block)
 *   { kind: "compound", parts }  : trimmed, non-empty subcommands
 */
export function splitTopLevelShell(cmd: string): SplitResult {
	// `case` pattern clauses (`foo)`) look like unmatched parens to the splitter.
	// Rather than attempting to parse the block, treat any command containing a
	// top-level `case` keyword as a single unit.
	if (/(?:^|[;&|]\s*|\n\s*)case\s/.test(cmd)) return { kind: "single" };
	const parts: string[] = [];
	let current = "";
	let inSingle = false;
	let inDouble = false;
	let inBacktick = false;
	let parenDepth = 0;
	let foundOperator = false;
	let i = 0;

	while (i < cmd.length) {
		const ch = cmd[i];

		// Backslash escape: skip next char (not inside single quotes).
		// POSIX: \<newline> outside single quotes is a line continuation:
		// both characters are removed.
		if (ch === "\\" && !inSingle) {
			const next = cmd[i + 1];
			if (next === "\n") { i += 2; continue; }
			if (next === "\r" && cmd[i + 2] === "\n") { i += 3; continue; }
			current += ch + (next ?? "");
			i += 2;
			continue;
		}

		// Single-quote toggle (not inside double quotes or backticks)
		if (ch === "'" && !inDouble && !inBacktick) {
			inSingle = !inSingle;
			current += ch;
			i++;
			continue;
		}

		// Double-quote toggle (not inside single quotes or backticks)
		if (ch === '"' && !inSingle && !inBacktick) {
			inDouble = !inDouble;
			current += ch;
			i++;
			continue;
		}

		// Backtick toggle (not inside single or double quotes)
		if (ch === "`" && !inSingle && !inDouble) {
			inBacktick = !inBacktick;
			current += ch;
			i++;
			continue;
		}

		// Parenthesis depth tracking (outside all quotes)
		if (!inSingle && !inDouble && !inBacktick) {
			if (ch === "(") {
				parenDepth++;
				current += ch;
				i++;
				continue;
			}
			if (ch === ")") {
				if (parenDepth <= 0) return { kind: "ambiguous" }; // unmatched )
				parenDepth--;
				current += ch;
				i++;
				continue;
			}
		}

		// Operator detection: only at the top level
		if (!inSingle && !inDouble && !inBacktick && parenDepth === 0) {
			// Heredoc: << or <<-; consume the entire body so its newlines are
			// not split points
			if (ch === "<" && cmd[i + 1] === "<") {
				const end = consumeHeredoc(cmd, i);
				if (end !== null) {
					current += cmd.slice(i, end);
					i = end;
					continue;
				}
				// If we can't parse the heredoc, fall through to the normal
				// newline handler which will mark it ambiguous.
			}

			if (ch === "&" && cmd[i + 1] === "&") {
				parts.push(current.trim());
				current = "";
				i += 2;
				foundOperator = true;
				continue;
			}
			if (ch === "|" && cmd[i + 1] === "|") {
				parts.push(current.trim());
				current = "";
				i += 2;
				foundOperator = true;
				continue;
			}
			if (ch === "|" && cmd[i + 1] !== "|") {
				parts.push(current.trim());
				current = "";
				i++;
				foundOperator = true;
				continue;
			}
			if (ch === ";") {
				parts.push(current.trim());
				current = "";
				i++;
				foundOperator = true;
				continue;
			}
			if (ch === "\n" || (ch === "\r" && cmd[i + 1] === "\n")) {
				parts.push(current.trim());
				current = "";
				i += ch === "\r" ? 2 : 1;
				foundOperator = true;
				continue;
			}
		}

		current += ch;
		i++;
	}

	// Unmatched quote or paren: ambiguous
	if (inSingle || inDouble || inBacktick || parenDepth !== 0) {
		return { kind: "ambiguous" };
	}

	if (!foundOperator) return { kind: "single" };

	const last = current.trim();
	if (last) parts.push(last);

	const nonEmpty = parts.filter((p) => p.length > 0 && !p.trimStart().startsWith("#"));
	if (nonEmpty.length > 1) return { kind: "compound", parts: nonEmpty };
	// When comment-stripping collapsed a multi-part split to one real command,
	// carry that effective command forward so callers don't match against the
	// full comment-prefixed original string.
	if (nonEmpty.length === 1) return { kind: "single", effectiveCmd: nonEmpty[0] };
	return { kind: "single" };
}

/**
 * Strip trailing redirect clauses that are harmless for permission purposes:
 * redirects to `/dev/null` (any fd, append variants, target optionally
 * quoted) and descriptor-to-descriptor dups (`2>&1`, `>&2`, `1>&-`).
 * File-target redirects (`>file`, `>>file`) are left intact so
 * write-detection still fires.
 */
export function stripTrailingHarmlessRedirects(s: string): string {
	let r = s.replace(/\s+$/, "");
	for (;;) {
		// Descriptor dup: [N]>&M or [N]>&-  (e.g. 2>&1, >&2, 1>&-)
		let m = r.match(/(\s+\d*>&(?:\d+|-))$/);
		if (m) { r = r.slice(0, r.length - m[1].length).replace(/\s+$/, ""); continue; }
		// Redirect to /dev/null: [N|&]>>? /dev/null (target optionally quoted)
		m = r.match(/(\s+(?:\d+|&)?>>?\s*(?:"\/dev\/null"|'\/dev\/null'|\/dev\/null))$/);
		if (m) { r = r.slice(0, r.length - m[1].length).replace(/\s+$/, ""); continue; }
		break;
	}
	return r;
}

/**
 * Strip a leading `timeout [OPTION]... DURATION` wrapper from a command,
 * returning the wrapped command for analysis. `timeout` is a pure wrapper: it
 * runs the following command unchanged (bounded in time), so permission
 * decisions should be made about the wrapped command, not the wrapper.
 * Conservative: when the shape does not parse exactly, the input is returned
 * unchanged. Nested wrappers are stripped iteratively.
 */
export function stripTimeoutPrefix(cmd: string): string {
	let s = cmd.replace(/^\s+/, "");
	for (;;) {
		const rest = stripOneTimeout(s);
		if (rest === null) break;
		s = rest;
	}
	return s === cmd.replace(/^\s+/, "") ? cmd : s;
}

/** One pass of the timeout-wrapper strip; null when `s` does not start with a
 * well-formed `timeout [opts] DURATION command...` wrapper. */
function stripOneTimeout(s: string): string | null {
	const tokRe = /\S+/g;
	const first = tokRe.exec(s);
	if (!first || first[0] !== "timeout") return null;
	let m: RegExpExecArray | null;
	// Option tokens (anything starting with `-`), value-taking ones consuming
	// the following token. `--` (end-of-options) is consumed here too.
	for (;;) {
		m = tokRe.exec(s);
		if (m === null) return null; // options/duration ran to end of string
		const t = m[0];
		if (!t.startsWith("-") || t === "-") break;
		if (/^(-k|--kill-after|-s|--signal)$/.test(t)) {
			const v = tokRe.exec(s);
			if (v === null) return null;
		}
	}
	// Duration: one or more NUMBER[UNIT] groups (compound forms like `2m30s`).
	if (!/^(\d+(\.\d+)?[smhdSMHD]?)+$/.test(m[0])) return null;
	// The wrapped command is everything after the duration token, verbatim.
	const rest = s.slice(tokRe.lastIndex).replace(/^\s+/, "");
	return rest.length > 0 ? rest : null;
}

/**
 * Strip leading shell structural keywords from a compound-split subcommand.
 * Returns null when the residue is purely structural (an iteration/case head,
 * a bare keyword, or empty) with no user command to evaluate. Returns the
 * stripped residue when a real command follows a prefix keyword, so a loop
 * like `for x in a b c; do echo $x; done` only prompts on `echo $x`.
 *
 * Pure structural (whole part: null): do, done, then, else, fi, plus
 * iteration heads `for VAR in ...` / `for VAR` / `for ((...))` / `select`.
 * Prefix-strip (keyword stripped, residue re-evaluated): while, until, if,
 * elif, and the leading-keyword forms of do/then/else. A leading `timeout`
 * wrapper is also stripped. Loops iteratively so nested forms collapse.
 */
export function stripStructuralKeywords(part: string): string | null {
	let s = part.trim();
	while (s.length > 0) {
		// `timeout [opts] DURATION` is a pure wrapper around the command that
		// follows: strip it so the inner command is analyzed.
		const noTimeout = stripTimeoutPrefix(s);
		if (noTimeout !== s) { s = noTimeout; continue; }
		// Trailing harmless redirects (e.g. `2>/dev/null`, `2>&1`) on a
		// structural keyword must not turn it into a "command". Strip them for
		// the structural checks only; real commands keep their redirects.
		const core = stripTrailingHarmlessRedirects(s);
		// Pure structural keyword tokens: bare, no arguments
		if (core === "do" || core === "done" || core === "then" || core === "else" || core === "fi") return null;
		// Iteration / case heads: the head itself runs no user command.
		if (/^(for|select)\s+\S+(\s+in\b[^\n]*)?$/.test(core)) return null;
		// Prefix keywords: a command follows; strip the keyword and re-test.
		const prefixMatch = s.match(/^(do|then|else|while|until|if|elif)\s+/);
		if (prefixMatch) { s = s.slice(prefixMatch[0].length); continue; }
		break;
	}
	return s.length > 0 ? s : null;
}
