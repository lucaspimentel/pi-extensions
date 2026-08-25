// Shared helpers for all test files.
//
// The pure logic (rule matching, decide, suggestRule, config merge, classifier
// helpers, etc.) lives in index.ts and is re-exported here so the tests exercise
// the REAL code, not a hand-maintained mirror. Run the suites with
// `node --experimental-strip-types` (Node >= 22.6) so the .mjs tests can import
// the .ts module — see run-all.mjs.
//
// Only genuinely test-only helpers (makeCfg, makeTestRunner) and a thin alias
// for saveUserConfig live in this file.

import {
	normalizeToolDefaultsKeys,
	coerceDefaultAction,
	saveUserConfig,
} from "./index.ts";

// ── Re-export the real pure functions from index.ts ──────────────────────
export {
	normalizeTool,
	normalizePathSep,
	normalizeMatchPath,
	cwdGlobPattern,
	skillReadGlobs,
	piDocsReadGlobs,
	isNoopCd,
	isReadOnlyBashSubcommand,
	hasTopLevelFileRedirect,
	rulePatternAllowsRedirect,
	normalizeToolDefaultsKeys,
	coerceDefaultAction,
	compilePattern,
	parseRule,
	getMatchField,
	ruleMatches,
	inputForMatching,
	suggestRule,
	stripLineContinuations,
	splitTopLevelShell,
	stripStructuralKeywords,
	decideCompound,
	shouldClassifyWholeCompound,
	decide,
	actionIcon,
	formatBreakdownLine,
	formatBreakdown,
	recomputeBreakdown,
	modelCostScore,
	hasPrice,
	dedupeModels,
	rankClassifierModels,
	pickClassifierModel,
	modelLabel,
	pickableModels,
	autoStatusLabel,
	classifierAttribution,
	describeAction,
	mcpPreview,
	buildClassifierPrompt,
	buildActionContext,
	findGitRoot,
	leadingCdTarget,
	resolveAgainstCwd,
	parseClassifierResponse,
	verdictToAction,
	classifierCacheKey,
	classifyAction,
	mergeConfig as loadConfigFromObjects,
	// Config paths / disk IO (test-friendly aliases below)
	PROJECT_CONFIG_REL,
	LEGACY_PROJECT_CONFIG_REL,
	LEGACY2_PROJECT_CONFIG_REL,
	projectConfigPath,
	legacyProjectConfigPath,
	legacy2ProjectConfigPath,
	loadProjectConfigRaw as loadProjectConfigFromDisk,
	saveProjectConfig as saveProjectConfigToDisk,
	userConfigPath,
	legacyUserConfigPath,
	loadUserConfigRaw as loadUserConfigFromDisk,
	DEFAULT_AUTO_MODE,
} from "./index.ts";

// saveUserConfigToDisk(home, cfg) — index.ts's saveUserConfig takes (cfg, home).
export function saveUserConfigToDisk(home, cfg) {
	return saveUserConfig(cfg, home);
}

// ── Test-only helpers ─────────────────────────────────────────────────────

/** Build a minimal ResolvedConfig for decide/decideCompound tests.
 * Note: bashReadOnlyAllowCwd defaults to false here to preserve existing test
 * semantics. Pass bashReadOnlyAllowCwd: true explicitly when testing that feature.
 */
export function makeCfg({ allow = [], deny = [], ask = [], toolDefaults = {}, defaultAction = "ask", allowNoopCd = true, bashReadOnlyAllowCwd = false, cwd = process.cwd(), autoMode } = {}) {
	// Normalize toolDefault keys so decide() can look them up via normalizeTool()
	// Coerce legacy `defaultAction: "auto"` → "ask" (auto mode is now a session toggle).
	return { allow, deny, ask, toolDefaults: normalizeToolDefaultsKeys(toolDefaults), defaultAction: coerceDefaultAction(defaultAction), allowNoopCd, bashReadOnlyAllowCwd, cwd, autoMode: autoMode ?? { classifier: undefined, environment: [], allow: [], soft_deny: [], hard_deny: [], classifyAllShell: false }, implicit: { allow: [], toolDefaults: {}, readAllowCwd: true, grepAllowCwd: true, globAllowCwd: true, lsAllowCwd: true, readAllowSkills: true, readAllowPiDocs: true, bashReadOnlyAllowCwd, allowNoopCd } };
}

// ── Test runner ───────────────────────────────────────────────────────────

export function makeTestRunner() {
	let pass = 0, fail = 0;

	function test(desc, actual, expected) {
		const ok = actual === expected;
		console.log((ok ? "  ✓" : "  ✗") + " " + desc);
		if (!ok) {
			console.log(`      got:      ${JSON.stringify(actual)}`);
			console.log(`      expected:  ${JSON.stringify(expected)}`);
		}
		ok ? pass++ : fail++;
	}

	function section(name) {
		console.log(`\n── ${name} ${"─".repeat(Math.max(0, 50 - name.length))}`);
	}

	function summary() {
		console.log(`\n  ${pass} passed, ${fail} failed`);
		return fail;
	}

	return { test, section, summary };
}
