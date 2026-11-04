/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Forked from pi's example extension:
 *   examples/extensions/subagent/index.ts
 *
 * Changes vs upstream:
 *   - agents.ts additionally discovers agents bundled in ./agents (this dir)
 *   - SingleResult.agentSource includes "bundled"
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports four modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *   - Panel: { panel: "preset", task: "..." } (read-only fan-out merged by a judge)
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	formatReadLineRange,
	getAgentDir,
	getMarkdownTheme,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	type AgentConfig,
	type AgentScope,
	type AgentSource,
	discoverAgents,
	formatAgentCatalog,
	formatAgentList,
	formatAgentNames,
	formatPanelCatalog,
	sortAgentsByName,
} from "./agents.ts";
import { INHERIT_ENV, serializeInheritance } from "../guard/policy/inheritance.ts";
import { queryGuardSnapshot, type GuardSnapshot } from "./guard-snapshot.ts";
import {
	buildPanelJudgeInput,
	buildToolCallSummary,
	truncateTaskOutput,
	type PanelReviewInput,
} from "./panel.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
/** Opt-in per-child wall-clock timeout for the panel phase (panelists and judge). */
const PANEL_CHILD_TIMEOUT_MS = 10 * 60 * 1000;
/** Grace period between SIGTERM and SIGKILL when terminating a child. */
const CHILD_KILL_GRACE_MS = 5 * 1000;
/** Fixed code-reading tool set for the judge, passed by the panel path itself. */
const JUDGE_TOOL_NAMES = ["read", "ffgrep", "fffind", "ls", "git_read", "gh_read"];
const ERROR_REASON_CAP = 160;

/**
 * Preferred tool -> built-in substitute, applied when the preferred tool is not
 * registered in the dispatching session (e.g. ffgrep/fffind come from the
 * optional @ff-labs/pi-fff package). pi silently ignores unknown names in
 * --tools, so without this a missing package would silently strip the agents'
 * search tools down to read/ls.
 */
const TOOL_FALLBACKS: Record<string, string> = { ffgrep: "grep", fffind: "find" };

