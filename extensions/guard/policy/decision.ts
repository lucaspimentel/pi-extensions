/**
 * Guard's decision function: a pure, total mapping from (policy state, tool
 * call) to an action with a reason. The auto profile's "classify" cells are
 * resolved through an injected async strategy so the core stays sync and
 * unit-testable; resolveDecision() is the async wrapper the step-3 tools and
 * the observe-only hook (index.ts) use.
 *
 * Principles (docs/guard-design.md):
 *   - The kernel enforces; rules only route. A rule can never make an
 *     unconfined action safe.
 *   - No auto-routing: a sandboxed bash call never resolves to host execution
 *     because of a rule.
 *   - Fail closed: non-interactive prompts collapse to deny.
 *   - Host-shell precedence: deny rules > ask rules > the tightened read-only
 *     tier (host vetoes first) > redirect-aware allow rules > the profile
 *     cell (then the classifier in auto).
 *
 * Host-shell per profile:
 *   research     absolute: rules ignored, deny (degraded host_bash: only
 *                tier-proven read-only commands, allow rules never widen
 *                that set).
 *   default/auto/trusted  deny > ask > tier > redirect-aware allow rules >
 *                cell. A top-level file redirect (outside the writeRoots
 *                exemptions) is allowed ONLY by a redirect-aware rule (one
 *                whose pattern contains ">"); otherwise it prompts.
 *   yolo         deny rules block, ask rules prompt, everything else allows
 *                (no tier or allow-rule evaluation needed).
 *   unrestricted allow (rules ignored).
 */

import {
	DEFAULT_MASK_EXCEPTIONS,
	DEFAULT_MASK_PATTERNS,
	isMaskedName,
	type WorkspaceMode,
} from "../sandbox/spec.ts";
import {
	isNoopCd,
	isPureVariableAssignment,
	isReadOnlyBashSubcommand,
	pathInsideAllowedRoots,
	stripLineContinuations,
	tokenizeSimple,
	validatorApprovedBashReason,
	hasTopLevelFileRedirect,
} from "./bashtier.ts";
import { parseRule, ruleMatches, rulePatternAllowsRedirect, compilePattern } from "./rules.ts";
import { homedir } from "node:os";
import { normalizeMatchPath, normalizeRootList } from "./paths.ts";
import {
	assessBreakdownReliability,
	splitTopLevelShell,
	stripStructuralKeywords,
	stripTimeoutPrefix,
	stripTrailingHarmlessRedirects,
	type BreakdownReliability,
} from "./shellsplit.ts";
import type { ResolvedGuardConfig } from "./config.ts";
import { makeIsProtectedPath } from "./protected.ts";
import {
	exfilRemoteReadCell,
	hostShellCell,
	localReadCell,
	maskReadCell,
	metaCell,
	otherRemoteReadCell,
	remoteWriteCell,
	sandboxedExecCell,
	protectedPathCell,
	workspaceModeForProfile,
	writeEditCell,
	type Profile,
} from "./profiles.ts";

/**
 * A tool call in guard's domain, already mapped through policy/classes.ts.
 * The class is encoded in the kind: sandboxed execution, host shells, local
 * reads/writes, and class-tagged remote calls (exfil-capable web_fetch is
 * its own kind; plain remote reads and remote writes carry the tool name).
 */
export type GuardCall =
	| { kind: "sandboxed-exec"; tool: string; command?: string }
	| { kind: "host-shell"; shell: "host-bash" | "pwsh"; command: string }
	| { kind: "local-read"; tool: string; path?: string }
	| { kind: "local-write"; tool: string; path?: string }
	| { kind: "web-fetch"; url: string }
	| { kind: "remote-read"; tool: string }
	| { kind: "remote-write"; tool: string; input?: Record<string, unknown> }
	| { kind: "meta"; tool: string };

/** Non-sandbox cell actions; "classify" is resolved by the injected strategy. */
export type DecisionAction = "allow" | "prompt" | "deny" | "classify";

export interface Decision {
	action: DecisionAction;
	reason: string;
	/** Explicit ask rules never offer saving an allow rule. */
	provenance?: "explicit-ask" | "fallback";
}

export interface PolicyState {
	profile: Profile;
	config: ResolvedGuardConfig;
	sandboxMode: "full" | "reduced" | "degraded";
	cwd: string;
	/** Set when the audit found lockWrites; step 3 forces workspace ro until /guard ack. */
	workspaceLocked: boolean;
	/** False in print/JSON mode: prompt collapses to deny. */
	interactive: boolean;
}

/** The async classifier strategy injected into resolveDecision (auto profile). */
export type ClassifyStrategy = (call: GuardCall, policy: PolicyState) => Promise<{ verdict: "allow" | "soft_deny" | "hard_deny" | "no_match"; reason: string; modelId?: string }>;

/**
 * True when `s` contains a `$` outside single quotes: any shell expansion
 * vetoes the host tier's auto-allow (`echo $GITHUB_TOKEN` must prompt).
 * Double quotes do NOT protect: `"$HOME"` still expands. A single quote
 * inside double quotes is a literal character, not a toggle: `echo "'$HOME'"`
 * still expands and must be flagged.
 */
