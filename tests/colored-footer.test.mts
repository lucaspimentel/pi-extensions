// Test harness that runs the ACTUAL colored-footer extension code.
//
// It imports the real default export, drives it with mock pi/ctx/tui/theme/
// footerData objects, captures the footer factory registered via
// ctx.ui.setFooter, and asserts on the rendered output.
//
// Each test case gets a fresh harness and its own agent dir (via the
// PI_CODING_AGENT_DIR env var, which pi's getAgentDir() respects) so the
// colored-footer.json config can be varied per case.
//
// Run: node tests/colored-footer.test.mts
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "timers/promises";
import coloredFooter from "../extensions/colored-footer.ts";

// The mock theme renders tokens and custom colors as REAL ANSI escapes
// (zero-width for visibleWidth, like the actual renderer) with per-source
// codes so assertions can tell which path a segment took. colorToHex
// normalizes parsed Color objects back to "#rrggbb" for the truecolor code.
import { colorToHex } from "@earendil-works/pi-tui";

const TOKEN_CODES: Record<string, string> = {
	dim: "2",
	accent: "90",
	mdLinkUrl: "94",
	success: "92",
	warning: "93",
	error: "91",
};

function hexToAnsi(hex: string): string {
	const h = hex.replace("#", "");
	return `\x1b[38;2;${parseInt(h.slice(0, 2), 16)};${parseInt(h.slice(2, 4), 16)};${parseInt(h.slice(4, 6), 16)}m`;
}

const theme: any = {
	appearance: "dark",
	fg(role: string, text: string) {
		return `\x1b[${TOKEN_CODES[role] ?? "0"}m${text}\x1b[0m`;
	},
	style(text: string, opts: { fg?: unknown }) {
		const fg = opts?.fg;
		if (fg && typeof fg === "object") return `${hexToAnsi(colorToHex(fg as any))}${text}\x1b[0m`;
		if (typeof fg === "string") return this.fg(fg, text);
		return text;
	},
};

const tui: any = { requestRender() {} };

// Read the real branch so the live PR/repo lookups have something to work with.
const cwd = process.cwd();
let CURRENT_BRANCH = "main";
try {
	CURRENT_BRANCH = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd })
		.toString()
		.trim();
} catch { /* keep default */ }

// Two assistant messages from the same model; the last reports a different
// responseModel (router/gateway alias) so the routed-model arrow is exercised.
const ROUTER_BRANCH = [
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
];

interface CaseResult {
	footer: { render(width: number): string[]; dispose?(): void };
	rendered: string[];
	notifications: { msg: string; level: string }[];
	cleanup: () => void;
}

