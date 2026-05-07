// run: node test-format.mjs

import {
	formatTitle, formatProgressSequence, isWindowsTerminal, makeTestRunner,
} from "./test-helpers.mjs";

const { test, section, summary } = makeTestRunner();

// ── formatTitle ────────────────────────────────────────────────────────────

section("formatTitle — with session name");

test("idle has no glyph",
	formatTitle("idle", "my-session", "myrepo"),
	"π - my-session - myrepo");
test("working has ⚙ prefix",
	formatTitle("working", "my-session", "myrepo"),
	"⚙ π - my-session - myrepo");
test("waiting has ❓ prefix",
	formatTitle("waiting", "my-session", "myrepo"),
	"❓ π - my-session - myrepo");
test("error has ✗ prefix",
	formatTitle("error", "my-session", "myrepo"),
	"✗ π - my-session - myrepo");

section("formatTitle — without session name");

test("idle (null session)",
	formatTitle("idle", null, "myrepo"),
	"π - myrepo");
test("working (null session)",
	formatTitle("working", null, "myrepo"),
	"⚙ π - myrepo");
test("waiting (null session)",
	formatTitle("waiting", null, "myrepo"),
	"❓ π - myrepo");
test("error (null session)",
	formatTitle("error", null, "myrepo"),
	"✗ π - myrepo");

// ── formatProgressSequence ─────────────────────────────────────────────────

section("formatProgressSequence — OSC 9;4");

test("idle → state=0 (hide)",
	formatProgressSequence("idle"),
	"\x1b]9;4;0;0\x07");
test("working → state=3 (indeterminate)",
	formatProgressSequence("working"),
	"\x1b]9;4;3;0\x07");
test("waiting → state=4 (warning)",
	formatProgressSequence("waiting"),
	"\x1b]9;4;4;0\x07");
test("error → state=2 (error)",
	formatProgressSequence("error"),
	"\x1b]9;4;2;0\x07");

// Sanity: each state produces a distinct sequence
const seqs = new Set([
	formatProgressSequence("idle"),
	formatProgressSequence("working"),
	formatProgressSequence("waiting"),
	formatProgressSequence("error"),
]);
test("all four states produce distinct sequences", seqs.size, 4);

// ── isWindowsTerminal ──────────────────────────────────────────────────────

section("isWindowsTerminal — env detection");

test("true when WT_SESSION is set",
	isWindowsTerminal({ WT_SESSION: "abc-123" }),
	true);
test("false when WT_SESSION is missing",
	isWindowsTerminal({}),
	false);
test("false when WT_SESSION is empty string",
	isWindowsTerminal({ WT_SESSION: "" }),
	false);
test("ignores other env vars",
	isWindowsTerminal({ TERM_PROGRAM: "WindowsTerminal" }),
	false);

process.exit(summary() === 0 ? 0 : 1);
