// run: node test-rules-and-decide.mjs

import {
	makeTestRunner, compilePattern, parseRule, ruleMatches, decide, decideCompound, shouldClassifyWholeCompound, makeCfg,
	cwdGlobPattern, normalizePathSep, inputForMatching, recomputeBreakdown,
	loadConfigFromObjects,
	verdictToAction, parseClassifierResponse, buildClassifierPrompt, describeAction,
	classifyAction, classifierCacheKey, pickClassifierModel, rankClassifierModels, dedupeModels,
	buildActionContext, findGitRoot, leadingCdTarget, resolveAgainstCwd,
	getMatchField, suggestRule, mcpPreview,
	DEFAULT_AUTO_MODE,
} from "./test-helpers.mjs";

// Aliases for the real DEFAULT_AUTO_MODE lists in index.ts — no hand-maintained mirror.
const DEFAULT_ALLOW = DEFAULT_AUTO_MODE.allow;
const DEFAULT_SOFT_DENY = DEFAULT_AUTO_MODE.soft_deny;

const { test, section, summary } = makeTestRunner();

// ── compilePattern — glob ─────────────────────────────────────────────────

section("compilePattern — glob");

test("* matches any characters",              compilePattern("npm*").test("npm test --watch"), true);
test("* matches across slashes",              compilePattern("src/*").test("src/foo/bar.ts"), true);
test("** same as * (both map to .*)",         compilePattern("src/**").test("src/a/b/c.ts"), true);
test("? matches exactly one char",            compilePattern("file.?s").test("file.ts"), true);
test("? does NOT match two chars",            compilePattern("file.?s").test("file.tsx"), false);
test("case-insensitive by default",           compilePattern("npm*").test("NPM test"), true);
test("entire string must match (anchored)",   compilePattern("npm").test("npm test"), false);

// special regex chars escaped in glob mode
test(". is literal (not regex wildcard)",     compilePattern(".env").test("Xenv"), false);
test(". matches a literal dot",               compilePattern(".env*").test(".envrc"), true);
test("+ is literal",                          compilePattern("a+b").test("a+b"), true);
test("+ is NOT regex +",                      compilePattern("a+b").test("aab"), false);
test("( and ) are literal in glob",           compilePattern("Bash(npm*)").test("Bash(npm test)"), true);
test("[ is literal",                          compilePattern("[test]").test("[test]"), true);
test("^ is literal",                          compilePattern("^start").test("^start"), true);

section("compilePattern — \" *\" optional space");

// Trailing " *" should be treated as an optional space + .*, so the rule matches the bare command too.
test("Bash(git status *) matches bare 'git status'",
	compilePattern("git status *").test("git status"), true);
test("Bash(git status *) matches 'git status -s'",
	compilePattern("git status *").test("git status -s"), true);
test("Bash(git status *) matches multi-arg 'git status --porcelain --branch'",
	compilePattern("git status *").test("git status --porcelain --branch"), true);
test("Bash(git status *) does NOT match 'git statusx' (no space, no end)",
	compilePattern("git status *").test("git statusx"), false);
test("Bash(git status *) does NOT match 'gitstatus'",
	compilePattern("git status *").test("gitstatus"), false);
test("Bash(git status *) does NOT match 'git push'",
	compilePattern("git status *").test("git push"), false);
test("Bash(rm -rf *) matches bare 'rm -rf'",
	compilePattern("rm -rf *").test("rm -rf"), true);
test("Bash(rm -rf *) matches 'rm -rf .'",
	compilePattern("rm -rf *").test("rm -rf ."), true);

// Multiple " *" segments
test("Bash(git push * *) matches 'git push'",
	compilePattern("git push * *").test("git push"), true);
test("Bash(git push * *) matches 'git push origin'",
	compilePattern("git push * *").test("git push origin"), true);
test("Bash(git push * *) matches 'git push origin main'",
	compilePattern("git push * *").test("git push origin main"), true);

// Regression: bare * (no leading space) is unchanged
test("npm* still matches 'npm'",                compilePattern("npm*").test("npm"), true);
test("npm* still matches 'npm test'",           compilePattern("npm*").test("npm test"), true);
test("npm* does NOT match 'np' (anchored start unchanged)",
	compilePattern("npm*").test("np"), false);
test("npm test* still matches 'npm test'",      compilePattern("npm test*").test("npm test"), true);
test("npm test* still matches 'npm test --watch'", compilePattern("npm test*").test("npm test --watch"), true);

// Regex form must bypass the transform (still requires literal space)
test("regex form does NOT get \" *\" → \"( .*)?\" transform",
	compilePattern("/^git status .*$/").test("git status"), false);

// End-to-end: rule actually allows the bare command via decide()
const statusCfg = makeCfg({ allow: ["Bash(git status *)"], defaultAction: "deny" });
test("decide: 'git status' is allowed by 'Bash(git status *)'",
	decide(statusCfg, "bash", { command: "git status" }), "allow");
test("decide: 'git status -s' is allowed by 'Bash(git status *)'",
	decide(statusCfg, "bash", { command: "git status -s" }), "allow");
test("decide: 'git push' falls through to defaultAction",
	decide(statusCfg, "bash", { command: "git push" }), "deny");

section("compilePattern — regex form");

test("/regex/ used as-is",                    compilePattern("/^git (push|tag)/").test("git push origin"), true);
test("/regex/ is case-insensitive",           compilePattern("/foo/").test("FOO"), true);
test("/regex/ does not match non-match",      compilePattern("/^git push/").test("git pull"), false);
test("/regex/ with groups",                   compilePattern("/^(npm|yarn) (test|build)/").test("yarn build"), true);
test("bare /.../ treated as regex not glob",  compilePattern("/.*\\.env.*/").test(".env.local"), true);

// ── parseRule ─────────────────────────────────────────────────────────────

section("parseRule");

test("bare tool name: tool",           parseRule("Bash")?.tool, "bash");
test("bare tool name: no pattern",     parseRule("Bash")?.pattern, undefined);
test("bare tool name: no regex",       parseRule("Bash")?.regex, undefined);
test("bare tool name: raw preserved",  parseRule("Bash")?.raw, "Bash");
test("with pattern: tool",             parseRule("Read(./src)")?.tool, "read");
test("with pattern: pattern",          parseRule("Read(./src)")?.pattern, "./src");
test("with pattern: regex compiled",   parseRule("Read(./src)")?.regex instanceof RegExp, true);
test("with pattern: raw preserved",    parseRule("Read(./src)")?.raw, "Read(./src)");
test("regex form parsed ok",           parseRule("Bash(/^git /)")?.pattern, "/^git /");
test("underscore tool normalised",     parseRule("web_fetch")?.tool, "webfetch");
test("web_fetch with pattern",         parseRule("web_fetch(https://github.com/*)")?.pattern, "https://github.com/*");
test("whitespace trimmed",             parseRule("  Bash  ")?.tool, "bash");
test("empty string → null",           parseRule(""), null);
test("whitespace only → null",        parseRule("   "), null);
test("null/undefined → null",         parseRule(null), null);
test("malformed unclosed paren → null", parseRule("Bash("), null);
test("starts with paren → null",      parseRule("(foo)"), null);

