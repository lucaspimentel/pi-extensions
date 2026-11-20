/**
 * Agent discovery and configuration
 *
 * Forked from pi's example extension: examples/extensions/subagent/agents.ts
 *
 * Changes vs upstream:
 *   - discovers agents bundled next to this file (./agents/*.md), always loaded
 *   - precedence: project agents override user agents override bundled agents
 *     (same-name collisions; bundled agents exist so scout/reviewer/worker work
 *     out of the box, while ~/.pi/agent/agents drops can retune them per machine)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";
export type AgentSource = "user" | "project" | "bundled";
export type AgentRole = "delegate" | "internal";

/** One panelist: a model plus the read-only agent that runs it. */
export interface PanelistConfig {
	agent: string;
	model: string;
}

/** Merge step: the agent that merges the answers, plus an optional explicit model. */
export interface JudgeConfig {
	agent: string;
	model?: string;
}

/** Validated configuration used to resolve a panel at call time. */
export interface PanelConfig {
	name: string;
	panelists: PanelistConfig[];
	/** Undefined inherits the judge model chain; null skips merging. */
	judge?: JudgeConfig | null;
	/** Nonfatal warnings, not reasons to reject this preset. */
	diagnostics: string[];
}

export interface IgnoredPanel {
	name: string;
	reason: string;
}

export interface PanelParseResult {
	panels: PanelConfig[];
	ignoredPanels: IgnoredPanel[];
}

export interface AgentConfig {
	name: string;
	role: AgentRole;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
}

export interface AgentDiscoveryResult extends PanelParseResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
	/**
	 * Resolved `<agentDir>/subagent.json` path. Exposed so panel validation can
	 * name the file a user has to edit when no preset is configured or usable,
	 * instead of only saying that nothing is configured.
	 */
	configPath: string;
	/**
	 * Accepted, normalized `models` overrides from `subagent.json` by agent name.
	 * Separate from `AgentConfig.model` because that field also carries a
	 * frontmatter pin, and the judge precedence chain must distinguish the two:
	 * a frontmatter pin is not an extra level between the preset and the session.
	 */
	configuredModels: Record<string, string>;
}

/**
 * Raw agent frontmatter. Values are `unknown` because `parseFrontmatter` runs a
 * real YAML parser, so any scalar or collection can appear here.
 *
 * A type alias rather than an interface: `parseFrontmatter` constrains its
 * parameter to `Record<string, unknown>`, and only an alias picks up the
 * implicit index signature that satisfies it.
 */
type AgentFrontmatter = {
	name?: unknown;
	description?: unknown;
	tools?: unknown;
	model?: unknown;
	role?: unknown;
};

// Keep undeclared roles unresolved until the scope-aware precedence merge.
type LoadedAgentConfig = Omit<AgentConfig, "role"> & { role?: AgentRole };

/**
 * Normalize a frontmatter `tools` value to a list of tool names.
 *
 * Both spellings are valid YAML and both are in use:
 *
 *     tools: read, bash        # string
 *     tools: [read, bash]      # array
 *
 * so accept either. Anything else (a number, a map, a nested list) yields no
 * tools rather than throwing: this runs inside agent discovery, where a single
 * bad file must not take down every other agent in the same directory.
 */
function parseToolList(value: unknown): string[] | undefined {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	const tools = raw
		.filter((t): t is string => typeof t === "string")
		.map((t) => t.trim())
		.filter(Boolean);
	return tools.length > 0 ? tools : undefined;
}

