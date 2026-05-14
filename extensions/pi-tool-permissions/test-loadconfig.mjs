// run: node test-loadconfig.mjs

import {
	makeTestRunner, normalizePathSep, cwdGlobPattern, skillReadGlobs, piDocsReadGlobs, loadConfigFromObjects, decide,
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

section("readAllowSkills");

const HOME = "C:/Users/Test";
const SKILL_GLOBS = skillReadGlobs(HOME);
const SKILL_RULES = SKILL_GLOBS.map((g) => `Read(${g})`);

const withSkills = loadConfigFromObjects({}, {}, CWD, HOME);
test("implicit.readAllowSkills is true by default", withSkills.implicit.readAllowSkills, true);
test("implicit.allow includes ~/.pi/agent/skills/** rule",          withSkills.implicit.allow.includes(SKILL_RULES[0]), true);
test("implicit.allow includes ~/.pi/agent/git/**/skills/** rule",   withSkills.implicit.allow.includes(SKILL_RULES[1]), true);
test("implicit.allow includes ~/.agents/skills/** rule",            withSkills.implicit.allow.includes(SKILL_RULES[2]), true);
test("implicit.allow has 4 cwd + 3 skill + 6 pi-docs rules",         withSkills.implicit.allow.length, 13);

// Opt-out: readAllowSkills: false removes all three skill rules
const noSkills = loadConfigFromObjects({}, { readAllowSkills: false }, CWD, HOME);
test("implicit.readAllowSkills is false when disabled", noSkills.implicit.readAllowSkills, false);
test("no skill rules when disabled",                    noSkills.implicit.allow.some((r) => SKILL_RULES.includes(r)), false);
test("cwd + pi-docs rules still present when readAllowSkills:false",  noSkills.implicit.allow.length, 10);

// End-to-end decide(): in-scope skill paths → allow
const skillCfg = loadConfigFromObjects({}, { defaultAction: "ask" }, CWD, HOME);
test("Read ~/.pi/agent/skills/foo/SKILL.md → allow",
	decide(skillCfg, "read", { path: HOME + "/.pi/agent/skills/foo/SKILL.md" }), "allow");
test("Read ~/.pi/agent/git/github.com/u/r/skills/bar/SKILL.md → allow",
	decide(skillCfg, "read", { path: HOME + "/.pi/agent/git/github.com/u/r/skills/bar/SKILL.md" }), "allow");
test("Read ~/.agents/skills/baz/SKILL.md → allow",
	decide(skillCfg, "read", { path: HOME + "/.agents/skills/baz/SKILL.md" }), "allow");
test("Read helper script inside skill dir → allow",
	decide(skillCfg, "read", { path: HOME + "/.pi/agent/skills/foo/scripts/helper.sh" }), "allow");

// Constrained scope: paths outside the skill roots must NOT be auto-allowed
test("Read ~/.pi/agent/sessions/abc.json → ask (NOT in skills scope)",
	decide(skillCfg, "read", { path: HOME + "/.pi/agent/sessions/abc.json" }), "ask");
test("Read ~/.pi/agent/git/github.com/u/r/README.md → ask (outside skills/ subdir)",
	decide(skillCfg, "read", { path: HOME + "/.pi/agent/git/github.com/u/r/README.md" }), "ask");
test("Read ~/.pi/agent/pi-tool-permissions.json → ask (NOT in skills scope)",
	decide(skillCfg, "read", { path: HOME + "/.pi/agent/pi-tool-permissions.json" }), "ask");

// readAllowSkills:false makes in-scope paths fall through too
const skillsOffCfg = loadConfigFromObjects({}, { readAllowSkills: false, defaultAction: "ask" }, CWD, HOME);
test("Read skill SKILL.md → ask when readAllowSkills:false",
	decide(skillsOffCfg, "read", { path: HOME + "/.pi/agent/skills/foo/SKILL.md" }), "ask");

// Sanity: Write to a skill path is NOT auto-allowed (write→ask still applies)
test("Write skill SKILL.md → ask (write toolDefault unaffected by readAllowSkills)",
	decide(skillCfg, "write", { path: HOME + "/.pi/agent/skills/foo/SKILL.md" }), "ask");

section("readAllowPiDocs");

const PI_DOCS_GLOBS = piDocsReadGlobs(HOME);
const PI_DOCS_RULES = PI_DOCS_GLOBS.map((g) => `Read(${g})`);

const withPiDocs = loadConfigFromObjects({}, {}, CWD, HOME);
test("implicit.readAllowPiDocs is true by default",                       withPiDocs.implicit.readAllowPiDocs, true);
test("implicit.allow includes Windows AppData npm rule",                  withPiDocs.implicit.allow.includes(PI_DOCS_RULES[0]), true);
test("implicit.allow includes .npm-global rule",                         withPiDocs.implicit.allow.includes(PI_DOCS_RULES[1]), true);
test("implicit.allow includes .nvm rule",                                withPiDocs.implicit.allow.includes(PI_DOCS_RULES[2]), true);
test("implicit.allow includes .volta rule",                              withPiDocs.implicit.allow.includes(PI_DOCS_RULES[3]), true);
test("implicit.allow includes .local/share/npm rule",                    withPiDocs.implicit.allow.includes(PI_DOCS_RULES[4]), true);
test("implicit.allow includes Library/Application Support rule",         withPiDocs.implicit.allow.includes(PI_DOCS_RULES[5]), true);
test("implicit.allow has 4 cwd + 3 skill + 6 pi-docs rules",             withPiDocs.implicit.allow.length, 13);

// Opt-out: readAllowPiDocs: false removes all pi-docs rules
const noPiDocs = loadConfigFromObjects({}, { readAllowPiDocs: false }, CWD, HOME);
test("implicit.readAllowPiDocs is false when disabled",  noPiDocs.implicit.readAllowPiDocs, false);
test("no pi-docs rules when disabled",                   noPiDocs.implicit.allow.some((r) => PI_DOCS_RULES.includes(r)), false);
test("cwd + skill rules still present when readAllowPiDocs:false", noPiDocs.implicit.allow.length, 7);

// Independence: toggling one flag does not affect the other
const skillsOffPiDocsOn = loadConfigFromObjects({}, { readAllowSkills: false }, CWD, HOME);
test("readAllowSkills:false still leaves pi-docs rules",    skillsOffPiDocsOn.implicit.allow.some((r) => PI_DOCS_RULES.includes(r)), true);
test("readAllowSkills:false still has readAllowPiDocs:true", skillsOffPiDocsOn.implicit.readAllowPiDocs, true);
const piDocsOffSkillsOn = loadConfigFromObjects({}, { readAllowPiDocs: false }, CWD, HOME);
test("readAllowPiDocs:false still leaves skill rules",      piDocsOffSkillsOn.implicit.allow.includes(SKILL_RULES[0]), true);
test("readAllowPiDocs:false still has readAllowSkills:true", piDocsOffSkillsOn.implicit.readAllowSkills, true);

// End-to-end decide(): pi-docs paths → allow
const piDocsCfg = loadConfigFromObjects({}, { defaultAction: "ask" }, CWD, HOME);
test("Read pi README.md (Windows AppData) → allow",
	decide(piDocsCfg, "read", { path: HOME + "/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/README.md" }), "allow");
test("Read pi docs/sdk.md (Windows AppData) → allow",
	decide(piDocsCfg, "read", { path: HOME + "/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/docs/sdk.md" }), "allow");
test("Read pi README.md (.nvm layout) → allow",
	decide(piDocsCfg, "read", { path: HOME + "/.nvm/versions/node/v20.0.0/lib/node_modules/@earendil-works/pi-coding-agent/README.md" }), "allow");

// End-to-end decide(): out-of-scope paths must NOT be auto-allowed
test("Read sibling npm package → ask (out of scope)",
	decide(piDocsCfg, "read", { path: HOME + "/AppData/Roaming/npm/node_modules/other-pkg/README.md" }), "ask");
test("Read npm root file → ask (out of scope)",
	decide(piDocsCfg, "read", { path: HOME + "/AppData/Roaming/npm/other.json" }), "ask");

// Opt-out flow-through
const piDocsOffCfg = loadConfigFromObjects({}, { readAllowPiDocs: false, defaultAction: "ask" }, CWD, HOME);
test("Read pi-docs file → ask when readAllowPiDocs:false",
	decide(piDocsOffCfg, "read", { path: HOME + "/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/README.md" }), "ask");

// Write unaffected
test("Write pi-docs file → ask (write toolDefault unaffected by readAllowPiDocs)",
	decide(piDocsCfg, "write", { path: HOME + "/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/README.md" }), "ask");

// Project overrides user precedence
const userOffProjectOn = loadConfigFromObjects({ readAllowPiDocs: false }, { readAllowPiDocs: true }, CWD, HOME);
test("user:false, project:true → readAllowPiDocs is true",  userOffProjectOn.implicit.readAllowPiDocs, true);
const userOnProjectOff = loadConfigFromObjects({ readAllowPiDocs: true }, { readAllowPiDocs: false }, CWD, HOME);
test("user:true, project:false → readAllowPiDocs is false", userOnProjectOff.implicit.readAllowPiDocs, false);

process.exit(summary() > 0 ? 1 : 0);
