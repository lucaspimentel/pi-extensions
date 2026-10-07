/**
 * Offline fake provider for guard step-5 subprocess tests. Registers a
 * "guardtest/fake" chat model that answers with a fixed text and records one
 * line per model request in GUARD_TEST_CALL_LOG, so tests can count delegated
 * model calls without contacting real providers. Loaded as an explicit
 * --extension in a pi subprocess with an isolated PI_CODING_AGENT_DIR.
 */

import * as fs from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CALL_LOG = process.env.GUARD_TEST_CALL_LOG;

export default function fakeProvider(pi: ExtensionAPI) {
	pi.registerProvider("guardtest", {
		name: "Guard Test",
		apiKey: "guard-test-key",
		baseUrl: "http://guardtest.invalid",
		api: "guard-test",
		models: [{
			id: "fake",
			name: "Fake",
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			reasoning: false,
			contextWindow: 128000,
			maxTokens: 4096,
		}],
		streamSimple: (model, _context, _options) => {
			if (CALL_LOG) {
				try { fs.appendFileSync(CALL_LOG, `${JSON.stringify({ at: Date.now(), model: `${model.provider}/${model.id}` })}\n`); } catch { /* best effort */ }
			}
			const stream = createAssistantMessageEventStream();
			const message = {
				role: "assistant" as const,
				api: "guard-test" as const,
				provider: model.provider,
				model: String(model.id),
				content: [] as Array<{ type: "text"; text: string }>,
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "stop" as const,
				timestamp: Date.now(),
			};
			const text = "GUARDTEST-OK";
			stream.push({ type: "start", partial: message });
			stream.push({ type: "text_start", contentIndex: 0, partial: message });
			message.content = [{ type: "text", text }];
			stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
			stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
			stream.push({ type: "done", reason: "stop", message });
			return stream;
		},
	});
}
