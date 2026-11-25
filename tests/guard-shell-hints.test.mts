// Unit tests for guard's unmounted-path failure hints: the bwrap mount-table
// parser (mountTable), the visibility check (isPathVisible), the advisory
// path-argument detector (unmountedPathCandidates), the sandboxed bash hint
// composition (sandboxFailureHint), and the tool-description boundary
// statements. Advisory only by design: no code path blocks execution or
// opens a dialog from a path token.
//
// Run: node --test tests/guard-shell-hints.test.mts
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { isPathVisible, mountTable, type MountEntry } from "../extensions/guard/sandbox/bwrap.ts";
import { SHELL_SANDBOX_FAILURE_HINT, bashToolDescription, hostBashToolDescription, readToolRoutingClause, sandboxBoundaryText, sandboxFailureHint as sandboxFailureHintPolicy, unmountedPathCandidates as unmountedPathCandidatesPolicy, workerToolDescription } from "../extensions/guard/tools/shell.ts";
import { analyzeSync } from "./shellast-sync.mts";

// Synchronous test façade: the production path analyses the command once and
// passes the result; these tests still speak in command strings.
function unmountedPathCandidates(cmd: string, mountedPaths: Parameters<typeof unmountedPathCandidatesPolicy>[1], home?: string): string[] {
	return unmountedPathCandidatesPolicy(analyzeSync(cmd), mountedPaths, home);
}
function sandboxFailureHint(cmd: string, mountedPaths?: Parameters<typeof sandboxFailureHintPolicy>[1], _home?: string): string {
	return sandboxFailureHintPolicy(analyzeSync(cmd), mountedPaths);
}

const HOME = os.homedir();

// ── mountTable ───────────────────────────────────────────────────────────────

test("mountTable captures bind, ro-bind, and dev-bind destinations", () => {
	const mounts = mountTable(["--ro-bind", "/usr", "/usr", "--bind", "/ws", "/ws", "--dev-bind", "/dev/null", "/ws/secret"]);
	assert.deepEqual(mounts, [
		{ dest: "/usr", kind: "bind" },
		{ dest: "/ws", kind: "bind" },
		{ dest: "/ws/secret", kind: "bind" },
	]);
});

test("mountTable includes ro-bind-try only when the source exists", () => {
	const mounts = mountTable(["--ro-bind-try", "/usr", "/usr", "--ro-bind-try", "/no/such/path", "/gone"]);
	assert.deepEqual(mounts, [{ dest: "/usr", kind: "bind" }]);
});

test("mountTable maps tmpfs, symlink, proc, and dev kinds", () => {
	const mounts = mountTable(["--proc", "/proc", "--dev", "/dev", "--tmpfs", "/home/lucas", "--symlink", "usr/bin", "/bin"]);
	assert.deepEqual(mounts, [
		{ dest: "/proc", kind: "special" },
		{ dest: "/dev", kind: "special" },
		{ dest: "/home/lucas", kind: "tmpfs" },
		{ dest: "/bin", kind: "symlink" },
	]);
});

test("mountTable ignores everything after the -- separator", () => {
	const mounts = mountTable(["--ro-bind", "/usr", "/usr", "--", "/bin/bash", "-c", "--tmpfs /leak", "--bind", "/leak", "/leak"]);
	assert.deepEqual(mounts, [{ dest: "/usr", kind: "bind" }]);
});

// ── isPathVisible ────────────────────────────────────────────────────────────

const WS_MOUNTS: MountEntry[] = [
	{ dest: "/usr", kind: "bind" },
	{ dest: "/proc", kind: "special" },
	{ dest: "/dev", kind: "special" },
	{ dest: "/home/lucas", kind: "tmpfs" },
	{ dest: "/home/lucas/.cargo/bin", kind: "bind" },
	{ dest: "/ws", kind: "bind" },
	{ dest: "/ws/scratch", kind: "bind" },
	{ dest: "/bin", kind: "symlink" },
];

test("isPathVisible: paths under a tmpfs home are invisible unless a longer bind covers them", () => {
	assert.equal(isPathVisible(WS_MOUNTS, "/home/lucas"), true, "the tmpfs directory itself is visible");
	assert.equal(isPathVisible(WS_MOUNTS, "/home/lucas/.pi/agent"), false, "beneath tmpfs home: invisible");
	assert.equal(isPathVisible(WS_MOUNTS, "/home/lucas/.cargo/bin/cargo"), true, "covered by the longer bind");
});

test("isPathVisible: shared prefixes do not leak across component boundaries", () => {
	assert.equal(isPathVisible(WS_MOUNTS, "/wsx/file"), false, "/wsx is not /ws");
	assert.equal(isPathVisible(WS_MOUNTS, "/workspace"), false);
});

