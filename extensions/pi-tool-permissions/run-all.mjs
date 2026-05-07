// run: node run-all.mjs

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const suites = [
	"test-grep-glob.mjs",
	"test-read-write-edit.mjs",
	"test-bash.mjs",
	"test-web.mjs",
	"test-rules-and-decide.mjs",
	"test-loadconfig.mjs",
];

const BAR = "═".repeat(60);
let failed = 0;

for (const file of suites) {
	console.log(`\n${BAR}\n  ${file}\n${BAR}`);
	const result = spawnSync("node", [file], { stdio: "inherit", cwd: __dirname, shell: true });
	if (result.status !== 0) failed++;
}

console.log(`\n${BAR}`);
if (failed === 0) {
	console.log(`  ✓ All ${suites.length} suites passed.`);
} else {
	console.log(`  ✗ ${failed} of ${suites.length} suite(s) failed.`);
}
process.exit(failed > 0 ? 1 : 0);
