/** Rule coverage is independent of winning rules and tier/profile authorization. */
import { createHash } from "node:crypto";
import type * as Rules from "../../extensions/guard/policy/rules.ts";
import type * as Tier from "../../extensions/guard/policy/bashtier.ts";
import type * as Text from "../../extensions/guard/policy/shell-text.ts";
import type { ResolvedGuardConfig } from "../../extensions/guard/policy/config.ts";

export const SLOTS = ["deny", "ask", "allow"] as const;
export type Slot = typeof SLOTS[number];
export interface Analysis {
	cause: string | null;
	canonicalJoin?: string | null;
	previousCanonicalJoin?: string | null;
	calls: readonly {
		complete: boolean;
		subject: string | null;
		previousSubject?: string | null;
		rawSubject?: string;
		/** Absent in frozen analyses from revisions before active-expansion eligibility. */
		hasActiveExpansion?: boolean;
		redirects: readonly { op: string; target: string | null }[];
	}[];
}
export interface CompiledRule {
	slot: Slot;
	index: number;
	text: string;
	parsed: Rules.ParsedRule;
}
export interface Coverage {
	key: string;
	subjects: string[];
}
export interface APIs {
	rules: typeof Rules;
	tier: typeof Tier;
	text: typeof Text;
}

export function compileRules(config: ResolvedGuardConfig, api: APIs): CompiledRule[] {
	return SLOTS.flatMap((slot) => config.hostBash[slot].map((text, index) => {
		const parsed = api.rules.parseRule(text);
		if (parsed === null) throw new Error(`invalid frozen ${slot} rule at ${index}`);
		return { slot, index, text, parsed };
	}));
}

/** All syntactically eligible rule matches, even when another rule or tier wins. */
export function ruleCoverage(
	command: string,
	analysis: Analysis,
	config: ResolvedGuardConfig,
	compiled: readonly CompiledRule[],
	api: APIs,
	canonical: boolean,
): Coverage[] {
	// The runner labels the baseline non-canonical, but a baseline can itself
	// be a canonical revision. Detect its analysis shape instead of assuming
	// that every baseline predates the switch.
	canonical ||= Object.hasOwn(analysis, "canonicalJoin");
	const safety: string[] = [api.tier.stripLineContinuations(command)];
	if (canonical && analysis.canonicalJoin != null) safety.push(analysis.canonicalJoin);
	if (canonical && analysis.previousCanonicalJoin != null) safety.push(analysis.previousCanonicalJoin);
	const allows: Array<{ subject: string; redirectAware: boolean }> = [];
	if (analysis.cause === null) {
		for (const call of analysis.calls) {
			const normalized = call.subject === null ? null : canonical ? call.subject
				: api.text.stripTimeoutPrefix(api.tier.stripLineContinuations(call.subject).trim());
			if (normalized !== null) safety.push(normalized);
			if (canonical && call.previousSubject != null) safety.push(call.previousSubject);
			if (canonical && call.rawSubject !== undefined) safety.push(call.rawSubject);
			// Active-expansion eligibility: an expansion-bearing call is never
			// allow-authorizable. Frozen baselines from older revisions lack the
			// flag; keep legacy candidacy there so paired comparisons measure
			// exactly the eligibility change.
			if (call.hasActiveExpansion) continue;
			if (!call.complete || normalized === null) continue;
			const redirectAware = api.tier.hasWritableRedirect(call.redirects, config.writeRoots, { cwd: config.cwd });
			allows.push({ subject: redirectAware ? normalized : api.text.stripTrailingHarmlessRedirects(normalized, canonical), redirectAware });
		}
	}
	return compiled.flatMap((rule) => {
		const candidates = rule.slot === "allow"
			? allows.filter((c) => !c.redirectAware || api.rules.rulePatternAllowsRedirect(rule.parsed)).map((c) => c.subject)
			: safety;
		const subjects = [...new Set(candidates)].filter((subject) => api.rules.ruleMatches(rule.parsed, "HostBash", { command: subject }, config.cwd));
		return subjects.length === 0 ? [] : [{ key: `${rule.slot}:${rule.index}`, subjects }];
	});
}

/** Labelled specimens only: no invented values for interior glob/regex patterns. */
export function ruleProbes(raw: { hostBash?: Partial<Record<Slot, string[]>> }, parseRule: typeof Rules.parseRule) {
	const probes = new Map<string, { id: string; tool: "rule-probe"; command: string; probes: Array<{ slot: Slot; index: number; text: string }> }>();
	for (const slot of SLOTS) for (const [index, text] of (raw.hostBash?.[slot] ?? []).entries()) {
		const rule = parseRule(text);
		if (rule?.tool !== "hostbash" || !rule.pattern || !/[~$'"]/.test(rule.pattern)) continue;
		if (rule.pattern.startsWith("/") && rule.pattern.endsWith("/")) continue;
		// A trailing space-star is optional in this grammar. Remove only that
		// suffix, never guess arguments for interior globs or regex syntax.
		const command = rule.pattern.replace(/ \*$/, "");
		if (command.includes("*") || /(?<!\$)\?/.test(command) || /[\r\n]/.test(command)) continue;
		const id = createHash("sha256").update(command).digest("hex").slice(0, 12);
		const existing = probes.get(command);
		if (existing) existing.probes.push({ slot, index, text });
		else probes.set(command, { id, tool: "rule-probe", command, probes: [{ slot, index, text }] });
	}
	return [...probes.values()];
}

/**
 * Allow-slot rules whose pattern happens to match an expansion-marker subject.
 * These rules are ineligible to authorize expansion-bearing commands under the
 * active-expansion eligibility contract; this reports the compatibility
 * boundary (a legacy rule that still textually matches the marker encoding).
 * Works on frozen analyses regardless of flag presence: any call whose
 * canonical subject contains the marker namespace is a match surface.
 */
export function markerMatchingRules(
	analysis: Analysis,
	config: ResolvedGuardConfig,
	compiled: readonly CompiledRule[],
	api: APIs,
	canonical: boolean,
): Coverage[] {
	if (!canonical || analysis.cause !== null) return [];
	const markerCandidates = analysis.calls
		.filter((call) => call.complete && call.subject !== null && /@guard:exp:/i.test(call.subject))
		.map((call) => {
			const redirectAware = api.tier.hasWritableRedirect(call.redirects, config.writeRoots, { cwd: config.cwd });
			return { subject: redirectAware ? call.subject! : api.text.stripTrailingHarmlessRedirects(call.subject!, true), redirectAware };
		});
	if (markerCandidates.length === 0) return [];
	return compiled.flatMap((rule) => {
		if (rule.slot !== "allow") return [];
		const subjects = [...new Set(markerCandidates.filter((c) => !c.redirectAware || api.rules.rulePatternAllowsRedirect(rule.parsed)).map((c) => c.subject))]
			.filter((subject) => api.rules.ruleMatches(rule.parsed, "HostBash", { command: subject }, config.cwd));
		return subjects.length === 0 ? [] : [{ key: `${rule.slot}:${rule.index}`, subjects }];
	});
}

export function coverageDelta(before: readonly Coverage[], after: readonly Coverage[]): { lost: string[]; gained: string[] } {
	const oldKeys = new Set(before.map((r) => r.key));
	const newKeys = new Set(after.map((r) => r.key));
	return { lost: [...oldKeys].filter((key) => !newKeys.has(key)), gained: [...newKeys].filter((key) => !oldKeys.has(key)) };
}
