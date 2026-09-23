// run: node test-validators.mjs
//
// Tests for the per-command bash validator mechanism (bashValidators):
// readonly-duckdb and readonly-mlr, their pipeline placement (after explicit
// ask rules), redirect interplay, auto-mode gating, and compound behavior.

import {
	makeTestRunner, makeCfg, decide, decideWithReason, decideCompound,
	validatorApprovedBashReason, BASH_VALIDATORS, loadConfigFromObjects,
} from "./test-helpers.mjs";

const { test, section, summary } = makeTestRunner();

const CWD = "/tmp/proj";

const validatorCfg = (extra = {}) => makeCfg({
	defaultAction: "ask",
	bashValidators: { duckdb: "readonly-duckdb", mlr: "readonly-mlr" },
	cwd: CWD,
	...extra,
});

const AUTO_MODE_ON = { classifier: undefined, environment: [], allow: [], soft_deny: [], hard_deny: [], classifyAllShell: true };
const AUTO_MODE_OFF = { classifier: undefined, environment: [], allow: [], soft_deny: [], hard_deny: [], classifyAllShell: false };

section("BASH_VALIDATORS registry");

test("readonly-duckdb is registered",   typeof BASH_VALIDATORS["readonly-duckdb"], "function");
test("readonly-mlr is registered",      typeof BASH_VALIDATORS["readonly-mlr"], "function");

section("validatorApprovedBashReason — direct");

test("duckdb SELECT with cwd file returns reason",    validatorApprovedBashReason("duckdb -c \"SELECT * FROM 'data.csv'\"", CWD, { duckdb: "readonly-duckdb" }), "validated read-only duckdb (bashValidators.readonly-duckdb)");
test("COPY statement returns null",                   validatorApprovedBashReason("duckdb -c \"COPY t TO '/tmp/x'\"", CWD, { duckdb: "readonly-duckdb" }), null);
test("unmapped command returns null",                 validatorApprovedBashReason("duckdb -c \"SELECT 1\"", CWD, {}), null);
test("unknown validator name returns null",           validatorApprovedBashReason("duckdb -c \"SELECT 1\"", CWD, { duckdb: "readonly-nonsense" }), null);
test("empty command returns null",                    validatorApprovedBashReason("", CWD, { duckdb: "readonly-duckdb" }), null);
test("case-insensitive command lookup",               validatorApprovedBashReason("DuckDB -c \"SELECT 1\"", CWD, { duckdb: "readonly-duckdb" }), "validated read-only duckdb (bashValidators.readonly-duckdb)");

section("validators — allow cases");

test("duckdb aggregate over cwd csv",           decide(validatorCfg(), "Bash", { command: "duckdb -c \"SELECT user, sum(bytes) FROM 'data.csv' GROUP BY user\"" }), "allow");
test("duckdb CTE + window function",            decide(validatorCfg(), "Bash", { command: "duckdb -c \"WITH t AS (SELECT * FROM 'data.csv') SELECT user, rank() OVER (ORDER BY sum(bytes) DESC) FROM t GROUP BY user\"" }), "allow");
test("duckdb --csv flag",                       decide(validatorCfg(), "Bash", { command: "duckdb --csv -c \"SELECT 1\"" }), "allow");
test("duckdb read_csv_auto",                    decide(validatorCfg(), "Bash", { command: "duckdb -c \"SELECT * FROM read_csv_auto('data.csv', header=true)\"" }), "allow");
test("duckdb subdirectory file",                decide(validatorCfg(), "Bash", { command: "duckdb -c \"SELECT * FROM 'data/nested.csv'\"" }), "allow");
test("duckdb -f field list on stats1 is fine",  decide(validatorCfg(), "Bash", { command: "mlr stats1 -a sum -f bytes data.csv" }), "allow");
test("mlr stats1",                              decide(validatorCfg(), "Bash", { command: "mlr --icsv --ojson stats1 -a sum -f bytes -g user data.csv" }), "allow");
test("mlr cut",                                 decide(validatorCfg(), "Bash", { command: "mlr cut -f x,y data.csv" }), "allow");
test("mlr put with inline DSL",                 decide(validatorCfg(), "Bash", { command: "mlr put '$x > 3' data.csv" }), "allow");
test("mlr nested path inside cwd",              decide(validatorCfg(), "Bash", { command: "mlr cat data/sub/file.csv" }), "allow");

section("validators — decline cases fall through to ask (not deny)");

