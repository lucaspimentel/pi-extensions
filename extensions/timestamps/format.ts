/** Pure formatting helpers for the timestamps extension. No pi or TUI imports. */

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

/**
 * Wall-clock time of an event: HH:MM:SS in the local timezone, prefixed with
 * MM-DD when the timestamp falls on a different local date than `nowMs`.
 */
export function formatAbsolute(timestampMs: number, nowMs: number): string {
	const d = new Date(timestampMs);
	const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
	const now = new Date(nowMs);
	const sameDay =
		d.getFullYear() === now.getFullYear() &&
		d.getMonth() === now.getMonth() &&
		d.getDate() === now.getDate();
	if (sameDay) return time;
	return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${time}`;
}

/**
 * Gap since the previous transcript event: +3s under a minute, +M:SS from one
 * minute to under an hour, +H:MM:SS beyond.
 */
export function formatDelta(deltaMs: number): string {
	// Floored so a displayed value never flips to the next unit early.
	const s = Math.max(0, Math.floor(deltaMs / 1000));
	if (s < 60) return `+${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `+${m}:${pad2(s % 60)}`;
	const h = Math.floor(m / 60);
	return `+${h}:${pad2(m % 60)}:${pad2(s % 60)}`;
}

/**
 * Durations under 100ms would render as "ran 0.0s", which reads as noise;
 * callers omit the duration segment entirely for them.
 */
export function durationIsDisplayable(durationMs: number): boolean {
	return durationMs >= 100;
}

/**
 * How long the tool ran: 2.1s (one decimal under 10s), 14s, 1m14s, 1:02:03.
 * Call sites prefix the "ran " label themselves.
 */
export function formatDuration(ms: number): string {
	const s = Math.max(0, ms / 1000);
	if (s < 60) {
		// One decimal under 10s, floored so 9.99s never renders as 10.0s.
		if (s < 10) return `${(Math.floor(s * 10) / 10).toFixed(1)}s`;
		return `${Math.floor(s)}s`;
	}
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${Math.floor(s % 60)}s`;
	const h = Math.floor(m / 60);
	return `${h}:${pad2(m % 60)}:${pad2(Math.floor(s % 60))}`;
}

/**
 * Dim line under a tool result header: `ran 2.1s  ended 14:32:07` when the
 * duration is known and worth showing, `ended 14:32:07` otherwise (date prefix
 * when not today). Sub-100ms durations are omitted (they would read as 0.0s),
 * and shell tools pass includeDuration=false because the shell renderer
 * already displays the duration (Elapsed/Took).
 */
export function formatResultLine(
	durationMs: number | undefined,
	timestampMs: number,
	nowMs: number,
	includeDuration: boolean,
): string {
	const ended = `ended ${formatAbsolute(timestampMs, nowMs)}`;
	if (includeDuration && durationMs !== undefined && durationIsDisplayable(durationMs)) {
		return `ran ${formatDuration(durationMs)}  ${ended}`;
	}
	return ended;
}
