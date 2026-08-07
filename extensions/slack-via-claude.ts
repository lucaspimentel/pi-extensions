/**
 * Slack via Claude Extension
 *
 * Exposes Slack read operations as Pi tools by spawning `claude --print`
 * with MCP tool access scoped to read-only Slack tools. Piggybacks on the
 * Slack MCP already configured in Claude.ai / Claude Code — no separate
 * Slack app registration required.
 *
 * Tools registered:
 *   slack_search        — search messages, files, channels, and users
 *   slack_read_channel  — read recent messages from a channel
 *   slack_read_thread   — read a complete message thread
 *
 * Invocation pattern:
 *   - Prompt piped via stdin
 *   - --print for headless output
 *   - --no-session-persistence to avoid polluting history
 *   - --allowedTools scoped to read-only Slack MCP tools only
 *   - MAX_THINKING_TOKENS and CLAUDECODE cleared from env
 */

import { Type } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	defineTool,
	formatSize,
	truncateTail,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ── Allowed MCP tools ────────────────────────────────────────────────────────
// Two naming variants cover both the claude.ai Slack MCP (mcp__claude_ai_Slack__)
// and the plugin-based Slack MCP (mcp__plugin_slack_slack__), so the extension
// works regardless of which server name is active in Claude's local config.

const ALLOWED_TOOLS = [
	// claude.ai Slack MCP variants
	"mcp__claude_ai_Slack__slack_read_channel",
	"mcp__claude_ai_Slack__slack_read_thread",
	"mcp__claude_ai_Slack__slack_read_user_profile",
	"mcp__claude_ai_Slack__slack_search_channels",
	"mcp__claude_ai_Slack__slack_search_public",
	"mcp__claude_ai_Slack__slack_search_public_and_private",
	"mcp__claude_ai_Slack__slack_search_users",
	// plugin-based Slack MCP variants
	"mcp__plugin_slack_slack__slack_read_channel",
	"mcp__plugin_slack_slack__slack_read_thread",
	"mcp__plugin_slack_slack__slack_read_user_profile",
	"mcp__plugin_slack_slack__slack_search_channels",
	"mcp__plugin_slack_slack__slack_search_public",
	"mcp__plugin_slack_slack__slack_search_public_and_private",
	"mcp__plugin_slack_slack__slack_search_users",
].join(",");

// ── Claude executable detection (cached) ────────────────────────────────────

let resolvedExe: string | null | undefined; // undefined = not yet probed, null = not found

function detectClaude(): string | null {
	try {
		const r = spawnSync("claude", ["--version"], {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
			timeout: 10_000,
		});
		if (r.status === 0) return "claude";
	} catch {
		// ENOENT or timeout — claude not on PATH
	}
	return null;
}

function getExe(): string | null {
	if (resolvedExe === undefined) resolvedExe = detectClaude();
	return resolvedExe;
}

// ── Claude subprocess helpers ────────────────────────────────────────────────

const DEFAULT_TIMEOUT_SEC = 120;

interface ClaudeResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	durationMs: number;
	timedOut: boolean;
	spawnErr?: Error;
}

async function runClaude(
	prompt: string,
	signal: AbortSignal | undefined,
	timeoutSec = DEFAULT_TIMEOUT_SEC,
): Promise<ClaudeResult> {
	const env = { ...process.env };
	delete env.MAX_THINKING_TOKENS;
	delete env.CLAUDECODE;

	const startedAt = Date.now();

	const child = spawn(
		"claude",
		[
			"--print",
			"--no-session-persistence",
			"--model=sonnet",
			"--disable-slash-commands",
			`--allowedTools=${ALLOWED_TOOLS}`,
		],
		{
			env,
			windowsHide: true,
			stdio: ["pipe", "pipe", "pipe"],
			signal: signal ?? undefined,
		},
	);

	const stdoutChunks: Buffer[] = [];
	const stderrChunks: Buffer[] = [];
	child.stdout.on("data", (d: Buffer) => stdoutChunks.push(d));
	child.stderr.on("data", (d: Buffer) => stderrChunks.push(d));

	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		child.kill();
	}, Math.max(1, timeoutSec) * 1000);

	// Pipe prompt via stdin
	child.stdin.write(prompt, "utf8");
	child.stdin.end();

	const { exitCode, spawnErr } = await new Promise<{
		exitCode: number | null;
		spawnErr?: Error;
	}>((resolve) => {
		child.on("error", (err: Error) => {
			clearTimeout(timer);
			resolve({ exitCode: null, spawnErr: err });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ exitCode: code });
		});
	});

	const durationMs = Date.now() - startedAt;
	return {
		stdout: Buffer.concat(stdoutChunks).toString("utf8"),
		stderr: Buffer.concat(stderrChunks).toString("utf8"),
		exitCode,
		durationMs,
		timedOut,
		spawnErr,
	};
}