function loadAgentsFromDir(dir: string, source: AgentSource): LoadedAgentConfig[] {
	const agents: LoadedAgentConfig[] = [];

	if (!fs.existsSync(dir)) {
		return agents;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(content);

		if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") {
			continue;
		}

		agents.push({
			name: frontmatter.name,
			role: frontmatter.role === "delegate" || frontmatter.role === "internal" ? frontmatter.role : undefined,
			description: frontmatter.description,
			tools: parseToolList(frontmatter.tools),
			model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, CONFIG_DIR_NAME, "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = path.dirname(currentDir);
	}
}

/**
 * Directory of agents shipped with this extension: ./agents, resolved from this
 * module's own URL so it follows the installed package copy, not the cwd.
 */
function getBundledAgentsDir(): string {
	return path.join(path.dirname(fileURLToPath(import.meta.url)), "agents");
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const bundledDir = getBundledAgentsDir();
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	// Bundled agents load regardless of scope: they are the extension's own
	// defaults, not a trust boundary. User agents override them by name, and
	// project agents override both (matching upstream's project-over-user rule).
	const agentMap = new Map<string, AgentConfig>();
	const merge = (agent: LoadedAgentConfig) => {
		const role = agent.role ?? agentMap.get(agent.name)?.role ?? "delegate";
		agentMap.set(agent.name, { ...agent, role });
	};
	// Every directory is read once: the judge check needs the bundled and user
	// agents even when the requested scope excludes the user dir.
	const bundledAgents = loadAgentsFromDir(bundledDir, "bundled");
	const userAgents = loadAgentsFromDir(userDir, "user");
	const projectAgents = scope !== "user" && projectAgentsDir ? loadAgentsFromDir(projectAgentsDir, "project") : [];
	// A `models` override names an agent that this session can resolve from any of
	// those directories, so one for an agent outside the requested scope is not
	// "ignored": the judge resolves at user scope regardless of the request's.
	const knownAgentNames = new Set([...bundledAgents, ...userAgents, ...projectAgents].map((agent) => agent.name));
	for (const agent of bundledAgents) merge(agent);
	if (scope !== "project") {
		for (const agent of userAgents) merge(agent);
	}
	if (scope !== "user" && projectAgentsDir) {
		for (const agent of projectAgents) merge(agent);
	}

	const configPath = path.join(getAgentDir(), "subagent.json");
	const raw = readConfiguration(configPath);
	const configuredModels = applyModelOverrides(agentMap, raw, configPath, knownAgentNames);
	const result = parsePanels((raw as { panels?: unknown } | null)?.panels);
	// The judge resolves at user scope only, so its check has to see bundled and
	// user agents even when the request's scope excluded the user dir: reading
	// them here is not a scope widening, because the run-time lookup reads them
	// too.
	const judgeAgents = new Map<string, AgentConfig>();
	const mergeJudgeAgent = (agent: LoadedAgentConfig) => {
		const role = agent.role ?? judgeAgents.get(agent.name)?.role ?? "delegate";
		judgeAgents.set(agent.name, { ...agent, role });
	};
	for (const agent of bundledAgents) mergeJudgeAgent(agent);
	for (const agent of userAgents) mergeJudgeAgent(agent);
	for (const panel of result.panels) {
		const label = `[subagent] panels.${JSON.stringify(panel.name)}:`;
		for (const agentName of new Set(panel.panelists.map((panelist) => panelist.agent))) {
			if (!agentMap.has(agentName)) {
				panel.diagnostics.push(`${label} no agent named ${JSON.stringify(agentName)}; preset retained`);
			}
		}
		if (panel.judge !== null) {
			// An omitted `judge` still merges with the bundled default, so the
			// effective agent is checked either way; only `judge: null` disables it.
			const judgeName = panel.judge?.agent ?? "judge";
			const judgeAgent = judgeAgents.get(judgeName);
			if (!judgeAgent) {
				panel.diagnostics.push(`${label} no agent named ${JSON.stringify(judgeName)} for "judge.agent"; preset retained`);
			} else if (judgeAgent.role !== "internal") {
				panel.diagnostics.push(`${label} "judge.agent" agent ${JSON.stringify(judgeName)} is not internal; preset retained`);
			}
		}
		for (const diagnostic of panel.diagnostics) reportDiagnostic(diagnostic);
	}
	for (const ignored of result.ignoredPanels) reportDiagnostic(ignored.reason);

	return { agents: Array.from(agentMap.values()), projectAgentsDir, configPath, configuredModels, ...result };
}

/**
 * Per-agent model overrides from `<agentDir>/subagent.json`:
 *
 *     { "models": { "scout": "baseten/zai-org/GLM-5.3-Flash" } }
 *
 * Lets each bundled agent pin (or switch) its model without duplicating the
 * whole agent file into ~/.pi/agent/agents/. Overrides win over agent
 * frontmatter; a user/project agent file with the same name replaces the
 * bundled agent entirely and is still subject to overrides (its frontmatter
 * model loses to the override, which is the point of configuring it).
 * Malformed files and entries are warned about and ignored.
 */
function readConfiguration(configPath: string): unknown {
	try {
		return JSON.parse(fs.readFileSync(configPath, "utf-8"));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			reportDiagnostic(`[subagent] could not read ${configPath}; configuration ignored`);
		}
		return undefined;
	}
}

