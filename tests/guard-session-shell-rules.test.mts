// Focused tests for the memory-only session host-shell rule store
// (extensions/guard/session-shell-rules.ts): workspace scope resolution,
// lexical+physical containment, dormant reactivation, and deduplication.
// Run: node --test tests/guard-session-shell-rules.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SessionShellRuleStore, resolveWorkspaceScope, scopeContains } from "../extensions/guard/session-shell-rules.ts";

const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
	tempDirs.push(dir);
	return dir;
}

/** Try to create a symlink; symlink creation can fail on unprivileged hosts. */
function trySymlink(target: string, linkPath: string): boolean {
	try {
		fs.symlinkSync(target, linkPath, "dir");
		return true;
	} catch {
		return false;
	}
}

test("resolveWorkspaceScope canonicalizes an existing workspace", () => {
	const dir = makeTempDir("guard-session-scope-");
	const scope = resolveWorkspaceScope(dir);
	assert.ok(scope);
	assert.equal(scope.workspace, dir);
	assert.deepEqual(scope.lexical, [path.resolve(dir)]);
	assert.deepEqual(scope.real, [fs.realpathSync(dir)]);
});

test("resolveWorkspaceScope fails closed for a missing workspace", () => {
	assert.equal(resolveWorkspaceScope(path.join(os.tmpdir(), "guard-session-missing-does-not-exist")), null);
});

test("scopeContains covers the origin and descendants but not parents, siblings, or prefix siblings", () => {
	const parent = makeTempDir("guard-session-parent-");
	const origin = path.join(parent, "origin");
	const descendant = path.join(origin, "sub", "deeper");
	const sibling = path.join(parent, "sibling");
	const prefixSibling = path.join(parent, "origin-two");
	for (const dir of [origin, descendant, sibling, prefixSibling]) fs.mkdirSync(dir, { recursive: true });
	const scope = resolveWorkspaceScope(origin);
	assert.ok(scope);
	assert.equal(scopeContains(scope, origin), true);
	assert.equal(scopeContains(scope, descendant), true);
	assert.equal(scopeContains(scope, parent), false, "the parent is not covered");
	assert.equal(scopeContains(scope, sibling), false, "a sibling is not covered");
	assert.equal(scopeContains(scope, prefixSibling), false, "a name-prefix sibling is not covered");
	assert.equal(scopeContains(scope, path.join(os.tmpdir(), "guard-session-nonexistent")), false, "an unresolvable workspace is never covered");
});

test("scopeContains rejects a symlinked descendant that escapes the granting workspace and one that lexically escapes it", () => {
	const origin = makeTempDir("guard-session-symlink-origin-");
	const outside = makeTempDir("guard-session-symlink-outside-");
	fs.mkdirSync(path.join(outside, "inner"));
	const escape = path.join(origin, "escape");
	if (!trySymlink(outside, escape)) {
		console.log("skip: symlinks are unavailable on this host; containment assertions not exercised");
		return;
	}
	const scope = resolveWorkspaceScope(origin);
	assert.ok(scope);
	// Lexical containment passes for origin/escape, but its realpath is outside.
	assert.equal(scopeContains(scope, escape), false, "a lexically-contained symlink escaping the scope is rejected");
	// A workspace outside the scope whose realpath lands inside it is rejected
	// by the lexical check before physical containment can pass.
	const inbound = path.join(outside, "inbound");
	if (trySymlink(path.join(origin, "sub"), inbound)) {
		fs.mkdirSync(path.join(origin, "sub"), { recursive: true });
		assert.equal(scopeContains(scope, inbound), false, "a lexically-outside symlink into the scope is rejected");
	}
});

