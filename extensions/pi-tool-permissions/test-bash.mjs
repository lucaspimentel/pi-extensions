// run: node test-bash.mjs

import { resolve } from "node:path";
import {
	makeTestRunner, getMatchField, suggestRule,
	splitTopLevelShell, decideCompound, decide, makeCfg, isNoopCd,
	isReadOnlyBashSubcommand,
} from "./test-helpers.mjs";

const { test, section, summary } = makeTestRunner();

section("getMatchField");

test("bash returns input.command",          getMatchField("bash",  { command: "npm test" }), "npm test");
test("Bash (PascalCase) also works",        getMatchField("Bash",  { command: "npm test" }), "npm test");
test("missing command returns empty string", getMatchField("bash",  {}), "");

section("suggestRule");

test("first token + * for multi-word command",  suggestRule("bash", { command: "npm test --watch" }), "bash(npm *)");
test("first token + * for git command",         suggestRule("bash", { command: "git push origin main" }), "bash(git *)");
test("bare tool name for empty command",        suggestRule("bash", { command: "" }), "bash");
test("bare tool name for missing command",      suggestRule("bash", {}), "bash");

section("splitTopLevelShell — kind");

test("empty string → single",      splitTopLevelShell("").kind, "single");
test("single command → single",    splitTopLevelShell("npm test").kind, "single");
test("&& → compound",              splitTopLevelShell("a && b").kind, "compound");
test("|| → compound",              splitTopLevelShell("a || b").kind, "compound");
test("| → compound",               splitTopLevelShell("a | b").kind, "compound");
test("; → compound",               splitTopLevelShell("a ; b").kind, "compound");
test("newline → compound",         splitTopLevelShell("a\nb").kind, "compound");
test("CRLF → compound",            splitTopLevelShell("a\r\nb").kind, "compound");

section("splitTopLevelShell — parts");

const andAnd = splitTopLevelShell("npm test && git push");
test("&& splits into 2 parts",     andAnd.parts?.length, 2);
test("&& first part trimmed",      andAnd.parts?.[0], "npm test");
test("&& second part trimmed",     andAnd.parts?.[1], "git push");

const pipe3 = splitTopLevelShell("cat file | grep foo | wc -l");
test("three pipes → 3 parts",      pipe3.parts?.length, 3);

const semi = splitTopLevelShell("cd /tmp ; rm -rf test ; echo done");
test("; three parts",              semi.parts?.length, 3);

section("splitTopLevelShell — quoting");

test("double-quoted && not operator",   splitTopLevelShell('echo "a && b"').kind, "single");
test("single-quoted && not operator",   splitTopLevelShell("echo 'a && b'").kind, "single");
test("backtick-quoted && not operator", splitTopLevelShell("echo `a && b`").kind, "single");
test("escaped & not operator",          splitTopLevelShell("echo \\&\\&").kind, "single");
test("double-quoted ; not operator",    splitTopLevelShell('echo "a ; b"').kind, "single");
test("single-quoted | not operator",    splitTopLevelShell("echo 'a | b'").kind, "single");

section("splitTopLevelShell — line continuation (\\<newline>)");

// Continuation joins two lines into one logical command
const cont1 = splitTopLevelShell("foo \\\nbar");
test("\\<LF> joins lines → single",                   cont1.kind, "single");

// Continuation after a compound operator — second part must be clean
const cont2 = splitTopLevelShell("foo && \\\nbar");
test("&& with \\<LF> → compound",                     cont2.kind, "compound");
test("&& with \\<LF> → 2 parts",                      cont2.parts?.length, 2);
test("&& with \\<LF> → first part is 'foo'",          cont2.parts?.[0], "foo");
test("&& with \\<LF> → second part is 'bar' (not \\\\nbar)", cont2.parts?.[1], "bar");

// CRLF continuation
const cont3 = splitTopLevelShell("foo \\\r\nbar");
test("\\<CRLF> joins lines → single",                  cont3.kind, "single");

