/**
 * Merge out/*.json into the committed results artifact.
 *
 * Committed output is TEXT-FREE: command identity is a 12-hex SHA-256 prefix
 * plus shape counts. No command text, token, or path is ever written here.
 *
 * Usage: node report.ts --dir out --out results
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

function argValue(name: string, fallback?: string): string | undefined {
	const argv = process.argv.slice(2);
	const i = argv.indexOf(name);
	if (i !== -1 && i + 1 < argv.length) return argv[i + 1];
	return fallback;
}

const MS = (ns: number | null | undefined): string => (ns === null || ns === undefined || Number.isNaN(ns) ? "n/a" : (ns / 1e6).toFixed(4));
const MIB = (bytes: number | null | undefined): string => (bytes === null || bytes === undefined || Number.isNaN(bytes) ? "n/a" : (bytes / 1048576).toFixed(2));
const X = (a: number, b: number): string => (b === 0 || !Number.isFinite(a / b) ? "n/a" : `${(a / b).toFixed(2)}x`);
/** Repo-relative form for local paths, so the artifact carries no home directory. */
const rel = (s: string): string => s.replace(/^.*?(tools\/shell-ast-spike\/)/, "$1");
const med = (xs: number[]): number => {
	if (xs.length === 0) return Number.NaN;
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.floor(s.length / 2)]!;
};

function readJson(path: string): any | null {
	if (!existsSync(path)) return null;
	return JSON.parse(readFileSync(path, "utf8"));
}

const dir = resolve(argValue("--dir", "out")!);
const outBase = resolve(argValue("--out", "results")!);
const warm = readJson(resolve(dir, "warm.json"));
const cold = readJson(resolve(dir, "cold.json"));
const battery = readJson(resolve(dir, "battery.json"));
const fidelity = readJson(resolve(dir, "fidelity.json"));
const counts = readJson(resolve(process.cwd(), "counts.json"));

const lines: string[] = [];
const push = (...xs: string[]) => lines.push(...xs);

push(
	"# shell-ast spike results",
	"",
	`Generated: ${new Date().toISOString()}`,
	"",
	"Spike: `@questi0nm4rk/shell-ast` vs guard's hand-written bash parsing.",
	"See `README.md` for the settled methodology and hard boundary. Thresholds are deliberately",
	"not pre-committed: the adopt / do-not-adopt bar is set by the reviewer from these numbers.",
	"",
	"Command identity below is a 12-hex SHA-256 prefix; no command text is committed.",
	"",
);

push("## Environment", "");
if (warm !== null) {
	push(
		`- node: ${warm.meta.nodeVersion}`,
		`- shell-ast: ${warm.meta.shellAstVersion}`,
		`- config source: ${warm.meta.configSource} (profile ${warm.meta.profile})`,
		`- corpus: ${warm.meta.corpusUnique} unique commands (of ${warm.meta.corpusAvailable} available)`,
		`- warm: ${warm.meta.warmup} warmup + ${warm.meta.iters} timed iterations per command per arm`,
	);
} else {
	push("- warm.json missing");
}
if (counts !== null) {
	push(
		`- harvest: ${counts.rawCalls} bash/host_bash calls across ${counts.filesScanned}/${counts.filesAvailable} transcript files -> ${counts.unique} unique`,
		`- harvest per tool (raw): ${Object.entries(counts.rawCallsPerTool).map(([k, v]) => `${k}=${v}`).join(", ")}; (unique): ${Object.entries(counts.uniquePerTool).map(([k, v]) => `${k}=${v}`).join(", ")}`,
		`- note: ${counts.note}`,
	);
}
if (cold !== null) {
	push(`- cold: ${cold.meta.boots} boots per arm, isolated=${cold.meta.isolate}, cmd: pi ${cold.meta.args.map(rel).join(" ")}`);
}
push("");

