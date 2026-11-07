/** Streaming comparison; all command text and rule evidence stays in ignored output. */
import { createHash } from "node:crypto";
import { appendFileSync, createReadStream, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import * as configMod from "../../extensions/guard/policy/config.ts";
import * as rulesMod from "../../extensions/guard/policy/rules.ts";
import * as tierMod from "../../extensions/guard/policy/bashtier.ts";
import * as textMod from "../../extensions/guard/policy/shell-text.ts";
import { compileRules, coverageDelta, eligibilityTransition, markerMatchingRules, type APIs } from "./coverage.mts";

async function* rows(path: string): AsyncGenerator<any> {
	for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) if (line.trim()) yield JSON.parse(line);
}

export async function compare(out: string) {
	const read = (name: string) => readFileSync(join(out, name));
	const json = (name: string) => JSON.parse(read(name).toString("utf8"));
	const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");
	const manifest = json("measurement-manifest.json");
	const oldDone = json("baseline-complete.json"), newDone = json("candidate-complete.json");
	if (oldDone.outputSha256 !== hash(read("baseline.jsonl")) || newDone.outputSha256 !== hash(read("candidate.jsonl"))) throw new Error("measurement output hash mismatch");
	if (JSON.stringify({ ...oldDone, outputSha256: null }) !== JSON.stringify({ ...newDone, outputSha256: null })) throw new Error("runner matrices differ");
	if (oldDone.cells !== manifest.cellsPerSide || oldDone.profiles.length !== 7 || oldDone.configs.length !== 2) throw new Error("incomplete matrix");
	const rules = json("baseline-rules.json");
	if (JSON.stringify(rules) !== JSON.stringify(json("candidate-rules.json"))) throw new Error("resolved rules differ between source trees");
	// The candidate tree's policy modules evaluate marker-matching allow rules
	// against each candidate analysis; baselines predate the flag and are not
	// probed for this compatibility signal.
	const api: APIs = { rules: rulesMod, tier: tierMod, text: textMod };
	const cwd = manifest.runtime.cwd;
	const user = json("inputs/user-config.json");
	const markerConfigs = [
		{ name: "user", config: configMod.mergeConfig(user, {}, cwd, homedir()) },
		{ name: "empty", config: configMod.mergeConfig({}, {}, cwd, homedir()) },
	].map((c) => ({ ...c, compiled: compileRules(c.config, api) }));
	const markerMatchingKeys = new Set<string>();
	const inventories = new Map<string, any>();
	for (const config of rules) for (const rule of config.rules) inventories.set(`${config.name}/${rule.slot}:${rule.index}`, { config: config.name, ...rule, oldCommands: 0, newCommands: 0, oldObservedCommands: 0, newObservedCommands: 0, oldProbeCommands: 0, newProbeCommands: 0, lostIds: [], gainedIds: [] });
	const affected = join(out, "affected.jsonl");
	if (existsSync(affected)) throw new Error("refusing to overwrite comparison output");
	writeFileSync(affected, "");
	const before = rows(join(out, "baseline.jsonl"))[Symbol.asyncIterator]();
	const after = rows(join(out, "candidate.jsonl"))[Symbol.asyncIterator]();
	let pairedCommands = 0, pairedCells = 0, changedCells = 0, actionChangingCells = 0, changedRuleIdentityCells = 0, affectedCommands = 0;
	const transitions: Record<string, number> = {};
	const actionTransitions: Record<string, number> = {};
	const observedActionTransitions: Record<string, number> = {};
	const probeActionTransitions: Record<string, number> = {};
	let observedCommands = 0, ruleProbeCommands = 0;
	let tildeEligibilityGains = 0, unexplainedEligibilityGains = 0, eligibilityLosses = 0;
	const byConfigProfile: Record<string, number> = {};
	const seen = new Set<string>();
	for await (const command of rows(join(out, "inputs/commands.jsonl"))) {
		const old = await before.next(), next = await after.next();
		if (old.done || next.done || old.value.id !== command.id || next.value.id !== command.id || seen.has(command.id)) throw new Error("missing, duplicate or misaligned command");
		seen.add(command.id); pairedCommands++;
		const probe = command.tool === "rule-probe";
		if (probe) ruleProbeCommands++; else observedCommands++;
		const changes: any[] = [], coverageChanges: any[] = [];
		for (let i = 0; i < old.value.configs.length; i++) {
			const a = old.value.configs[i], b = next.value.configs[i];
			if (a.name !== b.name || a.cells.length !== b.cells.length) throw new Error("misaligned config");
			for (const match of a.coverage) {
				const r = inventories.get(`${a.name}/${match.key}`);
				r.oldCommands++; r[probe ? "oldProbeCommands" : "oldObservedCommands"]++;
			}
			for (const match of b.coverage) {
				const r = inventories.get(`${b.name}/${match.key}`);
				r.newCommands++; r[probe ? "newProbeCommands" : "newObservedCommands"]++;
			}
			const delta = coverageDelta(a.coverage, b.coverage);
			for (const key of delta.lost) inventories.get(`${a.name}/${key}`).lostIds.push(command.id);
			for (const key of delta.gained) inventories.get(`${b.name}/${key}`).gainedIds.push(command.id);
			if (delta.lost.length || delta.gained.length) coverageChanges.push({ config: a.name, ...delta, before: a.coverage, after: b.coverage });
			for (let j = 0; j < a.cells.length; j++) {
				const x = a.cells[j], y = b.cells[j];
				if (x.profile !== y.profile) throw new Error("misaligned profile");
				pairedCells++;
				if (JSON.stringify(x) === JSON.stringify(y)) continue;
				changedCells++;
				const transition = `${x.action}->${y.action}`;
				transitions[transition] = (transitions[transition] ?? 0) + 1;
				if (x.action !== y.action) {
					actionChangingCells++; actionTransitions[transition] = (actionTransitions[transition] ?? 0) + 1;
					const byOrigin = probe ? probeActionTransitions : observedActionTransitions;
					byOrigin[transition] = (byOrigin[transition] ?? 0) + 1;
				}
				if (x.matchedRule !== y.matchedRule) changedRuleIdentityCells++;
				const cell = `${a.name}/${x.profile}`;
				byConfigProfile[cell] = (byConfigProfile[cell] ?? 0) + 1;
				changes.push({ config: a.name, profile: x.profile, before: x, after: y });
			}
		}
		if (changes.length || coverageChanges.length) {
			affectedCommands++;
			appendFileSync(affected, JSON.stringify({ ...command, changes, coverageChanges, before: old.value.analysis, after: next.value.analysis }) + "\n");
		}
		for (let i = 0; i < markerConfigs.length; i++) {
			for (const match of markerMatchingRules(next.value.analysis, markerConfigs[i].config, markerConfigs[i].compiled, api, true)) {
				markerMatchingKeys.add(`${next.value.configs[i].name}/${match.key}`);
			}
		}
		// Differential eligibility: every step that became allow-eligible must
		// carry only tilde words (see eligibilityTransition for the coverage limit).
		const oldCalls = old.value.analysis?.calls ?? [], newCalls = next.value.analysis?.calls ?? [];
		for (let i = 0; i < Math.min(oldCalls.length, newCalls.length); i++) {
			switch (eligibilityTransition(oldCalls[i], newCalls[i])) {
				case "gain-tilde": tildeEligibilityGains++; break;
				case "gain-unexplained": unexplainedEligibilityGains++; break;
				case "loss": eligibilityLosses++; break;
			}
		}
	}
	if (!(await before.next()).done || !(await after.next()).done || pairedCommands !== manifest.commands || pairedCells !== manifest.cellsPerSide) throw new Error("extra or missing measurement rows");
	const inventory = [...inventories.values()];
	writeFileSync(join(out, "rule-coverage.json"), JSON.stringify(inventory, null, 2) + "\n");
	const changedRules = inventory.filter((r) => r.lostIds.length || r.gainedIds.length);
	const summary = {
		baselineSha: manifest.baselineSha,
		manifestSha256: hash(read("measurement-manifest.json")),
		commands: pairedCommands, observedCommands, ruleProbeCommands, pairedCells, changedCells, actionChangingCells, changedRuleIdentityCells,
		affectedCommands, transitions, actionTransitions, observedActionTransitions, probeActionTransitions, byConfigProfile,
		rules: inventory.length, changedRules: changedRules.length,
		lostAllowRules: changedRules.filter((r) => r.slot === "allow" && r.lostIds.length).length,
		lostSafetyRules: changedRules.filter((r) => r.slot !== "allow" && r.lostIds.length).length,
		gainedSafetyRules: changedRules.filter((r) => r.slot !== "allow" && r.gainedIds.length).length,
		markerMatchingAllowRules: markerMatchingKeys.size,
		tildeEligibilityGains, unexplainedEligibilityGains, eligibilityLosses,
		unexercisedRules: inventory.filter((r) => !r.oldCommands && !r.newCommands).length,
		observedUnexercisedRules: inventory.filter((r) => !r.oldObservedCommands && !r.newObservedCommands).length,
		consistencyErrors: 0,
	};
	writeFileSync(join(out, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
	return summary;
}