// Inside double quotes POSIX also strips \<newline>
const cont4 = splitTopLevelShell('echo "foo \\\nbar"');
test("\\<LF> inside double quotes → single",           cont4.kind, "single");

// Inside single quotes \<newline> is literal — must stay single (pinned regression guard)
test("\\<LF> inside single quotes preserved → single", splitTopLevelShell("echo 'a\\\nb'").kind, "single");

// Plain backslash before a non-newline char must still act as an escape
test("\\& still escapes (not a continuation)",         splitTopLevelShell("echo \\&\\&").kind, "single");

// Bare trailing backslash at EOF — no crash, treated as escape of nothing
test("trailing \\ at EOF → single",                    splitTopLevelShell("foo \\\\").kind, "single");

section("splitTopLevelShell — parentheses");

const parenGroup = splitTopLevelShell("(cmd1 && cmd2) || cmd3");
test("paren group + || → compound",          parenGroup.kind, "compound");
test("paren group + || → 2 parts",           parenGroup.parts?.length, 2);
test("paren content preserved as-is",        parenGroup.parts?.[0], "(cmd1 && cmd2)");
test("command after || captured",            parenGroup.parts?.[1], "cmd3");

test("nested parens handled", splitTopLevelShell("((a && b)) || c").parts?.length, 2);

section("splitTopLevelShell — ambiguous");

test("unmatched single quote → ambiguous",    splitTopLevelShell("echo 'unclosed").kind, "ambiguous");
test("unmatched double quote → ambiguous",    splitTopLevelShell('echo "unclosed').kind, "ambiguous");
test("unmatched open paren → ambiguous",      splitTopLevelShell("cmd (unclosed && x").kind, "ambiguous");
test("unmatched close paren → ambiguous",     splitTopLevelShell("cmd )").kind, "ambiguous");

section("decideCompound — non-bash short-circuit");

const readCfg = makeCfg({ allow: ["Read"], defaultAction: "deny" });
const dc0 = decideCompound(readCfg, "read", { path: "./file.ts" });
test("non-bash: isCompound false",        dc0.isCompound, false);
test("non-bash: ambiguous false",         dc0.ambiguous, false);
test("non-bash: delegates to decide",     dc0.action, "allow");
test("non-bash: empty breakdown",         dc0.breakdown.length, 0);

section("decideCompound — single bash command");

const cfg = makeCfg({ allow: ["Bash(npm*)"], deny: ["Bash(rm*)"], defaultAction: "ask" });

const single = decideCompound(cfg, "bash", { command: "npm test --watch" });
test("single: isCompound false",          single.isCompound, false);
test("single: action allow",              single.action, "allow");
test("single: ambiguous false",           single.ambiguous, false);
test("single: empty breakdown",           single.breakdown.length, 0);

section("decideCompound — compound bash");

const allAllow = decideCompound(cfg, "bash", { command: "npm test && npm run build" });
test("all allow → action allow",          allAllow.action, "allow");
test("all allow → isCompound true",       allAllow.isCompound, true);
test("all allow → breakdown length 2",    allAllow.breakdown.length, 2);
test("all allow → first sub action",      allAllow.breakdown[0].action, "allow");

const anyDeny = decideCompound(cfg, "bash", { command: "npm test && rm -rf ." });
test("any deny → action deny",            anyDeny.action, "deny");
test("deny propagates correctly",         anyDeny.breakdown.some((b) => b.action === "deny"), true);

const anyAsk = decideCompound(cfg, "bash", { command: "npm test && git push" });
test("no deny + any ask → action ask",    anyAsk.action, "ask");

const threeWay = decideCompound(cfg, "bash", { command: "npm test && git push && rm -rf ." });
test("deny wins over ask in 3-way",       threeWay.action, "deny");

section("decideCompound — ambiguous command");

