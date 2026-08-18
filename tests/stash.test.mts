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

async function main() {
	assert.ok(commands.stash, "should register /stash");
	assert.ok(commands.pop, "should register /pop");
	assert.ok(commands["stash-list"], "should register /stash-list");
	assert.ok(commands["stash-drop"], "should register /stash-drop");
	assert.ok(commands["stash-clear"], "should register /stash-clear");
	assert.ok(shortcuts["ctrl+alt+s"], "should register ctrl+alt+s");
	assert.ok(shortcuts["ctrl+alt+r"], "should register ctrl+alt+r");

	// session_start should not throw
	sessionStartHandler?.({}, makeCtx());

	// 1. /pop on empty stash warns
	editorText = "";
	notifications.length = 0;
	await commands.pop.handler("", makeCtx());
	assert.match(lastNotification(), /empty/i);

	// 2. /stash with empty editor warns, does not stash
	editorText = "";
	notifications.length = 0;
	await commands.stash.handler("", makeCtx());
	assert.match(lastNotification(), /empty/i);

	// 3. /stash clears the editor
	editorText = "hello world\nsecond line";
	notifications.length = 0;
	await commands.stash.handler("", makeCtx());
	assert.equal(editorText, "", "stash should clear editor");
	assert.match(lastNotification(), /Stashed/);

	// 4. /pop restores it
	editorText = "";
	notifications.length = 0;
	await commands.pop.handler("", makeCtx());
	assert.equal(editorText, "hello world\nsecond line", "pop should restore text");
	assert.match(lastNotification(), /Restored/);

	// 5. Named stash/pop round-trip
	editorText = "named draft";
	await commands.stash.handler("myname", makeCtx());
	assert.equal(editorText, "");
	editorText = "";
	await commands.pop.handler("myname", makeCtx());
	assert.equal(editorText, "named draft");

	// 6. pop with non-empty editor swaps rather than clobbers
	editorText = "first draft";
	await commands.stash.handler("keep", makeCtx()); // stash "first draft" as "keep"
	editorText = "second draft (unsaved)";
	notifications.length = 0;
	await commands.pop.handler("keep", makeCtx());
	assert.equal(editorText, "first draft", "should restore named entry");
	assert.match(lastNotification(), /stashed first/i);
	// The swapped-out text should now be poppable (anonymous, newest).
	editorText = "";
	await commands.pop.handler("", makeCtx());
	assert.equal(editorText, "second draft (unsaved)", "swapped text should be recoverable");

	// 7. /stash-drop removes named entry
	editorText = "to be dropped";
	await commands.stash.handler("dropme", makeCtx());
	await commands["stash-drop"].handler("dropme", makeCtx());
	notifications.length = 0;
	editorText = "";
	await commands.pop.handler("dropme", makeCtx());
	assert.match(lastNotification(), /No stash named/);

	// 8. /stash-clear empties everything (with confirm)
	editorText = "one more";
	await commands.stash.handler("", makeCtx());
	confirmResult = true;
	await commands["stash-clear"].handler("", makeCtx());
	notifications.length = 0;
	editorText = "";
	await commands.pop.handler("", makeCtx());
	assert.match(lastNotification(), /empty/i);

	// 9. State survives a fresh extension instance (disk-backed).
	editorText = "persisted";
	await commands.stash.handler("persist-me", makeCtx());
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
	await commands2.pop.handler("persist-me", makeCtx());
	assert.equal(editorText, "persisted", "fresh instance should see disk-backed state");

	// 10. Corrupt JSON degrades to empty stash, no throw.
	writeFileSync(stashFile, "{ not valid json", "utf8");
	notifications.length = 0;
	editorText = "";
	await commands.pop.handler("", makeCtx());
	assert.match(lastNotification(), /empty/i);

	// 11. MAX_ENTRIES cap holds (anonymous entries dropped first).
	writeFileSync(stashFile, JSON.stringify({ version: 1, entries: [] }), "utf8");
	for (let i = 0; i < 60; i++) {
		editorText = `entry ${i}`;
		await commands.stash.handler("", makeCtx());
	}
	const state = stashModule.loadStash();
	assert.ok(state.entries.length <= 50, `expected <=50 entries, got ${state.entries.length}`);

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
