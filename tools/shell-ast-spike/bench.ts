/**
 * Warm comparison over the harvested corpus.
 *
 * Two labelled baselines (the middle column is the honest end-to-end cost,
 * the first is the like-for-like parser cost) against the shell-ast arm:
 *
 *   A  parser-only   splitTopLevelShell(cmd)                       [shellsplit.ts]
 *   B  end-to-end    explainHostShellCommand(host-shell, policy)    [decision.ts]
 *   S  shell-ast     parse(cmd)
 *
 * Timings are per-call nanoseconds from process.hrtime.bigint(). Corpus I/O is
 * never inside a timed region. A parse error on a real command is recorded as
 * an observation, never a gate.
 *
 * Usage:
 *   node bench.ts --corpus corpus/commands.jsonl --out out/warm.json
 *                 [--limit N] [--iters 30] [--warmup 3] [--config real|empty]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { splitTopLevelShell } from "../../extensions/guard/policy/shellsplit.ts";
import { explainHostShellCommand, type PolicyState } from "../../extensions/guard/policy/decision.ts";
import { loadConfig, mergeConfig } from "../../extensions/guard/policy/config.ts";
import { describe, hashId, type Shape } from "./redact.ts";

const shellAst = await import("@questi0nm4rk/shell-ast");
const parse = shellAst.parse;
const findAll = shellAst.findAll;
const resolvedCmd = shellAst.resolvedCmd;

/**
 * Wrappers that invoke another command but are absent from the package's
 * unwrapper registry (verified: both unwrap to `kind: "plain"`). Censused per
 * command so the report can quantify how often the adapter would need a
 * hand walk. The registry subpath is not importable (package `exports` allows
 * only "." and "./semantic"), so this list is observed, not derived.
 */
const MANUAL_WRAPPERS = new Set(["command", "xargs", "builtin", "nocache"]);

interface Timing {
	p50: number;
	p95: number;
	p99: number;
	median: number;
	min: number;
	max: number;
	mean: number;
}

interface CorpusRow {
	id: string;
	tool: "bash" | "host_bash";
	command: string;
}

function argValue(name: string, fallback?: string): string | undefined {
	const argv = process.argv.slice(2);
	const i = argv.indexOf(name);
	if (i !== -1 && i + 1 < argv.length) return argv[i + 1];
	return fallback;
}

function summarize(samplesNs: number[]): Timing {
	const sorted = [...samplesNs].sort((a, b) => a - b);
	const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
	const sum = sorted.reduce((a, b) => a + b, 0);
	return {
		p50: at(0.5),
		p95: at(0.95),
		p99: at(0.99),
		median: at(0.5),
		min: sorted[0]!,
		max: sorted[sorted.length - 1]!,
		mean: sum / sorted.length,
	};
}

function timeSync(fn: () => unknown): number {
	const t = process.hrtime.bigint();
	fn();
	return Number(process.hrtime.bigint() - t);
}

async function timeAsync(fn: () => Promise<unknown>): Promise<number> {
	const t = process.hrtime.bigint();
	await fn();
	return Number(process.hrtime.bigint() - t);
}

function buildPolicy(cwd: string, source: string): PolicyState {
	let config;
	if (source === "empty") {
		config = mergeConfig({}, {}, cwd);
	} else {
		try {
			config = loadConfig(cwd);
		} catch (err) {
			console.warn(`loadConfig failed (${String(err)}); falling back to an empty config`);
			config = mergeConfig({}, {}, cwd);
		}
	}
	return { profile: "default", config, sandboxMode: "full", cwd, workspaceLocked: false, interactive: true };
}