const ambiguous = decideCompound(cfg, "bash", { command: "echo 'unclosed" });
test("ambiguous → action ask",            ambiguous.action, "ask");
test("ambiguous → ambiguous flag true",   ambiguous.ambiguous, true);
test("ambiguous → isCompound false",      ambiguous.isCompound, false);
test("ambiguous → empty breakdown",       ambiguous.breakdown.length, 0);

section("end-to-end rule matching");

const allowCfg = makeCfg({ allow: ["Bash(npm test*)"], deny: ["Bash(rm -rf*)"], ask: ["Bash(git push*)"], defaultAction: "ask" });
test("Bash(npm test*) allows npm test --watch", decide(allowCfg, "bash", { command: "npm test --watch" }), "allow");
test("Bash(rm -rf*) denies rm -rf .",           decide(allowCfg, "bash", { command: "rm -rf ." }), "deny");
test("Bash(git push*) asks for git push",       decide(allowCfg, "bash", { command: "git push origin" }), "ask");
test("unmatched command falls to defaultAction", decide(allowCfg, "bash", { command: "echo hello" }), "ask");

section("splitTopLevelShell — comment lines");

// A pure comment line on its own → treated as a single (no real subcommands)
test("lone comment → single",                splitTopLevelShell("# just a comment").kind, "single");

// Two real commands separated by a comment line
const withComment = splitTopLevelShell("npm ci\n# install deps\nnpm test");
test("comment line stripped, 2 parts remain", withComment.parts?.length, 2);
test("first part is npm ci",                  withComment.parts?.[0], "npm ci");
test("second part is npm test",               withComment.parts?.[1], "npm test");

// Leading whitespace before # still counts as a comment
const indentedComment = splitTopLevelShell("npm ci\n  # indented comment\nnpm test");
test("indented comment stripped",             indentedComment.parts?.length, 2);

// Inline # (not at start of line) is NOT a comment — keep the whole part
const inlineHash = splitTopLevelShell("echo foo # not a comment\nnpm test");
test("inline # not stripped",                 inlineHash.parts?.[0], "echo foo # not a comment");

// All lines are comments → collapses to single (no subcommands)
const allComments = splitTopLevelShell("# step 1\n# step 2\n# step 3");
test("all-comment lines → single",            allComments.kind, "single");

// Comment-only lines mixed with ; operator
const semiWithComment = splitTopLevelShell("cmd1 ; # comment ; cmd2");
test("comment between semicolons stripped",   semiWithComment.parts?.filter((p) => p === "cmd1").length, 1);
test("cmd2 still present",                    semiWithComment.parts?.includes("cmd2"), true);

// decideCompound skips comment lines for bash rule evaluation
const commentCfg = makeCfg({ allow: ["Bash(npm*)"], deny: ["Bash(rm*)"], defaultAction: "ask" });
const withCommentDecide = decideCompound(commentCfg, "bash", { command: "npm ci\n# rm -rf node_modules\nnpm test" });
test("comment line not evaluated as rm command", withCommentDecide.action, "allow");
test("breakdown excludes comment line",          withCommentDecide.breakdown.length, 2);

section("isNoopCd — recognised no-op forms");

const CWD = "/home/user/proj";

test("cd .  → no-op",           isNoopCd("cd .",   CWD), true);
test("cd ./  → no-op",          isNoopCd("cd ./",  CWD), true);
test("cd $PWD  → no-op",        isNoopCd("cd $PWD", CWD), true);
test("cd ${PWD}  → no-op",      isNoopCd("cd ${PWD}", CWD), true);
test("cd ~+  → no-op",          isNoopCd("cd ~+",  CWD), true);
test("cd '.'  → no-op",         isNoopCd("cd '.'",  CWD), true);
test("cd '/'  → not no-op when cwd != /",  isNoopCd("cd '/'", CWD), false);
test('cd "$PWD"  → no-op',      isNoopCd('cd "$PWD"', CWD), true);
test("cd <absolute cwd>  → no-op",      isNoopCd(`cd ${CWD}`, CWD), true);
test("cd <absolute cwd trailing />  → no-op", isNoopCd(`cd ${CWD}/`, CWD), true);