// ── decide — precedence chain ─────────────────────────────────────────────

section("decide — full precedence");

const cfg = makeCfg({
	deny:         ["Bash(rm*)"],
	ask:          ["Bash(git push*)"],
	allow:        ["Bash(npm*)"],
	toolDefaults: { bash: "allow" },
	defaultAction: "deny",
});

test("deny beats everything",                   decide(cfg, "bash", { command: "rm -rf ." }), "deny");
test("ask beats allow + toolDefaults",          decide(cfg, "bash", { command: "git push origin" }), "ask");
test("allow beats toolDefaults + defaultAction", decide(cfg, "bash", { command: "npm test" }), "allow");
test("toolDefaults beats defaultAction",        decide(cfg, "bash", { command: "echo hello" }), "allow");
test("defaultAction when nothing matches",
	decide(makeCfg({ defaultAction: "deny" }), "bash", { command: "echo hi" }), "deny");

section("decide — toolDefaults map");

const tdCfg = makeCfg({ toolDefaults: { write: "ask", read: "allow" }, defaultAction: "deny" });
test("toolDefaults.write → ask",                decide(tdCfg, "write", { path: "./f.ts" }), "ask");
test("toolDefaults.read → allow",              decide(tdCfg, "read",  { path: "./f.ts" }), "allow");
test("unmatched tool falls to defaultAction",  decide(tdCfg, "bash",  { command: "echo" }), "deny");

test("web_search normalized in toolDefaults",
	decide(makeCfg({ toolDefaults: { web_search: "allow" }, defaultAction: "deny" }),
		"web_search", {}), "allow");
test("WebSearch normalized same as web_search in toolDefaults",
	decide(makeCfg({ toolDefaults: { WebSearch: "allow" }, defaultAction: "deny" }),
		"web_search", {}), "allow");

test("explicit allow beats toolDefaults",
	decide(
		makeCfg({ allow: ["Write(./output/*)"], toolDefaults: { write: "ask" }, defaultAction: "allow" }),
		"write", { path: "./output/file.ts" }
	), "allow");

section("decide — deny always wins");

const hardDeny = makeCfg({ deny: ["Read"], allow: ["Read"], ask: ["Read"], defaultAction: "allow" });
test("deny overrides allow and ask for same tool", decide(hardDeny, "read", { path: "./f.ts" }), "deny");

section("decideCompound — non-bash short-circuit");

const readCfg = makeCfg({ allow: ["Read"], defaultAction: "deny" });
const dcRead = decideCompound(readCfg, "read", { path: "./file.ts" });
test("non-bash: isCompound false",       dcRead.isCompound, false);
test("non-bash: ambiguous false",        dcRead.ambiguous, false);
test("non-bash: delegates to decide",    dcRead.action, "allow");
test("non-bash: empty breakdown",        dcRead.breakdown.length, 0);

const dcWrite = decideCompound(makeCfg({ toolDefaults: { write: "ask" } }), "write", { path: "./f.ts" });
test("non-bash write: uses toolDefaults", dcWrite.action, "ask");

section("ruleMatches — cwd-resolved candidate");

const RM_CWD = "C:/Users/Lucas/project";
const rmRule = parseRule(`Read(${cwdGlobPattern(RM_CWD)})`);

test("ruleMatches: absolute path inside cwd matches with cwd",
	ruleMatches(rmRule, "read", { path: RM_CWD + "/foo.ts" }, RM_CWD), true);
test("ruleMatches: dot-slash relative inside cwd matches with cwd",
	ruleMatches(rmRule, "read", { path: "./foo.ts" }, RM_CWD), true);
test("ruleMatches: bare relative inside cwd matches with cwd",
	ruleMatches(rmRule, "read", { path: "foo.ts" }, RM_CWD), true);
test("ruleMatches: relative outside cwd does NOT match",
	ruleMatches(rmRule, "read", { path: "../other/foo.ts" }, RM_CWD), false);
test("ruleMatches: absolute outside cwd does NOT match",
	ruleMatches(rmRule, "read", { path: "/etc/passwd" }, RM_CWD), false);
test("ruleMatches: no cwd — relative path does not match absolute rule",
	ruleMatches(rmRule, "read", { path: "./foo.ts" }), false);

section("decide — implicit Ls(<cwd>/**)");

const LS_CWD = "C:/Users/Lucas/project";
const lsImplicit = `Ls(${cwdGlobPattern(LS_CWD)})`;
const lsCfg = makeCfg({ allow: [lsImplicit], defaultAction: "ask", cwd: LS_CWD });

test("Ls with absolute path inside cwd → allow",
	decide(lsCfg, "ls", { path: LS_CWD + "/src" }), "allow");
test("Ls with relative path inside cwd → allow (cwd-resolved)",
	decide(lsCfg, "ls", { path: "./src" }, ), "allow");
test("Ls with absolute path outside cwd → ask (defaultAction)",
	decide(lsCfg, "ls", { path: "/etc" }), "ask");

// Bare Ls (no path) should default to cwd via inputForMatching, then match implicit rule.
const bareLsMatchInput = inputForMatching("ls", {}, LS_CWD);
test("inputForMatching: bare Ls defaults path to cwd (with trailing slash)",
	bareLsMatchInput.path, LS_CWD + "/");
test("Ls with no path → allow (defaults to cwd)",
	decide(lsCfg, "ls", bareLsMatchInput), "allow");

// Explicit deny still wins over the implicit allow.
const lsDenyCfg = makeCfg({ allow: [lsImplicit], deny: ["Ls(*node_modules*)"], defaultAction: "ask", cwd: LS_CWD });
test("Ls deny rule wins over implicit cwd allow",
	decide(lsDenyCfg, "ls", { path: LS_CWD + "/node_modules/foo" }), "deny");

