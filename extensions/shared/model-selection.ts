/**
 * Shared model helpers: display labels, dedupe, and the interactive picker
 * list used by guard, idle-summary, session-name-llm and pi-tool-permissions.
 *
 * Model resolution for guard, idle-summary and session-name-llm is the global
 * pin in `./model-pin.ts` (pinned model, else the session model). The
 * cost-ranking helpers that pi-tool-permissions' classifier auto-select uses
 * live in `../pi-tool-permissions/rules.ts`, which is the only consumer.
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
