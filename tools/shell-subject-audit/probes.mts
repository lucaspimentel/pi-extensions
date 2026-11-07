/** Append separately-labelled rule probes to a copy of an already frozen corpus. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseRule } from "../../extensions/guard/policy/rules.ts";
import { ruleProbes } from "./coverage.mts";

const args = process.argv.slice(2);
const arg = (key: string) => { const i = args.indexOf(key); if (i < 0 || !args[i + 1]) throw new Error(`${key} is required`); return args[i + 1]; };
const out = resolve(arg("--out"));
const corpusPath = resolve(arg("--corpus"));
const harvestPath = resolve(arg("--harvest"));
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const original = readFileSync(corpusPath);
const provenance = readFileSync(harvestPath);
const harvest = JSON.parse(provenance.toString("utf8"));
if (hash(original) !== harvest.corpusSha256) throw new Error("source corpus hash mismatch");
const commands = original.toString("utf8").trimEnd().split("\n").filter(Boolean).map((line) => JSON.parse(line));
const user = JSON.parse(readFileSync(join(out, "inputs/user-config.json"), "utf8"));
const probes = ruleProbes(user, parseRule);
const byCommand = new Map(commands.map((row) => [row.command, row]));
let added = 0;
for (const probe of probes) {
	const existing = byCommand.get(probe.command);
	if (existing) existing.probes = probe.probes;
	else { commands.push(probe); byCommand.set(probe.command, probe); added++; }
}
if (new Set(commands.map((r) => r.id)).size !== commands.length) throw new Error("duplicate command ID");
const corpus = commands.map((row) => JSON.stringify(row)).join("\n") + "\n";
const destination = join(out, "inputs/commands.jsonl");
const manifestPath = join(out, "inputs/harvest.json");
if (existsSync(destination) || existsSync(manifestPath)) throw new Error("refusing to overwrite frozen inputs");
writeFileSync(destination, corpus);
writeFileSync(manifestPath, JSON.stringify({ ...harvest, corpusSha256: hash(corpus), originalCorpusSha256: hash(original), originalHarvestSha256: hash(provenance), observedCommands: commands.length - added, addedRuleProbes: added, ruleProbeSpecs: probes.length, totalCommands: commands.length, note: "PRIVATE. Observed commands retain their original tool label. tool=rule-probe rows are config-derived specimens, NEVER observations or executable commands." }, null, 2) + "\n");
console.log(JSON.stringify({ observedCommands: commands.length - added, addedRuleProbes: added, totalCommands: commands.length }));