/**
 * Applies the per-agent overrides in place and returns the accepted, trimmed
 * map. The return value is what the judge precedence chain reads, because it
 * is the only place that distinguishes a configured override from a
 * frontmatter pin. `knownAgentNames` is every agent this session can resolve
 * from any directory, so an override for an agent outside the requested scope is
 * neither warned about nor dropped as unknown.
 */
function applyModelOverrides(
	agentMap: Map<string, AgentConfig>,
	raw: unknown,
	configPath: string,
	knownAgentNames: ReadonlySet<string>,
): Record<string, string> {
	const accepted: Record<string, string> = {};
	const models = (raw as { models?: unknown } | null)?.models;
	if (typeof models !== "object" || models === null) {
		if (models !== undefined) {
			reportDiagnostic(`[subagent] ${configPath}: "models" should be an object of agent name -> model`);
		}
		return accepted;
	}

	for (const [name, model] of Object.entries(models as Record<string, unknown>)) {
		const agent = agentMap.get(name);
		if (!agent) {
			if (!knownAgentNames.has(name)) reportDiagnostic(`[subagent] ${configPath}: no agent named "${name}"; model override ignored`);
			continue;
		}
		if (typeof model !== "string" || !model.trim()) {
			reportDiagnostic(`[subagent] ${configPath}: models."${name}" should be a non-empty model string`);
			continue;
		}
		agent.model = model.trim();
		accepted[name] = model.trim();
	}
	return accepted;
}

/**
 * A panelist entry: a plain object whose `model` is a non-blank string and
 * whose optional `agent`, when written, is also a non-blank string. An
 * explicitly written `undefined` is not an omission, so it is rejected too.
 */
function isPanelistEntry(value: unknown): boolean {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const entry = value as Record<string, unknown>;
	if (typeof entry.model !== "string" || !entry.model.trim()) return false;
	return !Object.hasOwn(entry, "agent") || (typeof entry.agent === "string" && !!entry.agent.trim());
}

/** A judge value: `null` (skip the merge) or an object with optional non-blank `agent`/`model`. */
function isJudgeEntry(value: unknown): boolean {
	if (value === null) return true;
	if (typeof value !== "object" || Array.isArray(value)) return false;
	const entry = value as Record<string, unknown>;
	if (Object.hasOwn(entry, "agent") && (typeof entry.agent !== "string" || !entry.agent.trim())) return false;
	return !Object.hasOwn(entry, "model") || (typeof entry.model === "string" && !!entry.model.trim());
}

function normalizeJudge(value: unknown): JudgeConfig | null {
	if (value === null) return null;
	const entry = value as Record<string, unknown>;
	const agent = Object.hasOwn(entry, "agent") ? (entry.agent as string).trim() : "judge";
	if (!Object.hasOwn(entry, "model")) return { agent };
	return { agent, model: (entry.model as string).trim() };
}

