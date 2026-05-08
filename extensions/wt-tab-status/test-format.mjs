// run: node test-format.mjs

import {
	formatTitle, formatProgressSequence, isWindowsTerminal, WRAPPED_UI_METHODS, makeTestRunner,
} from "./test-helpers.mjs";

const { test, section, summary } = makeTestRunner();

// ── formatTitle ────────────────────────────────────────────────────────────

section("formatTitle — with session name");

test("idle has ✅ prefix",
	formatTitle("idle", "my-session", "myrepo"),
	"✅ π - my-session - myrepo");
test("working has no glyph (spinner conveys it)",
	formatTitle("working", "my-session", "myrepo"),
	"π - my-session - myrepo");
test("waiting has ❓ prefix",
	formatTitle("waiting", "my-session", "myrepo"),
	"❓ π - my-session - myrepo");
test("error has ❌ prefix",
	formatTitle("error", "my-session", "myrepo"),
	"❌ π - my-session - myrepo");

section("formatTitle — without session name");

test("idle (null session)",
	formatTitle("idle", null, "myrepo"),
	"✅ π - myrepo");
test("working (null session)",
	formatTitle("working", null, "myrepo"),
	"π - myrepo");
test("waiting (null session)",
	formatTitle("waiting", null, "myrepo"),
	"❓ π - myrepo");
test("error (null session)",
	formatTitle("error", null, "myrepo"),
	"❌ π - myrepo");

// ── formatProgressSequence ─────────────────────────────────────────────────

section("formatProgressSequence — OSC 9;4");

test("idle → state=0 (hide)",
	formatProgressSequence("idle"),
	"\x1b]9;4;0;0\x07");
test("working → state=3 (indeterminate spinner)",
	formatProgressSequence("working"),
	"\x1b]9;4;3;0\x07");
test("waiting → state=0 (hide)",
	formatProgressSequence("waiting"),
	"\x1b]9;4;0;0\x07");
test("error → state=0 (hide)",
	formatProgressSequence("error"),
	"\x1b]9;4;0;0\x07");

// Only "working" gets a non-hide progress sequence; the other three all hide.
const seqs = new Set([
	formatProgressSequence("idle"),
	formatProgressSequence("working"),
	formatProgressSequence("waiting"),
	formatProgressSequence("error"),
]);
test("only working differs from hide (2 distinct sequences)", seqs.size, 2);

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

// ── WRAPPED_UI_METHODS ─ dialog-detection coverage ───────────────────────
// These are the ctx.ui.* methods wrapUiDialogs() intercepts to drive the
// "waiting" state. Forgetting one means the user-blocking dialog silently
// keeps the spinner going instead of switching to ❓.

section("WRAPPED_UI_METHODS — dialog detection list");

const wrapped = new Set(WRAPPED_UI_METHODS);
test("includes confirm", wrapped.has("confirm"), true);
test("includes select",  wrapped.has("select"),  true);
test("includes input",   wrapped.has("input"),   true);
test("includes editor",  wrapped.has("editor"),  true);
test("includes custom (e.g. questionnaire)", wrapped.has("custom"), true);
test("no duplicates", wrapped.size, WRAPPED_UI_METHODS.length);

process.exit(summary() === 0 ? 0 : 1);
