// run: node test-state-machine.mjs

import { initialState, reduce, makeTestRunner } from "./test-helpers.mjs";

const { test, section, summary } = makeTestRunner();

// helper: apply a sequence of events and return the final state
function run(events) {
	let s = initialState();
	for (const ev of events) s = reduce(s, ev);
	return s;
}

// helper: apply events and return ONLY the visible state name after each
function trace(events) {
	let s = initialState();
	const out = [];
	for (const ev of events) {
		s = reduce(s, ev);
		out.push(s.state);
	}
	return out;
}

// ── Initial state ──────────────────────────────────────────────────────────

section("initialState");

test("starts idle", initialState().state, "idle");
test("dialogDepth = 0", initialState().dialogDepth, 0);
test("lastToolErrored = false", initialState().lastToolErrored, false);
test("agentRunning = false", initialState().agentRunning, false);

// ── Basic transitions ──────────────────────────────────────────────────────

section("agent_start / agent_end");

test("agent_start → working",
	run([{ type: "agent_start" }]).state,
	"working");
test("agent_start, agent_end → idle",
	run([{ type: "agent_start" }, { type: "agent_end" }]).state,
	"idle");
test("agent_end without start stays idle",
	run([{ type: "agent_end" }]).state,
	"idle");

// ── Dialog (waiting) takes precedence over working ─────────────────────────

section("dialog_open / dialog_close");

test("dialog_open during working → waiting",
	run([{ type: "agent_start" }, { type: "dialog_open" }]).state,
	"waiting");
test("dialog_close returns to working",
	run([
		{ type: "agent_start" },
		{ type: "dialog_open" },
		{ type: "dialog_close" },
	]).state,
	"working");
test("nested dialogs require equal closes",
	run([
		{ type: "agent_start" },
		{ type: "dialog_open" },
		{ type: "dialog_open" },
		{ type: "dialog_close" },
	]).state,
	"waiting");
test("dialog_close past zero clamps to 0 (stays idle)",
	run([{ type: "dialog_close" }, { type: "dialog_close" }]).state,
	"idle");
test("dialog over idle agent → waiting then idle",
	trace([
		{ type: "dialog_open" },
		{ type: "dialog_close" },
	]).join(","),
	"waiting,idle");

// ── Error state ────────────────────────────────────────────────────────────

section("tool_error / tool_success");

test("tool_error during working → error",
	run([{ type: "agent_start" }, { type: "tool_error" }]).state,
	"error");
test("error sticks through agent_end (turn ended on failing tool)",
	run([
		{ type: "agent_start" },
		{ type: "tool_error" },
		{ type: "agent_end" },
	]).state,
	"error");
test("tool_success clears error mid-turn (agent recovered)",
	run([
		{ type: "agent_start" },
		{ type: "tool_error" },
		{ type: "tool_success" },
	]).state,
	"working");
test("recovered turn ends idle (no ❌ stuck after agent_end)",
	run([
		{ type: "agent_start" },
		{ type: "tool_error" },
		{ type: "tool_success" },
		{ type: "agent_end" },
	]).state,
	"idle");
test("tool_success when no error is a no-op (stays working)",
	run([
		{ type: "agent_start" },
		{ type: "tool_success" },
	]).state,
	"working");
test("agent_start clears prior error from last turn",
	run([
		{ type: "agent_start" },
		{ type: "tool_error" },
		{ type: "agent_end" },
		{ type: "agent_start" },
	]).state,
	"working");
test("dialog over error → waiting",
	run([
		{ type: "agent_start" },
		{ type: "tool_error" },
		{ type: "dialog_open" },
	]).state,
	"waiting");
test("closing dialog after error returns to error (no tool_success yet)",
	run([
		{ type: "agent_start" },
		{ type: "tool_error" },
		{ type: "dialog_open" },
		{ type: "dialog_close" },
	]).state,
	"error");

// ── Precedence: waiting > error > working > idle ──────────────────────────

section("precedence");

test("waiting beats error",
	run([
		{ type: "agent_start" },
		{ type: "tool_error" },
		{ type: "dialog_open" },
	]).state,
	"waiting");
test("error beats working",
	run([
		{ type: "agent_start" },
		{ type: "tool_error" },
	]).state,
	"error");
test("working beats idle",
	run([{ type: "agent_start" }]).state,
	"working");

// ── session_shutdown resets everything ────────────────────────────────────

section("session_shutdown");

test("shutdown from working → idle",
	run([{ type: "agent_start" }, { type: "session_shutdown" }]).state,
	"idle");
test("shutdown from error → idle",
	run([
		{ type: "agent_start" },
		{ type: "tool_error" },
		{ type: "session_shutdown" },
	]).state,
	"idle");
test("shutdown clears dialogDepth",
	run([
		{ type: "dialog_open" },
		{ type: "dialog_open" },
		{ type: "session_shutdown" },
	]).dialogDepth,
	0);

// ── Realistic full flow ───────────────────────────────────────────────────

section("realistic flow");

test("idle → working → waiting (permission) → working → idle",
	trace([
		{ type: "agent_start" },     // working
		{ type: "dialog_open" },     // waiting
		{ type: "dialog_close" },    // working
		{ type: "agent_end" },       // idle
	]).join(","),
	"working,waiting,working,idle");

test("turn ends on failing tool: ❌ persists until next agent_start",
	trace([
		{ type: "agent_start" },     // working
		{ type: "tool_error" },      // error
		{ type: "agent_end" },       // error (still ❌ on idle tab)
		{ type: "agent_start" },     // working (cleared)
		{ type: "agent_end" },       // idle
	]).join(","),
	"working,error,error,working,idle");

test("agent recovers mid-turn: error → working → idle (no ❌ sticks)",
	trace([
		{ type: "agent_start" },     // working
		{ type: "tool_error" },      // error  (failing tool)
		{ type: "tool_success" },    // working (next tool worked)
		{ type: "agent_end" },       // idle
	]).join(","),
	"working,error,working,idle");

process.exit(summary() === 0 ? 0 : 1);
