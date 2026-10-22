// Test harness that runs the ACTUAL stash extension code.
//
// It points PI_STASH_FILE at a temp file, imports the real default export,
// captures registered commands/shortcuts via a mock `pi`, and drives a mock
// `ctx` whose ui.getEditorText/setEditorText read/write a local variable.
//
// Scenarios run through the canonical /stash <subcommand> surface and
// verify that removed flat aliases are no longer registered.
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

// Invoke the canonical root command with fresh notifications.
async function stashCmd(args: string) {
	notifications.length = 0;
	await commands.stash.handler(args, makeCtx());
}

async function main() {
	assert.ok(commands.stash, "should register canonical /stash");
	for (const alias of ["pop", "stash-list", "stash-drop", "stash-clear"]) {
		assert.equal(Object.hasOwn(commands, alias), false, `should not register removed /${alias} alias`);
	}
	assert.ok(shortcuts["ctrl+alt+s"], "should register ctrl+alt+s");
	assert.ok(shortcuts["ctrl+alt+r"], "should register ctrl+alt+r");

	// session_start should not throw
	sessionStartHandler?.({}, makeCtx());

	// 0. Bare /stash and /stash help show usage; unknown subcommands warn.
	for (const args of ["", "help", "bogus"]) {
		await stashCmd(args);
		assert.match(lastNotification(), /usage/i);
		assert.doesNotMatch(lastNotification(), /\/pop\b|stash-list|stash-drop|stash-clear|deprecated/i);
		if (args === "bogus") {
			assert.match(lastNotification(), /Unknown stash subcommand: bogus/);
			assert.equal(notifications[notifications.length - 1].type, "warning");
		}
	}

	// 0b. Root argument completion offers subcommands for the first word.
	const subCompletions = commands.stash.getArgumentCompletions("");
	assert.deepEqual(
		subCompletions.map((i: any) => i.value).sort(),
		["clear", "drop", "help", "list", "pop"],
	);
	assert.equal(commands.stash.getArgumentCompletions("li")?.length, 1);
	assert.equal(commands.stash.getArgumentCompletions("li")[0].value, "list");
	assert.equal(commands.stash.getArgumentCompletions("zzz"), null);

	// 1. /stash pop on empty stash warns
	editorText = "";
	await stashCmd("pop");
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

	// 3b. Index completion after pop/drop carries the subcommand in the value,
	// since completion replaces the whole argument text after /stash.
	const popCompletions = commands.stash.getArgumentCompletions("pop ");
	assert.ok(popCompletions, "expected index completions for 'pop '");
	assert.deepEqual(
		popCompletions.map((i: any) => i.value),
		["pop 1"],
	);
	assert.equal(commands.stash.getArgumentCompletions("drop 1")?.[0]?.value, "drop 1");
	assert.equal(commands.stash.getArgumentCompletions("clear 1"), null, "clear takes no index");

	// 4. /stash pop restores it (bare, defaults to newest = index 1)
	editorText = "";
	await stashCmd("pop");
	assert.equal(editorText, "hello world\nsecond line", "pop should restore text");
	assert.match(lastNotification(), /Restored/);

	// 5. /stash list numbers entries newest-first, 1 = newest
	await stashDraft("oldest");
	await stashDraft("middle");
	await stashDraft("newest");
	await stashCmd("list");
	const listing = lastNotification();
	const lines = listing.split("\n");
	assert.match(lines[1], /^1\./);
	assert.match(lines[2], /^2\./);
	assert.match(lines[3], /^3\./);
	assert.match(listing, /\/stash pop <n> or \/stash drop <n>/);

	// 6. /stash pop 2 restores the middle one, leaving the other two
	editorText = "";
	await stashCmd("pop 2");
	assert.equal(editorText, "middle", "/stash pop 2 should restore the middle entry");

	// 7. /stash pop 1 (bare index) matches bare /stash pop (newest = "newest")
	editorText = "";
	await stashCmd("pop 1");
	assert.equal(editorText, "newest");

	// remaining: "oldest" only
	editorText = "";
	await stashCmd("pop 1");
	assert.equal(editorText, "oldest");

	// 8. out-of-range / non-numeric args warn without mutating state
	await stashDraft("a");
	await stashDraft("b");
	editorText = "unsaved";
	await stashCmd("pop 99");
	assert.match(lastNotification(), /No stash entry 99/);
	assert.equal(editorText, "unsaved", "editor should be untouched on bad index");

	await stashCmd("pop nope");
	assert.match(lastNotification(), /No stash entry nope/);

	await stashCmd("drop 0");
	assert.match(lastNotification(), /No stash entry 0/);

	// missing index for drop shows canonical usage
	await stashCmd("drop");
	assert.match(lastNotification(), /Usage: \/stash drop <n>/);

	// drain stash from prior step ("a", "b")
	editorText = "";
	await stashCmd("pop");
	editorText = "";
	await stashCmd("pop");

	// 9. Drop an entry by index.
	await stashDraft("keep me");
	await stashDraft("drop me");
	await stashCmd("drop 1"); // "drop me" is newest -> index 1
	assert.match(lastNotification(), /Dropped entry 1/);
	editorText = "";
	await stashCmd("pop");
	assert.equal(editorText, "keep me", "the dropped entry should be gone, leaving the other");

	// 10. pop with non-empty editor swaps rather than clobbers
	await stashDraft("first draft");
	editorText = "second draft (unsaved)";
	await stashCmd("pop 1");
	assert.equal(editorText, "first draft", "should restore the stashed entry");
	assert.match(lastNotification(), /stashed first/i);
	// The swapped-out text should now be poppable (newest).
	editorText = "";
	await stashCmd("pop");
	assert.equal(editorText, "second draft (unsaved)", "swapped text should be recoverable");

	// 11. /stash clear preserves entries when declined and empties them when confirmed.
	await stashDraft("one more");
	confirmResult = false;
	await stashCmd("clear");
	assert.deepEqual(stashModule.loadStash().entries.map((entry) => entry.text), ["one more"]);
	confirmResult = true;
	await stashCmd("clear");
	editorText = "";
	await stashCmd("pop");
	assert.match(lastNotification(), /empty/i);

	// 11b. The restore shortcut pops the newest draft saved by the stash shortcut.
	await stashDraft("shortcut oldest");
	await stashDraft("shortcut newest");
	notifications.length = 0;
	await shortcuts["ctrl+alt+r"].handler(makeCtx());
	assert.equal(editorText, "shortcut newest");
	assert.match(lastNotification(), /Restored/);
	editorText = "";
	await stashCmd("pop");
	assert.equal(editorText, "shortcut oldest");

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
	await commands2.stash.handler("pop 1", makeCtx());
	assert.equal(editorText, "persisted", "fresh instance should see disk-backed state");

	// 13. Legacy on-disk entries with a stale `name` field still load and pop fine.
	writeFileSync(
		stashFile,
		JSON.stringify({ version: 1, entries: [{ name: "legacy", text: "legacy text", savedAt: new Date().toISOString() }] }),
		"utf8",
	);
	editorText = "";
	notifications.length = 0;
	await commands2.stash.handler("pop", makeCtx());
	assert.equal(editorText, "legacy text", "legacy named entry should still pop by index");

	// 14. Corrupt JSON degrades to empty stash, no throw.
	writeFileSync(stashFile, "{ not valid json", "utf8");
	notifications.length = 0;
	editorText = "";
	await commands2.stash.handler("pop", makeCtx());
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