// Ls is treated as a path-tool by suggestRule / getMatchField — sanity check via ruleMatches.
const lsRule = parseRule(lsImplicit);
test("ruleMatches: Ls absolute path inside cwd matches",
	ruleMatches(lsRule, "ls", { path: LS_CWD + "/foo" }, LS_CWD), true);
test("ruleMatches: Ls relative path inside cwd matches (cwd-resolved)",
	ruleMatches(lsRule, "ls", { path: "./foo" }, LS_CWD), true);
test("ruleMatches: Ls absolute path outside cwd does NOT match",
	ruleMatches(lsRule, "ls", { path: "/etc/passwd" }, LS_CWD), false);

// ── MCP — per-tool rules & human-readable preview ─────────────────────────
//
// MCP calls arrive as toolName "mcp" with the real tool name in input.tool
// (conventionally "<server>_<tool>") and args as a JSON string. Matching is
// done against input.tool so Mcp(<pattern>) rules can target individual tools;
// the prompt preview renders the parsed args one-per-line instead of raw JSON.
section("MCP — getMatchField / suggestRule / ruleMatches");

const MCP_INPUT = {
	tool: "slack_slack_search_public_and_private",
	args: JSON.stringify({ query: "from:foo after:2026-08-11", sort: "timestamp", limit: 20 }),
};

test("getMatchField: mcp returns the MCP tool name",
	getMatchField("mcp", MCP_INPUT), "slack_slack_search_public_and_private");
test("getMatchField: mcp normalises case/underscores",
	getMatchField("Mcp", MCP_INPUT), "slack_slack_search_public_and_private");
test("getMatchField: mcp with no tool → empty string",
	getMatchField("mcp", { args: "{}" }), "");

test("suggestRule: mcp suggests Mcp(<tool>)",
	suggestRule("mcp", MCP_INPUT), "Mcp(slack_slack_search_public_and_private)");
test("suggestRule: mcp with no tool → bare MCP",
	suggestRule("mcp", {}), "Mcp");

test("parseRule: Mcp(slack_*) parses",
	parseRule("Mcp(slack_*)")?.tool, "mcp");
test("parseRule: Mcp(slack_*) pattern",
	parseRule("Mcp(slack_*)")?.pattern, "slack_*");

test("ruleMatches: Mcp(slack_*) matches slack tool",
	ruleMatches(parseRule("Mcp(slack_*)"), "mcp", MCP_INPUT), true);
test("ruleMatches: Mcp(slack_slack_search_*) matches",
	ruleMatches(parseRule("Mcp(slack_slack_search_*)"), "mcp", MCP_INPUT), true);
test("ruleMatches: exact MCP tool name matches",
	ruleMatches(parseRule("Mcp(slack_slack_search_public_and_private)"), "mcp", MCP_INPUT), true);
test("ruleMatches: Mcp(github_*) does NOT match slack tool",
	ruleMatches(parseRule("Mcp(github_*)"), "mcp", MCP_INPUT), false);
test("ruleMatches: MCP regex /atlassian_.*/ does NOT match slack",
	ruleMatches(parseRule("Mcp(/atlassian_.*/)"), "mcp", MCP_INPUT), false);

section("MCP — decide precedence");

test("decide: MCP allow rule → allow",
	decide(makeCfg({ allow: ["Mcp(slack_*)"], defaultAction: "ask" }), "mcp", MCP_INPUT), "allow");
test("decide: MCP deny beats allow",
	decide(makeCfg({ allow: ["Mcp(slack_*)"], deny: ["Mcp(slack_slack_post_*)"], defaultAction: "ask" }), "mcp", MCP_INPUT), "allow");
test("decide: MCP ask beats allow",
	decide(makeCfg({ allow: ["Mcp(slack_*)"], ask: ["Mcp(slack_slack_search_*)"], defaultAction: "allow" }), "mcp", MCP_INPUT), "ask");
test("decide: toolDefaults.mcp → ask when no rule matches",
	decide(makeCfg({ toolDefaults: { mcp: "ask" }, defaultAction: "allow" }), "mcp", MCP_INPUT), "ask");
test("decide: explicit MCP allow beats toolDefaults.mcp ask",
	decide(makeCfg({ allow: ["Mcp(slack_*)"], toolDefaults: { mcp: "ask" }, defaultAction: "deny" }), "mcp", MCP_INPUT), "allow");
test("decide: MCP deny beats toolDefaults.mcp allow",
	decide(makeCfg({ deny: ["Mcp(slack_*)"], toolDefaults: { mcp: "allow" }, defaultAction: "ask" }), "mcp", MCP_INPUT), "deny");

section("MCP — mcpPreview");

test("mcpPreview: renders each arg on its own line",
	mcpPreview(MCP_INPUT),
	"query: from:foo after:2026-08-11\n  sort: timestamp\n  limit: 20");
test("mcpPreview: non-string values are JSON-encoded",
	mcpPreview({ tool: "x", args: JSON.stringify({ n: 3, b: true, obj: { a: 1 } }) }),
	"n: 3\n  b: true\n  obj: {\"a\":1}");
test("mcpPreview: object args (not stringified) render too",
	mcpPreview({ tool: "x", args: { q: "hi" } }), "q: hi");
test("mcpPreview: no args → placeholder",
	mcpPreview({ tool: "x" }), "(no arguments)");
test("mcpPreview: invalid JSON args fall back to raw string",
	mcpPreview({ tool: "x", args: "not-json" }), "not-json");
test("mcpPreview: truncates long output",
	mcpPreview({ tool: "x", args: JSON.stringify({ long: "a".repeat(1000) }) }, 50).length <= 50, true);

test("describeAction: mcp shows tool + args",
	describeAction("mcp", MCP_INPUT),
	"Tool: mcp\nMCP tool: slack_slack_search_public_and_private\nArgs: query=from:foo after:2026-08-11, sort=timestamp, limit=20");

// ── recomputeBreakdown ────────────────────────────────────────────────────
//
// Used by the compound-Bash prompt loop after a rule save: re-decide every
// subcommand against the freshly-loaded cfg while preserving the original
// `sub` strings (no re-splitting). The actual prompt loop is not unit-tested
// because it depends on ctx.ui; these tests cover the pure helper instead.
section("recomputeBreakdown");

const baseBreakdown = [
	{ sub: "rg foo",  action: "ask" },
	{ sub: "rg bar",  action: "ask" },
	{ sub: "npm test", action: "ask" },
];

