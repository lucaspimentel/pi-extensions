/**
 * Legacy compound-splitting helper retained ONLY for the shell-ast spike's
 * parser-only benchmark (`tools/shell-ast-spike/bench.ts`). Guard no longer
 * splits commands here: bash is projected by `policy/shellast.ts` and pwsh is
 * evaluated as one whole-command step in `policy/decision.ts`. Do not add new
 * callers; this module is slated for deletion once the spike drops it.
 *
 * Ported from extensions/pi-tool-permissions/rules.ts (copied and adapted;
 * that file is never modified or imported by guard).
 *
 * The text-level redirect/timeout helpers moved to shell-text.ts; guard
 * imports them from there directly.
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
