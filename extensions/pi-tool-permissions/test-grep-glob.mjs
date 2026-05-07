// run: node test-grep-glob.mjs

import {
	makeTestRunner, normalizeTool, normalizePathSep, normalizeMatchPath,
	getMatchField, inputForMatching, suggestRule, compilePattern,
	decide, makeCfg, cwdGlobPattern,
} from "./test-helpers.mjs";

const { test, section, summary } = makeTestRunner();
const CWD = "C:/Users/Lucas.Pimentel/.pi";
const NORM_CWD = normalizePathSep(CWD);

section("getMatchField");

test("grep with path returns path",       getMatchField("grep", { pattern: "TODO", path: "./src" }), "./src");
test("grep without path returns empty",   getMatchField("grep", { pattern: "TODO" }), "");
test("glob with path returns path",       getMatchField("glob", { pattern: "**/*.ts", path: "./src" }), "./src");
test("glob without path returns empty",   getMatchField("glob", { pattern: "**/*.ts" }), "");
test("search pattern is NOT match field", getMatchField("grep", { pattern: "TODO", path: "./src" }) === "TODO", false);

section("inputForMatching");

const grepWithPath = inputForMatching("grep", { pattern: "TODO", path: "./src" }, CWD);
test("relative path resolves to absolute (with trailing /)", grepWithPath.path, NORM_CWD + "/src/");

const grepNoPath = inputForMatching("grep", { pattern: "TODO" }, CWD);
test("no path defaults to cwd (with trailing /)", grepNoPath.path, NORM_CWD + "/");

const globAbsPath = inputForMatching("glob", { pattern: "**/*.ts", path: CWD + "/agent" }, CWD);
test("absolute path normalises separators (with trailing /)", globAbsPath.path, NORM_CWD + "/agent/");

test("original input not mutated — pattern preserved", grepWithPath.pattern, "TODO");

section("suggestRule");

test("grep with path → Grep(path)",  suggestRule("grep", { pattern: "TODO", path: "./src" }), "grep(./src)");
test("grep no path → bare tool name", suggestRule("grep", { pattern: "TODO" }), "grep");
test("Glob with path → Glob(path)",  suggestRule("Glob", { pattern: "**/*.ts", path: "./src" }), "Glob(./src)");

section("end-to-end rule matching");

const noPath  = inputForMatching("grep", { pattern: "TODO" }, CWD);
const relPath = inputForMatching("grep", { pattern: "TODO", path: "./src" }, CWD);
const etcPath = inputForMatching("grep", { pattern: "secret", path: "/etc" }, CWD);
const outside = inputForMatching("grep", { pattern: "TODO", path: "/tmp/other" }, CWD);
const globRel = inputForMatching("glob", { pattern: "**/*.ts", path: "./agent" }, CWD);

test("Grep(<cwd>/**) matches grep with no explicit path",   compilePattern(NORM_CWD + "/**").test(noPath.path), true);
test("Grep(<cwd>/**) matches grep with relative path",      compilePattern(NORM_CWD + "/**").test(relPath.path), true);
test("Grep(/etc/*)   matches grep with path: /etc",         compilePattern("/etc/*").test(etcPath.path), true);
test("Grep(<cwd>/**) does NOT match path outside cwd",      compilePattern(NORM_CWD + "/**").test(outside.path), false);
test("Glob(<cwd>/**) matches glob with relative path",      compilePattern(NORM_CWD + "/**").test(globRel.path), true);
test("Old Grep(TODO*) does NOT match — pattern not field",  compilePattern("TODO*").test(relPath.path), false);
test("Bare Glob(**) always matches any path",               compilePattern("**").test(globRel.path), true);

const cfg = makeCfg({ allow: [`Grep(${NORM_CWD}/**)`], deny: ["Grep(/etc/*)"], defaultAction: "ask" });
test("decide: cwd grep → allow",      decide(cfg, "grep", noPath), "allow");
test("decide: /etc grep → deny",      decide(cfg, "grep", etcPath), "deny");
test("decide: outside grep → ask",    decide(cfg, "grep", outside), "ask");

process.exit(summary() > 0 ? 1 : 0);
