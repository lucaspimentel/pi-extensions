// run: node test-loadconfig.mjs

import {
	makeTestRunner, normalizePathSep, cwdGlobPattern, loadConfigFromObjects, decide,
} from "./test-helpers.mjs";

const { test, section, summary } = makeTestRunner();

const CWD = "C:/Users/Lucas.Pimentel/.pi";
const NORM_CWD = normalizePathSep(CWD);
const CWD_GLOB = cwdGlobPattern(CWD);
const IMPLICIT_READ = `Read(${CWD_GLOB})`;
const IMPLICIT_GREP = `Grep(${CWD_GLOB})`;
const IMPLICIT_GLOB = `Glob(${CWD_GLOB})`;
const IMPLICIT_LS   = `Ls(${CWD_GLOB})`;

section("implicit defaults (empty config)");

const empty = loadConfigFromObjects({}, {}, CWD);
test("defaultAction is ask",                    empty.defaultAction, "ask");
test("implicit Read(<cwd>/**) prepended",       empty.allow[0], IMPLICIT_READ);
test("implicit write→ask in toolDefaults",      empty.toolDefaults["write"], "ask");
test("implicit.readAllowCwd is true",           empty.implicit.readAllowCwd, true);
test("implicit.grepAllowCwd is true",           empty.implicit.grepAllowCwd, true);
test("implicit.globAllowCwd is true",           empty.implicit.globAllowCwd, true);
test("implicit.lsAllowCwd is true",             empty.implicit.lsAllowCwd, true);
test("implicit.bashReadOnlyAllowCwd is true",   empty.implicit.bashReadOnlyAllowCwd, true);
test("implicit.allow has 4 entries (Read+Grep+Glob+Ls)", empty.implicit.allow.length, 4);
test("implicit.allow[0] is Read(<cwd>/**)",     empty.implicit.allow[0], IMPLICIT_READ);
test("implicit.allow[1] is Grep(<cwd>/**)",     empty.implicit.allow[1], IMPLICIT_GREP);
test("implicit.allow[2] is Glob(<cwd>/**)",     empty.implicit.allow[2], IMPLICIT_GLOB);
test("implicit.allow[3] is Ls(<cwd>/**)",       empty.implicit.allow[3], IMPLICIT_LS);
test("implicit.allow[0] matches allow[0]",      empty.implicit.allow[0] === empty.allow[0], true);
test("implicit.toolDefaults has write key",     "write" in empty.implicit.toolDefaults, true);
test("no other implicit toolDefaults",          Object.keys(empty.implicit.toolDefaults).length, 1);

section("readAllowCwd: false");

const noAutoRead = loadConfigFromObjects({}, { readAllowCwd: false }, CWD);
test("no Read in allow when readAllowCwd:false", noAutoRead.implicit.allow.some(r => r.startsWith("Read(")), false);
test("Grep still in allow when readAllowCwd:false", noAutoRead.implicit.allow.includes(IMPLICIT_GREP), true);
test("Glob still in allow when readAllowCwd:false", noAutoRead.implicit.allow.includes(IMPLICIT_GLOB), true);
test("Ls still in allow when readAllowCwd:false",   noAutoRead.implicit.allow.includes(IMPLICIT_LS), true);
test("implicit.readAllowCwd is false",          noAutoRead.implicit.readAllowCwd, false);
test("implicit.allow has 3 entries (Grep+Glob+Ls)", noAutoRead.implicit.allow.length, 3);
test("write default still injected",            noAutoRead.toolDefaults["write"], "ask");

section("lsAllowCwd: false");

const noAutoLs = loadConfigFromObjects({}, { lsAllowCwd: false }, CWD);
test("no Ls in allow when lsAllowCwd:false",    noAutoLs.implicit.allow.some(r => r.startsWith("Ls(")), false);
test("Read still in allow when lsAllowCwd:false", noAutoLs.implicit.allow.includes(IMPLICIT_READ), true);
test("Grep still in allow when lsAllowCwd:false", noAutoLs.implicit.allow.includes(IMPLICIT_GREP), true);
test("Glob still in allow when lsAllowCwd:false", noAutoLs.implicit.allow.includes(IMPLICIT_GLOB), true);
test("implicit.lsAllowCwd is false",            noAutoLs.implicit.lsAllowCwd, false);
test("implicit.allow has 3 entries (Read+Grep+Glob)", noAutoLs.implicit.allow.length, 3);

