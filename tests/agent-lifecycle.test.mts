// Unit tests for the shared agent lifecycle reducer.
//
// The reducer is one definition of what a pi session is doing, consumed by
// wt-tab-status (tab glyph + OSC 9;4 spinner) and intelligent-terminal (IT
// status reporting). Both depend on the semantics pinned here:
//   - lastToolErrored survives agent_settled (a turn ending on a failing tool
//     keeps the error state visible until the next turn)
//   - dialogDepth composes for nested dialogs and wins over every other state
//   - currentTool is informational and never affects the visible state
//
// Run: node --test tests/agent-lifecycle.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";

const {
	initialLifecycleState,
	reduceLifecycle,
	resolveLifecycleState,
} = await import("../extensions/shared/agent-lifecycle.ts");

test("initialLifecycleState starts idle with nothing running", () => {
	assert.deepEqual(initialLifecycleState(), {
		state: "idle",
		dialogDepth: 0,
		lastToolErrored: false,
		agentRunning: false,
		currentTool: null,
	});
});

test("agent_start works and agent_settled returns to idle", () => {
	let s = initialLifecycleState();
	s = reduceLifecycle(s, { type: "agent_start" });
	assert.equal(s.state, "working");
	assert.equal(s.agentRunning, true);

	s = reduceLifecycle(s, { type: "agent_settled" });
	assert.equal(s.state, "idle");
	assert.equal(s.agentRunning, false);

	// Repeats are idempotent.
	s = reduceLifecycle(s, { type: "agent_settled" });
	assert.equal(s.state, "idle");
});

test("a dialog forces waiting and closing it restores the previous state", () => {
	let s = initialLifecycleState();
	s = reduceLifecycle(s, { type: "agent_start" });
	s = reduceLifecycle(s, { type: "dialog_open" });
	assert.equal(s.state, "waiting");
	assert.equal(s.dialogDepth, 1);

	s = reduceLifecycle(s, { type: "dialog_close" });
	assert.equal(s.state, "working");
	assert.equal(s.dialogDepth, 0);

	// Opened and closed while idle: back to idle, never working.
	let idle = initialLifecycleState();
	idle = reduceLifecycle(idle, { type: "dialog_open" });
	assert.equal(idle.state, "waiting");
	idle = reduceLifecycle(idle, { type: "dialog_close" });
	assert.equal(idle.state, "idle");
});

test("nested dialogs compose and closing below zero is clamped", () => {
	let s = initialLifecycleState();
	s = reduceLifecycle(s, { type: "dialog_open" });
	s = reduceLifecycle(s, { type: "dialog_open" });
	assert.equal(s.dialogDepth, 2);

	s = reduceLifecycle(s, { type: "dialog_close" });
	assert.equal(s.state, "waiting");
	s = reduceLifecycle(s, { type: "dialog_close" });
	assert.equal(s.state, "idle");

	s = reduceLifecycle(s, { type: "dialog_close" });
	assert.equal(s.dialogDepth, 0);
});

test("tool_error outranks working and survives settlement until tool_success", () => {
	let s = initialLifecycleState();
	s = reduceLifecycle(s, { type: "agent_start" });
	s = reduceLifecycle(s, { type: "tool_error" });
	assert.equal(s.state, "error");

	// The sticky-error rule: a turn that ends on a failing tool keeps the
	// error visible into idle.
	s = reduceLifecycle(s, { type: "agent_settled" });
	assert.equal(s.state, "error");
	assert.equal(s.lastToolErrored, true);

	s = reduceLifecycle(s, { type: "tool_success" });
	assert.equal(s.state, "idle");

	// agent_start is also a clearing boundary.
	let next = reduceLifecycle(s, { type: "tool_error" });
	next = reduceLifecycle(next, { type: "agent_start" });
	assert.equal(next.lastToolErrored, false);
});

test("session_shutdown clears every derived flag", () => {
	let s = initialLifecycleState();
	s = reduceLifecycle(s, { type: "agent_start" });
	s = reduceLifecycle(s, { type: "tool_error" });
	s = reduceLifecycle(s, { type: "dialog_open" });
	s = reduceLifecycle(s, { type: "tool_start", toolName: "read" });

	s = reduceLifecycle(s, { type: "session_shutdown" });
	assert.equal(s.state, "idle");
	assert.equal(s.agentRunning, false);
	assert.equal(s.lastToolErrored, false);
	assert.equal(s.dialogDepth, 0);
	assert.equal(s.currentTool, null);
});

test("tool_start records the current tool without changing activity", () => {
	let s = initialLifecycleState();
	s = reduceLifecycle(s, { type: "agent_start" });

	s = reduceLifecycle(s, { type: "tool_start", toolName: "read" });
	assert.equal(s.currentTool, "read");
	assert.equal(s.state, "working");
	assert.equal(s.agentRunning, true);
	assert.equal(s.dialogDepth, 0);

	// A second call replaces the name.
	s = reduceLifecycle(s, { type: "tool_start", toolName: "bash" });
	assert.equal(s.currentTool, "bash");

	// currentTool is cleared on the run boundaries, not on tool completion
	// (this model has no tool_end event).
	s = reduceLifecycle(s, { type: "agent_settled" });
	assert.equal(s.currentTool, null);

	s = reduceLifecycle(s, { type: "agent_start" });
	s = reduceLifecycle(s, { type: "tool_start", toolName: "read" });
	s = reduceLifecycle(s, { type: "agent_start" });
	assert.equal(s.currentTool, null);
});

test("tool_start does not disturb a pending dialog", () => {
	let s = initialLifecycleState();
	s = reduceLifecycle(s, { type: "agent_start" });
	s = reduceLifecycle(s, { type: "dialog_open" });
	s = reduceLifecycle(s, { type: "tool_start", toolName: "ask_user_question" });

	assert.equal(s.state, "waiting");
	assert.equal(s.dialogDepth, 1);
	assert.equal(s.currentTool, "ask_user_question");
});

test("resolveLifecycleState accepts a state without currentTool and keeps precedence", () => {
	assert.equal(resolveLifecycleState({ dialogDepth: 0, lastToolErrored: false, agentRunning: false }), "idle");
	assert.equal(resolveLifecycleState({ dialogDepth: 0, lastToolErrored: false, agentRunning: true }), "working");
	assert.equal(resolveLifecycleState({ dialogDepth: 0, lastToolErrored: true, agentRunning: true }), "error");
	assert.equal(resolveLifecycleState({ dialogDepth: 1, lastToolErrored: true, agentRunning: true }), "waiting");
});
