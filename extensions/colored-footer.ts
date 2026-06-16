/**
 * Colored footer extension for pi
 *
 * Line 1 (colored):   cwd
 * Line 2 (colored):   branch [PR icon + number]
 * Line 3 (stats):     model • thinking   ↑10 ↓5.4k $0.285   ctx-icon X% context used        
 * Line 4+:            extension statuses (if any)
 *
 * Colors use the Campbell scheme, matching ~/.claude/statusline-command.sh.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { execFile } from "child_process";
import * as os from "os";

// ── ANSI colors (Campbell color scheme) ────────────────────────────────────────
const C_CYAN    = "\x1b[38;2;97;214;214m";   // #61D6D6 — folder / cwd
const C_MAGENTA = "\x1b[38;2;255;127;255m";  // #FF7FFF — branch
const C_BLUE    = "\x1b[38;2;59;120;255m";   // #3B78FF — model
const C_GREEN   = "\x1b[38;2;22;198;12m";    // #16C60C — ctx ≤37%
const C_YELLOW  = "\x1b[38;2;249;241;165m";  // #F9F1A5 — ctx 38-62%
const C_RED     = "\x1b[38;2;231;72;86m";    // #E74856 — ctx ≥63%
const C_RESET   = "\x1b[0m";

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
	pi.on("session_start", (_event, ctx) => {
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

			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
					// ── Accumulate token/cost stats from current branch ─────────────
					let totalInput = 0, totalOutput = 0, totalCost = 0;

					for (const e of ctx.sessionManager.getBranch() as SessionEntry[]) {
						if (e.type === "message" && e.message.role === "assistant") {
							const m = e.message as AssistantMessage;
							totalInput  += m.usage.input;
							totalOutput += m.usage.output;
							totalCost   += m.usage.cost.total;
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
					let ctxIcon: string, ctxColor: string;
					if      (ctxPercentNum <  13) { ctxIcon = "󰝦"; ctxColor = C_GREEN;  }
					else if (ctxPercentNum <  38) { ctxIcon = "󰪟"; ctxColor = C_GREEN;  }
					else if (ctxPercentNum <  63) { ctxIcon = "󰪡"; ctxColor = C_YELLOW; }
					else if (ctxPercentNum <  88) { ctxIcon = "󰪣"; ctxColor = C_RED;    }
					else if (ctxPercentNum <  98) { ctxIcon = "󰪥"; ctxColor = C_RED;    }
					else                          { ctxIcon = "󰝥"; ctxColor = C_RED;    }

					// ─────────────────────────────────────────────────────────────────
					// LINE 1 — directory: cwd
					// ─────────────────────────────────────────────────────────────────
					const line1Parts: string[] = [
						`${C_CYAN}${ICON_FOLDER}  ${shortCwd}${C_RESET}`,
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
						line2Parts.push(`${C_MAGENTA}${repoPrefix}${ICON_BRANCH} ${branch}${prSuffix}${C_RESET}`);
					}

					// ─────────────────────────────────────────────────────────────────
					// LINE 3 — session stats: model  tokens  cost  ctx
					// ─────────────────────────────────────────────────────────────────
					const line3Parts: string[] = [];

					const model = ctx.model;
					if (model) {
						const label = (model as any).name ?? model.id ?? "?";
						let modelLabel = label;
						if (model.reasoning) {
							const lvl = (pi as any).getThinkingLevel?.() ?? "off";
							modelLabel += ` \u2022 ${lvl} effort`;
						}
						line3Parts.push(`${C_BLUE}${ICON_MODEL}  ${modelLabel}${C_RESET}`);
					}

					const statsParts: string[] = [];
					if (totalInput)    statsParts.push(`\u2191${formatTokens(totalInput)}`);
					if (totalOutput)   statsParts.push(`\u2193${formatTokens(totalOutput)}`);
					if (totalCost > 0) statsParts.push(`$${totalCost.toFixed(3)}`);
					if (statsParts.length > 0) {
						line3Parts.push(theme.fg("dim", statsParts.join(" ")));
					}

					if (usage?.percent != null) {
						line3Parts.push(`${ctxColor}${ctxIcon} ${Math.round(ctxPercentNum)}% context used${C_RESET}`);
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
