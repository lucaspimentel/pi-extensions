/**
 * Ollama model auto-discovery.
 *
 * Registers an "ollama" provider whose model list is discovered live from
 * http://localhost:11434/api/tags, so pulled models show up in /model
 * without maintaining ~/.pi/agent/models.json manually.
 *
 * - Initial discovery happens in this async factory (available to
 *   `pi --list-models` and normal startup).
 * - `refreshModels` keeps the list live on model refresh; nothing is persisted.
 * - Degrades gracefully: if Ollama is not running, no provider is registered.
 *
 * Uses Ollama's OpenAI-compat endpoint (/v1). Ollama ignores the API key but
 * pi requires auth to be present, so a dummy key is used. Ollama also does
 * not understand the `developer` role or `reasoning_effort`, hence the
 * compat flags.
 *
 * Set OLLAMA_HOST to override the base URL (same variable Ollama clients use).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://localhost:11434";

export interface OllamaTagModel {
	name: string;
	details?: {
		parameter_size?: string;
		quantization_level?: string;
		context_length?: number;
	};
	capabilities?: string[];
}

export interface PiModel {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
	// Ollama does not understand the `developer` role or `reasoning_effort`.
	compat: {
		supportsDeveloperRole: false;
		supportsReasoningEffort: false;
	};
}

export function toPiModel(model: OllamaTagModel): PiModel {
	const capabilities = model.capabilities ?? [];
	const contextLength = model.details?.context_length ?? 128000;
	// Leave headroom for the answer; Ollama rejects requests larger than the context window.
	const maxTokens = Math.min(32768, Math.max(4096, Math.floor(contextLength / 8)));

	return {
		id: model.name,
		name: `Ollama ${model.name}${model.details?.parameter_size ? ` (${model.details.parameter_size})` : ""}`,
		reasoning: capabilities.includes("thinking"),
		input: capabilities.includes("vision") ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: contextLength,
		maxTokens,
		compat: {
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
		},
	};
}

export async function fetchOllamaModels(signal?: AbortSignal): Promise<PiModel[] | undefined> {
	try {
		const response = await fetch(`${OLLAMA_HOST}/api/tags`, { signal });
		if (!response.ok) return undefined;
		const payload = (await response.json()) as { models?: OllamaTagModel[] };
		return (payload.models ?? []).map(toPiModel);
	} catch {
		// Ollama not running: register nothing, keep pi startup clean.
		return undefined;
	}
}

export default async function (pi: ExtensionAPI) {
	const models = await fetchOllamaModels();
	if (!models) return;

	pi.registerProvider("ollama", {
		baseUrl: `${OLLAMA_HOST}/v1`,
		apiKey: "ollama", // placeholder; Ollama ignores it but pi requires auth presence
		api: "openai-completions",
		models,
		async refreshModels({ signal }) {
			const refreshed = await fetchOllamaModels(signal);
			return refreshed ?? [];
		},
	});
}
