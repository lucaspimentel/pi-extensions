/**
 * Pure model-selection helpers for the idle-summary extension.
 *
 * Extracted from `idle-summary.ts` so they can be unit-tested without pulling
 * in the TUI or extension runtime. This module has only type-only imports —
 * it is safe to import from a plain JS test runner via type-stripping.
 */

import type { Api, Model } from "@earendil-works/pi-ai";

/**
 * Cost proxy for both cheapness and speed: smaller/cheaper models generally
 * respond faster. Lower score = preferred. Uses per-million input + output
 * rates. Missing rates are treated as 0.
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
 * Ordering: models from `currentProvider` come first (cheapest within that
 * provider first), then all other providers in ascending cost order. Ties keep
 * insertion order (Array.prototype.sort is stable as of ES2019).
 */
export const rankSummaryModels = (
	pool: Model<Api>[],
	currentProvider: string | undefined,
): Model<Api>[] => {
	const unique = dedupeModels(pool);
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