export function resolveAgentTools(tools: string[], available: Set<string>): string[] | undefined {
	const resolved = tools
		.map((t) => (available.has(t) ? t : TOOL_FALLBACKS[t]))
		.filter((t): t is string => !!t && available.has(t));
	return resolved.length > 0 ? resolved : undefined;
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const lineRange = formatReadLineRange(args.offset, args.limit);
			let text = themeFg("accent", filePath);
			if (lineRange) {
				text += themeFg("warning", lineRange);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

/** Usage without `contextTokens`: never summed across children. */
type UsageTotals = Pick<UsageStats, "input" | "output" | "cacheRead" | "cacheWrite" | "cost" | "turns">;

interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "bundled" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	terminationReason?: "timeout" | "aborted";
	exitSignal?: NodeJS.Signals;
}

interface EffectivePanel {
	name: string;
	agent: string;
	models: string[];
	judge: { agent: string; model?: string } | null;
}

/** A panelist record: `results` in panel mode, never the judge. */
interface PanelistResult extends Omit<SingleResult, "step"> {
	model: string;
	output: string;
	toolCallSummary: string;
}

/** One judge invocation, kept raw even when it failed. */
interface JudgeAttempt extends Omit<SingleResult, "step"> {
	output: string;
}

interface PanelJudgeResult {
	agent: "judge";
	model?: string;
	output: string;
	usage: UsageTotals;
	attempts: JudgeAttempt[];
}

type PanelNoticeKind =
	| "merge-skipped"
	| "merge-failed"
	| "merge-aborted"
	| "partial-merge"
	| "single-model-merge"
	| "no-survivors";

interface PanelNotice {
	kind: PanelNoticeKind;
	reason: string;
}

interface BaseSubagentDetails {
	agentScope: AgentScope;
	projectAgentsDir: string | null;
}

interface DelegateDetails extends BaseSubagentDetails {
	mode: "single" | "parallel" | "chain";
	results: SingleResult[];
}

interface PanelDetails extends BaseSubagentDetails {
	mode: "panel";
	/** Omitted for preflight failures, where no preset was accepted. */
	panel?: EffectivePanel;
	/** Panelists only: the judge lives in `judge`. */
	results: PanelistResult[];
	judge: PanelJudgeResult | null;
	notices: PanelNotice[];
	mergedOutput: string | null;
}

type SubagentDetails = DelegateDetails | PanelDetails;

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

function isFailedResult(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

/** Legacy parallel truncation now delegates to the shared panel helper. */
function truncateParallelOutput(output: string): string {
	return truncateTaskOutput(output);
}

/** Sum the additive usage fields. `contextTokens` is per child and never summed. */
function aggregateUsage(usages: readonly UsageStats[]): UsageTotals {
	const total: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
	for (const usage of usages) {
		total.input += usage.input;
		total.output += usage.output;
		total.cacheRead += usage.cacheRead;
		total.cacheWrite += usage.cacheWrite;
		total.cost += usage.cost;
		total.turns += usage.turns;
	}
	return total;
}

/** One bounded, whitespace-normalized line for content; details keep the raw text. */
function boundedLine(text: string, cap = ERROR_REASON_CAP): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (!normalized) return "(no details)";
	return normalized.length > cap ? `${normalized.slice(0, cap)}...` : normalized;
}

/** Short, actionable failure reason for content and the judge input. */
function failureReason(result: SingleResult): string {
	const reason =
		result.errorMessage ||
		result.stderr.trim() ||
		(result.terminationReason === "timeout"
			? "timed out after 10 minutes"
			: result.terminationReason === "aborted"
				? "aborted"
				: result.stopReason || "failed");
	return boundedLine(reason);
}

function hasNonzeroUsage(usage: UsageStats): boolean {
	return Boolean(usage.input || usage.output || usage.cacheRead || usage.cacheWrite || usage.cost || usage.turns);
}

function usageText(usage: UsageStats | UsageTotals): string {
	return formatUsageStats(usage) || "no usage";
}

/** A judge attempt is a failure on a nonzero exit or an empty (whitespace-only) answer. */
function judgeAttemptFailed(result: SingleResult): boolean {
	return isFailedResult(result) || !getFinalOutput(result.messages).trim();
}

function toJudgeAttempt(result: SingleResult): JudgeAttempt {
	const { step: _step, ...rest } = result;
	return { ...rest, output: getFinalOutput(result.messages) };
}

function buildJudgeResult(output: string, model: string | undefined, attempts: JudgeAttempt[]): PanelJudgeResult {
	return { agent: "judge", model, output, usage: aggregateUsage(attempts.map((attempt) => attempt.usage)), attempts };
}

/** The last judge attempt holds a usable merge. */
function judgeIsMerged(judge: PanelJudgeResult): boolean {
	const last = judge.attempts.at(-1);
	return Boolean(last && !isFailedResult(last) && judge.output.trim());
}

/**
 * Panel notices: the fallback reasons plus the survivor labels. Merge labels
 * only describe a produced merge; when the judge did not merge, the labeled
 * per-model sections already carry the failures. Notices describe a finished
 * run: while any panelist or the judge is still in flight, a survivor count or
 * a merge verdict is not yet meaningful, so the list is empty.
 */
function buildPanelNotices(
	panel: EffectivePanel,
	results: readonly PanelistResult[],
	judge: PanelJudgeResult | null,
	aborted: boolean,
	running: boolean,
): PanelNotice[] {
	if (running) return [];
	const failed = results.filter(isFailedResult);
	const survivors = results.filter((result) => !isFailedResult(result));
	if (results.length > 0 && survivors.length === 0) {
		return [
			{
				kind: "no-survivors",
				reason: boundedLine(
					`all ${results.length} panelists failed: ${failed.map((result) => `${result.model} (${failureReason(result)})`).join("; ")}`,
				),
			},
		];
	}

	const notices: PanelNotice[] = [];
	const merged = judge !== null && judgeIsMerged(judge);
	if (!merged) {
		if (judge === null && panel.judge === null) {
			notices.push({ kind: "merge-skipped", reason: 'judge is "none"; per-model sections follow' });
		} else if (aborted) {
			notices.push({ kind: "merge-aborted", reason: "the judge was aborted" });
		} else {
			const lastAttempt = judge?.attempts.at(-1);
			notices.push({
				kind: "merge-failed",
				reason: lastAttempt ? failureReason(lastAttempt) : "the judge did not produce a merge",
			});
		}
	}
	if (merged && survivors.length === 1) {
		notices.push({ kind: "single-model-merge", reason: boundedLine(`only ${survivors[0].model} answered`) });
	}
	if (merged && failed.length > 0) {
		notices.push({
			kind: "partial-merge",
			reason: boundedLine(
				`${failed.length} of ${results.length} panelists failed: ${failed.map((result) => `${result.model} (${failureReason(result)})`).join("; ")}`,
			),
		});
	}
	return notices;
}

/** Capped labeled sections, the fallback whenever there is no merged review. */
function formatLabeledPanelReviews(results: readonly PanelistResult[]): string {
	return results
		.map((result) => {
			const status = isFailedResult(result)
				? `failed${result.stopReason && result.stopReason !== "end" ? ` (${result.stopReason})` : ""}`
				: "completed";
			const body = isFailedResult(result)
				? result.errorMessage || result.stderr || result.output || "(no output)"
				: result.output || "(no output)";
			return `### [${result.model}] ${status}\n\n${truncateTaskOutput(body)}`;
		})
		.join("\n\n---\n\n");
}

/**
 * Model-facing panel content: a plain header, applicable notices, the merged
 * review or the labeled fallback sections, per-model usage, the judge usage
 * line, and one total across every panelist and every judge attempt. Never
 * contains ANSI sequences; dim styling lives in the renderer.
 */
function formatPanelContent(details: PanelDetails): string {
	const panel = details.panel;
	const judge = details.judge;
	const judgeLabel = judge ? judge.model ?? "session model" : "none";
	const modelCount = details.results.length;
	const lines = [`Panel ${panel?.name ?? "(unknown)"} (${modelCount} model${modelCount === 1 ? "" : "s"}; judge: ${judgeLabel})`];
	for (const notice of details.notices) lines.push(`${notice.kind}: ${notice.reason}`);
	lines.push("");
	lines.push(details.mergedOutput !== null ? truncateTaskOutput(details.mergedOutput) : formatLabeledPanelReviews(details.results));

	const usageLines: string[] = [];
	for (const result of details.results) {
		if (!isFailedResult(result)) usageLines.push(`- ${result.model}: ${usageText(result.usage)}`);
	}
	for (const result of details.results) {
		if (!isFailedResult(result)) continue;
		usageLines.push(`- ${result.model} failed: ${failureReason(result)}`);
		if (hasNonzeroUsage(result.usage)) usageLines.push(`  usage: ${usageText(result.usage)}`);
	}
	if (judge) {
		const retryNote = judge.attempts.length > 1 ? ` (${judge.attempts.length} attempts)` : "";
		const lastAttempt = judge.attempts.at(-1);
		const failure = !judgeIsMerged(judge) && lastAttempt ? ` failed: ${failureReason(lastAttempt)}` : "";
		usageLines.push(`- judge ${judge.model ?? "session model"}: ${usageText(judge.usage)}${retryNote}${failure}`);
	}
	if (usageLines.length > 0) lines.push("", ...usageLines);

	const totals = aggregateUsage([
		...details.results.map((result) => result.usage),
		...(judge?.attempts ?? []).map((attempt) => attempt.usage),
	]);
	lines.push("", `Total: ${usageText(totals)}`);
	return lines.join("\n");
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

/**
 * Guard step 5: per-spawn coupling with the parent guard. The snapshot query
 * must run synchronously immediately before spawn; the bootstrap path is the
 * child startup gate passed with --extension.
 */
interface GuardDispatch {
	bootstrapPath: string;
	snapshot: (cwd: string) => GuardSnapshot;
}

/** Absolute path of the child startup gate, resolved next to this module. */
const GUARD_BOOTSTRAP_PATH = fileURLToPath(new URL("./guard-bootstrap.ts", import.meta.url));

type SpawnFunction = typeof spawn;
let spawnOverride: SpawnFunction | null = null;
let bootstrapOverride: string | null = null;

/** Test seam: capture child argv/env and control spawn timing. */
export function setSpawnOverride(fn: SpawnFunction | null): void {
	spawnOverride = fn;
}

/** Test seam: point the child startup gate elsewhere (e.g. a missing file). */
export function setBootstrapPathOverride(path: string | null): void {
	bootstrapOverride = path;
}

/**
 * Directory used by `subagent`'s per-request description rewrite. `prepareLoadout`
 * receives no ctx, so the factory captures the session cwd from the
 * `session_start` / `before_agent_start` handlers (both call this seam). Null
 * until a cwd is known, in which case the declared static description is used.
 */
let agentListCwd: string | null = null;

/** Test seam: seed or clear the cwd used by `prepareLoadout`. */
export function setAgentListCwd(cwd: string | null): void {
	agentListCwd = cwd;
}

function refusedResult(agentName: string, agentSource: SingleResult["agentSource"], task: string, step: number | undefined, reason: string): SingleResult {
	return {
		agent: agentName,
		agentSource,
		task,
		exitCode: 1,
		messages: [],
		stderr: `guard: ${reason}`,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		errorMessage: `guard refused subagent dispatch: ${reason}`,
		step,
	};
}

interface DispatchDefaults {
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

interface ChildOptions {
	/** `null` suppresses agent/session fallback; `undefined` inherits as before. */
	model?: string | null;
	thinkingLevel?: ThinkingLevel;
	tools?: string[];
	/** Opt-in wall-clock timeout; fires the shared kill sequence on expiry. */
	timeoutMs?: number;
	/** `verbatim` passes the task as the whole final argv entry (judge input). */
	promptMode?: "task" | "verbatim";
	/** `result` converts spawn/prompt failures into failed results. */
	failureMode?: "throw" | "result";
	/** `result` returns a failed aborted result instead of throwing. */
	abortMode?: "throw" | "result";
}

interface ChildKillController {
	terminate(): void;
	dispose(): void;
}

/**
 * One shared termination sequence for abort and timeout: idempotent SIGTERM,
 * then SIGKILL after `CHILD_KILL_GRACE_MS` only if the child has not actually
 * exited. `proc.killed` becomes true on SIGTERM and must never gate escalation.
 */
function createChildKillController(proc: ChildProcess): ChildKillController {
	let terminated = false;
	let exited = false;
	let escalation: NodeJS.Timeout | undefined;
	let disposed = false;
	const markExited = () => {
		exited = true;
		if (escalation) {
			clearTimeout(escalation);
			escalation = undefined;
		}
	};
	proc.once("exit", markExited);
	proc.once("close", markExited);
	return {
		terminate() {
			if (terminated || disposed || exited) return;
			terminated = true;
			proc.kill("SIGTERM");
			escalation = setTimeout(() => {
				escalation = undefined;
				if (!exited) proc.kill("SIGKILL");
			}, CHILD_KILL_GRACE_MS);
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			if (escalation) {
				clearTimeout(escalation);
				escalation = undefined;
			}
			proc.removeListener("exit", markExited);
			proc.removeListener("close", markExited);
		},
	};
}

async function runSingleAgent(
	defaultCwd: string,
	dispatchDefaults: DispatchDefaults,
	agents: AgentConfig[],
	availableTools: Set<string>,
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	guard: GuardDispatch,
	child: ChildOptions = {},
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = formatAgentNames(sortAgentsByName(agents.filter((a) => a.role !== "internal")));
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
		};
	}

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	const inheritsDispatchConfig = !agent.model;
	const model = child.model === null ? undefined : child.model ?? agent.model ?? dispatchDefaults.model;
	if (model) args.push("--model", model);
	const thinking = child.thinkingLevel ?? (inheritsDispatchConfig ? dispatchDefaults.thinkingLevel : undefined);
	if (thinking) args.push("--thinking", thinking);
	if (child.tools !== undefined) {
		if (child.tools.length > 0) args.push("--tools", child.tools.join(","));
		else args.push("--no-tools");
	} else if (agent.tools && agent.tools.length > 0) {
		const tools = resolveAgentTools(agent.tools, availableTools);
		if (tools) args.push("--tools", tools.join(","));
	}

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model,
		step,
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};

	// Declared outside the try so the failure-mode catch can tell a deliberate
	// abort/timeout throw apart from a spawn or prompt-preparation failure.
	let wasAborted = false;
	let timedOut = false;

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(child.promptMode === "verbatim" ? task : `Task: ${task}`);

		// Guard step 5: fail-closed dispatch. Every child carries the child
		// startup gate and a fresh snapshot of the parent's effective profile,
		// taken after all asynchronous prompt preparation and immediately
		// before spawn, with no await in between. An unavailable or unsafe
		// parent guard refuses the dispatch instead of defaulting to default.
		if (signal?.aborted) {
			wasAborted = true;
			if (child.abortMode !== "result") throw new Error("Subagent was aborted");
			currentResult.exitCode = 1;
			currentResult.terminationReason = "aborted";
			currentResult.errorMessage = "Subagent was aborted";
			return currentResult;
		}
		const bootstrapPath = bootstrapOverride ?? guard.bootstrapPath;
		if (!fs.existsSync(bootstrapPath)) {
			return refusedResult(agentName, agent.source, task, step, `child startup gate not found: ${bootstrapPath}`);
		}
		const snapshot = guard.snapshot(defaultCwd);
		if (!snapshot.ok) {
			return refusedResult(agentName, agent.source, task, step, snapshot.reason);
		}
		args.push("--extension", bootstrapPath);
		// Only the profile is inherited. The child loads its own guard
		// configuration for its cwd; parent rules, masks, roots, grants, locks,
		// scratch, and workers are never copied. Overriding the key also
		// replaces stale ambient inheritance so nested dispatch reflects the
		// current effective profile.
		const childEnv = { ...process.env, [INHERIT_ENV]: serializeInheritance(snapshot.profile, randomUUID()) };

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const spawnFn = spawnOverride ?? spawn;
			const proc = spawnFn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: childEnv,
			});
			let buffer = "";
			let settled = false;
			let timeoutTimer: NodeJS.Timeout | undefined;
			const killController = createChildKillController(proc);

			const killProc = () => {
				wasAborted = true;
				killController.terminate();
			};

			const settle = (code: number) => {
				if (settled) return;
				settled = true;
				if (timeoutTimer) {
					clearTimeout(timeoutTimer);
					timeoutTimer = undefined;
				}
				signal?.removeEventListener("abort", killProc);
				killController.dispose();
				resolve(code);
			};

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message as Message);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code, exitSignal) => {
				if (buffer.trim()) processLine(buffer);
				if (exitSignal) currentResult.exitSignal = exitSignal;
				settle(code ?? (exitSignal ? 1 : 0));
			});

			proc.on("error", (error) => {
				currentResult.exitCode = 1;
				if (!currentResult.errorMessage) {
					currentResult.errorMessage = error instanceof Error ? error.message : String(error);
				}
				settle(1);
			});

			if (signal) {
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}

			if (child.timeoutMs !== undefined) {
				timeoutTimer = setTimeout(() => {
					timeoutTimer = undefined;
					timedOut = true;
					killController.terminate();
				}, child.timeoutMs);
			}
		});

		currentResult.exitCode = exitCode;
		if (timedOut) {
			currentResult.terminationReason = "timeout";
			currentResult.errorMessage = "timed out after 10 minutes";
			if (currentResult.exitCode === 0) currentResult.exitCode = 1;
		}
		if (wasAborted) {
			currentResult.terminationReason = "aborted";
			if (currentResult.exitCode === 0) currentResult.exitCode = 1;
			if (!currentResult.errorMessage) currentResult.errorMessage = "Subagent was aborted";
		}
		if (wasAborted && child.abortMode !== "result") throw new Error("Subagent was aborted");
		if (timedOut && child.failureMode !== "result") throw new Error("timed out after 10 minutes");
		return currentResult;
	} catch (error) {
		if (child.failureMode !== "result" || wasAborted || timedOut) throw error;
		currentResult.exitCode = currentResult.exitCode === 0 ? 1 : currentResult.exitCode;
		if (!currentResult.errorMessage) {
			currentResult.errorMessage = error instanceof Error ? error.message : String(error);
		}
		return currentResult;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	model: Type.Optional(Type.String({ description: "Explicit model ID (provider/id) for this child" })),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	model: Type.Optional(Type.String({ description: "Explicit model ID (provider/id) for this child" })),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the single agent, or panelist agent override" })),
	task: Type.Optional(Type.String({ description: "Task to delegate, shared by all panelists in panel mode" })),
	model: Type.Optional(Type.String({ description: "Explicit single-mode model ID; use models for panels" })),
	panel: Type.Optional(Type.String({ description: "Named panel preset" })),
	models: Type.Optional(Type.Array(Type.String(), { description: "Panel model overrides (1 to 4 model IDs)" })),
	judge: Type.Optional(Type.Union([Type.String({ description: 'Panel judge model override; "none" or null disables it' }), Type.Null()])),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single or panel mode)" })),
});