// No rule changes → action unchanged (per-row identity).
const rbNoop = recomputeBreakdown(baseBreakdown, makeCfg({ defaultAction: "ask" }));
test("no-op: length preserved",         rbNoop.length, 3);
test("no-op: rg foo still ask",         rbNoop[0].action, "ask");
test("no-op: rg bar still ask",         rbNoop[1].action, "ask");
test("no-op: npm test still ask",       rbNoop[2].action, "ask");
test("no-op: sub strings preserved",    rbNoop.map((b) => b.sub).join("|"), "rg foo|rg bar|npm test");

// Saving an allow rule that matches both `rg *` subs flips them to allow,
// while the unrelated `npm test` step stays ask.
const rbAllow = recomputeBreakdown(baseBreakdown, makeCfg({ allow: ["Bash(rg *)"], defaultAction: "ask" }));
test("allow Bash(rg *): rg foo → allow",   rbAllow[0].action, "allow");
test("allow Bash(rg *): rg bar → allow",   rbAllow[1].action, "allow");
test("allow Bash(rg *): npm test → ask",   rbAllow[2].action, "ask");

// Saving a deny rule that matches one sub flips just that row to deny.
const rbDeny = recomputeBreakdown(baseBreakdown, makeCfg({ deny: ["Bash(npm *)"], defaultAction: "ask" }));
test("deny Bash(npm *): rg foo → ask",     rbDeny[0].action, "ask");
test("deny Bash(npm *): rg bar → ask",     rbDeny[1].action, "ask");
test("deny Bash(npm *): npm test → deny",  rbDeny[2].action, "deny");

// Mixed allow+deny: deny wins over allow per `decide()` precedence.
const rbMixed = recomputeBreakdown(baseBreakdown, makeCfg({
	allow: ["Bash(*)"], deny: ["Bash(npm *)"], defaultAction: "ask",
}));
test("mixed: rg foo → allow",              rbMixed[0].action, "allow");
test("mixed: rg bar → allow",              rbMixed[1].action, "allow");
test("mixed: npm test → deny (deny wins)", rbMixed[2].action, "deny");

// `sub` strings are passed through verbatim, including whitespace and quotes
// the splitter produced. No re-splitting / no re-normalization here.
const quirkyBreakdown = [
	{ sub: 'echo "hi there"', action: "ask" },
	{ sub: "cd ./sub",         action: "allow" },
];
const rbQuirky = recomputeBreakdown(quirkyBreakdown, makeCfg({ defaultAction: "ask", allowNoopCd: false }));
test("verbatim sub: quoted echo preserved",  rbQuirky[0].sub, 'echo "hi there"');
test("verbatim sub: cd preserved",            rbQuirky[1].sub, "cd ./sub");
// (Action recomputed; cd ./sub is no longer a no-op because allowNoopCd is off.)
test("recompute uses live cfg: cd ./sub → ask under allowNoopCd:false", rbQuirky[1].action, "ask");

// Empty input → empty output (defensive).
test("empty breakdown → empty result", recomputeBreakdown([], makeCfg()).length, 0);

// ── Auto mode (session-toggle layer) ──────────────────────────────────
//
// Auto mode is a LAYER between `toolDefaults` and `defaultAction`, controlled
// by the session toggle (autoActive). `defaultAction` is never "auto" (legacy
// configs that set it are coerced to "ask"). When autoActive is on, decide()
// returns an "auto" sentinel for fallthroughs; the handler then runs the
// classifier (or stubs to "ask" if no model). When autoActive is off, decide()
// returns the terminal defaultAction directly. See docs/auto-mode-design.md.
section("auto mode — layer + sentinel");

// defaultAction: "auto" is coerced to "ask" (no longer a valid default).
const autoCoercedCfg = makeCfg({ defaultAction: "auto" });
test("makeCfg: defaultAction \"auto\" coerced to \"ask\"", autoCoercedCfg.defaultAction, "ask");
test("decide: coerced auto default → ask fallthrough (autoActive off)",
	decide(autoCoercedCfg, "bash", { command: "some-unknown-cmd" }), "ask");

// With autoActive ON, a fallthrough returns the "auto" sentinel.
const askCfg = makeCfg({ defaultAction: "ask" });
test("decide: autoActive fallthrough → \"auto\" sentinel",
	decide(askCfg, "bash", { command: "some-unknown-cmd" }, true), "auto");
test("decide: deny still beats auto layer (autoActive=true)",
	decide(makeCfg({ deny: ["Bash(rm*)"], defaultAction: "ask" }), "bash", { command: "rm -rf ." }, true), "deny");
test("decide: ask still beats auto layer (autoActive=true)",
	decide(makeCfg({ ask: ["Bash(git push*)"], defaultAction: "ask" }), "bash", { command: "git push" }, true), "ask");
test("decide: allow still beats auto layer (autoActive=true)",
	decide(makeCfg({ allow: ["Bash(npm*)"], defaultAction: "ask" }), "bash", { command: "npm test" }, true), "allow");
test("decide: toolDefaults beats auto layer (autoActive=true)",
	decide(makeCfg({ toolDefaults: { bash: "ask" }, defaultAction: "allow" }), "bash", { command: "x" }, true), "ask");

// decideCompound surfaces the sentinel when autoActive; terminal defaultAction when not.
const dcAutoOn = decideCompound(askCfg, "bash", { command: "some-unknown-cmd" }, true);
test("decideCompound: single bash autoActive fallthrough → auto sentinel", dcAutoOn.action, "auto");
test("decideCompound: single bash not compound",        dcAutoOn.isCompound, false);
const dcAutoOff = decideCompound(askCfg, "bash", { command: "some-unknown-cmd" }, false);
test("decideCompound: single bash (autoActive off) → ask defaultAction", dcAutoOff.action, "ask");

const dcAutoRead = decideCompound(askCfg, "read", { path: "./outside.txt" }, true);
test("decideCompound: non-bash autoActive fallthrough → auto sentinel", dcAutoRead.action, "auto");

// Compound with an auto-subcommand: aggregate surfaces "auto" when autoActive.
// NOTE: the tool_call handler now classifies the *whole* compound as one command
// when no sub is a static `ask` (see shouldClassifyWholeCompound). decideCompound
// itself is unchanged — it still splits and surfaces `auto`/`isCompound`/`breakdown`.
const dcAutoCompound = decideCompound(askCfg, "bash", { command: "npm test && unknown-cmd" }, true);
test("decideCompound: compound (autoActive) → auto aggregate",
	dcAutoCompound.action, "auto");
test("decideCompound: compound flagged isCompound",
	dcAutoCompound.isCompound, true);
// Without autoActive the unknown sub falls to defaultAction (ask), so aggregate is ask.
const dcAskCompound = decideCompound(askCfg, "bash", { command: "npm test && unknown-cmd" }, false);
test("decideCompound: compound (autoActive off) → ask aggregate",
	dcAskCompound.action, "ask");

