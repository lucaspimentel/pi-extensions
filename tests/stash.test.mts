// Test harness that runs the ACTUAL stash extension code.
//
// It points PI_STASH_FILE at a temp file, imports the real default export,
// captures registered commands/shortcuts via a mock `pi`, and drives a mock
// `ctx` whose ui.getEditorText/setEditorText read/write a local variable.
//
// Run: node tests/stash.test.mts
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDir = mkdtempSync(join(tmpdir(), "pi-stash-test-"));
const stashFile = join(tmpDir, "pi-stash.json");
process.env.PI_STASH_FILE = stashFile;

const stashModule = await import("../extensions/stash.ts");
const stash = stashModule.default;

// ── Mock pi: capture commands + shortcuts ───────────────────────────────────
const commands: Record<string, any> = {};
const shortcuts: Record<string, any> = {};
let sessionStartHandler: ((event: any, ctx: any) => void) | undefined;

const pi: any = {
	registerCommand(name: string, opts: any) {
		commands[name] = opts;
	},
	registerShortcut(key: string, opts: any) {
		shortcuts[key] = opts;
	},
	on(eventName: string, handler: any) {
		if (eventName === "session_start") sessionStartHandler = handler;
	},
};

stash(pi);

// ── Mock ctx ─────────────────────────────────────────────────────────────────
let editorText = "";
const notifications: Array<{ message: string; type?: string }> = [];
let confirmResult = true;

function makeCtx(overrides: Partial<any> = {}) {
	return {
		hasUI: true,
		cwd: process.cwd(),
		ui: {
			theme: { fg: (_role: string, text: string) => text },
			getEditorText: () => editorText,
			setEditorText: (t: string) => {
				editorText = t;
			},
			notify: (message: string, type?: string) => {
				notifications.push({ message, type });
			},
			confirm: async (_title: string, _message: string) => confirmResult,
			setStatus: (_key: string, _text: string | undefined) => {},
		},
		...overrides,
	};
}

function lastNotification(): string {
	return notifications[notifications.length - 1]?.message ?? "";
}

async function stashDraft(text: string) {
	editorText = text;
	notifications.length = 0;
	await shortcuts["ctrl+alt+s"].handler(makeCtx());
}