test("isPathVisible: unmounted prefixes are invisible; standard dirs are visible", () => {
	assert.equal(isPathVisible(WS_MOUNTS, "/opt/tool"), false);
	assert.equal(isPathVisible(WS_MOUNTS, "/mnt/data"), false);
	assert.equal(isPathVisible(WS_MOUNTS, "/usr/bin/ls"), true);
	assert.equal(isPathVisible(WS_MOUNTS, "/dev/null"), true);
	assert.equal(isPathVisible(WS_MOUNTS, "/proc/self"), true);
	assert.equal(isPathVisible(WS_MOUNTS, "/bin/bash"), true, "symlink destination is visible");
	assert.equal(isPathVisible(WS_MOUNTS, "/ws/scratch/x.txt"), true);
});

test("isPathVisible: no matching mount is invisible", () => {
	assert.equal(isPathVisible([], "/ws/x"), false);
});

// ── unmountedPathCandidates ──────────────────────────────────────────────────

/** Mounts modelling a realistic launch: workspace at /ws, scratch, empty home. */
function fakeMounts(scratch = "/ws/.guard-scratch"): MountEntry[] {
	return [
		{ dest: "/usr", kind: "bind" },
		{ dest: "/bin", kind: "symlink" },
		{ dest: "/proc", kind: "special" },
		{ dest: "/dev", kind: "special" },
		{ dest: HOME, kind: "tmpfs" },
		{ dest: "/ws", kind: "bind" },
		{ dest: scratch, kind: "bind" },
	];
}

test("unmountedPathCandidates flags an unmounted absolute path with redirection noise", () => {
	assert.deepEqual(unmountedPathCandidates(`ls ${HOME}/.pi/agent/agents/ 2>/dev/null`, fakeMounts(), HOME), [`${HOME}/.pi/agent/agents`]);
});

test("unmountedPathCandidates expands ~", () => {
	assert.deepEqual(unmountedPathCandidates("cat ~/.pi/agent/settings.json", fakeMounts(), HOME), [`${HOME}/.pi/agent/settings.json`]);
});

test("unmountedPathCandidates handles compound commands and flags only unmounted parts", () => {
	assert.deepEqual(unmountedPathCandidates("cd /ws && cat /opt/secret.txt", fakeMounts(), HOME), ["/opt/secret.txt"]);
});

test("unmountedPathCandidates extracts --opt=/abs/path values", () => {
	assert.deepEqual(unmountedPathCandidates("tool --config=/etc/extra/tool.conf", fakeMounts(), HOME), ["/etc/extra/tool.conf"]);
});

test("unmountedPathCandidates truncates globs to their directory", () => {
	assert.deepEqual(unmountedPathCandidates("ls /opt/logs/*.txt", fakeMounts(), HOME), ["/opt/logs"]);
});

test("unmountedPathCandidates ignores relative paths, URLs, redirections, and bare ~ arguments", () => {
	assert.deepEqual(unmountedPathCandidates("grep pattern relative/file.txt", fakeMounts(), HOME), []);
	assert.deepEqual(unmountedPathCandidates("curl https://example.com/path", fakeMounts(), HOME), []);
	// Redirect operands are not argv: the shell-ast projection scans command
	// arguments, not redirection targets, so a path that only appears as a
	// redirect operand is not probed (advisory-only hint).
	assert.deepEqual(unmountedPathCandidates("sort < /etc/hostname > out.txt", fakeMounts(), HOME), []);
	assert.deepEqual(unmountedPathCandidates("cd ~", fakeMounts(), HOME), []);
});

test("unmountedPathCandidates skips leading assignments and wrapper prefixes", () => {
	assert.deepEqual(unmountedPathCandidates("FOO=/assigned/not/probed env sudo ls /opt/tool", fakeMounts(), HOME), ["/opt/tool"]);
});

test("unmountedPathCandidates dedupes and caps at 3", () => {
	const found = unmountedPathCandidates("ls /a/x /b/y /c/z /d/w", fakeMounts(), HOME);
	assert.deepEqual(found, ["/a/x", "/b/y", "/c/z"]);
	assert.deepEqual(unmountedPathCandidates("ls /a/x /a/x/", fakeMounts(), HOME), ["/a/x"], "trailing slash normalizes to a duplicate");
});

test("unmountedPathCandidates returns [] without mount data", () => {
	assert.deepEqual(unmountedPathCandidates("ls /opt/x", undefined, HOME), []);
	assert.deepEqual(unmountedPathCandidates("ls /opt/x", [], HOME), []);
});

