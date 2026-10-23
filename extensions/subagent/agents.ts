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

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
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
};

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

function loadAgentsFromDir(dir: string, source: AgentSource): AgentConfig[] {
	const agents: AgentConfig[] = [];

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
	for (const agent of loadAgentsFromDir(bundledDir, "bundled")) agentMap.set(agent.name, agent);

	if (scope !== "project") {
		for (const agent of loadAgentsFromDir(userDir, "user")) agentMap.set(agent.name, agent);
	}
	if (scope !== "user" && projectAgentsDir) {
		for (const agent of loadAgentsFromDir(projectAgentsDir, "project")) agentMap.set(agent.name, agent);
	}

	applyModelOverrides(agentMap);

	return { agents: Array.from(agentMap.values()), projectAgentsDir };
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
function applyModelOverrides(agentMap: Map<string, AgentConfig>): void {
	const configPath = path.join(getAgentDir(), "subagent.json");
	let raw: unknown;
	try {
		raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			console.warn(`[subagent] could not read ${configPath}; model overrides ignored`);
		}
		return;
	}

	const models = (raw as { models?: unknown } | null)?.models;
	if (typeof models !== "object" || models === null) {
		if (models !== undefined) {
			console.warn(`[subagent] ${configPath}: "models" should be an object of agent name -> model`);
		}
		return;
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
	}
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
					`${a.name} (${a.source}): ${a.description} | model: ${a.model ?? "inherit"} | tools: ${a.tools?.join(", ") ?? "default"}`,
			)
			.join("\n"),
		remaining,
	};
}