async function main() {
	assert.ok(commands.pop, "should register /pop");
	assert.ok(commands["stash-list"], "should register /stash-list");
	assert.ok(commands["stash-drop"], "should register /stash-drop");
	assert.ok(commands["stash-clear"], "should register /stash-clear");
	assert.ok(shortcuts["ctrl+alt+s"], "should register ctrl+alt+s");
	assert.ok(shortcuts["ctrl+alt+r"], "should register ctrl+alt+r");
	assert.equal(commands.stash, undefined, "/stash should no longer be registered");

	// session_start should not throw
	sessionStartHandler?.({}, makeCtx());

	// 1. /pop on empty stash warns
	editorText = "";
	notifications.length = 0;
	await commands.pop.handler("", makeCtx());
	assert.match(lastNotification(), /empty/i);

	// 2. ctrl+alt+s with empty editor warns, does not stash
	editorText = "";
	notifications.length = 0;
	await shortcuts["ctrl+alt+s"].handler(makeCtx());
	assert.match(lastNotification(), /empty/i);

	// 3. ctrl+alt+s clears the editor
	await stashDraft("hello world\nsecond line");
	assert.equal(editorText, "", "stash should clear editor");
	assert.match(lastNotification(), /Stashed/);

	// 4. /pop restores it (bare, defaults to newest = index 1)
	editorText = "";
	notifications.length = 0;
	await commands.pop.handler("", makeCtx());
	assert.equal(editorText, "hello world\nsecond line", "pop should restore text");
	assert.match(lastNotification(), /Restored/);

	// 5. /stash-list numbers entries newest-first, 1 = newest
	await stashDraft("oldest");
	await stashDraft("middle");
	await stashDraft("newest");
	notifications.length = 0;
	await commands["stash-list"].handler("", makeCtx());
	const listing = lastNotification();
	const lines = listing.split("\n");
	assert.match(lines[1], /^1\./);
	assert.match(lines[2], /^2\./);
	assert.match(lines[3], /^3\./);

	// 6. /pop 2 restores the middle one, leaving the other two
	editorText = "";
	notifications.length = 0;
	await commands.pop.handler("2", makeCtx());
	assert.equal(editorText, "middle", "/pop 2 should restore the middle entry");

	// 7. /pop 1 (bare index) matches bare /pop (newest = "newest")
	editorText = "";
	await commands.pop.handler("1", makeCtx());
	assert.equal(editorText, "newest");

	// remaining: "oldest" only
	editorText = "";
	await commands.pop.handler("1", makeCtx());
	assert.equal(editorText, "oldest");

	// 8. out-of-range / non-numeric args warn without mutating state
	await stashDraft("a");
	await stashDraft("b");
	notifications.length = 0;
	editorText = "unsaved";
	await commands.pop.handler("99", makeCtx());
	assert.match(lastNotification(), /No stash entry 99/);
	assert.equal(editorText, "unsaved", "editor should be untouched on bad index");

	notifications.length = 0;
	await commands.pop.handler("nope", makeCtx());
	assert.match(lastNotification(), /No stash entry nope/);

	notifications.length = 0;
	await commands["stash-drop"].handler("0", makeCtx());
	assert.match(lastNotification(), /No stash entry 0/);

	// drain stash from prior step ("a", "b")
	editorText = "";
	await commands.pop.handler("", makeCtx());
	editorText = "";
	await commands.pop.handler("", makeCtx());

	// 9. Drop an anonymous entry by index (the gap that motivated this change).
	await stashDraft("keep me");
	await stashDraft("drop me");
	notifications.length = 0;
	await commands["stash-drop"].handler("1", makeCtx()); // "drop me" is newest -> index 1
	assert.match(lastNotification(), /Dropped entry 1/);
	editorText = "";
	notifications.length = 0;
	await commands.pop.handler("", makeCtx());
	assert.equal(editorText, "keep me", "the dropped entry should be gone, leaving the other");

	// 10. pop with non-empty editor swaps rather than clobbers
	await stashDraft("first draft");
	editorText = "second draft (unsaved)";
	notifications.length = 0;
	await commands.pop.handler("1", makeCtx());
	assert.equal(editorText, "first draft", "should restore the stashed entry");
	assert.match(lastNotification(), /stashed first/i);
	// The swapped-out text should now be poppable (anonymous, newest).
	editorText = "";
	await commands.pop.handler("", makeCtx());
	assert.equal(editorText, "second draft (unsaved)", "swapped text should be recoverable");

	// 11. /stash-clear empties everything (with confirm)
	await stashDraft("one more");
	confirmResult = true;
	await commands["stash-clear"].handler("", makeCtx());
	notifications.length = 0;
	editorText = "";
	await commands.pop.handler("", makeCtx());
	assert.match(lastNotification(), /empty/i);

	// 12. State survives a fresh extension instance (disk-backed).
	await stashDraft("persisted");
	const commands2: Record<string, any> = {};
	const pi2: any = {
		registerCommand(name: string, opts: any) {
			commands2[name] = opts;
		},
		registerShortcut() {},
		on() {},
	};
	stash(pi2);
	editorText = "";
	await commands2.pop.handler("1", makeCtx());
	assert.equal(editorText, "persisted", "fresh instance should see disk-backed state");

	// 13. Legacy on-disk entries with a stale `name` field still load and pop fine.
	writeFileSync(
		stashFile,
		JSON.stringify({ version: 1, entries: [{ name: "legacy", text: "legacy text", savedAt: new Date().toISOString() }] }),
		"utf8",
	);
	editorText = "";
	notifications.length = 0;
	await commands.pop.handler("", makeCtx());
	assert.equal(editorText, "legacy text", "legacy named entry should still pop by index");

	// 14. Corrupt JSON degrades to empty stash, no throw.
	writeFileSync(stashFile, "{ not valid json", "utf8");
	notifications.length = 0;
	editorText = "";
	await commands.pop.handler("", makeCtx());
	assert.match(lastNotification(), /empty/i);

	// 15. MAX_ENTRIES cap holds (oldest entries dropped first).
	writeFileSync(stashFile, JSON.stringify({ version: 1, entries: [] }), "utf8");
	for (let i = 0; i < 60; i++) {
		await stashDraft(`entry ${i}`);
	}
	const state = stashModule.loadStash();
	assert.ok(state.entries.length <= 50, `expected <=50 entries, got ${state.entries.length}`);
	assert.equal(state.entries[state.entries.length - 1].text, "entry 59", "newest entry should survive the cap");
	assert.equal(state.entries[0].text, "entry 10", "oldest surviving entry should be entry 10 (0..9 evicted)");

	console.log("All stash tests passed.");
}

main()
	.catch((e) => {
		console.error(e);
		process.exit(1);
	})
	.finally(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});