async function main(): Promise<void> {
	const corpusPath = resolve(argValue("--corpus", "corpus/commands.jsonl")!);
	const outPath = resolve(argValue("--out", "out/warm.json")!);
	const limitRaw = argValue("--limit");
	const limit = limitRaw === undefined ? Number.POSITIVE_INFINITY : Number.parseInt(limitRaw, 10);
	const iters = Number.parseInt(argValue("--iters", "30")!, 10);
	const warmup = Number.parseInt(argValue("--warmup", "3")!, 10);
	const configSource = argValue("--config", "real")!;

	if (!existsSync(corpusPath)) throw new Error(`corpus not found: ${corpusPath} (run harvest.ts first)`);
	const all: CorpusRow[] = readFileSync(corpusPath, "utf8")
		.split("\n")
		.filter((l) => l.trim() !== "")
		.map((l) => JSON.parse(l) as CorpusRow);
	const rows = Number.isFinite(limit) ? all.slice(0, limit) : all;

	const policy = buildPolicy(process.cwd(), configSource);
	// One parse before any timing so the wasm load never lands in a warm sample.
	await parse("ls -la");

	const errors = new Map<string, number>();
	const censusErrors = new Map<string, number>();
	const out: any[] = [];
	let done = 0;

	for (const row of rows) {
		const cmd = row.command;

		// Warmup, then timed iterations, per arm, in a tight loop.
		for (let i = 0; i < warmup; i += 1) {
			splitTopLevelShell(cmd);
			explainHostShellCommand({ kind: "host-shell", shell: "host-bash", command: cmd }, policy);
			await parse(cmd).catch(() => undefined);
		}

		const aSamples: number[] = [];
		for (let i = 0; i < iters; i += 1) aSamples.push(timeSync(() => splitTopLevelShell(cmd)));

		const bSamples: number[] = [];
		let tier = "unknown";
		for (let i = 0; i < iters; i += 1) {
			const t = process.hrtime.bigint();
			const explanation = explainHostShellCommand({ kind: "host-shell", shell: "host-bash", command: cmd }, policy);
			bSamples.push(Number(process.hrtime.bigint() - t));
			tier = explanation.decision.action;
		}

		const sSamples: number[] = [];
		let parseError: string | null = null;
		for (let i = 0; i < iters; i += 1) {
			const t = process.hrtime.bigint();
			try {
				await parse(cmd);
			} catch (err) {
				const kind = (err as { kind?: string }).kind ?? (err as Error).constructor?.name ?? "error";
				parseError = kind;
				errors.set(kind, (errors.get(kind) ?? 0) + 1);
			}
			sSamples.push(Number(process.hrtime.bigint() - t));
		}

		const shape: Shape = describe(cmd);
		const a = summarize(aSamples);
		const b = summarize(bSamples);
		const s = summarize(sSamples);

		// One extra parse outside every timed region: census the wrappers the
		// package does not unwrap, which is adapter work, not parser cost.
		let manualWrappers: string[] = [];
		try {
			const ast = await parse(cmd);
			const names = new Set<string>();
			for (const call of findAll(ast, "CallExpr")) {
				const name = resolvedCmd(call);
				if (name !== undefined) names.add(name);
			}
			manualWrappers = [...names].filter((n) => MANUAL_WRAPPERS.has(n));
		} catch (err) {
			// A parse error is already recorded from the timed loop. Anything else
			// here is a harness bug and must not be swallowed silently.
			if (!(err instanceof shellAst.ShellAstError)) {
				censusErrors.set(String((err as Error).message ?? err), (censusErrors.get(String((err as Error).message ?? err)) ?? 0) + 1);
			}
		}

		out.push({
			id: row.id || hashId(cmd),
			tool: row.tool,
			shape,
			tier,
			manualWrappers,
			baselineA: a,
			baselineB: b,
			shellAst: s,
			ratioB: b.median === 0 ? null : s.median / b.median,
			ratioA: a.median === 0 ? null : s.median / a.median,
			parseError,
		});

		done += 1;
		if (done % 200 === 0) console.log(`  ${done}/${rows.length}`);
	}

	const meta = {
		generatedAt: new Date().toISOString(),
		nodeVersion: process.version,
		shellAstVersion: (await import("./shell-ast-version.mjs")).version,
		corpusPath,
		corpusUnique: rows.length,
		corpusAvailable: all.length,
		warmup,
		iters,
		profile: policy.profile,
		configSource,
		cwd: process.cwd(),
	};
	mkdirSync(dirname(outPath), { recursive: true });
	writeFileSync(outPath, JSON.stringify({ meta, errors: Object.fromEntries(errors), rows: out }) + "\n", "utf8");

	const allSummary = summarize(out.flatMap((r) => [r.shellAst.median]));
	const withManualWrappers = out.filter((r) => Array.isArray(r.manualWrappers) && r.manualWrappers.length > 0).length;
	console.log(`bench: ${rows.length} commands x ${iters} iterations`);
	console.log(`  shell-ast parse errors: ${[...errors.entries()].map(([k, v]) => `${k}=${v}`).join(", ") || "none"}`);
	console.log(`  commands needing a manual arg walk (command/xargs/builtin/nocache): ${withManualWrappers}/${out.length}`);
	if (censusErrors.size > 0) console.log(`  CENSUS ERRORS (harness bug): ${[...censusErrors.entries()].map(([k, v]) => `${k} x${v}`).join("; ")}`);
	console.log(`  median-of-medians: A=${(out.reduce((a, r) => a + r.baselineA.median, 0) / out.length).toFixed(0)}ns B=${(out.reduce((a, r) => a + r.baselineB.median, 0) / out.length).toFixed(0)}ns S=${(out.reduce((a, r) => a + r.shellAst.median, 0) / out.length).toFixed(0)}ns`);
	console.log(`  wrote ${outPath}`);
}

await main();