// recomputeBreakdown preserves the sentinel when autoActive.
const rbAuto = recomputeBreakdown([{ sub: "unknown-cmd", action: "auto" }], askCfg, true);
test("recomputeBreakdown: autoActive keeps auto sentinel", rbAuto[0].action, "auto");
const rbAsk = recomputeBreakdown([{ sub: "unknown-cmd", action: "auto" }], askCfg, false);
test("recomputeBreakdown: autoActive off → defaultAction (ask)", rbAsk[0].action, "ask");

// loadConfigFromObjects coerces legacy defaultAction: "auto" → "ask".
test("loadConfig: defaultAction \"auto\" coerced to \"ask\"",
	loadConfigFromObjects({ defaultAction: "auto" }, {}, "C:/proj").defaultAction, "ask");
test("loadConfig: defaultAction \"allow\" preserved",
	loadConfigFromObjects({ defaultAction: "allow" }, {}, "C:/proj").defaultAction, "allow");

// loadConfigFromObjects merges autoMode (user + project), project classifier wins, lists concat.
const mergedAuto = loadConfigFromObjects(
	{ autoMode: { classifier: { provider: "anthropic", model: "claude-haiku-4-5" }, allow: ["Running tests"], environment: ["Trusted repo: a"] } },
	{ autoMode: { classifier: { provider: "openai", model: "gpt-4o-mini" }, allow: ["Running linters"], soft_deny: ["Force push"], classifyAllShell: true } },
	"C:/proj",
);
test("loadConfig: project classifier wins",
	mergedAuto.autoMode.classifier.model, "gpt-4o-mini");
test("loadConfig: allow lists concatenated + deduped (defaults prepended)",
	mergedAuto.autoMode.allow.join("|"), DEFAULT_ALLOW.join("|") + "|Running tests|Running linters");
test("loadConfig: soft_deny from project (default prepended)",
	mergedAuto.autoMode.soft_deny.join("|"), DEFAULT_SOFT_DENY.join("|") + "|Force push");
test("loadConfig: environment from user",
	mergedAuto.autoMode.environment.join("|"), "Trusted repo: a");
test("loadConfig: classifyAllShell project wins (true)",
	mergedAuto.autoMode.classifyAllShell, true);

// No autoMode configured → sane defaults for lists + classifyAllShell;
// classifier (auto-select) and environment (empty) have no defaults.
const emptyAuto = loadConfigFromObjects({}, {}, "C:/proj");
test("loadConfig: no autoMode → empty classifier",       emptyAuto.autoMode.classifier, undefined);
test("loadConfig: no autoMode → empty environment",      emptyAuto.autoMode.environment.length, 0);
test("loadConfig: no autoMode → default allow list",       emptyAuto.autoMode.allow.join("|"), DEFAULT_ALLOW.join("|"));
test("loadConfig: no autoMode → default soft_deny list",  emptyAuto.autoMode.soft_deny.join("|"), DEFAULT_SOFT_DENY.join("|"));
test("loadConfig: no autoMode → default hard_deny list",  emptyAuto.autoMode.hard_deny.join("|"), DEFAULT_AUTO_MODE.hard_deny.join("|"));
test("loadConfig: no autoMode → classifyAllShell true (default)",  emptyAuto.autoMode.classifyAllShell, true);

// Content assertions guarding the gh-pr-create / git push carve-out intent:
// the narrowed hard_deny steers the classifier away from normal GitHub dev
// actions, and the new soft_deny entry routes them to a prompt instead of a block.
test("DEFAULT_AUTO_MODE.soft_deny includes gh pr create / push carve-out",
	DEFAULT_AUTO_MODE.soft_deny.includes("Creating a pull request or pushing a branch on GitHub via gh, modifying remote state"), true);
test("DEFAULT_AUTO_MODE.hard_deny narrowed to telemetry/analytics/exfiltration intent",
	DEFAULT_AUTO_MODE.hard_deny[0].includes("telemetry, analytics, or exfiltration"), true);

// Content assertions guarding the package-registry lookup allow entries:
// read-only GET requests to public package registries (and the shell loop/
// pipeline shape wrapping them) should be silently allowed, not routed to
// the telemetry/analytics/exfiltration hard_deny.
test("DEFAULT_AUTO_MODE.allow includes public package registry lookups",
	DEFAULT_AUTO_MODE.allow.some((r) => r.includes("public package registry")), true);
test("DEFAULT_AUTO_MODE.allow includes curl/wget loop-or-pipeline shape",
	DEFAULT_AUTO_MODE.allow.some((r) => r.includes("curl or wget") && r.includes("loop or pipeline")), true);

// User/project lists are ADDITIVE on top of the defaults (concatenated + deduped).
const additiveAuto = loadConfigFromObjects(
	{ autoMode: { allow: ["Running builds"] } },
	{ autoMode: { soft_deny: ["Rebasing"] } },
	"C:/proj",
);
test("loadConfig: user allow added on top of default",
	additiveAuto.autoMode.allow.join("|"), DEFAULT_ALLOW.join("|") + "|Running builds");
test("loadConfig: project soft_deny added on top of default",
	additiveAuto.autoMode.soft_deny.join("|"), DEFAULT_SOFT_DENY.join("|") + "|Rebasing");

// A user can override classifyAllShell to false; defaults don't force it on.
const noShellAuto = loadConfigFromObjects({ autoMode: { classifyAllShell: false } }, {}, "C:/proj");
test("loadConfig: user can override classifyAllShell to false",
	noShellAuto.autoMode.classifyAllShell, false);

// ── Auto-mode classifier (Step 3) ──────────────────────────────────────
section("auto mode — classifier runtime");

// verdictToAction mapping: no_match → defaultAction (the terminal fallback).
// soft_deny → ask (interactive) / deny (non-interactive). allow/hard_deny fixed.
test("verdictToAction: allow → allow (interactive)",        verdictToAction("allow", false, "ask"),     "allow");
test("verdictToAction: allow → allow (non-interactive)",    verdictToAction("allow", true, "ask"),      "allow");
test("verdictToAction: hard_deny → deny (interactive)",     verdictToAction("hard_deny", false, "ask"),  "deny");
test("verdictToAction: hard_deny → deny (non-interactive)", verdictToAction("hard_deny", true, "ask"),   "deny");
test("verdictToAction: soft_deny → ask (interactive)",      verdictToAction("soft_deny", false, "ask"),  "ask");
test("verdictToAction: soft_deny → deny (non-interactive)", verdictToAction("soft_deny", true, "ask"),   "deny");
test("verdictToAction: no_match → defaultAction=ask",        verdictToAction("no_match", false, "ask"),   "ask");
test("verdictToAction: no_match → defaultAction=allow",    verdictToAction("no_match", true, "allow"),   "allow");
test("verdictToAction: no_match → defaultAction=deny",     verdictToAction("no_match", false, "deny"),    "deny");