const SubagentListAgentSchema = Type.Object({
	name: Type.String(),
	role: StringEnum(["delegate", "internal"] as const),
	source: StringEnum(["user", "project", "bundled"] as const),
	description: Type.String(),
	model: Type.Union([Type.String(), Type.Null()]),
	tools: Type.Array(Type.String()),
});

const RawPanelSchema = Type.Object({
	name: Type.String(),
	agent: Type.Union([Type.String(), Type.Null()]),
	models: Type.Array(Type.String()),
	judge: Type.Union([Type.String(), Type.Null()]),
});
const IgnoredPanelSchema = Type.Object({ name: Type.String(), reason: Type.String() });

const SubagentListParams = Type.Object({
	agentScope: Type.Optional(AgentScopeSchema),
});

const SubagentListOutput = Type.Object({
	agentScope: StringEnum(["user", "project", "both"] as const),
	projectAgentsDir: Type.Union([Type.String(), Type.Null()]),
	agents: Type.Array(SubagentListAgentSchema),
	panels: Type.Array(RawPanelSchema),
	ignoredPanels: Type.Array(IgnoredPanelSchema),
});

interface SubagentListDetails {
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	agents: Array<{ name: string; role: "delegate" | "internal"; source: AgentSource; description: string; model: string | null; tools: string[] }>;
	panels: Array<{ name: string; agent: string | null; models: string[]; judge: string | null }>;
	ignoredPanels: Array<{ name: string; reason: string }>;
}