export function hasDollarExpansionOutsideSingleQuotes(s: string): boolean {
	let inSingle = false;
	let inDouble = false;
	let i = 0;
	while (i < s.length) {
		const ch = s[i];
		if (ch === "\\" && !inSingle) { i += 2; continue; }
		if (ch === "'" && !inDouble) { inSingle = !inSingle; i++; continue; }
		if (ch === '"' && !inSingle) { inDouble = !inDouble; i++; continue; }
		if (!inSingle && ch === "$") return true;
		i++;
	}
	return false;
}

/**
 * The active-construct screen for the read-only tier: returns a reason string
 * when `cmd` contains shell syntax the tier's per-command checks cannot prove
 * harmless, or null when the command is syntactically simple enough for the
 * tier. Fail closed: a flagged command never auto-allows, it falls through to
 * the normal rule/cell pipeline (a prompt in the default profile).
 *
 * Flagged constructs:
 *   - Dollar expansion and backtick command substitution outside literal
 *     single quotes (both are ACTIVE inside double quotes).
 *   - Process substitution `<(...)` / `>(...)`, subshells and grouping
 *     `(...)`, brace grouping `{`.
 *   - Background execution `&`, pipelines `|`, `&&` / `||`, and command
 *     separators `;` / newlines the top-level splitter did not handle.
 *   - Heredocs and here-strings `<<` / `<<<`.
 *   - Unterminated quotes (uncertain syntax).
 *
 * Deliberately NOT flagged: file-output redirects `>` / `>>` / `&>` (judged
 * by the redirect-aware allow-rule machinery, not here), plain input
 * redirects `<`, and descriptor dups `N>&M` / `>&-` / `&>target` (not file
 * writes in the dup case; the `&>` write case is judged by the redirect
 * machinery). Trailing separators are inert in bash (`echo ok;`) and are
 * trimmed before scanning; a trailing `&` is NOT trimmed, backgrounding is
 * an active semantic.
 */
export function activeConstructReason(cmd: string): string | null {
	const s = cmd.replace(/(?:\|\||&&|\||;|\s)+$/, "");
	let inSingle = false;
	let inDouble = false;
	let i = 0;
	while (i < s.length) {
		const ch = s[i];
		// Backslash escape outside single quotes: the next character cannot be
		// an active construct (bash itself treats it as literal, including
		// inside double quotes for the escapable set).
		if (ch === "\\" && !inSingle) { i += 2; continue; }
		// Quote toggles: a single quote inside double quotes (and vice versa)
		// is a literal character, not a toggle.
		if (ch === "'" && !inDouble) { inSingle = !inSingle; i++; continue; }
		if (ch === '"' && !inSingle) { inDouble = !inDouble; i++; continue; }
		// Expansion and backtick substitution are active outside AND inside
		// double quotes; only literal single quotes neutralize them.
		if (ch === "$" && !inSingle) return "dollar expansion";
		if (ch === "`" && !inSingle) return "backtick command substitution";
		if (inSingle || inDouble) { i++; continue; }
		// Everything below is unquoted and therefore active shell syntax.
		if (ch === "&") {
			const next = s[i + 1] ?? "";
			const prev = s[i - 1] ?? "";
			if (next === "&") return "&& control operator";
			if (next === ">") { i += 2; continue; } // &> file: judged by the redirect machinery
			if (prev === ">" && (next === "-" || /[0-9]/.test(next))) {
				// Descriptor dup `N>&M` / `>&-`: skip past `&` and the fd digits.
				i++;
				while (i < s.length && /[0-9]/.test(s[i] ?? "")) i++;
				continue;
			}
			return "background execution";
		}
		if (ch === "|") return s[i + 1] === "|" ? "|| control operator" : "pipeline";
		if (ch === ";" || ch === "\n" || ch === "\r") return "command separator";
		if (ch === "(") {
			const prev = s[i - 1] ?? "";
			if (prev === "<" || prev === ">") return "process substitution";
			return "subshell or grouping";
		}
		if (ch === ")") return "subshell or grouping";
		if (ch === "{") return "brace grouping";
		if (ch === "<") {
			if (s[i + 1] === "<") return "heredoc or here-string";
			i++; // plain input redirect: read-only
			continue;
		}
		i++;
	}
	if (inSingle || inDouble) return "unterminated quotes";
	return null;
}

/**
 * Basenames of a host command's non-flag tokens that match a secret-mask
 * pattern: a file argument like `.env` or `server.pem` vetoes the host tier's
 * auto-allow (the file's contents must not be readable on the host).
 * Patterns: built-ins plus guard.json additions. Exceptions: the built-in
 * exceptions (e.g. .env.example) plus guard.json additions.
 */