test("unmountedPathCandidates flags a workspace symlink resolving outside the mounts", () => {
	const base = mkdtempSync(path.join(os.tmpdir(), "guard-hints-"));
	try {
		const ws = path.join(base, "ws");
		mkdirSync(ws);
		const outside = path.join(base, "outside");
		mkdirSync(outside);
		symlinkSync(outside, path.join(ws, "link"));
		writeFileSync(path.join(outside, "file.txt"), "x");
		// The workspace is bound at its real temp path; the link's realpath
		// (base/outside) is not under any mount.
		const mounts: MountEntry[] = [{ dest: "/usr", kind: "bind" }, { dest: ws, kind: "bind" }];
		assert.deepEqual(unmountedPathCandidates(`ls ${ws}/link/file.txt`, mounts, HOME), [`${ws}/link/file.txt`]);
		writeFileSync(path.join(ws, "real.txt"), "x");
		assert.deepEqual(unmountedPathCandidates(`cat ${ws}/real.txt`, mounts, HOME), [], "a real workspace file is never flagged");
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("unmountedPathCandidates never flags paths under visible standard dirs", () => {
	assert.deepEqual(unmountedPathCandidates("ls /usr/bin /dev/null /proc/self /bin/sh /ws/x", fakeMounts(), HOME), []);
});

// ── sandboxFailureHint composition ───────────────────────────────────────────

test("sandboxFailureHint: host-bound commands keep the existing targeted directive", () => {
	assert.equal(
		sandboxFailureHint("gh pr list", fakeMounts(), HOME),
		"Guard sandbox: 'gh' needs network access or host credentials and cannot succeed here. Re-run this command with host_bash (not bash); do not retry with bash.",
	);
	assert.match(sandboxFailureHint("git push origin main", fakeMounts(), HOME), /'git push'/);
});

test("sandboxFailureHint: unmounted paths name the invisibility, direct the action, and keep the causation hedge", () => {
	const hint = sandboxFailureHint(`ls ${HOME}/.pi/agent/agents/ 2>/dev/null`, fakeMounts(), HOME);
	assert.match(hint, new RegExp(`${HOME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\/\\.pi\\/agent\\/agents`));
	assert.match(hint, /are not visible in this sandbox/);
	assert.match(hint, /If the command needs them, use host_bash \(or the read tool to read them\); do not retry with bash\./);
	assert.match(hint, /Other causes are possible/, "the hint still never claims the path caused the failure");
	assert.match(hint, /request_read_access/, "the appended shell explanation names the tool");
	assert.ok(hint.includes(SHELL_SANDBOX_FAILURE_HINT), "the stable shell explanation is appended");
});

test("sandboxFailureHint: no path mention keeps the generic shell hint", () => {
	const hint = sandboxFailureHint("false", fakeMounts(), HOME);
	assert.equal(hint, SHELL_SANDBOX_FAILURE_HINT);
});

test("SHELL_SANDBOX_FAILURE_HINT states the boundary and points at the read-access tool", () => {
	assert.match(SHELL_SANDBOX_FAILURE_HINT, /host_bash/);
	assert.match(SHELL_SANDBOX_FAILURE_HINT, /request a grant with the request_read_access tool/);
	assert.match(SHELL_SANDBOX_FAILURE_HINT, /the sandbox \/tmp is a private tmpfs, not the host \/tmp/);
	assert.match(SHELL_SANDBOX_FAILURE_HINT, /never fall back to host execution/);
	assert.doesNotMatch(SHELL_SANDBOX_FAILURE_HINT, /readRoots/, "the manual config-editing sentence is replaced by the tool");
});

test("sandboxFailureHint remains advisory for path-mentioning commands that would succeed", () => {
	// echo merely mentions the path; the hint must stay conditional and no
	// execution path may block or reroute on it (asserted by composition only).
	const hint = sandboxFailureHint("echo /opt/unmounted/path", fakeMounts(), HOME);
	assert.match(hint, /are not visible in this sandbox/);
	assert.match(hint, /Other causes are possible/);
});

// ── Tool descriptions ───────────────────────────────────────────────────────

const LIVE_PATHS = { workspace: "/home/user/proj", scratch: "/tmp/pi-guard-1000/session-x/scratch", home: "/home/user" };

test("bash and host_bash descriptions name the live paths and the private /tmp", () => {
	const bash = bashToolDescription("NATIVE", LIVE_PATHS);
	assert.match(bash, /^Sandboxed shell: no network, no host credentials\./);
	assert.ok(bash.includes(`the workspace ${LIVE_PATHS.workspace}`), "the workspace path is named");
	assert.ok(bash.includes(LIVE_PATHS.scratch), "the session scratch path is named");
	assert.match(bash, /the sandbox \/tmp is a private tmpfs, not the host \/tmp/);
	assert.match(bash, /including \/home\/user\/\.pi and other repositories/);
	assert.match(bash, /bash runs in the sandbox only and is unavailable on a host without one \(degraded mode\)/);
	assert.match(bash, /full_output_path is a host temp file/);
	assert.ok(bash.includes("NATIVE"), "the native description survives verbatim");
	assert.match(bash, /request a grant with the request_read_access tool\.$/);

	const host = hostBashToolDescription("NATIVE", LIVE_PATHS);
	assert.match(host, /^Host shell: runs on the host with full network access and host credentials\. NATIVE/);
	assert.match(host, /the host \/tmp, \/home\/user\/\.pi, other repositories/);
	assert.match(host, /as the only shell in yolo, unrestricted, and degraded mode/);
	assert.match(host, /in degraded research only read-only-tier commands run/);
	assert.match(host, /Subject to HostBash rules and guard profile\.$/);

	// The routing parentheses now say `gh writes and auth`: plain gh reads are
	// not the escape this sentence is about.
	assert.match(bash, /\(gh writes and auth, curl, ssh, git push\/fetch, package installs\)/);
	assert.match(host, /\(gh writes and auth, curl, ssh, git push\/fetch, package installs\)/);

	// No clause is the old text exactly: no tool names, no double space.
	assert.doesNotMatch(bash, /gh_read|git_read/);
	assert.doesNotMatch(host, /gh_read|git_read/);
	assert.doesNotMatch(bash, / {2}/);
	assert.doesNotMatch(host, / {2}/);
	// The no-clause junctions are pinned as literals rather than compared with a
	// second call to the same builder, so a change to the routing sentence or to
	// the note that follows it cannot pass unnoticed.
	assert.match(bash, /when you only need to read it\. bash runs in the sandbox only/);
	assert.match(host, /in degraded research only read-only-tier commands run\)\. Subject to HostBash rules and guard profile\.$/);
	assert.equal(bashToolDescription("NATIVE", LIVE_PATHS), bash, "identical inputs are byte-identical");
	assert.equal(hostBashToolDescription("NATIVE", LIVE_PATHS), host, "identical inputs are byte-identical");

	// A clause lands immediately after the amended routing sentence in bash,
	// and immediately before the HostBash rules sentence in host_bash.
	const bashClause = bashToolDescription("NATIVE", LIVE_PATHS, "GitHub reads are gh_read, not a shell.");
	assert.match(bashClause, /when you only need to read it\. GitHub reads are gh_read, not a shell\. bash runs in the sandbox only/);
	const hostClause = hostBashToolDescription("NATIVE", LIVE_PATHS, "GitHub reads are gh_read, not a shell.");
	assert.match(hostClause, /in degraded research only read-only-tier commands run\)\. GitHub reads are gh_read, not a shell\. Subject to HostBash rules and guard profile\.$/);
	// An empty clause is the no-clause text exactly.
	assert.equal(bashToolDescription("NATIVE", LIVE_PATHS, ""), bash);
	assert.equal(hostBashToolDescription("NATIVE", LIVE_PATHS, ""), host);
	// A whitespace-only or padded clause is normalized, so no caller can
	// introduce a leading or doubled space into the routing rule.
	assert.equal(bashToolDescription("NATIVE", LIVE_PATHS, "   "), bash, "a whitespace-only clause is no clause");
	assert.equal(hostBashToolDescription("NATIVE", LIVE_PATHS, "\t"), host, "a tab-only clause is no clause");
	assert.doesNotMatch(bashToolDescription("NATIVE", LIVE_PATHS, "  Local git reads are git_read.  "), / {2}/);
	assert.match(bashToolDescription("NATIVE", LIVE_PATHS, "  Local git reads are git_read.  "), /read it\. Local git reads are git_read\. bash runs/);
});

test("readToolRoutingClause names only the read tools this request can reach", () => {
	const tools = (...names: string[]) => names.map((name) => ({ name }));
	const declared = (names: string[]) => ({ declared: tools(...names), callable: [] });
	const callable = (names: string[]) => ({ declared: [], callable: tools(...names) });
	const fanOut = "GitHub reads are gh_read, not a shell: fan several reads out from one codemode script.";
	assert.equal(readToolRoutingClause(declared(["gh_read", "codemode"])), fanOut, "gh_read declared with codemode: the fan-out sentence");
	assert.equal(readToolRoutingClause(declared(["gh_read"])), "GitHub reads are gh_read, not a shell.", "gh_read declared without codemode: no invitation to a codemode call");
	assert.equal(readToolRoutingClause(callable(["gh_read"])), "GitHub reads are gh_read from one codemode script, not a shell.", "gh_read reachable only from codemode");
	assert.equal(readToolRoutingClause(declared(["git_read"])), "Local git reads are git_read.", "git_read declared");
	assert.equal(readToolRoutingClause(callable(["git_read"])), "Local git reads are git_read from one codemode script.", "git_read reachable only from codemode");
	assert.equal(
		readToolRoutingClause(declared(["gh_read", "git_read"])),
		"GitHub reads are gh_read, not a shell. Local git reads are git_read.",
		"both declared: GitHub first, then git",
	);
	// Membership only: the loadout order cannot change the clause, so an
	// unchanged loadout yields identical text and cannot churn the payload.
	assert.equal(
		readToolRoutingClause(declared(["codemode", "git_read", "gh_read"])),
		readToolRoutingClause(declared(["gh_read", "git_read", "codemode"])),
		"the clause depends on the reachable set, not its order",
	);
	assert.equal(
		readToolRoutingClause(callable(["git_read", "gh_read"])),
		readToolRoutingClause(callable(["gh_read", "git_read"])),
		"callable order does not change the clause either",
	);
	assert.equal(readToolRoutingClause(declared(["read", "bash", "host_bash"])), "", "neither read tool: no clause");
	assert.equal(readToolRoutingClause(undefined), "", "an absent loadout yields the empty string");
	assert.equal(readToolRoutingClause(null), "", "a null loadout yields the empty string");
	assert.equal(readToolRoutingClause({} as never), "", "a malformed loadout yields the empty string rather than throwing");
	assert.equal(readToolRoutingClause({ declared: "gh_read", callable: [] } as never), "", "a non-array declared field is skipped, not thrown on");
	assert.equal(readToolRoutingClause({ declared: [], callable: null } as never), "", "a null callable field is skipped, not thrown on");
	assert.equal(readToolRoutingClause({ declared: [undefined as never], callable: [] } as never), "", "an undefined entry is skipped, not thrown on");
});

test("descriptions fall back to generic phrases before the runtime exists", () => {
	const bash = bashToolDescription("NATIVE");
	assert.match(bash, /the workspace the current workspace, the session scratch directory the per-session scratch directory/);
	assert.match(bash, /including ~\/\.pi and other repositories/);
	assert.doesNotMatch(bash, /undefined/);
	const host = hostBashToolDescription("NATIVE");
	assert.match(host, /~\/\.pi, other repositories/);
	assert.doesNotMatch(host, /undefined/);
	const worker = workerToolDescription("node");
	assert.match(worker, /~\/\.pi/);
	assert.doesNotMatch(worker, /undefined/);
});

test("worker descriptions share the boundary text and keep their own semantics", () => {
	for (const name of ["python", "node"] as const) {
		const text = workerToolDescription(name, LIVE_PATHS);
		assert.match(text, new RegExp(`^Persistent ${name} interpreter managed by guard`));
		assert.ok(text.includes(sandboxBoundaryText(LIVE_PATHS)), `${name}: shares the boundary text`);
		assert.match(text, /throwaway workspace overlays \(workspace writes never reach the host\)/);
		assert.match(text, /Host files outside those mounts \(including the host \/tmp\) are not visible to workers/);
		assert.match(text, /request_read_access/);
		assert.match(text, /action=reset discards state, not scratch; action=status never starts a worker\./);
		assert.match(text, /Raw profiles expose the host\. Unavailable in degraded mode\./);
		assert.doesNotMatch(text, /sandbox-only/, `${name}: the bash-only restriction is not attached to workers`);
	}
});

test("boundary text never enumerates read roots", () => {
	const first = bashToolDescription("NATIVE", LIVE_PATHS);
	assert.match(first, /read roots you were granted/);
	assert.doesNotMatch(first, /\/secret\/root|\/opt\/granted/, "granted read roots must never be enumerated");
	// Identical inputs are byte-identical, so a grant cannot churn the payload.
	assert.equal(bashToolDescription("NATIVE", LIVE_PATHS), first);
	assert.equal(workerToolDescription("python", LIVE_PATHS), workerToolDescription("python", LIVE_PATHS));
	// A clause is data too: the same clause renders byte-identically every time.
	const clause = readToolRoutingClause({ declared: [{ name: "gh_read" }, { name: "codemode" }], callable: [] });
	assert.equal(
		bashToolDescription("NATIVE", LIVE_PATHS, clause),
		bashToolDescription("NATIVE", LIVE_PATHS, clause),
	);
});
