// run: node test-bash.mjs

import { resolve } from "node:path";
import {
	makeTestRunner, getMatchField, suggestRule,
	splitTopLevelShell, decideCompound, decide, makeCfg, isNoopCd,
	isReadOnlyBashSubcommand, isPureVariableAssignment, hasTopLevelFileRedirect, rulePatternAllowsRedirect,
	parseRule,
	actionIcon, formatBreakdownLine, formatBreakdown,
	stripLineContinuations, stripStructuralKeywords,
} from "./test-helpers.mjs";

const { test, section, summary } = makeTestRunner();

section("getMatchField");

test("bash returns input.command",          getMatchField("bash",  { command: "npm test" }), "npm test");
test("Bash (PascalCase) also works",        getMatchField("Bash",  { command: "npm test" }), "npm test");
test("missing command returns empty string", getMatchField("bash",  {}), "");

section("suggestRule");

test("full command for multi-word command",  suggestRule("bash", { command: "npm test --watch" }), "bash(npm test --watch)");
test("full command for git command",         suggestRule("bash", { command: "git push origin main" }), "bash(git push origin main)");
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
// case blocks → single (pattern-clause `)` would otherwise look like unmatched paren)
test("case at start → single",      splitTopLevelShell("case $x in foo) cmd;; esac").kind, "single");
test("case after ; → single",       splitTopLevelShell("echo a; case $x in foo) cmd;; esac").kind, "single");
test("case after \\n → single",      splitTopLevelShell("echo a\ncase $x in foo) cmd;; esac").kind, "single");
test("case after && → single",      splitTopLevelShell("echo a && case $x in foo) cmd;; esac").kind, "single");
// negative: 'case' as argument does not trigger (not at command-start position)
test("grep case → not affected",    splitTopLevelShell("grep case file").kind, "single");
test("echo case → not affected",    splitTopLevelShell("echo case").kind, "single");

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

section("stripLineContinuations");

test("\\<LF> joined",                                   stripLineContinuations("foo \\\nbar"), "foo bar");
test("\\<CRLF> joined",                                 stripLineContinuations("foo \\\r\nbar"), "foo bar");
test("\\<LF> inside double quotes stripped",            stripLineContinuations('echo "a \\\nb"'), 'echo "a b"');
test("\\<LF> inside single quotes preserved",           stripLineContinuations("echo 'a \\\nb'"), "echo 'a \\\nb'");
test("non-newline escape preserved (\\&)",              stripLineContinuations("foo \\&"), "foo \\&");
test("non-newline escape preserved (\\$)",              stripLineContinuations("echo \\$HOME"), "echo \\$HOME");
test("trailing backslash at EOF preserved",             stripLineContinuations("foo \\"), "foo \\");
test("empty string unchanged",                          stripLineContinuations(""), "");
test("no continuations — returned as-is",                stripLineContinuations("npm test --watch"), "npm test --watch");
test("multiple continuations joined",                   stripLineContinuations("a \\\nb \\\nc"), "a b c");
test("continuation immediately after && (compound)",    stripLineContinuations("foo && \\\nbar"), "foo && bar");

section("decideCompound — line continuation in single commands");

// A non-compound command containing \<LF> must still match plain rules after normalization.
const contAllowCfg = makeCfg({ allow: ["Bash(foo bar)"], defaultAction: "deny" });
const contSingle = decideCompound(contAllowCfg, "bash", { command: "foo \\\nbar" });
test("\\<LF> single → action allow (rule matches normalized form)", contSingle.action, "allow");
test("\\<LF> single → isCompound false",                            contSingle.isCompound, false);
test("\\<LF> single → ambiguous false",                             contSingle.ambiguous, false);

const contSingleCRLF = decideCompound(contAllowCfg, "bash", { command: "foo \\\r\nbar" });
test("\\<CRLF> single → action allow",                              contSingleCRLF.action, "allow");

// Inside single quotes \<NL> is literal — the command is NOT normalized and the rule should NOT match.
const contSingleQuoted = decideCompound(contAllowCfg, "bash", { command: "echo 'foo \\\nbar'" });
test("\\<LF> inside '...' not normalized → falls through to deny",   contSingleQuoted.action, "deny");

// no-op cd survives line-continuation normalization (was previously missed in single-cmd path)
const noopCwd = "/home/user/proj";
const noopContCfg = makeCfg({ defaultAction: "deny", cwd: noopCwd });
const noopCont = decideCompound(noopContCfg, "bash", { command: "cd \\\n." });
test("cd \\<LF>. → recognized as no-op (allow)",                     noopCont.action, "allow");

// read-only bash subcommand detection survives line-continuation normalization
const readonlyContCfg = makeCfg({ defaultAction: "deny", bashReadOnlyAllowCwd: true, cwd: process.cwd() });
const readonlyCont = decideCompound(readonlyContCfg, "bash", { command: "pwd \\\n" });
test("pwd with trailing \\<LF> → allow via readonly auto-allow",      readonlyCont.action, "allow");

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

// Leading comment + single real command → single with effectiveCmd (not the comment-prefixed string)
const leadingComment = splitTopLevelShell("# find where X is used\nrg -A5 X /some/path");
test("leading comment + single cmd → kind single",     leadingComment.kind, "single");
test("leading comment + single cmd → effectiveCmd set", leadingComment.effectiveCmd, "rg -A5 X /some/path");

// decideCompound uses effectiveCmd — rule matching should not see the comment prefix
const leadingCommentCfg = makeCfg({ allow: ["Bash(rg *)"], defaultAction: "ask" });
const leadingCommentDecide = decideCompound(leadingCommentCfg, "bash", { command: "# find DATADOG_CLIENT_COMPUTED_STATS\nrg -A5 \"DATADOG_CLIENT_COMPUTED_STATS\" /some/path" });
test("leading comment stripped — rg command is allowed", leadingCommentDecide.action, "allow");

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
const MSYS_PATHS = { env: { MSYSTEM: "MINGW64", OSTYPE: "msys" }, home: "C:\\Users\\alice" };
const CYGWIN_PATHS = { env: { OSTYPE: "cygwin" }, home: "C:/Users/alice" };
test("Windows: cd C:/Users/alice/proj  → no-op",  isNoopCd("cd C:/Users/alice/proj",  WIN_CWD), true);
test("Windows: cd C:/Users/alice/proj/  → no-op", isNoopCd("cd C:/Users/alice/proj/", WIN_CWD), true);
test("Windows: case-insensitive match",            isNoopCd("cd c:/users/alice/proj",  WIN_CWD), true);
test("Windows: mixed separators → no-op",          isNoopCd("cd c:\\Users/alice\\proj", WIN_CWD, MSYS_PATHS), true);
test("MSYS: cd /c/Users/alice/proj → no-op",       isNoopCd("cd /c/Users/alice/proj", WIN_CWD, MSYS_PATHS), true);
test("Cygwin: cd /cygdrive/c/Users/alice/proj → no-op", isNoopCd("cd /cygdrive/c/Users/alice/proj", WIN_CWD, CYGWIN_PATHS), true);
test("MSYS: cd ~/proj → no-op",                    isNoopCd("cd ~/proj", WIN_CWD, MSYS_PATHS), true);
test("MSYS: cd /c/Users/alice/other → not no-op", isNoopCd("cd /c/Users/alice/other", WIN_CWD, MSYS_PATHS), false);
test("Windows: cd C:/Users/bob  → not no-op",     isNoopCd("cd C:/Users/bob",         WIN_CWD), false);

