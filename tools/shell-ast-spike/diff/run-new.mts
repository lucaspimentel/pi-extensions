/**
 * New-side runner for the shell-ast decision diff: the WORKING TREE guard
 * (shell-ast adapter). It evaluates every corpus command as a host_bash
 * host-shell call, under every profile guard defines and two config variants,
 * and writes hash-keyed JSONL rows for the comparator.
 *
 * The new API requires the analysis: analyze once per command with the real
 * `analyzeHostCommand`, then call the SYNC `decide(policy, call, analysis)` for
 * every cell. "classify" cells are left unresolved and reported as-is.
 *
 * Usage:
 *   node run-new.mts [--corpus PATH] [--out DIR] [--limit N]
 */
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { decide, type PolicyState } from "../../../extensions/guard/policy/decision.ts";
import { analyzeHostCommand } from "../../../extensions/guard/policy/shellast.ts";
import { mergeConfig, loadUserConfigRaw } from "../../../extensions/guard/policy/config.ts";
import { ALL_PROFILES, type Profile } from "../../../extensions/guard/policy/profiles.ts";
import { argValue, hashId, makeJsonlWriter, makeProgress, readCorpus, resetFile, writeJson, writeText } from "./lib.mjs";
import { reasonClass } from "./reason-class.mjs";
import { SHAPE_LABELS, SYNTHETIC } from "./shapes.mjs";

const argv = process.argv.slice(2);
const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const corpusPath = resolve(argValue(argv, "--corpus", resolve(repoRoot, "tools/shell-ast-spike/corpus/commands.jsonl"))!);
const outDir = resolve(argValue(argv, "--out", resolve(repoRoot, "tools/shell-ast-spike/out/diff"))!);
const limitRaw = argValue(argv, "--limit", undefined);
const limit = limitRaw === undefined ? Number.POSITIVE_INFINITY : Number.parseInt(limitRaw, 10);
const cwd = resolve(process.env.DIFF_CWD ?? repoRoot);
const home = homedir();

const emptyWarnings: string[] = [];
const emptyConfig = mergeConfig({}, {}, cwd, home);
const userRaw = loadUserConfigRaw(home, emptyWarnings);
const userConfig = mergeConfig(userRaw, {}, cwd, home);
const CONFIGS: { name: string; config: ReturnType<typeof mergeConfig> }[] = [
	{ name: "user", config: userConfig },
	{ name: "empty", config: emptyConfig },
];

const policies = new Map<string, PolicyState>();
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

const outPath = resolve(outDir, "new.jsonl");
const metaPath = resolve(outDir, "new-meta.jsonl");
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
const progress = makeProgress("new", all.length, 1000);
writeJson(resolve(outDir, "new-manifest.json"), {
	side: "new",
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

/** A wrapper invocation the package does not unwrap (detected on the subject). */
const MANUAL_WRAPPER_RE = /^(?:timeout\s+\S+\s+)?(?:command|xargs|builtin|nocache)(?:\s|$)/;

let done = 0;
for (const row of all) {
	done += 1;
	const h = row.id;
	try {
		// The corpus id is hashId(command); a mismatch would break the join, so
		// surface it as a runner failure rather than silently re-keying.
		if (hashId(row.command) !== h) throw new Error(`corpus id ${h} != hashId ${hashId(row.command)}`);
		const analysis = await analyzeHostCommand(row.command);
		const wrapHits = analysis.calls.filter((c) => MANUAL_WRAPPER_RE.test(c.subject)).length;
		meta.write({
			h,
			tool: row.tool,
			ext: row.tool === "synthetic",
			cause: analysis.cause,
			reason: analysis.reason,
			calls: analysis.calls.length,
			wrappers: wrapHits,
			redirectAware: analysis.calls.filter((c) => c.requiresRedirectAwareAllow).length,
			paramExpansion: analysis.calls.filter((c) => c.hasParameterExpansion).length,
			syntheticShape: SHAPE_LABELS.get(row.command) ?? null,
		});
		for (const { name, config } of CONFIGS) {
			void config;
			for (const profile of ALL_PROFILES as readonly Profile[]) {
				const policy = policies.get(`${name}\0${profile}`)!;
				const decision = decide(policy, { kind: "host-shell", shell: "host-bash", command: row.command }, analysis);
				const rc = reasonClass(decision.reason);
				noteReason(rc, decision.reason);
				rows.write({ h, cfg: name, p: profile, a: decision.action, rc, c: analysis.cause ?? null, ext: row.tool === "synthetic" });
			}
		}
	} catch (err) {
		const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
		failures.push({ h, tool: row.tool, err: msg });
		noteReason("runner.error", msg);
	}
	progress.tick(done);
}

const rowCount = rows.close();
const metaCount = meta.close();
const samples: Record<string, { reason: string; count: number }[]> = {};
for (const [rc, byReason] of reasonSamples) {
	samples[rc] = [...byReason.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);
}
writeJson(resolve(outDir, "new-reason-samples.json"), {
	side: "new",
	userConfigWarnings: emptyWarnings,
	cwd,
	profiles: ALL_PROFILES,
	configs: CONFIGS.map((c) => ({ name: c.name, allow: c.config.hostBash.allow.length, ask: c.config.hostBash.ask.length, deny: c.config.hostBash.deny.length })),
	samples,
	failures,
});
writeText(resolve(outDir, "new-run.done"), `rows=${rowCount} meta=${metaCount} failures=${failures.length}\n`);
console.error(`[new] done: ${rowCount} decision rows, ${metaCount} meta rows, ${failures.length} failures -> ${outPath}`);