// parseClassifierResponse
{
	const a = parseClassifierResponse("VERDICT: allow\nREASON: safe test command");
	test("parse: allow verdict",  a.verdict, "allow");
	test("parse: reason captured", a.reason,  "safe test command");
}
{
	const h = parseClassifierResponse("VERDICT: hard_deny\nREASON: destructive");
	test("parse: hard_deny verdict", h.verdict, "hard_deny");
}
{
	const s = parseClassifierResponse("VERDICT: soft_deny\nREASON: force push");
	test("parse: soft_deny verdict", s.verdict, "soft_deny");
}
{
	const n = parseClassifierResponse("VERDICT: no_match\nREASON: nothing matched");
	test("parse: no_match verdict", n.verdict, "no_match");
}
{
	const m = parseClassifierResponse("sorry, I could not decide");
	test("parse: unparseable → no_match", m.verdict, "no_match");
	test("parse: unparseable → empty reason", m.reason, "");
}
{
	const ci = parseClassifierResponse("verdict: ALLOW\nReason: UpPeRcAsE");
	test("parse: case-insensitive verdict", ci.verdict, "allow");
	test("parse: reason trimmed",       ci.reason,  "UpPeRcAsE");
}

// describeAction per tool
test("describeAction: bash shows command",
	describeAction("bash", { command: "ls -la" }), "Tool: bash\nCommand: ls -la");
test("describeAction: read shows path",
	describeAction("read", { path: "./f.ts" }), "Tool: read\nPath: ./f.ts");
test("describeAction: web_fetch shows url",
	describeAction("web_fetch", { url: "https://x.com" }), "Tool: web_fetch\nURL: https://x.com");
test("describeAction: unknown tool → JSON",
	describeAction("custom", { foo: 1 }).includes("Input:"), true);

// buildClassifierPrompt contains the NL lists + action description
{
	const am = { environment: ["Trusted repo: a"], allow: ["Running tests"], soft_deny: ["Force push"], hard_deny: ["Exfil data"], classifyAllShell: false };
	const p = buildClassifierPrompt("bash", { command: "npm test" }, am);
	test("prompt: contains tool action",   p.includes("Tool: bash\nCommand: npm test"), true);
	test("prompt: context section empty when no facts", p.includes("Context") && p.includes("(none)"), true);
	const pc = buildClassifierPrompt("edit", { path: "projects.md" }, am, ["Working directory: /repo", "Target path is inside a git repository (root: /repo), so file changes there are source-controlled and reversible"]);
	test("prompt: renders context facts", pc.includes("  - Working directory: /repo"), true);
	test("prompt: renders git-repo fact",  pc.includes("Target path is inside a git repository (root: /repo)"), true);
	test("prompt: contains environment",    p.includes("Trusted repo: a"), true);
	test("prompt: contains allow list",     p.includes("Running tests"), true);
	test("prompt: contains soft_deny list", p.includes("Force push"), true);
	test("prompt: contains hard_deny list", p.includes("Exfil data"), true);
	test("prompt: contains verdict schema",  p.includes("VERDICT:"), true);
	test("prompt: precedence sentence directs hard_deny first", p.includes("If the action matches a Hard deny rule, verdict is hard_deny"), true);
	test("prompt: verdict options ordered hard_deny first", p.includes("VERDICT: <hard_deny|soft_deny|allow|no_match>"), true);
}

// ── Classifier context: git-root detection + action facts ─────────────────
section("classifier context");

// Fake filesystem: only these paths "exist".
const REPO_FS = new Set(["/src/repo/.git", "D:/src/repo/.git"]);
const fakeExists = (p) => REPO_FS.has(p);

test("findGitRoot: dir is the repo root",        findGitRoot("/src/repo", fakeExists), "/src/repo");
test("findGitRoot: walks up from nested dir",    findGitRoot("/src/repo/a/b/c", fakeExists), "/src/repo");
test("findGitRoot: trailing slash tolerated",    findGitRoot("/src/repo/a/", fakeExists), "/src/repo");
test("findGitRoot: backslashes normalized",      findGitRoot("D:\\src\\repo\\pkg", fakeExists), "D:/src/repo");
test("findGitRoot: outside any repo → null",     findGitRoot("/tmp/scratch", fakeExists), null);
test("findGitRoot: stops at windows drive root", findGitRoot("C:/other", fakeExists), null);
test("findGitRoot: empty input → null",          findGitRoot("", fakeExists), null);

test("resolveAgainstCwd: relative joins cwd",     resolveAgainstCwd("projects.md", "/src/repo"), "/src/repo/projects.md");
test("resolveAgainstCwd: ./ prefix stripped",     resolveAgainstCwd("./a/b.md", "/src/repo"), "/src/repo/a/b.md");
test("resolveAgainstCwd: posix absolute kept",    resolveAgainstCwd("/etc/hosts", "D:/src/repo"), "/etc/hosts");
test("resolveAgainstCwd: windows absolute kept",  resolveAgainstCwd("D:\\x\\y", "/src/repo"), "D:/x/y");

test("leadingCdTarget: cd && command",       leadingCdTarget("cd /src/repo && git commit -m x"), "/src/repo");
test("leadingCdTarget: quoted path",         leadingCdTarget("cd '/src/my repo' && git status"), "/src/my repo");
test("leadingCdTarget: bare cd",             leadingCdTarget("cd /src/repo"), "/src/repo");
test("leadingCdTarget: semicolon separator", leadingCdTarget("cd /src/repo; ls"), "/src/repo");
test("leadingCdTarget: no cd → null",        leadingCdTarget("git commit -m x"), null);
test("leadingCdTarget: metachars → null",    leadingCdTarget("cd $(pwd) && ls"), null);
test("leadingCdTarget: cd with no arg → null", leadingCdTarget("cd && ls"), null);