section("isPureVariableAssignment — pure forms");

test('SKILL_DIR="..." → pure',         isPureVariableAssignment('SKILL_DIR="/home/lucas/.pi/agent/git/github.com/ddoghq-sandbox/lucas-pimentel-coding-agent-tools/skills/gitlab-status"'), true);
test("SKILL_DIR=/home/x → pure",        isPureVariableAssignment("SKILL_DIR=/home/lucas/x"), true);
test("PID=130847101 → pure",            isPureVariableAssignment("PID=130847101"), true);
test("SKILL_DIR=$OTHER → pure",         isPureVariableAssignment("SKILL_DIR=$OTHER"), true);
test("SKILL_DIR= → pure (empty value)", isPureVariableAssignment("SKILL_DIR="), true);
test("A=1 B=2 → pure (multi)",          isPureVariableAssignment("A=1 B=2"), true);
test('export SKILL_DIR="..." → pure',   isPureVariableAssignment('export SKILL_DIR="/home/lucas/x"'), true);
test("readonly X=1 → pure",             isPureVariableAssignment("readonly X=1"), true);
test("declare -r X=1 → pure",           isPureVariableAssignment("declare -r X=1"), true);
test('X+=" appended" → pure (append)', isPureVariableAssignment('X+=" appended"'), true);
test('X="a ) b" → pure (literal ) in quotes)', isPureVariableAssignment('X="a ) b"'), true);
test('X="a;b" → pure (quoted ; is a literal)', isPureVariableAssignment('X="a;b"'), true);

section("isPureVariableAssignment — impure / rejected");

test("TOKEN=$(ddtool auth) → impure",   isPureVariableAssignment("TOKEN=$(ddtool auth gitlab token)"), false);
test("X=`pwd` → impure (backtick)",     isPureVariableAssignment("X=`pwd`"), false);
test("A=1 echo hi → impure (trailing cmd)", isPureVariableAssignment("A=1 echo hi"), false);
test("A=1 B=2 cmd → impure",            isPureVariableAssignment("A=1 B=2 cmd"), false);
test("X=$((1+2)) → impure (arith)",     isPureVariableAssignment("X=$((1+2))"), false);
test("X=1;reboot → impure (separator)",  isPureVariableAssignment("X=1;reboot"), false);
test("X=1&&reboot → impure (separator)", isPureVariableAssignment("X=1&&reboot"), false);
test("X=1|reboot → impure (separator)",  isPureVariableAssignment("X=1|reboot"), false);
test("X=1\nreboot → impure (newline)",   isPureVariableAssignment("X=1\nreboot"), false);
test("X=1&reboot → impure (background)", isPureVariableAssignment("X=1&reboot"), false);
test("A=1 > out → impure (redirect)",  isPureVariableAssignment("A=1 > out"), false);
test("echo hi → not an assignment",     isPureVariableAssignment("echo hi"), false);
test("cd . → not an assignment",        isPureVariableAssignment("cd ."), false);
test("empty string → false",            isPureVariableAssignment(""), false);
test("declare -p X → not an assignment", isPureVariableAssignment("declare -p X"), false);
test("bare export → not an assignment", isPureVariableAssignment("export"), false);

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

section("decide — bashAllowPureVarAssign auto-allow");

// Even with a very restrictive defaultAction: deny and no allow rules, pure
// assignments go through.
const pvaStrictCfg = makeCfg({ defaultAction: "deny", cwd: CWD });
test('SKILL_DIR="..." allowed with deny default', decide(pvaStrictCfg, "bash", { command: 'SKILL_DIR="/home/lucas/.pi/agent/git/github.com/ddoghq-sandbox/lucas-pimentel-coding-agent-tools/skills/gitlab-status"' }), "allow");
test("PID=130847101 allowed with deny default",   decide(pvaStrictCfg, "bash", { command: "PID=130847101" }), "allow");
test('export FOO="bar" allowed',                  decide(pvaStrictCfg, "bash", { command: 'export FOO="bar"' }), "allow");
test("A=1 B=2 allowed (multi)",                   decide(pvaStrictCfg, "bash", { command: "A=1 B=2" }), "allow");
test("TOKEN=$(evil) falls through to deny",       decide(pvaStrictCfg, "bash", { command: "TOKEN=$(evil)" }), "deny");
test("A=1 echo hi falls through to deny",         decide(pvaStrictCfg, "bash", { command: "A=1 echo hi" }), "deny");
test("X=$((1+2)) falls through to deny",          decide(pvaStrictCfg, "bash", { command: "X=$((1+2))" }), "deny");

section("decide — bashAllowPureVarAssign: false disables it");

const pvaOffCfg = makeCfg({ defaultAction: "deny", bashAllowPureVarAssign: false, cwd: CWD });
test('SKILL_DIR="..." denied when flag off', decide(pvaOffCfg, "bash", { command: 'SKILL_DIR="/home/x"' }), "deny");
test("PID=1 denied when flag off",          decide(pvaOffCfg, "bash", { command: "PID=1" }), "deny");

section("decide — explicit deny beats pure-assignment allow");

const pvaDenyCfg = makeCfg({ deny: ["Bash(SKILL_DIR=*)"], defaultAction: "allow", cwd: CWD });
test('Bash(SKILL_DIR=*) deny wins', decide(pvaDenyCfg, "bash", { command: 'SKILL_DIR="/home/x"' }), "deny");

section("decideCompound — pure-assignment subcommands");

const pvaCompCfg = makeCfg({ defaultAction: "deny", bashAllowPureVarAssign: true, cwd: CWD });
const twoAssign = decideCompound(pvaCompCfg, "bash", { command: 'SKILL_DIR="/home/x"\nPID=1' });
test("two pure assigns → allow",         twoAssign.action, "allow");
test("two pure assigns → isCompound true", twoAssign.isCompound, true);
test("two pure assigns → 2 parts",        twoAssign.breakdown.length, 2);
test("first assign part → allow",         twoAssign.breakdown[0].action, "allow");
test("second assign part → allow",        twoAssign.breakdown[1].action, "allow");

