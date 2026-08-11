// run: node test-rules-and-decide.mjs

import {
	makeTestRunner, compilePattern, parseRule, ruleMatches, decide, decideCompound, makeCfg,
	cwdGlobPattern, normalizePathSep, inputForMatching, recomputeBreakdown, effectiveAction,
	loadConfigFromObjects,
} from "./test-helpers.mjs";

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

// ── Auto mode (Step 1 spine) ───────────────────────────────────────────
//
// `defaultAction: "auto"` is a valid action. decide() returns the raw "auto"
// (it does not resolve it); decideCompound / recomputeBreakdown resolve "auto"
// → "ask" via effectiveAction so the existing prompt path runs unchanged until
// the classifier runtime is wired (Step 2). See docs/auto-mode-design.md.
section("auto mode — Step 1 spine");

test("effectiveAction: allow passes through",  effectiveAction("allow"), "allow");
test("effectiveAction: deny passes through",   effectiveAction("deny"),  "deny");
test("effectiveAction: ask passes through",     effectiveAction("ask"),    "ask");
test("effectiveAction: auto → ask (stub)",      effectiveAction("auto"),    "ask");

const autoCfg = makeCfg({ defaultAction: "auto" });
test("decide: returns raw 'auto' for fallthrough (no static match)",
	decide(autoCfg, "bash", { command: "some-unknown-cmd" }), "auto");
test("decide: deny still beats auto default",
	decide(makeCfg({ deny: ["Bash(rm*)"], defaultAction: "auto" }), "bash", { command: "rm -rf ." }), "deny");
test("decide: ask still beats auto default",
	decide(makeCfg({ ask: ["Bash(git push*)"], defaultAction: "auto" }), "bash", { command: "git push" }), "ask");
test("decide: allow still beats auto default",
	decide(makeCfg({ allow: ["Bash(npm*)"], defaultAction: "auto" }), "bash", { command: "npm test" }), "allow");

// decideCompound resolves auto → ask in its output so the handler/prompt path is unchanged.
const dcAutoSingle = decideCompound(autoCfg, "bash", { command: "some-unknown-cmd" });
test("decideCompound: single bash auto fallthrough → ask (stub)", dcAutoSingle.action, "ask");
test("decideCompound: single bash not compound",        dcAutoSingle.isCompound, false);

const dcAutoRead = decideCompound(autoCfg, "read", { path: "./outside.txt" });
test("decideCompound: non-bash auto fallthrough → ask (stub)", dcAutoRead.action, "ask");

// Compound with an auto subcommand: the aggregate treats auto like ask (prompt).
const dcAutoCompound = decideCompound(autoCfg, "bash", { command: "npm test && unknown-cmd" });
test("decideCompound: compound with one allow + one auto → ask aggregate",
	dcAutoCompound.action, "ask");
test("decideCompound: compound flagged isCompound",
	dcAutoCompound.isCompound, true);

// recomputeBreakdown also resolves auto → ask.
const rbAuto = recomputeBreakdown(
	[{ sub: "unknown-cmd", action: "auto" }],
	autoCfg,
);
test("recomputeBreakdown: auto → ask (stub)", rbAuto[0].action, "ask");

// loadConfigFromObjects merges autoMode (user + project), project classifier wins, lists concat.
const mergedAuto = loadConfigFromObjects(
	{ autoMode: { classifier: { provider: "anthropic", model: "claude-haiku-4-5" }, allow: ["Running tests"], environment: ["Trusted repo: a"] } },
	{ autoMode: { classifier: { provider: "openai", model: "gpt-4o-mini" }, allow: ["Running linters"], soft_deny: ["Force push"], classifyAllShell: true } },
	"C:/proj",
);
test("loadConfig: project classifier wins",
	mergedAuto.autoMode.classifier.model, "gpt-4o-mini");
test("loadConfig: allow lists concatenated + deduped",
	mergedAuto.autoMode.allow.join("|"), "Running tests|Running linters");
test("loadConfig: soft_deny from project",
	mergedAuto.autoMode.soft_deny.join("|"), "Force push");
test("loadConfig: environment from user",
	mergedAuto.autoMode.environment.join("|"), "Trusted repo: a");
test("loadConfig: classifyAllShell project wins (true)",
	mergedAuto.autoMode.classifyAllShell, true);

// No autoMode configured → empty defaults, not undefined.
const emptyAuto = loadConfigFromObjects({}, {}, "C:/proj");
test("loadConfig: no autoMode → empty classifier",       emptyAuto.autoMode.classifier, undefined);
test("loadConfig: no autoMode → empty allow list",        emptyAuto.autoMode.allow.length, 0);
test("loadConfig: no autoMode → classifyAllShell false",  emptyAuto.autoMode.classifyAllShell, false);

process.exit(summary() > 0 ? 1 : 0);