/**
 * Where agent-discovery diagnostics go.
 *
 * `console.warn` is only safe while pi runs a non-interactive mode: in a TUI
 * session nothing takes over stdout, so an extension's stderr write lands on the
 * terminal row the cursor sits on, which is the editor, and reads as if the user
 * had typed it. The extension therefore installs a sink at `session_start` that
 * reports each problem through `ui.notify`, and this default stays for the
 * modes without a UI (print, json, rpc) and for tests.
 */
let diagnosticSink: ((reason: string) => void) | null = null;

/** Replace the destination for discovery diagnostics; `null` restores the console. */
export function setDiagnosticSink(sink: ((reason: string) => void) | null): void {
	diagnosticSink = sink;
}

/** Report one diagnostic through the installed sink, or the console when there is none. */
export function reportDiagnostic(reason: string): void {
	if (diagnosticSink) diagnosticSink(reason);
	else console.warn(reason);
}

/**
 * The configured `models.<agent>` override for one agent, or undefined.
 *
 * Own-property only: agent names come from user files, and a name matching an
 * `Object.prototype` member (`constructor`, `toString`) would otherwise resolve
 * to the inherited function instead of no override.
 */
export function configuredModel(discovery: AgentDiscoveryResult, agentName: string): string | undefined {
	return Object.hasOwn(discovery.configuredModels, agentName) ? discovery.configuredModels[agentName] : undefined;
}

/** Parse the panels value without I/O, availability checks, or input mutation. */
export function parsePanels(raw: unknown): PanelParseResult {
	const panels: PanelConfig[] = [];
	const ignoredPanels: IgnoredPanel[] = [];
	if (raw === undefined) return { panels, ignoredPanels };
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		ignoredPanels.push({ name: "panels", reason: '[subagent] "panels" should be an object of preset name -> panel' });
		return { panels, ignoredPanels };
	}

	for (const [name, value] of Object.entries(raw)) {
		const prefix = `[subagent] panels.${JSON.stringify(name)}:`;
		const reject = (reason: string) => ignoredPanels.push({ name, reason: `${prefix} ${reason}` });
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			reject("preset should be an object");
			continue;
		}
		const entry = value as Record<string, unknown>;
		// The flat form is refused outright rather than coerced: an upgrade would
		// have to guess which panelist each model belonged to.
		if (Object.hasOwn(entry, "agent") || Object.hasOwn(entry, "models") || (Object.hasOwn(entry, "judge") && typeof entry.judge === "string")) {
			reject(
				'"agent"/"models"/judge string form is no longer accepted; use "panelists": [{"agent": ..., "model": ...}] and "judge": {"agent": ..., "model": ...}',
			);
			continue;
		}
		// `Array.from` first: `every` skips array holes, so a sparse `panelists`
		// array would otherwise pass the shape check and reach normalization.
		const rawPanelists = Array.isArray(entry.panelists) ? Array.from(entry.panelists as unknown[]) : undefined;
		if (!rawPanelists || rawPanelists.length === 0 || !rawPanelists.every(isPanelistEntry)) {
			reject('"panelists" should contain 1 to 4 entries of {"agent"?: non-empty string, "model": non-empty string}');
			continue;
		}
		if (rawPanelists.length > 4) {
			reject('"panelists" exceeds the cap of 4 entries');
			continue;
		}
		const judgeExplicit = Object.hasOwn(entry, "judge");
		if (judgeExplicit && !isJudgeEntry(entry.judge)) {
			reject('"judge" should be null or an object with optional non-empty "agent" and "model" strings');
			continue;
		}
		// One entry per (agent, model) pair: the same model under two different
		// agents is two distinct panelists, so the pair is what identifies a seat.
		const panelists: PanelistConfig[] = [];
		const seen = new Set<string>();
		for (const raw of rawPanelists) {
			const item = raw as Record<string, unknown>;
			const agent = Object.hasOwn(item, "agent") ? (item.agent as string).trim() : "panelist";
			const model = (item.model as string).trim();
			const key = `${agent}\u0000${model}`;
			if (seen.has(key)) continue;
			seen.add(key);
			panelists.push({ agent, model });
		}
		const diagnostics: string[] = [];
		if (panelists.length < rawPanelists.length) {
			diagnostics.push(`${prefix} duplicate panelists removed; preset retained`);
		}
		panels.push({
			name,
			panelists,
			judge: judgeExplicit ? normalizeJudge(entry.judge) : undefined,
			diagnostics,
		});
	}
	return { panels, ignoredPanels };
}

