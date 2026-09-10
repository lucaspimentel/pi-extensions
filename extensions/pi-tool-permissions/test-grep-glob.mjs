// run: node test-grep-glob.mjs

import {
	makeTestRunner, normalizeTool, normalizePathSep, normalizeMatchPath,
	getMatchField, inputForMatching, suggestRule, compilePattern,
	decide, makeCfg, cwdGlobPattern, loadConfigFromObjects,
} from "./test-helpers.mjs";

const { test, section, summary } = makeTestRunner();
const CWD = "C:/Users/Lucas.Pimentel/.pi";
const NORM_CWD = normalizePathSep(CWD);

section("getMatchField");

test("grep with path returns path",       getMatchField("grep", { pattern: "TODO", path: "./src" }), "./src");
test("grep without path returns empty",   getMatchField("grep", { pattern: "TODO" }), "");
test("glob with path returns path",       getMatchField("glob", { pattern: "**/*.ts", path: "./src" }), "./src");
test("glob without path returns empty",   getMatchField("glob", { pattern: "**/*.ts" }), "");
test("find with path returns path",       getMatchField("find", { pattern: "**/*.ts", path: "/x/y" }), "/x/y");
test("find without path returns empty",   getMatchField("find", { pattern: "**/*.ts" }), "");
test("search pattern is NOT match field", getMatchField("grep", { pattern: "TODO", path: "./src" }) === "TODO", false);

section("inputForMatching");

const grepWithPath = inputForMatching("grep", { pattern: "TODO", path: "./src" }, CWD);
test("relative path resolves to absolute (with trailing /)", grepWithPath.path, NORM_CWD + "/src/");

const grepNoPath = inputForMatching("grep", { pattern: "TODO" }, CWD);
test("no path defaults to cwd (with trailing /)", grepNoPath.path, NORM_CWD + "/");

const globAbsPath = inputForMatching("glob", { pattern: "**/*.ts", path: CWD + "/agent" }, CWD);
test("absolute path normalises separators (with trailing /)", globAbsPath.path, NORM_CWD + "/agent/");

const findRelPath = inputForMatching("find", { pattern: "AGENTS.md", path: "./src" }, CWD);
test("find: relative path resolves to absolute (with trailing /)", findRelPath.path, NORM_CWD + "/src/");

const findNoPath = inputForMatching("find", { pattern: "AGENTS.md" }, CWD);
test("find: no path defaults to cwd (with trailing /)", findNoPath.path, NORM_CWD + "/");

test("original input not mutated — pattern preserved", grepWithPath.pattern, "TODO");

section("suggestRule");

test("grep with path → Grep(path)",  suggestRule("grep", { pattern: "TODO", path: "./src" }), "grep(./src)");
test("grep no path → bare tool name", suggestRule("grep", { pattern: "TODO" }), "grep");
test("Glob with path → Glob(path)",  suggestRule("Glob", { pattern: "**/*.ts", path: "./src" }), "Glob(./src)");
test("Find with path → Find(path)",  suggestRule("Find", { pattern: "**/*.ts", path: CWD + "/agent" }), `Find(${NORM_CWD}/agent)`);
test("find no path → bare tool name", suggestRule("find", { pattern: "**/*.ts" }), "find");

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

const findNoPathInput  = inputForMatching("find", { pattern: "AGENTS.md" }, CWD);
const findRelInput     = inputForMatching("find", { pattern: "AGENTS.md", path: "./agent" }, CWD);
const findOutsideInput = inputForMatching("find", { pattern: "AGENTS.md", path: "/tmp/other" }, CWD);

test("Find(<cwd>/**) matches find with no explicit path",     compilePattern(NORM_CWD + "/**").test(findNoPathInput.path), true);
test("Find(<cwd>/**) matches find with relative path",        compilePattern(NORM_CWD + "/**").test(findRelInput.path), true);
test("Find(<cwd>/**) does NOT match path outside cwd",        compilePattern(NORM_CWD + "/**").test(findOutsideInput.path), false);

const cfg = makeCfg({ allow: [`Grep(${NORM_CWD}/**)`], deny: ["Grep(/etc/*)"], defaultAction: "ask" });
test("decide: cwd grep → allow",      decide(cfg, "grep", noPath), "allow");
test("decide: /etc grep → deny",      decide(cfg, "grep", etcPath), "deny");
test("decide: outside grep → ask",    decide(cfg, "grep", outside), "ask");

section("grepAllowCwd / globAllowCwd — implicit rules");

const defaultCfg = loadConfigFromObjects({}, {}, CWD);
test("default: Grep(<cwd>/**) in implicit allow",  defaultCfg.implicit.allow.includes(`Grep(${NORM_CWD}/**)`), true);
test("default: Glob(<cwd>/**) in implicit allow",  defaultCfg.implicit.allow.includes(`Glob(${NORM_CWD}/**)`), true);
test("default: Read(<cwd>/**) still present",      defaultCfg.implicit.allow.includes(`Read(${NORM_CWD}/**)`), true);
test("default: implicit.grepAllowCwd is true",     defaultCfg.implicit.grepAllowCwd, true);
test("default: implicit.globAllowCwd is true",     defaultCfg.implicit.globAllowCwd, true);
test("default: Find(<cwd>/**) in implicit allow",  defaultCfg.implicit.allow.includes(`Find(${NORM_CWD}/**)`), true);
test("default: implicit.findAllowCwd is true",     defaultCfg.implicit.findAllowCwd, true);

