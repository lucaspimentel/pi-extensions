/** Freeze trusted source trees and the explicit user config, never command execution. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

const args = process.argv.slice(2);
const arg = (key: string) => { const i = args.indexOf(key); if (i < 0 || !args[i + 1]) throw new Error(`${key} is required`); return args[i + 1]; };
const root = process.cwd();
const out = resolve(arg("--out"));
const config = resolve(arg("--config"));
const rel = relative(root, out);
if (!rel.startsWith(`build${sep}`)) throw new Error("private audit inputs must live under ignored build/");
execFileSync("git", ["check-ignore", "--quiet", `${rel}/inputs/user-config.json`]);
if (existsSync(out)) throw new Error("refusing to overwrite a frozen audit directory");
const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const baselineIndex = args.indexOf("--baseline");
const baselineRef = baselineIndex < 0 ? "HEAD" : arg("--baseline");
const baselineSha = execFileSync("git", ["rev-parse", "--verify", "--end-of-options", `${baselineRef}^{commit}`], { encoding: "utf8" }).trim();
const paths = [...new Set(execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean))].sort();
const tracked = execFileSync("git", ["ls-tree", "-r", "--name-only", "-z", baselineSha], { encoding: "utf8" }).split("\0").filter(Boolean);
const before = resolve(out, "baseline");
const after = resolve(out, "candidate");
mkdirSync(before, { recursive: true });
mkdirSync(after, { recursive: true });
const archive = execFileSync("git", ["archive", "--format=tar", baselineSha], { maxBuffer: 64 * 1024 * 1024 });
execFileSync("tar", ["-xf", "-"], { input: archive, cwd: before });
const candidateFiles: Record<string, string> = {};
for (const path of paths) {
	const destination = resolve(after, path);
	mkdirSync(dirname(destination), { recursive: true });
	copyFileSync(resolve(root, path), destination);
	candidateFiles[path] = hash(readFileSync(destination));
}
const baselineFiles = Object.fromEntries(tracked.map((path) => [path, hash(readFileSync(resolve(before, path)))]));
const configBytes = readFileSync(config);
JSON.parse(configBytes.toString("utf8"));
mkdirSync(resolve(out, "inputs"), { recursive: true });
writeFileSync(resolve(out, "inputs/user-config.json"), configBytes);
const manifest = {
	generatedAt: new Date().toISOString(), baselineRef, baselineSha,
	candidateFiles, baselineFiles,
	configSource: config, configSha256: hash(configBytes), archiveSha256: hash(archive),
	provenance: { harvester: "e4377ed:tools/shell-ast-spike/{harvest,redact}.ts", harness: "adapted from edbff4a:tools/shell-ast-spike/diff/" },
};
const bytes = JSON.stringify(manifest, null, 2) + "\n";
writeFileSync(resolve(out, "source-manifest.json"), bytes);
console.log(JSON.stringify({ out: rel, baselineSha, manifestSha256: hash(bytes), sourceFiles: paths.length }));
