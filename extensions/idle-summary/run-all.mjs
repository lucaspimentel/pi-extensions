// run: node run-all.mjs
//
// Runs all extension-level test suites. Tests that import TypeScript modules
// (.ts) are executed with `node --experimental-strip-types` (Node >= 22.6) so
// they exercise the real code without a build step.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const suites = [
	// [file, needsTypeStripping]
	["test-idle-summary.mjs", true],
];

const BAR = "═".repeat(60);
let failed = 0;

for (const [file, stripTypes] of suites) {
	console.log(`\n${BAR}\n  ${file}\n${BAR}`);
	const args = stripTypes ? ["--experimental-strip-types", file] : [file];
	const result = spawnSync("node", args, {
		stdio: "inherit",
		cwd: __dirname,
		shell: true,
	});
	if (result.status !== 0) failed++;
}

console.log(`\n${BAR}`);
if (failed === 0) {
	console.log(`  ✓ All ${suites.length} suites passed.`);
} else {
	console.log(`  ✗ ${failed} of ${suites.length} suite(s) failed.`);
}
process.exit(failed > 0 ? 1 : 0);
