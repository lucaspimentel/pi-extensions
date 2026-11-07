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
	hasBlockingInputRedirect,
	hasTopLevelFileRedirect,
	hasWritableRedirect,
	isNoopCd,
	isReadOnlyBashArgv,
	pathInsideAllowedRoots,
	stripLineContinuations,
	validatorApprovedBashArgv,
	type StructuredRedirect,
} from "./bashtier.ts";
import { parseRule, ruleMatches, rulePatternAllowsRedirect, compilePattern } from "./rules.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizeMatchPath, normalizeRootList } from "./paths.ts";
import { stripTimeoutPrefix, stripTrailingHarmlessRedirects, type BreakdownReliability } from "./shell-text.ts";
import { shellAnalysisCauseReason, shellAstStatus, type ShellCommandAnalysis } from "./shellast.ts";
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
	/** Raw rule identifier when an explicit shell rule decided this result. */
	matchedRule?: string;
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
 * Basenames of a host command's non-flag tokens that match a secret-mask
 * pattern: a file argument like `.env` or `server.pem` vetoes the host tier's
 * auto-allow (the file's contents must not be readable on the host).
 * Patterns: built-ins plus guard.json additions. Exceptions: the built-in
 * exceptions (e.g. .env.example) plus guard.json additions.
 */
export function maskArgumentVeto(argv: readonly string[], config: ResolvedGuardConfig): string | null {
	for (const tok of argv.slice(1)) {
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
export function hostTierVetoReason(
	argv: readonly string[],
	hasParameterExpansion: boolean,
	config: ResolvedGuardConfig,
): string | null {
	// env/printenv removed from the host tier: the host environment holds tokens.
	const first = (argv[0] ?? "").toLowerCase();
	if (first === "env" || first === "printenv") return "env/printenv removed from the host tier (host environment holds tokens)";
	// Any $ expansion vetoes auto-allow (the analysis's per-call flag).
	if (hasParameterExpansion) return "$ expansion vetoes host-tier auto-allow";
	// Secret-mask file arguments veto auto-allow.
	const mask = maskArgumentVeto(argv, config);
	if (mask) return mask;
	return null;
}

/** The rule tool name a shell's rules are written against. */
function ruleToolFor(shell: "host-bash" | "pwsh"): string {
	return shell === "pwsh" ? "Pwsh" : "HostBash";
}

/** Match rules first, then supplied spellings, preserving the earliest rule's identity. */
function matchedHostShellRule(list: readonly string[], shell: "host-bash" | "pwsh", commands: readonly (string | null)[], cwd: string): string | undefined {
	const tool = ruleToolFor(shell);
	for (const raw of list) {
		const rule = parseRule(raw);
		if (rule && commands.some((command) => command !== null && ruleMatches(rule, tool, { command }, cwd))) return raw;
	}
	return undefined;
}

/**
 * One call's inputs to the tightened read-only tier: the unwrapped argv, the
 * structured redirects, the per-call `$` flag, the pure-assignment flag, and
 * the writeRoots-aware redirect gate. No subject text is judged here (the
 * syntax screen is the AST analysis's completeness, checked by the caller).
 */
interface HostTierInput {
	/** Legacy raw input used only for the string-based no-op cd helper. */
	tierNoopCdSubject: string;
	argv: readonly string[];
	redirects: readonly StructuredRedirect[];
	hasParameterExpansion: boolean;
	pureAssignment: boolean;
	requiresRedirectAwareAllow: boolean;
}

/**
 * The tightened read-only tier for host_bash (pwsh has no read-only tier).
 * Judged on the call's UNWRAPPED argv, its redirects, and its assignment flag,
 * never on the subject text. Returns an allow reason, or null when the tier
 * cannot prove the command read-only.
 */
function hostTierAllowReason(step: HostTierInput, config: ResolvedGuardConfig): string | null {
	if (hostTierVetoReason(step.argv, step.hasParameterExpansion, config) !== null) return null;
	// A top-level file write is authorized ONLY by a redirect-aware allow rule:
	// the tier never proves a write read-only.
	if (step.requiresRedirectAwareAllow) return null;
	// The read-only name-set judgment is on argv. An input redirect blocks the
	// path-taking / validator / assignment checks below, because its target is
	// not in argv and the pre-AST tier rejected those forms for exactly that
	// reason; the safe-always set (and a pure assignment) is unaffected.
	const hasInput = hasBlockingInputRedirect(step.redirects);
	if (isReadOnlyBashArgv(step.argv, config.cwd, config.readRoots, hasInput)) {
		return "read-only host command (tightened tier)";
	}
	if (hasInput) return null;
	const validatorReason = validatorApprovedBashArgv(step.argv, config.cwd, config.bashValidators, config.readRoots);
	if (validatorReason !== null) return validatorReason;
	if (isNoopCd(step.tierNoopCdSubject, config.cwd)) return "no-op cd";
	if (step.pureAssignment) return "pure shell variable assignment";
	return null;
}

/**
 * The tier for host_bash in degraded mode (research): the tightened host tier
 * applies (host vetoes included: degraded execution is host execution, so
 * env/printenv, $ expansion, and secret-mask file arguments are not proven
 * read-only). Allow rules never widen this set. A compound is not provable as
 * one whole-command tier check (its per-call argv cannot be collapsed), so
 * only a complete single call is judged. Returns an allow reason or null.
 */
function degradedResearchTierReason(analysis: ShellCommandAnalysis | null, config: ResolvedGuardConfig): string | null {
	if (analysis === null || analysis.cause !== null || analysis.calls.length !== 1) return null;
	const call = analysis.calls[0];
	if (!call.complete) return null;
	const tier = hostTierAllowReason({
		tierNoopCdSubject: call.tierNoopCdSubject,
		argv: call.argv,
		redirects: call.redirects,
		hasParameterExpansion: call.hasParameterExpansion,
		pureAssignment: call.pureAssignment,
		requiresRedirectAwareAllow: hasWritableRedirect(call.redirects, config.writeRoots, { cwd: config.cwd }),
	}, config);
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
 * One evaluated host-shell step. Deny/ask test the current, previous, and
 * raw subjects; Bash allow tests only the canonical `allowSubject` (or full
 * canonical subject for a redirect-aware rule). Suggestions use these exact
 * evaluator subjects, never merely displayed fragments.
 */
export interface HostShellStep {
	/** Stable identity within one evaluation; duplicate command text keeps distinct IDs. */
	occurrenceId: number;
	/** The fragment shown for the step (matches the aggregate reason attribution). */
	display: string;
	/** Canonical deny/ask subject, null when the projection is incomplete. */
	subject: string | null;
	/** Raw safety subject and displayed spelling, never a Bash allow subject. */
	rawSubject: string;
	/** Canonical plain-allow subject, null when the projection is incomplete. */
	allowSubject: string | null;
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
 * One evaluable step handed to evaluateHostShellSub. Safety rules test the
 * canonical and raw subjects; the tightened read-only tier is judged
 * on `argv`/`redirects`/`hasParameterExpansion`/`pureAssignment` (never the
 * subject text), with `requiresRedirectAwareAllow` computed by the caller
 * from the structured redirects (bash) or the text scanner (pwsh).
 * `incompleteReason` is non-null when the step cannot be evaluated (its own
 * subtree was flagged, or a pwsh command is malformed): it prompts before the
 * tier and every allow rule, so no rule can authorize an incomplete step.
 */
interface EvaluableStep {
	subject: string | null;
	previousSubject: string | null;
	allowSubject: string | null;
	rawSubject: string;
	tierNoopCdSubject: string;
	argv: readonly string[];
	redirects: readonly StructuredRedirect[];
	hasParameterExpansion: boolean;
	/** True when any projected word carries active shell expansion: such steps are ineligible for allow-rule authorization. */
	hasActiveExpansion: boolean;
	pureAssignment: boolean;
	requiresRedirectAwareAllow: boolean;
	incompleteReason: string | null;
}

/**
 * Decide one host shell step, for the default/auto/trusted precedence:
 * deny > ask > yolo > incomplete (prompt) > tier > redirect-aware allow
 * rules > redirect requirement > plain allow rules > cell. Returns the
 * decision plus the exact matching subjects so suggestions can anchor to
 * what the evaluator matched.
 *
 * `step.incompleteReason` non-null means the step's own projection is
 * unfaithful. It prompts there, BEFORE the tier and every allow rule, so an
 * explicit allow rule (or the tier) can never authorize a step that contains
 * a construct guard cannot evaluate; its complete siblings are unaffected.
 * Deny and ask rules still apply first, so a deny rule on an incomplete step
 * still denies.
 */
function evaluateHostShellSub(step: EvaluableStep, policy: PolicyState, shell: "host-bash" | "pwsh"): { decision: Decision; subject: string | null; allowSubject: string | null; requiresRedirectAwareAllow: boolean } {
	const { config, profile } = policy;
	const cmd = step.subject;
	const subject = cmd;
	const requiresRedirectAwareAllow = step.requiresRedirectAwareAllow;
	// Root exemptions are known only here, not by the AST adapter. Recompute
	// the harmless suffix after refining the redirect gate with those roots.
	const allowSubject = requiresRedirectAwareAllow ? cmd : shell === "host-bash" && cmd !== null
		? stripTrailingHarmlessRedirects(cmd, true) : step.allowSubject;
	// Rules first, then spellings: an earlier raw rule beats a later canonical rule.
	const denyRule = matchedHostShellRule(config.hostBash.deny, shell, [cmd, step.previousSubject, step.rawSubject], config.cwd);
	if (denyRule !== undefined) return { decision: { action: "deny", reason: `matched ${ruleToolFor(shell)} deny rule '${denyRule}'`, matchedRule: denyRule }, subject, allowSubject, requiresRedirectAwareAllow };
	const askRule = matchedHostShellRule(config.hostBash.ask, shell, [cmd, step.previousSubject, step.rawSubject], config.cwd);
	if (askRule !== undefined) return { decision: { action: "prompt", reason: `matched ${ruleToolFor(shell)} ask rule '${askRule}'`, matchedRule: askRule, provenance: "explicit-ask" }, subject, allowSubject, requiresRedirectAwareAllow };
	if (profile === "yolo") return { decision: { action: "allow", reason: "host shell: yolo allows everything else" }, subject, allowSubject, requiresRedirectAwareAllow };
	// An unfaithful step prompts here: no tier or allow rule may authorize it.
	if (step.incompleteReason !== null || cmd === null) return { decision: { action: "prompt", reason: step.incompleteReason ?? "the command has no canonical rule subject" }, subject, allowSubject, requiresRedirectAwareAllow };
	// Tightened read-only tier (host_bash only; host vetoes first). Judged on
	// the unwrapped argv and the structured redirects, never the subject text.
	if (shell === "host-bash") {
		const tier = hostTierAllowReason(step, config);
		if (tier !== null) return { decision: { action: "allow", reason: tier }, subject, allowSubject, requiresRedirectAwareAllow };
	}
	// Redirect handling: a top-level file redirect (outside the writeRoots
	// exemptions) may only be authorized by a redirect-aware allow rule (one
	// whose pattern contains ">"). Broad rules and the profile cell never
	// authorize a write redirect. Active shell expansion makes the step
	// ineligible for every allow rule, redirect-aware or plain: legacy
	// glob/regex patterns cannot distinguish expanding words from literals.
	if (requiresRedirectAwareAllow) {
		if (step.hasActiveExpansion) return { decision: { action: "prompt", reason: "active shell expansion cannot be authorized by an allow rule (a redirect-aware rule matched)" }, subject, allowSubject, requiresRedirectAwareAllow };
		for (const raw of config.hostBash.allow) {
			const rule = parseRule(raw);
			if (rule && rulePatternAllowsRedirect(rule) && ruleMatches(rule, ruleToolFor(shell), { command: cmd }, config.cwd)) {
				return { decision: { action: "allow", reason: `matched redirect-aware allow rule '${raw}'`, matchedRule: raw }, subject, allowSubject, requiresRedirectAwareAllow };
			}
		}
		return { decision: { action: "prompt", reason: "file redirect requires a redirect-aware allow rule (a pattern containing '>')" }, subject, allowSubject, requiresRedirectAwareAllow };
	}
	// Plain allow rules. An expansion-bearing step keeps the match evidence
	// for the prompt reason but falls through to the profile cell, so profile
	// scope (trusted allowing, default prompting) is untouched.
	const allowRule = matchedHostShellRule(config.hostBash.allow, shell, [allowSubject], config.cwd);
	if (allowRule !== undefined && !step.hasActiveExpansion) {
		return { decision: { action: "allow", reason: `matched ${ruleToolFor(shell)} allow rule '${allowRule}'`, matchedRule: allowRule }, subject, allowSubject, requiresRedirectAwareAllow };
	}
	const cell = cellAction(hostShellCell(profile), "host shell");
	if (allowRule !== undefined && step.hasActiveExpansion && cell.action === "prompt") {
		return { decision: { action: "prompt", reason: `${cell.reason} (allow rule '${allowRule}' cannot authorize active shell expansion)` }, subject, allowSubject, requiresRedirectAwareAllow };
	}
	// Profile cell.
	return { decision: cell, subject, allowSubject, requiresRedirectAwareAllow };
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
	analysis: ShellCommandAnalysis | null,
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
			const tier = degradedResearchTierReason(analysis, config);
			if (tier !== null) return { decision: { action: "allow", reason: tier }, steps: [], breakdown: degradedResearchBreakdown };
			return { decision: { action: "deny", reason: "degraded research: only read-only-tier commands run on the host" }, steps: [], breakdown: degradedResearchBreakdown };
		}
		return { decision: { action: "deny", reason: "host shell: denied in research (rules are ignored)" }, steps: [], breakdown: { available: false, reason: "research denies host execution regardless of steps" } };
	}

	const cmd = stripLineContinuations(call.command);
	const safetySubjects = [cmd, shell === "host-bash" ? analysis?.canonicalJoin ?? null : null, shell === "host-bash" ? analysis?.previousCanonicalJoin ?? null : null];
	const rawDeny = matchedHostShellRule(config.hostBash.deny, shell, safetySubjects, config.cwd);
	if (rawDeny !== undefined) return { decision: { action: "deny", reason: `matched ${ruleToolFor(shell)} deny rule '${rawDeny}'`, matchedRule: rawDeny }, steps: [], rawDenyRule: rawDeny, breakdown: { available: false, reason: "a whole-command deny rule matched" } };
	const rawAsk = matchedHostShellRule(config.hostBash.ask, shell, safetySubjects, config.cwd);

	if (shell === "pwsh") return evaluatePwshCommand(cmd, policy);

	// The whole-command branch is taken ONLY when no reliable call list exists
	// (analysis null, or a whole-command construct set the analysis cause). A
	// per-call flag leaves the analysis complete so every call is evaluated
	// below with its own completeness; the offending step still names itself
	// when the cause is whole-command.
	if (analysis == null || analysis.cause !== null) {
		const reason = analysis?.reason ?? shellAstStatus().diagnostic ?? "the bash parser is unavailable";
		const offending = analysis?.calls.find((c) => !c.complete)?.rawSubject;
		const breakdown: BreakdownReliability = offending === undefined ? { available: false, reason } : { available: false, reason, offending };
		if (rawAsk !== undefined) return { decision: { action: "prompt", reason: `matched ${ruleToolFor(shell)} ask rule '${rawAsk}'`, matchedRule: rawAsk, provenance: "explicit-ask" }, steps: [], rawAskRule: rawAsk, splitCause: reason, breakdown };
		if (profile === "yolo") return { decision: { action: "allow", reason: "host shell: yolo allows everything else" }, steps: [], splitCause: reason, breakdown };
		return { decision: { action: "prompt", reason }, steps: [], splitCause: reason, breakdown };
	}

	const evaluations = analysis.calls.map((c) => ({ sub: c.rawSubject, ev: evaluateHostShellSub({ subject: c.subject, previousSubject: c.previousSubject, allowSubject: c.allowSubject, rawSubject: c.rawSubject, tierNoopCdSubject: c.tierNoopCdSubject, argv: c.argv, redirects: c.redirects, hasParameterExpansion: c.hasParameterExpansion, hasActiveExpansion: c.hasActiveExpansion, pureAssignment: c.pureAssignment, requiresRedirectAwareAllow: hasWritableRedirect(c.redirects, config.writeRoots, { cwd: config.cwd }), incompleteReason: c.complete ? null : shellAnalysisCauseReason(c.cause ?? "unrecognized-node") }, policy, shell) }));
	const incompleteCall = analysis.calls.find((c) => !c.complete);
	const reliability: BreakdownReliability = incompleteCall === undefined
		? { available: analysis.calls.length > 0 }
		: { available: false, reason: shellAnalysisCauseReason(incompleteCall.cause ?? "unrecognized-node"), offending: incompleteCall.rawSubject };
	const toStep = (i: number, e: { sub: string; ev: ReturnType<typeof evaluateHostShellSub> }): HostShellStep => ({ occurrenceId: i, display: e.sub, rawSubject: e.sub, subject: e.ev.subject, allowSubject: e.ev.allowSubject, requiresRedirectAwareAllow: e.ev.requiresRedirectAwareAllow, decision: e.ev.decision });
	if (evaluations.length === 1) {
		const e = evaluations[0];
		const decision = e.ev.decision.action !== "deny" && rawAsk !== undefined ? { action: "prompt" as const, reason: `matched ${ruleToolFor(shell)} ask rule '${rawAsk}'`, matchedRule: rawAsk, provenance: "explicit-ask" as const } : e.ev.decision;
		return { decision, steps: [toStep(0, e)], rawAskRule: rawAsk, breakdown: reliability };
	}
	if (!evaluations.some((e) => e.ev.decision.action === "deny") && rawAsk !== undefined) {
		return { decision: { action: "prompt", reason: `matched ${ruleToolFor(shell)} ask rule '${rawAsk}'`, matchedRule: rawAsk, provenance: "explicit-ask" }, steps: evaluations.map((e, i) => toStep(i, e)), rawAskRule: rawAsk, breakdown: reliability };
	}
	const worst =
		evaluations.find((e) => e.ev.decision.action === "deny") ??
		evaluations.find((e) => e.ev.decision.action === "prompt") ??
		evaluations.find((e) => e.ev.decision.action === "classify") ??
		evaluations[0];
	const decision: Decision = { action: worst.ev.decision.action, matchedRule: worst.ev.decision.matchedRule, reason: `subcommand '${worst.sub}': ${worst.ev.decision.reason}`, provenance: evaluations.some((e) => e.ev.decision.provenance === "explicit-ask") ? "explicit-ask" : worst.ev.decision.provenance };
	return { decision, steps: evaluations.map((e, i) => toStep(i, e)), rawAskRule: rawAsk, failingSub: worst.sub, breakdown: reliability };
}

/**
 * Pwsh is evaluated as ONE whole-command step. Guard has no PowerShell
 * parser, so there is no split, no per-subcommand rules, and no read-only
 * tier (pwsh never had one): the whole command text is matched by Pwsh
 * deny/ask/allow rules, yolo allows, and the profile cell governs everything
 * else (a prompt for default/allow-edits/auto). A malformed command (an
 * unterminated quote) is the one fail-closed exception: it prompts instead of
 * reaching an allow cell. The whole-command deny match still runs first in
 * the caller.
 */
function evaluatePwshCommand(cmd: string, policy: PolicyState): HostShellExplanation {
	const breakdown: BreakdownReliability = { available: false, reason: "PowerShell commands are evaluated as one whole command (no per-step breakdown)" };
	const malformed = pwshMalformedReason(cmd);
	const subject = stripTimeoutPrefix(stripLineContinuations(cmd).trim());
	const requiresRedirectAwareAllow = hasTopLevelFileRedirect(cmd, policy.config.writeRoots, { cwd: policy.config.cwd });
	const ev = evaluateHostShellSub({ subject, previousSubject: subject, allowSubject: requiresRedirectAwareAllow ? subject : stripTrailingHarmlessRedirects(subject), rawSubject: subject, tierNoopCdSubject: subject, argv: [], redirects: [], hasParameterExpansion: false, hasActiveExpansion: false, pureAssignment: false, requiresRedirectAwareAllow, incompleteReason: malformed }, policy, "pwsh");
	if (malformed !== null) return { decision: ev.decision, steps: [], splitCause: malformed, breakdown };
	const step: HostShellStep = { occurrenceId: 0, display: cmd, rawSubject: subject, subject: ev.subject, allowSubject: ev.allowSubject, requiresRedirectAwareAllow: ev.requiresRedirectAwareAllow, decision: ev.decision };
	return { decision: ev.decision, steps: [step], breakdown };
}

/**
 * The pwsh syntactic sanity gate: the whole command is one step, so an
 * unterminated single or double quote means the text cannot be trusted and
 * must prompt rather than reach an allow cell. This is NOT a split: no parts
 * are projected and no per-subcommand rule runs. PowerShell's backtick escape
 * is not modelled; an unmodelled case fails closed (prompts).
 */
function pwshMalformedReason(cmd: string): string | null {
	let inSingle = false;
	let inDouble = false;
	let i = 0;
	while (i < cmd.length) {
		const ch = cmd[i];
		if (ch === "\\" && !inSingle) { i += 2; continue; }
		if (ch === "'" && !inDouble) { inSingle = !inSingle; i++; continue; }
		if (ch === '"' && !inSingle) { inDouble = !inDouble; i++; continue; }
		i++;
	}
	return inSingle || inDouble ? "the PowerShell command has an unterminated quote" : null;
}

/**
 * Decide a host shell call (host_bash or pwsh). Bash compounds are split by
 * the AST adapter and each call is evaluated independently; pwsh is one
 * whole-command step. Aggregation: deny > prompt > classify > allow,
 * attributed to the worst call. Per profile:
 *   research     absolute deny (rules ignored); degraded mode is the one
 *                exception, where host_bash takes the whole-command
 *                read-only tier and allow rules never widen it.
 *   yolo         deny rules block, ask rules prompt, everything else allows.
 *   unrestricted allow, rules ignored.
 *   otherwise    evaluateHostShellSub per call.
 * An analysis-level failure prompts, and a malformed pwsh prompt, but an
 * explicit deny rule on the raw command still denies (deny rules always win).
 */
export function decideHostShellCommand(
	call: Extract<GuardCall, { kind: "host-shell" }>,
	policy: PolicyState,
	analysis: ShellCommandAnalysis | null,
): Decision {
	return evaluateHostShell(call, policy, analysis).decision;
}

/**
 * The per-step projection of exactly the evaluation decideHostShellCommand
 * performs: same aggregate decision, plus steps, causes, and breakdown
 * reliability. Never re-decides reconstructed fragments.
 */
export function explainHostShellCommand(
	call: Extract<GuardCall, { kind: "host-shell" }>,
	policy: PolicyState,
	analysis: ShellCommandAnalysis | null,
): HostShellExplanation {
	return evaluateHostShell(call, policy, analysis);
}

/**
 * The rungs the host-shell approval dialog may offer as a computed profile
 * switch. The ladder is NOT a permission ordering (default can allow what auto
 * denies through classification), so this is an eligibility allow-list, not a
 * promise that each rung qualifies: yolo and unrestricted are never offered.
 */
export const SWITCH_CANDIDATES: readonly Profile[] = ["allow-edits", "auto", "trusted"];

/**
 * The computed profile-switch rungs for one host-shell call: the pinned
 * candidate set filtered to the rungs that would allow this exact call under a
 * pure re-decision, excluding the current profile. Pure and synchronous: it
 * never resolves an auto "classify" cell (no classifier calls here), so a
 * prompting call can only ever qualify "trusted" with the current cells; that
 * collapse is asserted in tests/guard-policy.test.mts.
 */
export function qualifyingSwitchRungs(
	call: Extract<GuardCall, { kind: "host-shell" }>,
	policy: PolicyState,
	analysis: ShellCommandAnalysis | null,
): Profile[] {
	return SWITCH_CANDIDATES.filter((rung) =>
		rung !== policy.profile && explainHostShellCommand(call, { ...policy, profile: rung }, analysis).decision.action === "allow");
}

/**
 * The sessions directory the session-search extension reads, resolved the same
 * way that extension resolves it for the production case (no explicit home
 * argument): PI_CODING_AGENT_DIR wins when set, else ~/.pi/agent, plus
 * "/sessions". Purely string-based: environment values, homedir, and path
 * joins, never a filesystem call. pi resolves the same path as
 * join(getAgentDir(), "sessions").
 */
export function sessionSearchRoot(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
	const agentDir = env.PI_CODING_AGENT_DIR;
	const base = agentDir !== undefined && agentDir.trim() !== "" ? expandTilde(agentDir, home) : join(home, ".pi", "agent");
	return join(base, "sessions");
}

/** Expand a leading ~ the way pi's normalizePath does (~/ and, on Windows, ~\). */
function expandTilde(p: string, home: string): string {
	if (p === "~") return home;
	if (p.startsWith("~/") || (process.platform === "win32" && p.startsWith("~\\"))) return join(home, p.slice(2));
	return p;
}

/**
 * Containment for session_excerpt: the sessions tree only, never cwd. Reuses
 * the read-only tier's string containment with that tree as the implicit root,
 * so Windows case-insensitivity and ~/.. normalization behave the same.
 */
function pathInsideSessionsRoot(p: string, env: NodeJS.ProcessEnv = process.env): boolean {
	return pathInsideAllowedRoots(p, sessionSearchRoot(env), []);
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
	// session_excerpt reads one file from the sessions tree, which is that
	// tool's own data rather than workspace data: treat it as inside the roots.
	// Scoped to this tool on purpose: every other local-read tool (including
	// the `read` tool) keeps ordinary containment.
	if (call.tool === "session_excerpt" && hasPath && pathInsideSessionsRoot(call.path as string)) {
		return { action: "allow", reason: "session excerpt inside the sessions directory" };
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
export function decide(policy: PolicyState, call: GuardCall, analysis: ShellCommandAnalysis | null): Decision {
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
			return decideHostShellCommand(call, policy, analysis);
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
	analysis: ShellCommandAnalysis | null,
): Promise<Decision & { action: "allow" | "prompt" | "deny" }> {
	const d = decide(policy, call, analysis);
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