export function maskArgumentVeto(cmd: string, config: ResolvedGuardConfig): string | null {
	const tokens = tokenizeSimple(stripTrailingHarmlessRedirects(cmd));
	for (const tok of tokens.slice(1)) {
		if (!tok || tok.startsWith("-")) continue;
		if (/[`$(){}|&;<>*?]/.test(tok)) continue; // unresolvable: other vetoes handle it
		const base = tok.split("/").pop() ?? tok;
		if (
			isMaskedName(
				base,
				[...DEFAULT_MASK_PATTERNS, ...config.maskPatterns],
				[...DEFAULT_MASK_EXCEPTIONS, ...config.maskExceptions],
			)
		) {
			return `command argument matches secret mask pattern (${base})`;
		}
	}
	return null;
}

/** Secret-mask check for a read target path (path-level only in step 2). */
export function maskedReadPathReason(path: string, config: ResolvedGuardConfig): string | null {
	const base = path.replace(/\\/g, "/").split("/").filter((p) => p.length > 0).pop();
	if (!base) return null;
	if (
		isMaskedName(
			base,
			[...DEFAULT_MASK_PATTERNS, ...config.maskPatterns],
			[...DEFAULT_MASK_EXCEPTIONS, ...config.maskExceptions],
		)
	) {
		return `path matches secret mask pattern (${base})`;
	}
	return null;
}

/**
 * Host-tier vetoes applied BEFORE the read-only tier for host_bash and pwsh
 * (the tightened host tier). Returns a veto reason or null.
 */
export function hostTierVetoReason(cmd: string, config: ResolvedGuardConfig): string | null {
	const stripped = stripLineContinuations(cmd);
	// env/printenv removed from the host tier: the host environment holds tokens.
	const first = (tokenizeSimple(stripped)[0] ?? "").toLowerCase();
	if (first === "env" || first === "printenv") return "env/printenv removed from the host tier (host environment holds tokens)";
	// Any $ expansion vetoes auto-allow.
	if (hasDollarExpansionOutsideSingleQuotes(stripped)) return "$ expansion vetoes host-tier auto-allow";
	// Secret-mask file arguments veto auto-allow.
	const mask = maskArgumentVeto(stripped, config);
	if (mask) return mask;
	return null;
}

/** The rule tool name a shell's rules are written against. */
function ruleToolFor(shell: "host-bash" | "pwsh"): string {
	return shell === "pwsh" ? "Pwsh" : "HostBash";
}

/** Match a host-shell rule list against a command; returns the raw rule or undefined. */
function matchedHostShellRule(list: readonly string[], shell: "host-bash" | "pwsh", command: string, cwd: string): string | undefined {
	const tool = ruleToolFor(shell);
	for (const raw of list) {
		const rule = parseRule(raw);
		if (rule && ruleMatches(rule, tool, { command }, cwd)) return raw;
	}
	return undefined;
}

/**
 * The tightened read-only tier for host_bash (pwsh has no read-only tier).
 * Returns an allow reason, or null when the tier cannot prove the command
 * read-only.
 */
function hostTierAllowReason(cmd: string, config: ResolvedGuardConfig): string | null {
	if (hostTierVetoReason(cmd, config) !== null) return null;
	// Active-construct screen (fail closed): command/process substitution,
	// background execution, grouping, heredocs, and separators the splitter
	// did not handle all make the per-command checks below unsound. A flagged
	// command does not deny: it falls through to the normal pipeline (rules,
	// then the profile cell, typically a prompt).
	if (activeConstructReason(cmd) !== null) return null;
	if (isReadOnlyBashSubcommand(cmd, config.cwd, {}, config.writeRoots, config.readRoots)) {
		return "read-only host command (tightened tier)";
	}
	const validatorReason = validatorApprovedBashReason(cmd, config.cwd, config.bashValidators, config.writeRoots, config.readRoots);
	if (validatorReason !== null) return validatorReason;
	if (isNoopCd(cmd, config.cwd)) return "no-op cd";
	if (isPureVariableAssignment(cmd, config.writeRoots, { cwd: config.cwd })) {
		return "pure shell variable assignment";
	}
	return null;
}

/**
 * The tier for host_bash in degraded mode (research): the tightened host tier
 * applies (host vetoes included: degraded execution is host execution, so
 * env/printenv, $ expansion, and secret-mask file arguments are not proven
 * read-only). Allow rules never widen this set. Returns an allow reason or
 * null.
 */
function degradedResearchTierReason(cmd: string, config: ResolvedGuardConfig): string | null {
	const tier = hostTierAllowReason(cmd, config);
	return tier === null ? null : `${tier} (degraded research)`;
}

function cellAction(cell: "allow" | "prompt" | "deny" | "classify", what: string): Decision {
	switch (cell) {
		case "allow": return { action: "allow", reason: `${what}: allowed in this profile` };
		case "prompt": return { action: "prompt", reason: `${what}: prompts in this profile` };
		case "deny": return { action: "deny", reason: `${what}: denied in this profile` };
		case "classify": return { action: "classify", reason: `${what}: screened by the classifier in auto profile` };
	}
}

/**
 * One evaluated host-shell step. `subject` is the exact string deny/ask rules
 * match against and `allowSubject` the exact string a plain allow rule
 * matches against (redirect-stripped), so suggestions can anchor to the real
 * evaluator matching subjects rather than merely displayed fragments.
 */
export interface HostShellStep {
	/** Stable identity within one evaluation; duplicate command text keeps distinct IDs. */
	occurrenceId: number;
	/** The fragment shown for the step (matches the aggregate reason attribution). */
	display: string;
	/** The subject deny/ask rules are matched against (normalized). */
	subject: string;
	/** The subject a plain allow rule is matched against (redirect-stripped). */
	allowSubject: string;
	/** True when only a redirect-aware allow rule (pattern containing '>') can authorize the step. */
	requiresRedirectAwareAllow: boolean;
	decision: Decision;
}

/**
 * The full host-shell evaluation: the aggregate decision plus the per-step
 * projection used by the save/deny/compound prompts. `decision` is exactly
 * what decideHostShellCommand returns; steps and causes are a projection of
 * the same single evaluation, never fresh calls on reconstructed fragments.
 */
export interface HostShellExplanation {
	decision: Decision;
	/** Evaluated steps in evaluation order; empty when nothing was evaluated per-step. */
	steps: HostShellStep[];
	/** Raw whole-command rule matches, recorded even when a step re-matched them. */
	rawDenyRule?: string;
	rawAskRule?: string;
	/** Present when the command could not be split for per-subcommand checks. */
	splitCause?: string;
	/** The worst subcommand whose decision the aggregate reason attributes;
	 *  present only when the reason has the "subcommand '<sub>': ..." form. */
	failingSub?: string;
	/** Conservative breakdown availability for presentation/suggestions (policy routing is unaffected). */
	breakdown: BreakdownReliability;
}

/**
 * Decide one (already split) host shell subcommand, for the
 * default/auto/trusted precedence: deny > ask > tier > redirect-aware allow
 * rules > redirect requirement > cell. Returns the decision plus the exact
 * matching subjects so suggestions can anchor to what the evaluator matched.
 */
function evaluateHostShellSub(command: string, policy: PolicyState, shell: "host-bash" | "pwsh", tierEligible: boolean): { decision: Decision; subject: string; allowSubject: string; requiresRedirectAwareAllow: boolean } {
	const { config, profile } = policy;
	const cmd = stripTimeoutPrefix(stripLineContinuations(command).trim());
	const subject = cmd;
	const requiresRedirectAwareAllow = hasTopLevelFileRedirect(cmd, config.writeRoots, { cwd: config.cwd });
	// Plain allow rules match the redirect-stripped subject; a step that needs
	// a redirect-aware rule is matched verbatim (its text contains '>').
	const allowSubject = requiresRedirectAwareAllow ? cmd : stripTrailingHarmlessRedirects(cmd);
	// Explicit rules: deny > ask (redirect-agnostic; safety rules win first).
	const denyRule = matchedHostShellRule(config.hostBash.deny, shell, cmd, config.cwd);
	if (denyRule !== undefined) return { decision: { action: "deny", reason: `matched ${ruleToolFor(shell)} deny rule '${denyRule}'` }, subject, allowSubject, requiresRedirectAwareAllow };
	const askRule = matchedHostShellRule(config.hostBash.ask, shell, cmd, config.cwd);
	if (askRule !== undefined) return { decision: { action: "prompt", reason: `matched ${ruleToolFor(shell)} ask rule '${askRule}'`, provenance: "explicit-ask" }, subject, allowSubject, requiresRedirectAwareAllow };
	if (profile === "yolo") return { decision: { action: "allow", reason: "host shell: yolo allows everything else" }, subject, allowSubject, requiresRedirectAwareAllow };
	// Tightened read-only tier (host_bash only; host vetoes first). Skipped
	// entirely when the whole command contains a structural construct whose
	// head was discarded during step projection: the fragments evaluated here
	// do not stand for what bash will actually run.
	if (shell === "host-bash" && tierEligible) {
		const tier = hostTierAllowReason(cmd, config);
		if (tier !== null) return { decision: { action: "allow", reason: tier }, subject, allowSubject, requiresRedirectAwareAllow };
	}
	// Redirect handling: a top-level file redirect (outside the writeRoots
	// exemptions) may only be authorized by a redirect-aware allow rule (one
	// whose pattern contains ">"). Broad rules and the profile cell never
	// authorize a write redirect. When the projection is unfaithful
	// (tierEligible false: a structural head was discarded), allow rules are
	// skipped entirely: a rule saved against a projected body fragment must
	// never authorize a command whose discarded head runs other code.
	if (requiresRedirectAwareAllow) {
		if (tierEligible) {
			for (const raw of config.hostBash.allow) {
				const rule = parseRule(raw);
				if (rule && rulePatternAllowsRedirect(rule) && ruleMatches(rule, ruleToolFor(shell), { command: cmd }, config.cwd)) {
					return { decision: { action: "allow", reason: `matched redirect-aware allow rule '${raw}'` }, subject, allowSubject, requiresRedirectAwareAllow };
				}
			}
		}
		return { decision: { action: "prompt", reason: tierEligible ? "file redirect requires a redirect-aware allow rule (a pattern containing '>')" : "structural command could not be evaluated (loop or case head discarded)" }, subject, allowSubject, requiresRedirectAwareAllow };
	}
	// Plain allow rules. Skipped when the projection is unfaithful, like the
	// tier above.
	if (tierEligible) {
		const allowRule = matchedHostShellRule(config.hostBash.allow, shell, stripTrailingHarmlessRedirects(cmd), config.cwd);
		if (allowRule !== undefined) {
			return { decision: { action: "allow", reason: `matched ${ruleToolFor(shell)} allow rule '${allowRule}'` }, subject, allowSubject, requiresRedirectAwareAllow };
		}
	}
	// Profile cell.
	return { decision: cellAction(hostShellCell(profile), "host shell"), subject, allowSubject, requiresRedirectAwareAllow };
}

/**
 * The full host-shell evaluation behind decideHostShellCommand: the
 * aggregate decision plus per-step decisions, exact matching subjects, and
 * whole-call causes. Pure and deterministic; no classifier calls here (a
 * per-step "classify" cell stays unresolved and is attributed at the
 * aggregate level exactly as before).
 */
function evaluateHostShell(
	call: Extract<GuardCall, { kind: "host-shell" }>,
	policy: PolicyState,
): HostShellExplanation {
	const { profile, config } = policy;
	const shell = call.shell;
	if (policy.workspaceLocked) return { decision: { action: "deny", reason: "workspace locked: host execution is unavailable until /guard ack" }, steps: [], breakdown: { available: false, reason: "the workspace is locked; host execution is unavailable" } };
	if (profile === "unrestricted") return { decision: { action: "allow", reason: "host shell: unrestricted profile allows everything" }, steps: [], breakdown: { available: false, reason: "the unrestricted profile allows everything; no breakdown is needed" } };
	if (profile === "research") {
		// Degraded mode is the one place research has no sandbox at all, so
		// host_bash takes the whole-command read-only tier there (the same rule
		// set that used to run as the degraded "sandboxed" bash). Allow rules
		// never widen it, and no per-step breakdown is fabricated: the tier
		// judges the whole command.
		if (policy.sandboxMode === "degraded" && shell === "host-bash") {
			const degradedResearchBreakdown: BreakdownReliability = { available: false, reason: "degraded research runs a whole-command read-only-tier check" };
			const cmd = call.command ?? "";
			if (cmd.trim() === "") return { decision: { action: "deny", reason: "degraded research: no command to prove read-only" }, steps: [], breakdown: degradedResearchBreakdown };
			const tier = degradedResearchTierReason(stripTimeoutPrefix(stripLineContinuations(cmd).trim()), config);
			if (tier !== null) return { decision: { action: "allow", reason: tier }, steps: [], breakdown: degradedResearchBreakdown };
			return { decision: { action: "deny", reason: "degraded research: only read-only-tier commands run on the host" }, steps: [], breakdown: degradedResearchBreakdown };
		}
		return { decision: { action: "deny", reason: "host shell: denied in research (rules are ignored)" }, steps: [], breakdown: { available: false, reason: "research denies host execution regardless of steps" } };
	}

	const cmd = stripLineContinuations(call.command);
	const rawDeny = matchedHostShellRule(config.hostBash.deny, shell, cmd, config.cwd);
	if (rawDeny !== undefined) return { decision: { action: "deny", reason: `matched ${ruleToolFor(shell)} deny rule '${rawDeny}'` }, steps: [], rawDenyRule: rawDeny, breakdown: { available: false, reason: "a whole-command deny rule matched" } };
	const rawAsk = matchedHostShellRule(config.hostBash.ask, shell, cmd, config.cwd);

	const split = splitTopLevelShell(cmd);
	if (split.kind === "ambiguous") {
		const ambiguous: BreakdownReliability = { available: false, reason: "the command could not be split unambiguously" };
		const splitCause = "complex command could not be split for per-subcommand checks";
		const denyRule = matchedHostShellRule(config.hostBash.deny, shell, cmd, config.cwd);
		if (denyRule !== undefined) return { decision: { action: "deny", reason: `matched ${ruleToolFor(shell)} deny rule '${denyRule}'` }, steps: [], rawDenyRule: denyRule, splitCause, breakdown: ambiguous };
		if (rawAsk !== undefined) return { decision: { action: "prompt", reason: `matched ${ruleToolFor(shell)} ask rule '${rawAsk}'`, provenance: "explicit-ask" }, steps: [], rawAskRule: rawAsk, splitCause, breakdown: ambiguous };
		if (profile === "yolo") return { decision: { action: "allow", reason: "host shell: yolo allows everything else" }, steps: [], splitCause, breakdown: ambiguous };
		return { decision: { action: "prompt", reason: splitCause }, steps: [], splitCause, breakdown: ambiguous };
	}
	const stepOf = (occurrenceId: number, display: string, ev: ReturnType<typeof evaluateHostShellSub>): HostShellStep => ({ occurrenceId, display, subject: ev.subject, allowSubject: ev.allowSubject, requiresRedirectAwareAllow: ev.requiresRedirectAwareAllow, decision: ev.decision });
	if (split.kind === "single") {
		const effective = split.effectiveCmd ?? cmd;
		const ev = evaluateHostShellSub(effective, policy, shell, true);
		const decision = ev.decision.action !== "deny" && rawAsk !== undefined ? { action: "prompt" as const, reason: `matched ${ruleToolFor(shell)} ask rule '${rawAsk}'`, provenance: "explicit-ask" as const } : ev.decision;
		// Pair the single fragment with its structurally stripped form so pure
		// timeout wrappers stay reliable while structural keywords do not.
		const strippedSingle = stripStructuralKeywords(effective);
		const reliability = assessBreakdownReliability(shell, strippedSingle === null ? [] : [effective], strippedSingle === null ? [] : [strippedSingle]);
		return { decision, steps: [stepOf(0, effective, ev)], rawAskRule: rawAsk, breakdown: reliability };
	}
	const pairs: Array<{ raw: string; stripped: string }> = [];
	// A raw part that stripStructuralKeywords discards (a pure iteration/case
	// head or a bare block keyword) was never evaluated, so the projected steps
	// do not stand for the whole command: the discarded head can hold the
	// active construct (`for x in $(touch probe); do echo ok; done`). No step
	// of such a command may auto-allow via the tier.
	let structuralCollapse = false;
	for (const rawSub of split.parts) {
		const stripped = stripStructuralKeywords(rawSub);
		if (stripped !== null) pairs.push({ raw: rawSub, stripped });
		else structuralCollapse = true;
	}
	if (pairs.length === 0) {
		if (structuralCollapse) {
			// A pure loop/select head may still expand its word list (`for x in
			// $(touch probe); do done` runs the substitution), so "nothing to
			// evaluate" must not auto-allow.
			return { decision: { action: "prompt", reason: "structural command could not be evaluated (loop or case head discarded)" }, steps: [], rawAskRule: rawAsk, breakdown: { available: false, reason: "the command is purely structural and has no evaluable steps" } };
		}
		return { decision: { action: "allow", reason: "no commands after structural stripping" }, steps: [], rawAskRule: rawAsk, breakdown: { available: false, reason: "the command is purely structural and has no evaluable steps" } };
	}
	const parts = pairs.map((p) => p.stripped);
	const tierEligible = !structuralCollapse;
	const reliability = assessBreakdownReliability(shell, pairs.map((p) => p.raw), parts);
	if (parts.length === 1) {
		const ev = evaluateHostShellSub(parts[0], policy, shell, tierEligible);
		const decision = ev.decision.action !== "deny" && rawAsk !== undefined ? { action: "prompt" as const, reason: `matched ${ruleToolFor(shell)} ask rule '${rawAsk}'`, provenance: "explicit-ask" as const } : ev.decision;
		return { decision, steps: [stepOf(0, parts[0], ev)], rawAskRule: rawAsk, breakdown: reliability };
	}
	const breakdown = pairs.map((p) => ({ sub: p.stripped, ev: evaluateHostShellSub(p.stripped, policy, shell, tierEligible) }));
	if (!breakdown.some((b) => b.ev.decision.action === "deny") && rawAsk !== undefined) {
		return { decision: { action: "prompt", reason: `matched ${ruleToolFor(shell)} ask rule '${rawAsk}'`, provenance: "explicit-ask" }, steps: breakdown.map((b, i) => stepOf(i, b.sub, b.ev)), rawAskRule: rawAsk, breakdown: reliability };
	}
	const worst =
		breakdown.find((b) => b.ev.decision.action === "deny") ??
		breakdown.find((b) => b.ev.decision.action === "prompt") ??
		breakdown.find((b) => b.ev.decision.action === "classify") ??
		breakdown[0];
	const decision: Decision = { action: worst.ev.decision.action, reason: `subcommand '${worst.sub}': ${worst.ev.decision.reason}`, provenance: breakdown.some((b) => b.ev.decision.provenance === "explicit-ask") ? "explicit-ask" : worst.ev.decision.provenance };
	return { decision, steps: breakdown.map((b, i) => stepOf(i, b.sub, b.ev)), rawAskRule: rawAsk, failingSub: worst.sub, breakdown: reliability };
}

/**
 * Decide a host shell call (host_bash or pwsh), splitting compounds so each
 * subcommand is evaluated independently. Aggregation: deny > prompt >
 * classify > allow, attributed to the worst subcommand. Per profile:
 *   research     absolute deny (rules ignored); degraded mode is the one
 *                exception, where host_bash takes the whole-command
 *                read-only tier and allow rules never widen it.
 *   yolo         deny rules block, ask rules prompt, everything else allows.
 *   unrestricted allow, rules ignored.
 *   otherwise    evaluateHostShellSub per subcommand.
 * An ambiguous split prompts, but an explicit deny rule on the raw command
 * still denies (deny rules always win).
 */
export function decideHostShellCommand(
	call: Extract<GuardCall, { kind: "host-shell" }>,
	policy: PolicyState,
): Decision {
	return evaluateHostShell(call, policy).decision;
}

/**
 * The per-step projection of exactly the evaluation decideHostShellCommand
 * performs: same aggregate decision, plus steps, causes, and breakdown
 * reliability. Never re-decides reconstructed fragments.
 */
export function explainHostShellCommand(
	call: Extract<GuardCall, { kind: "host-shell" }>,
	policy: PolicyState,
): HostShellExplanation {
	return evaluateHostShell(call, policy);
}

/**
 * Containment for read targets: cwd plus the configured readRoots (~ and
 * $HOME expanded, trailing globs stripped). A missing or empty path means
 * cwd (and is always inside).
 */
export function pathInsideReadRoots(path: string | undefined, config: ResolvedGuardConfig): boolean {
	if (path === undefined || path.trim() === "") return true;
	const roots = normalizeRootList(config.readRoots, config.cwd, homedir());
	return pathInsideAllowedRoots(path, config.cwd, roots);
}

/** Containment for write/edit targets: cwd plus the configured writeRoots. */
export function pathInsideWriteRoots(path: string, config: ResolvedGuardConfig): boolean {
	const roots = normalizeRootList(config.writeRoots, config.cwd, homedir());
	return pathInsideAllowedRoots(path, config.cwd, roots);
}

/** Decide a local read (read/grep/find/ls/fffind/ffgrep/git_read). */
export function decideLocalRead(call: Extract<GuardCall, { kind: "local-read" }>, policy: PolicyState): Decision {
	const { profile, config } = policy;
	const hasPath = call.path !== undefined && call.path.trim() !== "";
	// Secret masks are path-level only in step 2: a grep over a directory
	// that happens to contain a masked file is allowed. Documented gap; step 3
	// adds a tool_result filter that drops matches from masked files.
	if (hasPath) {
		const masked = maskedReadPathReason(call.path as string, config);
		if (masked !== null) {
			const cell = maskReadCell(profile);
			if (cell === "allow") return { action: "allow", reason: `secret-mask path allowed in ${profile}` };
			return { action: "deny", reason: `secret-mask read denied: ${masked}` };
		}
	}
	if (localReadCell(profile) === "allow") {
		return { action: "allow", reason: `local read: allowed in ${profile}` };
	}
	if (pathInsideReadRoots(call.path, config)) {
		return { action: "allow", reason: hasPath ? "read inside cwd or a configured read root" : "read without a path argument (cwd)" };
	}
	return { action: "prompt", reason: "read outside cwd and every read root" };
}

/** Decide a local write (write/edit with a path; memory/scratchpad without). */
export function decideLocalWrite(call: Extract<GuardCall, { kind: "local-write" }>, policy: PolicyState): Decision {
	const { profile, config } = policy;
	if (profile === "research") return { action: "deny", reason: "local write: denied in research" };
	// The workspace lock (step-3 audit findings) blocks every host write
	// channel, path-carrying or not, until /guard ack.
	if (policy.workspaceLocked) return { action: "deny", reason: "workspace locked: write/edit is unavailable until /guard ack" };
	// Local writes without a path (memory_write, scratchpad, ...) are allowed
	// in every profile except research; pi's tool-call rendering shows them.
	if (call.path === undefined || call.path.trim() === "") {
		return { action: "allow", reason: "local write without a path (allowed outside research)" };
	}
	if (makeIsProtectedPath(config)(call.path)) {
		return cellAction(protectedPathCell(profile), `protected path ${call.path}`);
	}
	const cell = writeEditCell(profile);
	if (cell === "prompt") {
		// default: every non-protected write/edit prompts, in-root or not. The
		// dialog offers the switch to allow-edits for in-root targets.
		return {
			action: "prompt",
			reason: pathInsideWriteRoots(call.path, config)
				? "write/edit requires approval in the default profile"
				: "write outside cwd and every write root",
		};
	}
	if (cell === "roots") {
		return pathInsideWriteRoots(call.path, config)
			? { action: "allow", reason: "write inside cwd or a configured write root" }
			: { action: "prompt", reason: "write outside cwd and every write root" };
	}
	if (cell === "classify") {
		// auto: write-root containment gates the classifier. An out-of-root
		// write always prompts; the classifier only rules on in-root calls.
		if (!pathInsideWriteRoots(call.path, config)) {
			return { action: "prompt", reason: "write outside cwd and every write root" };
		}
	}
	return cellAction(cell, "write/edit");
}

/** True when a web_fetch URL matches no webFetchAllow entry (exfil-capable). */
export function isExfilCapableFetch(url: string, config: ResolvedGuardConfig): boolean {
	if (config.webFetchAllow.length === 0) return true;
	for (const pattern of config.webFetchAllow) {
		if (compilePattern(pattern).test(url)) return false;
	}
	return true;
}

/**
 * Whether a `bash` call would run on the host instead of inside the sandbox:
 * degraded mode has no sandbox at all, and the unlocked raw profiles (yolo,
 * unrestricted) run everything raw. The workspace lock forces the sandbox
 * back on, so a locked raw session keeps its read-only sandboxed bash. Both
 * the decision layer (the bash ban) and the execution layer (executeShell)
 * must use this predicate, so the two can never drift apart.
 */
export function bashRunsOnHost(policy: PolicyState): boolean {
	return policy.sandboxMode === "degraded" || (!policy.workspaceLocked && (policy.profile === "yolo" || policy.profile === "unrestricted"));
}

/**
 * The pure decision function. Total over all GuardCall shapes and profiles;
 * "classify" results must be resolved through resolveDecision().
 */
export function decide(policy: PolicyState, call: GuardCall): Decision {
	const { profile, config } = policy;
	if (policy.workspaceLocked && (call.kind === "host-shell" || (call.kind === "sandboxed-exec" && policy.sandboxMode === "degraded"))) {
		return { action: "deny", reason: "workspace locked: host/raw execution is unavailable until /guard ack" };
	}

	switch (call.kind) {
		case "sandboxed-exec": {
			// bash is sandbox-only: wherever the sandbox is unavailable and a
			// bash call would run on the host (degraded mode, or the unlocked raw
			// profiles), deny it and name the explicit host tool rather than
			// silently switching where the command runs.
			if (call.tool === "bash" && bashRunsOnHost(policy)) {
				return { action: "deny", reason: policy.sandboxMode === "degraded"
					? "bash is sandbox-only and this host has no sandbox (degraded mode): use host_bash instead"
					: `bash is sandbox-only; in ${profile} it would run on the host: use host_bash (same permissions here) instead` };
			}
			// Degraded mode has no sandbox at all, so the workers are unavailable.
			if (policy.sandboxMode === "degraded") return { action: "deny", reason: "persistent workers unavailable in degraded mode" };
			// The unlocked raw profiles run python/node without a sandbox.
			if ((profile === "yolo" || profile === "unrestricted") && !policy.workspaceLocked) {
				return { action: "allow", reason: `${call.tool}: raw execution in ${profile}, no sandbox or resource limits` };
			}
			return cellAction(sandboxedExecCell(profile), "sandboxed execution (kernel-enforced sandbox)");
		}
		case "host-shell":
			return decideHostShellCommand(call, policy);
		case "local-read":
			return decideLocalRead(call, policy);
		case "local-write":
			return decideLocalWrite(call, policy);
		case "web-fetch":
			return isExfilCapableFetch(call.url, config)
				? cellAction(exfilRemoteReadCell(profile), "web_fetch outside the allowlist (exfil-capable)")
				: { action: "allow", reason: "web_fetch inside the allowlist" };
		case "remote-read":
			return cellAction(otherRemoteReadCell(profile), "remote read (not attacker-readable)");
		case "remote-write":
			return cellAction(remoteWriteCell(profile), "remote write");
		case "meta":
			return cellAction(metaCell(profile), "meta tool (nested calls are gated individually)");
	}
}

/**
 * The async wrapper: run decide(), resolve "classify" cells through the
 * injected strategy, and collapse prompts to deny in non-interactive
 * contexts. `no_match` and classifier failures fall through to the auto
 * profile's safe default (prompt, or deny when non-interactive).
 */
export async function resolveDecision(
	policy: PolicyState,
	call: GuardCall,
	classify: ClassifyStrategy,
): Promise<Decision & { action: "allow" | "prompt" | "deny" }> {
	const d = decide(policy, call);
	if (d.action !== "classify") {
		return { ...finalize(policy, d.action, d.reason), provenance: d.provenance };
	}
	let result: { verdict: "allow" | "soft_deny" | "hard_deny" | "no_match"; reason: string; modelId?: string };
	try {
		result = await classify(call, policy);
	} catch (err) {
		result = { verdict: "no_match", reason: `classifier call failed (${err instanceof Error ? err.message : String(err)})` };
	}
	const attribution = result.modelId ? `classifier ${result.modelId}${result.reason ? `: ${result.reason}` : ""}` : `classifier${result.reason ? `: ${result.reason}` : ""}`;
	switch (result.verdict) {
		case "allow":
			return { action: "allow", reason: attribution };
		case "hard_deny":
			return { action: "deny", reason: attribution };
		case "soft_deny":
			return finalize(policy, "prompt", attribution);
		case "no_match":
		default:
			return finalize(policy, "prompt", `classifier had no verdict; auto-profile fallthrough (${attribution})`);
	}
}

function finalize(
	policy: PolicyState,
	action: "allow" | "prompt" | "deny",
	reason: string,
): { action: "allow" | "prompt" | "deny"; reason: string } {
	if (action === "prompt" && !policy.interactive) {
		return { action: "deny", reason: `${reason}; non-interactive prompt collapses to deny` };
	}
	return { action, reason };
}

/**
 * Effective sandbox workspace mode for the profile, adjusted for the runtime
 * mode: research's overlay degrades to read-only unless the sandbox is full;
 * yolo and unrestricted are "none".
 */
export function effectiveWorkspaceMode(policy: PolicyState): WorkspaceMode | "none" {
	if (policy.workspaceLocked) return "ro";
	if (policy.profile === "yolo" || policy.profile === "unrestricted") return "none";
	const base = workspaceModeForProfile(policy.profile);
	if (base === "overlay" && policy.sandboxMode !== "full") return "ro";
	return base;
}

/**
 * Resolve a possibly-relative call path against the policy cwd (absolute
 * paths pass through). Used by suggestRule and readGrantSuggestion.
 */
export function resolveCallPath(path: string, cwd: string): string {
	return normalizeMatchPath(path, cwd);
}