function buildResult(r: ClaudeResult, details: Record<string, unknown>) {
	const sections: string[] = [];
	if (r.stdout.length > 0) sections.push(r.stdout.replace(/\r\n/g, "\n").trimEnd());
	if (r.stderr.length > 0) {
		sections.push(`--- stderr ---\n${r.stderr.replace(/\r\n/g, "\n").trimEnd()}`);
	}

	let footer: string;
	if (r.spawnErr) {
		footer = `--- spawn error: ${r.spawnErr.message} (${r.durationMs}ms) ---`;
	} else if (r.timedOut) {
		footer = `--- timed out (${r.durationMs}ms) ---`;
	} else {
		footer = `--- exit ${r.exitCode ?? "null"} (${r.durationMs}ms) ---`;
	}
	sections.push(footer);

	const fullText = sections.join("\n\n");
	const truncation = truncateTail(fullText, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});

	let displayText = truncation.content;
	let fullOutputPath: string | undefined;

	if (truncation.truncated) {
		try {
			const fname = `pi-slack-${Date.now()}-${randomBytes(4).toString("hex")}.txt`;
			fullOutputPath = path.join(os.tmpdir(), fname);
			writeFileSync(fullOutputPath, fullText, "utf8");
			const notice =
				`[Output truncated: kept last ${formatSize(truncation.outputBytes)} of ` +
				`${formatSize(truncation.totalBytes)} (${truncation.totalLines} lines total). ` +
				`Full output: ${fullOutputPath}]`;
			displayText = `${notice}\n\n${displayText}`;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			displayText = `[Output truncated (failed to dump: ${msg})]\n\n${displayText}`;
		}
	}

	const isError =
		r.timedOut || r.spawnErr !== undefined || (r.exitCode !== 0 && r.exitCode !== null);

	return {
		content: [{ type: "text" as const, text: displayText }],
		details: {
			...details,
			exitCode: r.exitCode,
			durationMs: r.durationMs,
			timedOut: r.timedOut,
			fullOutputPath,
		},
		isError,
	};
}

function notFound() {
	return {
		content: [
			{
				type: "text" as const,
				text: "claude CLI not found on PATH. Install Claude Code and ensure `claude` is reachable.",
			},
		],
		details: { exe: null },
		isError: true,
	};
}

function aborted() {
	return {
		content: [{ type: "text" as const, text: "Aborted before execution." }],
		details: { aborted: true },
		isError: true,
	};
}

function progress(text: string, details: Record<string, unknown>) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}

// ── Tool definitions ─────────────────────────────────────────────────────────

const slackSearchTool = defineTool({
	name: "slack_search",
	label: "Search Slack",
	description:
		"Search Slack messages, files, channels, and users using Claude's Slack MCP. " +
		"Searches both public and private channels the authenticated user can access.",
	promptSnippet: "Search Slack messages, channels, and users",
	promptGuidelines: [
		"Use slack_search to find Slack messages, files, channels, or users matching a query.",
	],
	parameters: Type.Object({
		query: Type.String({ description: "Search query — keywords, phrases, or Slack search filters" }),
	}),

	async execute(_toolCallId, params, signal, onUpdate) {
		if (!getExe()) return notFound();
		if (signal?.aborted) return aborted();

		onUpdate?.(progress(`Searching Slack for: ${params.query}`, {
			phase: "searching",
			query: params.query,
		}));

		const prompt =
			`Search Slack for: "${params.query}"\n\n` +
			`Use the available Slack search tools to find relevant messages, files, channels, ` +
			`and users. Return the results clearly formatted, including channel names, usernames, ` +
			`timestamps, and message content.`;

		const result = await runClaude(prompt, signal);
		return buildResult(result, { query: params.query });
	},

	renderCall(args, theme, _context) {
		const query = typeof args?.query === "string" ? args.query : "";
		const label = theme.fg("toolTitle", theme.bold("Search Slack"));
		const queryDisplay = query
			? theme.fg("toolOutput", `"${query}"`)
			: theme.fg("toolOutput", "...");
		return new Text(`${label} ${queryDisplay}`, 0, 0);
	},
});

