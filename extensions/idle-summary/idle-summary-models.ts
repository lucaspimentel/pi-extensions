/**
 * Pure model-selection helpers for the idle-summary extension.
 *
 * Extracted from `idle-summary.ts` so they can be unit-tested without pulling
 * in the TUI or extension runtime. This module has only type-only imports —
 * it is safe to import from a plain JS test runner via type-stripping.
 */

import type { Api, Model } from "@earendil-works/pi-ai";

/**
 * Canonical display label for a model: `provider/modelId`.
 */
export const modelLabel = (model: Model<Api>): string =>
	`${model.provider}/${model.id}`;

/**
 * Whether a model carries pricing information. Models without input and
 * output rates provide no signal for ordering, so the ranking ignores them
 * (they cannot be compared by cost).
 */
export const hasPrice = (model: Model<Api>): boolean =>
	model.cost.input != null && model.cost.output != null;

/**
 * Cost proxy for both cheapness and speed: smaller/cheaper models generally
 * respond faster. Lower score = preferred. Uses per-million input + output
 * rates. Callers must ensure the model has pricing (see `hasPrice`) before
 * relying on this score.
 */
export const modelCostScore = (model: Model<Api>): number =>
	(model.cost.input ?? 0) + (model.cost.output ?? 0);

/**
 * Dedupe a model pool by `provider/id`, preserving first-seen order.
 */
export const dedupeModels = (pool: Model<Api>[]): Model<Api>[] => {
	const seen = new Set<string>();
	const out: Model<Api>[] = [];
	for (const m of pool) {
		const key = `${m.provider}/${m.id}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(m);
	}
	return out;
};

/**
 * Rank a model pool for summary generation.
 *
 * Models without pricing information are ignored entirely (they cannot be
 * ordered by cost). Ordering: models from `currentProvider` come first
 * (cheapest within that provider first), then all other providers in ascending
 * cost order. Ties keep insertion order (Array.prototype.sort is stable as of
 * ES2019).
 */
export const rankSummaryModels = (
	pool: Model<Api>[],
	currentProvider: string | undefined,
): Model<Api>[] => {
	const unique = dedupeModels(pool).filter(hasPrice);
	return [...unique].sort((a, b) => {
		const aSame = currentProvider !== undefined && a.provider === currentProvider;
		const bSame = currentProvider !== undefined && b.provider === currentProvider;
		if (aSame !== bSame) return aSame ? -1 : 1;
		return modelCostScore(a) - modelCostScore(b);
	});
};

/**
 * Pick the first ranked model that has configured auth.
 *
 * `hasAuth` is injected so tests can stub it without a real ModelRegistry.
 */
export const selectSummaryModel = (
	pool: Model<Api>[],
	currentProvider: string | undefined,
	hasAuth: (model: Model<Api>) => boolean,
): Model<Api> | undefined => {
	for (const model of rankSummaryModels(pool, currentProvider)) {
		if (hasAuth(model)) return model;
	}
	return undefined;
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
 * An explicit user override (from `/summary-model`) comes first and is treated
 * as authoritative, even when it is unpriced: it is the user's direct choice.
 * If it errors at request time, the remaining ranked models are tried in order
 * until one actually returns text. The ranked fallback ignores models without
 * pricing information (see `rankSummaryModels`).
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
	const ranked = rankSummaryModels(authed, currentProvider);
	const preferred = findConfiguredModel(authed, modelRef, () => true);
	if (!preferred) return ranked;
	const label = modelLabel(preferred);
	return [preferred, ...ranked.filter((m) => modelLabel(m) !== label)];
};

/**
 * Models the user is allowed to pick as a summary model: unique, authed,
 * sorted by provider then model id for a stable picker list.
 */
export const pickableModels = (
	pool: Model<Api>[],
	hasAuth: (model: Model<Api>) => boolean,
): Model<Api>[] =>
	dedupeModels(pool)
		.filter((m) => hasAuth(m))
		.sort((a, b) =>
			a.provider === b.provider
				? a.id.localeCompare(b.id)
				: a.provider.localeCompare(b.provider),
		);
