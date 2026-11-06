/**
 * Shared, import-side-free reason classifier for the shell-ast decision diff.
 *
 * It maps the RAW reason string both guard trees emit (old shellsplit-based
 * HEAD, new shell-ast working tree) into one machine vocabulary so the
 * comparator can group transitions by mechanism. It reads reason text only:
 * no guard import, no command import, so either side's runner can use it.
 *
 * Matching is END-ANCHORED, never a plain substring test. The new aggregate
 * wraps a per-step decision as `subcommand '<text>': <terminal reason>`, and
 * `<text>` is command text that can itself contain phrase-like words
 * (`no-op cd`, `read-only host command`, ...); a substring matcher would
 * misclassify a command that merely contains such a phrase. Every reason
 * guard emits is either the terminal string alone or that string as a suffix,
 * so `endsWith` / `$`-anchored regexes are exact.
 */

/** [terminal suffix (string) | $-anchored RegExp, class] in priority order. */
const MATCHERS = [
	// Terminal profile / state answers.
	["workspace locked: host execution is unavailable until /guard ack", "state.workspace-locked"],
	["host shell: unrestricted profile allows everything", "state.unrestricted-allow"],
	["host shell: denied in research (rules are ignored)", "state.research-deny"],
	["degraded research: no command to prove read-only", "state.degraded-research-no-command"],
	["degraded research: only read-only-tier commands run on the host", "state.degraded-research-deny"],
	[" (degraded research)", "state.degraded-research-tier"],

	// Explicit rules (deny/ask win first; the allow forms come later in the
	// pipeline, but class identity is independent of that ordering).
	[/matched (?:HostBash|Pwsh) deny rule '.*'$/, "rule.deny"],
	[/matched (?:HostBash|Pwsh) ask rule '.*'$/, "rule.ask"],
	[/matched redirect-aware allow rule '.*'$/, "rule.allow-redirect"],
	[/matched (?:HostBash|Pwsh) allow rule '.*'$/, "rule.allow"],

	// Old-side structural incompleteness (shellsplit heuristics).
	["complex command could not be split for per-subcommand checks", "old-incomplete.ambiguous-split"],
	["structural command could not be evaluated (loop or case head discarded)", "old-incomplete.structural-head"],
	["no commands after structural stripping", "old-incomplete.no-commands-after-strip"],

	// New-side AST incompleteness causes (shellast.ts CAUSE_REASON).
	["the command uses command substitution", "new-incomplete.command-substitution"],
	["the command uses process substitution", "new-incomplete.process-substitution"],
	["the command runs a step in the background", "new-incomplete.background"],
	["the command uses a grouping construct (loop, conditional, or block)", "new-incomplete.grouped"],
	["the command uses a subshell", "new-incomplete.subshell"],
	["the command uses a heredoc or here-string", "new-incomplete.heredoc"],
	["the command defines a shell function", "new-incomplete.function-definition"],
	["the command uses a shell state-change construct", "new-incomplete.state-change"],
	["the command uses a construct the parser cannot evaluate", "new-incomplete.unrecognized-node"],
	["the command could not be parsed as a shell command", "new-incomplete.parse-error"],
	["the command is too large to parse", "new-incomplete.size-cap"],
	["the bash parser is unavailable", "new-incomplete.parser-unavailable"],
	["the command contains no executable command", "new-incomplete.no-command"],

	// Redirect gate and pwsh malformed.
	["file redirect requires a redirect-aware allow rule (a pattern containing '>')", "redirect.required"],
	["the PowerShell command has an unterminated quote", "pwsh.malformed"],

	// Tightened read-only tier.
	["read-only host command (tightened tier)", "tier.readonly"],
	["no-op cd", "tier.noop-cd"],
	["pure shell variable assignment", "tier.assignment"],
	[/validated read-only \S+ \(bashValidators\.[a-z0-9-]+\)$/i, "tier.validator"],

	// Profile cells.
	["host shell: yolo allows everything else", "cell.yolo-allow"],
	["host shell: allowed in this profile", "cell.allow"],
	["host shell: prompts in this profile", "cell.prompt"],
	["host shell: denied in this profile", "cell.deny"],
	["host shell: screened by the classifier in auto profile", "cell.classify"],
];

/** Classify a decision reason; empty/unknown reasons fall back to "unknown". */
export function reasonClass(reason) {
	if (typeof reason !== "string" || reason.length === 0) return "unknown";
	for (const [needle, cls] of MATCHERS) {
		if (typeof needle === "string") {
			if (reason.endsWith(needle)) return cls;
		} else if (needle.test(reason)) {
			return cls;
		}
	}
	return "unknown";
}

export function isNewIncomplete(cls) {
	return typeof cls === "string" && cls.startsWith("new-incomplete.");
}

export function isOldIncomplete(cls) {
	return typeof cls === "string" && cls.startsWith("old-incomplete.");
}

export function isRule(cls) {
	return typeof cls === "string" && cls.startsWith("rule.");
}

export function isTier(cls) {
	return typeof cls === "string" && cls.startsWith("tier.");
}

export function isCell(cls) {
	return typeof cls === "string" && cls.startsWith("cell.");
}

/** Human group label for a reason class, used by the report tables. */
export function reasonGroup(cls) {
	if (isNewIncomplete(cls)) return "new-incomplete";
	if (isOldIncomplete(cls)) return "old-incomplete";
	const dot = cls.indexOf(".");
	return dot === -1 ? cls : cls.slice(0, dot);
}
