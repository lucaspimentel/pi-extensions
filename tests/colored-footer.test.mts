// Test harness that runs the ACTUAL colored-footer extension code.
//
// It imports the real default export and drives it with mock pi/ctx/tui/theme/
// footerData objects, capturing the footer factory the extension registers via
// ctx.ui.setFooter, then calling its render(width) and printing the result.
//
// Run: node tests/colored-footer.test.mts
import { setTimeout as delay } from "timers/promises";
import coloredFooter from "../extensions/colored-footer.ts";

// ── Capture the footer factory the extension registers ─────────────────────────
let footerFactory: ((tui: any, theme: any, footerData: any) => any) | undefined;
let sessionStartHandler: ((event: any, ctx: any) => void) | undefined;

const pi: any = {
	on(eventName: string, handler: any) {
		if (eventName === "session_start") sessionStartHandler = handler;
	},
	getThinkingLevel: () => "high",
};

// ── Mock theme: theme.fg(role, text) ───────────────────────────────────────────
const theme: any = {
	fg(role: string, text: string) {
		// dim ANSI so output roughly matches the real renderer
		return role === "dim" ? `\x1b[2m${text}\x1b[0m` : text;
	},
};

// ── Mock tui: requestRender triggers a re-render so async PR/repo lookups show ──
let renderCount = 0;
const tui: any = {
	requestRender() {
		renderCount++;
	},
};

// ── Mock footerData ────────────────────────────────────────────────────────────
const branchListeners: Array<() => void> = [];
const footerData: any = {
	getGitBranch: () => CURRENT_BRANCH,
	onBranchChange(cb: () => void) {
		branchListeners.push(cb);
		return () => {
			const i = branchListeners.indexOf(cb);
			if (i >= 0) branchListeners.splice(i, 1);
		};
	},
	getExtensionStatuses: () => new Map<string, string>(),
};

// Read the real branch so the live PR/repo lookups have something to work with.
import { execFileSync } from "child_process";
const cwd = process.cwd();
let CURRENT_BRANCH = "main";
try {
	CURRENT_BRANCH = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd })
		.toString()
		.trim();
} catch { /* keep default */ }

// ── Mock ctx ─────────────────────────────────────────────────────────────────
const ctx: any = {
	cwd,
	sessionManager: {
		// Two assistant messages with usage so token/cost stats appear.
		// The last one reports a different responseModel (router/gateway alias) so the
		// footer's routed-model suffix is exercised.
		getBranch: () => [
			{
				type: "message",
				message: {
					role: "assistant",
					model: "claude-sonnet-4",
					responseModel: "anthropic/claude-sonnet-4",
					usage: { input: 8000, output: 3200, cost: { total: 0.18 } },
				},
			},
			{
				type: "message",
					message: {
					role: "assistant",
					model: "claude-sonnet-4",
					responseModel: "anthropic/claude-sonnet-4",
					usage: { input: 2234, output: 2221, cost: { total: 0.105 } },
				},
			},
		],
	},
	getContextUsage: () => ({ percent: 24 }),
	model: { id: "claude-sonnet-4", name: "claude-sonnet-4", reasoning: true },
	ui: {
		setFooter(factory: any) {
			footerFactory = factory;
		},
	},
};

// ── Drive the extension ─────────────────────────────────────────────────────────
async function main() {
	// 1. Load the extension — registers the session_start handler.
	coloredFooter(pi);
	if (!sessionStartHandler) throw new Error("extension did not register session_start");

	// 2. Fire session_start — extension calls ctx.ui.setFooter(factory).
	sessionStartHandler({}, ctx);
	if (!footerFactory) throw new Error("extension did not call ctx.ui.setFooter");

	// 3. Instantiate the footer (the real render closure).
	const footer = footerFactory(tui, theme, footerData);

	const WIDTH = 100;

	console.log("\n── render #1 (before async git/PR lookups resolve) ──");
	for (const line of footer.render(WIDTH)) console.log(line);

	// 4. Let the async fetchRepoName / fetchPrInfo promises resolve.
	//    They call tui.requestRender() when done; we just wait then re-render.
	const before = renderCount;
	await delay(1500);
	console.log(`\n(requestRender called ${renderCount - before} time(s) after async lookups)`);

	console.log("\n── render #2 (after async git/PR lookups resolve) ──");
	for (const line of footer.render(WIDTH)) console.log(line);

	// 5. Simulate switching to a different model. The last assistant message still
	//    records the old model, so the footer should show 'last turn: <old model>'
	//    as a dim segment instead of '-> <model>'.
	ctx.model = { id: "claude-opus-5", name: "Claude Opus 5 (AI Gateway, 1M)", reasoning: true };
	console.log("\n── render #3 (after switching to a different model) ──");
	for (const line of footer.render(WIDTH)) console.log(line);

	footer.dispose?.();
	console.log();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
