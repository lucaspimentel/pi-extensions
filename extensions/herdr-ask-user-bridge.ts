/**
 * Herdr ask-user bridge extension for pi
 *
 * Maps @juicesharp/rpiv-ask-user-question's `rpiv:ask-user:blocked` event to
 * the `herdr:blocked` event consumed by herdr's pi integration
 * (~/.pi/agent/extensions/herdr-agent-state.ts), so a herdr pane shows
 * "blocked" (with a reason) while the ask_user_question tool is waiting for
 * input, and returns to "working" when the answer arrives.
 *
 * No-op outside herdr: herdr-agent-state.ts gates on HERDR_ENV internally.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface AskUserBlockedPayload {
	active?: boolean;
}

export default function (pi: ExtensionAPI) {
	pi.events.on("rpiv:ask-user:blocked", (data: unknown) => {
		const payload = data as AskUserBlockedPayload | undefined;
		pi.events.emit("herdr:blocked", {
			active: payload?.active === true,
			label: "waiting for user to answer question",
		});
	});
}
