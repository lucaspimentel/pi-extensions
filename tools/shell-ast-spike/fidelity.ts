/**
 * Fidelity pass over the whole corpus: the things the warm timings do not
 * answer.
 *
 *   1. Which real commands the parser REJECTS (the adapter's fail-closed
 *      cost), and whether `bash -n` also rejects them. A command only
 *      shell-ast rejects is a pure parser gap; one bash also rejects is
 *      malformed input the corpus happened to contain.
 *   2. How often a command invokes a wrapper the package does NOT unwrap
 *      (`command`, `xargs`), i.e. work guard must do by hand.
 *
 * Output is text-free (class labels, counts, shape buckets only). Examples are
 * printed to the console for local inspection and never written to the file.
 *
 * Usage: node fidelity.ts --out out/fidelity.json
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parse, findAll, resolvedCmd, ShellAstError } from "@questi0nm4rk/shell-ast";
import { lenBucket } from "./redact.ts";

const MANUAL_WRAPPERS = new Set(["command", "xargs", "builtin", "nocache"]);

function argValue(name: string, fallback?: string): string | undefined {
	const argv = process.argv.slice(2);
	const i = argv.indexOf(name);
	if (i !== -1 && i + 1 < argv.length) return argv[i + 1];
	return fallback;
}

/** Keep a failure message as a class: drop offsets and any backticked token. */
function classify(message: string): string {
	return message
		.replace(/line \d+/gi, "line N")
		.replace(/col(umn)? \d+/gi, "col N")
		.replace(/`[^`]*`/g, "`<tok>`")
		.replace(/\d+/g, "N")
		.slice(0, 120);
}

interface CorpusRow {
	id: string;
	tool: string;
	command: string;
}

async function main(): Promise<void> {
	const corpusPath = resolve(argValue("--corpus", "corpus/commands.jsonl")!);
	const outPath = resolve(argValue("--out", "out/fidelity.json")!);
	const rows: CorpusRow[] = readFileSync(corpusPath, "utf8")
		.split("\n")
		.filter((l) => l.trim() !== "")
		.map((l) => JSON.parse(l) as CorpusRow);

	const failures: { id: string; tool: string; command: string; message: string }[] = [];
	const manual = new Map<string, number>();
	let manualCommands = 0;
	const lenBuckets: Record<string, number> = {};
	const features = { pipes: 0, andOr: 0, semis: 0, cmdSubst: 0, backticks: 0, procSubst: 0, heredocs: 0, redirects: 0 };

	let done = 0;
	for (const row of rows) {
		let ast: unknown = null;
		try {
			ast = await parse(row.command);
		} catch (err) {
			const message = err instanceof ShellAstError ? `${err.name}: ${err.message}` : `non-ShellAstError: ${String(err)}`;
			failures.push({ id: row.id, tool: row.tool, command: row.command, message });
		}
		if (ast !== null) {
			const names = new Set<string>();
			for (const call of findAll(ast as never, "CallExpr")) {
				const name = resolvedCmd(call);
				if (name !== undefined) names.add(name);
			}
			const hits = [...names].filter((n) => MANUAL_WRAPPERS.has(n));
			if (hits.length > 0) {
				manualCommands += 1;
				for (const h of hits) manual.set(h, (manual.get(h) ?? 0) + 1);
			}
		}
		done += 1;
		if (done % 10000 === 0) console.log(`  ${done}/${rows.length}`);
	}

	// Does bash agree that these are malformed? bash -n parses without running.
	let bashAlsoRejects = 0;
	let bashAccepts = 0;
	const byClass = new Map<string, number>();
	for (const f of failures) {
		const res = spawnSync("bash", ["-n"], { input: f.command, encoding: "utf8" });
		if (res.status === 0) bashAccepts += 1;
		else bashAlsoRejects += 1;
		const key = classify(f.message);
		byClass.set(key, (byClass.get(key) ?? 0) + 1);
		const bucket = lenBucket(Buffer.byteLength(f.command, "utf8"));
		lenBuckets[bucket] = (lenBuckets[bucket] ?? 0) + 1;
		if (/\|/.test(f.command)) features.pipes += 1;
		if (/&&|\|\|/.test(f.command)) features.andOr += 1;
		if (/;/.test(f.command)) features.semis += 1;
		if (/\$\(/.test(f.command)) features.cmdSubst += 1;
		if (/`/.test(f.command)) features.backticks += 1;
		if (/[<>]\(/.test(f.command)) features.procSubst += 1;
		if (/<<-?/.test(f.command)) features.heredocs += 1;
		if (/(^|[^0-9<>])>>?/.test(f.command)) features.redirects += 1;
	}

	const result = {
		meta: { generatedAt: new Date().toISOString(), nodeVersion: process.version, corpus: rows.length },
		parseFailures: {
			unique: failures.length,
			byTool: { bash: failures.filter((f) => f.tool === "bash").length, host_bash: failures.filter((f) => f.tool === "host_bash").length },
			bashAlsoRejects,
			bashAccepts,
			classes: [...byClass.entries()].map(([message, count]) => ({ message, count })).sort((a, b) => b.count - a.count),
			lenBuckets,
			features,
		},
		manualWrappers: { commands: manualCommands, byName: Object.fromEntries([...manual.entries()].sort()) },
	};
	mkdirSync(dirname(outPath), { recursive: true });
	writeFileSync(outPath, JSON.stringify(result, null, "\t") + "\n", "utf8");

	console.log(`fidelity: ${failures.length}/${rows.length} commands rejected; bash -n also rejects ${bashAlsoRejects}, bash accepts ${bashAccepts}`);
	for (const c of result.parseFailures.classes) console.log(`  [${c.count}] ${c.message}`);
	console.log(`  manual-wrapper commands: ${manualCommands}/${rows.length} (${[...manual.entries()].map(([k, v]) => `${k}=${v}`).join(", ") || "none"})`);
	console.log("  examples (local only, never written to the artifact):");
	for (const f of failures.slice(0, 6)) console.log(`    - ${f.command.replace(/\s+/g, " ").slice(0, 70)}  ||  ${f.message.slice(0, 80)}`);
	console.log(`  wrote ${outPath}`);
}

await main();