// The regression from the issue: a bare relative path used to look
// "not source-controlled" to the classifier.
{
	const ctx = buildActionContext("edit", { path: "projects.md" }, "/src/repo/docs", fakeExists);
	test("context: reports cwd",              ctx.includes("Working directory: /src/repo/docs"), true);
	test("context: cwd in repo",              ctx.some((l) => l.startsWith("Working directory is inside a git repository (root: /src/repo)")), true);
	test("context: resolves relative path",   ctx.includes("Resolved target path: /src/repo/docs/projects.md"), true);
	test("context: target path in repo",      ctx.some((l) => l.startsWith("Target path is inside a git repository (root: /src/repo)")), true);
}
{
	const ctx = buildActionContext("write", { path: "/tmp/out.md" }, "/tmp", fakeExists);
	test("context: cwd outside repo",         ctx.includes("Working directory is NOT inside a git repository"), true);
	test("context: target outside repo",      ctx.includes("Target path is NOT inside a git repository"), true);
}
{
	const ctx = buildActionContext("bash", { command: "cd /src/repo && git add -A && git commit -m x" }, "/tmp", fakeExists);
	test("context: honours leading cd",       ctx.includes("Command runs in: /src/repo"), true);
	test("context: cd target in repo",        ctx.some((l) => l.startsWith("That directory is inside a git repository (root: /src/repo)")), true);
}
{
	const ctx = buildActionContext("bash", { command: "git status" }, "/src/repo", fakeExists);
	test("context: no cd → no command-runs-in line", ctx.some((l) => l.startsWith("Command runs in:")), false);
}
{
	const ctx = buildActionContext("pwsh", { command: "Get-ChildItem", cwd: "/src/repo" }, "/tmp", fakeExists);
	test("context: pwsh cwd arg honoured",    ctx.includes("Command runs in: /src/repo"), true);
}

// Default NL rules cover the local-commit / push split.
test("defaults: local git commit allowed",
	DEFAULT_ALLOW.some((r) => /local git commit/i.test(r)), true);
test("defaults: git push soft-denied",
	DEFAULT_SOFT_DENY.some((r) => /git push/i.test(r)), true);
test("defaults: history rewrite soft-denied",
	DEFAULT_SOFT_DENY.some((r) => /rebase/i.test(r)), true);

// classifyAction with a fake complete seam
{
	const am = { environment: [], allow: [], soft_deny: [], hard_deny: [], classifyAllShell: false };
	const fakeCompleteAllow = async (_m, _c) => ({
		content: [{ type: "text", text: "VERDICT: allow\nREASON: safe" }],
	});
	const res = await classifyAction(fakeCompleteAllow, { id: "m" }, "bash", { command: "npm test" }, am, new Map());
	test("classifyAction: returns allow verdict", res.verdict, "allow");
	test("classifyAction: returns reason",       res.reason,  "safe");
}

// classifyAction cache hit: complete is not called the second time
{
	let calls = 0;
	const am = { environment: [], allow: [], soft_deny: [], hard_deny: [], classifyAllShell: false };
	const counting = async () => { calls++; return { content: [{ type: "text", text: "VERDICT: no_match\nREASON: x" }] }; };
	const cache = new Map();
	await classifyAction(counting, { id: "m" }, "bash", { command: "rm -rf ." }, am, cache);
	await classifyAction(counting, { id: "m" }, "bash", { command: "rm -rf ." }, am, cache);
	test("classifyAction: cache hit — complete called once", calls, 1);
	// A different input should miss the cache and call again.
	await classifyAction(counting, { id: "m" }, "bash", { command: "rm -rf /" }, am, cache);
	test("classifyAction: different input — complete called twice", calls, 2);
	// Same tool+input but different context facts must not reuse the verdict.
	await classifyAction(counting, { id: "m" }, "bash", { command: "rm -rf /" }, am, cache, ["Working directory: /a"]);
	test("classifyAction: different context — complete called thrice", calls, 3);
	test("classifierCacheKey: context changes the key",
		classifierCacheKey("bash", { command: "x" }, am) === classifierCacheKey("bash", { command: "x" }, am, ["fact"]), false);
}

// classifyAction API error → safe no_match fallback
{
	const am = { environment: [], allow: [], soft_deny: [], hard_deny: [], classifyAllShell: false };
	const throwing = async () => { throw new Error("network"); };
	const res = await classifyAction(throwing, { id: "m" }, "bash", { command: "x" }, am, new Map());
	test("classifyAction: API error → no_match",  res.verdict, "no_match");
	test("classifyAction: API error reason set",   res.reason,  "classifier call failed");
}

// classifierCacheKey: deterministic + sensitive to input and ruleset
{
	const am = { environment: ["e"], allow: ["a"], soft_deny: ["s"], hard_deny: ["h"], classifyAllShell: false };
	const k1 = classifierCacheKey("bash", { command: "npm test" }, am);
	const k2 = classifierCacheKey("bash", { command: "npm test" }, am);
	test("cacheKey: same input+ruleset → same key", k1 === k2, true);
	const k3 = classifierCacheKey("bash", { command: "npm run" }, am);
	test("cacheKey: different input → different key", k1 === k3, false);
	const am2 = { ...am, allow: ["a", "b"] };
	const k4 = classifierCacheKey("bash", { command: "npm test" }, am2);
	test("cacheKey: different ruleset → different key", k1 === k4, false);
	const k5 = classifierCacheKey("read", { command: "npm test" }, am);
	test("cacheKey: different toolName → different key", k1 === k5, false);
}

// Model selection: rankClassifierModels prefers same provider, cheapest first
{
	const mk = (provider, id, input, output) => ({ provider, id, cost: { input, output, cacheRead: 0, cacheWrite: 0 } });
	const pool = [
		mk("openai", "gpt-4o",      5, 15),
		mk("anthropic", "haiku",    1, 5),
		mk("anthropic", "sonnet",   3, 15),
		mk("openai", "mini",        1, 2),
	];
	const ranked = rankClassifierModels(pool, "anthropic");
	test("rank: same-provider models come first",   ranked[0].provider === "anthropic", true);
	test("rank: cheapest same-provider first",       ranked[0].id, "haiku");
	test("rank: then other providers ascending cost",  ranked[2].id, "mini"); // openai mini (cost 3) before gpt-4o (cost 20)
	test("rank: most expensive same-provider last of its kind", ranked[1].id, "sonnet");
}

