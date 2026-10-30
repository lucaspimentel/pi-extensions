/**
 * Global model pin shared by guard, idle-summary and session-name-llm.
 *
 * Each extension keeps one optional pin in its own global config file
 * (`<agent dir>/<ext>.json`) under the top-level string key `"model"`, with
 * the value `"provider/modelId"`. Resolution is the same everywhere: the
 * pinned model wins only when it parses, `modelRegistry.find(provider, id)`
 * returns it, and `modelRegistry.hasConfiguredAuth(model)` is true; in every
 * other case the session model (`ctx.model`) is used unchanged. There is no
 * pool ranking, no pricing check and no provider preference.
 *
 * Callers pass the config file path: this module never resolves the agent
 * directory itself, so guard's tests can keep their HOME override and the
 * other extensions keep using getAgentDir(). Type-only imports from pi-ai,
 * so plain node test runners can import it via type stripping.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { modelLabel } from "./model-selection.ts";

/** Top-level key holding the pin in every extension's config file. */
export const MODEL_PIN_KEY = "model";

export type ModelRef = { provider: string; modelId: string };

/**
 * Parse a `provider/modelId` reference. The value is trimmed and split on the
 * FIRST "/", so model ids may contain slashes ("baseten/zai-org/GLM-5.2" is
 * provider "baseten", id "zai-org/GLM-5.2"). Both sides must be non-empty.
 */
export function parseModelRef(ref: string): ModelRef | undefined {
	if (typeof ref !== "string") return undefined;
	const trimmed = ref.trim();
	const slash = trimmed.indexOf("/");
	if (slash <= 0 || slash === trimmed.length - 1) return undefined;
	return { provider: trimmed.slice(0, slash), modelId: trimmed.slice(slash + 1) };
}

export type PinRead = { ref?: string; warning?: string };

/**
 * Coerce a raw config value into a pin. `undefined` means no pin; any other
 * non-string or an unparsable string is warned about and reads as unset.
 */
export function coerceModelPin(raw: unknown, label: string): PinRead {
	if (raw === undefined) return {};
	if (typeof raw !== "string" || !parseModelRef(raw)) {
		return { warning: `${label}: "${MODEL_PIN_KEY}" must be a "provider/modelId" string; ignoring it` };
	}
	return { ref: raw.trim() };
}

/** Read and parse a config file as a JSON object; `undefined` when missing. */
function readObject(path: string): { obj?: Record<string, unknown>; warning?: string } {
	if (!existsSync(path)) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (err) {
		return { warning: `${path}: failed to read (${(err as Error).message})` };
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { warning: `${path}: top-level value must be an object` };
	}
	return { obj: parsed as Record<string, unknown> };
}

/**
 * Read the pin from a config file. A missing file is no pin; a corrupt file
 * or a non-object top level warns and reads as no pin.
 */
export function readModelPin(path: string): PinRead {
	const { obj, warning } = readObject(path);
	if (warning) return { warning: `${warning}; ignoring the model pin` };
	if (!obj) return {};
	return coerceModelPin(obj[MODEL_PIN_KEY], path);
}

/**
 * Write the pin, preserving every sibling key. Creates the directory when
 * needed. A corrupt file (or a non-object top level) is warned about and
 * replaced by `{ "model": ref }`. Write errors throw so callers can report
 * that the pin was not saved.
 */
export function writeModelPin(path: string, ref: string): { warnings: string[] } {
	if (!parseModelRef(ref)) throw new Error(`invalid model reference "${ref}"; expected "provider/modelId"`);
	const warnings: string[] = [];
	mkdirSync(dirname(path), { recursive: true });
	const { obj, warning } = readObject(path);
	if (warning) warnings.push(`${warning}; overwriting it`);
	const next: Record<string, unknown> = { ...(obj ?? {}), [MODEL_PIN_KEY]: ref.trim() };
	writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
	return { warnings };
}

/**
 * Remove only the `"model"` key. Returns false, and writes nothing, when the
 * file is missing, unreadable, or has no `"model"` key.
 */
export function clearModelPin(path: string): boolean {
	const { obj } = readObject(path);
	if (!obj || !Object.prototype.hasOwnProperty.call(obj, MODEL_PIN_KEY)) return false;
	delete obj[MODEL_PIN_KEY];
	writeFileSync(path, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
	return true;
}

/** The registry surface resolution needs (ctx.modelRegistry satisfies it). */
export type PinRegistry = {
	find(provider: string, modelId: string): Model<Api> | undefined;
	hasConfiguredAuth(model: Model<Api>): boolean;
};

export type IgnoredPinReason = "invalid" | "not-found" | "no-auth";
export type IgnoredPin = { ref: string; reason: IgnoredPinReason };

export type ResolvedModel = {
	/** The model to use: the pin when it resolved, else the session model as-is. */
	model?: Model<Api>;
	/** True when the pin was used. */
	pinned: boolean;
	/** Set when a pin exists but could not be used. */
	ignoredPin?: IgnoredPin;
};

/**
 * Resolve the model to use. The pin wins only when it parses, is found, and
 * has configured auth; otherwise `ctxModel` is returned unchanged and NOT
 * auth-gated (callers keep their own "no model" / "no auth" handling).
 * `registry.find` is never called without a pin.
 */
export function resolveModel(
	pinRef: string | undefined,
	ctxModel: Model<Api> | undefined,
	registry: PinRegistry,
): ResolvedModel {
	if (pinRef === undefined) return { model: ctxModel, pinned: false };
	const fallback = (reason: IgnoredPinReason): ResolvedModel => ({ model: ctxModel, pinned: false, ignoredPin: { ref: pinRef, reason } });
	const parsed = parseModelRef(pinRef);
	if (!parsed) return fallback("invalid");
	const found = registry.find(parsed.provider, parsed.modelId);
	if (!found) return fallback("not-found");
	if (!registry.hasConfiguredAuth(found)) return fallback("no-auth");
	return { model: found, pinned: true };
}

/** Short reason text for an ignored pin ("not found", ...). */
export function ignoredPinReasonText(reason: IgnoredPinReason): string {
	switch (reason) {
		case "invalid": return 'not a "provider/modelId" reference';
		case "not-found": return "not found";
		case "no-auth": return "no configured auth";
	}
}

/**
 * The user-facing sentence for an ignored pin, e.g.
 * `idle-summary: pinned model "x/y" ignored (not found); using the session model anthropic/claude-x.`
 */
export function describeIgnoredPin(ext: string, ignored: IgnoredPin, fallback: Model<Api> | undefined): string {
	const using = fallback ? `the session model ${modelLabel(fallback)}` : "the session model (none available)";
	return `${ext}: pinned model "${ignored.ref}" ignored (${ignoredPinReasonText(ignored.reason)}); using ${using}.`;
}

/**
 * Once-per-session dedupe for ignored-pin notices, keyed by the pin ref.
 * `reset()` on a fresh session; `notifyOnce` runs `emit` the first time a ref
 * is seen and records it only after `emit` returns, so a throwing (stale)
 * emitter does not consume the notice.
 */
export function createIgnoredPinNotifier(): { reset(): void; notifyOnce(ref: string, emit: () => void): boolean } {
	const seen = new Set<string>();
	return {
		reset() {
			seen.clear();
		},
		notifyOnce(ref, emit) {
			if (seen.has(ref)) return false;
			emit();
			seen.add(ref);
			return true;
		},
	};
}
