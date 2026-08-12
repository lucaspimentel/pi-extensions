// run: node run-all.mjs
//
// Runs all extension-level test suites with `node --experimental-strip-types`
// (Node >= 22.6) because the suites import test-helpers.mjs, which imports the
// real TypeScript module (./index.ts) so tests exercise the actual code, not a
// mirror.

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
	const result = spawnSync("node", ["--experimental-strip-types", file], { stdio: "inherit", cwd: __dirname, shell: true });
	if (result.status !== 0) failed++;
}

console.log(`\n${BAR}`);
if (failed === 0) {
	console.log(`  ✓ All ${suites.length} suites passed.`);
} else {
	console.log(`  ✗ ${failed} of ${suites.length} suite(s) failed.`);
}
process.exit(failed > 0 ? 1 : 0);
