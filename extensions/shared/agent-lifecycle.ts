/**
 * Shared pi session lifecycle state machine.
 *
 * One definition of what a pi session is currently doing, consumed by two
 * extensions:
 *   - extensions/wt-tab-status/index.ts       (tab title glyph + OSC 9;4)
 *   - extensions/intelligent-terminal/index.ts (Intelligent Terminal status)
 *
 * Pure and dependency-free (no runtime imports, no pi runtime types), so a
 * type-stripping test runner can import it directly.
 *
 * State is derived from the fields carried here:
 *   state            - current visible state
 *   dialogDepth      - number of nested blocking dialogs open (>0 -> waiting)
 *   lastToolErrored  - set by tool_error; cleared by tool_success, agent_start,
 *                      session_shutdown (deliberately NOT agent_settled)
 *   agentRunning     - between agent_start and agent_settled
 *   currentTool      - most recent top-level tool name, informational only
 */

export type AgentLifecycleState = "idle" | "working" | "waiting" | "error";

export interface LifecycleState {
	state: AgentLifecycleState;
	dialogDepth: number;
	/** True iff the *most recent* tool_result was an error and we haven't
	 *  recovered. Cleared by tool_success, agent_start, or session_shutdown.
	 *  Deliberately NOT cleared by agent_settled — a turn that ends on a
	 *  failing tool leaves the error state visible until the next agent_start. */
	lastToolErrored: boolean;
	agentRunning: boolean;
	/** Most recent top-level tool name, or null when none is running. Purely
	 *  informational: resolveLifecycleState ignores it. */
	currentTool: string | null;
}

export type LifecycleEvent =
	| { type: "agent_start" }
	| { type: "agent_settled" }
	| { type: "tool_error" }
	| { type: "tool_success" }
	| { type: "tool_start"; toolName: string }
	| { type: "dialog_open" }
	| { type: "dialog_close" }
	| { type: "session_shutdown" };

export function initialLifecycleState(): LifecycleState {
	return { state: "idle", dialogDepth: 0, lastToolErrored: false, agentRunning: false, currentTool: null };
}

export function reduceLifecycle(s: LifecycleState, ev: LifecycleEvent): LifecycleState {
	const next: LifecycleState = { ...s };
	switch (ev.type) {
		case "agent_start":
			next.agentRunning = true;
			next.lastToolErrored = false;
			next.currentTool = null;
			break;
		case "agent_settled":
			// Note: leave lastToolErrored alone — if the turn ended on a
			// failing tool, we want the error state to persist into idle until
			// the next turn. agent_settled (not agent_end) is the clearing
			// boundary for agentRunning: agent_end fires before retries,
			// overflow compaction, and queued follow-ups finish, so clearing
			// there would flash idle mid-work. Clears on every settlement,
			// including aborted ones.
			next.agentRunning = false;
			next.currentTool = null;
			break;
		case "tool_error":
			next.lastToolErrored = true;
			break;
		case "tool_success":
			next.lastToolErrored = false;
			break;
		case "tool_start":
			next.currentTool = ev.toolName;
			break;
		case "dialog_open":
			next.dialogDepth = s.dialogDepth + 1;
			break;
		case "dialog_close":
			next.dialogDepth = Math.max(0, s.dialogDepth - 1);
			break;
		case "session_shutdown":
			next.agentRunning = false;
			next.lastToolErrored = false;
			next.dialogDepth = 0;
			next.currentTool = null;
			break;
	}
	next.state = resolveLifecycleState(next);
	return next;
}

export function resolveLifecycleState(
	s: Pick<LifecycleState, "dialogDepth" | "lastToolErrored" | "agentRunning">,
): AgentLifecycleState {
	if (s.dialogDepth > 0) return "waiting";
	if (s.lastToolErrored) return "error";
	if (s.agentRunning) return "working";
	return "idle";
}