const mixedAssign = decideCompound(pvaCompCfg, "bash", { command: 'SKILL_DIR="/home/x"\nTOKEN=$(evil)' });
test("pure + impure assigns → deny",      mixedAssign.action, "deny");
test("pure part → allow",                 mixedAssign.breakdown[0].action, "allow");
test("impure part → deny (defaultAction)", mixedAssign.breakdown[1].action, "deny");

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

// Use WIN_CWD (C:/...) for WITH_PATHS tests and verify that Windows-native,
// MSYS, and Cygwin spellings all compare against the same canonical cwd.
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
test("cut -d, -f1 ./data.csv → true",       isReadOnlyBashSubcommand("cut -d, -f1 ./data.csv", WIN_CWD), true);
test("jq '.foo' ./in.json → true",          isReadOnlyBashSubcommand("jq '.foo' ./in.json", WIN_CWD), true);
test("nl ./file.txt → true",                isReadOnlyBashSubcommand("nl ./file.txt", WIN_CWD), true);
test("jq -n '1+1' → true (no file args)",   isReadOnlyBashSubcommand("jq -n '1+1'", WIN_CWD), true);
test("MSYS absolute path inside cwd → true",       isReadOnlyBashSubcommand("cat /c/Users/alice/proj/README.md", WIN_CWD, MSYS_PATHS), true);
test("Cygwin absolute path inside cwd → true",     isReadOnlyBashSubcommand("cat /cygdrive/c/Users/alice/proj/README.md", WIN_CWD, CYGWIN_PATHS), true);
test("MSYS tilde path inside cwd → true",          isReadOnlyBashSubcommand("cat ~/proj/README.md", WIN_CWD, MSYS_PATHS), true);
test("MSYS path with dot segments inside cwd → true", isReadOnlyBashSubcommand("cat /c/Users/alice/proj/src/../README.md", WIN_CWD, MSYS_PATHS), true);
test("MSYS path under drive-root cwd → true",         isReadOnlyBashSubcommand("cat /c/Windows/System32/drivers/etc/hosts", "C:/", MSYS_PATHS), true);

section("isReadOnlyBashSubcommand — rejected cases");

test("rm → not in safe lists",               isReadOnlyBashSubcommand("rm -rf .", WIN_CWD), false);
test("git → not in safe lists",              isReadOnlyBashSubcommand("git status", WIN_CWD), false);
test("curl → not in safe lists",             isReadOnlyBashSubcommand("curl http://x.com", WIN_CWD), false);
test("cat /etc/passwd → path outside cwd",   isReadOnlyBashSubcommand("cat /etc/passwd", WIN_CWD), false);
test("jq . /etc/passwd → path outside cwd", isReadOnlyBashSubcommand("jq . /etc/passwd", WIN_CWD), false);
test("nl /etc/passwd → path outside cwd",   isReadOnlyBashSubcommand("nl /etc/passwd", WIN_CWD), false);
test("ls .. → parent dir not inside cwd",    isReadOnlyBashSubcommand("ls ..", WIN_CWD), false);
test("ls C:/Windows → path outside cwd",     isReadOnlyBashSubcommand("ls C:/Windows", WIN_CWD), false);
test("MSYS path outside cwd → false",         isReadOnlyBashSubcommand("cat /c/Users/alice/other/secrets", WIN_CWD, MSYS_PATHS), false);
test("MSYS path on another drive → false",    isReadOnlyBashSubcommand("cat /d/secrets", WIN_CWD, MSYS_PATHS), false);
test("MSYS traversal outside cwd → false",    isReadOnlyBashSubcommand("cat /c/Users/alice/proj/../other/secrets", WIN_CWD, MSYS_PATHS), false);
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

section("formatBreakdown — rendering");

// actionIcon mapping
test("actionIcon(allow) → ✓",                actionIcon("allow"), "✓");
test("actionIcon(deny) → ✗",                 actionIcon("deny"),  "✗");
test("actionIcon(ask) → ?",                  actionIcon("ask"),   "?");

// formatBreakdownLine: non-current rows use a 3-space gutter
test("non-current allow line",              formatBreakdownLine("git status", "allow", false), "   [✓] git status");
test("non-current deny line",               formatBreakdownLine("rm -rf /",   "deny",  false), "   [✗] rm -rf /");
test("non-current ask line",                formatBreakdownLine("git commit", "ask",   false), "   [?] git commit");

// formatBreakdownLine: current rows use " » " gutter (same width)
test("current ask line has » marker",       formatBreakdownLine("git commit", "ask",   true),  " » [?] git commit");
test("current allow line has » marker",     formatBreakdownLine("git status", "allow", true),  " » [✓] git status");

// Column alignment: the `[` index must match between current and non-current rows
const currentLine = formatBreakdownLine("x", "ask", true);
const plainLine   = formatBreakdownLine("x", "ask", false);
test("icon column aligned across current/non-current", currentLine.indexOf("["), plainLine.indexOf("["));

// formatBreakdown: joins with newlines and marks exactly the current sub
const sampleBreakdown = [
	{ sub: "git status",  action: "allow" },
	{ sub: "git commit",  action: "ask"   },
	{ sub: "rm -rf /",    action: "deny"  },
];
const rendered = formatBreakdown(sampleBreakdown, "git commit");
const lines = rendered.split("\n");
test("formatBreakdown → 3 lines",            lines.length, 3);
test("first line is non-current allow",     lines[0], "   [✓] git status");
test("second line is current ask",          lines[1], " » [?] git commit");
test("third line is non-current deny",      lines[2], "   [✗] rm -rf /");
test("exactly one » marker in output",      (rendered.match(/» /g) || []).length, 1);

// formatBreakdown with null currentSub: no row is marked current
const renderedNoCurrent = formatBreakdown(sampleBreakdown, null);
test("null currentSub → no » markers",       (renderedNoCurrent.match(/» /g) || []).length, 0);
test("null currentSub → still 3 lines",      renderedNoCurrent.split("\n").length, 3);

// Edge case: empty breakdown
test("empty breakdown → empty string",       formatBreakdown([], null), "");

section("stripStructuralKeywords");

// Pure-structural keyword tokens — elided
test("'do' alone → null",                       stripStructuralKeywords("do"),   null);
test("'done' alone → null",                     stripStructuralKeywords("done"), null);
test("whitespace-only → null",                  stripStructuralKeywords("   "),  null);
test("empty string → null",                     stripStructuralKeywords(""),     null);