const noGrepCfg = loadConfigFromObjects({}, { grepAllowCwd: false }, CWD);
test("grepAllowCwd:false removes Grep from implicit",  noGrepCfg.implicit.allow.includes(`Grep(${NORM_CWD}/**)`), false);
test("grepAllowCwd:false does not remove Glob",        noGrepCfg.implicit.allow.includes(`Glob(${NORM_CWD}/**)`), true);
test("grepAllowCwd:false does not remove Find",        noGrepCfg.implicit.allow.includes(`Find(${NORM_CWD}/**)`), true);
test("implicit.grepAllowCwd flag is false",            noGrepCfg.implicit.grepAllowCwd, false);

const noGlobCfg = loadConfigFromObjects({}, { globAllowCwd: false }, CWD);
test("globAllowCwd:false removes Glob from implicit",  noGlobCfg.implicit.allow.includes(`Glob(${NORM_CWD}/**)`), false);
test("globAllowCwd:false does not remove Grep",        noGlobCfg.implicit.allow.includes(`Grep(${NORM_CWD}/**)`), true);
test("implicit.globAllowCwd flag is false",            noGlobCfg.implicit.globAllowCwd, false);

const noFindCfg = loadConfigFromObjects({}, { findAllowCwd: false }, CWD);
test("findAllowCwd:false removes Find from implicit",   noFindCfg.implicit.allow.includes(`Find(${NORM_CWD}/**)`), false);
test("findAllowCwd:false does not remove Grep",         noFindCfg.implicit.allow.includes(`Grep(${NORM_CWD}/**)`), true);
test("findAllowCwd:false does not remove Glob",         noFindCfg.implicit.allow.includes(`Glob(${NORM_CWD}/**)`), true);
test("findAllowCwd:false does not remove Read",         noFindCfg.implicit.allow.includes(`Read(${NORM_CWD}/**)`), true);
test("findAllowCwd:false does not remove Ls",           noFindCfg.implicit.allow.includes(`Ls(${NORM_CWD}/**)`), true);
test("implicit.findAllowCwd flag is false",             noFindCfg.implicit.findAllowCwd, false);

// user-level flag can also disable it
const userNoFindCfg = loadConfigFromObjects({ findAllowCwd: false }, {}, CWD);
test("user findAllowCwd:false also disables Find",      userNoFindCfg.implicit.allow.includes(`Find(${NORM_CWD}/**)`), false);

// project overrides user
const projRestoreFindCfg = loadConfigFromObjects({ findAllowCwd: false }, { findAllowCwd: true }, CWD);
test("project findAllowCwd:true overrides user false",  projRestoreFindCfg.implicit.allow.includes(`Find(${NORM_CWD}/**)`), true);

// user-level flag can also disable it
const userNoGrepCfg = loadConfigFromObjects({ grepAllowCwd: false }, {}, CWD);
test("user grepAllowCwd:false also disables Grep",     userNoGrepCfg.implicit.allow.includes(`Grep(${NORM_CWD}/**)`), false);

// project overrides user
const projRestoreGrepCfg = loadConfigFromObjects({ grepAllowCwd: false }, { grepAllowCwd: true }, CWD);
test("project grepAllowCwd:true overrides user false",  projRestoreGrepCfg.implicit.allow.includes(`Grep(${NORM_CWD}/**)`), true);

// end-to-end: decide uses the injected Grep rule
const grepInput  = inputForMatching("grep", { pattern: "TODO" }, CWD);
const globInput  = inputForMatching("glob", { pattern: "**/*.ts" }, CWD);

test("grepAllowCwd:true + cwd grep → allow",          decide(defaultCfg, "grep", grepInput), "allow");
test("globAllowCwd:true + cwd glob → allow",           decide(defaultCfg, "glob", globInput), "allow");

const findInput = inputForMatching("find", { pattern: "AGENTS.md" }, CWD);
test("findAllowCwd:true + cwd find → allow",           decide(defaultCfg, "find", findInput), "allow");

test("grepAllowCwd:false + deny default → deny",       decide({ ...noGrepCfg, defaultAction: "deny" }, "grep", grepInput), "deny");
test("globAllowCwd:false + deny default → deny",       decide({ ...noGlobCfg, defaultAction: "deny" }, "glob", globInput), "deny");
test("findAllowCwd:false + ask default → ask",         decide({ ...noFindCfg, defaultAction: "ask" }, "find", findInput), "ask");

// explicit deny still wins even when findAllowCwd:true
const findDenyCfg = loadConfigFromObjects({}, { deny: [`Find(${NORM_CWD}/secret/**)`] }, CWD);
test("explicit Find deny blocks find under secret dir", decide(findDenyCfg, "find", inputForMatching("find", { pattern: "x", path: NORM_CWD + "/secret/keys" }, CWD)), "deny");

// explicit deny still wins even when grepAllowCwd:true
const grepDenyCfg = loadConfigFromObjects({}, { deny: [`Grep(${NORM_CWD}/**)`] }, CWD);
test("explicit Grep deny wins over grepAllowCwd:true", decide(grepDenyCfg, "grep", grepInput), "deny");

process.exit(summary() > 0 ? 1 : 0);
