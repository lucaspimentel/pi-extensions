/**
 * One-shot orchestrator for the shell-ast decision diff.
 *
 *   1. extracts HEAD read-only into a temp tree OUTSIDE the repo
 *      (`git archive HEAD | tar -x`), unless --old is given;
 *   2. runs the new-tree runner (working tree) and the old-tree runner
 *      (extracted HEAD) as separate node processes, so neither process ever
 *      imports both guard trees;
 *   3. runs the comparator.
 *
 * Usage:
 *   node run-all.mts [--limit N] [--old DIR] [--corpus PATH] [--out DIR]
 *
 * Full run is minutes (progress goes to stderr and to out/run.log when
 * launched with nohup). Guard's own tests are unaffected; this never touches
 * extensions/guard/**.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";
import { argValue } from "./lib.mjs";

const argv = process.argv.slice(2);
const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const diffDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const corpusPath = resolve(argValue(argv, "--corpus", resolve(repoRoot, "tools/shell-ast-spike/corpus/commands.jsonl"))!);
const outDir = resolve(argValue(argv, "--out", resolve(repoRoot, "tools/shell-ast-spike/out/diff"))!);
const explicitOld = argValue(argv, "--old", undefined);
const limit = argValue(argv, "--limit", undefined);

let oldDir = explicitOld;
if (!oldDir) {
	oldDir = mkdtempSync(join(tmpdir(), "shellast-diff-old-"));
	console.error(`[orchestrator] extracting HEAD -> ${oldDir}`);
	execFileSync("bash", ["-c", `git archive HEAD | tar -x -C ${JSON.stringify(oldDir)}`], { cwd: repoRoot, stdio: "inherit" });
} else {
	console.error(`[orchestrator] reusing old tree ${oldDir}`);
}

function run(name: string, script: string, extraArgs: string[]): void {
	console.error(`[orchestrator] ${name} ...`);
	const res = spawnSync(process.execPath, [resolve(diffDir, script), ...extraArgs], { stdio: "inherit", cwd: repoRoot });
	if (res.status !== 0) {
		console.error(`[orchestrator] ${name} FAILED (exit ${res.status})`);
		process.exit(res.status ?? 1);
	}
}

const common = ["--corpus", corpusPath, "--out", outDir, ...(limit !== undefined ? ["--limit", limit] : [])];
run("new runner", "run-new.mts", common);
run("old runner", "run-old.mts", ["--old", oldDir, ...common]);
run("comparator", "compare.mts", ["--corpus", corpusPath, "--out", outDir]);
console.error(`[orchestrator] done -> ${outDir}/summary.md`);