// `for` iteration heads — elided
test("'for x in a b c' → null",                 stripStructuralKeywords("for x in a b c"), null);
test("'for x in $(ls)' → null",                 stripStructuralKeywords("for x in $(ls)"), null);
test("'for x in *.txt' → null",                 stripStructuralKeywords("for x in *.txt"), null);
test("C-style 'for ((i=0;i<10;i++))' → null",   stripStructuralKeywords("for ((i=0;i<10;i++))"), null);
test("bare 'for x' (no `in`) → null",            stripStructuralKeywords("for x"), null);

// Leading `do` is stripped, residue is returned
test("'do echo $x' → 'echo $x'",                stripStructuralKeywords("do echo $x"), "echo $x");
test("'do rm -rf /tmp' → 'rm -rf /tmp'",        stripStructuralKeywords("do rm -rf /tmp"), "rm -rf /tmp");

// Nested loops: `do for y in b` is one split-part; strip `do ` then elide for-head
test("'do for y in b' → null (nested for-head)", stripStructuralKeywords("do for y in b"), null);

// Non-structural commands pass through unchanged
test("'echo hi' → 'echo hi' (no strip)",         stripStructuralKeywords("echo hi"), "echo hi");
test("'rm -rf /' → 'rm -rf /' (no strip)",      stripStructuralKeywords("rm -rf /"), "rm -rf /");

// `for_foo` is not the `for` keyword (no whitespace after)
test("'for_foo a' → unchanged",                 stripStructuralKeywords("for_foo a"), "for_foo a");

// Leading whitespace is trimmed before tests
test("'  do echo  ' → 'echo'",                  stripStructuralKeywords("  do echo  "), "echo");

// New pure-structural keywords: then, else, fi
test("'then' alone → null",                     stripStructuralKeywords("then"),  null);
test("'else' alone → null",                     stripStructuralKeywords("else"),  null);
test("'fi' alone → null",                       stripStructuralKeywords("fi"),    null);

// `select` iteration heads — same shape as `for`, no command runs
test("'select x in a b c' → null",              stripStructuralKeywords("select x in a b c"), null);
test("'select x in $(ls)' → null",              stripStructuralKeywords("select x in $(ls)"), null);
test("bare 'select x' (no in) → null",          stripStructuralKeywords("select x"),          null);

// Prefix-strip: while / until — the condition command is exposed
test("'while true' → 'true'",                   stripStructuralKeywords("while true"),            "true");
test("'while [[ -f x ]]' → '[[ -f x ]]'",       stripStructuralKeywords("while [[ -f x ]]"),      "[[ -f x ]]");
test("'until [[ -f x ]]' → '[[ -f x ]]'",       stripStructuralKeywords("until [[ -f x ]]"),      "[[ -f x ]]");
test("'until false' → 'false'",                 stripStructuralKeywords("until false"),           "false");

// Prefix-strip: if / elif — condition command exposed
test("'if grep foo bar' → 'grep foo bar'",       stripStructuralKeywords("if grep foo bar"),        "grep foo bar");
test("'if [[ -d /tmp ]]' → '[[ -d /tmp ]]'",    stripStructuralKeywords("if [[ -d /tmp ]]"),       "[[ -d /tmp ]]");
test("'elif test -f x' → 'test -f x'",          stripStructuralKeywords("elif test -f x"),         "test -f x");

// Prefix-strip: then / else followed by a command
test("'then echo found' → 'echo found'",         stripStructuralKeywords("then echo found"),        "echo found");
test("'else rm -rf /tmp/a' → 'rm -rf /tmp/a'",  stripStructuralKeywords("else rm -rf /tmp/a"),    "rm -rf /tmp/a");

// Nested prefix chains: `do while true` → strip do → strip while → `true`
test("'do while true' → 'true'",                stripStructuralKeywords("do while true"),          "true");
// `then if grep foo f` → strip then → strip if → `grep foo f`
test("'then if grep foo f' → 'grep foo f'",     stripStructuralKeywords("then if grep foo f"),     "grep foo f");

// Negative: no keyword match — word-boundary check
test("'while_foo a' → unchanged",               stripStructuralKeywords("while_foo a"),           "while_foo a");
test("'iffy a' → unchanged",                    stripStructuralKeywords("iffy a"),               "iffy a");
test("'selectable b' → unchanged",              stripStructuralKeywords("selectable b"),          "selectable b");
test("'fifo' → unchanged",                      stripStructuralKeywords("fifo"),                 "fifo");
test("'elseif a b' → unchanged",                stripStructuralKeywords("elseif a b"),            "elseif a b");

// Trailing harmless redirects on a structural keyword must not turn it into a
// command. Only /dev/null targets (and descriptor dups) are stripped; a
// file-target redirect is preserved so write-detection still fires.
test("'done 2>/dev/null' → null",               stripStructuralKeywords("done 2>/dev/null"),         null);
test("'fi 2>/dev/null' → null",                 stripStructuralKeywords("fi 2>/dev/null"),           null);
test("'done >/dev/null 2>&1' → null",           stripStructuralKeywords("done >/dev/null 2>&1"),   null);
test("'done 2>&1' → null (dup only)",           stripStructuralKeywords("done 2>&1"),               null);
test("'then 2>/dev/null' → null",               stripStructuralKeywords("then 2>/dev/null"),        null);
test("'else 2>/dev/null' → null",               stripStructuralKeywords("else 2>/dev/null"),        null);
test("'do 2>/dev/null' → null",                 stripStructuralKeywords("do 2>/dev/null"),          null);
test("'for x in a b c 2>/dev/null' → null",     stripStructuralKeywords("for x in a b c 2>/dev/null"), null);
// File-target redirect preserved: still prompts so write-detection runs.
test("'done > out.txt' → 'done > out.txt'",      stripStructuralKeywords("done > out.txt"),          "done > out.txt");
// Real command after a prefix keyword keeps its (harmless) redirect.
test("'do echo hi 2>/dev/null' → 'echo hi 2>/dev/null'", stripStructuralKeywords("do echo hi 2>/dev/null"), "echo hi 2>/dev/null");

section("decideCompound — control flow");

// Single-line for loop: only the body command enters the breakdown.
const forCfg = makeCfg({ allow: ["Bash(echo*)"], defaultAction: "deny" });
const forSingle = decideCompound(forCfg, "bash", { command: "for x in a b c; do echo $x; done" });
test("for x in ...; do echo $x; done → allow",  forSingle.action, "allow");
test("for-loop body only → isCompound false (1 command)", forSingle.isCompound, false);
test("for-loop body only → empty breakdown (single-row downgrade)", forSingle.breakdown.length, 0);

// Multiline form: same result — `do`/`done` on their own lines must also be elided.
const forMulti = decideCompound(forCfg, "bash", { command: "for x in a b c\ndo\necho $x\ndone" });
test("multiline for → allow",                   forMulti.action, "allow");
test("multiline for → isCompound false",        forMulti.isCompound, false);

