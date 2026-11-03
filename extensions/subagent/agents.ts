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

/** Configured values, before normalization or effective defaults. */
export interface RawPanelConfig {
	models: string[];
	agent: string | null;
	judge: string | null;
	judgeExplicit: boolean;
}

/** Validated configuration used to resolve a panel at call time. */
export interface PanelConfig {
	name: string;
	models: string[];
	agent: string;
	/** Undefined inherits the judge model; null skips merging. */
	judge?: string | null;
	raw: RawPanelConfig;
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
	for (const agent of loadAgentsFromDir(bundledDir, "bundled")) merge(agent);

	if (scope !== "project") {
		for (const agent of loadAgentsFromDir(userDir, "user")) merge(agent);
	}
	if (scope !== "user" && projectAgentsDir) {
		for (const agent of loadAgentsFromDir(projectAgentsDir, "project")) merge(agent);
	}

	const configPath = path.join(getAgentDir(), "subagent.json");
	const raw = readConfiguration(configPath);
	const configuredModels = applyModelOverrides(agentMap, raw, configPath);
	const result = parsePanels((raw as { panels?: unknown } | null)?.panels);
	for (const panel of result.panels) {
		if (!agentMap.has(panel.agent)) {
			panel.diagnostics.push(
				`[subagent] panels.${JSON.stringify(panel.name)}: no agent named ${JSON.stringify(panel.agent)}; preset retained`,
			);
		}
		for (const diagnostic of panel.diagnostics) console.warn(diagnostic);
	}
	for (const ignored of result.ignoredPanels) console.warn(ignored.reason);

	return { agents: Array.from(agentMap.values()), projectAgentsDir, configuredModels, ...result };
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
			console.warn(`[subagent] could not read ${configPath}; configuration ignored`);
		}
		return undefined;
	}
}

/**
 * Applies the per-agent overrides in place and returns the accepted, trimmed
 * map. The return value is what the judge precedence chain reads, because it
 * is the only place that distinguishes a configured override from a
 * frontmatter pin.
 */
function applyModelOverrides(agentMap: Map<string, AgentConfig>, raw: unknown, configPath: string): Record<string, string> {
	const accepted: Record<string, string> = {};
	const models = (raw as { models?: unknown } | null)?.models;
	if (typeof models !== "object" || models === null) {
		if (models !== undefined) {
			console.warn(`[subagent] ${configPath}: "models" should be an object of agent name -> model`);
		}
		return accepted;
	}

	for (const [name, model] of Object.entries(models as Record<string, unknown>)) {
		const agent = agentMap.get(name);
		if (!agent) {
			console.warn(`[subagent] ${configPath}: no agent named "${name}"; model override ignored`);
			continue;
		}
		if (typeof model !== "string" || !model.trim()) {
			console.warn(`[subagent] ${configPath}: models."${name}" should be a non-empty model string`);
			continue;
		}
		agent.model = model.trim();
		accepted[name] = model.trim();
	}
	return accepted;
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
		if (!Array.isArray(entry.models) || entry.models.length === 0) {
			reject('"models" should contain 1 to 4 non-empty model strings');
			continue;
		}
		if (entry.models.length > 4) {
			reject('"models" exceeds the cap of 4 entries');
			continue;
		}
		if (!Array.from(entry.models).every((model) => typeof model === "string" && !!model.trim())) {
			reject('"models" should contain 1 to 4 non-empty model strings');
			continue;
		}
		const agentExplicit = Object.hasOwn(entry, "agent");
		if (agentExplicit && (typeof entry.agent !== "string" || !entry.agent.trim())) {
			reject('"agent" should be a non-empty agent name');
			continue;
		}
		const judgeExplicit = Object.hasOwn(entry, "judge");
		if (judgeExplicit && entry.judge !== null && (typeof entry.judge !== "string" || !entry.judge.trim())) {
			reject('"judge" should be a non-empty model string, "none", or null');
			continue;
		}
		const configuredModels = entry.models as string[];
		const normalizedModels = configuredModels.map((model) => model.trim());
		const models = [...new Set(normalizedModels)];
		const rawJudge = judgeExplicit ? (entry.judge as string | null) : null;
		const judge = rawJudge === null || rawJudge.trim() === "none" ? null : rawJudge.trim();
		panels.push({
			name,
			models,
			agent: agentExplicit ? (entry.agent as string).trim() : "panelist",
			judge: judgeExplicit ? judge : undefined,
			raw: {
				models: [...configuredModels],
				agent: agentExplicit ? (entry.agent as string) : null,
				judge: rawJudge,
				judgeExplicit,
			},
			diagnostics: models.length < configuredModels.length ? [`${prefix} duplicate model IDs removed; preset retained`] : [],
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
	const listed = sortPanelsByName(panels).slice(0, maxItems);
	const remaining = panels.length - listed.length;
	const text = listed
		.map((panel) => {
			const judge = panel.raw.judgeExplicit ? ` (judge: ${panel.judge ?? "none"})` : "";
			const agent = panel.agent !== "panelist" ? ` (agent: ${panel.agent})` : "";
			return `${panel.name}: ${panel.models.join(" + ")}${judge}${agent}`;
		})
		.join("; ");
	return `${text}${remaining > 0 ? ` (+${remaining} more)` : ""}`;
}

/** Prose listing for the model and for humans; `PanelConfig.raw` stays raw. */
export function formatPanelList(panels: PanelConfig[], maxItems = 100): { text: string; remaining: number } {
	const listed = sortPanelsByName(panels).slice(0, maxItems);
	return {
		text:
			listed
				.map((panel) => {
					const judge = panel.raw.judgeExplicit ? (panel.judge === null ? "none" : panel.judge) : "session model";
					return `${panel.name}: ${panel.agent} | ${panel.models.join(" + ")} | judge: ${judge}`;
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