section("isNoopCd — NOT a no-op");

test("bare cd  → not no-op (goes to HOME)",  isNoopCd("cd", CWD), false);
test("cd ..  → not no-op",                   isNoopCd("cd ..", CWD), false);
test("cd /tmp  → not no-op",                 isNoopCd("cd /tmp", CWD), false);
test("cd /  → not no-op",                    isNoopCd("cd /", CWD), false);
test("cd $(evil)  → rejected",               isNoopCd("cd $(evil)", CWD), false);
test("cd `pwd`  → rejected",                 isNoopCd("cd `pwd`", CWD), false);
test("not cd at all  → false",               isNoopCd("ls .", CWD), false);
test("cdx  → false (not cd command)",        isNoopCd("cdx .", CWD), false);

section("isNoopCd — absolute cwd (Windows-style path)");

const WIN_CWD = "C:/Users/alice/proj";
test("Windows: cd C:/Users/alice/proj  → no-op",  isNoopCd("cd C:/Users/alice/proj",  WIN_CWD), true);
test("Windows: cd C:/Users/alice/proj/  → no-op", isNoopCd("cd C:/Users/alice/proj/", WIN_CWD), true);
test("Windows: case-insensitive match",            isNoopCd("cd c:/users/alice/proj",  WIN_CWD), true);
test("Windows: cd C:/Users/bob  → not no-op",     isNoopCd("cd C:/Users/bob",         WIN_CWD), false);

section("decide — no-op cd is auto-allowed");

// Even with a very restrictive defaultAction: deny and no allow rules the no-op forms go through
const strictCfg = makeCfg({ defaultAction: "deny", cwd: CWD });
test("cd .  allowed with deny default",     decide(strictCfg, "bash", { command: "cd ." }),     "allow");
test("cd ./  allowed with deny default",    decide(strictCfg, "bash", { command: "cd ./" }),    "allow");
test("cd $PWD  allowed",                    decide(strictCfg, "bash", { command: "cd $PWD" }),  "allow");
test("cd ${PWD}  allowed",                  decide(strictCfg, "bash", { command: "cd ${PWD}" }),"allow");
test("cd ~+  allowed",                      decide(strictCfg, "bash", { command: "cd ~+" }),    "allow");
test("cd <cwd>  allowed",                   decide(strictCfg, "bash", { command: `cd ${CWD}` }),"allow");

test("cd ..  falls through to deny",        decide(strictCfg, "bash", { command: "cd .." }),    "deny");
test("cd /tmp  falls through to deny",      decide(strictCfg, "bash", { command: "cd /tmp" }),  "deny");

section("decide — explicit deny rule beats no-op cd");

const denyAllBash = makeCfg({ deny: ["Bash(cd*)"], defaultAction: "allow", cwd: CWD });
test("Bash(cd*) deny wins over no-op cd .",    decide(denyAllBash, "bash", { command: "cd ." }),    "deny");
test("Bash(cd*) deny wins over cd $PWD",       decide(denyAllBash, "bash", { command: "cd $PWD" }), "deny");

section("decide — allowNoopCd: false disables the behaviour");

const noNoopCfg = makeCfg({ defaultAction: "deny", allowNoopCd: false, cwd: CWD });
test("cd .  denied when allowNoopCd: false",  decide(noNoopCfg, "bash", { command: "cd ." }),    "deny");
test("cd $PWD  denied when allowNoopCd: false",decide(noNoopCfg, "bash", { command: "cd $PWD" }), "deny");

section("decideCompound — no-op cd inside compound command");

const compCfg = makeCfg({ deny: ["Bash(rm*)"], allow: ["Bash(npm*)"], defaultAction: "ask", cwd: CWD });