// Two-command body — stays compound, only body commands appear.
const forTwoBody = decideCompound(forCfg, "bash", { command: "for x in a b; do echo $x; echo done-with-$x; done" });
test("two-command body → allow",                forTwoBody.action, "allow");
test("two-command body → isCompound true",      forTwoBody.isCompound, true);
test("two-command body → breakdown length 2",   forTwoBody.breakdown.length, 2);
test("two-command body → first sub is 'echo $x'", forTwoBody.breakdown[0].sub, "echo $x");
test("two-command body → second sub is 'echo done-with-$x'", forTwoBody.breakdown[1].sub, "echo done-with-$x");

// Nested for loops: only the innermost body command survives.
const forNested = decideCompound(forCfg, "bash", { command: "for x in a; do for y in b; do echo $x$y; done; done" });
test("nested for → allow",                      forNested.action, "allow");
test("nested for → isCompound false (1 command after strip)", forNested.isCompound, false);

// C-style for loop: `((i=0;i<10;i++))` head is elided (paren-depth keeps inner `;` intact).
const forCStyle = decideCompound(forCfg, "bash", { command: "for ((i=0;i<10;i++)); do echo $i; done" });
test("C-style for → allow",                      forCStyle.action, "allow");
test("C-style for → isCompound false",          forCStyle.isCompound, false);

// Loop terminator with a trailing `2>/dev/null` must be elided, not prompted.
// Regression for the real-world command: `for f in *.md; do ...; done 2>/dev/null`.
const forDoneRedirect = decideCompound(forCfg, "bash", { command: "for f in *.md; do echo $f; done 2>/dev/null" });
test("for ... done 2>/dev/null → allow",        forDoneRedirect.action, "allow");
test("for ... done 2>/dev/null → isCompound false", forDoneRedirect.isCompound, false);
test("for ... done 2>/dev/null → empty breakdown (single-row downgrade)", forDoneRedirect.breakdown.length, 0);

// Loop body with an `ask` action: final action is ask, single-command downgrade applies.
const forAskCfg = makeCfg({ defaultAction: "ask" });
const forAsk = decideCompound(forAskCfg, "bash", { command: "for f in *.txt; do git status; done" });
test("for-loop ask body → ask",                  forAsk.action, "ask");
test("for-loop ask body → isCompound false (1 cmd)", forAsk.isCompound, false);

// Loop body with a `deny` action: deny propagates; single-command downgrade applies.
const forDenyCfg = makeCfg({ deny: ["Bash(rm*)"], defaultAction: "allow" });
const forDeny = decideCompound(forDenyCfg, "bash", { command: "for f in *.txt; do rm $f; done" });
test("for-loop deny body → deny",                forDeny.action, "deny");
test("for-loop deny body → isCompound false",    forDeny.isCompound, false);

// Mixed body: one allow + one deny inside the same loop — deny still wins.
const forMixed = decideCompound(forDenyCfg, "bash", { command: "for f in *.txt; do echo $f; rm $f; done" });
test("mixed allow+deny body → deny",             forMixed.action, "deny");
test("mixed body → isCompound true",             forMixed.isCompound, true);
test("mixed body → breakdown length 2 (no for/do/done)", forMixed.breakdown.length, 2);

// Negative case: quoted `for ... do ... done` inside an echo is a single command — the
// splitter never sees the inner `;`/`\n` so stripStructuralKeywords never runs.
const quotedFor = decideCompound(forCfg, "bash", { command: 'echo "for x in a; do echo; done"' });
test("quoted for-loop → isCompound false (single, no split)", quotedFor.isCompound, false);
test("quoted for-loop → allow (matches Bash(echo*))",         quotedFor.action, "allow");

// Degenerate: empty body (`for x in a; do; done`) — nothing to evaluate, allow with empty breakdown.
const forEmpty = decideCompound(makeCfg({ defaultAction: "deny" }), "bash", { command: "for x in a; do; done" });
test("empty-body for → allow (no commands)",     forEmpty.action, "allow");
test("empty-body for → isCompound false",        forEmpty.isCompound, false);
test("empty-body for → empty breakdown",         forEmpty.breakdown.length, 0);

// ── while / until ──────────────────────────────────────────────────────────
const wuCfg = makeCfg({ allow: ["Bash(echo*)", "Bash(sleep*)", "Bash(true)"], defaultAction: "deny" });

// `while true; do sleep 1; done` — condition `true` is allowed, body `sleep 1` is allowed
const whileTrue = decideCompound(wuCfg, "bash", { command: "while true; do sleep 1; done" });
test("while true; do sleep 1 → allow",           whileTrue.action, "allow");
test("while true; do sleep 1 → isCompound true", whileTrue.isCompound, true);
test("while true; do sleep 1 → breakdown 2",     whileTrue.breakdown.length, 2);
test("while breakdown[0].sub = 'true'",          whileTrue.breakdown[0].sub, "true");
test("while breakdown[1].sub = 'sleep 1'",       whileTrue.breakdown[1].sub, "sleep 1");

// Multiline form
const whileMulti = decideCompound(wuCfg, "bash", { command: "while true\ndo\nsleep 1\ndone" });
test("multiline while → allow",                  whileMulti.action, "allow");
test("multiline while → isCompound true",        whileMulti.isCompound, true);
test("multiline while → breakdown 2",            whileMulti.breakdown.length, 2);

// `until` — same shape, different keyword.
// Use `until true` so the stripped condition `true` is in wuCfg's allow list.
const untilLoop = decideCompound(wuCfg, "bash", { command: "until true; do sleep 1; done" });
test("until true; do sleep 1 → allow",           untilLoop.action, "allow");
test("until → isCompound true",                  untilLoop.isCompound, true);
test("until → breakdown[0].sub = 'true'",        untilLoop.breakdown[0].sub, "true");
// Separate check: `until false` strips keyword — `false` is not in the allow list → deny
const untilFalse = decideCompound(wuCfg, "bash", { command: "until false; do sleep 1; done" });
test("until false → deny (false not allowed)",    untilFalse.action, "deny");

// Deny in while condition propagates
const whileDenyCfg = makeCfg({ deny: ["Bash(rm*)"], defaultAction: "allow" });
const whileDeny = decideCompound(whileDenyCfg, "bash", { command: "while rm /tmp/lock; do echo ok; done" });
test("deny in while condition → deny",           whileDeny.action, "deny");

// Deny in while body propagates
const whileBodyDeny = decideCompound(whileDenyCfg, "bash", { command: "while true; do rm -rf /; done" });
test("deny in while body → deny",                whileBodyDeny.action, "deny");