/** Agent cap and per-agent description cap for the per-request description catalog. */
const DESCRIPTION_MAX_AGENTS = 20;
const DESCRIPTION_MAX_DESCRIPTION_CHARS = 160;

/** Cap for `subagent_list`; high enough that the full list normally fits. */
const SUBAGENT_LIST_MAX_AGENTS = 100;

/**
 * Static base text for the `subagent` tool. A function, not a constant, so the
 * user agents path reflects the environment at call time (relevant after a
 * reload that changes `PI_CODING_AGENT_DIR`).
 */
function baseSubagentDescription(): string {
	return [
		"Delegate tasks to specialized subagents with isolated context.",
		"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder), panel (a named preset fanned out across its read-only models).",
		"Bundled agents are always available; agents in the user agents dir override them by name.",
		`User agents live in ${path.join(getAgentDir(), "agents")}.`,
		`To enable project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: "both" (or "project").`,
		"Call subagent_list to list the discovered agents with their source, model, and tools without spawning anything.",
	].join(" ");
}

/**
 * Per-request description: the static base text plus one deterministic catalog
 * sentence for the scope-"user" agents. Two calls with unchanged files return
 * byte-identical strings (plain name sort, fixed punctuation, no timestamps).
 * The catalog lists only user-scope agents and mentions the project agents dir
 * without naming its agents, so it never implies they are reachable without
 * agentScope: "both". Never throws: returns undefined when no cwd is known.
 */
function buildSubagentDescription(): string | undefined {
	if (agentListCwd === null) return undefined;
	const discovery = discoverAgents(agentListCwd, "user");
	const catalog = formatAgentCatalog(
		sortAgentsByName(discovery.agents.filter((a) => a.role !== "internal")),
		DESCRIPTION_MAX_AGENTS,
		DESCRIPTION_MAX_DESCRIPTION_CHARS,
	);
	const projectNotice =
		discovery.projectAgentsDir !== null
			? ` Project-local agents exist under ${CONFIG_DIR_NAME}/agents but are not listed here; pass agentScope: "both" to subagent or subagent_list to include them.`
			: "";
	const panels = formatPanelCatalog(discovery.panels.filter((p) => discovery.agents.some((a) => a.name === p.agent && a.role !== "internal")));
	return `${baseSubagentDescription()} Discovered agents for agentScope "user": ${catalog}.${projectNotice}${panels ? ` Panels: ${panels}.` : ""}`;
}

