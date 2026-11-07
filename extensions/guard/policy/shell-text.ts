/**
 * Text-level shell helpers shared by the read-only tier and the shell-ast
 * adapter: stripping trailing harmless redirect clauses and a leading
 * `timeout` wrapper. Kept separate from the parser-based adapter so the
 * substring-level rules are unit-testable on their own and can be reused by
 * the tier's path containment checks.
 *
 * Retained from the retired hand-written shell parser (2026-11-06).
 * All callers import these helpers directly from this module.
 */

/**
 * Conservative breakdown reliability for presentation and rule suggestions.
 * The shell-ast adoption collapses this into the analysis' completeness: a
 * complete analysis is available, an incomplete one is not.
 */
export interface BreakdownReliability {
	available: boolean;
	/** Why the breakdown is unavailable, when it is. */
	reason?: string;
	/** The raw shell fragment that caused the unavailability, when a single
	 *  fragment is identifiable; display-only. */
	offending?: string;
}

/**
 * Strip trailing redirect clauses that are harmless for permission purposes:
 * redirects to `/dev/null` (any fd, append variants, target optionally
 * quoted) and descriptor-to-descriptor dups (`2>&1`, `>&2`, `1>&-`).
 * File-target redirects (`>file`, `>>file`) are left intact so
 * write-detection still fires. `canonicalDescriptors` also accepts the AST
 * renderer's spaced descriptor targets (`2>& 1`), leaving raw Pwsh unchanged.
 */
export function stripTrailingHarmlessRedirects(s: string, canonicalDescriptors = false): string {
	let r = s.replace(/\s+$/, "");
	for (;;) {
		// Descriptor dup: [N]>&M or [N]>&-  (e.g. 2>&1, >&2, 1>&-)
		let m = r.match(canonicalDescriptors ? /(\s+\d*>& *(?:\d+|-))$/ : /(\s+\d*>&(?:\d+|-))$/);
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