const cdAndNpm = decideCompound(compCfg, "bash", { command: `cd ${CWD} && npm test` });
test("cd <cwd> && npm test → allow",      cdAndNpm.action, "allow");
test("breakdown length is 2",             cdAndNpm.breakdown.length, 2);
test("cd part is allowed",                cdAndNpm.breakdown[0].action, "allow");
test("npm test part is allowed",          cdAndNpm.breakdown[1].action, "allow");

const cdAndRm = decideCompound(compCfg, "bash", { command: "cd . && rm -rf /" });
test("cd . && rm -rf / → deny",          cdAndRm.action, "deny");
test("cd . is allowed individually",     cdAndRm.breakdown[0].action, "allow");
test("rm is denied",                     cdAndRm.breakdown[1].action, "deny");

section("isReadOnlyBashSubcommand — SAFE_ALWAYS commands");

test("pwd → safe always",          isReadOnlyBashSubcommand("pwd", CWD), true);
test("echo hi → safe always",      isReadOnlyBashSubcommand("echo hi", CWD), true);
test("whoami → safe always",       isReadOnlyBashSubcommand("whoami", CWD), true);
test("date -u → safe always",      isReadOnlyBashSubcommand("date -u", CWD), true);
test("uname -a → safe always",     isReadOnlyBashSubcommand("uname -a", CWD), true);
test("which node → safe always",   isReadOnlyBashSubcommand("which node", CWD), true);
test("env → safe always",          isReadOnlyBashSubcommand("env", CWD), true);
test("printf hi → safe always",    isReadOnlyBashSubcommand("printf hi", CWD), true);
test("true → safe always",          isReadOnlyBashSubcommand("true", CWD), true);

// Use WIN_CWD (C:/...) for WITH_PATHS tests: resolve() on Windows prepends a
// drive letter to Unix-style paths (/home/...) which breaks cwd-prefix comparisons.
section("isReadOnlyBashSubcommand — WITH_PATHS (paths inside cwd)");

test("ls (bare) → true",                     isReadOnlyBashSubcommand("ls", WIN_CWD), true);
test("ls -la → true (flag only)",            isReadOnlyBashSubcommand("ls -la", WIN_CWD), true);
test("ls -la . → true (cwd itself)",         isReadOnlyBashSubcommand("ls -la .", WIN_CWD), true);
test("ls ./src → true (child of cwd)",       isReadOnlyBashSubcommand("ls ./src", WIN_CWD), true);
test("cat ./README.md → true",               isReadOnlyBashSubcommand("cat ./README.md", WIN_CWD), true);
test("head -n 20 ./file.ts → true",          isReadOnlyBashSubcommand("head -n 20 ./file.ts", WIN_CWD), true);
test("wc -l ./src/index.ts → true",          isReadOnlyBashSubcommand("wc -l ./src/index.ts", WIN_CWD), true);
test("stat ./package.json → true",           isReadOnlyBashSubcommand("stat ./package.json", WIN_CWD), true);
test("quoted path inside cwd → true",        isReadOnlyBashSubcommand(`cat "./has space.md"`, WIN_CWD), true);
test("tail -f ./app.log → true",             isReadOnlyBashSubcommand("tail -f ./app.log", WIN_CWD), true);

section("isReadOnlyBashSubcommand — rejected cases");

test("rm → not in safe lists",               isReadOnlyBashSubcommand("rm -rf .", WIN_CWD), false);
test("git → not in safe lists",              isReadOnlyBashSubcommand("git status", WIN_CWD), false);
test("curl → not in safe lists",             isReadOnlyBashSubcommand("curl http://x.com", WIN_CWD), false);
test("cat /etc/passwd → path outside cwd",   isReadOnlyBashSubcommand("cat /etc/passwd", WIN_CWD), false);
test("ls .. → parent dir not inside cwd",    isReadOnlyBashSubcommand("ls ..", WIN_CWD), false);
test("ls C:/Windows → path outside cwd",     isReadOnlyBashSubcommand("ls C:/Windows", WIN_CWD), false);
test("echo foo > /tmp/out → redirect",       isReadOnlyBashSubcommand("echo foo > /tmp/out", WIN_CWD), false);
test("cat secrets >> log → redirect",        isReadOnlyBashSubcommand("cat secrets >> log", WIN_CWD), false);
test("empty string → false",                 isReadOnlyBashSubcommand("", WIN_CWD), false);
test("unknown command → false",              isReadOnlyBashSubcommand("make build", WIN_CWD), false);

