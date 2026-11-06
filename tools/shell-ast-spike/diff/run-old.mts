/**
 * Old-side runner for the shell-ast decision diff: HEAD's guard, extracted
 * read-only with `git archive HEAD` into a temp tree OUTSIDE the repo (the
 * working tree holds the new code uncommitted, so HEAD is the pre-adapter
 * implementation).
 *
 * It imports ONLY the old tree's modules (dynamic import from --old), never
 * the working tree's guard. The old `decide(policy, call)` takes no analysis,
 * so it runs the sync path directly.
 *
 * Usage:
 *   node run-old.mts --old /tmp/shellast-diff-old [--corpus PATH] [--out DIR] [--limit N]
 */
import { homedir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import { resolve, join } from "node:path";
import { argValue, hashId, makeJsonlWriter, makeProgress, readCorpus, resetFile, writeJson, writeText } from "./lib.mjs";
import { reasonClass } from "./reason-class.mjs";
import { SHAPE_LABELS, SYNTHETIC } from "./shapes.mjs";

const argv = process.argv.slice(2);
const oldDir = argValue(argv, "--old", undefined);
if (!oldDir) {
	console.error("run-old.mts: --old <extracted HEAD tree> is required");
	process.exit(2);
}
const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const corpusPath = resolve(argValue(argv, "--corpus", resolve(repoRoot, "tools/shell-ast-spike/corpus/commands.jsonl"))!);
const outDir = resolve(argValue(argv, "--out", resolve(repoRoot, "tools/shell-ast-spike/out/diff"))!);
const limitRaw = argValue(argv, "--limit", undefined);
const limit = limitRaw === undefined ? Number.POSITIVE_INFINITY : Number.parseInt(limitRaw, 10);
const cwd = resolve(process.env.DIFF_CWD ?? repoRoot);
const home = homedir();

const guardDir = join(oldDir, "extensions/guard/policy");
const decisionMod: any = await import(pathToFileURL(join(guardDir, "decision.ts")).href);
const configMod: any = await import(pathToFileURL(join(guardDir, "config.ts")).href);
const profilesMod: any = await import(pathToFileURL(join(guardDir, "profiles.ts")).href);

const emptyConfig = configMod.mergeConfig({}, {}, cwd, home);
const userRaw = configMod.loadUserConfigRaw(home, []);
const userConfig = configMod.mergeConfig(userRaw, {}, cwd, home);
const CONFIGS: { name: string; config: any }[] = [
	{ name: "user", config: userConfig },
	{ name: "empty", config: emptyConfig },
];
const ALL_PROFILES: readonly string[] = profilesMod.ALL_PROFILES;

const policies = new Map<string, any>();
for (const { name, config } of CONFIGS) {
	for (const profile of ALL_PROFILES) {
		policies.set(`${name}\0${profile}`, {
			profile,
			config,
			sandboxMode: "full",
			cwd,
			workspaceLocked: false,
			interactive: true,
		});
	}
}

const outPath = resolve(outDir, "old.jsonl");
const metaPath = resolve(outDir, "old-meta.jsonl");
resetFile(outPath);
resetFile(metaPath);
const rows = makeJsonlWriter(outPath);
const meta = makeJsonlWriter(metaPath);
const reasonSamples = new Map<string, Map<string, number>>();
const failures: { h: string; tool: string; err: string }[] = [];

const corpus = readCorpus(corpusPath);
const realRows = Number.isFinite(limit) ? corpus.slice(0, limit) : corpus;
const synthetic = SYNTHETIC.map((command) => ({ id: hashId(command), tool: "synthetic", command }));
const all = [...realRows, ...synthetic];
const progress = makeProgress("old", all.length, 1000);
writeJson(resolve(outDir, "old-manifest.json"), {
	side: "old",
	corpusPath,
	corpusTotal: corpus.length,
	realRows: realRows.length,
	synthetic: synthetic.length,
	profiles: ALL_PROFILES,
	configs: CONFIGS.map((c) => c.name),
	limit: Number.isFinite(limit) ? limit : null,
	cwd,
});

function noteReason(rc: string, reason: string): void {
	let byReason = reasonSamples.get(rc);
	if (byReason === undefined) {
		byReason = new Map();
		reasonSamples.set(rc, byReason);
	}
	byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
}

let done = 0;
for (const row of all) {
	done += 1;
	const h = row.id;
	try {
		meta.write({ h, tool: row.tool, ext: row.tool === "synthetic", syntheticShape: SHAPE_LABELS.get(row.command) ?? null });
		for (const { name, config } of CONFIGS) {
			void config;
			for (const profile of ALL_PROFILES) {
				const policy = policies.get(`${name}\0${profile}`);
				const decision = decisionMod.decide(policy, { kind: "host-shell", shell: "host-bash", command: row.command });
				const rc = reasonClass(decision.reason);
				noteReason(rc, decision.reason);
				rows.write({ h, cfg: name, p: profile, a: decision.action, rc, c: null, ext: row.tool === "synthetic" });
			}
		}
	} catch (err) {
		const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
		failures.push({ h, tool: row.tool, err: msg });
	}
	progress.tick(done);
}

const rowCount = rows.close();
const metaCount = meta.close();
const samples: Record<string, { reason: string; count: number }[]> = {};
for (const [rc, byReason] of reasonSamples) {
	samples[rc] = [...byReason.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);
}
writeJson(resolve(outDir, "old-reason-samples.json"), {
	side: "old",
	oldDir,
	cwd,
	profiles: ALL_PROFILES,
	configs: CONFIGS.map((c) => ({ name: c.name, allow: c.config.hostBash.allow.length, ask: c.config.hostBash.ask.length, deny: c.config.hostBash.deny.length })),
	samples,
	failures,
});
writeText(resolve(outDir, "old-run.done"), `rows=${rowCount} meta=${metaCount} failures=${failures.length}\n`);
console.error(`[old] done: ${rowCount} decision rows, ${metaCount} meta rows, ${failures.length} failures -> ${outPath}`);