// pickClassifierModel: explicit pin wins; hasAuth gates; auto-select respects provider
{
	const mk = (provider, id, input, output) => ({ provider, id, cost: { input, output, cacheRead: 0, cacheWrite: 0 } });
	const pool = [mk("anthropic", "haiku", 1, 5), mk("openai", "mini", 1, 2)];
	const allAuth = () => true;
	const noneAuth = () => false;
	const find = (provider, id) => pool.find((m) => m.provider === provider && m.id === id);
	test("pick: explicit pin found + authed",
		pickClassifierModel(pool, "openai", allAuth, { provider: "anthropic", model: "haiku" }, find).id, "haiku");
	test("pick: auto-select prefers same provider",
		pickClassifierModel(pool, "anthropic", allAuth).id, "haiku");
	test("pick: auto-select falls back to cheapest other provider",
		pickClassifierModel(pool, "google", allAuth).id, "mini");
	test("pick: no authed model → undefined",
		pickClassifierModel(pool, "anthropic", noneAuth), undefined);
	test("pick: explicit pin not found → auto-select",
		pickClassifierModel(pool, "anthropic", allAuth, { provider: "x", model: "y" }, find).id, "haiku");
}

// ── deny/ask-beat-classifier invariant ────────────────────────────────────
//
// The classifier only sees true fallthroughs. With autoActive=true, a static
// deny/ask/allow rule still wins (decide returns deny/ask/allow, not "auto").
// classifyAllShell routes otherwise-auto-allowed read-only bash through the
// classifier (decide returns "auto" instead of "allow"). defaultAction is now
// "ask" (auto coerced); the auto layer is reached via the session toggle.
section("auto mode — static rules beat classifier");

const autoCfg2 = makeCfg({ defaultAction: "ask" });
test("invariant: deny beats auto (autoActive=true)",
	decide(makeCfg({ deny: ["Bash(rm*)"], defaultAction: "ask" }), "bash", { command: "rm -rf ." }, true), "deny");
test("invariant: ask beats auto (autoActive=true)",
	decide(makeCfg({ ask: ["Bash(git push*)"], defaultAction: "ask" }), "bash", { command: "git push" }, true), "ask");
test("invariant: allow beats auto (autoActive=true)",
	decide(makeCfg({ allow: ["Bash(npm*)"], defaultAction: "ask" }), "bash", { command: "npm test" }, true), "allow");

// Without classifyAllShell, read-only bash is still auto-allowed (does not reach classifier).
const roCfg = makeCfg({ defaultAction: "ask", bashReadOnlyAllowCwd: true });
test("no classifyAllShell: read-only bash auto-allowed (autoActive=true)",
	decide(roCfg, "bash", { command: "ls" }, true), "allow");

// With classifyAllShell, read-only bash falls through to "auto" (reaches classifier).
const classifyAllCfg = makeCfg({ defaultAction: "ask", bashReadOnlyAllowCwd: true, autoMode: { classifier: undefined, environment: [], allow: [], soft_deny: [], hard_deny: [], classifyAllShell: true } });
test("classifyAllShell: read-only bash → auto (reaches classifier)",
	decide(classifyAllCfg, "bash", { command: "ls" }, true), "auto");
test("classifyAllShell: no-op cd still auto-allowed (cd is harmless bookkeeping)",
	decide(classifyAllCfg, "bash", { command: "cd ." }, true), "allow");

// decideCompound surfaces "auto" when autoActive (sentinel preserved)
{
	const dc = decideCompound(autoCfg2, "bash", { command: "npm test && unknown-cmd" }, true);
	test("decideCompound (autoActive): compound aggregate surfaces auto",
		dc.action, "auto");
	test("decideCompound (autoActive): breakdown keeps auto sub",
		dc.breakdown.some((b) => b.action === "auto"), true);
}
// Without autoActive, fallthroughs resolve to defaultAction (ask) directly.
{
	const dc = decideCompound(autoCfg2, "bash", { command: "unknown-cmd" }, false);
	test("decideCompound (not autoActive): fallthrough → defaultAction (ask)", dc.action, "ask");
}

// ── Bash output redirection as a write-risk operation ──────────────────────

section("decide — bash redirect-aware allow filter");

const cwd = process.cwd().replace(/\\/g, "/");
const rCfg = makeCfg({ allow: ["Bash(rg *)"], defaultAction: "ask", bashReadOnlyAllowCwd: true, cwd });
test("rg x → allow (broad rule)",                  decide(rCfg, "bash", { command: "rg x" }), "allow");
test("rg x > out → ask (broad rule skips redirect)", decide(rCfg, "bash", { command: "rg x > out" }), "ask");
test("rg x 2>&1 → allow (descriptor dup, not a file write)", decide(rCfg, "bash", { command: "rg x 2>&1" }), "allow");

test("deny beats redirect-aware allow", decide(
	makeCfg({ deny: ["Bash(rm -rf*)"], allow: ["Bash(rm -rf * > *)"], defaultAction: "ask" }),
	"bash", { command: "rm -rf x > out" }), "deny");

test("ask beats redirect-aware allow (broad ask rule)", decide(
	makeCfg({ ask: ["Bash(rg *)"], allow: ["Bash(rg * > *)"], defaultAction: "allow" }),
	"bash", { command: "rg x > out" }), "ask");

test("toolDefaults not gated by redirect filter", decide(
	makeCfg({ toolDefaults: { bash: "allow" }, defaultAction: "ask" }),
	"bash", { command: "rg x > out" }), "allow");

test("pwsh redirect not filtered (out of scope)", decide(
	makeCfg({ allow: ["Pwsh(*)"], defaultAction: "ask" }),
	"pwsh", { command: "$x > out" }), "allow");

// ── shouldClassifyWholeCompound ─────────────────────────────────────────────
// Gates the tool_call handler's whole-compound classify branch (no fake-UI
// harness exists to test the handler directly). decideCompound is unchanged,
// so this predicate is the testable surface for the new behavior.

section("shouldClassifyWholeCompound");

test("all allow/auto subs → true (classify whole)",
	shouldClassifyWholeCompound([
		{ sub: "npm test", action: "allow" },
		{ sub: "unknown-cmd", action: "auto" },
	]), true);
test("one ask sub → false (per-sub loop)",
	shouldClassifyWholeCompound([
		{ sub: "npm test", action: "allow" },
		{ sub: "git push", action: "ask" },
	]), false);
test("one deny sub (defensive — shouldn't reach classifier) → true",
	shouldClassifyWholeCompound([
		{ sub: "npm test", action: "allow" },
		{ sub: "rm -rf .", action: "deny" },
	]), true);
test("empty breakdown (single/ambiguous) → true",
	shouldClassifyWholeCompound([]), true);

test("all ask subs → false",
	shouldClassifyWholeCompound([
		{ sub: "git push", action: "ask" },
		{ sub: "rm x", action: "ask" },
	]), false);

process.exit(summary() > 0 ? 1 : 0);
