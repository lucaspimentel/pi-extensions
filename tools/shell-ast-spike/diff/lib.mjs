/**
 * Shared runner plumbing for the shell-ast decision diff: argv parsing, the
 * corpus reader, the stable 12-hex command hash (identical to harvest.ts's
 * hashId so per-side rows join on the corpus `id`), and a progress logger.
 *
 * Import-free (no guard modules), so both the new-tree and old-tree runners
 * can load it without pulling either guard implementation into the other.
 */
import { createHash } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** Stable 12-hex-character identity for a command (matches harvest.ts hashId). */
export function hashId(cmd) {
	return createHash("sha256").update(cmd, "utf8").digest("hex").slice(0, 12);
}

export function argValue(argv, name, fallback) {
	const i = argv.indexOf(name);
	if (i !== -1 && i + 1 < argv.length) return argv[i + 1];
	return fallback;
}

/** Read the corpus JSONL. Returns [{id, tool, command}] in file order. */
export function readCorpus(path) {
	const text = readFileSync(path, "utf8");
	const rows = [];
	let lineNo = 0;
	for (const line of text.split("\n")) {
		lineNo += 1;
		if (line.trim() === "") continue;
		let row;
		try {
			row = JSON.parse(line);
		} catch (err) {
			throw new Error(`${path}:${lineNo}: malformed JSON (${err.message})`);
		}
		if (typeof row.command !== "string" || row.command.trim() === "") continue;
		rows.push({ id: row.id, tool: row.tool ?? "unknown", command: row.command });
	}
	return rows;
}

/** Create a writer that appends whole JSON lines and flushes periodically. */
export function makeJsonlWriter(path) {
	mkdirSync(dirname(path), { recursive: true });
	const chunks = [];
	let count = 0;
	return {
		write(obj) {
			chunks.push(JSON.stringify(obj));
			count += 1;
			if (chunks.length >= 4096) {
				writeFileSync(path, chunks.join("\n") + "\n", { flag: "a" });
				chunks.length = 0;
			}
		},
		close() {
			writeFileSync(path, chunks.length > 0 ? chunks.join("\n") + "\n" : "", { flag: "a" });
			chunks.length = 0;
			return count;
		},
		count() {
			return count;
		},
	};
}

/** Truncate a file (called once before appending). */
export function resetFile(path) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, "");
}

/** Progress logger: one line every `every` items to stderr with a rate. */
export function makeProgress(label, total, every = 2000) {
	const start = Date.now();
	let last = start;
	return {
		tick(done) {
			if (done % every !== 0 && done !== total) return;
			const now = Date.now();
			const elapsed = (now - start) / 1000;
			const rate = done > 0 ? done / elapsed : 0;
			const eta = rate > 0 ? Math.round(((total - done) / rate) * 10) / 10 : null;
			const delta = ((now - last) / 1000).toFixed(1);
			last = now;
			console.error(`[${label}] ${done}/${total} (${rate.toFixed(1)}/s, elapsed ${elapsed.toFixed(0)}s, last ${delta}s, eta ${eta ?? "?"}s)`);
		},
	};
}

/** Write a JSON artifact, creating parent dirs. */
export function writeJson(path, value) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

export function writeText(path, value) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, value, "utf8");
}

export { resolve };
