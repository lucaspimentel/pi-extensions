// Shared temporary-fixture tracking for the guard test suites: every
// directory created through makeTempDir, plus explicitly adopted externals
// (fixtures that must live outside the overridden HOME), is recorded so a
// suite can delete exactly what it created, and nothing else.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const tempDirs: string[] = [];

export function makeTempDir(prefix: string): string {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
	tempDirs.push(dir);
	return dir;
}

/** Delete every tracked directory and empty the registry. Deletion failures
 * propagate: the caller (typically a suite-wide after hook) should fail so a
 * leak cannot hide behind a swallowed error. */
export function drainTempDirs(): void {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
}