// Single body command after stripping → downgrade to non-compound
const wuSingle = decideCompound(wuCfg, "bash", { command: "while true; do sleep 1; done" });
// already tested above — also verify single-body while downgrades
const wuSingleBody = decideCompound(makeCfg({ allow: ["Bash(sleep*)"], defaultAction: "deny" }), "bash",
	{ command: "while true; do sleep 1; done" });
// `true` hits deny (not in allow list), so action is deny, isCompound false (2→compound, but deny wins)
test("while single body, condition denied → deny", wuSingleBody.action, "deny");

// ── if / elif / else / fi ─────────────────────────────────────────────────
const ifCfg = makeCfg({ allow: ["Bash(grep*)", "Bash(echo*)", "Bash(ls*)"], defaultAction: "deny" });

// Simple if-then-fi
const ifSimple = decideCompound(ifCfg, "bash", { command: "if grep foo file; then echo found; fi" });
test("if grep…then echo…fi → allow",             ifSimple.action, "allow");
test("if-then-fi → isCompound true",             ifSimple.isCompound, true);
test("if-then-fi → breakdown 2",                 ifSimple.breakdown.length, 2);
test("if breakdown[0].sub = 'grep foo file'",    ifSimple.breakdown[0].sub, "grep foo file");
test("if breakdown[1].sub = 'echo found'",       ifSimple.breakdown[1].sub, "echo found");

// if-then-elif-then-else-fi
const ifElif = decideCompound(ifCfg, "bash",
	{ command: "if grep a f; then echo a; elif grep b f; then echo b; else echo c; fi" });
test("if-elif-else-fi → allow",                  ifElif.action, "allow");
test("if-elif-else-fi → isCompound true",        ifElif.isCompound, true);
test("if-elif-else-fi → breakdown 5",            ifElif.breakdown.length, 5);
test("breakdown[0] = 'grep a f'",                ifElif.breakdown[0].sub, "grep a f");
test("breakdown[1] = 'echo a'",                  ifElif.breakdown[1].sub, "echo a");
test("breakdown[2] = 'grep b f'",                ifElif.breakdown[2].sub, "grep b f");
test("breakdown[3] = 'echo b'",                  ifElif.breakdown[3].sub, "echo b");
test("breakdown[4] = 'echo c'",                  ifElif.breakdown[4].sub, "echo c");

// Multiline if
const ifMulti = decideCompound(ifCfg, "bash", { command: "if grep foo file\nthen\necho found\nfi" });
test("multiline if → allow",                     ifMulti.action, "allow");
test("multiline if → isCompound true",           ifMulti.isCompound, true);
test("multiline if → breakdown 2",               ifMulti.breakdown.length, 2);

// Deny in if condition propagates
const ifDenyCfg = makeCfg({ deny: ["Bash(rm*)"], defaultAction: "allow" });
const ifCondDeny = decideCompound(ifDenyCfg, "bash", { command: "if rm /tmp/x; then echo ok; fi" });
test("deny in if condition → deny",              ifCondDeny.action, "deny");

// Deny in if body propagates
const ifBodyDeny = decideCompound(ifDenyCfg, "bash", { command: "if grep x f; then rm -rf /; fi" });
test("deny in if body → deny",                   ifBodyDeny.action, "deny");

// Single-command if: `if ls; then ls; fi` — grep-allow cfg has ls allowed; 2 subs
const ifLs = decideCompound(ifCfg, "bash", { command: "if ls; then ls; fi" });
test("if ls; then ls; fi → allow",               ifLs.action, "allow");
test("if ls; then ls; fi → isCompound true",     ifLs.isCompound, true);

// ── select ────────────────────────────────────────────────────────────────
const selCfg = makeCfg({ allow: ["Bash(echo*)"], defaultAction: "deny" });

// `select x in a b c; do echo $x; done` — head is structural, body is the only real command
const selectLoop = decideCompound(selCfg, "bash", { command: "select x in a b c; do echo $x; done" });
test("select x in …; do echo → allow",           selectLoop.action, "allow");
test("select → isCompound false (1 cmd)",        selectLoop.isCompound, false);
test("select → empty breakdown (downgrade)",     selectLoop.breakdown.length, 0);

// Multiline select
const selectMulti = decideCompound(selCfg, "bash", { command: "select x in a b\ndo\necho $x\ndone" });
test("multiline select → allow",                 selectMulti.action, "allow");
test("multiline select → isCompound false",      selectMulti.isCompound, false);

// Negative: quoted control-flow string is a single command — splitter never fires
const quotedWhile = decideCompound(ifCfg, "bash", { command: 'echo "while true; do sleep 1; done"' });
test("quoted while → isCompound false",          quotedWhile.isCompound, false);
test("quoted while → allow (matches echo*)",     quotedWhile.action, "allow");

// ── case ─────────────────────────────────────────────────────────────────
const caseCfg = makeCfg({ defaultAction: "ask" });
const caseAllowCfg = makeCfg({ allow: ["Bash(case*)"], defaultAction: "deny" });

// Whole case block treated as a single command — prompts once for the whole thing
const caseSimple = decideCompound(caseCfg, "bash", { command: "case $x in foo) echo a;; bar) echo b;; esac" });
test("case block → isCompound false",            caseSimple.isCompound, false);
test("case block → ambiguous false",             caseSimple.ambiguous, false);
test("case block → ask (defaultAction)",         caseSimple.action, "ask");
test("case block → empty breakdown",             caseSimple.breakdown.length, 0);

// Multiline case
const caseMulti = decideCompound(caseCfg, "bash",
	{ command: "case $x in\n  foo) echo a;;\n  bar) echo b;;\nesac" });
test("multiline case → isCompound false",        caseMulti.isCompound, false);
test("multiline case → ask",                     caseMulti.action, "ask");

// Explicit allow rule still applies
const caseAllow = decideCompound(caseAllowCfg, "bash", { command: "case $x in foo) echo a;; esac" });
test("case with Bash(case*) allow → allow",      caseAllow.action, "allow");
test("case with allow rule → isCompound false",  caseAllow.isCompound, false);

// Explicit deny rule still applies
const caseDenyCfg = makeCfg({ deny: ["Bash(case*)"], defaultAction: "allow" });
const caseDeny = decideCompound(caseDenyCfg, "bash", { command: "case $x in foo) cmd;; esac" });
test("case with Bash(case*) deny → deny",        caseDeny.action, "deny");

// case after another command: the whole command still treated as single (pre-check fires)
const casePreceded = decideCompound(caseCfg, "bash", { command: "echo start; case $x in foo) cmd;; esac" });
test("cmd; case → isCompound false (pre-check)", casePreceded.isCompound, false);
test("cmd; case → ask",                          casePreceded.action, "ask");

