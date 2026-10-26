/**
 * Memory-only session-scoped host-shell allow rules ("Allow for this
 * session"). Reviewed rules are installed at an approval commit and never
 * serialized: no config file, session entry, environment variable, or child
 * contract carries them, and they are discarded when a fresh session starts.
 *
 * Scope: a grant belongs to the workspace it was approved in and to every
 * descendant workspace. Applicability requires BOTH lexical containment of the
 * current workspace spelling AND, when the current workspace resolves on disk,
 * physical (realpath) containment of it. That conjunction is deliberate: a
 * symlinked descendant that escapes the granting workspace passes the lexical
 * check alone, and a symlink into the granting workspace passes the physical
 * check alone; neither may widen a grant. An unresolvable identity fails
 * closed (no grant). Comparisons follow the platform's path semantics (the
 * shared component-aware `isWithin`): a differently cased spelling of the same
 * directory is rejected on a case-sensitive platform (fail closed) and folds
 * on a case-insensitive one.
 *
 * Grants stay recorded for every workspace visited in the session; rules for
 * unrelated workspaces go dormant rather than being discarded, so navigating
 * back reactivates them.
 */
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { isWithin } from "./sandbox/host-paths.ts";

/** The workspace identity of one grant: display spelling plus canonical roots. */
export interface SessionShellScope {
	/** The workspace as displayed to the user (the granting cwd spelling). */
	workspace: string;
	/** Resolved (lexical) spellings of the granting workspace. */
	lexical: string[];
	/** Canonical (realpath) identities of the granting workspace. */
	real: string[];
}

export interface SessionShellGrant {
	scope: SessionShellScope;
	rules: string[];
}

/**
 * Resolve one workspace into a grant scope, or null when its canonical
 * identity is unavailable (a missing directory, a permission failure, or any
 * other filesystem error). Callers must treat null as "cannot grant here" and
 * never offer or create a session allow for it.
 */
export function resolveWorkspaceScope(workspace: string): SessionShellScope | null {
	const lexical = resolve(workspace);
	let real: string;
	try { real = realpathSync(lexical); } catch { return null; }
	return { workspace, lexical: [...new Set([lexical])], real: [...new Set([real])] };
}

/**
 * True when a workspace is the granting workspace or a descendant of it.
 * Lexical containment is checked first (cheap, and it rejects unrelated
 * workspaces whose realpath happens to land inside the scope), then physical
 * containment; an unresolvable current workspace is never covered.
 */
export function scopeContains(scope: SessionShellScope, cwd: string): boolean {
	const lexical = resolve(cwd);
	if (!scope.lexical.some((root) => isWithin(lexical, root))) return false;
	let real: string;
	try { real = realpathSync(lexical); } catch { return false; }
	return scope.real.some((root) => isWithin(real, root));
}

function dedupeRules(rules: readonly string[]): string[] {
	const out: string[] = [];
	for (const rule of rules) {
		const trimmed = rule.trim();
		if (trimmed !== "" && !out.includes(trimmed)) out.push(trimmed);
	}
	return out;
}

/** One session's in-memory grant records, keyed by canonical workspace identity. */
export class SessionShellRuleStore {
	private grants: SessionShellGrant[] = [];

	/** Drop every record (a fresh session start). */
	reset(): void {
		this.grants = [];
	}

	/**
	 * Every recorded grant, for inspection and listing. Shallow copies: the
	 * stored records are immutable by construction, and a caller must not be
	 * able to mutate one through the returned view.
	 */
	list(): readonly SessionShellGrant[] {
		return this.grants.map((grant) => ({ scope: grant.scope, rules: [...grant.rules] }));
	}

	/**
	 * The allow rules applicable to one workspace, deduplicated in insertion
	 * order. Records for other workspaces stay dormant and contribute nothing.
	 */
	rulesFor(cwd: string): string[] {
		const rules: string[] = [];
		for (const grant of this.grants) {
			if (!scopeContains(grant.scope, cwd)) continue;
			for (const rule of grant.rules) if (!rules.includes(rule)) rules.push(rule);
		}
		return rules;
	}

	/**
	 * Append reviewed rules to one workspace's record, replacing the record
	 * immutably. Identical rules are never duplicated, and an all-duplicate
	 * addition leaves the store untouched. A second grant for the same physical
	 * directory extends the record instead of replacing it: the workspace
	 * spellings and canonical roots accumulate (so a directory reached through
	 * a symlink and through its target stays one record that covers both
	 * spellings), while the newest spelling is what gets displayed.
	 */
	add(scope: SessionShellScope, rules: readonly string[]): void {
		const added = dedupeRules(rules);
		if (added.length === 0) return;
		const index = this.grants.findIndex((grant) => grant.scope.real.some((root) => scope.real.includes(root)));
		if (index === -1) {
			this.grants = [...this.grants, { scope, rules: added }];
			return;
		}
		const existing = this.grants[index];
		const merged = [...existing.rules, ...added.filter((rule) => !existing.rules.includes(rule))];
		const combined: SessionShellScope = {
			workspace: scope.workspace,
			lexical: [...new Set([...existing.scope.lexical, ...scope.lexical])],
			real: [...new Set([...existing.scope.real, ...scope.real])],
		};
		this.grants = this.grants.map((grant, at) => (at === index ? { scope: combined, rules: merged } : grant));
	}
}
