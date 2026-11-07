/**
 * Harvest every bash/host_bash command guard has evaluated out of the local pi
 * session transcripts, dedupe exact repeats, and write:
 *
 *   commands.jsonl   raw commands, LOCAL ONLY (gitignored)
 *   harvest.json     counts and source-file hashes/paths, also PRIVATE
 *
 * Restored from e4377ed and extended to freeze provenance. Neither output
 * belongs in git. The command text lives only in the corpus file.
 *
 * Known limitation: bash calls nested inside a `codemode` tool call are not
 * harvested, because the transcript records the codemode block, not the inner
 * tool calls. Sessions record bash/host_bash blocks verbatim.
 *
 * Usage:
 *   node harvest.ts --sessions PATH --out build/.../commands.jsonl --manifest build/.../harvest.json
 */
import { createReadStream, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import { listSessionFiles, sessionsDir } from "../../extensions/session-search/store.ts";
import { describe, hashId, lenBucket, type Shape } from "./redact.ts";

interface Found {
	tool: "bash" | "host_bash";
	command: string;
}

function argValue(name: string, fallback?: string): string | undefined {
	const argv = process.argv.slice(2);
	const i = argv.indexOf(name);
	if (i !== -1 && i + 1 < argv.length) return argv[i + 1];
	return fallback;
}

/** Defensive: real transcripts use `arguments`; older fixtures used `input`. */
function extract(entry: unknown): Found[] {
	const out: Found[] = [];
	if (typeof entry !== "object" || entry === null) return out;
	const e = entry as Record<string, any>;
	if (e.type !== "message") return out;
	const msg = e.message;
	if (typeof msg !== "object" || msg === null || msg.role !== "assistant") return out;
	if (!Array.isArray(msg.content)) return out;
	for (const block of msg.content) {
		if (typeof block !== "object" || block === null) continue;
		if (block.type !== "toolCall") continue;
		if (block.name !== "bash" && block.name !== "host_bash") continue;
		const cmd =
			typeof block.arguments?.command === "string"
				? block.arguments.command
				: typeof block.input?.command === "string"
					? block.input.command
					: undefined;
		if (cmd !== undefined && cmd.trim() !== "") out.push({ tool: block.name, command: cmd });
	}
	return out;
}

async function scanFile(file: string, onFound: (f: Found) => void): Promise<{ malformed: number; sha256: string; bytes: number }> {
	let malformed = 0;
	let bytes = 0;
	const digest = createHash("sha256");
	const input = createReadStream(file);
	input.on("data", (chunk) => { digest.update(chunk); bytes += chunk.length; });
	const rl = createInterface({ input, crlfDelay: Infinity });
	for await (const line of rl) {
		if (line.trim() === "") continue;
		let entry: unknown;
		try {
			entry = JSON.parse(line);
		} catch {
			malformed += 1;
			continue;
		}
		for (const found of extract(entry)) onFound(found);
	}
	return { malformed, sha256: digest.digest("hex"), bytes };
}

async function main(): Promise<void> {
	const outPath = resolve(argValue("--out", "build/shell-subject-audit/commands.jsonl")!);
	const manifestPath = resolve(argValue("--manifest", "build/shell-subject-audit/harvest.json")!);
	const limitRaw = argValue("--limit");
	const limit = limitRaw === undefined ? Number.POSITIVE_INFINITY : Number.parseInt(limitRaw, 10);
	if (existsSync(outPath) || existsSync(manifestPath)) throw new Error("refusing to overwrite frozen harvest outputs");
	const dir = resolve(argValue("--sessions", sessionsDir())!);
	const files = listSessionFiles(dir).sort();
	if (!(limit > 0)) throw new Error("--limit must be positive");
	const selected = Number.isFinite(limit) ? files.slice(0, limit) : files;
	if (selected.length === 0) throw new Error("no session files found; refusing an empty measurement");
	const sources: Array<{ path: string; sha256: string; bytes: number }> = [];

	// Dedupe exact command strings, preserving first-seen order.
	const seen = new Map<string, { id: string; tool: "bash" | "host_bash"; command: string; occurrences: number; shapes: Shape }>();
	let malformedLines = 0;
	let rawCalls = 0;
	const perToolRaw: Record<string, number> = { bash: 0, host_bash: 0 };

	for (const file of selected) {
		const res = await scanFile(file, (f) => {
			rawCalls += 1;
			perToolRaw[f.tool] = (perToolRaw[f.tool] ?? 0) + 1;
			const existing = seen.get(f.command);
			if (existing !== undefined) {
				existing.occurrences += 1;
				return;
			}
			seen.set(f.command, {
				id: hashId(f.command),
				tool: f.tool,
				command: f.command,
				occurrences: 1,
				shapes: describe(f.command),
			});
		});
		sources.push({ path: file, sha256: res.sha256, bytes: res.bytes });
		malformedLines += res.malformed;
	}

	mkdirSync(dirname(outPath), { recursive: true });
	const rows = [...seen.values()];
	if (new Set(rows.map((r) => r.id)).size !== rows.length) throw new Error("command hash collision");
	writeFileSync(outPath, rows.map((r) => JSON.stringify({ id: r.id, tool: r.tool, command: r.command })).join("\n") + "\n", "utf8");

	const lenBuckets: Record<string, number> = {};
	const features = ["wrappers", "pipes", "andOr", "semis", "cmdSubst", "backticks", "procSubst", "heredocs", "background", "redirects"] as const;
	const featureBuckets: Record<string, number> = {};
	for (const key of features) featureBuckets[key] = 0;
	const perToolUnique: Record<string, number> = { bash: 0, host_bash: 0 };
	for (const r of rows) {
		lenBuckets[lenBucket(r.shapes.lenBytes)] = (lenBuckets[lenBucket(r.shapes.lenBytes)] ?? 0) + 1;
		for (const key of features) if (r.shapes[key] > 0) featureBuckets[key] += 1;
		perToolUnique[r.tool] += 1;
	}

	const manifest = {
		generatedAt: new Date().toISOString(),
		sessionsRoot: dir,
		sources,
		corpusSha256: createHash("sha256").update(rows.map((r) => JSON.stringify({ id: r.id, tool: r.tool, command: r.command })).join("\n") + "\n").digest("hex"),
		filesScanned: selected.length,
		filesAvailable: files.length,
		rawCalls,
		rawCallsPerTool: perToolRaw,
		unique: rows.length,
		uniquePerTool: perToolUnique,
		malformedLines,
		lenBuckets,
		featureBuckets,
		parseErrorCount: null,
		note: "PRIVATE provenance. Commands are deduped by exact string. Nested codemode calls are not harvested. Source hashes cover the bytes actually read; the active transcript may later change. No command text is present here.",
	};
	writeFileSync(manifestPath, JSON.stringify(manifest, null, "\t") + "\n", "utf8");

	console.log(`scanned ${selected.length}/${files.length} files, ${rawCalls} bash/host_bash calls -> ${rows.length} unique`);
	console.log(`corpus:   ${outPath}`);
	console.log(`manifest: ${manifestPath}`);
}

await main();
