// Unit tests for /guard migrate (policy/migrate.ts): every conversion, the
// dropped list, the runner list, changes counts, and second-run idempotence.
// Run: node tests/guard-migrate.test.mts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { userConfigPath, projectConfigPath, type GuardConfig } from "../extensions/guard/policy/config.ts";
import { computeMigration, looksLikeProjectCodeRunner } from "../extensions/guard/policy/migrate.ts";
import { addToConfigScope } from "../extensions/guard/policy/suggest.ts";

const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
	tempDirs.push(dir);
	return dir;
}

function writeLegacy(home: string, cwd: string, userCfg: unknown, projectCfg: unknown): void {
	fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
	fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
	if (userCfg !== undefined) fs.writeFileSync(path.join(home, ".pi", "agent", "pi-tool-permissions.json"), JSON.stringify(userCfg), "utf8");
	if (projectCfg !== undefined) fs.writeFileSync(path.join(cwd, ".pi", "pi-tool-permissions.local.json"), JSON.stringify(projectCfg), "utf8");
}

const tests: { name: string; fn: () => void | Promise<void> }[] = [];
function test(name: string, fn: () => void | Promise<void>) {
	tests.push({ name, fn });
}

test("looksLikeProjectCodeRunner flags project-code runners only", () => {
	assert.equal(looksLikeProjectCodeRunner("HostBash(cargo build --release)"), true);
	assert.equal(looksLikeProjectCodeRunner("HostBash(dotnet test *)"), true);
	assert.equal(looksLikeProjectCodeRunner("HostBash(pytest -q)"), true);
	assert.equal(looksLikeProjectCodeRunner("HostBash(npm install)"), true);
	assert.equal(looksLikeProjectCodeRunner("HostBash(npm test *)"), false, "npm test is not in the suspect list; npm run/install are");
	assert.equal(looksLikeProjectCodeRunner("HostBash(git push *)"), false);
});