test("the store activates origin and descendant rules and keeps other workspaces dormant", () => {
	const parent = makeTempDir("guard-session-store-parent-");
	const origin = path.join(parent, "origin");
	const descendant = path.join(origin, "nested");
	const other = path.join(parent, "other");
	for (const dir of [origin, descendant, other]) fs.mkdirSync(dir, { recursive: true });
	const store = new SessionShellRuleStore();
	const scope = resolveWorkspaceScope(origin);
	assert.ok(scope);
	store.add(scope, ["HostBash(echo one)"]);
	assert.deepEqual(store.rulesFor(origin), ["HostBash(echo one)"]);
	assert.deepEqual(store.rulesFor(descendant), ["HostBash(echo one)"]);
	assert.deepEqual(store.rulesFor(other), [], "an unrelated workspace sees nothing");
	assert.equal(store.list().length, 1, "the dormant record is retained");
	// Returning to the origin reactivates the same record.
	assert.deepEqual(store.rulesFor(origin), ["HostBash(echo one)"]);
});

test("the store deduplicates rules within and across additions to the same workspace", () => {
	const origin = makeTempDir("guard-session-store-dedupe-");
	const scope = resolveWorkspaceScope(origin);
	assert.ok(scope);
	const store = new SessionShellRuleStore();
	store.add(scope, ["HostBash(echo one)", "HostBash(echo one)"]);
	assert.deepEqual(store.list()[0].rules, ["HostBash(echo one)"]);
	store.add(scope, ["HostBash(echo one)", "HostBash(echo two)"]);
	assert.deepEqual(store.list()[0].rules, ["HostBash(echo one)", "HostBash(echo two)"]);
	assert.equal(store.list().length, 1, "the same canonical workspace keeps one record");
	store.add(scope, ["HostBash(echo one)"]);
	assert.deepEqual(store.list()[0].rules, ["HostBash(echo one)", "HostBash(echo two)"], "an all-duplicate addition is a no-op");
	store.add(scope, ["   "]);
	assert.equal(store.list()[0].rules.length, 2, "blank rules are never stored");
	// The listing view is a copy; mutating it cannot corrupt the store.
	(store.list()[0].rules as string[]).push("HostBash(echo injected)");
	assert.deepEqual(store.rulesFor(origin), ["HostBash(echo one)", "HostBash(echo two)"]);
});

test("a second grant for the same physical directory extends one record and keeps every spelling", () => {
	const real = makeTempDir("guard-session-store-alias-real-");
	const linkPath = path.join(makeTempDir("guard-session-store-alias-link-"), "link");
	if (!trySymlink(real, linkPath)) return; // unprivileged host: no symlink semantics to test
	const viaLink = resolveWorkspaceScope(linkPath);
	const viaReal = resolveWorkspaceScope(real);
	assert.ok(viaLink && viaReal);
	const store = new SessionShellRuleStore();
	store.add(viaLink, ["HostBash(echo via-link)"]);
	assert.deepEqual(store.rulesFor(linkPath), ["HostBash(echo via-link)"]);
	store.add(viaReal, ["HostBash(echo via-real)"]);
	assert.equal(store.list().length, 1, "the same physical directory stays one record");
	assert.deepEqual(store.list()[0].rules, ["HostBash(echo via-link)", "HostBash(echo via-real)"]);
	// Both spellings keep working, and the newest one is what gets displayed.
	assert.deepEqual(store.rulesFor(linkPath), ["HostBash(echo via-link)", "HostBash(echo via-real)"]);
	assert.deepEqual(store.rulesFor(real), ["HostBash(echo via-link)", "HostBash(echo via-real)"]);
	assert.equal(store.list()[0].scope.workspace, real);
});

test("distinct workspaces keep independent records and reset clears everything", () => {
	const parent = makeTempDir("guard-session-store-multi-");
	const first = path.join(parent, "first");
	const second = path.join(parent, "second");
	fs.mkdirSync(first);
	fs.mkdirSync(second);
	const store = new SessionShellRuleStore();
	const firstScope = resolveWorkspaceScope(first);
	const secondScope = resolveWorkspaceScope(second);
	assert.ok(firstScope && secondScope);
	store.add(firstScope, ["HostBash(echo first)"]);
	store.add(secondScope, ["HostBash(echo second)"]);
	assert.deepEqual(store.rulesFor(first), ["HostBash(echo first)"]);
	assert.deepEqual(store.rulesFor(second), ["HostBash(echo second)"]);
	store.reset();
	assert.deepEqual(store.list(), []);
	assert.deepEqual(store.rulesFor(first), []);
});

test.after(() => {
	for (const dir of tempDirs) {
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
	}
});