const slackReadChannelTool = defineTool({
	name: "slack_read_channel",
	label: "Read Slack Channel",
	description: "Read recent messages from a Slack channel using Claude's Slack MCP.",
	promptSnippet: "Read recent messages from a Slack channel",
	promptGuidelines: [
		"Use slack_read_channel to read recent message history from a Slack channel by name or ID.",
	],
	parameters: Type.Object({
		channel: Type.String({ description: "Channel name (e.g. general) or channel ID" }),
		limit: Type.Optional(
			Type.Number({ description: "Number of recent messages to fetch (default: 20)" }),
		),
	}),

	async execute(_toolCallId, params, signal, onUpdate) {
		if (!getExe()) return notFound();
		if (signal?.aborted) return aborted();

		const limit = params.limit ?? 20;
		onUpdate?.(progress(`Reading #${params.channel}...`, {
			phase: "reading_channel",
			channel: params.channel,
			limit,
		}));

		const prompt =
			`Read the ${limit} most recent messages from the Slack channel #${params.channel}.\n\n` +
			`Return the messages in chronological order with username, timestamp, and text for each.`;

		const result = await runClaude(prompt, signal);
		return buildResult(result, { channel: params.channel, limit });
	},

	renderCall(args, theme, _context) {
		const channel = typeof args?.channel === "string" ? args.channel : "";
		const label = theme.fg("toolTitle", theme.bold("Read Slack"));
		const channelDisplay = channel
			? theme.fg("toolOutput", `#${channel}`)
			: theme.fg("toolOutput", "...");
		let text = `${label} ${channelDisplay}`;

		const limit = typeof args?.limit === "number" ? args.limit : undefined;
		if (limit !== undefined) {
			text += theme.fg("muted", ` (limit ${limit})`);
		}

		return new Text(text, 0, 0);
	},
});

const slackReadThreadTool = defineTool({
	name: "slack_read_thread",
	label: "Read Slack Thread",
	description: "Read all messages in a Slack thread using Claude's Slack MCP.",
	promptSnippet: "Read a complete Slack message thread",
	promptGuidelines: [
		"Use slack_read_thread to read all replies in a Slack thread given a channel name and thread timestamp.",
	],
	parameters: Type.Object({
		channel: Type.String({
			description: "Channel name (e.g. general) or channel ID containing the thread",
		}),
		thread_ts: Type.String({
			description:
				"Timestamp of the parent message that starts the thread (e.g. 1234567890.123456)",
		}),
	}),

	async execute(_toolCallId, params, signal, onUpdate) {
		if (!getExe()) return notFound();
		if (signal?.aborted) return aborted();

		onUpdate?.(progress(`Reading thread in #${params.channel}...`, {
			phase: "reading_thread",
			channel: params.channel,
			thread_ts: params.thread_ts,
		}));

		const prompt =
			`Read the complete Slack thread in channel #${params.channel} ` +
			`starting at timestamp ${params.thread_ts}.\n\n` +
			`Return all messages in the thread in chronological order, including the parent ` +
			`message, with username, timestamp, and text for each reply.`;

		const result = await runClaude(prompt, signal);
		return buildResult(result, { channel: params.channel, thread_ts: params.thread_ts });
	},

	renderCall(args, theme, _context) {
		const channel = typeof args?.channel === "string" ? args.channel : "";
		const threadTs = typeof args?.thread_ts === "string" ? args.thread_ts : "";
		const label = theme.fg("toolTitle", theme.bold("Read Slack thread"));
		const channelDisplay = channel
			? theme.fg("toolOutput", `#${channel}`)
			: theme.fg("toolOutput", "...");
		let text = `${label} ${channelDisplay}`;

		if (threadTs) {
			text += theme.fg("muted", ` @${threadTs}`);
		}

		return new Text(text, 0, 0);
	},
});

// ── Extension entry point ────────────────────────────────────────────────────

export default function slackViaClaudeExtension(pi: ExtensionAPI) {
	pi.registerTool(slackSearchTool);
	pi.registerTool(slackReadChannelTool);
	pi.registerTool(slackReadThreadTool);
}
