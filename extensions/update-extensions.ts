/**
 * update-extensions
 *
 * /update-extensions runs `pi update --extensions` and then reloads
 * the runtime, replacing the manual `!pi update --extensions` +
 * `/reload` sequence.
 *
 * Notes:
 *   - The update runs in-process via child_process, so output is captured
 *     and surfaced as a notification (it does not go through `!` shell).
 *   - ctx.reload() replaces the extension runtime. Code after the await
 *     must not touch state from the old runtime, so this handler ends at
 *     the reload.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);

export default function (pi: ExtensionAPI) {
	pi.registerCommand("update-extensions", {
		description: "Run `pi update --extensions`, then reload extensions",
		handler: async (_args, ctx) => {
			ctx.ui.notify("Updating extensions...", "info");
			try {
				const { stdout, stderr } = await execFileAsync("pi", ["update", "--extensions"], {
					timeout: 120_000,
				});
				const output = [stdout, stderr].map((s) => s.trim()).filter(Boolean).join("\n");
				if (output) {
					ctx.ui.notify(output.slice(0, 2000), "info");
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`pi update failed: ${message.slice(0, 1000)}`, "error");
				return;
			}
			ctx.ui.notify("Update complete, reloading...", "info");
			// Nothing after this line may use state from the old runtime.
			await ctx.reload();
		},
	});
}
