/**
 * Protected-path predicate, shared by the decision core, index.ts, and the
 * tests (previously duplicated between index.ts and the test helper, which
 * disagreed). A path is protected when either holds:
 *   - its first component relative to cwd is in PROTECTED_TOP_LEVEL (from
 *     sandbox/spec.ts) or in guard.json `protectedPaths`, or
 *   - any deeper component is in PROTECTED_NESTED_NAMES (nested repos,
 *     submodules, instruction files, direnv scripts).
 * The whole .git tree is protected: ".git" is both a top-level name and a
 * nested name. Absolute and cwd-relative paths are both handled.
 *
 * Pure string logic; no filesystem access.
 */

import {
	PROTECTED_NESTED_NAMES,
	PROTECTED_TOP_LEVEL,
} from "../sandbox/spec.ts";
import { normalizeMatchPath } from "./paths.ts";
import type { ResolvedGuardConfig } from "./config.ts";

export interface ProtectedPathPredicate {
	(path: string): boolean;
	/** The top-level names the predicate checks (built-ins plus config extras). */
	topLevel: readonly string[];
	/** The nested names the predicate checks below the top level. */
	nested: readonly string[];
}

/**
 * Build the predicate for a resolved config. Relative paths resolve against
 * the config's cwd; absolute paths are used as-is (a path outside cwd is only
 * protected when a component still matches, e.g. an absolute path into
 * <cwd>/.git or a config extra like an absolute root).
 */
export function makeIsProtectedPath(config: ResolvedGuardConfig): ProtectedPathPredicate {
	const topLevel = new Set<string>([...PROTECTED_TOP_LEVEL, ...config.protectedPaths]);
	const nested = new Set<string>(PROTECTED_NESTED_NAMES);
	const predicate = (path: string): boolean => {
		const raw = (path ?? "").trim();
		if (!raw) return false;
		let rel: string;
		if (/^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith("/")) {
			const abs = normalizeMatchPath(raw, config.cwd);
			const cwdNorm = normalizeMatchPath(config.cwd, config.cwd);
			rel = abs === cwdNorm || abs.startsWith(`${cwdNorm}/`) ? abs.slice(cwdNorm.length + 1) : abs.replace(/^\/+/, "");
		} else {
			rel = raw.replace(/\\/g, "/").replace(/^\/+/, "");
		}
		rel = rel.replace(/\/+$/, "");
		if (!rel) return false;
		const parts = rel.split("/").filter((p) => p.length > 0);
		if (parts.length === 0) return false;
		if (topLevel.has(parts[0])) return true;
		// Nested protected names at any depth below the top level.
		for (let i = 1; i < parts.length; i++) {
			if (nested.has(parts[i])) return true;
		}
		return false;
	};
	predicate.topLevel = [...topLevel];
	predicate.nested = [...nested];
	return predicate;
}
