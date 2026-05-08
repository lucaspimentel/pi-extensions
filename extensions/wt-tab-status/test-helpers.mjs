// Shared helpers for wt-tab-status tests.
// Plain-JS mirrors of the pure functions in index.ts.
// When index.ts changes, update this file to match.

// ── State model (mirror of index.ts) ─────────────────────────────────────────

export const STATE_GLYPHS = {
	idle: "✅",
	working: "",
	waiting: "❓",
	error: "❌",
};

export const STATE_PROGRESS = {
	idle: 0,
	working: 3,
	waiting: 0,
	error: 0,
};

export function isWindowsTerminal(env = process.env) {
	return Boolean(env.WT_SESSION);
}

export function formatTitle(state, sessionName, cwdBase) {
	const glyph = STATE_GLYPHS[state];
	const base = sessionName ? `π - ${sessionName} - ${cwdBase}` : `π - ${cwdBase}`;
	return glyph ? `${glyph} ${base}` : base;
}

export function formatProgressSequence(state) {
	return `\x1b]9;4;${STATE_PROGRESS[state]};0\x07`;
}

export function initialState() {
	return { state: "idle", dialogDepth: 0, errorThisTurn: false, agentRunning: false };
}

export function resolveState(s) {
	if (s.dialogDepth > 0) return "waiting";
	if (s.errorThisTurn) return "error";
	if (s.agentRunning) return "working";
	return "idle";
}

export function reduce(s, ev) {
	const next = { ...s };
	switch (ev.type) {
		case "agent_start":
			next.agentRunning = true;
			next.errorThisTurn = false;
			break;
		case "agent_end":
			next.agentRunning = false;
			break;
		case "tool_error":
			next.errorThisTurn = true;
			break;
		case "dialog_open":
			next.dialogDepth = s.dialogDepth + 1;
			break;
		case "dialog_close":
			next.dialogDepth = Math.max(0, s.dialogDepth - 1);
			break;
		case "session_shutdown":
			next.agentRunning = false;
			next.errorThisTurn = false;
			next.dialogDepth = 0;
			break;
		default:
			throw new Error(`unknown event type: ${ev.type}`);
	}
	next.state = resolveState(next);
	return next;
}

// ── Test runner (matches pi-tool-permissions/test-helpers.mjs) ───────────────

export function makeTestRunner() {
	let pass = 0, fail = 0;

	function test(desc, actual, expected) {
		const ok = actual === expected;
		console.log((ok ? "  ✓" : "  ✗") + " " + desc);
		if (!ok) {
			console.log(`      got:      ${JSON.stringify(actual)}`);
			console.log(`      expected: ${JSON.stringify(expected)}`);
		}
		ok ? pass++ : fail++;
	}

	function section(name) {
		console.log(`\n── ${name} ${"─".repeat(Math.max(0, 50 - name.length))}`);
	}

	function summary() {
		console.log(`\n  ${pass} passed, ${fail} failed`);
		return fail;
	}

	return { test, section, summary };
}
