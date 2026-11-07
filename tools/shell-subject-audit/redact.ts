/**
 * Text-free descriptors for measured commands.
 *
 * This module is the only place that derives anything from a command string,
 * and it must never return any substring of the input: the committed report
 * carries hashes and shape counts only. The harvested corpus itself stays
 * local (corpus/ is gitignored).
 *
 * shell-ast reports node offsets as UTF-8 byte offsets, not JS string indices,
 * so every length here uses Buffer.byteLength rather than String.length.
 */
import { createHash } from "node:crypto";

export interface Shape {
	lenBytes: number;
	lines: number;
	wrappers: number;
	pipes: number;
	andOr: number;
	semis: number;
	cmdSubst: number;
	backticks: number;
	procSubst: number;
	heredocs: number;
	background: number;
	redirects: number;
	quotes: number;
}

/** Leading-chain wrappers that change what the next word means. */
const WRAPPERS = new Set([
	"sudo",
	"command",
	"env",
	"nohup",
	"time",
	"xargs",
	"stdbuf",
	"nice",
	"ionice",
	"setsid",
	"exec",
]);

/** Stable 12-hex-character identity for a command, so rows can be regenerated locally. */
export function hashId(cmd: string): string {
	return createHash("sha256").update(cmd, "utf8").digest("hex").slice(0, 12);
}

function count(cmd: string, re: RegExp): number {
	const m = cmd.match(re);
	return m === null ? 0 : m.length;
}

/** Shape only: no token, path, or substring of the command is ever returned. */
export function describe(cmd: string): Shape {
	let wrappers = 0;
	for (const tok of cmd.trim().split(/\s+/)) {
		if (WRAPPERS.has(tok)) wrappers += 1;
		else break;
	}
	return {
		lenBytes: Buffer.byteLength(cmd, "utf8"),
		lines: cmd.split("\n").length,
		wrappers,
		pipes: count(cmd, /(?<!\|)\|(?!\|)/g),
		andOr: count(cmd, /&&|\|\|/g),
		semis: count(cmd, /;/g),
		cmdSubst: count(cmd, /\$\(/g),
		backticks: count(cmd, /`/g),
		procSubst: count(cmd, /[<>]\(/g),
		heredocs: count(cmd, /<<-?/g),
		background: count(cmd, /(?<![&>])&(?![&>])/g),
		redirects: count(cmd, /(?:^|[^0-9<>])>>?|&>>?/g),
		quotes: count(cmd, /["']/g),
	};
}

/** Coarse length band used by the committed counts manifest (no exact lengths). */
export function lenBucket(lenBytes: number): string {
	if (lenBytes < 64) return "<64";
	if (lenBytes < 128) return "<128";
	if (lenBytes < 256) return "<256";
	if (lenBytes < 512) return "<512";
	if (lenBytes < 1024) return "<1k";
	if (lenBytes < 4096) return "<4k";
	return ">=4k";
}
