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
 *   research     absolute: rules ignored, deny (degraded sandboxed bash:
 *                only tier-proven read-only commands, allow rules never
 *                widen that set).
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
	splitTopLevelShell,
	stripStructuralKeywords,
	stripTimeoutPrefix,
	stripTrailingHarmlessRedirects,
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
 * Double quotes do NOT protect: `"$HOME"` still expands.
 */
export function hasDollarExpansionOutsideSingleQuotes(s: string): boolean {
	let inSingle = false;
	let i = 0;
	while (i < s.length) {
		const ch = s[i];
		if (ch === "\\" && !inSingle) { i += 2; continue; }
		if (ch === "'" && !inSingle) { inSingle = true; i++; continue; }
		if (ch === "'" && inSingle) { inSingle = false; i++; continue; }
		if (!inSingle && ch === "$") return true;
		i++;
	}
	return false;
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
function maskedPathReason(path: string, config: ResolvedGuardConfig): string | null {
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
 * The tier for SANDBOXED bash running in degraded mode (research): the
 * tightened host tier applies (host vetoes included: degraded execution is
 * host execution, so env/printenv, $ expansion, and secret-mask file
 * arguments are not proven read-only). Allow rules never widen this set.
 * Returns an allow reason or null.
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
 * Decide one (already split) host shell subcommand, for the
 * default/auto/trusted precedence: deny > ask > tier > redirect-aware allow
 * rules > redirect requirement > cell.
 */
function decideHostShellSub(command: string, policy: PolicyState, shell: "host-bash" | "pwsh"): Decision {
	const { config, profile } = policy;
	const cmd = stripTimeoutPrefix(stripLineContinuations(command).trim());
	// Explicit rules: deny > ask (redirect-agnostic; safety rules win first).
	const denyRule = matchedHostShellRule(config.hostBash.deny, shell, cmd, config.cwd);
	if (denyRule !== undefined) return { action: "deny", reason: `matched ${ruleToolFor(shell)} deny rule '${denyRule}'` };
	const askRule = matchedHostShellRule(config.hostBash.ask, shell, cmd, config.cwd);
	if (askRule !== undefined) return { action: "prompt", reason: `matched ${ruleToolFor(shell)} ask rule '${askRule}'` };
	// Tightened read-only tier (host_bash only; host vetoes first).
	if (shell === "host-bash") {
		const tier = hostTierAllowReason(cmd, config);
		if (tier !== null) return { action: "allow", reason: tier };
	}
	// Redirect handling: a top-level file redirect (outside the writeRoots
	// exemptions) may only be authorized by a redirect-aware allow rule (one
	// whose pattern contains ">"). Broad rules and the profile cell never
	// authorize a write redirect.
	if (hasTopLevelFileRedirect(cmd, config.writeRoots, { cwd: config.cwd })) {
		for (const raw of config.hostBash.allow) {
			const rule = parseRule(raw);
			if (rule && rulePatternAllowsRedirect(rule) && ruleMatches(rule, ruleToolFor(shell), { command: cmd }, config.cwd)) {
				return { action: "allow", reason: `matched redirect-aware allow rule '${raw}'` };
			}
		}
		return { action: "prompt", reason: "file redirect requires a redirect-aware allow rule (a pattern containing '>')" };
	}
	// Plain allow rules.
	const allowRule = matchedHostShellRule(config.hostBash.allow, shell, stripTrailingHarmlessRedirects(cmd), config.cwd);
	if (allowRule !== undefined) {
		return { action: "allow", reason: `matched ${ruleToolFor(shell)} allow rule '${allowRule}'` };
	}
	// Profile cell.
	return cellAction(hostShellCell(profile), "host shell");
}

/**
 * Decide a host shell call (host_bash or pwsh), splitting compounds so each
 * subcommand is evaluated independently. Aggregation: deny > prompt >
 * classify > allow, attributed to the worst subcommand. Per profile:
 *   research     absolute deny (rules ignored).
 *   yolo         deny rules block, ask rules prompt, everything else allows.
 *   unrestricted allow, rules ignored.
 *   otherwise    decideHostShellSub per subcommand.
 * An ambiguous split prompts, but an explicit deny rule on the raw command
 * still denies (deny rules always win).
 */
export function decideHostShellCommand(
	call: Extract<GuardCall, { kind: "host-shell" }>,
	policy: PolicyState,
): Decision {
	const { profile, config } = policy;
	const shell = call.shell;
	if (profile === "unrestricted") return { action: "allow", reason: "host shell: unrestricted profile allows everything" };
	if (profile === "research") return { action: "deny", reason: "host shell: denied in research (rules are ignored)" };

	const cmd = stripLineContinuations(call.command);
	if (profile === "yolo") {
		const denyRule = matchedHostShellRule(config.hostBash.deny, shell, cmd, config.cwd);
		if (denyRule !== undefined) return { action: "deny", reason: `matched ${ruleToolFor(shell)} deny rule '${denyRule}'` };
		const askRule = matchedHostShellRule(config.hostBash.ask, shell, cmd, config.cwd);
		if (askRule !== undefined) return { action: "prompt", reason: `matched ${ruleToolFor(shell)} ask rule '${askRule}'` };
		return { action: "allow", reason: "host shell: yolo allows everything else" };
	}

	const split = splitTopLevelShell(cmd);
	if (split.kind === "ambiguous") {
		const denyRule = matchedHostShellRule(config.hostBash.deny, shell, cmd, config.cwd);
		if (denyRule !== undefined) return { action: "deny", reason: `matched ${ruleToolFor(shell)} deny rule '${denyRule}'` };
		return { action: "prompt", reason: "complex command could not be split for per-subcommand checks" };
	}
	if (split.kind === "single") {
		const effective = split.effectiveCmd ?? cmd;
		return decideHostShellSub(effective, policy, shell);
	}
	const parts: string[] = [];
	for (const rawSub of split.parts) {
		const stripped = stripStructuralKeywords(rawSub);
		if (stripped !== null) parts.push(stripped);
	}
	if (parts.length === 0) return { action: "allow", reason: "no commands after structural stripping" };
	if (parts.length === 1) return decideHostShellSub(parts[0], policy, shell);
	const breakdown = parts.map((p) => ({ sub: p, decision: decideHostShellSub(p, policy, shell) }));
	const worst =
		breakdown.find((b) => b.decision.action === "deny") ??
		breakdown.find((b) => b.decision.action === "prompt") ??
		breakdown.find((b) => b.decision.action === "classify") ??
		breakdown[0];
	// The reason comes from the worst subcommand, attributed to it.
	return { action: worst.decision.action, reason: `subcommand '${worst.sub}': ${worst.decision.reason}` };
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

/** Decide a local read (read/grep/find/ls/fffind/ffgrep). */
export function decideLocalRead(call: Extract<GuardCall, { kind: "local-read" }>, policy: PolicyState): Decision {
	const { profile, config } = policy;
	const hasPath = call.path !== undefined && call.path.trim() !== "";
	// Secret masks are path-level only in step 2: a grep over a directory
	// that happens to contain a masked file is allowed. Documented gap; step 3
	// adds a tool_result filter that drops matches from masked files.
	if (hasPath) {
		const masked = maskedPathReason(call.path as string, config);
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
	// Local writes without a path (memory_write, scratchpad, ...) are allowed
	// in every profile except research; pi's tool-call rendering shows them.
	if (call.path === undefined || call.path.trim() === "") {
		return { action: "allow", reason: "local write without a path (allowed outside research)" };
	}
	if (makeIsProtectedPath(config)(call.path)) {
		return cellAction(protectedPathCell(profile), `protected path ${call.path}`);
	}
	const cell = writeEditCell(profile);
	if (cell === "roots") {
		return pathInsideWriteRoots(call.path, config)
			? { action: "allow", reason: "write inside cwd or a configured write root" }
			: { action: "prompt", reason: "write outside cwd and every write root" };
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
 * Degraded sandboxed exec (the sandbox IS host execution). research: only
 * commands the read-only tier or validators prove read-only are allowed, and
 * allow rules never widen that set. Other profiles: the host-shell row.
 */
function decideDegradedSandboxedExec(call: Extract<GuardCall, { kind: "sandboxed-exec" }>, policy: PolicyState): Decision {
	const { profile, config } = policy;
	if (profile === "research") {
		const cmd = call.command ?? "";
		if (cmd.trim() === "") return { action: "deny", reason: "degraded research: no command to prove read-only" };
		const tier = degradedResearchTierReason(stripTimeoutPrefix(stripLineContinuations(cmd).trim()), config);
		if (tier !== null) return { action: "allow", reason: tier };
		return { action: "deny", reason: "degraded research: only read-only-tier commands run on the host" };
	}
	return decideHostShellCommand({ kind: "host-shell", shell: "host-bash", command: call.command ?? "" }, policy);
}

/**
 * The pure decision function. Total over all GuardCall shapes and profiles;
 * "classify" results must be resolved through resolveDecision().
 */
export function decide(policy: PolicyState, call: GuardCall): Decision {
	const { profile, config } = policy;

	switch (call.kind) {
		case "sandboxed-exec": {
			// Degraded mode: the sandbox is unavailable, so sandboxed bash IS
			// host execution and follows the host-shell row (research: tier only).
			if (policy.sandboxMode === "degraded") return decideDegradedSandboxedExec(call, policy);
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
): Promise<{ action: "allow" | "prompt" | "deny"; reason: string }> {
	const d = decide(policy, call);
	if (d.action !== "classify") {
		return finalize(policy, d.action, d.reason);
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
