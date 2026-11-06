/**
 * Three-arm cold runner: spawns fresh headless `pi -p` processes with the
 * probe extension, N boots per arm, and reports the arm deltas.
 *
 *   arm0 = no shell-ast import    (control)
 *   arm1 = imported, never parsed (module cost; isolates wasm compile)
 *   arm2 = first parse executed
 *
 * Headline cold delta = median(arm2.total) - median(arm0.total); the arm1 step
 * decomposes it. RSS deltas are reported the same way and are the only
 * meaningful comparison, since maxRSS includes pi's own peak.
 *
 * Usage:
 *   node cold.ts --out out/cold.json [--boots 10] [--isolate] [--timeout 120]
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PROBE = resolve(here, "probe.ts");
const PKG = resolve(here, "node_modules/@questi0nm4rk/shell-ast/dist/index.js");

function argValue(name: string, fallback?: string): string | undefined {
	const argv = process.argv.slice(2);
	const i = argv.indexOf(name);
	if (i !== -1 && i + 1 < argv.length) return argv[i + 1];
	return fallback;
}
const hasFlag = (name: string): boolean => process.argv.slice(2).includes(name);

interface Sample {
	ok: boolean;
	wall_ms: number;
	total_ms?: number;
	import_ms?: number | null;
	parse_ms?: number | null;
	rss_steady?: number;
	rss_peak_kb?: number;
	parse_ok?: boolean | null;
	parse_error_kind?: string | null;
	node?: string;
	raw?: string;
}

function median(xs: number[]): number {
	const s = [...xs].sort((a, b) => a - b);
	if (s.length === 0) return Number.NaN;
	const mid = Math.floor(s.length / 2);
	return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}
function p95(xs: number[]): number {
	const s = [...xs].sort((a, b) => a - b);
	if (s.length === 0) return Number.NaN;
	return s[Math.min(s.length - 1, Math.floor(0.95 * s.length))]!;
}

function stats(xs: number[]) {
	return { n: xs.length, median: median(xs), p95: p95(xs), min: Math.min(...xs), max: Math.max(...xs) };
}

async function main(): Promise<void> {
	const outPath = resolve(argValue("--out", "out/cold.json")!);
	const boots = Number.parseInt(argValue("--boots", "10")!, 10);
	const timeout = Number.parseInt(argValue("--timeout", "120")!, 10) * 1000;
	const isolate = hasFlag("--isolate");

	const baseArgs = ["-p", "--no-session"];
	if (isolate) baseArgs.push("-ne");
	baseArgs.push("-e", PROBE, "probe");

	const arms: Record<string, Sample[]> = { "0": [], "1": [], "2": [] };
	for (const arm of ["0", "1", "2"]) {
		for (let i = 0; i < boots; i += 1) {
			const started = Date.now();
			const res = spawnSync("pi", baseArgs, {
				encoding: "utf8",
				timeout,
				env: { ...process.env, SHELLAST_ARM: arm, SHELLAST_PKG: PKG },
			});
			const wall = Date.now() - started;
			const stdout = res.stdout ?? "";
			const stderr = res.stderr ?? "";
			// pi routes extension console output to stderr in -p mode (stdout is
			// reserved for the answer), so both streams are searched.
			const match = /^SHELLAST_PROBE (.*)$/m.exec(stdout + stderr);
			if (match === null) {
				arms[arm]!.push({
					ok: false,
					wall_ms: wall,
					raw: (stdout + stderr).slice(0, 400),
				});
				console.log(`  arm ${arm} boot ${i + 1}/${boots}: NO PROBE LINE (exit=${res.status})\n${(stdout + stderr).slice(0, 300)}`);
				continue;
			}
			const parsed = JSON.parse(match[1]!) as Record<string, any>;
			arms[arm]!.push({
				ok: true,
				wall_ms: wall,
				total_ms: parsed.t_total_ms,
				import_ms: parsed.t_import_ms,
				parse_ms: parsed.t_parse_ms,
				rss_steady: parsed.rss_steady,
				rss_peak_kb: parsed.rss_peak_kb,
				parse_ok: parsed.parse_ok,
				parse_error_kind: parsed.parse_error_kind,
				node: parsed.node,
			});
			process.stdout.write(`  arm ${arm} boot ${i + 1}/${boots}: total=${parsed.t_total_ms}ms rss=${(parsed.rss_steady / 1048576).toFixed(1)}MiB\n`);
		}
	}

	const total = (arm: string) => arms[arm]!.filter((s) => s.ok).map((s) => s.total_ms!);
	const rss = (arm: string) => arms[arm]!.filter((s) => s.ok).map((s) => s.rss_steady!);
	const peak = (arm: string) => arms[arm]!.filter((s) => s.ok).map((s) => s.rss_peak_kb!);
	const summary = {
		"0": { total: stats(total("0")), rss: stats(rss("0")), peak_kb: stats(peak("0")), ok: arms["0"]!.filter((s) => s.ok).length, boots },
		"1": { total: stats(total("1")), rss: stats(rss("1")), peak_kb: stats(peak("1")), ok: arms["1"]!.filter((s) => s.ok).length, boots },
		"2": { total: stats(total("2")), rss: stats(rss("2")), peak_kb: stats(peak("2")), ok: arms["2"]!.filter((s) => s.ok).length, boots },
	};
	const deltas = {
		module_ms: summary["1"].total.median - summary["0"].total.median,
		wasm_and_first_parse_ms: summary["2"].total.median - summary["1"].total.median,
		headline_cold_ms: summary["2"].total.median - summary["0"].total.median,
		rss_steady_bytes: summary["2"].rss.median - summary["0"].rss.median,
		rss_peak_kb: summary["2"].peak_kb.median - summary["0"].peak_kb.median,
		rss_import_bytes: summary["1"].rss.median - summary["0"].rss.median,
		rss_first_parse_bytes: summary["2"].rss.median - summary["1"].rss.median,
	};

	const failures = (["0", "1", "2"] as const).filter((a) => summary[a].ok < boots);
	mkdirSync(dirname(outPath), { recursive: true });
	writeFileSync(
		outPath,
		JSON.stringify({ meta: { generatedAt: new Date().toISOString(), nodeVersion: process.version, boots, isolate, args: baseArgs, probe: PROBE }, arms, summary, deltas }) + "\n",
		"utf8",
	);

	console.log("\ncold summary (ms from process time origin)");
	for (const arm of ["0", "1", "2"]) {
		const s = summary[arm as "0" | "1" | "2"];
		console.log(`  arm ${arm}: total median=${s.total.median.toFixed(2)} p95=${s.total.p95.toFixed(2)} | rss median=${(s.rss.median / 1048576).toFixed(1)}MiB | ok=${s.ok}/${s.boots}`);
	}
	console.log(`  module cost (arm1-arm0): ${deltas.module_ms.toFixed(2)} ms`);
	console.log(`  wasm + first parse (arm2-arm1): ${deltas.wasm_and_first_parse_ms.toFixed(2)} ms`);
	console.log(`  HEADLINE cold (arm2-arm0): ${deltas.headline_cold_ms.toFixed(2)} ms`);
	console.log(`  rss steady delta (arm2-arm0): ${(deltas.rss_steady_bytes / 1048576).toFixed(2)} MiB`);
	console.log(`  wrote ${outPath}`);
	if (failures.length > 0) {
		console.error(`FAILED: arms ${failures.join(", ")} produced fewer than ${boots} probe lines`);
		process.exitCode = 1;
	}
}

await main();