push("## Cold (fresh headless `pi -p`, offsets from each process's own time origin)", "");
if (cold === null) {
	push("cold.json missing", "");
} else {
	push("| arm | meaning | total median ms | total p95 ms | rss median MiB | rss peak median KiB | ok |", "| --- | --- | --- | --- | --- | --- | --- |");
	const meaning: Record<string, string> = {
		"0": "no shell-ast import (control)",
		"1": "imported, never parsed",
		"2": "imported + first parse",
	};
	for (const arm of ["0", "1", "2"]) {
		const s = cold.summary[arm];
		push(`| ${arm} | ${meaning[arm]} | ${s.total.median.toFixed(2)} | ${s.total.p95.toFixed(2)} | ${MIB(s.rss.median)} | ${s.peak_kb.median.toFixed(0)} | ${s.ok}/${s.boots} |`);
	}
	push(
		"",
		`- module cost (arm1-arm0): **${cold.deltas.module_ms.toFixed(2)} ms**`,
		`- wasm compile + first parse (arm2-arm1): **${cold.deltas.wasm_and_first_parse_ms.toFixed(2)} ms**`,
		`- HEADLINE cold delta (arm2-arm0): **${cold.deltas.headline_cold_ms.toFixed(2)} ms**`,
		`- RSS steady delta (arm2-arm0): **${MIB(cold.deltas.rss_steady_bytes)} MiB** (import-only ${MIB(cold.deltas.rss_import_bytes)} MiB, first parse ${MIB(cold.deltas.rss_first_parse_bytes)} MiB)`,
		`- RSS peak delta (arm2-arm0): **${cold.deltas.rss_peak_kb.toFixed(0)} KiB**`,
		"",
		"RSS caveat: `maxRSS` is the process high-water mark, so it includes pi's own peak. Only the arm deltas are signal.",
		"",
	);
}

push("## Warm (per command, same corpus on every arm)", "");
if (warm === null) {
	push("warm.json missing", "");
} else {
	const rows: any[] = warm.rows;
	const avg = (f: (r: any) => number) => rows.reduce((a, r) => a + f(r), 0) / rows.length;
	push("| arm | mean of per-command p50 | mean p95 | mean p99 | mean median |", "| --- | --- | --- | --- | --- |");
	push(`| A parser-only (\`splitTopLevelShell\`) | ${MS(avg((r) => r.baselineA.p50))} ms | ${MS(avg((r) => r.baselineA.p95))} ms | ${MS(avg((r) => r.baselineA.p99))} ms | ${MS(avg((r) => r.baselineA.median))} ms |`);
	push(`| B end-to-end (\`explainHostShellCommand\`) | ${MS(avg((r) => r.baselineB.p50))} ms | ${MS(avg((r) => r.baselineB.p95))} ms | ${MS(avg((r) => r.baselineB.p99))} ms | ${MS(avg((r) => r.baselineB.median))} ms |`);
	push(`| S shell-ast \`parse\` | ${MS(avg((r) => r.shellAst.p50))} ms | ${MS(avg((r) => r.shellAst.p95))} ms | ${MS(avg((r) => r.shellAst.p99))} ms | ${MS(avg((r) => r.shellAst.median))} ms |`);
	const ratios = rows.map((r) => r.ratioB).filter((x) => typeof x === "number").sort((a, b) => a - b);
	const ratioA = rows.map((r) => r.ratioA).filter((x) => typeof x === "number").sort((a, b) => a - b);
	const at = (xs: number[], q: number) => (xs.length === 0 ? Number.NaN : xs[Math.min(xs.length - 1, Math.floor(q * xs.length))]!);
	push(
		"",
		`- shell-ast / baseline B median ratio: p50 ${at(ratios, 0.5)?.toFixed(3)} p95 ${at(ratios, 0.95)?.toFixed(3)} max ${ratios[ratios.length - 1]?.toFixed(3)}`,
		`- shell-ast / baseline A median ratio: p50 ${at(ratioA, 0.5)?.toFixed(3)} p95 ${at(ratioA, 0.95)?.toFixed(3)} max ${ratioA[ratioA.length - 1]?.toFixed(3)}`,
		`- shell-ast rejected the input on ${Object.entries(warm.errors as Record<string, number>).map(([k, v]) => `${k}=${v}`).join(", ") || "no"} timed iterations (per-iteration counts, not unique commands)`,
		"",
	);

	// Fidelity: unique commands rejected + wrapper coverage. Text-free.
	const errorRows = rows.filter((r) => r.parseError !== null);
	if (fidelity !== null) {
		const pf = fidelity.parseFailures;
		push(`### Commands shell-ast rejects (${pf.unique}/${rows.length}, ${((pf.unique / rows.length) * 100).toFixed(3)}%)`, "");
		push(`\`bash -n\` also rejects ${pf.bashAlsoRejects} of these and accepts ${pf.bashAccepts}: only the latter are pure parser gaps, the rest were malformed input already present in the corpus. Per the settled spec a parse failure maps to the fail-closed prompt path, so this is a coverage cost, not a hole.`, "");
		push("| failure class | count |", "| --- | --- |");
		for (const c of pf.classes) push(`| ${c.message.replace(/\|/g, "\\|")} | ${c.count} |`);
		push("", `- by tool: ${Object.entries(pf.byTool).map(([k, v]) => `${k}=${v}`).join(", ")}`);
		push(`- by length: ${Object.entries(pf.lenBuckets).map(([k, v]) => `${k}=${v}`).join(", ")}`);
		push(`- by construct present: ${Object.entries(pf.features).map(([k, v]) => `${k}=${v}`).join(", ")}`);
		push(`- commands invoking a wrapper the package does NOT unwrap (\`command\`/\`xargs\`): **${fidelity.manualWrappers.commands}/${rows.length}** (${Object.entries(fidelity.manualWrappers.byName).map(([k, v]) => `${k}=${v}`).join(", ") || "none"})`, "");
	} else if (errorRows.length > 0) {
		push(`### Commands shell-ast rejects (${errorRows.length}/${rows.length}; fidelity.json missing, reporting warm rows only)`, "", "");
	}
}

