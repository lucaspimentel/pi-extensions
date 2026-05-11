// run: node test-rules-and-decide.mjs

import {
	makeTestRunner, compilePattern, parseRule, ruleMatches, decide, decideCompound, makeCfg,
	cwdGlobPattern, normalizePathSep,
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

process.exit(summary() > 0 ? 1 : 0);