/**
 * Deterministic name ordering for every model-facing agent list. A plain `<`
 * comparison (not `localeCompare`) keeps the output byte-stable across
 * machines and locales, so unchanged files produce identical prompt text and
 * prompt caching is not churned.
 */
export function sortAgentsByName(agents: AgentConfig[]): AgentConfig[] {
	return [...agents].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Compact normalized panel catalog, omitted entirely when no presets are usable. */
export function formatPanelCatalog(panels: PanelConfig[], maxItems = 10): string {
	if (panels.length === 0) return "";
	const listed = sortPanelsByName(panels).slice(0, maxItems).map((panel) => panel.name);
	const remaining = panels.length - listed.length;
	return `${listed.join("; ")}${remaining > 0 ? ` (+${remaining} more)` : ""}`;
}

/** Prose listing for the model and for humans: resolved panelists and judge. */
export function formatPanelList(panels: PanelConfig[], maxItems = 100): { text: string; remaining: number } {
	const listed = sortPanelsByName(panels).slice(0, maxItems);
	return {
		text:
			listed
				.map((panel) => {
					const judge =
						panel.judge === null
							? "none"
							: panel.judge === undefined
								? "judge (inherit)"
								: `${panel.judge.agent} (${panel.judge.model ?? "inherit"})`;
					const panelists = panel.panelists.map((panelist) => `${panelist.agent} (${panelist.model})`).join(" + ");
					return `${panel.name}: ${panelists} | judge: ${judge}`;
				})
				.join("\n") || "none",
		remaining: panels.length - listed.length,
	};
}

function sortPanelsByName(panels: PanelConfig[]): PanelConfig[] {
	return [...panels].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Compact `name (source)` list used by the spawn path's error text. */
export function formatAgentNames(agents: AgentConfig[]): string {
	if (agents.length === 0) return "none";
	return agents.map((a) => `${a.name} (${a.source})`).join(", ");
}

/**
 * Deterministic one-line catalog for the model-facing `subagent` description:
 * `name (source)[ [model: X]]: description`, `; `-joined, with a `...` truncation
 * past `maxDescriptionChars` and a single `(+N more; call subagent_list ...)`
 * suffix when more than `maxItems` agents exist. The caller sorts first.
 */
export function formatAgentCatalog(agents: AgentConfig[], maxItems: number, maxDescriptionChars: number): string {
	if (agents.length === 0) return "none";
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	const entries = listed.map((a) => {
		const description =
			a.description.length > maxDescriptionChars ? `${a.description.slice(0, maxDescriptionChars)}...` : a.description;
		const model = a.model ? ` [model: ${a.model}]` : "";
		return `${a.name} (${a.source})${model}: ${description}`;
	});
	const suffix = remaining > 0 ? ` (+${remaining} more; call subagent_list for the full list)` : "";
	return `${entries.join("; ")}${suffix}`;
}

/**
 * Detailed listing for `subagent_list`: one multi-field line per agent, newline
 * joined. Unlike the description catalog this includes the `tools` list, which
 * is available on demand rather than injected into every request.
 */
export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed
			.map(
				(a) =>
					`${a.name} (${a.source})${a.role === "internal" ? " [internal]" : ""}: ${a.description} | model: ${a.model ?? "inherit"} | tools: ${a.tools?.join(", ") ?? "default"}`,
			)
			.join("\n"),
		remaining,
	};
}