// The extension reads its config at session_start, and getAgentDir() resolves
// via PI_CODING_AGENT_DIR, so each case points the env at a fresh temp dir.
async function makeCase(options: {
	config?: string | Record<string, unknown> | null;
	branch?: unknown[];
	model?: unknown;
	agentDir?: string;
	ctxPercent?: number;
}): Promise<CaseResult> {
	const { config, branch = ROUTER_BRANCH, model, ctxPercent = 24 } = options;

	let agentDir = options.agentDir;
	let createdDir: string | undefined;
	if (!agentDir && config !== undefined) {
		createdDir = mkdtempSync(join(tmpdir(), "pi-colored-footer-test-"));
		agentDir = createdDir;
	}
	const prevEnv = process.env.PI_CODING_AGENT_DIR;
	if (agentDir) process.env.PI_CODING_AGENT_DIR = agentDir;
	else delete process.env.PI_CODING_AGENT_DIR;

	if (config != null) {
		writeFileSync(
			join(agentDir!, "colored-footer.json"),
			typeof config === "string" ? config : JSON.stringify(config, null, "\t"),
		);
	}

	const notifications: { msg: string; level: string }[] = [];
	let footerFactory: ((tui: any, theme: any, footerData: any) => any) | undefined;
	let sessionStartHandler: ((event: any, ctx: any) => void) | undefined;

	const pi: any = {
		on(eventName: string, handler: any) {
			if (eventName === "session_start") sessionStartHandler = handler;
		},
		getThinkingLevel: () => "high",
	};

	const ctx: any = {
		cwd,
		sessionManager: { getBranch: () => branch },
		getContextUsage: () => ({ percent: ctxPercent }),
		model: model ?? { id: "claude-sonnet-4", name: "claude-sonnet-4", reasoning: true },
		ui: {
			setFooter(factory: any) { footerFactory = factory; },
			notify(msg: string, level: string) { notifications.push({ msg, level }); },
		},
	};

	const footerData: any = {
		getGitBranch: () => CURRENT_BRANCH,
		onBranchChange(_cb: () => void) {
			return () => {};
		},
		getExtensionStatuses: () => new Map<string, string>(),
	};

	coloredFooter(pi);
	assert.ok(sessionStartHandler, "extension did not register session_start");
	sessionStartHandler({}, ctx);
	assert.ok(footerFactory, "extension did not call ctx.ui.setFooter");
	const footer = footerFactory(tui, theme, footerData);

	// Let async PR/repo lookups settle so renders are deterministic.
	await delay(50);
	const rendered = footer.render(120).join("\n");

	const cleanup = () => {
		if (prevEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prevEnv;
		if (createdDir) rmSync(createdDir, { recursive: true, force: true });
	};

	return { footer, rendered, notifications, cleanup };
}

async function main() {
	let pass = 0;
	let fail = 0;
	function test(name: string, ok: boolean, detail?: string) {
		if (ok) {
			pass++;
			console.log(`  ✓ ${name}`);
		} else {
			fail++;
			console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`);
		}
	}

	// ── No config file: everything renders via theme tokens ────────────────────
	{
		const { rendered, notifications, cleanup } = await makeCase({});
		test("token mode: cwd uses the accent token", rendered.includes("\x1b[90m"), rendered);
		test("token mode: no custom-color markers", !rendered.includes("\x1b[38;2;"), rendered);
		test("token mode: ctx circle uses success at 24%", rendered.includes("\x1b[92m"), rendered);
		test("token mode: no warnings", notifications.length === 0, JSON.stringify(notifications));
		cleanup();
	}

	// ── Full Campbell palette: every role renders with its custom hex ──────────
	{
		const campbell = {
			colors: {
				cwd: "#61D6D6",
				branch: "#FF7FFF",
				model: "#3B78FF",
				ctxOk: "#16C60C",
				ctxWarn: "#F9F1A5",
				ctxError: "#E74856",
			},
		};
		const { rendered, notifications, cleanup } = await makeCase({ config: campbell });
		// ctx percent 24 exercises ctxOk; the other two ctx roles are covered by
		// the dedicated cases below (one render shows exactly one ctx role).
		for (const role of ["cwd", "branch", "model", "ctxOk"] as const) {
			const hex = (campbell.colors as Record<string, string>)[role];
			test(
				`campbell palette: ${role} renders with ${hex}`,
				rendered.includes(hexToAnsi(hex.toLowerCase())),
				rendered,
			);
		}
		test("campbell palette: no token markers", !rendered.includes("\x1b[9"), rendered);
		test("campbell palette: no warnings", notifications.length === 0, JSON.stringify(notifications));
		cleanup();
	}

	// ── Campbell palette: ctxWarn/ctxError roles at higher context usage ─────
	{
		const campbell = {
			colors: {
				ctxWarn: "#F9F1A5",
				ctxError: "#E74856",
			},
		};
		const warn = await makeCase({ config: campbell, ctxPercent: 50 });
		test(
			"campbell palette: ctxWarn renders with #F9F1A5 at 50%",
			warn.rendered.includes("\x1b[38;2;249;241;165m"),
			warn.rendered,
		);
		warn.cleanup();
		const err = await makeCase({ config: campbell, ctxPercent: 95 });
		test(
			"campbell palette: ctxError renders with #E74856 at 95%",
			err.rendered.includes("\x1b[38;2;231;72;86m"),
			err.rendered,
		);
		err.cleanup();
	}

	// ── Partial palette: overridden roles custom, the rest theme tokens ───────
	{
		const { rendered, cleanup } = await makeCase({
			config: { colors: { cwd: "#61D6D6" } },
		});
		test("partial palette: cwd renders custom", rendered.includes("\x1b[38;2;97;214;214m"), rendered);
		test("partial palette: branch stays a token", rendered.includes("\x1b[94m"), rendered);
		test("partial palette: model stays a token", rendered.includes("\x1b[90m"), rendered);
		cleanup();
	}

	// ── Invalid hex for one role: that role falls back, warning fires ─────────
	{
		const { rendered, notifications, cleanup } = await makeCase({
			config: { colors: { cwd: "not-a-color", model: "#3B78FF" } },
		});
		test("invalid hex: cwd falls back to the accent token", rendered.includes("\x1b[90m"), rendered);
		test("invalid hex: model still renders custom", rendered.includes("\x1b[38;2;59;120;255m"), rendered);
		test(
			"invalid hex: a warning notification fires",
			notifications.some((n) => n.level === "warning" && n.msg.includes("colors.cwd")),
			JSON.stringify(notifications),
		);
		cleanup();
	}

	// ── Invalid JSON: warning + full theme mode ────────────────────────────────
	{
		const { rendered, notifications, cleanup } = await makeCase({ config: "{ not json" });
		test("invalid JSON: renders via tokens", rendered.includes("\x1b[90m") && !rendered.includes("\x1b[38;2;"), rendered);
		test(
			"invalid JSON: warning fires",
			notifications.some((n) => n.level === "warning" && n.msg.includes("not valid JSON")),
			JSON.stringify(notifications),
		);
		cleanup();
	}

	// ── colors: "theme" is the explicit opt-in to token mode ───────────────────
	{
		const { rendered, notifications, cleanup } = await makeCase({
			config: { colors: "theme" },
		});
		test("colors:'theme' renders via tokens", rendered.includes("\x1b[90m") && !rendered.includes("\x1b[38;2;"), rendered);
		test("colors:'theme': no warnings", notifications.length === 0, JSON.stringify(notifications));
		cleanup();
	}

	// ── Virtual model: routes via the physical model from the last turn ────────
	{
		const virtualBranch = [
			{
				type: "message",
				message: {
					role: "assistant",
					api: "pi-virtual",
					provider: "pi",
					model: "openai/gpt-5.6",
					thinkingLevel: "high",
					usage: { input: 1000, output: 500, cost: { total: 0 } },
				},
			},
		];
		const { rendered, cleanup } = await makeCase({
			branch: virtualBranch,
			model: { id: "pi/auto", name: "Auto", api: "pi-virtual", reasoning: true },
		});
		test("virtual: shows the physical model after an arrow", rendered.includes("→ openai/gpt-5.6"), rendered);
		test("virtual: shows the thinking level from the last message", rendered.includes("• high"), rendered);
		test("virtual: never shows the last-turn segment", !rendered.includes("last turn:"), rendered);
		cleanup();
	}

	// ── Virtual model with no assistant message yet: bare label ────────────────
	{
		const { rendered, cleanup } = await makeCase({
			branch: [],
			model: { id: "pi/auto", name: "Auto", api: "pi-virtual", reasoning: true },
		});
		test("virtual, no turns: bare model label", rendered.includes("Auto") && !rendered.includes("→"), rendered);
		test("virtual, no turns: no last-turn segment", !rendered.includes("last turn:"), rendered);
		cleanup();
	}

	// ── Non-virtual router: responseModel arrow, no last-turn segment ─────────
	{
		const { rendered, cleanup } = await makeCase({});
		test("router: shows the routed model after an arrow", rendered.includes("→ anthropic/claude-sonnet-4"), rendered);
		test("router: no last-turn segment (same model)", !rendered.includes("last turn:"), rendered);
		cleanup();
	}

	// ── Non-virtual switched model: last-turn dim segment fires ────────────────
	{
		const { rendered, cleanup } = await makeCase({
			model: { id: "claude-opus-5", name: "Claude Opus 5 (AI Gateway, 1M)", reasoning: true },
		});
		test("switched model: shows the dim last-turn segment", rendered.includes("\x1b[2mlast turn: anthropic/claude-sonnet-4"), rendered);
		test("switched model: does not show the arrow", !rendered.includes("→ anthropic/claude-sonnet-4"), rendered);
		cleanup();
	}

	console.log(`\n  ${pass} passed, ${fail} failed`);
	if (fail > 0) process.exit(1);
	console.log("All colored-footer tests passed.");
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