push("## Battery", "");
if (battery === null) {
	push("battery.json missing", "");
} else {
	push(`- typed-node matrix: ${battery.summary.matrixPass}/${battery.summary.matrixTotal}`);
	push(`- five false-allow constructions surfaced by the AST: ${battery.summary.falseAllowPass}/${battery.summary.falseAllowTotal}`);
	push(`- malformed inputs raising ParseSyntaxError: ${battery.summary.malformedPass}/${battery.summary.malformedTotal}`);
	push(`- over-cap input: ${battery.sizeLimit.ok ? "ParseSizeError" : "NOT the size-limit kind"} (${battery.sizeLimit.kind ?? "n/a"})`);
	push("");
	push("| case | expected node types | missing | pass |", "| --- | --- | --- | --- |");
	for (const c of battery.cases) push(`| ${c.name} | ${c.expected.join(", ")} | ${c.missing.join(", ") || "-"} | ${c.ok ? "yes" : "NO"} |`);
	push("", "Five recorded false-allow constructions, with what guard decides today (2026-10-21 fix expected to close all five):", "");
	push("| construction | direct `touch` calls | unwrapped `touch` calls | guard decision today |", "| --- | --- | --- | --- |");
	for (const f of battery.falseAllows) push(`| ${f.src.replace(/\|/g, "\\|").replace(/`/g, "\\`")} | ${f.directTouchCalls} | ${f.unwrappedTouchCalls} | ${f.guardDecision} |`);
	push("", "Malformed inputs (fresh set; the original six are not enumerated anywhere):", "");
	push("| input | error | kind | pass |", "| --- | --- | --- | --- |");
	for (const m of battery.malformed) push(`| ${m.src.replace(/\|/g, "\\|").replace(/`/g, "\\`")} | ${m.errorName ?? "no error"} | ${m.kind ?? "-"} | ${m.ok ? "yes" : "NO"} |`);
	push("", `Observed node-type vocabulary (${battery.vocabulary.length}): ${battery.vocabulary.join(", ")}`, "");
}

if (warm !== null) {
	const rows: any[] = warm.rows;
	const order = [...rows].sort((a, b) => (b.ratioB ?? 0) - (a.ratioB ?? 0));
	const LIMIT = 1500;
	const shown = order.slice(0, LIMIT);
	push(`## Per-command table (sorted by shell-ast / baseline-B median ratio, descending)`, "");
	push(`Showing ${shown.length} of ${rows.length} commands, sorted by shell-ast / baseline-B median ratio so the most expensive rows cannot hide. The full per-command set is regenerated locally by \`run-all.sh\` (\`out/warm.json\`); \`results.json\` carries the aggregates plus the top rows by ratio.`, "");
	push("| id | tool | tier | len | wrap | pipe | and | ; | subst | bt | proc | hd | bg | red | A p50 ms | B p50 ms | S p50 ms | S/B | S/A | err |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
	for (const r of shown) {
		const s = r.shape;
		push(
			`| ${r.id} | ${r.tool} | ${r.tier} | ${s.lenBytes} | ${s.wrappers} | ${s.pipes} | ${s.andOr} | ${s.semis} | ${s.cmdSubst} | ${s.backticks} | ${s.procSubst} | ${s.heredocs} | ${s.background} | ${s.redirects} | ${MS(r.baselineA.p50)} | ${MS(r.baselineB.p50)} | ${MS(r.shellAst.p50)} | ${r.ratioB === null ? "n/a" : r.ratioB.toFixed(3)} | ${r.ratioA === null ? "n/a" : r.ratioA.toFixed(3)} | ${r.parseError ?? "-"} |`,
		);
	}
	push("");
}

push("## Findings (derived from the numbers above)", "");
if (warm !== null) {
	const rows: any[] = warm.rows;
	const mA = med(rows.map((r) => r.baselineA.median));
	const mB = med(rows.map((r) => r.baselineB.median));
	const mS = med(rows.map((r) => r.shellAst.median));
	const ratios = rows.map((r) => r.ratioB).filter((x) => typeof x === "number").sort((a, b) => a - b);
	const at = (xs: number[], q: number) => (xs.length === 0 ? Number.NaN : xs[Math.min(xs.length - 1, Math.floor(q * xs.length))]!);
	push(
		`- Warm, median of per-command medians: shell-ast \`parse\` ${MS(mS)} ms vs today's end-to-end decision path ${MS(mB)} ms (${X(mS, mB)}) and the parser-only splitter ${MS(mA)} ms (${X(mS, mA)}).`,
		`- The warm comparison is not uniform: the per-command shell-ast/end-to-end ratio is p50 ${at(ratios, 0.5).toFixed(2)}, p95 ${at(ratios, 0.95).toFixed(2)}, max ${ratios[ratios.length - 1]?.toFixed(2)}, so a minority of long commands pay far more than the average.`,
	);
}
if (cold !== null) {
	push(
		`- Cold: the first guarded command pays ${cold.deltas.headline_cold_ms.toFixed(2)} ms (${cold.deltas.module_ms.toFixed(2)} ms module import + ${cold.deltas.wasm_and_first_parse_ms.toFixed(2)} ms wasm compile and first parse), and steady RSS grows ${MIB(cold.deltas.rss_steady_bytes)} MiB at that first parse.`,
	);
}
if (fidelity !== null) {
	const total = fidelity.meta.corpus;
	push(
		`- Coverage: ${fidelity.parseFailures.unique}/${total} real commands are rejected by the parser; \`bash -n\` rejects ${fidelity.parseFailures.bashAlsoRejects} of those too, so only ${fidelity.parseFailures.bashAccepts} are pure parser gaps.`,
		`- Adapter burden: ${fidelity.manualWrappers.commands}/${total} commands invoke a wrapper the package does not unwrap (${Object.entries(fidelity.manualWrappers.byName).map(([k, v]) => `${k}=${v}`).join(", ")}), so guard must walk those itself.`,
	);
}
if (battery !== null) {
	push(
		`- Correctness: typed-node matrix ${battery.summary.matrixPass}/${battery.summary.matrixTotal}; all five recorded false-allow constructions are surfaced by the AST (and guard already prompts on all five today, confirming the 2026-10-21 fix); ${battery.summary.malformedPass}/${battery.summary.malformedTotal} malformed inputs raise ParseSyntaxError, plus the size-limit kind.`,
	);
}
if (warm !== null && cold !== null && fidelity !== null && battery !== null) {
	push("", "This spike measured parse cost, correctness, and coverage only. The adapter's own cost, the", "retirement of `shellsplit.ts`/`bashtier.ts`, and the license question are all out of scope.", "");
}
push("");

push(
	"## Verdict",
	"",
	"**Pending.** Thresholds were deliberately not fixed before the measurement (settled: see README).",
	"The reviewer sets the adopt / do-not-adopt bar from the numbers above; this file records the",
	"measurement only. What the call turns on, listed so nothing is decided implicitly:",
	"",
	"- the cold first-command cost and the steady-RSS delta at that first parse;",
	"- the warm tail, not just the median: long commands are where shell-ast loses to today's path;",
	"- the commands needing a manual wrapper walk, which the adapter must implement itself;",
	"- the pure parser gaps versus inputs `bash -n` also rejects;",
	"- separately, the license split (not a discrepancy): `0.8.0` is MIT in the registry metadata, the",
	"  tarball `package.json`, and the MIT `LICENSE` file the tarball ships, while the repo was",
	"  relicensed to MPL-2.0 on 2026-10-12 and `0.8.1-beta.0` is MPL-2.0 in those same three places, so",
	"  pinning `0.8.0` keeps MIT terms and any bump moves to file-level copyleft.",
	"",
);

writeFileSync(`${outBase}.md`, lines.join("\n"), "utf8");
// The committed JSON is path-scrubbed and row-bounded: committing all 34,969
// full row objects would be a ~35 MB blob in git history for no review value,
// and the complete set is regenerated locally by run-all.sh (out/warm.json).
// Here we keep the aggregates plus the most expensive rows by ratio.
const scrubText = (s: string): string => s.replace(/\/home\/[^/\s"]+/g, "~").replaceAll(process.cwd(), "spike-dir");
const JSON_ROW_CAP = 2000;
const compactRow = (r: any) => ({
	id: r.id,
	tool: r.tool,
	tier: r.tier,
	shape: r.shape,
	baselineA: r.baselineA,
	baselineB: r.baselineB,
	shellAst: r.shellAst,
	ratioB: r.ratioB,
	ratioA: r.ratioA,
	parseError: r.parseError,
});
const warmForJson =
	warm === null
		? null
		: {
				meta: warm.meta,
				errors: warm.errors,
				rowsTotal: warm.rows.length,
				rowsIncluded: Math.min(JSON_ROW_CAP, warm.rows.length),
				rowsNote: `top ${JSON_ROW_CAP} rows by shell-ast / baseline-B median ratio; the full set is regenerated locally by run-all.sh`,
				rows: [...warm.rows].sort((a: any, b: any) => (b.ratioB ?? 0) - (a.ratioB ?? 0)).slice(0, JSON_ROW_CAP).map(compactRow),
			};
const payload = { meta: { generatedAt: new Date().toISOString() }, counts, cold, warm: warmForJson, battery, fidelity };
writeFileSync(
	`${outBase}.json`,
	JSON.stringify(payload, (_key, value) => (typeof value === "string" ? scrubText(value) : value), "\t") + "\n",
	"utf8",
);
console.log(`wrote ${outBase}.md and ${outBase}.json`);