test("migrate converts every legacy key with a guard home", () => {
	const home = makeTempDir("guard-mig-home-");
	const cwd = makeTempDir("guard-mig-cwd-");
	writeLegacy(
		home,
		cwd,
		{
			allow: [
				"Bash(git status*)",
				"Bash(cargo build *)",
				"WebFetch(https://github.com/*)",
				"WebFetch(/docs\\.datadoghq\\.com/)",
				"mcp__atlassian__discover",
				"Mcp(slack_*)",
				"Glob",
				"Grep",
			],
			deny: ["Bash(rm -rf*)", "Write(.env*)", "WebFetch(evil.com)"],
			ask: ["Bash(git push*)", "WebFetch(*)", "Mcp(atlassian_*)"],
			bashValidators: { duckdb: "readonly-duckdb" },
			readAllowPaths: ["~/source", "/tmp/logs"],
			writeAllowPaths: ["/tmp/scratch"],
			nonInteractiveAsk: "allow",
			defaultAction: "ask",
			toolDefaults: { write: "ask" },
			readAllowCwd: true,
			bashReadOnlyAllowCwd: true,
			autoMode: {
				classifier: { provider: "anthropic", model: "claude-haiku-4-5" },
				environment: ["Trusted repo: github.com/lucaspimentel/*"],
				allow: ["Running tests and linters"],
				soft_deny: ["Force pushing"],
				hard_deny: ["Exfiltration"],
				classifyAllShell: true,
			},
		},
		{
			allow: ["Bash(dotnet build *)", "Read"],
			deny: ["Bash(sudo*)"],
			bashAllowRedirectsTo: ["/tmp"],
		},
	);
	const report = computeMigration(home, cwd);

	// User scope conversions.
	const u = report.user;
	assert.equal(u.sourceFound, true);
	assert.ok(u.sourcePath.endsWith(path.join(".pi", "agent", "pi-tool-permissions.json")));
	assert.deepEqual(u.patch.hostBash?.allow, ["HostBash(git status*)", "HostBash(cargo build *)"]);
	assert.deepEqual(u.patch.hostBash?.deny, ["HostBash(rm -rf*)"]);
	assert.deepEqual(u.patch.hostBash?.ask, ["HostBash(git push*)"]);
	assert.deepEqual(u.patch.webFetchAllow, ["https://github.com/*", "/docs\\.datadoghq\\.com/"], "URL globs and /regex/ carry verbatim");
	assert.deepEqual(u.patch.readRoots, ["~/source", "/tmp/logs"]);
	assert.deepEqual(u.patch.writeRoots, ["/tmp/scratch"]);
	assert.deepEqual(u.patch.bashValidators, { duckdb: "readonly-duckdb" });
	assert.deepEqual(u.patch.classifier, { provider: "anthropic", model: "claude-haiku-4-5" });
	assert.deepEqual(u.patch.classifierEnvironment, ["Trusted repo: github.com/lucaspimentel/*"]);
	assert.deepEqual(u.patch.classifierAllow, ["Running tests and linters"]);
	assert.deepEqual(u.patch.classifierSoftDeny, ["Force pushing"]);
	assert.deepEqual(u.patch.classifierHardDeny, ["Exfiltration"]);
	assert.equal(u.patch.toolClasses?.["mcp__atlassian__discover"], "remote-read", "bare mcp__ names become toolClasses reads");
	assert.equal(u.patch.toolClasses?.["slack_*"], "remote-read", "Mcp(...) patterns become toolClasses reads");

	// Project scope conversions, including the bashAllowRedirectsTo alias.
	const p = report.project;
	assert.equal(p.sourceFound, true);
	assert.deepEqual(p.patch.hostBash?.allow, ["HostBash(dotnet build *)"]);
	assert.deepEqual(p.patch.hostBash?.deny, ["HostBash(sudo*)"]);
	assert.deepEqual(p.patch.writeRoots, ["/tmp"], "bashAllowRedirectsTo becomes writeRoots when writeAllowPaths is absent");

	// Dropped lists.
	const userDropped = u.dropped.join("\n");
	assert.match(userDropped, /nonInteractiveAsk/);
	assert.match(userDropped, /defaultAction/);
	assert.match(userDropped, /toolDefaults/);
	assert.match(userDropped, /readAllowCwd/);
	assert.match(userDropped, /bashReadOnlyAllowCwd/);
	assert.match(userDropped, /classifyAllShell/);
	assert.match(userDropped, /'Glob'/);
	assert.match(userDropped, /'Grep'/);
	assert.match(userDropped, /Write\(\.env\*\)/);
	assert.match(userDropped, /WebFetch\(evil\.com\)/, "WebFetch deny/ask rules are dropped with a note");
	assert.match(userDropped, /WebFetch\(\*\)/);
	assert.match(userDropped, /Mcp\(atlassian_\*\)/, "MCP deny/ask rules are dropped");
	const projectDropped = p.dropped.join("\n");
	assert.match(projectDropped, /'Read'/);

	// Suspected runners are copied but listed.
	assert.ok(u.suspectedRunners.includes("HostBash(cargo build *)"));
	assert.ok(p.suspectedRunners.includes("HostBash(dotnet build *)"));
	assert.ok(!u.suspectedRunners.includes("HostBash(git status*)"));

	// Summary is human-readable and mentions both scopes and the purge advice.
	assert.match(report.summary, /user:/);
	assert.match(report.summary, /project:/);
	assert.match(report.summary, /purge manually/);

	// changes counts against the (empty) existing guard.json files.
	assert.ok(u.changes > 0);
	assert.ok(p.changes > 0);
});

test("WebFetch allow rules land in webFetchAllow; MCP allow rules in toolClasses (no cross-contamination)", () => {
	const home = makeTempDir("guard-mig-web-home-");
	const cwd = makeTempDir("guard-mig-web-cwd-");
	writeLegacy(home, cwd, { allow: ["WebFetch(https://docs.*)", "Mcp(github_*)"] }, undefined);
	const report = computeMigration(home, cwd);
	assert.deepEqual(report.user.patch.webFetchAllow, ["https://docs.*"]);
	assert.deepEqual(report.user.patch.hostBash, undefined, "no Bash rules: no hostBash patch");
	assert.equal(report.user.patch.toolClasses?.["github_*"], "remote-read");
});

