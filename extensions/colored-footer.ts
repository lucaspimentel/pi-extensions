/**
 * Colored footer extension for pi
 *
 * Line 1 (colored):   cwd
 * Line 2 (colored):   branch [PR icon + number]
 * Line 3 (stats):     model • thinking   ↑10 ↓5.4k $0.285   ctx-icon X% context used        
 * Line 4+:            extension statuses (if any)
 *
 * Colors: configurable via `<agent dir>/colored-footer.json`. By default every
 * colored segment uses the pi theme (accent/success/warning/error/...), so it
 * adapts to the active theme and terminal color depth. A custom palette of hex
 * colors can be set per role (cwd, branch, model, ctxOk, ctxWarn, ctxError);
 * roles without an override fall back to their theme token. The previous
 * hardcoded Campbell scheme is preserved as a config file example below.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parseColor, type Color, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { execFile } from "child_process";
import { readFileSync } from "node:fs";
import * as os from "os";
import { join } from "node:path";

// ── Configurable colors ──────────────────────────────────────────────────────
// Each role renders with the user's custom hex color when colored-footer.json
// provides one, otherwise with the mapped pi theme token.
const CONFIG_FILE = "colored-footer.json";

type ColorRole = "cwd" | "branch" | "model" | "ctxOk" | "ctxWarn" | "ctxError";

const ROLE_THEME_TOKENS = {
	cwd: "accent",
	branch: "mdLinkUrl",
	model: "accent",
	ctxOk: "success",
	ctxWarn: "warning",
	ctxError: "error",
} as const;

const CAMPBELL_EXAMPLE = `{
	"colors": {
		"cwd": "#61D6D6",
		"branch": "#FF7FFF",
		"model": "#3B78FF",
		"ctxOk": "#16C60C",
		"ctxWarn": "#F9F1A5",
		"ctxError": "#E74856"
	}
}`;

function readPaletteConfig(notify: (msg: string) => void): Partial<Record<ColorRole, string>> {
	let raw: string;
	try {
		raw = readFileSync(join(getAgentDir(), CONFIG_FILE), "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
			notify(`colored-footer: could not read ${CONFIG_FILE}; using theme colors`);
		}
		return {};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		notify(`colored-footer: ${CONFIG_FILE} is not valid JSON; using theme colors. Example: ${CAMPBELL_EXAMPLE}`);
		return {};
	}
	const colors = (parsed as { colors?: unknown } | null)?.colors;
	if (colors === undefined || colors === "theme") return {};
	if (typeof colors !== "object" || colors === null || Array.isArray(colors)) {
		notify(`colored-footer: "colors" in ${CONFIG_FILE} must be an object or "theme"; using theme colors`);
		return {};
	}
	const palette: Partial<Record<ColorRole, string>> = {};
	for (const role of Object.keys(ROLE_THEME_TOKENS) as ColorRole[]) {
		const value = (colors as Record<string, unknown>)[role];
		if (value === undefined) continue;
		if (typeof value !== "string") {
			notify(`colored-footer: colors.${role} in ${CONFIG_FILE} must be a hex color string; using the theme color`);
			continue;
		}
		try {
			parseColor(value);
			palette[role] = value;
		} catch {
			notify(`colored-footer: colors.${role} "${value}" in ${CONFIG_FILE} is not a valid color; using the theme color`);
		}
	}
	return palette;
}

// ── Nerd Font icons ─────────────────────────────────────────────────────────────
const ICON_FOLDER   = "\uF07C";  // nf-fa-folder_open
const ICON_BRANCH   = "\uE725";  // nf-dev-git_branch
const ICON_REPO     = "\uE65B";  // nf-seti-github (repo)
const ICON_MODEL    = "\uEE0D";  // nf-md-robot
const ICON_PR_OPEN   = "\uEA64";  // nf-cod-git_pull_request
const ICON_PR_CLOSED = "\uEBDA";  // nf-cod-git_pull_request_closed
const ICON_PR_DRAFT  = "\uEBDB";  // nf-cod-git_pull_request_draft

// ── Helpers ─────────────────────────────────────────────────────────────────────
function formatTokens(n: number): string {
	if (n < 1000)      return `${n}`;
	if (n < 10_000)    return `${(n / 1000).toFixed(1)}k`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	if (n < 10_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	return `${Math.round(n / 1_000_000)}M`;
}

function sanitize(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function renderLineWithRightItem(left: string, right: string, width: number, edgePadding = 2): string {
	const contentWidth = Math.max(0, width - edgePadding);
	const rightWidth = visibleWidth(right);
	const minPadding = left ? 2 : 0;
	const availableForLeft = Math.max(0, contentWidth - rightWidth - minPadding);
	const truncatedLeft = truncateToWidth(left, availableForLeft);
	const padding = " ".repeat(Math.max(0, contentWidth - visibleWidth(truncatedLeft) - rightWidth));

	return truncatedLeft + padding + right;
}

// ── PR info cache (branch → PrInfo | null) ──────────────────────────────────────
interface PrInfo { number: number; icon: string; }

const prCache = new Map<string, PrInfo | null>();

// ── Repo name cache (cwd → "owner/repo" | null) ─────────────────────────────────
const repoCache = new Map<string, string | null>();

function fetchRepoName(cwd: string): Promise<string | null> {
	return new Promise((resolve) => {
		execFile(
			"git", ["remote", "get-url", "origin"],
			{ cwd, timeout: 5000 },
			(err, stdout) => {
				if (err || !stdout.trim()) {
					resolve(null);
					return;
				}
				const url = stdout.trim();
				// Match owner/repo from git@host:owner/repo.git or https://host/owner/repo.git
				const m = url.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
				resolve(m ? m[1] : null);
			},
		);
	});
}

function fetchPrInfo(cwd: string, branch: string): Promise<PrInfo | null> {
	return new Promise((resolve) => {
		execFile(
			"gh", ["pr", "view", "--json", "number,state,isDraft"],
			{ cwd, timeout: 5000 },
			(err, stdout) => {
				if (err || !stdout.trim()) {
					resolve(null);
				} else {
					try {
						const { number, state, isDraft } = JSON.parse(stdout);
						const icon = isDraft ? ICON_PR_DRAFT
							: state === "CLOSED" ? ICON_PR_CLOSED
							: ICON_PR_OPEN;
						resolve({ number, icon });
					} catch {
						resolve(null);
					}
				}
			},
		);
	});
}

export default function (pi: ExtensionAPI) {
	// Config read once at registration; the palette (possibly empty = theme mode)
	// is captured by the footer factory below.
	let palette: Partial<Record<ColorRole, string>> = {};

	pi.on("session_start", (_event, ctx) => {
		palette = readPaletteConfig((msg) => ctx.ui.notify?.(msg, "warning"));
		ctx.ui.setFooter((tui, theme, footerData) => {
			let lastLookedUpBranch: string | undefined;

			function maybeFetchPr(branch: string) {
				if (branch === lastLookedUpBranch) return;
				lastLookedUpBranch = branch;
				if (!prCache.has(branch)) {
					fetchPrInfo(ctx.cwd ?? ".", branch).then((info) => {
						prCache.set(branch, info);
						tui.requestRender();
					});
				}
			}

			function maybeFetchRepo() {
				const cwd = ctx.cwd ?? ".";
				if (!repoCache.has(cwd)) {
					repoCache.set(cwd, null);
					fetchRepoName(cwd).then((name) => {
						repoCache.set(cwd, name);
						tui.requestRender();
					});
				}
			}

			const unsub = footerData.onBranchChange(() => {
				const b = footerData.getGitBranch();
				if (b) maybeFetchPr(b);
				tui.requestRender();
			});

			// Resolve each role once per factory invocation: custom hexes are
			// parsed once (outside render), theme tokens go straight to theme.fg.
			const customColors = new Map<ColorRole, Color>();
			for (const [role, hex] of Object.entries(palette) as [ColorRole, string][]) {
				customColors.set(role, parseColor(hex));
			}
			const paint = (role: ColorRole, text: string): string => {
				const color = customColors.get(role);
				return color ? theme.style(text, { fg: color }) : theme.fg(ROLE_THEME_TOKENS[role], text);
			};

			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
					// ── Accumulate token/cost stats from current branch ─────────────
					let totalInput = 0, totalOutput = 0, totalCost = 0;

					// Routed model for the most recent turn (e.g. OpenRouter auto router picks one each turn).
					// Take it from the last assistant message so it clears when the latest turn had none.
					let routedModel: string | undefined;
					// The model id the last turn actually requested. When this matches the current model,
					// routedModel is a routing/gateway-alias of the current model; when it differs, the user
					// has switched models and routedModel is stale context from the previous model.
					let lastRequestedModel: string | undefined;
					// Pi thinking level the agent loop requested for the latest assistant
					// response (shown for virtual models, which have no fixed thinking level).
					let lastThinkingLevel: string | undefined;

					for (const e of ctx.sessionManager.getBranch() as SessionEntry[]) {
						if (e.type === "message" && e.message.role === "assistant") {
							const m = e.message as AssistantMessage;
							totalInput  += m.usage.input;
							totalOutput += m.usage.output;
							totalCost   += m.usage.cost.total;
							routedModel = m.responseModel;
							lastRequestedModel = m.model;
							lastThinkingLevel = m.thinkingLevel;
						}
					}

					// ── Context usage ───────────────────────────────────────────────
					const usage = ctx.getContextUsage();
					const ctxPercentNum = usage?.percent ?? 0;

					// ── CWD (normalise separators, shorten home to ~) ───────────────
					const rawCwd  = (ctx.cwd ?? "").replace(/\\/g, "/");
					const home    = os.homedir().replace(/\\/g, "/");
					const shortCwd = rawCwd.toLowerCase().startsWith(home.toLowerCase())
						? "~" + rawCwd.slice(home.length)
						: rawCwd;

					// ── Context circle icon ─────────────────────────────────────────
					let ctxIcon: string, ctxRole: ColorRole;
					if      (ctxPercentNum <  13) { ctxIcon = "󰝦"; ctxRole = "ctxOk";    }
					else if (ctxPercentNum <  38) { ctxIcon = "󰪟"; ctxRole = "ctxOk";    }
					else if (ctxPercentNum <  63) { ctxIcon = "󰪡"; ctxRole = "ctxWarn"; }
					else if (ctxPercentNum <  88) { ctxIcon = "󰪣"; ctxRole = "ctxError"; }
					else if (ctxPercentNum <  98) { ctxIcon = "󰪥"; ctxRole = "ctxError"; }
					else                          { ctxIcon = "󰝥"; ctxRole = "ctxError"; }

					// ─────────────────────────────────────────────────────────────────
					// LINE 1 — directory: cwd
					// ─────────────────────────────────────────────────────────────────
					const line1Parts: string[] = [
						paint("cwd", `${ICON_FOLDER}  ${shortCwd}`),
					];

					// LINE 2 — git: branch [PR icon + number]
					// ─────────────────────────────────────────────────────────────────
					const line2Parts: string[] = [];

					const branch = footerData.getGitBranch();
					if (branch) {
						maybeFetchPr(branch);
						maybeFetchRepo();
						const pr = prCache.get(branch);
						const prSuffix = pr != null ? `  ${pr.icon} ${pr.number}` : "";
						const repo = repoCache.get(ctx.cwd ?? ".");
						const repoPrefix = repo ? `${ICON_REPO}  ${repo}    ` : "";
						line2Parts.push(paint("branch", `${repoPrefix}${ICON_BRANCH} ${branch}${prSuffix}`));
					}

					// ─────────────────────────────────────────────────────────────────
					// LINE 3 — session stats: model  tokens  cost  ctx
					// ─────────────────────────────────────────────────────────────────
					const line3Parts: string[] = [];

					const model = ctx.model;
					if (model) {
						// Virtual models (api "pi-virtual") route to a physical model per
						// turn: ctx.model.id is the virtual id while every assistant message
						// records the physical model it actually ran on. Show that routing
						// (and the thinking level pi requested) from the latest assistant
						// message, matching the built-in footer; the "last turn:" dim
						// segment below must never fire for a virtual model since its
						// m.model never equals the virtual id.
						const isVirtual = (model.api as string) === "pi-virtual";
						const label = (model as any).name ?? model.id ?? "?";
						let modelLabel = label;
						if (isVirtual) {
							if (lastRequestedModel !== undefined) {
								modelLabel += ` \u2192 ${lastRequestedModel}`;
								if (lastThinkingLevel !== undefined) {
									modelLabel += ` \u2022 ${lastThinkingLevel}`;
								}
							}
						} else {
							if (model.reasoning) {
								const lvl = (pi as any).getThinkingLevel?.() ?? "off";
								modelLabel += ` \u2022 ${lvl} effort`;
							}
							if (routedModel && lastRequestedModel === model.id) {
								// Last turn used the current model and the provider reported a different
								// underlying model id (router like openrouter/auto, or a gateway alias).
								modelLabel += ` \u2192 ${routedModel}`;
							}
						}
						line3Parts.push(paint("model", `${ICON_MODEL}  ${modelLabel}`));
						if (!isVirtual && routedModel && lastRequestedModel !== model.id) {
							// Last turn ran on a different model than the current one (user switched).
							// Show it as a separate dim segment so it is not read as a routing of the current model.
							line3Parts.push(theme.fg("dim", `last turn: ${routedModel}`));
						}
					}

					const statsParts: string[] = [];
					if (totalInput)    statsParts.push(`\u2191${formatTokens(totalInput)}`);
					if (totalOutput)   statsParts.push(`\u2193${formatTokens(totalOutput)}`);
					if (totalCost > 0) statsParts.push(`$${totalCost.toFixed(3)}`);
					if (statsParts.length > 0) {
						line3Parts.push(theme.fg("dim", statsParts.join(" ")));
					}

					if (usage?.percent != null) {
						line3Parts.push(paint(ctxRole, `${ctxIcon} ${Math.round(ctxPercentNum)}% context used`));
					}

					const lines = [truncateToWidth(line1Parts.join("  "), width)];
					if (line2Parts.length > 0) {
						lines.push(truncateToWidth(line2Parts.join("  "), width));
					}
					lines.push(renderLineWithRightItem(line3Parts.join("  "), "", width));

					// LINE 3+ — extension statuses (same as default)
					const statuses = footerData.getExtensionStatuses();
					if (statuses.size > 0) {
						const statusLine = Array.from(statuses.entries())
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([, t]) => sanitize(t))
							.join(" ");
						lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
					}

					return lines;
				},
			};
		});
	});
}
