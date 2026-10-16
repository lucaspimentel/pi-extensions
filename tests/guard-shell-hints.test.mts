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
import { SHELL_SANDBOX_FAILURE_HINT, sandboxFailureHint, unmountedPathCandidates } from "../extensions/guard/tools/shell.ts";

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
	assert.deepEqual(unmountedPathCandidates("sort < /etc/hostname > out.txt", fakeMounts(), HOME), ["/etc/hostname"]);
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

test("sandboxFailureHint: unmounted paths get the conditional hint without grant language", () => {
	const hint = sandboxFailureHint(`ls ${HOME}/.pi/agent/agents/ 2>/dev/null`, fakeMounts(), HOME);
	assert.match(hint, new RegExp(`${HOME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\/\\.pi\\/agent\\/agents`));
	assert.match(hint, /may not be visible/);
	assert.match(hint, /other causes are possible/);
	assert.doesNotMatch(hint, /read grant/i);
	assert.ok(hint.includes(SHELL_SANDBOX_FAILURE_HINT), "the stable shell explanation is appended");
});

test("sandboxFailureHint: no path mention keeps the generic shell hint", () => {
	const hint = sandboxFailureHint("false", fakeMounts(), HOME);
	assert.equal(hint, SHELL_SANDBOX_FAILURE_HINT);
});

test("SHELL_SANDBOX_FAILURE_HINT states the boundary and no grant offer", () => {
	assert.match(SHELL_SANDBOX_FAILURE_HINT, /host_bash/);
	assert.match(SHELL_SANDBOX_FAILURE_HINT, /readRoots/);
	assert.match(SHELL_SANDBOX_FAILURE_HINT, /guard\.json/);
	assert.doesNotMatch(SHELL_SANDBOX_FAILURE_HINT, /read grant/i);
});

test("sandboxFailureHint remains advisory for path-mentioning commands that would succeed", () => {
	// echo merely mentions the path; the hint must stay conditional and no
	// execution path may block or reroute on it (asserted by composition only).
	const hint = sandboxFailureHint("echo /opt/unmounted/path", fakeMounts(), HOME);
	assert.match(hint, /may not be visible/);
	assert.match(hint, /other causes are possible/);
});
