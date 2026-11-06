// Shared synthetic fixture policy, also used to collect the initial expectations.
import { join } from "node:path";
import { mergeConfig } from "../extensions/guard/policy/config.ts";
import { explainHostShellCommand, type PolicyState } from "../extensions/guard/policy/decision.ts";
import { analyzeHostCommand } from "../extensions/guard/policy/shellast.ts";
import type { Profile } from "../extensions/guard/policy/profiles.ts";

export function fixtureContext(root: string) {
	const replacements: Record<string, string> = {
		"{{CWD}}": join(root, "workspace"),
		"{{READ}}": join(root, "read"),
		"{{WRITE}}": join(root, "write"),
		"{{OUTSIDE}}": join(root, "outside"),
		"{{ITEM_ID}}": "synthetic-item",
	};
	const expand = (text: string) => Object.entries(replacements).reduce((s, [key, value]) => s.replaceAll(key, value), text);
	const config = mergeConfig({
		readRoots: [replacements["{{READ}}"]],
		writeRoots: [replacements["{{WRITE}}"]],
		hostBash: {
			allow: ["HostBash(fixture-tool *)", "HostBash(echo *)", "HostBash(fixture-write * > {{OUTSIDE}}/approved)", "Pwsh(Get-Fixture *)"].map(expand),
			ask: ["HostBash(fixture-ask *)"],
			deny: ["HostBash(fixture-deny *)"],
		},
	}, {}, replacements["{{CWD}}"]);
	return { replacements, expand, config };
}

export interface Fixture {
	id: string;
	command: string;
	profile: Profile;
	shell: "host-bash" | "pwsh";
	source?: string;
	sampleCause?: string;
	expected: Awaited<ReturnType<typeof observeFixture>>;
}

export async function observeFixture(row: Pick<Fixture, "command" | "profile" | "shell">, root: string) {
	const { expand, config, replacements } = fixtureContext(root);
	const command = expand(row.command);
	const analysis = row.shell === "host-bash" ? await analyzeHostCommand(command) : null;
	const policy: PolicyState = { profile: row.profile, config, cwd: config.cwd, sandboxMode: "full", interactive: true, workspaceLocked: false };
	const explanation = explainHostShellCommand({ kind: "host-shell", shell: row.shell, command }, policy, analysis);
	const shrink = (s: string | undefined) => s === undefined ? null : Object.entries(replacements).reduce((text, [key, value]) => text.replaceAll(value, key), s);
	return {
		action: explanation.decision.action,
		// These are adapter cause codes, not a classification of reason prose.
		cause: analysis?.cause ?? analysis?.calls.find(c => !c.complete)?.cause ?? (analysis ? "complete" : "not-bash"),
		matchedRule: shrink(explanation.decision.matchedRule),
		steps: explanation.steps.map((step, i) => ({
			action: step.decision.action,
			cause: analysis?.calls[i]?.cause ?? (analysis ? "complete" : "not-bash"),
			matchedRule: shrink(step.decision.matchedRule),
			redirectAware: step.requiresRedirectAwareAllow,
		})),
	};
}