section("decide — bashReadOnlyAllowCwd auto-allow");

// Use WIN_CWD so relative path resolution works correctly on Windows
const roStrictCfg = makeCfg({ defaultAction: "deny", bashReadOnlyAllowCwd: true, cwd: WIN_CWD });
test("pwd → allow (deny default)",                    decide(roStrictCfg, "bash", { command: "pwd" }), "allow");
test("ls → allow (deny default)",                     decide(roStrictCfg, "bash", { command: "ls" }), "allow");
test("echo hello → allow (safe always)",              decide(roStrictCfg, "bash", { command: "echo hello" }), "allow");
test("cat ./README.md → allow",                       decide(roStrictCfg, "bash", { command: "cat ./README.md" }), "allow");
test("cat /etc/passwd → deny (path outside cwd)",    decide(roStrictCfg, "bash", { command: "cat /etc/passwd" }), "deny");
test("rm -rf . → deny (not in safe lists)",           decide(roStrictCfg, "bash", { command: "rm -rf ." }), "deny");

const roOffCfg = makeCfg({ defaultAction: "deny", bashReadOnlyAllowCwd: false, cwd: WIN_CWD });
test("pwd → deny when bashReadOnlyAllowCwd:false",    decide(roOffCfg, "bash", { command: "pwd" }), "deny");
test("ls → deny when bashReadOnlyAllowCwd:false",     decide(roOffCfg, "bash", { command: "ls" }), "deny");

const roDenyLsCfg = makeCfg({ deny: ["Bash(ls*)"], defaultAction: "allow", bashReadOnlyAllowCwd: true, cwd: WIN_CWD });
test("explicit deny wins over read-only allow",        decide(roDenyLsCfg, "bash", { command: "ls" }), "deny");
test("explicit deny on pwd wins over read-only allow", decide(
	makeCfg({ deny: ["Bash(pwd*)"], defaultAction: "allow", bashReadOnlyAllowCwd: true, cwd: WIN_CWD }),
	"bash", { command: "pwd" }
), "deny");

// non-bash tool not affected
test("read tool not affected by bashReadOnlyAllowCwd",  decide(roStrictCfg, "read", { path: "/etc/passwd" }), "deny");

section("decideCompound — read-only bash subcommands");

const roCompCfg = makeCfg({ defaultAction: "deny", bashReadOnlyAllowCwd: true, cwd: WIN_CWD });

const lsAndPwd = decideCompound(roCompCfg, "bash", { command: "ls && pwd" });
test("ls && pwd → allow",              lsAndPwd.action, "allow");
test("ls && pwd → isCompound true",   lsAndPwd.isCompound, true);
test("ls && pwd → 2 parts",           lsAndPwd.breakdown.length, 2);
test("ls part → allow",               lsAndPwd.breakdown[0].action, "allow");
test("pwd part → allow",              lsAndPwd.breakdown[1].action, "allow");

const lsAndRm = decideCompound(roCompCfg, "bash", { command: "ls && rm -rf ." });
test("ls && rm -rf . → deny",         lsAndRm.action, "deny");
test("ls subpart → allow",            lsAndRm.breakdown[0].action, "allow");
test("rm subpart → deny (falls to defaultAction)", lsAndRm.breakdown[1].action, "deny");

const lsAndGit = decideCompound(roCompCfg, "bash", { command: "ls && git status" });
test("ls && git status → deny (git not in safe list)", lsAndGit.action, "deny");

process.exit(summary() > 0 ? 1 : 0);
