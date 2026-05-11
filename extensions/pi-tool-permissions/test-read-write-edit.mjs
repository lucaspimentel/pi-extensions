// run: node test-read-write-edit.mjs

import {
	makeTestRunner, normalizePathSep, getMatchField, inputForMatching,
	suggestRule, compilePattern, decide, makeCfg, cwdGlobPattern,
} from "./test-helpers.mjs";

const { test, section, summary } = makeTestRunner();
const CWD = "C:/Users/Lucas.Pimentel/.pi";
const NORM_CWD = normalizePathSep(CWD);
const CWD_PATTERN = cwdGlobPattern(CWD);

section("getMatchField");

test("read returns input.path",         getMatchField("read", { path: "./src/foo.ts" }), "./src/foo.ts");
test("write returns input.path",        getMatchField("write", { path: "/etc/hosts" }), "/etc/hosts");
test("edit returns input.path",         getMatchField("edit", { path: "C:\\foo\\bar.ts" }), "C:\\foo\\bar.ts");
test("missing path returns empty",      getMatchField("read", {}), "");
test("Read (PascalCase) also works",    getMatchField("Read", { path: "./file.ts" }), "./file.ts");
test("Write (PascalCase) also works",   getMatchField("Write", { path: "./file.ts" }), "./file.ts");

section("inputForMatching");

const relRead = inputForMatching("read", { path: "./src/foo.ts" }, CWD);
// read/write/edit only normalise separators; relative paths stay relative
// so that user rules like Write(.env*) continue to work
test("relative path: separators normalised, stays relative", relRead.path, "./src/foo.ts");

const backslash = inputForMatching("write", { path: "C:\\Users\\Lucas\\file.ts" }, CWD);
test("Windows backslashes normalised",           backslash.path, "C:/Users/Lucas/file.ts");

const absUnix = inputForMatching("read", { path: "/etc/passwd" }, CWD);
test("absolute Unix path passes through",        absUnix.path, "/etc/passwd");

const absDrive = inputForMatching("read", { path: "C:/foo/bar.ts" }, CWD);
test("Windows drive path passes through",        absDrive.path, "C:/foo/bar.ts");

// Unlike grep/glob, read/write/edit do NOT default empty path to cwd
const emptyPath = inputForMatching("read", { path: "" }, CWD);
test("empty path: input passes through unchanged", emptyPath.path, "");

const noPath = inputForMatching("read", {}, CWD);
test("missing path: input passes through unchanged (no cwd default)", noPath.path, undefined);

const preserved = inputForMatching("write", { path: "./file.ts", contents: "hello" }, CWD);
test("other input fields preserved alongside path", preserved.contents, "hello");

section("suggestRule");

test("read with path suggests Read(path)",          suggestRule("read",  { path: "./src/foo.ts" }), "read(./src/foo.ts)");
test("write with backslashes normalised",            suggestRule("write", { path: "C:\\Users\\foo\\file.ts" }), "write(C:/Users/foo/file.ts)");
test("edit with no path → bare tool name",          suggestRule("Edit",  { path: "" }), "Edit");
test("read with missing path → bare tool name",     suggestRule("Read",  {}), "Read");

section("end-to-end rule matching");

// Use an absolute path — pi provides absolute paths to read/write/edit in practice,
// and inputForMatching only normalises separators (does not resolve relative to absolute).
const cwdRead = inputForMatching("read", { path: NORM_CWD + "/agent/index.ts" }, CWD);
test("Read(<cwd>/**) matches file inside cwd",          compilePattern(CWD_PATTERN).test(cwdRead.path), true);

const outsideRead = inputForMatching("read", { path: "/etc/passwd" }, CWD);
test("Read(<cwd>/**) does NOT match outside cwd",       compilePattern(CWD_PATTERN).test(outsideRead.path), false);

const envWrite = inputForMatching("write", { path: ".env.local" }, CWD);
test("Write(.env*) matches .env.local",                 compilePattern(".env*").test(getMatchField("write", envWrite)), true);

const srcWrite = inputForMatching("write", { path: "./src/index.ts" }, CWD);
test("Write(.env*) does NOT match ./src/index.ts",      compilePattern(".env*").test(getMatchField("write", srcWrite)), false);

const gitEdit = inputForMatching("edit", { path: "./.git/config" }, CWD);
test("Edit(*/.git/*) matches .git/config path",         compilePattern("*/.git/*").test(getMatchField("edit", gitEdit)), true);

// Full decide chain
const cfg = makeCfg({
	deny:         ["Write(.env*)", `Edit(*/.git/*)`],
	allow:        [`Read(${CWD_PATTERN})`],
	toolDefaults: { write: "ask" },
	defaultAction: "ask",
});

test("decide: Read inside cwd → allow",             decide(cfg, "read",  cwdRead), "allow");
test("decide: Read outside cwd → ask (defaultAction)", decide(cfg, "read", outsideRead), "ask");
test("decide: Write .env → deny",                   decide(cfg, "write", { path: ".env" }), "deny");
test("decide: Write normal path → toolDefaults ask", decide(cfg, "write", srcWrite), "ask");
test("decide: Edit .git/config → deny",             decide(cfg, "edit",  gitEdit), "deny");

// Explicit Write allow beats toolDefaults write:ask
const allowOutputCfg = makeCfg({
	allow:        ["Write(./output/*)"],
	toolDefaults: { write: "ask" },
	defaultAction: "allow",
});
// With only separator normalisation, relative paths stay relative and match relative rules.
const outputWrite = inputForMatching("write", { path: "./output/result.json" }, CWD);
test("Write(./output/*) allow beats toolDefaults ask", decide(allowOutputCfg, "write", { path: "./output/result.json" }), "allow");

section("decide — implicit Read(<cwd>/**) matches relative paths (regression)");

// makeCfg doesn't inject implicit rules; supply the cwd glob explicitly to mirror what loadConfig does.
const implicitReadCfg = makeCfg({
	allow:         [`Read(${CWD_PATTERN})`],
	defaultAction: "ask",
	cwd:           CWD,
});

test("Read(./TODO.md) → allow (dot-slash relative)",
	decide(implicitReadCfg, "read", { path: "./TODO.md" }), "allow");
test("Read(TODO.md) → allow (bare relative)",
	decide(implicitReadCfg, "read", { path: "TODO.md" }), "allow");
test("Read(src/foo.ts) → allow (nested relative)",
	decide(implicitReadCfg, "read", { path: "src/foo.ts" }), "allow");
test("Read(/etc/passwd) → ask (outside cwd, not allowed)",
	decide(implicitReadCfg, "read", { path: "/etc/passwd" }), "ask");

// Relative deny rules must still work even with the dual-candidate matching
const relDenyCfg = makeCfg({
	deny:          ["Write(.env*)"],
	defaultAction: "allow",
	cwd:           CWD,
});
test("Write(.env.local) → deny (relative deny rule still works)",
	decide(relDenyCfg, "write", { path: ".env.local" }), "deny");
test("Write(./src/index.ts) → allow (relative deny rule doesn't over-match)",
	decide(relDenyCfg, "write", { path: "./src/index.ts" }), "allow");

process.exit(summary() > 0 ? 1 : 0);