test("migrate is idempotent: a second run changes nothing and the files are identical", () => {
	const home = makeTempDir("guard-mig-idem-home-");
	const cwd = makeTempDir("guard-mig-idem-cwd-");
	writeLegacy(
		home,
		cwd,
		{
			allow: ["Bash(git status*)", "Bash(cargo build *)", "WebFetch(https://github.com/*)", "mcp__atlassian__discover"],
			ask: ["Bash(git push*)"],
			readAllowPaths: ["/tmp/docs"],
			autoMode: { allow: ["Running tests"] },
		},
		{ allow: ["Bash(dotnet build *)"] },
	);
	const first = computeMigration(home, cwd);
	assert.ok(first.user.changes > 0);
	assert.ok(first.project.changes > 0);

	// Write like the command does: union with dedupe, never removes.
	let written = 0;
	for (const scope of ["user", "project"] as const) {
		const r = addToConfigScope(scope, first[scope].patch, { home, cwd });
		written += r.added;
	}
	assert.ok(written > 0);
	const userAfterFirst = fs.readFileSync(userConfigPath(home), "utf8");
	const projectAfterFirst = fs.readFileSync(projectConfigPath(cwd), "utf8");

	const second = computeMigration(home, cwd);
	assert.equal(second.user.changes, 0, "second run: zero changes for the user scope");
	assert.equal(second.project.changes, 0, "second run: zero changes for the project scope");
	const secondWrite = (() => {
		let n = 0;
		for (const scope of ["user", "project"] as const) {
			n += addToConfigScope(scope, second[scope].patch, { home, cwd }).added;
		}
		return n;
	})();
	assert.equal(secondWrite, 0, "re-writing the same patch adds nothing");
	assert.equal(fs.readFileSync(userConfigPath(home), "utf8"), userAfterFirst, "user guard.json is byte-identical");
	assert.equal(fs.readFileSync(projectConfigPath(cwd), "utf8"), projectAfterFirst, "project guard.local.json is byte-identical");
});

test("migrate unions into existing guard.json entries without removing them", () => {
	const home = makeTempDir("guard-mig-union-home-");
	const cwd = makeTempDir("guard-mig-union-cwd-");
	writeLegacy(home, cwd, { allow: ["Bash(git status*)"] }, undefined);
	fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
	const existing: GuardConfig = {
		hostBash: { deny: ["HostBash(rm -rf*)"], allow: ["HostBash(ls *)"] },
		webFetchAllow: ["https://keep.example.com/*"],
	};
	fs.writeFileSync(userConfigPath(home), JSON.stringify(existing), "utf8");
	const report = computeMigration(home, cwd);
	assert.deepEqual(report.user.patch.hostBash?.allow, ["HostBash(git status*)"]);
	assert.equal(report.user.changes, 1, "only the new allow rule would be added");
	addToConfigScope("user", report.user.patch, { home, cwd });
	const merged = JSON.parse(fs.readFileSync(userConfigPath(home), "utf8")) as GuardConfig;
	assert.deepEqual(merged.hostBash?.deny, ["HostBash(rm -rf*)"], "existing deny survives");
	assert.deepEqual(merged.hostBash?.allow, ["HostBash(ls *)", "HostBash(git status*)"]);
	assert.deepEqual(merged.webFetchAllow, ["https://keep.example.com/*"]);
});

test("migrate with no legacy configs finds nothing and patches nothing", () => {
	const home = makeTempDir("guard-mig-empty-home-");
	const cwd = makeTempDir("guard-mig-empty-cwd-");
	const report = computeMigration(home, cwd);
	assert.equal(report.user.sourceFound, false);
	assert.equal(report.project.sourceFound, false);
	assert.deepEqual(report.user.patch, {});
	assert.deepEqual(report.project.patch, {});
	assert.equal(report.user.changes, 0);
	assert.equal(report.project.changes, 0);
	assert.match(report.summary, /no legacy pi-tool-permissions config found/);
});

// ── Runner ────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
for (const t of tests) {
	try {
		const r = t.fn();
		if (r instanceof Promise) await r;
		passed++;
		console.log(`  ok ${t.name}`);
	} catch (err) {
		failed++;
		console.error(`  FAIL ${t.name}:`, err);
	}
}
console.log(`\n${passed} passed, ${failed} failed`);
for (const dir of tempDirs) {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		// Best-effort cleanup.
	}
}
if (failed > 0) process.exit(1);
process.exit(0);
