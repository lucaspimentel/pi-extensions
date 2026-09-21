/**
 * Pure model-selection helpers for the idle-summary extension.
 *
 * Extracted from `idle-summary.ts` so they can be unit-tested without pulling
 * in the TUI or extension runtime. This module has only type-only imports —
 * it is safe to import from a plain JS test runner via type-stripping.
 *
 * The generic ranking/dedupe/auth logic (shared with pi-tool-permissions'
 * classifier model selection) lives in `../shared/model-selection.ts` and is
 * re-exported here directly. Only the summary-specific pieces
 * (`findConfiguredModel`'s string-ref parsing, `orderedSummaryCandidates`'
 * override-first candidate list) are defined locally.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import {
	dedupeModels,
	hasPrice,
	modelCostScore,
	modelLabel,
	pickableModels,
	rankModels,
	selectModel,
} from "../shared/model-selection.ts";

export { modelLabel, hasPrice, modelCostScore, dedupeModels, pickableModels, rankModels, selectModel };

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

/**
 * Resolve an explicit model override to a usable model.
 *
 * `modelRef` is a user-chosen `provider/modelId` (e.g. `"anthropic/claude-haiku-4-5"`)
 * or a bare `modelId` (e.g. `"claude-haiku-4-5"`). A `provider/modelId` match wins
 * over a bare `modelId` match, and the model must have configured auth. Returns
 * `undefined` when there's no override, no match, or the match lacks auth.
 */
export const findConfiguredModel = (
	pool: Model<Api>[],
	modelRef: string | undefined,
	hasAuth: (model: Model<Api>) => boolean,
): Model<Api> | undefined => {
	if (!modelRef) return undefined;
	const ref = modelRef.trim();
	if (!ref) return undefined;

	const unique = dedupeModels(pool);
	const byProviderAndId = unique.find(
		(m) => hasAuth(m) && modelLabel(m) === ref,
	);
	if (byProviderAndId) return byProviderAndId;
	return unique.find((m) => hasAuth(m) && m.id === ref);
};

/**
 * Ordered model candidates for a summary run.
 *
 * An explicit user override (from `/summary model`) comes first and is treated
 * as authoritative, even when it is unpriced: it is the user's direct choice.
 * If it errors at request time, the remaining ranked models are tried in order
 * until one actually returns text. The ranked fallback ignores models without
 * pricing information (see `rankModels`).
 *
 * Returns only models with configured auth. The override contributes at most
 * one entry; the ranked list never repeats it.
 */
export const orderedSummaryCandidates = (
	pool: Model<Api>[],
	currentProvider: string | undefined,
	modelRef: string | undefined,
	hasAuth: (model: Model<Api>) => boolean,
): Model<Api>[] => {
	const authed = dedupeModels(pool).filter(hasAuth);
	// Ranked fallback ignores unpriced models; dedupe guards against the case
	// where the override is also in the ranked pool.
	const ranked = rankModels(authed, currentProvider);
	const preferred = findConfiguredModel(authed, modelRef, () => true);
	if (!preferred) return ranked;
	const label = modelLabel(preferred);
	return [preferred, ...ranked.filter((m) => modelLabel(m) !== label)];
};
