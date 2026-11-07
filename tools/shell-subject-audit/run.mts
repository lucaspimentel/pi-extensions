/** Separate-process baseline/candidate evaluation. Harvested text is parsed, NEVER executed. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir, release } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compileRules, ruleCoverage } from "./coverage.mts";

const args = process.argv.slice(2);
const arg = (key: string) => { const i = args.indexOf(key); if (i < 0 || !args[i + 1]) throw new Error(`${key} is required`); return args[i + 1]; };
const out = resolve(arg("--out"));
const cwd = arg("--cwd");
const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const read = (name: string) => readFileSync(join(out, name));
const sourceBytes = read("source-manifest.json");
const source = JSON.parse(sourceBytes.toString("utf8"));
const corpusBytes = read("inputs/commands.jsonl");
const configBytes = read("inputs/user-config.json");
const corpus = corpusBytes.toString("utf8").trimEnd().split("\n").filter(Boolean).map((line) => JSON.parse(line));
const user = JSON.parse(configBytes.toString("utf8"));
const wasm = fileURLToPath(import.meta.resolve("@questi0nm4rk/shell-ast"));
const hashes = () => ({ sourceManifest: hash(read("source-manifest.json")), corpus: hash(read("inputs/commands.jsonl")), harvest: hash(read("inputs/harvest.json")), userConfig: hash(read("inputs/user-config.json")), wasm: hash(readFileSync(join(dirname(wasm), "shell-ast.wasm"))) });

function verifySources(): void {
	for (const [side, files] of [["baseline", source.baselineFiles], ["candidate", source.candidateFiles]] as const) {
		for (const [path, sha] of Object.entries(files)) {
			if (hash(readFileSync(join(out, side, path))) !== sha) throw new Error(`frozen source changed: ${side}/${path}`);
		}
	}
	if (hash(configBytes) !== source.configSha256) throw new Error("config snapshot does not match source manifest");
	const harvest = JSON.parse(read("inputs/harvest.json").toString("utf8"));
	if (hash(corpusBytes) !== harvest.corpusSha256) throw new Error("corpus does not match harvest manifest");
	if (new Set(corpus.map((row) => row.id)).size !== corpus.length) throw new Error("duplicate corpus ID");
	for (const row of corpus) if (hash(row.command).slice(0, 12) !== row.id) throw new Error("invalid command ID");
}

if (args.includes("--side")) {
	const side = arg("--side");
	if (side !== "baseline" && side !== "candidate") throw new Error("invalid side");
	const root = join(out, side, "extensions/guard/policy");
	const load = (name: string) => import(pathToFileURL(join(root, `${name}.ts`)).href);
	const decision = await load("decision");
	const adapter = await load("shellast");
	const configMod = await load("config");
	const profiles = (await load("profiles")).ALL_PROFILES as string[];
	const api = { rules: await load("rules"), tier: await load("bashtier"), text: await load("shell-text") };
	const configs = [
		{ name: "user", config: configMod.mergeConfig(user, {}, cwd, homedir()) },
		{ name: "empty", config: configMod.mergeConfig({}, {}, cwd, homedir()) },
	].map((c) => ({ ...c, compiled: compileRules(c.config, api) }));
	const rules = configs.map(({ name, config, compiled }) => ({ name, warnings: config.warnings, rules: compiled.map(({ parsed, ...r }) => ({ ...r, sourceIndices: (user.hostBash?.[r.slot] ?? []).flatMap((text: string, index: number) => text === r.text ? [index] : []) })) }));
	writeFileSync(join(out, `${side}-rules.json`), JSON.stringify(rules, null, 2) + "\n");
	const output = join(out, `${side}.jsonl`);
	if (existsSync(output)) throw new Error("refusing to overwrite measurement output");
	writeFileSync(output, "");
	let buffer: string[] = [];
	const flush = () => { appendFileSync(output, buffer.join("\n") + "\n"); buffer = []; };
	let done = 0;
	for (const row of corpus) {
		const analysis = await adapter.analyzeHostCommand(row.command);
		const observations = configs.map(({ name, config, compiled }) => ({
			name,
			coverage: ruleCoverage(row.command, analysis, config, compiled, api, side === "candidate"),
			cells: profiles.map((profile) => {
				const policy = { profile, config, cwd, sandboxMode: "full", workspaceLocked: false, interactive: true };
				const result = decision.decide(policy, { kind: "host-shell", shell: "host-bash", command: row.command }, analysis);
				return { profile, action: result.action, reason: result.reason, matchedRule: result.matchedRule ?? null, provenance: result.provenance ?? null };
			}),
		}));
		buffer.push(JSON.stringify({ id: row.id, analysis, configs: observations }));
		if (buffer.length === 256) flush();
		if (++done % 1000 === 0) console.error(`${side}: ${done}/${corpus.length}`);
	}
	if (buffer.length > 0) flush();
	writeFileSync(join(out, `${side}-complete.json`), JSON.stringify({ commands: done, cells: done * profiles.length * configs.length, profiles, configs: configs.map((c) => c.name), outputSha256: hash(read(`${side}.jsonl`)) }, null, 2) + "\n");
	console.error(`${side}: complete, ${done} commands`);
} else {
	verifySources();
	if (existsSync(join(out, "measurement-manifest.json"))) throw new Error("refusing to overwrite a frozen measurement");
	const initialHashes = hashes();
	const manifest = { generatedAt: new Date().toISOString(), baselineSha: source.baselineSha, hashes: initialHashes, baselineLockfile: source.baselineFiles["package-lock.json"], candidateLockfile: source.candidateFiles["package-lock.json"], runtime: { node: process.version, platform: process.platform, arch: process.arch, release: release(), home: homedir(), cwd }, commands: corpus.length, inputOrigins: { observed: corpus.filter((r) => r.tool !== "rule-probe").length, ruleProbes: corpus.filter((r) => r.tool === "rule-probe").length }, cellsPerSide: corpus.length * 14, classifier: "unresolved, no model or network calls", scope: "all corpus bash/host_bash calls evaluated as host-shell/host-bash; full sandbox mode; no project config; rules covered independently of profile/tier" };
	writeFileSync(join(out, "measurement-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
	for (const side of ["baseline", "candidate"]) {
		const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--out", out, "--cwd", cwd, "--side", side], { stdio: "inherit", env: { ...process.env, PI_GUARD_INHERIT: undefined } });
		if (result.status !== 0) throw new Error(`${side} runner failed (${result.status}): ${result.error ?? ""}`);
	}
	verifySources();
	if (JSON.stringify(initialHashes) !== JSON.stringify(hashes())) throw new Error("inputs changed while measuring");
	const { compare } = await import("./compare.mts");
	const summary = await compare(out);
	console.log(JSON.stringify({ manifestSha256: hash(read("measurement-manifest.json")), summary }));
}
