/** Pure, serializable rule-subject projections, not commands to execute. */
export interface ShellSourceSpan {
	/** UTF-8 byte offsets in the continuation-folded, BOM-free parsed source. */
	start: number;
	end: number;
}

export type ShellRuleWord =
	| { kind: "literal"; value: string; source: string; span: ShellSourceSpan }
	| { kind: "dynamic"; source: string; span: ShellSourceSpan }
	/** A word containing unquoted shell expansion syntax, encoded from its source. */
	| { kind: "expanding"; source: string; span: ShellSourceSpan }
	/**
	 * A word whose only expansion is unquoted tilde expansion (`~/x`, `~user/x`,
	 * `~+`, `~-`, or a tilde in an assignment value). It renders as its own
	 * unquoted source spelling, which no `literal`, `dynamic` or `source` word
	 * can produce (a literal containing `~` is always single-quoted, and a
	 * dynamic/source word always keeps `$`, a backtick or parentheses), so a
	 * rule can never reach a quoted or escaped `~` through it. Unlike `expanding`
	 * and `dynamic` words it stays eligible for legacy allow rules: resolving `~`
	 * to a home directory is the one expansion guard accepts as statically
	 * bounded, and the user accepted it as non-active.
	 */
	| { kind: "tilde"; source: string; span: ShellSourceSpan }
	/** Locale/ANSI-C quoting: source-preserving, not a claimed static value. */
	| { kind: "source"; source: string; span: ShellSourceSpan };

export interface ShellAssignmentSubject {
	name: string;
	append: boolean;
	value: ShellRuleWord;
	span: ShellSourceSpan;
}

export interface ShellRedirectSubject {
	descriptor: string | null;
	op: string;
	target: ShellRuleWord;
	span: ShellSourceSpan;
}

export function renderRuleRedirect(redirect: ShellRedirectSubject, previous = false): string {
	return `${redirect.descriptor ?? ""}${redirect.op} ${renderWord(redirect.target, previous)}`;
}

export function renderRuleSubject(
	words: readonly ShellRuleWord[],
	assignments: readonly ShellAssignmentSubject[],
	redirects: readonly ShellRedirectSubject[],
	previous = false,
): string {
	return [
		...assignments.map((a) => `${a.name}${a.append ? "+" : ""}=${renderWord(a.value, previous)}`),
		...words.map((word) => renderWord(word, previous)),
		...redirects.map((redirect) => renderRuleRedirect(redirect, previous)),
	].join(" ");
}

/** Replace call spans, retaining the original compound operators and real newlines. */
export function renderCanonicalJoin(
	source: string,
	calls: readonly { sourceSpan: ShellSourceSpan; subject: string | null }[],
	representable: boolean,
): string | null {
	if (!representable || calls.length === 0 || calls.some((c) => c.subject === null)) return null;
	const bytes = Buffer.from(source, "utf8");
	let end = 0;
	let rendered = "";
	for (const call of calls) {
		if (call.sourceSpan.start < end) return null;
		rendered += bytes.subarray(end, call.sourceSpan.start).toString("utf8") + call.subject;
		end = call.sourceSpan.end;
	}
	return (rendered + bytes.subarray(end).toString("utf8")).trim();
}

export function renderRuleWord(word: ShellRuleWord): string {
	return renderWord(word, false);
}

/**
 * Active shell expansion: kind `expanding` (unquoted glob/brace/extglob
 * spellings, and any word that both carries tilde expansion and a dynamic
 * node, all rendered `@guard:exp:<hex>`) plus kind `dynamic`
 * (ParamExp/CmdSubst/ArithmExp/ProcSubst, including inside double quotes).
 * Kinds `tilde` (unquoted tilde only, rendered verbatim), `source` (inert
 * ANSI-C `$'...'` / locale `$"..."` spellings) and `literal` stay eligible for
 * legacy allow-rule authorization.
 */
export function isActiveExpansionWord(word: ShellRuleWord): boolean {
	return word.kind === "expanding" || word.kind === "dynamic";
}

function renderWord(word: ShellRuleWord, previous: boolean): string {
	// Tilde-only words are the one expanding family a rule may authorize, so
	// they keep their readable unquoted spelling. Sources start with `~` (or
	// carry it inside an assignment value), never the reserved marker prefix.
	if (word.kind === "tilde") return word.source;
	if (word.kind === "expanding") return `@guard:exp:${Buffer.from(word.source, "utf8").toString("hex")}`;
	if (word.kind !== "literal") {
		// Source-preserving dynamic/locale words must not occupy the reserved
		// namespace either. Subjects are projections, not executable shell text.
		return !previous && /^@guard:exp:/i.test(word.source) ? `''${word.source}` : word.source;
	}
	const value = word.value;
	if (value === "") return "''";
	// Reserve the marker namespace: a literal argument must never render as an
	// encoded expanding word, even when the caller supplied the marker itself.
	return (!previous && value.toLowerCase().startsWith("@guard:exp:")) || /[\s'"\\;|&<>(){}\[\]*?!#~$`]/.test(value) ? `'${value.replace(/'/g, "'\\''")}'` : value;
}