// ── Output redirection as a write-risk operation ──────────────────────────

section("hasTopLevelFileRedirect — file writes");

test("> file → true",                   hasTopLevelFileRedirect("echo foo > out.txt"), true);
test(">> file → true",                  hasTopLevelFileRedirect("echo foo >> out.txt"), true);
test("2> file → true",                  hasTopLevelFileRedirect("cmd 2> err.txt"), true);
test("2>> file → true",                 hasTopLevelFileRedirect("cmd 2>> err.txt"), true);
test("1> file → true",                  hasTopLevelFileRedirect("cmd 1> out.txt"), true);
test("&> file → true (both streams)",   hasTopLevelFileRedirect("cmd &> all.txt"), true);
test("&>> file → true (both append)",   hasTopLevelFileRedirect("cmd &>> all.txt"), true);
test("> file with leading space → true", hasTopLevelFileRedirect("rg x  >  out"), true);
test("> file no space → true",          hasTopLevelFileRedirect("rg x>out"), true);
test("process subst >(...) → true",      hasTopLevelFileRedirect("echo >(tee f)"), true);
test("redirect after heredoc → true",   hasTopLevelFileRedirect("cat <<EOF > out.txt\nbody\nEOF"), true);

section("hasTopLevelFileRedirect — descriptor dups (NOT file writes)");

test("2>&1 → false",                   hasTopLevelFileRedirect("echo foo 2>&1"), false);
test("1>&2 → false",                   hasTopLevelFileRedirect("echo foo 1>&2"), false);
test(">&1 → false",                    hasTopLevelFileRedirect("echo foo >&1"), false);
test(">&2 → false",                    hasTopLevelFileRedirect("echo foo >&2"), false);
test(">&- (close) → false",            hasTopLevelFileRedirect("cmd >&-"), false);
test(">&10 → false",                   hasTopLevelFileRedirect("cmd >&10"), false);
test(">>&1 (append dup) → false",       hasTopLevelFileRedirect("cmd >>&1"), false);
test("bare command → false",            hasTopLevelFileRedirect("echo foo"), false);
test("empty → false",                   hasTopLevelFileRedirect(""), false);

section("hasTopLevelFileRedirect — /dev/null sink (NOT a file write)");

test(">/dev/null → false",              hasTopLevelFileRedirect("cmd >/dev/null"), false);
test("> /dev/null → false",             hasTopLevelFileRedirect("cmd > /dev/null"), false);
test("2>/dev/null → false",             hasTopLevelFileRedirect("cmd 2>/dev/null"), false);
test("2>>/dev/null → false",            hasTopLevelFileRedirect("cmd 2>>/dev/null"), false);
test("1>/dev/null → false",             hasTopLevelFileRedirect("cmd 1>/dev/null"), false);
test(">>/dev/null → false",             hasTopLevelFileRedirect("cmd >>/dev/null"), false);
test("&>/dev/null → false",             hasTopLevelFileRedirect("cmd &>/dev/null"), false);
test("&>>/dev/null → false",            hasTopLevelFileRedirect("cmd &>>/dev/null"), false);
test("> \"/dev/null\" → false (dquote)",  hasTopLevelFileRedirect('cmd > "/dev/null"'), false);
test("> '/dev/null' → false (squote)",  hasTopLevelFileRedirect("cmd > '/dev/null'"), false);
test(">/dev/null 2>&1 → false",         hasTopLevelFileRedirect("cmd >/dev/null 2>&1"), false);
test(">/dev/null; echo → false",        hasTopLevelFileRedirect("cmd >/dev/null; echo hi"), false);
test(">/dev/null|cat → false",         hasTopLevelFileRedirect("cmd >/dev/null|cat"), false);
test(">/dev/null& → false",            hasTopLevelFileRedirect("cmd >/dev/null&"), false);
// A later real redirect still wins

section("hasTopLevelFileRedirect — /dev/null does not mask a real redirect");

test("2>/dev/null > realfile → true",   hasTopLevelFileRedirect("cmd 2>/dev/null > realfile"), true);
test("> realfile 2>/dev/null → true",   hasTopLevelFileRedirect("cmd > realfile 2>/dev/null"), true);
test(">/dev/null >realfile → true",    hasTopLevelFileRedirect("cmd >/dev/null >realfile"), true);
// Non-exact /dev/null forms stay write-risk
test(">/dev/nullx → true",              hasTopLevelFileRedirect("cmd >/dev/nullx"), true);
test("> /dev/null/x → true",            hasTopLevelFileRedirect("cmd > /dev/null/x"), true);
test("> /dev/null foo → false (foo is arg)", hasTopLevelFileRedirect("cmd > /dev/null foo"), false);
// Process substitution stays a write even if inner targets /dev/null
test(">(tee /dev/null) → true",        hasTopLevelFileRedirect("echo >(tee /dev/null)"), true);

section("hasTopLevelFileRedirect — quoting / escaping / nesting");

test("double-quoted > → false",         hasTopLevelFileRedirect('echo "a > b"'), false);
test("single-quoted > → false",         hasTopLevelFileRedirect("echo 'a > b'"), false);
test("backtick > → false",              hasTopLevelFileRedirect("echo `echo x > y`"), false);
test("escaped \\> → false",              hasTopLevelFileRedirect("echo a \\> b"), false);
test("> inside $(...) → false",         hasTopLevelFileRedirect('echo $(grep ">" f)'), false);
test("> inside (...) → false",          hasTopLevelFileRedirect("(echo a > b)"), false);
test("> inside heredoc body → false",   hasTopLevelFileRedirect("cat <<EOF\nx > y\nEOF"), false);
test("mixed 2>&1 > file → true",         hasTopLevelFileRedirect("echo hi 2>&1 > out.txt"), true);

section("isReadOnlyBashSubcommand — descriptor dup is read-only");

test("echo foo 2>&1 → true (dup, no file)",  isReadOnlyBashSubcommand("echo foo 2>&1", WIN_CWD), true);
test("echo foo 1>&2 → true",                 isReadOnlyBashSubcommand("echo foo 1>&2", WIN_CWD), true);
test("echo foo >&2 → true",                  isReadOnlyBashSubcommand("echo foo >&2", WIN_CWD), true);
test("echo foo >/dev/null → true (null sink)", isReadOnlyBashSubcommand("echo foo >/dev/null", WIN_CWD), true);
test("echo foo 2>/dev/null → true (null sink)",  isReadOnlyBashSubcommand("echo foo 2>/dev/null", WIN_CWD), true);
test("echo foo > out → false (file write)",  isReadOnlyBashSubcommand("echo foo > out", WIN_CWD), false);
test("cmd 2> err → false",                   isReadOnlyBashSubcommand("cmd 2> err", WIN_CWD), false);
test("cmd &> all → false",                  isReadOnlyBashSubcommand("cmd &> all", WIN_CWD), false);