export default function (pi: ExtensionAPI) {
	// Guard step 5: every spawn asks the parent guard for a fresh profile
	// snapshot over the synchronous bus handshake and passes the child startup
	// gate to the child. Fail-closed: dispatch without a working guard refuses.
	const guardDispatch: GuardDispatch = {
		bootstrapPath: bootstrapOverride ?? GUARD_BOOTSTRAP_PATH,
		snapshot: (cwd) => queryGuardSnapshot(pi.events, cwd),
	};
	// prepareLoadout has no ctx, so capture the session cwd from the events that
	// carry one. Before the first event the static description is used.
	pi.on("session_start", (_event, ctx) => {
		setAgentListCwd(ctx.cwd);
	});
	pi.on("before_agent_start", (_event, ctx) => {
		setAgentListCwd(ctx.cwd);
	});
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: baseSubagentDescription(),
		promptSnippet: "Delegate tasks to specialized subagents (single, parallel, chain, panel) or list them",
		promptGuidelines: [
			"Use subagent({panel, task}) to fan one task across a named preset's models; tasks[] with per-item model supports a manual pair.",
			"Use scout for code reconnaissance, planner for implementation plans, researcher for evidence-gathering investigations, worker for edits, and reviewer for code review.",
			'Project-local agents require agentScope: "both"; the default scope lists bundled and user agents only.',
		],
		parameters: SubagentParams,

		prepareLoadout: () => {
			try {
				const description = buildSubagentDescription();
				return description ? { descriptions: { subagent: description } } : undefined;
			} catch {
				return undefined;
			}
		},

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const dispatchDefaults: DispatchDefaults = {
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				thinkingLevel: ctx.thinkingLevel,
			};
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const availableTools = new Set(pi.getAllTools().map((t) => t.name));
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasPanel = params.panel !== undefined;
			const hasSingle = Boolean(params.agent && params.task && !hasPanel);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle) + Number(hasPanel);
			const mode = hasPanel ? "panel" : hasChain ? "chain" : hasTasks ? "parallel" : "single";
			let panel: EffectivePanel | undefined;
			let panelTools: string[] = [];
			const participants: AgentConfig[] = [];
			const dispatchable = sortAgentsByName(agents.filter((a) => a.role !== "internal"));
			const available = formatAgentNames(dispatchable);
			// Legacy modes keep the original detail shape. Panel mode never calls this:
			// the panel block builds PanelDetails with panelists and the judge.
			const makeDetails =
				(mode: SubagentDetails["mode"]) =>
				(results: SingleResult[]): SubagentDetails =>
					mode === "panel"
						? {
								mode: "panel",
								agentScope,
								projectAgentsDir: discovery.projectAgentsDir,
								...(panel ? { panel } : {}),
								results: [],
								judge: null,
								notices: [],
								mergedOutput: null,
							}
						: { mode, agentScope, projectAgentsDir: discovery.projectAgentsDir, results };
			const invalid = (text: string) => ({
				content: [{ type: "text" as const, text: `${text}\nAvailable agents: ${available}` }],
				details: makeDetails(mode)([]),
				isError: true,
			});
			const panelOnly = ["models", "judge"].filter((field) => params[field as "models" | "judge"] !== undefined);
			if (!hasPanel && panelOnly.length) return invalid(`Parameters ${panelOnly.join(", ")} require panel. Use model for a single child.`);
			if (modeCount !== 1 || (hasPanel && (params.tasks !== undefined || params.chain !== undefined))) return invalid("Invalid parameters. Provide exactly one mode. Use agent + task, tasks, chain, or panel + task. Do not combine panel with tasks/chain or combine legacy modes.");
			if (hasTasks && params.tasks!.length > MAX_PARALLEL_TASKS) return invalid(`Too many parallel tasks (${params.tasks!.length}). Max is ${MAX_PARALLEL_TASKS}.`);
			if (params.model !== undefined && mode !== "single") return invalid(`Parameter model is only valid in single mode; use ${hasPanel ? "models for panel" : "per-item model in tasks/chain"}.`);
			if (hasPanel && !params.task) return invalid("Parameter panel requires task. Use subagent({panel, task}).");

			const agentError = (name: string, field: string, internal = false): string | undefined => {
				const agent = agents.find((a) => a.name === name);
				if (!agent) return `Unknown agent: "${name}" in ${field}.`;
				if (!internal && agent.role === "internal") return `Agent "${name}" in ${field} is internal and cannot be dispatched directly or as a panelist. Use subagent({panel, task}) to reach internal judge metadata.`;
				participants.push(agent);
			};
			const usableModels = (ctx.scopedModels ?? []).map(({ model }) => `${model.provider}/${model.id}`).sort();
			const modelError = (model: string, field: string): string | undefined => {
				if (!model.trim()) return `Parameter ${field} must be a nonblank model ID.`;
				if (usableModels.length && !usableModels.includes(model)) return `Unknown or unavailable model "${model}" in ${field}. Usable models: ${usableModels.join(", ")}.`;
			};
			if (hasPanel) {
				const preset = discovery.panels.find((p) => p.name === params.panel);
				if (!preset) return invalid(`Unknown panel "${params.panel}". Configured presets: ${discovery.panels.map((p) => p.name).sort().join(", ") || "none"}.`);
				const rawModels = params.models ?? preset.models;
				if (!rawModels.length || rawModels.length > 4 || rawModels.some((m) => !m.trim())) return invalid("Parameter models must contain 1 to 4 nonblank model IDs.");
				const models = [...new Set(rawModels.map((m) => m.trim()))];
				const agentName = params.agent ?? preset.agent;
				const error = agentError(agentName, "panel.agent");
				if (error) return invalid(error);
				const panelist = agents.find((a) => a.name === agentName)!;
				const forbidden = panelist.tools?.filter((t) => ["write", "edit", "bash"].includes(t)) ?? [];
				if (!panelist.tools?.length) return invalid(`Agent "${agentName}" panel tools declaration is missing or empty; default tools include write, edit, bash. Declare read-only tools explicitly.`);
				if (forbidden.length) return invalid(`Agent "${agentName}" panel tools contains forbidden tools: ${forbidden.join(", ")}. Declare read-only tools instead.`);
				panelTools = resolveAgentTools(panelist.tools.filter((t) => t !== "subagent"), availableTools) ?? [];
				for (let i = 0; i < models.length; i++) {
					const error = modelError(models[i], `models[${i}]`);
					if (error) return invalid(error);
				}
				const selectedJudge = params.judge !== undefined ? params.judge : preset.judge;
				let judge: EffectivePanel["judge"] = null;
				if (selectedJudge !== null && selectedJudge?.trim() !== "none") {
					const error = agentError("judge", "panel.judge", true);
					if (error) return invalid(error);
					const model = selectedJudge?.trim() ?? discovery.configuredModels.judge ?? dispatchDefaults.model;
					if (model !== undefined) {
						const error = modelError(model, "judge");
						if (error) return invalid(error);
					}
					judge = { agent: "judge", model };
				}
				panel = { name: preset.name, agent: agentName, models, judge };
			} else {
				const requests = hasChain ? params.chain! : hasTasks ? params.tasks! : [{ agent: params.agent!, model: params.model }];
				for (let i = 0; i < requests.length; i++) {
					const request = requests[i];
					const field = hasChain ? `chain[${i}]` : hasTasks ? `tasks[${i}]` : "single";
					const error = agentError(request.agent, `${field}.agent`) ?? (request.model !== undefined ? modelError(request.model, `${field}.model`) : undefined);
					if (error) return invalid(error);
				}
			}

			if (
				(agentScope === "project" || agentScope === "both") &&
				confirmProjectAgents &&
				ctx.hasUI &&
				!ctx.isProjectTrusted()
			) {
				const projectAgentsRequested = [...new Set(participants)].filter((a) => a.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(mode)([]),
						};
				}
			}

			if (panel) {
				// Panelists are read-only, run with explicit model/thinking/tools, and get a
				// fresh guard snapshot per spawn. Their answers are always kept, whether or
				// not the judge merges them.
				const effective = panel;
				const settings = pi.getSettings();
				const panelistSource = agents.find((a) => a.name === effective.agent)!.source;
				const allResults: SingleResult[] = effective.models.map((model) => ({
					agent: effective.agent,
					agentSource: panelistSource,
					task: params.task!,
					exitCode: -1,
					messages: [],
					stderr: "",
					model,
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
				}));
				// A streamed result already reports exit code 0, so completion is tracked
				// separately from the result's own fields.
				const settled = new Set<number>();
				const judgeAttempts: JudgeAttempt[] = [];
				let currentJudge: PanelJudgeResult | null = null;
				// The judge phase is complete only after its attempts settle; until then
				// every streamed emit keeps notices empty.
				let judgeSettled = false;

				const toPanelistResult = (result: SingleResult): PanelistResult => {
					const { step: _step, ...rest } = result;
					return {
						...rest,
						model: result.model ?? "unknown",
						output: getFinalOutput(result.messages),
						toolCallSummary: buildToolCallSummary(result.messages),
					};
				};
				const makePanelDetails = (results: SingleResult[], judge: PanelJudgeResult | null = currentJudge): PanelDetails => {
					const panelists = results.map(toPanelistResult);
					const running = settled.size < allResults.length || (effective.judge !== null && !judgeSettled);
					return {
						mode: "panel",
						agentScope,
						projectAgentsDir: discovery.projectAgentsDir,
						panel: effective,
						results: panelists,
						judge,
						notices: buildPanelNotices(effective, panelists, judge, false, running),
						mergedOutput: judge && judgeIsMerged(judge) ? judge.output : null,
					};
				};
				const emit = () =>
					onUpdate?.({
						content: [{ type: "text" as const, text: `Panel ${effective.name}: ${settled.size}/${allResults.length} done` }],
						details: makePanelDetails(allResults),
					});

				await mapWithConcurrencyLimit(effective.models, MAX_CONCURRENCY, async (model, index) => {
					const result = await runSingleAgent(
						ctx.cwd,
						dispatchDefaults,
						agents,
						availableTools,
						effective.agent,
						params.task!,
						params.cwd,
						undefined,
						signal,
						(partial) => {
							const streamed = partial.details?.results[0];
							if (streamed && !settled.has(index)) {
								// A streamed child already reports exit code 0, so the slot stays
								// pending until the final result lands; otherwise a mid-run render
								// counts a still-running panelist as done.
								allResults[index] = { ...streamed, exitCode: -1 };
								emit();
							}
						},
						(partialResults) => makePanelDetails(partialResults),
						guardDispatch,
						{
							model,
							thinkingLevel: settings.modelThinkingLevels?.[model] ?? ctx.thinkingLevel,
							tools: panelTools,
							timeoutMs: PANEL_CHILD_TIMEOUT_MS,
							failureMode: "result",
						},
					);
					allResults[index] = result;
					settled.add(index);
					emit();
					return result;
				});

				const panelists = allResults.map(toPanelistResult);
				const survivors = panelists.filter((result) => !isFailedResult(result));
				const reviews: PanelReviewInput[] = panelists.map((result) => ({
					model: result.model,
					task: params.task!,
					toolCallSummary: result.toolCallSummary,
					status: isFailedResult(result) ? "failed" : "completed",
					output: result.output,
					error: isFailedResult(result) ? failureReason(result) : undefined,
				}));

				let aborted = false;
				let mergedOutput: string | null = null;
				let judge: PanelJudgeResult | null = null;
				// Zero survivors: no judge call, the failures are returned as an error.
				// Judge disabled (`judge: "none"`): no call, merge-skipped notice.
				if (survivors.length > 0 && effective.judge) {
					const judgeModel = effective.judge.model;
					// The judge tool set is fixed here, never read from the override agent's
					// declaration, so an override cannot widen it.
					const judgeTools = resolveAgentTools(JUDGE_TOOL_NAMES, availableTools) ?? [];
					const judgeThinking =
						judgeModel !== undefined ? settings.modelThinkingLevels?.[judgeModel] ?? ctx.thinkingLevel : ctx.thinkingLevel;
					const judgeInput = buildPanelJudgeInput(reviews);
					const attemptJudge = async (): Promise<SingleResult> =>
						runSingleAgent(
							ctx.cwd,
							dispatchDefaults,
							agents,
							availableTools,
							"judge",
							judgeInput,
							params.cwd,
							undefined,
							signal,
							(partial) => {
								const streamed = partial.details?.results[0];
								if (!streamed) return;
								currentJudge = buildJudgeResult(getFinalOutput(streamed.messages), judgeModel, [...judgeAttempts, toJudgeAttempt(streamed)]);
								emit();
							},
							(partialResults) => {
								const streamed = partialResults[0];
								const streamedJudge = streamed
									? buildJudgeResult(getFinalOutput(streamed.messages), judgeModel, [...judgeAttempts, toJudgeAttempt(streamed)])
									: currentJudge;
								return makePanelDetails(allResults, streamedJudge);
							},
							guardDispatch,
							{
								model: judgeModel ?? null,
								thinkingLevel: judgeThinking,
								tools: judgeTools,
								timeoutMs: PANEL_CHILD_TIMEOUT_MS,
								promptMode: "verbatim",
								failureMode: "result",
								abortMode: "result",
							},
						);

					const first = await attemptJudge();
					judgeAttempts.push(toJudgeAttempt(first));
					currentJudge = buildJudgeResult(getFinalOutput(first.messages), judgeModel, judgeAttempts);
					let finalAttempt: SingleResult | null = first;
					// Exactly one retry after an ordinary failure. Timeout and abort are
					// terminal, and an already-aborted signal skips the retry entirely.
					if (judgeAttemptFailed(first) && !first.terminationReason) {
						if (signal?.aborted) {
							aborted = true;
							finalAttempt = null;
						} else {
							emit();
							const second = await attemptJudge();
							judgeAttempts.push(toJudgeAttempt(second));
							currentJudge = buildJudgeResult(getFinalOutput(second.messages), judgeModel, judgeAttempts);
							finalAttempt = second;
						}
					}
					if (judgeAttempts.some((attempt) => attempt.terminationReason === "aborted")) aborted = true;
					if (finalAttempt && !judgeAttemptFailed(finalAttempt)) mergedOutput = getFinalOutput(finalAttempt.messages);
					judge = buildJudgeResult(finalAttempt ? getFinalOutput(finalAttempt.messages) : "", judgeModel, judgeAttempts);
					judgeSettled = true;
				}

				const details: PanelDetails = {
					mode: "panel",
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					panel: effective,
					results: panelists,
					judge,
					notices: buildPanelNotices(effective, panelists, judge, aborted, false),
					mergedOutput,
				};
				return {
					content: [{ type: "text" as const, text: formatPanelContent(details) }],
					details,
					isError: survivors.length === 0,
				};
			}

			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

					// Create update callback that includes all previous results
					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								// Combine completed results with current streaming result
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									const allResults = [...results, currentResult];
									onUpdate({
										content: partial.content,
										details: makeDetails("chain")(allResults),
									});
								}
							}
						: undefined;

					const result = await runSingleAgent(
						ctx.cwd,
						dispatchDefaults,
						agents,
						availableTools,
						step.agent,
						taskWithContext,
						step.cwd,
						i + 1,
						signal,
						chainUpdate,
						makeDetails("chain"),
						guardDispatch,
						{ model: step.model },
					);
					results.push(result);

					const isError = isFailedResult(result);
					if (isError) {
						const errorMsg = getResultOutput(result);
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` }],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					previousOutput = getFinalOutput(result.messages);
				}
				return {
					content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
					details: makeDetails("chain")(results),
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				// Track all results for streaming updates
				const allResults: SingleResult[] = new Array(params.tasks.length);

				// Initialize placeholder results
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: params.tasks[i].agent,
						agentSource: "unknown",
						task: params.tasks[i].task,
						exitCode: -1, // -1 = still running
						messages: [],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						onUpdate({
							content: [
								{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
					const result = await runSingleAgent(
						ctx.cwd,
						dispatchDefaults,
						agents,
						availableTools,
						t.agent,
						t.task,
						t.cwd,
						undefined,
						signal,
						// Per-task update callback
						(partial) => {
							if (partial.details?.results[0]) {
								allResults[index] = partial.details.results[0];
								emitParallelUpdate();
							}
						},
						makeDetails("parallel"),
						guardDispatch,
						{ model: t.model },
					);
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				});

				const successCount = results.filter((r) => !isFailedResult(r)).length;
				const summaries = results.map((r) => {
					const output = truncateParallelOutput(getResultOutput(r));
					const status = isFailedResult(r)
						? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
						: "completed";
					return `### [${r.agent}] ${status}\n\n${output}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
				};
			}

			if (params.agent && params.task) {
				const result = await runSingleAgent(
					ctx.cwd,
					dispatchDefaults,
					agents,
					availableTools,
					params.agent,
					params.task,
					params.cwd,
					undefined,
					signal,
					onUpdate,
					makeDetails("single"),
					guardDispatch,
					{ model: params.model },
				);
				const isError = isFailedResult(result);
				if (isError) {
					const errorMsg = getResultOutput(result);
					return {
						content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
					details: makeDetails("single")([result]),
				};
			}

			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					// Clean up {previous} placeholder for display
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", step.agent) +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			if (details.mode === "panel") {
				const panel = details.panel;
				const judge = details.judge;
				const modelCount = details.results.length;
				const judgeLabel = judge
					? judge.model ?? "session model"
					: panel?.judge
						? panel.judge.model ?? "session model"
						: "none";
				const plural = modelCount === 1 ? "" : "s";
				const name = panel?.name ?? "(unknown)";
				const header = `${theme.fg("toolTitle", theme.bold(`Panel ${name}`))}${theme.fg("muted", ` (${modelCount} model${plural}; judge: ${judgeLabel})`)}`;
				const running = isPartial || details.results.some((result) => result.exitCode === -1);
				const settledCount = details.results.filter((result) => result.exitCode !== -1).length;
				const survivorCount = details.results.filter(
					(result) => result.exitCode !== -1 && !isFailedResult(result),
				).length;
				const merged = details.mergedOutput !== null;
				const noSurvivors = survivorCount === 0 && settledCount === modelCount;
				const statusIcon = running
					? theme.fg("warning", "⏳")
					: merged
						? theme.fg("success", "✓")
						: noSurvivors
							? theme.fg("error", "✗")
							: theme.fg("warning", "◐");
				const panelistMark = (result: PanelistResult) =>
					result.exitCode === -1
						? theme.fg("warning", "⏳")
						: isFailedResult(result)
							? theme.fg("error", "✗")
							: theme.fg("success", "✓");

				if (!expanded) {
					// Running: derived from details, never from the model-facing content.
					if (running) {
						let text = `${theme.fg("warning", "⏳")} ${header}${theme.fg("accent", ` ${settledCount}/${modelCount} done, ${modelCount - settledCount} running`)}`;
						for (const result of details.results) text += `\n${panelistMark(result)} ${theme.fg("accent", result.model)}`;
						if (judge) {
							const attempt = judge.attempts.length > 1 ? theme.fg("dim", ` (attempt ${judge.attempts.length})`) : "";
							text += `\n${theme.fg("warning", "⏳")} ${theme.fg("accent", `judge ${judgeLabel}`)}${theme.fg("dim", " merging…")}${attempt}`;
						}
						return new Text(text, 0, 0);
					}

					// Collapsed finished: the model-facing content reproduced verbatim with only
					// its metadata lines dimmed (header, notices, and the trailing usage block).
					const raw = result.content[0];
					const body = raw?.type === "text" ? raw.text : "(no output)";
					const lines = body.split("\n");
					const dimmed = new Set<number>();
					dimmed.add(0);
					for (let index = 1; index <= details.notices.length && index < lines.length; index++) dimmed.add(index);
					const last = lines.length - 1;
					if (last >= 0 && lines[last].startsWith("Total: ")) {
						dimmed.add(last);
						let index = last - 1;
						if (index >= 0 && lines[index] === "") index--;
						while (index >= 0 && lines[index] !== "") {
							dimmed.add(index);
							index--;
						}
					}
					const styled = lines
						.map((line, index) => (dimmed.has(index) ? theme.fg("dim", line) : line))
						.join("\n");
					return new Text(`${statusIcon} ${styled}\n${theme.fg("muted", "(Ctrl+O to expand)")}`, 0, 0);
				}

				// Expanded (running or finished): one section per panelist, then the judge
				// with every attempt, then the total.
				const container = new Container();
				container.addChild(new Text(`${statusIcon} ${header}`, 0, 0));
				for (const notice of details.notices)
					container.addChild(new Text(theme.fg("dim", `${notice.kind}: ${notice.reason}`), 0, 0));
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("dim", `Task: ${details.results[0]?.task ?? ""}`), 0, 0));
				if (merged) {
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── merged review ───"), 0, 0));
					container.addChild(new Markdown(details.mergedOutput!.trim(), 0, 0, mdTheme));
				}

				for (const result of details.results) {
					const pending = result.exitCode === -1;
					const failed = !pending && isFailedResult(result);
					container.addChild(new Spacer(1));
					container.addChild(
						new Text(`${theme.fg("muted", "─── ")}${theme.fg("accent", result.model)} ${panelistMark(result)}`, 0, 0),
					);
					for (const item of getDisplayItems(result.messages)) {
						if (item.type === "toolCall")
							container.addChild(
								new Text(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)), 0, 0),
							);
					}
					if (failed) container.addChild(new Text(theme.fg("dim", `Error: ${failureReason(result)}`), 0, 0));
					if (result.output) {
						container.addChild(new Spacer(1));
						if (failed) container.addChild(new Text(theme.fg("dim", "[Incomplete partial answer:]"), 0, 0));
						container.addChild(new Markdown(result.output.trim(), 0, 0, mdTheme));
					}
					// A pending panelist has no usage to report yet; "no usage" would be a
					// statement about a run that has not finished.
					if (!pending) container.addChild(new Text(theme.fg("dim", usageText(result.usage)), 0, 0));
				}

				if (judge) {
					const attempts = judge.attempts.length;
					const judgeMark = running ? theme.fg("warning", "⏳") : merged ? theme.fg("success", "✓") : theme.fg("error", "✗");
					const attemptLabel = attempts > 1 ? theme.fg("muted", ` (${attempts} attempts)`) : "";
					container.addChild(new Spacer(1));
					container.addChild(
						new Text(
							`${theme.fg("muted", "─── ")}${theme.fg("accent", `judge ${judgeLabel}`)} ${judgeMark}${attemptLabel}`,
							0,
							0,
						),
					);
					for (let index = 0; index < attempts; index++) {
						const attempt = judge.attempts[index];
						if (attempts > 1) container.addChild(new Text(theme.fg("muted", `attempt ${index + 1}`), 0, 0));
						if (isFailedResult(attempt)) container.addChild(new Text(theme.fg("dim", `Error: ${failureReason(attempt)}`), 0, 0));
						for (const item of getDisplayItems(attempt.messages)) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)), 0, 0),
								);
						}
						if (attempt.output) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(attempt.output.trim(), 0, 0, mdTheme));
						}
					}
					container.addChild(new Text(theme.fg("dim", usageText(judge.usage)), 0, 0));
				}

				const totals = aggregateUsage([
					...details.results.map((result) => result.usage),
					...(judge?.attempts ?? []).map((attempt) => attempt.usage),
				]);
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("dim", `Total: ${usageText(totals)}`), 0, 0));
				return container;
			}

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = isFailedResult(r);
				const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage)
						container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}


			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg("accent", `${successCount}/${details.results.length} steps`),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const stepUsage = formatUsageStats(r.usage, r.model);
						if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results.map((r) => r.usage)));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view
				let text =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const r of details.results) {
					const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results.map((r) => r.usage)));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const successCount = details.results.filter((r) => r.exitCode !== -1 && !isFailedResult(r)).length;
				const failCount = details.results.filter((r) => r.exitCode !== -1 && isFailedResult(r)).length;
				const isRunning = running > 0;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: failCount > 0
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running`
					: `${successCount}/${details.results.length} tasks`;

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const taskUsage = formatUsageStats(r.usage, r.model);
						if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results.map((r) => r.usage)));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view (or still running)
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon =
						r.exitCode === -1
							? theme.fg("warning", "⏳")
							: isFailedResult(r)
								? theme.fg("error", "✗")
								: theme.fg("success", "✓");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				if (!isRunning) {
					const usageStr = formatUsageStats(aggregateUsage(details.results.map((r) => r.usage)));
					if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});
	pi.registerTool({
		name: "subagent_list",
		label: "Subagent List",
		description: [
			"List the discovered subagents with their source, model, and tools.",
			"Spawns nothing and asks for no confirmation.",
			`Project-local agents in ${CONFIG_DIR_NAME}/agents require agentScope: "both".`,
		].join(" "),
		promptSnippet: "List discovered subagents (source, model, tools) without spawning",
		promptGuidelines: [
			"Use subagent_list to discover which agents are available before dispatching a subagent.",
			'Project-local agents require agentScope: "both"; the default scope lists bundled and user agents only.',
		],
		parameters: SubagentListParams,
		outputSchema: SubagentListOutput,
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = sortAgentsByName(discovery.agents);
			const { text: agentLines, remaining } = formatAgentList(agents, SUBAGENT_LIST_MAX_AGENTS);
			const agentEntries = agents.map((a) => ({
				name: a.name,
				role: a.role,
				source: a.source,
				description: a.description,
				model: a.model ?? null,
				tools: a.tools ?? [],
			}));
			const lines = [
				`subagent_list (agentScope: ${agentScope})`,
				`Agents: ${agents.length}`,
				`Project agents dir: ${discovery.projectAgentsDir ?? "not found"}`,
				agentLines,
			];
			if (remaining > 0) lines.push(`(+${remaining} more)`);
			const panels = discovery.panels.map((p) => ({ name: p.name, agent: p.raw.agent, models: [...p.raw.models], judge: p.raw.judge }));
			const ignoredPanels = discovery.ignoredPanels.map((p) => ({ ...p }));
			const appendRawListing = (label: string, entries: Array<{ name: string }>) => {
				const sorted = [...entries].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
				lines.push(`${label}: ${sorted.length ? "" : "[]"}`);
				lines.push(...sorted.slice(0, SUBAGENT_LIST_MAX_AGENTS).map((entry) => JSON.stringify(entry)));
				if (sorted.length > SUBAGENT_LIST_MAX_AGENTS) lines.push(`(+${sorted.length - SUBAGENT_LIST_MAX_AGENTS} more)`);
			};
			appendRawListing("Panels", panels);
			appendRawListing("Ignored panels", ignoredPanels);
			const details: SubagentListDetails = {
				agentScope,
				projectAgentsDir: discovery.projectAgentsDir,
				agents: agentEntries,
				panels,
				ignoredPanels,
			};
			return {
				content: [{ type: "text" as const, text: lines.join("\n") }],
				structuredContent: {
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					agents: agentEntries,
					panels,
					ignoredPanels,
				},
				details,
			};
		},
	});
}
