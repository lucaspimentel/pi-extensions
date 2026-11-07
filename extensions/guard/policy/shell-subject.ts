/** Pure, serializable rule-subject projections, not commands to execute. */
export interface ShellSourceSpan {
	/** UTF-8 byte offsets in the continuation-folded, BOM-free parsed source. */
	start: number;
	end: number;
}

export type ShellRuleWord =
	| { kind: "literal"; value: string; source: string; span: ShellSourceSpan }
	| { kind: "dynamic"; source: string; span: ShellSourceSpan }
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

export function renderRuleRedirect(redirect: ShellRedirectSubject): string {
	return `${redirect.descriptor ?? ""}${redirect.op} ${renderRuleWord(redirect.target)}`;
}

export function renderRuleSubject(
	words: readonly ShellRuleWord[],
	assignments: readonly ShellAssignmentSubject[],
	redirects: readonly ShellRedirectSubject[],
): string {
	return [
		...assignments.map((a) => `${a.name}${a.append ? "+" : ""}=${renderRuleWord(a.value)}`),
		...words.map(renderRuleWord),
		...redirects.map(renderRuleRedirect),
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
	if (word.kind !== "literal") return word.source;
	const value = word.value;
	if (value === "") return "''";
	return /[\s'"\\;|&<>(){}\[\]*?!#~$`]/.test(value) ? `'${value.replace(/'/g, "'\\''")}'` : value;
}
