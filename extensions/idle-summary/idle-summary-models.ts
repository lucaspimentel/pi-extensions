/**
 * Pure helpers for the idle-summary extension.
 *
 * Extracted from `index.ts` so they can be unit-tested without pulling in the
 * TUI or extension runtime. This module has no runtime imports: it is safe to
 * import from a plain JS test runner via type-stripping.
 *
 * Model resolution is not here: the summary model is the global pin from
 * `../shared/model-pin.ts` (pinned model, else the session model), and the
 * picker helpers come from `../shared/model-selection.ts`.
 */

// ── Idle timeout resolution ─────────────────────────────────────────────────

export const DEFAULT_IDLE_TIMEOUT_MS = 3 * 60_000;
const MS_PER_MINUTE = 60_000;

export type IdleTimeoutResolution = {
	/** Effective delay before a summary fires, in milliseconds. */
	timeoutMs: number;
	/** True when a timeoutMinutes value was present in the config but unusable. */
	invalid: boolean;
};

/**
 * Resolve the user's configured idle timeout.
 *
 * `raw` is the `timeoutMinutes` value from the user's config file. A missing
 * value (undefined) means the default. A present value must be a finite,
 * positive number of minutes; anything else falls back to the default and is
 * reported as invalid so the caller can notify the user once.
 */
export const resolveIdleTimeoutMs = (raw: unknown): IdleTimeoutResolution => {
	if (raw === undefined) {
		return { timeoutMs: DEFAULT_IDLE_TIMEOUT_MS, invalid: false };
	}
	if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
		return { timeoutMs: raw * MS_PER_MINUTE, invalid: false };
	}
	return { timeoutMs: DEFAULT_IDLE_TIMEOUT_MS, invalid: true };
};