test("duckdb COPY",                             decide(validatorCfg(), "Bash", { command: "duckdb -c \"COPY t TO 'out.csv'\"" }), "ask");
test("duckdb ATTACH",                           decide(validatorCfg(), "Bash", { command: "duckdb -c \"ATTACH 'other.db'\"" }), "ask");
test("duckdb INSTALL",                          decide(validatorCfg(), "Bash", { command: "duckdb -c \"INSTALL json\"" }), "ask");
test("duckdb LOAD",                             decide(validatorCfg(), "Bash", { command: "duckdb -c \"LOAD icebreaker\"" }), "ask");
test("duckdb dot-command .output",              decide(validatorCfg(), "Bash", { command: "duckdb -c \".output /tmp/x\"" }), "ask");
test("duckdb -f script file",                   decide(validatorCfg(), "Bash", { command: "duckdb -f script.sql" }), "ask");
test("duckdb positional db file",               decide(validatorCfg(), "Bash", { command: "duckdb mydb.duckdb -c \"SELECT 1\"" }), "ask");
test("duckdb absolute path outside cwd",        decide(validatorCfg(), "Bash", { command: "duckdb -c \"SELECT * FROM '/home/x/f.csv'\"" }), "ask");
test("duckdb URL input",                        decide(validatorCfg(), "Bash", { command: "duckdb -c \"SELECT * FROM 'https://example.com/f.csv'\"" }), "ask");
test("duckdb unknown flag",                     decide(validatorCfg(), "Bash", { command: "duckdb --frobnicate -c \"SELECT 1\"" }), "ask");
test("duckdb without -c (no SQL)",              decide(validatorCfg(), "Bash", { command: "duckdb --version" }), "ask");
test("mlr put -f script",                       decide(validatorCfg(), "Bash", { command: "mlr put -f script.mlr data.csv" }), "ask");
test("mlr filter -f script",                    decide(validatorCfg(), "Bash", { command: "mlr filter -f script.mlr data.csv" }), "ask");
test("mlr tee write in DSL",                    decide(validatorCfg(), "Bash", { command: "mlr put 'tee > \"out.tsv\", $*' data.csv" }), "ask");
test("mlr --from outside cwd",                  decide(validatorCfg(), "Bash", { command: "mlr --from /etc/passwd cat" }), "ask");
test("mlr input file outside cwd",              decide(validatorCfg(), "Bash", { command: "mlr cat /etc/passwd" }), "ask");
test("declined validator falls to defaultAction reason", decideWithReason(validatorCfg(), "Bash", { command: "duckdb -c \"COPY t TO 'out.csv'\"" }, "manual").reason, "no matching rule; defaultAction = ask");

section("validators: read roots (readAllowPaths)");

const withTmpRoot = validatorCfg({ readRoots: ["/tmp"] });
test("mlr --from /tmp/x declines without roots",        decide(validatorCfg(), "Bash", { command: "mlr --from /tmp/x cut -f x" }), "ask");
test("mlr --from /tmp/x allows with /tmp root",         decide(withTmpRoot, "Bash", { command: "mlr --from /tmp/x cut -f x" }), "allow");
test("mlr input file /tmp/x allows with /tmp root",     decide(withTmpRoot, "Bash", { command: "mlr cut -f x /tmp/x.csv" }), "allow");
test("duckdb FROM /tmp/x.csv declines without roots",   decide(validatorCfg(), "Bash", { command: "duckdb -c \"SELECT * FROM '/tmp/x.csv'\"" }), "ask");
test("duckdb FROM /tmp/x.csv allows with /tmp root",    decide(withTmpRoot, "Bash", { command: "duckdb -c \"SELECT * FROM '/tmp/x.csv'\"" }), "allow");
test("/tmpfoo does not match /tmp root",                decide(withTmpRoot, "Bash", { command: "mlr cat /tmpfoo" }), "ask");
test("dot-segment escape does not match /tmp root",     decide(withTmpRoot, "Bash", { command: "mlr --from /tmp/../etc/passwd cat" }), "ask");
test("URL still declines with /tmp root",               decide(withTmpRoot, "Bash", { command: "duckdb -c \"SELECT * FROM 'https://example.com/f.csv'\"" }), "ask");
test("direct validatorApprovedBashReason with read root", validatorApprovedBashReason("mlr --from /tmp/x cut -f x", CWD, { mlr: "readonly-mlr" }, [], ["/tmp"]), "validated read-only mlr (bashValidators.readonly-mlr)");
test("direct validatorApprovedBashReason without roots",  validatorApprovedBashReason("mlr --from /tmp/x cut -f x", CWD, { mlr: "readonly-mlr" }, []), null);

section("validators — disabled / not configured");