section("explicit toolDefaults.write suppresses implicit");

const explicitWrite = loadConfigFromObjects({}, { toolDefaults: { write: "allow" } }, CWD);
test("explicit write:allow wins",               explicitWrite.toolDefaults["write"], "allow");
test("implicit.toolDefaults is empty",          Object.keys(explicitWrite.implicit.toolDefaults).length, 0);

const explicitAsk = loadConfigFromObjects({}, { toolDefaults: { write: "ask" } }, CWD);
test("explicit write:ask still counts as explicit", Object.keys(explicitAsk.implicit.toolDefaults).length, 0);
test("explicit write:ask value",                explicitAsk.toolDefaults["write"], "ask");

section("project overrides user");

const merged = loadConfigFromObjects(
	{ defaultAction: "allow", toolDefaults: { write: "ask",   read: "allow" } },
	{ defaultAction: "deny",  toolDefaults: { write: "allow", read: "deny"  } },
	CWD,
);
test("project defaultAction overrides user",    merged.defaultAction, "deny");
test("project toolDefaults.write overrides",    merged.toolDefaults["write"], "allow");
test("project toolDefaults.read overrides",     merged.toolDefaults["read"], "deny");

section("allow/deny/ask lists concatenated");

const withRules = loadConfigFromObjects(
	{ allow: ["Bash(npm*)"],  deny: ["Bash(rm*)"] },
	{ allow: ["Read"],        ask:  ["Bash(git push*)"] },
	CWD,
);
test("implicit Read prepended first",           withRules.allow[0], IMPLICIT_READ);
test("user allow rule present",                 withRules.allow.includes("Bash(npm*)"), true);
test("project allow rule present",              withRules.allow.includes("Read"), true);
test("user deny rule present",                  withRules.deny.includes("Bash(rm*)"), true);
test("project ask rule present",                withRules.ask.includes("Bash(git push*)"), true);

section("invalid toolDefaults values silently dropped");

const invalid = loadConfigFromObjects({}, { toolDefaults: { write: "lol", read: "allow" } }, CWD);
test("invalid value dropped → falls back to implicit", invalid.toolDefaults["write"], "ask");
test("valid value alongside invalid preserved",         invalid.toolDefaults["read"], "allow");

section("deduplication");

const dupes = loadConfigFromObjects(
	{ allow: ["Read", "Bash(npm*)"] },
	{ allow: ["Read", "Bash(npm*)"] },
	CWD,
);
test("duplicate allow rules deduplicated", dupes.allow.filter((r) => r === "Read").length, 1);
test("duplicate Bash rule deduplicated",   dupes.allow.filter((r) => r === "Bash(npm*)").length, 1);

section("end-to-end: decide uses loaded config");

const cfg = loadConfigFromObjects(
	{},
	{ deny: ["Write(.env*)"], allow: ["Bash(npm*)"], defaultAction: "ask" },
	CWD,
);
test("Read inside cwd → allow (implicit rule)", decide(cfg, "read", { path: NORM_CWD + "/src/foo.ts" }), "allow");
test("Write .env → deny (explicit rule)",       decide(cfg, "write", { path: ".env" }), "deny");
test("Bash npm test → allow (explicit rule)",   decide(cfg, "bash", { command: "npm test" }), "allow");
test("Write normal path → toolDefaults ask",    decide(cfg, "write", { path: "./src/foo.ts" }), "ask");
test("Read outside cwd → defaultAction ask",    decide(cfg, "read", { path: "/etc/passwd" }), "ask");
test("Ls inside cwd → allow (implicit rule)",   decide(cfg, "ls", { path: NORM_CWD + "/src/" }), "allow");
test("Ls outside cwd → defaultAction ask",      decide(cfg, "ls", { path: "/etc/" }), "ask");

// Ls with lsAllowCwd disabled: in-cwd Ls falls through to defaultAction
const noLsCfg = loadConfigFromObjects({}, { lsAllowCwd: false, defaultAction: "ask" }, CWD);
test("Ls inside cwd → ask when lsAllowCwd:false", decide(noLsCfg, "ls", { path: NORM_CWD + "/src/" }), "ask");

process.exit(summary() > 0 ? 1 : 0);
