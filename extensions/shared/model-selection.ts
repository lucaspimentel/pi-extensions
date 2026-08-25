/**
 * Shared model-selection helpers.
 *
 * Both `idle-summary` and `pi-tool-permissions` need to pick a cheap/fast LLM
 * (a summary generator, a permission classifier) from whatever models the
 * user currently has configured. This module holds the pure ranking/auth/dedupe
 * logic that used to be duplicated verbatim in both extensions — see
 * `idle-summary/idle-summary-models.ts` and `pi-tool-permissions/index.ts`,
 * which both re-export these under their own extension-specific names.
 *
 * Type-only imports only, so this module (like the files that re-export it)
 * is safe to import from a plain JS test runner via type-stripping — no TUI
 * or extension runtime is pulled in.
 */

import type { Api, Model } from "@earendil-works/pi-ai";

/** Auth-gate seam: whether the caller has configured credentials for a model. */
export type HasAuth = (model: Model<Api>) => boolean;

/**
 * Canonical display label for a model: `provider/modelId`.
 */
export const modelLabel = (model: Model<Api>): string =>
	`${model.provider}/${model.id}`;

/**
 * Whether a model carries pricing information. Models without input and
 * output rates provide no signal for ordering, so ranking ignores them
 * (they cannot be compared by cost, and would otherwise default to a cost
 * score of 0 — i.e. "free" — and leap to the front of the ranking).
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
 * Rank a model pool for auto-selection.
 *
 * Models without pricing information are ignored entirely (they cannot be
 * ordered by cost). Ordering: models from `currentProvider` come first
 * (cheapest within that provider first), then all other providers in ascending
 * cost order. Ties keep insertion order (Array.prototype.sort is stable as of
 * ES2019).
 */
export const rankModels = (
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
export const selectModel = (
	pool: Model<Api>[],
	currentProvider: string | undefined,
	hasAuth: HasAuth,
): Model<Api> | undefined => {
	for (const model of rankModels(pool, currentProvider)) {
		if (hasAuth(model)) return model;
	}
	return undefined;
};

/**
 * Models the user is allowed to pick from interactively: unique, authed,
 * sorted by provider then model id for a stable picker list.
 */
export const pickableModels = (
	pool: Model<Api>[],
	hasAuth: HasAuth,
): Model<Api>[] =>
	dedupeModels(pool)
		.filter((m) => hasAuth(m))
		.sort((a, b) =>
			a.provider === b.provider
				? a.id.localeCompare(b.id)
				: a.provider.localeCompare(b.provider),
		);