// A bare config with no bashValidators key must still get the built-in
// defaults (duckdb/mlr readonly validators) via the merge in rules.ts.
const bareCfg = loadConfigFromObjects({}, {}, CWD);
test("no bashValidators key → default duckdb allow", decide(bareCfg, "Bash", { command: "duckdb -c \"SELECT * FROM 'data.csv'\"" }), "allow");
test("no bashValidators key → default mlr allow",   decide(bareCfg, "Bash", { command: "mlr cut -f x data.csv" }), "allow");
test("none sentinel → duckdb falls through to ask", decide(loadConfigFromObjects({ bashValidators: { duckdb: "none" } }, {}, CWD), "Bash", { command: "duckdb -c \"SELECT * FROM 'data.csv'\"" }), "ask");

const emptyDefaultCfg = makeCfg({ defaultAction: "ask", cwd: CWD, bashValidators: {} });
test("no validators configured → ask",          decide(emptyDefaultCfg, "Bash", { command: "duckdb -c \"SELECT 1\"" }), "ask");
test("empty validators map → ask",              decide(validatorCfg({ bashValidators: {} }), "Bash", { command: "mlr cat data.csv" }), "ask");

section("validators — redirect interplay");

const redirectCfg = validatorCfg({ bashAllowRedirectsTo: ["/allowed"] });
test("allowed redirect target validates",       decide(redirectCfg, "Bash", { command: "duckdb -c \"SELECT 1\" > /allowed/out" }), "allow");
test("unallowed redirect falls through",        decide(redirectCfg, "Bash", { command: "duckdb -c \"SELECT 1\" > out.txt" }), "ask");
test("append redirect to allowed target",       decide(redirectCfg, "Bash", { command: "duckdb -c \"SELECT 1\" >> /allowed/out" }), "allow");
test("stderr dup redirect stays valid",         decide(redirectCfg, "Bash", { command: "duckdb -c \"SELECT 1\" 2>/dev/null" }), "allow");

section("validators — precedence");

test("deny rule beats validator",               decide(validatorCfg({ deny: ["Bash(duckdb *)"] }), "Bash", { command: "duckdb -c \"SELECT 1\"" }), "deny");
test("ask rule beats validator",                decide(validatorCfg({ ask: ["Bash(duckdb *)"] }), "Bash", { command: "duckdb -c \"SELECT 1\"" }), "ask");
test("allow rule still works alongside",        decide(validatorCfg({ allow: ["Bash(duckdb *)"], defaultAction: "ask" }), "Bash", { command: "duckdb -c \"SELECT 1\"" }), "allow");

section("validators — implicit tiers below ask rules (reorder guard)");

test("ask rule beats read-only tier (cat)",     decide(makeCfg({ ask: ["Bash(cat *)"], bashReadOnlyAllowCwd: true, defaultAction: "ask" }), "Bash", { command: "cat foo" }), "ask");
test("read-only tier still allows without ask rule", decide(makeCfg({ bashReadOnlyAllowCwd: true, defaultAction: "ask", cwd: CWD }), "Bash", { command: "cat foo" }), "allow");
test("ask rule beats pure var assign tier",     decide(makeCfg({ ask: ["Bash(FOO=*)"], bashAllowPureVarAssign: true, defaultAction: "allow" }), "Bash", { command: "FOO=1" }), "ask");
test("ask rule beats noop cd tier",             decide(makeCfg({ ask: ["Bash(cd*)"], allowNoopCd: true, defaultAction: "allow", cwd: CWD }), "Bash", { command: "cd ." }), "ask");

section("validators — auto mode gating");

test("auto + classifyAllShell → auto sentinel", decideWithReason(validatorCfg({ autoMode: AUTO_MODE_ON }), "Bash", { command: "duckdb -c \"SELECT 1\"" }, "auto").action, "auto");
test("auto without classifyAllShell → allow",   decideWithReason(validatorCfg({ autoMode: AUTO_MODE_OFF }), "Bash", { command: "duckdb -c \"SELECT 1\"" }, "auto").action, "allow");
test("auto + classifyAllShell: mlr also gated", decide(validatorCfg({ autoMode: AUTO_MODE_ON }), "Bash", { command: "mlr cat data.csv" }, "auto"), "auto");

section("validators — compounds");

const compoundCfg = validatorCfg({ bashReadOnlyAllowCwd: true });
test("compound: ls && validated duckdb",        decideCompound(compoundCfg, "bash", { command: "ls && duckdb -c \"SELECT 1\"" }).action, "allow");
test("compound: ls && declined duckdb",         decideCompound(compoundCfg, "bash", { command: "ls && duckdb -c \"COPY t TO 'x'\"" }).action, "ask");
test("compound: pipe into validated mlr",       decideCompound(compoundCfg, "bash", { command: "cat data.csv | mlr cat" }).action, "allow");
test("compound: mlr decline in pipe",           decideCompound(compoundCfg, "bash", { command: "cat x | mlr cat /etc/passwd" }).action, "ask");

summary() && process.exit(1);
