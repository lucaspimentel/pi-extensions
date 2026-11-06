// Test-only synchronous façade over the async shell-ast adapter. The policy
// evaluators take a `ShellCommandAnalysis | null` produced asynchronously in
// production; the pre-existing policy tests are synchronous and assert on
// decisions inline, so this helper runs the real adapter in a worker thread
// and blocks the test process on shared memory (Atomics.wait) to return the
// same analysis object. Never imported by guard extension code.
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import type { ShellCommandAnalysis } from "../extensions/guard/policy/shellast.ts";

const REQ_BYTES = 256 * 1024;
const RES_BYTES = 4 * 1024 * 1024;

let worker: Worker | null = null;
let reqI: Int32Array;
let resI: Int32Array;
let reqBytes: Uint8Array;
let resBytes: Uint8Array;
const cache = new Map<string, ShellCommandAnalysis>();
let seq = 0;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function ensureWorker(): void {
	if (worker) return;
	const reqSab = new SharedArrayBuffer(REQ_BYTES + 8);
	const resSab = new SharedArrayBuffer(RES_BYTES + 8);
	reqI = new Int32Array(reqSab);
	resI = new Int32Array(resSab);
	reqBytes = new Uint8Array(reqSab, 8);
	resBytes = new Uint8Array(resSab, 8);
	worker = new Worker(fileURLToPath(new URL("./shellast-sync-worker.mts", import.meta.url)), { workerData: { reqSab, resSab } });
	worker.unref();
}

/** Analyse one command synchronously (cached per command for the test run). */
export function analyzeSync(command: string): ShellCommandAnalysis {
	const cached = cache.get(command);
	if (cached) return cached;
	ensureWorker();
	const current = ++seq;
	const bytes = encoder.encode(command);
	if (bytes.length > reqBytes.length) throw new Error("shellast-sync: request too large");
	reqBytes.set(bytes);
	Atomics.store(reqI, 1, bytes.length);
	Atomics.store(reqI, 0, current);
	Atomics.notify(reqI, 0);
	for (;;) {
		const seen = Atomics.load(resI, 0);
		if (seen === current) break;
		Atomics.wait(resI, 0, seen);
	}
	const len = Atomics.load(resI, 1);
	if (len < 0) throw new Error("shellast-sync: response too large");
	const analysis = JSON.parse(decoder.decode(resBytes.subarray(0, len))) as ShellCommandAnalysis;
	cache.set(command, analysis);
	return analysis;
}

/**
 * The analysis a host-shell GuardCall would carry: null for anything that is
 * not a host-bash call (matching the production analysisFor).
 */
export function analysisForSync(call: { kind: string; shell?: string; command?: string }): ShellCommandAnalysis | null {
	if (call.kind !== "host-shell" || call.shell !== "host-bash") return null;
	return analyzeSync(call.command ?? "");
}

/** Stop the worker (best-effort; callers may just let it unref away). */
export async function stopAnalyzeSync(): Promise<void> {
	if (worker) {
		await worker.terminate();
		worker = null;
	}
}