section("decide — redirect-aware allow rules");

const rgBroadCfg = makeCfg({ allow: ["Bash(rg *)"], defaultAction: "ask", bashReadOnlyAllowCwd: true, cwd: WIN_CWD });
test("rg x → allow (broad rule)",                 decide(rgBroadCfg, "bash", { command: "rg x" }), "allow");
test("rg x > out.txt → ask (broad rule skipped)", decide(rgBroadCfg, "bash", { command: "rg x > out.txt" }), "ask");
test("rg x >> out.txt → ask",                     decide(rgBroadCfg, "bash", { command: "rg x >> out.txt" }), "ask");
test("rg x 2>&1 → allow (descriptor dup, broad ok)", decide(rgBroadCfg, "bash", { command: "rg x 2>&1" }), "allow");
test("rg x >/dev/null → allow (null sink, broad ok)", decide(rgBroadCfg, "bash", { command: "rg x >/dev/null" }), "allow");
test("rg x 2>/dev/null → allow (null sink, broad ok)", decide(rgBroadCfg, "bash", { command: "rg x 2>/dev/null" }), "allow");
test("rg x 2> err → ask",                         decide(rgBroadCfg, "bash", { command: "rg x 2> err" }), "ask");

const rgRedirectCfg = makeCfg({ allow: ["Bash(rg *)", "Bash(rg * > *)"], defaultAction: "ask", bashReadOnlyAllowCwd: true, cwd: WIN_CWD });
test("rg x > out.txt → allow (redirect-aware rule)", decide(rgRedirectCfg, "bash", { command: "rg x > out.txt" }), "allow");
test("rg x >> out.txt → ask (`>` pattern is literal, does not cover `>>`)", decide(rgRedirectCfg, "bash", { command: "rg x >> out.txt" }), "ask");
test("rg x → allow (broad rule still works)",        decide(rgRedirectCfg, "bash", { command: "rg x" }), "allow");

// A `>>`-aware rule covers the append form (separate from `>`).
const rgAppendCfg = makeCfg({ allow: ["Bash(rg *)", "Bash(rg * >> *)"], defaultAction: "ask", bashReadOnlyAllowCwd: true, cwd: WIN_CWD });
test("rg x >> out.txt → allow (>> rule)", decide(rgAppendCfg, "bash", { command: "rg x >> out.txt" }), "allow");
test("rg x > out.txt → ask (> not covered by >> rule)", decide(rgAppendCfg, "bash", { command: "rg x > out.txt" }), "ask");

// deny rules are redirect-agnostic: they always win over a redirected command
const denyRmCfg = makeCfg({ deny: ["Bash(rm -rf*)"], allow: ["Bash(rm -rf * > *)"], defaultAction: "ask" });
test("rm -rf x > out → deny (deny beats redirect-aware allow)", decide(denyRmCfg, "bash", { command: "rm -rf x > out" }), "deny");

// ask rules are redirect-agnostic: a broad ask rule forces ask even for redirects
const askRgCfg = makeCfg({ ask: ["Bash(rg *)"], allow: ["Bash(rg * > *)"], defaultAction: "allow" });
test("rg x > out → ask (broad ask rule beats redirect allow)", decide(askRgCfg, "bash", { command: "rg x > out" }), "ask");

// bare Bash rule (no pattern) is NOT redirect-aware — won't authorize a redirect
const bareBashCfg = makeCfg({ allow: ["Bash"], defaultAction: "ask" });
test("rg x → allow (bare Bash)",                 decide(bareBashCfg, "bash", { command: "rg x" }), "allow");
test("rg x > out → ask (bare Bash not redirect-aware)", decide(bareBashCfg, "bash", { command: "rg x > out" }), "ask");

// pwsh is out of scope — its redirects are NOT filtered (broad allow still works)
const pwshCfg = makeCfg({ allow: ["Pwsh(*)"], defaultAction: "ask" });
test("pwsh with > stays allow (out of scope)",   decide(pwshCfg, "pwsh", { command: "$x > out" }), "allow");

// toolDefaults / defaultAction are NOT gated by the redirect filter
const tdCfg = makeCfg({ toolDefaults: { bash: "allow" }, defaultAction: "ask" });
test("rg x > out → allow via toolDefaults (not gated)", decide(tdCfg, "bash", { command: "rg x > out" }), "allow");

section("rulePatternAllowsRedirect");

test("pattern with > → true",          rulePatternAllowsRedirect(parseRule("Bash(rg * > *)")), true);
test("pattern with >> → true",         rulePatternAllowsRedirect(parseRule("Bash(rg * >> *)")), true);
test("pattern without > → false",      rulePatternAllowsRedirect(parseRule("Bash(rg *)")), false);
test("bare rule (no pattern) → false", rulePatternAllowsRedirect(parseRule("Bash")), false);

section("decideCompound — redirect in one subcommand");

const compRedirectCfg = makeCfg({ allow: ["Bash(rg *)"], defaultAction: "ask", bashReadOnlyAllowCwd: true, cwd: WIN_CWD });
const rgRedirectComp = decideCompound(compRedirectCfg, "bash", { command: "rg x > out.txt && echo hi" });
test("rg > out && echo → isCompound true",  rgRedirectComp.isCompound, true);
test("rg > out && echo → action ask",       rgRedirectComp.action, "ask");
test("rg > out part → ask",                 rgRedirectComp.breakdown[0].action, "ask");
test("echo hi part → allow",                rgRedirectComp.breakdown[1].action, "allow");

const teeCompCfg = makeCfg({ allow: ["Bash(rg *)"], defaultAction: "ask", bashReadOnlyAllowCwd: true, cwd: WIN_CWD });
const teeComp = decideCompound(teeCompCfg, "bash", { command: "rg x | tee out.txt" });
test("rg | tee → isCompound true",  teeComp.isCompound, true);
test("rg part → allow (no redirect)", teeComp.breakdown[0].action, "allow");
test("tee part → ask (not on safe list)", teeComp.breakdown[1].action, "ask");

const bothRedirectCfg = makeCfg({ allow: ["Bash(echo *)"], defaultAction: "ask", bashReadOnlyAllowCwd: true, cwd: WIN_CWD });
const bothRedirect = decideCompound(bothRedirectCfg, "bash", { command: "echo a > x && echo b > y" });
test("echo>a && echo>b → isCompound true", bothRedirect.isCompound, true);
test("echo>a part → ask",                  bothRedirect.breakdown[0].action, "ask");
test("echo>b part → ask",                  bothRedirect.breakdown[1].action, "ask");

process.exit(summary() > 0 ? 1 : 0);
